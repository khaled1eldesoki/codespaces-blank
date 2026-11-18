'use strict';
/*
 * EDCL backup service (v1.0.10)
 *  - writeSqlite : real .sqlite file, one table per EDCL table + _edcl_backup (full lossless payload for restore)
 *  - writeAccess : real Microsoft Access database (.accdb, or .mdb fallback) created through ADOX/ADO from PowerShell
 * Nothing here needs the user to install or configure anything on a normal Windows + Office PC.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

let Database;
try { Database = require('better-sqlite3'); } catch (e) { Database = null; }

const FORMAT = 'EDCL-full-backup-json-v1';
const q = s => '"' + String(s).replace(/"/g, '""') + '"';

/* ---------- model: tables -> { name, cols:[{name,type}], rows:[[string|null,...]] } ---------- */
const cell = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.replace(/\u0000/g, '');
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch (e) { return String(v); }
};
const safeName = (raw, fallback, used) => {
  let n = String(raw == null ? '' : raw).replace(/[\u0000-\u001f.!`\[\]]/g, '_').replace(/^\s+|\s+$/g, '').slice(0, 60);
  if (!n) n = fallback;
  if (/^(msys|usys)/i.test(n)) n = '_' + n;
  let c = n, i = 2;
  while (used.has(c.toLowerCase())) c = n + '_' + (i++);
  used.add(c.toLowerCase());
  return c;
};
const buildModel = tables => {
  const model = [], usedT = new Set();
  for (const key of Object.keys(tables || {})) {
    const src = tables[key];
    if (!Array.isArray(src)) continue;
    const keys = [];
    const seen = new Set();
    for (const r of src) if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    if (!keys.length) keys.push('ID');
    const usedC = new Set();
    const cols = keys.map((k, i) => ({ key: k, name: safeName(k, 'Field' + (i + 1), usedC), maxLen: 0 }));
    const rows = src.map(r => cols.map(c => {
      const v = cell(r && typeof r === 'object' ? r[c.key] : null);
      if (v !== null && v.length > c.maxLen) c.maxLen = v.length;
      return v;
    }));
    cols.forEach(c => { c.type = c.maxLen > 120 ? 'LONGTEXT' : 'TEXT(255)'; });
    model.push({ name: safeName(key, 'Table' + (model.length + 1), usedT), source: key, cols, rows });
  }
  return model;
};

/* ---------- SQLite ---------- */
const writeSqlite = (file, model, fullJson, meta) => {
  if (!Database) throw new Error('SQLite native driver is unavailable');
  const tmp = file + '.tmp';
  try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
  const db = new Database(tmp);
  let total = 0;
  try {
    db.exec('BEGIN');
    for (const t of model) {
      db.exec('CREATE TABLE ' + q(t.name) + ' (' + t.cols.map(c => q(c.name) + ' TEXT').join(', ') + ')');
      const ins = db.prepare('INSERT INTO ' + q(t.name) + ' VALUES (' + t.cols.map(() => '?').join(',') + ')');
      for (const r of t.rows) { ins.run(r); total++; }
    }
    db.exec('CREATE TABLE _edcl_backup (id INTEGER PRIMARY KEY, created TEXT, app_version TEXT, format TEXT, payload TEXT)');
    db.prepare('INSERT INTO _edcl_backup (created, app_version, format, payload) VALUES (?,?,?,?)')
      .run(meta.created, meta.version, FORMAT, fullJson);
    db.exec('COMMIT');
    const ic = db.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw new Error('SQLite integrity_check failed: ' + ic);
    for (const t of model) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM ' + q(t.name)).get().n;
      if (n !== t.rows.length) throw new Error('Row count mismatch in ' + t.name + ': wrote ' + n + ', expected ' + t.rows.length);
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (x) { /* ignore */ }
    try { db.close(); } catch (x) { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ }
    throw e;
  }
  db.close();
  fs.renameSync(tmp, file);
  return { path: file, size: fs.statSync(file).size, tables: model.length, rows: total };
};

const readPayload = file => {
  if (!Database) throw new Error('SQLite native driver is unavailable');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const ic = db.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw new Error('This SQLite file failed its integrity check: ' + ic);
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_edcl_backup'").get();
    if (!has) throw new Error('This SQLite file is not an EDCL backup (table _edcl_backup not found)');
    const row = db.prepare('SELECT created, app_version, format, payload FROM _edcl_backup ORDER BY id DESC LIMIT 1').get();
    if (!row || !row.payload) throw new Error('The EDCL backup table is empty');
    if (row.format !== FORMAT) throw new Error('Unsupported backup format: ' + row.format);
    return { payload: row.payload, created: row.created, version: row.app_version };
  } finally { db.close(); }
};

/* ---------- Microsoft Access (ADOX / ADO through PowerShell, no script file, no execution-policy issue) ---------- */
const psQuote = s => "'" + String(s).replace(/'/g, "''") + "'";
const PS_BODY = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Web.Extensions',
  '  $js = New-Object System.Web.Script.Serialization.JavaScriptSerializer',
  '  $js.MaxJsonLength = [int]::MaxValue',
  '  $js.RecursionLimit = 100',
  '  $text = [System.IO.File]::ReadAllText($JsonPath, [System.Text.Encoding]::UTF8)',
  '  $tables = $js.DeserializeObject($text)',
  '  $cs = "Provider=$Provider;Data Source=$OutPath;"',
  '  $cat = New-Object -ComObject ADOX.Catalog',
  '  [void]$cat.Create($cs)',
  '  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($cat)',
  '  $conn = New-Object -ComObject ADODB.Connection',
  '  $conn.Open($cs)',
  '  $tableCount = 0; $rowCount = 0; $failed = 0',
  '  foreach ($t in $tables) {',
  "    $name = [string]$t['name']",
  '    try {',
  '      $defs = @()',
  "      foreach ($c in $t['cols']) { $defs += ('[' + $c['name'] + '] ' + $c['type']) }",
  "      [void]$conn.Execute('CREATE TABLE [' + $name + '] (' + ($defs -join ', ') + ')')",
  "      $n = @($t['cols']).Count",
  '      $rs = New-Object -ComObject ADODB.Recordset',
  "      $rs.Open('SELECT * FROM [' + $name + ']', $conn, 1, 3)",
  "      foreach ($r in $t['rows']) {",
  '        $rs.AddNew()',
  '        for ($i = 0; $i -lt $n; $i++) {',
  '          $v = $r[$i]',
  "          if ($v -ne $null -and $v -ne '') { $rs.Fields.Item($i).Value = [string]$v }",
  '        }',
  '        $rs.Update()',
  '        $rowCount++',
  '      }',
  '      $rs.Close()',
  '      $tableCount++',
  '    } catch {',
  '      $failed++',
  "      Write-Output ('FAIL ' + $name + ': ' + $_.Exception.Message)",
  '    }',
  '  }',
  '  $conn.Close()',
  '  Write-Output ("RESULT tables=$tableCount rows=$rowCount failed=$failed")',
  '  exit 0',
  '} catch {',
  "  Write-Output ('ERROR ' + $_.Exception.Message)",
  '  exit 2',
  '}'
].join('\r\n');

const sysRoot = process.env.SystemRoot || 'C:\\Windows';
const PS64 = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PS32 = path.join(sysRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const runPs = (exe, script) => new Promise(resolve => {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  execFile(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
    { windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

const writeAccess = async (destNoExt, model) => {
  if (process.platform !== 'win32') throw new Error('Microsoft Access files can only be created on Windows');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-access-'));
  const jsonPath = path.join(work, 'tables.json');
  fs.writeFileSync(jsonPath, JSON.stringify(model.map(t => ({ name: t.name, cols: t.cols.map(c => ({ name: c.name, type: c.type })), rows: t.rows }))), 'utf8');
  const attempts = [
    { ps: PS64, provider: 'Microsoft.ACE.OLEDB.12.0', ext: '.accdb', label: 'Access Database Engine (64-bit)' },
    { ps: PS64, provider: 'Microsoft.ACE.OLEDB.16.0', ext: '.accdb', label: 'Access Database Engine 2016 (64-bit)' },
    { ps: PS32, provider: 'Microsoft.ACE.OLEDB.12.0', ext: '.accdb', label: 'Access Database Engine (32-bit)' },
    { ps: PS32, provider: 'Microsoft.ACE.OLEDB.16.0', ext: '.accdb', label: 'Access Database Engine 2016 (32-bit)' },
    { ps: PS32, provider: 'Microsoft.Jet.OLEDB.4.0', ext: '.mdb', label: 'Windows Jet 4.0 (.mdb, opens in every Access version)' }
  ];
  const tried = [];
  try {
    for (const a of attempts) {
      if (!fs.existsSync(a.ps)) { tried.push(a.label + ': PowerShell not found'); continue; }
      const out = path.join(work, 'EDCL_backup' + a.ext);
      try { fs.unlinkSync(out); } catch (e) { /* none */ }
      const script = '$JsonPath = ' + psQuote(jsonPath) + '\r\n$OutPath = ' + psQuote(out) + '\r\n$Provider = ' + psQuote(a.provider) + '\r\n' + PS_BODY;
      const r = await runPs(a.ps, script);
      const text = (r.stdout + '\n' + r.stderr).trim();
      const m = text.match(/RESULT tables=(\d+) rows=(\d+) failed=(\d+)/);
      if (m && fs.existsSync(out) && fs.statSync(out).size > 0) {
        const fails = text.split(/\r?\n/).filter(l => l.startsWith('FAIL '));
        const dest = destNoExt + a.ext;
        fs.copyFileSync(out, dest);
        return { path: dest, size: fs.statSync(dest).size, format: a.ext.slice(1), provider: a.provider, tables: +m[1], rows: +m[2], failed: +m[3], warnings: fails };
      }
      const why = (text.split(/\r?\n/).find(l => l.startsWith('ERROR ')) || text || (r.err && r.err.message) || 'unknown error').slice(0, 300);
      tried.push(a.label + ': ' + why);
    }
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  const e = new Error('Could not create a Microsoft Access file on this PC. Install the free "Microsoft Access Database Engine 2016 Redistributable" (or use a PC with Microsoft Office/Access) and try again. The SQLite backup is not affected.');
  e.details = tried;
  throw e;
};

const PS_READ = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $cs = "Provider=$Provider;Data Source=$InPath;Mode=Read;"',
  '  $conn = New-Object -ComObject ADODB.Connection',
  '  $conn.Open($cs)',
  '  $cat = New-Object -ComObject ADOX.Catalog',
  '  $cat.ActiveConnection = $conn',
  '  $names = @()',
  "  foreach ($t in $cat.Tables) { if ($t.Type -eq 'TABLE' -and $t.Name -notlike 'MSys*' -and $t.Name -notlike '~*') { $names += [string]$t.Name } }",
  '  $sb = New-Object System.Text.StringBuilder',
  "  [void]$sb.Append('{')",
  '  $firstT = $true',
  '  foreach ($name in $names) {',
  '    $rs = New-Object -ComObject ADODB.Recordset',
  "    $rs.Open('SELECT * FROM [' + $name + ']', $conn, 0, 1)",
  '    $n = $rs.Fields.Count',
  '    $cols = @()',
  '    for ($i = 0; $i -lt $n; $i++) { $cols += [string]$rs.Fields.Item($i).Name }',
  "    if (-not $firstT) { [void]$sb.Append(',') }",
  '    $firstT = $false',
  '    [void]$sb.Append((ConvertTo-Json -InputObject ([string]$name) -Compress))',
  `    [void]$sb.Append(':{"cols":')`,
  '    [void]$sb.Append((ConvertTo-Json -InputObject @($cols) -Compress))',
  `    [void]$sb.Append(',"rows":[')`,
  '    $firstR = $true',
  '    while (-not $rs.EOF) {',
  "      $vals = New-Object 'System.Collections.Generic.List[object]'",
  '      for ($i = 0; $i -lt $n; $i++) {',
  '        $v = $rs.Fields.Item($i).Value',
  '        if ($v -eq $null -or $v -is [System.DBNull]) { $vals.Add($null) }',
  "        elseif ($v -is [bool]) { if ($v) { $vals.Add('Yes') } else { $vals.Add('No') } }",
  "        elseif ($v -is [datetime]) { if ($v.TimeOfDay.TotalSeconds -eq 0) { $vals.Add($v.ToString('yyyy-MM-dd')) } else { $vals.Add($v.ToString('yyyy-MM-dd HH:mm:ss')) } }",
  '        else { $vals.Add([string]$v) }',
  '      }',
  "      if (-not $firstR) { [void]$sb.Append(',') }",
  '      $firstR = $false',
  '      [void]$sb.Append((ConvertTo-Json -InputObject $vals.ToArray() -Compress))',
  '      $rs.MoveNext()',
  '    }',
  "    [void]$sb.Append(']}')",
  '    $rs.Close()',
  '  }',
  "  [void]$sb.Append('}')",
  '  $conn.Close()',
  '  [System.IO.File]::WriteAllText($OutPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))',
  "  Write-Output ('RESULT tables=' + $names.Count)",
  '  exit 0',
  '} catch {',
  "  Write-Output ('ERROR ' + $_.Exception.Message)",
  '  exit 2',
  '}'
].join('\r\n');

const readAccess = async file => {
  if (process.platform !== 'win32') throw new Error('Reading Access files is only possible on Windows');
  const isMdb = /\.mdb$/i.test(file);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-read-'));
  const local = path.join(work, 'source' + (isMdb ? '.mdb' : '.accdb'));
  fs.copyFileSync(file, local);
  const attempts = [
    { ps: PS64, provider: 'Microsoft.ACE.OLEDB.12.0' }, { ps: PS64, provider: 'Microsoft.ACE.OLEDB.16.0' },
    { ps: PS32, provider: 'Microsoft.ACE.OLEDB.12.0' }, { ps: PS32, provider: 'Microsoft.ACE.OLEDB.16.0' }
  ];
  if (isMdb) attempts.push({ ps: PS32, provider: 'Microsoft.Jet.OLEDB.4.0' });
  const tried = [];
  try {
    for (const a of attempts) {
      if (!fs.existsSync(a.ps)) continue;
      const out = path.join(work, 'out.json');
      try { fs.unlinkSync(out); } catch (e) { /* none */ }
      const script = '$InPath = ' + psQuote(local) + '\r\n$OutPath = ' + psQuote(out) + '\r\n$Provider = ' + psQuote(a.provider) + '\r\n' + PS_READ;
      const r = await runPs(a.ps, script);
      const text = (r.stdout + '\n' + r.stderr).trim();
      if (/RESULT tables=\d+/.test(text) && fs.existsSync(out)) {
        return { file: path.basename(file), provider: a.provider, tables: JSON.parse(fs.readFileSync(out, 'utf8')) };
      }
      tried.push(a.provider + ': ' + (text.split(/\r?\n/).find(l => l.startsWith('ERROR ')) || text || 'failed').slice(0, 200));
    }
  } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  const e = new Error('Could not open this Access database. If it is password-protected, remove the password first; otherwise install the free "Microsoft Access Database Engine 2016 Redistributable". ' + tried.join(' | '));
  throw e;
};

/* ---------- orchestration ---------- */
const stamp = sec => { const d = new Date(), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + (sec ? p(d.getSeconds()) : ''); };
const prune = (dir, prefix, keep) => {
  for (const ext of ['.sqlite', '.accdb', '.mdb']) {
    const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith(ext)).sort().reverse();
    files.slice(keep).forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ } });
  }
};

const run = async ({ folder, kind, tables, full, version, auto }) => {
  if (!['access', 'sqlite', 'both'].includes(kind)) throw new Error('Unknown backup type');
  if (!tables || typeof tables !== 'object') throw new Error('No data to back up');
  const dir = auto ? path.join(folder, 'Auto') : folder;
  fs.mkdirSync(dir, { recursive: true });
  const model = buildModel(tables);
  const base = path.join(dir, (auto ? 'EDCL_AutoBackup_' : 'EDCL_Backup_') + stamp(!!auto));
  const result = { folder: dir, files: [], errors: [] };
  const meta = { created: new Date().toISOString(), version: version || '' };
  if (kind === 'sqlite' || kind === 'both') {
    try { const r = writeSqlite(base + '.sqlite', model, full, meta); result.files.push({ type: 'sqlite', ...r }); }
    catch (e) { result.errors.push({ type: 'sqlite', message: e.message }); }
  }
  if (kind === 'access' || kind === 'both') {
    try { const r = await writeAccess(base, model); result.files.push({ type: 'access', ...r }); }
    catch (e) { result.errors.push({ type: 'access', message: e.message, details: e.details || [] }); }
  }
  if (auto) { try { prune(dir, 'EDCL_AutoBackup_', 15); } catch (e) { /* keep going */ } }
  return result;
};

module.exports = { run, readPayload, readAccess, PS_READ, buildModel, writeSqlite, FORMAT, PS_BODY };
