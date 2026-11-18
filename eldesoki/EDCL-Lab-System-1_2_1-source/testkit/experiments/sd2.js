const { app, BrowserWindow } = require('electron'); const fs = require('fs'); app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 1250, height: 1000, webPreferences: { webSecurity: false, contextIsolation: false } });
  await w.loadFile('/tmp/sd/v1/page.html'); const run = c => w.webContents.executeJavaScript(c, true).catch(e => 'ERR ' + e.message);
  for (let i = 0; i < 40 && !(await run('window.__ready===true')); i++) await sleep(500); console.log('ready:', await run('window.__ready'));
  await sleep(2500);
  fs.writeFileSync('/tmp/sd/shot1.pdf', await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })); console.log('printToPDF shot1 ok');
  console.log('editor:', await run('(()=>{const e=window.__sd.activeEditor;return e?("has editor; commands="+Object.keys(e.commands).length+"; docSize="+e.state.doc.content.size):"no activeEditor"})()'));
  console.log('cells:', await run(`(()=>{const e=window.__sd.activeEditor,out=[];e.state.doc.descendants((n,p)=>{if(/tableCell|tableHeader/.test(n.type.name))out.push(p+':'+n.textContent.slice(0,22))});return JSON.stringify(out.slice(0,14))})()`));
  const ins = await run(`(()=>{const e=window.__sd.activeEditor,cells=[];e.state.doc.descendants((n,p)=>{if(/tableCell|tableHeader/.test(n.type.name))cells.push({p,t:n.textContent})});
    const jobs=[['Training subject','تحضير العينات / Sample preparation'],['Full name','محمد أحمد عبد العظيم'],['Department','Hematology Lab'],['Staff ID','EMP001']];
    const todo=jobs.map(([l,t])=>{const i=cells.findIndex(c=>c.t.startsWith(l));return{l,t,p:cells[i+1].p}}).sort((x,y)=>y.p-x.p); /* insert from the END of the document backwards so earlier positions stay valid */
    return todo.map(j=>j.l+':'+e.commands.insertContentAt(j.p+2,j.t)).join(' | ')})()`);
  console.log('insert results:', ins); await sleep(800);
  const b64 = await run(`(async()=>{const r=await window.__sd.export({triggerDownload:false});const blob=Array.isArray(r)?r[0]:r;const u=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode(...u.subarray(i,i+8192));return btoa(s)})()`);
  if (typeof b64 === 'string' && !b64.startsWith('ERR')) { fs.writeFileSync('/tmp/sd/exported.docx', Buffer.from(b64, 'base64')); console.log('exported docx bytes', Buffer.from(b64, 'base64').length); } else console.log('export result:', String(b64).slice(0, 200));
  fs.writeFileSync('/tmp/sd/shot2.pdf', await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })); console.log('printToPDF shot2 ok');
  app.exit(0);
});
