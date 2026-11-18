/* EDCL Quiz Register (TRQ) tab + fills "Training Record Files" from the scanned records (ADD-ONLY).
   - New tab "Quiz Register (TRQ)": index of TRQ numbers, linked to the training record files.
   - Data lives in D.TRQ (new list); training packages go to the existing D.TrainPkgs; scans to the existing file store.
   - Existing records are never changed or deleted. Remove: delete the <script src="trq-register.js"> line. */
(()=>{
if(typeof R==='undefined'||typeof NAV==='undefined'||window.EDCL_TRQ_DISABLED)return;
const BASE='training-pdfs/',DIR='Dr. Ahmed Mostafa',eh=s=>esc(s);
const manage=()=>!!(U&&(can()||pm('edit')));
const NOTE='Registered from the scanned training record. Scores and dates are as written on the paper forms.';
const L=t=>t.join('\n');
const QM='Quality Manager',YL='Yousri Leon',AK='Dr. Amr Alkorashy',TM='Technical Manager';
/* sp: staff attendees -> [StaffID or '', name if not on the staff list, score or null, evaluation pdf] */
const SPEC=[
{code:'GR006',date:'2025-11-10',duration:'1 day',trainer:YL,trainerTitle:QM,
 title:'Root Cause Analysis (RCA) & Non-Conformity Management (ISO/IEC 17025:2017, WADA ISL 2021, Laboratory SOPs)',
 memo:{},program:{formCode:'FO313v01',objectives:L(['Understand and apply ISO/IEC 17025:2017 Clause 7.10 (Non-Conforming Work) and WADA ISL 2021 requirements.','Perform structured Root Cause Analysis using standardized tools (5 Whys, Timeline Analysis).','Prepare, document and close Corrective Action Reports (CARs) in compliance with laboratory SOPs (GR006v05, FO064v01, FO210v01).','Integrate RCA and CAR processes into daily laboratory operations to prevent recurrence of non-conformities.']),modules:L(['Module 1: Introduction to Non-Conforming Work & Regulatory Framework','Module 2: Laboratory SOP GR006v05 – Non-Conforming Work Procedure','Module 3: Root Cause Analysis (RCA) – Principles & Tools','Module 4: Corrective Action Report (CAR) – Preparation & Completion','Module 5: Effectiveness Checks & CAR Closure','Module 6: Integration with the Laboratory Management System'])},
 quiz:{formCode:'TRQ-001',minutes:15,mc:'B,C,C,C,B,B,C,B,D,D',tf:'False,True,False,False,True,False,True,False,True,True',total:20,preparedBy:YL+' – '+QM,approvedBy:DIR},
 q:{mc:10,tf:10},
 att:[['EMP001'],['EMP002',0,18,'rca_eval_abo.pdf'],['EMP003'],['EMP004',0,19,'rca_eval_amr.pdf'],['EMP005'],['EMP006'],['EMP007'],['EMP008',0,17,'rca_eval_enas.pdf'],['EMP010',0,16,'rca_eval_zain.pdf'],['EMP011'],['EMP012'],['EMP013'],['EMP014'],['EMP015'],['EMP017',0,18,'rca_eval_waleed.pdf'],['','Dr. Ahmed Mostafa']],
 ev:{by:YL,pos:QM,date:'2025-11-11'},au:{date:'2025-11-11',scope:'Conduct RCA and use the Corrective Action Report'},
 files:{program:['rca_program.pdf','Training program and attendance'],key:['rca_key.pdf','Quiz answer key (TRQ-001)']},ev0:'RCA & Non-Conformity Management'},
{code:'GR009',date:'2025-10-28',time:'10:00',duration:'Approximately 2–3 hours',trainer:YL,trainerTitle:QM,
 title:'SOP GR009 v08 – Internal Audit (Internal Audit & WADA Document Implementation Processes)',
 memo:{formCode:'FO174v01',date:'2025-10-27',from:QM,to:'All Internal Auditors, DCS',background:'Mandatory training on the updated Internal Audit and WADA Document procedures (SOPs GR009 and GR035). The training is a direct response to WADA feedback and ensures compliance with the version-tracking requirements in internal audit reports. Attendance is mandatory for all internal auditors.'},
 program:{formCode:'FO313v01',objectives:L(['Understand the updated requirements in GR009 (Internal Audit SOP) and GR035 (WADA Document Implementation SOP).','Correctly document WADA TD/TL/LG version numbers and effective dates in audit reports.','Use the updated Internal Audit Report Template (FO041) and WADA Trigger List (FO340).','Explain the WADA document implementation stages: consultation, planning, implementation and archiving.']),modules:L(['Module 1: Introduction & Background','Module 2: Updated SOP GR035 – WADA Document Implementation','Module 3: Updated SOP GR009 – Internal Audit Process','Module 4: Practical Exercise – Mock Audit Scenario','Module 5: Monitoring & Effectiveness'])},
 quiz:{formCode:'TRQ-003',minutes:15,mc:'',tf:'',total:25,preparedBy:YL+' – '+QM,approvedBy:''},q:{mc:25,tf:0},
 att:[['','Dr. Ahmed Mostafa'],['EMP004',0,23,'gr009_eval_amr.pdf'],['EMP006'],['EMP010',0,21,'gr009_eval_zain.pdf'],['EMP008',0,22,'gr009_eval_enas.pdf'],['EMP017',0,22,'gr009_eval_waleed.pdf'],['EMP002',0,21,'gr009_eval_abo.pdf']],
 ev:{by:YL,pos:QM,date:'2025-10-29'},au:{date:'2025-10-29',scope:'Conduct internal audits and use the internal audit report'},
 files:{program:['gr009_035_program.pdf','Memorandum, training program and attendance (GR009 & GR035)'],key:['gr009_key.pdf','Quiz answer key (TRQ-003)']},ev0:'GR009',
 notes:'Answer key: see the attached scan (TRQ-003). Same training session as SOP GR035 (TRQ-004).'},
{code:'GR035',date:'2025-10-28',time:'10:00',duration:'Approximately 2–3 hours',trainer:YL,trainerTitle:QM,
 title:'SOP GR035 v03 – Implementation of WADA Documents Changes',
 memo:{formCode:'FO174v01',date:'2025-10-27',from:QM,to:'All Internal Auditors, DCS',background:'Mandatory training on the updated Internal Audit and WADA Document procedures (SOPs GR009 and GR035), in response to WADA feedback.'},
 program:{formCode:'FO313v01',objectives:L(['Understand the updated requirements in GR035 (WADA Document Implementation SOP).','Use the WADA Trigger List (FO340) and the External Documents Review Checklist (FO287).','Explain the WADA document implementation stages: consultation, planning, implementation and archiving.']),modules:L(['Module 2: Updated SOP GR035 – WADA Document Implementation (Documentation Consultation, Review and Planning, Implementation before Effective Date)'])},
 quiz:{formCode:'TRQ-004',minutes:15,mc:'',tf:'',total:18,preparedBy:YL+' – '+QM,approvedBy:''},q:{mc:18,tf:0},
 att:[['','Dr. Ahmed Mostafa'],['EMP004',0,17,'gr035_eval_amr.pdf'],['EMP006',0,17,'gr035_eval_beniamin.pdf'],['EMP010'],['EMP008',0,16,'gr035_eval_enas.pdf'],['EMP017',0,16,'gr035_eval_waleed.pdf'],['EMP002',0,16,'gr035_eval_abo.pdf']],
 ev:{by:YL,pos:QM,date:'2025-10-28'},au:{date:'2025-10-29',scope:'Use and implement GR035 and related forms'},
 files:{program:['gr009_035_program.pdf','Memorandum, training program and attendance (GR009 & GR035)'],key:['gr035_key.pdf','Quiz answer key (TRQ-004)']},ev0:'GR035',
 notes:'Answer key: see the attached scan (TRQ-004). Same training session as SOP GR009 (TRQ-003).'},
{code:'MS030',date:'2025-11-23',time:'10:00',duration:'1 day',trainer:AK,trainerTitle:TM,
 title:'MS030 v4.1 – Detection and Quantification of Urinary Peptide Hormones hCG and LH by Chemiluminescence Immunoassay (acceptance criteria, IQC, evaluation of results)',
 memo:{formCode:'FO174v01',date:'2025-11-20',from:'Quality Office',to:'Enas Abdallah',topics:L(['Acceptance criteria of test sample results (MS030 v4.1): Decision Limits for hCG and LH, specific gravity correction, interpretation of negative, presumptive positive, ATF and AAF results','Internal Quality Control (IQC) requirements: positive and negative controls (URP1, URP2, BLUR), QC chart monitoring (FO031), handling QC failures (SOP GR007 & GR036)','Evaluation of results: verification of IQC criteria before reporting, step-by-step evaluation of hCG and LH results, documentation in FO024 evaluation forms and FO359 QC charts'])},
 program:{},quiz:{formCode:'TRQ-006',minutes:15,mc:'C,B,B,B,D',tf:'False,True,True,False,True,True,False,True,True,False,True,True,True,True,True,True,True,False',total:23,preparedBy:'Dr. Amr Abd Elhamed Alkorashy',approvedBy:''},q:{mc:5,tf:18},
 att:[['EMP008',0,21,'ms030_eval_enas.pdf']],
 ev:{by:'Dr. Amr Abd Elhamed Alkorashy',pos:TM,date:'2025-11-23'},au:{date:'',scope:'Use and implement MS030 v4.1'},
 files:{program:['ms030_program.pdf','Training memorandum'],key:['ms030_key.pdf','Quiz answer key (TRQ-006)']},ev0:'MS030 v4.1',
 notes:'The handwritten score on the evaluation form is hard to read (appears 21/23): verify against the paper form. The authorization date is blank on the form.'},
{code:'GR013',date:'2026-04-23',time:'10:00',duration:'1 day',trainer:YL,trainerTitle:QM,
 title:'SOP GR013 v04 – Labeling Prepared Reagents and Reference Materials (RMs); Storage Conditions & Verification of Reference Materials',
 memo:{formCode:'FO174v01',date:'2026-04-23',from:YL,to:'Reem Mohamady, Tarek Ali',topics:L(['SOP GR013 v04 – labeling requirements for reagents, RMs and RM stock solutions','Storage conditions and verification of reference materials (Section 4.9)','RM storage deviation handling (Section 4.10)','Traceability and documentation'])},
 program:{formCode:'FO313v01',objectives:L(['Understand SOP GR013 v04 requirements for labeling prepared reagents and Reference Materials (RMs).','Apply proper labeling requirements for reagents, RMs and RM stock solutions.','Verify and document RM storage conditions according to CoA/manufacturer instructions.','Implement RM traceability and inventory documentation requirements.','Handle RM storage deviations in compliance with QA procedures and CAPA requirements.','Maintain compliance with ISO/IEC 17025, WADA TN QCA v1.0 (2025) and internal QA requirements.']),modules:L(['Module 1: Introduction & Background','Module 2: Labeling Requirements','Module 3: Storage Conditions and Verification of Reference Materials (Section 4.9)','Module 4: Handling Undefined Storage Conditions','Module 5: RM Storage Deviation Handling (Section 4.10)'])},
 quiz:{formCode:'TRQ-007',minutes:15,mc:'C,C,C,C,B,C,B,B,B,B,B,C',tf:'True,False,True,False,False,True,False,True,True,True,True,False,True,True,False,False,True,True',total:30,preparedBy:YL,approvedBy:''},q:{mc:12,tf:18},
 att:[['EMP015',0,26,'gr013_eval_reem.pdf'],['EMP016',0,27,'gr013_eval_tarek.pdf']],
 ev:{by:YL,pos:QM,date:'2026-04-25'},au:{date:'2026-04-25',scope:'Use and implement SOP GR013 for RM handling'},
 files:{program:['gr013_program.pdf','Training memorandum and program'],key:['gr013_key.pdf','Quiz answer key (TRQ-007)']},ev0:'GR013 v04'},
{code:'TD2027NA',date:'2026-07-28',time:'10:00',duration:'1 day',trainer:AK,trainerTitle:TM,dept:"GC Lab / Technical Manager's Office",
 title:'ISL TD2027NA – Harmonization of Analysis and Reporting of 19-Norsteroids',
 memo:{formCode:'FO174v01',date:'2026-07-26',from:AK+' – '+TM,to:'GC lab staff',background:'ISL TD2027NA (Version 1.1, approved 07 April 2026, nominal effective date 01 January 2027) revises the analytical and reporting requirements for 19-norsteroids, including a new SPC requirement of 150% MRL (22.5 ng/mL) in the GC-MSn Confirmation Procedure. Per WADA/Lab EAG feedback on CAR mNC04_2026 it must be implemented immediately rather than on the nominal effective date.',topics:L(['Initial Testing Procedure (ITP) requirements: LOD, SPC, NQC, PQC and ISTD criteria','GC-MSn Confirmation Procedure (CP) requirements, including the revised SPC at 150% MRL','Table 1 decision criteria for when GC/C/IRMS analysis is not needed, required, or optional','Specific gravity (SG) adjustment rules and GC/C/IRMS interpretation (Δδ13C criteria)','Interpretation and reporting of results (AAF / ATF / Negative) across the three athlete scenarios in Table 2'])},
 program:{formCode:'FO313v01',objectives:L(['Understand the two-step 19-norsteroid analysis procedure: Initial Testing Procedure (ITP) and Confirmation Procedure (CP).','Apply the revised GC-MSn CP requirements per Article 3.2.1.1(c), including the SPC at 150% MRL (22.5 ng/mL) and PQC at 100% MRL (15 ng/mL).','Use Table 1 to determine whether GC/C/IRMS analysis is not needed, required, or optional.','Apply specific gravity (SG) adjustment rules and interpret GC/C/IRMS Δδ13C criteria.','Classify and report results as AAF, ATF, or Negative Finding per Table 2.']),modules:L(['Module 1: Introduction & Regulatory Context','Module 2: Initial Testing Procedure (ITP) Requirements','Module 3: GC-MSn Confirmation Procedure (CP) & Table 1','Module 4: SG Adjustment & GC/C/IRMS Interpretation','Module 5: Interpretation & Reporting (Table 2)'])},
 quiz:{formCode:'TRQ-008',minutes:15,mc:'B,C,B,C,B',tf:'False,True,True,True,False,True,False,True,True,False',total:15,preparedBy:AK+' – '+TM,approvedBy:DIR},q:{mc:5,tf:10},
 att:[['EMP007',0,13,'td2027_eval_eman.pdf'],['EMP014',0,13,'td2027_eval_rasha.pdf'],['EMP016',0,13,'td2027_eval_tarek.pdf'],['EMP002',0,12,'td2027_eval_abo.pdf']],
 ev:{by:AK,pos:TM,date:'2026-07-28'},au:{date:'2026-07-28',scope:'Use and implement ISL TD2027NA'},
 files:{program:['td2027_program.pdf','Training memorandum and program'],key:['td2027_key.pdf','Quiz answer key (TRQ-008)']},ev0:'ISL TD2027NA'}
];
const emp=id=>(D.Employees||[]).find(e=>e.StaffID===id)||{};
const pkgOf=sp=>(D.TrainPkgs||[]).find(p=>String(p.code).toUpperCase()===sp.code.toUpperCase()&&p.date===sp.date);
const nextPkgId=()=>'TP-'+String(Math.max(0,...(D.TrainPkgs||[]).map(r=>+String(r.id).replace(/\D/g,'')||0))+1).padStart(4,'0');
const mkPkg=sp=>({code:sp.code,title:sp.title,date:sp.date,time:sp.time||'',duration:sp.duration||'',type:'Internal',dept:sp.dept||'EDCL',trainer:sp.trainer,trainerTitle:sp.trainerTitle,
 memo:Object.assign({formCode:'',date:'',from:'',to:'',background:'',topics:''},sp.memo),program:Object.assign({formCode:'',objectives:'',modules:''},sp.program),quiz:sp.quiz,evalForm:'FO127v01',
 trainees:sp.att.map(([id,nm,sc])=>{const e=emp(id),has=sc!=null;return{staffId:id||'',name:id?(e.FullName||id):nm,position:id?(e.JobTitle||''):'',score:has?sc:'',max:sp.quiz.total,evalDate:has?sp.ev.date:'',evaluator:has?sp.ev.by:'',evalPos:has?sp.ev.pos:'',authorized:has,authBy:has?DIR:'',authDate:has?sp.au.date:'',authScope:has?sp.au.scope:''}}),
 notes:NOTE+(sp.notes?' '+sp.notes:'')});
const TRQ_META=sp=>({id:sp.quiz.formCode,title:sp.title,code:sp.code,date:sp.date,mc:sp.q.mc,tf:sp.q.tf,total:sp.quiz.total,minutes:sp.quiz.minutes,preparedBy:sp.quiz.preparedBy,approvedBy:sp.quiz.approvedBy,status:'In force',notes:''});
const fileList=(sp,pid)=>{const a=[[sp.files.program[0],sp.code+' – '+sp.files.program[1]],[sp.files.key[0],sp.code+' – '+sp.files.key[1]]];
 sp.att.forEach(([id,,sc,f])=>{if(f&&sc!=null)a.push([f,`${sp.code} – Training evaluation – ${emp(id).FullName||id}`])});return a};
const ensure=()=>{D.TrainPkgs=D.TrainPkgs||[];D.TRQ=D.TRQ||[]};
const plan=async()=>{ensure();const have=(await tx('readonly',s=>s.getAll()))||[];let pk=0,fl=0,tq=0;
 for(const sp of SPEC){const p=pkgOf(sp);if(!p)pk++;const cat=p?'trpkg:'+p.id:null;
  for(const[f,t]of fileList(sp))if(!cat||!have.some(x=>x.cat===cat&&x.name===t+'.pdf'))fl++;
  if(!D.TRQ.some(x=>x.id===sp.quiz.formCode))tq++}
 return{pk,fl,tq}};
const run=async()=>{ensure();let pk=0,fl=0,tq=0;const have=(await tx('readonly',s=>s.getAll()))||[],cache={};
 for(const sp of SPEC){let p=pkgOf(sp);
  if(!p){p=mkPkg(sp);p.id=nextPkgId();p.createdBy=(U&&U.username)||'import';p.createdAt=now().slice(0,16);D.TrainPkgs.push(p);audit('Create','TrainPkgs',p.id,sp.code+' – imported from scanned record');pk++}
  for(const[f,t]of fileList(sp)){const name=t+'.pdf';if(have.some(x=>x.cat==='trpkg:'+p.id&&x.name===name))continue;
   try{const blob=cache[f]||(cache[f]=await (await fetch(BASE+f)).blob());
    await tx('readwrite',s=>s.add({cat:'trpkg:'+p.id,name,code:t,type:'application/pdf',size:blob.size,date:sp.date+' 00:00',blob}));fl++}
   catch(x){console.error('trq-register file',f,x)}}
  if(!D.TRQ.some(x=>x.id===sp.quiz.formCode)){const m=TRQ_META(sp);m.pkgId=p.id;m.createdBy=(U&&U.username)||'import';m.createdAt=now().slice(0,16);D.TRQ.push(m);audit('Create','TRQ',m.id,sp.code);tq++}}
 await save();return{pk,fl,tq}};
/* ---------- Quiz Register tab ---------- */
const css=`<style id="trqcss">.trqs{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:0 0 14px}.trqs>div{background:#fff;border:1px solid var(--b);border-radius:14px;padding:12px 14px;box-shadow:var(--sh)}.trqs small{display:block;color:var(--m);font-size:12px}.trqs b{font:600 17px 'Outfit',sans-serif}.trqf{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.trqf label{display:flex;flex-direction:column;font-size:13px;gap:3px}.trqf .w{grid-column:1/-1}.trqd{color:#b4690e}</style>`;
const num=s=>{const m=String(s||'').match(/(\d+)/);return m?+m[1]:NaN};
const fmt=n=>'TRQ-'+String(n).padStart(3,'0');
const norm=s=>{const n=num(s);return isNaN(n)?'':fmt(n)};
const detected=()=>{const have=new Set(D.TRQ.map(x=>x.id)),out=[];
 (D.TrainPkgs||[]).forEach(p=>{const c=norm(p.quiz&&p.quiz.formCode);if(c&&!have.has(c)&&!out.some(o=>o.id===c))out.push({id:c,title:p.title,code:p.code,date:p.date,pkgId:p.id,mc:'',tf:'',total:p.quiz.total||'',minutes:p.quiz.minutes||'',preparedBy:p.quiz.preparedBy||'',approvedBy:p.quiz.approvedBy||'',status:'Not registered',_det:1})});return out};
const rowsAll=()=>[...D.TRQ,...detected()].sort((a,b)=>num(a.id)-num(b.id));
const open=pid=>{if(window.trpkgOpen)trpkgOpen(pid)};
const pkgSel=v=>`<option value="">— none —</option>`+(D.TrainPkgs||[]).map(p=>`<option value="${eh(p.id)}"${p.id===v?' selected':''}>${eh(p.id+' – '+p.code+' · '+p.date)}</option>`).join('');
const render=async()=>{ensure();if(!document.getElementById('trqcss'))document.head.insertAdjacentHTML('beforeend',css);
 const rows=rowsAll(),nums=rows.map(r=>num(r.id)).filter(n=>!isNaN(n)),mx=nums.length?Math.max(...nums):0,mn=nums.length?Math.min(...nums):1;
 const gaps=[];for(let n=mn;n<=mx;n++)if(!nums.includes(n))gaps.push(fmt(n));
 const box=document.createElement('div'),pend=manage()?await plan():{pk:0,fl:0,tq:0},todo=pend.pk+pend.fl+pend.tq;
 box.innerHTML=`<div class="trqs"><div><small>Registered TRQ numbers</small><b>${D.TRQ.length}</b></div><div><small>Highest number</small><b>${mx?fmt(mx):'—'}</b></div><div><small>Next free number</small><b>${fmt(mx+1)}</b></div><div><small>Unassigned numbers in range</small><b>${gaps.length?eh(gaps.join(', ')):'none'}</b></div></div>
 ${manage()?`<div class="bar"><button class="btn" id="trqn">➕ Register TRQ</button>${todo?`<button class="btn s" id="trqi">⬇ Fill from scanned training records (${pend.pk} packages, ${pend.fl} files, ${pend.tq} TRQ)</button>`:''}</div>`:''}<div id="trqg"></div>`;
 page('Quiz Register (TRQ)','Index of training quiz forms: register the TRQ number, link it to the training record file and keep the sequence under control',box);
 const g=box.querySelector('#trqg');
 if(rows.length)g.appendChild(grid([['TRQ no.',r=>r.id],['Quiz / training',r=>r.title],['SOP / method',r=>r.code],['Training date',r=>r.date],['Questions',r=>r.mc!==''||r.tf!==''?`${+r.mc||0} MC + ${+r.tf||0} T/F`:'—'],['Points',r=>r.total||'—'],['Prepared by',r=>r.preparedBy],['Record file',r=>r.pkgId||'—'],['Status',r=>r.status]],rows,r=>view(r),[['Status',r=>r.status],['SOP / method',r=>r.code]]));
 else g.innerHTML='<div class="card"><p class="sub">No TRQ numbers registered yet.</p></div>';
 const n=box.querySelector('#trqn');if(n)n.onclick=()=>form(null,{id:fmt(mx+1),status:'In force'});
 const i=box.querySelector('#trqi');if(i)i.onclick=async()=>{if(!confirm(`Add ${pend.pk} training record files (packages), ${pend.fl} scanned PDFs and ${pend.tq} TRQ numbers from the scanned records?\n\nNothing existing is changed or deleted.`))return;
  try{const r=await run();alert(`Done: ${r.pk} packages, ${r.fl} files, ${r.tq} TRQ numbers added.`);render()}catch(e){alert('Import stopped: '+e.message)}}};
const view=r=>{const m=modal(`<h2>${eh(r.id)} – ${eh(r.title||'')}</h2><div class="sub">${eh(r.code||'')} · ${eh(r.date||'')} · <span class="${r._det?'trqd':''}">${eh(r.status||'')}</span></div>
 <div class="card">${[['Questions',(+r.mc||0)+' multiple choice + '+(+r.tf||0)+' true/false'],['Total points',r.total],['Time (min)',r.minutes],['Prepared by',r.preparedBy],['Approved by',r.approvedBy],['Training record file',r.pkgId],['Notes',r.notes]].map(([k,v])=>`<p><b>${k}:</b> ${eh(v||'—')}</p>`).join('')}</div>
 <div class="bar">${r.pkgId&&window.trpkgOpen?'<button class="btn" id="tqo">📦 Open training record file</button>':''}${manage()?(r._det?'<button class="btn" id="tqr">Register this TRQ</button>':'<button class="btn s" id="tqe">✎ Edit</button><button class="btn s" id="tqd">🗑 Delete</button>'):''}</div>`);
 const b=s=>m.querySelector(s);
 if(b('#tqo'))b('#tqo').onclick=()=>{m.remove();open(r.pkgId)};
 if(b('#tqe'))b('#tqe').onclick=()=>{m.remove();form(r.id,r)};
 if(b('#tqr'))b('#tqr').onclick=()=>{m.remove();const c=Object.assign({},r);delete c._det;c.status='In force';form(null,c)};
 if(b('#tqd'))b('#tqd').onclick=async()=>{if(!confirm('Delete '+r.id+' from the register? (the training record file is not deleted)'))return;D.TRQ=D.TRQ.filter(x=>x.id!==r.id);audit('Delete','TRQ',r.id,r.code||'');await save();m.remove();render()}};
const form=(id,d)=>{d=Object.assign({status:'In force'},d);const isNew=!id;
 const f=(k,label,type='text',w='')=>`<label class="${w}">${label}<input id="q_${k}" type="${type}" value="${eh(d[k]??'')}"></label>`;
 const m=modal(`<h2>${isNew?'Register TRQ':'Edit '+eh(id)}</h2><div class="trqf">${f('id','TRQ number (e.g. TRQ-009)')}${f('title','Quiz / training title','text','w')}${f('code','SOP / method code')}${f('date','Training date','date')}
 <label>Linked training record file<select id="q_pkgId">${pkgSel(d.pkgId)}</select></label>${f('mc','Multiple-choice questions','number')}${f('tf','True/false questions','number')}${f('total','Total points','number')}${f('minutes','Time (minutes)','number')}${f('preparedBy','Prepared by')}${f('approvedBy','Approved by')}
 <label>Status<select id="q_status">${['In force','Draft','Superseded','Obsolete'].map(s=>`<option${s===d.status?' selected':''}>${s}</option>`).join('')}</select></label><label class="w">Notes<textarea id="q_notes" rows="3">${eh(d.notes||'')}</textarea></label></div>
 <p class="tperr" id="q_err"></p><div class="bar"><button class="btn" id="q_ok">Save</button></div>`);
 const v=k=>m.querySelector('#q_'+k).value.trim();
 m.querySelector('#q_ok').onclick=async()=>{const nid_=norm(v('id')),err=m.querySelector('#q_err');
  if(!nid_){err.textContent='Enter the TRQ number, for example TRQ-009.';return}
  if(!v('title')){err.textContent='Enter the quiz / training title.';return}
  if(D.TRQ.some(x=>x.id===nid_&&x.id!==id)){err.textContent=nid_+' is already registered.';return}
  const rec={id:nid_,title:v('title'),code:v('code'),date:v('date'),pkgId:v('pkgId'),mc:v('mc'),tf:v('tf'),total:v('total'),minutes:v('minutes'),preparedBy:v('preparedBy'),approvedBy:v('approvedBy'),status:v('status'),notes:v('notes')};
  if(isNew){rec.createdBy=U.username;rec.createdAt=now().slice(0,16);D.TRQ.push(rec);audit('Create','TRQ',rec.id,rec.code)}
  else{const i=D.TRQ.findIndex(x=>x.id===id),o=D.TRQ[i];Object.assign(o,rec,{updatedBy:U.username,updatedAt:now().slice(0,16)});audit('Edit','TRQ',rec.id,rec.code)}
  await save();m.remove();render()}};
if(!NAV.some(n=>n[0]==='trq')){let at=NAV.findIndex(n=>n[0]==='trpkg');if(at<0)at=NAV.findIndex(n=>n[0]==='train');NAV.splice(at+1,0,['trq','🧾 Quiz Register (TRQ)'])}
if(typeof NAVIC!=='undefined')NAVIC.trq='clip';
R.trq=()=>{render().catch(e=>{console.error('trq',e)})};
/* offer the import once per session after the dashboard opens */
let asked=0;const _d=R.dash;
R.dash=()=>{_d();setTimeout(async()=>{try{if(asked||sessionStorage.getItem('edclTrqAsked')||typeof can!=='function'||!can())return;
 const p=await plan();if(!(p.pk+p.fl+p.tq))return;asked=1;sessionStorage.setItem('edclTrqAsked','1');
 if(!confirm(`Fill the "Training Record Files" tab and the new Quiz Register from the scanned records?\n\n• ${p.pk} training record files (packages)\n• ${p.fl} scanned PDFs\n• ${p.tq} TRQ numbers\n\nNothing existing is changed or deleted. Continue?`))return;
 const r=await run();alert(`Done: ${r.pk} packages, ${r.fl} files, ${r.tq} TRQ numbers added.`)}catch(e){console.error('trq-register',e)}},1000)};
})();
