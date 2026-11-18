'use strict';
/*
 * EDCL AI Hybrid - PRIVACY GATEWAY (main process: the only door to the cloud)
 *
 * Policy, enforced here and not in the page:
 *   1. Nothing from the EDCL database (employees, training, authorizations, competency, instruments, users ...), nothing from
 *      EDCL documents and no laboratory SOP is ever sent to a cloud service. Such content can only go to a LOCAL model
 *      (this PC or the laboratory network) or be shown on screen.
 *   2. Only "cloud-eligible" content may leave: (a) official public WADA documents archived by the WADA synchronisation,
 *      (b) public web pages fetched from approved websites, (c) library documents the System Owner explicitly approved.
 *      Eligibility is decided by the SHA-256 of the document, held in this process - the page cannot simply claim it.
 *   3. The question is screened for names, staff IDs, user names, e-mails, phone numbers, IP addresses and long numbers
 *      (sample / specimen codes). Default: BLOCK (nothing is sent; the user is told what to remove). Optional: REDACT
 *      (placeholders). A conversation that already used confidential EDCL data is "tainted" and cannot use the cloud.
 *   4. Cloud requests are stateless: only the current question and the eligible excerpts are sent, never the chat history.
 *   5. Every decision goes to an append-only local log. The log holds a short fingerprint and counts, never the question text.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isoNow = () => new Date().toISOString();
const MARKS = /[\u0300-\u036f\u064b-\u065f\u0670\u06d6-\u06ed]/g; // accents and Arabic vowel marks are ignored when matching names
const isWordCh = ch => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/* fold() keeps a map from every folded character back to its position in the original text, so redaction hits the right place */
const fold = text => {
  const s = String(text || ''); let f = ''; const map = []; let i = 0;
  for (const ch of s) { const g = ch.normalize('NFKD').replace(MARKS, '').toLowerCase(); for (const c of g) { f += c; map.push(i); } i += ch.length; }
  map.push(i); return { f, map };
};

const PATTERNS = [
  { type: 'email', re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, ph: '[EMAIL]' },
  { type: 'phone', re: /(?<![\p{N}])\+?\d[\d\s().-]{6,}\d(?![\p{N}])/gu, ph: '[PHONE]', minDigits: 7 },
  { type: 'ip-address', re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, ph: '[IP]' },
  { type: 'long-number', re: /(?<![\p{L}\p{N}])\d{6,}(?![\p{L}\p{N}])/gu, ph: '[NUMBER]' }
];
const PH = { name: '[PERSON]', id: '[ID]', username: '[USER]', email: '[EMAIL]', phone: '[PHONE]' };
const TYPE = { name: 'person-name', id: 'staff-id', username: 'user-name', email: 'email', phone: 'phone' };

/* Terms (names, staff IDs, user names ...) come from the EDCL data layer on this PC: [{value, kind}] */
const buildTermMatcher = terms => {
  const by = new Map();
  for (const t of terms || []) {
    const raw = String(t && t.value !== undefined ? t.value : t || '').trim(); if (raw.length < 3) continue;
    const key = fold(raw).f.replace(/\s+/g, ' '); if (!by.has(key)) by.set(key, (t && t.kind) || 'name');
  }
  const list = [...by.keys()].sort((a, b) => b.length - a.length).slice(0, 6000);
  return { size: list.length, find: folded => { const hits = []; for (const t of list) { let from = 0; for (;;) { const i = folded.indexOf(t, from); if (i < 0) break; if (!isWordCh(folded[i - 1]) && !isWordCh(folded[i + t.length])) hits.push({ start: i, end: i + t.length, kind: by.get(t) }); from = i + t.length; } } return hits; } };
};

/* screenText(text, matcher) -> { found, counts, hits:[{type,start,end}], redacted } */
const screenText = (text, matcher) => {
  const s = String(text || ''), ranges = [];
  for (const p of PATTERNS) { const re = new RegExp(p.re.source, p.re.flags); let m; while ((m = re.exec(s))) { if (p.minDigits && m[0].replace(/\D/g, '').length < p.minDigits) continue; ranges.push({ start: m.index, end: m.index + m[0].length, type: p.type, ph: p.ph }); } }
  if (matcher && matcher.size) { const { f, map } = fold(s); for (const h of matcher.find(f)) ranges.push({ start: map[h.start], end: map[h.end], type: TYPE[h.kind] || h.kind, ph: PH[h.kind] || '[REDACTED]' }); }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = []; for (const r of ranges) { const last = merged[merged.length - 1]; if (last && r.start < last.end) { if (r.end > last.end) last.end = r.end; } else merged.push({ ...r }); }
  let redacted = s; for (let i = merged.length - 1; i >= 0; i--) redacted = redacted.slice(0, merged[i].start) + merged[i].ph + redacted.slice(merged[i].end);
  const counts = {}; for (const r of merged) counts[r.type] = (counts[r.type] || 0) + 1;
  return { found: merged.length, counts, hits: merged.map(r => ({ type: r.type, start: r.start, end: r.end })), redacted };
};

