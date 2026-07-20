'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '066_b_adm_episodic_node_fact_cleanup.sql'),
  'utf-8',
);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-mig066-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  const { db } = handle;
  db.prepare("INSERT INTO projects (id, name) VALUES ('p_ep', 'Episodic')").run();
  db.prepare("INSERT INTO projects (id, name) VALUES ('p_st', 'Stable')").run();
  t.after(() => { handle.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, svc: createMemoryService(db) };
}

test('migration 066 archives episodic env.node_resolution facts, preserves stable + other facts', (t) => {
  const { db, svc } = setup(t);

  // Pre-B-adm episodic node fact (server-source wording).
  svc.upsertFact({
    projectId: 'p_ep',
    factKey: 'env.node_resolution',
    content: 'No project-specific Node declaration; harvest uses the server Node major 22',
    importance: 5,
  });
  // Stable project requirement (B-adm's normalized form).
  svc.upsertFact({
    projectId: 'p_st',
    factKey: 'env.node_resolution',
    content: 'Project requires Node major 22',
    importance: 5,
  });
  // A different fact_key must be untouched.
  svc.upsertFact({
    projectId: 'p_ep',
    factKey: 'env.test_command',
    content: 'Project test command: npm test',
    importance: 6,
  });

  // Re-run the migration statement (it was a no-op at boot on an empty DB).
  db.exec(MIGRATION_SQL);

  const status = (projectId, factKey) => db.prepare(
    'SELECT status, archive_reason FROM memory_items WHERE owner_type=? AND owner_id=? AND fact_key=? ORDER BY updated_at DESC LIMIT 1',
  ).get('workspace', projectId, factKey);

  const episodic = status('p_ep', 'env.node_resolution');
  assert.equal(episodic.status, 'archived', 'episodic node fact must be archived');
  assert.equal(episodic.archive_reason, 'b_adm_episodic_cleanup');

  assert.equal(status('p_st', 'env.node_resolution').status, 'active', 'stable requirement must stay active');
  assert.equal(status('p_ep', 'env.test_command').status, 'active', 'other fact_key must be untouched');
});
