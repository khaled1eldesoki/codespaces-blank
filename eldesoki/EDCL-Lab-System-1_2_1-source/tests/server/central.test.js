'use strict';
// Central-server tests: 120 simulated users, individual accounts, no lost updates, permissions, SSE, backup, restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../../server/server');
const auth = require('../../server/auth');
const { importD, importUsers } = require('../../server/import-backup');

const N = 120, PW = 'Str0ng-Pass-1234';
let srv, base, dir;
const api = async (p, o = {}, token) => {
  const r = await fetch(base + p, { method: o.body ? 'POST' : (o.method || 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, body: await r.json() };
};
const signIn = async (username, password = PW) => { const r = await api('/api/login', { body: { username, password } }); assert.equal(r.status, 200, username + ' ' + JSON.stringify(r.body)); return r.body.token; };
const push = (token, ops) => api('/api/push', { body: { ops } }, token);
const sync = (token, since = 0) => api('/api/sync?since=' + since + '&limit=5000', {}, token);

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-central-'));
  srv = createServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const a = await srv.start(); base = `http://127.0.0.1:${a.port}`;
  const db = srv.db;
  await auth.createUser(db, { username: 'owner', name: 'Owner', role: 'admin', password: PW, mustChange: false });
  await auth.createUser(db, { username: 'manager', name: 'Manager', role: 'lab_manager', password: PW, mustChange: false });
  await auth.createUser(db, { username: 'qa', name: 'QA', role: 'quality', password: PW, mustChange: false });
  await Promise.all(Array.from({ length: N }, (_, i) => auth.createUser(db, { username: 'emp' + String(i + 1).padStart(3, '0'), name: 'Employee ' + (i + 1), staffId: 'EMP' + String(i + 1).padStart(3, '0'), role: i < 100 ? 'lab_manager' : 'staff', password: PW, mustChange: false })));
});
test.after(async () => { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('authentication: no token, bad password, lockout, forced password change, no hashes exposed', async () => {
  assert.equal((await api('/api/sync')).status, 401);
  assert.equal((await api('/api/login', { body: { username: 'owner', password: 'wrong' } })).status, 401);
  await auth.createUser(srv.db, { username: 'newbie', name: 'New', role: 'staff', password: 'Temp-Pass-0001' });   // must_change = 1
  const t = await signIn('newbie', 'Temp-Pass-0001');
  const blocked = await api('/api/sync', {}, t); assert.equal(blocked.status, 403); assert.equal(blocked.body.mustChange, true);
  assert.equal((await api('/api/password', { body: { oldPassword: 'Temp-Pass-0001', newPassword: 'short' } }, t)).status, 400);
  assert.equal((await api('/api/password', { body: { oldPassword: 'Temp-Pass-0001', newPassword: 'A-Better-Pass-77' } }, t)).status, 200);
  assert.equal((await sync(t)).status, 200);
  await auth.createUser(srv.db, { username: 'victim', name: 'V', role: 'staff', password: PW, mustChange: false });
  for (let i = 0; i < 5; i++) await api('/api/login', { body: { username: 'victim', password: 'nope' } });
  assert.equal((await api('/api/login', { body: { username: 'victim', password: PW } })).status, 429, 'locked after 5 failures');
  const ot = await signIn('owner'); const users = await api('/api/admin/users', {}, ot);
  assert.ok(!JSON.stringify(users.body).includes('scrypt'), 'no password hash in admin listing');
});

test('legacy SHA-256 account from the desktop app is upgraded to scrypt on first sign-in', async () => {
  await auth.createUser(srv.db, { username: 'olduser', name: 'Old', role: 'staff', legacy: auth.legacyHash('olduser', 'Edcl@2026'), mustChange: false });
  assert.equal((await api('/api/login', { body: { username: 'olduser', password: 'bad' } })).status, 401);
  assert.equal((await api('/api/login', { body: { username: 'olduser', password: 'Edcl@2026' } })).status, 200);
  const row = srv.db.prepare('SELECT hash, legacy_hash FROM users WHERE username=?').get('olduser');
  assert.ok(row.hash.startsWith('scrypt$') && row.legacy_hash === null);
});

test('blind overwrites are refused; create/duplicate/delete conflicts are reported, never silently resolved', async () => {
  const t = await signIn('manager');
  assert.match((await push(t, [{ tbl: 'Methods', id: 'X1', op: 'put', data: { a: 1 } }])).body.results[0].error, /baseRev/);
  assert.equal((await push(t, [{ tbl: 'Methods', id: 'X1', op: 'put', baseRev: 0, data: { a: 1 } }])).body.results[0].rev, 1);
  assert.equal((await push(t, [{ tbl: 'Methods', id: 'X1', op: 'put', baseRev: 0, data: { a: 2 } }])).body.results[0].reason, 'exists');
  assert.equal((await push(t, [{ tbl: 'Methods', id: 'X1', op: 'put', baseRev: 1, data: { a: 5 } }])).body.results[0].rev, 2);
  const stale = (await push(t, [{ tbl: 'Methods', id: 'X1', op: 'delete', baseRev: 1 }])).body.results[0];
  assert.equal(stale.reason, 'changed'); assert.equal(stale.server.data.a, 5);               // cannot delete someone else's newer edit
  assert.equal((await push(t, [{ tbl: 'Methods', id: 'X1', op: 'delete', baseRev: 2 }])).body.results[0].ok, true);
  assert.equal((await push(t, [{ tbl: 'Methods', id: 'X1', op: 'put', baseRev: 3, data: { a: 9 } }])).body.results[0].ok, true);   // explicit restore of the deleted revision (rev 3)
  assert.equal((await push(t, [{ tbl: 'Methods', id: 'X1', op: 'put', baseRev: 1, data: { a: 7 } }])).body.results[0].conflict, true);
});

test(`100 concurrent users edit DIFFERENT fields of one record from stale copies: all changes are merged, none lost`, async () => {
  const owner = await signIn('owner');
  assert.equal((await push(owner, [{ tbl: 'Employees', id: 'SHARED1', op: 'put', baseRev: 0, data: { StaffID: 'SHARED1', title: 'start' } }])).body.results[0].rev, 1);
  const tokens = await Promise.all(Array.from({ length: 100 }, (_, i) => signIn('emp' + String(i + 1).padStart(3, '0'))));
  const rs = await Promise.all(tokens.map((t, i) => push(t, [{ tbl: 'Employees', id: 'SHARED1', op: 'put', baseRev: 1, data: { StaffID: 'SHARED1', title: 'start', ['f' + i]: 'v' + i } }])));
  assert.ok(rs.every(r => r.body.results[0].ok), 'every edit accepted');
  const rec = (await sync(owner)).body.changes.find(c => c.tbl === 'Employees' && c.id === 'SHARED1');
  for (let i = 0; i < 100; i++) assert.equal(rec.data['f' + i], 'v' + i, 'field f' + i + ' survived');
  assert.equal(rec.rev, 101);
});

test(`100 concurrent users edit the SAME field concurrently: exactly one wins per revision, the rest get a conflict and retry without losing anything`, async () => {
  const owner = await signIn('owner');
  await push(owner, [{ tbl: 'Gap', id: 'G1', op: 'put', baseRev: 0, data: { Description: 'log', entries: [] } }]);
  const tokens = await Promise.all(Array.from({ length: 100 }, (_, i) => signIn('emp' + String(i + 1).padStart(3, '0'))));
  let conflicts = 0, attempts = 0;
  const work = async (t, i) => {
    let base = { rev: 1, data: { Description: 'log', entries: [] } };
    for (;;) {
      attempts++;
      const r = (await push(t, [{ tbl: 'Gap', id: 'G1', op: 'put', baseRev: base.rev, data: { ...base.data, entries: [...base.data.entries, 'u' + i] } }])).body.results[0];
      if (r.ok) return;
      assert.equal(r.conflict, true); conflicts++;
      base = { rev: r.server.rev, data: r.server.data };            // client re-reads the server copy, re-applies its own change
    }
  };
  await Promise.all(tokens.map(work));
  const rec = (await sync(owner)).body.changes.find(c => c.tbl === 'Gap' && c.id === 'G1');
  assert.equal(rec.data.entries.length, 100); assert.equal(new Set(rec.data.entries).size, 100, 'no entry lost, none duplicated');
  assert.equal(rec.rev, 101); assert.ok(conflicts > 0, 'real contention happened (' + conflicts + ' conflicts, ' + attempts + ' attempts)');
});

test('mixed workload: 120 accounts (100 editors + 20 read-only) x 5 rounds over 30 shared records; every client\'s last write to its own field is present', async () => {
  const owner = await signIn('owner');
  await push(owner, Array.from({ length: 30 }, (_, k) => ({ tbl: 'Training', id: 'R' + k, op: 'put', baseRev: 0, data: { TrainingID: 'R' + k } })));
  const tokens = await Promise.all(Array.from({ length: N }, (_, i) => signIn('emp' + String(i + 1).padStart(3, '0'))));
  const expected = new Map(), local = new Map();
  await Promise.all(tokens.map(async (t, i) => {
    if (i >= 100) return;                                     // 100 editors (role lab_manager); 20 staff only read
    for (let round = 0; round < 5; round++) {
      const id = 'R' + ((i * 7 + round * 11) % 30);
      for (;;) {
        const l = local.get(id) || { rev: 1, data: { TrainingID: id } };
        const val = `c${i}-r${round}`;
        const r = (await push(t, [{ tbl: 'Training', id, op: 'put', baseRev: l.rev, data: { ...l.data, ['u' + i]: val } }])).body.results[0];
        if (r.ok) { expected.set(id + '/u' + i, val); local.set(id, { rev: r.rev, data: r.data || { ...l.data, ['u' + i]: val } }); break; }
        local.set(id, { rev: r.server.rev, data: r.server.data });
      }
    }
  }));
  const all = (await sync(owner)).body.changes.filter(c => c.tbl === 'Training');
  const byId = new Map(all.map(c => [c.id, c.data]));
  for (const [k, v] of expected) { const [id, f] = k.split('/'); assert.equal(byId.get(id)[f], v, 'lost update at ' + k); }
  assert.ok(expected.size >= 100);
});

test('permissions: staff cannot write; staff only read their own StaffID rows; Settings needs the users permission; admin endpoints guarded', async () => {
  const staff = await signIn('emp110'), mgr = await signIn('manager'), owner = await signIn('owner');
  assert.equal((await push(staff, [{ tbl: 'Training', id: 'Z', op: 'put', baseRev: 0, data: { StaffID: 'EMP110' } }])).body.results[0].denied, true);
  await push(mgr, [{ tbl: 'Training', id: 'T-own', op: 'put', baseRev: 0, data: { StaffID: 'EMP110', x: 1 } }, { tbl: 'Training', id: 'T-other', op: 'put', baseRev: 0, data: { StaffID: 'EMP111', x: 2 } }, { tbl: 'Methods', id: 'M-ref', op: 'put', baseRev: 0, data: { MethodID: 'M-ref' } }]);
  const seen = (await sync(staff)).body.changes;
  assert.ok(seen.some(c => c.id === 'T-own')); assert.ok(!seen.some(c => c.id === 'T-other'), 'other staff data hidden'); assert.ok(seen.some(c => c.id === 'M-ref'), 'reference data visible');
  assert.equal((await push(mgr, [{ tbl: 'Settings', id: 's', op: 'put', baseRev: 0, data: { SettingName: 's' } }])).body.results[0].denied, true);
  assert.equal((await push(owner, [{ tbl: 'Settings', id: 's', op: 'put', baseRev: 0, data: { SettingName: 's' } }])).body.results[0].ok, true);
  assert.equal((await api('/api/admin/users', {}, mgr)).status, 403);
  assert.equal((await api('/api/admin/roles', {}, mgr)).status, 403);
  const roles = await api('/api/admin/roles', {}, owner);
  assert.equal(roles.status, 200);
  assert.ok(roles.body.roles.some(r => r.role === 'admin'));
  assert.equal((await api('/api/admin/users', { body: { username: 'x1', role: 'admin', password: PW } }, await signIn('qa'))).status, 403);
});

test('admin: create user, role change, disable kills sessions, last administrator is protected', async () => {
  const owner = await signIn('owner');
  assert.equal((await api('/api/admin/users', { body: { username: 'temp1', name: 'T', role: 'staff', password: 'Temp-Pass-1234' } }, owner)).status, 200);
  const t = await signIn('temp1', 'Temp-Pass-1234');
  assert.equal((await api('/api/admin/users/temp1/active', { body: { active: false } }, owner)).status, 200);
  assert.equal((await api('/api/me', {}, t)).status, 401, 'disabled user is signed out immediately');
  assert.equal((await api('/api/admin/users/owner/role', { body: { role: 'staff' } }, owner)).status, 400, 'last administrator protected');
});

test('two clients that sync independently converge to identical state (paged sync cursor)', async () => {
  const a = await signIn('owner'), b = await signIn('qa');
  const pull = async t => { let since = 0, rows = new Map(); for (;;) { const r = (await api('/api/sync?since=' + since + '&limit=10', {}, t)).body; r.changes.forEach(c => rows.set(c.tbl + '/' + c.id, c.rev)); if (!r.more) break; since = r.lastSeq; } return rows; };
  const [ra, rb] = [await pull(a), await pull(b)];
  assert.ok(ra.size > 30); assert.deepEqual([...ra].sort(), [...rb].sort());
});

test('live change events reach other sessions', async () => {
  const owner = await signIn('owner'), ctl = new AbortController();
  const r = await fetch(base + '/api/events', { headers: { Authorization: 'Bearer ' + owner }, signal: ctl.signal });
  const rd = r.body.getReader(); let text = ''; const read = async () => { const { value } = await rd.read(); text += Buffer.from(value).toString(); };
  await read();                                                  // initial hello
  await push(await signIn('manager'), [{ tbl: 'Gap', id: 'EVT', op: 'put', baseRev: 0, data: { v: 1 } }]);
  await Promise.race([read(), new Promise((_, no) => setTimeout(() => no(new Error('no event')), 3000))]);
  assert.match(text, /"seq":\d+[\s\S]*"seq":\d+/); ctl.abort();
});

test('verified backup, then restart keeps every record and revision; version history retained for audit/rollback', async () => {
  const owner = await signIn('owner');
  const b = await api('/api/admin/backup', { body: {} }, owner); assert.equal(b.status, 200); assert.ok(b.body.records > 30);
  const before = (await sync(owner)).body.changes.length;
  await srv.stop();
  srv = createServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); const a = await srv.start(); base = `http://127.0.0.1:${a.port}`;
  const o2 = await signIn('owner'); assert.equal((await sync(o2)).body.changes.length, before);
  assert.ok(srv.db.prepare('SELECT COUNT(*) c FROM versions').get().c > before, 'every revision kept');
  const Drv = srv.db.constructor, bk = new Drv(b.body.file); assert.equal(bk.prepare('SELECT COUNT(*) c FROM records').get().c, b.body.records); bk.close();
});

test('migration import: desktop data loads once, composite keys preserved, accounts keep legacy hashes, refuses to overwrite', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-imp-')), db = require('../../server/db').open(path.join(d2, 'c.sqlite')); auth.seedRoles(db);
  const D = { Employees: [{ StaffID: 'E1', FullName: 'A' }], MethodCertifiedScientists: [{ MethodID: 'M1', StaffID: 'E1' }, { MethodID: 'M1', StaffID: 'E2' }], Gap: [{ x: 1 }, { x: 2 }], Users: [{ username: 'Admin', name: 'Admin', role: 'admin', StaffID: '', active: 'Yes', hash: auth.legacyHash('admin', 'pw') }], Perms: {} };
  const r = importD(db, D); assert.equal(r.records, 5); assert.equal(await importUsers(db, D), 1);
  assert.ok(db.prepare("SELECT 1 FROM records WHERE tbl='MethodCertifiedScientists' AND id='M1|E2'").get());
  assert.throws(() => importD(db, D), /not empty/);
  assert.equal((await auth.login(db, 'admin', 'pw', 't')).ok, true);
  db.close(); fs.rmSync(d2, { recursive: true, force: true });
});

test('HTTPS: server runs with a TLS certificate and serves the same API', async () => {
  const { execSync } = require('child_process'), d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-tls-'));
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${d3}/k.pem -out ${d3}/c.pem -days 2 -subj /CN=localhost 2>/dev/null`);
  const s2 = createServer({ dataDir: path.join(d3, 'data'), port: 0, host: '127.0.0.1', tls: { key: d3 + '/k.pem', cert: d3 + '/c.pem' } });
  const a = await s2.start(); process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const r = await fetch(`https://127.0.0.1:${a.port}/api/health`); delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  assert.equal((await r.json()).ok, true); await s2.stop(); fs.rmSync(d3, { recursive: true, force: true });
});
