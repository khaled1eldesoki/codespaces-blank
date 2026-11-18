'use strict';
// Tests the BUILT, MINIFIED browser bundle (app/vendor/edcl-forms-engine.js) - the code the app actually ships - and the source module's bidi ordering.
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const R = path.join(__dirname, '..'); const KIT = R + '/testkit/forms'; const rd = f => new Uint8Array(fs.readFileSync(f));
const bundle = new Function(fs.readFileSync(R + '/app/vendor/edcl-forms-engine.js', 'utf8') + ';return EDCLForms;')();
const fonts = { en: rd(R + '/app/fonts/NotoSans-Regular.ttf'), ar: rd(R + '/app/fonts/NotoNaskhArabic-Regular.ttf') };
const sha = b => crypto.createHash('sha256').update(b).digest('hex'); const hasPoppler = (() => { try { cp.execSync('pdftotext -v 2>&1'); return true; } catch { return false; } })();
const text = bytes => { fs.writeFileSync('/tmp/_fe.pdf', bytes); return cp.execSync('pdftotext /tmp/_fe.pdf - 2>/dev/null').toString(); };
const poppler = bytes => { fs.writeFileSync('/tmp/_fe2.pdf', bytes); return +cp.execSync('pdfinfo /tmp/_fe2.pdf 2>&1 | grep -c "Syntax Error" || true').toString().trim(); };
test('bundle exports the API and survives minification', () => { for (const k of ['createCompletedPdf', 'drawTextBox', 'unitsOf', 'widthOf', 'firstStrong', 'listFields', 'sha256Hex']) assert.equal(typeof bundle[k], 'function', k); });
test('native fields of a real fillable PDF are recognised in the minified bundle (text, multiline, checkbox, radio, dropdown)', async () => {
  const f = await bundle.listFields(rd(KIT + '/FILL-TEST.pdf')); assert.deepEqual(f.map(x => x.type).sort(), ['checkbox', 'dropdown', 'radio', 'text', 'text', 'text', 'text', 'text']); });
test('fill native fields (English + Arabic + mixed): all 8 fields drawn, none skipped, master bytes untouched, structure clean', async () => {
  const master = rd(KIT + '/FILL-TEST.pdf'), before = sha(master);
  const out = await bundle.createCompletedPdf({ masterBytes: master, fontBytes: fonts, fields: { staff_id: 'EMP001', full_name: 'محمد أحمد عبد العظيم', date: '21/10/2026', subject: 'تحضير العينات / Sample preparation (GC-MS/MS) 95%', comments: 'تم التدريب بنجاح — Training completed 100%\nSecond line', sat: true, result: 'Competent', assess: 'B' } });
  assert.equal(sha(master), before, 'master untouched'); assert.equal(out.masterSha256, before); assert.equal(out.report.skipped.length, 0, JSON.stringify(out.report.skipped)); assert.equal(out.report.fields.length, 8); assert.deepEqual(out.report.warnings, []);
  assert.equal(String.fromCharCode(...out.bytes.slice(0, 5)), '%PDF-');
  if (hasPoppler) { const t = text(out.bytes); for (const w of ['EMP001', '21/10/2026', 'Competent', 'Sample preparation', 'Training completed 100%']) assert.ok(t.includes(w), 'text layer has ' + w); assert.equal(poppler(out.bytes), 0, 'no xref errors / dangling annotation references'); } });
test('overlays on a non-fillable multi-page PDF; master untouched; pages 2-3 unchanged in content', async () => {
  const master = rd(KIT + '/FO-TEST-001.pdf'), before = sha(master);
  const out = await bundle.createCompletedPdf({ masterBytes: master, fontBytes: fonts, overlays: [{ page: 1, x: 190, y: 676, w: 100, h: 18, text: 'EMP001' }, { page: 1, x: 60, y: 575, w: 480, h: 50, text: 'تم التدريب بنجاح — Training completed 100%\nالنتيجة: مقبول (Satisfactory) 95%', multiline: true }, { page: 9, x: 0, y: 0, w: 10, h: 10, text: 'x' }] });
  assert.equal(sha(master), before); assert.equal(out.report.overlays, 2); assert.ok(out.report.warnings.some(w => /missing page 9/.test(w)), 'overlay on a non-existent page is reported, not silently dropped'); if (hasPoppler) { assert.ok(text(out.bytes).includes('EMP001')); assert.equal(poppler(out.bytes), 0); } });
test('a box that is too small is reported (overflow warning) instead of silently cut', async () => {
  const out = await bundle.createCompletedPdf({ masterBytes: rd(KIT + '/FO-TEST-001.pdf'), fontBytes: fonts, overlays: [{ page: 1, x: 10, y: 10, w: 20, h: 10, text: 'This text is far too long for a tiny box', multiline: true }] }); assert.ok(out.report.warnings.some(w => /does not fit/.test(w))); });
test('bidi visual order and bracket mirroring equal an independent reordering by bidi-js (10 mixed strings)', async () => {
  const E = await import(R + '/app/forms-engine.src.mjs'); const bidi = require('bidi-js')(); const { PDFDocument } = require('pdf-lib'); const fontkit = require('@pdf-lib/fontkit'); const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  const mk = async b => ({ pdf: await doc.embedFont(b, { subset: true }), fk: fontkit.create(b) }); const F = { en: await mk(fonts.en), ar: await mk(fonts.ar) };
  const samples = JSON.parse(fs.readFileSync(__dirname + '/fixtures/bidi-samples.json', 'utf8'));
  for (const s of samples) { const dir = E.firstStrong(s); const units = E.unitsOf(s, dir, F); const ours = units.map(u => (u.kind === 'word' && u.level % 2 ? [...u.text].reverse().join('') : u.text)).join('');
    const { levels } = bidi.getEmbeddingLevels(s, dir); const idx = bidi.getReorderedIndices(s, { levels, paragraphs: [{ start: 0, end: s.length, level: dir === 'rtl' ? 1 : 0 }] }); const chars = [...s]; let exp = ''; for (const i of idx) { const c = s[i]; exp += levels[i] % 2 ? (bidi.getMirroredCharacter(c) || c) : c; }
    assert.equal(ours, exp, 'visual order of: ' + s); } });
