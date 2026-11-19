'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const app = window.serverDashboard;
const state = {
  user: null, mode: 'local', conn: null, metrics: null, roles: [], users: [], audit: [], backups: [],
  serviceRunning: false, view: 'overview', busy: false, ticks: 0, loginAt: 0, online: false, timer: null,
  files: { offset: 0, limit: 50, total: 0 }, notice: { text: '', at: 0 }, checkTimer: null
};
const titles = { overview: 'Overview', sessions: 'Connected users', files: 'Stored files', users: 'Users & roles', backups: 'Backups & recovery', audit: 'Audit log', settings: 'Configuration', logs: 'Server logs' };

// ---------------------------------------------------------------- helpers
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function setNotice(message, kind = '') {
  const notice = $('#notice');
  if (message && state.notice.text === message && Date.now() - state.notice.at < 20000 && !notice.hidden) return;   // do not repeat the same error every refresh
  state.notice = { text: message, at: Date.now() };
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  notice.hidden = !message;
  if (message) window.setTimeout(() => { if (notice.textContent === message) notice.hidden = true; }, 8000);
}
function showModal(id) { $('#' + id).hidden = false; }
function hideModal(id) { $('#' + id).hidden = true; }
function userCan(permission) { return !!(state.user && state.user.perms && state.user.perms[permission]); }
function maySeeStatus() { return userCan('backup') || userCan('users'); }
function isOwner() { return !!(state.user && state.user.role === 'admin'); }
function isLocal() { return state.mode === 'local'; }
async function request(path, method = 'GET', json) {
  let response;
  try { response = await app.request({ path, method, json }); }
  catch (error) {
    if (/Sign in to the server first/.test(error.message) && state.user) sessionLost('Your server session ended. Sign in again.');
    throw new Error(String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
  }
  if (response.status === 401 && state.user) sessionLost('Your server session ended. Sign in again.');
  if (response.status < 200 || response.status >= 300)
    throw new Error(response.json && response.json.error || `Server request failed (HTTP ${response.status})`);
  return response.json;
}
function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes), index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index > 1 ? 1 : index ? 0 : 0)} ${units[index]}`;
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString();
}
function formatDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m} min` : `${sec}s`;
}
function ago(ms) {
  const sec = Math.round((Date.now() - Number(ms)) / 1000);
  if (!Number.isFinite(sec)) return '—';
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}
const num = value => Number(value || 0).toLocaleString();
const hostLabel = () => (state.conn && state.conn.serverUrl ? state.conn.serverUrl.replace(/^https:\/\//, '') : '');

// ---------------------------------------------------------------- views and permissions
function setView(name) {
  if (name !== 'overview' && !state.user) { showModal('login-modal'); return; }
  const nav = $(`.nav-item[data-view="${name}"]`);
  if (nav && nav.hidden) return;
  state.view = name;
  $$('.view').forEach(section => { section.hidden = section.id !== name; });
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#page-title').textContent = titles[name] || titles.overview;
  const loaders = { settings: loadConfig, logs: loadLogs, backups: loadBackups, users: loadUsers, audit: loadAudit, sessions: loadSessions, files: loadFiles };
  if (loaders[name]) loaders[name]().catch(error => setNotice(error.message, 'error'));
}
function setPermissions() {
  $$('.nav-item').forEach(button => {
    const view = button.dataset.view;
    button.hidden = !(view === 'overview' ||
      (['users', 'sessions', 'files'].includes(view) && userCan('users')) ||
      (view === 'backups' && (userCan('backup') || userCan('recover'))) ||
      (view === 'audit' && userCan('audit')) ||
      (['settings', 'logs'].includes(view) && isOwner()));
  });
  $$('[data-service]').forEach(button => {
    button.hidden = !isOwner() || (!isLocal() && button.dataset.service !== 'restart');
  });
  $('#signin-open').hidden = !!state.user;
  $('#account').hidden = !state.user;
  $('#account-name').textContent = state.user ? `${state.user.name || state.user.username} · ${state.user.role.replaceAll('_', ' ')}` : '';
  $('#recover-open').hidden = !isLocal();
}
function sessionLost(message) {
  if (!state.user) return;
  state.user = null; state.metrics = null; state.users = []; state.audit = [];
  setPermissions(); setView('overview'); renderOverview(state.lastHealth || { connected: state.online });
  setNotice(message, 'error');
  showModal('login-modal');
}

// ---------------------------------------------------------------- charts
function drawChart(id, points, pick, cls, fmt) {
  const el = $('#chart-' + id);
  const values = (points || []).map(pick).filter(Number.isFinite);
  if (values.length < 2) {
    el.innerHTML = '<div class="chart-empty">Collecting data…</div>';
    $('#chart-' + id + '-now').textContent = values.length ? fmt(values[values.length - 1]) : '—';
    $('#chart-' + id + '-note').textContent = '';
    return;
  }
  const W = 300, H = 80, max = Math.max(1, ...values) * 1.15;
  const x = i => (i / (values.length - 1)) * W, y = v => H - (v / max) * (H - 4) - 2;
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(id)} over the last hour"><line class="grid-line" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/><path class="area ${cls}" d="${line} L${W} ${H} L0 ${H} Z"/><path class="line ${cls}" d="${line}"/></svg>`;
  $('#chart-' + id + '-now').textContent = fmt(values[values.length - 1]);
  const spanMin = Math.round((points[points.length - 1].t - points[0].t) / 60000);
  $('#chart-' + id + '-note').innerHTML = `<span>peak ${escapeHtml(fmt(Math.max(...values)))}</span><span>last ${spanMin < 1 ? '<1' : spanMin} min</span>`;
}
function meter(label, free, total) {
  if (!total) return '';
  const used = Math.min(100, Math.max(0, (1 - free / total) * 100));
  const level = used > 95 ? 'bad' : used > 90 ? 'warn' : '';
  return `<div class="meter"><div class="meter-top"><span>${escapeHtml(label)}</span><span>${formatBytes(free)} free of ${formatBytes(total)}</span></div><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)} ${used.toFixed(0)}% used"><rect class="fill ${level}" x="0" y="0" width="${used.toFixed(1)}" height="8" rx="2"/></svg></div>`;
}

// ---------------------------------------------------------------- overview
function serviceState(service) {
  const output = `${service.stdout || ''}\n${service.stderr || ''}`;
  if (service.remote) {
    state.serviceRunning = state.online;
    $('#service-state').textContent = state.online ? 'Running (remote)' : 'Not responding';
    $('#service-badge').className = `badge ${state.online ? 'ok' : 'bad'}`;
    $('#service-badge').textContent = state.online ? 'Online' : 'Offline';
    $('#service-sub').textContent = 'Connected remotely - the service is controlled from the server PC';
    return;
  }
  state.serviceRunning = !!(state.online || /Status:\s*Running/i.test(output));
  $('#service-sub').textContent = 'Windows scheduled task and HTTPS endpoint';
  $('#service-state').textContent = state.serviceRunning ? 'Running' : /Status:\s*(Ready|Queued)/i.test(output) ? 'Stopped' : service.code === 0 ? 'Scheduled' : 'Unavailable';
  $('#service-badge').className = `badge ${state.serviceRunning ? 'ok' : service.code === 0 ? 'warn' : 'bad'}`;
  $('#service-badge').textContent = state.serviceRunning ? 'Running' : service.code === 0 ? 'Stopped / idle' : 'Unavailable';
}
function renderAlerts(health, m) {
  const box = $('#alerts');
  const items = [];
  if (health.notConfigured) items.push({ level: 'info', text: 'No server is selected yet. Use "Server connection…" in the sidebar to choose the server to monitor.' });
  else if (!health.connected) items.push({ level: 'bad', text: `The server is not responding${health.error ? ': ' + health.error : ''}.` });
  else if (!state.user) items.push({ level: 'info', text: 'Sign in with a server account to see live monitoring, backups, sessions and activity.' });
  else if (m) {
    for (const a of m.alerts || []) items.push(a);
    if (!items.length) items.push({ level: 'ok', text: 'All checks passed: backups are current, disk space and the certificate are fine, and there are no recent errors.' });
  }
  box.innerHTML = items.map(a => `<div class="alert ${a.level === 'bad' ? 'bad' : a.level === 'ok' ? 'ok' : a.level === 'info' ? 'info' : ''}"><b>${a.level === 'ok' ? '✓' : a.level === 'info' ? 'ℹ' : '!'}</b><span>${escapeHtml(a.text)}</span></div>`).join('');
}
function renderOverview(health) {
  state.lastHealth = health;
  const online = !!health.connected;
  state.online = online;
  const m = state.metrics;
  $('#connection').className = `connection ${online ? 'online' : 'offline'}`;
  $('#connection span').textContent = online ? 'Server online' : health.notConfigured ? 'No server selected' : 'Server offline';
  $('#side-connection').textContent = state.conn && state.conn.serverUrl ? `${isLocal() ? 'This PC' : 'Remote'} · ${hostLabel()}` : 'No server selected';
  $('#endpoint-state').textContent = online ? 'HTTPS responding' : health.error || 'Not responding';
  $('#stat-status').textContent = online ? 'Online' : 'Offline';
  $('#stat-status').classList.toggle('good', online);
  $('#stat-status').classList.toggle('bad', !online);
  $('#stat-version').textContent = health.health ? `Version ${health.health.version}` : 'Awaiting connection';
  $('#version').textContent = health.health ? `EDCL Server ${health.health.version}` : 'EDCL Server Dashboard';
  serviceState(health.service || { code: 1 });
  renderAlerts(health, m);
  if (!m) {
    for (const id of ['records', 'files', 'sessions', 'rpm', 'backup']) $('#stat-' + id).textContent = '—';
    $('#stat-uptime').textContent = $('#stat-seq').textContent = $('#stat-driver').textContent = $('#stat-host').textContent = '—';
    for (const [id, pick, cls, fmt] of CHARTS) drawChart(id, [], pick, cls, fmt);
  } else {
    $('#server-name').textContent = String(m.name || 'CENTRAL LABORATORY SERVER').toUpperCase();
    $('#stat-records').textContent = num(m.counts.records);
    $('#stat-files').textContent = num(m.counts.files);
    $('#stat-files-size').textContent = `${formatBytes(m.storage.fileBytes)} stored`;
    $('#stat-sessions').textContent = num(m.sessions.active);
    $('#stat-users').textContent = `${num(m.counts.users)} accounts · ${num(m.sessions.live)} live`;
    const last = m.series[m.series.length - 1];
    $('#stat-rpm').textContent = last ? num(last.rpm) : '—';
    $('#stat-errors').textContent = `${num(m.requests.total)} requests · ${num(m.requests.errors)} errors since start`;
    $('#stat-backup').textContent = m.backups.last ? ago(Date.parse(m.backups.last.modified)) : 'None';
    $('#stat-backup-note').textContent = m.backups.last ? `${formatBytes(m.backups.last.size)} · ${m.backups.count} kept` : 'No backup yet';
    $('#stat-uptime').textContent = formatDuration(m.uptimeSec);
    $('#stat-seq').textContent = num(m.seq);
    $('#stat-driver').textContent = m.driver;
    $('#stat-host').textContent = `${m.host} · pid ${m.pid}`;
    for (const [id, pick, cls, fmt] of CHARTS) drawChart(id, m.series, pick, cls, fmt);
    renderStorage(m); renderBackupPanel(m); renderSecurity(m); renderWada(m.wada);
    $('#quick-backup').hidden = !userCan('backup');
  }
  if (!state.user) {
    $('#storage').textContent = 'Sign in to view storage.';
    $('#backup-summary').textContent = 'Sign in with an authorized account to see backup history.';
    $('#backup-badge').className = 'badge neutral'; $('#backup-badge').textContent = 'Sign in to view';
    $('#security').textContent = 'Sign in to view.';
    $('#wada-status').textContent = 'Sign in to view monitor status.';
    $('#quick-backup').hidden = true;
  }
  $('#last-updated') && ($('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`);
}
const CHARTS = [
  ['rpm', p => p.rpm, '', v => num(Math.round(v))],
  ['sessions', p => p.sessions, 'b', v => num(Math.round(v))],
  ['ms', p => p.avgMs, 'c', v => v.toFixed(1)],
  ['mem', p => p.rss / 1048576, 'd', v => `${Math.round(v)}`]
];
function renderStorage(m) {
  const s = m.storage;
  $('#storage').innerHTML = `<div class="kv"><div><span>Database</span><b>${formatBytes(s.dbBytes)}${s.walBytes ? ` (+${formatBytes(s.walBytes)} log)` : ''}</b></div><div><span>Uploaded documents</span><b>${formatBytes(s.fileBytes)} · ${num(m.counts.files)} files</b></div><div><span>Deleted files kept</span><b>${num(s.deletedFiles)}</b></div></div>${meter('Database disk', s.dataDisk && s.dataDisk.free, s.dataDisk && s.dataDisk.total)}${s.backupDisk && (!s.dataDisk || s.backupDisk.total !== s.dataDisk.total) ? meter('Backup disk', s.backupDisk.free, s.backupDisk.total) : ''}`;
}
function renderBackupPanel(m) {
  const b = m.backups;
  const level = b.lastRunOk === false ? 'bad' : !b.last ? 'warn' : m.alerts.some(a => a.id === 'backup-stale') ? 'warn' : 'ok';
  $('#backup-badge').className = `badge ${level}`;
  $('#backup-badge').textContent = level === 'ok' ? 'Healthy' : level === 'bad' ? 'Failed' : 'Attention';
  $('#backup-summary').innerHTML = b.last
    ? `<div class="backup-message">Latest backup <strong>${escapeHtml(b.last.file)}</strong><br>${formatBytes(b.last.size)} · ${escapeHtml(formatDate(b.last.modified))} (${escapeHtml(ago(Date.parse(b.last.modified)))})<br>${b.count} kept (limit ${b.keep}) · ${b.intervalMinutes ? `automatic every ${b.intervalMinutes} min` : 'automatic backups off'}</div>`
    : '<div class="backup-message">No verified database backups have been recorded yet.</div>';
}
function renderSecurity(m) {
  const c = m.cert;
  $('#security').innerHTML = `<div class="kv"><div><span>Connection</span><b>${m.tls ? 'HTTPS (encrypted)' : 'Plain HTTP - test only'}</b></div><div><span>Failed sign-ins (1 h)</span><b>${num(m.security.failedLastHour)}</b></div><div><span>Locked accounts</span><b>${num(m.security.lockedAccounts)}</b></div><div><span>Certificate</span><b>${c ? (c.daysLeft < 0 ? 'Expired' : `${c.daysLeft} days left`) : '—'}</b></div></div>`;
}
function renderWada(wada) {
  const box = $('#wada-status');
  if (!wada) { box.textContent = 'No WADA status has been recorded yet.'; return; }
  const failures = (Array.isArray(wada.Sources) ? wada.Sources : []).filter(source => !source.ok);
  box.innerHTML = `<div class="backup-message">Last check: <strong>${escapeHtml(wada.LastCheck ? formatDate(wada.LastCheck) : 'Not reported')}</strong><br>Status: ${escapeHtml(wada.Result || 'Unknown')} · ${Number(wada.Added || 0)} added · ${Number(wada.Changed || 0)} changed</div>` +
    (failures.length ? `<ul class="wada-list">${failures.slice(0, 4).map(source => `<li>${escapeHtml(source.id)}: ${escapeHtml(source.error || 'source unavailable')}</li>`).join('')}</ul>` : '<div class="empty-message">No failed WADA sources reported.</div>');
}
function renderAuditRows(rows, limit = 500) {
  const body = rows.slice(0, limit).map(row => `<tr><td>${escapeHtml(formatDate(row.at))}</td><td>${escapeHtml(row.user || '—')}</td><td><span class="pill">${escapeHtml(row.action || '—')}</span></td><td>${escapeHtml(row.tbl || '—')}</td><td>${escapeHtml(row.rid || '—')}</td><td>${escapeHtml(row.detail || '')}</td></tr>`).join('');
  return `<table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Table</th><th>Record</th><th>Details</th></tr></thead><tbody>${body || '<tr><td class="table-empty" colspan="6">No audit events.</td></tr>'}</tbody></table>`;
}
async function refreshRecentAudit() {
  if (!state.user || !userCan('audit')) { $('#recent-audit').textContent = 'Sign in with audit access to view events.'; return; }
  try {
    state.audit = (await request('/api/admin/audit')).rows || [];
    $('#recent-audit').innerHTML = state.audit.length
      ? `<div class="audit-mini">${state.audit.slice(0, 6).map(row => `<div class="audit-mini-row"><b>${escapeHtml(row.action)} · ${escapeHtml(row.user || '—')}</b><span>${escapeHtml(formatDate(row.at))}</span></div>`).join('')}</div>`
      : '<div class="empty-message">No audit events are available.</div>';
  } catch (error) { $('#recent-audit').textContent = error.message; }
}

// ---------------------------------------------------------------- refresh loop
async function tick(force = false) {
  if (state.busy) return;
  state.busy = true;
  try {
    const health = await app.health({ force });
    state.mode = health.mode || state.mode;
    if (state.user && health.connected && !health.sessionActive && Date.now() - state.loginAt > 4000) sessionLost('Your server session ended. Sign in again.');
    if (state.user && maySeeStatus() && health.connected) {
      try { state.metrics = await request('/api/admin/metrics'); }
      catch (error) { state.metrics = null; setNotice(error.message, 'error'); }
    } else state.metrics = null;
    renderOverview(health);
    state.ticks++;
    if (state.user && health.connected) {
      if (state.view === 'overview' && state.ticks % 3 === 1) refreshRecentAudit();
      if (state.view === 'sessions') loadSessions().catch(error => setNotice(error.message, 'error'));
      if (state.view === 'logs' && $('#logs-follow').checked) loadLogs().catch(() => {});
    }
  } catch (error) { setNotice(error.message, 'error'); }
  finally { state.busy = false; }
}
function schedule() {
  window.clearTimeout(state.timer);
  const interval = Number($('#refresh-interval').value);
  if (interval > 0 && !document.hidden) state.timer = window.setTimeout(async () => { await tick(); schedule(); }, interval);
}

// ---------------------------------------------------------------- users, audit
async function loadUsers() {
  const result = await request('/api/admin/users');
  state.users = result.users || [];
  const roleResult = await request('/api/admin/roles');
  state.roles = roleResult.roles || [];
  const counts = new Map();
  state.users.filter(user => user.active).forEach(user => counts.set(user.role, (counts.get(user.role) || 0) + 1));
  $('#role-summary').innerHTML = state.roles.map(role => `<span class="role-chip">${escapeHtml(role.role.replaceAll('_', ' '))}<b>${counts.get(role.role) || 0}</b></span>`).join('');
  const availableRoles = state.roles.filter(role => isOwner() || role.role !== 'admin');
  $('#user-form select[name="role"]').innerHTML = availableRoles.map(role => `<option value="${escapeHtml(role.role)}">${escapeHtml(role.role.replaceAll('_', ' '))}</option>`).join('');
  $('#user-form select[name="role"]').value = availableRoles.some(role => role.role === 'staff') ? 'staff' : (availableRoles[0] && availableRoles[0].role || '');
  const rows = state.users.map(user => {
    const roleOptions = availableRoles.map(role => `<option value="${escapeHtml(role.role)}" ${role.role === user.role ? 'selected' : ''}>${escapeHtml(role.role.replaceAll('_', ' '))}</option>`).join('');
    const locked = user.lockedUntil > Date.now() ? `Locked until ${escapeHtml(formatDate(user.lockedUntil))}` : user.mustChange ? 'Password change required' : '';
    const canTouch = isOwner() || user.role !== 'admin';
    return `<tr><td><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.username)}${user.staffId ? ` · ${escapeHtml(user.staffId)}` : ''}</small></td><td><span class="pill">${escapeHtml(user.role.replaceAll('_', ' '))}</span></td><td><span class="pill ${user.active ? 'good' : 'bad'}">${user.active ? 'Active' : 'Disabled'}</span><small>${locked}</small></td><td><div class="table-actions">${isOwner() ? `<select class="select" data-user-role="${escapeHtml(user.username)}">${roleOptions}</select>` : ''}${canTouch ? `<button class="button secondary" data-reset="${escapeHtml(user.username)}">Reset password</button><button class="button secondary" data-signout="${escapeHtml(user.username)}">Sign out</button>` : ''}${isOwner() ? `<button class="button ${user.active ? 'danger-outline' : 'secondary'}" data-toggle-user="${escapeHtml(user.username)}" data-active="${user.active ? '1' : '0'}">${user.active ? 'Disable' : 'Enable'}</button>` : ''}</div></td></tr>`;
  }).join('');
  $('#users-table').innerHTML = `<table><thead><tr><th>Name / account</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td class="table-empty" colspan="4">No server accounts.</td></tr>'}</tbody></table>`;
}
async function loadAudit() {
  state.audit = (await request('/api/admin/audit')).rows || [];
  $('#audit-table').innerHTML = renderAuditRows(state.audit);
}

// ---------------------------------------------------------------- connected users
async function loadSessions() {
  const list = (await request('/api/admin/sessions')).sessions || [];
  const users = new Set(list.map(s => s.username));
  $('#sessions-summary').textContent = `${list.length} session(s) · ${users.size} user(s)`;
  const rows = list.map(s => `<tr><td><strong>${escapeHtml(s.name || s.username)}</strong><small>${escapeHtml(s.username)}</small></td><td><span class="pill">${escapeHtml(String(s.role || '—').replaceAll('_', ' '))}</span></td><td>${escapeHtml(s.device || '—')}</td><td>${escapeHtml(formatDate(s.created))}</td><td>${escapeHtml(ago(s.lastSeen))}</td><td>${escapeHtml(formatDate(s.expires))}</td><td>${s.current ? '<span class="pill good">This dashboard</span>' : `<button class="button danger-outline" data-revoke="${escapeHtml(s.id)}" data-user="${escapeHtml(s.username)}">Sign out</button>`}</td></tr>`).join('');
  $('#sessions-table').innerHTML = `<table><thead><tr><th>User</th><th>Role</th><th>Device</th><th>Signed in</th><th>Last activity</th><th>Expires</th><th></th></tr></thead><tbody>${rows || '<tr><td class="table-empty" colspan="7">Nobody is signed in.</td></tr>'}</tbody></table>`;
}

// ---------------------------------------------------------------- files
async function loadFiles() {
  const f = state.files;
  const qs = new URLSearchParams({ limit: String(f.limit), offset: String(f.offset) });
  const q = $('#files-search').value.trim(), cat = $('#files-cat').value;
  if (q) qs.set('q', q);
  if (cat) qs.set('cat', cat);
  if ($('#files-deleted').checked) qs.set('deleted', '1');
  const r = await request('/api/admin/files?' + qs.toString());
  f.total = r.total;
  $('#files-groups').innerHTML = (r.groups || []).map(g => `<span class="role-chip">${escapeHtml(g.g || 'uncategorised')}<b>${num(g.n)}</b> · ${formatBytes(g.b)}</span>`).join('');
  const select = $('#files-cat'), previous = select.value;
  select.innerHTML = '<option value="">All categories</option>' + (r.groups || []).map(g => `<option value="${escapeHtml(g.g)}">${escapeHtml(g.g || 'uncategorised')}</option>`).join('');
  select.value = (r.groups || []).some(g => g.g === previous) ? previous : '';
  const rows = r.files.map(file => `<tr><td><strong>${escapeHtml(file.name || '(no name)')}</strong><small>${escapeHtml(file.code || '')}</small></td><td><span class="pill">${escapeHtml(file.cat)}</span></td><td>${formatBytes(file.size)}</td><td>${escapeHtml(file.createdBy || '—')}<small>${escapeHtml(formatDate(file.createdAt))}</small></td><td class="mono">${escapeHtml(file.sha256.slice(0, 12))}…</td><td>${file.deleted ? `<span class="pill warn">Deleted ${escapeHtml(file.deletedBy || '')}</span>` : file.bytesPresent ? '<span class="pill good">OK</span>' : '<span class="pill bad">Bytes missing</span>'}</td></tr>`).join('');
  $('#files-table').innerHTML = `<table><thead><tr><th>Name</th><th>Category</th><th>Size</th><th>Uploaded</th><th>SHA-256</th><th>State</th></tr></thead><tbody>${rows || '<tr><td class="table-empty" colspan="6">No files match.</td></tr>'}</tbody></table>`;
  const from = r.total ? r.offset + 1 : 0, to = Math.min(r.total, r.offset + r.files.length);
  $('#files-page').textContent = `${from}–${to} of ${num(r.total)}`;
  $('#files-prev').disabled = r.offset <= 0;
  $('#files-next').disabled = r.offset + r.limit >= r.total;
  await loadFileCheck();
}
async function loadFileCheck() {
  const c = await request('/api/admin/files/verify');
  const box = $('#files-check');
  window.clearTimeout(state.checkTimer);
  if (!c.startedAt) { box.hidden = true; $('#verify-files').disabled = false; return; }
  box.hidden = false;
  const pct = c.total ? Math.round(c.done / c.total * 100) : 100;
  const problems = c.missingCount + c.corruptCount;
  const list = [...c.corrupt.map(x => `Damaged: ${escapeHtml(x.name)} (${escapeHtml(x.sha256.slice(0, 12))}…)`), ...c.missing.map(x => `Missing: ${escapeHtml(x.name)} (${escapeHtml(x.sha256.slice(0, 12))}…)`)].slice(0, 12);
  box.innerHTML = `<h3>${c.running ? 'Checking stored files…' : problems ? `Integrity check found ${problems} problem(s)` : 'Integrity check passed - every stored file matches its fingerprint'}</h3>` +
    `<div class="progress"><svg viewBox="0 0 100 8" preserveAspectRatio="none"><rect class="fill" x="0" y="0" width="${pct}" height="8"/></svg></div>` +
    `<div class="muted">${num(c.done)} of ${num(c.total)} files · ${formatBytes(c.bytes)} read · ${c.running ? 'started' : 'finished'} ${escapeHtml(formatDate(c.finishedAt || c.startedAt))}${c.by ? ' · by ' + escapeHtml(c.by) : ''}</div>` +
    (list.length ? `<ul>${list.map(x => `<li>${x}</li>`).join('')}</ul><div class="muted">Restore the missing or damaged files from a backup (the backup folder keeps a copy of every uploaded document).</div>` : '');
  $('#verify-files').disabled = !!c.running;
  if (c.running) state.checkTimer = window.setTimeout(() => loadFileCheck().catch(() => {}), 1000);
}

// ---------------------------------------------------------------- backups, configuration, logs
async function loadBackups() {
  state.backups = await app.backups.list();
  const rows = state.backups.map(backup => `<tr><td><strong>${escapeHtml(backup.file)}</strong><small>${escapeHtml(formatDate(backup.modified))} · ${escapeHtml(ago(Date.parse(backup.modified)))}</small></td><td>${formatBytes(backup.size)}</td><td><div class="table-actions">${userCan('recover') || userCan('backup') ? `<button class="button secondary" data-verify="${escapeHtml(backup.file)}">Verify</button>` : ''}${isOwner() && isLocal() ? `<button class="button danger-outline" data-restore="${escapeHtml(backup.file)}" ${state.serviceRunning ? 'disabled title="Stop the server first"' : ''}>Restore</button>` : ''}</div></td></tr>`).join('');
  $('#import-backup').hidden = !isOwner() || !isLocal();
  $('#create-backup').hidden = !userCan('backup');
  $('#backup-dir').textContent = state.metrics ? `Backup folder: ${state.metrics.storage.backupDir}${isLocal() ? '' : ' (on the server)'}` : '';
  $('#backups-table').innerHTML = `<table><thead><tr><th>Backup file</th><th>Size</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td class="table-empty" colspan="3">No backups found in the configured backup folder.</td></tr>'}</tbody></table>`;
}
async function loadConfig() {
  const config = await app.config.get();
  let certificate = null;
  if (isLocal()) {
    try { certificate = await app.certificates.get(); }
    catch (error) { setNotice(`Certificate details unavailable: ${error.message}`, 'error'); }
  }
  const form = $('#config-form');
  for (const key of ['serverName', 'backupDir', 'backupMinutes', 'keepBackups', 'wadaHours', 'maxFileMB']) form.elements[key].value = config[key] ?? '';
  $('#config-note').textContent = config.live ? 'Changes are applied immediately - no restart needed.' : 'The server is not reachable, so changes are saved to its settings file and apply after it starts.';
  $('#config-host').textContent = config.host;
  $('#config-port').textContent = config.port;
  $('#config-data').textContent = config.dataDir;
  const cert = certificate ? { when: certificate.serverNotAfter, fp: certificate.serverFingerprint } : state.metrics && state.metrics.cert ? { when: state.metrics.cert.validTo, fp: state.metrics.cert.fingerprint256 } : null;
  $('#cert-expiry').textContent = cert ? formatDate(cert.when) : isLocal() ? 'Run dashboard as administrator' : 'Not available';
  $('#cert-fingerprint').textContent = cert && cert.fp ? `SHA-256: ${cert.fp}` : '';
  $('#renew-cert').hidden = !isLocal();
  $('#open-client-config').closest('.read-only').hidden = !isLocal();
}
async function loadLogs() {
  const result = await app.logs();
  const out = $('#log-output');
  const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
  $('#log-name').textContent = result.file || 'No server log found';
  out.textContent = result.lines.join('\n') || 'No log entries.';
  if (atEnd || !state.logsLoaded) out.scrollTop = out.scrollHeight;
  state.logsLoaded = true;
}

// ---------------------------------------------------------------- dialogs and actions
function generatePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function showSecret(title, password) {
  $('#secret-title').textContent = title;
  $('#secret-value').textContent = password;
  $('#copy-secret').textContent = 'Copy password';
  showModal('secret-modal');
}
function showActionResult(label, result) {
  const text = result.stdout || result.stderr || `${label} completed`;
  if (Number(result.code) !== 0) setNotice(`${label} returned code ${result.code}: ${text}`, 'error');
  else setNotice(`${label} completed: ${text}`, 'success');
}
async function doBackup() {
  const result = await request('/api/admin/backup', 'POST', {});
  setNotice(`Verified backup created: ${String(result.file).split(/[\\/]/).pop()} (${formatBytes(result.size)}).`, 'success');
  await tick();
  if (state.view === 'backups') await loadBackups();
}
async function completeLogin(result) {
  state.user = result.json.user;
  state.loginAt = Date.now();
  setPermissions();
  if (result.json.mustChange) { showModal('password-modal'); return; }
  setView('overview');
  await tick(true);
  refreshRecentAudit();
}
async function checkSetup() {
  if (!state.conn || !state.conn.serverUrl) return;
  const s = await app.setup.state();
  if (s && s.needsOwner) showModal('setup-modal');   // the server itself only accepts this from the server PC and says so if not
}
async function loadConnection() {
  state.conn = await app.connection.get();
  state.mode = state.conn.mode;
}
function openConnection() {
  const c = state.conn || {};
  const form = $('#connection-form');
  form.elements.mode.forEach(r => { r.checked = r.value === (c.mode || 'remote'); if (r.value === 'local') r.disabled = !c.localAvailable; });
  form.elements.serverUrl.value = c.mode === 'remote' ? c.serverUrl : '';
  $('#ca-info').textContent = c.mode === 'remote' && c.fingerprint ? `Saved certificate ${c.fingerprint}` : 'No certificate chosen';
  $('#connection-error').textContent = '';
  $('#remote-fields').hidden = form.elements.mode.value !== 'remote';
  showModal('connection-modal');
}

$('#navigation').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) setView(button.dataset.view);
});
$$('[data-close]').forEach(button => button.addEventListener('click', () => hideModal(button.dataset.close)));
$('#signin-open').addEventListener('click', () => showModal('login-modal'));
$('#refresh').addEventListener('click', async () => {
  try { await tick(true); if (state.user) { const v = $(`.nav-item[data-view="${state.view}"]`); if (state.view !== 'overview' && v) setView(state.view); } }
  catch (error) { setNotice(error.message, 'error'); }
});
$('#refresh-interval').addEventListener('change', () => {
  try { localStorage.setItem('edcl-dash-interval', $('#refresh-interval').value); } catch { /* optional */ }
  schedule();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); } schedule(); });
