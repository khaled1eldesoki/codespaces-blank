'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const app = window.serverDashboard;
const state = { user: null, status: null, roles: [], users: [], audit: [], backups: [], serviceRunning: false, timer: null };
const titles = { overview: 'Overview', users: 'Users & roles', backups: 'Backups & recovery', audit: 'Audit log', settings: 'Configuration', logs: 'Server logs' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function setNotice(message, kind = '') {
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  notice.hidden = !message;
  if (message) window.setTimeout(() => { if (notice.textContent === message) notice.hidden = true; }, 8000);
}
function showModal(id) { $('#' + id).hidden = false; }
function hideModal(id) { $('#' + id).hidden = true; }
function userCan(permission) { return !!(state.user && state.user.perms && state.user.perms[permission]); }
function maySeeStatus() { return userCan('backup') || userCan('users'); }
function isOwner() { return state.user && state.user.role === 'admin'; }
function request(path, method = 'GET', json) {
  return app.request({ path, method, json }).then(response => {
    if (response.status < 200 || response.status >= 300)
      throw new Error(response.json && response.json.error || `Server request failed (HTTP ${response.status})`);
    return response.json;
  });
}
function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes))) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes), index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString();
}
function setView(name) {
  if (name !== 'overview' && !state.user) { showModal('login-modal'); return; }
  const nav = $(`.nav-item[data-view="${name}"]`);
  if (nav && nav.hidden) return;
  $$('.view').forEach(section => { section.hidden = section.id !== name; });
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#page-title').textContent = titles[name] || titles.overview;
  const load = name === 'settings' ? loadConfig : name === 'logs' ? loadLogs : name === 'backups' ? loadBackups : name === 'users' ? loadUsers : name === 'audit' ? loadAudit : null;
  if (load) load().catch(error => setNotice(error.message, 'error'));
}
function setPermissions() {
  $$('.nav-item').forEach(button => {
    const view = button.dataset.view;
    const visible = view === 'overview' ||
      (view === 'users' && userCan('users')) ||
      (view === 'backups' && (userCan('backup') || userCan('recover'))) ||
      (view === 'audit' && userCan('audit')) ||
      (['settings', 'logs'].includes(view) && isOwner());
    button.hidden = !visible;
  });
  $$('[data-service]').forEach(button => { button.hidden = !isOwner(); });
  $('#signin-open').hidden = !!state.user;
  $('#account').hidden = !state.user;
  $('#account-name').textContent = state.user ? `${state.user.name || state.user.username} · ${state.user.role}` : '';
}
function serviceState(service) {
  const output = `${service.stdout || ''}\n${service.stderr || ''}`;
  state.serviceRunning = !!(state.healthOnline || /Status:\s*Running/i.test(output));
  $('#service-state').textContent = state.serviceRunning ? 'Running' : /Status:\s*(Ready|Queued)/i.test(output) ? 'Stopped' : service.code === 0 ? 'Scheduled' : 'Unavailable';
  $('#service-badge').className = `badge ${state.serviceRunning ? 'ok' : service.code === 0 ? 'warn' : 'bad'}`;
  $('#service-badge').textContent = state.serviceRunning ? 'Running' : service.code === 0 ? 'Stopped / idle' : 'Unavailable';
}
function renderOverview(health) {
  const online = !!health.connected;
  state.healthOnline = online;
  $('#connection').className = `connection ${online ? 'online' : 'offline'}`;
  $('#connection span').textContent = online ? 'Server online' : 'Server offline';
  $('#endpoint-state').textContent = online ? 'HTTPS responding' : health.error || 'Not responding';
  $('#stat-status').textContent = online ? 'Online' : 'Offline';
  $('#stat-status').classList.toggle('good', online);
  $('#stat-status').classList.toggle('bad', !online);
  $('#stat-version').textContent = health.health ? `Version ${health.health.version}` : 'Awaiting connection';
  $('#version').textContent = health.health ? `EDCL Server ${health.health.version}` : 'EDCL Server Dashboard';
  $('#stat-driver').textContent = state.status ? state.status.driver : '—';
  $('#stat-seq').textContent = state.status ? Number(state.status.seq).toLocaleString() : '—';
  serviceState(health.service || { code: 1 });
  if (state.status) {
    $('#stat-records').textContent = Number(state.status.records).toLocaleString();
    $('#stat-files').textContent = Number(state.status.files).toLocaleString();
    $('#stat-sessions').textContent = Number(state.status.sessions).toLocaleString();
    $('#stat-users').textContent = `${Number(state.status.users).toLocaleString()} active accounts`;
    const backups = state.status.backups || [];
    $('#backup-badge').className = `badge ${backups.length ? 'ok' : 'warn'}`;
    $('#backup-badge').textContent = `${backups.length} recent`;
    $('#backup-summary').innerHTML = backups.length
      ? `<div class="backup-message">Latest backup <strong>${escapeHtml(backups[backups.length - 1].file)}</strong><br>${formatBytes(backups[backups.length - 1].size)} · ${backups.length} recent snapshot(s)</div>`
      : '<div class="backup-message">No verified database backups have been recorded yet.</div>';
    $('#quick-backup').hidden = !userCan('backup');
    renderWada(state.status.wada);
  }
  $('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}
function renderWada(wada) {
  const box = $('#wada-status');
  if (!wada) { box.textContent = 'No WADA status has been recorded yet.'; return; }
  const updated = wada.LastCheck;
  const failures = (Array.isArray(wada.Sources) ? wada.Sources : []).filter(source => !source.ok);
  box.innerHTML = `<div class="backup-message">Last check: <strong>${escapeHtml(updated ? formatDate(updated) : 'Not reported')}</strong><br>Status: ${escapeHtml(wada.Result || 'Unknown')} · ${Number(wada.Added || 0)} added · ${Number(wada.Changed || 0)} changed</div>` +
    (failures.length ? `<ul class="wada-list">${failures.slice(0, 4).map(source => `<li>${escapeHtml(source.id)}: ${escapeHtml(source.error || 'source unavailable')}</li>`).join('')}</ul>` : '<div class="empty-message">No failed WADA sources reported.</div>');
}
function renderAuditRows(rows, limit = 500) {
  const body = rows.slice(0, limit).map(row => `<tr><td>${escapeHtml(formatDate(row.at))}</td><td>${escapeHtml(row.user || '—')}</td><td><span class="pill">${escapeHtml(row.action || '—')}</span></td><td>${escapeHtml(row.tbl || '—')}</td><td>${escapeHtml(row.rid || '—')}</td><td>${escapeHtml(row.detail || '')}</td></tr>`).join('');
  return `<table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Table</th><th>Record</th><th>Details</th></tr></thead><tbody>${body || '<tr><td class="table-empty" colspan="6">No audit events.</td></tr>'}</tbody></table>`;
}
async function refreshDashboard() {
  const health = await app.health();
  if (state.user && maySeeStatus()) {
    try { state.status = await request('/api/admin/status'); }
    catch (error) { setNotice(error.message, 'error'); }
  } else state.status = null;
  renderOverview(health);
  if (state.status && userCan('audit')) {
    try {
      state.audit = (await request('/api/admin/audit')).rows || [];
      $('#recent-audit').innerHTML = state.audit.length
        ? `<div class="audit-mini">${state.audit.slice(0, 5).map(row => `<div class="audit-mini-row"><b>${escapeHtml(row.action)} · ${escapeHtml(row.user)}</b><span>${escapeHtml(formatDate(row.at))}</span></div>`).join('')}</div>`
        : '<div class="empty-message">No audit events are available.</div>';
    } catch (error) { $('#recent-audit').textContent = error.message; }
  }
}
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
    const roleOptions = state.roles.filter(role => isOwner() || role.role !== 'admin')
      .map(role => `<option value="${escapeHtml(role.role)}" ${role.role === user.role ? 'selected' : ''}>${escapeHtml(role.role.replaceAll('_', ' '))}</option>`).join('');
    const locked = user.lockedUntil > Date.now() ? `Locked until ${escapeHtml(formatDate(user.lockedUntil))}` : user.mustChange ? 'Password change required' : '';
    return `<tr><td><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.username)}${user.staffId ? ` · ${escapeHtml(user.staffId)}` : ''}</small></td><td><span class="pill">${escapeHtml(user.role.replaceAll('_', ' '))}</span></td><td><span class="pill ${user.active ? 'good' : 'bad'}">${user.active ? 'Active' : 'Disabled'}</span><small>${locked}</small></td><td><div class="table-actions">${isOwner() ? `<select class="select" data-user-role="${escapeHtml(user.username)}">${roleOptions}</select>` : ''}<button class="button secondary" data-reset="${escapeHtml(user.username)}">Reset password</button>${isOwner() ? `<button class="button ${user.active ? 'danger-outline' : 'secondary'}" data-toggle-user="${escapeHtml(user.username)}" data-active="${user.active ? '1' : '0'}">${user.active ? 'Disable' : 'Enable'}</button>` : ''}</div></td></tr>`;
  }).join('');
  $('#users-table').innerHTML = `<table><thead><tr><th>Name / account</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td class="table-empty" colspan="4">No server accounts.</td></tr>'}</tbody></table>`;
}
async function loadAudit() {
  state.audit = (await request('/api/admin/audit')).rows || [];
  $('#audit-table').innerHTML = renderAuditRows(state.audit);
}
async function loadBackups() {
  state.backups = await app.backups.list();
  const rows = state.backups.map(backup => `<tr><td><strong>${escapeHtml(backup.file)}</strong><small>${escapeHtml(formatDate(backup.modified))}</small></td><td>${formatBytes(backup.size)}</td><td><div class="table-actions">${userCan('recover') || userCan('backup') ? `<button class="button secondary" data-verify="${escapeHtml(backup.file)}">Verify</button>` : ''}${isOwner() ? `<button class="button danger-outline" data-restore="${escapeHtml(backup.file)}" ${state.serviceRunning ? 'disabled' : ''}>Restore</button>` : ''}</div></td></tr>`).join('');
  $('#import-backup').hidden = !isOwner();
  $('#create-backup').hidden = !userCan('backup');
  $('#backups-table').innerHTML = `<table><thead><tr><th>Backup file</th><th>Size</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td class="table-empty" colspan="3">No backups found in the configured backup folder.</td></tr>'}</tbody></table>`;
}
async function loadConfig() {
  const config = await app.config.get();
  let certificate = null;
  try { certificate = await app.certificates.get(); }
  catch (error) { setNotice(`Certificate details unavailable: ${error.message}`, 'error'); }
  const form = $('#config-form');
  for (const key of ['serverName', 'backupDir', 'backupMinutes', 'keepBackups', 'wadaHours', 'maxFileMB']) form.elements[key].value = config[key] ?? '';
  $('#config-host').textContent = config.host;
  $('#config-port').textContent = config.port;
  $('#config-data').textContent = config.dataDir;
  $('#cert-expiry').textContent = certificate ? formatDate(certificate.serverNotAfter) : 'Run dashboard as administrator';
  $('#cert-fingerprint').textContent = certificate && certificate.serverFingerprint ? `SHA-256: ${certificate.serverFingerprint}` : '';
}
async function loadLogs() {
  const result = await app.logs();
  $('#log-name').textContent = result.file || 'No server log found';
  $('#log-output').textContent = result.lines.join('\n') || 'No log entries.';
  $('#log-output').scrollTop = $('#log-output').scrollHeight;
}
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
  setNotice(`Verified backup created: ${result.file} (${formatBytes(result.size)}).`, 'success');
  await refreshDashboard();
  if (!$('#backups').hidden) await loadBackups();
}

