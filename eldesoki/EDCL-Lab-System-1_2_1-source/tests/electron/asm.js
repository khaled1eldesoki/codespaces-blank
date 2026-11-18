const { app, BrowserWindow } = require('electron'); const fs = require('fs');
app.setPath('userData', '' + (process.env.USERDATA || '/tmp/edcl-userdata') + ''); app.disableHardwareAcceleration();
require(process.env.MAINJS || '' + (process.env.APP_ROOT || process.cwd()) + '/main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  await sleep(6000); const w = BrowserWindow.getAllWindows()[0]; const run = c => w.webContents.executeJavaScript(c, true).catch(e => 'ERR ' + e.message);
  console.log('setup:', await run(`(async()=>{U=D.Users.find(x=>x.role==='admin')||D.Users[0];start();D.Employees[0].JobTitle='Analyst';
    D.CompDefs.push({CompID:'C-0001',Title:'GC-MS/MS sample preparation',Category:'Technical',ReviewMonths:12,RequiredDocTypes:'',RequiredTraining:'',Description:''});D.CompCriteria.push({CritID:'CR-0001',CompID:'C-0001',Text:'Follows SOP',Method:'Observation'});
    D.Training.push({TrainingID:'T-PRINT',StaffID:D.Employees[0].StaffID,TrainingDate:'2026-09-01',TrainingTopic:'GC-MS/MS basics',SignOffDate:'2026-09-02'});
    ensureComp();newAssess(D.Employees[0].StaffID,'C-0001');const a=D.CompAssess[0];linkTraining(a,D.Training.find(t=>t.TrainingID==='T-PRINT'));a.Outcome='Competent';a.Method='Observation';a.NextReview='2027-10-01';D.CompResults[0].Score='90';D.CompResults[0].Result='Met';a.Score=90;a.Status='Approved';a.EvalSign={user:'x',name:'Evaluator X',ts:'2026-10-21 10:00:00'};a.RevSign={user:'y',name:'Reviewer Y',ts:'2026-10-21 11:00:00'};return a.AssessID})()`));
  const html = await run(`assessHtml(D.CompAssess[0].AssessID)`); console.log('html chars:', String(html).length);
  const r = await run(`(async()=>{try{const h=await assessHtml(D.CompAssess[0].AssessID);const b=await edclDesktop.pdf(h);return 'type='+Object.prototype.toString.call(b)+' len='+(b.length||b.byteLength)+' head='+String.fromCharCode(...new Uint8Array(b).slice(0,5))}catch(e){return 'EXC '+e.message}})()`); console.log('pdf result:', r);
  const b64 = await run(`(async()=>{const b=await edclDesktop.pdf(await assessHtml(D.CompAssess[0].AssessID));let s='';const u=new Uint8Array(b);for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode(...u.subarray(i,i+8192));return btoa(s)})()`);
  if (typeof b64 === 'string' && !b64.startsWith('ERR')) { fs.writeFileSync('/tmp/el/assess.pdf', Buffer.from(b64, 'base64')); console.log('print:pdf bytes', Buffer.from(b64, 'base64').length); }
  console.log('templates page:', await run(`(async()=>{location.hash='tpl';go();await new Promise(r=>setTimeout(r,700));return document.querySelector('#v h1')?document.querySelector('#v h1').textContent+' | rows='+document.querySelectorAll('#v tbody tr').length:'no h1'})()`));
  app.exit(0);
});
