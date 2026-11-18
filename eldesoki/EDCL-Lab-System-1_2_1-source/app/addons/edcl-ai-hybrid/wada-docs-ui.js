/* EDCL WADA Documents - live view (add-on v2.0)
   Adds to Document Library > WADA Documents: the official documents synchronised from wada-ama.org, each with its CURRENT and
   PREVIOUS version, the full version history, open / download of every stored version and a text comparison of two versions.
   Files added by hand stay below, unchanged. Desktop application only (the archive is kept by the main process). */
(function(){
'use strict';
/* ================= pure comparison core (unit-tested in Node) ================= */
const norm=s=>String(s||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const segments=(pages,max=700)=>{const out=[];
  (pages||[]).forEach((p,i)=>{const s=String(p||'').replace(/\s+/g,' ').trim();if(!s)return;
    for(let x of s.split(/(?<=[.;:!?])\s+(?=[A-Z0-9(\[“"•])/)){while(x.length>max*1.5){out.push({page:i+1,text:x.slice(0,max)});x=x.slice(max)}const n=norm(x);if(n&&!/^\d+$/.test(n))out.push({page:i+1,text:x})}});
  for(const g of out)g.norm=norm(g.text);
  // running headers / footers repeat on many pages: they are not content
  if(pages&&pages.length>=6){const pg=new Map();for(const g of out){let st=pg.get(g.norm);if(!st)pg.set(g.norm,st=new Set());st.add(g.page)}
    const lim=Math.max(3,Math.ceil(pages.length*.3));return out.filter(g=>pg.get(g.norm).size<lim)}
  return out};
const toks=s=>String(s||'').match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)*|[^\s\p{L}\p{N}]/gu)||[];
const lcsOps=(A,B,eq)=>{ // returns ops [{t:'same'|'del'|'add',a?,b?}]
  let s=0;while(s<A.length&&s<B.length&&eq(A[s],B[s]))s++;let ea=A.length,eb=B.length;while(ea>s&&eb>s&&eq(A[ea-1],B[eb-1])){ea--;eb--}
  const n=ea-s,m=eb-s,ops=[];for(let i=0;i<s;i++)ops.push({t:'same',a:i,b:i});
  if(n*m>16e6){const set=new Set(B.slice(s,eb).map(x=>x.norm)),sa=new Set(A.slice(s,ea).map(x=>x.norm));for(let i=s;i<ea;i++)if(!set.has(A[i].norm))ops.push({t:'del',a:i});for(let j=s;j<eb;j++)if(!sa.has(B[j].norm))ops.push({t:'add',b:j})}
  else{const W=m+1,T=new Uint16Array((n+1)*W);
    for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)T[i*W+j]=eq(A[s+i],B[s+j])?T[(i+1)*W+j+1]+1:Math.max(T[(i+1)*W+j],T[i*W+j+1]);
    let i=0,j=0;while(i<n&&j<m){if(eq(A[s+i],B[s+j])){ops.push({t:'same',a:s+i,b:s+j});i++;j++}else if(T[(i+1)*W+j]>=T[i*W+j+1]){ops.push({t:'del',a:s+i});i++}else{ops.push({t:'add',b:s+j});j++}}
    while(i<n){ops.push({t:'del',a:s+i});i++}while(j<m){ops.push({t:'add',b:s+j});j++}}
  for(let k=0;k<A.length-ea;k++)ops.push({t:'same',a:ea+k,b:eb+k});return ops};
const wordDiff=(a,b)=>{const A=toks(a).map(x=>({norm:x})),B=toks(b).map(x=>({norm:x}));if(A.length*B.length>160000)return null;
  return lcsOps(A,B,(x,y)=>x.norm===y.norm).map(o=>o.t==='same'?{t:'same',w:A[o.a].norm}:o.t==='del'?{t:'del',w:A[o.a].norm}:{t:'add',w:B[o.b].norm})};
const sim=(a,b)=>{const A=new Set(norm(a).split(' ')),B=new Set(norm(b).split(' '));let i=0;for(const x of A)if(B.has(x))i++;const u=A.size+B.size-i;return u?i/u:1};
// compare(previousPages, currentPages) -> {stats, changes:[{kind:'mod'|'del'|'add', oldText,newText,oldPage,newPage, words?}]}
const compare=(prevPages,curPages)=>{const A=segments(prevPages),B=segments(curPages),ops=lcsOps(A,B,(x,y)=>x.norm===y.norm),changes=[];let same=0;
  for(let k=0;k<ops.length;){if(ops[k].t==='same'){same++;k++;continue}
    const dels=[],adds=[];while(k<ops.length&&ops[k].t!=='same'){(ops[k].t==='del'?dels:adds).push(ops[k]);k++}
    const used=new Set();
    for(const d of dels){let best=-1,bs=0;adds.forEach((a,ix)=>{if(used.has(ix))return;const s=sim(A[d.a].text,B[a.b].text);if(s>bs){bs=s;best=ix}});
      if(best>=0&&bs>=.5){used.add(best);const a=adds[best];changes.push({kind:'mod',oldText:A[d.a].text,newText:B[a.b].text,oldPage:A[d.a].page,newPage:B[a.b].page,words:wordDiff(A[d.a].text,B[a.b].text),at:Math.min(d.a,a.b)})}
      else changes.push({kind:'del',oldText:A[d.a].text,oldPage:A[d.a].page,at:d.a})}
    adds.forEach((a,ix)=>{if(!used.has(ix))changes.push({kind:'add',newText:B[a.b].text,newPage:B[a.b].page,at:a.b})})}
  changes.sort((x,y)=>(x.newPage||x.oldPage)-(y.newPage||y.oldPage)||x.at-y.at);
  const nm=changes.filter(c=>c.kind==='mod').length,nd=changes.filter(c=>c.kind==='del').length,na=changes.filter(c=>c.kind==='add').length;
  return{stats:{previousPages:(prevPages||[]).length,currentPages:(curPages||[]).length,previousPassages:A.length,currentPassages:B.length,unchanged:same,modified:nm,removed:nd,added:na,changedPct:A.length+B.length?Math.round(1000*((nm*2+nd+na)/(A.length+B.length)))/10:0},changes}};
const core={norm,segments,compare,wordDiff,sim};
if(typeof document==='undefined'){if(typeof module!=='undefined')module.exports=core;return}
if(window.EDCL_WADA_DOCS_UI)return;window.EDCL_WADA_DOCS_UI=1;window.EDCL_DOC_COMPARE=core;

/* ================= interface ================= */
const WDX=()=>window.edclAI&&edclAI.wada&&window.edclDesktop&&edclDesktop.wada;
const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const host=n=>{try{return(0,eval)(n)}catch(e){return undefined}};
const isAdm=()=>{try{return host('typeof isA')==='function'&&host('isA')()}catch(e){return false}};
// the add-on never writes to the EDCL Audit Trail; its own actions are recorded in the add-on's local access log
const audit=(a,k,d)=>{try{window.EDCL_AIH&&window.EDCL_AIH.log&&window.EDCL_AIH.log({via:'wada-documents',tool:a,table:String(k).slice(0,80),columns:[],filters:[String(d||'').slice(0,120)],rows:0})}catch(e){}};
const fmtDate=t=>t?E(String(t).replace('T',' ').slice(0,16)):'-';
const fmtSize=n=>n>1e6?(n/1e6).toFixed(1)+' MB':Math.ceil((n||0)/1e3)+' KB';
const css=`.wdp .tag{display:inline-block;font-size:11px;border-radius:6px;padding:1px 7px;margin-right:4px}.wdp .cur{background:#dcf5e7;color:#0a6b3d}.wdp .prv{background:#fff0d6;color:#8a5a00}.wdp .old{background:#eceff1;color:#546e7a}.wdp .new{background:#ffe1e1;color:#a11}
.wdp td{vertical-align:top}.wdp .vh td{background:#f6faf8;font-size:12px}.wdp .sha{font-family:monospace;font-size:11px;color:#5d6f68}.wdp .mut{color:#5d6f68;font-size:12px}
.wdc{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:3vh 2vw;overflow:auto}.wdc>div{background:#fff;border-radius:14px;max-width:1100px;width:100%;padding:18px 20px}
.wdc .ch{border:1px solid #dfe8e4;border-radius:10px;margin:8px 0;padding:8px 10px;font-size:13px;line-height:1.5}.wdc .ch b{font-size:11px;color:#5d6f68}.wdc del{background:#ffd9d9;text-decoration:line-through}.wdc ins{background:#c9f2d6;text-decoration:none}.wdc .rm{background:#fff3f3}.wdc .ad{background:#f2fbf5}`;
let FILTER={q:'',type:'',prevOnly:false,recent:false},LAST=null,OPEN=new Set(),BUSY=false;
const openFile=async(fileId)=>{const r=await edclAI.wada.read(fileId),isPdf=/\.pdf$/i.test(r.name),blob=new Blob([r.bytes],{type:isPdf?'application/pdf':'application/octet-stream'});
  if(isPdf)window.open(URL.createObjectURL(blob));else{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=r.name;a.click()}audit('Open',r.name,'sha256='+r.sha256.slice(0,16))};
const loadJs=src=>new Promise((ok,no)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=()=>no(new Error('cannot load '+src));document.head.appendChild(s)});
const readPages=async fileId=>{const r=await edclAI.wada.read(fileId);if(!/\.pdf$/i.test(r.name))throw new Error('Only PDF documents can be compared');
  if(!window.pdfjsLib)await loadJs('vendor/pdf.min.js');pdfjsLib.GlobalWorkerOptions.workerSrc='vendor/pdf.worker.min.js';
  const pdf=await pdfjsLib.getDocument({data:r.bytes.slice()}).promise,pages=[];
  for(let i=1;i<=pdf.numPages;i++){const pg=await pdf.getPage(i),tc=await pg.getTextContent();let s='',y=null;for(const it of tc.items){if(y!==null&&Math.abs(it.transform[5]-y)>2)s+=' ';s+=it.str+(it.hasEOL?' ':'');y=it.transform[5]}pages.push(s)}
  return pages};
const wordsHtml=w=>w?w.map(x=>x.t==='same'?E(x.w):x.t==='del'?'<del>'+E(x.w)+'</del>':'<ins>'+E(x.w)+'</ins>').join(' '):null;
const verName=v=>E((v.year?v.year+' · ':'')+(v.published||'')||'')+(v.fetchedAt?' <span class="mut">(stored '+fmtDate(v.fetchedAt)+')</span>':'');
const compareView=async(g,a,b)=>{ // a = older, b = newer
  const m=document.createElement('div');m.className='wdc';m.innerHTML=`<div><div style="display:flex;justify-content:space-between;gap:10px"><h2 style="margin:0">Compare versions - ${E(g.label)}</h2><button class="btn s" id="wdx">Close</button></div><div class="mut" style="margin:6px 0">PREVIOUS: ${verName(a)} · ${E(a.sourceUrl.split('/').pop())}<br>CURRENT: ${verName(b)} · ${E(b.sourceUrl.split('/').pop())}</div><div id="wdr">Reading both documents…</div></div>`;
  document.body.appendChild(m);m.querySelector('#wdx').onclick=()=>m.remove();m.onclick=e=>{if(e.target===m)m.remove()};
  const out=m.querySelector('#wdr');
  try{const[pa,pb]=await Promise.all([readPages(a.fileId),readPages(b.fileId)]);
    if(pa.join('').length<200||pb.join('').length<200)throw new Error('One of the documents has no selectable text (scanned PDF) - open both and compare by eye.');
    const r=compare(pa,pb),s=r.stats;let shown=100;
    const draw=()=>{out.innerHTML=`<div class="card" style="margin:8px 0"><b>${s.modified+s.removed+s.added} change(s)</b> · ${s.modified} reworded · ${s.removed} removed · ${s.added} added · ${s.unchanged} unchanged passages · about <b>${s.changedPct}%</b> of the text differs · pages ${s.previousPages} → ${s.currentPages}<div class="mut">Text comparison made on this PC from the two stored official files. Tables, figures and layout are not compared - always read the official document for the final decision.</div><div style="margin-top:6px"><button class="btn s sm" id="wdpdf">Save comparison as PDF</button></div></div>`+
      (r.changes.length?r.changes.slice(0,shown).map(c=>c.kind==='mod'?`<div class="ch"><b>REWORDED · previous p.${c.oldPage} → current p.${c.newPage}</b><br>${wordsHtml(c.words)||'<del>'+E(c.oldText)+'</del><br><ins>'+E(c.newText)+'</ins>'}</div>`:c.kind==='del'?`<div class="ch rm"><b>REMOVED · previous p.${c.oldPage}</b><br><del>${E(c.oldText)}</del></div>`:`<div class="ch ad"><b>ADDED · current p.${c.newPage}</b><br><ins>${E(c.newText)}</ins></div>`).join('')+(r.changes.length>shown?`<button class="btn s" id="wdmore">Show more (${r.changes.length-shown} left)</button>`:''):'<div class="card">No difference in the text of the two documents.</div>');
      const mo=out.querySelector('#wdmore');if(mo)mo.onclick=()=>{shown+=200;draw()};
      out.querySelector('#wdpdf').onclick=async()=>{const body=r.changes.map(c=>c.kind==='mod'?`<p><b>REWORDED (prev p.${c.oldPage} → cur p.${c.newPage})</b><br>${wordsHtml(c.words)||E(c.newText)}</p>`:c.kind==='del'?`<p><b>REMOVED (prev p.${c.oldPage})</b><br><del>${E(c.oldText)}</del></p>`:`<p><b>ADDED (cur p.${c.newPage})</b><br><ins>${E(c.newText)}</ins></p>`).join('');
        const html=`<html><head><meta charset="utf-8"><style>body{font:12px Arial}del{background:#ffd9d9}ins{background:#c9f2d6;text-decoration:none}</style></head><body><h2>${E(g.label)} - comparison of versions</h2><p>Previous: ${E(a.sourceUrl)}<br>sha256 ${a.sha256}<br>Current: ${E(b.sourceUrl)}<br>sha256 ${b.sha256}<br>${s.modified} reworded, ${s.removed} removed, ${s.added} added (${s.changedPct}% of text)</p>${body}<p><i>Automatic text comparison; not an official WADA document.</i></p></body></html>`;
        try{await edclDesktop.savePdf(html,'WADA-compare-'+g.key+'.pdf');audit('Compare',g.label,s.modified+s.removed+s.added+' changes; PDF saved')}catch(e){alert('Could not save: '+e.message)}};};
    draw();audit('Compare',g.label,`${s.modified+s.removed+s.added} changes`)}
  catch(e){out.innerHTML='<div class="card" style="color:#a11">'+E(e.message)+'</div>'}};

const panel=async()=>{const v=document.querySelector('#v');if(!v||!WDX())return;const tabs=v.querySelector('.tabs');if(!tabs)return;
  let host_=v.querySelector('#wdp');if(!host_){host_=document.createElement('div');host_.id='wdp';host_.className='wdp';tabs.insertAdjacentElement('afterend',host_)}
  host_.innerHTML=`<style>${css}</style><div class="card">Loading the WADA document archive…</div>`;
  let L;try{L=await edclAI.wada.list()}catch(e){host_.innerHTML='<div class="card">WADA document archive unavailable: '+E(e.message)+'</div>';return}LAST=L;draw(host_)};
const draw=host_=>{const L=LAST,T=L.totals,adm=isAdm(),types=[...new Set(L.groups.map(g=>g.type))].sort();
  const rows=L.groups.filter(g=>(!FILTER.type||g.type===FILTER.type)&&(!FILTER.prevOnly||g.previous)&&(!FILTER.recent||g.recentChange)&&(!FILTER.q||(g.label+' '+g.title+' '+g.key).toLowerCase().includes(FILTER.q.toLowerCase())));
  const cell=(g,v)=>!v?'<span class="mut">none yet</span>':`${v.year?'<b>'+v.year+'</b> ':''}${v.published?E(v.published)+' ':''}${v.status?'<span class="tag old">'+E(v.status)+'</span>':''}<br>${v.archived?'<span class="mut">stored '+fmtDate(v.fetchedAt)+' · '+fmtSize(v.size)+'</span>':'<span class="mut">listed on WADA - not downloaded yet</span>'}`;
  const vrows=g=>g.versions.map(v=>`<tr class="vh"><td colspan="2"><span class="tag ${v.role==='current'?'cur':v.role==='previous'?'prv':'old'}">${v.role}</span> ${E(v.title)}</td><td>${verName(v)}<br><span class="mut" style="word-break:break-all">${E(v.sourceUrl)}</span></td><td class="sha">${v.sha256?'SHA-256 '+E(v.sha256.slice(0,20))+'…':''}</td><td>${v.archived?`<button class="btn s sm" data-wo="${v.fileId}">Open</button>`:''}</td></tr>`).join('');
  host_.innerHTML=`<style>${css}</style><div class="card"><h3 style="margin-top:0">Official WADA documents · synchronised with wada-ama.org</h3>
  <div class="mut" style="margin-bottom:8px">${T.documents} document line(s) · ${T.files} stored file(s) (${fmtSize(T.bytes)}) · last file check ${fmtDate(T.lastChecked)}${T.failed?` · <span style="color:#a11">${T.failed} file(s) could not be fetched - see WADA Updates → Sync History</span>`:''}. Every version ever downloaded is kept; a new edition never overwrites the old one.</div>
  <div class="bar"><button class="btn" id="wdc"${BUSY?' disabled':''}>↻ Check WADA &amp; update documents</button><button class="btn s" id="wdf"${BUSY?' disabled':''} title="Download the files that are still missing (a limited number per run)">Download missing files</button>${adm?`<button class="btn s" id="wda"${BUSY?' disabled':''} title="Ask WADA again for every stored file">Re-check all files</button><button class="btn s" id="wds">⚙ Archive settings</button>`:''}<span class="mut" id="wdm"></span></div>
  <div class="bar"><input id="wdq" placeholder="Search TD, TL, ISL, Prohibited List…" value="${E(FILTER.q)}" style="min-width:240px"><select id="wdt"><option value="">All types</option>${types.map(t=>`<option${t===FILTER.type?' selected':''}>${E(t)}</option>`).join('')}</select><label><input type="checkbox" id="wdp1"${FILTER.prevOnly?' checked':''}> has a previous version</label><label><input type="checkbox" id="wdr1"${FILTER.recent?' checked':''}> changed in the last 30 days</label></div></div>
  ${rows.length?`<div class="tw"><table><thead><tr><th>Document</th><th>Type</th><th>CURRENT version</th><th>PREVIOUS version</th><th></th></tr></thead><tbody>${rows.map(g=>`<tr><td><b>${E(g.label)}</b>${g.recentChange?' <span class="tag new">new version</span>':''}<br><span class="mut">${E(g.title)}</span></td><td>${E(g.type)}</td><td>${cell(g,g.current)}</td><td>${cell(g,g.previous)}</td><td style="min-width:210px;max-width:260px">${g.current&&g.current.archived?`<button class="btn s sm" data-wo="${g.current.fileId}">Open current</button> `:''}${g.previous&&g.previous.archived?`<button class="btn s sm" data-wo="${g.previous.fileId}">Open previous</button> `:''}${g.current&&g.previous&&g.current.archived&&g.previous.archived?`<button class="btn sm" data-wc="${E(g.key)}">Compare</button> `:''}<button class="btn s sm" data-wv="${E(g.key)}">${OPEN.has(g.key)?'Hide':'All'} versions (${g.versions.length})</button></td></tr>${OPEN.has(g.key)?vrows(g):''}`).join('')}</tbody></table></div>`:'<div class="card">'+(T.documents?'No document matches the filters.':'No official document archived yet. Press “Check WADA &amp; update documents” (internet connection needed).')+'</div>'}
  <h3 style="color:var(--n);margin-top:18px">Files added by the laboratory</h3>`;
  const msg=t=>{const m=host_.querySelector('#wdm');if(m)m.innerHTML=t};
  const run=async(label,fn)=>{BUSY=true;draw(host_);msg(label);try{await fn()}catch(e){BUSY=false;draw(host_);msg('<span style="color:#a11">'+E(e.message)+'</span>')}};
  host_.querySelector('#wdc').onclick=()=>run('Checking WADA…',async()=>{const r=await edclDesktop.wada.check();const s=await edclAI.wada.sync({});audit('Sync','WADA Documents',`check=${r.status}; new files=${s.newFiles}; changed=${s.changedFiles}; failed=${s.failed}`);
    LAST=await edclAI.wada.list();BUSY=false;draw(host_);msg(`${r.status==='failed'?'<span style="color:#a11">WADA check failed (see Sync History). </span>':''}${s.newFiles} new file(s), ${s.changedFiles} new version(s)${s.deferred?', '+s.deferred+' more waiting for the next run':''}${s.failed?', '+s.failed+' failed':''}.`)});
  host_.querySelector('#wdf').onclick=()=>run('Downloading…',async()=>{const s=await edclAI.wada.sync({});audit('Sync','WADA Documents',`manual download; new files=${s.newFiles}; changed=${s.changedFiles}; failed=${s.failed}`);LAST=await edclAI.wada.list();BUSY=false;draw(host_);msg(`${s.newFiles} new file(s), ${s.changedFiles} new version(s)${s.deferred?', '+s.deferred+' more - press again':''}${s.failed?', '+s.failed+' failed (see error log)':''}.`)});
  if(host_.querySelector('#wda'))host_.querySelector('#wda').onclick=()=>run('Re-checking every file…',async()=>{const s=await edclAI.wada.sync({force:true});audit('Sync','WADA Documents',`full re-check; new=${s.newFiles}; changed=${s.changedFiles}; failed=${s.failed}`);LAST=await edclAI.wada.list();BUSY=false;draw(host_);msg(`${s.newFiles} new, ${s.changedFiles} new version(s), ${s.unchanged} unchanged${s.deferred?', '+s.deferred+' waiting':''}.`)});
  if(host_.querySelector('#wds'))host_.querySelector('#wds').onclick=async()=>{const p=await edclAI.wada.getPrefs(),CATS={standards:'International Standards, TD, TL, guidelines',prohibited_list:'Prohibited List',rules:'Rules and policies',education:'Education',other:'Other'};
    host_.querySelector('#wdm').innerHTML=`<div class="card" style="margin-top:8px"><label><input type="checkbox" id="wsa"${p.archive?' checked':''}> keep the official files automatically after every WADA check</label><br>${Object.entries(CATS).map(([k,t])=>`<label style="margin-right:12px"><input type="checkbox" class="wsc" value="${k}"${p.categories.includes(k)?' checked':''}> ${E(t)}</label>`).join('')}<br><label>Files per run <input id="wsm" type="number" min="1" max="500" value="${p.maxFiles}" style="width:70px"></label> <label>Re-check a file every <input id="wsh" type="number" min="1" max="720" value="${p.recheckHours}" style="width:70px"> hours</label> <button class="btn sm" id="wss">Save</button></div>`;
    host_.querySelector('#wss').onclick=async()=>{try{await edclAI.wada.setPrefs({archive:host_.querySelector('#wsa').checked,categories:[...host_.querySelectorAll('.wsc')].filter(x=>x.checked).map(x=>x.value),maxFiles:+host_.querySelector('#wsm').value,recheckHours:+host_.querySelector('#wsh').value});audit('Edit','WADA Documents settings','saved');host_.querySelector('#wdm').textContent='Saved.'}catch(e){alert(e.message)}}};
  const rerender=()=>draw(host_);
  host_.querySelector('#wdq').oninput=e=>{FILTER.q=e.target.value;const pos=e.target.selectionStart;rerender();const q=host_.querySelector('#wdq');q.focus();q.setSelectionRange(pos,pos)};
  host_.querySelector('#wdt').onchange=e=>{FILTER.type=e.target.value;rerender()};host_.querySelector('#wdp1').onchange=e=>{FILTER.prevOnly=e.target.checked;rerender()};host_.querySelector('#wdr1').onchange=e=>{FILTER.recent=e.target.checked;rerender()};
  host_.onclick=async e=>{const o=e.target.closest('[data-wo]'),c=e.target.closest('[data-wc]'),vv=e.target.closest('[data-wv]');
    if(o){try{await openFile(+o.dataset.wo)}catch(x){alert(x.message)}}
    else if(vv){const k=vv.dataset.wv;OPEN.has(k)?OPEN.delete(k):OPEN.add(k);rerender()}
    else if(c){const g=LAST.groups.find(x=>x.key===c.dataset.wc);if(g)compareView(g,g.previous,g.current)}};
};
const mount=()=>{if(typeof R==='undefined'||typeof R.docs!=='function')return;const base=R.docs;
  R.docs=async function(){await base.apply(this,arguments);try{if(typeof CAT!=='undefined'&&CAT==='wada'&&WDX())await panel()}catch(e){console.warn('WADA documents view:',e)}};
  try{if(WDX()&&edclAI.wada.onChanged)edclAI.wada.onChanged(()=>{if(typeof CAT!=='undefined'&&CAT==='wada'&&document.querySelector('#wdp')&&!BUSY)panel()})}catch(e){}};
mount();
})();
