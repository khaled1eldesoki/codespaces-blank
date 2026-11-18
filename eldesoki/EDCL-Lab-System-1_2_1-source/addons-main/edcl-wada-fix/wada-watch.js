'use strict';
/*
 * EDCL WADA Monitor Fix - DOCUMENT WATCH (main process)
 *
 * The original monitor reads WADA's index pages, so it notices when a NEW link appears but never opens the pages of the
 * documents themselves. This stage opens every ISL / TD / TL / Guideline page (and every directly linked WADA file) and records:
 *    publication date, "updated" date, status (In force / Archived), version label, download link and the SHA-256 of the file.
 * Each time ANY of these changes a NEW version row is appended; old rows and old files are never changed or deleted.
 *    wada_doc_versions   append-only history (one row per distinct page state + file)
 *    WADA Documents/versions/<item>/<time>-<sha8>-<name>   the stored official files (written once, never overwritten)
 * New or revised documents raise a notification in the existing WADA Updates list (bell + desktop).
 * Newly published Technical Letters are also discovered from WADA's Technical Letters index page.
 * Failure rules: a page that could not be checked is counted as FAILED (never as "no change"); the result says "complete" only
 * when every due document was actually checked.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = 'www.wada-ama.org';
const UA = 'EDCL-Lab-System/1.0 (+public WADA page monitor; contact: laboratory quality unit)'; // identical to the monitor's own, so WADA sees one consistent client
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const isoNow = () => new Date().toISOString();
const MAX_FILE = 100 * 1024 * 1024;
const ACCEPT = 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5'; // the same Accept string the original monitor uses
const MAGIC = { '.pdf': b => b.slice(0, 5).toString() === '%PDF-', '.docx': b => b[0] === 0x50 && b[1] === 0x4b, '.xlsx': b => b[0] === 0x50 && b[1] === 0x4b, '.doc': b => b[0] === 0xd0 && b[1] === 0xcf, '.xls': b => b[0] === 0xd0 && b[1] === 0xcf };
const DEFAULTS = { enabled: true, pageRecheckHours: 12, maxPagesPerRun: 45, maxFilesPerRun: 45, archiveFiles: true, maxAttempts: 3, backoffBaseMs: 1500, timeoutMs: 30000, categories: ['standards', 'prohibited_list'] };
const CONN = ['dns', 'network', 'timeout', 'proxy', 'tls_certificate'];

/* ---------------- document identity ---------------- */
const lastSeg = u => { try { return decodeURIComponent(String(u || '').split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || ''); } catch (e) { return ''; } };
const verOf = s => { const m = String(s || '').match(/(?:(?<![A-Za-z])v|version\s*|index\s+)(\d+(?:\.\d+)?)/i); return m ? parseFloat(m[1]) : 0; };
const pathDate = u => { const m = String(u || '').match(/\/sites\/default\/files\/(\d{4})-(\d{2})\//); return m ? m[1] + '-' + m[2] : ''; };
const STD = 'ISL|ISTI|ISPPPI|ISTUE|ISCCS|ISRM|ISE|ISDP';
const familyOf = (title, url) => {
  const t = String(title || ''), f = lastSeg(url), both = t + ' ' + f; let m;
  const yr = () => { const y = both.match(/(20\d{2})/); return y ? +y[1] : null; };
  const lang = lastSeg(url).match(/[_-](fr|es|ru|ar|de|pt|zh|it)(?=[_.-])/i) || (/^\s*R[ée]sum[ée]\b/i.test(t) ? [null, 'fr'] : null);
  const out = (key, label, type, year, ver) => lang ? { key: key + '-' + lang[1].toUpperCase(), label: label + ' (' + lang[1].toUpperCase() + ')', type, year, ver } : { key, label, type, year, ver };
  if ((m = both.match(/(?<![A-Za-z])TD[\s_-]?((?:19|20)\d{2})[\s_-]*index(?![a-z])/i))) return out('TD-INDEX', 'Technical Documents Index', 'TD', +m[1], verOf(both));
  if ((m = t.match(/^\s*TD[\s_-]?((?:19|20)\d{2})([A-Z][A-Z0-9]*(?:\/[A-Z0-9]+)?)(?![a-z])/i) || f.match(/^td((?:19|20)\d{2})([a-z][a-z0-9]{1,9})/i) || both.match(/(?<![A-Za-z])TD[\s_-]?((?:19|20)\d{2})([A-Z][A-Z0-9]{1,9})(?![a-z])/))) { const code = m[2].replace(/\//g, '').toUpperCase(); return out('TD-' + code, 'Technical Document ' + code, 'TD', +m[1], verOf(both)); }
  if ((m = both.match(/(?<![A-Za-z])TL[\s_-]?(\d{1,3})(?!\d)/i))) return out('TL-' + (+m[1]), 'Technical Letter TL' + (+m[1]), 'TL', null, verOf(both));
  if ((m = both.match(new RegExp('(?<![A-Za-z])(' + STD + ')(?![A-Za-z])')))) return out('STD-' + m[1], 'International Standard ' + m[1], 'Standard', yr(), verOf(both));
  if (/international[\s_-]standard[\s_-](?:for[\s_-])?laborator/i.test(both)) return out('STD-ISL', 'International Standard ISL', 'Standard', yr(), verOf(both));
  if (/guideline/i.test(both)) { const norm = t.toLowerCase().replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70); return out('GL-' + norm, t.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim() || 'Guideline', 'Guideline', yr(), verOf(both)); }
  if (/monitoring[\s_-]program/i.test(both)) return out('PL-MONITORING', 'Monitoring Program', 'Prohibited List', yr(), 0);
  if (/explanatory[\s_-]note|summary[\s_-]of[\s_-]major/i.test(both)) return out('PL-NOTES', 'Prohibited List - Summary of Major Modifications', 'Prohibited List', yr(), 0);
  if (/prohibited[\s_-]list|\d{4}list_en/i.test(both)) return out('PL', 'Prohibited List', 'Prohibited List', yr(), 0);
  const norm = t.toLowerCase().replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b(v|version)\s*\d+(\.\d+)?\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || f.toLowerCase();
  return out('DOC-' + norm, t.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim() || f, 'Other', yr(), verOf(both));
};
// Which monitored index items are document PAGES worth opening?
const docPageType = (title, url) => { const t = String(title || ''), u = String(url || '');
  if (/^\s*TD[\s_-]?\d{4}/i.test(t) || /\/lab-documents\/td\d{4}/i.test(u)) return 'TD';
  if (/^\s*TL[\s_-]?\d+/i.test(t) || /\/(?:[a-z-]+\/)?tl\d+(?:[#?/]|$)/i.test(u)) return 'TL';
  if (/International Standard for Laboratories/i.test(t) || /international-standard-lab/i.test(u)) return 'ISL';
  if (/guideline/i.test(t) && !/^\s*guidelines\s*$/i.test(t) && !/^#/.test(u.replace(/^https?:\/\/[^/]+/, ''))) return 'Guideline';
  return null; };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const shortDate = t => { const m = String(t || '').match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})/); if (!m) return ''; const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (!mo) return ''; const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return y + '-' + String(mo).padStart(2, '0') + '-' + String(+m[1]).padStart(2, '0'); };
// readable text of the WHOLE page (used when the page has no usable <main> block, which real WADA pages sometimes lack)
const htmlToText = html => String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(+n, 0x10ffff))).replace(/\b(cookie settings|accept all)\b/gi, ' ').replace(/\s+/g, ' ').trim();
const labelOf = (text, title, fileUrl) => { const m = String(text || '').match(/\bversion\s*:?\s*(\d+(?:\.\d+)?)/i) || String(fileUrl || '').match(/(?:^|[_\/-])v(\d+(?:\.\d+)?)(?=[_.-])/i) || String(title || '').match(/\bv(?:ersion)?\s*(\d+(?:\.\d+)?)/i); return m ? m[1] : ''; };

const create = (opts = {}) => {
  const db = opts.db, fetchImpl = opts.fetchImpl, root = opts.root, officialUrl = opts.officialUrl, parseResourcePage = opts.parseResourcePage, parseIndex = opts.parseIndex;
  const classifyError = opts.classifyError || (() => ({ category: 'unknown', retryable: false })), sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms))), nowFn = opts.now || (() => new Date());
  const onNotify = opts.onNotify || (() => {}), onChange = opts.onChange || (() => {});
  if (!db || !fetchImpl || !root || !officialUrl || !parseResourcePage) throw new Error('wada-watch: db, fetchImpl, root, officialUrl and parseResourcePage are required');
  const dir = path.join(root, 'WADA Documents', 'versions');
  db.exec(`CREATE TABLE IF NOT EXISTS wada_doc_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, seen_at TEXT NOT NULL, title TEXT, published TEXT, updated TEXT, status TEXT, version_label TEXT, page_fp TEXT NOT NULL, file_url TEXT, file_sha256 TEXT NOT NULL DEFAULT '', file_path TEXT, file_size INTEGER, etag TEXT, last_modified TEXT, reason TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_docver_item ON wada_doc_versions(item_id);
    CREATE TABLE IF NOT EXISTS wada_doc_state (item_id INTEGER PRIMARY KEY, dtype TEXT, last_checked TEXT, last_ok TEXT, result TEXT, error TEXT, page_etag TEXT, page_last_modified TEXT, fail_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS wada_fix_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wada_doc_diag (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, item_id INTEGER, url TEXT, kind TEXT, http_status INTEGER, content_type TEXT, bytes INTEGER, summary TEXT, sample TEXT);`);
  let running = null;
  const getFix = (k, d) => { const r = db.prepare('SELECT value FROM wada_fix_state WHERE key=?').get(k); if (!r) return d; try { return JSON.parse(r.value); } catch (e) { return d; } };
  const setFix = (k, v) => db.prepare('INSERT INTO wada_fix_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
  const getPrefs = () => { const o = { ...DEFAULTS, categories: DEFAULTS.categories.slice() }; for (const [k, v] of Object.entries(getFix('watchPrefs', {}))) o[k] = v; return o; };
  const setPrefs = p => { const cur = getPrefs(), n = { ...cur };
    for (const [k, lo, hi] of [['pageRecheckHours', 1, 720], ['maxPagesPerRun', 1, 500], ['maxFilesPerRun', 1, 500], ['maxAttempts', 1, 8]]) if (p[k] !== undefined) { const v = Number(p[k]); if (!(v >= lo && v <= hi)) throw new Error(k + ' must be between ' + lo + ' and ' + hi); n[k] = v; }
    if (p.enabled !== undefined) n.enabled = !!p.enabled; if (p.archiveFiles !== undefined) n.archiveFiles = !!p.archiveFiles;
    setFix('watchPrefs', n); return n; };

  /* ----- network with retry / back-off / classification ----- */
  const httpErr = (url, status, res) => { const e = new Error('HTTP ' + status); e.status = status; e.category = status === 404 || status === 410 ? 'not_found' : status === 401 || status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : status === 202 ? 'challenge' : status >= 500 || status === 408 ? 'server_error' : 'http_status'; e.retryable = status === 408 || status === 429 || status >= 500; e.retryAfter = res && res.headers && res.headers.get ? res.headers.get('retry-after') : null; return e; };
  const getOnce = async (url, headers, timeoutMs) => {
    const u = new URL(url); if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== HOST) { const e = new Error('Only HTTPS addresses on ' + HOST + ' are allowed'); e.category = 'blocked'; e.retryable = false; throw e; }
    const ctl = new AbortController(); let timer; const to = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); const e = new Error('timeout after ' + timeoutMs + ' ms'); e.code = 'ETIMEDOUT'; rej(e); }, timeoutMs); });
    try {
      const res = await Promise.race([fetchImpl(u.href, { headers: { 'User-Agent': UA, Accept: ACCEPT, 'Accept-Language': 'en-US,en;q=0.9', ...(headers || {}) }, redirect: 'follow', signal: ctl.signal }), to]);
      if (res.url && !officialUrl(res.url, u.href)) { const e = new Error('Redirected outside wada-ama.org; not followed'); e.category = 'redirect_offsite'; e.retryable = false; throw e; }
      if (res.status === 304) return { status: 304, headers: res.headers };
      if (res.status < 200 || res.status >= 300) throw httpErr(url, res.status, res);
      const buf = Buffer.from(await Promise.race([res.arrayBuffer(), to])); return { status: res.status, headers: res.headers, buf, url: res.url };
    } finally { clearTimeout(timer); }
  };
  const get = async (url, headers, prefs) => {
    let last; for (let a = 1; a <= prefs.maxAttempts; a++) {
      try { return await getOnce(url, headers, prefs.timeoutMs); } catch (e) {
        const c = classifyError(e); e.category = e.category || c.category; e.retryable = e.retryable !== undefined ? e.retryable : !!c.retryable; e.attempt = a; last = e;
        if (!e.retryable || a >= prefs.maxAttempts) throw e; let wait = prefs.backoffBaseMs * Math.pow(2, a - 1); if (e.retryAfter && /^\d+$/.test(String(e.retryAfter))) wait = Math.max(wait, Math.min(60000, +e.retryAfter * 1000)); await sleep(wait);
      }
    } throw last;
  };
  const hdr = (h, n) => { try { return (h && h.get && h.get(n)) || null; } catch (e) { return null; } };
  const saveDiag = (item, url, kind, res, html, summary) => { try { db.prepare('INSERT INTO wada_doc_diag (at,item_id,url,kind,http_status,content_type,bytes,summary,sample) VALUES (?,?,?,?,?,?,?,?,?)').run(isoNow(), item ? item.id : null, url, kind, res ? res.status : null, res && res.headers && res.headers.get ? res.headers.get('content-type') : null, res && res.buf ? res.buf.length : null, summary, String(html || '').slice(0, 3000)); db.prepare('DELETE FROM wada_doc_diag WHERE id NOT IN (SELECT id FROM wada_doc_diag ORDER BY id DESC LIMIT 40)').run(); } catch (x) { /* diagnostics must never break a check */ } };
  const recordError = (runId, url, e, stage) => { try { db.prepare('INSERT INTO wada_errors (run_id,at,source_url,stage,category,http_status,attempt,retryable,message,action) VALUES (?,?,?,?,?,?,?,?,?,?)').run(runId || null, isoNow(), String(url), stage || 'document', e.category || 'unknown', e.status || null, e.attempt || null, e.retryable ? 1 : 0, ('Document check: ' + String(e.message || e)).slice(0, 500), null); } catch (x) { /* logging must never break a check */ } };

  /* ----- helpers on the monitor database ----- */
  const latestRow = itemId => db.prepare('SELECT * FROM wada_doc_versions WHERE item_id=? ORDER BY id DESC LIMIT 1').get(itemId);
  const saveFile = (itemId, fileUrl, buf) => {
    const ext = path.extname(new URL(fileUrl).pathname).toLowerCase(), h = sha(buf), d = path.join(dir, String(itemId)); fs.mkdirSync(d, { recursive: true });
    const stamp = isoNow().replace(/[-:T]/g, '').slice(0, 14), base = path.basename(new URL(fileUrl).pathname).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'document' + ext;
    const existing = db.prepare('SELECT file_path FROM wada_doc_versions WHERE item_id=? AND file_sha256=? AND file_path IS NOT NULL LIMIT 1').get(itemId, h); if (existing && fs.existsSync(existing.file_path)) return existing.file_path; // same bytes: reuse, never write twice
    const file = path.join(d, stamp + '-' + h.slice(0, 8) + '-' + base); fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o644 }); return file; };
  const notify = (item, kind, fp, title, significance, fresh) => { const n = db.prepare('INSERT OR IGNORE INTO wada_notifications (item_id,kind,fingerprint,title,source,category,detected_at,significance) VALUES (?,?,?,?,?,?,?,?)').run(item.id, kind, fp, title, 'WADA document check', item.category, isoNow(), significance); if (n.changes) fresh.push({ id: Number(n.lastInsertRowid), title, category: item.category, kind }); };
  const touchItem = (item, status, significance, changed) => { const when = isoNow(); db.prepare('UPDATE wada_items SET last_checked=?, last_status=?, last_changed=COALESCE(?,last_changed), signals=COALESCE(?,signals) WHERE id=?').run(when, status, status === 'changed' ? when : null, status === 'changed' ? JSON.stringify({ significance, changePct: null, changedFields: changed || [], verified: false, detectedAt: when }) : null, item.id); };
  const setState = (item, dtype, result, error, extra = {}) => { const ok = result === 'ok' || result === 'unchanged'; const prev = db.prepare('SELECT * FROM wada_doc_state WHERE item_id=?').get(item.id);
    db.prepare('INSERT INTO wada_doc_state (item_id,dtype,last_checked,last_ok,result,error,page_etag,page_last_modified,fail_count) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET dtype=excluded.dtype,last_checked=excluded.last_checked,last_ok=COALESCE(excluded.last_ok,wada_doc_state.last_ok),result=excluded.result,error=excluded.error,page_etag=COALESCE(excluded.page_etag,wada_doc_state.page_etag),page_last_modified=COALESCE(excluded.page_last_modified,wada_doc_state.page_last_modified),fail_count=excluded.fail_count')
      .run(item.id, dtype, isoNow(), ok ? isoNow() : null, result, error || null, extra.etag || null, extra.lastModified || null, ok ? 0 : ((prev && prev.fail_count) || 0) + 1); };

  /* ----- check one document PAGE (or one direct FILE) ----- */
  const fetchFile = async (item, fileUrl, last, prefs, out, pageUrl) => {
    const ext = path.extname(new URL(fileUrl).pathname).toLowerCase(); if (!MAGIC[ext]) return null;
    const cond = {}; if (last && last.file_url === fileUrl) { if (last.etag) cond['If-None-Match'] = last.etag; if (last.last_modified) cond['If-Modified-Since'] = last.last_modified; }
    out.filesChecked++; let res = null, tried = 0;
    // some servers answer a file request with an EMPTY body unless it looks like a normal browser click: first with the page as Referer, then plain, then without caches
    const variants = [{ ...cond, ...(pageUrl ? { Referer: pageUrl } : {}) }, { ...cond }, { 'Cache-Control': 'no-cache', Pragma: 'no-cache', ...(pageUrl ? { Referer: pageUrl } : {}) }];
    for (const h of variants) { tried++; res = await get(fileUrl, h, prefs); if (res.status === 304 && last) break; if (res.buf && res.buf.length) break; }
    if (res.status === 304 && last) return { sha: last.file_sha256, path: last.file_path, size: last.file_size, etag: last.etag, lastModified: last.last_modified, unchanged: true };
    const buf = res.buf; if (!buf || !buf.length) { saveDiag(item, fileUrl, 'document file', res, '', 'EMPTY file: HTTP ' + res.status + ', content-length ' + (hdr(res.headers, 'content-length') || '?') + ', content-type ' + (hdr(res.headers, 'content-type') || '?') + ', final address ' + (res.url || fileUrl) + ', ' + tried + ' request variant(s) tried'); const e = new Error('The file download returned no data (HTTP ' + res.status + ', ' + tried + ' attempts)'); e.category = 'empty_response'; throw e; }
    if (buf.length > MAX_FILE) { const e = new Error('File larger than 100 MB'); e.category = 'too_large'; throw e; }
    if (!MAGIC[ext](buf)) { saveDiag(item, fileUrl, 'document file', res, buf.toString('utf8', 0, 1500), 'File content does not match its extension: HTTP ' + res.status + ', ' + buf.length + ' bytes, content-type ' + (hdr(res.headers, 'content-type') || '?')); const e = new Error('File content does not match its extension - rejected'); e.category = 'bad_file'; throw e; }
    const h = sha(buf); const p = prefs.archiveFiles ? saveFile(item.id, fileUrl, buf) : null; return { sha: h, path: p, size: buf.length, etag: hdr(res.headers, 'etag'), lastModified: hdr(res.headers, 'last-modified') };
  };
  const checkOne = async (item, dtype, prefs, ctx, out, fresh) => {
    const st = db.prepare('SELECT * FROM wada_doc_state WHERE item_id=?').get(item.id), last = latestRow(item.id);
    let meta = { published: '', updated: '', status: '', label: '', fileUrl: '', title: item.title }, pageEtag = null, pageLm = null, pageUnchanged = false;
    if (item.kind === 'document') { meta.fileUrl = item.url; }
    else {
      out.pagesChecked++; const cond = {}; if (st && st.page_etag) cond['If-None-Match'] = st.page_etag; if (st && st.page_last_modified) cond['If-Modified-Since'] = st.page_last_modified;
      const res = await get(item.url, { ...cond }, prefs);
      if (res.status === 304 && last) { pageUnchanged = true; meta = { published: last.published || '', updated: last.updated || '', status: last.status || '', label: last.version_label || '', fileUrl: last.file_url || '', title: last.title || item.title }; pageEtag = st.page_etag; pageLm = st.page_last_modified; }
      else {
        pageEtag = hdr(res.headers, 'etag'); pageLm = hdr(res.headers, 'last-modified'); const html = res.buf.toString('utf8'), rp = parseResourcePage(html, item.url, item.category, item.title) || { page: { text: '', textLen: 0, parts: {} }, docs: [] };
        const body = rp.page.textLen >= 200 ? rp.page.text : htmlToText(html), pt = { ...(rp.page.parts || {}) };
        if (!pt.published) pt.published = shortDate((body.match(/Publication date\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/i) || [])[1] || ''); if (!pt.status) { const st2 = body.match(/\b(In force|Archived|Draft|Withdrawn|Under review)\b/i); pt.status = st2 ? st2[1] : ''; }
        const ttl = (rp.page.title && rp.page.title !== item.url ? rp.page.title : '') || ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').replace(/\s*\|\s*World Anti.?Doping Agency.*$/i, '').trim();
        const dl = rp.docs.find(d => d.primary) || (rp.docs.filter(d => /\.pdf(\?|$)/i.test(d.url)).length >= 1 ? rp.docs.find(d => /\.pdf(\?|$)/i.test(d.url)) : null);
        // a page counts as readable when we found ANYTHING that identifies the document (date, status, file) or enough text; otherwise it is a failure with details
        if (!(pt.published || pt.status || dl || body.length >= 200)) { const summary = 'HTTP ' + res.status + ', ' + res.buf.length + ' bytes, content-type ' + (hdr(res.headers, 'content-type') || '?') + ', title "' + String(ttl).slice(0, 60) + '", readable text ' + body.length + ' characters, ' + (/<main[\s>]/i.test(html) ? 'has' : 'no') + ' <main> block, starts: "' + body.slice(0, 100) + '"'; saveDiag(item, item.url, 'document page', res, html, summary); const e = new Error('Page loaded but its content was not recognised - the WADA page layout may have changed or the page is a block / challenge page (' + summary + ')'); e.category = 'parse_failed'; e.retryable = false; throw e; }
        meta = { published: pt.published || '', updated: pt.updated || '', status: pt.status || '', label: labelOf(body, ttl || item.title, dl && dl.url), fileUrl: dl ? dl.url : '', title: ttl || item.title };
      }
    }
    let file = null;
    if (meta.fileUrl) {
      try { file = await fetchFile(item, meta.fileUrl, last, prefs, out, item.kind === 'index' ? item.url : null); } // always asked (conditional request, usually 304): a file replaced under the SAME address is still noticed
      catch (e) {
        const c = classifyError(e); e.category = e.category || c.category;
        // The page information (or, for a direct file, its address and title) is known. A file that cannot be downloaded is a WARNING for that document - but a broken CONNECTION is still a failure.
        if (CONN.includes(e.category) || ['cancelled', 'redirect_offsite', 'blocked'].includes(e.category)) throw e; // security-relevant problems are never downgraded to warnings
        out.fileWarnings = (out.fileWarnings || 0) + 1; if (!out.fileWarning) out.fileWarning = { title: item.title, category: e.category, message: String(e.message).slice(0, 160) }; recordError(ctx && ctx.runId, meta.fileUrl, e, 'document file');
        file = last && last.file_sha256 && last.file_url === meta.fileUrl ? { sha: last.file_sha256, path: last.file_path, size: last.file_size, etag: last.etag, lastModified: last.last_modified, carried: true } : null;
      }
    }
    const fsha = file ? file.sha : '', pfp = sha(JSON.stringify([meta.published, meta.updated, meta.status, meta.label, meta.fileUrl, meta.title]));
    const same = last && last.page_fp === pfp && last.file_sha256 === fsha;
    if (same) { setState(item, dtype, 'unchanged', null, { etag: pageEtag, lastModified: pageLm }); touchItem(item, item.last_status === 'failed' ? 'unchanged' : item.last_status, null); out.unchanged++; return; }
    const pageChanged = !!last && last.page_fp !== pfp, fileChanged = !!last && last.file_sha256 !== fsha && !!fsha && !!last.file_sha256, fileAvailable = !!last && !pageChanged && !last.file_sha256 && !!fsha;
    const reason = !last ? 'first' : fileAvailable ? 'file_available' : pageChanged && fileChanged ? 'revised' : fileChanged ? 'file_changed' : 'page_changed';
    const ins = db.prepare('INSERT INTO wada_doc_versions (item_id,seen_at,title,published,updated,status,version_label,page_fp,file_url,file_sha256,file_path,file_size,etag,last_modified,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(item.id, isoNow(), meta.title, meta.published, meta.updated, meta.status, meta.label, pfp, meta.fileUrl || null, fsha, file ? file.path : null, file ? file.size : null, file ? file.etag : null, file ? file.lastModified : null, reason); // append-only: a return to an earlier state is a NEW row, history is never merged or edited
    const verId = Number(ins.lastInsertRowid); setState(item, dtype, 'ok', null, { etag: pageEtag, lastModified: pageLm });
    if (!last) { out.firstSeen++; touchItem(item, item.last_status === 'failed' ? 'unchanged' : item.last_status, null); return; }
    if (fileAvailable) { out.unchanged++; touchItem(item, item.last_status === 'failed' ? 'unchanged' : item.last_status, null); return; } // the file is now readable: stored silently, nothing was revised
    out.revised++; const what = []; if (last.published !== meta.published && meta.published) what.push('published ' + (last.published || '?') + ' -> ' + meta.published); if (last.status !== meta.status && meta.status) what.push('status ' + (last.status || '?') + ' -> ' + meta.status); if (last.version_label !== meta.label && meta.label) what.push('version ' + (last.version_label || '?') + ' -> ' + meta.label); if (last.updated !== meta.updated && meta.updated && !what.length) what.push('page updated ' + meta.updated); if (fileChanged) what.push('new file');
    const significance = fileChanged ? 'revised_file' : 'revised_page'; touchItem(item, 'changed', significance, [fileChanged ? 'file' : '', pageChanged ? 'page' : ''].filter(Boolean));
    notify(item, 'changed', 'v' + verId + ':' + pfp.slice(0, 12) + ':' + fsha.slice(0, 12), item.title + ' - revised' + (what.length ? ' (' + what.join('; ') + ')' : ''), significance, fresh);
  };

  /* ----- Technical Letters discovery (newly published TLs that the standards page does not list yet) ----- */
  const discoverTL = async (prefs, out, fresh, runId) => {
    const tl = db.prepare("SELECT * FROM wada_items WHERE kind='index' AND (url LIKE '%technical-letters-index%' OR title='Technical Letters') LIMIT 1").get(); if (!tl || !parseIndex) return;
    out.discovery.attempted = true;
    try {
      const res = await get(tl.url, {}, prefs), known = new Set(db.prepare('SELECT url FROM wada_items').all().map(r => r.url)), html = res.buf.toString('utf8');
      // tolerant link finder: any official link whose text or address names a Technical Letter (TL + number), whatever the page layout
      const items = [], seen = new Set(); const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
      while ((m = re.exec(html)) && items.length < 300) { const url = officialUrl(m[1], tl.url); if (!url) continue; const clean = url.split('#')[0]; const label = htmlToText(m[2]).slice(0, 200), pth = new URL(clean).pathname;
        if (/\.(pdf|docx?|xlsx?)$/i.test(pth) && !/(?<![A-Za-z])TL[\s_-]?\d{1,3}(?!\d)/i.test(label + ' ' + pth)) continue; if (!(/(?<![A-Za-z])TL[\s_-]?(\d{1,3})(?!\d)/i.test(label) || /(?:^|\/)tl[-_]?\d{1,3}(?:[-_/.]|$)/i.test(pth))) continue; if (clean === tl.url.split('#')[0] || seen.has(clean)) continue; seen.add(clean);
        const num = (label.match(/(?<![A-Za-z])TL[\s_-]?(\d{1,3})(?!\d)/i) || pth.match(/tl[-_]?(\d{1,3})/i) || [])[1]; items.push({ url: clean, title: (/^\s*TL[\s_-]?\d/i.test(label) ? label : 'TL' + num + (label ? ' - ' + label : '')).slice(0, 300), published: '', summary: '' }); }
      if (items.length < 3) { const summary = 'Technical Letters list: HTTP ' + res.status + ', ' + res.buf.length + ' bytes, ' + items.length + ' letters recognised, readable text ' + htmlToText(html).length + ' characters'; saveDiag(tl, tl.url, 'technical letters list', res, html, summary); out.discovery.warning = 'The Technical Letters page loaded but only ' + items.length + ' letters were recognised - the page layout may have changed (not counted as a failed check). Details are in the connection test panel.'; recordError(runId, tl.url, Object.assign(new Error(out.discovery.warning), { category: 'parse_warning' }), 'discovery'); return; }
      const baseline = !getFix('tlDiscovered', false), src = db.prepare("SELECT source_id FROM wada_items WHERE id=?").get(tl.id).source_id, when = isoNow();
      const ins = db.prepare('INSERT INTO wada_items (url,source_id,kind,title,published,category,summary,fingerprint,verifiable,baseline,first_seen,last_checked,last_changed,last_status,item_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const it of items) { if (known.has(it.url)) continue; const r = ins.run(it.url, src, 'index', it.title, it.published || null, 'standards', it.summary || null, sha([it.url, it.title, it.published].join('|')), 1, baseline ? 1 : 0, when, when, null, baseline ? 'unchanged' : 'new', 'Technical Letter'); out.discovery.found++;
        if (!baseline) { const row = { id: Number(r.lastInsertRowid), category: 'standards' }; notify(row, 'new', sha(it.url), it.title + ' (new Technical Letter)', 'new_item', fresh); } }
      setFix('tlDiscovered', true);
    } catch (e) { const c = classifyError(e); e.category = e.category || c.category; out.discovery.error = e.category; recordError(runId, tl.url, e, 'discovery'); if (CONN.includes(e.category)) { out.failed++; out.errors.push({ title: 'Technical Letters list', category: e.category, message: String(e.message).slice(0, 200) }); } }
  };

  /* ----- the stage run after every monitor check ----- */
  const watch = async ({ runId, force, cancelled } = {}) => {
    if (running) return running;
    running = (async () => {
      const prefs = getPrefs(), out = { enabled: prefs.enabled, fileWarnings: 0, candidates: 0, pagesChecked: 0, filesChecked: 0, checked: 0, failed: 0, deferred: 0, firstSeen: 0, revised: 0, unchanged: 0, errors: [], discovery: { attempted: false, found: 0 }, complete: true, at: isoNow(), recheckFiles: !!force }, fresh = [];
      if (!prefs.enabled) { out.complete = false; return out; }
      await discoverTL(prefs, out, fresh, runId);
      const cats = new Set(prefs.categories), rows = db.prepare("SELECT i.* FROM wada_items i JOIN wada_sources s ON s.id=i.source_id AND s.enabled=1 WHERE i.kind IN ('index','document') ORDER BY i.id").all(), st = new Map(db.prepare('SELECT * FROM wada_doc_state').all().map(r => [r.item_id, r]));
      const cand = []; for (const i of rows) { if (!cats.has(i.category)) continue; let dtype = null; if (i.kind === 'index') dtype = docPageType(i.title, i.url); else if (MAGIC[path.extname(new URL(i.url).pathname).toLowerCase()]) dtype = 'File'; if (dtype) cand.push({ item: i, dtype, state: st.get(i.id) }); }
      out.candidates = cand.length; const hours = prefs.pageRecheckHours, nowMs = nowFn().getTime();
      const due = c => { if (force || !c.state || !c.state.last_checked) return true; const age = nowMs - new Date(c.state.last_checked).getTime(); return age >= (c.state.result === 'failed' ? Math.min(0.5, hours) : hours) * 3600e3; }; // a failed check is retried after 30 min at the latest
      const todo = cand.filter(due).sort((a, b) => (!!(a.state && a.state.last_ok) - !!(b.state && b.state.last_ok)) || String((a.state && a.state.last_checked) || '').localeCompare(String((b.state && b.state.last_checked) || '')));
      let pages = 0, files = 0, connFails = 0;
      for (const c of todo) {
        if (cancelled && cancelled()) { out.deferred++; continue; }
        if (connFails >= 3) { out.deferred++; continue; } // the connection itself is down: do not hammer, do not pretend
        if (c.item.kind === 'index' ? pages >= prefs.maxPagesPerRun : files >= prefs.maxFilesPerRun) { out.deferred++; continue; } if (c.item.kind === 'index') pages++; else files++;
        try { await checkOne(c.item, c.dtype, prefs, { runId }, out, fresh); out.checked++; connFails = 0; }
        catch (e) { const cl = classifyError(e); e.category = e.category || cl.category; out.failed++; if (CONN.includes(e.category)) connFails++; else connFails = 0; recordError(runId, c.item.url, e); setState(c.item, c.dtype, 'failed', e.category + ': ' + String(e.message).slice(0, 200)); out.errors.push({ itemId: c.item.id, title: c.item.title, category: e.category, message: String(e.message).slice(0, 200) }); }
      }
      out.complete = out.failed === 0 && out.deferred === 0; delete out.recheckFiles;
      if (fresh.length) { try { onNotify(fresh); } catch (e) { /* optional */ } for (const n of fresh) { try { db.prepare('UPDATE wada_notifications SET desktop_notified=1 WHERE id=?').run(n.id); } catch (e) { /* ignore */ } } }
      onChange(); return out;
    })();
    try { return await running; } finally { running = null; }
  };

  /* ----- queries ----- */
  const versionsOf = itemId => db.prepare('SELECT id,item_id,seen_at,title,published,updated,status,version_label,file_url,file_sha256,file_size,reason,(file_path IS NOT NULL) AS stored FROM wada_doc_versions WHERE item_id=? ORDER BY id DESC').all(itemId);
  const readVersion = id => { const r = db.prepare('SELECT * FROM wada_doc_versions WHERE id=?').get(Number(id)); if (!r || !r.file_path) throw new Error('No stored file for this version'); const abs = path.resolve(r.file_path), base = path.resolve(dir) + path.sep; if (!abs.startsWith(base)) throw new Error('Stored file is outside the archive folder'); if (!fs.existsSync(abs)) throw new Error('The stored file is missing from disk'); const buf = fs.readFileSync(abs); if (sha(buf) !== r.file_sha256) throw new Error('Integrity check failed: the stored file no longer matches its recorded SHA-256'); return { buffer: buf, name: path.basename(abs).replace(/^\d{14}-[0-9a-f]{8}-/, ''), sha256: r.file_sha256, size: buf.length, title: r.title, seenAt: r.seen_at }; };
  /* documents grouped into families with CURRENT / PREVIOUS (newest first) */
  const list = () => {
    const prefs = getPrefs(), items = db.prepare("SELECT i.* FROM wada_items i JOIN wada_sources s ON s.id=i.source_id AND s.enabled=1 WHERE i.kind IN ('index','document') ORDER BY i.id").all(), byFam = new Map(), states = new Map(db.prepare('SELECT * FROM wada_doc_state').all().map(r => [r.item_id, r]));
    for (const it of items) { if (!prefs.categories.includes(it.category)) continue; const dt = it.kind === 'index' ? docPageType(it.title, it.url) : 'File'; if (!dt) continue; const vs = versionsOf(it.id); const lastV = vs[0]; const fam = familyOf(it.title, lastV && lastV.file_url ? lastV.file_url : it.url); if (!byFam.has(fam.key)) byFam.set(fam.key, { key: fam.key, label: fam.label, type: fam.type, items: [] }); byFam.get(fam.key).items.push({ it, fam, vs, lastV, state: states.get(it.id), date: (lastV && lastV.published) || it.published || pathDate(lastV && lastV.file_url) || '' }); }
    const groups = [];
    for (const g of byFam.values()) {
      g.items.sort((a, b) => ((b.fam.year || 0) - (a.fam.year || 0)) || (b.fam.ver - a.fam.ver) || String(b.date).localeCompare(String(a.date)) || b.it.id - a.it.id);
      const versions = []; for (const x of g.items) { if (!x.vs.length) versions.push({ itemId: x.it.id, versionId: null, title: x.it.title, year: x.fam.year, published: x.date, status: '', label: '', seenAt: null, sha256: null, size: null, stored: false, sourceUrl: x.it.url, baselineItem: !!x.it.baseline, pageUrl: x.it.kind === 'index' ? x.it.url : '' }); else for (const v of x.vs) versions.push({ itemId: x.it.id, baselineItem: !!x.it.baseline, versionId: v.id, title: v.title || x.it.title, year: x.fam.year, published: v.published || x.date, updated: v.updated, status: v.status, label: v.version_label, seenAt: v.seen_at, sha256: v.file_sha256 || null, size: v.file_size, stored: !!v.stored, reason: v.reason, sourceUrl: v.file_url || x.it.url, pageUrl: x.it.kind === 'index' ? x.it.url : '' }); }
      let ci = versions.findIndex(v => /in force/i.test(v.status || '')); if (ci < 0) ci = 0; const ordered = [versions[ci], ...versions.filter((_, i) => i !== ci)].map((v, i) => ({ ...v, role: i === 0 ? 'current' : i === 1 ? 'previous' : 'older' }));
      const failedItems = g.items.filter(x => x.state && x.state.result === 'failed').length;
      groups.push({ key: g.key, label: g.label, type: g.type, title: g.items[0].it.title, itemId: g.items[0].it.id, versions: ordered, current: ordered[0], previous: ordered[1] || null, checkFailed: failedItems > 0, lastChecked: g.items.map(x => x.state && x.state.last_checked).filter(Boolean).sort().pop() || null, recentChange: !!ordered[1] && !!ordered[0].seenAt && (nowFn().getTime() - new Date(ordered[0].seenAt).getTime()) < 30 * 864e5 && ((ordered[0].reason && ordered[0].reason !== 'first') || ordered[0].baselineItem === false) }); // a revision, or a new edition that appeared after the first baseline
    }
    groups.sort((a, b) => (b.recentChange - a.recentChange) || a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
    const fails = db.prepare("SELECT COUNT(*) n FROM wada_doc_state WHERE result='failed'").get().n, checked = db.prepare('SELECT COUNT(*) n FROM wada_doc_state').get().n, last = db.prepare('SELECT MAX(last_checked) t FROM wada_doc_state').get().t, nv = db.prepare('SELECT COUNT(*) n FROM wada_doc_versions').get().n;
    return { groups, prefs, totals: { documents: groups.length, versions: nv, tracked: checked, failed: fails, lastChecked: last || null, running: !!running } };
  };
  const diagnostics = () => db.prepare('SELECT id,at,item_id,url,kind,http_status,content_type,bytes,summary,sample FROM wada_doc_diag ORDER BY id DESC LIMIT 8').all();
  return { watch, list, diagnostics, versionsOf, readVersion, getPrefs, setPrefs, getFix, setFix, familyOf, docPageType, isRunning: () => !!running, dir };
};

module.exports = { create, familyOf, docPageType, labelOf, DEFAULTS, UA };
