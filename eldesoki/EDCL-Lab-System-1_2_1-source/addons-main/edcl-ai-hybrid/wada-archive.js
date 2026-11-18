'use strict';
/*
 * EDCL WADA Documents archive (add-on v2.0) - keeps its OWN database; the WADA monitor database is only READ (SELECT) and never changed.
 * (derived from EDCL WADA Documents archive v1.2.0)
 *
 * Sits on top of the WADA update monitor (wada-monitor.js). The monitor tells the laboratory THAT something on wada-ama.org
 * changed; this module keeps the actual official files so the laboratory can always see
 *      CURRENT version  and  PREVIOUS version
 * of every Technical Document (TD), Technical Letter (TL), International Standard, guideline and the Prohibited List, and
 * can compare them.
 *
 *  - Only public files hosted by www.wada-ama.org over HTTPS are downloaded (redirects off-site are refused).
 *  - Every file is stored once per distinct content (SHA-256) and is never overwritten or deleted by a later sync.
 *  - A file replaced in place by WADA (same address, new content) and a new edition published under a new address are both
 *    recognised as a new version; the older file stays available as "previous".
 *  - Files are only ever read as bytes; nothing downloaded is executed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = 'www.wada-ama.org';
const UA = 'EDCL-Lab-System-AI-Hybrid/2.0 (+public WADA document archive; contact: laboratory quality unit)';
const MAX_FILE = 100 * 1024 * 1024;
const MAGIC = {
  '.pdf': b => b.slice(0, 5).toString() === '%PDF-',
  '.docx': b => b[0] === 0x50 && b[1] === 0x4b, '.xlsx': b => b[0] === 0x50 && b[1] === 0x4b,
  '.doc': b => b[0] === 0xd0 && b[1] === 0xcf, '.xls': b => b[0] === 0xd0 && b[1] === 0xcf
};
const DEFAULTS = { archive: true, categories: ['standards', 'prohibited_list'], maxFiles: 40, maxPages: 30, recheckHours: 20, timeoutMs: 45000 };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const isoNow = () => new Date().toISOString();

/* ---------------- document family (which documents are versions of the same thing) ---------------- */
const STD_CODES = 'ISL|ISTI|ISPPPI|ISTUE|ISCCS|ISRM|ISE|ISDP';
const lastSeg = u => { try { return decodeURIComponent(String(u || '').split('?')[0].split('/').filter(Boolean).pop() || ''); } catch (e) { return ''; } };
const verOf = s => { const m = String(s || '').match(/(?:(?<![A-Za-z])v|version\s*|index\s+)(\d+(?:\.\d+)?)/i); return m ? parseFloat(m[1]) : 0; }; // "v4.0", "_v4.0", "version 4", "Index 4.0"
const pathDate = u => { const m = String(u || '').match(/\/sites\/default\/files\/(\d{4})-(\d{2})\//); return m ? m[1] + '-' + m[2] : ''; };
const familyBase = (title, url) => {
  const t = String(title || ''), f = lastSeg(url), both = t + ' ' + f;
  let m;
  if ((m = both.match(/(?<![A-Za-z])TD[\s_-]?((?:19|20)\d{2})[\s_-]*index(?![a-z])/i))) return { key: 'TD-INDEX', label: 'Technical Documents Index', type: 'TD', year: +m[1], ver: verOf(both) };
  if ((m = t.match(/^\s*TD[\s_-]?((?:19|20)\d{2})([A-Z][A-Z0-9]*(?:\/[A-Z0-9]+)?)(?![a-z])/i) || f.match(/^td((?:19|20)\d{2})([a-z][a-z0-9]{1,9})/i) || both.match(/(?<![A-Za-z])TD[\s_-]?((?:19|20)\d{2})([A-Z][A-Z0-9]{1,9})(?![a-z])/))) {
    const code = m[2].replace(/\//g, '').toUpperCase();
    return { key: 'TD-' + code, label: 'Technical Document ' + code, type: 'TD', year: +m[1], ver: verOf(both) };
  }
  if ((m = both.match(/(?<![A-Za-z])TL[\s_-]?(\d{1,3})(?!\d)/i))) return { key: 'TL-' + (+m[1]), label: 'Technical Letter TL' + (+m[1]), type: 'TL', year: null, ver: verOf(both) };
  if ((m = both.match(new RegExp('(?<![A-Za-z])(' + STD_CODES + ')(?![A-Za-z])')))) { const y = both.match(/(20\d{2})/); return { key: 'STD-' + m[1], label: 'International Standard ' + m[1], type: 'Standard', year: y ? +y[1] : null, ver: verOf(both) }; }
  if (/international[\s_-]standard[\s_-]for[\s_-]laboratories/i.test(both)) { const y = both.match(/(20\d{2})/); return { key: 'STD-ISL', label: 'International Standard ISL', type: 'Standard', year: y ? +y[1] : null, ver: verOf(both) }; }
  if (/monitoring[\s_-]program/i.test(both)) { const y = both.match(/(20\d{2})/); return { key: 'PL-MONITORING', label: 'Monitoring Program', type: 'Prohibited List', year: y ? +y[1] : null, ver: 0 }; }
  if (/explanatory[\s_-]note|summary[\s_-]of[\s_-]major/i.test(both)) { const y = both.match(/(20\d{2})/); return { key: 'PL-NOTES', label: 'Prohibited List - Summary of Major Modifications', type: 'Prohibited List', year: y ? +y[1] : null, ver: 0 }; }
  if (/prohibited[\s_-]list|\d{4}list_en/i.test(both)) { const y = both.match(/(20\d{2})/); return { key: 'PL', label: 'Prohibited List', type: 'Prohibited List', year: y ? +y[1] : null, ver: 0 }; }
  const y = both.match(/(20\d{2})/);
  const norm = t.toLowerCase().replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b(v|version)\s*\d+(\.\d+)?\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || f.toLowerCase();
  return { key: 'DOC-' + norm, label: t.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim() || f, type: 'Other', year: y ? +y[1] : null, ver: verOf(both) };
};

// translations (…_fr_…, …_es_…) are separate document lines, never the "previous version" of the English text
const familyOf = (title, url) => {
  const f = familyBase(title, url), m = lastSeg(url).match(/[_-](fr|es|ru|ar|de|pt|zh|it)(?=[_.-])/i) || (/^\s*R[ée]sum[ée]\b/i.test(title) ? [null, 'fr'] : null);
  return m ? { ...f, key: f.key + '-' + m[1].toUpperCase(), label: f.label + ' (' + m[1].toUpperCase() + ')' } : f;
};

const create = (opts = {}) => {
  const db = opts.db, mdb = opts.monitorDb, fetchImpl = opts.fetchImpl, root = opts.root, officialUrl = opts.officialUrl, parseResourcePage = opts.parseResourcePage;
  const onNotify = opts.onNotify || (() => {}), onChange = opts.onChange || (() => {}), classifyError = opts.classifyError || (() => ({ stage: 'request', category: 'unknown' }));
  const nowFn = opts.now || (() => new Date());
  if (!db || !mdb || !root || !officialUrl) throw new Error('wada-archive: db, monitorDb, root and officialUrl are required');
  const roDb = { prepare: sql => { if (!/^\s*select\b/i.test(sql)) throw new Error('The WADA monitor database is read-only for this add-on'); return mdb.prepare(sql); } };
  const dir = path.join(root, 'WADA Documents', 'archive');
  db.exec(`CREATE TABLE IF NOT EXISTS wada_doc_files (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, title TEXT, url TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, etag TEXT, last_modified TEXT, fetched_at TEXT NOT NULL, UNIQUE(item_id, sha256));
    CREATE INDEX IF NOT EXISTS idx_docfiles_item ON wada_doc_files(item_id);
    CREATE TABLE IF NOT EXISTS wada_doc_meta (item_id INTEGER PRIMARY KEY, file_url TEXT, published TEXT, status TEXT, updated TEXT, checked_at TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS wada_doc_checks (item_id INTEGER PRIMARY KEY, last_checked TEXT, result TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS wada_doc_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wada_doc_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source_url TEXT, category TEXT, http_status INTEGER, message TEXT);
    CREATE TABLE IF NOT EXISTS wada_doc_events (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, sha256 TEXT, title TEXT, kind TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(item_id, sha256, kind));`);
  let running = null;

  /* ----- preferences (stored beside the monitor's own, keys "docs.*") ----- */
  const getPrefs = () => {
    const o = { ...DEFAULTS, categories: DEFAULTS.categories.slice() };
    for (const r of db.prepare("SELECT key,value FROM wada_doc_prefs WHERE key LIKE 'docs.%'").all()) { try { o[r.key.slice(5)] = JSON.parse(r.value); } catch (e) { /* ignore */ } }
    return o;
  };
  const setPrefs = p => {
    const cur = getPrefs(), n = { ...cur };
    if (p.archive !== undefined) n.archive = !!p.archive;
    if (Array.isArray(p.categories)) n.categories = p.categories.filter(c => ['standards', 'prohibited_list', 'rules', 'education', 'other'].includes(c));
    for (const [k, lo, hi] of [['maxFiles', 1, 500], ['maxPages', 1, 200], ['recheckHours', 1, 720]]) if (p[k] !== undefined) { const v = Number(p[k]); if (!(v >= lo && v <= hi)) throw new Error(k + ' must be between ' + lo + ' and ' + hi); n[k] = v; }
    const up = db.prepare('INSERT INTO wada_doc_prefs (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    db.transaction(() => { for (const k of ['archive', 'categories', 'maxFiles', 'maxPages', 'recheckHours']) up.run('docs.' + k, JSON.stringify(n[k])); })();
    return n;
  };

  const recordError = (url, e) => {
    const c = classifyError(e); const msg = String((e && e.message) || e).slice(0, 300);
    try { db.prepare('INSERT INTO wada_doc_errors (at,source_url,category,http_status,message) VALUES (?,?,?,?,?)').run(isoNow(), url, (e && e.category) || c.category || 'unknown', (e && e.status) || null, 'Document archive: ' + msg); } catch (x) { /* never let logging break a sync */ }
    return msg;
  };

  const netGet = async (url, headers) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== HOST) throw Object.assign(new Error('Only HTTPS addresses on www.wada-ama.org are allowed'), { category: 'blocked' });
    const ctl = new AbortController(), timeoutMs = getPrefs().timeoutMs; let timer;
    const to = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(Object.assign(new Error('timeout after ' + timeoutMs + ' ms'), { code: 'ETIMEDOUT' })); }, timeoutMs); });
    try {
      const res = await Promise.race([fetchImpl(u.href, { headers: { 'User-Agent': UA, ...(headers || {}) }, redirect: 'follow', signal: ctl.signal }), to]);
      if (res.url && !officialUrl(res.url, u.href)) throw Object.assign(new Error('Redirected outside wada-ama.org; not followed'), { category: 'redirect_offsite' });
      if (res.status === 304) return { status: 304, headers: res.headers };
      if (res.status < 200 || res.status >= 300) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status, category: res.status === 404 ? 'not_found' : res.status === 403 ? 'forbidden' : 'http_error' });
      const buf = Buffer.from(await Promise.race([res.arrayBuffer(), to]));
      return { status: res.status, headers: res.headers, buf };
    } finally { clearTimeout(timer); }
  };
  const hdr = (h, n) => { try { return (h && h.get && h.get(n)) || null; } catch (e) { return null; } };

  /* ----- candidates: which monitored items carry (or lead to) an official file ----- */
  const latestParts = id => { const r = roDb.prepare('SELECT parts FROM wada_item_versions WHERE item_id=? ORDER BY id DESC LIMIT 1').get(id); try { return r && r.parts ? JSON.parse(r.parts) : {}; } catch (e) { return {}; } };
  const eligible = () => {
    const items = roDb.prepare("SELECT i.* FROM wada_items i JOIN wada_sources s ON s.id=i.source_id AND s.enabled=1 WHERE i.kind IN ('document','index') ORDER BY i.id").all();
    const meta = new Map(db.prepare('SELECT * FROM wada_doc_meta').all().map(m => [m.item_id, m]));
    return items.map(i => { const m = meta.get(i.id) || {}; return { ...i, m_file: m.file_url || null, m_pub: m.published || null, m_status: m.status || null, m_checked: m.checked_at || null, m_error: m.error || null }; });
  };

  const fetchMeta = async item => {
    const res = await netGet(item.url, { Accept: 'text/html,application/xhtml+xml' });
    const html = res.buf.toString('utf8'); const rp = parseResourcePage(html, item.url, item.category, item.title);
    const dl = rp.docs.find(d => d.primary) || rp.docs.find(d => /\.pdf$/i.test(d.url)) || null, pt = (rp.page && rp.page.parts) || {};
    db.prepare('INSERT INTO wada_doc_meta (item_id,file_url,published,status,updated,checked_at,error) VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(item_id) DO UPDATE SET file_url=excluded.file_url, published=excluded.published, status=excluded.status, updated=excluded.updated, checked_at=excluded.checked_at, error=NULL').run(item.id, dl ? dl.url : null, pt.published || '', pt.status || '', pt.updated || '', isoNow());
    return dl ? dl.url : null;
  };

  const saveFile = (item, fileUrl, buf, res) => {
    const ext = path.extname(new URL(fileUrl).pathname).toLowerCase(), h = sha(buf);
    const d = path.join(dir, String(item.id)); fs.mkdirSync(d, { recursive: true });
    const stamp = isoNow().replace(/[-:T]/g, '').slice(0, 14), base = path.basename(new URL(fileUrl).pathname).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'document' + ext;
    const file = path.join(d, stamp + '-' + h.slice(0, 8) + '-' + base);
    fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o644 });
    const r = db.prepare('INSERT INTO wada_doc_files (item_id,title,url,path,size,sha256,etag,last_modified,fetched_at) VALUES (?,?,?,?,?,?,?,?,?)').run(item.id, item.title, fileUrl, file, buf.length, h, hdr(res.headers, 'etag'), hdr(res.headers, 'last-modified'), isoNow());
    return { id: Number(r.lastInsertRowid), path: file, sha256: h };
  };

  /* ----- sync ----- */
  const sync = async (o = {}) => {
    if (running) return running;
    running = (async () => {
      const prefs = getPrefs(), out = { pagesChecked: 0, filesChecked: 0, newFiles: 0, changedFiles: 0, unchanged: 0, deferred: 0, skipped: 0, failed: 0, errors: [], at: isoNow() };
      const cats = new Set(prefs.categories), cand = eligible().filter(i => cats.has(i.category) && (!o.itemIds || o.itemIds.includes(i.id)));
      const hours = prefs.recheckHours, isDue = (ts, failed) => o.force || !ts || (nowFn().getTime() - new Date(ts).getTime()) >= (failed ? Math.min(2, hours) : hours) * 3600e3; // a failed check is retried after 2 hours, a good one after recheckHours
      let pages = 0, files = 0, netFails = 0; const claimed = new Set(), toastItems = [];
      const ordered = [...cand.filter(i => i.kind === 'document'), ...cand.filter(i => i.kind === 'index')];
      const lastFile = id => db.prepare('SELECT * FROM wada_doc_files WHERE item_id=? ORDER BY id DESC LIMIT 1').get(id);
      // items never archived first, then the longest unchecked
      ordered.sort((a, b) => (!!lastFile(a.id) - !!lastFile(b.id)) || String((db.prepare('SELECT last_checked FROM wada_doc_checks WHERE item_id=?').get(a.id) || {}).last_checked || '').localeCompare(String((db.prepare('SELECT last_checked FROM wada_doc_checks WHERE item_id=?').get(b.id) || {}).last_checked || '')));
      for (const item of ordered) {
        if (o.cancelled && o.cancelled()) break;
        if (netFails >= 3) { out.deferred++; continue; } // the connection itself is down: stop hammering
        const chk = db.prepare('SELECT * FROM wada_doc_checks WHERE item_id=?').get(item.id), last = lastFile(item.id); let fileUrlKnown = false;
        try {
          let fileUrl = item.kind === 'document' ? item.url : item.m_file;
          if (item.kind === 'index') {
            if (isDue(item.m_checked, !!item.m_error)) { if (pages >= prefs.maxPages) { out.deferred++; continue; } pages++; out.pagesChecked++; fileUrl = await fetchMeta(item); }
          }
          fileUrlKnown = true;
          if (!fileUrl) { db.prepare('INSERT INTO wada_doc_checks (item_id,last_checked,result,error) VALUES (?,?,?,NULL) ON CONFLICT(item_id) DO UPDATE SET last_checked=excluded.last_checked, result=excluded.result, error=NULL').run(item.id, isoNow(), 'no_file'); continue; }
          if (claimed.has(fileUrl)) continue; claimed.add(fileUrl);
          const ext = path.extname(new URL(fileUrl).pathname).toLowerCase(); if (!MAGIC[ext]) continue;
          if (chk && !isDue(chk.last_checked, chk.result === 'failed') && (!last || last.url === fileUrl)) { out.skipped++; continue; }
          if (files >= prefs.maxFiles) { out.deferred++; continue; } files++; out.filesChecked++;
          const cond = {}; if (last && last.url === fileUrl) { if (last.etag) cond['If-None-Match'] = last.etag; if (last.last_modified) cond['If-Modified-Since'] = last.last_modified; }
          const res = await netGet(fileUrl, cond); netFails = 0;
          const mark = r => db.prepare('INSERT INTO wada_doc_checks (item_id,last_checked,result,error) VALUES (?,?,?,NULL) ON CONFLICT(item_id) DO UPDATE SET last_checked=excluded.last_checked, result=excluded.result, error=NULL').run(item.id, isoNow(), r);
          if (res.status === 304) { mark('unchanged'); out.unchanged++; continue; }
          const buf = res.buf; if (!buf.length) throw new Error('Empty file'); if (buf.length > MAX_FILE) throw new Error('File larger than 100 MB'); if (!MAGIC[ext](buf)) throw new Error('File content does not match its extension - rejected');
          const h = sha(buf), same = db.prepare('SELECT * FROM wada_doc_files WHERE item_id=? AND sha256=?').get(item.id, h);
          if (same) { db.prepare('UPDATE wada_doc_files SET etag=COALESCE(?,etag), last_modified=COALESCE(?,last_modified) WHERE id=?').run(hdr(res.headers, 'etag'), hdr(res.headers, 'last-modified'), same.id); mark('unchanged'); out.unchanged++; continue; }
          const saved = saveFile(item, fileUrl, buf, res); mark(last ? 'new_version' : 'first_copy');
          if (last) {
            out.changedFiles++; const when = isoNow();
            const n = db.prepare('INSERT OR IGNORE INTO wada_doc_events (item_id,sha256,title,kind,at) VALUES (?,?,?,?,?)').run(item.id, saved.sha256, item.title, 'new_version', when);
            if (n.changes) toastItems.push({ id: Number(n.lastInsertRowid), title: item.title + ' - new file version', category: item.category, kind: 'changed' });
          } else out.newFiles++;
        } catch (e) {
          out.failed++; const msg = recordError(item.kind === 'index' && !item.m_file ? item.url : (item.kind === 'document' ? item.url : item.m_file || item.url), e);
          if (/ETIMEDOUT|ENOTFOUND|ECONN|EAI_AGAIN|fetch failed|network/i.test(String(e && (e.code || e.message)))) netFails++; else netFails = 0;
          out.errors.push({ itemId: item.id, title: item.title, message: msg });
          if (item.kind === 'index' && !fileUrlKnown) db.prepare('INSERT INTO wada_doc_meta (item_id,checked_at,error) VALUES (?,?,?) ON CONFLICT(item_id) DO UPDATE SET checked_at=excluded.checked_at, error=excluded.error').run(item.id, isoNow(), msg);
          db.prepare('INSERT INTO wada_doc_checks (item_id,last_checked,result,error) VALUES (?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET last_checked=excluded.last_checked, result=excluded.result, error=excluded.error').run(item.id, isoNow(), 'failed', msg);
        }
      }
      if (toastItems.length) { try { onNotify(toastItems); } catch (e) { /* ignore */ } }
      onChange(); return out;
    })();
    try { return await running; } finally { running = null; }
  };

  /* ----- queries ----- */
  const fileRows = id => db.prepare('SELECT id,item_id,url,size,sha256,fetched_at FROM wada_doc_files WHERE item_id=? ORDER BY id DESC').all(id);
  const list = () => {
    const prefs = getPrefs(), items = eligible().filter(i => prefs.categories.includes(i.category));
    const byFam = new Map();
    for (const it of items) {
      const fam = familyOf(it.title, it.kind === 'document' ? it.url : (it.m_file || it.url)), fileUrl = it.kind === 'document' ? it.url : it.m_file;
      const files = fileRows(it.id), pub = it.m_pub || it.published || '', pd = pathDate(fileUrl || it.url) || '';
      if (!byFam.has(fam.key)) byFam.set(fam.key, { key: fam.key, label: fam.label, type: fam.type, category: it.category, items: [] });
      byFam.get(fam.key).items.push({ it, fam, files, fileUrl, date: pub || pd || '', status: it.m_status || '' });
    }
    const groups = [];
    for (const g of byFam.values()) {
      g.items.sort((a, b) => ((b.fam.year || 0) - (a.fam.year || 0)) || (b.fam.ver - a.fam.ver) || b.date.localeCompare(a.date) || b.it.first_seen.localeCompare(a.it.first_seen) || b.it.id - a.it.id);
      const versions = [];
      for (const x of g.items) {
        const base = { itemId: x.it.id, title: x.it.title, year: x.fam.year, published: x.date, status: x.status, pageUrl: x.it.kind === 'index' ? x.it.url : '', sourceUrl: x.fileUrl || '', checked: null };
        if (!x.files.length) versions.push({ ...base, fileId: null, sha256: null, size: null, fetchedAt: null, archived: false });
        else for (const f of x.files) versions.push({ ...base, sourceUrl: f.url, fileId: f.id, sha256: f.sha256, size: f.size, fetchedAt: f.fetched_at, archived: true });
      }
      let ci = versions.findIndex(v => /in force/i.test(v.status)); if (ci < 0) ci = 0;
      const rest = versions.filter((_, i) => i !== ci);
      g.versions = [versions[ci], ...rest].map((v, i) => ({ ...v, role: i === 0 ? 'current' : i === 1 ? 'previous' : 'older' }));
      g.current = g.versions[0]; g.previous = g.versions[1] || null;
      g.title = g.items[0].it.title; g.recentChange = !!(g.previous && g.current.fetchedAt && (nowFn().getTime() - new Date(g.current.fetchedAt).getTime()) < 30 * 864e5 && g.versions.some(v => v.archived && v !== g.current));
      g.archivedCount = g.versions.filter(v => v.archived).length; delete g.items; groups.push(g);
    }
    groups.sort((a, b) => (b.recentChange - a.recentChange) || a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
    const events = db.prepare("SELECT * FROM wada_doc_events ORDER BY id DESC LIMIT 30").all(), total = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) s FROM wada_doc_files').get(), fails = db.prepare("SELECT COUNT(*) n FROM wada_doc_checks WHERE result='failed'").get().n, lastC = db.prepare('SELECT MAX(last_checked) t FROM wada_doc_checks').get().t;
    return { groups, prefs, totals: { documents: groups.length, files: total.n, bytes: total.s, failed: fails, lastChecked: lastC || null, syncing: !!running }, events };
  };
  const fileInfo = id => {
    const r = db.prepare('SELECT * FROM wada_doc_files WHERE id=?').get(Number(id)); if (!r) throw new Error('Unknown archived file');
    const abs = path.resolve(r.path), base = path.resolve(dir) + path.sep; if (!abs.startsWith(base)) throw new Error('Archived file is outside the archive folder');
    return { ...r, path: abs };
  };
  const read = id => {
    const r = fileInfo(id); if (!fs.existsSync(r.path)) throw new Error('The archived file is missing from disk: ' + path.basename(r.path));
    const buf = fs.readFileSync(r.path); if (sha(buf) !== r.sha256) throw new Error('Integrity check failed: the archived file no longer matches its recorded SHA-256');
    return { buffer: buf, name: path.basename(r.path).replace(/^\d{14}-[0-9a-f]{8}-/, ''), sha256: r.sha256, title: r.title, url: r.url, size: buf.length, fetchedAt: r.fetched_at };
  };
  const shas = () => new Set(db.prepare('SELECT sha256 FROM wada_doc_files').all().map(r => r.sha256));
  const lastMonitorRun = () => { try { return roDb.prepare("SELECT MAX(finished_at) t FROM wada_sync_runs WHERE status IN ('ok','partial')").get().t || null; } catch (e) { return null; } };
  return { sync, list, read, fileInfo, getPrefs, setPrefs, familyOf, shas, lastMonitorRun, isRunning: () => !!running, dir };
};

module.exports = { create, familyOf, pathDate, DEFAULTS, UA };
