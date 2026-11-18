/* EDCL training-record import (ADD-ONLY).
   Adds 5 training events (Oct 2025 - Jul 2026) to the existing Training table and attaches the scanned
   record PDFs to the staff profiles (Documents). Existing records are never changed or removed.
   It asks for confirmation once per run, only for users who can edit, and skips anything already imported.
   Remove: delete the <script src="training-import.js"> line in index.html. */
(()=>{
if(typeof R==='undefined'||!R.dash||window.EDCL_TRAIN_IMPORT_DISABLED)return;
const BASE='training-pdfs/',DIR='Dr. Ahmed Mostafa (Lab Director)';
const band=(s,t)=>{const p=s/t;return t===25?(s>=23?'Excellent':s>=20?'Good':s>=17?'Satisfactory, needs review':'Requires retraining'):t===18?(s>=16?'Excellent':s>=13?'Good':s>=10?'Satisfactory, needs review':'Requires retraining'):t===20?(s>=18?'Excellent':s>=15?'Good':s>=12?'Satisfactory, needs review':'Requires retraining'):t===30?(s>=27?'Excellent':s>=24?'Good':s>=21?'Satisfactory, needs review':'Requires retraining'):t===23?(s>=22?'Excellent':s>=19?'Good':s>=16?'Satisfactory, needs review':'Requires retraining'):(s>=13?'Excellent':s>=11?'Good':s>=9?'Satisfactory, needs review':'Requires retraining')};
const sc=(label,s,t)=>`${label}: ${s}/${t} (${band(s,t)})`;
/* ev: StaffID -> {f: evaluation pdf, scores:[text...], auth:'ISO date or "" ', scope:'...'} */
const EV=[
{k:'RCA',authdate:'2025-11-11',date:'2025-11-10',signoff:'2025-11-11',code:'GR006',
 topic:'Root Cause Analysis (RCA) & Non-Conformity Management (ISO/IEC 17025:2017, WADA ISL 2021, Laboratory SOPs)',
 names:'GR006 v05 – Non-Conforming Work Procedure; CAR (FO064); RCA report (FO210)',trainer:'Yousri Leon',
 att:['EMP001','EMP002','EMP003','EMP004','EMP005','EMP006','EMP007','EMP008','EMP010','EMP011','EMP012','EMP013','EMP014','EMP015','EMP017'],
 prog:['rca_program.pdf','RCA & Non-Conformity Management – Training program and attendance'],
 key:['rca_key.pdf','RCA & Non-Conformity Management – Quiz answer key','EMP018'],
 ev:{EMP004:['rca_eval_amr.pdf',[sc('Quiz',19,20)]],EMP010:['rca_eval_zain.pdf',[sc('Quiz',16,20)]],EMP008:['rca_eval_enas.pdf',[sc('Quiz',17,20)]],EMP017:['rca_eval_waleed.pdf',[sc('Quiz',18,20)]],EMP002:['rca_eval_abo.pdf',[sc('Quiz',18,20)]]},
 auth:'to conduct RCA and use the Corrective Action Report'},
{k:'AUDIT',authdate:'2025-10-29',date:'2025-10-28',signoff:'2025-10-29',code:'GR009, GR035',
 topic:'Internal Audit & WADA Document Implementation Processes (SOP GR009 v08 and SOP GR035 v03)',
 names:'GR009 – Internal Audit; GR035 – WADA Document Implementation',trainer:'Yousri Leon',
 att:['EMP002','EMP004','EMP006','EMP008','EMP010','EMP017'],
 prog:['gr009_035_program.pdf','GR009 & GR035 – Training program and attendance'],
 key:['gr009_035_key.pdf','GR009 & GR035 – Quiz answer keys','EMP018'],
 ev:{EMP008:['gr009_035_eval_enas.pdf',[sc('GR009 quiz',22,25),sc('GR035 quiz',16,18)]],
     EMP004:['gr009_035_eval_amr.pdf',[sc('GR009 quiz',23,25),sc('GR035 quiz',17,18)]],
     EMP002:['gr009_035_eval_abo.pdf',[sc('GR009 quiz',21,25),sc('GR035 quiz',16,18)]],
     EMP010:['gr009_035_eval_zain.pdf',[sc('GR009 quiz',21,25),'GR035: no evaluation sheet in the supplied record']],
     EMP017:['gr009_035_eval_waleed.pdf',[sc('GR009 quiz',22,25),sc('GR035 quiz',16,18)]],
     EMP006:['gr009_035_eval_beniamin.pdf',['GR009: no evaluation sheet in the supplied record',sc('GR035 quiz',17,18)]]},
 auth:'to use GR009 / GR035 (internal audit and WADA document implementation) and related forms'},
{k:'MS030',authdate:'',date:'2025-11-23',signoff:'2025-11-23',code:'MS030',
 topic:'MS030 v4.1 – Detection and Quantification of Urinary Peptide Hormones hCG and LH by Chemiluminescence Immunoassay (acceptance criteria, IQC, evaluation of results)',
 names:'MS030 v4.1',trainer:'Dr. Amr Abd Elhamed Alkorashy',att:['EMP008'],
 prog:['ms030_program.pdf','MS030 v4.1 – Training memorandum'],key:['ms030_key.pdf','MS030 v4.1 – Quiz answer key','EMP004'],
 ev:{EMP008:['ms030_eval_enas.pdf',[sc('Quiz',21,23)+' – handwritten score is hard to read; verify against the paper form']]},
 auth:'to use and implement MS030 v4.1 (the authorization date is blank on the form)'},
{k:'GR013',authdate:'2026-04-25',date:'2026-04-23',signoff:'2026-04-25',code:'GR013',
 topic:'SOP GR013 v04 – Labeling Prepared Reagents and Reference Materials (RMs); Storage Conditions & Verification of Reference Materials',
 names:'GR013 v04',trainer:'Yousri Leon',att:['EMP015','EMP016'],
 prog:['gr013_program.pdf','GR013 v04 – Training memorandum and program'],key:['gr013_key.pdf','GR013 v04 – Quiz answer key','EMP018'],
 ev:{EMP016:['gr013_eval_tarek.pdf',[sc('Quiz',27,30)]],EMP015:['gr013_eval_reem.pdf',[sc('Quiz',26,30)]]},
 auth:'to use and implement SOP GR013 for RM handling'},
{k:'TD2027NA',authdate:'2026-07-28',date:'2026-07-28',signoff:'2026-07-28',code:'TD2027NA',
 topic:'ISL TD2027NA – Harmonization of Analysis and Reporting of 19-Norsteroids',
 names:'ISL TD2027NA v1.1',trainer:'Dr. Amr Abd Elhamed Alkorashy',att:['EMP002','EMP007','EMP014','EMP016'],
 prog:['td2027_program.pdf','ISL TD2027NA – Training memorandum and program'],key:['td2027_key.pdf','ISL TD2027NA – Quiz answer key','EMP004'],
 ev:{EMP014:['td2027_eval_rasha.pdf',[sc('Quiz',13,15)]],EMP016:['td2027_eval_tarek.pdf',[sc('Quiz',13,15)]],EMP007:['td2027_eval_eman.pdf',[sc('Quiz',13,15)]],EMP002:['td2027_eval_abo.pdf',[sc('Quiz',12,15)]]},
 auth:'to use and implement ISL TD2027NA'}
];
const sn=id=>((D.Employees||[]).find(e=>e.StaffID===id)||{}).FullName||id;
const rowNotes=(e,id)=>{const v=e.ev[id];const a=[`Internal training, 1 day. Source: scanned training record (${e.k}).`];
 if(v){a.push('Evaluation FO127v01 – '+v[1].join('; ')+'.');a.push(`Authorized by ${DIR}${e.authdate?' on '+e.authdate:''} ${e.auth}.`)}
 else a.push('Attendance recorded on the training program sheet; no evaluation sheet in the supplied record.');
 return a.join(' ')};
const plan=()=>{const rows=[],files=[];
 for(const e of EV){
  for(const id of e.att){
   if((D.Training||[]).some(t=>t.StaffID===id&&t.TrainingDate===e.date&&String(t.Code||'').toUpperCase()===e.code.toUpperCase()))continue;
   rows.push({StaffID:id,TrainingDate:e.date,TrainingTopic:e.topic,Code:e.code,'SOP/MethodNames':e.names,Trainer:e.trainer,IntExt:'Internal',SignOffDate:e.ev[id]?e.signoff:'',Notes:rowNotes(e,id)});
   files.push([id,e.prog[0],e.prog[1],e.date]);
   if(e.ev[id])files.push([id,e.ev[id][0],`${e.k==='AUDIT'?'GR009 & GR035':e.k==='RCA'?'RCA & Non-Conformity Management':e.k==='GR013'?'GR013 v04':e.k==='MS030'?'MS030 v4.1':'ISL TD2027NA'} – Training evaluation – ${sn(id)}`,e.date]);
  }
  if(rows.some(r=>r.Code===e.code&&r.TrainingDate===e.date))files.push([e.key[2],e.key[0],e.key[1],e.date]);
 }
 return{rows,files}};
const sha=async b=>{try{return typeof shaOf==='function'?await shaOf(b):''}catch(x){return''}};
const run=async()=>{
 const {rows,files}=plan();let nf=0;
 for(const r of rows){r.TrainingID=nid('Training','TrainingID');D.Training.push(r);audit('Import','Training',r.TrainingID,sn(r.StaffID)+' – '+r.Code)}
 save();
 D.DocMeta=D.DocMeta||[];
 const cache={},have=await tx('readonly',s=>s.getAll());
 for(const[id,f,title,date]of files){
  const name=title+'.pdf';
  if((have||[]).some(x=>x.cat==='cert:'+id&&x.name===name))continue;
  try{
   const blob=cache[f]||(cache[f]=await (await fetch(BASE+f)).blob());
   const fid=await tx('readwrite',s=>s.add({cat:'cert:'+id,name,code:title,type:'application/pdf',size:blob.size,date:(date||'')+' 00:00',blob}));
   D.DocMeta.push({FileID:fid,StaffID:id,DocType:'Training record',Issue:date||'',Expiry:'',Verified:'Unverified',VerifiedBy:'',VerifiedAt:'',Version:1,Sha:await sha(blob)});nf++;
  }catch(x){console.error('training-import file',f,x)}
 }
 audit('Import','Training','',`${rows.length} training records, ${nf} files`);save();
 return{rows:rows.length,files:nf}};
let asked=0;
const check=async()=>{
 if(asked||sessionStorage.getItem('edclTrainAsked'))return;
 if(typeof can!=='function'||!can())return;
 const {rows,files}=plan();if(!rows.length&&!files.length)return;
 asked=1;sessionStorage.setItem('edclTrainAsked','1');
 if(!confirm(`Import training records from the scanned files?\n\n• ${rows.length} new training records (Oct 2025 – Jul 2026)\n• ${files.length} PDF files attached to staff profiles\n\nNothing existing is changed or deleted. Continue?`))return;
 try{const r=await run();alert(`Done: ${r.rows} training records and ${r.files} files added.`);if(R.train)R.train();else R.dash()}catch(e){alert('Import stopped: '+e.message)}};
window.edclImportTraining=()=>{sessionStorage.removeItem('edclTrainAsked');asked=0;return check()};
const _d=R.dash;R.dash=()=>{_d();setTimeout(()=>{try{check()}catch(e){console.error('training-import',e)}},800)};
})();
