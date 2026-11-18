'use strict';
// Central file store: documents, evidence, form templates and completed forms.
// Bytes are content-addressed on disk (<data>/files/<aa>/<sha256>), verified on upload; metadata lives in SQLite.
// Deleting a file only marks it deleted (bytes are kept until an administrator purges them) so nothing is lost by accident.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY AUTOINCREMENT, cat TEXT NOT NULL, name TEXT, code TEXT, type TEXT, size INTEGER, date TEXT,
  sha256 TEXT NOT NULL, created_by TEXT, created_at TEXT, deleted INTEGER NOT NULL DEFAULT 0, deleted_by TEXT, deleted_at TEXT, extra TEXT);
CREATE INDEX IF NOT EXISTS files_cat ON files(cat);
CREATE INDEX IF NOT EXISTS files_sha ON files(sha256);
`;
const HEX = /^[0-9a-f]{64}$/;
const blobPath = (dir, sha) => path.join(dir, 'files', sha.slice(0, 2), sha);

function init(db) { db.exec(SCHEMA); }
const row = r => r && ({ id: r.id, cat: r.cat, name: r.name, code: r.code, type: r.type, size: r.size, date: r.date, sha256: r.sha256, createdBy: r.created_by, createdAt: r.created_at, extra: r.extra ? JSON.parse(r.extra) : undefined });

function list(db, cat) {
  const rows = cat ? db.prepare('SELECT * FROM files WHERE deleted=0 AND cat=? ORDER BY id').all(cat) : db.prepare('SELECT * FROM files WHERE deleted=0 ORDER BY id').all();
  return rows.map(row);
}
const get = (db, id) => row(db.prepare('SELECT * FROM files WHERE id=? AND deleted=0').get(id));
const hasBlob = (dir, sha) => HEX.test(sha) && fs.existsSync(blobPath(dir, sha));

// Stream an upload to disk while hashing; refuse when the hash differs from the one in the URL or the size limit is exceeded.
function receiveBlob(dir, sha, req, maxBytes) {
  return new Promise((ok, no) => {
    if (!HEX.test(sha)) return no(Object.assign(new Error('Invalid hash'), { code: 400 }));
    const dest = blobPath(dir, sha);
    if (fs.existsSync(dest)) { req.resume(); return ok({ size: fs.statSync(dest).size, existed: true }); }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.' + crypto.randomBytes(6).toString('hex') + '.part', h = crypto.createHash('sha256'), out = fs.createWriteStream(tmp);
    let n = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; try { out.destroy(); } catch (x) {} try { fs.unlinkSync(tmp); } catch (x) {} no(e); };
    req.on('data', d => { n += d.length; if (n > maxBytes) { fail(Object.assign(new Error('File too large'), { code: 413 })); req.destroy(); } else { h.update(d); out.write(d); } });
    req.on('error', fail);
    req.on('end', () => { if (failed) return; out.end(() => {
      if (h.digest('hex') !== sha) return fail(Object.assign(new Error('Upload corrupted: hash mismatch'), { code: 400 }));
      try { fs.renameSync(tmp, dest); } catch (e) { if (!fs.existsSync(dest)) return fail(e); try { fs.unlinkSync(tmp); } catch (x) {} }
      ok({ size: n, existed: false });
    }); });
  });
}
function add(db, dir, user, m) {
  if (!hasBlob(dir, m.sha256)) throw Object.assign(new Error('Upload the file bytes first'), { code: 400 });
  const size = fs.statSync(blobPath(dir, m.sha256)).size, at = new Date().toISOString();
  const r = db.prepare('INSERT INTO files(cat,name,code,type,size,date,sha256,created_by,created_at,extra) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(String(m.cat || ''), String(m.name || ''), String(m.code || ''), String(m.type || ''), size, String(m.date || at.slice(0, 16).replace('T', ' ')), m.sha256, user, at, m.extra ? JSON.stringify(m.extra) : null);
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO audit(at,user,action,tbl,rid,detail) VALUES(?,?,?,?,?,?)').run(at, user, 'file-add', 'files', String(id), `${m.cat}: ${m.name} (${size} bytes)`);
  return get(db, id);
}
// migration only: keep the ORIGINAL numeric id, because rows in the app refer to files by that id
function importWithId(db, dir, user, m) {
  const bytes = m.bytes, sha = crypto.createHash('sha256').update(bytes).digest('hex'), dest = blobPath(dir, sha);
  if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); }
  const at = new Date().toISOString();
  db.prepare('INSERT INTO files(id,cat,name,code,type,size,date,sha256,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(Number(m.id), String(m.cat || ''), String(m.name || ''), String(m.code || ''), String(m.type || ''), bytes.length, String(m.date || ''), sha, user, at);
  return sha;
}
function replace(db, dir, user, id, m) {   // new bytes/metadata for the same id; the previous bytes stay on disk
  const cur = get(db, id); if (!cur) throw Object.assign(new Error('No such file'), { code: 404 });
  const sha = m.sha256 || cur.sha256; if (!hasBlob(dir, sha)) throw Object.assign(new Error('Upload the file bytes first'), { code: 400 });
  const size = fs.statSync(blobPath(dir, sha)).size, at = new Date().toISOString();
  db.prepare('UPDATE files SET name=?,code=?,type=?,size=?,date=?,sha256=?,cat=? WHERE id=?')
    .run(m.name ?? cur.name, m.code ?? cur.code, m.type ?? cur.type, size, m.date ?? cur.date, sha, m.cat ?? cur.cat, id);
  db.prepare('INSERT INTO audit(at,user,action,tbl,rid,detail) VALUES(?,?,?,?,?,?)').run(at, user, 'file-replace', 'files', String(id), `${cur.sha256.slice(0, 12)} -> ${sha.slice(0, 12)}`);
  return get(db, id);
}
function remove(db, user, id) {
  const cur = get(db, id); if (!cur) return false; const at = new Date().toISOString();
  db.prepare('UPDATE files SET deleted=1,deleted_by=?,deleted_at=? WHERE id=?').run(user, at, id);
  db.prepare('INSERT INTO audit(at,user,action,tbl,rid,detail) VALUES(?,?,?,?,?,?)').run(at, user, 'file-delete', 'files', String(id), `${cur.cat}: ${cur.name}`);
  return true;
}
function clearAll(db, user) {   // used only by the owner's "reset" - marks everything deleted, bytes stay
  const at = new Date().toISOString(); db.prepare('UPDATE files SET deleted=1,deleted_by=?,deleted_at=? WHERE deleted=0').run(user, at);
}
module.exports = { init, list, get, add, importWithId, replace, remove, clearAll, hasBlob, receiveBlob, blobPath, HEX };
