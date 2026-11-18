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
const VERSION = require('../package.json').version;

const TABLE_WRITE = { Settings: ['users'], Evaluation: ['edit', 'assess'], default: ['edit'] };
const FULL_READ = ['edit', 'audit', 'assess', 'users'];
const MAX_BODY = 8 * 1024 * 1024, MAX_OPS = 200;

function createServer({ dataDir, port = 8443, host = '0.0.0.0', tls = null, backupEveryMs = 0, keepBackups = 30, backupDir = '', maxFileBytes = 300 * 1024 * 1024, wadaHours = 0, wadaFetch = null, serverName = 'EDCL Server', log = () => {} }) {
  const db = db_.open(path.join(dataDir, 'edcl-central.sqlite'));
  auth.seedRoles(db); files.init(db);
  const bkRoot = backupDir || path.join(dataDir, 'backups');
  const sse = new Set();
  const broadcast = () => { const m = `data: {"seq":${db_.curSeq(db)}}\n\n`; for (const r of sse) { try { r.write(m); } catch (e) { sse.delete(r); } } };
  const broadcastFiles = () => { const m = `event: files\ndata: {"seq":${db_.curSeq(db)}}\n\n`; for (const r of sse) { try { r.write(m); } catch (e) { sse.delete(r); } } };
  const canWrite = (u, tbl) => (TABLE_WRITE[tbl] || TABLE_WRITE.default).some(p => u.perms[p]);
  const fullRead = u => FULL_READ.some(p => u.perms[p]);
  const canRead = (u, rec) => fullRead(u) || !rec.data || rec.data.StaffID === undefined || String(rec.data.StaffID).toLowerCase() === String(u.staffId || u.username).toLowerCase();

  function backup(label) {
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
  const FILE_WRITE = ['edit', 'assess', 'own'];
  const ownCat = (u, cat) => { const m2 = /^(?:ev|fdone|own):(.+)$/.exec(cat || ''); return m2 ? m2[1].toLowerCase() : null; };
  const fileReadable = (u, f) => { const o = ownCat(u, f.cat); return fullRead(u) || !/^ev:/.test(f.cat || '') || o === String(u.staffId || u.username).toLowerCase(); };
  const fileWritable = (u, cat) => u.perms.edit || ((u.perms.assess || u.perms.own) && /^(ev|fdone):/.test(cat || ''));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;

    if (p === '/api/health') return send(res, 200, { ok: true, seq: db_.curSeq(db), driver: db.kind, version: VERSION });
    if (p === '/api/info') return send(res, 200, { ok: true, product: 'EDCL central server', name: serverName, version: VERSION, tls: !!tls, seq: db_.curSeq(db), time: new Date().toISOString() });
    if ((p === '/m' || p.startsWith('/m/')) && m === 'GET') return serveMobile(p, res);
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
      if (p === '/api/admin/backup' && m === 'POST') {
        if (!u.perms.backup) return send(res, 403, { error: 'Permission denied' });
        try { return send(res, 200, backup('manual')); } catch (e) { return send(res, 500, { error: e.message }); }
      }
      if (p === '/api/admin/status' && m === 'GET') {
        if (!u.perms.backup && !u.perms.users) return send(res, 403, { error: 'Permission denied' });
        const bl = fs.existsSync(bkRoot) ? fs.readdirSync(bkRoot).filter(f => /^edcl-.*\.sqlite$/.test(f)).sort().slice(-10).map(f => ({ file: f, size: fs.statSync(path.join(bkRoot, f)).size })) : [];
        return send(res, 200, { version: VERSION, driver: db.kind, seq: db_.curSeq(db), records: db.prepare('SELECT COUNT(*) c FROM records WHERE deleted=0').get().c, files: db.prepare('SELECT COUNT(*) c FROM files WHERE deleted=0').get().c, users: db.prepare('SELECT COUNT(*) c FROM users WHERE active=1').get().c, sessions: db.prepare('SELECT COUNT(*) c FROM sessions WHERE expires>?').get(Date.now()).c, backups: bl, wada: (store.getRecord(db, 'WadaStatus', 'main') || {}).data || null });
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
      const mm = p.match(/^\/api\/admin\/users\/([a-z0-9._-]+)\/(reset|role|active)$/);
      if (mm && m === 'POST') {
        const b = await body(req), target = db.prepare('SELECT * FROM users WHERE username=?').get(mm[1]);
        if (!target) return send(res, 404, { error: 'No such user' });
        if ((target.role === 'admin' || b.role === 'admin') && u.role !== 'admin') return send(res, 403, { error: 'Only an administrator can change administrators' });
        const a = db.prepare('INSERT INTO audit(at,user,action,rid,detail) VALUES(?,?,?,?,?)');
        try {
          if (mm[2] === 'reset') { await auth.resetPassword(db, target.username, b.password); a.run(new Date().toISOString(), u.username, 'password-reset', target.username, ''); }
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
    handle(req, res).catch(e => { log('error', e.message); if (!res.headersSent) send(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.code ? e.message : 'Server error' }); else res.end(); });
  };
  const server = tls ? https.createServer({ key: fs.readFileSync(tls.key), cert: fs.readFileSync(tls.cert), minVersion: 'TLSv1.2' }, onReq) : http.createServer(onReq);
  server.keepAliveTimeout = 65000;
  let timer = null, wtimer = null, first = null;
  const start = () => new Promise(ok => server.listen(port, host, () => {
    if (wadaHours > 0) {
      const run = () => wadaFeed.check({ db, broadcast, log, fetchImpl: wadaFetch || fetch }).catch(e => log('wada-failed', e.message));
      wtimer = setInterval(run, wadaHours * 3600e3); first = setTimeout(run, 20000);
    }
    if (backupEveryMs > 0) timer = setInterval(() => { try { backup('auto'); } catch (e) { log('backup-failed', e.message); } }, backupEveryMs);
    ok(server.address());
  }));
  const stop = () => new Promise(ok => { if (timer) clearInterval(timer); if (wtimer) clearInterval(wtimer); if (first) clearTimeout(first); for (const r of sse) { try { r.end(); } catch (e) {} } sse.clear(); try { backup('shutdown'); } catch (e) {} server.close(() => { db.close(); ok(); }); server.closeAllConnections && server.closeAllConnections(); });
  return { start, stop, db, backup, server, bkRoot };
}
module.exports = { createServer };
