const { app, BrowserWindow, Menu, shell, protocol, net, session, dialog, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const sqliteService = require('./sqlite-service');
const wadaMonitor = require('./wada-monitor');
const backupService = require('./backup-service');

app.setAppUserModelId('eg.edcl.labsystem');
// Fixed data folder so the database survives updates/re-installs: %APPDATA%\EDCL Lab System
app.setPath('userData', path.join(app.getPath('appData'), 'EDCL Lab System'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

const APP_DIR = path.join(__dirname, 'app');
const ICON = path.join(__dirname, 'build', 'icon.ico');
const STATE = path.join(app.getPath('userData'), 'window-state.json');
let win = null;

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = () => {
  if (!win || win.isDestroyed()) return;
  const s = { maximized: win.isMaximized(), ...(win.isMaximized() ? loadState() : win.getBounds()) };
  s.maximized = win.isMaximized();
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); } catch {}
};

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width || 1366, height: st.height || 860, x: st.x, y: st.y,
    minWidth: 1024, minHeight: 680,
    title: 'EDCL Lab System', icon: ICON, backgroundColor: '#e9f6ef', show: false,
    autoHideMenuBar: true,
    // dark-green window frame (Windows): title-bar overlay + border colour; the page draws the green bar (see edTb in index.html)
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0a4d33', symbolColor: '#ffffff', height: 36 }, accentColor: '#0a4d33' } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: true }
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => { win.show(); win.focus(); win.webContents.focus(); });
  win.webContents.on('did-finish-load', () => { win.focus(); win.webContents.focus(); });
  win.on('close', saveState);
  win.on('closed', () => { win = null; });
  // v1.0.11: let the page save an automatic backup before the window really closes
  let closeOk = false, closeTimer = null;
  win.on('close', ev => {
    if (closeOk || win.webContents.isDestroyed() || win.webContents.isLoading()) return;
    ev.preventDefault();
    if (closeTimer) return;
    win.webContents.send('app:before-close');
    closeTimer = setTimeout(() => { closeOk = true; try { win.close(); } catch {} }, 150000);
  });
  ipcMain.once('app:close-done', () => { closeOk = true; if (closeTimer) clearTimeout(closeTimer); try { win.close(); } catch {} });
  win.on('page-title-updated', e => e.preventDefault());   // keep window title "EDCL Lab System"
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // blob: = uploaded certificates / PDFs the app previews; open them in a plain viewer window
    if (url.startsWith('blob:') || url.startsWith('app://')) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: { sandbox: true } } };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code !== -3) dialog.showErrorBox('EDCL Lab System', 'The application could not be loaded.\n' + desc);
  });
  win.loadURL('app://edcl/index.html');
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
    { label: 'Help', submenu: [
      { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
      { label: 'About EDCL Lab System', click: () => dialog.showMessageBox({ type: 'info', title: 'About', message: 'EDCL Lab System', detail: 'Version ' + app.getVersion() + '\nEgyptian Doping Control Laboratory – Quality & Competency System\n\nData folder: ' + app.getPath('userData'), icon: undefined }) }
    ] }
  ]));
}

// Windows/Electron: after alert()/confirm() text boxes can stay frozen until the window is re-focused
ipcMain.on('refocus', e => { const w = BrowserWindow.fromWebContents(e.sender); if (w && !w.isDestroyed()) { w.focus(); e.sender.focus(); } });
const assertAppSender = e => { const u = e.sender.getURL(); if (!u.startsWith('app://')) throw new Error('Blocked IPC sender'); };
const managedSqlite = name => { const base = path.basename(String(name || '')); if (!sqliteService.ALLOWED_EXT.has(path.extname(base).toLowerCase())) throw new Error('Invalid managed SQLite name'); const file = path.join(sqliteService.ensureDir(app.getPath('userData')), base); if (!fs.existsSync(file)) throw new Error('Managed SQLite database not found'); return file; };
ipcMain.handle('sqlite:list', e => { assertAppSender(e); return sqliteService.list(app.getPath('userData')); });
ipcMain.handle('sqlite:import', async (e) => { assertAppSender(e); const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['sqlite','sqlite3','db'] }] }); if (r.canceled || !r.filePaths[0]) return { canceled: true }; return sqliteService.importFile(app.getPath('userData'), r.filePaths[0]); });
ipcMain.handle('sqlite:inspect', (e, name) => { assertAppSender(e); return sqliteService.inspect(managedSqlite(name)); });
ipcMain.handle('sqlite:read', (e, args = {}) => { assertAppSender(e); return sqliteService.read(managedSqlite(args.name), args.sql, args.params); });
ipcMain.handle('sqlite:write', (e, args = {}) => { assertAppSender(e); if (args.authorized !== true) throw new Error('SQLite write requires an authorized application session'); return sqliteService.write(managedSqlite(args.name), args.sql, args.params); });
ipcMain.handle('sqlite:export', async (e, name) => { assertAppSender(e); const source = managedSqlite(name); const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: path.basename(source), filters: [{ name: 'SQLite database', extensions: ['sqlite','sqlite3','db'] }] }); if (r.canceled || !r.filePath) return { canceled: true }; fs.copyFileSync(source, r.filePath, fs.constants.COPYFILE_EXCL); return { path: r.filePath, size: fs.statSync(r.filePath).size }; });

