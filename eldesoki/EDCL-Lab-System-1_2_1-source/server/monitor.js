'use strict';
// Live server metrics for the administration dashboard: request counters, a one-hour time series sampled every
// 10 seconds, an in-memory log ring and helpers that describe disk/certificate health. Nothing here is persisted.
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const SAMPLE_MS = 10000, KEEP_POINTS = 360, KEEP_LOGS = 1000;

function createMonitor() {
  const startedAt = Date.now();
  let total = 0, errors = 0;
  const byStatus = {};
  let win = { req: 0, err: 0, ms: 0, max: 0 };
  let cpuPrev = process.cpuUsage(), lastSample = Date.now(), lastCpu = 0;
  const series = [], logs = [];
  let timer = null;

  const track = (status, ms) => {
    total++; win.req++; win.ms += ms; if (ms > win.max) win.max = ms;
    const k = Math.floor(status / 100) + 'xx'; byStatus[k] = (byStatus[k] || 0) + 1;
    if (status >= 500) { errors++; win.err++; }
  };
  const log = (level, ...args) => {
    const msg = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logs.push({ t: new Date().toISOString(), level, msg: msg.slice(0, 500) });
    if (logs.length > KEEP_LOGS) logs.splice(0, logs.length - KEEP_LOGS);
  };
  const sample = (extra = {}) => {
    const now = Date.now(), dt = Math.max(1, now - lastSample), cpu = process.cpuUsage(cpuPrev), mem = process.memoryUsage();
    lastCpu = Math.min(100, Math.round(((cpu.user + cpu.system) / 1000) / dt / Math.max(1, os.cpus().length) * 1000) / 10);
    cpuPrev = process.cpuUsage(); lastSample = now;
    const pt = { t: now, req: win.req, rpm: Math.round(win.req * 60000 / dt), err: win.err, avgMs: win.req ? Math.round(win.ms / win.req * 10) / 10 : 0, maxMs: Math.round(win.max), rss: mem.rss, heap: mem.heapUsed, cpu: lastCpu, ...extra };
    win = { req: 0, err: 0, ms: 0, max: 0 };
    series.push(pt); if (series.length > KEEP_POINTS) series.shift();
    return pt;
  };
  const start = getExtra => { if (!timer) { timer = setInterval(() => { try { sample(getExtra ? getExtra() : {}); } catch (e) { log('error', 'metrics sample failed: ' + e.message); } }, SAMPLE_MS); timer.unref && timer.unref(); } };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const snapshot = () => ({
    startedAt, uptimeSec: Math.round((Date.now() - startedAt) / 1000), pid: process.pid, node: process.version, platform: process.platform, host: os.hostname(),
    process: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, cpuPct: lastCpu },
    system: { totalMem: os.totalmem(), freeMem: os.freemem(), cpus: os.cpus().length, load: os.loadavg() },
    requests: { total, errors, byStatus: { ...byStatus } },
    series: series.slice()
  });
  return { track, log, sample, start, stop, snapshot, logs: (limit = 300) => logs.slice(-Math.max(1, Math.min(KEEP_LOGS, limit))), SAMPLE_MS };
}

function disk(dir) {
  try { const s = fs.statfsSync(dir); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; }
  catch (e) { return null; }
}
function certInfo(certFile) {
  if (!certFile) return null;
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(certFile));
    const to = new Date(x.validTo);
    return { validTo: to.toISOString(), daysLeft: Math.floor((to.getTime() - Date.now()) / 86400000), subject: x.subject.replace(/\n/g, ', '), fingerprint256: x.fingerprint256 };
  } catch (e) { return null; }
}
module.exports = { createMonitor, disk, certInfo, SAMPLE_MS };
