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
    L('employees-loaded', await ev('D.Employees.length')); L('badge', await ev("(document.getElementById('cenBadge')||{}).textContent"));
    // screens open without script errors with server data
    for (const h of ['emp', 'docs', 'train', 'auth', 'bak', 'users']) { await ev(`location.hash='${h}';typeof go==='function'&&go()`); await sleep(500); }
    L('screens-ok', true);
    const bytes = ROLE === 'A' ? 'PDF-bytes-from-A-' + 'x'.repeat(100000) : 'PDF-bytes-from-B';
    const fname = ROLE.toLowerCase() + '.pdf', other = ROLE === 'A' ? 'b.pdf' : 'a.pdf';
    if (ROLE === 'A') {
      await ev("D.Employees[0].Department='A-wrote-dept';save()");
      await ev(`tx('readwrite',s=>s.add({cat:'sop',name:'${fname}',code:'v1',type:'application/pdf',size:1,date:'2026-11-14 10:00',blob:new Blob([${JSON.stringify(bytes)}],{type:'application/pdf'})}))`);
      L('A-wrote', true);
    } else {
      L('B-sees-A-field', await until("D.Employees[0].Department==='A-wrote-dept'", 40000));
      L('B-sees-A-file', await until("tx('readonly',s=>s.getAll()).then(a=>a.some(f=>f.name==='a.pdf'))", 40000));
      L('B-file-bytes', await ev("tx('readonly',s=>s.getAll()).then(a=>a.find(f=>f.name==='a.pdf').blob.get()).then(b=>b.text()).then(t=>t.length+':'+t.slice(0,16))"));
      await ev("D.Employees[0].JobTitle='B-wrote-title';save()");
      await ev(`tx('readwrite',s=>s.add({cat:'sop',name:'${fname}',code:'v1',type:'application/pdf',size:1,date:'2026-11-14 10:01',blob:new Blob([${JSON.stringify(bytes)}],{type:'application/pdf'})}))`);
      L('B-wrote', true);
    }
    if (ROLE === 'A') {
      L('A-sees-B-field', await until("D.Employees[0].JobTitle==='B-wrote-title'&&D.Employees[0].Department==='A-wrote-dept'", 40000));
      L('A-sees-B-file', await until("tx('readonly',s=>s.getAll()).then(a=>a.some(f=>f.name==='b.pdf'))", 40000));
    }
    L('phase1-done', true);
    // phase 2: server is stopped by the orchestrator, A edits meanwhile, server comes back
    if (ROLE === 'A') {
      await until("1", 1); for (let i = 0; i < 240 && !flag('phase2'); i++) await sleep(250);
      await ev("D.Employees[1].Department='edited-while-server-down';save()");
      L('A-offline-badge', await until("/unreachable/.test((document.getElementById('cenBadge')||{}).textContent||'')", 40000, 500));
      L('A-synced-after-return', await until("/Connected/.test((document.getElementById('cenBadge')||{}).textContent||'')&&CEN.eng.state().pending===0", 90000, 500));
    } else {
      L('B-sees-offline-edit', await until("D.Employees[1].Department==='edited-while-server-down'", 150000, 500));
    }
    L('sync-log', errs.filter(e => /SYNC/.test(e)).slice(0, 5)); L('console-errors', errs.filter(e => !/Autofill|DevTools|favicon|SYNC/i.test(e)).slice(0, 5));
    L('alerts', await ev('window.__alerts||[]'));
    L('done', true);
  } catch (e) { L('exception', String(e && e.stack || e).slice(0, 400)); }
  setTimeout(() => app.exit(0), 500);
});