// ---- v1.2.0: central LAN server connection (all network access to the server happens HERE, never in the page) ----
const crypto = require('crypto');
const SERVER_CERTS = require('./server/certs-verify');
const CENTRAL = { cfg: null, token: null, ca: null, sse: null, sseAbort: null };
const centralCfgFiles = () => [path.join(app.getPath('userData'), 'central.json'), path.join(process.env.ProgramData || 'C:\\ProgramData', 'EDCL Lab System', 'client', 'server.json')];
function loadCentral() {
  for (const f of centralCfgFiles()) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (!j.serverUrl) continue;
      const u = new URL(j.serverUrl); if (u.protocol !== 'https:' && !j.allowHttp) throw new Error('Only https:// server addresses are allowed');
      let ca = null; const caFile = path.join(path.dirname(f), 'ca.crt'); try { ca = fs.readFileSync(caFile, 'utf8'); } catch {}
      CENTRAL.cfg = { serverUrl: u.origin, host: u.hostname, source: f, caFingerprint: j.caFingerprint || '' }; CENTRAL.ca = ca; return CENTRAL.cfg;
    } catch (e) { CENTRAL.error = f + ': ' + e.message; }
  }
  CENTRAL.cfg = null; return null;
}
loadCentral();
app.whenReady().then(() => {
  // Trust ONLY certificates issued by the laboratory CA, and only for the configured server host. Everything else uses normal Windows/Chromium validation.
  session.defaultSession.setCertificateVerifyProc((req, cb) => {
    try { if (CENTRAL.cfg && CENTRAL.ca && req.hostname === CENTRAL.cfg.host && SERVER_CERTS.verifyChain(req.certificate.data, CENTRAL.ca)) return cb(0); } catch (e) {}
    cb(-3);
  });
});
const central = async (method, p, { json, bytes, raw } = {}) => {
  if (!CENTRAL.cfg) throw new Error('No server configured');
  if (typeof p !== 'string' || !p.startsWith('/api/')) throw new Error('Blocked path');
  const headers = {}; if (CENTRAL.token) headers.Authorization = 'Bearer ' + CENTRAL.token;
  let body; if (bytes) { headers['Content-Type'] = 'application/octet-stream'; body = Buffer.from(bytes); } else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await net.fetch(CENTRAL.cfg.serverUrl + p, { method, headers, body, signal: AbortSignal.timeout(raw ? 600000 : 60000) });
  if (raw) return { status: res.status, bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null };
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, json: j };
};
ipcMain.handle('central:config', e => { assertAppSender(e); return { configured: !!CENTRAL.cfg, serverUrl: CENTRAL.cfg && CENTRAL.cfg.serverUrl, hasCa: !!CENTRAL.ca, error: CENTRAL.error || '' }; });
ipcMain.handle('central:setServer', (e, a = {}) => {
  assertAppSender(e); const u = new URL(String(a.serverUrl || '')); if (u.protocol !== 'https:') throw new Error('The address must start with https://');
  const f = path.join(app.getPath('userData'), 'central.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ serverUrl: u.origin })); if (a.caPem) { new crypto.X509Certificate(String(a.caPem)); fs.writeFileSync(path.join(path.dirname(f), 'ca.crt'), String(a.caPem)); }
  CENTRAL.token = null; return loadCentral() ? { ok: true } : { ok: false, error: CENTRAL.error };
});
ipcMain.handle('central:ping', async e => { assertAppSender(e); try { const r = await central('GET', '/api/info'); return { ok: r.status === 200, info: r.json }; } catch (x) { return { ok: false, error: String(x.cause && x.cause.message || x.message) }; } });
ipcMain.handle('central:login', async (e, a = {}) => { assertAppSender(e); const r = await central('POST', '/api/login', { json: { username: String(a.username || ''), password: String(a.password || ''), device: require('os').hostname() } }); if (r.status === 200 && r.json.token) { CENTRAL.token = r.json.token; const { token, ...rest } = r.json; return { status: 200, json: rest }; } return r; });
ipcMain.handle('central:logout', async e => { assertAppSender(e); try { if (CENTRAL.token) await central('POST', '/api/logout', { json: {} }); } catch {} CENTRAL.token = null; if (CENTRAL.sseAbort) CENTRAL.sseAbort.abort(); return true; });
ipcMain.handle('central:request', (e, a = {}) => { assertAppSender(e); return central(String(a.method || 'GET'), a.path, { json: a.json, bytes: a.bytes, raw: !!a.raw }); });
ipcMain.handle('central:events', async e => {
  assertAppSender(e); if (CENTRAL.sseAbort) CENTRAL.sseAbort.abort(); const ab = new AbortController(); CENTRAL.sseAbort = ab; const wc = e.sender;
  (async () => { while (!ab.signal.aborted && CENTRAL.token && !wc.isDestroyed()) { try {
    const res = await net.fetch(CENTRAL.cfg.serverUrl + '/api/events', { headers: { Authorization: 'Bearer ' + CENTRAL.token }, signal: ab.signal }); const rd = res.body.getReader();
    for (;;) { const { done } = await rd.read(); if (done) break; if (!wc.isDestroyed()) wc.send('central:event'); }
  } catch {} await new Promise(r => setTimeout(r, 5000)); } })(); return true;
});
// ---- v1.0.13: WADA update monitor (Chromium network stack, local SQLite history, notifications) ----
let monitor = null;
const getMonitor = () => {
  if (monitor) return monitor;
  monitor = wadaMonitor.createMonitor({
    dbPath: path.join(app.getPath('userData'), 'wada-monitor.sqlite'),
    // electron.net.fetch uses Chromium's network stack: system/PAC proxy, Windows certificate store, DNS - same as a browser.
    fetchImpl: (url, opts) => net.fetch(url, opts),
    onChange: () => BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('wada:changed'); } catch {} }),
    onNotify: items => {
      try {
        if (!Notification.isSupported()) return;
        const list = items.slice(0, 3);
        list.forEach(n => { const t = new Notification({ title: n.kind === 'changed' ? 'WADA update changed' : 'New WADA update', body: String(n.title).slice(0, 180), silent: false }); t.on('click', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); w.webContents.send('wada:open-inbox'); } }); t.show(); });
        if (items.length > 3) new Notification({ title: 'WADA updates', body: `${items.length - 3} more update(s) in the EDCL Lab System inbox` }).show();
      } catch {}
    }
  });
  const rules = monitor.getPrefs().proxyRules; if (rules) session.defaultSession.setProxy({ proxyRules: rules }).catch(() => {});
  return monitor;
};
const diag = e => `${e.category} at ${e.stage} (${e.url}) at ${e.at}${e.http_status ? ' HTTP ' + e.http_status : ''}: ${e.message}`;
ipcMain.handle('wada:sync', async e => {
  assertAppSender(e);
  const mon = getMonitor(), r = await mon.check('manual');
  if (r.status === 'failed' || r.status === 'cancelled') { const err = mon.history().errors.find(x => x.run_id === r.runId) || {}; throw new Error('WADA check ' + r.status + (err.message ? ' - ' + diag({ category: err.category, stage: err.stage, url: err.source_url, at: err.at, http_status: err.http_status, message: err.message }) : '')); }
  return { source: 'https://www.wada-ama.org/en/media/news', fetchedAt: new Date().toISOString(), records: mon.legacyRecords(), partial: r.status === 'partial' };
});
ipcMain.handle('wada:status', e => { assertAppSender(e); return getMonitor().status(); });
ipcMain.handle('wada:check', async e => { assertAppSender(e); return getMonitor().check('manual'); });
ipcMain.handle('wada:cancel', e => { assertAppSender(e); return getMonitor().cancel(); });
ipcMain.handle('wada:items', (e, f) => { assertAppSender(e); return getMonitor().listItems(f || {}); });
ipcMain.handle('wada:notifications', (e, f) => { assertAppSender(e); return getMonitor().listNotifications(f || {}); });
ipcMain.handle('wada:markRead', (e, a = {}) => { assertAppSender(e); return getMonitor().markRead(Array.isArray(a.ids) ? a.ids.map(Number).filter(Number.isInteger) : [], a.read !== false); });
ipcMain.handle('wada:markAllRead', e => { assertAppSender(e); return getMonitor().markAllRead(); });
ipcMain.handle('wada:prefs:get', e => { assertAppSender(e); return { prefs: getMonitor().getPrefs(), categories: wadaMonitor.CATEGORIES }; });
ipcMain.handle('wada:prefs:set', (e, p) => { assertAppSender(e); const r = getMonitor().setPrefs(p || {}); if (p && p.proxyRules !== undefined) session.defaultSession.setProxy(p.proxyRules ? { proxyRules: r.proxyRules } : { mode: 'system' }).catch(() => {}); return r; });
ipcMain.handle('wada:history', e => { assertAppSender(e); return getMonitor().history(); });
ipcMain.handle('wada:verify', (e, a = {}) => { assertAppSender(e); return getMonitor().verify(Number(a.id), { verdict: String(a.verdict || ''), note: String(a.note || '').slice(0, 500), user: String(a.user || '').slice(0, 80) }); });
ipcMain.handle('wada:open', async (e, id) => { assertAppSender(e); const it = getMonitor().itemById(Number(id)); if (!it) throw new Error('Unknown update'); const u = new URL(it.url); if (u.protocol !== 'https:' || u.hostname !== wadaMonitor.HOST) throw new Error('Only official wada-ama.org pages can be opened'); await shell.openExternal(u.href); return true; });
ipcMain.handle('wada:download', async (e, args = {}) => { assertAppSender(e); return getMonitor().download(app.getPath('userData'), args.url, args.filename, args.itemId); });

