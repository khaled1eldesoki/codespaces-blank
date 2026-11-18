// Orchestrator: real server (HTTPS, private CA) + two real Electron workstations. Run:
//   xvfb-run -a node tests/electron/central-e2e.js   (ELECTRON=<path to electron 35.7.5 binary>)
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..', '..'), ELECTRON = process.env.ELECTRON || path.join(root, '..', 'electron35', 'dist', 'electron');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-e2e-')), PORT = 18443 + (process.pid % 500);
const cli = (...a) => spawnSync(process.execPath, ['--no-warnings', path.join(root, 'server', 'cli.js'), ...a], { encoding: 'utf8' });
const out = []; const ok = (n, c, d) => { out.push((c ? 'ok   ' : 'FAIL ') + n + (d ? '  [' + d + ']' : '')); console.log(out[out.length - 1]); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { createServer } = require(path.join(root, 'server', 'server'));
(async () => {
  // 1. server PC: certificates + data import (legacy hashes, like a real migration) + HTTPS server
  const certs = path.join(tmp, 'certs'), data = path.join(tmp, 'data');
  let r = cli('make-certs', '--out', certs, '--name', 'localhost', '--ip', '127.0.0.1', '--url', 'https://localhost:' + PORT); ok('server: certificates created', r.status === 0, r.stderr.slice(0, 100));
  const l = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8').split('\n').find(x => x.startsWith('let D={')); const D = eval('(' + l.replace(/^let D=/, '').replace(/;\s*$/, '') + ')');
  const lh = (u, p) => crypto.createHash('sha256').update(u + ':' + p).digest('hex');
  for (const k of ['Audit', 'Access', 'TrainForms', 'News', 'CustomTabs']) D[k] = []; D.Brand = {}; D.SystemAdministrator = 'admin'; D.seeded = 1;
  D.Users = [['admin', 'System Administrator', '', 'admin'], ['qa.a', 'QA A', '', 'quality'], ['qa.b', 'QA B', '', 'quality']].map(([u, n, s, role]) => ({ username: u, name: n, StaffID: s, role, active: 'Yes', must: 1, hash: lh(u, 'Test-Password-1') }));
  const bk = path.join(tmp, 'backup.json'); fs.writeFileSync(bk, JSON.stringify({ D, files: [] }));
  r = cli('import', bk, '--data', data); ok('server: migration import of the legacy backup', r.status === 0 && /records/.test(r.stdout), (r.stdout.match(/"records": (\d+)/) || [])[0]);
  const startSrv = async () => { const s = createServer({ dataDir: data, port: PORT, host: '127.0.0.1', tls: { key: path.join(certs, 'server.key'), cert: path.join(certs, 'server.crt') }, backupDir: path.join(tmp, 'bk') }); await s.start(); return s; };
  let srv = await startSrv();
  // 2. two workstations, each with its OWN data folder and the client config the installer would write
  const mk = role => { const cfg = path.join(tmp, 'cfg-' + role), ud = path.join(cfg, 'EDCL Lab System'); fs.mkdirSync(ud, { recursive: true }); fs.copyFileSync(path.join(certs, 'client-config', 'ca.crt'), path.join(ud, 'ca.crt')); fs.writeFileSync(path.join(ud, 'central.json'), JSON.stringify({ serverUrl: 'https://localhost:' + PORT })); return cfg; };
  const outDir = path.join(tmp, 'out'); fs.mkdirSync(outDir);
  const run = (role, user, pass) => new Promise(res => { const p = spawn(ELECTRON, ['--no-sandbox', '--disable-gpu', path.join(root, 'tests', 'electron', 'central-client.js')], { env: { ...process.env, ROLE: role, OUT_DIR: outDir, APP_ROOT: process.env.CLIENT_ROOT || root, USER_NAME: user, PASS: pass, XDG_CONFIG_HOME: mk(role), NODE_PATH: path.join(root, 'node_modules') }, stdio: 'ignore' }); p.on('exit', res); setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 420000); });
  // first sign-in must force a password change: set the new passwords through the API first (as a user would in the dialog)
  const https = require('https'), ca = fs.readFileSync(path.join(certs, 'ca.crt'));
  const api = (m, p, body, tok) => new Promise((res, no) => { const d = body ? Buffer.from(JSON.stringify(body)) : null; const q = https.request({ host: 'localhost', port: PORT, path: p, method: m, ca, headers: { 'Content-Type': 'application/json', ...(d ? { 'Content-Length': d.length } : {}), ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } }, rs => { const c = []; rs.on('data', x => c.push(x)); rs.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c)); } catch (e) {} res({ status: rs.statusCode, json: j }); }); }); q.on('error', no); if (d) q.write(d); q.end(); });
  for (const u of ['qa.a', 'qa.b']) { const lg = await api('POST', '/api/login', { username: u, password: 'Test-Password-1' }); ok('legacy password accepted once for ' + u + ' and flagged for change', lg.status === 200 && lg.json.mustChange === true); const pc = await api('POST', '/api/password', { oldPassword: 'Test-Password-1', newPassword: 'New-Password-Lab-2026' }, lg.json.token); ok('password changed (>=10 chars, scrypt)', pc.status === 200); }
  const pA = run('A', 'qa.a', 'New-Password-Lab-2026'), pB = run('B', 'qa.b', 'New-Password-Lab-2026');
  const L = role => { try { return Object.fromEntries(fs.readFileSync(path.join(outDir, role + '.log'), 'utf8').trim().split('\n').map(x => JSON.parse(x))); } catch (e) { return {}; } };
  const waitLog = async (key, roles, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (roles.every(r => L(r)[key] !== undefined)) return true; await sleep(500); } return false; };
  const p1 = await waitLog('phase1-done', ['A', 'B'], 200000); ok('both workstations finished phase 1 (sign-in, edit, upload, cross-visibility)', p1);
  // 3. server outage while A keeps working
  await srv.stop(); await sleep(500); fs.writeFileSync(path.join(outDir, 'phase2'), '1'); await sleep(6000); srv = await startSrv(); ok('server restarted on the same data after an outage', true);
  await Promise.all([pA, pB]);
  const a = L('A'), b = L('B');
  ok('A: real login through the app UI against the HTTPS server (private CA, no Windows trust store)', a['signed-in'] === true && a.user === 'qa.a' && a['central-on'] === true);
  ok('B: real login', b['signed-in'] === true && b.user === 'qa.b');
  ok('both received the central data (' + a['employees-loaded'] + ' employees)', a['employees-loaded'] === 18 && b['employees-loaded'] === 18);
  ok('screens (emp, docs, train, auth, backup, users) open without error in server mode', a['screens-ok'] === true && b['screens-ok'] === true);
  ok('B sees A\'s edit', b['B-sees-A-field'] === true); ok('B downloads A\'s uploaded file from the server with identical content', b['B-sees-A-file'] === true && /^100017:PDF-bytes-from-/.test(b['B-file-bytes']), b['B-file-bytes']);
  ok('A sees B\'s edit AND keeps its own (different fields of the same record)', a['A-sees-B-field'] === true); ok('A sees B\'s uploaded file', a['A-sees-B-file'] === true);
  ok('A shows "server unreachable" while the server is down', a['A-offline-badge'] === true);
  ok('A\'s edit made during the outage is delivered after the server returns, status back to connected', a['A-synced-after-return'] === true);
  ok('B receives the edit that was made during the outage', b['B-sees-offline-edit'] === true);
  ok('no script errors reported by either window', (a['console-errors'] || []).length === 0 && (b['console-errors'] || []).length === 0, JSON.stringify([a['console-errors'], b['console-errors']]).slice(0, 300));
  const db = srv.db; ok('server holds exactly one copy of each uploaded file', db.prepare("SELECT COUNT(*) c FROM files WHERE cat='sop' AND deleted=0").get().c === 2);
  ok('password hashes were never written to shared records', !db.prepare('SELECT data FROM records').all().some(x => /"hash"/.test(x.data || '')));
  await srv.stop(); console.log('\n' + out.filter(x => x.startsWith('FAIL')).length + ' failed of ' + out.length); console.log('logs: ' + outDir); fs.writeFileSync(path.join(root, 'docs', 'TEST_RESULTS_central_e2e.txt'), out.join('\n') + '\n\nElectron ' + (spawnSync(ELECTRON, ['--no-sandbox', '--version'], { encoding: 'utf8' }).stdout || '').trim() + ', Linux/xvfb, ' + new Date().toISOString() + '\nA log: ' + JSON.stringify(a) + '\nB log: ' + JSON.stringify(b) + '\n');
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.error('ORCHESTRATOR ERROR', e); process.exit(2); });
