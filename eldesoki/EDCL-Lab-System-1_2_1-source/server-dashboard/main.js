'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
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
const SESSION = { token: null, user: null };
let window;

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

function serverAddress() {
  const cfg = readJson(CLIENT_CONFIG);
  const url = new URL(cfg.serverUrl);
  if (url.protocol !== 'https:') throw new Error('The server dashboard requires HTTPS');
  return url;
}

function apiRequest(method, apiPath, body) {
  if (!/^\/api\/[a-z0-9/?=&._-]+$/i.test(apiPath)) return Promise.reject(new Error('Invalid server API path'));
  let url;
  let ca;
  try {
    url = new URL(apiPath, serverAddress());
    ca = fs.readFileSync(CA_FILE);
  } catch (error) {
    return Promise.reject(error);
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
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Server request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

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

function safeBackupPath(file) {
  const config = readJson(CONFIG_FILE);
  const backupDir = path.resolve(config.backupDir || path.join(config.dataDir, 'backups'));
  const candidate = path.resolve(backupDir, path.basename(String(file || '')));
  if (path.dirname(candidate) !== backupDir || !/^edcl-.*\.sqlite$/.test(path.basename(candidate)))
    throw new Error('Invalid backup file');
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error('Backup file not found');
  return { config, backupDir, candidate };
}

function latestLogs() {
  if (!fs.existsSync(LOG_DIR)) return { file: '', lines: [] };
  const file = fs.readdirSync(LOG_DIR)
    .filter(name => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort().at(-1);
  if (!file) return { file: '', lines: [] };
  const filePath = path.join(LOG_DIR, file);
  const size = fs.statSync(filePath).size;
  const length = Math.min(size, 512 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  let bytesRead;
  try { bytesRead = fs.readSync(fd, buffer, 0, length, size - length); }
  finally { fs.closeSync(fd); }
  const contents = buffer.toString('utf8', 0, bytesRead);
  return { file, lines: contents.split(/\r?\n/).slice(-500) };
}

function updateConfig(changes) {
  const config = readJson(CONFIG_FILE);
  const next = { ...config };
  for (const key of ['backupMinutes', 'keepBackups', 'wadaHours', 'maxFileMB']) {
    if (changes[key] === undefined) continue;
    const value = Number(changes[key]);
    const ranges = { backupMinutes: [0, 1440], keepBackups: [1, 365], wadaHours: [0, 168], maxFileMB: [1, 1000] };
    if (!Number.isInteger(value) || value < ranges[key][0] || value > ranges[key][1])
      throw new Error(`Invalid ${key} value`);
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

ipcMain.handle('dashboard:health', async event => {
  assertSender(event);
  const service = process.platform === 'win32'
    ? await control('status').catch(error => ({ code: 1, stderr: error.message, stdout: '' }))
    : { code: 1, stderr: 'Service status is available on Windows only', stdout: '' };
  try {
    const response = await apiRequest('GET', '/api/health');
    return { connected: response.status === 200 && response.json.ok, health: response.json, service };
  } catch (error) {
    return { connected: false, error: error.message, service };
  }
});

ipcMain.handle('dashboard:login', async (event, credentials = {}) => {
  assertSender(event);
  const previous = SESSION.token;
  SESSION.token = null;
  const response = await apiRequest('POST', '/api/login', {
    username: String(credentials.username || ''),
    password: String(credentials.password || ''),
    device: require('os').hostname()
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
  } finally {
    SESSION.token = null;
    SESSION.user = null;
  }
  return true;
});

ipcMain.handle('dashboard:request', async (event, request = {}) => {
  assertSender(event);
  requireLogin();
  const method = String(request.method || 'GET').toUpperCase();
  const apiPath = String(request.path || '');
  const allowed =
    (method === 'GET' && ['/api/me', '/api/admin/status', '/api/admin/users', '/api/admin/roles', '/api/admin/audit'].includes(apiPath)) ||
    (method === 'POST' && ['/api/admin/backup', '/api/admin/users'].includes(apiPath)) ||
    (method === 'POST' && /^\/api\/admin\/users\/[a-z0-9._-]+\/(reset|role|active)$/.test(apiPath));
  if (!allowed) throw new Error('This dashboard request is not allowed');
  if (apiPath === '/api/admin/users' || apiPath === '/api/admin/roles' || apiPath === '/api/admin/audit' ||
      /^\/api\/admin\/users\//.test(apiPath)) requireLogin(['users']);
  if (apiPath === '/api/admin/backup') requireLogin(['backup']);
  if (apiPath === '/api/admin/status') requireLogin(['backup', 'users']);
  return apiRequest(method, apiPath, request.json);
});

ipcMain.handle('dashboard:service', async (event, action) => {
  assertSender(event);
  requireOwner();
  return control(String(action || ''));
});

ipcMain.handle('dashboard:config:get', event => {
  assertSender(event);
  requireOwner();
  const c = readJson(CONFIG_FILE);
  return {
    serverName: c.serverName || 'EDCL Server',
    host: c.host || '0.0.0.0',
    port: c.port,
    dataDir: c.dataDir,
    backupDir: c.backupDir || path.join(c.dataDir, 'backups'),
    backupMinutes: c.backupMinutes ?? 30,
    keepBackups: c.keepBackups ?? 30,
    wadaHours: c.wadaHours ?? 6,
    maxFileMB: c.maxFileMB ?? 300
  };
});

ipcMain.handle('dashboard:config:save', (event, changes = {}) => {
  assertSender(event);
  requireOwner();
  return updateConfig(changes);
});

ipcMain.handle('dashboard:certificates', event => {
  assertSender(event);
  requireOwner();
  return readJson(CERT_INFO);
});

ipcMain.handle('dashboard:certificates:renew', async event => {
  assertSender(event);
  requireOwner();
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
  const service = await control('restart');
  return { renewal, service };
});

ipcMain.handle('dashboard:logs', event => {
  assertSender(event);
  requireOwner();
  return latestLogs();
});

ipcMain.handle('dashboard:backups', event => {
  assertSender(event);
  requireLogin(['backup', 'recover']);
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
  const { candidate } = safeBackupPath(name);
  if (process.platform !== 'win32') throw new Error('Backup verification is available on Windows only');
  return run(NODE_EXE, ['--no-warnings', CLI_FILE, 'verify-backup', candidate]);
});

ipcMain.handle('dashboard:backup:restore', async (event, name) => {
  assertSender(event);
  requireOwner();
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
  const error = await shell.openPath(path.join(SERVER_DATA, 'client-config'));
  if (error) throw new Error(error);
  return true;
});

function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 860,
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
