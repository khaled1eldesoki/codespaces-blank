'use strict';
/*
 * EDCL WADA update monitor (v1.0.13)
 *
 * ROOT CAUSE of "TypeError: fetch failed" (v1.0.9 wada-service.js): the main process called Node's global fetch (undici).
 * That stack ignores the Windows system/PAC proxy, the Windows certificate store (corporate TLS inspection) and
 * Chromium's DNS settings - which is why the same URL worked in a browser. Requests now use electron.net.fetch
 * (Chromium network stack). Every failure is classified (stage / category / retryable) instead of "fetch failed".
 *
 * Everything is stored in a local SQLite file (migrations via PRAGMA user_version) so history, notifications and
 * preferences survive restarts. Public official pages only - no login, no bypass of challenges or rate limits.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
let Database; try { Database = require('better-sqlite3'); } catch (e) { Database = null; }

const HOST = 'www.wada-ama.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const CATEGORIES = {
  news: 'Anti-doping news and announcements',
  prohibited_list: 'Prohibited List and related documents',
  standards: 'International Standards and guidance',
  rules: 'Rules, regulations and policy changes',
  education: 'Education and training resources',
  other: 'Other official publications'
};
/* Sources: every URL below was read from the official WADA website (fetched 2026-10-21) - none are guesses.
 *   news      listing of articles, each tracked individually (title + date)
 *   resource  a WADA "resource" page: monitored by Publication date, current download link, og:updated_time and body text,
 *             plus the PDF documents it links to (newest 40)
 *   index     an overview page whose Technical Documents / Technical Letters / Guidelines / Standards links are each tracked */
const DEFAULT_SOURCES = [
  { id: 'news', url: 'https://www.wada-ama.org/en/media/news', kind: 'news', category: 'news', label: 'WADA news' },
  { id: 'prohibited-list-resource', url: 'https://www.wada-ama.org/en/resources/world-anti-doping-code-and-international-standards/prohibited-list', kind: 'resource', category: 'prohibited_list', label: 'Prohibited List (resource page)' },
  { id: 'international-standards', url: 'https://www.wada-ama.org/en/what-we-do/international-standards', kind: 'index', category: 'standards', label: 'International Standards, Technical Documents & Guidelines' },
  { id: 'td-index', url: 'https://www.wada-ama.org/en/resources/lab-documents/technical-documents-index', kind: 'resource', category: 'standards', label: 'Technical Documents Index' }
];
const DEFAULT_PREFS = { autoEnabled: true, intervalHours: 6, desktop: true, categories: { news: true, prohibited_list: true, standards: true, rules: true, education: true, other: true }, maxAttempts: 4, timeoutMs: 20000, backoffBaseMs: 1500, proxyRules: '', minChangePct: 2 };

/* ---------------- helpers ---------------- */
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
const strip = s => decode(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '));
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const isoNow = () => new Date().toISOString();
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const parseDate = s => { const x = String(s || '').match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i); if (!x) return ''; return `${x[3]}-${String(MONTHS[x[2].slice(0, 3).toLowerCase()]).padStart(2, '0')}-${String(+x[1]).padStart(2, '0')}`; };
const officialUrl = (href, base) => { try { const u = new URL(String(href).trim(), base); if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== HOST) return null; u.hash = ''; [...u.searchParams.keys()].filter(k => /^(utm_|fbclid|gclid)/i.test(k)).forEach(k => u.searchParams.delete(k)); if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, ''); return u.href; } catch (e) { return null; } };
const parseShortDate = s => { const x = String(s || '').match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{2,4})\b/i); if (!x) return ''; const y = x[3].length === 2 ? '20' + x[3] : x[3]; return `${y}-${String(MONTHS[x[2].slice(0, 3).toLowerCase()]).padStart(2, '0')}-${String(+x[1]).padStart(2, '0')}`; };
const classify = (title, url, hint) => {
  const t = (title + ' ' + url).toLowerCase();
  if (/prohibited[- ]list|monitoring program/.test(t)) return 'prohibited_list';
  if (/international[- ]standard|\bisl\b|\bisti\b|\bisppi\b|\bistue\b|\bisccs\b|\bisrm\b|technical[- ]document|\btd\d{4}|\btl\d+\b|technical[- ]letter|lab-documents|guideline|guidance/.test(t)) return 'standards';
  if (/world[- ]anti[- ]doping[- ]code|\bcode\b|\brule|regulation|polic(y|ies)|non[- ]compliance|signator/.test(t)) return 'rules';
  if (/education|training|e-learning|\badel\b|course|learn|resource for/.test(t)) return 'education';
  return hint || 'other';
};

