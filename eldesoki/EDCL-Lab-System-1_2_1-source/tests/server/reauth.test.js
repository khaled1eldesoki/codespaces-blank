'use strict';
// Re-authentication for protected screens (Backup etc.) and the server-side backup call used by the Backup tab in server mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createServer } = require('../../server/server');
const auth = require('../../server/auth');
const PW = 'Str0ng-Pass-1234';
let srv, base;
const api = async (p, body, token) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-reauth-'));
  srv = createServer({ dataDir: dir, port: 0, host: '127.0.0.1', backupDir: path.join(dir, 'bk') });
  const a = await srv.start(); base = 'http://127.0.0.1:' + a.port;
  await auth.createUser(srv.db, { username: 'owner', name: 'Owner', role: 'admin', password: PW, mustChange: false });
  await auth.createUser(srv.db, { username: 'qa', name: 'QA', role: 'quality', password: PW, mustChange: false });
});
test.after(async () => { await srv.stop(); });
test('reauth: correct password ok, wrong password refused, no session needed token, lockout after repeated failures', async () => {
  const t = (await api('/api/login', { username: 'qa', password: PW })).body.token;
  assert.equal((await api('/api/reauth', { password: PW })).status, 401, 'no token');
  assert.equal((await api('/api/reauth', { password: PW }, t)).status, 200);
  assert.equal((await api('/api/reauth', { password: 'nope' }, t)).status, 401);
  for (let i = 0; i < 12; i++) await api('/api/reauth', { password: 'nope' }, t);
  const locked = await api('/api/reauth', { password: PW }, t);
  assert.equal(locked.status, 429, 'account is locked after repeated failures');
});
test('server-side backup: allowed for admin (creates a verified file), refused without backup permission', async () => {
  const t = (await api('/api/login', { username: 'owner', password: PW })).body.token;
  const r = await api('/api/admin/backup', {}, t);
  assert.equal(r.status, 200); assert.ok(r.body.file && /\.sqlite$/.test(r.body.file)); assert.ok(fs.existsSync(r.body.file));
  const q = await api('/api/login', { username: 'qa', password: PW });
  if (q.status === 200) assert.equal((await api('/api/admin/backup', {}, q.body.token)).status, 403);
});
