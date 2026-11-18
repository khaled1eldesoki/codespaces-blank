const { app, net } = require('electron');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { createMonitor } = require('' + (process.env.APP_ROOT || process.cwd()) + '/wada-monitor.js');
app.disableHardwareAcceleration();
let hits = {}, plan = {}, items = [{ s: 'a', t: 'WADA publishes 2027 Prohibited List', d: '10 October 2026' }];
const srv = http.createServer((req, res) => { hits[req.url] = (hits[req.url] || 0) + 1; const p = plan[req.url]; const st = p && (typeof p === 'function' ? p(hits[req.url]) : p);
  if (st && st.status) { res.writeHead(st.status); return res.end('x'); } if (st && st.hang) return;
  if (req.url === '/en/media/news') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><main>' + items.map(i => `<span>${i.d}</span><a href="/en/news/${i.s}">${i.t}</a>`).join('') + '</main></html>'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>P</title></head><main>page</main></html>'); });
const out = [], ok = (n, c) => { out.push((c ? 'ok   ' : 'FAIL ') + n); };
app.whenReady().then(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const via = (url, o) => net.fetch('http://127.0.0.1:' + port + new URL(url).pathname, o).then(r => { Object.defineProperty(r, 'url', { value: url }); return r; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-')); const notified = [];
  const m = createMonitor({ dbPath: path.join(dir, 'w.sqlite'), fetchImpl: via, sleep: async () => {}, onNotify: n => notified.push(...n), sources: [{ id: 'news', url: 'https://www.wada-ama.org/en/media/news', kind: 'news', category: 'news', label: 'WADA news' }] });
  let r = await m.check(); ok('electron net.fetch: baseline check ok, ' + m.listItems().length + ' item', r.status === 'ok' && m.listItems().length === 1 && m.listNotifications().length === 0);
  items.unshift({ s: 'b', t: 'New Code compliance policy announced', d: '19 October 2026' }); r = await m.check(); ok('electron net.fetch: new item -> 1 notification', r.counts.new === 1 && m.listNotifications().length === 1 && notified.length === 1);
  r = await m.check(); ok('electron net.fetch: unchanged recheck -> no new notification', r.newNotifications === 0 && m.listNotifications().length === 1);
  plan['/en/media/news'] = n => n <= 2 ? { status: 503 } : null; r = await m.check(); ok('electron net.fetch: 503,503,200 retried, run ok (hits=' + hits['/en/media/news'] + ')', r.status === 'ok');
  plan['/en/media/news'] = { status: 404 }; r = await m.check(); ok('electron net.fetch: 404 -> failed run, not success', r.status === 'failed' && m.status().lastRun.status === 'failed');
  plan['/en/media/news'] = { hang: true }; const slowM = createMonitor({ dbPath: path.join(dir, 'w2.sqlite'), fetchImpl: via, sleep: async () => {}, sources: [{ id: 'news', url: 'https://www.wada-ama.org/en/media/news', kind: 'news', category: 'news', label: 'n' }] });
  slowM.db.prepare("INSERT INTO wada_prefs (key,value) VALUES ('x','1')").run(); const p = slowM.check(); setTimeout(() => slowM.cancel(), 300); r = await p; ok('electron net.fetch: in-flight request cancelled via AbortSignal (' + r.status + ')', r.status === 'cancelled');
  const refused = createMonitor({ dbPath: path.join(dir, 'w3.sqlite'), fetchImpl: (u, o) => net.fetch('http://127.0.0.1:59999/', o), sleep: async () => {}, sources: [{ id: 'news', url: 'https://www.wada-ama.org/en/media/news', kind: 'news', category: 'news', label: 'n' }] });
  r = await refused.check(); const e1 = refused.history().errors[0]; ok('Chromium error classified: connection refused -> ' + e1.category + '/' + e1.stage + ' :: ' + e1.message.slice(0, 90), r.status === 'failed' && ['network'].includes(e1.category));
  const dns = createMonitor({ dbPath: path.join(dir, 'w4.sqlite'), fetchImpl: (u, o) => net.fetch('https://no-such-host.invalid/', o), sleep: async () => {}, sources: [{ id: 'news', url: 'https://www.wada-ama.org/en/media/news', kind: 'news', category: 'news', label: 'n' }] });
  r = await dns.check(); const e2 = dns.history().errors[0]; ok('Chromium error classified: DNS -> ' + e2.category + '/' + e2.stage + ' :: ' + e2.message.slice(0, 90), r.status === 'failed' && ['dns', 'network'].includes(e2.category));
  console.log(out.join('\n')); console.log('electron', process.versions.electron, 'chrome', process.versions.chrome, 'node', process.versions.node);
  [m, slowM, refused, dns].forEach(x => x.close()); srv.close(); app.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
});