/* ---------------- error classification ---------------- */
const classifyError = err => {
  const msg = String((err && err.message) || err || '');
  const code = String((err && (err.code || (err.cause && err.cause.code))) || '');
  const all = msg + ' ' + code + ' ' + String((err && err.cause && err.cause.message) || '');
  const t = (stage, category, retryable, hint) => ({ stage, category, retryable, hint });
  if (err && (err.name === 'AbortError' || /aborted|cancel/i.test(msg)) && !/timeout/i.test(msg)) return t('cancelled', 'cancelled', false, 'Request cancelled');
  if (/ERR_UNSAFE_PORT|ERR_BLOCKED_BY|ERR_DISALLOWED_URL_SCHEME|ERR_ACCESS_DENIED/i.test(all)) return t('request', 'blocked', false, 'The request was blocked by the application/browser security policy');
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)) return t('dns', 'dns', true, 'DNS lookup failed - check internet/DNS settings');
  if (/ERR_CERT|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_SSL|SSL_|TLS|certificate/i.test(all)) return t('tls', 'tls_certificate', false, 'TLS/certificate problem - a proxy or firewall may be inspecting HTTPS; install the organisation root certificate in Windows');
  if (/ERR_PROXY|PROXY|ERR_TUNNEL/i.test(all)) return t('proxy', 'proxy', true, 'Proxy problem - check the Windows/organisation proxy settings');
  if (/timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ERR_TIMED_OUT/i.test(all)) return t('connect', 'timeout', true, 'The request timed out');
  if (/ECONNREFUSED|ECONNRESET|EPIPE|ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_ADDRESS|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|network/i.test(all)) return t('connect', 'network', true, 'Network connection failed');
  return t('request', 'unknown', true, 'Unclassified network error');
};
const ACTIONS = {
  not_found: 'The monitored page no longer exists at this address. Open the URL in a browser; if WADA moved it, update the source address in wada-monitor.js (DEFAULT_SOURCES) and run the check again.',
  forbidden: 'WADA refused automated access (not bypassed). Open the page manually; try again later; ask IT whether a proxy or firewall blocks the request.',
  challenge: 'WADA returned a bot-protection page instead of content (not bypassed). Open the page in a browser; try again later.',
  parse_failed: 'The page loaded but the expected content was not found - WADA may have changed its page layout. Open the page in a browser and compare; the parser in wada-monitor.js needs updating (see tests/fixtures).',
  empty_response: 'WADA returned an empty page. This is usually temporary - the check will retry automatically.',
  dns: 'DNS lookup failed. Check the internet connection and DNS settings; confirm www.wada-ama.org opens in a browser on this PC.',
  network: 'The network connection failed. Check the internet connection, VPN or firewall.',
  timeout: 'The request timed out. Check the connection speed; the check will retry automatically.',
  proxy: 'Proxy problem. Check the Windows proxy settings or enter the proxy under WADA Updates, Settings, Network.',
  tls_certificate: 'HTTPS certificate problem - an organisation firewall may be inspecting HTTPS. Ask IT to install the organisation root certificate in Windows.',
  server_error: 'WADA server error. This is usually temporary - the check will retry automatically.',
  rate_limited: 'WADA asked for fewer requests (HTTP 429). The check waits and retries; consider a longer interval in Settings.',
  redirect_offsite: 'The address redirected outside wada-ama.org and was not followed. Open the URL in a browser to see where it goes.',
  blocked: 'The request was blocked by the application security policy.',
  http_status: 'Unexpected HTTP response. Open the URL in a browser.',
  unknown: 'Unclassified error. See the detail text; open the URL in a browser to compare.'
};
const actionFor = c => ACTIONS[c] || ACTIONS.unknown;
class SyncError extends Error {
  constructor(info) { super(`${info.category} at ${info.stage} for ${info.url}: ${info.message}`); this.name = 'SyncError'; Object.assign(this, info); }
}
const httpError = (url, status, res) => {
  const base = { url, status, at: isoNow(), stage: 'http' };
  if (status === 202) return new SyncError({ ...base, category: 'challenge', retryable: false, message: 'HTTP 202 - the site returned a bot-protection challenge instead of the page. Not bypassed; try again later or open the page in a browser.' });
  if (status === 429) return new SyncError({ ...base, category: 'rate_limited', retryable: true, message: 'HTTP 429 - rate limited', retryAfter: res && res.headers && res.headers.get ? res.headers.get('retry-after') : null });
  if (status === 401 || status === 403) return new SyncError({ ...base, category: 'forbidden', retryable: false, message: `HTTP ${status} - access refused (not retried, no authentication attempted)` });
  if (status === 404 || status === 410) return new SyncError({ ...base, category: 'not_found', retryable: false, message: `HTTP ${status} - page not found (permanent)` });
  if (status === 408 || status >= 500) return new SyncError({ ...base, category: 'server_error', retryable: true, message: `HTTP ${status} - server error`, retryAfter: res && res.headers && res.headers.get ? res.headers.get('retry-after') : null });
  return new SyncError({ ...base, category: 'http_status', retryable: false, message: `HTTP ${status}` });
};

