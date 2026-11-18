/* EDCL AI privacy gateway v2.1.0  (runs in the Electron main process)
   - The ONLY place where the EDCL AI add-on talks to the internet.
   - Outbound requests are limited to approved HTTPS hosts, screened for confidential patterns, size-limited, rate-limited and logged (metadata only, never content).
   - Cloud AI keys are stored encrypted with Electron safeStorage and never returned to the screen.
   - Nothing here reads the EDCL database; the screen decides what may be sent and this module re-checks it. */
'use strict';
const crypto = require('crypto');
const VERSION = '2.1.0';
const EVAL_ITEMS = ['dpa', 'retention', 'residency', 'classification', 'keys', 'limits', 'exit', 'legal', 'pilot']; // security evaluation checklist (the screen shows the wording)
const APPROVAL_DAYS = 365;
const DEFAULT_HOSTS = ['eutils.ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov', 'www.ebi.ac.uk', 'api.crossref.org', 'www.wada-ama.org'];
const MAX_RESP = 2 * 1024 * 1024, MAX_OUT = 24000, TIMEOUT = 20000, RATE_PER_MIN = 30;
/* patterns that must never leave the laboratory (defence in depth; the screen applies a stricter, data-driven check first) */
const PATTERNS = [
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['staff-id', /\bEMP\d{2,}\b/i],
  ['internal-code', /\b(?:MS|MC|SM|GR|PP|PR|FO|FI)\d{3}\b/],
  ['national-id', /\b\d{14}\b/],
  ['phone', /\+\d{1,3}[\s-]?\d[\d\s-]{6,14}\d/],
  ['long-number', /\b\d{9,}\b/]
];
const screenText = t => { const hits = []; for (const [k, r] of PATTERNS) if (r.test(String(t || ''))) hits.push(k); return hits; };
const validHost = h => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h) && !/^\d+(\.\d+){3}$/.test(h) && !/(^|\.)(localhost|local|lan|internal|intranet)$/i.test(h);

