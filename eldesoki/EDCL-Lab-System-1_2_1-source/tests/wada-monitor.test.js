'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const Database = require('better-sqlite3');
const M = require('../wada-monitor');
const { createMonitor, classifyError } = M;
const FX = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const ROUTES = { '/en/media/news': 'news.html', '/en/resources/world-anti-doping-code-and-international-standards/prohibited-list': 'prohibited-list.html', '/en/what-we-do/international-standards': 'international-standards.html', '/en/resources/lab-documents/technical-documents-index': 'technical-documents-index.html' };
const U = { news: 'https://www.wada-ama.org/en/media/news', pl: 'https://www.wada-ama.org/en/resources/world-anti-doping-code-and-international-standards/prohibited-list', std: 'https://www.wada-ama.org/en/what-we-do/international-standards', td: 'https://www.wada-ama.org/en/resources/lab-documents/technical-documents-index' };
const P = u => new URL(u).pathname;

/* ---- mock WADA server serving the saved fixtures over real HTTP ---- */
let hits = {}, plan = {}, over = {}, server, port;
test.before(async () => {
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1; const p = plan[req.url], st = p && (typeof p === 'function' ? p(hits[req.url]) : p);
    if (st && st.status) { res.writeHead(st.status, st.headers || {}); return res.end(st.body || ''); } if (st && st.destroy) return req.socket.destroy(); if (st && st.hang) return;
    if (over[req.url] !== undefined) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(over[req.url]); }
    if (ROUTES[req.url]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(FX(ROUTES[req.url])); }
    if (req.url.endsWith('2026list_en_final_clean_september_2025.pdf')) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(Buffer.from('%PDF-1.7\n%test pdf content')); }
    if (req.url.endsWith('fake.pdf')) { res.writeHead(200); return res.end('<html>not a pdf</html>'); }
    res.writeHead(404); res.end('nf');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); port = server.address().port;
});
test.after(() => server.close());
const toLocal = (url, opt = {}) => fetch('http://127.0.0.1:' + port + new URL(url).pathname, opt).then(res => { Object.defineProperty(res, 'url', { value: url }); return res; });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wada-t-'));
const mk = (dir, extra = {}) => { const sleeps = [], notified = []; const m = createMonitor({ dbPath: path.join(dir || tmp(), 'w.sqlite'), fetchImpl: toLocal, sleep: async ms => { sleeps.push(ms); }, onNotify: n => notified.push(...n), ...extra }); m._sleeps = sleeps; m._notified = notified; return m; };
const reset = () => { hits = {}; plan = {}; over = {}; };
const notes = m => m.db.prepare('SELECT * FROM wada_notifications').all();
const item = (m, frag) => m.db.prepare('SELECT * FROM wada_items WHERE url LIKE ?').get('%' + frag + '%');

