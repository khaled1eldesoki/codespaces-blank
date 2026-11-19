'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PROGRAM_DATA = process.env.ProgramData || 'C:\\ProgramData';
const SERVER_DATA = path.join(PROGRAM_DATA, 'EDCL Server');
const CONFIG_FILE = path.join(SERVER_DATA, 'server.json');
const CLIENT_CONFIG = path.join(SERVER_DATA, 'client-config', 'server.json');
const CA_FILE = path.join(SERVER_DATA, 'client-config', 'ca.crt');
const CERT_INFO = path.join(SERVER_DATA, 'certs', 'cert-info.json');
const CERT_DIR = path.join(SERVER_DATA, 'certs');
const SERVER_ROOT = path.resolve(app.getAppPath(), '..');
const CONTROL_FILE = path.join(SERVER_ROOT, 'edcl-server-ctl.cmd');
const NODE_EXE = path.join(SERVER_ROOT, 'node.exe');
const CLI_FILE = path.join(SERVER_ROOT, 'server', 'cli.js');
const LOG_DIR = path.join(SERVER_DATA, 'logs');
const DASHBOARD_FILE = path.join(__dirname, 'index.html');
const USER_DIR = app.getPath('userData');
const PROFILE_FILE = path.join(USER_DIR, 'connection.json');
const REMOTE_CA = path.join(USER_DIR, 'remote-ca.crt');
const SESSION = { token: null, user: null };
let window;
let pendingCa = null;                       // a CA certificate chosen in the connection dialog, not yet saved

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const assertSender = event => {
  if (event.senderFrame.url !== require('url').pathToFileURL(DASHBOARD_FILE).href)
    throw new Error('Blocked dashboard IPC sender');
};
const requireLogin = (perms = []) => {
  if (!SESSION.token || !SESSION.user) throw new Error('Sign in to the server first');
  if (SESSION.user.mustChange) throw new Error('Change the one-time password before continuing');
  if (perms.length && !perms.some(p => SESSION.user.perms && SESSION.user.perms[p]))
    throw new Error('Your server account is not permitted to perform this action');
  return SESSION.user;
};
const requireOwner = () => {
  const user = requireLogin();
  if (user.role !== 'admin') throw new Error('Only a server administrator can perform this action');
  return user;
};

// ---------------------------------------------------------------- connection (this PC or another PC)
const localAvailable = () => fs.existsSync(CLIENT_CONFIG) && fs.existsSync(CA_FILE);
function loadProfile() {
  try {
    const p = readJson(PROFILE_FILE);
    if (p.mode === 'remote' && p.serverUrl && fs.existsSync(REMOTE_CA)) return { mode: 'remote', serverUrl: p.serverUrl };
    if (p.mode === 'local' && localAvailable()) return { mode: 'local', serverUrl: '' };
  } catch { /* first start */ }
  return { mode: localAvailable() ? 'local' : 'remote', serverUrl: '' };
}
let profile = loadProfile();
const isLocal = () => profile.mode === 'local';

function parseServerUrl(text) {
  let url;
  try { url = new URL(String(text || '').trim()); } catch { throw new Error('Enter the server address, for example https://edcl-server:8443'); }
  if (url.protocol !== 'https:') throw new Error('The server address must start with https://');
  if (url.username || url.password) throw new Error('The server address must not contain a user name or password');
  return url;
}
function target() {
  if (isLocal()) {
    const cfg = readJson(CLIENT_CONFIG);
    const url = parseServerUrl(cfg.serverUrl);
    return { url, ca: fs.readFileSync(CA_FILE) };
  }
  if (!profile.serverUrl) throw new Error('NOT_CONFIGURED');
  return { url: parseServerUrl(profile.serverUrl), ca: fs.readFileSync(REMOTE_CA) };
}
function certSummary(pem) {
  const x = new crypto.X509Certificate(pem);
  return { fingerprint: x.fingerprint256, subject: x.subject.replace(/\n/g, ', '), validTo: new Date(x.validTo).toISOString(), isCa: !!x.ca };
}