$('#signout').addEventListener('click', async () => {
  try { await app.logout(); } catch (error) { setNotice(error.message, 'error'); }
  state.user = null; state.metrics = null; state.users = []; state.audit = [];
  setPermissions(); setView('overview'); await tick(true);
  setNotice('You have signed out of the server.', 'success');
});

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $('#login-error');
  errorBox.textContent = '';
  let result;
  try { result = await app.login({ username: form.elements.username.value, password: form.elements.password.value }); }
  catch (error) { errorBox.textContent = error.message; return; }
  if (result.status !== 200 || !result.json.user) {
    errorBox.textContent = result.json && result.json.error || 'Sign in failed.';
    return;
  }
  form.reset();
  hideModal('login-modal');
  await completeLogin(result);
});
$('#password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $('#password-error');
  errorBox.textContent = '';
  if (form.elements.newPassword.value !== form.elements.confirmPassword.value) {
    errorBox.textContent = 'The new passwords do not match.';
    return;
  }
  let result;
  try { result = await app.changePassword({ oldPassword: form.elements.oldPassword.value, newPassword: form.elements.newPassword.value }); }
  catch (error) { errorBox.textContent = error.message; return; }
  if (result.status !== 200) { errorBox.textContent = result.json && result.json.error || 'Password change failed.'; return; }
  form.reset();
  hideModal('password-modal');
  setView('overview');
  await tick(true);
  setNotice('Your password has been changed.', 'success');
});
$('#setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, errorBox = $('#setup-error');
  errorBox.textContent = '';
  if (form.elements.password.value !== form.elements.confirm.value) { errorBox.textContent = 'The passwords do not match.'; return; }
  const username = form.elements.username.value.trim().toLowerCase(), password = form.elements.password.value;
  try {
    const created = await app.setup.createOwner({ username, name: form.elements.name.value.trim(), password });
    if (created.status !== 200) throw new Error(created.json && created.json.error || 'The administrator could not be created.');
    const login = await app.login({ username, password });
    if (login.status !== 200 || !login.json.user) throw new Error('The administrator was created, but signing in failed. Sign in manually.');
    form.reset();
    hideModal('setup-modal');
    await completeLogin(login);
    setNotice(`Administrator "${username}" created. You are signed in.`, 'success');
  } catch (error) { errorBox.textContent = error.message; }
});