/* ---------------- parsing ---------------- */
const metaOf = (html, name) => { const re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'), re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + name + '["\']', 'i'); const m = html.match(re1) || html.match(re2); return m ? decode(m[1]) : ''; };
const mainOf = html => (html.match(/<main\b[\s\S]*?<\/main>/i) || html.match(/<body\b[\s\S]*?<\/body>/i) || [html])[0];
const NEWS_TYPE = /\b(Releases?|Stories|Story|Athlete Corner)\b/i;
const parseNewsList = (html, base, hint) => {
  const out = [], seen = new Set(), ms = [];
  const re = /<a\b[^>]*href=["']([^"']*\/en\/news\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html)) && ms.length < 400) ms.push({ href: m[1], inner: m[2] });
  for (const x of ms) {
    if (out.length >= 120) break;
    const url = officialUrl(x.href, base); if (!url || seen.has(url)) continue;
    const txt = strip(x.inner), rm = txt.match(/Read more on\s*:\s*(.+)$/i);
    let title = rm ? rm[1].trim() : txt.replace(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/, '').replace(NEWS_TYPE, '').trim();
    if (!title || title.length < 8) continue; // image-only or empty anchors never become items (and never block a later real anchor)
    seen.add(url);
    const before = txt.slice(0, rm ? txt.toLowerCase().indexOf('read more on') : txt.length), tm = before.match(NEWS_TYPE);
    out.push({ url, title: decode(title), published: parseDate(txt), summary: '', kind: 'news', itemType: tm ? tm[1].replace(/^Stories$/i, 'Story').replace(/^Release$/i, 'Releases') : '', category: classify(title, url, hint) });
  }
  return out;
};
const pathMonth = url => { const m = url.match(/\/sites\/default\/files\/(\d{4})-(\d{2})\//); return m ? m[1] + m[2] : '000000'; };
const docTitle = (t, url) => { const x = decode(t).replace(/\((?:PDF|DOCX?|XLSX?),\s*[^)]*\)/gi, '').replace(/\s+(Active|Archived)\s*$/i, '').replace(/\s+/g, ' ').trim(); return x || decodeURIComponent(path.basename(new URL(url).pathname)); };
const parseDocuments = (html, base, pageTitle) => {
  const out = [], seen = new Set(); const re = /<a\b[^>]*href=["']([^"']+\.(?:pdf|docx?|xlsx?))(?:\?[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html)) && out.length < 400) {
    const url = officialUrl(m[1], base); if (!url || seen.has(url)) continue; seen.add(url);
    const raw = strip(m[2]), isDl = /^download\b/i.test(raw), title = isDl ? (pageTitle || 'WADA resource') + ' - current download' : docTitle(raw, url);
    out.push({ url, title: title.slice(0, 220), published: '', summary: '', kind: 'document', category: classify(title, url, 'other'), primary: isDl });
  }
  // keep the current download plus the 40 most recently published files (folder yyyy-mm); older archives are not monitored one by one
  const pri = out.filter(d => d.primary), rest = out.filter(d => !d.primary).sort((a, b) => pathMonth(b.url).localeCompare(pathMonth(a.url))).slice(0, 40);
  return [...pri, ...rest];
};
const parseResourcePage = (html, url, hint, label) => {
  const main = mainOf(html), text = strip(main).replace(/\b(cookie settings|accept all)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const title = metaOf(html, 'og:title') || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || label || url).replace(/\s*\|\s*World Anti.?Doping Agency.*$/i, '');
  const pub = text.match(/Publication date\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/i), st = text.match(/\b(In force|Archived|Draft|Withdrawn|Under review)\b/i);
  const docs = parseDocuments(html, url, title), dl = docs.find(d => d.primary);
  const parts = { published: pub ? parseShortDate(pub[1]) : '', status: st ? st[1] : '', download: dl ? dl.url : '', updated: metaOf(html, 'og:updated_time') };
  const page = { url, title: title || label, published: parts.published, summary: [parts.status, parts.published ? 'Publication date ' + parts.published : '', dl ? 'current download available' : ''].filter(Boolean).join(' Â· '), kind: 'page', category: hint, parts, text, textLen: text.length };
  return { page, docs };
};
const LINKRE = /\/en\/resources\/(?:lab-documents\/(?:td[a-z0-9]+|tl\d+)|science-medicine\/tl\d+|tl\d+|technical-letters-index|lab-documents\/technical-documents-index|[a-z0-9-]*guidelines?[a-z0-9-]*|world-anti-doping-program\/[a-z0-9-]+|world-anti-doping-code-and-international-standards\/[a-z0-9-]+|laboratory-guidelines-[a-z0-9-]+)$/i;
const parseIndex = (html, base, hint, skip) => {
  const out = [], seen = new Set(); const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html)) && out.length < 200) {
    const url = officialUrl(m[1], base); if (!url || seen.has(url) || (skip && skip.has(url))) continue; // a URL that is itself a monitored source belongs to that source
    if (!LINKRE.test(new URL(url).pathname)) continue;
    const label = strip(m[2]); if (!label) continue;
    const after = html.slice(re.lastIndex, re.lastIndex + 400).split(/<br\b|<\/p>|<\/li>|<a\b|<p\b/i)[0], desc = strip(after).replace(/^\s*[-â€“â€”]\s*/, '');
    const title = (desc && /^\s*[-â€“â€”]/.test(strip(after)) ? label + ' - ' + desc : label).slice(0, 300);
    seen.add(url); out.push({ url, title, published: '', summary: '', kind: 'index', category: classify(title, url, hint) });
  }
  return out;
};

/* ---------------- schema migrations (additive; existing data is always kept) ---------------- */
const MIGRATION_SQL = [
  `CREATE TABLE wada_sources (id TEXT PRIMARY KEY, url TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL, label TEXT, enabled INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE wada_items (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL REFERENCES wada_sources(id), kind TEXT NOT NULL, title TEXT NOT NULL, published TEXT, category TEXT NOT NULL, summary TEXT, fingerprint TEXT NOT NULL, verifiable INTEGER NOT NULL DEFAULT 1, baseline INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, last_checked TEXT NOT NULL, last_changed TEXT, last_status TEXT NOT NULL);
   CREATE INDEX idx_items_source ON wada_items(source_id); CREATE INDEX idx_items_cat ON wada_items(category); CREATE INDEX idx_items_seen ON wada_items(first_seen);
   CREATE TABLE wada_item_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES wada_items(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, title TEXT, captured_at TEXT NOT NULL);
   CREATE INDEX idx_versions_item ON wada_item_versions(item_id);
   CREATE TABLE wada_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, trigger_type TEXT NOT NULL, status TEXT NOT NULL, new_count INTEGER NOT NULL DEFAULT 0, changed_count INTEGER NOT NULL DEFAULT 0, unchanged_count INTEGER NOT NULL DEFAULT 0, failed_sources INTEGER NOT NULL DEFAULT 0, message TEXT);
   CREATE INDEX idx_runs_started ON wada_sync_runs(started_at);
   CREATE TABLE wada_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER REFERENCES wada_sync_runs(id) ON DELETE CASCADE, at TEXT NOT NULL, source_url TEXT NOT NULL, stage TEXT NOT NULL, category TEXT NOT NULL, http_status INTEGER, attempt INTEGER, retryable INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL);
   CREATE INDEX idx_errors_run ON wada_errors(run_id);
   CREATE TABLE wada_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES wada_items(id) ON DELETE CASCADE, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, title TEXT NOT NULL, source TEXT, category TEXT, detected_at TEXT NOT NULL, read_at TEXT, desktop_notified INTEGER NOT NULL DEFAULT 0, UNIQUE(item_id, kind, fingerprint));
   CREATE INDEX idx_notif_read ON wada_notifications(read_at);
   CREATE TABLE wada_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE wada_downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER REFERENCES wada_items(id) ON DELETE SET NULL, url TEXT NOT NULL, path TEXT, size INTEGER, sha256 TEXT, status TEXT NOT NULL, error TEXT, at TEXT NOT NULL);`,
  `ALTER TABLE wada_items ADD COLUMN verification TEXT NOT NULL DEFAULT 'unverified';
   ALTER TABLE wada_items ADD COLUMN verification_note TEXT;
   ALTER TABLE wada_items ADD COLUMN verified_by TEXT;
   ALTER TABLE wada_items ADD COLUMN verified_at TEXT;
   ALTER TABLE wada_items ADD COLUMN item_type TEXT;
   ALTER TABLE wada_items ADD COLUMN signals TEXT;
   ALTER TABLE wada_item_versions ADD COLUMN text_snapshot TEXT;
   ALTER TABLE wada_item_versions ADD COLUMN parts TEXT;
   ALTER TABLE wada_item_versions ADD COLUMN change_pct REAL;
   ALTER TABLE wada_notifications ADD COLUMN significance TEXT;
   ALTER TABLE wada_errors ADD COLUMN action TEXT;`
];

/* ---------------- monitor ---------------- */
const createMonitor = (opts = {}) => {
  if (!Database) throw new Error('SQLite native driver is unavailable');
  const dbPath = opts.dbPath, sources = opts.sources || DEFAULT_SOURCES;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const nowFn = opts.now || (() => new Date());
  const onNotify = opts.onNotify || (() => {});
  const onChange = opts.onChange || (() => {});
  const log = opts.log || (() => {});
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');

  const MIGRATIONS = MIGRATION_SQL;
  const migrate = () => {
    let v = db.pragma('user_version', { simple: true });
    while (v < MIGRATIONS.length) { const sql = MIGRATIONS[v]; db.transaction(() => { db.exec(sql); db.pragma('user_version = ' + (v + 1)); })(); v++; }
    const up = db.prepare('INSERT INTO wada_sources (id,url,kind,category,label,enabled) VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET url=excluded.url, kind=excluded.kind, category=excluded.category, label=excluded.label');
    db.transaction(() => { sources.forEach(s => up.run(s.id, s.url, s.kind, s.category, s.label)); const ids = sources.map(x => x.id); db.prepare(`UPDATE wada_sources SET enabled = CASE WHEN id IN (${ids.map(() => '?').join(',')}) THEN 1 ELSE 0 END`).run(...ids); })();
  };
  migrate();
  // a check cut off by an application exit/crash must not stay "running" forever in the history
  db.prepare("UPDATE wada_sync_runs SET status='interrupted', finished_at=COALESCE(finished_at, ?), message=COALESCE(NULLIF(message,''), 'Interrupted: the application closed or stopped during this check') WHERE status='running'").run(isoNow());

  /* prefs */
  const getPrefs = () => { const rows = db.prepare('SELECT key,value FROM wada_prefs').all(), o = JSON.parse(JSON.stringify(DEFAULT_PREFS)); for (const r of rows) { try { o[r.key] = JSON.parse(r.value); } catch (e) { /* ignore */ } } o.categories = { ...DEFAULT_PREFS.categories, ...(o.categories || {}) }; return o; };
  const setPrefs = p => {
    const cur = getPrefs(), next = { ...cur };
    if (p.autoEnabled !== undefined) next.autoEnabled = !!p.autoEnabled;
    if (p.desktop !== undefined) next.desktop = !!p.desktop;
    if (p.intervalHours !== undefined) { const h = Number(p.intervalHours); if (!(h >= 0.25 && h <= 168)) throw new Error('Update interval must be between 0.25 and 168 hours'); next.intervalHours = h; }
    if (p.categories) for (const k of Object.keys(DEFAULT_PREFS.categories)) if (k in p.categories) next.categories[k] = !!p.categories[k];
    if (p.proxyRules !== undefined) next.proxyRules = String(p.proxyRules).slice(0, 200);
    if (p.minChangePct !== undefined) { const c = Number(p.minChangePct); if (!(c >= 0 && c <= 100)) throw new Error('Minimum text change must be between 0 and 100 percent'); next.minChangePct = c; }
    const up = db.prepare('INSERT INTO wada_prefs (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    db.transaction(() => { for (const k of ['autoEnabled', 'desktop', 'intervalHours', 'categories', 'proxyRules', 'minChangePct']) up.run(k, JSON.stringify(next[k])); })();
    return next;
  };

  /* ----- network with timeout, retry/backoff, cancellation ----- */
  let current = null; // {promise, controller, cancelled}
  const requestOnce = async (url, controller, timeoutMs) => {
    if (!fetchImpl) throw new SyncError({ url, stage: 'request', category: 'unavailable', retryable: false, message: 'No network API available', at: isoNow() });
    let timer; const timeout = new Promise((_, rej) => { timer = setTimeout(() => { controller.abort(); rej(Object.assign(new Error('timeout after ' + timeoutMs + ' ms'), { code: 'ETIMEDOUT' })); }, timeoutMs); });
    try {
      const res = await Promise.race([fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5' }, redirect: 'follow', signal: controller.signal }), timeout]);
      if (res.url && !officialUrl(res.url, url)) throw new SyncError({ url, stage: 'redirect', category: 'redirect_offsite', retryable: false, message: 'Redirected outside wada-ama.org (' + String(res.url).slice(0, 120) + '); not followed', at: isoNow() });
      if (res.status < 200 || res.status >= 300 || res.status === 202) throw httpError(url, res.status, res);
      const body = await Promise.race([res.text(), timeout]);
      if (!body || !body.trim()) throw new SyncError({ url, stage: 'parse', category: 'empty_response', retryable: true, message: 'Empty response body', at: isoNow() });
      return { body, status: res.status, finalUrl: res.url || url };
    } finally { clearTimeout(timer); }
  };
  const request = async (url, run, ctx) => {
    const prefs = ctx.prefs; let attempt = 0, last;
    while (attempt < prefs.maxAttempts) {
      attempt++;
      if (run.cancelled) throw new SyncError({ url, stage: 'cancelled', category: 'cancelled', retryable: false, message: 'Cancelled by user', at: isoNow() });
      const controller = new AbortController(); run.controller = controller;
      try { return await requestOnce(url, controller, prefs.timeoutMs); }
      catch (e) {
        let info;
        if (e instanceof SyncError) info = e; else { if (run.cancelled) info = new SyncError({ url, stage: 'cancelled', category: 'cancelled', retryable: false, message: 'Cancelled by user', at: isoNow() }); else { const c = classifyError(e); info = new SyncError({ url, ...c, message: (e && e.message ? e.message : String(e)).slice(0, 300) + ' | ' + c.hint, at: isoNow() }); } }
        info.attempt = attempt; last = info;
        recordError(ctx.runId, info);
        if (!info.retryable || attempt >= prefs.maxAttempts) throw info;
        let wait = prefs.backoffBaseMs * Math.pow(2, attempt - 1); wait += Math.floor(wait * 0.2 * Math.random());
        if (info.retryAfter && /^\d+$/.test(String(info.retryAfter))) wait = Math.max(wait, Math.min(60000, +info.retryAfter * 1000));
        log('retry', url, attempt, wait);
        await sleep(wait);
      }
    }
    throw last;
  };
  const recordError = (runId, e) => db.prepare('INSERT INTO wada_errors (run_id,at,source_url,stage,category,http_status,attempt,retryable,message,action) VALUES (?,?,?,?,?,?,?,?,?,?)').run(runId, e.at || isoNow(), String(e.url || ''), e.stage || 'request', e.category || 'unknown', e.status || null, e.attempt || null, e.retryable ? 1 : 0, String(e.message || '').slice(0, 500), actionFor(e.category));

  /* ----- diff & notifications (one transaction per source) -----
   * A fingerprint change is only a DETECTED change. Page changes are graded: 'structured' (publication date / status /
   * current download changed), 'text' (body text changed by >= minChangePct), 'minor' (metadata or tiny edits - recorded,
   * not announced). Nothing is ever marked as a verified substantive change automatically: verification is a human decision. */
  const shingles = t => { const w = String(t || '').toLowerCase().split(/\s+/).filter(Boolean), set = new Set(); for (let i = 0; i + 3 <= w.length && set.size < 40000; i++) set.add(w[i] + ' ' + w[i + 1] + ' ' + w[i + 2]); return set; };
  const diffPct = (a, b) => { const A = shingles(a), B = shingles(b); if (!A.size && !B.size) return 0; let inter = 0; for (const x of A) if (B.has(x)) inter++; const uni = A.size + B.size - inter; return uni ? Math.round((1 - inter / uni) * 1000) / 10 : 0; };
  const applySource = (src, items, runId, counts) => {
    const when = isoNow(), prefs = getPrefs();
    const hasAny = db.prepare('SELECT COUNT(*) n FROM wada_items WHERE source_id=?').get(src.id).n > 0;
    const sel = db.prepare('SELECT * FROM wada_items WHERE url=?'), ins = db.prepare('INSERT INTO wada_items (url,source_id,kind,title,published,category,summary,fingerprint,verifiable,baseline,first_seen,last_checked,last_changed,last_status,item_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const upd = db.prepare("UPDATE wada_items SET title=?,published=?,category=?,summary=?,fingerprint=?,last_checked=?,last_changed=?,last_status=?,signals=?,verification='unverified',verification_note=NULL,verified_by=NULL,verified_at=NULL WHERE id=?"), touch = db.prepare('UPDATE wada_items SET last_checked=?, last_status=? WHERE id=?');
    const ver = db.prepare('INSERT INTO wada_item_versions (item_id,fingerprint,title,captured_at,text_snapshot,parts,change_pct) VALUES (?,?,?,?,?,?,?)'), lastVer = db.prepare('SELECT * FROM wada_item_versions WHERE item_id=? ORDER BY id DESC LIMIT 1');
    const note = db.prepare('INSERT OR IGNORE INTO wada_notifications (item_id,kind,fingerprint,title,source,category,detected_at,significance) VALUES (?,?,?,?,?,?,?,?)');
    const fresh = []; const seenUrls = new Set();
    db.transaction(() => {
      for (const it of items) {
        if (seenUrls.has(it.url)) continue; seenUrls.add(it.url); // duplicate entries on one page never create two records
        const isPage = it.kind === 'page', parts = it.parts || null;
        const fp = isPage ? sha(JSON.stringify([parts, it.text])) : sha([it.url, it.title, it.published].join('|'));
        const snap = isPage ? String(it.text || '').slice(0, 200000) : null, row = sel.get(it.url);
        if (row && row.source_id !== src.id) { const owner = db.prepare('SELECT enabled FROM wada_sources WHERE id=?').get(row.source_id); if (owner && owner.enabled) continue; db.prepare('UPDATE wada_items SET source_id=? WHERE id=?').run(src.id, row.id); row.source_id = src.id; } // each URL is owned by exactly one active source
        if (!row) {
          const baseline = hasAny ? 0 : 1; // first successful discovery of a source is the baseline: listed, but not announced
          const r = ins.run(it.url, src.id, it.kind, it.title, it.published, it.category, it.summary, fp, isPage ? 0 : 1, baseline, when, when, null, baseline ? 'unchanged' : 'new', it.itemType || '');
          ver.run(r.lastInsertRowid, fp, it.title, when, snap, parts ? JSON.stringify(parts) : null, null);
          if (!baseline) { const n = note.run(r.lastInsertRowid, 'new', fp, it.title, src.label || src.id, it.category, when, 'new_item'); if (n.changes) fresh.push({ id: n.lastInsertRowid, title: it.title, category: it.category, kind: 'new' }); counts.new++; } else counts.unchanged++;
        } else if (row.fingerprint !== fp) {
          let significance = 'possible', pct = null, changed = [];
          if (isPage) {
            const pv = lastVer.get(row.id), pp = pv && pv.parts ? JSON.parse(pv.parts) : {};
            pct = diffPct(pv && pv.text_snapshot, snap);
            changed = ['published', 'status', 'download'].filter(k => (pp[k] || '') !== (parts[k] || ''));
            significance = changed.length ? 'structured' : pct >= prefs.minChangePct ? 'text' : 'minor';
            if ((pp.updated || '') !== (parts.updated || '')) changed.push('updated_time');
          }
          const signals = JSON.stringify({ significance, changePct: pct, changedFields: changed, verified: false, detectedAt: when });
          upd.run(it.title, it.published, it.category, it.summary, fp, when, when, 'changed', signals, row.id);
          ver.run(row.id, fp, it.title, when, snap, parts ? JSON.stringify(parts) : null, pct);
          if (significance !== 'minor') { const n = note.run(row.id, 'changed', fp, it.title, src.label || src.id, it.category, when, significance); if (n.changes) fresh.push({ id: n.lastInsertRowid, title: it.title, category: it.category, kind: 'changed' }); }
          counts.changed++;
        } else { touch.run(when, 'unchanged', row.id); counts.unchanged++; }
      }
    })();
    return fresh;
  };

  const check = async (trigger = 'manual') => {
    if (current) return { coalesced: true, ...(await current.promise.catch(r => r)) }; // duplicate-request prevention
    const run = { cancelled: false, controller: null }; const startedAt = isoNow();
    const runId = db.prepare('INSERT INTO wada_sync_runs (started_at,trigger_type,status) VALUES (?,?,?)').run(startedAt, trigger, 'running').lastInsertRowid;
    const ctx = { runId, prefs: getPrefs() }; const counts = { new: 0, changed: 0, unchanged: 0 }; let failed = 0, ok = 0; const messages = []; const allFresh = [];
    run.promise = (async () => {
      for (const src of sources) {
        if (run.cancelled) break;
        try {
          const r = await request(src.url, run, ctx);
          let items; const bad = m => new SyncError({ url: src.url, stage: 'parse', category: 'parse_failed', retryable: false, message: m, at: isoNow() });
          if (src.kind === 'news') { items = parseNewsList(r.body, src.url, src.category); if (!items.length) throw bad('Page loaded but no news items were recognised (0 results) - the WADA page layout may have changed'); }
          else if (src.kind === 'index') { items = parseIndex(r.body, src.url, src.category, new Set(sources.map(x => officialUrl(x.url)))); if (items.length < 5) throw bad('Page loaded but only ' + items.length + ' document links were recognised (expected 5 or more) - the WADA page layout may have changed'); }
          else { const rp = parseResourcePage(r.body, src.url, src.category, src.label); if (rp.page.textLen < 80) throw bad('Page loaded but its main content was empty or unrecognised - the WADA page layout may have changed'); items = [rp.page, ...rp.docs.map(d => ({ ...d, category: d.category === 'other' ? src.category : d.category }))]; }
          allFresh.push(...applySource(src, items, runId, counts)); ok++;
        } catch (e) {
          failed++; const info = e instanceof SyncError ? e : Object.assign(new SyncError({ url: src.url, ...classifyError(e), message: String(e && e.message || e), at: isoNow() }), {});
          if (['dns', 'network', 'timeout', 'proxy', 'tls_certificate'].includes(info.category) && ctx.prefs.maxAttempts > 1) ctx.prefs = { ...ctx.prefs, maxAttempts: 1 }; // connection-level problem: do not spend the full retry budget on every remaining source
          if (!(e instanceof SyncError) || e.stage === 'parse') recordError(runId, info);
          messages.push(`${src.label || src.id}: ${info.category} (${info.stage})`);
          db.prepare("UPDATE wada_items SET last_status='failed', last_checked=? WHERE source_id=? AND last_status!='failed'").run(isoNow(), src.id);
        }
      }
      const status = run.cancelled ? 'cancelled' : failed === 0 ? 'ok' : ok === 0 ? 'failed' : 'partial';
      db.prepare('UPDATE wada_sync_runs SET finished_at=?, status=?, new_count=?, changed_count=?, unchanged_count=?, failed_sources=?, message=? WHERE id=?').run(isoNow(), status, counts.new, counts.changed, counts.unchanged, failed, messages.join('; ') || (status === 'ok' ? 'No new updates' : ''), runId);
      const prefs = getPrefs(), toast = allFresh.filter(n => prefs.categories[n.category] !== false);
      if (toast.length) { for (const n of toast) db.prepare('UPDATE wada_notifications SET desktop_notified=1 WHERE id=?').run(n.id); if (prefs.desktop) onNotify(toast); }
      onChange();
      return { runId, status, counts, failedSources: failed, messages, newNotifications: toast.length };
    })();
    current = run; run.promise.finally(() => { current = null; });
    return run.promise;
  };
  const cancel = () => { if (!current) return false; current.cancelled = true; try { current.controller && current.controller.abort(); } catch (e) { /* ignore */ } return true; };

  /* ----- queries ----- */
  const lastRun = (where = '1=1') => db.prepare(`SELECT * FROM wada_sync_runs WHERE ${where} ORDER BY id DESC LIMIT 1`).get();
  const status = () => {
    const prefs = getPrefs(), ls = lastRun("status IN ('ok')"), lr = lastRun("status!='running'"), le = db.prepare('SELECT * FROM wada_errors ORDER BY id DESC LIMIT 1').get();
    const base = lr && lr.finished_at ? new Date(lr.finished_at).getTime() : null;
    const next = prefs.autoEnabled ? new Date((base || nowFn().getTime()) + prefs.intervalHours * 3600e3).toISOString() : null;
    const unread = db.prepare('SELECT COUNT(*) n FROM wada_notifications n JOIN wada_items i ON i.id=n.item_id JOIN wada_sources s ON s.id=i.source_id WHERE n.read_at IS NULL AND s.enabled=1').get().n;
    const lastFailed = !!lr && (lr.status === 'failed' || lr.status === 'partial');
    return { running: !!current, lastSuccess: ls ? ls.finished_at : null, lastRun: lr || null, lastError: le ? { at: le.at, url: le.source_url, stage: le.stage, category: le.category, message: le.message } : null, nextCheck: next, unread, online: !lastFailed || (lr && lr.status === 'partial'), offlineNotice: lastFailed && lr.status === 'failed' ? 'Online synchronization is unavailable - showing previously discovered updates.' : '', prefs };
  };
  const prefsOnly = n => { const p = getPrefs(); return p.categories[n] !== false; };
  const listNotifications = (f = {}) => {
    const rows = db.prepare('SELECT n.*, i.url FROM wada_notifications n JOIN wada_items i ON i.id=n.item_id JOIN wada_sources s ON s.id=i.source_id WHERE s.enabled=1 ORDER BY n.detected_at DESC, n.id DESC LIMIT 500').all();
    return rows.filter(r => (f.unread ? !r.read_at : true) && (f.ignoreCategoryFilter || prefsOnly(r.category)));
  };
  const listItems = (f = {}) => db.prepare('SELECT i.* FROM wada_items i JOIN wada_sources s ON s.id=i.source_id WHERE s.enabled=1 ORDER BY i.first_seen DESC, i.id DESC LIMIT 1000').all().filter(r => (!f.category || r.category === f.category) && (!f.status || r.last_status === f.status));
  const markRead = (ids, read) => { const st = db.prepare('UPDATE wada_notifications SET read_at=? WHERE id=?'); db.transaction(() => (ids || []).forEach(id => st.run(read ? isoNow() : null, id)))(); onChange(); return status().unread; };
  const markAllRead = () => { db.prepare('UPDATE wada_notifications SET read_at=? WHERE read_at IS NULL').run(isoNow()); onChange(); return 0; };
  const history = (n = 50) => ({ runs: db.prepare('SELECT * FROM wada_sync_runs ORDER BY id DESC LIMIT ?').all(n), errors: db.prepare('SELECT * FROM wada_errors ORDER BY id DESC LIMIT 200').all() });
  const itemById = id => db.prepare('SELECT * FROM wada_items WHERE id=?').get(id);
  const VERDICTS = ['unverified', 'substantive', 'not_substantive'];
  const verify = (id, a = {}) => {
    const it = itemById(id); if (!it) throw new Error('Unknown update');
    if (!VERDICTS.includes(a.verdict)) throw new Error('Verdict must be one of: ' + VERDICTS.join(', '));
    if (it.last_status !== 'changed' && it.last_status !== 'new' && a.verdict !== 'unverified') throw new Error('Only items with a detected change or newly detected items can be verified');
    if (a.verdict !== 'unverified' && !String(a.user || '').trim()) throw new Error('The verifying user must be recorded');
    const unv = a.verdict === 'unverified';
    db.prepare('UPDATE wada_items SET verification=?, verification_note=?, verified_by=?, verified_at=? WHERE id=?').run(a.verdict, unv ? null : String(a.note || '').slice(0, 500), unv ? null : String(a.user).slice(0, 80), unv ? null : isoNow(), id);
    onChange(); return itemById(id);
  };
  const legacyRecords = () => db.prepare("SELECT * FROM wada_items WHERE kind='news' ORDER BY published DESC, first_seen DESC LIMIT 120").all().map(r => ({ NewsID: 'WADA-' + Buffer.from(r.url).toString('base64url').slice(0, 18), Date: r.published || r.first_seen.slice(0, 10), Category: 'WADA', Title: r.title, Source: 'WADA', Link: r.url, Text: r.summary || '', Image: '', WadaSyncedAt: r.last_checked }));

  /* ----- document download (only when a direct, official, supported document link exists) ----- */
  const MAX_DL = 100 * 1024 * 1024, MAGIC = { '.pdf': b => b.slice(0, 5).toString() === '%PDF-', '.docx': b => b[0] === 0x50 && b[1] === 0x4b, '.xlsx': b => b[0] === 0x50 && b[1] === 0x4b, '.doc': b => b[0] === 0xd0 && b[1] === 0xcf, '.xls': b => b[0] === 0xd0 && b[1] === 0xcf };
  const download = async (root, url, filename, itemId) => {
    const at = isoNow(), rec = (status, extra = {}) => db.prepare('INSERT INTO wada_downloads (item_id,url,path,size,sha256,status,error,at) VALUES (?,?,?,?,?,?,?,?)').run(itemId || null, url, extra.path || null, extra.size || null, extra.sha || null, status, extra.error || null, at);
    try {
      const u = new URL(url), ext = path.extname(u.pathname).toLowerCase();
      if (u.protocol !== 'https:' || u.hostname !== HOST) throw new Error('Only HTTPS files hosted by www.wada-ama.org may be downloaded');
      if (!MAGIC[ext]) throw new Error('Unsupported file type (' + (ext || 'none') + '). Only PDF, Word and Excel documents are downloaded; open other items on the website');
      const res = await fetchImpl(u.href, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (res.url && !officialUrl(res.url, u.href)) throw new Error('Redirected outside wada-ama.org');
      if (!res.ok) throw httpError(u.href, res.status, res);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_DL) throw new Error('File larger than 100 MB'); if (!buf.length) throw new Error('Empty file');
      if (!MAGIC[ext](buf)) throw new Error('File content does not match its extension - rejected');
      const dir = path.join(root, 'WADA Documents'); fs.mkdirSync(dir, { recursive: true });
      const safe = String(filename || path.basename(u.pathname)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150) || 'wada-document' + ext;
      let file = path.join(dir, safe); if (fs.existsSync(file)) file = path.join(dir, Date.now() + '-' + safe);
      fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o644 }); // never executed, never opened by the app itself
      const hash = sha(buf); rec('downloaded', { path: file, size: buf.length, sha: hash });
      return { path: file, size: buf.length, sha256: hash, url: u.href };
    } catch (e) { rec('failed', { error: String(e.message || e).slice(0, 300) }); throw e; }
  };

  /* ----- scheduler ----- */
  let timer = null;
  const due = () => { const p = getPrefs(); if (!p.autoEnabled || current) return false; const lr = lastRun("status!='running'"); if (!lr || !lr.finished_at) return true; return nowFn().getTime() - new Date(lr.finished_at).getTime() >= p.intervalHours * 3600e3; };
  const start = (tickMs = 60000, firstDelay = 15000) => { stop(); const tick = () => { if (due()) check('auto').catch(() => {}); }; timer = setInterval(tick, tickMs); if (timer.unref) timer.unref(); const f = setTimeout(tick, firstDelay); if (f.unref) f.unref(); };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const close = () => { stop(); try { db.close(); } catch (e) { /* ignore */ } };

  return { check, cancel, status, getPrefs, setPrefs, listNotifications, listItems, markRead, markAllRead, history, itemById, legacyRecords, download, verify, start, stop, close, due, db, CATEGORIES };
};

module.exports = { createMonitor, classifyError, classify, parseNewsList, parseResourcePage, parseIndex, parseDocuments, actionFor, officialUrl, MIGRATION_SQL, DEFAULT_SOURCES, DEFAULT_PREFS, CATEGORIES, HOST };

