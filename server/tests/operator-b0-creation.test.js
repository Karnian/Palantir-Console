const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createEventBus } = require('../services/eventBus');
const { createRunService } = require('../services/runService');

function makeHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-b0-create-'));
  const { db, migrate, close } = createDatabase(path.join(root, 'test.db'));
  migrate();
  t.after(() => {
    close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, runService: createRunService(db, createEventBus()) };
}

function insertProject(db, id) {
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, `Project ${id}`);
}

test('ensurePrimaryOperatorInstanceForProject atomically creates a deterministic private profile', (t) => {
  const { db, runService } = makeHarness(t);
  insertProject(db, 'b0_create');

  const resolved = runService.ensurePrimaryOperatorInstanceForProject('b0_create');
  assert.equal(resolved.instanceId, 'oi_b0_create');
  const instance = db.prepare('SELECT * FROM operator_instances WHERE id = ?').get(resolved.instanceId);
  assert.equal(instance.profile_id, 'op_priv_oi_b0_create');
  const profile = db.prepare('SELECT * FROM operator_profiles WHERE id = ?').get(instance.profile_id);
  assert.equal(profile.is_private, 1);
  assert.equal(profile.persona, null);
  assert.equal(profile.capabilities_json, '[]');
});

test('ensurePrimaryOperatorInstanceForProject is idempotent without orphan profiles', (t) => {
  const { db, runService } = makeHarness(t);
  insertProject(db, 'b0_repeat');

  const first = runService.ensurePrimaryOperatorInstanceForProject('b0_repeat');
  const profileCount = db.prepare('SELECT COUNT(*) AS n FROM operator_profiles').get().n;
  const second = runService.ensurePrimaryOperatorInstanceForProject('b0_repeat');
  assert.equal(second.instanceId, first.instanceId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_profiles').get().n, profileCount);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM operator_profiles WHERE id LIKE 'op_priv_%' AND id NOT IN (SELECT profile_id FROM operator_instances)").get().n, 0);
});

test('ensure adds a missing primary ref to an existing profiled instance', (t) => {
  const { db, runService } = makeHarness(t);
  insertProject(db, 'b0_edge');
  db.prepare("INSERT INTO operator_profiles (id, name, is_private) VALUES ('op_edge', 'Edge private', 1)").run();
  db.prepare("INSERT INTO operator_instances (id, profile_id) VALUES ('oi_b0_edge', 'op_edge')").run();

  const before = db.prepare('SELECT COUNT(*) AS n FROM operator_profiles').get().n;
  const resolved = runService.ensurePrimaryOperatorInstanceForProject('b0_edge');
  assert.equal(resolved.instanceId, 'oi_b0_edge');
  assert.equal(db.prepare('SELECT profile_id FROM operator_instances WHERE id = ?').get('oi_b0_edge').profile_id, 'op_edge');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_profiles').get().n, before);
  assert.deepEqual(db.prepare("SELECT instance_id FROM operator_codebase_refs WHERE project_id = ? AND role = 'primary'").get('b0_edge'), { instance_id: 'oi_b0_edge' });
});