/* =========================== A. SOURCE PARSERS vs SAVED FIXTURES =========================== */
test('A1 news parser: real listing structure -> clean titles, dates, types, canonical URLs, no duplicates', () => {
  const items = M.parseNewsList(FX('news.html'), U.news, 'news');
  assert.equal(items.length, 10, 'six latest + four stories');
  const first = items[0]; assert.equal(first.title, 'REMINDER: Save the date for WADA’s 2027 Annual Symposium'); assert.equal(first.published, '2026-10-20'); assert.equal(first.itemType, 'Releases'); assert.equal(first.url, 'https://www.wada-ama.org/en/news/reminder-save-date-wadas-2027-annual-symposium');
  assert.ok(items.every(i => !/Read more on|symposium-top-down|\d{1,2} \w{3} \d{4}/.test(i.title)), 'no alt text, dates or "Read more" in titles');
  assert.ok(items.every(i => /^https:\/\/www\.wada-ama\.org\/en\/news\//.test(i.url)) && new Set(items.map(i => i.url)).size === 10);
  assert.equal(items.filter(i => i.itemType === 'Story').length, 4); assert.equal(items[1].published, '2026-10-16'); assert.equal(items.at(-1).published, '2022-06-03');
  assert.equal(items.find(i => /Stakeholder Engagement/.test(i.title)).title, 'Spotlight - Stakeholder Engagement & Partnerships', 'HTML entities decoded');
});
test('A2 resource-page parser (Prohibited List): publication date, status, current download, og:updated_time, documents', () => {
  const { page, docs } = M.parseResourcePage(FX('prohibited-list.html'), U.pl, 'prohibited_list', 'PL');
  assert.equal(page.title, 'Prohibited List'); assert.deepEqual(page.parts, { published: '2026-01-01', status: 'In force', download: 'https://www.wada-ama.org/sites/default/files/2025-09/2026list_en_final_clean_september_2025.pdf', updated: '2026-01-19T09:38:43-05:00' });
  assert.ok(page.textLen > 400 && /went into effect on 1 January 2026/.test(page.text));
  assert.equal(docs[0].primary, true); assert.equal(docs[0].title, 'Prohibited List - current download'); assert.equal(docs.length, 12);
  assert.ok(docs.slice(1).every(d => !/\(PDF,|Active$/.test(d.title)), 'file size / status suffix removed');
  assert.match(docs[1].url, /2025-09/, 'newest files first'); assert.ok(docs.some(d => d.title === '2026 Monitoring Program'));
});
test('A3 index parser (International Standards): TDs, TLs, guidelines and standards with descriptions; no duplicates; fragments removed', () => {
  const items = M.parseIndex(FX('international-standards.html'), U.std, 'standards');
  const td = items.filter(i => /\/lab-documents\/td2/.test(i.url)); assert.equal(td.length, 15, 'all 15 Technical Documents');
  assert.equal(td.find(i => /td2026dbs$/.test(i.url)).title, 'TD2026DBS - Dried Blood Spots (DBS) for Doping Control Requirements and Procedures for Analytical Testing and Sample Storage');
  assert.equal(td.find(i => /td2021cglh$/.test(i.url)).title.startsWith('TD2021CG/LH - Analysis, Reporting & Management'), true);
  const tl = items.filter(i => /\/tl\d+$/.test(i.url)); assert.equal(tl.length, 7); assert.ok(tl.some(i => i.url.endsWith('/lab-documents/tl23')), '#resource-download fragment removed');
  assert.equal(items.filter(i => /guidelines?/i.test(i.url)).length, 5); assert.equal(items.filter(i => /world-anti-doping-code-and-international-standards\/international-standard-/.test(i.url)).length, 3);
  assert.equal(items.length, 32, 'TDIndex/TLIndex linked twice on the page but stored once'); assert.equal(new Set(items.map(i => i.url)).size, items.length);
  const skip = new Set(M.DEFAULT_SOURCES.map(s => s.url)); const own = M.parseIndex(FX('international-standards.html'), U.std, 'standards', skip); assert.equal(own.length, 31, 'the Technical Documents Index is its own source and is not duplicated here'); assert.ok(!own.some(i => i.url === U.td));
  assert.ok(items.filter(i => /td20|tl\d/.test(i.url)).every(i => i.category === 'standards'));
});
test('A4 resource-page parser (Technical Documents Index): current download and archive versions', () => {
  const { page, docs } = M.parseResourcePage(FX('technical-documents-index.html'), U.td, 'standards', 'TD');
  assert.equal(page.parts.published, '2026-09-11'); assert.equal(page.parts.status, 'In force'); assert.match(page.parts.download, /td2026_index_v4\.0/); assert.equal(page.parts.updated, '2026-09-16T11:11:29-04:00');
  assert.equal(docs.length, 9); assert.equal(docs[1].title, 'TD2026 Index 3.0'); assert.ok(docs.at(-1).url.includes('/resources/files/'), 'undated legacy paths sorted last');
});
test('A5 all four configured source URLs are the official addresses captured from wada-ama.org (none guessed)', () => {
  assert.deepEqual(M.DEFAULT_SOURCES.map(s => s.url), [U.news, U.pl, U.std, U.td]);
  for (const s of M.DEFAULT_SOURCES) assert.ok(fs.existsSync(path.join(__dirname, 'fixtures', ROUTES[P(s.url)])), 'fixture exists for ' + s.id);
});
test('A6 URL canonicalisation: tracking parameters, fragments, trailing slashes, http and foreign hosts', () => {
  assert.equal(M.officialUrl('/en/news/x/?utm_source=a&utm_medium=b#top', U.news), 'https://www.wada-ama.org/en/news/x');
  assert.equal(M.officialUrl('https://WWW.WADA-AMA.ORG/en/news/x', U.news), 'https://www.wada-ama.org/en/news/x');
  assert.equal(M.officialUrl('http://www.wada-ama.org/en/news/x', U.news), null); assert.equal(M.officialUrl('https://evil.example/en/news/x', U.news), null);
  assert.equal(M.officialUrl('https://www.wada-ama.org/en/search?filters%5Bcontent_type%5D%5B%5D=%22news%22', U.news).includes('filters'), true);
});

/* =========================== B. FULL SYNC FROM FIXTURES =========================== */
test('B1 baseline run over all four sources: ok, items recorded, nothing announced, history accurate', async () => {
  reset(); const m = mk(); const r = await m.check('manual');
  assert.equal(r.status, 'ok'); assert.equal(r.failedSources, 0); assert.equal(notes(m).length, 0);
  const run = m.history().runs[0]; assert.equal(run.status, 'ok'); assert.equal(run.failed_sources, 0); assert.equal(run.new_count, 0); assert.equal(run.unchanged_count, m.listItems().length, 'every discovered item counted as unchanged baseline');
  const bySrc = Object.fromEntries(m.db.prepare('SELECT source_id, COUNT(*) n FROM wada_items GROUP BY source_id').all().map(x => [x.source_id, x.n])); assert.deepEqual(bySrc, { news: 10, 'prohibited-list-resource': 13, 'international-standards': 31, 'td-index': 10 });
  assert.ok(m.status().lastSuccess); m.close();
});

/* =========================== C. ERROR HANDLING =========================== */
test('C1 HTTP 404 on every source: failed run, 1 attempt each, actionable error rows, no success recorded', async () => {
  reset(); for (const k of Object.values(U)) plan[P(k)] = { status: 404 }; const m = mk(); const r = await m.check();
  assert.equal(r.status, 'failed'); assert.equal(r.failedSources, 4); assert.equal(m.status().lastSuccess, null); assert.equal(m.status().lastRun.status, 'failed'); assert.match(m.status().offlineNotice, /unavailable/i);
  for (const k of Object.values(U)) assert.equal(hits[P(k)], 1, 'permanent 404 not retried: ' + P(k));
  const errs = m.history().errors; assert.equal(errs.length, 4); assert.ok(errs.every(e => e.category === 'not_found' && e.stage === 'http' && e.http_status === 404 && /^https:\/\/www\.wada-ama\.org\//.test(e.source_url) && e.at && /no longer exists/.test(e.action)));
  assert.match(m.history().runs[0].message, /not_found/); m.close();
});
test('C2 network failure: classified, retried with exponential backoff, then fails fast on remaining sources; never "ok"', async () => {
  reset(); for (const k of Object.values(U)) plan[P(k)] = { destroy: true }; const m = mk(); const r = await m.check();
  assert.equal(r.status, 'failed'); assert.equal(hits[P(U.news)], 4, 'first source uses full retry budget'); assert.ok(Object.values(U).slice(1).every(k => hits[P(k)] === 1), 'remaining sources: single attempt once the network is clearly down');
  assert.ok(m._sleeps.length === 3 && m._sleeps[1] > m._sleeps[0] && m._sleeps[2] > m._sleeps[1], 'backoff ' + m._sleeps.join(',')); const e = m.history().errors[0]; assert.ok(['network', 'connect'].includes(e.category) || e.stage === 'connect'); assert.ok(e.action && e.action.length > 20); assert.equal(m.status().lastSuccess, null); m.close();
});
test('C3 empty results: HTTP 200 with a page that has no items is a FAILED check (parse_failed), not a success', async () => {
  reset(); over[P(U.news)] = '<html><head><title>News</title></head><body><main><h1>News</h1><p>No articles.</p></main></body></html>'; const m = mk(); const r = await m.check();
  assert.equal(r.status, 'partial'); const e = m.history().errors.find(x => x.category === 'parse_failed'); assert.ok(e); assert.equal(e.source_url, U.news); assert.match(e.message, /0 results/); assert.match(e.action, /layout/); assert.equal(m.status().lastSuccess, null, 'a partial run is not a successful sync');
  assert.equal(m.listItems().filter(i => i.source_id === 'news').length, 0); assert.equal(hits[P(U.news)], 1, 'parse failures are not retried'); m.close();
});
test('C4 changed page structures are detected for each parser kind (news, index, resource)', async () => {
  reset(); over[P(U.news)] = FX('news.html').replace(/\/en\/news\//g, '/en/stories-v2/'); over[P(U.std)] = '<html><main><h1>International Standards</h1><a href="/en/resources/lab-documents/td2026dbs">TD2026DBS</a> - x<br><a href="/en/resources/tl22">TL22</a></main></html>'; over[P(U.pl)] = '<html><head><title>Prohibited List</title></head><body><main></main></body></html>';
  const m = mk(); const r = await m.check(); assert.equal(r.status, 'partial'); assert.equal(r.failedSources, 3);
  const errs = m.history().errors.filter(e => e.category === 'parse_failed'); assert.equal(errs.length, 3); assert.ok(errs.some(e => /only 2 document links/.test(e.message)) && errs.some(e => /main content was empty/.test(e.message)) && errs.some(e => /no news items/.test(e.message)));
  assert.ok(errs.every(e => /parser in wada-monitor\.js needs updating/.test(e.action))); assert.equal(m.history().runs[0].failed_sources, 3); assert.equal(m.db.prepare("SELECT COUNT(*) n FROM wada_items WHERE source_id='td-index'").get().n, 10, 'the healthy source still synchronised'); m.close();
});
test('C5 duplicate news items: repeated anchors, tracking params, trailing slash and image-only anchors yield one record and one notification', async () => {
  reset(); const m = mk(); await m.check();
  const dup = FX('news.html').replace('<ul>\n<li><a href="https://www.wada-ama.org/en/news/reminder', '<ul>\n<li><a href="https://www.wada-ama.org/en/news/new-article-one"><img alt="x"></a></li>\n<li><a href="https://www.wada-ama.org/en/news/new-article-one?utm_source=nl"><span>21 Oct 2026</span> <span>Releases</span> <span>Read more on : WADA publishes new article number one</span></a></li>\n<li><a href="https://www.wada-ama.org/en/news/new-article-one/"><span>21 Oct 2026</span> <span>Releases</span> <span>Read more on : WADA publishes new article number one</span></a></li>\n<li><a href="https://www.wada-ama.org/en/news/reminder');
  over[P(U.news)] = dup; const items = M.parseNewsList(dup, U.news, 'news'); assert.equal(items.filter(i => /new-article-one/.test(i.url)).length, 1); assert.equal(items.find(i => /new-article-one/.test(i.url)).title, 'WADA publishes new article number one');
  let r = await m.check(); assert.equal(r.counts.new, 1); assert.equal(notes(m).length, 1); r = await m.check(); await m.check(); assert.equal(notes(m).length, 1); assert.equal(m.db.prepare("SELECT COUNT(*) n FROM wada_items WHERE url LIKE '%new-article-one%'").get().n, 1); m.close();
});
test('C6 sync history is accurate for success, partial and failed runs; lastSuccess only moves on a fully successful run', async () => {
  reset(); const m = mk(); const ok = await m.check(); const t1 = m.status().lastSuccess; assert.equal(ok.status, 'ok');
  plan[P(U.td)] = { status: 500 }; const part = await m.check(); assert.equal(part.status, 'partial'); assert.equal(m.status().lastSuccess, t1, 'partial run does not count as success');
  const runs = m.history().runs; assert.deepEqual(runs.map(r => r.status), ['partial', 'ok']); assert.equal(runs[0].failed_sources, 1); assert.match(runs[0].message, /Technical Documents Index: server_error/); assert.equal(hits[P(U.td)], 5, '1 request in the ok run + 4 attempts in the partial run');
  assert.equal(m.history().errors.filter(e => e.run_id === runs[0].id && e.source_url === U.td).length, 4, 'every attempt logged'); m.close();
});
test('C7 403 and 202 challenge are permanent, not retried, not bypassed; off-site redirect rejected', async () => {
  reset(); plan[P(U.news)] = { status: 403 }; plan[P(U.pl)] = { status: 202, body: 'challenge' }; const m = mk(); const r = await m.check(); assert.equal(r.status, 'partial'); assert.equal(hits[P(U.news)], 1); assert.equal(hits[P(U.pl)], 1);
  assert.deepEqual(m.history().errors.filter(e => e.category !== 'parse_failed').map(e => e.category).sort(), ['challenge', 'forbidden']); m.close();
  const m2 = mk(null, { fetchImpl: async url => ({ ok: true, status: 200, url: 'https://evil.example/x', headers: new Map(), text: async () => '<html/>' }) }); await m2.check(); assert.equal(m2.history().errors[0].category, 'redirect_offsite'); m2.close();
});
test('C8 503 x2 then 200: retried with backoff, run ok, no duplicate records', async () => {
  reset(); plan[P(U.news)] = n => (n <= 2 ? { status: 503, headers: { 'retry-after': '0' } } : null); const m = mk(); const r = await m.check(); assert.equal(r.status, 'ok'); assert.equal(hits[P(U.news)], 3);
  assert.equal(m.history().errors.filter(e => e.category === 'server_error').length, 2); const urls = m.listItems().map(i => i.url); assert.equal(new Set(urls).size, urls.length); assert.equal(notes(m).length, 0); m.close();
});
test('C9 timeout and cancellation; duplicate-request prevention', async () => {
  const slow = (u, o) => new Promise((res, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 15); o.signal && o.signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); }); });
  const m = createMonitor({ dbPath: path.join(tmp(), 'w.sqlite'), fetchImpl: slow, sleep: async () => {} }); const r = await m.check(); assert.equal(r.status, 'failed'); assert.equal(m.history().errors[0].category, 'timeout'); m.close();
  const hang = (u, o) => new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))));
  const m2 = createMonitor({ dbPath: path.join(tmp(), 'w.sqlite'), fetchImpl: hang, sleep: async () => {} }); const p = m2.check(); const p2 = m2.check(); await new Promise(r => setTimeout(r, 30)); assert.equal(m2.cancel(), true); const [a, b] = await Promise.all([p, p2]);
  assert.equal(a.status, 'cancelled'); assert.equal(m2.db.prepare('SELECT COUNT(*) n FROM wada_sync_runs').get().n, 1); assert.equal(m2.status().lastSuccess, null); m2.close();
});
test('C10 error classification covers Chromium and Node error texts', () => {
  const c = e => classifyError(e).category;
  assert.equal(c(new Error('net::ERR_NAME_NOT_RESOLVED')), 'dns'); assert.equal(c(new Error('net::ERR_CERT_AUTHORITY_INVALID')), 'tls_certificate'); assert.equal(c(new Error('net::ERR_PROXY_CONNECTION_FAILED')), 'proxy'); assert.equal(c(new Error('net::ERR_TIMED_OUT')), 'timeout'); assert.equal(c(new Error('net::ERR_CONNECTION_REFUSED')), 'network'); assert.equal(c(new Error('net::ERR_UNSAFE_PORT')), 'blocked');
  assert.equal(c(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'dns'); assert.equal(c(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })), 'tls_certificate'); assert.equal(c(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'network');
  for (const k of ['not_found', 'forbidden', 'challenge', 'parse_failed', 'dns', 'network', 'timeout', 'proxy', 'tls_certificate', 'server_error', 'rate_limited', 'redirect_offsite', 'empty_response']) assert.ok(M.actionFor(k).length > 30, 'actionable text for ' + k);
});