function createGateway(o) {
  const { app, fs, path, safeStorage, fetchImpl, now = () => new Date(), extraHosts = [] } = o;
  const dir = o.dir || app.getPath('userData');
  const F = { policy: path.join(dir, 'edcl-ai-policy.json'), keys: path.join(dir, 'edcl-ai-keys.json'), log: path.join(dir, 'edcl-ai-egress.log') };
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJson = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };
  const defaults = () => ({ researchEnabled: true, hosts: [], cloud: { enabled: false, provider: 'openai', baseUrl: '', model: '' }, approvedBy: '', approval: { approved: false } });
  const policy = () => { const p = readJson(F.policy, {}), d = defaults(); return { ...d, ...p, cloud: { ...d.cloud, ...(p.cloud || {}) }, approval: { ...d.approval, ...(p.approval || {}) }, hosts: Array.isArray(p.hosts) ? p.hosts.filter(validHost) : [] }; };
  /* Cloud AI is usable only while a System Owner approval exists for EXACTLY the configured provider / address / model and has not expired. */
  const approvalValid = p => { const a = p.approval || {}, c = p.cloud; return !!(a.approved && a.provider === c.provider && a.baseUrl === c.baseUrl && a.model === c.model && a.until && Date.parse(a.until) > now().getTime()); };
  const allowedHosts = () => new Set([...DEFAULT_HOSTS, ...policy().hosts, ...extraHosts].map(h => h.toLowerCase()));
  const stamps = [];
  const rate = () => { const t = now().getTime(); while (stamps.length && t - stamps[0] > 60000) stamps.shift(); if (stamps.length >= RATE_PER_MIN) throw new Error('Too many outbound requests (limit ' + RATE_PER_MIN + ' per minute). Try again shortly.'); stamps.push(t); };
  const log = (e) => { try { fs.appendFileSync(F.log, JSON.stringify({ t: now().toISOString(), ...e }) + '\n'); } catch {} };
  const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
  const guardUrl = (u, hosts) => { const x = new URL(u); if (x.protocol !== 'https:') throw new Error('Only HTTPS is allowed'); if (x.username || x.password) throw new Error('Credentials in URLs are not allowed'); if (x.port && x.port !== '443') throw new Error('Only the standard HTTPS port is allowed'); if (!hosts.has(x.hostname.toLowerCase())) throw new Error('Host not approved: ' + x.hostname); return x; };
  const httpGet = async (url, { user, purpose, headers = {}, hosts } = {}) => {
    hosts = hosts || allowedHosts(); const x = guardUrl(url, hosts); rate();
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), TIMEOUT);
    try {
      const res = await fetchImpl(x.href, { headers: { 'User-Agent': 'EDCL-Lab-System/AI-gateway', Accept: 'application/json, text/html, application/xml;q=0.9', ...headers }, redirect: 'follow', signal: ac.signal });
      if (res.url) guardUrl(res.url, hosts);
      if (!res.ok) throw new Error('Server answered ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_RESP) throw new Error('Response larger than 2 MB was rejected');
      log({ kind: 'fetch', user: user || '', host: x.hostname, path: sha(x.pathname + x.search), out: 0, in: buf.length, purpose: purpose || '', decision: 'allowed' });
      return buf.toString('utf8');
    } catch (e) { log({ kind: 'fetch', user: user || '', host: x.hostname, purpose: purpose || '', decision: 'failed', error: String(e.message || e).slice(0, 120) }); throw e; }
    finally { clearTimeout(tm); }
  };
  const checkQuery = (q, user, purpose, kind) => {
    q = String(q || '').trim(); if (!q) throw new Error('Empty query'); if (q.length > 400) throw new Error('Query too long (400 characters maximum)');
    const hits = screenText(q); if (hits.length) { log({ kind, user: user || '', purpose: purpose || '', decision: 'blocked', reason: hits.join(',') }); const e = new Error('Blocked by the privacy gateway: the query contains confidential-looking data (' + hits.join(', ') + ').'); e.code = 'BLOCKED'; throw e; }
    return q;
  };
  const strip = h => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  const xmlText = (s, tag) => { const m = [...String(s).matchAll(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'g'))].map(x => strip(x[1])); return m; };
  /* ---------- research providers (public scientific sources) ---------- */
  const providers = {
    async pubmed(q, n, ctx) {
      const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
      const s = JSON.parse(await httpGet(base + 'esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=' + n + '&term=' + encodeURIComponent(q), ctx));
      const ids = (s.esearchresult && s.esearchresult.idlist) || []; if (!ids.length) return [];
      const sum = JSON.parse(await httpGet(base + 'esummary.fcgi?db=pubmed&retmode=json&id=' + ids.join(','), ctx)).result || {};
      let abs = {}; try { const x = await httpGet(base + 'efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&id=' + ids.join(','), ctx); for (const a of x.split('</PubmedArticle>')) { const id = (a.match(/<PMID[^>]*>(\d+)<\/PMID>/) || [])[1]; if (id) abs[id] = xmlText(a, 'AbstractText').join(' '); } } catch {}
      return ids.map(id => { const r = sum[id] || {}; return { source: 'PubMed', title: strip(r.title), authors: (r.authors || []).map(a => a.name).slice(0, 6).join(', '), year: String(r.pubdate || '').slice(0, 4), journal: r.fulljournalname || r.source || '', doi: ((r.articleids || []).find(a => a.idtype === 'doi') || {}).value || '', url: 'https://pubmed.ncbi.nlm.nih.gov/' + id + '/', abstract: abs[id] || '' }; });
    },
    async europepmc(q, n, ctx) {
      const j = JSON.parse(await httpGet('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=' + n + '&query=' + encodeURIComponent(q), ctx));
      return ((j.resultList && j.resultList.result) || []).map(r => ({ source: 'Europe PMC', title: strip(r.title), authors: r.authorString || '', year: String(r.pubYear || ''), journal: r.journalTitle || '', doi: r.doi || '', url: r.doi ? 'https://doi.org/' + r.doi : 'https://europepmc.org/article/' + (r.source || 'MED') + '/' + (r.id || ''), abstract: strip(r.abstractText) }));
    },
    async crossref(q, n, ctx) {
      const j = JSON.parse(await httpGet('https://api.crossref.org/works?rows=' + n + '&select=DOI,title,author,issued,container-title,abstract,URL&query=' + encodeURIComponent(q), ctx));
      return ((j.message && j.message.items) || []).map(r => ({ source: 'Crossref', title: strip((r.title || [])[0]), authors: (r.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).slice(0, 6).join(', '), year: String((((r.issued || {})['date-parts'] || [[]])[0] || [])[0] || ''), journal: (r['container-title'] || [])[0] || '', doi: r.DOI || '', url: r.URL || ('https://doi.org/' + r.DOI), abstract: strip(r.abstract) }));
    }
  };
  /* ---------- operations exposed to the screen ---------- */
  const ops = {
    status: async () => { const p = policy(); return { version: VERSION, encryption: !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()), research: p.researchEnabled, hosts: [...allowedHosts()], cloud: { enabled: p.cloud.enabled, provider: p.cloud.provider, baseUrl: p.cloud.baseUrl, model: p.cloud.model, keySet: !!readJson(F.keys, {})[p.cloud.provider], approval: { valid: approvalValid(p), approved: !!p.approval.approved, by: p.approval.by || '', at: p.approval.at || '', until: p.approval.until || '', evaluator: p.approval.evaluator || '', evalRef: p.approval.evalRef || '', matchesConfig: !!(p.approval.approved && p.approval.provider === p.cloud.provider && p.approval.baseUrl === p.cloud.baseUrl && p.approval.model === p.cloud.model) } }, evalItems: EVAL_ITEMS }; },
    research: async (a = {}) => {
      const p = policy(); if (!p.researchEnabled) throw new Error('Web research is switched off by the administrator');
      const q = checkQuery(a.query, a.user, 'research:' + a.source, 'research'), src = a.source || 'pubmed', n = Math.max(1, Math.min(10, +a.limit || 5));
      if (!providers[src]) throw new Error('Unknown research source: ' + src);
      const out = await providers[src](q, n, { user: a.user, purpose: 'research:' + src });
      return { source: src, query: q, results: out.slice(0, n) };
    },
    fetchPage: async (a = {}) => {
      const p = policy(); if (!p.researchEnabled) throw new Error('Web research is switched off by the administrator');
      const x = guardUrl(String(a.url || ''), allowedHosts()); if (screenText(x.href).length) throw new Error('Blocked by the privacy gateway: the address contains confidential-looking data.');
      const body = await httpGet(x.href, { user: a.user, purpose: 'page' });
      return { url: x.href, text: strip(body).slice(0, 20000) };
    },
    cloudChat: async (a = {}) => {
      const p = policy(), c = p.cloud;
      if (!c.enabled) throw new Error('Cloud AI is switched off by the administrator');
      if (!approvalValid(p)) { log({ kind: 'cloud', user: a.user || '', decision: 'blocked', reason: 'not-approved' }); throw new Error('Blocked by the privacy gateway: cloud AI has no valid System Owner approval for this provider, address and model.'); }
      if (a.classification !== 'public') { log({ kind: 'cloud', user: a.user || '', decision: 'blocked', reason: 'not-classified-public' }); throw new Error('Blocked by the privacy gateway: only content classified as public may be sent to cloud AI.'); }
      const msgs = Array.isArray(a.messages) ? a.messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: String(m.content || '') })) : [];
      const total = msgs.reduce((s, m) => s + m.content.length, 0); if (!msgs.length || total > MAX_OUT) throw new Error('Request is empty or larger than ' + MAX_OUT + ' characters');
      const hits = screenText(msgs.map(m => m.content).join('\n')); if (hits.length) { log({ kind: 'cloud', user: a.user || '', host: '', purpose: a.purpose || '', decision: 'blocked', reason: hits.join(',') }); const e = new Error('Blocked by the privacy gateway: the content contains confidential-looking data (' + hits.join(', ') + ').'); e.code = 'BLOCKED'; throw e; }
      let u; try { u = new URL(c.baseUrl); } catch { throw new Error('Cloud AI address is not set'); } const host = u.hostname.toLowerCase();
      if (!validHost(host)) throw new Error('Cloud AI address must be a public HTTPS host name');
      const kobj = readJson(F.keys, {}), enc = kobj[c.provider]; if (!enc) throw new Error('Cloud AI key is not set');
      let key; try { key = safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { throw new Error('Cloud AI key cannot be decrypted on this PC'); }
      const hosts = new Set([host]); const base = guardUrl(c.baseUrl, hosts).href.replace(/\/+$/, ''); rate();
      const isA = c.provider === 'anthropic', url = isA ? base + '/v1/messages' : base + '/v1/chat/completions';
      const sys = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n'), rest = msgs.filter(m => m.role !== 'system');
      const body = isA ? { model: c.model, max_tokens: 1200, temperature: 0.1, system: sys, messages: rest } : { model: c.model, temperature: 0.1, messages: msgs };
      const headers = isA ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } : { Authorization: 'Bearer ' + key, 'content-type': 'application/json' };
      const payload = JSON.stringify(body), ac = new AbortController(), tm = setTimeout(() => ac.abort(), 90000);
      try {
        const res = await fetchImpl(url, { method: 'POST', headers, body: payload, redirect: 'error', signal: ac.signal });
        const txt = await res.text(); if (!res.ok) throw new Error('Cloud AI answered ' + res.status);
        const j = JSON.parse(txt), text = isA ? ((j.content || []).map(x => x.text || '').join('')) : (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        log({ kind: 'cloud', user: a.user || '', host, purpose: a.purpose || '', out: payload.length, in: txt.length, sha: sha(payload), decision: 'allowed' });
        return { text, host };
      } catch (e) { log({ kind: 'cloud', user: a.user || '', host, purpose: a.purpose || '', decision: 'failed', error: String(e.message || e).slice(0, 120) }); throw e; }
      finally { clearTimeout(tm); }
    },
    keySet: async (a = {}) => { if (!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable())) throw new Error('Secure key storage is not available on this PC; the key was NOT saved.'); const k = String(a.key || '').trim(); if (k.length < 8 || k.length > 400) throw new Error('Invalid key'); const o2 = readJson(F.keys, {}); o2[a.provider === 'anthropic' ? 'anthropic' : 'openai'] = safeStorage.encryptString(k).toString('base64'); writeJson(F.keys, o2); log({ kind: 'key', user: a.user || '', decision: 'set', provider: a.provider }); return true; },
    keyClear: async (a = {}) => { const o2 = readJson(F.keys, {}); delete o2[a.provider === 'anthropic' ? 'anthropic' : 'openai']; writeJson(F.keys, o2); log({ kind: 'key', user: a.user || '', decision: 'cleared', provider: a.provider }); return true; },
    policySet: async (a = {}) => {
      const cur = policy(), n = { ...cur };
      if (typeof a.researchEnabled === 'boolean') n.researchEnabled = a.researchEnabled;
      if (Array.isArray(a.hosts)) { const h = a.hosts.map(x => String(x).trim().toLowerCase()).filter(Boolean); const bad = h.filter(x => !validHost(x)); if (bad.length) throw new Error('Not a valid public host name: ' + bad.join(', ')); n.hosts = [...new Set(h)].slice(0, 40); }
      if (a.cloud) { const c = a.cloud, provider = c.provider === 'anthropic' ? 'anthropic' : 'openai'; let bu = String(c.baseUrl || '').trim(); if (bu) { const u = new URL(bu); if (u.protocol !== 'https:' || !validHost(u.hostname)) throw new Error('Cloud AI address must be an HTTPS public host'); bu = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')); } const nc = { enabled: !!c.enabled, provider, baseUrl: bu, model: String(c.model || '').slice(0, 80) }; const same = nc.provider === cur.cloud.provider && nc.baseUrl === cur.cloud.baseUrl && nc.model === cur.cloud.model; if (!same) { nc.enabled = false; n.approval = { approved: false }; log({ kind: 'approval', user: a.user || '', decision: 'revoked', reason: 'configuration-changed' }); } n.cloud = nc; if (nc.enabled && !approvalValid(n)) throw new Error('Cloud AI needs a security evaluation and System Owner approval for this configuration before it can be enabled.'); }
      n.approvedBy = String(a.user || '').slice(0, 80); writeJson(F.policy, n); log({ kind: 'policy', user: a.user || '', decision: 'changed', cloud: n.cloud.enabled, hosts: n.hosts.length, research: n.researchEnabled }); return ops.status();
    },
    approvalSet: async (a = {}) => {
      const p = policy(), c = p.cloud; if (!c.baseUrl || !c.model) throw new Error('Save the cloud provider, address and model first.');
      const items = Array.isArray(a.items) ? a.items : []; const missing = EVAL_ITEMS.filter(i => !items.includes(i)); if (missing.length) throw new Error('The security evaluation is incomplete (' + missing.length + ' item(s) not confirmed).');
      const ev = String(a.evaluator || '').trim(); if (ev.length < 3) throw new Error('The name of the person who carried out the security evaluation is required.');
      const owner = String(a.user || '').trim(); if (!owner) throw new Error('The approving System Owner is not identified.');
      if (String(a.confirm || '') !== 'I APPROVE ' + c.provider.toUpperCase()) throw new Error('Confirmation text does not match.');
      const t = now(); p.approval = { approved: true, by: owner.slice(0, 80), at: t.toISOString(), until: new Date(t.getTime() + APPROVAL_DAYS * 86400000).toISOString(), provider: c.provider, baseUrl: c.baseUrl, model: c.model, evaluator: ev.slice(0, 80), evalRef: String(a.evalRef || '').slice(0, 80), items, note: String(a.note || '').slice(0, 500) };
      writeJson(F.policy, p); log({ kind: 'approval', user: owner, decision: 'approved', provider: c.provider, host: new URL(c.baseUrl).hostname, model: c.model, until: p.approval.until }); return ops.status();
    },
    approvalRevoke: async (a = {}) => { const p = policy(); p.approval = { approved: false }; p.cloud.enabled = false; writeJson(F.policy, p); log({ kind: 'approval', user: a.user || '', decision: 'revoked', reason: 'by-owner' }); return ops.status(); },
    egress: async (a = {}) => { try { const l = fs.readFileSync(F.log, 'utf8').trim().split('\n').slice(-Math.min(500, +a.limit || 200)); return l.filter(Boolean).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean).reverse(); } catch { return []; } }
  };
  return { ops, screenText, policy, allowedHosts, files: F };
}
function register(o) {
  const { ipcMain, app, assertAppSender, safeStorage } = o, fs = o.fs || require('fs'), path = o.path || require('path');
  // Same network stack as the WADA monitor: Electron net.fetch (system proxy, Windows certificate store, DNS). Plain Node fetch is only a fallback.
  const fetchImpl = o.fetchImpl || ((u, init) => (o.net && typeof o.net.fetch === 'function' ? o.net.fetch(u, init) : fetch(u, init)));
  const g = createGateway({ app, fs, path, safeStorage, fetchImpl });
  for (const [name, fn] of Object.entries(g.ops)) ipcMain.handle('ai:' + name, async (e, a) => { assertAppSender(e); return fn(a || {}); });
  return g;
}
module.exports = { VERSION, EVAL_ITEMS, createGateway, register, screenText, validHost, DEFAULT_HOSTS };