// ---------------------------------------------------------------- server API
function apiRequest(method, apiPath, body) {
  if (!/^\/api\/[a-z0-9/?=&._%+-]+$/i.test(apiPath)) return Promise.reject(new Error('Invalid server API path'));
  let url;
  let ca;
  try {
    const t = target();
    url = new URL(apiPath, t.url);
    ca = t.ca;
  } catch (error) {
    return Promise.reject(error.message === 'NOT_CONFIGURED' ? new Error('No server is configured yet. Use "Server connection" to choose one.') : error);
  }
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      ca,
      headers: {
        ...(SESSION.token ? { Authorization: `Bearer ${SESSION.token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
      },
      timeout: 60000
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          req.destroy(new Error('Server response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new Error(`Server returned invalid JSON (HTTP ${res.statusCode})`)); return; }
        if (res.statusCode === 401 && SESSION.token && apiPath !== '/api/login') { SESSION.token = null; SESSION.user = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Server request timed out')));
    req.on('error', error => {
      const text = String(error.code || '');
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/i.test(text)) reject(new Error(`The server certificate was rejected (${text}). Check the CA certificate and that the address matches the certificate.`));
      else if (text === 'ECONNREFUSED') reject(new Error('The server refused the connection (is it running?)'));
      else if (text === 'ENOTFOUND') reject(new Error('The server name could not be found. Check the address.'));
      else reject(error);
    });
    if (payload) req.write(payload);
    req.end();
  });
}
const apiOk = async (method, apiPath, body) => {
  const r = await apiRequest(method, apiPath, body);
  if (r.status < 200 || r.status >= 300) throw new Error(r.json && r.json.error || `Server request failed (HTTP ${r.status})`);
  return r.json;
};

function run(file, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const result = { code: error ? error.code ?? 1 : 0, stdout: stdout.trim(), stderr: stderr.trim() };
      if (error && !error.code) reject(error);
      else resolve(result);
    });
  });
}

function control(action) {
  if (process.platform !== 'win32') throw new Error('Server service controls are available on Windows only');
  if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('Unsupported server control action');
  return run('cmd.exe', ['/d', '/c', 'call', CONTROL_FILE, action], 180000);
}
const isElevated = () => process.platform !== 'win32' ? Promise.resolve(false) : run('net', ['session'], 8000).then(r => Number(r.code) === 0, () => false);

function safeBackupPath(file) {
  const config = readJson(CONFIG_FILE);
  const backupDir = path.resolve(config.backupDir || path.join(config.dataDir, 'backups'));
  const candidate = path.resolve(backupDir, path.basename(String(file || '')));
  if (path.dirname(candidate) !== backupDir || !/^edcl-.*\.sqlite$/.test(path.basename(candidate)))
    throw new Error('Invalid backup file');
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error('Backup file not found');
  return { config, backupDir, candidate };
}

function readTail(filePath) {
  const size = fs.statSync(filePath).size;
  const length = Math.min(size, 512 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  let bytesRead;
  try { bytesRead = fs.readSync(fd, buffer, 0, length, size - length); }
  finally { fs.closeSync(fd); }
  return buffer.toString('utf8', 0, bytesRead).split(/\r?\n/).slice(-500);
}
function latestLogs() {
  if (!fs.existsSync(LOG_DIR)) return null;
  const file = fs.readdirSync(LOG_DIR).filter(name => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort().at(-1);
  return file ? { file, lines: readTail(path.join(LOG_DIR, file)) } : null;
}

const RANGES = { backupMinutes: [0, 1440], keepBackups: [1, 365], wadaHours: [0, 168], maxFileMB: [1, 1000] };
function updateConfigFile(changes) {
  const config = readJson(CONFIG_FILE);
  const next = { ...config };
  for (const key of Object.keys(RANGES)) {
    if (changes[key] === undefined || changes[key] === '') continue;
    const value = Number(changes[key]);
    if (!Number.isInteger(value) || value < RANGES[key][0] || value > RANGES[key][1]) throw new Error(`Invalid ${key} value`);
    next[key] = value;
  }
  if (changes.serverName !== undefined) {
    const name = String(changes.serverName).trim();
    if (!name || name.length > 80 || /[\r\n]/.test(name)) throw new Error('Invalid server name');
    next.serverName = name;
  }
  if (changes.backupDir !== undefined) {
    const dir = String(changes.backupDir).trim();
    if (!dir || dir.length > 400) throw new Error('Invalid backup folder');
    const resolved = path.resolve(dir);
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
    next.backupDir = resolved.replace(/\\/g, '/');
  }
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  return next;
}
const configView = c => ({
  serverName: c.serverName || 'EDCL Server', host: c.host || '0.0.0.0', port: c.port, dataDir: c.dataDir,
  backupDir: c.backupDir || path.join(c.dataDir, 'backups'), backupMinutes: c.backupMinutes ?? 30, keepBackups: c.keepBackups ?? 30,
  wadaHours: c.wadaHours ?? 6, maxFileMB: c.maxFileMB ?? 300
});

// ---------------------------------------------------------------- requests the renderer may make
const ROUTES = [
  ['GET', /^\/api\/me$/, []],
  ['GET', /^\/api\/admin\/status$/, ['backup', 'users']],
  ['GET', /^\/api\/admin\/metrics$/, ['backup', 'users']],
  ['GET', /^\/api\/admin\/(users|roles|sessions)$/, ['users']],
  ['GET', /^\/api\/admin\/audit$/, ['audit']],
  ['GET', /^\/api\/admin\/files(\/verify)?$/, ['users']],
  ['POST', /^\/api\/admin\/files\/verify$/, ['users']],
  ['POST', /^\/api\/admin\/backup$/, ['backup']],
  ['POST', /^\/api\/admin\/users$/, ['users']],
  ['POST', /^\/api\/admin\/users\/[a-z0-9._-]+\/(reset|role|active|signout)$/, ['users']],
  ['POST', /^\/api\/admin\/sessions\/revoke$/, ['users']]
];
const QUERY_KEYS = ['cat', 'q', 'deleted', 'limit', 'offset'];

ipcMain.handle('dashboard:request', async (event, request = {}) => {
  assertSender(event);
  requireLogin();
  const method = String(request.method || 'GET').toUpperCase();
  const [base, query = ''] = String(request.path || '').split('?');
  const route = ROUTES.find(([m, re]) => m === method && re.test(base));
  if (!route) throw new Error('This dashboard request is not allowed');
  if (route[2].length) requireLogin(route[2]);
  let apiPath = base;
  if (query) {
    const out = new URLSearchParams();
    for (const [k, v] of new URLSearchParams(query)) if (QUERY_KEYS.includes(k)) out.set(k, v.slice(0, 80));
    const text = out.toString();
    if (text) apiPath += '?' + text;
  }
  return apiRequest(method, apiPath, request.json);
});

// ---------------------------------------------------------------- connection
ipcMain.handle('dashboard:connection:get', event => {
  assertSender(event);
  let serverUrl = '';
  let fingerprint = '';
  try { serverUrl = target().url.origin; fingerprint = certSummary(target().ca).fingerprint; } catch { /* not configured */ }
  return { mode: profile.mode, localAvailable: localAvailable(), serverUrl, fingerprint, platform: process.platform };
});
ipcMain.handle('dashboard:connection:choose-ca', async event => {
  assertSender(event);
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose the lab CA certificate (ca.crt from the server\'s client-config folder)',
    properties: ['openFile'], filters: [{ name: 'Certificate', extensions: ['crt', 'cer', 'pem'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const pem = fs.readFileSync(result.filePaths[0]);
  if (pem.length > 64 * 1024) throw new Error('That file is not a certificate');
  let info;
  try { info = certSummary(pem); } catch { throw new Error('That file is not a valid PEM certificate'); }
  pendingCa = pem;
  return info;
});
ipcMain.handle('dashboard:connection:save', async (event, input = {}) => {
  assertSender(event);
  if (input.mode === 'local') {
    if (!localAvailable()) throw new Error('This PC has no EDCL server installed');
    profile = { mode: 'local', serverUrl: '' };
  } else {
    const url = parseServerUrl(input.serverUrl);
    if (!pendingCa && !fs.existsSync(REMOTE_CA)) throw new Error('Choose the CA certificate (ca.crt) first');
    profile = { mode: 'remote', serverUrl: url.origin };
  }
  const previous = fs.existsSync(REMOTE_CA) ? fs.readFileSync(REMOTE_CA) : null;
  if (profile.mode === 'remote' && pendingCa) fs.writeFileSync(REMOTE_CA, pendingCa);
  // prove the new settings work before keeping them
  SESSION.token = null; SESSION.user = null;
  try {
    const r = await apiRequest('GET', '/api/info');
    if (r.status !== 200 || !r.json.ok) throw new Error('That address did not answer like an EDCL server');
  } catch (error) {
    if (profile.mode === 'remote') { if (previous) fs.writeFileSync(REMOTE_CA, previous); else if (pendingCa) fs.rmSync(REMOTE_CA, { force: true }); }
    profile = loadProfile();
    throw error;
  }
  pendingCa = null;
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile));
  svcCache = { at: 0, value: null };
  return { mode: profile.mode, serverUrl: profile.serverUrl };
});

// ---------------------------------------------------------------- health / service
let svcCache = { at: 0, value: null };
async function serviceStatus(force) {
  if (!isLocal() || process.platform !== 'win32') return { code: 1, stderr: isLocal() ? 'Service status is available on Windows only' : 'Service control is local to the server PC', stdout: '', remote: !isLocal() };
  if (!force && svcCache.value && Date.now() - svcCache.at < 30000) return svcCache.value;
  const value = await control('status').catch(error => ({ code: 1, stderr: error.message, stdout: '' }));
  svcCache = { at: Date.now(), value };
  return value;
}
ipcMain.handle('dashboard:health', async (event, options = {}) => {
  assertSender(event);
  const service = await serviceStatus(!!options.force);
  try {
    const response = await apiRequest('GET', '/api/health');
    return { connected: response.status === 200 && response.json.ok, health: response.json, service, mode: profile.mode, sessionActive: !!SESSION.token };
  } catch (error) {
    return { connected: false, error: error.message, service, mode: profile.mode, sessionActive: !!SESSION.token, notConfigured: /No server is configured/.test(error.message) };
  }
});

ipcMain.handle('dashboard:login', async (event, credentials = {}) => {
  assertSender(event);
  const previous = SESSION.token;
  SESSION.token = null;
  const response = await apiRequest('POST', '/api/login', {
    username: String(credentials.username || ''),
    password: String(credentials.password || ''),
    device: require('os').hostname() + ' (dashboard)'
  });
  if (response.status !== 200 || !response.json.token) {
    SESSION.token = previous;
    return response;
  }
  SESSION.token = response.json.token;
  SESSION.user = { ...response.json.user, mustChange: !!response.json.mustChange };
  const { token, ...publicResponse } = response.json;
  return { status: response.status, json: publicResponse };
});

ipcMain.handle('dashboard:change-password', async (event, credentials = {}) => {
  assertSender(event);
  if (!SESSION.token || !SESSION.user) throw new Error('Sign in to the server first');
  const response = await apiRequest('POST', '/api/password', {
    oldPassword: String(credentials.oldPassword || ''),
    newPassword: String(credentials.newPassword || '')
  });
  if (response.status === 200) SESSION.user.mustChange = false;
  return response;
});

ipcMain.handle('dashboard:logout', async event => {
  assertSender(event);
  try {
    if (SESSION.token) await apiRequest('POST', '/api/logout', {});
  } catch { /* the server may already be gone */ } finally {
    SESSION.token = null;
    SESSION.user = null;
  }
  return true;
});

ipcMain.handle('dashboard:service', async (event, action) => {
  assertSender(event);
  requireOwner();
  action = String(action || '');
  svcCache = { at: 0, value: null };
  if (action === 'restart') {
    // a running server restarts itself on request (no Windows elevation needed); its runner script starts it again
    try { await apiOk('POST', '/api/admin/restart', {}); return { code: 0, stdout: 'Restart requested. The server is back in about 15 seconds.', stderr: '' }; }
    catch (error) { if (!isLocal()) throw error; }
  }
  if (!isLocal()) throw new Error('Start and stop are available on the server PC only');
  return control(action);
});

// ---------------------------------------------------------------- first-run setup and recovery
ipcMain.handle('dashboard:setup:state', async event => {
  assertSender(event);
  try { const r = await apiRequest('GET', '/api/setup/state'); return r.status === 200 ? r.json : { error: 'unavailable' }; }
  catch (error) { return { error: error.message }; }
});
ipcMain.handle('dashboard:setup:owner', async (event, input = {}) => {
  assertSender(event);
  return apiRequest('POST', '/api/setup/owner', { username: String(input.username || ''), name: String(input.name || ''), password: String(input.password || '') });
});
ipcMain.handle('dashboard:recover-owner', async (event, input = {}) => {
  assertSender(event);
  if (!isLocal()) throw new Error('Password recovery is available on the server PC only');
  if (process.platform !== 'win32') throw new Error('Password recovery is available on Windows only');
  if (!(await isElevated())) throw new Error('Close the dashboard and open it again with "Run as administrator" to reset a password this way.');
  const username = String(input.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(username)) throw new Error('Enter a valid user name');
  const result = await run(NODE_EXE, ['--no-warnings', CLI_FILE, 'reset-password', username, '--config', CONFIG_FILE]);
  const match = /One-time password for "[^"]*": (\S+)/.exec(result.stdout);
  if (Number(result.code) !== 0 || !match) throw new Error(result.stderr || result.stdout || 'The password could not be reset (does that user exist?)');
  return { username, password: match[1] };
});

// ---------------------------------------------------------------- configuration, certificates, logs
ipcMain.handle('dashboard:config:get', async event => {
  assertSender(event);
  requireOwner();
  try { return { ...(await apiOk('GET', '/api/admin/config')), live: true }; }
  catch (error) { if (!isLocal()) throw error; }
  return { ...configView(readJson(CONFIG_FILE)), live: false };
});
ipcMain.handle('dashboard:config:save', async (event, changes = {}) => {
  assertSender(event);
  requireOwner();
  try { await apiOk('POST', '/api/admin/config', changes); return { live: true }; }
  catch (error) { if (!isLocal() || /Invalid|folder|administrator/i.test(error.message)) throw error; }
  updateConfigFile(changes);
  return { live: false };
});
ipcMain.handle('dashboard:certificates', event => {
  assertSender(event);
  requireOwner();
  if (!isLocal()) throw new Error('Certificate details are shown from the server metrics when connected remotely');
  return readJson(CERT_INFO);
});
ipcMain.handle('dashboard:certificates:renew', async event => {
  assertSender(event);
  requireOwner();
  if (!isLocal()) throw new Error('Certificate renewal is available on the server PC only');
  if (process.platform !== 'win32') throw new Error('Certificate renewal is available on Windows only');
  const info = readJson(CERT_INFO);
  const clientConfig = readJson(CLIENT_CONFIG);
  const url = new URL(clientConfig.serverUrl);
  if (url.protocol !== 'https:') throw new Error('The configured server address must use HTTPS');
  const names = Array.isArray(info.dns) ? info.dns.filter(name => typeof name === 'string' && /^[a-z0-9.-]{1,253}$/i.test(name)) : [];
  const ips = Array.isArray(info.ip) ? info.ip.filter(ip => typeof ip === 'string' && /^[0-9a-f:.]{2,45}$/i.test(ip)) : [];
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!names.some(name => name.toLowerCase() === host) && !ips.some(ip => ip.toLowerCase() === host))
    throw new Error('The configured server address is not present in the current certificate names. Contact an administrator before renewal.');
  const args = ['--no-warnings', CLI_FILE, 'make-certs', '--out', CERT_DIR, '--renew'];
  for (const name of names) args.push('--name', name);
  for (const ip of ips) args.push('--ip', ip);
  args.push('--url', url.origin);
  const renewal = await run(NODE_EXE, args, 180000);
  if (Number(renewal.code) !== 0) return { renewal, service: null };
  SESSION.token = null;
  SESSION.user = null;
  svcCache = { at: 0, value: null };
  const service = await control('restart');
  return { renewal, service };
});

ipcMain.handle('dashboard:logs', async event => {
  assertSender(event);
  requireOwner();
  if (isLocal()) {
    const local = latestLogs();
    if (local) return { ...local, source: 'file' };
  }
  const feed = await apiOk('GET', '/api/admin/logs?limit=500');
  return { file: 'Live server activity since ' + new Date(feed.startedAt).toLocaleString(), lines: feed.lines.map(l => `${l.t} ${l.level === 'info' ? '' : l.level + ' '}${l.msg}`), source: 'feed' };
});

// ---------------------------------------------------------------- backups
ipcMain.handle('dashboard:backups', async event => {
  assertSender(event);
  requireLogin(['backup', 'recover']);
  try { return (await apiOk('GET', '/api/admin/backups')).backups; }
  catch (error) { if (!isLocal()) throw error; }
  const config = readJson(CONFIG_FILE);
  const dir = path.resolve(config.backupDir || path.join(config.dataDir, 'backups'));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^edcl-.*\.sqlite$/.test(name))
    .map(name => {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      return stat.isFile() ? { file: name, size: stat.size, modified: stat.mtime.toISOString() } : null;
    })
    .filter(Boolean).sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, 100);
});

ipcMain.handle('dashboard:backup:verify', async (event, name) => {
  assertSender(event);
  requireLogin(['recover', 'backup']);
  try {
    const result = await apiOk('POST', '/api/admin/backups/verify', { file: String(name || '') });
    return { code: result.integrity === 'ok' ? 0 : 1, stdout: JSON.stringify(result, null, 1), stderr: '' };
  } catch (error) {
    if (!isLocal() || process.platform !== 'win32') throw error;
  }
  const { candidate } = safeBackupPath(name);
  return run(NODE_EXE, ['--no-warnings', CLI_FILE, 'verify-backup', candidate]);
});

ipcMain.handle('dashboard:backup:restore', async (event, name) => {
  assertSender(event);
  requireOwner();
  if (!isLocal()) throw new Error('Restore must be done on the server PC');
  const { candidate } = safeBackupPath(name);
  if (process.platform !== 'win32') throw new Error('Backup restore is available on Windows only');
  const result = await run(NODE_EXE, ['--no-warnings', CLI_FILE, 'restore', candidate, '--config', CONFIG_FILE], 300000);
  if ([0, 3].includes(Number(result.code))) {
    SESSION.token = null;
    SESSION.user = null;
  }
  return result;
});

ipcMain.handle('dashboard:backup:import', async event => {
  assertSender(event);
  requireOwner();
  if (!isLocal()) throw new Error('Import must be done on the server PC');
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose an EDCL backup JSON file',
    properties: ['openFile'],
    filters: [{ name: 'EDCL backup', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  if (process.platform !== 'win32') throw new Error('Backup import is available on Windows only');
  return run(NODE_EXE, ['--no-warnings', CLI_FILE, 'import', result.filePaths[0], '--config', CONFIG_FILE], 300000);
});

ipcMain.handle('dashboard:open-client-config', async event => {
  assertSender(event);
  requireOwner();
  if (!isLocal()) throw new Error('The client connection package is on the server PC');
  const error = await shell.openPath(path.join(SERVER_DATA, 'client-config'));
  if (error) throw new Error(error);
  return true;
});

function createWindow() {
  window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 680,
    title: 'EDCL Server Dashboard',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== require('url').pathToFileURL(DASHBOARD_FILE).href) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadFile(DASHBOARD_FILE);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
