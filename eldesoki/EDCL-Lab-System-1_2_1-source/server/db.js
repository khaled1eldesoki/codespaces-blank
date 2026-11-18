'use strict';
// SQLite access for the EDCL central server. Prefers better-sqlite3 (bundled with the app),
// falls back to Node's built-in node:sqlite (Node >= 22.13). Both expose prepare/get/all/run/exec.
const fs = require('fs');
const path = require('path');
let Driver = null, kind = '';
try { Driver = require('better-sqlite3'); kind = 'better-sqlite3'; }
catch (e) { try { Driver = require('node:sqlite').DatabaseSync; kind = 'node:sqlite'; } catch (e2) { Driver = null; } }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS records(
  tbl TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL, updated_by TEXT, updated_at TEXT, PRIMARY KEY(tbl, id));
CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
CREATE TABLE IF NOT EXISTS versions(
  tbl TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0,
  by TEXT, at TEXT, PRIMARY KEY(tbl, id, rev));
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, name TEXT, staff_id TEXT, role TEXT NOT NULL, hash TEXT, legacy_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 1, failed INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS roles(role TEXT PRIMARY KEY, perms TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  tokhash TEXT PRIMARY KEY, username TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  expires INTEGER NOT NULL, device TEXT);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user TEXT, action TEXT NOT NULL, tbl TEXT, rid TEXT, detail TEXT);
`;

function open(file) {
  if (!Driver) throw new Error('No SQLite driver available (need better-sqlite3 or Node >= 22.13)');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Driver(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  db.kind = kind;
  db.tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; } };
  return db;
}
const nextSeq = db => {
  const r = db.prepare("SELECT v FROM meta WHERE k='seq'").get();
  const n = (r ? Number(r.v) : 0) + 1;
  db.prepare("INSERT INTO meta(k,v) VALUES('seq',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(n));
  return n;
};
const curSeq = db => { const r = db.prepare("SELECT v FROM meta WHERE k='seq'").get(); return r ? Number(r.v) : 0; };
module.exports = { open, nextSeq, curSeq, kind: () => kind };
