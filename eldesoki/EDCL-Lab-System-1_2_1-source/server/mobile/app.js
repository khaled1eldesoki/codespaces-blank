(() => {
'use strict';
// EDCL phone viewer - READ ONLY. It only calls: POST /api/login, POST /api/password (first sign-in), POST /api/logout, GET /api/sync.
// There is no code anywhere in this file that calls /api/push, so nothing can be created, edited or deleted from the phone.
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AUTH_VALID_MONTHS = 0;      // set e.g. 24 to also flag authorizations older than 24 months; 0 = off (no validity rule is stored in the data)
const POLL_MS = 60000;
let token = sessionStorage.getItem('edcl.tok'), D = {}, seq = 0, tab = 'dash', q = '', filt = 'All', loaded = false, timer = null, newWada = new Set();
const tbl = n => D[n] || (D[n] = new Map());
const list = n => [...tbl(n).values()];
const show = id => { for (const x of ['login', 'chpw', 'app']) $('#' + x).classList.toggle('hidden', x !== id); };

async function api(path, opt = {}) {
  const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { signOut(true); throw new Error('Signed out'); }
  if (!r.ok && !(r.status === 403 && j.mustChange)) throw Object.assign(new Error(j.error || 'Error ' + r.status), { status: r.status, body: j });
  return j;
}
function signOut(silent) { if (!silent && token) api('/api/logout', { method: 'POST' }).catch(() => {}); token = null; sessionStorage.removeItem('edcl.tok'); D = {}; seq = 0; loaded = false; clearInterval(timer); show('login'); }

async function sync() {
  let more = true, fresh = [];
  while (more) {
    const r = await api('/api/sync?since=' + seq + '&limit=1000');
    for (const c of r.changes) { c.deleted ? tbl(c.tbl).delete(c.id) : tbl(c.tbl).set(c.id, c.data); if (loaded && !c.deleted) fresh.push(c); }
    seq = r.lastSeq > seq ? r.lastSeq : seq; more = r.more;
  }
  $('#status').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  loaded = true; notify(fresh); render();
}
function notify(ch) {
  const items = [];
  for (const c of ch) {
    if (c.tbl === 'WadaUpdates') { if (c.data.Baseline) continue; newWada.add(c.id); items.push('WADA: ' + c.data.Title); }
    else if (c.tbl === 'Authorization' && /^(Expired|Pending)$/.test(c.data.AuthorizationStatus || '')) items.push('Authorization ' + c.data.AuthorizationStatus + ': ' + (empName(c.data.StaffID)));
    else if (c.tbl === 'Flags' && /^open$/i.test(c.data.Status || '')) items.push('Lab flag: ' + (c.data.Description || '').slice(0, 80));
  }
  if (!items.length || !('Notification' in window) || Notification.permission !== 'granted' || !navigator.serviceWorker) return;
  navigator.serviceWorker.ready.then(r => r.showNotification('EDCL Lab - ' + items.length + ' update' + (items.length > 1 ? 's' : ''), { body: items.slice(0, 3).join('\n'), tag: 'edcl-updates', renotify: true }));
}
const empName = id => (tbl('Employees').get(String(id)) || {}).FullName || id || '-';
const authList = () => list('Authorization'), empList = () => list('Employees');
const short = (s, n = 90) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '...' : s; };

function alerts() {
  const a = [];
  for (const w of [...tbl('WadaUpdates').entries()].sort((x, y) => String(y[1].FoundAt).localeCompare(String(x[1].FoundAt))))
    a.push({ kind: 'WADA', cls: 'wn', title: w[1].Title, sub: [w[1].Published, w[1].ItemType, host(w[1].Url)].filter(Boolean).join(' - '), url: w[1].Url, isNew: newWada.has(w[0]) || wIsNew(w[1]) });
  for (const x of authList()) {
    const st = x.AuthorizationStatus;
    if (st === 'Expired') a.push({ kind: 'Authorization expired', cls: 'bd', title: empName(x.StaffID) + ' - ' + short(x.MethodName, 70), sub: x.AuthorizationID });
    else if (st === 'Pending') a.push({ kind: 'Authorization pending', cls: 'wn', title: empName(x.StaffID) + ' - ' + short(x.MethodName, 70), sub: x.AuthorizationID });
    else if (AUTH_VALID_MONTHS && x.AuthorizationDate) { const d = new Date(x.AuthorizationDate); d.setMonth(d.getMonth() + AUTH_VALID_MONTHS); const days = Math.round((d - Date.now()) / 864e5); if (days < 0) a.push({ kind: 'Authorization past ' + AUTH_VALID_MONTHS + ' months', cls: 'bd', title: empName(x.StaffID) + ' - ' + short(x.MethodName, 70), sub: x.AuthorizationID }); else if (days <= 60) a.push({ kind: 'Authorization due in ' + days + ' days', cls: 'wn', title: empName(x.StaffID) + ' - ' + short(x.MethodName, 70), sub: x.AuthorizationID }); }
  }
  for (const f of list('Flags')) if (/^open$/i.test(f.Status || '')) a.push({ kind: 'Lab flag', cls: 'wn', title: short(f.Description, 110), sub: f.Category + ' - ' + f.FlagID });
  return a;
}
const wkey = w => w.ChangedAt || w.Published || w.FoundAt || '';
const wIsNew = w => !w.Baseline && Date.now() - new Date(w.ChangedAt || w.FoundAt || 0) < 14 * 864e5;
const safe = u => host(u) === 'www.wada-ama.org' ? u : '#';
const host = u => { try { return new URL(u).hostname; } catch (e) { return ''; } };
const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 90 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
function wadaBlock() {
  const st = tbl('WadaStatus').get('main'), L = list('WadaUpdates').sort((a, b) => wkey(b).localeCompare(wkey(a))).slice(0, 5);
  let s = '<h3>WADA updates</h3>';
  if (!st) s += '<p class="muted">The server has not completed a WADA check yet (first check runs about 20 seconds after the server starts).</p>';
  else s += `<p class="muted">Last checked ${esc(ago(st.LastCheck))}${st.Result === 'ok' ? '' : ' - <span class="' + (st.Result === 'failed' ? 'bd' : 'wn') + '">' + esc(st.Result) + '</span>'}${st.LastOk && st.Result !== 'ok' ? ' (last success ' + esc(ago(st.LastOk)) + ')' : ''}</p>` +
    (st.Sources || []).filter(x => !x.ok).map(x => `<p class="muted wn">${esc(x.id)}: ${esc(x.error)}</p>`).join('');
  return s + L.map(w => `<div class="row">${wIsNew(w) ? '<span class="new">NEW</span> ' : ''}<span class="muted">${esc(w.ItemType || '')} ${esc(w.Published || '')}</span><b><a href="${esc(safe(w.Url))}" target="_blank" rel="noopener noreferrer">${esc(w.Title)}</a></b><span class="muted">${esc(host(w.Url))}</span></div>`).join('') + (L.length ? '' : '<p class="muted">No WADA items yet.</p>');
}
const pill = s => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
const searchBox = ph => `<input id="q" placeholder="${ph}" value="${esc(q)}" autocomplete="off">`;

function render() {
  if (!loaded) return;
  const v = $('#view'), A = alerts(); let h = '';
  $('#title').textContent = { dash: 'Dashboard', emp: 'Employees', auth: 'Authorizations', alerts: 'Alerts' }[tab];
  const nb = A.filter(x => x.kind !== 'WADA' || x.isNew).length; $('#badge').textContent = nb; $('#badge').classList.toggle('hidden', !nb);
  if (tab === 'dash') {
    const st = c => authList().filter(x => x.AuthorizationStatus === c).length;
    h = `<div class="grid"><div class="card"><div class="n">${empList().filter(e => e.EmploymentStatus === 'Active').length}</div>Active employees</div>
<div class="card"><div class="n">${authList().length}</div>Authorizations</div>
<div class="card ok"><div class="n">${st('Active')}</div>Active auth.</div>
<div class="card wn"><div class="n">${st('Pending')}</div>Pending</div>
<div class="card bd"><div class="n">${st('Expired')}</div>Expired</div>
<div class="card ${list('WadaUpdates').some(wIsNew) ? 'wn' : ''}"><div class="n">${list('WadaUpdates').filter(wIsNew).length}</div>New WADA (14 d)</div></div>${wadaBlock()}<h3>Needs attention</h3>`;
    h += A.filter(x => x.kind !== 'WADA').slice(0, 6).map(x => `<div class="row"><span class="${x.cls}">${esc(x.kind)}</span><b>${esc(x.title)}</b></div>`).join('') || '<p class="muted">Nothing needs attention.</p>';
  } else if (tab === 'emp') {
    const ql = q.toLowerCase(), L = empList().filter(e => !ql || [e.FullName, e.StaffID, e.Department, e.JobTitle].join(' ').toLowerCase().includes(ql)).sort((a, b) => String(a.FullName).localeCompare(b.FullName));
    h = searchBox('Search employees') + `<p class="muted">${L.length} employees</p>` + L.map(e => `<button class="row" data-emp="${esc(e.StaffID)}"><b>${esc(e.FullName)}</b><span class="muted">${esc(e.StaffID)} - ${esc(e.JobTitle)} - ${esc(e.Department)}</span></button>`).join('');
  } else if (tab === 'auth') {
    const ql = q.toLowerCase(), L = authList().filter(x => (filt === 'All' || x.AuthorizationStatus === filt) && (!ql || [x.AuthorizationID, empName(x.StaffID), x.MethodName, x.MethodID, x.InstrumentID].join(' ').toLowerCase().includes(ql)));
    h = searchBox('Search authorizations') + `<div class="chips">${['All', 'Active', 'Pending', 'Expired'].map(f => `<button data-f="${f}" class="${f === filt ? 'on' : ''}">${f}</button>`).join('')}</div><p class="muted">${L.length} authorizations</p>` +
      L.map(x => `<button class="row" data-auth="${esc(x.AuthorizationID)}"><b>${esc(empName(x.StaffID))}</b>${esc(short(x.MethodName, 100))}<br>${pill(x.AuthorizationStatus || '-')} <span class="muted">${esc(x.AuthorizationID)} ${esc(x.AuthorizationDate || '')}</span></button>`).join('');
  } else {
    const nt = 'Notification' in window ? Notification.permission : 'unsupported';
    h = nt === 'default' ? '<button id="en" class="primary">Enable device notifications</button><p class="muted">Notifies you while this page is open or installed and the phone is awake. Background push when the page is closed is not included in this version.</p>' : nt === 'denied' ? '<p class="muted">Notifications are blocked in the browser settings for this site.</p>' : nt === 'unsupported' ? '<p class="muted">This browser cannot show notifications over this connection.</p>' : '';
    h += A.map(x => `<div class="row"><span class="${x.cls}">${esc(x.kind)}</span> ${x.isNew ? '<span class="new">NEW</span>' : ''}<b>${x.url ? `<a href="${esc(safe(x.url))}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a>` : esc(x.title)}</b><span class="muted">${esc(x.sub)}</span></div>`).join('') || '<p class="muted">No alerts.</p>';
  }
  v.innerHTML = h;
}
function sheet(html) { $('#sheetbody').innerHTML = html; $('#sheet').classList.remove('hidden'); }
function empDetail(id) {
  const e = tbl('Employees').get(id); if (!e) return;
  const au = authList().filter(x => String(x.StaffID) === id), tr = list('Training').filter(x => String(x.StaffID) === id).sort((a, b) => String(b.TrainingDate).localeCompare(String(a.TrainingDate))), ev = list('Evaluation').filter(x => String(x.StaffID) === id);
  sheet(`<h2>${esc(e.FullName)}</h2><p class="muted">${esc(e.StaffID)} - ${esc(e.JobTitle)}<br>${esc(e.Department)} - ${esc(e.EmploymentStatus)}${e.JoiningDate ? ' - joined ' + esc(e.JoiningDate) : ''}</p>
<h3>Authorizations (${au.length})</h3>${au.map(x => `<div class="row">${pill(x.AuthorizationStatus || '-')} <span class="muted">${esc(x.AuthorizationDate || '')}</span><br>${esc(short(x.MethodName, 110))}</div>`).join('') || '<p class="muted">None</p>'}
<h3>Evaluations (${ev.length})</h3>${ev.map(x => `<div class="row"><b>${esc(x.CompetencyArea)}</b><span class="muted">${esc(x.EvaluationDate)} - ${esc(x.EvaluationType)} - ${esc(x.Result)}</span></div>`).join('') || '<p class="muted">None</p>'}
<h3>Training (${tr.length}, latest 10)</h3>${tr.slice(0, 10).map(x => `<div class="row"><b>${esc(short(x.TrainingTopic, 100))}</b><span class="muted">${esc(x.TrainingDate)} - ${esc(x.Trainer)}</span></div>`).join('') || '<p class="muted">None</p>'}`);
}
function authDetail(id) {
  const x = tbl('Authorization').get(id); if (!x) return;
  const row = (k, v) => v ? `<div class="row"><span class="muted">${k}</span><b>${esc(v)}</b></div>` : '';
  sheet(`<h2>${esc(x.AuthorizationID)} ${pill(x.AuthorizationStatus || '-')}</h2>${row('Employee', empName(x.StaffID) + ' (' + x.StaffID + ')')}${row('Method', x.MethodName)}${row('Method ID / SOP', [x.MethodID, x.SOPID].filter(Boolean).join(' / '))}${row('Instrument', x.InstrumentID)}${row('Authorization date', x.AuthorizationDate)}${row('Authorized by', x.AuthorizedBy)}${row('Training complete', x.TrainingComplete)}${row('Competency evaluation', x.CompetencyEvaluationComplete)}${row('Notes', x.Notes)}`);
}

async function start() {
  show('app'); $('#view').innerHTML = '<p class="muted">Loading...</p>';
  try { await sync(); } catch (e) { if (e.body && e.body.mustChange) return show('chpw'); if (token) $('#view').innerHTML = '<p class="err">' + esc(e.message) + '</p>'; return; }
  clearInterval(timer); timer = setInterval(() => sync().catch(() => { $('#status').textContent = 'Offline'; }), POLL_MS);
}
$('#go').onclick = async () => {
  $('#lerr').textContent = '';
  try { const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#u').value, password: $('#p').value, device: 'phone viewer' }) }); token = r.token; sessionStorage.setItem('edcl.tok', token); $('#p').value = ''; r.mustChange ? show('chpw') : start(); }
  catch (e) { $('#lerr').textContent = e.message; }
};
$('#cg').onclick = async () => {
  $('#cerr').textContent = '';
  try { await api('/api/password', { method: 'POST', body: JSON.stringify({ oldPassword: $('#op').value, newPassword: $('#np').value }) }); $('#op').value = $('#np').value = ''; start(); }
  catch (e) { $('#cerr').textContent = e.message; }
};
$('#out').onclick = () => signOut(false);
$('#close').onclick = () => $('#sheet').classList.add('hidden');
document.querySelectorAll('nav button').forEach(b => b.onclick = () => { tab = b.dataset.t; q = ''; filt = 'All'; if (tab === 'alerts') newWada = new Set(); document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b)); render(); scrollTo(0, 0); });
$('#view').addEventListener('input', e => { if (e.target.id === 'q') { q = e.target.value; const p = e.target.selectionStart; render(); const n = $('#q'); n.focus(); n.setSelectionRange(p, p); } });
$('#view').addEventListener('click', e => {
  const t = e.target.closest('[data-emp],[data-auth],[data-f],#en'); if (!t) return;
  if (t.dataset.emp) empDetail(t.dataset.emp); else if (t.dataset.auth) authDetail(t.dataset.auth);
  else if (t.dataset.f) { filt = t.dataset.f; render(); } else if (t.id === 'en') Notification.requestPermission().then(render);
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch(() => {});
token ? start() : show('login');
})();