/* =========================== D. CHANGE DETECTION: DETECTED vs VERIFIED =========================== */
const plChange = (f) => { over[P(U.pl)] = f(FX('prohibited-list.html')); };
test('D1 structured change (publication date + current download) is DETECTED, announced once, and stays UNVERIFIED', async () => {
  reset(); const m = mk(); await m.check();
  plChange(h => h.replace('Publication date 01 Jan 26', 'Publication date 15 Sep 26').replace('2026list_en_final_clean_september_2025.pdf">Download', '2027list_en_final_clean_september_2026.pdf">Download'));
  const r = await m.check(); const n = notes(m); const page = item(m, 'prohibited-list');
  assert.equal(r.counts.changed, 1); assert.equal(n.filter(x => x.kind === 'changed').length, 1); assert.equal(n.find(x => x.kind === 'changed').significance, 'structured');
  assert.equal(page.verification, 'unverified'); const sig = JSON.parse(page.signals); assert.equal(sig.verified, false); assert.deepEqual(sig.changedFields.filter(f => f !== 'updated_time').sort(), ['download', 'published']);
  assert.equal(n.filter(x => x.kind === 'new').length, 1, 'the new 2027 PDF is a separate new-document item'); await m.check(); assert.equal(notes(m).length, 2, 'rechecking creates no further notifications'); m.close();
});
test('D2 metadata-only change (og:updated_time) is recorded as a version but NOT announced as a change', async () => {
  reset(); const m = mk(); await m.check(); plChange(h => h.replace('2026-01-19T09:38:43-05:00', '2026-10-21T08:00:00-04:00'));
  const r = await m.check(); const page = item(m, 'prohibited-list'); assert.equal(r.counts.changed, 1); assert.equal(notes(m).length, 0, 'no notification for a metadata-only change'); assert.equal(JSON.parse(page.signals).significance, 'minor'); assert.deepEqual(JSON.parse(page.signals).changedFields, ['updated_time']);
  assert.equal(m.db.prepare('SELECT COUNT(*) n FROM wada_item_versions WHERE item_id=?').get(page.id).n, 2, 'version history keeps it'); assert.equal(page.verification, 'unverified'); m.close();
});
test('D3 text edits are graded by size: small edit below threshold = minor (silent), larger edit = "text" change announced, with the measured percentage', async () => {
  reset(); const m = mk(); m.setPrefs({ minChangePct: 25 }); await m.check();
  plChange(h => h.replace('went into effect on 1 January 2026', 'went into effect on 2 January 2026')); await m.check(); const p1 = item(m, 'prohibited-list'); assert.equal(JSON.parse(p1.signals).significance, 'minor'); assert.equal(notes(m).length, 0); assert.ok(JSON.parse(p1.signals).changePct < 25);
  plChange(h => h.replace(/<p>The <a href="[^"]*#search-anchor">List<\/a>[\s\S]*?<\/p>\s*<p>A Summary[\s\S]*?<\/p>/, '<p>WADA has published a completely rewritten description of this resource with new requirements for all laboratories and anti-doping organizations effective immediately; read the explanatory notes carefully.</p>'));
  await m.check(); const p2 = item(m, 'prohibited-list'), s2 = JSON.parse(p2.signals); assert.equal(s2.significance, 'text'); assert.ok(s2.changePct >= 25, 'measured ' + s2.changePct + '%'); assert.equal(notes(m).filter(x => x.significance === 'text').length, 1); m.close();
});
test('D4 verification is a human decision: default unverified, requires a user, can be changed, and is reset by the next detected change', async () => {
  reset(); const m = mk(); await m.check(); plChange(h => h.replace('Publication date 01 Jan 26', 'Publication date 15 Sep 26')); await m.check(); const id = item(m, 'prohibited-list').id;
  assert.equal(item(m, 'prohibited-list').verification, 'unverified'); assert.throws(() => m.verify(id, { verdict: 'substantive', note: 'x' }), /user must be recorded/); assert.throws(() => m.verify(id, { verdict: 'confirmed', user: 'q' }), /Verdict must be/);
  const v = m.verify(id, { verdict: 'substantive', note: 'New publication date confirmed on WADA site', user: 'quality1' }); assert.equal(v.verification, 'substantive'); assert.equal(v.verified_by, 'quality1'); assert.ok(v.verified_at);
  assert.throws(() => m.verify(item(m, 'lab-documents/technical-documents-index').id, { verdict: 'substantive', user: 'q' }), /Only items with a detected change/);
  plChange(h => h.replace('Publication date 01 Jan 26', 'Publication date 20 Oct 26')); await m.check(); const again = item(m, 'prohibited-list'); assert.equal(again.verification, 'unverified', 'a new detected change resets the verdict'); assert.equal(again.verified_by, null); m.close();
});
test('D5 no code path produces a "verified" state automatically: after many varied changes every item is unverified', async () => {
  reset(); const m = mk(); await m.check(); plChange(h => h.replace('01 Jan 26', '02 Jan 26')); await m.check(); over[P(U.td)] = FX('technical-documents-index.html').replace('11 Sep 26', '01 Oct 26').replace('2026-09-16T11:11:29-04:00', '2026-10-01T00:00:00-04:00'); await m.check();
  over[P(U.news)] = FX('news.html').replace('REMINDER: Save the date for WADA’s 2027 Annual Symposium</span>', 'Save the date for the 2027 Symposium (updated)</span>'); await m.check();
  assert.ok(m.db.prepare("SELECT COUNT(*) n FROM wada_notifications WHERE kind='changed'").get().n >= 3, 'three different sources produced detected changes'); assert.equal(m.db.prepare("SELECT COUNT(*) n FROM wada_items WHERE verification!='unverified'").get().n, 0); m.close();
});
test('D6 news item with an edited title: change detected (possible), one notification, unverified', async () => {
  reset(); const m = mk(); await m.check(); over[P(U.news)] = FX('news.html').replace('Read more on : WADA approves lifting of Analytical Testing Restriction on the Warsaw Laboratory', 'Read more on : WADA lifts Analytical Testing Restriction on Warsaw Laboratory');
  await m.check(); const n = notes(m); assert.equal(n.length, 1); assert.equal(n[0].kind, 'changed'); assert.equal(n[0].significance, 'possible'); assert.equal(item(m, 'warsaw-laboratory').verification, 'unverified'); await m.check(); assert.equal(notes(m).length, 1); m.close();
});

/* =========================== E. NOTIFICATIONS, PERSISTENCE, MIGRATION, DOWNLOAD =========================== */
test('E1 new item after baseline -> exactly one notification and one desktop notification; unchanged recheck -> none', async () => {
  reset(); const m = mk(); await m.check(); over[P(U.news)] = FX('news.html').replace('<h2>Latest news</h2>\n<ul>', '<h2>Latest news</h2>\n<ul>\n<li><a href="https://www.wada-ama.org/en/news/wada-publishes-2027-code-policy"><span>21 Oct 2026</span> <span>Releases</span> <span>Read more on : WADA publishes 2027 Code policy update for signatories</span></a></li>');
  let r = await m.check(); assert.equal(r.counts.new, 1); assert.equal(notes(m).length, 1); assert.equal(m._notified.length, 1); assert.equal(notes(m)[0].category, 'rules'); r = await m.check(); assert.equal(r.newNotifications, 0); assert.equal(notes(m).length, 1); m.close();
});
test('E2 notifications, history, read status and preferences persist across restart', async () => {
  reset(); const dir = tmp(); let m = mk(dir); await m.check(); plChange(h => h.replace('01 Jan 26', '09 Sep 26')); await m.check(); const id = notes(m)[0].id; m.markRead([id], true); m.setPrefs({ intervalHours: 12, categories: { education: false } }); const runs = m.history().runs.length; m.close();
  m = mk(dir); assert.ok(notes(m).length >= 1); assert.ok(notes(m).find(n => n.id === id).read_at); assert.equal(m.history().runs.length, runs); assert.equal(m.getPrefs().intervalHours, 12); assert.equal(m.getPrefs().categories.education, false); m.markRead([id], false); assert.equal(m.status().unread >= 1, true); m.close();
});
test('E3 migration v1 -> v2 keeps existing data; retired (guessed) sources are hidden, not deleted', () => {
  const dir = tmp(), f = path.join(dir, 'w.sqlite'), db = new Database(f); db.exec(M.MIGRATION_SQL[0]); db.pragma('user_version = 1');
  db.prepare("INSERT INTO wada_sources (id,url,kind,category,label) VALUES ('prohibited-list','https://www.wada-ama.org/en/prohibited-list','page','prohibited_list','old'),('news','https://www.wada-ama.org/en/media/news','news','news','n')").run();
  db.prepare("INSERT INTO wada_items (url,source_id,kind,title,category,fingerprint,first_seen,last_checked,last_status) VALUES ('https://www.wada-ama.org/en/prohibited-list','prohibited-list','page','Old guessed page','prohibited_list','x','2026-10-01','2026-10-01','unchanged'),('https://www.wada-ama.org/en/news/old-article','news','news','Old article','news','y','2026-10-01','2026-10-01','unchanged')").run();
  db.prepare("INSERT INTO wada_notifications (item_id,kind,fingerprint,title,detected_at) VALUES (2,'new','y','Old article','2026-10-01')").run(); db.prepare("INSERT INTO wada_prefs (key,value) VALUES ('intervalHours','24')").run(); db.close();
  const m = createMonitor({ dbPath: f, fetchImpl: toLocal, sleep: async () => {} });
  assert.equal(m.db.pragma('user_version', { simple: true }), 2); assert.equal(m.db.prepare('SELECT COUNT(*) n FROM wada_items').get().n, 2, 'nothing deleted'); assert.equal(m.db.prepare('SELECT COUNT(*) n FROM wada_notifications').get().n, 1);
  assert.deepEqual(m.listItems().map(i => i.title), ['Old article'], 'item of a retired source is hidden'); assert.equal(m.getPrefs().intervalHours, 24); assert.equal(m.db.prepare("SELECT verification FROM wada_items WHERE id=2").get().verification, 'unverified'); assert.equal(m.db.pragma('foreign_key_check').length, 0); m.close();
});
test('E4 category preferences, interval validation, scheduler due()', async () => {
  reset(); let t = Date.now(); const m = mk(null, { now: () => new Date(t) }); assert.throws(() => m.setPrefs({ intervalHours: 0 }), /between/); assert.throws(() => m.setPrefs({ minChangePct: 101 }), /between/); assert.equal(m.due(), true); await m.check(); assert.equal(m.due(), false); t += 7 * 3600e3; assert.equal(m.due(), true); m.setPrefs({ autoEnabled: false }); assert.equal(m.due(), false); m.close();
});
test('E5 document download validates host, type and content; never executes', async () => {
  reset(); const root = tmp(), m = mk();
  const ok = await m.download(root, 'https://www.wada-ama.org/sites/default/files/2025-09/2026list_en_final_clean_september_2025.pdf', 'list.pdf'); assert.ok(fs.existsSync(ok.path)); assert.equal(ok.sha256.length, 64);
  await assert.rejects(m.download(root, 'https://evil.example/a.pdf'), /Only HTTPS files hosted by www\.wada-ama\.org/); await assert.rejects(m.download(root, 'https://www.wada-ama.org/setup.exe'), /Unsupported file type/); await assert.rejects(m.download(root, 'https://www.wada-ama.org/files/fake.pdf'), /does not match its extension/);
  assert.deepEqual(m.db.prepare('SELECT status FROM wada_downloads ORDER BY id').all().map(r => r.status), ['downloaded', 'failed', 'failed', 'failed']); m.close();
});

test('E6 a run left "running" by a crash is closed as "interrupted" at startup and is never counted as a success', async () => {
  reset(); const dir = tmp(); let m = mk(dir); await m.check(); const ok = m.status().lastSuccess;
  m.db.prepare("INSERT INTO wada_sync_runs (started_at,trigger_type,status) VALUES ('2026-10-21T01:00:00Z','auto','running')").run(); m.close();
  m = mk(dir); const runs = m.history().runs; assert.equal(runs[0].status, 'interrupted'); assert.ok(runs[0].finished_at); assert.match(runs[0].message, /Interrupted/); assert.equal(m.db.prepare("SELECT COUNT(*) n FROM wada_sync_runs WHERE status='running'").get().n, 0); assert.equal(m.status().lastSuccess, ok); m.close();
});
