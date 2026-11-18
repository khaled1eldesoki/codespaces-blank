/* EDCL Fillable PDF forms (v1.0.15). Loaded on demand after vendor/edcl-forms-engine.js. Uses page globals: D, tx, rd, esc, now, audit, save, modal, grid, head, pm, can, S, sn, U, dl, SVG, IC, opt, loadJs.
   Master templates are stored once and never written; every save creates a NEW completed copy (revision). */
(function () {
  'use strict';
  const SC = 1.5, fmtSz = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  const ensure = () => ['FormTemplates', 'FormInstances', 'FormRevisions', 'FormLinks'].forEach(k => { D[k] = D[k] || []; });
  const nextId = (t, k, p) => p + String(Math.max(0, ...D[t].map(r => +String(r[k]).replace(/\D/g, '') || 0)) + 1).padStart(4, '0');
  const getFile = id => tx('readonly', s => s.get(id));
  const toBytes = async blob => new Uint8Array(blob.arrayBuffer ? await blob.arrayBuffer() : await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsArrayBuffer(blob); }));
  const sha = bytes => EDCLForms.sha256Hex(bytes);
  const canEdit = () => !!(U && pm('edit'));
  const canView = inst => !!(U && (pm('edit') || pm('assess') || pm('audit') || (pm('own') && U.StaffID && U.StaffID === inst.StaffID)));
  let FONTS = null; const fonts = async () => FONTS || (FONTS = { en: new Uint8Array(await (await fetch('fonts/NotoSans-Regular.ttf')).arrayBuffer()), ar: new Uint8Array(await (await fetch('fonts/NotoNaskhArabic-Regular.ttf')).arrayBuffer()) });
  const pdfjs = async () => { if (!window.pdfjsLib) await loadJs('vendor/pdf.min.js'); pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; return pdfjsLib; };

  /* ---------- templates (masters) ---------- */
  async function importTemplate(file, meta) {
    if (!canEdit()) throw new Error('You do not have permission to import templates');
    if (!file) throw new Error('No file selected');
    if (!/\.pdf$/i.test(file.name)) throw new Error('Only PDF templates can be imported in this version. Word (DOCX/DOC) forms are not supported yet (pending decision, see HANDOVER.md).');
    if (file.size < 100 || file.size > 50 * 1024 * 1024) throw new Error('PDF must be between 100 bytes and 50 MB');
    const bytes = await toBytes(file); if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('The file content is not a PDF');
    const hash = await sha(bytes), dup = D.FormTemplates.find(t => t.Sha256 === hash && t.Status === 'Active');
    if (dup) throw new Error('This exact file is already imported as ' + dup.Code + ' v' + dup.Version);
    const lib = await pdfjs(); let pdf; try { pdf = await lib.getDocument({ data: bytes.slice() }).promise; } catch (e) { throw new Error('The PDF cannot be opened (' + e.message + '). Encrypted or damaged files are not accepted.'); }
    let fields = 0; for (let p = 1; p <= pdf.numPages; p++) fields += (await (await pdf.getPage(p)).getAnnotations()).filter(a => a.subtype === 'Widget' && a.fieldType).length;
    const code = ((meta && meta.code) || file.name.replace(/\.pdf$/i, '')).trim().slice(0, 40), title = ((meta && meta.title) || code).trim().slice(0, 120);
    const prev = D.FormTemplates.filter(t => t.Code === code); prev.forEach(t => { if (t.Status === 'Active') t.Status = 'Superseded'; });
    const fid = await tx('readwrite', s => s.add({ cat: 'ftpl', name: file.name, code: code, type: 'application/pdf', size: bytes.length, date: now().slice(0, 16), blob: new Blob([bytes], { type: 'application/pdf' }) }));
    const t = { TplID: nextId('FormTemplates', 'TplID', 'FT-'), Code: code, Title: title, Kind: 'pdf', Version: prev.length + 1, FileID: fid, FileName: file.name, Sha256: hash, Size: bytes.length, Pages: pdf.numPages, NativeFields: fields, Status: 'Active', ImportedBy: U.username, ImportedAt: now() };
    D.FormTemplates.push(t); audit('Import', 'FormTemplates', t.TplID, code + ' v' + t.Version + ' sha ' + hash.slice(0, 16)); await save(); return t;
  }
  async function verifyMaster(t) { const f = await getFile(t.FileID); if (!f) return { ok: false, why: 'master file is missing' }; const h = await sha(await toBytes(f.blob)); return h === t.Sha256 ? { ok: true } : { ok: false, why: 'master hash changed (expected ' + t.Sha256.slice(0, 12) + ', found ' + h.slice(0, 12) + ')' }; }

  /* ---------- instances (completed copies) ---------- */
  async function newInstance(tplId, staffId, related) {
    if (!canEdit()) throw new Error('You do not have permission to create forms');
    const t = D.FormTemplates.find(x => x.TplID === tplId); if (!t || t.Status !== 'Active') throw new Error('Template not found or not active');
    if (!S[staffId]) throw new Error('Choose a valid employee');
    const chk = await verifyMaster(t); if (!chk.ok) throw new Error('Template integrity check failed: ' + chk.why);
    const rel = (related || []).filter(r => r && r.Type && r.Id), ok = { Training: () => D.Training, Competency: () => D.CompAssess, Authorization: () => D.Authorization, Quality: () => [...(D.Gap || []), ...(D.IQAS || [])] };
    const keyOf = { Training: 'TrainingID', Competency: 'AssessID', Authorization: 'AuthID', Quality: null };
    for (const r of rel) { const list = ok[r.Type] ? ok[r.Type]() : null; if (!list) throw new Error('Unknown related record type ' + r.Type); const row = list.find(x => Object.values(x).some(v => String(v) === String(r.Id))); if (!row) throw new Error(r.Type + ' record ' + r.Id + ' does not exist'); if (row.StaffID && row.StaffID !== staffId) throw new Error(r.Type + ' record ' + r.Id + ' belongs to another employee'); }
    const inst = { FormID: nextId('FormInstances', 'FormID', 'FI-'), TplID: t.TplID, TplSha256: t.Sha256, TplCode: t.Code, StaffID: staffId, Status: 'Draft', Fields: {}, Overlays: [], Ocr: {}, Related: rel, Rev: 0, FileID: '', CreatedBy: U.username, CreatedAt: now(), UpdatedAt: now() };
    D.FormInstances.push(inst); rel.forEach(r => D.FormLinks.push({ FormID: inst.FormID, StaffID: staffId, RecordType: r.Type, RecordID: String(r.Id), LinkedBy: U.username, LinkedAt: now() }));
    audit('Create', 'FormInstances', inst.FormID, t.Code + ' for ' + staffId); await save(); return inst;
  }
  async function saveInstance(inst, state) {
    if (!canEdit()) throw new Error('You do not have permission to save forms');
    const t = D.FormTemplates.find(x => x.TplID === inst.TplID), chk = await verifyMaster(t); if (!chk.ok) throw new Error('Template integrity check failed: ' + chk.why);
    const master = await toBytes((await getFile(t.FileID)).blob); inst.Fields = state.fields; inst.Overlays = state.overlays; inst.Ocr = state.ocr || inst.Ocr;
    const out = await EDCLForms.createCompletedPdf({ masterBytes: master, fontBytes: await fonts(), fields: inst.Fields, overlays: inst.Overlays, flatten: true });
    if (out.masterSha256 !== t.Sha256) throw new Error('Master changed while saving - aborted');
    const rev = inst.Rev + 1, hash = await sha(out.bytes);
    const fid = await tx('readwrite', s => s.add({ cat: 'fdone:' + inst.FormID, name: inst.FormID + '_' + t.Code + '_rev' + rev + '.pdf', code: t.Code + ' completed form', type: 'application/pdf', size: out.bytes.length, date: now().slice(0, 16), blob: new Blob([out.bytes], { type: 'application/pdf' }) }));
    D.FormRevisions.push({ FormID: inst.FormID, Rev: rev, FileID: fid, Sha256: hash, SavedBy: U.username, SavedAt: now(), Status: state.complete ? 'Completed' : 'Draft', Warnings: out.report.warnings.join(' | ') });
    D.DocMeta = D.DocMeta || []; D.DocMeta.push({ FileID: fid, StaffID: inst.StaffID, DocType: 'Completed form', Issue: now().slice(0, 10), Expiry: '', Verified: 'Unverified', VerifiedBy: '', VerifiedAt: '', Version: rev, Sha: hash });
    inst.Rev = rev; inst.FileID = fid; inst.Status = state.complete ? 'Completed' : 'Draft'; inst.UpdatedAt = now();
    audit('Save', 'FormInstances', inst.FormID, 'rev ' + rev + ' sha ' + hash.slice(0, 16) + (out.report.warnings.length ? ' warnings: ' + out.report.warnings.length : '')); await save(); return { rev, fileId: fid, sha: hash, report: out.report };
  }
  const latestBytes = async inst => { if (!inst.FileID) return null; const f = await getFile(inst.FileID); return f ? toBytes(f.blob) : null; };

  /* ---------- print / export ---------- */
  async function pageImagesHtml(bytes) {
    const lib = await pdfjs(), pdf = await lib.getDocument({ data: bytes.slice() }).promise, first = await pdf.getPage(1), v1 = first.getViewport({ scale: 1 });
    let body = ''; for (let p = 1; p <= pdf.numPages; p++) { const pg = await pdf.getPage(p), v = pg.getViewport({ scale: 200 / 72 }), c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height); await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; const w = pg.getViewport({ scale: 1 }); body += `<div class="pg" style="width:${w.width}pt;height:${w.height}pt"><img src="${c.toDataURL('image/png')}" style="width:${w.width}pt;height:${w.height}pt"></div>`; }
    return `<!doctype html><meta charset="utf-8"><style>@page{size:${v1.width}pt ${v1.height}pt;margin:0}html,body{margin:0;padding:0}.pg{page-break-after:always;overflow:hidden}.pg:last-child{page-break-after:auto}img{display:block}</style>${body}`;
  }
  async function printInstance(inst) { const b = await latestBytes(inst); if (!b) throw new Error('Save the form first'); audit('Print', 'FormInstances', inst.FormID, 'rev ' + inst.Rev); return edclDesktop.print(await pageImagesHtml(b)); }
  async function exportInstance(inst) { const b = await latestBytes(inst); if (!b) throw new Error('Save the form first'); audit('Export', 'FormInstances', inst.FormID, 'rev ' + inst.Rev); return edclDesktop.forms.saveFile(Array.from(b), inst.FormID + '_' + inst.TplCode + '.pdf'); }

  /* ---------- editor ---------- */
  async function openEditor(formId) {
    const inst = D.FormInstances.find(x => x.FormID === formId); if (!inst) return; if (!canView(inst)) { audit('Denied form access', 'FormInstances', formId, U.username); return alert('You do not have permission to open this form'); }
    const t = D.FormTemplates.find(x => x.TplID === inst.TplID), ed = canEdit(), chk = await verifyMaster(t);
    const v = $('#v'); v.innerHTML = head('Form ' + esc(inst.FormID), esc(t.Code) + ' - ' + esc(t.Title) + ' | ' + esc(inst.StaffID) + ' ' + esc(sn(inst.StaffID))) + (chk.ok ? '' : `<div class="card" style="border-left:4px solid var(--r)">Master template integrity check FAILED: ${esc(chk.why)}. Editing is disabled.</div>`) +
      `<div class="bar"><button class="btn s" id="fx">◀ Back</button>${ed && chk.ok ? '<button class="btn s" id="fadd">＋ Text box</button><button class="btn s" id="focr">🔍 OCR this page</button><button class="btn s" id="focv">Show OCR words</button><button class="btn" id="fsv">💾 Save revision</button><button class="btn" id="fcp">✔ Save as completed</button>' : ''}<button class="btn s" id="fpr">🖨 Print</button><button class="btn s" id="fex">⬇ Export PDF</button><span id="fst" class="sub" style="margin:0"></span></div>
      <div class="sub">Status <b>${esc(inst.Status)}</b> · revision ${inst.Rev} · master SHA-256 ${esc(t.Sha256.slice(0, 16))}… (never modified) · related: ${inst.Related.map(r => esc(r.Type + ' ' + r.Id)).join(', ') || 'none'}</div><div id="fpg"></div>`;
    const st = msg => { const e = $('#fst'); if (e) e.textContent = msg; };
    const lib = await pdfjs(), master = await toBytes((await getFile(t.FileID)).blob), pdf = await lib.getDocument({ data: master.slice() }).promise;
    const fields = { ...inst.Fields }, overlays = inst.Overlays.map(o => ({ ...o })), ocr = JSON.parse(JSON.stringify(inst.Ocr || {})), pages = []; let addMode = false, showOcr = false;
    const host = $('#fpg'); host.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px;background:#cfd8d5;padding:14px;border-radius:12px;overflow:auto';
    const mkOv = (o, pg) => { const e = document.createElement('div'); e.className = 'fov'; e.dataset.id = o.id; const vp = pg.vp, r = vp.convertToViewportRectangle([o.x, o.y, o.x + o.w, o.y + o.h]), L = Math.min(r[0], r[2]), T = Math.min(r[1], r[3]);
      e.style.cssText = `position:absolute;left:${L}px;top:${T}px;width:${o.w * SC}px;height:${o.h * SC}px;border:1px dashed #0b7a4f;background:#ffffffcc;resize:both;overflow:hidden;min-width:30px;min-height:16px`;
      const ta = document.createElement('textarea'); ta.value = o.text || ''; ta.dir = 'auto'; ta.disabled = !ed || !chk.ok; ta.style.cssText = `width:100%;height:100%;border:0;background:transparent;font:${(o.size || 11) * SC}px/1.2 'Noto Sans','Noto Naskh Arabic','Segoe UI',sans-serif;color:#0a2a8c;resize:none;outline:0;padding:1px 2px;box-sizing:border-box`; ta.oninput = () => { o.text = ta.value; };
      const hd = document.createElement('div'); hd.title = 'drag'; hd.style.cssText = 'position:absolute;right:0;top:0;width:14px;height:14px;background:#0b7a4f;color:#fff;font:10px/14px sans-serif;text-align:center;cursor:move'; hd.textContent = '⠿';
      const x = document.createElement('div'); x.title = 'delete'; x.style.cssText = 'position:absolute;right:15px;top:0;width:14px;height:14px;background:#c4473f;color:#fff;font:10px/14px sans-serif;text-align:center;cursor:pointer'; x.textContent = '×';
      if (ed && chk.ok) { hd.onmousedown = ev => { ev.preventDefault(); const sx = ev.clientX, sy = ev.clientY, l0 = e.offsetLeft, t0 = e.offsetTop; const mv = m => { e.style.left = l0 + m.clientX - sx + 'px'; e.style.top = t0 + m.clientY - sy + 'px'; }; const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); sync(); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); }; x.onclick = () => { overlays.splice(overlays.indexOf(o), 1); e.remove(); }; new ResizeObserver(() => sync()).observe(e); e.append(ta, hd, x); } else e.append(ta);
      const sync = () => { const p = vp.convertToPdfPoint(e.offsetLeft, e.offsetTop + e.offsetHeight); o.x = p[0]; o.y = p[1]; o.w = e.offsetWidth / SC; o.h = e.offsetHeight / SC; }; pg.layer.appendChild(e); e._sync = sync; return e; };
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), vp = page.getViewport({ scale: SC }), box = document.createElement('div'); box.style.cssText = `position:relative;width:${vp.width}px;height:${vp.height}px;background:#fff;box-shadow:0 2px 10px #0004`;
      const cv = document.createElement('canvas'); cv.width = vp.width * (window.devicePixelRatio || 1); cv.height = vp.height * (window.devicePixelRatio || 1); cv.style.cssText = `width:${vp.width}px;height:${vp.height}px;position:absolute;left:0;top:0`; box.appendChild(cv); const layer = document.createElement('div'); layer.style.cssText = 'position:absolute;inset:0'; box.appendChild(layer); host.appendChild(box);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: window.devicePixelRatio > 1 ? [window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0] : null }).promise;
      const pg = { n, page, vp, layer, box }; pages.push(pg);
      if (page.rotate) { const w = document.createElement('div'); w.className = 'sub'; w.textContent = 'Page ' + n + ' is rotated; placement on rotated pages is not supported in this version.'; host.insertBefore(w, box); }
      for (const a of await page.getAnnotations()) { if (a.subtype !== 'Widget' || !a.fieldType || a.readOnly) continue; const r = vp.convertToViewportRectangle(a.rect), L = Math.min(r[0], r[2]), T = Math.min(r[1], r[3]), W = Math.abs(r[2] - r[0]), Hh = Math.abs(r[3] - r[1]); let el;
        if (a.fieldType === 'Tx') { el = a.multiLine ? document.createElement('textarea') : document.createElement('input'); el.value = fields[a.fieldName] ?? (a.fieldValue || ''); el.dir = 'auto'; el.oninput = () => { fields[a.fieldName] = el.value; }; el.style.font = `${Math.min(14, Math.max(9, Hh * 0.55))}px 'Noto Sans','Noto Naskh Arabic','Segoe UI',sans-serif`; }
        else if (a.fieldType === 'Btn' && a.checkBox) { el = document.createElement('input'); el.type = 'checkbox'; el.checked = fields[a.fieldName] !== undefined ? !!fields[a.fieldName] : (a.fieldValue && a.fieldValue !== 'Off'); fields[a.fieldName] = el.checked; el.onchange = () => { fields[a.fieldName] = el.checked; }; }
        else if (a.fieldType === 'Btn' && a.radioButton) { el = document.createElement('input'); el.type = 'radio'; el.name = 'r_' + a.fieldName; el.checked = (fields[a.fieldName] ?? a.fieldValue) === a.buttonValue; el.onchange = () => { if (el.checked) fields[a.fieldName] = a.buttonValue; }; }
        else if (a.fieldType === 'Ch') { el = document.createElement('select'); el.innerHTML = (a.options || []).map(o => `<option value="${esc(o.exportValue)}">${esc(o.displayValue)}</option>`).join(''); el.value = fields[a.fieldName] ?? (Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue) ?? ''; fields[a.fieldName] = el.value; el.onchange = () => { fields[a.fieldName] = el.value; }; }
        else continue; el.dataset.field = a.fieldName; el.disabled = !ed || !chk.ok; el.style.cssText += `;position:absolute;left:${L}px;top:${T}px;width:${W}px;height:${Hh}px;box-sizing:border-box;border:1px solid #0b7a4f66;background:#eaf6ffcc;padding:0 2px`; layer.appendChild(el); }
      overlays.filter(o => o.page === n).forEach(o => mkOv(o, pg));
      layer.addEventListener('click', ev => { if (ev.target !== layer) return; if (!(ed && chk.ok)) return; if (!addMode) return; const rect = layer.getBoundingClientRect(), x = ev.clientX - rect.left, y = ev.clientY - rect.top, w = 160, h = 20, p = vp.convertToPdfPoint(x, y + h * SC); const o = { id: 'o' + Date.now() + Math.floor(Math.random() * 1000), page: n, x: p[0], y: p[1], w, h, text: '', size: 11, dir: 'auto', align: 'auto', multiline: false }; overlays.push(o); const e = mkOv(o, pg); e.querySelector('textarea').focus(); addMode = false; $('#fadd').style.background = ''; });
    }
    const drawOcr = () => pages.forEach(pg => { pg.layer.querySelectorAll('.focr').forEach(e => e.remove()); if (!showOcr) return; (ocr[pg.n] || []).forEach(wd => { const r = pg.vp.convertToViewportRectangle([wd.x, wd.y, wd.x + wd.w, wd.y + wd.h]), e = document.createElement('div'); e.className = 'focr'; e.title = 'Click: add a text box after "' + wd.t + '"'; e.style.cssText = `position:absolute;left:${Math.min(r[0], r[2])}px;top:${Math.min(r[1], r[3])}px;width:${Math.abs(r[2] - r[0])}px;height:${Math.abs(r[3] - r[1])}px;border:1px solid #f29a1f;background:#f29a1f22;cursor:copy`; e.onclick = () => { if (!ed) return; const o = { id: 'o' + Date.now() + Math.floor(Math.random() * 1000), page: pg.n, x: wd.x + wd.w + 4, y: wd.y - 2, w: 160, h: wd.h + 4, text: '', size: 11, dir: 'auto', align: 'auto', multiline: false }; overlays.push(o); mkOv(o, pg).querySelector('textarea').focus(); }; pg.layer.appendChild(e); }); });
    const collect = () => { overlays.forEach(o => { const e = host.querySelector(`.fov[data-id="${o.id}"]`); if (e && e._sync) e._sync(); }); return { fields: { ...fields }, overlays: overlays.filter(o => String(o.text || '').trim()), ocr }; };
    const doSave = async complete => { try { st('Saving…'); const r = await saveInstance(inst, { ...collect(), complete }); st('Saved revision ' + r.rev + (r.report.warnings.length ? ' - warnings: ' + r.report.warnings.join('; ') : '') + (r.report.skipped.length ? ' - skipped fields: ' + r.report.skipped.map(s => s.name).join(', ') : '')); } catch (e) { st(''); alert('Save failed: ' + e.message); } };
    $('#fx').onclick = () => R.forms();
    if (ed && chk.ok) {
      $('#fadd').onclick = () => { addMode = !addMode; $('#fadd').style.background = addMode ? '#d8f1e4' : ''; st(addMode ? 'Click on the page where the text box should go' : ''); };
      $('#fsv').onclick = () => doSave(false); $('#fcp').onclick = () => doSave(true); $('#focv').onclick = () => { showOcr = !showOcr; drawOcr(); };
      $('#focr').onclick = async () => { const first = pages.find(p => { const r = p.box.getBoundingClientRect(); return r.bottom > 80; }) || pages[0]; try { st('OCR: loading…'); await runOcr(first, ocr, st); showOcr = true; drawOcr(); st('OCR done: ' + (ocr[first.n] || []).length + ' words found on page ' + first.n + ' (orange boxes; click one to add a text box next to it)'); } catch (e) { st(''); alert('OCR failed: ' + e.message); } };
    }
    $('#fpr').onclick = async () => { try { const r = await printInstance(inst); if (r && r.ok === false && r.why && !/cancel/i.test(r.why)) alert('Print problem: ' + r.why); } catch (e) { alert(e.message); } };
    $('#fex').onclick = async () => { try { const r = await exportInstance(inst); if (r && r.ok) st('Exported to ' + r.path); } catch (e) { alert(e.message); } };
    window._formsEditor = { inst, pages, fields, overlays, ocr, collect, drawOcr, doSave };
  }
  async function runOcr(pg, store, st) {
    if (!window.Tesseract) await loadJs('vendor/tesseract/tesseract.min.js'); const abs = r => new URL(r, location.href).href;
    const wk = await Tesseract.createWorker(['eng', 'ara'], 1, { workerPath: abs('vendor/tesseract/worker.min.js'), corePath: abs('vendor/tesseract/'), langPath: abs('vendor/tesseract/lang'), gzip: true, workerBlobURL: false, cacheMethod: 'none', logger: m => { if (m.status) st('OCR: ' + m.status + (m.progress ? ' ' + Math.round(m.progress * 100) + '%' : '')); } });
    try { const S3 = 3, v = pg.page.getViewport({ scale: S3 }), c = document.createElement('canvas'); c.width = Math.round(v.width); c.height = Math.round(v.height); await pg.page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise; const H = pg.page.getViewport({ scale: 1 }).height;
      const { data } = await wk.recognize(c, {}, { blocks: true }); const words = (data.blocks || []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words))).filter(w => w.text && w.text.trim());
      store[pg.n] = words.map(w => ({ t: w.text, c: Math.round(w.confidence), x: w.bbox.x0 / S3, y: H - w.bbox.y1 / S3, w: (w.bbox.x1 - w.bbox.x0) / S3, h: (w.bbox.y1 - w.bbox.y0) / S3 })); } finally { await wk.terminate(); }
  }

  /* ---------- pages ---------- */
  let TAB = 'forms';

  // v1.1.0: delete a completed form (all revisions and their files) or an unused template. Audit entries are kept.
  const canDelete = () => !!(U && (pm('edit') || (typeof isA === 'function' && isA())));
  async function deleteInstance(formId) {
    const inst = D.FormInstances.find(x => x.FormID === formId); if (!inst) return false;
    if (!canDelete()) { alert('You do not have permission to delete forms.'); return false; }
    const revs = D.FormRevisions.filter(r => r.FormID === formId);
    if (!confirm('Delete completed form ' + formId + ' (' + inst.TplCode + ' for ' + inst.StaffID + ') with its ' + revs.length + ' saved revision(s)?\n\nThe PDF files will be permanently removed. The deletion is recorded in the audit trail.')) return false;
    for (const f of new Set([...revs.map(r => r.FileID), inst.FileID].filter(Boolean))) { try { await tx('readwrite', st => st.delete(f)); } catch (e) {} }
    const ids = new Set([...revs.map(r => r.FileID), inst.FileID].filter(Boolean));
    D.FormRevisions = D.FormRevisions.filter(r => r.FormID !== formId);
    D.FormLinks = D.FormLinks.filter(r => r.FormID !== formId);
    D.FormInstances = D.FormInstances.filter(x => x.FormID !== formId);
    if (D.DocMeta) D.DocMeta = D.DocMeta.filter(m => !ids.has(m.FileID));
    audit('Delete', 'FormInstances', formId, inst.TplCode + ' for ' + inst.StaffID + ', ' + revs.length + ' revision(s)'); await save(); return true;
  }
  async function deleteTemplate(tplId) {
    const t = D.FormTemplates.find(x => x.TplID === tplId); if (!t) return false;
    if (!canDelete()) { alert('You do not have permission to delete templates.'); return false; }
    const used = D.FormInstances.filter(i => i.TplID === tplId).length;
    if (used) { alert('This template (' + t.Code + ' v' + t.Version + ') is used by ' + used + ' completed form(s). Delete those forms first.'); return false; }
    if (!confirm('Delete template ' + t.Code + ' v' + t.Version + '?\n\nThe master PDF will be permanently removed. The deletion is recorded in the audit trail.')) return false;
    try { await tx('readwrite', st => st.delete(t.FileID)); } catch (e) {}
    D.FormTemplates = D.FormTemplates.filter(x => x.TplID !== tplId);
    audit('Delete', 'FormTemplates', tplId, t.Code + ' v' + t.Version); await save(); return true;
  }
  async function page() {
    ensure(); const v = $('#v'); v.innerHTML = head('Fillable Forms', 'PDF templates are stored once and never changed; each filled form is a separate completed copy linked to an employee and related records') + `<div class="tabs">${[['forms', 'Completed forms'], ['tpl', 'Templates']].map(t => `<a class="${t[0] === TAB ? 'on' : ''}" data-t="${t[0]}">${t[1]}</a>`).join('')}</div><div id="ft"></div>`;
    v.querySelectorAll('.tabs a').forEach(a => a.onclick = () => { TAB = a.dataset.t; page(); }); const ft = $('#ft');
    if (TAB === 'tpl') {
      ft.insertAdjacentHTML('beforeend', `<div class="bar">${canEdit() ? '<label class="btn">⬆ Import PDF template<input type="file" id="ftf" accept=".pdf,application/pdf" hidden></label> <input id="ftc" placeholder="Form code (e.g. FO127)" style="width:170px"> <input id="ftt" placeholder="Title" style="width:240px">' : ''}<span class="sub" style="margin:0">Word forms (DOCX/DOC) are not supported yet.</span></div>`);
      ft.appendChild(grid([['Code', r => r.Code], ['Title', r => r.Title], ['Ver', r => r.Version], ['Status', r => r.Status], ['Pages', r => r.Pages], ['Native fields', r => r.NativeFields], ['SHA-256', r => r.Sha256.slice(0, 12) + '…'], ['Size', r => fmtSz(r.Size)], ['Imported', r => r.ImportedAt + ' ' + r.ImportedBy], ['', r => '', r => `<button class="btn s sm" data-pv="${r.TplID}">Preview</button> ${r.Status === 'Active' && canEdit() ? `<button class="btn sm" data-nf="${r.TplID}">New form</button>` : ''} ${canDelete() ? `<button class="btn s sm" data-delt="${r.TplID}" title="Delete template">🗑 Delete</button>` : ''}`]], D.FormTemplates, null));
      const f = $('#ftf'); if (f) f.onchange = async e => { try { const t = await importTemplate(e.target.files[0], { code: $('#ftc').value.trim() || undefined, title: $('#ftt').value.trim() || undefined }); alert('Imported ' + t.Code + ' v' + t.Version + ' (' + t.Pages + ' pages, ' + t.NativeFields + ' native fields)'); page(); } catch (x) { alert(x.message); } };
    } else {
      ft.appendChild(grid([['Form', r => r.FormID], ['Template', r => r.TplCode], ['Employee', r => r.StaffID + ' ' + sn(r.StaffID)], ['Status', r => r.Status], ['Rev', r => r.Rev], ['Related', r => r.Related.map(x => x.Type + ' ' + x.Id).join(', ')], ['Updated', r => r.UpdatedAt], ['By', r => r.CreatedBy], ['', r => '', r => canDelete() ? `<button class=\"btn s sm\" data-deli=\"${r.FormID}\" title=\"Delete form\">🗑 Delete</button>` : '']], D.FormInstances.filter(canView), r => openEditor(r.FormID), [['Employee', r => r.StaffID + ' ' + sn(r.StaffID)], ['Template', r => r.TplCode], ['Status', r => r.Status]]));
    }
    ft.addEventListener('click', async e => { const b = e.target.closest('[data-deli],[data-delt]'); if (!b) return; e.stopPropagation(); e.preventDefault();
      if (b.dataset.deli ? await deleteInstance(b.dataset.deli) : await deleteTemplate(b.dataset.delt)) page(); }, true);
    ft.onclick = async e => { const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.pv) { const t = D.FormTemplates.find(x => x.TplID === b.dataset.pv), m = modal(`<h2>${esc(t.Code)} v${t.Version} (read-only preview)</h2><div id="fpv" style="max-height:70vh;overflow:auto"></div>`); pdfPages(m.querySelector('#fpv'), await toBytes((await getFile(t.FileID)).blob)); }
      if (b.dataset.nf) { const t = D.FormTemplates.find(x => x.TplID === b.dataset.nf), emps = D.Employees.filter(x => x.EmploymentStatus === 'Active'); const m = modal(`<h2>New form from ${esc(t.Code)}</h2><div class="fg"><label>Employee (required)<select id="nfe">${opt(emps.map(x => [x.StaffID, x.StaffID + ' - ' + x.FullName]), '')}</select></label><label>Related training<select id="nft"></select></label><label>Related competency assessment<select id="nfc"></select></label><label>Related authorization<select id="nfa"></select></label></div><p><button class="btn" id="nfok">Create and open</button></p>`);
        const fill = () => { const s = m.querySelector('#nfe').value, o = (a, f) => '<option value="">(none)</option>' + a.filter(r => r.StaffID === s).map(r => `<option>${esc(f(r))}</option>`).join(''); m.querySelector('#nft').innerHTML = o(D.Training, r => r.TrainingID); m.querySelector('#nfc').innerHTML = o(D.CompAssess || [], r => r.AssessID); m.querySelector('#nfa').innerHTML = o(D.Authorization, r => r.AuthID || r.AuthorizationID || Object.values(r)[0]); }; m.querySelector('#nfe').onchange = fill; fill();
        m.querySelector('#nfok').onclick = async () => { try { const rel = [['Training', '#nft'], ['Competency', '#nfc'], ['Authorization', '#nfa']].map(([T, q]) => ({ Type: T, Id: m.querySelector(q).value })).filter(x => x.Id); const inst = await newInstance(t.TplID, m.querySelector('#nfe').value, rel); m.remove(); openEditor(inst.FormID); } catch (x) { alert(x.message); } }; } };
  }
  function profile(box, sid) { ensure(); const list = D.FormInstances.filter(i => i.StaffID === sid && canView(i)); box.innerHTML = list.length ? `<table><tr><th>Form<th>Template<th>Status<th>Rev<th>Updated<th></tr>${list.map(i => `<tr><td>${esc(i.FormID)}<td>${esc(i.TplCode)}<td>${esc(i.Status)}<td>${i.Rev}<td>${esc(i.UpdatedAt)}<td><button class="btn s sm" data-of="${esc(i.FormID)}">Open</button> ${canDelete() ? `<button class="btn s sm" data-delp="${esc(i.FormID)}" title="Delete form">🗑 Delete</button>` : ''}</tr>`).join('')}</table>` : '<p class="sub">No filled forms for this employee.</p>'; box.querySelectorAll('[data-of]').forEach(b => b.onclick = () => openEditor(b.dataset.of)); box.querySelectorAll('[data-delp]').forEach(b => b.onclick = async () => { if (await deleteInstance(b.dataset.delp)) profile(box, sid); }); }
  window.formsUI = { ensure, importTemplate, verifyMaster, newInstance, saveInstance, openEditor, printInstance, exportInstance, pageImagesHtml, page, profile, runOcr, latestBytes, deleteInstance, deleteTemplate };
})();
