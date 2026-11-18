const fs = require('fs');
const path = require('path');

let Database;
try { Database = require('better-sqlite3'); } catch (error) { Database = null; }

const ALLOWED_EXT = new Set(['.sqlite', '.sqlite3', '.db']);
const safeName = name => String(name || 'database.sqlite').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'database.sqlite';
const ensureDir = root => { const dir = path.join(root, 'sqlite'); fs.mkdirSync(dir, { recursive: true }); return dir; };
const assertPath = file => {
  if (!Database) throw new Error('SQLite native driver is unavailable');
  if (!file || !ALLOWED_EXT.has(path.extname(file).toLowerCase())) throw new Error('Only .sqlite, .sqlite3 and .db files are supported');
  if (!fs.existsSync(file)) throw new Error('SQLite file does not exist');
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > 2 * 1024 * 1024 * 1024) throw new Error('Invalid or oversized SQLite file');
};
const inspect = file => {
  assertPath(file);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('SQLite integrity_check failed: ' + integrity);
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const schema = tables.map(t => ({ name: t.name, sql: t.sql || '', columns: db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all().map(c => ({ name: c.name, type: c.type, notnull: !!c.notnull, pk: !!c.pk })) }));
    return { file: path.basename(file), size: fs.statSync(file).size, integrity, tables: schema };
  } finally { db.close(); }
};
const read = (file, sql, params = []) => {
  assertPath(file);
  if (typeof sql !== 'string' || !/^\s*select\b/i.test(sql)) throw new Error('Read operation accepts SELECT statements only');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return { columns: db.prepare(sql).columns().map(c => c.name), rows: db.prepare(sql).all(...(Array.isArray(params) ? params : [])) }; }
  finally { db.close(); }
};
const write = (file, sql, params = []) => {
  assertPath(file);
  if (typeof sql !== 'string' || !/^\s*(insert|update|delete|create|alter|drop|replace|pragma)\b/i.test(sql)) throw new Error('Write operation is limited to SQLite data-definition and data-change statements');
  const db = new Database(file, { fileMustExist: true });
  try { return db.transaction(() => db.prepare(sql).run(...(Array.isArray(params) ? params : [])))(); }
  finally { db.close(); }
};
const importFile = (root, source) => { assertPath(source); const dir = ensureDir(root); let base = safeName(path.basename(source)); let dest = path.join(dir, base); if (fs.existsSync(dest)) dest = path.join(dir, `${path.basename(base, path.extname(base))}-${Date.now()}${path.extname(base)}`); fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL); try { const meta = inspect(dest); return { path: dest, meta }; } catch (e) { try { fs.unlinkSync(dest); } catch {} throw e; } };
const list = root => { const dir = ensureDir(root); return fs.readdirSync(dir).filter(x => ALLOWED_EXT.has(path.extname(x).toLowerCase())).map(name => { const file = path.join(dir, name); let meta; try { meta = inspect(file); } catch (e) { meta = { error: e.message }; } return { name, path: file, size: fs.statSync(file).size, meta }; }); };
module.exports = { ALLOWED_EXT, ensureDir, inspect, read, write, importFile, list };
