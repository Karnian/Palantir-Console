// G2 — verifyCheckService unit: CRUD + server-derived provenance + spec validation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createVerifyCheckService, validateSpec } = require('../services/verifyCheckService');

function db(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-vcs-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 't.db'));
  migrate();
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P1')").run();
  db.prepare("INSERT INTO projects (id, name) VALUES ('p2', 'P2')").run();
  t.after(() => { try { close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

test('validateSpec: command requires command; timeout bounds', () => {
  assert.deepEqual(validateSpec('command', { command: 'npm test' }), { command: 'npm test', timeout_ms: null });
  assert.deepEqual(validateSpec('command', { command: 'x', timeout_ms: 5000 }), { command: 'x', timeout_ms: 5000 });
  assert.throws(() => validateSpec('command', {}), /spec.command is required/);
  assert.throws(() => validateSpec('command', { command: 'x', timeout_ms: -1 }), /timeout_ms/);
});

test('validateSpec: artifact is declarative, no-exec, rejects traversal + empty', () => {
  const s = validateSpec('artifact', { files: [{ glob: 'dist/*.js', must_exist: true, min_bytes: 10 }], report: { min_chars: 5, must_contain: ['DONE'], format: 'markdown' } });
  assert.equal(s.files[0].glob, 'dist/*.js');
  assert.equal(s.report.format, 'markdown');
  assert.throws(() => validateSpec('artifact', {}), /at least one of files\/report/);
  assert.throws(() => validateSpec('artifact', { files: [{ glob: '../etc/passwd' }] }), /must not contain/);
  assert.throws(() => validateSpec('artifact', { report: { format: 'exe' } }), /format must be/);
});

test('createCheck: created_by is server-derived, NEVER from request body', (t) => {
  const svc = createVerifyCheckService(db(t));
  // Attacker passes created_by:'human' but authenticates as operator → must be operator.
  const c = svc.createCheck({ kind: 'artifact', name: 'a1', spec_json: { report: { min_chars: 1 } }, created_by: 'human' }, { actor: 'operator' });
  assert.equal(c.created_by, 'operator', 'created_by ignores request body, uses actor');
});

test('createCheck: command requires project_id; artifact does not', (t) => {
  const svc = createVerifyCheckService(db(t));
  assert.throws(() => svc.createCheck({ kind: 'command', name: 'c', spec_json: { command: 'x' } }, { actor: 'human' }), /project_id/);
  const cmd = svc.createCheck({ kind: 'command', project_id: 'p1', name: 'c', spec_json: { command: 'npm test' } }, { actor: 'human' });
  assert.equal(cmd.created_by, 'human');
  const art = svc.createCheck({ kind: 'artifact', name: 'a', spec_json: { files: [{ glob: '*.md' }] } }, { actor: 'operator' });
  assert.equal(art.project_id, null);
});

test('updateCheck: operator editing spec downgrades human→operator; rename preserves', (t) => {
  const svc = createVerifyCheckService(db(t));
  const c = svc.createCheck({ kind: 'artifact', project_id: 'p1', name: 'a', spec_json: { report: { min_chars: 10 } } }, { actor: 'human' });
  assert.equal(c.created_by, 'human');
  // operator rename only (no spec change) → provenance preserved
  const renamed = svc.updateCheck(c.id, { name: 'a-renamed' }, { actor: 'operator' });
  assert.equal(renamed.created_by, 'human', 'rename by operator preserves human provenance');
  // operator changes spec → downgrade to operator (anti-laundering)
  const edited = svc.updateCheck(c.id, { spec_json: { report: { min_chars: 999 } } }, { actor: 'operator' });
  assert.equal(edited.created_by, 'operator', 'operator spec edit downgrades to operator');
  // human edit vouches → restore human
  const restored = svc.updateCheck(c.id, { spec_json: { report: { min_chars: 1 } } }, { actor: 'human' });
  assert.equal(restored.created_by, 'human', 'human edit restores human provenance');
});

test('createCheck: command without project_id blocked by DB trigger too (defense-in-depth)', (t) => {
  const d = db(t);
  assert.throws(
    () => d.prepare("INSERT INTO verify_checks (kind, name, spec_json, created_by) VALUES ('command','x','{}','human')").run(),
    /command verify_check requires project_id/,
  );
});

test('createCheck: unique name within project scope; is_default clears siblings', (t) => {
  const svc = createVerifyCheckService(db(t));
  svc.createCheck({ kind: 'artifact', project_id: 'p1', name: 'dup', spec_json: { report: { min_chars: 1 } }, is_default: true }, { actor: 'human' });
  assert.throws(() => svc.createCheck({ kind: 'artifact', project_id: 'p1', name: 'dup', spec_json: { report: { min_chars: 1 } } }, { actor: 'human' }), /already|UNIQUE|exists/i);
  // same name in a different project is fine
  const other = svc.createCheck({ kind: 'artifact', project_id: 'p2', name: 'dup', spec_json: { report: { min_chars: 1 } }, is_default: true }, { actor: 'human' });
  assert.ok(other.id);
  // second default in p2 clears the first
  const d2 = svc.createCheck({ kind: 'artifact', project_id: 'p2', name: 'dup2', spec_json: { report: { min_chars: 1 } }, is_default: true }, { actor: 'human' });
  assert.equal(svc.getCheck(other.id).is_default, 0, 'new default clears sibling default');
  assert.equal(svc.getCheck(d2.id).is_default, 1);
});
