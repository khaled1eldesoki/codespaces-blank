'use strict';
// End-to-end check of the server dashboard: the REAL renderer (index.html + dashboard.js) in headless Chromium,
// the REAL main-process handlers (server-dashboard/main.js, electron stubbed) and a REAL server over HTTPS.
// Skipped automatically when playwright/chromium or openssl are missing.
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const { execFileSync } = require('child_process');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP: playwright not available'); process.exit(0); }
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-dash-e2e-'));
const shots = process.env.SHOTS_DIR || '';
try { execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' }); }
catch (e) { console.log('SKIP: openssl not available'); process.exit(0); }

// ---- stub electron, then load the real main.js
const handlers = {};
const fakeElectron = {
  app: { getPath: () => path.join(tmp, 'userdata'), getAppPath: () => path.join(tmp, 'app'), requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), on() {}, quit() {} },
  BrowserWindow: class {}, shell: {}, ipcMain: { handle: (n, f) => { handlers[n] = f; } },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(tmp, 'c.pem')] }) }
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : origLoad.call(this, req, ...rest); };
process.env.ProgramData = path.join(tmp, 'ProgramData');           // no local server here -> the dashboard starts in "remote" mode
fs.mkdirSync(path.join(tmp, 'userdata'), { recursive: true });
require(path.join(ROOT, 'server-dashboard', 'main.js'));
const fileUrl = require('url').pathToFileURL(path.join(ROOT, 'server-dashboard', 'index.html')).href;
const ev = { senderFrame: { url: fileUrl } };

