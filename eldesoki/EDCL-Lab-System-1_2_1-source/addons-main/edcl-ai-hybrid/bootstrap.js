'use strict';
/* EDCL AI Hybrid add-on - main-process entry point (called by ONE line appended to main.js).
   - Registers the "aih:*" IPC channels. It does not touch the host's own channels, windows, menus or databases.
   - All add-on data (settings, gateway policy + log, WADA document archive and its own SQLite file) lives in ONE folder:
        <userData>/EDCL-AI-Hybrid/      (deleting that folder removes everything the add-on ever stored outside the page database)
   - The host's WADA monitor database is only READ (SELECT) - no table, index or row of it is created or changed. */
const fs = require('fs');
const path = require('path');
const Gateway = require('./privacy-gateway');
const HybridNet = require('./hybrid-net');
const Local = require('./local-llm');
const WadaArchive = require('./wada-archive');
const VERSION = '2.0.0';

const init = ctx => {
  const { app, ipcMain } = ctx;
  const dir = path.join(app.getPath('userData'), 'EDCL-AI-Hybrid'); fs.mkdirSync(dir, { recursive: true });
  const fetchImpl = (u, o) => ctx.net.fetch(u, o), guard = ctx.assertAppSender || (() => {});
  let archive = null, timer = null, lastSeenRun = null;
  const gateway = Gateway.create({ dir });
  const hnet = HybridNet.create({ dir, fetchImpl, safeStorage: ctx.safeStorage, onFetched: (sha, url) => gateway.registerPublic(sha, url) });
  const local = Local.create({ fetchImpl });
  const broadcast = () => { try { ctx.BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('aih:wada:changed'); } catch (e) { /* closed */ } }); } catch (e) { /* none */ } };
  const toast = items => { try { if (ctx.Notification && ctx.Notification.isSupported && ctx.Notification.isSupported()) { const n = items[0]; new ctx.Notification({ title: items.length > 1 ? items.length + ' WADA documents have new versions' : 'WADA document updated', body: items.length > 1 ? 'Open Document Library > WADA Documents' : n.title }).show(); } } catch (e) { /* notifications are optional */ } };
  const getArchive = () => {
    if (archive) return archive;
    const monitor = ctx.getMonitor(); const Database = ctx.Database || require('better-sqlite3');
    const db = new Database(path.join(dir, 'aih-wada-docs.sqlite')); db.pragma('journal_mode = WAL');
    archive = WadaArchive.create({ db, monitorDb: monitor.db, fetchImpl, root: dir, officialUrl: ctx.wadaMonitor.officialUrl, parseResourcePage: ctx.wadaMonitor.parseResourcePage, classifyError: ctx.wadaMonitor.classifyError, onNotify: toast, onChange: broadcast });
    return archive;
  };
  const need = a => { if (!a || a.authorized !== true) throw new Error('This change requires an authorized System Owner session'); return String(a.user || '').slice(0, 60); };
  const H = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => { guard(e); return fn(...args); });

  H('aih:status', () => ({ version: VERSION, dataFolder: dir, hasMonitor: typeof ctx.getMonitor === 'function' }));
  // ---- WADA documents (current / previous versions) ----
  H('aih:wada:list', () => getArchive().list());
  H('aih:wada:sync', a => getArchive().sync({ force: !!(a && a.force) }));
  H('aih:wada:read', id => { const r = getArchive().read(Number(id)); return { bytes: new Uint8Array(r.buffer), name: r.name, sha256: r.sha256, title: r.title, url: r.url, size: r.size, fetchedAt: r.fetchedAt }; });
  H('aih:wada:prefs:get', () => getArchive().getPrefs());
  H('aih:wada:prefs:set', p => getArchive().setPrefs(p || {}));
  // ---- internet access settings (System Owner) ----
  H('aih:net:settings', () => hnet.getSettings());
  H('aih:net:setSettings', a => hnet.setSettings((a && a.patch) || {}, need(a)));
  H('aih:net:setKey', a => { need(a); return hnet.setKey(a.key); });
  H('aih:net:clearKey', a => { need(a); return hnet.clearKey(); });
  H('aih:net:fetch', async a => { const r = await hnet.fetchPage(String((a && a.url) || '')); return { ...r, bytes: r.bytes ? new Uint8Array(r.bytes) : undefined }; });
  H('aih:net:test', () => hnet.test());
  // ---- privacy gateway ----
  H('aih:gw:policy', () => gateway.getPolicy());
  H('aih:gw:setMode', a => gateway.setMode(a && a.mode, need(a)));
  H('aih:gw:approve', a => gateway.approveDoc(a && a.sha256, a && a.label, need(a)));
  H('aih:gw:revoke', a => gateway.revokeDoc(a && a.sha256, need(a)));
  H('aih:gw:log', n => gateway.readLog(n || 200));
  H('aih:gw:screen', a => { const r = gateway.screen(String((a && a.text) || ''), (a && a.terms) || []); return { found: r.found, counts: r.counts }; });
  // ---- language models ----
  // LOCAL: may receive confidential EDCL data, therefore the address is verified here (loopback / laboratory network only).
  H('aih:llm:local', a => local.chat({ backend: a.backend, url: a.url, model: a.model, system: a.system, messages: a.messages }));
  H('aih:llm:models', a => local.models({ backend: a.backend, url: a.url }));
  // CLOUD: the gateway decides; if it refuses, nothing is sent and the reasons are returned.
  H('aih:llm:cloud', async a => {
    let publicShas = new Set(); try { publicShas = getArchive().shas(); } catch (e) { /* no archive yet */ }
    const d = gateway.prepareCloud({ question: a && a.question, excerpts: (a && a.excerpts) || [], terms: (a && a.terms) || [], tainted: !!(a && a.tainted), scope: hnet.getSettings().online.scope }, { publicShas });
    if (!d.allowed) return { blocked: true, reasons: d.reasons };
    const r = await hnet.cloudAsk({ payload: d.payload, web: !!(a && a.web) });
    return { ...r, gateway: { reasons: d.reasons, withheld: d.withheld, redactions: d.redactions, sent: d.payload.excerpts.length } };
  });

  // ---- keep the document archive level with the host's WADA monitor (no change to the monitor itself) ----
  const tick = async () => {
    try {
      const a = getArchive(), t = a.lastMonitorRun();
      if (t && t !== lastSeenRun) { lastSeenRun = t; if (a.getPrefs().archive) await a.sync({}); }
    } catch (e) { /* the monitor may not exist yet; try again later */ }
  };
  timer = setInterval(tick, 60000); if (timer.unref) timer.unref(); const t0 = setTimeout(tick, 20000); if (t0.unref) t0.unref();
  return { dir, gateway, hnet, local, version: VERSION, dispose: () => { if (timer) clearInterval(timer); }, tick };
};

module.exports = { init, VERSION };
