'use strict';
// Record store with optimistic concurrency (revision numbers) and field-level three-way merge.
// A write NEVER blindly overwrites: the client states which revision it edited (baseRev).
const { nextSeq } = require('./db');

const stable = v => {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
};
const same = (a, b) => stable(a) === stable(b);
const changedKeys = (base, other) => {
  const ks = new Set([...Object.keys(base || {}), ...Object.keys(other || {})]);
  return [...ks].filter(k => !same((base || {})[k], (other || {})[k]));
};
const parse = s => (s == null ? null : JSON.parse(s));
const now = () => new Date().toISOString();

function getRecord(db, tbl, id) {
  const r = db.prepare('SELECT tbl,id,rev,data,deleted,seq FROM records WHERE tbl=? AND id=?').get(tbl, id);
  return r ? { tbl: r.tbl, id: r.id, rev: r.rev, data: parse(r.data), deleted: !!r.deleted, seq: r.seq } : null;
}
function writeRecord(db, user, tbl, id, rev, data, deleted, action) {
  const seq = nextSeq(db), at = now(), json = deleted ? null : JSON.stringify(data);
  db.prepare(`INSERT INTO records(tbl,id,rev,data,deleted,seq,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(tbl,id) DO UPDATE SET rev=excluded.rev,data=excluded.data,deleted=excluded.deleted,seq=excluded.seq,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .run(tbl, id, rev, json, deleted ? 1 : 0, seq, user, at);
  db.prepare('INSERT INTO versions(tbl,id,rev,data,deleted,by,at) VALUES(?,?,?,?,?,?,?)').run(tbl, id, rev, json, deleted ? 1 : 0, user, at);
  db.prepare('INSERT INTO audit(at,user,action,tbl,rid,detail) VALUES(?,?,?,?,?,?)').run(at, user, action, tbl, id, 'rev ' + rev);
  return seq;
}

// op: {tbl, id, op:'put'|'delete', baseRev:number (0 = create), data}
// Returns {ok:true, rev, seq, merged?, data?} or {ok:false, conflict:true, reason, fields?, server:{rev,data,deleted}}
function applyOp(db, user, op) {
  if (!op || typeof op.tbl !== 'string' || typeof op.id !== 'string' || !op.tbl || !op.id) return { ok: false, error: 'tbl and id are required' };
  if (op.op !== 'put' && op.op !== 'delete') return { ok: false, error: 'op must be put or delete' };
  if (!Number.isInteger(op.baseRev) || op.baseRev < 0) return { ok: false, error: 'baseRev (integer >= 0) is required: blind overwrites are not allowed' };
  if (op.op === 'put' && (!op.data || typeof op.data !== 'object' || Array.isArray(op.data))) return { ok: false, error: 'data must be an object' };
  const cur = getRecord(db, op.tbl, op.id);
  const srv = c => c && { rev: c.rev, data: c.data, deleted: c.deleted };
  if (!cur) {
    if (op.baseRev !== 0) return { ok: false, conflict: true, reason: 'missing', server: null };
    if (op.op === 'delete') return { ok: true, rev: 0, noop: true };
    return { ok: true, rev: 1, seq: writeRecord(db, user, op.tbl, op.id, 1, op.data, false, 'create') };
  }
  if (cur.deleted) {
    if (op.baseRev === cur.rev && op.op === 'put') return { ok: true, rev: cur.rev + 1, seq: writeRecord(db, user, op.tbl, op.id, cur.rev + 1, op.data, false, 'restore') };
    if (op.op === 'delete') return { ok: true, rev: cur.rev, noop: true };
    return { ok: false, conflict: true, reason: 'deleted', server: srv(cur) };
  }
  if (op.baseRev === 0) return { ok: false, conflict: true, reason: 'exists', server: srv(cur) };
  if (op.op === 'delete') {
    if (op.baseRev !== cur.rev) return { ok: false, conflict: true, reason: 'changed', server: srv(cur) };
    return { ok: true, rev: cur.rev + 1, seq: writeRecord(db, user, op.tbl, op.id, cur.rev + 1, null, true, 'delete') };
  }
  if (op.baseRev === cur.rev) {
    if (same(op.data, cur.data)) return { ok: true, rev: cur.rev, noop: true };
    return { ok: true, rev: cur.rev + 1, seq: writeRecord(db, user, op.tbl, op.id, cur.rev + 1, op.data, false, 'update') };
  }
  // stale base: three-way merge on top-level fields
  const bv = db.prepare('SELECT data,deleted FROM versions WHERE tbl=? AND id=? AND rev=?').get(op.tbl, op.id, op.baseRev);
  if (!bv || bv.deleted) return { ok: false, conflict: true, reason: 'base-unknown', server: srv(cur) };
  const base = parse(bv.data);
  const mine = changedKeys(base, op.data), theirs = changedKeys(base, cur.data);
  const clash = mine.filter(k => theirs.includes(k) && !same(op.data[k], cur.data[k]));
  if (clash.length) return { ok: false, conflict: true, reason: 'fields', fields: clash, server: srv(cur) };
  const merged = { ...cur.data };
  for (const k of mine) { if (k in op.data) merged[k] = op.data[k]; else delete merged[k]; }
  if (same(merged, cur.data)) return { ok: true, rev: cur.rev, noop: true, merged: true, data: cur.data };
  const rev = cur.rev + 1;
  return { ok: true, rev, merged: true, data: merged, seq: writeRecord(db, user, op.tbl, op.id, rev, merged, false, 'merge') };
}

function changesSince(db, since, limit, filter) {
  const rows = db.prepare('SELECT tbl,id,rev,data,deleted,seq FROM records WHERE seq>? ORDER BY seq LIMIT ?').all(since, limit + 1);
  const more = rows.length > limit;
  const out = [];
  for (const r of rows.slice(0, limit)) {
    const rec = { tbl: r.tbl, id: r.id, rev: r.rev, deleted: !!r.deleted, seq: r.seq, data: parse(r.data) };
    if (filter(rec)) out.push(rec);
  }
  const last = rows.length ? rows[Math.min(rows.length, limit) - 1].seq : since;
  return { changes: out, lastSeq: last, more };
}
module.exports = { applyOp, getRecord, changesSince, stable, same, changedKeys };
