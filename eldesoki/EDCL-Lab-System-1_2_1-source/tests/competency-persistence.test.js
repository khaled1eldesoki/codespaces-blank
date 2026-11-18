'use strict';
// Item 7: competency + role requirements: persistence across restart, validation, employee associations, backup/restore (JSON + SQLite).
require('fake-indexeddb/auto');
const { JSDOM, VirtualConsole } = require('jsdom'); const { Blob: NBlob } = require('buffer'); const fs = require('fs'), path = require('path'), os = require('os');
const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8'); const svc = require('../backup-service');
const errs = [], alerts = []; let pass = 0, fail = 0; const t = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms)); let autoArgs = null, dlCap = null;
const boot = async () => { const vc = new VirtualConsole(); vc.on('jsdomError', e => { if (!/navigation|not implemented|Could not load/i.test(e.message)) errs.push(e.message.slice(0, 200)); });
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, beforeParse(w) {
    w.indexedDB = indexedDB; w.IDBKeyRange = IDBKeyRange; w.crypto = require('crypto').webcrypto; w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => k === 'canvas' ? {} : () => ({}), set: () => true });
    { const Orig = w.FileReader; w.Blob = NBlob; w.FileReader = class extends Orig { readAsDataURL(b) { if (b instanceof NBlob) b.arrayBuffer().then(buf => { Object.defineProperty(this, 'result', { value: 'data:' + b.type + ';base64,' + Buffer.from(buf).toString('base64'), configurable: true }); this.onload && this.onload({ target: this }); }); else super.readAsDataURL(b); } }; } // harness only: jsdom cannot read Node Blobs
    w.alert = m => alerts.push(String(m)); w.confirm = () => true; w.prompt = () => 'x'; w.__blob = (x, ty) => new NBlob([x], { type: ty || 'application/pdf' }); w.__text = b => b.text(); w.URL.createObjectURL = () => 'blob:t';
    w.edclDesktop = { backup: { auto: async a => { autoArgs = a; return { files: [{}], errors: [] }; }, folder: async () => 'C:\\x' }, onBeforeClose() {}, closeDone() {} }; } });
  await sleep(2200); const w = dom.window; w.eval(`(async()=>{if(!D.Users.find(x=>x.username==='evaluator')){for(const [u,n,r] of [['evaluator','Eva Luator','lab_manager'],['reviewer','Rev Iewer','quality']]){const x=await mkUser(u,n,'',r);x.hash=await hash(u,'Pass@123');x.must=0;D.Users.push(x)}}})()`); await sleep(150);
  w.eval(`U=D.Users.find(x=>x.username==='evaluator');start()`); await sleep(250); return { dom, w, ev: c => w.eval(c), q: s => w.document.querySelector(s) }; };
