import fs from 'fs';
import { PDFDocument, rgb } from 'pdf-lib'; import fontkit from '@pdf-lib/fontkit'; import bidiFactory from 'bidi-js';
const bidi = bidiFactory(); const nB = fs.readFileSync('fonts/NotoNaskhArabic-Regular.ttf'), sB = fs.readFileSync('fonts/NotoSans-Regular.ttf');
const nk = fontkit.create(nB), sk = fontkit.create(sB);
const isArabicish = cp => (cp >= 0x600 && cp <= 0x6FF) || (cp >= 0x750 && cp <= 0x77F) || (cp >= 0xFB50 && cp <= 0xFEFF) || (cp >= 0x8A0 && cp <= 0x8FF);
// split a string into visual-order runs [{text, rtl, font}], choosing a font per character (script fallback)
function visualRuns(text, baseDir) {
  const { levels } = bidi.getEmbeddingLevels(text, baseDir); const runs = []; let cur = null; let i = 0;
  for (const ch of text) { const cp = ch.codePointAt(0), lv = levels[i]; i += ch.length; const useArabic = isArabicish(cp) || (cp >= 0x200C && cp <= 0x200F) || (!sk.hasGlyphForCodePoint(cp) && nk.hasGlyphForCodePoint(cp)); const neutralKeep = cur && /[\s.,:;\-–—()\/%]/.test(ch); const font = useArabic ? 'ar' : (/[\s.,:;\-–—()\/%\d]/.test(ch) && cur && lv % 2 === 1 && cur.font === 'ar' && nk.hasGlyphForCodePoint(cp) ? 'ar' : 'en');
    if (cur && cur.level === lv && cur.font === font) cur.text += ch; else { cur = { text: ch, level: lv, font }; runs.push(cur); } }
  // reorder runs visually (UAX#9 L2 at run granularity)
  const max = Math.max(...runs.map(r => r.level)), minOdd = Math.min(...runs.map(r => r.level).filter(l => l % 2) , 99);
  for (let lv = max; lv >= Math.max(1, minOdd === 99 ? 1 : minOdd); lv--) { for (let a = 0; a < runs.length;) { if (runs[a].level >= lv) { let b = a; while (b + 1 < runs.length && runs[b + 1].level >= lv) b++; const seg = runs.slice(a, b + 1).reverse(); runs.splice(a, b - a + 1, ...seg); a = b + 1; } else a++; } }
  return runs;
}
const doc = await PDFDocument.create(); doc.registerFontkit(fontkit); const F = { ar: await doc.embedFont(nB, { subset: true }), en: await doc.embedFont(sB, { subset: true }) };
const page = doc.addPage([420, 330]);
const firstStrong = t => { for (const ch of t) { if (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(ch)) return 'rtl'; if (/[A-Za-z\u00C0-\u024F]/.test(ch)) return 'ltr'; } return 'ltr'; };
function drawBidi(text, x, y, size, opts = {}) { const dir = opts.dir || firstStrong(text); const runs = visualRuns(text, dir); for (const r of runs) { if (r.level % 2 === 1) r.text = [...r.text].map(c => bidi.getMirroredCharacter(c) || c).join(''); r.pieces = (r.level % 2 === 0 && r.font === 'ar') ? [...r.text] : [r.text]; }
  const w = r => r.pieces.reduce((s, p) => s + F[r.font].widthOfTextAtSize(p, size), 0); const total = runs.reduce((s, r) => s + w(r), 0); let cx = dir === 'rtl' && opts.rightEdge ? opts.rightEdge - total : x; for (const r of runs) for (const p of r.pieces) { page.drawText(p, { x: cx, y, size, font: F[r.font], color: rgb(0, 0, 0.55) }); cx += F[r.font].widthOfTextAtSize(p, size); } return total; }
const samples = ['محمد أحمد عبد العظيم', 'الرقم EMP001 / Staff ID', 'تم التدريب بنجاح — Training completed 100%', '٢٠٢٦/١٠/٢١', 'Hematology Lab — GC-MS/MS', 'مُرضٍ (Satisfactory) 95%', 'Staff ID: EMP001 الرقم الوظيفي'];
samples.forEach((s, i) => { const y = 300 - i * 40; page.drawText(String(i + 1) + '.', { x: 8, y, size: 8, font: F.en }); drawBidi(s, 30, y, 14); });
fs.writeFileSync('forms/bidi-test.pdf', await doc.save()); fs.writeFileSync('forms/bidi-samples.json', JSON.stringify(samples)); console.log('bidi runs for #2:', JSON.stringify(visualRuns(samples[1], 'rtl').map(r => [r.text, r.level, r.font])));