const { createServer } = require(path.join(ROOT, 'server', 'server.js'));
const auth = require(path.join(ROOT, 'server', 'auth.js'));
let restarts = 0;
(async () => {
  const dir = path.join(tmp, 'data');
  const srv = createServer({ dataDir: dir, port: 0, host: '127.0.0.1', tls: { key: path.join(tmp, 'k.pem'), cert: path.join(tmp, 'c.pem') }, backupDir: path.join(tmp, 'bk'), backupEveryMs: 1800000, onRestart: () => { restarts++; } });
  const addr = await srv.start(); const url = `https://localhost:${addr.port}`;
  const PW = 'Str0ng-Pass-1234';
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.exposeFunction('__ipc', (name, arg) => { if (!handlers[name]) throw new Error('no handler ' + name); return Promise.resolve().then(() => handlers[name](ev, arg)).catch(e => { throw new Error("Error invoking remote method '" + name + "': Error: " + e.message); }); });
  const preload = fs.readFileSync(path.join(ROOT, 'server-dashboard', 'preload.js'), 'utf8');
  await page.addInitScript(`(function(){const require=()=>({contextBridge:{exposeInMainWorld:(n,o)=>{window[n]=o}},ipcRenderer:{invoke:(c,...a)=>window.__ipc(c,...a)}});${preload}})();`);
  const shot = async n => { if (shots) await page.screenshot({ path: path.join(shots, n + '.png') }); };
  let n = 0; const ok = m => console.log('ok ' + (++n) + ' - ' + m);

  await page.goto(fileUrl);
  await page.waitForSelector('#connection-modal:not([hidden])', { timeout: 8000 }).catch(async e => { console.log('ERRORS', errors, await page.evaluate(async () => JSON.stringify({ hidden: document.querySelector('#connection-modal').hidden, notice: document.querySelector('#notice').textContent, conn: await window.serverDashboard.connection.get().catch(e => String(e)), h: await window.serverDashboard.health().catch(e => String(e)) }))); throw e; }); ok('no server configured -> connection dialog opens'); await shot('1-connection');
  await page.fill('#connection-form [name=serverUrl]', url);
  await page.click('#choose-ca'); await page.waitForFunction(() => /SHA-256/.test(document.querySelector('#ca-info').textContent)); ok('CA certificate chosen, fingerprint shown');
  await page.click('#connection-form button[type=submit]');
  await page.waitForSelector('#setup-modal:not([hidden])', { timeout: 6000 }).catch(async e => { console.log(await page.evaluate(() => document.querySelector('#connection-error').textContent + ' / ' + document.querySelector('#notice').textContent)); throw e; }); ok('connected over TLS; empty server offers first-time setup'); await shot('2-setup');
  await page.fill('#setup-form [name=password]', 'Str0ng-Pass-1234'); await page.fill('#setup-form [name=confirm]', 'different-pass-99'); await page.click('#setup-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#setup-error').textContent.length > 0); ok('mismatched passwords refused');
  await page.fill('#setup-form [name=password]', PW); await page.fill('#setup-form [name=confirm]', PW); await page.click('#setup-form button[type=submit]');
  await page.waitForSelector('#account:not([hidden])'); ok('administrator created and signed in without any command line');
  await auth.createUser(srv.db, { username: 'sam', name: 'Sam Staff', role: 'staff', password: PW, mustChange: false });
  const tok = (await (await fetch(url.replace('localhost', '127.0.0.1') + '/api/login', { method: 'POST', body: '{}' }).catch(() => ({ json: async () => ({}) }))).json());   // (self-signed: not used, see below)
  // second workstation session + files via the server object directly
  const login = await srv.db.prepare('SELECT 1').get(); void tok; void login;
  const http = require('https'); const call = (m, p, b, t) => new Promise((res, rej) => { const r = http.request(url + p, { method: m, ca: fs.readFileSync(path.join(tmp, 'c.pem')), headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) } }, s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res(JSON.parse(d))); }); r.on('error', rej); r.end(b ? JSON.stringify(b) : undefined); });
  const samTok = (await call('POST', '/api/login', { username: 'sam', password: PW, device: 'LAB-PC-07' })).token;
  const adminTok = (await call('POST', '/api/login', { username: 'admin', password: PW, device: 'extra' })).token;
  const crypto = require('crypto'), bytes = Buffer.from('hello evidence'), sha = crypto.createHash('sha256').update(bytes).digest('hex');
  await new Promise((res, rej) => { const r = http.request(url + '/api/blobs/' + sha, { method: 'PUT', ca: fs.readFileSync(path.join(tmp, 'c.pem')), headers: { Authorization: 'Bearer ' + adminTok } }, s => { s.resume(); s.on('end', res); }); r.on('error', rej); r.end(bytes); });
  await call('POST', '/api/files', { cat: 'ev:emp1', name: 'evidence.pdf', sha256: sha }, adminTok);

  await page.click('#refresh'); await page.waitForFunction(() => document.querySelector('#stat-sessions').textContent !== '—');
  assert.ok(await page.textContent('#stat-status') === 'Online'); assert.ok((await page.textContent('#stat-files')) === '1');
  assert.ok(await page.locator('#alerts .alert').count() >= 1); ok('overview shows live tiles and health alerts (HTTPS server, no backup yet)');
  assert.ok(/HTTPS/.test(await page.textContent('#security')));
  await page.click('#quick-backup'); await page.waitForFunction(() => /Verified backup created/.test(document.querySelector('#notice').textContent)); ok('backup created from the dashboard'); await shot('3-overview');

  await page.click('[data-view=sessions]'); await page.waitForSelector('#sessions-table [data-revoke]');
  assert.ok((await page.textContent('#sessions-table')).includes('LAB-PC-07')); ok('connected users lists the workstation');
  page.once('dialog', d => d.accept()); await page.click('#sessions-table tr:has-text("LAB-PC-07") [data-revoke]');
  await page.waitForFunction(() => !document.querySelector('#sessions-table').textContent.includes('LAB-PC-07'));
  assert.equal((await call('GET', '/api/me', null, samTok)).error, 'Not signed in'); ok('signing a workstation out ends its session on the server'); await shot('4-sessions');

  await page.click('[data-view=files]'); await page.waitForSelector('#files-table td strong');
  assert.ok((await page.textContent('#files-table')).includes('evidence.pdf'));
  await page.click('#verify-files'); await page.waitForFunction(() => /passed/.test(document.querySelector('#files-check').textContent)); ok('files browser + integrity check passes');
  fs.writeFileSync(path.join(dir, 'files', sha.slice(0, 2), sha), 'tampered');
  await page.click('#verify-files'); await page.waitForFunction(() => /1 problem/.test(document.querySelector('#files-check').textContent)); ok('tampered file is detected'); await shot('5-files');

  await page.click('[data-view=users]'); await page.waitForSelector('#users-table [data-signout]'); ok('users screen loads');
  await page.click('[data-view=backups]'); await page.waitForSelector('#backups-table [data-verify]');
  assert.equal(await page.locator('#backups-table [data-restore]').count(), 0); ok('restore is hidden on a remote connection');
  await page.click('#backups-table [data-verify]'); await page.waitForFunction(() => /Backup verification completed/.test(document.querySelector('#notice').textContent)); ok('backup verified through the server API');

  await page.click('[data-view=settings]'); await page.waitForFunction(() => document.querySelector('#config-form [name=keepBackups]').value !== '');
  assert.ok(/immediately/.test(await page.textContent('#config-note')));
  await page.fill('#config-form [name=keepBackups]', '12'); await page.click('#config-form button[type=submit]');
  await page.waitForFunction(() => /saved and applied/.test(document.querySelector('#notice').textContent)); ok('settings saved and applied live'); await shot('6-config');
  assert.equal(await page.locator('#renew-cert').isVisible(), false);

  await page.click('[data-view=logs]'); await page.waitForFunction(() => /server started|backup ok/.test(document.querySelector('#log-output').textContent)); ok('live server log feed');
  await page.click('[data-view=audit]'); await page.waitForSelector('#audit-table .pill'); ok('audit log loads');

  await page.click('[data-view=overview]'); page.once('dialog', d => d.accept()); await page.click('[data-service=restart]');
  await page.waitForFunction(() => /Restart requested/.test(document.querySelector('#notice').textContent), null, { timeout: 8000 }); await new Promise(r => setTimeout(r, 800)); assert.equal(restarts, 1); ok('restart requested from the dashboard (no elevation needed)');
  assert.equal(await page.locator('[data-service=stop]').isVisible(), false); ok('start/stop hidden for remote connections');

  // session killed on the server -> the dashboard notices and asks to sign in again
  srv.db.prepare("DELETE FROM sessions WHERE device LIKE '%dashboard%'").run();
  await page.click('#refresh'); await page.waitForSelector('#login-modal:not([hidden])', { timeout: 8000 }); ok('lost session -> sign-in dialog instead of an error loop'); await shot('7-session-lost');
  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  ok('no script or console errors');
  await browser.close(); await srv.stop(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${n} passed, 0 failed`);
})().catch(e => { console.error('FAILED:', e.stack || e); process.exit(1); });