const create = (opts = {}) => {
  const dir = opts.dir; if (!dir) throw new Error('privacy-gateway: dir is required');
  const STATE = path.join(dir, 'aih-gateway.json'), LOG = path.join(dir, 'aih-gateway.log'), nowFn = opts.now || isoNow;
  const load = () => { let j = {}; try { j = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { /* defaults */ } return { mode: j.mode === 'redact' ? 'redact' : 'block', approved: j.approved || {}, publicShas: j.publicShas || {} }; };
  const store = s => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); };
  const log = e => { try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ t: nowFn(), ...e }) + '\n'); } catch (x) { /* logging never breaks a request */ } };
  const who = w => String(w || '').slice(0, 60);

  const getPolicy = () => { const s = load(); return { mode: s.mode, approved: Object.entries(s.approved).map(([sha256, v]) => ({ sha256, ...v })), publicPages: Object.keys(s.publicShas).length }; };
  const setMode = (mode, by) => { if (!['block', 'redact'].includes(mode)) throw new Error('Mode must be "block" or "redact"'); const s = load(); s.mode = mode; store(s); log({ ev: 'policy', mode, by: who(by) }); return getPolicy(); };
  const approveDoc = (sha256, label, by) => {
    if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error('Invalid document fingerprint'); if (!String(by || '').trim()) throw new Error('The approving System Owner must be recorded');
    const s = load(); s.approved[sha256] = { label: String(label || '').slice(0, 120), by: who(by), at: nowFn() }; store(s); log({ ev: 'approve-doc', sha: sha256.slice(0, 12), by: who(by) }); return getPolicy();
  };
  const revokeDoc = (sha256, by) => { const s = load(); delete s.approved[sha256]; store(s); log({ ev: 'revoke-doc', sha: String(sha256).slice(0, 12), by: who(by) }); return getPolicy(); };
  const registerPublic = (sha256, url) => { if (!/^[0-9a-f]{64}$/.test(String(sha256))) return; const s = load(); s.publicShas[sha256] = { url: String(url || '').slice(0, 200), at: nowFn() }; const k = Object.keys(s.publicShas); if (k.length > 3000) for (const x of k.slice(0, k.length - 3000)) delete s.publicShas[x]; store(s); };
  const eligible = (sha256, extra) => { if (!sha256) return false; const s = load(); return !!(s.approved[sha256] || s.publicShas[sha256] || (extra && extra.has(sha256))); };

  /* The decision for one cloud request. Returns { allowed, reasons, payload? } - payload is the ONLY thing that may be sent. */
  const prepareCloud = ({ question, excerpts, terms, tainted, scope }, ctx = {}) => {
    const reasons = [], q = String(question || '').trim(), policy = load();
    const done = (allowed, extra = {}) => { const d = { allowed, reasons, mode: policy.mode, scope: scope || 'official', ...extra }; log({ ev: 'cloud-request', allowed, q: sha(q).slice(0, 10), qlen: q.length, excerptsIn: (excerpts || []).length, excerptsSent: d.payload ? d.payload.excerpts.length : 0, withheld: d.withheld || 0, found: d.counts || {}, redacted: d.redactions || 0, reasons: reasons.map(r => r.code), scope: d.scope }); return d; };
    if (!q) { reasons.push({ code: 'empty', text: 'There is no question to send.' }); return done(false); }
    if (tainted) { reasons.push({ code: 'tainted', text: 'This conversation already used confidential EDCL data, so the cloud cannot be used in it. Start a new chat for a public WADA or scientific question.' }); return done(false); }
    const matcher = buildTermMatcher(terms), sc = screenText(q, matcher); let text = q, redactions = 0;
    if (sc.found) {
      if (policy.mode === 'block') { reasons.push({ code: 'sensitive-question', text: 'The question contains confidential items (' + Object.entries(sc.counts).map(([k, v]) => v + ' ' + k).join(', ') + '). Nothing was sent. Remove them, or ask the System Owner to switch the gateway to "redact" mode, and ask again.' }); return done(false, { counts: sc.counts }); }
      text = sc.redacted; redactions = sc.found; reasons.push({ code: 'redacted', text: sc.found + ' confidential item(s) were replaced by placeholders before sending.' });
    }
    const out = []; let withheld = 0;
    for (const x of excerpts || []) {
      if (!eligible(x.docSha, ctx.publicShas)) { withheld++; continue; }
      const s2 = screenText(x.text, matcher);
      if (s2.found && policy.mode === 'block') { withheld++; continue; }
      if (s2.found) redactions += s2.found;
      out.push({ docId: x.docId, name: x.name, version: x.version, role: x.role, page: x.page, text: (s2.found ? s2.redacted : String(x.text || '')).slice(0, 2500) });
    }
    if (withheld) reasons.push({ code: 'excerpts-withheld', text: withheld + ' library passage(s) were not sent: only official WADA documents, public web pages and documents approved by the System Owner may leave the laboratory.' });
    return done(true, { payload: { question: text, excerpts: out }, withheld, counts: sc.counts, redactions });
  };

  const readLog = (n = 200) => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-Math.min(Math.max(+n || 1, 1), 2000)).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse(); } catch (e) { return []; } };
  return { getPolicy, setMode, approveDoc, revokeDoc, registerPublic, eligible, prepareCloud, readLog, log, screen: (t, terms) => screenText(t, buildTermMatcher(terms)) };
};

module.exports = { create, screenText, buildTermMatcher, fold, PATTERNS };
