'use strict';
// EDCL central server command line.
//   start            [--config server.json] | [--data DIR --port N --tls-key F --tls-cert F --backup-minutes N --wada-hours N]
//   init-owner       <username> [--data DIR]            create the first administrator (random one-time password)
//   create-user      <username> <role> [--name N] [--staff ID] [--data DIR]   (admin only action done offline, prints one-time password)
//   reset-password   <username> [--data DIR]            new random one-time password
//   make-certs       [--out DIR] [--name N]... [--ip A]... [--url URL] [--renew]
//   backup           [--data DIR] [--backup-dir DIR]    verified backup now (server may be running)
//   verify-backup    <file.sqlite>
//   restore          <file.sqlite> [--data DIR] [--backup-dir DIR]   (server must be stopped)
//   import           <backup.json> [--data DIR]         one-time migration of the desktop app's data into an EMPTY server
//   status           [--data DIR]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const args = (n) => { const o = []; process.argv.forEach((a, i) => { if (a === '--' + n && process.argv[i + 1]) o.push(process.argv[i + 1]); }); return o; };
const flag = n => process.argv.includes('--' + n);
const pos = () => process.argv.slice(3).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--') && !['--renew', '--no-start'].includes(all[i - 1])));
const cmd = process.argv[2];

function loadConfig() {
  const cfgPath = arg('config', ''); let c = {};
  if (cfgPath) { c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); c._dir = path.dirname(path.resolve(cfgPath)); }
  const rel = p => (p && c._dir && !path.isAbsolute(p) ? path.join(c._dir, p) : p);
  return {
    dataDir: path.resolve(arg('data', rel(c.dataDir) || path.join(process.cwd(), 'edcl-server-data'))),
    port: +arg('port', c.port || 8443), host: arg('host', c.host || '0.0.0.0'),
    tlsKey: arg('tls-key', rel(c.tlsKey)), tlsCert: arg('tls-cert', rel(c.tlsCert)),
    backupMinutes: +arg('backup-minutes', c.backupMinutes ?? 30), keepBackups: +arg('keep-backups', c.keepBackups || 30),
    backupDir: arg('backup-dir', rel(c.backupDir) || ''), wadaHours: +arg('wada-hours', c.wadaHours ?? 6),
    maxFileMB: +arg('max-file-mb', c.maxFileMB || 300), serverName: c.serverName || 'EDCL Server'
  };
}
const lockFile = dataDir => path.join(dataDir, 'server.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function runningPid(dataDir) { try { const p = +fs.readFileSync(lockFile(dataDir), 'utf8').split('\n')[0]; return p && alive(p) ? p : 0; } catch (e) { return 0; } }
const pw = () => crypto.randomBytes(12).toString('base64url');

(async () => {
  const cfg = loadConfig();
  const need = () => { const db_ = require('./db'), auth = require('./auth'), files = require('./files'); return { db_, auth, files }; };
  const openDb = () => { const { db_, auth, files } = need(); const db = db_.open(path.join(cfg.dataDir, 'edcl-central.sqlite')); auth.seedRoles(db); files.init(db); return { db, auth }; };

  if (cmd === 'start') {
    const { createServer } = require('./server');
    if (runningPid(cfg.dataDir)) throw new Error('A server is already running for ' + cfg.dataDir + ' (pid ' + runningPid(cfg.dataDir) + ')');
    const tls = cfg.tlsKey && cfg.tlsCert ? { key: cfg.tlsKey, cert: cfg.tlsCert } : null;
    if (!tls && !flag('allow-http')) throw new Error('Refusing to start without HTTPS (passwords would cross the network readable). Run make-certs first, or add --allow-http for a local test only.');
    const s = createServer({ dataDir: cfg.dataDir, tls, port: cfg.port, host: cfg.host, backupEveryMs: cfg.backupMinutes * 60000, keepBackups: cfg.keepBackups, backupDir: cfg.backupDir, wadaHours: cfg.wadaHours, maxFileBytes: cfg.maxFileMB * 1048576, serverName: cfg.serverName, configFile: arg('config', '') ? path.resolve(arg('config', '')) : '', onRestart: () => down(), log: (...a) => console.error(new Date().toISOString(), ...a) });
    const a = await s.start();
    fs.writeFileSync(lockFile(cfg.dataDir), process.pid + '\n' + new Date().toISOString());
    console.log(`${new Date().toISOString()} EDCL central server (${tls ? 'HTTPS' : 'PLAIN HTTP - TEST ONLY'}) listening on ${a.address}:${a.port}, data: ${cfg.dataDir}, backups: ${s.bkRoot}`);
    let closing = false;
    const down = () => { if (closing) return; closing = true; s.stop().then(() => { try { fs.unlinkSync(lockFile(cfg.dataDir)); } catch (e) {} process.exit(0); }); };
    process.on('SIGINT', down); process.on('SIGTERM', down); process.on('SIGBREAK', down);
    return;
  }
  if (cmd === 'init-owner') {
    const user = pos()[0]; if (!user) throw new Error('usage: init-owner <username>');
    const { db, auth } = openDb();
    if (db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c) throw new Error('An administrator already exists');
    const p = pw(); await auth.createUser(db, { username: user, name: 'System Owner', role: 'admin', password: p });
    console.log(`Owner "${user}" created.\nOne-time password: ${p}\n(It must be changed at first sign-in. It is not stored anywhere in readable form.)`); db.close(); return;
  }
  if (cmd === 'create-user') {
    const [user, role] = pos(); if (!user || !role) throw new Error('usage: create-user <username> <role> [--name N] [--staff ID]');
    const { db, auth } = openDb(); const p = pw();
    await auth.createUser(db, { username: user, role, name: arg('name', user), staffId: arg('staff', ''), password: p });
    console.log(`User "${user}" (${role}) created.\nOne-time password: ${p}`); db.close(); return;
  }
  if (cmd === 'reset-password') {
    const user = pos()[0]; if (!user) throw new Error('usage: reset-password <username>');
    const { db, auth } = openDb(); const p = pw(); await auth.resetPassword(db, user.toLowerCase(), p);
    db.prepare('INSERT INTO audit(at,user,action,rid) VALUES(?,?,?,?)').run(new Date().toISOString(), 'cli', 'password-reset', user.toLowerCase());
    console.log(`New one-time password for "${user}": ${p}`); db.close(); return;
  }
  if (cmd === 'make-certs') {
    const certs = require('./certs'), out = path.resolve(arg('out', path.join(cfg.dataDir, '..', 'certs')));
    const info = certs.make({ outDir: out, names: args('name'), ips: args('ip'), days: +arg('days', 730), renew: flag('renew'), url: arg('url', '') });
    console.log(JSON.stringify({ outDir: out, ...info }, null, 2)); return;
  }
  if (cmd === 'backup') {
    const { createServer } = require('./server'); const s = createServer({ dataDir: cfg.dataDir, backupDir: cfg.backupDir, port: 0 });
    const r = s.backup('manual'); console.log(JSON.stringify(r, null, 1)); s.db.close(); return;
  }
  if (cmd === 'verify-backup') {
    const f = pos()[0]; if (!f) throw new Error('usage: verify-backup <file.sqlite>');
    const { db_ } = need(); const db = db_.open(path.resolve(f)); const ic = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
    const out = { file: f, integrity: ic, records: db.prepare('SELECT COUNT(*) c FROM records').get().c, users: db.prepare('SELECT COUNT(*) c FROM users').get().c, files: db.prepare('SELECT COUNT(*) c FROM files WHERE deleted=0').get().c };
    db.close(); console.log(JSON.stringify(out, null, 1)); if (ic !== 'ok') process.exit(1); return;
  }
  if (cmd === 'restore') {
    const src = path.resolve(pos()[0] || ''); if (!fs.existsSync(src)) throw new Error('usage: restore <file.sqlite> (file not found)');
    if (runningPid(cfg.dataDir)) throw new Error('The server is running (pid ' + runningPid(cfg.dataDir) + '). Stop the EDCL Server service first.');
    const { db_ } = need(), cur = path.join(cfg.dataDir, 'edcl-central.sqlite');
    const chk = db_.open(src); const ic = Object.values(chk.prepare('PRAGMA integrity_check').get())[0]; const n = chk.prepare('SELECT COUNT(*) c FROM records').get().c;
    const refs = chk.prepare('SELECT DISTINCT sha256 FROM files WHERE deleted=0').all().map(r => r.sha256); chk.close();
    if (ic !== 'ok') throw new Error('The backup failed its integrity check (' + ic + '). Nothing was changed.');
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const keep = path.join(cfg.dataDir, 'pre-restore-' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(keep, { recursive: true });
    for (const x of ['', '-wal', '-shm']) if (fs.existsSync(cur + x)) fs.copyFileSync(cur + x, path.join(keep, 'edcl-central.sqlite' + x));
    for (const x of ['', '-wal', '-shm']) if (fs.existsSync(cur + x)) fs.unlinkSync(cur + x);
    fs.copyFileSync(src, cur);
    const mirror = path.join(cfg.backupDir || path.join(cfg.dataDir, 'backups'), 'files'); let missing = 0, restored = 0;
    for (const sha of refs) {
      const dst = path.join(cfg.dataDir, 'files', sha.slice(0, 2), sha); if (fs.existsSync(dst)) continue;
      const m = path.join(mirror, sha.slice(0, 2), sha);
      if (fs.existsSync(m)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(m, dst); restored++; } else missing++;
    }
    console.log(JSON.stringify({ restoredFrom: src, records: n, previousDatabaseKeptIn: keep, fileBytesRestoredFromMirror: restored, fileBytesMissing: missing }, null, 1));
    if (missing) { console.log('WARNING: ' + missing + ' uploaded file(s) referenced by this backup have no bytes in ' + mirror + ' or ' + path.join(cfg.dataDir, 'files')); process.exitCode = 3; }
    return;
  }
  if (cmd === 'import') {
    const f = pos()[0]; if (!f) throw new Error('usage: import <backup.json>');
    if (runningPid(cfg.dataDir)) throw new Error('Stop the server before importing.');
    const imp = require('./import-backup'), { db, auth } = openDb(); const raw = JSON.parse(fs.readFileSync(f, 'utf8')), D = raw.D || raw.data || raw;
    const r = imp.importD(db, D); r.users = await imp.importUsers(db, D);
    const files = require('./files'); let nf = 0, bad = [];
    for (const f of (raw.files || [])) {
      try {
        const m = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(String(f.blob || '')); if (!m) throw new Error('unreadable file data');
        const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'binary');
        files.importWithId(db, cfg.dataDir, 'migration', { ...f, type: f.type || f.bt || m[1] || '', bytes }); nf++;
      } catch (e) { bad.push((f && f.id) + ':' + e.message); }
    }
    r.files = { imported: nf, failed: bad.length, failures: bad.slice(0, 10) };
    console.log(JSON.stringify(r, null, 1)); db.close(); if (bad.length) process.exitCode = 3; return;
  }
  if (cmd === 'status') {
    const { db } = openDb(); const o = { dataDir: cfg.dataDir, running: runningPid(cfg.dataDir) || false, records: db.prepare('SELECT COUNT(*) c FROM records WHERE deleted=0').get().c, files: db.prepare('SELECT COUNT(*) c FROM files WHERE deleted=0').get().c, users: db.prepare('SELECT COUNT(*) c FROM users').get().c };
    db.close(); console.log(JSON.stringify(o, null, 1)); return;
  }
  console.error('commands: start | init-owner | create-user | reset-password | make-certs | backup | verify-backup | restore | import | status'); process.exit(2);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
