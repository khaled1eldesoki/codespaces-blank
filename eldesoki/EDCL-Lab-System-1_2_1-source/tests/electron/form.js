const { app, BrowserWindow } = require('electron'); const fs = require('fs'), cp = require('child_process');
app.setPath('userData', '' + (process.env.USERDATA || '/tmp/edcl-userdata') + ''); app.disableHardwareAcceleration();
require(process.env.MAINJS || '' + (process.env.APP_ROOT || process.cwd()) + '/main.js');
const sleep = ms => new Promise(r => setTimeout(r, ms)); const PHASE = process.env.PHASE;
app.whenReady().then(async () => {
  await sleep(6500); const w = BrowserWindow.getAllWindows()[0]; const run = c => w.webContents.executeJavaScript(c, true);
  if (PHASE === '1') {
    console.log('bridge keys:', await run('Object.keys(edclDesktop).join(",")'));
    await run(`(async()=>{U=D.Users.find(x=>x.role==='admin')||D.Users[0];start();TFT='FO127';TFO=null;location.hash='tform';go();await new Promise(r=>setTimeout(r,500));
      const set=(id,v)=>{const e=document.querySelector('#tfc [data-k="'+id+'"]')||document.querySelector('#tfc #'+id);if(e){e.value=v}};
      })()`);
    await sleep(800);
    console.log('form fields:', await run(`[...document.querySelectorAll('#tfc input,#tfc select,#tfc textarea')].map(e=>e.name||e.dataset.k||e.id).join(',')`));
    await run(`(()=>{const f=[...document.querySelectorAll('#tfc input,#tfc select,#tfc textarea')];const by=k=>f.find(e=>(e.name||e.dataset.k||e.id)===k);by('Subject').value='GC-MS/MS sample preparation';by('Trainer').value='Dr. Trainer Name';by('Score').value='88';by('Comments').value='Printed header test';document.querySelector('#tfc').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#ts').click()})()`);
    await sleep(1200);
    console.log('saved forms in data:', await run('D.TrainForms.length'), '| form no:', await run('D.TrainForms[0]&&D.TrainForms[0].FormNo'), '| type:', await run('D.TrainForms[0]&&D.TrainForms[0].FormType'));
    const pdf = await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }); fs.writeFileSync('/tmp/el/form.pdf', pdf);
    console.log('pdf bytes:', pdf.length, '| header:', pdf.slice(0, 5).toString());
  }
  if (PHASE === '2') {
    await run(`(async()=>{U=D.Users.find(x=>x.role==='admin')||D.Users[0];start();TFT='FO127';location.hash='tform';go()})()`); await sleep(900);
    console.log('after restart: saved forms:', await run('D.TrainForms.length'), '| list row shown:', await run(`!![...document.querySelectorAll('#tl td')].find(td=>/TF-0001/.test(td.textContent))`));
    await run(`[...document.querySelectorAll('#tl tr')].find(tr=>/TF-0001/.test(tr.textContent)).click()`); await sleep(800);
    console.log('reopened form fields restored: subject =', await run(`[...document.querySelectorAll('#tfc input,#tfc textarea')].find(e=>(e.name||e.dataset.k||e.id)==='Subject').value`), '| trainer =', await run(`[...document.querySelectorAll('#tfc input')].find(e=>(e.name||e.dataset.k||e.id)==='Trainer').value`));
  }
  app.exit(0);
});
