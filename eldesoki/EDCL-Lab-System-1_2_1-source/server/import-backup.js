'use strict';
// One-time migration: load the desktop app's data (JSON backup or exported D object) into the central DB.
// Refuses to touch a non-empty database; takes a verified backup first when one exists.
const fs = require('fs');
const path = require('path');
const db_ = require('./db');
const store = require('./store');
const auth = require('./auth');

const KEYS = {
  Employees: ['StaffID'], Methods: ['MethodID'], Training: ['TrainingID'], Authorization: ['AuthorizationID'], Evaluation: ['EvaluationID'],
  IQAS: ['RecordID'], EQAS: ['RecordID'], Literature: ['LiteratureReviewID'], Gap: ['GapID'], Instruments: ['InstrumentID'],
  MethodCertifiedScientists: ['MethodID', 'StaffID'], EmployeeInstruments: ['StaffID', 'InstrumentID'], DocumentTemplates: ['TemplateID'],
  Plan: ['PlanID'], Flags: ['FlagID'], EmpJD: ['StaffID', 'JobDescID'], JobDesc: ['JobDescID'], Settings: ['SettingName'], AuthPers: ['AuthPersonID'],
  JobItems: ['ItemID'], InstrumentInventory: ['InstrumentCode'], InstrumentLegacyMap: ['LegacyID'], InstrumentMethods: ['LinkID'], InstrumentFlags: ['FlagID']
};
const SKIP = new Set(['Users', 'Perms', 'SystemAdministrator']);   // accounts are migrated separately, never as plain records

function importD(db, D, user = 'migration') {
  if (db.prepare('SELECT COUNT(*) c FROM records').get().c > 0) throw new Error('Central database is not empty: refusing to import over existing data');
  const counts = {}; let n = 0;
  db.tx(() => {
    for (const [tbl, rows] of Object.entries(D)) {
      if (SKIP.has(tbl) || !Array.isArray(rows)) continue;
      counts[tbl] = 0;
      rows.forEach((r, i) => {
        if (!r || typeof r !== 'object') return;
        const ks = KEYS[tbl], id = ks && ks.every(k => r[k] !== undefined && r[k] !== '') ? ks.map(k => String(r[k])).join('|') : `${tbl}#${String(i + 1).padStart(6, '0')}`;
        const res = store.applyOp(db, user, { tbl, id, op: 'put', baseRev: 0, data: r });
        if (!res.ok) throw new Error(`Import failed for ${tbl}/${id}: ${res.reason || res.error}`);
        counts[tbl]++; n++;
      });
    }
  });
  return { records: n, counts };
}
async function importUsers(db, D) {
  let n = 0;
  for (const u of D.Users || []) {
    if (!u.username || !u.hash) continue;
    const role = db.prepare('SELECT 1 FROM roles WHERE role=?').get(u.role) ? u.role : 'staff';
    try { await auth.createUser(db, { username: u.username, name: u.name, staffId: u.StaffID, role, legacy: u.hash, mustChange: true }); n++; } catch (e) { /* duplicate or invalid: skipped */ }
    if (u.active === 'No') db.prepare('UPDATE users SET active=0 WHERE username=?').run(String(u.username).toLowerCase());
  }
  return n;
}
module.exports = { importD, importUsers, KEYS };
if (require.main === module) {
  const [, , dataDir, file] = process.argv;
  if (!dataDir || !file) { console.error('usage: node server/import-backup.js <data-dir> <backup.json>'); process.exit(2); }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')), D = raw.D || raw.data || raw;
  const db = db_.open(path.join(dataDir, 'edcl-central.sqlite')); auth.seedRoles(db);
  (async () => { const r = importD(db, D); r.users = await importUsers(db, D); console.log(JSON.stringify(r, null, 1)); db.close(); })().catch(e => { console.error(e.message); process.exit(1); });
}
