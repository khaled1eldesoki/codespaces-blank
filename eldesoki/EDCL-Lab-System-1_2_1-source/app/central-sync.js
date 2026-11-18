/* EDCL central sync client (renderer + Node tests). Keeps the app's in-memory data object `D` in step with the central server.
   - Every row of every table is a server record {tbl,id,rev,data}. Row identity (`_id`) and order (`_o`) are NON-enumerable
     properties, so no screen, export or CSV ever sees them; the server stores order inside the record data as `_o`.
   - Saves are per record and carry the revision they were edited from. The server merges different fields automatically and
     reports a conflict (never overwrites) when the same field was changed by someone else; the other person's value is kept
     and the user can choose to re-apply theirs.
   - Non-array parts of D (Brand, Perms, flags...) are synced as records of the table `_obj`. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.EdclSync = factory(); })(this, function () {
  'use strict';
  const OBJ = '_obj', SEP = '\u0001';
  const LOCAL_ONLY = new Set(['WADASync']);                 // per-PC state: never shared
  const APPEND_ONLY = new Set(['Audit', 'Access']);         // history: local trimming must never delete shared history
  const STRIP = { Users: ['hash'] };                        // passwords live only on the server
  const KEYS = { Employees: ['StaffID'], Methods: ['MethodID'], Training: ['TrainingID'], Authorization: ['AuthorizationID'], Evaluation: ['EvaluationID'], IQAS: ['RecordID'], EQAS: ['RecordID'], Literature: ['LiteratureReviewID'], Gap: ['GapID'], Instruments: ['InstrumentID'], MethodCertifiedScientists: ['MethodID', 'StaffID'], EmployeeInstruments: ['StaffID', 'InstrumentID'], DocumentTemplates: ['TemplateID'], Plan: ['PlanID'], Flags: ['FlagID'], EmpJD: ['StaffID', 'JobDescID'], JobDesc: ['JobDescID'], Settings: ['SettingName'], AuthPers: ['AuthPersonID'], JobItems: ['ItemID'], InstrumentInventory: ['InstrumentCode'], InstrumentLegacyMap: ['LegacyID'], InstrumentMethods: ['LinkID'], InstrumentFlags: ['FlagID'] };
  const isRow = r => r && typeof r === 'object' && !Array.isArray(r);
  const isTable = (k, v) => Array.isArray(v) && !LOCAL_ONLY.has(k) && v.every(isRow);
  const clone = o => JSON.parse(JSON.stringify(o));
  const rnd = () => (globalThis.crypto && globalThis.crypto.getRandomValues ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('') : Math.random().toString(16).slice(2, 10) + Date.now().toString(16)).slice(0, 16);
  const hid = (o, id, v) => Object.defineProperty(o, id, { value: v, enumerable: false, writable: true, configurable: true });
  const idOf = r => r._id, oOf = r => r._o;
  const natural = (tbl, r) => { const ks = KEYS[tbl]; return ks && ks.every(k => r[k] !== undefined && r[k] !== '') ? ks.map(k => String(r[k])).join('|') : null; };
  const dataOf = (tbl, r) => { const d = {}; const skip = STRIP[tbl] || []; for (const k of Object.keys(r)) if (!skip.includes(k)) d[k] = r[k]; if (r._o !== undefined) d._o = r._o; return d; };
  const objData = v => (v && typeof v === 'object' && !Array.isArray(v) && !('_v' in v) ? clone(v) : { _v: clone(v === undefined ? null : v) });
  const objValue = d => (d && Object.keys(d).length === 1 && '_v' in d ? d._v : d);

  function create(opt) {
    const { request, getD, setD, onStatus = () => {}, onConflict = () => {}, onRemote = () => {}, pollMs = 8000, saveDelayMs = 400, batch = 150, log = () => {} } = opt;
    const base = new Map();      // key -> {tbl,id,rev,json}
    let cursor = 0, timer = null, poll = null, running = Promise.resolve(), dirty = false, stopped = false, lastError = '', lastSync = 0, pendingCount = 0, offline = false;
    const key = (t, i) => t + SEP + i;
    const status = (s) => onStatus({ state: s || (offline ? 'offline' : pendingCount ? 'pending' : 'synced'), pending: pendingCount, lastSync, error: lastError });
    const call = async (method, path, body) => { const r = await request(method, path, body === undefined ? undefined : { json: body }); if (r.status === 401) { const e = new Error('Session expired - please sign in again'); e.auth = true; throw e; } return r; };
    const serial = fn => { const p = running.then(fn, fn); running = p.catch(() => {}); return p; };

    // ----- local model <-> records -----
    function assignOrder(rows) {
      for (let i = 0; i < rows.length; i++) {
        if (oOf(rows[i]) !== undefined) continue;
        let a, b; for (let j = i - 1; j >= 0; j--) if (oOf(rows[j]) !== undefined) { a = oOf(rows[j]); break; }
        for (let j = i + 1; j < rows.length; j++) if (oOf(rows[j]) !== undefined) { b = oOf(rows[j]); break; }
        hid(rows[i], '_o', a !== undefined && b !== undefined ? (a + b) / 2 : a !== undefined ? a + 1 : b !== undefined ? b - 1 : i + 1);
      }
    }
    function snapshot(D, forFirstUpload) {
      const cur = new Map(), tables = [];
      for (const k of Object.keys(D)) {
        const v = D[k]; if (LOCAL_ONLY.has(k) || v === undefined || typeof v === 'function') continue;
        if (isTable(k, v)) {
          tables.push(k);
          const byBase = new Map(); // business key -> id of base records not yet claimed (adopts rows replaced by a spread copy)
          const used = new Set(v.filter(r => idOf(r)).map(idOf));
          for (const r of v) if (!idOf(r)) { const n = natural(k, r); if (n && !used.has(n) && (forFirstUpload || base.has(key(k, n)))) { hid(r, '_id', n); used.add(n); } }
          for (const r of v) if (!idOf(r)) { let id; do id = 'n' + rnd(); while (used.has(id)); used.add(id); hid(r, '_id', id); }
          assignOrder(v);
          for (const r of v) cur.set(key(k, idOf(r)), { tbl: k, id: idOf(r), row: r, data: dataOf(k, r) });
        } else cur.set(key(OBJ, k), { tbl: OBJ, id: k, obj: true, data: objData(v) });
      }
      cur.set(key(OBJ, '_tables'), { tbl: OBJ, id: '_tables', obj: true, data: { _v: tables.sort() } });
      return cur;
    }
    function setRow(row, data) { for (const k of Object.keys(row)) delete row[k]; for (const k of Object.keys(data)) if (k !== '_o') row[k] = data[k]; if (data._o !== undefined) hid(row, '_o', data._o); }
    const cmp = (a, b) => ((oOf(a) ?? 0) - (oOf(b) ?? 0)) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);
    const touched = new Set();
    function insertSorted(arr, row, tbl) { arr.push(row); if (tbl) touched.add(tbl); }
    function resort(D) { for (const t of touched) if (Array.isArray(D[t])) D[t].sort(cmp); touched.clear(); }
    function applyRemote(D, rec, force) {
      const k = key(rec.tbl, rec.id), b = base.get(k);
      if (rec.tbl === OBJ) {
        if (rec.id === '_tables') { if (!rec.deleted) for (const t of rec.data._v) if (!Array.isArray(D[t])) D[t] = []; base.set(k, { tbl: OBJ, id: rec.id, rev: rec.rev, json: JSON.stringify(rec.data) }); return; }
        const localJson = JSON.stringify(objData(D[rec.id])), isDirty = !force && D[rec.id] !== undefined && (!b || localJson !== b.json);
        if (isDirty) return;   // local unsent edit: keep the OLD base so the next push carries the old revision and the server merges field by field
        base.set(k, { tbl: OBJ, id: rec.id, rev: rec.rev, json: rec.deleted ? '' : JSON.stringify(rec.data) });
        if (rec.deleted) delete D[rec.id]; else {
          const v = objValue(rec.data), cur = D[rec.id];
          if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)) { for (const x of Object.keys(cur)) delete cur[x]; Object.assign(cur, v); } else D[rec.id] = v;
        }
        return;
      }
      if (!Array.isArray(D[rec.tbl])) D[rec.tbl] = [];
      const arr = D[rec.tbl], i = arr.findIndex(r => idOf(r) === rec.id), row = i >= 0 ? arr[i] : null;
      const isDirty = !force && row && (!b || b.deleted || JSON.stringify(dataOf(rec.tbl, row)) !== b.json);
      if (isDirty) return;   // same rule as above: never advance the base of a record with unsent local edits
      if (rec.deleted) { base.set(k, { tbl: rec.tbl, id: rec.id, rev: rec.rev, json: '', deleted: true }); if (i >= 0) arr.splice(i, 1); return; }
      let target;
      if (row) { const keepO = rec.data._o, prevO = oOf(row); setRow(row, rec.data); if (keepO === undefined) hid(row, '_o', prevO ?? rec.seq); if (oOf(row) !== prevO) touched.add(rec.tbl); target = row; }
      else { const r = {}; hid(r, '_id', rec.id); setRow(r, rec.data); if (oOf(r) === undefined) hid(r, '_o', rec.seq); insertSorted(arr, r, rec.tbl); target = r; }
      base.set(k, { tbl: rec.tbl, id: rec.id, rev: rec.rev, json: JSON.stringify(dataOf(rec.tbl, target)) });
    }
    const hydrate = recs => {
      const D = {}, order = recs.filter(r => !r.deleted);
      for (const r of order) if (r.tbl === OBJ && r.id === '_tables') for (const t of r.data._v) D[t] = [];
      for (const r of order) {
        if (r.tbl === OBJ) { base.set(key(r.tbl, r.id), { tbl: r.tbl, id: r.id, rev: r.rev, json: JSON.stringify(r.data) }); if (r.id !== '_tables') D[r.id] = objValue(clone(r.data)); continue; }
        if (!Array.isArray(D[r.tbl])) D[r.tbl] = [];
        const row = {}; hid(row, '_id', r.id); setRow(row, clone(r.data)); if (oOf(row) === undefined) hid(row, '_o', r.seq); D[r.tbl].push(row);
        base.set(key(r.tbl, r.id), { tbl: r.tbl, id: r.id, rev: r.rev, json: JSON.stringify(dataOf(r.tbl, row)) });   // exactly what the next diff will compute: nothing is "changed" just because it was loaded
      }
      for (const t of Object.keys(D)) if (Array.isArray(D[t])) D[t].sort(cmp);
      return D;
    };

    // ----- network -----
    async function pullAll(first) {
      let recs = [], since = first ? 0 : cursor, seq = cursor;
      for (;;) {
        const r = await call('GET', `/api/sync?since=${since}&limit=1000`); if (r.status !== 200) throw new Error((r.json && r.json.error) || 'Sync failed (HTTP ' + r.status + ')');
        recs = recs.concat(r.json.changes); since = r.json.lastSeq; seq = r.json.seq;
        if (!r.json.more) break;
      }
      cursor = Math.max(since, cursor); return recs;
    }
    async function connect() {
      return serial(async () => {
        base.clear(); cursor = 0; const recs = await pullAll(true); const D = recs.length ? hydrate(recs) : null;
        offline = false; lastSync = Date.now(); lastError = ''; status('synced');
        return { empty: recs.length === 0, D, records: recs.length };
      });
    }
    async function pull() {
      return serial(async () => {
        if (stopped) return 0; const D = getD(); let recs;
        try { recs = await pullAll(false); } catch (e) { return fail(e); }
        for (const r of recs) applyRemote(D, r, false); resort(D);
        offline = false; lastSync = Date.now(); lastError = ''; if (recs.length) onRemote(recs.length); status(); return recs.length;
      });
    }
    function fail(e) { if (e.auth) { lastError = e.message; status('auth'); onStatus({ state: 'auth', error: e.message }); throw e; } offline = true; lastError = e.message; status('offline'); return 0; }

    function diff(D) {
      const cur = snapshot(D, false), ops = [];
      for (const [k, c] of cur) {
        const b = base.get(k), json = JSON.stringify(c.data);
        if (!b || b.deleted || b.json === '') { if (!b || !b.deleted) ops.push({ k, c, op: { tbl: c.tbl, id: c.id, op: 'put', baseRev: 0, data: c.data } }); else ops.push({ k, c, op: { tbl: c.tbl, id: c.id, op: 'put', baseRev: b.rev, data: c.data } }); }
        else if (b.json !== json) ops.push({ k, c, op: { tbl: c.tbl, id: c.id, op: 'put', baseRev: b.rev, data: c.data } });
      }
      for (const [k, b] of base) {
        if (cur.has(k) || b.deleted || b.json === '') continue;
        if (b.tbl === OBJ) continue;                            // objects are never deleted by the app
        if (APPEND_ONLY.has(b.tbl)) continue;                   // trimming history locally must not delete shared history
        ops.push({ k, c: null, op: { tbl: b.tbl, id: b.id, op: 'delete', baseRev: b.rev } });
      }
      return ops;
    }
    const label = (tbl, d) => { if (!d) return tbl; const k = Object.keys(d).find(x => /(^|[a-z])(ID|Name|Title)$|^(FullName|username|Topic|Subject)$/.test(x) && d[x]); return tbl + (k ? ' ' + String(d[k]).slice(0, 60) : ''); };
    async function push() {
      return serial(async () => {
        if (stopped) return { sent: 0, conflicts: [] };
        const D = getD(); let ops = diff(D), conflicts = [], sent = 0; pendingCount = ops.length; status();
        while (ops.length) {
          let bytes = 0, n = 0; while (n < ops.length && n < batch && (n === 0 || bytes + JSON.stringify(ops[n].op).length < 3500000)) { bytes += JSON.stringify(ops[n].op).length; n++; }
          const chunk = ops.splice(0, n); let r;
          try { r = await call('POST', '/api/push', { ops: chunk.map(x => x.op) }); } catch (e) { return fail(e) || { sent, conflicts, offline: true }; }
          if (r.status !== 200) { log('push-failed', r.status, 'chunk=' + chunk.length, 'remaining=' + ops.length, 'bytes=' + bytes, JSON.stringify(r.json).slice(0, 120)); lastError = (r.json && r.json.error) || 'Save failed (HTTP ' + r.status + ')'; offline = r.status >= 500; status('error'); if (r.status === 403) { /* permission: pull will restore server state */ } return { sent, conflicts, error: lastError }; }
          chunk.forEach((x, i) => {
            const res = r.json.results[i], k = x.k;
            if (res.ok) {
              sent++;
              if (x.op.op === 'delete') { base.set(k, { tbl: x.op.tbl, id: x.op.id, rev: res.rev, json: '', deleted: true }); return; }
              const data = res.merged && res.data ? res.data : x.op.data;
              base.set(k, { tbl: x.op.tbl, id: x.op.id, rev: res.rev, json: JSON.stringify(data) });
              if (res.merged && res.data && x.c) { if (x.c.row) { setRow(x.c.row, res.data); } else if (x.c.obj) applyRemote(D, { tbl: x.op.tbl, id: x.op.id, rev: res.rev, data: res.data, seq: 0 }, true); }
              return;
            }
            // conflict or denial: keep the OTHER person's version, report what was not saved
            const srv = res.server, mine = x.op.data ? clone(x.op.data) : null, theirs = srv && !srv.deleted ? srv.data : null;
            conflicts.push({ tbl: x.op.tbl, id: x.op.id, label: label(x.op.tbl, mine || theirs), reason: res.denied ? 'denied' : res.reason || 'conflict', fields: res.fields || [], mine, theirs, op: x.op.op, error: res.error });
            if (srv) applyRemote(D, { tbl: x.op.tbl, id: x.op.id, rev: srv.rev, data: srv.data, deleted: srv.deleted, seq: 0 }, true);
            else { base.delete(k); const arr = D[x.op.tbl]; if (Array.isArray(arr)) { const i2 = arr.findIndex(q => idOf(q) === x.op.id); if (i2 >= 0) arr.splice(i2, 1); } }
          });
        }
        resort(D); pendingCount = 0; offline = false; lastSync = Date.now(); lastError = ''; status();
        if (conflicts.length) onConflict(conflicts);
        return { sent, conflicts };
      });
    }
    // user chose "keep my version" for a conflict: write mine on top of the server's current revision
    async function applyMine(c) {
      const D = getD(); const b = base.get(key(c.tbl, c.id));
      if (c.tbl === OBJ) { const v = objValue(c.mine); D[c.id] = v; }
      else if (c.mine) {
        if (!Array.isArray(D[c.tbl])) D[c.tbl] = []; const arr = D[c.tbl]; let row = arr.find(r => idOf(r) === c.id);
        if (!row) { row = {}; hid(row, '_id', c.id); setRow(row, c.mine); insertSorted(arr, row, c.tbl); } else { const o = oOf(row); setRow(row, c.mine); if (oOf(row) === undefined && o !== undefined) hid(row, '_o', o); }
      } else { const arr = D[c.tbl]; const i = arr.findIndex(r => idOf(r) === c.id); if (i >= 0) arr.splice(i, 1); }
      if (b && b.deleted && c.mine) b.deleted = false;
      resort(D); return flush();
    }
    function markDirty() { dirty = true; if (timer || stopped) return; timer = setTimeout(() => { timer = null; dirty = false; push().catch(() => {}); }, saveDelayMs); pendingCount = Math.max(pendingCount, 1); status('pending'); }
    async function flush() { if (timer) { clearTimeout(timer); timer = null; } dirty = false; const r = await push(); return r; }
    function start() { if (poll) return; poll = setInterval(async () => { if (stopped) return; if (offline || pendingCount) await push().catch(() => {}); await pull().catch(() => {}); }, pollMs); }   // unsent edits are retried automatically when the server is reachable again
    function stop() { stopped = true; if (timer) clearTimeout(timer); if (poll) clearInterval(poll); }
    // first upload into an empty server (only offered to administrators)
    async function uploadAll() { const D = getD(); snapshot(D, true); return push(); }
    return { connect, pull, push, flush, markDirty, start, stop, applyMine, uploadAll, notify: () => pull().catch(() => {}), state: () => ({ pending: pendingCount, offline, lastSync, lastError, cursor }), _base: base, _snapshot: D => snapshot(D, false) };
  }
  // ----- central file store with the IndexedDB object-store API the app already uses (get/getAll/add/put/delete) -----
  function fileStore({ request, cacheMax = 40 }) {
    const cache = new Map();
    const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    const bytesOf = async b => (b.__lazy ? new Uint8Array(await (await b.get()).arrayBuffer()) : new Uint8Array(b.arrayBuffer ? await b.arrayBuffer() : await new Response(b).arrayBuffer()));
    const lazy = f => ({ __lazy: true, type: f.type || 'application/octet-stream', size: f.size, name: f.name, sha256: f.sha256,
      async get() { if (cache.has(f.sha256)) return cache.get(f.sha256); const r = await request('GET', '/api/blobs/' + f.sha256, { raw: true }); if (r.status !== 200 || !r.bytes) throw new Error('Could not download "' + f.name + '" from the server (HTTP ' + r.status + ')'); const bl = new Blob([r.bytes], { type: f.type || '' }); cache.set(f.sha256, bl); if (cache.size > cacheMax) cache.delete(cache.keys().next().value); return bl; },
      async arrayBuffer() { return (await this.get()).arrayBuffer(); } });
    const row = f => ({ id: f.id, cat: f.cat, name: f.name, code: f.code, type: f.type, size: f.size, date: f.date, blob: lazy(f) });
    async function upload(obj) {
      const bytes = await bytesOf(obj.blob), sha = hex(await crypto.subtle.digest('SHA-256', bytes));
      const u = await request('PUT', '/api/blobs/' + sha, { bytes }); if (u.status !== 200) throw new Error((u.json && u.json.error) || 'Upload failed (HTTP ' + u.status + ')');
      return sha;
    }
    const J = async (p, method, json) => { const r = await request(method, p, json ? { json } : undefined); if (r.status !== 200) throw new Error((r.json && r.json.error) || 'Server error (HTTP ' + r.status + ')'); return r.json; };
    const mk = fn => { const q = { result: undefined, error: null, onsuccess: null, onerror: null }; setTimeout(() => fn().then(v => { q.result = v; q.onsuccess && q.onsuccess({ target: q }); }, e => { q.error = e; if (q.onerror) q.onerror({ target: q }); else console.error(e); }), 0); return q; };
    return {
      getAll: () => mk(async () => (await J('/api/files', 'GET')).files.map(row)),
      get: id => mk(async () => { try { return row((await J('/api/files/' + id, 'GET')).file); } catch (e) { return undefined; } }),
      add: obj => mk(async () => { const sha = await upload(obj); return (await J('/api/files', 'POST', { cat: obj.cat, name: obj.name, code: obj.code, type: obj.type, date: obj.date, sha256: sha })).file.id; }),
      put: obj => mk(async () => { const sha = obj.blob && obj.blob.__lazy ? obj.blob.sha256 : await upload(obj); await J('/api/files/' + obj.id, 'PUT', { cat: obj.cat, name: obj.name, code: obj.code, type: obj.type, date: obj.date, sha256: sha }); return obj.id; }),
      delete: id => mk(async () => { await J('/api/files/' + id, 'DELETE'); }),
      clear: () => mk(async () => { throw new Error('Clearing the central file store is not allowed from the application'); })
    };
  }
  return { create, fileStore, OBJ, KEYS, LOCAL_ONLY, APPEND_ONLY, STRIP };
});
