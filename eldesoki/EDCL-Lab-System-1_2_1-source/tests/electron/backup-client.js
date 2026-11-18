// Runs the REAL app (main.js + preload + index.html) as one workstation in server mode and drives it through the page.
// Started by central-e2e.js (not by hand). env: ROLE=A|B  OUT_DIR  APP_ROOT  USER_NAME  PASS
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROLE = process.env.ROLE, OUT = process.env.OUT_DIR, root = process.env.APP_ROOT || process.cwd();
app.disableHardwareAcceleration();
const L = (k, v) => fs.appendFileSync(path.join(OUT, ROLE + '.log'), JSON.stringify([k, v === undefined ? true : v]) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
require(path.join(root, 'main.js'));
app.whenReady().then(async () => {
  let win; for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows()[0]); i++) await sleep(100);
  const wc = win.webContents, errs = [];
  wc.on('console-message', (_e, level, msg) => { if (level >= 3) errs.push(msg.slice(0, 200)); });
  const ev = c => wc.executeJavaScript(c, true);
  const until = async (c, ms = 40000, step = 250) => { const t = Date.now(); for (;;) { try { const v = await ev(c); if (v) return v; } catch (e) {} if (Date.now() - t > ms) return false; await sleep(step); } };
  const flag = f => fs.existsSync(path.join(OUT, f));
  try {
    L('started', true);
    await ev("window.confirm=()=>true;window.alert=m=>{window.__alerts=(window.__alerts||[]);window.__alerts.push(String(m))};0");
    L('login-screen', await until("!!document.querySelector('#lu')", 30000));
    await ev(`document.querySelector('#lu').value=${JSON.stringify(process.env.USER_NAME)};document.querySelector('#lp').value=${JSON.stringify(process.env.PASS)};document.querySelector('#lb').click()`);
    const bad = await until("(document.querySelector('.lgerr')||{}).textContent&&document.querySelector('.lgerr').textContent.length>0&&document.querySelector('.lgerr').textContent", 4000, 300);
    L('signed-in', await until("typeof U!=='undefined'&&!!U&&!!document.querySelector('#ver')", 45000)); if (bad) L('login-error', bad);
    L('user', await ev('U&&U.username')); L('central-on', await ev('!!window.CEN_ON'));
    L('employees-loaded', await ev('D.Employees.length'));
    L('role', await ev('JSON.stringify({role:U.role,perms:U.perms,isOwner:isOwner(),pmBackup:pm("backup")})'));
    await ev("tx('readwrite',s=>s.add({cat:'sop',name:'x.pdf',code:'v1',type:'application/pdf',size:1,date:'2026-11-14 10:00',blob:new Blob(['PDF-bytes'],{type:'application/pdf'})}))"); await sleep(1500);
    await ev("window.__dl=null;URL.createObjectURL=(b=>{window.__bk=b;return 'blob:x'});HTMLAnchorElement.prototype.click=function(){window.__dl=this.download};0");
    L('addon-imports-done', await until("(window.__alerts||[]).length>=2", 60000)); await sleep(2500);
    L('nav-links', await ev("[...document.querySelectorAll('nav a')].map(a=>(a.dataset.p||'')+'|'+a.getAttribute('href')+'|'+a.textContent.trim().slice(0,25))"));
    L('clicked', await ev("(()=>{const a=[...document.querySelectorAll('nav a')].find(a=>/backup/i.test(a.textContent));if(!a)return 'NO BACKUP LINK';a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return a.textContent.trim()+' -> '+location.hash})()")); await sleep(2000);
    L('debug', await ev("JSON.stringify({sec:D.Sec||null,hash:location.hash,overlays:[...document.querySelectorAll('body > div')].map(d=>d.className+'#'+d.id+':'+d.innerText.slice(0,40)).slice(-4),secGuard:typeof window.secGuard,navP:[...document.querySelectorAll('nav a')].filter(a=>/backup/i.test(a.textContent)).map(a=>a.dataset.p)})"));
    L('reauth-modal-shown', await until("!!document.querySelector('#rp')", 8000));
    await ev("document.querySelector('#rp').value='wrong-password-1';document.querySelector('#ro').click()"); await sleep(1500);
    L('wrong-password-message', await ev("(document.querySelector('#rm')||{}).textContent")); 
    await ev(`document.querySelector('#rp').value=${JSON.stringify(process.env.PASS)};document.querySelector('#ro').click()`); await sleep(2500);
    L('b1-button-present', await ev("!!document.querySelector('#b1')")); L('b2-restore-present', await ev("!!document.querySelector('#b2')"));
    L('page-text', (await ev("document.querySelector('#v').innerText")).slice(0, 400));
    if (await ev("!!document.querySelector('#b1')")) {
      await ev("document.querySelector('#b1').click()");
      L('download-started', await until("!!window.__dl", 60000));
      L('download-name', await ev("window.__dl")); L('blob-size', await ev("window.__bk&&window.__bk.size"));
      L('backup-content', await ev("window.__bk&&window.__bk.text().then(t=>{const j=JSON.parse(t);return {employees:j.D.Employees.length,users:(j.D.Users||[]).length,files:j.files.length}})"));
    }
    L('alerts', await ev("(window.__alerts||[]).slice(2)")); L('console-errors', errs);
  } catch (e) { L('harness-error', String(e)); }
  app.exit(0);
});
