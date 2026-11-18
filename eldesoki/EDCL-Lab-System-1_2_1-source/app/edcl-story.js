/* EDCL Historical Storytelling section (ADD-ONLY module).
   - Wraps R.dash and inserts one self-contained section at the top of the Dashboard.
   - Reads no database tables except the existing Director career (read-only); writes nothing to the database.
   - Disable: remove the <script src="edcl-story.js"> line in index.html, or set localStorage 'edclStoryOff' = '1'
     (the Hide button does this for administrators).
   - Content: translated executive-status deck only. Financial and military content is intentionally excluded. */
(()=>{
if(typeof R==='undefined'||!R.dash||window.EDCL_STORY_DISABLED)return;
const KEY='edclStoryOff',DUR=9000,IMG='edcl-story/images/';
const off=()=>{try{return localStorage.getItem(KEY)==='1'}catch(e){return false}};
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const PV='<span class="eh-pv">Pending Verification</span>';
const ph=(a,b,c)=>[a,b,c];
const S=[
{t:['all'],date:'2007',title:'The laboratory is established',
 f:[['2007','Laboratory established, as stated in the briefing (confirm against original records) '+PV],['2008–2009','Supply of laboratory equipment begins'],['Initial mission','Not described in the supplied material '+PV]],
 note:'Original establishment photographs and documents were not supplied. '+PV},
{t:['all'],date:'2015–2016',title:'Scientific cooperation with the Barcelona laboratory',
 f:[['2015–2016','Cooperation with the Barcelona laboratory begins, as stated in the briefing'],['Documents','Supporting agreement or correspondence not yet supplied '+PV]],note:'No photographs supplied. '+PV},
{t:['all'],date:'Leadership',title:'Laboratory directors',dyn:'lead',
 f:[['Directors','No director names, titles or terms appear in the supplied material '+PV],['Achievements','Added only from documentary evidence '+PV]],note:'No historical director photographs supplied. '+PV},
{t:['all','blood'],date:'2018',title:'Blood laboratory accreditation',
 f:[['2018','Accreditation obtained in blood research, as stated in the briefing'],['Accreditation name and issuing body','Not stated in the supplied material '+PV],['Renewals and validity periods','No certificates supplied '+PV]],
 note:'No certificate images supplied. '+PV,st:'A separate scientific achievement. It is not WADA accreditation.'},
{t:['all','wada'],date:'2023 to Sep 2025',title:'Final testing phase and suspension',
 f:[['End of 2023','Final testing phase begins'],['Jan, May, Sep 2024 and Jan 2025','Four groups of test samples received'],['Sep 2024','WADA evaluation visit'],['Mar 2025','Final testing phase suspended after 76 findings'],['Jun 2025','Laboratory submits its responses'],['Sep 2025','Full suspension issued: responses to 26 findings not accepted']],
 note:'No photographs supplied for this period. '+PV,st:'Operational resumption date and leadership attribution: Pending Verification.'},
{t:['all','intl'],date:'December 2025',title:'London: experts from King’s College London',
 f:[['Visitors','Prof. Kim Wolff, Head of the Drug Control Centre, King’s College London'],['','Dr. Shobha Ahi, Deputy Director of the Centre; formerly Quality Director in India'],['','Dr. Rodrigo Aguilera, IRMS technology expert, London laboratory'],['Purpose','Help address the causes of the suspension and draw on international experience']],
 p:ph('london_visit_dec2025_1','london_visit_dec2025_2','london_visit_dec2025_3')},
{t:['all','intl'],date:'January 2026',title:'Dr. Alka Putra',
 f:[['Visitor','Dr. Alka Putra, former Scientific Director of the Qatar laboratory and the National Laboratory of India'],['Purpose','Draw on her experience in managing and developing anti-doping laboratories']],
 p:ph('dr_alka_visit_jan2026_1','dr_alka_visit_jan2026_2','dr_alka_visit_jan2026_3')},
{t:['all','intl'],date:'January 2026',title:'Tokyo: Japan’s anti-doping laboratory',
 f:[['Visitors','Dr. Masato Okano, Director, Tokyo Anti-Doping Laboratory'],['','Ms. Ayako Ikekita, Quality Director of the laboratory'],['Purpose','Support cooperation and exchange of technical expertise']],
 p:ph('tokyo_visit_jan2026_1','tokyo_visit_jan2026_2','tokyo_visit_jan2026_3')},
{t:['all','intl','wada'],date:'March 2026',title:'WADA evaluation committee visit',
 f:[['Committee','Thierry Boghosian, Head of International Laboratory Accreditation, WADA'],['','Prof. Peter Van Eenoo, Chair of the expert committee; Director of the Belgian laboratory'],['','Prof. Vinicius Figueiredo Sardela, senior director of anti-doping laboratories'],['Result','26 findings evaluated: 22 responses accepted, 4 not accepted; 6 corrective actions set']],
 p:ph('wada_visit_mar2026_1','wada_visit_mar2026_2','wada_visit_mar2026_3')},
{t:['all','wada'],date:'Aug to Sep 2026',title:'Corrective actions and new instrumentation',
 f:[['Latest WADA letter','6 of 10 points accepted; 4 corrective actions remaining'],['20 Aug 2026','Responses to the remaining 4 actions sent; WADA decision awaited'],['30 Aug 2026','Training begins on the newly installed Thermo Scientific Orbitrap Exploris 240 (3-year warranty)'],['Sep 2026','If accepted, test samples are expected to return to complete the final testing phase']],
 note:'No photographs supplied for this period. '+PV,st:'Current WADA status: Probationary. The accreditation restoration process is ongoing.'}
];
const CH=[['all','Full history'],['blood','Blood laboratory'],['wada','WADA'],['intl','International visits']];
const css=`<style id="ehcss">
.eh{grid-column:1/-1;background:#0a3d2a;color:#e8f5ee;border-radius:20px;box-shadow:var(--sh);margin:0 0 16px;overflow:hidden;outline:none}
.eh *{box-sizing:border-box}
.eh .hd{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:14px 18px 0}
.eh .hd b{font:700 15px 'Outfit',sans-serif;margin-right:8px}
.eh .ch{border:1px solid #ffffff44;background:transparent;color:#cfe7dc;border-radius:99px;padding:5px 14px;font:500 13px 'Outfit',sans-serif;cursor:pointer}
.eh .ch[aria-pressed=true]{background:#7be3b4;border-color:#7be3b4;color:#06301f}
.eh .sp{flex:1}
.eh .stg{display:grid;grid-template-columns:1.15fr 1fr;min-height:400px}
.eh .md{display:grid;gap:4px;padding:16px 0 16px 18px;grid-template-columns:2fr 1fr;grid-template-rows:1fr 1fr;min-height:300px}
.eh .md img{width:100%;height:100%;object-fit:cover;border-radius:10px;display:block;background:#0f4d36}
.eh .md img:first-child{grid-row:1/3}
.eh .np{grid-column:1/-1;grid-row:1/3;border:1px dashed #ffffff55;border-radius:10px;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:#b6d6c7;font-size:14px}
.eh .tx{padding:20px 26px;display:flex;flex-direction:column;min-width:0}
.eh .dt{color:#7be3b4;font-weight:600;font-size:14px}
.eh h2{font:700 clamp(21px,2.6vw,30px)/1.15 'Outfit',sans-serif;margin:4px 0 10px;color:#fff}
.eh ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.eh li{padding-left:12px;border-left:2px solid #2f7a5a;font-size:14px;line-height:1.5}
.eh li b{color:#7be3b4;font-weight:600}
.eh .eh-pv{display:inline-block;background:#f2b84a29;color:#ffd27a;border:1px solid #f2b84a80;border-radius:5px;padding:0 6px;font-size:11.5px;white-space:nowrap}
.eh .stt{margin-top:auto;padding-top:12px;color:#ffd27a;font-size:13.5px}
.eh .cap{font-size:12px;color:#9fc4b2;margin-top:8px}
.eh .ct{display:flex;gap:10px;align-items:center;padding:6px 18px 14px}
.eh .ct>button{background:#ffffff1f;border:1px solid #ffffff44;color:#fff;border-radius:10px;padding:6px 14px;font:500 13px 'Outfit',sans-serif;cursor:pointer}
.eh .ct>button:hover,.eh .ch:hover{background:#ffffff3a}
.eh button:focus-visible{outline:2px solid #ffd27a;outline-offset:2px}
.eh .rl{display:flex;flex:1;overflow-x:auto;scrollbar-width:thin}
.eh .rl button{flex:1 0 104px;background:none;border:0;border-top:3px solid #ffffff2e;color:#a9cdbb;text-align:left;font:12px/1.35 'Outfit',sans-serif;padding:7px 6px 0;cursor:pointer;position:relative;border-radius:0}
.eh .rl button[aria-current=true]{color:#fff;border-top-color:#7be3b4}
.eh .rl button[aria-current=true]::after{content:"";position:absolute;left:0;top:-3px;height:3px;width:var(--p,0%);background:#ffd27a}
.eh .ld{margin-top:10px;border-top:1px dashed #ffffff33;padding-top:8px}
.eh.mini{padding:10px 18px;display:flex;align-items:center;gap:12px;font-size:13px}
@media(max-width:760px){.eh .stg{grid-template-columns:1fr}.eh .md{padding:16px 16px 0}}
@media(prefers-reduced-motion:no-preference){.eh .tx,.eh .md{animation:ehin .5s ease}@keyframes ehin{from{opacity:0}to{opacity:1}}}
</style>`;
const lead=()=>{try{const c=((D.Brand||{}).director||{}).career||[];return c.filter(p=>p.edcl).sort((a,b)=>String(a.from).localeCompare(String(b.from)))}catch(e){return[]}};
const mount=()=>{
 const host=document.querySelector('#v .dsh .dl');if(!host||host.querySelector('.eh'))return;
 if(!document.getElementById('ehcss'))document.head.insertAdjacentHTML('beforeend',css);
 const adm=(typeof isA==='function')&&isA();
 const el=document.createElement('section');el.className='eh';el.tabIndex=0;el.setAttribute('aria-label','EDCL historical storytelling');
 if(off()){if(!adm)return;el.classList.add('mini');el.innerHTML='<span>EDCL historical storytelling is hidden.</span><button class="btn s sm" id="ehshow">Show</button>';host.insertBefore(el,host.firstChild);el.querySelector('#ehshow').onclick=()=>{try{localStorage.removeItem(KEY)}catch(e){}el.remove();mount()};return}
 el.innerHTML=`<div class="hd"><b>EDCL history</b><span class="chs"></span><span class="sp"></span>${adm?'<button class="ch" id="ehhide">Hide section</button>':''}</div><div class="stg"><div class="md"></div><div class="tx" aria-live="polite"></div></div><div class="ct"><button data-a="p" aria-label="Previous story">◀</button><button data-a="pp"></button><button data-a="n" aria-label="Next story">▶</button><div class="rl"></div></div>`;
 host.insertBefore(el,host.firstChild);
 const q=s=>el.querySelector(s);let ch='all',i=0,play=!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches),t0=0,raf=0,hov=false,held=0;
 const L=()=>S.filter(s=>s.t.includes(ch));
 const draw=()=>{const l=L(),s=l[i];
  q('.chs').innerHTML=CH.map(c=>`<button class="ch" data-c="${c[0]}" aria-pressed="${c[0]===ch}">${c[1]}</button>`).join(' ');
  q('.md').innerHTML=s.p?s.p.map((x,k)=>`<img src="${IMG+x}.jpg" alt="${esc(s.title)}, photograph ${k+1}" loading="lazy">`).join(''):`<div class="np">${s.note}</div>`;
  let extra='';if(s.dyn==='lead'){const c=lead();if(c.length)extra=`<div class="ld"><b style="color:#7be3b4">Recorded in this system (Director profile):</b><ul>${c.map(p=>`<li>${esc(p.title)}${p.org?', '+esc(p.org):''}: ${esc(p.from||'?')} to ${esc(p.to||'present')}</li>`).join('')}</ul></div>`}
  q('.tx').innerHTML=`<div class="dt">${esc(s.date)}</div><h2>${esc(s.title)}</h2><ul>${s.f.map(f=>`<li>${f[0]?'<b>'+esc(f[0])+':</b> ':''}${f[1]}</li>`).join('')}</ul>${extra}${s.st?'<div class="stt">'+esc(s.st)+'</div>':''}${s.p?'<div class="cap">Original EDCL photographs, as supplied.</div>':''}`;
  q('.rl').innerHTML=l.map((x,k)=>`<button data-i="${k}" aria-current="${k===i}">${esc(x.date)}<br>${esc(x.title.split(':')[0].slice(0,26))}</button>`).join('');
  q('[data-a=pp]').textContent=play?'Pause':'Play';t0=performance.now();held=0};
 const go=n=>{const l=L();i=(n+l.length)%l.length;draw()};
 const tick=()=>{if(!document.body.contains(el))return;if(play&&!hov){const p=Math.min(100,(performance.now()-t0)/DUR*100),c=q('.rl [aria-current=true]');if(c)c.style.setProperty('--p',p+'%');if(p>=100)go(i+1)}else if(hov||!play)t0=performance.now()-(held||0);raf=requestAnimationFrame(tick)};
 el.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
  if(b.id==='ehhide'){try{localStorage.setItem(KEY,'1')}catch(x){}el.remove();mount();return}
  if(b.dataset.c){ch=b.dataset.c;i=0;draw()}else if(b.dataset.i)go(+b.dataset.i);
  else if(b.dataset.a==='p')go(i-1);else if(b.dataset.a==='n')go(i+1);else if(b.dataset.a==='pp'){play=!play;draw()}});
 el.addEventListener('keydown',e=>{if(e.target.closest('button'))return;if(e.key==='ArrowRight')go(i+1);else if(e.key==='ArrowLeft')go(i-1)});
 el.addEventListener('mouseenter',()=>{hov=true;held=performance.now()-t0});el.addEventListener('mouseleave',()=>{hov=false;t0=performance.now()-held});
 draw();tick();
};
const _d=R.dash;R.dash=()=>{_d();try{mount()}catch(e){console.error('edcl-story',e)}};
})();
