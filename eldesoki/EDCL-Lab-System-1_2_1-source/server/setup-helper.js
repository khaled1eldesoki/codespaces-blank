'use strict';
// Used by EDCL-Server-Setup.exe (and runnable by hand): writes server.json, creates the private CA + server certificate,
// creates the first administrator, and prepares the folder that is copied to every workstation.
// node setup-helper.js --name HOST[,HOST2] --ip A[,B] --port 8443 --data DIR --backup DIR --root DIR --owner USER [--wada-hours 6]
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const list = s => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
(async () => {
  const root = path.resolve(arg('root', path.join(process.env.ProgramData || '.', 'EDCL Server')));
  const names = list(arg('name', require('os').hostname())), ips = list(arg('ip', '')), port = +arg('port', 8443);
  const data = path.resolve(arg('data', path.join(root, 'data'))), backup = arg('backup', path.join(root, 'backups'));
  const certs = path.join(root, 'certs'), cc = path.join(root, 'client-config'), cfgFile = path.join(root, 'server.json');
  if (!(port > 0 && port < 65536)) throw new Error('Invalid port');
  if (!names.length && !ips.length) throw new Error('Give at least one server name or IP address');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  const c = require('./certs');
  const have = fs.existsSync(path.join(certs, 'ca.crt'));
  const url = 'https://' + (names[0] || ips[0]) + ':' + port;
  const info = c.make({ outDir: certs, names, ips, renew: have, url });
  fs.mkdirSync(cc, { recursive: true });
  fs.copyFileSync(path.join(certs, 'ca.crt'), path.join(cc, 'ca.crt'));
  fs.writeFileSync(path.join(cc, 'server.json'), JSON.stringify({ serverUrl: url, caFingerprint: info.caFingerprint }, null, 2));
  fs.writeFileSync(path.join(cc, 'server-url.txt'), url);
  fs.writeFileSync(path.join(cc, 'README.txt'), `EDCL client configuration\r\nServer address : ${url}\r\nOther names/IPs: ${[...info.dns, ...info.ip].join(', ')}\r\nCertificate fingerprint (SHA-256, check it on each workstation during setup):\r\n${info.caFingerprint}\r\n\r\nCopy this whole folder next to EDCL-Client-Setup.exe on each workstation (or type the address and pick ca.crt).\r\nDo NOT copy anything from the "certs" folder except what is in here: ca.key and server.key must never leave the server.\r\n`);
  const cfg = { serverName: 'EDCL Server', host: '0.0.0.0', port, dataDir: data.replace(/\\/g, '/'), backupDir: String(backup).replace(/\\/g, '/'), tlsKey: path.join(certs, 'server.key').replace(/\\/g, '/'), tlsCert: path.join(certs, 'server.crt').replace(/\\/g, '/'), backupMinutes: 30, keepBackups: 60, wadaHours: +arg('wada-hours', 6), maxFileMB: 300 };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const db_ = require('./db'), auth = require('./auth'), files = require('./files');
  const db = db_.open(path.join(data, 'edcl-central.sqlite')); auth.seedRoles(db); files.init(db);
  let ownerPassword = '', owner = arg('owner', 'admin');
  if (!db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c) { ownerPassword = crypto.randomBytes(12).toString('base64url'); await auth.createUser(db, { username: owner, name: 'System Owner', role: 'admin', password: ownerPassword }); }
  db.close();
  console.log(JSON.stringify({ ok: true, url, config: cfgFile, clientConfig: cc, caFingerprint: info.caFingerprint, owner: ownerPassword ? owner : '', ownerPassword, certRenewed: have, notAfter: info.serverNotAfter }));
})().catch(e => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
