'use strict';
// Administration API used by the server dashboard: live metrics, sessions, file browser + integrity check,
// backups list/verify, live configuration, log feed, restart hook and first-owner setup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { createServer } = require('../../server/server');
const auth = require('../../server/auth');
const PW = 'Str0ng-Pass-1234';
let srv, base, dir, restarted = 0, cfgFile;
const call = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const login = async u => (await call('POST', '/api/login', { username: u, password: PW, device: 'test-' + u })).body.token;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const upload = async (token, name, bytes, cat = 'doc') => {
  const h = sha(bytes);
  const r = await fetch(base + '/api/blobs/' + h, { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal(r.status, 200);
  return (await call('POST', '/api/files', { cat, name, sha256: h }, token)).body.file;
};

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-admin-'));
  cfgFile = path.join(dir, 'server.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ dataDir: dir, port: 0, backupMinutes: 30, keepBackups: 30, wadaHours: 0, maxFileMB: 300 }));
  srv = createServer({ dataDir: dir, port: 0, host: '127.0.0.1', backupDir: path.join(dir, 'bk'), configFile: cfgFile, onRestart: () => { restarted++; }, backupEveryMs: 30 * 60000 });
  const a = await srv.start(); base = 'http://127.0.0.1:' + a.port;
});
test.after(async () => { await srv.stop(); });

test('setup: first administrator can be created from the server PC only once, and only while none exists', async () => {
  assert.equal((await call('GET', '/api/setup/state')).body.needsOwner, true);
  assert.equal((await call('POST', '/api/setup/owner', { username: 'owner', password: 'short' })).status, 400);
  const r = await call('POST', '/api/setup/owner', { username: 'owner', name: 'Owner', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('GET', '/api/setup/state')).body.needsOwner, false);
  assert.equal((await call('POST', '/api/setup/owner', { username: 'second', password: PW })).status, 409);
  const l = await call('POST', '/api/login', { username: 'owner', password: PW });
  assert.equal(l.status, 200); assert.equal(l.body.mustChange, false);
  await auth.createUser(srv.db, { username: 'qa', name: 'QA', role: 'quality', password: PW, mustChange: false });
  await auth.createUser(srv.db, { username: 'sam', name: 'Sam', role: 'staff', password: PW, mustChange: false });
  await auth.createUser(srv.db, { username: 'fc', name: 'FC', role: 'full_control', password: PW, mustChange: false });
});

test('metrics: shape, permissions, and the session count ignores idle sessions', async () => {
  const t = await login('owner'), sam = await login('sam');
  assert.equal((await call('GET', '/api/admin/metrics', undefined, sam)).status, 403);
  assert.equal((await call('GET', '/api/admin/metrics')).status, 401);
  // an idle session (last seen 2 h ago) must not count as active
  srv.db.prepare("UPDATE sessions SET last_seen=? WHERE username='sam'").run(Date.now() - 2 * 3600e3);
  const m = (await call('GET', '/api/admin/metrics', undefined, t)).body;
  for (const k of ['version', 'uptimeSec', 'process', 'system', 'requests', 'sessions', 'counts', 'storage', 'backups', 'alerts', 'series']) assert.ok(k in m, 'missing ' + k);
  const ownerSessions = srv.db.prepare("SELECT COUNT(*) c FROM sessions WHERE username='owner'").get().c;
  assert.equal(m.sessions.active, ownerSessions, 'only the owner sessions are active, the idle one is not counted');
  assert.equal((await call('GET', '/api/admin/status', undefined, t)).body.sessions, ownerSessions);
  assert.ok(m.storage.dataDisk && m.storage.dataDisk.total > 0);
  assert.ok(m.alerts.some(a => a.id === 'plain-http'), 'HTTP test mode is flagged');
  assert.ok(m.alerts.some(a => a.id === 'backup-none'), 'no backup yet is flagged');
  const q = await login('qa');                       // quality has the backup permission -> may read metrics
  assert.equal((await call('GET', '/api/admin/metrics', undefined, q)).status, 200);
  srv.db.prepare("UPDATE sessions SET last_seen=? WHERE username='sam'").run(Date.now());
});

test('metrics: the time series fills and request counters move', async () => {
  const t = await login('owner');
  for (let i = 0; i < 5; i++) await call('GET', '/api/me', undefined, t);
  const m1 = (await call('GET', '/api/admin/metrics', undefined, t)).body;
  assert.ok(m1.requests.total >= 5);
  assert.ok(m1.requests.byStatus['2xx'] >= 5);
});

test('sessions: list, sign a user out, an admin session needs an admin, ids reveal no token', async () => {
  const t = await login('owner'), sam = await login('sam'), fc = await login('fc');
  const list = (await call('GET', '/api/admin/sessions', undefined, t)).body.sessions;
  const mine = list.find(s => s.current); assert.equal(mine.username, 'owner');
  assert.ok(list.every(s => /^[0-9a-f]{16}$/.test(s.id)));
  assert.ok(!JSON.stringify(list).includes(sam));
  const samRow = list.find(s => s.username === 'sam' && s.device === 'test-sam');
  assert.equal((await call('POST', '/api/admin/sessions/revoke', { id: samRow.id }, t)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, sam)).status, 401, 'revoked token no longer works');
  assert.equal((await call('POST', '/api/admin/sessions/revoke', { id: samRow.id }, t)).status, 404);
  assert.equal((await call('POST', '/api/admin/sessions/revoke', { id: 'zz' }, t)).status, 400);
  assert.equal((await call('POST', '/api/admin/sessions/revoke', { id: mine.id }, fc)).status, 403, 'full_control cannot sign out an administrator');
  const sam2 = await login('sam'); await login('sam');
  assert.equal((await call('POST', '/api/admin/users/sam/signout', {}, t)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, sam2)).status, 401);
  assert.ok((await call('GET', '/api/admin/audit', undefined, t)).body.rows.some(r => r.action === 'user-signout'));
});

