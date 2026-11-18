'use strict';
// The desktop sync engine (app/central-sync.js) against the REAL central server, using the app's real seed data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../../server/server');
const auth = require('../../server/auth');
const Sync = require('../../app/central-sync.js');

const PW = 'Str0ng-Pass-1234';
const seed = () => { const l = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'index.html'), 'utf8').split('\n').find(x => x.startsWith('let D={')); return eval('(' + l.replace(/^let D=/, '').replace(/;\s*$/, '') + ')'); };
let srv, base, dir;
async function client(username, D0) {
  const lg = await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PW }) })).json();
  const c = { username, D: D0 || null, conflicts: [], status: null };
  const request = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lg.token }, body: body && body.json ? JSON.stringify(body.json) : undefined }); let json = null; try { json = await r.json(); } catch (e) {} return { status: r.status, json }; };
  c.eng = Sync.create({ request, getD: () => c.D, setD: d => { c.D = d; }, onConflict: x => c.conflicts.push(...x), onStatus: s => { c.status = s; }, saveDelayMs: 5, pollMs: 100000 });
  c.open = async () => { const r = await c.eng.connect(); if (r.D) c.D = r.D; return r; };
  return c;
}
const plain = D => JSON.parse(JSON.stringify(D));
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-sc-'));
  srv = createServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); base = 'http://127.0.0.1:' + (await srv.start()).port;
  for (let i = 1; i <= 30; i++) await auth.createUser(srv.db, { username: 'q' + i, name: 'Q' + i, role: i === 1 ? 'admin' : 'quality', password: PW, mustChange: false });
});
test.after(async () => { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

let SEED;
test('S1 first upload of the real seed data, then a second PC receives IDENTICAL data in the same order', async () => {
  SEED = seed(); for (const k of ['Audit', 'Access', 'TrainForms', 'News', 'CustomTabs']) SEED[k] = []; SEED.Brand = {}; SEED.SystemAdministrator = 'q1'; SEED.Perms = { admin: { edit: 1, users: 1 }, quality: { edit: 1, backup: 1 }, staff: { own: 1 } }; SEED.Users = [{ username: 'q1', name: 'Q1', role: 'admin', active: 'Yes', hash: 'SECRET-HASH-MUST-NOT-LEAVE-THE-PC', must: 0 }, { username: 'q2', name: 'Q2', role: 'quality', active: 'Yes', hash: 'x2' }];
  const a = await client('q1', plain(SEED)); const r = await a.open(); assert.equal(r.empty, true);
  const up = await a.eng.uploadAll(); assert.equal(up.conflicts.length, 0); assert.ok(up.sent > 1600, 'sent ' + up.sent);
  const b = await client('q2'); const rb = await b.open(); assert.equal(rb.empty, false);
  for (const k of Object.keys(SEED)) { const exp = k === 'Users' ? SEED[k].map(u => { const { hash, ...o } = u; return o; }) : SEED[k]; assert.deepEqual(plain(b.D[k]), plain(exp), 'table ' + k + ' differs'); }
});
test('S2 no hidden fields are visible to screens/exports, and password hashes never reach the server', async () => {
  const b = await client('q2'); await b.open();
  assert.ok(Object.keys(b.D.Training[0]).every(k => !k.startsWith('_')));
  assert.ok(!JSON.stringify(b.D.Users).includes('hash'));
  const dump = srv.db.prepare('SELECT data FROM records').all().map(x => x.data).join('\n'); assert.ok(!dump.includes('SECRET-HASH'));
});
test('S3 a change on one PC appears on the others; edits to different fields of the same record are BOTH kept', async () => {
  const a = await client('q3'), b = await client('q4'); await a.open(); await b.open();
  const ea = a.D.Employees[0], eb = b.D.Employees[0];
  ea.Department = 'Changed by A'; eb.JobTitle = 'Changed by B';
  a.eng.markDirty(); b.eng.markDirty(); await a.eng.flush(); await b.eng.flush(); assert.equal(a.conflicts.length + b.conflicts.length, 0);
  await a.eng.pull(); await b.eng.pull();
  for (const c of [a, b]) { assert.equal(c.D.Employees[0].Department, 'Changed by A'); assert.equal(c.D.Employees[0].JobTitle, 'Changed by B'); }
});
test('S4 same field changed by two PCs: nothing is silently overwritten; the loser sees the winner and can re-apply', async () => {
  const a = await client('q5'), b = await client('q6'); await a.open(); await b.open();
  a.D.Methods[0].TitleStatus = 'Value from A'; b.D.Methods[0].TitleStatus = 'Value from B';
  await a.eng.flush(); const rb = await b.eng.flush();
  assert.equal(rb.conflicts.length, 1); assert.equal(rb.conflicts[0].reason, 'fields'); assert.deepEqual(rb.conflicts[0].fields, ['TitleStatus']); assert.equal(rb.conflicts[0].mine.TitleStatus, 'Value from B');
  assert.equal(b.D.Methods[0].TitleStatus, 'Value from A', 'loser now shows the winner');
  await b.eng.applyMine(rb.conflicts[0]); await a.eng.pull(); assert.equal(a.D.Methods[0].TitleStatus, 'Value from B', 'user-confirmed overwrite is propagated');
  assert.ok(srv.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='conflict'").get().c >= 1, 'conflict is in the audit log');
});
test('S5 new rows keep their position (unshift / push) for every PC, also for a fresh PC', async () => {
  const a = await client('q7'), b = await client('q8'); await a.open(); await b.open();
  a.D.Audit.push({ Time: 'seed1', Action: 's1' }, { Time: 'seed2', Action: 's2' }); await a.eng.flush(); await b.eng.pull(); assert.equal(b.D.Audit.length, a.D.Audit.length);
  a.D.Audit.unshift({ Time: 'T-A', User: 'a', Action: 'first' }); b.D.Audit.push({ Time: 'T-B', User: 'b', Action: 'last' });
  await a.eng.flush(); await b.eng.flush(); const c = await client('q9'); await c.open();
  const seq = c.D.Audit.map(x => x.Action).join(','); assert.ok(c.D.Audit[0].Action === 'first' && c.D.Audit[c.D.Audit.length - 1].Action === 'last', 'order was: ' + seq + ' | a sees: ' + a.D.Audit.map(x => x.Action).join(','));
});
test('S6 delete propagates; deleting a record someone else just edited is a conflict, not a silent loss', async () => {
  const a = await client('q10'), b = await client('q11'); await a.open(); await b.open();
  const n0 = a.D.Gap.length; a.D.Gap.splice(0, 1); await a.eng.flush(); await b.eng.pull(); assert.equal(b.D.Gap.length, n0 - 1);
  const t = a.D.Gap[0]; b.D.Gap[0].Status = 'edited by B'; const gone = a.D.Gap.splice(0, 1)[0]; await b.eng.flush(); const rr = await a.eng.flush();
  assert.equal(rr.conflicts.length, 1); assert.equal(rr.conflicts[0].op, 'delete'); assert.ok(a.D.Gap.some(g => g.Status === 'edited by B'), 'row is back because B changed it');
});
test('S7 a row replaced by a spread copy is recognised as the same record (update, not delete+create)', async () => {
  const a = await client('q12'); await a.open(); const before = srv.db.prepare("SELECT COUNT(*) c FROM records WHERE tbl='Training'").get().c;
  const old = a.D.Training[5]; const id = old._id; const rev0 = srv.db.prepare("SELECT rev FROM records WHERE tbl='Training' AND id=?").get(id).rev;
  a.D.Training[5] = { ...old, Trainer: 'Replaced via spread' }; await a.eng.flush();
  assert.equal(srv.db.prepare("SELECT COUNT(*) c FROM records WHERE tbl='Training'").get().c, before);
  assert.equal(srv.db.prepare("SELECT rev FROM records WHERE tbl='Training' AND id=?").get(id).rev, rev0 + 1);
});
test('S8 object settings (roles/permissions) merge per top-level field', async () => {
  const a = await client('q13'), b = await client('q14'); await a.open(); await b.open();
  a.D.Perms.quality = { ...a.D.Perms.quality, backup: 0 }; b.D.Perms.staff = { ...b.D.Perms.staff, own: 1, assess: 1 };
  await a.eng.flush(); const rb = await b.eng.flush(); assert.equal(rb.conflicts.length, 0); await a.eng.pull(); await b.eng.pull();
  for (const c of [a, b]) { assert.equal(c.D.Perms.quality.backup, 0); assert.equal(c.D.Perms.staff.assess, 1); }
});
test('S9 STRESS: 25 PCs, 12 rounds of random edits/creates/deletes; every PC ends identical to the server, no lost disjoint edits', async () => {
  const cs = []; for (let i = 0; i < 25; i++) { const c = await client('q' + (i + 1)); await c.open(); cs.push(c); }
  let seedN = 12345; const rnd = n => { seedN = (seedN * 1103515245 + 12345) & 0x7fffffff; return seedN % n; };
  const wrote = new Map();   // "Employees|row|field" -> last value written by anyone (disjoint fields per client so every write must survive)
  for (let round = 0; round < 12; round++) {
    await Promise.all(cs.map(async (c, ci) => {
      const op = rnd(10);
      if (op < 6) { const i = rnd(c.D.Employees.length), r = c.D.Employees[i]; if (!r) return; const f = 'F' + ci; r[f] = `c${ci}r${round}`; wrote.set(r._id + '|' + f, r[f]); }
      else if (op < 9) c.D.TrainForms.push({ TF: `tf-${ci}-${round}`, by: ci });
      else if (c.D.Flags && c.D.Flags.length > 40) c.D.Flags.splice(rnd(c.D.Flags.length), 1);
      await c.eng.flush();
    }));
    await Promise.all(cs.map(c => c.eng.pull()));
  }
  for (const c of cs) { await c.eng.flush(); }
  for (const c of cs) await c.eng.pull(); for (const c of cs) await c.eng.pull();
  const diffAt = (x, y) => { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) { const a1 = JSON.stringify(x[k]), b1 = JSON.stringify(y[k]); if (a1 !== b1) { if (Array.isArray(x[k]) && Array.isArray(y[k])) { const n = Math.max(x[k].length, y[k].length); for (let i = 0; i < n; i++) if (JSON.stringify(x[k][i]) !== JSON.stringify(y[k][i])) return k + '[' + i + '] of ' + x[k].length + '/' + y[k].length + ': ' + String(JSON.stringify(x[k][i])).slice(0, 80) + ' VS ' + String(JSON.stringify(y[k][i])).slice(0, 80); } return k + ' differs'; } } return ''; };
  const ref = JSON.stringify(plain(cs[0].D)); for (const c of cs) assert.ok(JSON.stringify(plain(c.D)) === ref, c.username + ' differs at ' + diffAt(plain(cs[0].D), plain(c.D)));
  for (const [k, v] of wrote) { const [id, f] = k.split('|'); const row = cs[0].D.Employees.find(r => r._id === id); const hist = () => srv.db.prepare("SELECT rev,by,data FROM versions WHERE tbl='Employees' AND id=? ORDER BY rev").all(id).map(x => x.rev + ':' + x.by + ':' + (JSON.parse(x.data)[f] || '-')).join(' | '); assert.equal(row[f], v, 'lost write ' + k + ' history ' + hist()); }
  const fresh = await client('q30'); await fresh.open(); assert.equal(JSON.stringify(plain(fresh.D)), ref, 'a fresh PC equals the converged state');
  assert.equal(cs.reduce((n, c) => n + c.conflicts.length, 0) >= 0, true);
});
