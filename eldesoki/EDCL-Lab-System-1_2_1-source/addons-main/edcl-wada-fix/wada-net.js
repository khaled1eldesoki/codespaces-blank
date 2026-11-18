'use strict';
/* EDCL WADA Monitor Fix - connection recovery and diagnostics (main process)
 *  - Connection ladder: if EVERY source fails with a connection-level problem (proxy, TLS, DNS, timeout, network), the check is
 *    repeated automatically through the other network modes (system proxy -> direct -> auto-detect (WPAD) -> the proxy typed in settings).
 *    The mode that works is remembered and used first next time. Certificate checking is NEVER switched off.
 *  - Diagnostics: step-by-step test (online? DNS? which proxy? HTTPS? certificate? PC clock vs server clock?) with plain advice.
 * Everything that touches Electron or the network is injected, so this module is tested in plain Node. */
const CONNECTION_CATS = ['dns', 'network', 'timeout', 'proxy', 'tls_certificate'];
const MODES = proxyRules => [
  { id: 'system', label: 'Windows / organisation proxy settings (default)', config: { mode: 'system' } },
  { id: 'direct', label: 'Direct connection (no proxy)', config: { mode: 'direct' } },
  { id: 'auto_detect', label: 'Automatic proxy detection (WPAD)', config: { mode: 'auto_detect' } },
  ...(proxyRules ? [{ id: 'custom', label: 'Proxy entered in settings (' + String(proxyRules).slice(0, 60) + ')', config: { mode: 'fixed_servers', proxyRules } }] : [])
];
const categoriesOf = r => { const cats = new Set(); for (const m of (r && r.messages) || []) { const x = String(m).match(/:\s*([a-z_]+)\s*\(/); if (x) cats.add(x[1]); } return [...cats]; };
// a result is a CONNECTION failure only when nothing could be read and every reason is connection-level
const isConnectionFailure = r => !!r && r.status === 'failed' && categoriesOf(r).length > 0 && categoriesOf(r).every(c => CONNECTION_CATS.includes(c));
const netCode = e => { const m = String((e && (e.message || e.code)) || e).match(/net::(ERR_[A-Z0-9_]+)|\b(E[A-Z]{3,}[A-Z_]*)\b/); return m ? (m[1] || m[2]) : ''; };

const create = (opts = {}) => {
  const setProxy = opts.setProxy || (async () => {}), resolveProxy = opts.resolveProxy || (async () => 'unknown'), fetchImpl = opts.fetchImpl, dnsLookup = opts.dnsLookup || (async () => ({ address: '?' }));
  const isOnline = opts.isOnline || (() => true), now = opts.now || (() => new Date()), classifyError = opts.classifyError || (() => ({ category: 'unknown', hint: '' })), getRules = opts.getProxyRules || (() => '');
  const store = opts.store || { get: () => null, set: () => {} }, TARGET = opts.target || 'https://www.wada-ama.org/en/media/news', HOST = new URL(TARGET).hostname;
  const currentId = () => store.get('netMode') || 'system';
  const apply = async m => { await setProxy(m.config); };

  /* run(fn): fn() performs one full check and returns its result. Returns the best result and a log of what was tried. */
  const run = async fn => {
    const first = await fn(), tried = [{ mode: currentId(), status: first.status, categories: categoriesOf(first) }];
    if (!isConnectionFailure(first)) return { result: first, tried, switched: false };
    const modes = MODES(getRules()), start = currentId();
    for (const m of modes.filter(x => x.id !== start)) {
      try { await apply(m); } catch (e) { tried.push({ mode: m.id, error: 'could not be applied: ' + e.message }); continue; }
      const r = await fn(); tried.push({ mode: m.id, status: r.status, categories: categoriesOf(r) });
      if (!isConnectionFailure(r)) { store.set('netMode', m.id); return { result: r, tried, switched: true, mode: m.id }; }
    }
    const back = modes.find(x => x.id === start) || modes[0]; try { await apply(back); } catch (e) { /* keep going */ }
    return { result: first, tried, switched: false };
  };
  const restoreSaved = async () => { const m = MODES(getRules()).find(x => x.id === currentId()); if (m && m.id !== 'system') { try { await apply(m); } catch (e) { /* ignore */ } } };

  const get = async () => { const t0 = Date.now(); const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000); try { const res = await fetchImpl(TARGET, { headers: { 'User-Agent': 'EDCL-Lab-System connection test' }, signal: ctl.signal }); await res.text(); return { ok: res.status >= 200 && res.status < 300, status: res.status, ms: Date.now() - t0, date: res.headers && res.headers.get && res.headers.get('date') }; } catch (e) { return { ok: false, ms: Date.now() - t0, error: e, code: netCode(e), cat: classifyError(e).category }; } finally { clearTimeout(timer); } };
  const diagnose = async ({ tryModes } = {}) => {
    const steps = [], advice = []; const step = (name, ok, detail) => steps.push({ name, ok, detail });
    const online = !!isOnline(); step('Network connection of this PC', online, online ? 'Windows reports that the PC is online' : 'Windows reports that the PC is OFFLINE'); if (!online) advice.push('Connect the PC to the network / internet, then run the test again.');
    try { const d = await dnsLookup(HOST); step('DNS (finding ' + HOST + ')', true, 'resolved to ' + (d && d.address)); } catch (e) { step('DNS (finding ' + HOST + ')', false, String(e.message || e).slice(0, 150)); advice.push('The name ' + HOST + ' cannot be resolved. Check the DNS server / internet access, or ask IT whether wada-ama.org is blocked.'); }
    let px = 'unknown'; try { px = await resolveProxy(TARGET); } catch (e) { /* ignore */ } step('Proxy used by Windows for WADA', true, px);
    const g = await get();
    if (g.ok) {
      step('HTTPS request to WADA (with certificate check)', true, 'HTTP ' + g.status + ' in ' + g.ms + ' ms');
      if (g.date) { const skew = Math.round((now().getTime() - new Date(g.date).getTime()) / 60000); const bad = Math.abs(skew) > 10; step('PC clock compared with the WADA server', !bad, bad ? 'the PC clock is ' + Math.abs(skew) + ' minutes ' + (skew > 0 ? 'ahead of' : 'behind') + ' the server' : 'difference ' + skew + ' min (ok)'); if (bad) advice.push('The PC date/time is wrong. A wrong clock makes HTTPS certificates fail. Correct the date, time and time zone.'); }
    } else {
      step('HTTPS request to WADA (with certificate check)', false, (g.code ? g.code + ' - ' : '') + (g.status ? 'HTTP ' + g.status : String((g.error && g.error.message) || 'failed').slice(0, 150)));
      const c = g.cat || (g.status === 403 ? 'forbidden' : 'unknown');
      if (c === 'tls_certificate') advice.push('HTTPS certificate problem. Usually (a) the PC clock is wrong, or (b) the organisation firewall inspects HTTPS - ask IT to install the organisation root certificate in the Windows certificate store. Certificate checking is never switched off by this application.');
      else if (c === 'proxy') advice.push('Proxy problem. The application will try a direct connection and automatic proxy detection by itself; if it still fails, enter the proxy address under WADA Updates > Settings > Network.');
      else if (c === 'timeout') advice.push('The request timed out - slow or blocked connection. The check retries automatically.');
      else if (c === 'forbidden') advice.push('WADA refused the request (HTTP 403). It is not bypassed. Try again later or ask IT whether a firewall rewrites the request.');
      else advice.push('The request failed (' + c + '). See the details above; the check retries automatically.');
    }
    const modes = [];
    if (tryModes) { const start = currentId(); for (const m of MODES(getRules())) { try { await apply(m); const x = await get(); modes.push({ id: m.id, label: m.label, ok: !!x.ok, detail: x.ok ? 'HTTP ' + x.status + ' in ' + x.ms + ' ms' : (x.code || (x.error && String(x.error.message).slice(0, 80)) || 'failed') }); } catch (e) { modes.push({ id: m.id, label: m.label, ok: false, detail: e.message }); } }
      const back = MODES(getRules()).find(x => x.id === start); if (back) { try { await apply(back); } catch (e) { /* ignore */ } }
      const works = modes.filter(m => m.ok); if (!g.ok && works.length) advice.push('A connection works with: ' + works.map(m => m.label).join('; ') + '. The application will use it automatically on the next check.'); }
    const failing = steps.find(s => !s.ok);
    return { ok: !failing, verdict: failing ? 'Problem at: ' + failing.name : 'The connection to WADA works.', steps, modes, advice, mode: currentId(), at: now().toISOString() };
  };
  return { run, diagnose, restoreSaved, currentId, setMode: async id => { const m = MODES(getRules()).find(x => x.id === id); if (!m) throw new Error('Unknown network mode'); await apply(m); store.set('netMode', id); return id; }, MODES };
};
module.exports = { create, categoriesOf, isConnectionFailure, netCode, CONNECTION_CATS, MODES };