test('files: browse, filter, summary, integrity check finds a corrupted and a missing blob', async () => {
  const t = await login('owner'), q = await login('qa');
  const f1 = await upload(t, 'alpha.pdf', Buffer.from('alpha document bytes'), 'doc');
  const f2 = await upload(t, 'beta.pdf', Buffer.from('beta evidence bytes'), 'ev:emp1');
  const f3 = await upload(t, 'gamma.pdf', Buffer.from('gamma bytes to remove'), 'doc');
  await call('DELETE', '/api/files/' + f3.id, undefined, t);
  const all = (await call('GET', '/api/admin/files', undefined, t)).body;
  assert.equal(all.total, 2); assert.ok(all.files.every(f => f.bytesPresent));
  assert.deepEqual(all.groups.map(g => g.g).sort(), ['doc', 'ev']);
  assert.equal((await call('GET', '/api/admin/files?cat=ev', undefined, t)).body.total, 1);
  assert.equal((await call('GET', '/api/admin/files?q=ALPHA', undefined, t)).body.files[0].name, 'alpha.pdf');
  assert.equal((await call('GET', '/api/admin/files?deleted=1', undefined, t)).body.total, 1);
  assert.equal((await call('GET', '/api/admin/files', undefined, q)).status, 403, 'quality has no users permission');
  // clean check
  assert.equal((await call('POST', '/api/admin/files/verify', {}, t)).status, 202);
  let st; for (let i = 0; i < 50; i++) { st = (await call('GET', '/api/admin/files/verify', undefined, t)).body; if (!st.running) break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal(st.running, false); assert.equal(st.total, 2); assert.equal(st.corruptCount, 0); assert.equal(st.missingCount, 0);
  // damage one blob, remove the other
  fs.writeFileSync(path.join(dir, 'files', f1.sha256.slice(0, 2), f1.sha256), 'tampered');
  fs.unlinkSync(path.join(dir, 'files', f2.sha256.slice(0, 2), f2.sha256));
  await call('POST', '/api/admin/files/verify', {}, t);
  for (let i = 0; i < 50; i++) { st = (await call('GET', '/api/admin/files/verify', undefined, t)).body; if (!st.running) break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal(st.corruptCount, 1); assert.equal(st.missingCount, 1);
  assert.equal(st.corrupt[0].name, 'alpha.pdf'); assert.equal(st.missing[0].name, 'beta.pdf');
  assert.equal((await call('GET', '/api/admin/files', undefined, t)).body.files.filter(f => !f.bytesPresent).length, 1);
});

test('backups: list newest first, verify a good file, refuse path tricks, alert clears after a backup', async () => {
  const t = await login('owner');
  const b = await call('POST', '/api/admin/backup', {}, t); assert.equal(b.status, 200);
  const list = (await call('GET', '/api/admin/backups', undefined, t)).body.backups;
  assert.equal(list.length, 1); assert.equal(list[0].file, path.basename(b.body.file));
  const v = (await call('POST', '/api/admin/backups/verify', { file: list[0].file }, t)).body;
  assert.equal(v.integrity, 'ok'); assert.ok(v.records >= 0);
  assert.equal((await call('POST', '/api/admin/backups/verify', { file: '../../etc/passwd' }, t)).status, 400);
  assert.equal((await call('POST', '/api/admin/backups/verify', { file: 'edcl-nope.sqlite' }, t)).status, 404);
  const m = (await call('GET', '/api/admin/metrics', undefined, t)).body;
  assert.equal(m.backups.count, 1); assert.ok(!m.alerts.some(a => a.id === 'backup-none'));
  fs.writeFileSync(path.join(dir, 'bk', 'edcl-broken.sqlite'), 'not a database');
  const bad = (await call('POST', '/api/admin/backups/verify', { file: 'edcl-broken.sqlite' }, t)).body;
  assert.notEqual(bad.integrity, 'ok');
});

test('config: owner only, validated, applied live and persisted to the config file', async () => {
  const t = await login('owner'), fc = await login('fc');
  assert.equal((await call('GET', '/api/admin/config', undefined, fc)).status, 403);
  const c = (await call('GET', '/api/admin/config', undefined, t)).body;
  assert.equal(c.persisted, true); assert.equal(c.backupMinutes, 30);
  assert.equal((await call('POST', '/api/admin/config', { keepBackups: 0 }, t)).status, 400);
  assert.equal((await call('POST', '/api/admin/config', { serverName: 'x\ny' }, t)).status, 400);
  const r = await call('POST', '/api/admin/config', { backupMinutes: 15, keepBackups: 7, maxFileMB: 50, serverName: 'Lab Server' }, t);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.config.backupMinutes, 15);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).keepBackups, 7);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).dataDir, dir, 'other keys are preserved');
  assert.equal((await call('GET', '/api/info')).body.name, 'Lab Server', 'server name applied without restart');
  assert.equal((await call('GET', '/api/admin/metrics', undefined, t)).body.backups.intervalMinutes, 15);
  // a failing write must not change the running settings
  fs.chmodSync(cfgFile, 0o400); fs.unlinkSync(cfgFile); fs.mkdirSync(cfgFile);
  const bad = await call('POST', '/api/admin/config', { keepBackups: 9 }, t);
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/api/admin/config', undefined, t)).body.keepBackups, 7);
  fs.rmdirSync(cfgFile);
});

test('logs and restart: owner only, restart calls the hook after replying and is audited', async () => {
  const t = await login('owner'), fc = await login('fc');
  const lg = (await call('GET', '/api/admin/logs', undefined, t)).body;
  assert.ok(lg.lines.some(l => /server started|backup ok/.test(l.msg)));
  assert.equal((await call('GET', '/api/admin/logs', undefined, fc)).status, 403);
  assert.equal((await call('POST', '/api/admin/restart', {}, fc)).status, 403);
  assert.equal((await call('POST', '/api/admin/restart', {}, t)).status, 200);
  await new Promise(r => setTimeout(r, 700));
  assert.equal(restarted, 1);
  assert.ok((await call('GET', '/api/admin/audit', undefined, t)).body.rows.some(r => r.action === 'server-restart'));
});