$('#connection-open').addEventListener('click', openConnection);
$('#connection-form').addEventListener('change', event => {
  if (event.target.name === 'mode') $('#remote-fields').hidden = event.target.value !== 'remote';
});
$('#choose-ca').addEventListener('click', async () => {
  const errorBox = $('#connection-error');
  errorBox.textContent = '';
  try {
    const info = await app.connection.chooseCa();
    if (info.canceled) return;
    $('#ca-info').textContent = `${info.subject} · SHA-256 ${info.fingerprint}${info.isCa ? '' : ' (this is not a CA certificate)'}`;
  } catch (error) { errorBox.textContent = error.message; }
});
$('#connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, errorBox = $('#connection-error');
  errorBox.textContent = '';
  try {
    await app.connection.save({ mode: form.elements.mode.value, serverUrl: form.elements.serverUrl.value });
    hideModal('connection-modal');
    state.user = null; state.metrics = null;
    await loadConnection();
    setPermissions(); setView('overview'); await tick(true);
    setNotice('Server connection saved.', 'success');
    await checkSetup();
  } catch (error) { errorBox.textContent = String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''); }
});
$('#recover-open').addEventListener('click', () => { hideModal('login-modal'); $('#recover-error').textContent = ''; showModal('recover-modal'); });
$('#recover-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, errorBox = $('#recover-error');
  errorBox.textContent = '';
  const username = form.elements.username.value.trim().toLowerCase();
  if (!window.confirm(`Reset the password for "${username}"? Their sessions will end and they must choose a new password at the next sign-in.`)) return;
  try {
    const result = await app.setup.recoverOwner({ username });
    form.reset();
    hideModal('recover-modal');
    showSecret(`One-time password for ${result.username}`, result.password);
  } catch (error) { errorBox.textContent = String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''); }
});

