'use strict';
/* EDCL WADA Monitor Fix - OUTDATED EDCL COPIES
 * Compares the laboratory's own copies of WADA documents (files in the EDCL Document Library) and the references to WADA
 * documents inside EDCL records (e.g. a training topic "TD2025NA") with the newest official versions known to the watch.
 *   current   the file is byte-identical to the current WADA file (SHA-256), or the same edition
 *   outdated  identical to an OLDER WADA version, or an older edition (year / version) than the current one
 *   review    could not be decided safely (newer than WADA's, or the same edition with different content, or uploaded before WADA's latest publication)
 *   unknown   not recognisable as a WADA document
 * An outdated copy raises ONE persistent notification per new WADA version (shown in the bell and the WADA Updates list).
 * The EDCL files themselves are never opened for writing: only their name, SHA-256 and a short text sample are received. */
const crypto = require('crypto');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isoNow = () => new Date().toISOString();

const CODE_RE = /(?<![A-Za-z])(TD)[\s_-]?((?:19|20)\d{2})[\s_-]?([A-Z][A-Z0-9]{1,9}(?:\/[A-Z0-9]+)?)(?![a-z])|(?<![A-Za-z])(TL)[\s_-]?(\d{1,3})(?!\d)|(?<![A-Za-z])(ISL|ISTI|ISPPPI|ISTUE|ISCCS|ISRM|ISE|ISDP)[\s_-]*((?:19|20)\d{2})?(?![A-Za-z])/g;
/* find WADA document identities in free text: [{key,label,year,type,text}] */
const identities = (text, familyOf) => {
  const out = [], seen = new Set(); const s = String(text || ''); let m; CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(s)) && out.length < 40) {
    let key, year = null, label = m[0].trim();
    if (m[1]) { key = 'TD-' + m[3].replace(/\//g, '').toUpperCase(); year = +m[2]; }
    else if (m[4]) { key = 'TL-' + (+m[5]); }
    else { key = 'STD-' + m[6]; year = m[7] ? +m[7] : null; }
    const id = key + '|' + year; if (seen.has(id)) continue; seen.add(id); out.push({ key, label, year, text: m[0] });
  }
  return out;
};
const verNum = s => { const m = String(s || '').match(/(?:(?<![A-Za-z])v|version\s*)(\d+(?:\.\d+)?)/i); return m ? parseFloat(m[1]) : 0; };
const dayOf = s => { const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : ''; };

/* decide the status of ONE copy against the watch groups. ctx = { groups, bySha: Map(sha -> {group, version}), familyOf } */
const evaluateCopy = (copy, ctx) => {
  const res = { ref: copy.ref, name: copy.name, status: 'unknown', reason: 'Not recognised as a WADA document', family: null, latest: null };
  const hit = copy.sha256 && ctx.bySha.get(copy.sha256);
  const show = g => ({ label: g.current.label ? g.label + ' v' + g.current.label : g.label, title: g.current.title, published: g.current.published || '', year: g.current.year, itemId: g.current.itemId, versionId: g.current.versionId, url: g.current.pageUrl || g.current.sourceUrl });
  if (hit) {
    const g = hit.group, cur = g.current; res.family = g.key; res.latest = show(g);
    if (hit.version.role === 'current' || hit.version.sha256 === cur.sha256) { res.status = 'current'; res.reason = 'Identical to the current WADA file' + (cur.published ? ' (published ' + cur.published + ')' : '') + '.'; }
    else { res.status = 'outdated'; res.reason = 'Identical to an OLDER WADA version' + (hit.version.published ? ' (published ' + hit.version.published + ')' : '') + '. The current version is ' + res.latest.label + (cur.published ? ', published ' + cur.published : '') + '.'; }
    return res;
  }
  const idText = [copy.name, copy.code].filter(Boolean).join(' ');
  let ids = identities(idText, ctx.familyOf); if (!ids.length) ids = identities(String(copy.textSample || '').slice(0, 1500), ctx.familyOf);
  let fam = null, year = null; const first = ids[0];
  if (first) { fam = ctx.groups.find(g => g.key === first.key); year = first.year; }
  if (!fam) { const f = ctx.familyOf(idText, ''); if (f && f.type !== 'Other') { fam = ctx.groups.find(g => g.key === f.key); year = f.year || year; } }
  if (!fam && /prohibited[\s_-]*list/i.test(idText)) { const f = ctx.familyOf(idText, ''); fam = ctx.groups.find(g => g.key === 'PL'); year = f.year || year; }
  if (!fam) return res;
  const cur = fam.current; res.family = fam.key; res.latest = show(fam); const curYear = cur.year || null, copyVer = verNum(idText), curVer = parseFloat(cur.label) || 0;
  if (year && curYear && year < curYear) { res.status = 'outdated'; res.reason = 'This copy is the ' + year + ' edition; the current WADA edition is ' + curYear + (cur.published ? ' (published ' + cur.published + ')' : '') + '.'; return res; }
  if (year && curYear && year > curYear) { res.status = 'review'; res.reason = 'This copy is the ' + year + ' edition, newer than the ' + curYear + ' edition the application knows. Run the WADA check.'; return res; }
  if (copyVer && curVer && copyVer < curVer) { res.status = 'outdated'; res.reason = 'This copy is version ' + copyVer + '; the current WADA version is ' + curVer + (cur.published ? ' (published ' + cur.published + ')' : '') + '.'; return res; }
  if (copyVer && curVer && copyVer > curVer) { res.status = 'review'; res.reason = 'This copy is version ' + copyVer + ', newer than the WADA version known (' + curVer + ').'; return res; }
  const up = dayOf(copy.date), pub = dayOf(cur.published);
  if (up && pub && up < pub && !(copyVer && curVer)) { res.status = 'review'; res.reason = 'Same document, but the copy was added (' + up + ') before WADA published the current version (' + pub + ') and its file differs. Compare it with the official file.'; return res; }
  res.status = 'review'; res.reason = 'Same document and edition as the current WADA version, but the file content is different (re-saved, annotated or translated?). Compare it with the official file.'; return res;
};
// references inside records: "training on TD2025NA" - only year / edition can be compared
const evaluateRef = (ref, ctx) => {
  const ids = identities(ref.text, ctx.familyOf); const out = [];
  for (const id of ids) { const fam = ctx.groups.find(g => g.key === id.key); if (!fam || !id.year || !fam.current.year) continue; const cur = fam.current;
    if (id.year < cur.year) out.push({ ref: ref.ref, label: id.text, family: fam.key, status: 'outdated', reason: 'Refers to the ' + id.year + ' edition; the current WADA edition is ' + cur.year + (cur.published ? ' (published ' + cur.published + ')' : '') + '.', latest: { label: fam.label + (cur.year ? ' ' + cur.year : ''), published: cur.published || '', itemId: cur.itemId, versionId: cur.versionId, title: cur.title } }); }
  return out;
};

const create = (opts = {}) => {
  const db = opts.db, watch = opts.watch, onNotify = opts.onNotify || (() => {}), onChange = opts.onChange || (() => {});
  if (!db || !watch) throw new Error('wada-copies: db and watch are required');
  db.exec(`CREATE TABLE IF NOT EXISTS wada_copy_checks (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, status TEXT NOT NULL, family TEXT, reason TEXT, latest_item_id INTEGER, latest_version_id INTEGER, latest_label TEXT, latest_published TEXT, latest_url TEXT, copy_sha TEXT, checked_at TEXT NOT NULL, first_outdated_at TEXT, ack_at TEXT, ack_by TEXT, ack_note TEXT);
    CREATE TABLE IF NOT EXISTS wada_copy_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, status TEXT NOT NULL, latest_version_id INTEGER, at TEXT NOT NULL);`);
  const buildCtx = () => { const L = watch.list(), bySha = new Map(); for (const g of L.groups) for (const v of g.versions) if (v.sha256 && !bySha.has(v.sha256)) bySha.set(v.sha256, { group: g, version: v }); return { groups: L.groups, bySha, familyOf: watch.familyOf }; };
  const itemFor = id => db.prepare('SELECT id,category FROM wada_items WHERE id=?').get(id);
  const noteOnce = (itemId, fp, title, sig, fresh) => { if (!itemId) return; const it = itemFor(itemId); if (!it) return; const n = db.prepare('INSERT OR IGNORE INTO wada_notifications (item_id,kind,fingerprint,title,source,category,detected_at,significance) VALUES (?,?,?,?,?,?,?,?)').run(itemId, 'changed', fp, title.slice(0, 300), 'EDCL copies check', it.category, isoNow(), sig); if (n.changes) fresh.push({ id: Number(n.lastInsertRowid), title, category: it.category, kind: 'changed' }); };
  /* report({copies:[{ref,name,code,date,sha256,size,textSample}], refs:[{ref,text,label}]}) */
  const report = ({ copies, refs } = {}) => {
    const ctx = buildCtx(), results = [], fresh = [], when = isoNow(); if (!ctx.groups.length) return { results: [], summary: { current: 0, outdated: 0, review: 0, unknown: 0, outdatedRefs: 0 }, notSynced: true, newNotifications: 0 };
    const up = db.prepare('INSERT INTO wada_copy_checks (ref,kind,name,status,family,reason,latest_item_id,latest_version_id,latest_label,latest_published,latest_url,copy_sha,checked_at,first_outdated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET kind=excluded.kind,name=excluded.name,status=excluded.status,family=excluded.family,reason=excluded.reason,latest_item_id=excluded.latest_item_id,latest_version_id=excluded.latest_version_id,latest_label=excluded.latest_label,latest_published=excluded.latest_published,latest_url=excluded.latest_url,copy_sha=excluded.copy_sha,checked_at=excluded.checked_at,first_outdated_at=CASE WHEN excluded.status=\'outdated\' THEN COALESCE(wada_copy_checks.first_outdated_at, excluded.first_outdated_at) ELSE NULL END,ack_at=CASE WHEN wada_copy_checks.latest_version_id IS excluded.latest_version_id AND wada_copy_checks.status=excluded.status THEN wada_copy_checks.ack_at ELSE NULL END,ack_by=CASE WHEN wada_copy_checks.latest_version_id IS excluded.latest_version_id AND wada_copy_checks.status=excluded.status THEN wada_copy_checks.ack_by ELSE NULL END,ack_note=CASE WHEN wada_copy_checks.latest_version_id IS excluded.latest_version_id AND wada_copy_checks.status=excluded.status THEN wada_copy_checks.ack_note ELSE NULL END');
    const prev = new Map(db.prepare('SELECT ref,status,latest_version_id FROM wada_copy_checks').all().map(r => [r.ref, r])), ev = db.prepare('INSERT INTO wada_copy_events (ref,status,latest_version_id,at) VALUES (?,?,?,?)');
    const save = (r, kind) => { const p = prev.get(r.ref); up.run(r.ref, kind, r.name || r.label || '', r.status, r.family, r.reason, r.latest ? r.latest.itemId : null, r.latest ? r.latest.versionId : null, r.latest ? r.latest.label : null, r.latest ? r.latest.published : null, r.latest ? r.latest.url || null : null, r.copySha || null, when, r.status === 'outdated' ? when : null); if (!p || p.status !== r.status || p.latest_version_id !== (r.latest ? r.latest.versionId : null)) ev.run(r.ref, r.status, r.latest ? r.latest.versionId : null, when); };
    db.transaction(() => {
      for (const c of copies || []) { const r = { ...evaluateCopy(c, ctx), copySha: c.sha256 }; results.push({ ...r, kind: 'copy' }); save(r, 'copy'); if (r.status === 'outdated') noteOnce(r.latest && r.latest.itemId, sha(r.ref + '|' + (r.latest && r.latest.versionId)), 'EDCL copy is OUTDATED: ' + (c.name || r.ref) + ' - current is ' + (r.latest && r.latest.label) + (r.latest && r.latest.published ? ' (published ' + r.latest.published + ')' : ''), 'outdated_copy', fresh); }
      const groupedRefs = new Map(); for (const rf of refs || []) for (const x of evaluateRef(rf, ctx)) { const k = x.family + '|' + x.label.toUpperCase() + '|' + (x.latest.versionId || ''); const g = groupedRefs.get(k) || { ...x, count: 0, refs: [] }; g.count++; if (g.refs.length < 20) g.refs.push(rf.label || rf.ref); groupedRefs.set(k, g); }
      for (const g of groupedRefs.values()) { const r = { ref: 'ref:' + g.family + ':' + g.label.toUpperCase().replace(/\s+/g, ''), name: g.label + ' (' + g.count + ' place' + (g.count === 1 ? '' : 's') + ')', status: 'outdated', reason: g.reason, family: g.family, latest: g.latest, label: g.label }; results.push({ ...r, kind: 'reference', count: g.count, where: g.refs }); save(r, 'ref'); noteOnce(g.latest.itemId, sha(r.ref + '|' + g.latest.versionId), 'EDCL records still refer to ' + g.label + ' (' + g.count + ' place' + (g.count === 1 ? '' : 's') + ') - current is ' + g.latest.label + (g.latest.published ? ' (published ' + g.latest.published + ')' : ''), 'outdated_reference', fresh); }
    })();
    const summary = { current: 0, outdated: 0, review: 0, unknown: 0, outdatedRefs: 0 }; for (const r of results) { if (r.kind === 'reference') summary.outdatedRefs++; else summary[r.status]++; }
    if (fresh.length) { try { onNotify(fresh); } catch (e) { /* optional */ } for (const n of fresh) db.prepare('UPDATE wada_notifications SET desktop_notified=1 WHERE id=?').run(n.id); }
    onChange(); return { results, summary, newNotifications: fresh.length, at: when };
  };
  const stored = () => db.prepare("SELECT * FROM wada_copy_checks WHERE status IN ('outdated','review') OR kind='copy' ORDER BY (status='outdated') DESC, name").all();
  const acknowledge = (ref, user, note) => { if (!String(user || '').trim()) throw new Error('The person acknowledging must be recorded'); const r = db.prepare('UPDATE wada_copy_checks SET ack_at=?, ack_by=?, ack_note=? WHERE ref=?').run(isoNow(), String(user).slice(0, 80), String(note || '').slice(0, 300), String(ref)); if (!r.changes) throw new Error('Unknown copy'); return true; };
  return { report, stored, acknowledge, evaluateCopy: c => evaluateCopy(c, buildCtx()) };
};
module.exports = { create, evaluateCopy, evaluateRef, identities };