$('#navigation').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) setView(button.dataset.view);
});
$$('[data-close]').forEach(button => button.addEventListener('click', () => hideModal(button.dataset.close)));
$('#signin-open').addEventListener('click', () => showModal('login-modal'));
$('#refresh').addEventListener('click', async () => {
  try { await refreshDashboard(); if (!$('#backups').hidden && state.user) await loadBackups(); }
  catch (error) { setNotice(error.message, 'error'); }
});
$('#signout').addEventListener('click', async () => {
  try { await app.logout(); } catch (error) { setNotice(error.message, 'error'); }
  state.user = null; state.status = null; state.users = []; state.audit = [];
  setPermissions(); setView('overview'); await refreshDashboard();
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
  state.user = result.json.user;
  form.reset();
  hideModal('login-modal');
  setPermissions();
  if (result.json.mustChange) {
    showModal('password-modal');
    return;
  }
  await refreshDashboard();
  setView('overview');
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
  await refreshDashboard();
  setNotice('Your password has been changed.', 'success');
});

$$('[data-service]').forEach(button => button.addEventListener('click', async () => {
  const action = button.dataset.service;
  if (action === 'stop' && !window.confirm('Stop the EDCL server? Connected workstations will be disconnected.')) return;
  if (action === 'restart' && !window.confirm('Restart the EDCL server? Connected workstations will be disconnected briefly.')) return;
  try {
    const result = await app.service(action);
    showActionResult(`Server ${action}`, result);
    await new Promise(resolve => window.setTimeout(resolve, action === 'stop' ? 1000 : 3000));
    await refreshDashboard();
    if (!$('#backups').hidden) await loadBackups();
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
    await refreshDashboard();
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
        state.user = null;
        state.status = null;
        setPermissions();
        setView('overview');
        await refreshDashboard();
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
  try {
    if (reset) {
      const username = reset.dataset.reset;
      if (!window.confirm(`Reset the password for ${username}? Their existing sessions will be signed out.`)) return;
      const password = generatePassword();
      await request(`/api/admin/users/${encodeURIComponent(username)}/reset`, 'POST', { password });
      showSecret(`One-time password for ${username}`, password);
      await loadUsers();
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
$('#config-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const changes = Object.fromEntries(['serverName', 'backupDir', 'backupMinutes', 'keepBackups', 'wadaHours', 'maxFileMB'].map(key => [key, form.elements[key].value]));
  try {
    await app.config.save(changes);
    setNotice('Configuration saved. Restart the server to apply the changes.', 'success');
  } catch (error) { setNotice(error.message, 'error'); }
});
$('#open-client-config').addEventListener('click', async () => {
  try { await app.openClientConfig(); } catch (error) { setNotice(error.message, 'error'); }
});
$('#renew-cert').addEventListener('click', async () => {
  if (!window.confirm('Renew the server certificate using its existing trusted CA and restart the server now? Connected workstations will be disconnected briefly.')) return;
  try {
    const result = await app.certificates.renew();
    state.user = null;
    state.status = null;
    setPermissions();
    setView('overview');
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
    await refreshDashboard();
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
  setPermissions();
  try { await refreshDashboard(); } catch (error) { setNotice(error.message, 'error'); }
  state.timer = window.setInterval(() => refreshDashboard().catch(error => setNotice(error.message, 'error')), 10000);
}
start();
