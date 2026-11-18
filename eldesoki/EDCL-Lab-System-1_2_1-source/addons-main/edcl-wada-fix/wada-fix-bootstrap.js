'use strict';
/* EDCL WADA Monitor Fix - main-process entry point (called by ONE line appended to main.js).
 * It wraps the existing WADA monitor object without replacing its file:
 *   check()   -> connection ladder (system proxy -> direct -> WPAD -> typed proxy) + document watch + honest result
 *   status()  -> adds health ("ok" / "degraded" / "failing" / "stale"), a plain-language message, next retry time
 *   start()   -> replaced by a scheduler that RETRIES after a failure (5, 10, 20, 40, 60, 120 min) instead of waiting for the full interval,
 *                runs again when the network comes back or the PC wakes up, and continues unfinished work after 2 minutes.
 * "No new updates" is only ever written for a run that really read every source AND every due document. */
const path = require('path');
const dns = require('dns');
const Net = require('./wada-net');
const Watch = require('./wada-watch');
const Copies = require('./wada-copies');
const VERSION = '2.1.2';
const RETRY_MIN = [5, 10, 20, 40, 60, 120];
const isoNow = () => new Date().toISOString();

/* ---------- health (pure) ---------- */
const ago = (ms, now) => { const m = Math.round((now - ms) / 60000); return m < 1 ? 'just now' : m < 90 ? m + ' minutes ago' : m < 2880 ? Math.round(m / 60) + ' hours ago' : Math.round(m / 1440) + ' days ago'; };
const computeHealth = ({ lastRun, lastSuccessAt, lastCompleteAt, consecutiveFailures, intervalHours, now, nextAttemptAt, watch, running }) => {
  const t = now.getTime(); const next = nextAttemptAt ? ' Next automatic attempt: ' + new Date(nextAttemptAt).toLocaleString() + '.' : '';
  const lastOk = lastCompleteAt ? ' Last complete check: ' + ago(new Date(lastCompleteAt).getTime(), t) + '.' : ' No complete check has succeeded yet.';
  if (running) return { health: 'running', message: 'A check is running now.' };
  if (!lastRun) return { health: 'unknown', message: 'No check has been completed yet. The first check starts automatically.' };
  if (lastRun.status === 'failed') return { health: 'failing', message: 'CANNOT CONFIRM whether WADA published or revised anything: WADA could not be reached (' + (lastRun.message || 'connection problem') + '). ' + consecutiveFailures + ' attempt' + (consecutiveFailures === 1 ? '' : 's') + ' in a row failed.' + lastOk + next };
  if (lastRun.status === 'partial' || (watch && watch.failed)) return { health: 'degraded', message: 'INCOMPLETE: ' + (lastRun.failed_sources ? lastRun.failed_sources + ' source(s) ' : '') + (watch && watch.failed ? (lastRun.failed_sources ? 'and ' : '') + watch.failed + ' document page(s) ' : '') + 'could not be checked, so absence of updates is NOT confirmed for them. ' + (lastRun.message || '') + lastOk + next };
  if (watch && watch.complete === false) return { health: 'degraded', message: 'In progress: ' + (watch.deferred || 0) + ' document page(s) are waiting for the next run (a limited number is checked per run).' + lastOk + next };
  if (watch && watch.fileWarnings) return { health: 'notice', message: 'All document PAGES were checked (dates, status, versions, links). ' + watch.fileWarnings + ' document file(s) could not be downloaded, so changes inside those files are not detected - only changes shown on their pages. Details: WADA Updates > Connection test > technical details.' + lastOk + next };
  const age = lastSuccessAt ? t - new Date(lastSuccessAt).getTime() : Infinity;
  if (age > 2 * intervalHours * 3600e3) return { health: 'stale', message: 'The last successful check was ' + (lastSuccessAt ? ago(new Date(lastSuccessAt).getTime(), t) : 'never') + ' - older than expected. Updates published since then are not known.' + next };
  return { health: 'ok', message: 'Everything was checked ' + ago(new Date(lastSuccessAt).getTime(), t) + '. No problem.' };
};