// ---- v1.0.10: one-click backup to Microsoft Access (.accdb) and SQLite (.sqlite) ----
const BK_CFG = path.join(app.getPath('userData'), 'backup-settings.json');
const bkFolder = () => { try { const j = JSON.parse(fs.readFileSync(BK_CFG, 'utf8')); if (j && typeof j.folder === 'string' && j.folder) return j.folder; } catch {} return path.join(app.getPath('documents'), 'EDCL Backups'); };
ipcMain.handle('backup:folder', e => { assertAppSender(e); return bkFolder(); });
ipcMain.handle('backup:chooseFolder', async e => {
  assertAppSender(e);
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose the EDCL backup folder', defaultPath: bkFolder(), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true, folder: bkFolder() };
  fs.mkdirSync(path.dirname(BK_CFG), { recursive: true });
  fs.writeFileSync(BK_CFG, JSON.stringify({ folder: r.filePaths[0] }));
  return { canceled: false, folder: r.filePaths[0] };
});
ipcMain.handle('backup:openFolder', async e => { assertAppSender(e); const f = bkFolder(); fs.mkdirSync(f, { recursive: true }); return shell.openPath(f); });
ipcMain.handle('backup:run', async (e, args = {}) => {
  assertAppSender(e);
  return backupService.run({ folder: bkFolder(), kind: args.kind, tables: args.tables, full: typeof args.full === 'string' ? args.full : '{}', version: app.getVersion() });
});
ipcMain.handle('backup:auto', async (e, args = {}) => {
  assertAppSender(e);
  return backupService.run({ folder: bkFolder(), kind: 'both', auto: true, tables: args.tables, full: typeof args.full === 'string' ? args.full : '{}', version: app.getVersion() });
});
ipcMain.handle('backup:readAccess', async e => {
  assertAppSender(e);
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose an Access database to import', defaultPath: bkFolder(), properties: ['openFile'], filters: [{ name: 'Microsoft Access database', extensions: ['accdb', 'mdb'] }] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return { canceled: false, ...(await backupService.readAccess(r.filePaths[0])) };
});
ipcMain.handle('backup:readSqlite', async e => {
  assertAppSender(e);
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose an EDCL SQLite backup', defaultPath: bkFolder(), properties: ['openFile'], filters: [{ name: 'EDCL SQLite backup', extensions: ['sqlite', 'sqlite3', 'db'] }] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return { canceled: false, ...backupService.readPayload(r.filePaths[0]) };
});



