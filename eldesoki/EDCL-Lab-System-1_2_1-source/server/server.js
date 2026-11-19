'use strict';
// EDCL central server: one SQLite database, individual accounts, per-record optimistic sync, live change events.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const db_ = require('./db');
const store = require('./store');
const auth = require('./auth');
const files = require('./files');
const wadaFeed = require('./wada-feed');
const monitor = require('./monitor');
const crypto = require('crypto');
const os = require('os');
const VERSION = require('../package.json').version;

const TABLE_WRITE = { Settings: ['users'], Evaluation: ['edit', 'assess'], default: ['edit'] };
const FULL_READ = ['edit', 'audit', 'assess', 'users'];
const MAX_BODY = 8 * 1024 * 1024, MAX_OPS = 200;

function createServer({ dataDir, port = 8443, host = '0.0.0.0', tls = null, backupEveryMs = 0, keepBackups = 30, backupDir = '', maxFileBytes = 300 * 1024 * 1024, wadaHours = 0, wadaFetch = null, serverName = 'EDCL Server', configFile = '', onRestart = null, log: logOut = () => {} }) {
  const mon = monitor.createMonitor();
  const log = (...a) => { mon.log('info', ...a); try { logOut(...a); } catch (e) {} };
  const db = db_.open(path.join(dataDir, 'edcl-central.sqlite'));
  auth.seedRoles(db); files.init(db);
  let bkRoot = backupDir || path.join(dataDir, 'backups');
  const startedIso = new Date().toISOString();
  const lastBackup = { at: null, ok: null, error: '' };
  const sse = new Set();
  const broadcast = () => { const m = `data: {"seq":${db_.curSeq(db)}}\n\n`; for (const r of sse) { try { r.write(m); } catch (e) { sse.delete(r); } } };
  const broadcastFiles = () => { const m = `event: files\ndata: {"seq":${db_.curSeq(db)}}\n\n`; for (const r of sse) { try { r.write(m); } catch (e) { sse.delete(r); } } };
  const canWrite = (u, tbl) => (TABLE_WRITE[tbl] || TABLE_WRITE.default).some(p => u.perms[p]);
  const fullRead = u => FULL_READ.some(p => u.perms[p]);
  const canRead = (u, rec) => fullRead(u) || !rec.data || rec.data.StaffID === undefined || String(rec.data.StaffID).toLowerCase() === String(u.staffId || u.username).toLowerCase();

  function backup(label) {
    try { return backupInner(label); }
    catch (e) { lastBackup.ok = false; lastBackup.error = e.message; log('backup FAILED', e.message); throw e; }
  }
  function backupInner(label) {
    const dir = bkRoot; fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `edcl-${new Date().toISOString().replace(/[:.]/g, '-')}${label ? '-' + label : ''}.sqlite`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const Drv = db.constructor, chk = new Drv(file);
    try {
      const ic = chk.prepare('PRAGMA integrity_check').get();
      const ok = Object.values(ic)[0] === 'ok';
      const n = chk.prepare('SELECT COUNT(*) c FROM records').get().c, m = db.prepare('SELECT COUNT(*) c FROM records').get().c;
      if (!ok || n !== m) { chk.close(); fs.unlinkSync(file); throw new Error('Backup verification failed'); }
      chk.close();
    } catch (e) { try { chk.close(); } catch (x) {} throw e; }
    const all = fs.readdirSync(dir).filter(f => /^edcl-.*\.sqlite$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - keepBackups))) fs.unlinkSync(path.join(dir, f));
    const mirrored = mirrorBlobs(dir);   // uploaded documents are immutable and content-addressed: copy only the ones not yet in the backup location
    lastBackup.at = new Date().toISOString(); lastBackup.ok = true; lastBackup.error = '';
    log('backup ok', path.basename(file), label || '');
    return { file, size: fs.statSync(file).size, records: db.prepare('SELECT COUNT(*) c FROM records').get().c, files: mirrored };
  }
  function mirrorBlobs(dir) {
    const src = path.join(dataDir, 'files'), dst = path.join(dir, 'files'); let copied = 0, total = 0;
    if (!fs.existsSync(src)) return { total: 0, copied: 0 };
    for (const a of fs.readdirSync(src)) {
      const sd = path.join(src, a); if (!fs.statSync(sd).isDirectory()) continue;
      fs.mkdirSync(path.join(dst, a), { recursive: true });
      for (const f of fs.readdirSync(sd)) { if (f.endsWith('.part')) continue; total++; const d = path.join(dst, a, f); if (!fs.existsSync(d)) { fs.copyFileSync(path.join(sd, f), d); copied++; } }
    }
    return { total, copied };
  }

  const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
  const body = req => new Promise((ok, no) => {
    let n = 0; const c = [];
    req.on('data', d => { n += d.length; if (n > MAX_BODY) { no(Object.assign(new Error('Request too large'), { code: 413 })); req.destroy(); } else c.push(d); });
    req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}); } catch (e) { no(Object.assign(new Error('Invalid JSON'), { code: 400 })); } });
    req.on('error', no);
  });


  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
  function serveMobile(p, res) {
    const root = path.join(__dirname, 'mobile'); let rel = p.replace(/^\/m\/?/, '') || 'index.html';
    const f = path.join(root, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: 'Not found' });
    const b = fs.readFileSync(f); res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Length': b.length }); res.end(b);
  }
  let setupBusy = false;
  const FILE_WRITE = ['edit', 'assess', 'own'];
  const ownCat = (u, cat) => { const m2 = /^(?:ev|fdone|own):(.+)$/.exec(cat || ''); return m2 ? m2[1].toLowerCase() : null; };
  const fileReadable = (u, f) => { const o = ownCat(u, f.cat); return fullRead(u) || !/^ev:/.test(f.cat || '') || o === String(u.staffId || u.username).toLowerCase(); };
  const fileWritable = (u, cat) => u.perms.edit || ((u.perms.assess || u.perms.own) && /^(ev|fdone):/.test(cat || ''));

  // ---------- administration helpers (dashboard) ----------
  const activeSessions = () => { const t = Date.now(); return db.prepare('SELECT COUNT(*) c FROM sessions WHERE expires>? AND last_seen>?').get(t, t - auth.IDLE_MS).c; };
  const auditRow = (user, action, rid, detail) => db.prepare('INSERT INTO audit(at,user,action,rid,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(), user, action, rid || null, detail || '');
  const listBackups = () => !fs.existsSync(bkRoot) ? [] : fs.readdirSync(bkRoot).filter(f => /^edcl-.*\.sqlite$/.test(f))
    .map(f => { const st = fs.statSync(path.join(bkRoot, f)); return { file: f, size: st.size, modified: st.mtime.toISOString() }; })
    .sort((a, b) => b.modified.localeCompare(a.modified));
  const fsize = f => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
  const adminCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  // "this PC": loopback, or one of this machine's own addresses (the dashboard may connect through the server's LAN name)
  const isLoopback = req => {
    const a = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (a === '127.0.0.1' || a === '::1') return true;
    try { return Object.values(os.networkInterfaces()).flat().some(i => i && i.address === a); } catch (e) { return false; }
  };
  const RANGES = { backupMinutes: [0, 1440], keepBackups: [1, 365], wadaHours: [0, 168], maxFileMB: [1, 1000] };

  function metrics() {
    const snap = mon.snapshot(), t = Date.now();
    const fa = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) b FROM files WHERE deleted=0').get();
    const deletedFiles = db.prepare('SELECT COUNT(*) n FROM files WHERE deleted=1').get().n;
    const dbFile = path.join(dataDir, 'edcl-central.sqlite');
    const bl = listBackups(), last = bl[0] || null, ageMin = last ? Math.round((t - Date.parse(last.modified)) / 60000) : null;
    const failedHour = db.prepare("SELECT COUNT(*) c FROM audit WHERE action IN ('login-failed','reauth-failed') AND at>?").get(new Date(t - 3600e3).toISOString()).c;
    const locked = db.prepare('SELECT COUNT(*) c FROM users WHERE locked_until>?').get(t).c;
    const cert = monitor.certInfo(tls && tls.cert);
    const dataDisk = monitor.disk(dataDir), backupDisk = monitor.disk(fs.existsSync(bkRoot) ? bkRoot : dataDir);
    const wada = (store.getRecord(db, 'WadaStatus', 'main') || {}).data || null;
    const alerts = [], add = (level, id, text) => alerts.push({ level, id, text });
    if (lastBackup.ok === false) add('bad', 'backup-failed', 'The last backup failed: ' + lastBackup.error);
    const limitMin = Math.max(120, (backupEveryMs / 60000) * 2.5);
    if (!last) add('warn', 'backup-none', 'No database backup exists yet.');
    else if (backupEveryMs > 0 && ageMin > limitMin) add(ageMin > limitMin * 3 ? 'bad' : 'warn', 'backup-stale', `The newest backup is ${ageMin >= 120 ? Math.round(ageMin / 60) + ' hours' : ageMin + ' minutes'} old (automatic backups run every ${Math.round(backupEveryMs / 60000)} min).`);
    else if (backupEveryMs === 0 && ageMin > 1440) add('warn', 'backup-stale', 'Automatic backups are switched off and the newest backup is over a day old.');
    for (const [name, d] of [['database', dataDisk], ['backup', backupDisk]]) {
      if (!d || !d.total) continue; const pct = d.free / d.total * 100;
      if (pct < 5 || d.free < 2 * 2 ** 30) add('bad', 'disk-' + name, `Very little space left on the ${name} disk (${(d.free / 2 ** 30).toFixed(1)} GB free).`);
      else if (pct < 10 || d.free < 10 * 2 ** 30) add('warn', 'disk-' + name, `The ${name} disk is getting full (${(d.free / 2 ** 30).toFixed(1)} GB free).`);
    }
    if (cert) { if (cert.daysLeft < 0) add('bad', 'cert', 'The HTTPS certificate has expired - workstations cannot connect.'); else if (cert.daysLeft < 30) add('warn', 'cert', `The HTTPS certificate expires in ${cert.daysLeft} day(s). Renew it from Configuration.`); }
    if (!tls) add('warn', 'plain-http', 'The server is running without HTTPS (test mode). Passwords cross the network unprotected.');
    const failing = wada && Array.isArray(wada.Sources) ? wada.Sources.filter(x => x && x.ok === false) : [];
    if (failing.length) add('warn', 'wada', `${failing.length} WADA source(s) could not be checked.`);
    if (failedHour >= 10) add('warn', 'logins', `${failedHour} failed sign-in attempts in the last hour.`);
    if (locked) add('warn', 'locked', `${locked} account(s) are temporarily locked after failed sign-ins.`);
    if (snap.series.slice(-6).reduce((n, x) => n + (x.err || 0), 0) > 0) add('warn', 'errors', 'The server returned internal errors in the last minute. Check the server log.');
    if (snap.process.rss > 1.5 * 2 ** 30) add('warn', 'memory', 'The server process is using a lot of memory.');
    return {
      time: new Date(t).toISOString(), version: VERSION, name: serverName, driver: db.kind, tls: !!tls, seq: db_.curSeq(db), ...snap,
      sessions: { active: activeSessions(), live: sse.size },
      counts: { records: db.prepare('SELECT COUNT(*) c FROM records WHERE deleted=0').get().c, users: db.prepare('SELECT COUNT(*) c FROM users WHERE active=1').get().c, files: fa.n },
      storage: { dbBytes: fsize(dbFile), walBytes: fsize(dbFile + '-wal'), fileBytes: fa.b, deletedFiles, dataDisk, backupDisk, dataDir, backupDir: bkRoot },
      backups: { count: bl.length, last, ageMinutes: ageMin, intervalMinutes: Math.round(backupEveryMs / 60000), keep: keepBackups, lastRunOk: lastBackup.ok, lastError: lastBackup.error },
      cert, wada, security: { failedLastHour: failedHour, lockedAccounts: locked }, alerts
    };
  }

  let fileCheck = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, bytes: 0, missingCount: 0, corruptCount: 0, missing: [], corrupt: [], by: '' };
  async function runFileCheck(by) {
    const rows = db.prepare('SELECT sha256, MIN(name) name FROM files WHERE deleted=0 GROUP BY sha256').all();
    const fc = fileCheck = { running: true, startedAt: new Date().toISOString(), finishedAt: null, total: rows.length, done: 0, bytes: 0, missingCount: 0, corruptCount: 0, missing: [], corrupt: [], by };
    try {
      for (const r of rows) {
        const bp = files.blobPath(dataDir, r.sha256);
        if (!fs.existsSync(bp)) { fc.missingCount++; if (fc.missing.length < 200) fc.missing.push({ sha256: r.sha256, name: r.name }); }
        else {
          try {
            const h = await new Promise((ok, no) => { const hh = crypto.createHash('sha256'); fs.createReadStream(bp).on('data', d => { hh.update(d); fc.bytes += d.length; }).on('end', () => ok(hh.digest('hex'))).on('error', no); });
            if (h !== r.sha256) { fc.corruptCount++; if (fc.corrupt.length < 200) fc.corrupt.push({ sha256: r.sha256, name: r.name }); }
          } catch (e) { fc.corruptCount++; if (fc.corrupt.length < 200) fc.corrupt.push({ sha256: r.sha256, name: r.name, error: e.message }); }
        }
        fc.done++;
      }
    } finally {
      fc.running = false; fc.finishedAt = new Date().toISOString();
      try { auditRow(by, 'files-verify', null, `${fc.done} blobs, ${fc.missingCount} missing, ${fc.corruptCount} corrupt`); } catch (e) {}
      log('file check finished', fc.done + ' blobs', fc.missingCount + ' missing', fc.corruptCount + ' corrupt');
    }
  }

  const currentConfig = () => ({ serverName, host, port: server.address() ? server.address().port : port, tls: !!tls, dataDir, backupDir: bkRoot, backupMinutes: Math.round(backupEveryMs / 60000), keepBackups, wadaHours, maxFileMB: Math.round(maxFileBytes / 1048576), persisted: !!configFile, configFile: configFile || '' });
  function applyConfig(ch) {
    const next = {};
    for (const k of Object.keys(RANGES)) {
      if (ch[k] === undefined || ch[k] === '') continue;
      const v = Number(ch[k]); if (!Number.isInteger(v) || v < RANGES[k][0] || v > RANGES[k][1]) throw new Error('Invalid value for ' + k);
      next[k] = v;
    }
    if (ch.serverName !== undefined) { const n = String(ch.serverName).trim(); if (!n || n.length > 80 || /[\r\n]/.test(n)) throw new Error('Invalid server name'); next.serverName = n; }
    if (ch.backupDir !== undefined) {
      const d = String(ch.backupDir).trim(); if (!d || d.length > 400) throw new Error('Invalid backup folder');
      const r = path.resolve(d); fs.mkdirSync(r, { recursive: true }); fs.accessSync(r, fs.constants.W_OK); next.backupDir = r.replace(/\\/g, '/');
    }
    if (configFile) {   // persist first: if the file cannot be written nothing changes in memory either
      const cur = JSON.parse(fs.readFileSync(configFile, 'utf8')), tmp = configFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ ...cur, ...next }, null, 2), { mode: 0o600 }); fs.renameSync(tmp, configFile);
    }
    if (next.backupMinutes !== undefined) backupEveryMs = next.backupMinutes * 60000;
    if (next.keepBackups !== undefined) keepBackups = next.keepBackups;
    if (next.wadaHours !== undefined) wadaHours = next.wadaHours;
    if (next.maxFileMB !== undefined) maxFileBytes = next.maxFileMB * 1048576;
    if (next.serverName !== undefined) serverName = next.serverName;
    if (next.backupDir !== undefined) bkRoot = next.backupDir;
    armTimers();
    return Object.keys(next);
  }

  // returns true when the request was handled here
  async function adminExt(req, res, u, p, m, url) {
    const admin = u.role === 'admin';
    if (p === '/api/admin/metrics' && m === 'GET') {
      if (!u.perms.backup && !u.perms.users) return send(res, 403, { error: 'Permission denied' }), true;
      return send(res, 200, metrics()), true;
    }
    if (p === '/api/admin/backups' && m === 'GET') {
      if (!u.perms.backup && !u.perms.recover) return send(res, 403, { error: 'Permission denied' }), true;
      return send(res, 200, { dir: bkRoot, backups: listBackups().slice(0, 100) }), true;
    }
    if (p === '/api/admin/backups/verify' && m === 'POST') {
      if (!u.perms.backup && !u.perms.recover) return send(res, 403, { error: 'Permission denied' }), true;
      const b = await body(req), name = path.basename(String(b.file || ''));
      if (!/^edcl-[A-Za-z0-9._-]+\.sqlite$/.test(name)) return send(res, 400, { error: 'Invalid backup file' }), true;
      const f = path.join(bkRoot, name); if (!fs.existsSync(f)) return send(res, 404, { error: 'Backup file not found' }), true;
      const chk = new db.constructor(f);
      try {
        const ic = Object.values(chk.prepare('PRAGMA integrity_check').get())[0];
        const out = { file: name, integrity: ic, records: chk.prepare('SELECT COUNT(*) c FROM records').get().c, users: chk.prepare('SELECT COUNT(*) c FROM users').get().c, files: chk.prepare('SELECT COUNT(*) c FROM files WHERE deleted=0').get().c };
        return send(res, 200, out), true;
      } catch (e) { return send(res, 200, { file: name, integrity: 'unreadable: ' + e.message }), true; }
      finally { try { chk.close(); } catch (e) {} }
    }
    if (!u.perms.users) return false;
    if (p === '/api/admin/sessions' && m === 'GET') {
      const t = Date.now();
      const rows = db.prepare('SELECT s.tokhash,s.username,s.created,s.last_seen,s.expires,s.device,u.name,u.role FROM sessions s LEFT JOIN users u ON u.username=s.username WHERE s.expires>? AND s.last_seen>? ORDER BY s.last_seen DESC').all(t, t - auth.IDLE_MS);
      return send(res, 200, { sessions: rows.map(r => ({ id: r.tokhash.slice(0, 16), username: r.username, name: r.name, role: r.role, device: r.device, created: r.created, lastSeen: r.last_seen, expires: r.expires, current: r.tokhash === u.tokhash })) }), true;
    }
    if (p === '/api/admin/sessions/revoke' && m === 'POST') {
      const b = await body(req), id = String(b.id || '');
      if (!/^[0-9a-f]{16}$/.test(id)) return send(res, 400, { error: 'Invalid session id' }), true;
      const s = db.prepare('SELECT s.tokhash, s.username, u.role FROM sessions s LEFT JOIN users u ON u.username=s.username WHERE substr(s.tokhash,1,16)=?').get(id);
      if (!s) return send(res, 404, { error: 'That session has already ended' }), true;
      if (s.role === 'admin' && !admin) return send(res, 403, { error: 'Only an administrator can sign out administrators' }), true;
      db.prepare('DELETE FROM sessions WHERE tokhash=?').run(s.tokhash); auditRow(u.username, 'session-revoke', s.username);
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/admin/files' && m === 'GET') {
      const q = url.searchParams, cat = q.get('cat') || '', term = (q.get('q') || '').toLowerCase().slice(0, 80), del = q.get('deleted') === '1';
      const limit = Math.min(500, Math.max(1, parseInt(q.get('limit') || '100', 10) || 100)), offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
      let where = 'deleted=?'; const params = [del ? 1 : 0];
      if (cat) { where += ' AND (cat=? OR cat LIKE ?)'; params.push(cat, cat + ':%'); }
      if (term) { where += " AND (LOWER(name) LIKE ? OR LOWER(code) LIKE ? OR LOWER(created_by) LIKE ? OR LOWER(cat) LIKE ?)"; const l = '%' + term + '%'; params.push(l, l, l, l); }
      const total = db.prepare('SELECT COUNT(*) c FROM files WHERE ' + where).get(...params).c;
      const rows = db.prepare('SELECT * FROM files WHERE ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...params, limit, offset);
      const groups = db.prepare("SELECT CASE WHEN instr(cat,':')>0 THEN substr(cat,1,instr(cat,':')-1) ELSE cat END g, COUNT(*) n, COALESCE(SUM(size),0) b FROM files WHERE deleted=0 GROUP BY g ORDER BY b DESC").all();
      return send(res, 200, { total, offset, limit, groups, files: rows.map(r => ({ id: r.id, cat: r.cat, name: r.name, code: r.code, type: r.type, size: r.size, date: r.date, sha256: r.sha256, createdBy: r.created_by, createdAt: r.created_at, deleted: !!r.deleted, deletedBy: r.deleted_by, deletedAt: r.deleted_at, bytesPresent: files.hasBlob(dataDir, r.sha256) })) }), true;
    }
    if (p === '/api/admin/files/verify' && m === 'GET') return send(res, 200, fileCheck), true;
    if (p === '/api/admin/files/verify' && m === 'POST') {
      if (fileCheck.running) return send(res, 409, { error: 'A file check is already running', ...fileCheck }), true;
      runFileCheck(u.username).catch(e => log('file check failed', e.message));
      return send(res, 202, { started: true }), true;
    }
    if (!admin) return /^\/api\/admin\/(config|logs|restart)$/.test(p) ? (send(res, 403, { error: 'Only the system administrator can do this' }), true) : false;
    if (p === '/api/admin/config' && m === 'GET') return send(res, 200, currentConfig()), true;
    if (p === '/api/admin/config' && m === 'POST') {
      const b = await body(req);
      try { const changed = applyConfig(b); auditRow(u.username, 'config-change', null, changed.join(',')); log('config changed by', u.username, changed.join(',')); return send(res, 200, { ok: true, changed, config: currentConfig() }), true; }
      catch (e) { return send(res, 400, { error: e.message }), true; }
    }
    if (p === '/api/admin/logs' && m === 'GET') return send(res, 200, { startedAt: startedIso, lines: mon.logs(parseInt(url.searchParams.get('limit') || '300', 10) || 300) }), true;
    if (p === '/api/admin/restart' && m === 'POST') {
      if (!onRestart) return send(res, 501, { error: 'This server was started without restart support' }), true;
      auditRow(u.username, 'server-restart'); log('restart requested by', u.username);
      send(res, 200, { ok: true }); setTimeout(() => { try { onRestart(); } catch (e) { log('restart failed', e.message); } }, 400); return true;
    }
    return false;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;

    if (p === '/api/health') return send(res, 200, { ok: true, seq: db_.curSeq(db), driver: db.kind, version: VERSION });
    if (p === '/api/info') return send(res, 200, { ok: true, product: 'EDCL central server', name: serverName, version: VERSION, tls: !!tls, seq: db_.curSeq(db), time: new Date().toISOString() });
    if ((p === '/m' || p.startsWith('/m/')) && m === 'GET') return serveMobile(p, res);
    if (p === '/api/setup/state' && m === 'GET') return send(res, 200, { needsOwner: adminCount() === 0, name: serverName, version: VERSION });
    if (p === '/api/setup/owner' && m === 'POST') {
      // first-run only: allowed from the server PC itself while no administrator exists
      const b = await body(req);
      if (adminCount() > 0) return send(res, 409, { error: 'An administrator already exists' });
      if (!isLoopback(req)) return send(res, 403, { error: 'The first administrator can only be created on the server PC itself' });
      if (String(b.password || '').length < 10) return send(res, 400, { error: 'Password must be at least 10 characters' });
      if (setupBusy) return send(res, 409, { error: 'Setup is already in progress' });
      setupBusy = true;
      try { const name = await auth.createUser(db, { username: b.username, name: b.name || 'System Owner', role: 'admin', password: b.password, mustChange: false }); auditRow('setup', 'owner-create', name); log('first administrator created:', name); return send(res, 200, { ok: true, username: name }); }
      catch (e) { return send(res, 400, { error: e.message }); }
      finally { setupBusy = false; }
    }
    if (p === '/api/login' && m === 'POST') {
      const b = await body(req);
      const r = await auth.login(db, b.username, b.password, b.device || req.socket.remoteAddress);
      return send(res, r.ok ? 200 : (r.locked ? 429 : 401), r);
    }
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const u = auth.authenticate(db, token);
    if (!u) return send(res, 401, { error: 'Not signed in' });
    if (p === '/api/logout' && m === 'POST') { auth.logout(db, token); return send(res, 200, { ok: true }); }
    if (p === '/api/password' && m === 'POST') {
      const b = await body(req);
      try { await auth.changePassword(db, u.username, b.oldPassword, b.newPassword); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (u.mustChange) return send(res, 403, { error: 'Password change required', mustChange: true });
    if (p === '/api/reauth' && m === 'POST') {
      const b = await body(req);
      const r = await auth.verifyPassword(db, u.username, b.password);
      return send(res, r.ok ? 200 : (r.locked ? 429 : 401), r);
    }
    if (p === '/api/me') return send(res, 200, { user: { username: u.username, name: u.name, staffId: u.staffId, role: u.role, perms: u.perms } });

    if (p === '/api/sync' && m === 'GET') {
      const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
      const limit = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('limit') || '1000', 10) || 1000));
      const r = store.changesSince(db, since, limit, rec => canRead(u, rec));
      return send(res, 200, { seq: db_.curSeq(db), lastSeq: r.lastSeq, more: r.more, changes: r.changes });
    }
    if (p === '/api/push' && m === 'POST') {
      const b = await body(req);
      if (!Array.isArray(b.ops) || !b.ops.length || b.ops.length > MAX_OPS) return send(res, 400, { error: `ops must contain 1-${MAX_OPS} operations` });
      const results = db.tx(() => b.ops.map(op => {
        if (!op || typeof op.tbl !== 'string') return { ok: false, error: 'Invalid operation' };
        if (!canWrite(u, op.tbl)) return { ok: false, denied: true, error: 'Permission denied for ' + op.tbl };
        const cur = store.getRecord(db, op.tbl, String(op.id));
        if (cur && !canRead(u, cur)) return { ok: false, denied: true, error: 'Permission denied' };
        const r = store.applyOp(db, u.username, { ...op, id: String(op.id) });
        if (r.conflict) db.prepare('INSERT INTO audit(at,user,action,tbl,rid,detail) VALUES(?,?,?,?,?,?)').run(new Date().toISOString(), u.username, 'conflict', op.tbl, String(op.id), (r.reason || '') + (r.fields ? ': ' + r.fields.join(',') : ''));
        return r;
      }));
      if (results.some(r => r.ok && !r.noop)) broadcast();
      return send(res, 200, { seq: db_.curSeq(db), results });
    }
    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: {"seq":${db_.curSeq(db)}}\n\n`);
      sse.add(res); req.on('close', () => sse.delete(res)); return;
    }

    // ---- central file store ----
    if (p === '/api/files' && m === 'GET') {
      const cat = url.searchParams.get('cat') || '';
      return send(res, 200, { files: files.list(db, cat).filter(f => fileReadable(u, f)) });
    }
    if (p === '/api/files' && m === 'POST') {
      const b = await body(req);
      if (!fileWritable(u, b.cat)) return send(res, 403, { error: 'Permission denied' });
      try { const f = files.add(db, dataDir, u.username, b); broadcastFiles(); return send(res, 200, { file: f }); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
    }
    let fm = p.match(/^\/api\/files\/(\d+)$/);
    if (fm && m === 'GET') { const f = files.get(db, +fm[1]); return f && fileReadable(u, f) ? send(res, 200, { file: f }) : send(res, 404, { error: 'No such file' }); }
    if (fm && m === 'PUT') {
      const cur = files.get(db, +fm[1]); if (!cur) return send(res, 404, { error: 'No such file' });
      const b = await body(req); if (!fileWritable(u, cur.cat) || !fileWritable(u, b.cat || cur.cat)) return send(res, 403, { error: 'Permission denied' });
      try { const f = files.replace(db, dataDir, u.username, +fm[1], b); broadcastFiles(); return send(res, 200, { file: f }); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
    }
    if (fm && m === 'DELETE') {
      const cur = files.get(db, +fm[1]); if (!cur) return send(res, 404, { error: 'No such file' });
      if (!fileWritable(u, cur.cat)) return send(res, 403, { error: 'Permission denied' });
      files.remove(db, u.username, +fm[1]); broadcastFiles(); return send(res, 200, { ok: true });
    }
    fm = p.match(/^\/api\/blobs\/([0-9a-f]{64})$/);
    if (fm && m === 'PUT') {
      if (!FILE_WRITE.some(k => u.perms[k])) { req.resume(); return send(res, 403, { error: 'Permission denied' }); }
      try { const r = await files.receiveBlob(dataDir, fm[1], req, maxFileBytes); return send(res, 200, { ok: true, ...r }); } catch (e) { return send(res, e.code || 500, { error: e.message }); }
    }
    if (fm && m === 'GET') {
      const meta = db.prepare('SELECT cat FROM files WHERE sha256=? AND deleted=0').all(fm[1]);
      if (!meta.some(f => fileReadable(u, f))) return send(res, 404, { error: 'Not found' });
      const bp = files.blobPath(dataDir, fm[1]); if (!fs.existsSync(bp)) return send(res, 404, { error: 'File bytes missing on the server' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Length': fs.statSync(bp).size });
      return fs.createReadStream(bp).pipe(res);
    }
    // ---- administration (permission 'users' / 'backup') ----
    if (p.startsWith('/api/admin/')) {
      if (await adminExt(req, res, u, p, m, url)) return;
      if (p === '/api/admin/backup' && m === 'POST') {
        if (!u.perms.backup) return send(res, 403, { error: 'Permission denied' });
        try { return send(res, 200, backup('manual')); } catch (e) { return send(res, 500, { error: e.message }); }
      }
      if (p === '/api/admin/status' && m === 'GET') {
        if (!u.perms.backup && !u.perms.users) return send(res, 403, { error: 'Permission denied' });
        const bl = fs.existsSync(bkRoot) ? fs.readdirSync(bkRoot).filter(f => /^edcl-.*\.sqlite$/.test(f)).sort().slice(-10).map(f => ({ file: f, size: fs.statSync(path.join(bkRoot, f)).size })) : [];
        return send(res, 200, { version: VERSION, driver: db.kind, seq: db_.curSeq(db), records: db.prepare('SELECT COUNT(*) c FROM records WHERE deleted=0').get().c, files: db.prepare('SELECT COUNT(*) c FROM files WHERE deleted=0').get().c, users: db.prepare('SELECT COUNT(*) c FROM users WHERE active=1').get().c, sessions: activeSessions(), backups: bl, wada: (store.getRecord(db, 'WadaStatus', 'main') || {}).data || null });
      }
      if (!u.perms.users) return send(res, 403, { error: 'Permission denied' });
      if (p === '/api/admin/roles' && m === 'GET')
        return send(res, 200, { roles: db.prepare('SELECT role,perms FROM roles ORDER BY role').all().map(r => ({ role: r.role, perms: JSON.parse(r.perms) })) });
      if (p === '/api/admin/users' && m === 'GET')
        return send(res, 200, { users: db.prepare('SELECT username,name,staff_id staffId,role,active,must_change mustChange,locked_until lockedUntil FROM users ORDER BY username').all() });
      if (p === '/api/admin/users' && m === 'POST') {
        const b = await body(req);
        if (b.role === 'admin' && u.role !== 'admin') return send(res, 403, { error: 'Only an administrator can create administrators' });
        try { const name = await auth.createUser(db, { username: b.username, name: b.name, staffId: b.staffId, role: b.role, password: b.password }); db.prepare('INSERT INTO audit(at,user,action,rid) VALUES(?,?,?,?)').run(new Date().toISOString(), u.username, 'user-create', name); return send(res, 200, { ok: true, username: name }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      const mm = p.match(/^\/api\/admin\/users\/([a-z0-9._-]+)\/(reset|role|active|signout)$/);
      if (mm && m === 'POST') {
        const b = await body(req), target = db.prepare('SELECT * FROM users WHERE username=?').get(mm[1]);
        if (!target) return send(res, 404, { error: 'No such user' });
        if ((target.role === 'admin' || b.role === 'admin') && u.role !== 'admin') return send(res, 403, { error: 'Only an administrator can change administrators' });
        const a = db.prepare('INSERT INTO audit(at,user,action,rid,detail) VALUES(?,?,?,?,?)');
        try {
          if (mm[2] === 'reset') { await auth.resetPassword(db, target.username, b.password); a.run(new Date().toISOString(), u.username, 'password-reset', target.username, ''); }
          if (mm[2] === 'signout') { db.prepare('DELETE FROM sessions WHERE username=?').run(target.username); a.run(new Date().toISOString(), u.username, 'user-signout', target.username, ''); }
          if (mm[2] === 'role') { if (!db.prepare('SELECT 1 FROM roles WHERE role=?').get(b.role)) throw new Error('Unknown role'); if (target.role === 'admin' && b.role !== 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c < 2) throw new Error('Cannot remove the last administrator'); db.prepare('UPDATE users SET role=? WHERE username=?').run(b.role, target.username); a.run(new Date().toISOString(), u.username, 'role-change', target.username, b.role); }
          if (mm[2] === 'active') { if (target.role === 'admin' && !b.active && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1").get().c < 2) throw new Error('Cannot disable the last administrator'); db.prepare('UPDATE users SET active=? WHERE username=?').run(b.active ? 1 : 0, target.username); if (!b.active) db.prepare('DELETE FROM sessions WHERE username=?').run(target.username); a.run(new Date().toISOString(), u.username, b.active ? 'user-enable' : 'user-disable', target.username, ''); }
          return send(res, 200, { ok: true });
        } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/api/admin/audit' && m === 'GET') {
        if (!u.perms.audit) return send(res, 403, { error: 'Permission denied' });
        return send(res, 200, { rows: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all() });
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  const onReq = (req, res) => {
    const t0 = process.hrtime.bigint(), pth = (req.url || '').split('?')[0];
    if (!/^\/api\/(health|events|admin\/metrics)$/.test(pth) && !/^\/m(\/|$)/.test(pth)) res.on('finish', () => mon.track(res.statusCode, Number(process.hrtime.bigint() - t0) / 1e6));
    handle(req, res).catch(e => { log('error', pth, e.message); if (!res.headersSent) send(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.code ? e.message : 'Server error' }); else res.end(); });
  };
  const server = tls ? https.createServer({ key: fs.readFileSync(tls.key), cert: fs.readFileSync(tls.cert), minVersion: 'TLSv1.2' }, onReq) : http.createServer(onReq);
  server.keepAliveTimeout = 65000;
  let timer = null, wtimer = null, first = null, listening = false;
  const runWada = () => wadaFeed.check({ db, broadcast, log, fetchImpl: wadaFetch || fetch }).catch(e => log('wada-failed', e.message));
  function armTimers() {   // (re)create the periodic jobs from the current settings - also used when the dashboard changes them
    if (!listening) return;
    if (timer) clearInterval(timer); if (wtimer) clearInterval(wtimer); timer = wtimer = null;
    if (wadaHours > 0) wtimer = setInterval(runWada, wadaHours * 3600e3);
    if (backupEveryMs > 0) timer = setInterval(() => { try { backup('auto'); } catch (e) { log('backup-failed', e.message); } }, backupEveryMs);
  }
  const start = () => new Promise(ok => server.listen(port, host, () => {
    listening = true; armTimers();
    if (wadaHours > 0) first = setTimeout(runWada, 20000);
    mon.start(() => ({ sessions: activeSessions(), sse: sse.size }));
    try { mon.sample({ sessions: activeSessions(), sse: sse.size }); } catch (e) {}   // first point immediately so the charts are not empty for 20 s
    log('server started', VERSION, tls ? 'HTTPS' : 'HTTP');
    ok(server.address());
  }));
  const stop = () => new Promise(ok => { listening = false; mon.stop(); if (timer) clearInterval(timer); if (wtimer) clearInterval(wtimer); if (first) clearTimeout(first); for (const r of sse) { try { r.end(); } catch (e) {} } sse.clear(); try { backup('shutdown'); } catch (e) {} server.close(() => { db.close(); ok(); }); server.closeAllConnections && server.closeAllConnections(); });
  return { start, stop, db, backup, server, get bkRoot() { return bkRoot; }, metrics };
}
module.exports = { createServer };
