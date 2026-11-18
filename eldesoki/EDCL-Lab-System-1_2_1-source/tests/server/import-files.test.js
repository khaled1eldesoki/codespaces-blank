'use strict';
// Migration: a desktop backup (.json with embedded files) is imported with the ORIGINAL file ids and identical bytes.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
test('M1 import keeps file ids and bytes', () => {
  const root = path.join(__dirname, '..', '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edcl-imp-'));
  const l = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8').split('\n').find(x => x.startsWith('let D={')); const D = eval('(' + l.replace(/^let D=/, '').replace(/;\s*$/, '') + ')');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4 '), crypto.randomBytes(5000)]);
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ D, files: [{ id: 7, cat: 'sop', name: 'SOP7.pdf', type: 'application/pdf', blob: 'data:application/pdf;base64,' + pdf.toString('base64') }] }));
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'server', 'cli.js'), 'import', path.join(dir, 'b.json'), '--data', path.join(dir, 'd')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).files.imported, 1);
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(dir, 'd', 'edcl-central.sqlite'));
  const row = db.prepare('SELECT id,sha256,size FROM files').get(); assert.equal(row.id, 7); assert.equal(row.size, pdf.length);
  assert.ok(fs.readFileSync(path.join(dir, 'd', 'files', row.sha256.slice(0, 2), row.sha256)).equals(pdf)); db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
