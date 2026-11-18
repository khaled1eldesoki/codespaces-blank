// EDCL forms engine: writes typed values onto a COPY of a PDF master. Never modifies the master bytes it is given.
// Mixed Arabic/English text: Unicode bidi (bidi-js) -> visual runs; Arabic words are shaped by fontkit via pdf-lib;
// Latin, digits, spaces and punctuation use the Latin font; Arabic-Indic digits are drawn left-to-right; brackets are mirrored in RTL runs.
import { PDFDocument, PDFName, PDFArray, PDFTextField, PDFDropdown, PDFOptionList, PDFCheckBox, PDFRadioGroup, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';
const bidi = bidiFactory();
const ARAB = /\p{Script=Arabic}/u, ADIGIT = /[\u0660-\u0669\u06F0-\u06F9]/;
export const firstStrong = t => { for (const ch of String(t)) { if (ADIGIT.test(ch)) continue; if (ARAB.test(ch)) return 'rtl'; if (/\p{L}/u.test(ch)) return 'ltr'; } return 'ltr'; };

// fonts = { en: {pdf: PDFFont, fk: fontkitFont}, ar: {...} }
export function unitsOf(text, baseDir, fonts) {
  const { levels } = bidi.getEmbeddingLevels(text, baseDir); const units = []; let idx = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0), lv = levels[idx]; idx += ch.length;
    const isArab = ARAB.test(ch) && !ADIGIT.test(ch) && !/[\u060C\u061B\u061F\u066A-\u066D]/.test(ch);
    if (isArab && fonts.ar.fk.hasGlyphForCodePoint(cp)) { const last = units.at(-1); if (last && last.kind === 'word' && last.level === lv) last.text += ch; else units.push({ kind: 'word', text: ch, level: lv, font: 'ar' }); continue; }
    let font = ADIGIT.test(ch) ? 'ar' : 'en';
    if (!fonts[font].fk.hasGlyphForCodePoint(cp)) font = font === 'en' ? 'ar' : 'en';
    let c = ch; if (lv % 2 === 1) c = bidi.getMirroredCharacter(ch) || ch;
    units.push({ kind: 'char', text: c, level: lv, font });
  }
  // L2: reverse contiguous sequences from the highest level down to the lowest odd level
  const max = Math.max(0, ...units.map(u => u.level)), odd = units.map(u => u.level).filter(l => l % 2);
  if (odd.length) for (let lv = max; lv >= Math.min(...odd); lv--) for (let a = 0; a < units.length;) { if (units[a].level >= lv) { let b = a; while (b + 1 < units.length && units[b + 1].level >= lv) b++; const seg = units.slice(a, b + 1).reverse(); units.splice(a, b - a + 1, ...seg); a = b + 1; } else a++; }
  // merge neighbouring single characters of the same font and level into one drawn run (keeps kerning); odd-level runs are reversed
  const merged = []; for (let i = 0; i < units.length;) { const u = units[i]; if (u.kind !== 'char') { merged.push(u); i++; continue; } let j = i, txt = ''; while (j < units.length && units[j].kind === 'char' && units[j].font === u.font && units[j].level === u.level && !(u.font === 'ar')) { txt += units[j].text; j++; } if (j === i) { merged.push(u); i++; continue; } merged.push({ kind: 'run', text: txt, level: u.level, font: u.font }); i = j; }
  return merged;
}
export const widthOf = (text, size, fonts, dir = 'auto') => unitsOf(text, dir === 'auto' ? firstStrong(text) : dir, fonts).reduce((s, u) => s + fonts[u.font].pdf.widthOfTextAtSize(u.text, size), 0);

function wrap(text, size, maxW, fonts, dir) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    const words = para.split(/(\s+)/).filter(w => w !== ''); let line = '';
    for (const w of words) { const t = line + w; if (line && widthOf(t.trimEnd(), size, fonts, dir) > maxW && !/^\s+$/.test(w)) { out.push(line.trimEnd()); line = w.trimStart(); } else line = t; }
    out.push(line.trimEnd());
  }
  return out;
}
// draw text into a box {x,y,w,h} (PDF points, origin bottom-left). Returns {lines, size, overflow}
export function drawTextBox(page, text, box, o, fonts) {
  text = String(text ?? ''); if (!text) return { lines: 0, size: o.size || 10, overflow: false };
  const dir = o.dir && o.dir !== 'auto' ? o.dir : firstStrong(text), align = o.align && o.align !== 'auto' ? o.align : (dir === 'rtl' ? 'right' : 'left');
  let size = o.size || 10; const pad = o.pad ?? 2, color = o.color || rgb(0.04, 0.1, 0.45), innerW = Math.max(1, box.w - pad * 2), multi = !!o.multiline;
  let lines = multi ? wrap(text, size, innerW, fonts, dir) : [text];
  if (!multi) while (widthOf(text, size, fonts, dir) > innerW && size > (o.minSize || 6)) size -= 0.5; // shrink to fit one line
  const lh = size * 1.25; let overflow = !multi && widthOf(text, size, fonts, dir) > innerW;
  if (multi && lines.length * lh > box.h + 0.5) overflow = true;
  lines.forEach((ln, i) => {
    const units = unitsOf(ln, dir, fonts), total = units.reduce((s, u) => s + fonts[u.font].pdf.widthOfTextAtSize(u.text, size), 0);
    let x = align === 'right' ? box.x + box.w - pad - total : align === 'center' ? box.x + (box.w - total) / 2 : box.x + pad;
    const y = multi ? box.y + box.h - pad - size * 0.85 - i * lh : box.y + (box.h - size) / 2 + size * 0.22;
    for (const u of units) { page.drawText(u.text, { x, y, size, font: fonts[u.font].pdf, color }); x += fonts[u.font].pdf.widthOfTextAtSize(u.text, size); }
  });
  return { lines: lines.length, size, overflow };
}

