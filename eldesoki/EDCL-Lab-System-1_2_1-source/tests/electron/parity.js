// Feature-parity check: the REAL app (standalone mode, isolated data folder) loads every production add-on, the training files and the story module,
// and every sidebar screen opens without a script error. Run: XDG_CONFIG_HOME=$(mktemp -d) xvfb-run -a electron --no-sandbox --disable-gpu tests/electron/parity.js
const { app, BrowserWindow } = require('electron');
const path = require('path'); const root = process.env.APP_ROOT || process.cwd();
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
require(path.join(root, 'main.js'));
const out = []; const ok = (n, v, extra) => { out.push(!!v); console.log((v ? 'ok   ' : 'FAIL ') + n + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); };
app.whenReady().then(async () => {
  let win; for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows()[0]); i++) await sleep(100);
  const wc = win.webContents, errs = [], fails = [];
  wc.on('console-message', (_e, lv, msg) => { if (lv >= 3) errs.push(msg.slice(0, 160)); });
  wc.on('did-fail-load', (_e, c, d, u) => fails.push(u));
  const ev = c => wc.executeJavaScript(c, true);
  const until = async (c, ms = 30000) => { const t = Date.now(); for (;;) { try { const v = await ev(c); if (v) return v; } catch (e) {} if (Date.now() - t > ms) return false; await sleep(250); } };
  try {
    await ev("window.confirm=()=>true;window.alert=m=>{(window.__al=window.__al||[]).push(String(m))};0");
    ok('login screen shown (standalone, no server configured)', await until("!!document.querySelector('#lu')"));
    ok('bridges: edclDesktop, edclDesktop.central, edclAI (AI Hybrid), edclWF (WADA Fix)', await ev("!!(window.edclDesktop&&edclDesktop.central&&window.edclAI&&window.edclWF)"));
    ok('server mode OFF without configuration', (await ev("edclDesktop.central.config()")).configured === false);
    await ev("document.querySelector('#lu').value='admin';document.querySelector('#lp').value='Admin@123';document.querySelector('#lb').click()");
    await sleep(1500);
    ok('signed in locally', await until("typeof U!=='undefined'&&!!U&&!!document.querySelector('#ver')", 30000));
    ok('version shown is 1.2.1', (await ev("document.querySelector('#ver')&&document.querySelector('#ver').textContent")||'').includes('1.2.1') || await ev("APP_VER==='1.2.1'"));
    const scripts = await ev("[...document.querySelectorAll('script[src]')].map(s=>s.getAttribute('src'))");
    ok('add-on / module script tags present', ['training-import.js','trq-register.js','addons/edcl-wada-links/wada-links.js','addons/edcl-ai-hybrid/loader.js','addons/edcl-ai/edcl-ai.js','addons/edcl-wada-fix/loader.js','edcl-story.js','central-sync.js'].every(s => scripts.includes(s)), scripts);
    ok('no resource failed to load', fails.length === 0, fails);
    for (const f of ['training-import.js','trq-register.js','edcl-story.js','central-sync.js','addons/edcl-ai/edcl-ai.js','addons/edcl-wada-fix/loader.js','addons/edcl-wada-links/wada-links.js','addons/edcl-ai-hybrid/loader.js','training-pdfs/gr009_key.pdf','edcl-story/images/dr_alka_visit_jan2026_1.jpg'])
      ok('served by app:// : ' + f, await ev(`fetch(${JSON.stringify(f)}).then(r=>r.ok&&r.status===200).catch(()=>false)`));
    await ev("document.querySelectorAll('.mo').forEach(m=>m.remove());U.must=0;0");   // the seeded admin must change its password at first sign-in; dismiss that dialog for this check
    await ev("location.hash='dash';go()"); await sleep(2000);
    let dd; try { dd = await ev("(()=>{try{R.dash();return 'dash-ok:'+document.querySelector('#v').innerHTML.slice(0,60)+'|host='+!!document.querySelector('#v .dsh .dl')}catch(e){return 'dash-threw:'+e.message+'|'+(e.stack||'').split('\\n').slice(0,3).join(' / ')}})()"); } catch (e) { dd = 'ev failed ' + e.message; } console.log('R.dash direct call ->', dd);
    const dbg = await ev("({dash:R.dash.toString().slice(0,70),host:!!document.querySelector('#v .dsh .dl'),off:localStorage.getItem('edclStoryOff'),dis:!!window.EDCL_STORY_DISABLED,sections:document.querySelectorAll('section.eh').length,hash:location.hash,v:(document.querySelector('#v')||{innerHTML:''}).innerHTML.slice(0,80),modals:document.querySelectorAll('.mo').length,mt:(document.querySelector('.mo')||{innerText:''}).innerText.slice(0,80)})");
    ok('Historical storytelling section on the Dashboard', await ev("!!document.querySelector('section.eh')"), dbg);
    const nav = await ev("NAV.map(n=>n[0]).filter(k=>typeof R[k]==='function')");
    const bad = [];
    for (const k of nav) { const before = errs.length; try { await ev(`location.hash=${JSON.stringify(k)};typeof go==='function'&&go()`); } catch (e) { bad.push([k, 'threw: ' + String(e.message).slice(0, 120)]); } await sleep(350); if (errs.length > before) bad.push([k, errs.slice(before)]); }
    ok('all ' + nav.length + ' sidebar screens open without script errors', bad.length === 0, bad);
    ok('no console errors overall', errs.length === 0, errs.slice(0, 5));
  } catch (e) { ok('harness', false, String(e)); }
  console.log(out.every(Boolean) ? 'PARITY PASS ' + out.length + '/' + out.length : 'PARITY FAIL ' + out.filter(x => !x).length + ' of ' + out.length); app.exit(out.every(Boolean) ? 0 : 1);
});
