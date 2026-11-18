import fs from 'fs';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
const naskh = fs.readFileSync('fonts/NotoNaskhArabic-Regular.ttf'), sans = fs.readFileSync('fonts/NotoSans-Regular.ttf');
const AR = { name: 'محمد أحمد عبد العظيم', subject: 'تحضير العينات بجهاز الكروماتوجرافيا', comment: 'تم التدريب بنجاح — Training completed 100%', mixed: 'الرقم EMP001 / Staff', date: '٢٠٢٦/١٠/٢١' };
// ---------- 1. build a native fillable PDF ----------
{
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit); const fe = await doc.embedFont(sans, { subset: true }), fa = await doc.embedFont(naskh, { subset: true });
  const page = doc.addPage([595.28, 841.89]); const form = doc.getForm();
  page.drawText('Training Attendance Form (fillable test)', { x: 60, y: 790, size: 16, font: fe });
  const rows = [['Staff ID', 'staff_id', 740], ['Full name', 'full_name', 700], ['Date', 'date', 660], ['Training subject', 'subject', 620]];
  for (const [lab, name, y] of rows) { page.drawText(lab, { x: 60, y: y + 6, size: 10, font: fe }); const f = form.createTextField(name); f.addToPage(page, { x: 180, y, width: 300, height: 22, font: fe, borderWidth: 1 }); }
  page.drawText('Comments', { x: 60, y: 570, size: 10, font: fe }); const c = form.createTextField('comments'); c.enableMultiline(); c.addToPage(page, { x: 180, y: 520, width: 300, height: 70, font: fe, borderWidth: 1 });
  const cb = form.createCheckBox('sat'); cb.addToPage(page, { x: 180, y: 480, width: 16, height: 16, borderWidth: 1 }); page.drawText('Satisfactory', { x: 202, y: 484, size: 10, font: fe });
  const dd = form.createDropdown('result'); dd.addOptions(['Competent', 'Needs repeat', 'Not applicable']); dd.addToPage(page, { x: 180, y: 440, width: 200, height: 22, font: fe, borderWidth: 1 }); page.drawText('Result', { x: 60, y: 446, size: 10, font: fe });
  const rg = form.createRadioGroup('assess'); for (const [i, o] of ['A', 'B'].entries()) { rg.addOptionToPage(o, page, { x: 180 + i * 80, y: 400, width: 16, height: 16, borderWidth: 1 }); page.drawText('Option ' + o, { x: 202 + i * 80, y: 404, size: 10, font: fe }); }
  page.drawText(AR.mixed, { x: 60, y: 350, size: 12, font: fa });  // Arabic label drawn natively
  fs.writeFileSync('forms/FILL-TEST.pdf', await doc.save());
}
// ---------- 2. pdf.js: detect native fields ----------
const open = async f => pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(f)), useSystemFonts: true, verbosity: 0 }).promise;
{ const pd = await open('forms/FILL-TEST.pdf'); const pg = await pd.getPage(1); const an = (await pg.getAnnotations()).filter(a => a.subtype === 'Widget');
  console.log('[pdf.js] widgets detected:', an.length, '->', an.map(a => `${a.fieldName}:${a.fieldType}${a.multiLine ? '(multi)' : ''}${a.checkBox ? '(chk)' : ''}${a.radioButton ? '(radio)' : ''}${a.combo ? '(combo)' : ''}@[${a.rect.map(n => Math.round(n)).join(',')}]`).join(' | ')); }
// ---------- 3. fill native fields (English + Arabic) ----------
{
  const doc = await PDFDocument.load(fs.readFileSync('forms/FILL-TEST.pdf')); doc.registerFontkit(fontkit); const fa = await doc.embedFont(naskh, { subset: true }), fe = await doc.embedFont(sans, { subset: true }); const form = doc.getForm();
  form.getTextField('staff_id').setText('EMP001'); form.getTextField('full_name').setText(AR.name); form.getTextField('date').setText('21/10/2026'); form.getTextField('subject').setText(AR.subject);
  form.getTextField('comments').setText(AR.comment + '\nLine two in English — page flows'); form.getCheckBox('sat').check(); form.getDropdown('result').select('Competent'); form.getRadioGroup('assess').select('B');
  form.updateFieldAppearances(fa); // one font for appearances; Arabic needs the Arabic font
  fs.writeFileSync('forms/FILL-TEST-filled.pdf', await doc.save()); console.log('[pdf-lib] native fields filled (EN+AR), saved separately; master file untouched:', fs.statSync('forms/FILL-TEST.pdf').size, 'bytes');
}
// ---------- 4. overlay text on a NON-fillable PDF (locate labels with pdf.js, then draw) ----------
{
  const pd = await open('forms/FO-TEST-001.pdf'); const pg = await pd.getPage(1); const tc = await pg.getTextContent(); const H = pg.view[3];
  const find = s => tc.items.find(i => i.str.includes(s)); const lab = ['Staff ID', 'Department', 'Training subject', 'Full name'].map(s => [s, find(s)]);
  console.log('[pdf.js] label positions found (x,y in PDF points):', lab.map(([s, i]) => i ? `${s}@(${Math.round(i.transform[4])},${Math.round(i.transform[5])})` : s + ':NOT FOUND').join(' '));
  const doc = await PDFDocument.load(fs.readFileSync('forms/FO-TEST-001.pdf')); doc.registerFontkit(fontkit); const fa = await doc.embedFont(naskh, { subset: true }), fe = await doc.embedFont(sans, { subset: true }); const p = doc.getPage(0);
  const place = (s, txt, font, dx = 0) => { const i = find(s); p.drawText(txt, { x: i.transform[4] + 150 + dx, y: i.transform[5] - 1, size: 10, font, color: rgb(0.05, 0.1, 0.6) }); };
  place('Staff ID', 'EMP001', fe); place('Department', 'Hematology Lab', fe); place('Training subject', AR.subject, fa); place('Full name', AR.name, fa, 20);
  p.drawText(AR.mixed, { x: 80, y: 560, size: 11, font: fa, color: rgb(0.05, 0.1, 0.6) }); p.drawText('Mixed: الرقم EMP001 / Staff ID', { x: 80, y: 540, size: 11, font: fa, color: rgb(0.8, 0.1, 0.1) });
  fs.writeFileSync('forms/FO-TEST-001-overlay.pdf', await doc.save()); console.log('[pdf-lib] overlay drawn on a copy; original size unchanged:', fs.statSync('forms/FO-TEST-001.pdf').size);
}
