/* EDCL AI Hybrid - core (pure functions; no UI, no storage). Loaded in the page and unit-tested in Node.
   Contains: text search, the READ-ONLY EDCL data layer (catalog / query / count / sensitive terms), the local tool loop,
   question routing, and the grounding check. Nothing in here can write to the EDCL data: every function only READS the object
   it is given and returns freshly built copies. */
(function (root, factory) { const c = factory(); if (typeof module !== 'undefined' && module.exports) module.exports = c; else root.EDCL_AIH_CORE = c; })(typeof window !== 'undefined' ? window : globalThis, function () {
'use strict';
const VER = '2.0.0';

/* ================= text search (BM25) ================= */
const STOP = new Set('the of and to in a is for on with by as at an be or are from that this it was were has have had not but if its into than then which what when who how can may shall should must'.split(' '));
const tok = s => { const raw = String(s || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}\p{M}]+(?:[.\-_/][\p{L}\p{N}\p{M}]+)*/gu) || [], out = [];
  for (const t of raw) { if (!STOP.has(t)) out.push(t); if (/[.\-_/]/.test(t)) for (const p of t.split(/[.\-_/]/)) if (p.length > 1 && !STOP.has(p)) out.push(p); } return out; };
const chunkText = (text, page, max = 900) => { const s = String(text || '').replace(/\s+/g, ' ').trim(); if (!s) return [];
  const sents = s.split(/(?<=[.;:!?])\s+(?=[A-Z0-9(\[“"])/); const out = []; let cur = '';
  for (const x of sents) { if (cur && (cur.length + x.length + 1) > max) { out.push({ page, text: cur }); const tl = cur.slice(-160); cur = cur.length > 300 ? tl.slice(tl.indexOf(' ') + 1) : ''; } cur = (cur + ' ' + x).trim();
    while (cur.length > max * 1.6) { out.push({ page, text: cur.slice(0, max) }); cur = cur.slice(max - 120); } }
  if (cur.trim()) out.push({ page, text: cur.trim() }); return out; };
const TYPES = ['ISL', 'TD', 'TL', 'Guideline', 'Technical Note', 'Prohibited List', 'Code', 'SOP', 'Web', 'Other'];
const detectType = (name, first) => { const t = String(name || ''), f = String(first || '').slice(0, 1500);
  const rules = [['TD', /(?<![A-Za-z])TD[\s_-]?\d{4}/i], ['TL', /(?<![A-Za-z])TL[\s_-]?\d+/i], ['ISL', /(?<![A-Za-z])ISL(?![A-Za-z])|international[\s_-]standard[\s_-]for[\s_-]laboratories/i], ['Guideline', /guideline/i], ['Technical Note', /technical[\s_-]note|(?<![A-Za-z])TN[\s_-]?[A-Z]{2,}/i], ['Prohibited List', /prohibited[\s_-]list|\d{4}list_en/i], ['Code', /world[\s_-]anti-?doping[\s_-]code/i], ['SOP', /(?<![A-Za-z])SOP[\s_-]?\d+/i]];
  for (const [k, r] of rules) if (r.test(t)) return k; for (const [k, r] of rules) if (r.test(f)) return k; return 'Other'; };
const wantsPrevious = q => /\b(previous|prior|former|older|old version|earlier|superseded|replaced|changed?|changes|difference|differences|differ|compare|comparison|what'?s new|new version|amend\w*|revis\w*|update[ds]?)\b|السابق|السابقة|القديم|القديمة|الفرق|الفروق|مقارنة|تغيير|تغييرات|تعديل|تحديث/i.test(String(q || ''));
const isOld = d => !!d && (d.role === 'previous' || d.role === 'older');
// public = official WADA archive, fetched public web pages, or approved by the System Owner. EVERYTHING else is confidential.
const isPublicDoc = (d, approvedShas) => !!d && (d.source === 'wada' || d.source === 'web' || (d.hash && approvedShas && approvedShas.has(d.hash)));
class Index { constructor(chunks, docs) { this.docs = new Map((docs || []).map(d => [d.id, d])); this.ch = chunks || []; this.k1 = 1.4; this.b = .75; this.build(); }
  build() { this.tf = []; this.len = []; this.df = new Map(); let tot = 0;
    for (const c of this.ch) { const d = this.docs.get(c.docId), ts = tok(c.text).concat(tok(d ? d.name + ' ' + (d.version || '') : '')), m = new Map(); for (const t of ts) m.set(t, (m.get(t) || 0) + 1);
      this.tf.push(m); this.len.push(ts.length); tot += ts.length; for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1); }
    this.avg = this.ch.length ? tot / this.ch.length : 1; }
  search(q, o = {}) { const qt = [...new Set(tok(q))]; if (!qt.length || !this.ch.length) return []; const N = this.ch.length, limit = o.limit || 6, types = o.types && o.types.length ? new Set(o.types) : null, ql = String(q).toLowerCase().trim(), res = [];
    for (let i = 0; i < N; i++) { const c = this.ch[i], d = this.docs.get(c.docId); if (types && (!d || !types.has(d.type))) continue; if (!o.includePrev && isOld(d)) continue; if (o.onlyPublic && !isPublicDoc(d, o.approved)) continue; const m = this.tf[i]; let s = 0, hit = 0;
      for (const t of qt) { const f = m.get(t); if (!f) continue; hit++; const idf = Math.log(1 + (N - this.df.get(t) + .5) / (this.df.get(t) + .5)); s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / this.avg)); }
      if (!s) continue; s *= .6 + .4 * (hit / qt.length); if (ql.length > 5 && c.text.toLowerCase().includes(ql)) s *= 1.5; res.push({ chunk: c, doc: d, score: s }); }
    res.sort((a, b) => b.score - a.score); return res.slice(0, limit); } }
const splitPages = (text, size = 3500) => { const s = String(text || '').replace(/\r/g, '').trim(), out = []; let cur = ''; for (const p of s.split(/\n{2,}|\n/)) { if (cur && cur.length + p.length > size) { out.push(cur); cur = ''; } cur += (cur ? '\n' : '') + p; } if (cur) out.push(cur); return out; };

/* ================= READ-ONLY EDCL data layer ================= */
// Columns that must never be readable by the assistant, whatever the permissions (credentials and secrets).
// substring match on purpose: camelCase names such as totpSecret, recoveryCodes, passwordHash must be caught too
const BLOCKED_COL = /hash|salt|secret|totp|recover|passw|pwd|token|apikey|api_key|(^|[^a-z])pin([^a-z]|$)|^must$/i;
const OWNER_ONLY = new Set(['Users', 'Settings']);
const PERM_TABLE = { Audit: 'audit', Access: 'audit', RecordHistory: 'audit' };
const isTable = (D, k) => D && Array.isArray(D[k]) && /^[A-Za-z][A-Za-z0-9_]*$/.test(k);
// ctx = { isOwner:boolean, pm:(key)=>boolean, allow: null | string[]  (System Owner's table allow-list) }
const tableAccess = (name, ctx) => {
  if (ctx.allow && !ctx.allow.includes(name)) return { ok: false, why: 'not enabled for the AI by the System Owner' };
  if (OWNER_ONLY.has(name) && !ctx.isOwner) return { ok: false, why: 'System Owner only' };
  const p = PERM_TABLE[name]; if (p && !(ctx.pm && ctx.pm(p)) && !ctx.isOwner) return { ok: false, why: 'requires the "' + p + '" permission' };
  return { ok: true };
};
const colsOf = (rows, max = 400) => { const set = new Set(); for (let i = 0; i < Math.min(rows.length, max); i++) { const r = rows[i]; if (r && typeof r === 'object') for (const k of Object.keys(r)) set.add(k); } return [...set].filter(c => !BLOCKED_COL.test(c)); };
const catalog = (D, ctx) => { const out = []; for (const k of Object.keys(D || {})) { if (!isTable(D, k)) continue; const a = tableAccess(k, ctx); out.push({ table: k, rows: D[k].length, columns: a.ok ? colsOf(D[k]) : [], allowed: a.ok, why: a.ok ? '' : a.why }); } return out; };
const cell = v => { if (v === null || v === undefined) return null; if (typeof v === 'number' || typeof v === 'boolean') return v; if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + '…' : v; try { const j = JSON.stringify(v); return j.length > 400 ? j.slice(0, 400) + '…' : j; } catch (e) { return String(v).slice(0, 400); } };
const OPS = ['=', '!=', '>', '>=', '<', '<=', 'contains', 'startswith', 'in', 'isnull', 'notnull'];
const matchRow = (row, conds) => { for (const c of conds) { const v = row[c.col], s = v === null || v === undefined ? '' : String(v).toLowerCase(), t = String(c.value === undefined ? '' : c.value).toLowerCase(); let ok;
  switch (c.op) { case '=': ok = s === t; break; case '!=': ok = s !== t; break; case 'contains': ok = s.includes(t); break; case 'startswith': ok = s.startsWith(t); break;
    case 'in': ok = (Array.isArray(c.value) ? c.value : String(c.value).split(',')).map(x => String(x).trim().toLowerCase()).includes(s); break; case 'isnull': ok = s === ''; break; case 'notnull': ok = s !== ''; break;
    default: { const a = parseFloat(s), b = parseFloat(t), num = !isNaN(a) && !isNaN(b) && /^-?[\d.]+$/.test(s) && /^-?[\d.]+$/.test(t); const x = num ? a : s, y = num ? b : t; ok = c.op === '>' ? x > y : c.op === '>=' ? x >= y : c.op === '<' ? x < y : x <= y; } }
  if (!ok) return false; } return true; };
const prep = (D, q, ctx) => {
  if (!q || typeof q.table !== 'string') throw new Error('A table name is required'); if (!isTable(D, q.table)) throw new Error('Unknown table "' + q.table + '". Available: ' + Object.keys(D || {}).filter(k => isTable(D, k)).join(', '));
  const a = tableAccess(q.table, ctx); if (!a.ok) throw new Error('Access to "' + q.table + '" is not allowed (' + a.why + ')');
  const valid = colsOf(D[q.table]), cols = (q.columns && q.columns.length ? q.columns : valid).map(String);
  for (const c of cols) if (!valid.includes(c)) throw new Error(BLOCKED_COL.test(c) ? 'Column "' + c + '" is protected and cannot be read' : 'Unknown column "' + c + '" in ' + q.table + '. Columns: ' + valid.join(', '));
  const conds = (q.where || []).slice(0, 6).map(w => { const op = String(w.op || '=').toLowerCase(); if (!OPS.includes(op)) throw new Error('Unsupported operator "' + w.op + '". Use: ' + OPS.join(' ')); if (!valid.includes(String(w.col))) throw new Error('Unknown filter column "' + w.col + '"'); return { col: String(w.col), op, value: w.value }; });
  return { rows: D[q.table].filter(r => r && typeof r === 'object' && matchRow(r, conds)), cols, conds, valid };
};
// query: returns NEW plain objects only (cannot be used to modify the source)
const queryRO = (D, q, ctx) => { const p = prep(D, q, ctx); let rows = p.rows;
  if (q.orderBy) { if (!p.valid.includes(String(q.orderBy))) throw new Error('Unknown sort column "' + q.orderBy + '"'); const k = String(q.orderBy), dir = q.desc ? -1 : 1; rows = rows.slice().sort((x, y) => { const a = x[k], b = y[k]; if (a === b) return 0; if (a === undefined || a === null || a === '') return 1; if (b === undefined || b === null || b === '') return -1; const na = parseFloat(a), nb = parseFloat(b); return (!isNaN(na) && !isNaN(nb) && /^-?[\d.]+$/.test(String(a)) && /^-?[\d.]+$/.test(String(b)) ? na - nb : String(a).localeCompare(String(b))) * dir; }); }
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200), out = rows.slice(0, limit).map(r => { const o = {}; for (const c of p.cols) o[c] = cell(r[c]); return o; });
  return { table: q.table, columns: p.cols, total: rows.length, returned: out.length, truncated: rows.length > out.length, rows: out, filters: p.conds.map(c => c.col + ' ' + c.op) }; };
const countRO = (D, q, ctx) => { const p = prep(D, { table: q.table, columns: q.groupBy ? [q.groupBy] : undefined, where: q.where }, ctx);
  if (!q.groupBy) return { table: q.table, total: p.rows.length, filters: p.conds.map(c => c.col + ' ' + c.op) };
  const g = new Map(); for (const r of p.rows) { const k = r[q.groupBy] === undefined || r[q.groupBy] === null || r[q.groupBy] === '' ? '(empty)' : String(r[q.groupBy]); g.set(k, (g.get(k) || 0) + 1); }
  const groups = [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([value, count]) => ({ value, count })); return { table: q.table, total: p.rows.length, groupBy: q.groupBy, groups, filters: p.conds.map(c => c.col + ' ' + c.op) }; };
// Terms for the privacy gateway: everything in the EDCL data that identifies a person or a login
const sensitiveTerms = D => { const out = [], seen = new Set(), add = (value, kind) => { const v = String(value || '').trim(); if (v.length < 3 || v.length > 120) return; const k = kind + '|' + v.toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push({ value: v, kind }); };
  const names = (v) => { add(v, 'name'); for (const t of String(v || '').split(/[\s,;/()-]+/)) if (t.length >= 4 && !/^(dr|mr|mrs|ms|prof|eng)\.?$/i.test(t)) add(t, 'name'); };
  for (const e of (D && D.Employees) || []) { add(e.StaffID, 'id'); names(e.FullName); for (const k of Object.keys(e)) { if (/mail/i.test(k)) add(e[k], 'email'); else if (/phone|mobile|tel/i.test(k)) add(e[k], 'phone'); else if (/national|passport|iqama|ssn/i.test(k)) add(e[k], 'id'); } }
  for (const u of (D && D.Users) || []) { add(u.username, 'username'); names(u.name); add(u.StaffID, 'id'); }
  for (const a of (D && D.AuthPers) || []) names(a.Name);
  for (const [tbl, cols] of [['Training', ['Trainer']], ['Authorization', ['AuthorizedBy']], ['Evaluation', ['Evaluator']], ['Literature', ['Reviewer']], ['Gap', ['ResponsiblePerson']], ['Plan', ['Trainer', 'Trainees']], ['InstrumentMethods', ['VerifiedBy']], ['MethodCertifiedScientists', ['NameOnForm']]]) for (const r of (D && D[tbl]) || []) for (const c of cols) if (r[c]) { for (const part of String(r[c]).split(/[;,]/)) names(part); }
  return out.slice(0, 6000); };

/* ================= question routing ================= */
const DATA_CUES = /\b(staff|employee|employees|personnel|authori[sz]ed|authori[sz]ation|authori[sz]ations|training|trainings|competen\w+|evaluation|evaluations|iqas|eqas|gap|gaps|job description|certified scientist|instrument|instruments|calibration|equipment|nonconformit\w+|internal audit)\b|موظف|موظفين|تدريب|ترخيص|تفويض|كفاءة|جهاز|أجهزة|معاير/i;
const RECORD_CUES = /\b(our|my|we|us|lab'?s|laboratory'?s|in edcl|in the system|in the database|how many|list (?:all|the|of)|show (?:me )?(?:all|the)|who|which (?:staff|employee|analyst)s?|expir\w+|overdue|due)\b|عدد|كم|اعرض|قائمة|من هو|لدينا|عندنا/i;
// returns { route:'local'|'cloud', dataIntent:bool, reason }
const classify = (q, sensitiveCount) => { const text = String(q || '');
  if (sensitiveCount > 0) return { dataIntent: true, reason: 'The question contains names or IDs from the EDCL records.' };
  if (DATA_CUES.test(text) && RECORD_CUES.test(text)) return { dataIntent: true, reason: 'The question is about the laboratory\'s own records.' };
  return { dataIntent: false, reason: 'A general WADA / scientific question.' }; };

/* ================= local tool loop (model asks, the read-only layer answers) ================= */
const toolPrompt = (cat, extra) => 'You are the EDCL assistant for an anti-doping laboratory. You can READ the laboratory records (read-only) with tools. To use a tool reply with ONE JSON object only, no other text:\n' +
  '{"tool":"query","table":"<table>","columns":["<col>"],"where":[{"col":"<col>","op":"=","value":"<v>"}],"orderBy":"<col>","desc":false,"limit":20}\n' +
  '{"tool":"count","table":"<table>","where":[...],"groupBy":"<col>"}\n{"tool":"docs","query":"<words>"}   (search the document library)\n' +
  'Operators: ' + OPS.join(' ') + '. When you have enough information reply with {"answer":"<your answer>"}. Use at most 4 tool calls. Use only values returned by the tools; never invent records. Cite the tables you used as (Table). Answer in the language of the question. If a table is not allowed or a column is protected, say so.\n' +
  'TABLES (name: rows; columns):\n' + cat.filter(t => t.allowed).map(t => `${t.table}: ${t.rows}; ${t.columns.join(', ')}`).join('\n').slice(0, 9000) + (extra ? '\n' + extra : '');
const parseToolCall = text => { const s = String(text || ''); const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); const cands = []; if (fence) cands.push(fence[1]);
  let depth = 0, start = -1; for (let i = 0; i < s.length; i++) { const ch = s[i]; if (ch === '{') { if (depth === 0) start = i; depth++; } else if (ch === '}' && depth > 0) { depth--; if (depth === 0 && start >= 0) { cands.push(s.slice(start, i + 1)); start = -1; } } }
  for (const c of cands) { try { const j = JSON.parse(c); if (j && typeof j === 'object' && (j.tool || j.answer !== undefined)) return j; } catch (e) { /* next */ } }
  return null; };
const clip = (o, n = 6000) => { const t = JSON.stringify(o); return t.length > n ? t.slice(0, n) + '…(truncated)' : t; };
// ask(messages) -> Promise<string>. env = { D, ctx, search(q)->passages[] , log(entry) }. Returns { answer, steps, usedData, error? }
const runToolLoop = async ({ ask, question, env, library, maxSteps = 4 }) => {
  const cat = catalog(env.D, env.ctx), msgs = [{ role: 'user', content: (library ? 'Library passages:\n' + library + '\n\n' : '') + 'Question: ' + question }], steps = [], evidence = []; let usedData = false, last = '';
  for (let i = 0; i <= maxSteps; i++) {
    const text = await ask(msgs, toolPrompt(cat)); last = text; const call = parseToolCall(text);
    if (!call || call.answer !== undefined) return { answer: call && call.answer !== undefined ? String(call.answer) : String(text).trim(), steps, usedData, evidence: evidence.join('\n') };
    if (i === maxSteps) break; msgs.push({ role: 'assistant', content: String(text).slice(0, 1500) }); let res;
    try {
      if (call.tool === 'query') { res = queryRO(env.D, call, env.ctx); usedData = true; env.log && env.log({ via: 'ai', tool: 'query', table: call.table, columns: res.columns, filters: res.filters, rows: res.returned }); steps.push({ tool: 'query', table: call.table, columns: res.columns, rows: res.returned, total: res.total }); }
      else if (call.tool === 'count') { res = countRO(env.D, call, env.ctx); usedData = true; env.log && env.log({ via: 'ai', tool: 'count', table: call.table, columns: call.groupBy ? [call.groupBy] : [], filters: res.filters, rows: res.total }); steps.push({ tool: 'count', table: call.table, total: res.total }); }
      else if (call.tool === 'docs') { const p = env.search ? env.search(String(call.query || '')) : []; res = { passages: p.map((x, n) => ({ n: n + 1, doc: x.doc ? x.doc.name : '', page: x.chunk.page, text: x.chunk.text.slice(0, 700) })) }; if (p.some(x => x.confidential)) usedData = true; steps.push({ tool: 'docs', query: String(call.query || ''), passages: res.passages.length }); }
      else res = { error: 'Unknown tool "' + call.tool + '". Use query, count or docs.' };
    } catch (e) { res = { error: e.message }; steps.push({ tool: call.tool, error: e.message }); }
    evidence.push(clip(res, 20000)); msgs.push({ role: 'user', content: 'TOOL RESULT: ' + clip(res) });
  }
  return { answer: 'I could not finish within the allowed number of steps. Last model output: ' + String(last).slice(0, 400), steps, usedData, error: 'max-steps', evidence: evidence.join('\n') };
};

/* ================= grounding check: numbers / codes in the answer that are not in the evidence ================= */
const normNum = s => s.replace(/,/g, '.').replace(/\s+/g, '').toLowerCase();
const groundingCheck = (answer, evidence) => {
  const a = String(answer || '').replace(/\[\d+\]/g, ' ').replace(/^\s*\d+[.)]\s/gm, ' '), ev = String(evidence || '').toLowerCase(), evN = normNum(ev), miss = new Set();
  const pats = [/\b\d{4}-\d{2}-\d{2}\b/g, /\b(?:TD|TL)\s?\d{2,4}[A-Z]{0,8}\b/gi, /\bISO(?:\/IEC)?\s?\d{4,5}(?::\d{4})?\b/gi, /\b\d+(?:[.,]\d+)?\s?(?:ng\/ml|ng\/mL|µg\/ml|ug\/ml|mg\/l|%|days?|months?|years?|hours?|weeks?|minutes?|ml|mg|µl|ul)\b/gi];
  for (const re of pats) for (const m of a.matchAll(re)) { const t = m[0]; const n = normNum(t); if (!ev.includes(t.toLowerCase()) && !evN.includes(n)) miss.add(t.trim()); }
  return { unverified: [...miss].slice(0, 8) };
};

return { VER, tok, chunkText, detectType, wantsPrevious, isOld, isPublicDoc, Index, splitPages, TYPES, BLOCKED_COL, OPS, tableAccess, catalog, queryRO, countRO, sensitiveTerms, classify, toolPrompt, parseToolCall, runToolLoop, groundingCheck };
});