// ---- printing: same HTML -> hidden window -> PDF preview / system print / save as PDF ----
async function printWin(html) {
  const f = path.join(app.getPath('temp'), 'edcl-print-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.html');
  fs.writeFileSync(f, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  w.webContents.on('will-navigate', e => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try { await w.loadFile(f); } catch (err) { try { w.destroy(); fs.unlinkSync(f); } catch {} throw err; }
  return { w, f };
}
const printDone = h => { try { h.w.destroy(); } catch {} try { fs.unlinkSync(h.f); } catch {} };
const PDF_OPTS = { printBackground: true, preferCSSPageSize: true };
ipcMain.handle('print:pdf', async (_e, html) => { const h = await printWin(html); try { return await h.w.webContents.printToPDF(PDF_OPTS); } finally { printDone(h); } });
ipcMain.handle('print:print', async (_e, html) => {
  const h = await printWin(html);
  return await new Promise(res => h.w.webContents.print({ silent: false, printBackground: true }, (ok, why) => { printDone(h); res({ ok, why }); }));
});
ipcMain.handle('forms:saveFile', async (e, bytes, name) => {   // v1.0.15: export the exact completed PDF bytes (validated, never executed)
  assertAppSender(e);
  const buf = Buffer.from(bytes || []); if (buf.length < 100 || buf.length > 200 * 1024 * 1024 || buf.slice(0, 5).toString() !== '%PDF-') throw new Error('Not a valid PDF');
  const safe = String(name || 'form.pdf').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: safe.endsWith('.pdf') ? safe : safe + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(r.filePath, buf); return { ok: true, path: r.filePath };
});
ipcMain.handle('print:save', async (e, html, name) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(parent, { defaultPath: name || 'document.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  const h = await printWin(html);
  try { fs.writeFileSync(r.filePath, await h.w.webContents.printToPDF(PDF_OPTS)); return { ok: true, path: r.filePath }; } finally { printDone(h); }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } else if (app.isReady()) { win = null; createWindow(); } });
  app.whenReady().then(() => {
    protocol.handle('app', req => {
      let p = decodeURIComponent(new URL(req.url).pathname);
      if (p === '/' || p === '') p = '/index.html';
      const file = path.normalize(path.join(APP_DIR, p));
      if (!file.startsWith(APP_DIR)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    buildMenu();
    createWindow();
    try { getMonitor().start(); } catch (err) { console.error('WADA monitor unavailable:', err && err.message); }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { try { if (monitor) monitor.close(); } catch {} });
}

// >>> EDCL-AI-HYBRID (add-on; removed by Remove.cmd / Disable.cmd) >>>
try { require("./addons-main/edcl-ai-hybrid/bootstrap").init({ app, ipcMain, BrowserWindow, net, shell, Notification, safeStorage: require("electron").safeStorage, getMonitor, assertAppSender, wadaMonitor }); } catch (e) { console.error("EDCL AI Hybrid add-on not started:", e && e.message); }
// <<< EDCL-AI-HYBRID <<<
/* EDCL-AI-GATEWAY-BEGIN */
try { require('./ai-gateway.js').register({ ipcMain, app, assertAppSender, net, safeStorage: require('electron').safeStorage }); } catch (e) { console.error('EDCL AI gateway not loaded:', e && e.message); }
/* EDCL-AI-GATEWAY-END */

// >>> EDCL-WADA-FIX (add-on; removed by Remove.cmd / Disable.cmd) >>>
try { require("./addons-main/edcl-wada-fix/wada-fix-bootstrap").init({ app, ipcMain, BrowserWindow, net, session, Notification, getPowerMonitor: () => require("electron").powerMonitor, getMonitor, assertAppSender, wadaMonitor }); } catch (e) { console.error("EDCL WADA Monitor Fix not started:", e && e.message); }
// <<< EDCL-WADA-FIX <<<