export async function sha256Hex(bytes) {
  const subtle = (globalThis.crypto && globalThis.crypto.subtle); if (subtle) { const h = await subtle.digest('SHA-256', bytes); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join(''); }
  const { createHash } = await import('node:crypto'); return createHash('sha256').update(bytes).digest('hex');
}
const pageIndexOfWidget = (doc, widget) => { const ref = doc.context.getObjectRef(widget.dict); const pages = doc.getPages(); for (let i = 0; i < pages.length; i++) { const an = pages[i].node.Annots(); if (an && an.asArray().some(r => r === ref || (r.objectNumber === ref.objectNumber))) return i; } return 0; };

/** Build a completed copy. masterBytes is never altered. fields = { name: string|boolean }, overlays = [{page(1-based),x,y,w,h,text,size,dir,align,multiline}] */
export async function createCompletedPdf({ masterBytes, fontBytes, fields = {}, overlays = [], flatten = true }) {
  const masterHash = await sha256Hex(masterBytes);
  const doc = await PDFDocument.load(masterBytes, { updateMetadata: false }); doc.registerFontkit(fontkit);
  const mk = async b => ({ pdf: await doc.embedFont(b, { subset: true }), fk: fontkit.create(b) });
  const fonts = { en: await mk(fontBytes.en), ar: await mk(fontBytes.ar) };
  const report = { masterSha256: masterHash, fields: [], skipped: [], overlays: 0, warnings: [] };
  const form = doc.getForm(); const pages = doc.getPages();
  for (const [name, value] of Object.entries(fields)) {
    let f; try { f = form.getField(name); } catch { report.skipped.push({ name, why: 'field not found in this PDF' }); continue; }
    // instanceof, never constructor.name: the shipped bundle is minified and class names are mangled
    const t = f instanceof PDFTextField ? 'PDFTextField' : f instanceof PDFDropdown ? 'PDFDropdown' : f instanceof PDFOptionList ? 'PDFOptionList' : f instanceof PDFCheckBox ? 'PDFCheckBox' : f instanceof PDFRadioGroup ? 'PDFRadioGroup' : 'unsupported';
    try {
      if (t === 'PDFTextField' || t === 'PDFDropdown' || t === 'PDFOptionList') {
        const widgets = f.acroField.getWidgets(), multi = t === 'PDFTextField' && f.isMultiline();
        if (value !== '' && value != null) for (const w of widgets) { const r = w.getRectangle(); drawTextBox(pages[pageIndexOfWidget(doc, w)], Array.isArray(value) ? value.join(', ') : String(value), { x: r.x, y: r.y, w: r.width, h: r.height }, { size: Math.min(12, Math.max(7, r.height * 0.6)), multiline: multi, pad: 2 }, fonts); }
        form.removeField(f); report.fields.push({ name, type: t, drawn: true });
      } else if (t === 'PDFCheckBox') { value ? f.check() : f.uncheck(); report.fields.push({ name, type: t, value: !!value }); }
      else if (t === 'PDFRadioGroup') { if (value) f.select(String(value)); report.fields.push({ name, type: t, value }); }
      else report.skipped.push({ name, why: 'unsupported field type' });
    } catch (e) { report.skipped.push({ name, why: e.message }); }
  }
  for (const o of overlays) { const p = pages[(o.page || 1) - 1]; if (!p) { report.warnings.push('overlay on missing page ' + o.page); continue; } const r = drawTextBox(p, o.text, { x: o.x, y: o.y, w: o.w, h: o.h }, o, fonts); if (r.overflow) report.warnings.push('text does not fit its box on page ' + o.page + ': ' + String(o.text).slice(0, 30)); report.overlays++; }
  if (flatten) { try { form.flatten(); } catch (e) { report.warnings.push('remaining fields not flattened: ' + e.message); } }
  // pdf-lib leaves references to deleted widgets in page /Annots (poppler reports "Invalid XRef entry"): remove dangling refs, drop empty /Annots and an empty AcroForm
  let removedRefs = 0; for (const pg of doc.getPages()) { const an = pg.node.Annots(); if (!an) continue; const keep = an.asArray().filter(r => doc.context.lookup(r)); removedRefs += an.size() - keep.length; if (keep.length) pg.node.set(PDFName.of('Annots'), doc.context.obj(keep)); else pg.node.delete(PDFName.of('Annots')); }
  const af = doc.catalog.lookup(PDFName.of('AcroForm')); if (af) { const fl = af.lookup(PDFName.of('Fields')); if (!fl || (fl instanceof PDFArray && fl.size() === 0)) doc.catalog.delete(PDFName.of('AcroForm')); }
  if (removedRefs) report.warnings = report.warnings; report.cleanedAnnotRefs = removedRefs;
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, report, masterSha256: masterHash };
}
// Field list from pdf-lib (used by tests and as a fallback when pdf.js is unavailable)
export async function listFields(masterBytes) { const doc = await PDFDocument.load(masterBytes, { updateMetadata: false }); return doc.getForm().getFields().map(f => ({ name: f.getName(), type: f instanceof PDFTextField ? 'text' : f instanceof PDFDropdown ? 'dropdown' : f instanceof PDFOptionList ? 'list' : f instanceof PDFCheckBox ? 'checkbox' : f instanceof PDFRadioGroup ? 'radio' : 'other' })); }
