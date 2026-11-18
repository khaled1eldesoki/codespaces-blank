// Drives the REAL app (main.js + preload + index.html + forms.js) in Electron. Isolate the data folder first (see README)!
const { app, BrowserWindow } = require('electron'); const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = process.env.APP_ROOT || process.cwd(), OUT = process.env.FORMS_OUT || '/tmp/forms-out'; fs.mkdirSync(OUT, { recursive: true }); app.disableHardwareAcceleration();
require((process.env.MAINJS || ROOT + '/main.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms)); const lines = []; let fail = 0; const T = (n, c, extra) => { lines.push((c ? 'ok   ' : 'FAIL ') + n + (extra ? '  [' + extra + ']' : '')); if (!c) fail++; };
const KIT = ROOT + '/testkit/forms'; const b64 = f => fs.readFileSync(KIT + '/' + f).toString('base64'); const sha = f => crypto.createHash('sha256').update(fs.readFileSync(KIT + '/' + f)).digest('hex');
app.whenReady().then(async () => {
  await sleep(6500); const w = BrowserWindow.getAllWindows()[0]; const run = c => w.webContents.executeJavaScript(c, true).catch(e => 'ERR ' + e.message);
  await run(`window.__alerts=[];window.alert=m=>window.__alerts.push(String(m));window.confirm=()=>true;window.prompt=()=>'x';'ok'`);
  console.log('setup:', await run(`(async()=>{U=D.Users.find(x=>x.role==='admin')||D.Users[0];start();document.querySelectorAll('.mo').forEach(x=>x.remove());await loadForms();window.F=(n,t)=>{const u=Uint8Array.from(atob(n),c=>c.charCodeAt(0));return new File([u],t,{type:'application/pdf'})};return 'engine='+typeof EDCLForms.createCompletedPdf+' ui='+typeof formsUI.page+' staff='+D.Employees[0].StaffID})()`));
  const emp = await run('D.Employees[0].StaffID'), emp2 = await run('D.Employees[1].StaffID');
  // 1. import
  const imp = async (f, code) => run(`formsUI.importTemplate(F('${b64(f)}','${f}'),{code:'${code}',title:'${code} test form'}).then(t=>JSON.stringify(t),e=>'ERR '+e.message)`);
  const t1 = JSON.parse(await imp('FILL-TEST.pdf', 'FILL-TEST')), t2 = JSON.parse(await imp('FO-TEST-001.pdf', 'FO-TEST-001')), t3 = JSON.parse(await imp('FO-TEST-001-scanned.pdf', 'FO-SCAN'));
  T('1a import fillable / static / scanned PDF templates', t1.Pages === 1 && t2.Pages === 3 && t3.Pages === 1, `pages ${t1.Pages}/${t2.Pages}/${t3.Pages}`);
  T('1b stored SHA-256 equals the SHA-256 of the file on disk', t1.Sha256 === sha('FILL-TEST.pdf') && t2.Sha256 === sha('FO-TEST-001.pdf') && t3.Sha256 === sha('FO-TEST-001-scanned.pdf'));
  T('1c native fields detected by the bundled pdf.js 3.11.174: 9 / 0 / 0', t1.NativeFields === 9 && t2.NativeFields === 0 && t3.NativeFields === 0, `${t1.NativeFields}/${t2.NativeFields}/${t3.NativeFields}`);
  T('1d exact duplicate import rejected', /already imported/.test(await imp('FILL-TEST.pdf', 'FILL-TEST')));
  T('1e Word files rejected with an honest message', /Word \(DOCX\/DOC\) forms are not supported yet/.test(await run(`formsUI.importTemplate(new File([new Uint8Array(500)],'x.docx'),{}).then(()=>'ok',e=>e.message)`)));
  T('1f a non-PDF renamed .pdf is rejected by content', /not a PDF/.test(await run(`formsUI.importTemplate(new File([new Uint8Array(500).fill(60)],'fake.pdf'),{}).then(()=>'ok',e=>e.message)`)));
  // 2. instance + associations
  const trn = await run(`(D.Training.find(t=>t.StaffID==='${emp}')||{}).TrainingID||''`), other = await run(`(D.Training.find(t=>t.StaffID!=='${emp}')||{}).TrainingID||''`);
  const i1 = JSON.parse(await run(`formsUI.newInstance('${t1.TplID}','${emp}',${JSON.stringify(trn ? [{ Type: 'Training', Id: trn }] : [])}).then(i=>JSON.stringify(i),e=>'ERR '+e.message)`));
  T('2a instance created for the employee with the related training record', i1.StaffID === emp && (!trn || i1.Related[0].Id === trn) && i1.Status === 'Draft', trn || 'employee has no training');
  T('2b related record of ANOTHER employee is rejected', !other || /belongs to another employee/.test(await run(`formsUI.newInstance('${t1.TplID}','${emp}',[{Type:'Training',Id:'${other}'}]).then(()=>'ok',e=>e.message)`)));
  T('2c link rows written (FormLinks)', (await run(`D.FormLinks.filter(l=>l.FormID==='${i1.FormID}').length`)) === (trn ? 1 : 0));
  // 3. fill native fields in the editor
  await run(`formsUI.openEditor('${i1.FormID}')`); await sleep(1500);
  T('3a editor shows the 9 native widgets as inputs', (await run(`document.querySelectorAll('#fpg [data-field]').length`)) === 9);
  await run(`(()=>{const q=n=>[...document.querySelectorAll('#fpg [data-field="'+n+'"]')];const set=(n,v)=>{const e=q(n)[0];e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}))};
    set('staff_id','EMP001');set('full_name','محمد أحمد عبد العظيم');set('date','21/10/2026');set('subject','تحضير العينات / Sample preparation (GC-MS/MS) 95%');set('comments','تم التدريب بنجاح — Training completed 100%\\nالسطر الثاني: Second line in English');
    const c=q('sat')[0];c.checked=true;c.dispatchEvent(new Event('change'));const r=q('result')[0];r.value='Competent';r.dispatchEvent(new Event('change'));const rad=q('assess')[1];rad.checked=true;rad.dispatchEvent(new Event('change'));return 1})()`);
  // user-placed text box on the fillable PDF as well
  await run(`(()=>{document.querySelector('#fadd').click();const L=_formsEditor.pages[0].layer,r=L.getBoundingClientRect();L.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+90,clientY:r.top+520}));const t=document.querySelector('.fov textarea');t.value='ملاحظة: Overlay on a fillable form';t.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  T('3b user-placed text box created', (await run(`_formsEditor.overlays.length`)) === 1);
  await run(`window.scrollTo(0,0);document.querySelector('main').scrollTop=0;1`); const shot = await Promise.race([w.webContents.capturePage().then(i => i.toPNG()), sleep(8000).then(() => null)]); if (shot) fs.writeFileSync(OUT + '/editor-fillable.png', shot);
  await run(`_formsEditor.doSave(false)`); await sleep(2500);
  const rev1 = JSON.parse(await run(`JSON.stringify(D.FormRevisions.filter(r=>r.FormID==='${i1.FormID}'))`));
  T('3c first revision saved as a separate file (master untouched)', rev1.length === 1 && rev1[0].FileID !== t1.FileID, rev1[0] && rev1[0].Sha256.slice(0, 12));
  T('3d master template still has its original SHA-256 (verifyMaster)', JSON.parse(await run(`formsUI.verifyMaster(D.FormTemplates.find(t=>t.TplID==='${t1.TplID}')).then(JSON.stringify)`)).ok === true);
  const dump = async (inst, name) => { const b = await run(`(async()=>{const b=await formsUI.latestBytes(D.FormInstances.find(i=>i.FormID==='${inst}'));let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s)})()`); fs.writeFileSync(OUT + '/' + name, Buffer.from(b, 'base64')); return Buffer.from(b, 'base64'); };
  const out1 = await dump(i1.FormID, 'filled-fillable.pdf'); T('3e completed copy is a valid PDF', out1.slice(0, 5).toString() === '%PDF-', out1.length + ' bytes');
  // 4. reopen
  await run(`formsUI.page()`); await sleep(300); await run(`formsUI.openEditor('${i1.FormID}')`); await sleep(1500);
  const re = JSON.parse(await run(`JSON.stringify({id:document.querySelector('[data-field="staff_id"]').value,name:document.querySelector('[data-field="full_name"]').value,chk:document.querySelector('[data-field="sat"]').checked,sel:document.querySelector('[data-field="result"]').value,rad:[...document.querySelectorAll('[data-field="assess"]')].map(e=>e.checked),ov:document.querySelectorAll('.fov').length,ovt:(document.querySelector('.fov textarea')||{}).value})`));
  T('4 reopen restores typed values, checkbox, dropdown, radio and the text box', re.id === 'EMP001' && re.name === 'محمد أحمد عبد العظيم' && re.chk && re.sel === 'Competent' && re.rad[1] === true && re.ov === 1 && /Overlay/.test(re.ovt), JSON.stringify(re).slice(0, 120));
  // 5. static PDF with overlays (precise placement), 3 pages
  const i2 = JSON.parse(await run(`formsUI.newInstance('${t2.TplID}','${emp}',[]).then(i=>JSON.stringify(i))`)); await run(`formsUI.openEditor('${i2.FormID}')`); await sleep(2000);
  const boxes = [{ x: 190, y: 676, w: 100, h: 18, text: 'EMP001' }, { x: 190, y: 647, w: 100, h: 18, text: 'Hematology Lab' }, { x: 440, y: 676, w: 110, h: 18, text: 'محمد أحمد عبد العظيم' }, { x: 190, y: 619, w: 110, h: 18, text: 'تحضير العينات (GC-MS)' }, { x: 60, y: 575, w: 480, h: 50, text: 'تم التدريب بنجاح — Training completed 100%\nالنتيجة: مقبول (Satisfactory) 95%', multiline: true }];
  await run(`(()=>{${JSON.stringify(boxes)}.forEach((b,i)=>{_formsEditor.overlays.push({id:'t'+i,page:1,x:b.x,y:b.y,w:b.w,h:b.h,text:b.text,size:10,dir:'auto',align:'auto',multiline:!!b.multiline})})})()`);
  await run(`_formsEditor.doSave(true)`); await sleep(2500);
  const out2 = await dump(i2.FormID, 'filled-static.pdf'); fs.writeFileSync(OUT + '/overlay-boxes.json', JSON.stringify(boxes));
  T('5a static 3-page PDF completed copy saved; instance status Completed', out2.slice(0, 5).toString() === '%PDF-' && (await run(`D.FormInstances.find(i=>i.FormID==='${i2.FormID}').Status`)) === 'Completed');
  // 6. scanned PDF + OCR
  const i3 = JSON.parse(await run(`formsUI.newInstance('${t3.TplID}','${emp}',[]).then(i=>JSON.stringify(i))`)); await run(`formsUI.openEditor('${i3.FormID}')`); await sleep(2000);
  const ocrRes = await run(`(async()=>{const st=m=>{window.__ocrst=m};const t0=Date.now();await formsUI.runOcr(_formsEditor.pages[0],_formsEditor.ocr,st);const ws=_formsEditor.ocr[1]||[];return JSON.stringify({n:ws.length,ms:Date.now()-t0,has:['Staff','Department','Training','Comments','Assessment'].filter(k=>ws.some(w=>w.t.includes(k))),ar:ws.filter(w=>/[\\u0600-\\u06FF]/.test(w.t)).length})})().catch(e=>'ERR '+e.message)`);
  let oc = {}; try { oc = JSON.parse(ocrRes); } catch { oc = { err: ocrRes }; }
  T('6a OCR ran inside the app on the scanned page (English + Arabic)', oc.n > 30, JSON.stringify(oc).slice(0, 160));
  await run(`(()=>{_formsEditor.drawOcr&&0;const ws=_formsEditor.ocr[1]||[];const d=ws.find(w=>/Department|Staff/.test(w.t));if(d)_formsEditor.overlays.push({id:'ocr1',page:1,x:d.x+d.w+6,y:d.y-2,w:150,h:d.h+4,text:'EMP001 (OCR-placed)',size:10,dir:'auto',align:'auto',multiline:false});return 1})()`);
  await run(`_formsEditor.doSave(false)`); await sleep(2500); const out3 = await dump(i3.FormID, 'filled-scanned.pdf'); T('6b scanned form completed copy saved with an OCR-placed text box', out3.slice(0, 5).toString() === '%PDF-' && (await run(`D.FormRevisions.filter(r=>r.FormID==='${i3.FormID}').length`)) === 1);
  // 7. print path (page images -> real print:pdf handler) 
  const html = await run(`(async()=>await formsUI.pageImagesHtml(await formsUI.latestBytes(D.FormInstances.find(i=>i.FormID==='${i2.FormID}'))))()`); T('7a print HTML built from the completed copy (3 page images, A4 page size)', typeof html === 'string' && (html.match(/<img /g) || []).length === 3 && /size:595\.\d+pt 841\.\d+pt/.test(html), (html || '').length + ' chars');
  const pb = await run(`(async()=>{const b=await edclDesktop.pdf(${JSON.stringify('')}+${JSON.stringify(html || '')});let s='';const u=new Uint8Array(b);for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode(...u.subarray(i,i+8192));return btoa(s)})().catch(e=>'ERR '+e.message)`);
  if (!pb.startsWith('ERR')) fs.writeFileSync(OUT + '/printed-static.pdf', Buffer.from(pb, 'base64')); T('7b print pipeline produced a PDF from the completed copy', !pb.startsWith('ERR') && Buffer.from(pb, 'base64').slice(0, 5).toString() === '%PDF-');
  // 8. association with the employee profile, competency evidence picker and backup coverage
  T('8a completed forms are registered as employee documents (DocMeta) and visible to the competency evidence picker', (await run(`(async()=>{const d=await empDocs('${emp}');return d.filter(f=>String(f.cat).startsWith('fdone:')).length})()`)) >= 3);
  await run(`EID='${emp}';R.emp()`); await sleep(1500); T('8b employee profile lists the filled forms', (await run(`(document.querySelector('#frmb')||{textContent:''}).textContent`)).includes(i1.FormID));
  T('8c form tables are part of the backup data set', JSON.parse(await run(`JSON.stringify(['FormTemplates','FormInstances','FormRevisions','FormLinks'].map(k=>Array.isArray(D[k])&&D[k].length))`)).every(n => n > 0));
  // 9. permissions
  await run(`window.__alerts.length=0;window.__U=U;U={username:'st',role:'staff',name:'S',StaffID:'${emp2}'};1`);
  T('9a staff role cannot create a form', /permission/.test(await run(`formsUI.newInstance('${t1.TplID}','${emp2}',[]).then(()=>'ok',e=>e.message)`)));
  await run(`formsUI.openEditor('${i1.FormID}')`); await sleep(300); T("9b staff cannot open another employee's form", (await run('window.__alerts.join()')).includes('permission'));
  T('9c staff cannot import templates', /permission/.test(await run(`formsUI.importTemplate(F('${b64('FILL-TEST.pdf')}','x.pdf'),{}).then(()=>'ok',e=>e.message)`))); await run('U=window.__U;1');
  // 10. master tamper detection (test data only; restored afterwards)
  await run(`(async()=>{const t=D.FormTemplates.find(t=>t.TplID==='${t1.TplID}');window.__orig=await getFile(t.FileID);const f={...window.__orig,blob:new Blob([new Uint8Array(await window.__orig.blob.arrayBuffer()),new Uint8Array([32,32,32])],{type:'application/pdf'})};await tx('readwrite',s=>s.put(f));return 1})()`);
  T('10a tampered master is detected and new forms from it are refused', /integrity check failed/.test(await run(`formsUI.newInstance('${t1.TplID}','${emp}',[]).then(()=>'ok',e=>e.message)`)));
  await run(`tx('readwrite',s=>s.put(window.__orig))`); T('10b after restoring the original bytes the master verifies again', JSON.parse(await run(`formsUI.verifyMaster(D.FormTemplates.find(t=>t.TplID==='${t1.TplID}')).then(JSON.stringify)`)).ok === true);
  console.log(lines.join('\n')); console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED'); fs.writeFileSync(OUT + '/results.txt', lines.join('\n') + (fail ? `\n${fail} FAILED\n` : '\nALL PASSED\n')); app.exit(fail ? 1 : 0);
});
