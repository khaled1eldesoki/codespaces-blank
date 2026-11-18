'use strict';
// Central file store, private-CA HTTPS, phone viewer route, verified backup with file mirror, offline restore.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { createServer } = require('../../server/server');
const auth = require('../../server/auth');
const certs = require('../../server/certs');

const PW = 'Str0ng-Pass-1234', sha = b => crypto.createHash('sha256').update(b).digest('hex');
let dir, srv, port, ca, otherCa;
const req = (method, p, { body, raw, token, cacert } = {}) => new Promise((ok, no) => {
  const data = raw || (body ? Buffer.from(JSON.stringify(body)) : null);
  const r = https.request({ host: 'localhost', port, path: p, method, ca: cacert || ca, headers: { ...(data ? { 'Content-Length': data.length, 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, res => {
    const c = []; res.on('data', d => c.push(d)); res.on('end', () => { const b = Buffer.concat(c); let j = null; try { j = JSON.parse(b.toString()); } catch (e) {} ok({ status: res.statusCode, json: j, buf: b, headers: res.headers }); });
  });
  r.on('error', no); if (data) r.write(data); r.end();
});
const login = async u => (await req('POST', '/api/login', { body: { username: u, password: PW } })).json.token;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-fb-'));
  certs.make({ outDir: path.join(dir, 'certs'), names: ['localhost'], ips: ['127.0.0.1'] });
  ca = fs.readFileSync(path.join(dir, 'certs', 'ca.crt'));
  otherCa = certs.makeCA('Some other CA').cert;
  srv = createServer({ dataDir: path.join(dir, 'data'), port: 0, host: '127.0.0.1', tls: { key: path.join(dir, 'certs', 'server.key'), cert: path.join(dir, 'certs', 'server.crt') }, backupDir: path.join(dir, 'bk') });
  port = (await srv.start()).port;
  for (const [u, role, staff] of [['owner', 'admin', ''], ['editor', 'quality', ''], ['emp001', 'staff', 'EMP001'], ['emp002', 'staff', 'EMP002']])
    await auth.createUser(srv.db, { username: u, name: u, staffId: staff, role, password: PW, mustChange: false });
});
test.after(async () => { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('F1 HTTPS works for a client that trusts the lab CA and is REFUSED for any other CA', async () => {
  const ok = await req('GET', '/api/info'); assert.equal(ok.status, 200); assert.equal(ok.json.tls, true);
  await assert.rejects(req('GET', '/api/info', { cacert: Buffer.from(otherCa) }), /self-signed|unable to verify|certificate/i);
  await assert.rejects(req('GET', '/api/info', { cacert: undefined, body: undefined }).then(() => new Promise((_, no) => https.get({ host: 'localhost', port, path: '/api/info' }, () => {}).on('error', no))), /self-signed|unable to verify|certificate/i);
});
test('F2 server certificate chain verifies against the CA (names and IP)', () => {
  const leaf = fs.readFileSync(path.join(dir, 'certs', 'server.crt'), 'utf8');
  assert.equal(certs.verifyChain(leaf, ca.toString()), true);
  assert.equal(certs.verifyChain(leaf, otherCa), false);
  const x = new crypto.X509Certificate(leaf); assert.ok(x.checkHost('localhost')); assert.ok(x.checkIP('127.0.0.1'));
});
test('F3 file upload: bytes verified by hash, metadata saved, download identical, corrupt upload refused', async () => {
  const t = await login('editor'), bytes = crypto.randomBytes(300000), h = sha(bytes);
  const bad = await req('PUT', '/api/blobs/' + sha(Buffer.from('other')), { raw: bytes, token: t }); assert.equal(bad.status, 400);
  const up = await req('PUT', '/api/blobs/' + h, { raw: bytes, token: t }); assert.equal(up.status, 200);
  const meta = await req('POST', '/api/files', { token: t, body: { cat: 'sop', name: 'SOP012.pdf', code: 'SOP012 v03', type: 'application/pdf', sha256: h } }); assert.equal(meta.status, 200);
  const dl = await req('GET', '/api/blobs/' + h, { token: t }); assert.equal(dl.status, 200); assert.ok(dl.buf.equals(bytes));
  const list = await req('GET', '/api/files?cat=sop', { token: t }); assert.equal(list.json.files.length, 1); assert.equal(list.json.files[0].size, 300000);
  const noBytes = await req('POST', '/api/files', { token: t, body: { cat: 'sop', name: 'x', sha256: sha(Buffer.from('never uploaded')) } }); assert.equal(noBytes.status, 400);
});
test('F4 permissions: staff cannot upload general documents, can read them, cannot read another person\'s evidence', async () => {
  const ed = await login('editor'), e1 = await login('emp001'), e2 = await login('emp002');
  const b = Buffer.from('evidence-for-emp001'), h = sha(b);
  assert.equal((await req('PUT', '/api/blobs/' + h, { raw: b, token: ed })).status, 200);
  assert.equal((await req('POST', '/api/files', { token: ed, body: { cat: 'ev:EMP001', name: 'cert.pdf', sha256: h } })).status, 200);
  assert.equal((await req('POST', '/api/files', { token: e1, body: { cat: 'sop', name: 'nope.pdf', sha256: h } })).status, 403);
  assert.equal((await req('GET', '/api/files?cat=ev:EMP001', { token: e1 })).json.files.length, 1);
  assert.equal((await req('GET', '/api/files?cat=ev:EMP001', { token: e2 })).json.files.length, 0);
  assert.equal((await req('GET', '/api/blobs/' + h, { token: e2 })).status, 404);
  assert.equal((await req('GET', '/api/blobs/' + h, { token: e1 })).status, 200);
  assert.equal((await req('GET', '/api/files')).status, 401);
});
test('F5 replace keeps the id and the old bytes; delete is soft and audited', async () => {
  const t = await login('editor'); const v1 = Buffer.from('v1 content'), v2 = Buffer.from('v2 content');
  await req('PUT', '/api/blobs/' + sha(v1), { raw: v1, token: t });
  const id = (await req('POST', '/api/files', { token: t, body: { cat: 'method', name: 'MS042.pdf', sha256: sha(v1) } })).json.file.id;
  await req('PUT', '/api/blobs/' + sha(v2), { raw: v2, token: t });
  const r = await req('PUT', '/api/files/' + id, { token: t, body: { sha256: sha(v2), name: 'MS042_v2.pdf' } }); assert.equal(r.json.file.id, id); assert.equal(r.json.file.name, 'MS042_v2.pdf');
  assert.ok(fs.existsSync(path.join(dir, 'data', 'files', sha(v1).slice(0, 2), sha(v1))), 'old bytes kept');
  assert.equal((await req('DELETE', '/api/files/' + id, { token: t })).status, 200);
  assert.equal((await req('GET', '/api/files?cat=method', { token: t })).json.files.length, 0);
  const a = srv.db.prepare("SELECT action FROM audit WHERE tbl='files' AND rid=? ORDER BY id").all(String(id)).map(x => x.action); assert.deepEqual(a, ['file-add', 'file-replace', 'file-delete']);
});
test('F6 phone viewer is served and has no write call', async () => {
  const r = await req('GET', '/m/'); assert.equal(r.status, 200); assert.match(r.buf.toString(), /html/i);
  const js = await req('GET', '/m/app.js'); assert.equal(js.status, 200); assert.ok(!/api\/push/.test(js.buf.toString().replace(/\/\/.*$/mg, '')));
  for (const bad of ['/m/..%2f..%2fpackage.json', '/m/%2e%2e/package.json', '/m/../package.json']) { const r2 = await req('GET', bad); assert.ok(r2.status !== 200, bad + ' must never be served (got ' + r2.status + ')'); }
});
test('F7 backup is verified, mirrors the uploaded files, and RESTORE brings back data AND file bytes', async () => {
  const t = await login('editor');
  await req('POST', '/api/push', { token: t, body: { ops: [{ tbl: 'Employees', id: 'EMP900', op: 'put', baseRev: 0, data: { StaffID: 'EMP900', FullName: 'Test Person' } }] } });
  const b = srv.backup('t1'); assert.ok(fs.existsSync(b.file)); assert.ok(b.files.total >= 3);
  assert.ok(fs.existsSync(path.join(dir, 'bk', 'files')), 'file mirror exists at the backup location');
  await req('POST', '/api/push', { token: t, body: { ops: [{ tbl: 'Employees', id: 'EMP901', op: 'put', baseRev: 0, data: { StaffID: 'EMP901', FullName: 'Added after backup' } }] } });
  await srv.stop();
  const cli = path.join(__dirname, '..', '..', 'server', 'cli.js');
  const bad = spawnSync(process.execPath, ['--no-warnings', cli, 'restore', b.file, '--data', path.join(dir, 'data'), '--backup-dir', path.join(dir, 'bk')], { encoding: 'utf8' });
  assert.equal(bad.status, 0, bad.stdout + bad.stderr);
  const out = JSON.parse(bad.stdout); assert.equal(out.fileBytesMissing, 0); assert.ok(fs.existsSync(out.previousDatabaseKeptIn));
  // lose the file bytes, restore again: they must come back from the mirror
  fs.rmSync(path.join(dir, 'data', 'files'), { recursive: true });
  const again = spawnSync(process.execPath, ['--no-warnings', cli, 'restore', b.file, '--data', path.join(dir, 'data'), '--backup-dir', path.join(dir, 'bk')], { encoding: 'utf8' });
  assert.equal(again.status, 0, again.stdout + again.stderr); assert.ok(JSON.parse(again.stdout).fileBytesRestoredFromMirror >= 2);
  srv = createServer({ dataDir: path.join(dir, 'data'), port: 0, host: '127.0.0.1', tls: { key: path.join(dir, 'certs', 'server.key'), cert: path.join(dir, 'certs', 'server.crt') }, backupDir: path.join(dir, 'bk') }); port = (await srv.start()).port;
  const t2 = await login('editor'), s = await req('GET', '/api/sync?since=0&limit=5000', { token: t2 });
  const ids = s.json.changes.map(c => c.id); assert.ok(ids.includes('EMP900')); assert.ok(!ids.includes('EMP901'), 'data written after the backup is gone, as expected');
  const l = await req('GET', '/api/files?cat=sop', { token: t2 }); const dl = await req('GET', '/api/blobs/' + l.json.files[0].sha256, { token: t2 }); assert.equal(sha(dl.buf), l.json.files[0].sha256);
});
test('F8 restore refuses a damaged backup and leaves the current database untouched', async () => {
  const cli = path.join(__dirname, '..', '..', 'server', 'cli.js'), bad = path.join(dir, 'broken.sqlite'); fs.writeFileSync(bad, 'this is not a database');
  const r = spawnSync(process.execPath, ['--no-warnings', cli, 'restore', bad, '--data', path.join(dir, 'data')], { encoding: 'utf8' }); assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(dir, 'data', 'edcl-central.sqlite')), 'current database untouched');
});