const createFix = ctx => {
  const monitor = ctx.monitor, wadaMonitor = ctx.wadaMonitor, userData = ctx.userData, nowFn = ctx.now || (() => new Date()), db = monitor.db;
  const fetchImpl = ctx.fetchImpl;
  const watch = Watch.create({ db, fetchImpl, root: userData, officialUrl: wadaMonitor.officialUrl, parseResourcePage: wadaMonitor.parseResourcePage, parseIndex: wadaMonitor.parseIndex, classifyError: wadaMonitor.classifyError, sleep: ctx.sleep, now: nowFn, onNotify: ctx.onNotify, onChange: ctx.onChange });
  const copies = Copies.create({ db, watch, onNotify: ctx.onNotify, onChange: ctx.onChange });
  const store = { get: k => watch.getFix('net:' + k, null), set: (k, v) => watch.setFix('net:' + k, v) };
  const net = Net.create({ setProxy: ctx.setProxy, resolveProxy: ctx.resolveProxy, fetchImpl, dnsLookup: ctx.dnsLookup || (h => dns.promises.lookup(h)), isOnline: ctx.isOnline || (() => true), now: nowFn, classifyError: wadaMonitor.classifyError, getProxyRules: () => monitor.getPrefs().proxyRules, store });
  const origCheck = monitor.check, origStatus = monitor.status, origStart = monitor.start;
  let busy = null, lastOnline = true, lastAttemptAt = 0, timer = null;
  const st = (k, d) => watch.getFix(k, d), setSt = (k, v) => watch.setFix(k, v);
  const lastRunRow = () => db.prepare("SELECT * FROM wada_sync_runs WHERE status!='running' ORDER BY id DESC LIMIT 1").get();
  const lastSuccess = () => { const r = db.prepare("SELECT finished_at FROM wada_sync_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").get(); return r && r.finished_at; }; // only a run that read everything counts as a success
  const interval = () => monitor.getPrefs().intervalHours || 6;

  const scheduleNext = (res, watchRes) => {
    const failedRun = res.status === 'failed' || res.status === 'partial' || (watchRes && watchRes.failed > 0), unfinished = watchRes && watchRes.complete === false && !failedRun;
    let n = st('consecutiveFailures', 0); let mins;
    if (failedRun) { n++; mins = Math.min(RETRY_MIN[Math.min(n - 1, RETRY_MIN.length - 1)], interval() * 60); }
    else { n = 0; mins = unfinished ? 2 : interval() * 60; if (!unfinished) setSt('lastCompleteAt', isoNow()); }
    setSt('consecutiveFailures', n); setSt('nextAttemptAt', new Date(nowFn().getTime() + mins * 60000).toISOString()); setSt('lastResult', { status: res.status, complete: !failedRun && !unfinished, fileWarnings: (watchRes && watchRes.fileWarnings) || 0, at: isoNow() });
    return { consecutiveFailures: n, minutes: mins };
  };

  /* check(): the ONE entry point for manual and automatic checks */
  const check = async (trigger = 'manual', opts = {}) => {
    if (busy) return { coalesced: true, ...(await busy.catch(r => r)) };
    busy = (async () => {
      lastAttemptAt = nowFn().getTime(); await net.restoreSaved(); // keep the remembered connection mode even if WADA settings were saved in between
      const ladder = await net.run(() => origCheck(trigger)); const res = ladder.result;
      if (res.coalesced) return res;
      let w = { enabled: true, candidates: 0, checked: 0, failed: 0, deferred: 0, complete: false, skipped: 'no connection' };
      const connDown = Net.isConnectionFailure(res);
      if (!connDown && res.runId) { try { w = await watch.watch({ runId: res.runId, force: !!opts.force }); } catch (e) { w = { enabled: true, failed: 1, complete: false, errors: [{ title: 'document check', category: 'internal', message: String(e.message || e).slice(0, 200) }], deferred: 0, checked: 0, candidates: 0 }; } }
      // ---- honest result: write the final status/message into the run record ----
      let status = res.status, parts = [];
      const watchBad = !!(w && (w.failed || (w.complete === false && !w.skipped)));
      if (status === 'ok' && w && w.failed) status = 'partial';
      if (res.messages && res.messages.length) parts.push(res.messages.join('; '));
      if (w && w.failed) parts.push(w.failed + ' document page(s) could not be checked' + (w.errors && w.errors[0] ? ' (' + w.errors[0].category + ')' : ''));
      if (w && w.deferred) parts.push(w.deferred + ' document page(s) not yet checked (continues automatically)');
      if (w && w.discovery && w.discovery.warning) parts.push('Technical Letters list: ' + w.discovery.warning);
      if (w && w.fileWarnings) parts.push('NOTE: ' + w.fileWarnings + ' document file(s) could not be downloaded' + (w.fileWarning ? ' (' + w.fileWarning.category + ')' : '') + '; their pages were checked');
      const nNew = (w && w.discovery ? w.discovery.found : 0) * 0, nCh = (w && w.revised) || 0;
      let message = parts.join('; ');
      if (status === 'ok' && !watchBad) { const caveat = w && w.fileWarnings ? ' - NOTE: ' + w.fileWarnings + ' document file(s) could not be downloaded, their pages were checked' : ''; const found = (res.newNotifications || 0) + nCh; message = found ? '' : 'No new updates (' + (res.counts.unchanged + res.counts.new + res.counts.changed) + ' items in ' + ctx.sourceCount + ' sources and ' + (w.checked || 0) + ' document pages checked)' + caveat; if (found) message = found + ' update(s) found' + caveat; }
      if (status === 'ok' && watchBad && !message) message = 'Not every document was checked';
      db.prepare('UPDATE wada_sync_runs SET status=?, message=?, changed_count=changed_count+? WHERE id=?').run(status, message, nCh, res.runId);
      const sched = scheduleNext({ status }, w);
      if (ladder.switched) { try { db.prepare("UPDATE wada_sync_runs SET message=message||? WHERE id=?").run(' [connection mode switched to ' + ladder.mode + ']', res.runId); } catch (e) { /* ignore */ } }
      if (sched.consecutiveFailures === 3 && ctx.onUnhealthy) { try { ctx.onUnhealthy('WADA monitoring could not complete a check 3 times in a row. Updates may be missed. Open WADA Updates for details.'); } catch (e) { /* optional */ } }
      ctx.onChange && ctx.onChange();
      return { ...res, status, message, watch: w, complete: !watchBad && status === 'ok', newNotifications: (res.newNotifications || 0), revisedDocuments: nCh, netTried: ladder.tried, netMode: net.currentId(), counts: { ...res.counts, changed: res.counts.changed + nCh } };
    })();
    try { return await busy; } finally { busy = null; }
  };
  const status = () => {
    const s = origStatus(), lr = lastRunRow(), nxt = st('nextAttemptAt', null), cf = st('consecutiveFailures', 0), wl = (() => { try { const q = x => db.prepare(x).get(); return { tracked: q('SELECT COUNT(*) n FROM wada_doc_state').n, failed: q("SELECT COUNT(*) n FROM wada_doc_state WHERE result='failed'").n, versions: q('SELECT COUNT(*) n FROM wada_doc_versions').n, lastChecked: q('SELECT MAX(last_checked) t FROM wada_doc_state').t || null }; } catch (e) { return null; } })(); // cheap: this is called on every screen change
    const h = computeHealth({ lastRun: lr, lastSuccessAt: lastSuccess(), lastCompleteAt: st('lastCompleteAt', null), consecutiveFailures: cf, intervalHours: interval(), now: nowFn(), nextAttemptAt: nxt, watch: (st('lastResult', null) && wl) ? { failed: wl.failed, complete: st('lastResult', {}).complete, fileWarnings: st('lastResult', {}).fileWarnings || 0 } : null, running: !!(s && s.running) || !!busy });
    return { ...s, health: h.health, healthMessage: h.message, consecutiveFailures: cf, nextAttemptAt: nxt, lastComplete: st('lastCompleteAt', null), netMode: net.currentId(), documents: wl, nextCheck: s.prefs && s.prefs.autoEnabled ? (nxt || s.nextCheck) : s.nextCheck };
  };

  /* scheduler: replaces the monitor's own (which waited the full interval after a failure) */
  const dueNow = () => {
    const p = monitor.getPrefs(); if (!p.autoEnabled || busy) return false; const t = nowFn().getTime();
    const online = ctx.isOnline ? !!ctx.isOnline() : true, regained = online && !lastOnline; lastOnline = online; if (!online) return false;
    if (t - lastAttemptAt < 60000) return false; const lr = lastRunRow(); if (!lr || !lr.finished_at) return true;
    const nxt = st('nextAttemptAt', null); if (regained && (lr.status !== 'ok' || st('consecutiveFailures', 0) > 0)) return true;
    if (!nxt) return t - new Date(lr.finished_at).getTime() >= interval() * 3600e3; return t >= new Date(nxt).getTime();
  };
  const tick = async () => { if (dueNow()) { try { return await check('auto'); } catch (e) { return null; } } return null; };
  const nudge = reason => { const lr = lastRunRow(); const stale = !lr || lr.status !== 'ok' || nowFn().getTime() - new Date(lr.finished_at || 0).getTime() >= interval() * 3600e3; if (stale) setSt('nextAttemptAt', new Date(nowFn().getTime() + 30000).toISOString()); return stale; };
  const startScheduler = (tickMs = 30000, firstDelay = 12000) => { stopScheduler(); timer = setInterval(tick, tickMs); if (timer.unref) timer.unref(); const f = setTimeout(tick, firstDelay); if (f.unref) f.unref(); };
  const stopScheduler = () => { if (timer) clearInterval(timer); timer = null; };
  const takeover = async () => { try { monitor.stop(); } catch (e) { /* ignore */ } monitor.check = check; monitor.status = status; monitor.start = () => { startScheduler(); }; await net.restoreSaved(); startScheduler(); };

  return { check, status, tick, nudge, takeover, startScheduler, stopScheduler, watch, copies, net, computeHealth, version: VERSION, dueNow };
};