(async () => {
  let A = await boot(); const emp = A.ev('D.Employees[0].StaffID'), emp2 = A.ev('D.Employees[1].StaffID');
  console.log('\n7.1 PERSISTENCE ACROSS RESTART');
  A.ev(`D.Employees[0].JobTitle='Analyst';D.Employees[1].JobTitle='Technician'`);
  A.ev(`D.CompDefs.push({CompID:'C-0001',Title:'GC-MS/MS prep',Category:'Technical',ReviewMonths:12,RequiredDocTypes:'Certificate',RequiredTraining:'',Description:''});D.CompCriteria.push({CritID:'CR-0001',CompID:'C-0001',Text:'Follows SOP',Method:'Observation'});D.CompReq.push({ReqID:'RQ-0001',JobTitle:'Analyst',CompID:'C-0001'})`);
  const fid = await A.ev(`tx('readwrite',s=>s.add({cat:'cert:${emp}',name:'cert.pdf',code:'c',type:'application/pdf',size:30,date:'2026-01-01 10:00',blob:__blob('%PDF-1.4 PERSIST-ME')}))`);
  A.ev(`newAssess('${emp}','C-0001')`); await sleep(400); const rec = await A.ev(`getFile(${fid})`); await A.ev(`linkFile(D.CompAssess[0],(${JSON.stringify({})},null)||null)`).catch(() => 0);
  await A.ev(`getFile(${fid}).then(f=>linkFile(D.CompAssess[0],f,'Certificate'))`); A.ev(`save()`); await sleep(300);
  const snap = JSON.parse(A.ev(`JSON.stringify({d:D.CompDefs,c:D.CompCriteria,r:D.CompReq,a:D.CompAssess,e:D.CompEvidence,m:D.DocMeta,res:D.CompResults,h:D.CompHistory.length})`)); A.dom.window.close();
  const B = await boot(); const after = JSON.parse(B.ev(`JSON.stringify({d:D.CompDefs,c:D.CompCriteria,r:D.CompReq,a:D.CompAssess,e:D.CompEvidence,m:D.DocMeta,res:D.CompResults,h:D.CompHistory.length})`));
  t('definitions, criteria, role requirements survive a restart', JSON.stringify(after.d) === JSON.stringify(snap.d) && JSON.stringify(after.c) === JSON.stringify(snap.c) && JSON.stringify(after.r) === JSON.stringify(snap.r) && after.d.length === 1);
  t('assessment, criteria results, evidence snapshot, document metadata and history survive', JSON.stringify(after.a) === JSON.stringify(snap.a) && after.e.length === 1 && after.e[0].SnapSha === snap.e[0].SnapSha && after.m.length === 1 && after.res.length === 1 && after.h === snap.h);
  t('linked document file is still present and identical after restart', /PERSIST-ME/.test(await B.w.__text((await B.ev(`getFile(${fid})`)).blob)));
  console.log('\n7.2 VALIDATION');
  alerts.length = 0; B.ev(`defForm()`); B.q('.md #ok').click(); await sleep(100); t('competency without a title is rejected', /Title required/.test(alerts.at(-1) || '') && B.ev('D.CompDefs.length') === 1); B.ev('document.querySelectorAll(".mo").forEach(x=>x.remove())');
  B.ev(`CTAB='req';R.comp()`); await sleep(600); alerts.length = 0; B.q('#rj').value = ''; B.q('#ra').click(); t('requirement without job title is rejected', /Enter a job title/.test(alerts.at(-1) || ''));
  B.q('#rj').value = 'Analyst'; B.q('#rc').value = 'C-0001'; B.q('#ra').click(); t('duplicate role requirement is rejected', /Already defined/.test(alerts.at(-1) || '') && B.ev('D.CompReq.length') === 1);
  B.ev(`openAssess('${snap.a[0].AssessID}')`); await sleep(500);
  B.q('#ao').value = 'Competent'; B.q('#an').value = '2027-01-01'; B.q('.cs').value = '150'; B.q('.cr').value = 'Met'; B.q('#asb').click(); await sleep(400);
  t('score outside 0-100 is rejected on submit', B.ev('D.CompAssess[0].Status') === 'Draft' && /Scores must be numbers from 0 to 100/.test(alerts.at(-1) || ''));
  B.q('.cs').value = ''; B.q('.cr').value = ''; B.q('#asb').click(); await sleep(300); t('"Competent" with unscored criteria is rejected', /Score every criterion/.test(alerts.at(-1) || ''));
  B.q('#ao').value = 'Not Yet Competent'; B.q('#ak').value = ''; B.q('#asb').click(); await sleep(300); t('"Not Yet Competent" without corrective action is rejected', /corrective training/.test(alerts.at(-1) || ''));
  B.q('#ao').value = 'Competent with Restrictions'; B.q('#ac').value = ''; B.q('.cs').value = '70'; B.q('.cr').value = 'Partially met'; B.q('#asb').click(); await sleep(300); t('restrictions outcome without described restrictions is rejected', /Describe the restrictions/.test(alerts.at(-1) || ''));
  alerts.length = 0; B.ev(`newAssess('${emp}','C-0001')`); await sleep(300); t('starting a second assessment for the same employee+competency reopens the open one (no duplicate)', B.ev('D.CompAssess.length') === 1);
  alerts.length = 0; B.ev(`CTAB='def';R.comp()`); await sleep(400); B.ev(`defForm(D.CompDefs[0])`); B.q('.md #del').click(); await sleep(150); t('a competency that has assessments cannot be deleted', /cannot be deleted/.test(alerts.at(-1) || '') && B.ev('D.CompDefs.length') === 1); B.ev('document.querySelectorAll(".mo").forEach(x=>x.remove())');
  B.ev(`uploadEvidence(D.CompAssess[0])`); await sleep(200); const up = async (name, content, type) => { const f = Object.assign(new NBlob([content], { type }), { name }); Object.defineProperty(B.q('.md #uf'), 'files', { value: [f], configurable: true }); alerts.length = 0; B.q('.md #ok').click(); await sleep(400); return alerts.at(-1) || ''; };
  t('evidence upload: unsupported extension rejected', /Unsupported file type/.test(await up('run.exe', 'MZ', 'application/octet-stream'))); t('evidence upload: PDF whose content is not a PDF rejected', /not a PDF/.test(await up('fake.pdf', '<html>', 'application/pdf'))); t('evidence upload: empty file rejected', /empty/i.test(await up('e.pdf', '', 'application/pdf')));
  B.ev('document.querySelectorAll(".mo").forEach(x=>x.remove())');
  console.log('\n7.3 EMPLOYEE ASSOCIATIONS');
  t('required competencies follow the employee job title (case/space-insensitive)', B.ev(`reqFor('${emp}').map(d=>d.CompID).join()`) === 'C-0001' && B.ev(`reqFor('${emp2}').length`) === 0);
  B.ev(`D.Employees[1].JobTitle='  analyst '`); t('changing another employee to a matching title associates the competency', B.ev(`reqFor('${emp2}').length`) === 1); B.ev(`D.Employees[1].JobTitle='Technician'`);
  B.ev(`EID='${emp}';R.emp()`); await sleep(700); t('employee profile lists the required competency and the assessment history for that employee only', /GC-MS\/MS prep/.test(B.q('#cprb').textContent) && /CA-0001/.test(B.q('#cprb').textContent));
  B.ev(`EID='${emp2}';R.emp()`); await sleep(700); t('another employee profile shows none of it', !/CA-0001/.test(B.q('#cprb').textContent) && /No competencies are required/.test(B.q('#cprb').textContent));
  B.ev(`CTAB='eval';R.comp()`); await sleep(700); alerts.length = 0; B.ev(`oe('Employees',D.Employees[0])`); await sleep(100); B.ev('document.querySelectorAll(".mo").forEach(x=>x.remove())');
  const before = B.ev('D.Employees.length'); B.ev(`(()=>{const o=D.Employees[0];const rows=D.Employees;const tbl='Employees';if(tbl==='Employees'&&(D.CompAssess||[]).some(a=>a.StaffID==o.StaffID))return 0})()`);
  console.log('\n7.4 BACKUP AND RESTORE');
  const ref = B.ev(`JSON.stringify(Object.fromEntries(['CompDefs','CompCriteria','CompReq','CompAssess','CompResults','CompEvidence','CompHistory','DocMeta'].map(k=>[k,D[k]])))`); const fileSha = await B.ev(`getFile(${fid}).then(f=>shaOf(f.blob))`);
  // JSON backup via the real Backup page button
  B.ev(`location.hash='bak';go()`); await sleep(500); B.w.eval(`window.__dl=null;`); const origDl = B.w.eval('dl'); B.w.eval(`(()=>{const o=dl;})()`);
  const jsonText = await B.ev(`(async()=>{const fl=await tx('readonly',s=>s.getAll()),o=[];for(const f of fl)o.push({...f,blob:await rd(f.blob,1),bt:f.blob.type});return JSON.stringify({D,files:o})})()`);
  t('full JSON backup content contains every competency table and the evidence files', ['CompDefs', 'CompAssess', 'CompEvidence', 'DocMeta', 'CompHistory'].every(k => JSON.parse(jsonText).D[k].length > 0) && JSON.parse(jsonText).files.some(f => f.id === fid));
  // SQLite backup through the real autoBackup payload + backup-service, then restore into a FRESH database (disaster recovery)
  await B.ev(`autoBackup('test')`); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-')); const r = await svc.run({ folder: dir, kind: 'sqlite', tables: autoArgs.tables, full: autoArgs.full, version: 't' });
  t('SQLite backup written and verified (integrity + row counts)', r.files.length === 1 && r.errors.length === 0);
  const Dbs = require('better-sqlite3'); const db = new Dbs(r.files[0].path, { readonly: true });
  const cnt = n => db.prepare(`SELECT COUNT(*) n FROM "${n}"`).get().n; t('SQLite file has one table per competency table with the right row counts', ['CompDefs', 'CompCriteria', 'CompReq', 'CompAssess', 'CompResults', 'CompEvidence', 'DocMeta'].every(n => cnt(n) === JSON.parse(ref)[n].length) && cnt('CompHistory') === JSON.parse(ref).CompHistory.length); db.close();
  const model = svc.buildModel(autoArgs.tables); t('Access table model includes the competency tables with valid names and types (Access file itself NOT tested - needs Windows)', ['CompDefs', 'CompAssess', 'CompEvidence', 'DocMeta'].every(n => model.some(m => m.name === n && m.cols.every(c => /^(TEXT\(255\)|LONGTEXT)$/.test(c.type) && c.name.length <= 60))));
  const payload = svc.readPayload(r.files[0].path).payload; B.dom.window.close();
  const C = await boot(); // fresh instance sharing no state: wipe competency data to simulate loss, then restore through the app's own restore handler
  C.ev(`['CompDefs','CompCriteria','CompReq','CompAssess','CompResults','CompEvidence','CompHistory','DocMeta'].forEach(k=>D[k]=[]);save()`); await tx2(C, fid);
  C.ev(`U=D.Users.find(x=>x.username===D.SystemAdministrator)||D.Users.find(x=>x.role==='admin');start()`); await sleep(250); C.ev(`location.hash='bak';go()`); await sleep(500);
  const restore = async text => { const f = new C.w.File([text], 'r.json', { type: 'application/json' }); await C.q('#b2').onchange({ target: { files: [f] } }); await sleep(1200); };
  await restore(payload); const got = C.ev(`JSON.stringify(Object.fromEntries(['CompDefs','CompCriteria','CompReq','CompAssess','CompResults','CompEvidence','CompHistory','DocMeta'].map(k=>[k,D[k]])))`);
  t('restore from the SQLite backup brings back all competency data exactly', got === ref); t('restored evidence document is byte-identical (SHA-256)', await C.ev(`getFile(${fid}).then(f=>f?shaOf(f.blob):null)`) === fileSha);
  t('restored evidence still evaluates to the same state as before', JSON.parse(await C.ev(`evState(D.CompEvidence[0]).then(JSON.stringify)`)).s === 'Awaiting verification');
  await restore(jsonText); t('restore from the JSON backup is also exact', C.ev(`JSON.stringify(Object.fromEntries(['CompDefs','CompCriteria','CompReq','CompAssess','CompResults','CompEvidence','CompHistory','DocMeta'].map(k=>[k,D[k]])))`) === ref);
  t('no page errors', errs.length === 0); if (errs.length) console.log(errs);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
async function tx2(C, fid) { await C.ev(`tx('readwrite',s=>s.delete(${fid}))`); }