$$('[data-service]').forEach(button => button.addEventListener('click', async () => {
  const action = button.dataset.service;
  if (action === 'stop' && !window.confirm('Stop the EDCL server? Connected workstations will be disconnected.')) return;
  if (action === 'restart' && !window.confirm('Restart the EDCL server? Connected workstations will be disconnected briefly.')) return;
  try {
    const result = await app.service(action);
    showActionResult(`Server ${action}`, result);
    await new Promise(resolve => window.setTimeout(resolve, action === 'stop' ? 1000 : 3000));
    await tick(true);
    if (state.view === 'backups') await loadBackups();
  } catch (error) { setNotice(error.message, 'error'); }
}));
$('#quick-backup').addEventListener('click', async () => {
  try { await doBackup(); } catch (error) { setNotice(error.message, 'error'); }
});
$('#create-backup').addEventListener('click', async () => {
  try { await doBackup(); } catch (error) { setNotice(error.message, 'error'); }
});
$('#import-backup').addEventListener('click', async () => {
  if (state.serviceRunning) { setNotice('Stop the server before importing a desktop backup.', 'error'); return; }
  if (!window.confirm('Import is allowed only into an empty server database. Continue to choose the EDCL JSON backup?')) return;
  try {
    const result = await app.backups.import();
    if (result.canceled) return;
    showActionResult('Desktop backup import', result);
    await tick(true);
  } catch (error) { setNotice(error.message, 'error'); }
});
$('#backups-table').addEventListener('click', async event => {
  const verify = event.target.closest('[data-verify]');
  const restore = event.target.closest('[data-restore]');
  if (verify) {
    try { showActionResult('Backup verification', await app.backups.verify(verify.dataset.verify)); }
    catch (error) { setNotice(error.message, 'error'); }
  } else if (restore) {
    if (state.serviceRunning) { setNotice('Stop the server before restoring a backup.', 'error'); return; }
    if (!window.confirm(`Restore ${restore.dataset.restore}? The current database will be preserved in a pre-restore folder.`)) return;
    try {
      const result = await app.backups.restore(restore.dataset.restore);
      showActionResult('Backup restore', result);
      if ([0, 3].includes(Number(result.code))) {
        state.user = null; state.metrics = null;
        setPermissions(); setView('overview'); await tick(true);
        showModal('login-modal');
      }
    } catch (error) { setNotice(error.message, 'error'); }
  }
});
$('#create-user-open').addEventListener('click', async () => {
  try { await loadUsers(); showModal('user-modal'); } catch (error) { setNotice(error.message, 'error'); }
});
$('#user-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const password = generatePassword();
  $('#user-error').textContent = '';
  try {
    const result = await request('/api/admin/users', 'POST', {
      username: form.elements.username.value.trim().toLowerCase(),
      name: form.elements.name.value.trim(),
      staffId: form.elements.staffId.value.trim(),
      role: form.elements.role.value,
      password
    });
    if (!result.ok) throw new Error('The server did not create the user.');
    const username = form.elements.username.value.trim().toLowerCase();
    form.reset();
    hideModal('user-modal');
    showSecret(`One-time password for ${username}`, password);
    await loadUsers();
  } catch (error) { $('#user-error').textContent = error.message; }
});
$('#users-table').addEventListener('click', async event => {
  const reset = event.target.closest('[data-reset]');
  const toggle = event.target.closest('[data-toggle-user]');
  const signout = event.target.closest('[data-signout]');
  try {
    if (reset) {
      const username = reset.dataset.reset;
      if (!window.confirm(`Reset the password for ${username}? Their existing sessions will be signed out.`)) return;
      const password = generatePassword();
      await request(`/api/admin/users/${encodeURIComponent(username)}/reset`, 'POST', { password });
      showSecret(`One-time password for ${username}`, password);
      await loadUsers();
    } else if (signout) {
      const username = signout.dataset.signout;
      if (!window.confirm(`Sign ${username} out of every device now?`)) return;
      await request(`/api/admin/users/${encodeURIComponent(username)}/signout`, 'POST', {});
      setNotice(`${username} has been signed out.`, 'success');
    } else if (toggle) {
      const username = toggle.dataset.toggleUser;
      const active = toggle.dataset.active !== '1';
      if (!window.confirm(`${active ? 'Enable' : 'Disable'} ${username}?`)) return;
      await request(`/api/admin/users/${encodeURIComponent(username)}/active`, 'POST', { active });
      await loadUsers();
    }
  } catch (error) { setNotice(error.message, 'error'); }
});
$('#users-table').addEventListener('change', async event => {
  const select = event.target.closest('[data-user-role]');
  if (!select) return;
  const username = select.dataset.userRole;
  try {
    await request(`/api/admin/users/${encodeURIComponent(username)}/role`, 'POST', { role: select.value });
    await loadUsers();
    setNotice(`Updated the role for ${username}.`, 'success');
  } catch (error) { setNotice(error.message, 'error'); await loadUsers(); }
});
$('#sessions-table').addEventListener('click', async event => {
  const revoke = event.target.closest('[data-revoke]');
  if (!revoke) return;
  if (!window.confirm(`Sign ${revoke.dataset.user} out of this device now? Unsaved work on that workstation may be lost.`)) return;
  try { await request('/api/admin/sessions/revoke', 'POST', { id: revoke.dataset.revoke }); await loadSessions(); setNotice('The session was ended.', 'success'); }
  catch (error) { setNotice(error.message, 'error'); await loadSessions().catch(() => {}); }
});
let searchTimer = null;
$('#files-search').addEventListener('input', () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { state.files.offset = 0; loadFiles().catch(e => setNotice(e.message, 'error')); }, 300); });
for (const id of ['#files-cat', '#files-deleted']) $(id).addEventListener('change', () => { state.files.offset = 0; loadFiles().catch(e => setNotice(e.message, 'error')); });
$('#files-prev').addEventListener('click', () => { state.files.offset = Math.max(0, state.files.offset - state.files.limit); loadFiles().catch(e => setNotice(e.message, 'error')); });
$('#files-next').addEventListener('click', () => { state.files.offset += state.files.limit; loadFiles().catch(e => setNotice(e.message, 'error')); });
$('#verify-files').addEventListener('click', async () => {
  try { $('#verify-files').disabled = true; await request('/api/admin/files/verify', 'POST', {}); await loadFileCheck(); }
  catch (error) { $('#verify-files').disabled = false; setNotice(error.message, 'error'); }
});
$('#config-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const changes = Object.fromEntries(['serverName', 'backupDir', 'backupMinutes', 'keepBackups', 'wadaHours', 'maxFileMB'].map(key => [key, form.elements[key].value]));
  try {
    const r = await app.config.save(changes);
    setNotice(r && r.live ? 'Configuration saved and applied.' : 'Configuration saved. Restart the server to apply the changes.', 'success');
    await tick(true);
  } catch (error) { setNotice(String(error.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''), 'error'); }
});
$('#open-client-config').addEventListener('click', async () => {
  try { await app.openClientConfig(); } catch (error) { setNotice(error.message, 'error'); }
});
$('#renew-cert').addEventListener('click', async () => {
  if (!window.confirm('Renew the server certificate using its existing trusted CA and restart the server now? Connected workstations will be disconnected briefly.')) return;
  try {
    const result = await app.certificates.renew();
    state.user = null; state.metrics = null;
    setPermissions(); setView('overview');
    if (Number(result.renewal.code) !== 0) {
      showActionResult('Certificate renewal', result.renewal);
      return;
    }
    if (!result.service || Number(result.service.code) !== 0) {
      showActionResult('Server restart after certificate renewal', result.service || { code: 1, stderr: 'The service did not restart' });
      setNotice('The certificate was renewed, but the server restart needs attention. Sign in again after the server is available.', 'error');
    } else {
      setNotice('The server certificate was renewed and the service restarted. Sign in again to continue.', 'success');
    }
    await tick(true);
    showModal('login-modal');
  } catch (error) { setNotice(error.message, 'error'); }
});
$('#refresh-logs').addEventListener('click', async () => {
  try { await loadLogs(); } catch (error) { setNotice(error.message, 'error'); }
});
$('#copy-secret').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#secret-value').textContent);
    $('#copy-secret').textContent = 'Copied';
  } catch (error) { setNotice(`Could not copy the password: ${error.message}`, 'error'); }
});
$('#secret-modal').addEventListener('click', event => {
  if (event.target.dataset.close === 'secret-modal') hideModal('secret-modal');
});

async function start() {
  try { const saved = localStorage.getItem('edcl-dash-interval'); if (saved && [...$('#refresh-interval').options].some(o => o.value === saved)) $('#refresh-interval').value = saved; } catch { /* optional */ }
  setPermissions();
  try { await loadConnection(); } catch (error) { setNotice(error.message, 'error'); }
  setPermissions();
  await tick(true);
  if (state.conn && !state.conn.serverUrl) openConnection();
  else { try { await checkSetup(); } catch (error) { setNotice(error.message, 'error'); } }
  schedule();
}
start();
