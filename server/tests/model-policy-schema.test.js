'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createDatabase } = require('../db/database');

function freshDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp1-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 't.db'));
  migrate();
  t.after(() => {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('model policy migration creates its tables and run snapshot columns', (t) => {
  const db = freshDb(t);
  const tables = new Set(
    db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('model_policies', 'model_policy_audit')
    `).all().map((row) => row.name),
  );
  const runColumns = new Set(
    db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name),
  );

  assert.deepEqual(tables, new Set(['model_policies', 'model_policy_audit']));
  assert.equal(runColumns.has('session_model'), true);
  assert.equal(runColumns.has('session_effort'), true);
});

test('model policy scope, uniqueness, and JSON checks reject invalid rows', (t) => {
  const db = freshDb(t);
  const insert = db.prepare(`
    INSERT INTO model_policies (scope_type, scope_id, vendor, params_json)
    VALUES (?, ?, ?, ?)
  `);

  assert.throws(() => insert.run('global', 'x', 'codex', '{}'));
  assert.throws(() => insert.run('codebase', '*', 'codex', '{}'));

  insert.run('global', '*', 'codex', '{}');
  assert.throws(() => insert.run('global', '*', 'codex', '{}'));

  assert.throws(() => insert.run('layer:top', '*', 'codex', '[]'));
  assert.throws(() => insert.run('layer:operator', '*', 'claude', 'not-json'));
});

test('deleting a project removes its policies and appends tombstones', (t) => {
  const db = freshDb(t);
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('project-1', 'Project 1');
  db.prepare(`
    INSERT INTO model_policies (scope_type, scope_id, vendor, params_json)
    VALUES ('codebase', ?, 'codex', ?)
  `).run('project-1', JSON.stringify({ model: 'gpt-test' }));

  db.prepare('DELETE FROM projects WHERE id = ?').run('project-1');

  const policy = db.prepare(`
    SELECT * FROM model_policies
    WHERE scope_type = 'codebase' AND scope_id = ?
  `).get('project-1');
  const tombstones = db.prepare(`
    SELECT action, params_json_after, changed_by
    FROM model_policy_audit
    WHERE scope_type = 'codebase' AND scope_id = ? AND vendor = 'codex'
  `).all('project-1');

  assert.equal(policy, undefined);
  assert.deepEqual(tombstones, [{
    action: 'delete',
    params_json_after: null,
    changed_by: 'system:project_delete',
  }]);
});

test('updating policy params bumps updated_at', (t) => {
  const db = freshDb(t);
  db.prepare(`
    INSERT INTO model_policies (
      scope_type,
      scope_id,
      vendor,
      params_json,
      updated_at
    ) VALUES ('layer:top', '*', 'claude', '{}', '2000-01-01 00:00:00')
  `).run();

  const before = db.prepare(`
    SELECT updated_at FROM model_policies
    WHERE scope_type = 'layer:top' AND scope_id = '*' AND vendor = 'claude'
  `).pluck().get();
  db.prepare(`
    UPDATE model_policies
    SET params_json = ?
    WHERE scope_type = 'layer:top' AND scope_id = '*' AND vendor = 'claude'
  `).run(JSON.stringify({ model: 'claude-test' }));
  const after = db.prepare(`
    SELECT updated_at FROM model_policies
    WHERE scope_type = 'layer:top' AND scope_id = '*' AND vendor = 'claude'
  `).pluck().get();

  assert.notEqual(after, before);
});