/* ---------- Electron wiring ---------- */
const init = ctx => {
  const { app, ipcMain } = ctx, guard = ctx.assertAppSender || (() => {}); let fix = null;
  const get = () => { if (fix) return fix; const monitor = ctx.getMonitor(); const ses = ctx.session && ctx.session.defaultSession;
    const broadcast = () => { try { ctx.BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send('wada:changed'); } catch (e) { /* closed */ } }); } catch (e) { /* none */ } };
    const toast = items => { try { if (ctx.Notification && ctx.Notification.isSupported && ctx.Notification.isSupported()) { const n = items[0]; new ctx.Notification({ title: items.length > 1 ? items.length + ' WADA document updates' : (n.kind === 'new' ? 'New WADA document' : 'WADA document revised / EDCL copy outdated'), body: String(n.title).slice(0, 180) }).show(); } } catch (e) { /* optional */ } };
    fix = createFix({ monitor, wadaMonitor: ctx.wadaMonitor, userData: app.getPath('userData'), fetchImpl: (u, o) => ctx.net.fetch(u, o), onNotify: toast, onChange: broadcast, sourceCount: 4,
      setProxy: async cfg => { if (ses) await ses.setProxy(cfg); }, resolveProxy: async u => (ses ? ses.resolveProxy(u) : 'unknown'), isOnline: () => (ctx.net.isOnline ? ctx.net.isOnline() : true),
      onUnhealthy: msg => { try { if (ctx.Notification && ctx.Notification.isSupported()) new ctx.Notification({ title: 'WADA monitoring problem', body: msg }).show(); } catch (e) { /* optional */ } } });
    return fix; };
  const need = a => { if (!a || a.authorized !== true) throw new Error('This change requires an authorized session'); return String(a.user || '').slice(0, 80); };
  const H = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => { guard(e); return fn(...args); });
  H('wf:status', () => get().status());
  H('wf:recheck', () => get().check('manual', { force: true }));
  H('wf:docs:list', () => get().watch.list());
  H('wf:docs:versions', id => get().watch.versionsOf(Number(id)));
  H('wf:docs:read', id => { const r = get().watch.readVersion(Number(id)); return { bytes: new Uint8Array(r.buffer), name: r.name, sha256: r.sha256, size: r.size, title: r.title }; });
  H('wf:docs:diagnostics', () => get().watch.diagnostics());
  H('wf:docs:prefs:get', () => get().watch.getPrefs());
  H('wf:docs:prefs:set', a => { need(a); return get().watch.setPrefs((a && a.prefs) || {}); });
  H('wf:copies:report', a => get().copies.report({ copies: (a && a.copies) || [], refs: (a && a.refs) || [] }));
  H('wf:copies:stored', () => get().copies.stored());
  H('wf:copies:ack', a => { const u = need(a); return get().copies.acknowledge(a.ref, u, a.note); });
  H('wf:net:diagnose', a => get().net.diagnose({ tryModes: !!(a && a.tryModes) }));
  H('wf:net:mode:get', () => ({ mode: get().net.currentId(), modes: Net.MODES(ctx.getMonitor().getPrefs().proxyRules).map(m => ({ id: m.id, label: m.label })) }));
  H('wf:net:mode:set', async a => { need(a); return { mode: await get().net.setMode(a.mode) }; });
  // the monitor's own scheduler is replaced shortly after start-up; the PC waking up triggers an early re-check when needed
  if (app.whenReady) app.whenReady().then(() => { try { const pm = ctx.getPowerMonitor && ctx.getPowerMonitor(); if (pm && pm.on) pm.on('resume', () => { try { get().nudge('resume'); } catch (e) { /* ignore */ } }); } catch (e) { /* optional */ } const t = setTimeout(() => { try { get().takeover(); } catch (e) { console.error('EDCL WADA fix: scheduler not started:', e && e.message); } }, 2500); if (t.unref) t.unref(); });
  return { get, VERSION };
};

module.exports = { init, createFix, computeHealth, VERSION, RETRY_MIN };
