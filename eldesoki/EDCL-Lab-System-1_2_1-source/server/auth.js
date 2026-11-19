'use strict';
// Individual accounts: scrypt-salted passwords, opaque session tokens (only SHA-256 stored), lockout, role permissions.
const crypto = require('crypto');
const util = require('util');
const scrypt = util.promisify(crypto.scrypt);

const DEFAULT_ROLES = {
  admin:        { edit: 1, audit: 1, backup: 1, recover: 1, users: 1, own: 1, assess: 1 },
  full_control: { edit: 1, audit: 1, backup: 1, recover: 0, users: 1, own: 1, assess: 1 },
  lab_manager:  { edit: 1, audit: 0, backup: 0, recover: 0, users: 0, own: 1, assess: 1 },
  quality:      { edit: 1, audit: 1, backup: 1, recover: 0, users: 0, own: 1, assess: 1 },
  staff:        { edit: 0, audit: 0, backup: 0, recover: 0, users: 0, own: 1, assess: 0 }
};
const MAX_FAILED = 5, LOCK_MS = 5 * 60 * 1000, IDLE_MS = 30 * 60 * 1000, MAX_MS = 12 * 3600 * 1000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const legacyHash = (u, p) => sha(u + ':' + p);      // the desktop app's old unsalted format (migration only)
const teq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyScrypt(pw, stored) {
  const p = String(stored || '').split('$');
  if (p[0] !== 'scrypt' || p.length !== 6) return false;
  const key = await scrypt(pw, Buffer.from(p[4], 'base64'), 32, { N: +p[1], r: +p[2], p: +p[3] });
  return teq(key.toString('base64'), p[5]);
}
function seedRoles(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO roles(role,perms) VALUES(?,?)');
  for (const [r, p] of Object.entries(DEFAULT_ROLES)) ins.run(r, JSON.stringify(p));
}
const permsOf = (db, role) => { const r = db.prepare('SELECT perms FROM roles WHERE role=?').get(role); return r ? JSON.parse(r.perms) : {}; };

async function createUser(db, { username, name, staffId, role, password, mustChange = true, legacy }) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(u)) throw new Error('Invalid username');
  if (!db.prepare('SELECT 1 FROM roles WHERE role=?').get(role)) throw new Error('Unknown role');
  const hash = password ? await hashPassword(password) : null;
  if (!hash && !legacy) throw new Error('A password is required');
  db.prepare('INSERT INTO users(username,name,staff_id,role,hash,legacy_hash,active,must_change,created_at) VALUES(?,?,?,?,?,?,1,?,?)')
    .run(u, name || u, staffId || null, role, hash, legacy || null, mustChange ? 1 : 0, new Date().toISOString());
  return u;
}
async function verifyPassword(db, username, password) {
  // re-authentication for protected screens: same hashing and lockout as login, but no new session is created
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim().toLowerCase());
  if (!u || !u.active) { await hashPassword('x'); return { ok: false }; }
  if (u.locked_until > Date.now()) return { ok: false, locked: true, error: 'Account temporarily locked. Try again later.' };
  const ok = u.hash ? await verifyScrypt(String(password || ''), u.hash) : false;
  if (!ok) {
    const f = u.failed + 1;
    db.prepare('UPDATE users SET failed=?, locked_until=? WHERE username=?').run(f >= MAX_FAILED ? 0 : f, f >= MAX_FAILED ? Date.now() + LOCK_MS : 0, u.username);
    db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), u.username, 'reauth-failed', '');
    return { ok: false };
  }
  db.prepare('UPDATE users SET failed=0, locked_until=0 WHERE username=?').run(u.username);
  db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), u.username, 'reauth', '');
  return { ok: true };
}
async function login(db, username, password, device) {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim().toLowerCase());
  const bad = { ok: false, error: 'Invalid username or password' };
  if (!u || !u.active) { await hashPassword('x'); return bad; }       // equalise timing
  if (u.locked_until > Date.now()) return { ok: false, error: 'Account temporarily locked. Try again later.', locked: true };
  let ok = false;
  if (u.hash) ok = await verifyScrypt(String(password || ''), u.hash);
  else if (u.legacy_hash) {                                            // first sign-in after migration: upgrade the old hash
    ok = teq(legacyHash(u.username, String(password || '')), u.legacy_hash);
    if (ok) db.prepare('UPDATE users SET hash=?, legacy_hash=NULL WHERE username=?').run(await hashPassword(password), u.username);
  }
  if (!ok) {
    const f = u.failed + 1;
    db.prepare('UPDATE users SET failed=?, locked_until=? WHERE username=?').run(f >= MAX_FAILED ? 0 : f, f >= MAX_FAILED ? Date.now() + LOCK_MS : 0, u.username);
    db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), u.username, 'login-failed', device || '');
    return bad;
  }
  db.prepare('UPDATE users SET failed=0, locked_until=0 WHERE username=?').run(u.username);
  const token = crypto.randomBytes(32).toString('base64url'), t = Date.now();
  db.prepare('INSERT INTO sessions(tokhash,username,created,last_seen,expires,device) VALUES(?,?,?,?,?,?)').run(sha(token), u.username, t, t, t + MAX_MS, String(device || '').slice(0, 80));
  db.prepare('INSERT INTO audit(at,user,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), u.username, 'login', device || '');
  return { ok: true, token, mustChange: !!u.must_change, user: publicUser(db, u) };
}
const publicUser = (db, u) => ({ username: u.username, name: u.name, staffId: u.staff_id, role: u.role, perms: permsOf(db, u.role) });
function authenticate(db, token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE tokhash=?').get(sha(token));
  const t = Date.now();
  if (!s || s.expires < t || s.last_seen + IDLE_MS < t) { if (s) db.prepare('DELETE FROM sessions WHERE tokhash=?').run(s.tokhash); return null; }
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(s.username);
  if (!u || !u.active) return null;
  if (t - s.last_seen > 60000) db.prepare('UPDATE sessions SET last_seen=? WHERE tokhash=?').run(t, s.tokhash);
  return { ...publicUser(db, u), mustChange: !!u.must_change, tokhash: s.tokhash };
}
const logout = (db, token) => db.prepare('DELETE FROM sessions WHERE tokhash=?').run(sha(token));
async function changePassword(db, username, oldPw, newPw) {
  if (String(newPw || '').length < 10) throw new Error('Password must be at least 10 characters');
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !(u.hash ? await verifyScrypt(String(oldPw || ''), u.hash) : false)) throw new Error('Current password is incorrect');
  db.prepare('UPDATE users SET hash=?, must_change=0 WHERE username=?').run(await hashPassword(newPw), username);
  db.prepare('DELETE FROM sessions WHERE username=? AND tokhash NOT IN (SELECT tokhash FROM sessions WHERE username=? ORDER BY last_seen DESC LIMIT 1)').run(username, username);
}
async function resetPassword(db, username, newPw) {
  if (String(newPw || '').length < 10) throw new Error('Password must be at least 10 characters');
  const r = db.prepare('UPDATE users SET hash=?, legacy_hash=NULL, must_change=1, failed=0, locked_until=0 WHERE username=?').run(await hashPassword(newPw), username);
  db.prepare('DELETE FROM sessions WHERE username=?').run(username);
  return r.changes > 0;
}
module.exports = { IDLE_MS, DEFAULT_ROLES, seedRoles, permsOf, createUser, login, verifyPassword, authenticate, logout, changePassword, resetPassword, legacyHash, hashPassword };
