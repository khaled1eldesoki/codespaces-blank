'use strict';
// Server-side WADA check (public pages only, no login, nothing bypassed). Writes two kinds of records that phones read through
// the normal read-only sync:
//   WadaUpdates  - news, the CURRENT Technical Documents Index, Technical Letters Index, Prohibited List, and the NEXT year's
//                  Prohibited List page (WADA publishes it on its own page /en/resources/<year>-prohibited-list in September, months
//                  before it comes into force - the normal Prohibited List page still shows the old list until 1 January).
//                  The long ARCHIVE of old versions is deliberately NOT stored: it is history, not an update.
//                  Items found on the very first check are marked Baseline:true (already existed, shown but never "NEW").
//   WadaStatus   - one record "main": when the last check ran, whether it worked, and which source failed and why.
const crypto = require('crypto');
const wada = require('../wada-monitor');
const store = require('./store');
const UA = 'EDCL-Lab-System/1.0 (+public WADA page monitor; contact: laboratory quality unit)';
const S = Object.fromEntries(wada.DEFAULT_SOURCES.map(s => [s.id, s]));
const RELEVANT = /laborator|technical (document|letter)|prohibited list|monitoring program|international standard|\bISL\b|accredit|world anti-doping code|\bTD20|\bTL\d|athlete biological passport|\bABP\b|analytical|\bTUE\b|therapeutic use/i;
const id16 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function get(url, fetchImpl, optional) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
  if (res.url && new URL(res.url).hostname !== wada.HOST) throw new Error('Redirected outside wada-ama.org - not followed');
  if (optional && res.status === 404) return null;   // page does not exist yet = nothing published, not an error
  if (res.status === 403 || res.status === 429 || res.status === 503) throw new Error('challenge/blocked by WADA (HTTP ' + res.status + ') - will retry next time');
  if (!res.ok) throw new Error('WADA returned HTTP ' + res.status);
  const html = await res.text();
  if (html.length < 3000 && /just a moment|captcha|challenge|enable javascript/i.test(html)) throw new Error('challenge page returned instead of content - will retry next time');
  return html;
}
function upsert(db, tbl, id, data, baseline) {   // returns 'new' | 'changed' | 'same'
  const cur = store.getRecord(db, tbl, id);
  if (!cur || cur.deleted) { store.applyOp(db, 'wada-monitor', { tbl, id, op: 'put', baseRev: 0, data: { ...data, Baseline: !!baseline } }); return 'new'; }
  const same = ['Title', 'Url', 'Published', 'Version'].every(k => (cur.data[k] || '') === (data[k] || ''));
  if (same) return 'same';
  store.applyOp(db, 'wada-monitor', { tbl, id, op: 'put', baseRev: cur.rev, data: { ...data, Baseline: false, FoundAt: cur.data.FoundAt, ChangedAt: data.FoundAt } }); return 'changed';
}
async function check({ db, broadcast = () => {}, log = () => {}, fetchImpl = fetch, firstLimit = 30 }) {
  const baseline = db.prepare("SELECT COUNT(*) c FROM records WHERE tbl='WadaUpdates' AND deleted=0").get().c === 0;
  const now = new Date().toISOString(), sources = []; let added = 0, changed = 0;
  const Y = new Date().getFullYear(), txt = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const resource = (url, category, type, label, extra = '') => async html => {
    const { page, docs } = wada.parseResourcePage(html, url, category, label), dl = docs.find(d => d.primary), yr = (txt(html).match(/The\s+(20\d\d)\s+List of Prohibited Substances/i) || [])[1];
    return [{ key: 'page:' + page.url, Title: label + (yr && type === 'Prohibited List' ? ' - ' + yr + ' List' : '') + extra, Url: dl ? dl.url : page.url, Published: page.published || '', Category: category, ItemType: type, Version: dl ? dl.url : '' }];
  };
  const jobs = [
    { id: 'news', url: S.news.url, parse: async html => wada.parseNewsList(html, S.news.url, 'news').slice(0, baseline ? firstLimit : 120).map(it => ({ key: it.url, Title: it.title, Url: it.url, Published: it.published || '', Category: it.category, ItemType: 'News' })) },
    { id: 'td-index', url: S['td-index'].url, parse: resource(S['td-index'].url, 'standards', 'Technical Documents', 'Technical Documents Index', ' (current version)') },
    { id: 'tl-index', url: 'https://www.wada-ama.org/en/resources/technical-letters-index', parse: resource('https://www.wada-ama.org/en/resources/technical-letters-index', 'standards', 'Technical Letters', 'Technical Letters Index', ' (current version)') },
    { id: 'prohibited-list', url: S['prohibited-list-resource'].url, parse: resource(S['prohibited-list-resource'].url, 'prohibited_list', 'Prohibited List', 'Prohibited List', ' (in force)') },
    { id: 'prohibited-list-next', optional: true, url: `https://www.wada-ama.org/en/resources/${Y + 1}-prohibited-list`, parse: resource(`https://www.wada-ama.org/en/resources/${Y + 1}-prohibited-list`, 'prohibited_list', 'Prohibited List (upcoming)', `${Y + 1} Prohibited List`, ' (published, not yet in force)') }
  ];
  for (const { id: sid, url, parse, optional } of jobs) {
    try {
      const html = await get(url, fetchImpl, optional);
      if (html === null) { sources.push({ id: sid, ok: true, items: 0, note: 'not published yet' }); continue; }
      const items = await parse(html);
      if (!items.length) throw new Error('page loaded but nothing recognised (WADA layout may have changed)');
      db.tx(() => { for (const it of items) { const { key, ...d } = it; const r = upsert(db, 'WadaUpdates', id16(key), { ...d, Priority: d.ItemType !== 'News' || RELEVANT.test(d.Title), FoundAt: now }, baseline); if (r === 'new') added++; else if (r === 'changed') changed++; } });
      sources.push({ id: sid, ok: true, items: items.length });
    } catch (e) { sources.push({ id: sid, ok: false, error: String(e.message || e).slice(0, 200) }); log('wada-source-failed', sid + ': ' + e.message); }
  }
  const ok = sources.filter(s => s.ok).length, st = { LastCheck: now, LastOk: ok ? now : ((store.getRecord(db, 'WadaStatus', 'main') || { data: {} }).data.LastOk || ''), Result: ok === sources.length ? 'ok' : ok ? 'partial' : 'failed', Added: added, Changed: changed, Baseline: baseline, Sources: sources };
  const cur = store.getRecord(db, 'WadaStatus', 'main');
  store.applyOp(db, 'wada-monitor', { tbl: 'WadaStatus', id: 'main', op: 'put', baseRev: cur && !cur.deleted ? cur.rev : 0, data: st });
  broadcast(); if ((added || changed) && !baseline) log('wada-new', added + changed);
  return { added, changed, baseline, sources };
}
module.exports = { check };
