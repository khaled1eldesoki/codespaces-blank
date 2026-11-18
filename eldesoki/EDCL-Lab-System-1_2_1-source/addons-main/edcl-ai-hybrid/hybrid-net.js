'use strict';
/*
 * EDCL AI Hybrid - internet + cloud access (main process)
 *   - approved-site page fetch (official + scientific sites; never "open web" for fetching),
 *   - optional online model (Anthropic) that receives ONLY the payload prepared by the privacy gateway,
 *   - web search by the online model limited to the chosen scope: official | scientific (official + scientific) | open (System Owner switch).
 * The API key is stored encrypted by Windows (safeStorage), never returned to the page. https only, every redirect hop re-checked.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ALLOWED = ['wada-ama.org', 'ilac.org', 'iso.org', 'iaf.nu'];
const DEFAULT_SCIENTIFIC = ['pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'europepmc.org', 'doi.org', 'crossref.org', 'nature.com', 'springer.com', 'wiley.com', 'tandfonline.com', 'sciencedirect.com', 'academic.oup.com', 'frontiersin.org', 'mdpi.com', 'tas-cas.org', 'usada.org', 'ukad.org.uk'];
const DEFAULT_ONLINE = { enabled: false, model: 'claude-sonnet-5-5', webSearch: true, maxSearches: 5, scope: 'scientific', allowOpenWeb: false, reasoning: 'standard', consentBy: '', consentAt: '' };
const MAX_PAGE = 30 * 1024 * 1024, MAX_REDIRECTS = 5;
const API_BASE = 'https://api.anthropic.com';
const isoNow = () => new Date().toISOString();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const DOMAIN_RE = /^(?=.{4,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

const htmlToText = html => {
  const title = ((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const main = (String(html).match(/<main[\s\S]*?<\/main>/i) || [String(html)])[0];
  const text = main.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(+n, 0x10ffff)))
    .replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title.replace(/&amp;/g, '&').slice(0, 200), text };
};

const create = (opts = {}) => {
  const dir = opts.dir, fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null), safeStorage = opts.safeStorage, apiBase = opts.apiBase || API_BASE;
  if (!dir) throw new Error('ai-web: dir is required');
  const SET = path.join(dir, 'aih-settings.json'), KEY = path.join(dir, 'aih-key.bin'), onFetched = opts.onFetched || (() => {});

  /* ---------- settings ---------- */
  const load = () => { let j = {}; try { j = JSON.parse(fs.readFileSync(SET, 'utf8')); } catch (e) { /* defaults */ } return { allowedDomains: Array.isArray(j.allowedDomains) && j.allowedDomains.length ? j.allowedDomains : DEFAULT_ALLOWED.slice(), scientificDomains: Array.isArray(j.scientificDomains) ? j.scientificDomains : DEFAULT_SCIENTIFIC.slice(), online: { ...DEFAULT_ONLINE, ...(j.online || {}) } }; };
  const store = s => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(SET, JSON.stringify(s, null, 1)); };
  const hasKey = () => fs.existsSync(KEY);
  const storageOk = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; } };
  const getSettings = () => { const s = load(); return { ...s, hasKey: hasKey(), secureStorage: storageOk(), defaults: { allowedDomains: DEFAULT_ALLOWED, scientificDomains: DEFAULT_SCIENTIFIC } }; };
  const cleanDomain = d => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const setSettings = (p, who) => {
    const s = load();
    for (const [key, min] of [['allowedDomains', 1], ['scientificDomains', 0]]) {
      if (p[key] === undefined) continue;
      if (!Array.isArray(p[key])) throw new Error(key + ' must be a list');
      const list = [...new Set(p[key].map(cleanDomain).filter(Boolean))];
      for (const d of list) if (!DOMAIN_RE.test(d) || /^\d+(\.\d+){3}$/.test(d)) throw new Error('"' + d + '" is not a valid website domain (use names such as wada-ama.org; IP addresses and local names are not allowed)');
      if (list.length < min) throw new Error('At least one approved website is required'); if (list.length > 60) throw new Error('At most 60 websites per list');
      s[key] = list;
    }
    if (p.online) {
      const o = { ...s.online }, q = p.online;
      if (q.model !== undefined) { const m = String(q.model).trim(); if (!/^[A-Za-z0-9._:-]{3,80}$/.test(m)) throw new Error('Model name is not valid'); o.model = m; }
      if (q.webSearch !== undefined) o.webSearch = !!q.webSearch;
      if (q.scope !== undefined) { if (!['official', 'scientific', 'open'].includes(q.scope)) throw new Error('Scope must be official, scientific or open'); o.scope = q.scope; }
      if (q.allowOpenWeb !== undefined) { o.allowOpenWeb = !!q.allowOpenWeb; if (!o.allowOpenWeb && o.scope === 'open') o.scope = 'scientific'; }
      if (o.scope === 'open' && !o.allowOpenWeb) throw new Error('Open-web search must first be allowed by the System Owner');
      if (q.reasoning !== undefined) { if (!['standard', 'extended'].includes(q.reasoning)) throw new Error('Reasoning must be standard or extended'); o.reasoning = q.reasoning; }
      if (q.maxSearches !== undefined) { const n = Number(q.maxSearches); if (!(n >= 1 && n <= 10)) throw new Error('Searches per question must be between 1 and 10'); o.maxSearches = Math.floor(n); }
      if (q.enabled !== undefined) {
        if (q.enabled) {
          if (!hasKey()) throw new Error('Store the API key first');
          if (!String(who || '').trim()) throw new Error('The System Owner who approves online use must be recorded');
          if (!s.online.enabled) { o.consentBy = String(who).slice(0, 80); o.consentAt = isoNow(); }
        }
        o.enabled = !!q.enabled;
      }
      s.online = o;
    }
    store(s); return getSettings();
  };
  const setKey = k => {
    const key = String(k || '').trim();
    if (!/^[\x21-\x7e]{20,300}$/.test(key) || !/^sk-/.test(key)) throw new Error('This does not look like an API key (it should start with "sk-" and contain no spaces)');
    if (!storageOk()) throw new Error('Windows secure storage is not available on this PC, so the key cannot be stored safely. Online AI cannot be used here.');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(KEY, safeStorage.encryptString(key), { mode: 0o600 }); return getSettings();
  };
  const clearKey = () => { try { fs.unlinkSync(KEY); } catch (e) { /* none */ } const s = load(); s.online.enabled = false; store(s); return getSettings(); };
  const readKey = () => { if (!hasKey()) throw new Error('No API key stored'); if (!storageOk()) throw new Error('Windows secure storage is not available'); return safeStorage.decryptString(fs.readFileSync(KEY)); };

  /* ---------- approved-site fetch ---------- */
  const hostAllowed = (host, list) => { host = String(host || '').toLowerCase(); return list.some(d => host === d || host.endsWith('.' + d)); };
  const checkUrl = (url, list) => {
    let u; try { u = new URL(String(url)); } catch (e) { throw new Error('This is not a valid web address'); }
    if (u.protocol !== 'https:') throw new Error('Only https:// addresses are allowed');
    if (u.username || u.password) throw new Error('Addresses with a user name or password are not allowed');
    if (u.port && u.port !== '443') throw new Error('Only the standard https port is allowed');
    if (!hostAllowed(u.hostname, list)) throw new Error(u.hostname + ' is not on the approved websites list. The System Owner can add it in AI Assistant > Settings.');
    u.hash = ''; return u;
  };
  const fetchPage = async (url, o = {}) => {
    if (!fetchImpl) throw new Error('No network API available');
    const st = load(), list = [...new Set([...st.allowedDomains, ...st.scientificDomains])]; let u = checkUrl(url, list), hops = 0;
    const timeoutMs = o.timeoutMs || 45000, ctl = new AbortController(); let timer;
    const to = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error('The website did not answer in time')); }, timeoutMs); });
    try {
      for (;;) {
        const res = await Promise.race([fetchImpl(u.href, { headers: { 'User-Agent': 'EDCL-Lab-System-AI-Hybrid/2.0 (approved public pages only)', Accept: 'text/html,application/pdf,text/plain;q=0.9' }, redirect: 'manual', signal: ctl.signal }), to]);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers && res.headers.get && res.headers.get('location'); if (!loc) throw new Error('The website redirected without a destination');
          if (++hops > MAX_REDIRECTS) throw new Error('Too many redirects');
          u = checkUrl(new URL(loc, u.href).href, list); continue; // every hop must be approved too
        }
        if (res.status < 200 || res.status >= 300) throw new Error('The website answered HTTP ' + res.status);
        const ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
        const buf = Buffer.from(await Promise.race([res.arrayBuffer(), to]));
        if (!buf.length) throw new Error('The page is empty'); if (buf.length > (o.maxBytes || MAX_PAGE)) throw new Error('The file is larger than ' + Math.round((o.maxBytes || MAX_PAGE) / 1048576) + ' MB');
        const out = { url: u.href, status: res.status, contentType: ct.split(';')[0], sha256: sha(buf), size: buf.length, fetchedAt: isoNow() };
        if (buf.slice(0, 5).toString() === '%PDF-' || ct.includes('application/pdf')) { if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('The file is not a valid PDF'); return (onFetched(out.sha256, out.url), { ...out, kind: 'pdf', bytes: buf, title: decodeURIComponent(path.basename(u.pathname)) }); }
        if (ct.includes('text/html') || ct.includes('application/xhtml')) { const t = htmlToText(buf.toString('utf8')); if (t.text.length < 80) throw new Error('No readable text found on the page (it may need JavaScript or a login)'); onFetched(out.sha256, out.url); return { ...out, kind: 'html', title: t.title || u.hostname, text: t.text }; }
        if (ct.startsWith('text/')) { onFetched(out.sha256, out.url); return { ...out, kind: 'text', title: path.basename(u.pathname) || u.hostname, text: buf.toString('utf8') }; }
        throw new Error('Unsupported content type (' + (ct || 'unknown') + '). Only web pages, PDF and plain text are accepted');
      }
    } finally { clearTimeout(timer); }
  };

  /* ---------- online model (Anthropic Messages API) ---------- */
  const callApi = async (body, timeoutMs = 120000) => {
    const key = readKey(), ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(apiBase + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal: ctl.signal });
      const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { /* not json */ }
      if (!res.ok) {
        const m = j && j.error && j.error.message ? String(j.error.message).slice(0, 200) : '';
        throw new Error(res.status === 401 ? 'The API key was rejected (401). Check the key in Settings.' : res.status === 403 ? 'The API key is not allowed to use this model or feature (403). ' + m : res.status === 429 ? 'The online AI service is busy or the usage limit was reached (429). Try again later.' : res.status >= 500 ? 'The online AI service is temporarily unavailable (' + res.status + ').' : 'The online AI service refused the request (' + res.status + '). ' + m);
      }
      if (!j) throw new Error('The online AI service returned an unreadable answer'); return j;
    } catch (e) { if (e.name === 'AbortError') throw new Error('The online AI service took too long to answer'); throw e; } finally { clearTimeout(t); }
  };
  const SYSTEM = web => 'You are the EDCL Technical Documents and Scientific Research Assistant for an anti-doping laboratory. ' +
    'You receive a PUBLIC question and numbered PUBLIC excerpts of official documents. Cite the excerpts you use as [1], [2]. ' + (web ? 'If the excerpts do not answer the question you may search the web (only the websites you are permitted to search); say clearly which statements come from the excerpts [n] and which from a web page, and give the page address. ' : 'Answer only from the excerpts; if the information is not there, say so. ') +
    'Excerpts marked PREVIOUS or OLDER are superseded editions: never present them as current requirements; when asked what changed, state the CURRENT and the PREVIOUS wording separately. Never invent limits, dates, document numbers or references. Answer in the language of the question, concisely. Your answer is not an official WADA interpretation; remind the user to confirm in the official document when a decision depends on it.';
  // The ONLY thing sent is what the privacy gateway prepared: { question, excerpts[] } - stateless, no chat history.
  const cloudAsk = async ({ payload, web }) => {
    const s = load(); if (!s.online.enabled) throw new Error('Online AI is switched off (System Owner: AI Assistant > Settings)');
    if (!payload || !payload.question) throw new Error('Nothing approved to send');
    const ex = (payload.excerpts || []).map((x, i) => `[${i + 1}] (${x.name || 'document'}${x.version ? ' ' + x.version : ''}${x.role === 'previous' ? ' - PREVIOUS edition' : x.role === 'older' ? ' - OLDER edition' : x.role === 'current' ? ' - CURRENT edition' : ''}, page ${x.page || '?'})\n${x.text}`).join('\n\n');
    const reasoning = s.online.reasoning === 'extended', useWeb = !!web && s.online.webSearch;
    const body = { model: s.online.model, max_tokens: reasoning ? 6000 : 1800, system: SYSTEM(useWeb), messages: [{ role: 'user', content: `Excerpts:\n${ex || '(none)'}\n\nQuestion: ${payload.question}`.slice(0, 60000) }] };
    if (reasoning) body.thinking = { type: 'enabled', budget_tokens: 3000 };
    let scopeDomains = null;
    if (useWeb) {
      const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: s.online.maxSearches };
      if (s.online.scope === 'open') { if (!s.online.allowOpenWeb) throw new Error('Open-web search is not allowed'); } else { scopeDomains = s.online.scope === 'scientific' ? [...new Set([...s.allowedDomains, ...s.scientificDomains])] : s.allowedDomains.slice(); tool.allowed_domains = scopeDomains; }
      body.tools = [tool];
    }
    let text = '', sources = [], searches = 0, content = [], stop; const msgs = body.messages;
    for (let turn = 0; turn < 4; turn++) {
      const j = await callApi(body); stop = j.stop_reason; content = Array.isArray(j.content) ? j.content : [];
      for (const b of content) {
        if (b.type === 'text') { text += b.text || ''; for (const c of (b.citations || [])) if (c && c.url) sources.push({ url: c.url, title: c.title || c.url }); }
        else if (b.type === 'server_tool_use') searches++;
        else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r && r.url) sources.push({ url: r.url, title: r.title || r.url, age: r.page_age || '' });
      }
      if (stop !== 'pause_turn') break; body.messages = [...msgs, { role: 'assistant', content }];
    }
    const seen = new Set(); sources = sources.filter(x => { if (scopeDomains) { try { if (!hostAllowed(new URL(x.url).hostname, scopeDomains)) return false; } catch (e) { return false; } } if (seen.has(x.url)) return false; seen.add(x.url); return true; });
    if (!text.trim()) throw new Error('The online AI service returned no text' + (stop === 'refusal' ? ' (it declined to answer)' : ''));
    return { text: text.trim(), sources, searches, model: s.online.model, web: useWeb, scope: useWeb ? s.online.scope : null, reasoning: reasoning ? 'extended' : 'standard' };
  };
  const test = async () => { const st = load(); if (!st.online.enabled) throw new Error('Online AI is switched off'); const j = await callApi({ model: st.online.model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }, 30000); return { ok: true, model: st.online.model, reply: (j.content || []).map(b => b.text || '').join('').slice(0, 20) }; };

  return { getSettings, setSettings, setKey, clearKey, fetchPage, cloudAsk, test, checkUrl: u => checkUrl(u, load().allowedDomains), hostAllowed, htmlToText };
};

module.exports = { create, htmlToText, DEFAULT_ALLOWED, DEFAULT_SCIENTIFIC, DEFAULT_ONLINE };
