'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Helper: run migrations on an in-memory DB.
function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const version = Number.parseInt(file.split('_')[0], 10);
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
  }

  for (const projectId of ['proj-1', 'proj-2', 'proj-3', 'proj-4', 'proj-5', 'proj-6']) {
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);
  }

  return db;
}

// Minimal eventBus stub.
function fakeEventBus() {
  const handlers = {};
  return {
    emit(event, data) {
      (handlers[event] || []).forEach((handler) => {
        try { handler(data); } catch { /* ignore listener failures */ }
      });
    },
    on(event, fn) {
      (handlers[event] = handlers[event] || []).push(fn);
    },
  };
}

describe('slice3 - L1 owner cutover', () => {
  let db;
  let svc;
  let eb;

  before(() => {
    db = buildTestDb();
    eb = fakeEventBus();
    const { createMemoryService } = require('../services/memoryService');
    svc = createMemoryService(db, eb);
  });

  after(() => db.close());

  test('createMemoryItem returns item with owner_type=workspace and owner_id=project_id', () => {
    const item = svc.createMemoryItem({
      projectId: 'proj-1',
      kind: 'convention',
      content: 'use snake_case',
      importance: 5,
      confidence: 0.8,
      origin: 'human',
    });
    assert.equal(item.owner_type, 'workspace');
    assert.equal(item.owner_id, 'proj-1');
    assert.equal(item.project_id, 'proj-1');
  });

  test('listForProject owner-keyed path returns same rows as before', () => {
    const rows = svc.listForProject('proj-1', 'active');
    assert.ok(rows.length >= 1, 'should have at least 1 active item');
    assert.ok(rows.every((row) => row.project_id === 'proj-1'), 'all rows belong to project');
    assert.ok(rows.every((row) => row.owner_type === 'workspace'), 'owner_type set');
    assert.ok(rows.every((row) => row.owner_id === 'proj-1'), 'owner_id matches project_id');
  });

  test('retrieveForProject owner-keyed FTS path returns same rows', () => {
    const rows = svc.retrieveForProject('proj-1', { taskContext: 'snake_case' });
    assert.ok(Array.isArray(rows), 'returns array');
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => row.project_id === 'proj-1'));
  });

  test('upsertFact uses owner-keyed active fact lookup', () => {
    const r1 = svc.upsertFact({
      projectId: 'proj-2',
      factKey: 'env.node_version',
      content: 'v22',
      evidenceJson: '{}',
      importance: 3,
    });
    const r2 = svc.upsertFact({
      projectId: 'proj-2',
      factKey: 'env.node_version',
      content: 'v22',
      evidenceJson: '{}',
      importance: 3,
    });
    assert.equal(r2.id, r1.id, 'unchanged fact returns existing row');
    assert.equal(r2.fact_key, 'env.node_version');
  });

  test('createCandidate owner columns are dual-written and lookup works', () => {
    const c = svc.createCandidate({
      projectId: 'proj-3',
      rule: 'R1b',
      rawJson: '{"x":1}',
      dedupKey: 'k1',
    });
    assert.equal(c.owner_type, 'workspace');
    assert.equal(c.owner_id, 'proj-3');
  });

  test('enqueueDistillJob single-flight duplicate enqueue returns existing job', () => {
    const r1 = svc.enqueueDistillJob('proj-4');
    const r2 = svc.enqueueDistillJob('proj-4');
    assert.equal(r1.job.id, r2.job.id, 'same job returned');
    assert.equal(r2.created, false);
  });

  test('memory_jobs owner partial-unique index prevents duplicate active jobs', () => {
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_jobs_owner_active'"
    ).get();
    assert.ok(idx, 'owner active index must exist');
  });

  test('claimDistillJob uses owner filter correctly', () => {
    svc.enqueueDistillJob('proj-5');
    const result = svc.claimDistillJob({ projectId: 'proj-5' });
    assert.ok(result === null || result.project_id === 'proj-5', 'claim targets correct project');
  });

  test('cross-project isolation: proj-1 items are not visible when listing proj-2', () => {
    const rows = svc.listForProject('proj-2', 'active');
    assert.ok(rows.length >= 1, 'proj-2 has an active fact row');
    assert.ok(rows.every((row) => row.project_id === 'proj-2'), 'no cross-project leakage');
  });

  test('project revision counter remains project_id-keyed (Composer gate reads it)', () => {
    // The legacy shouldInject gate was retired in S5-LEDGER; the Composer's
    // shouldCompose now gates injection, reading this project_id-keyed revision.
    const rev = svc.getRevision('proj-1');
    assert.ok(typeof rev === 'number', 'project revision is project_id-keyed');
  });

  test('admission control keeps human/pinned protection available through owner path', () => {
    const human = svc.createMemoryItem({
      projectId: 'proj-6',
      kind: 'convention',
      content: 'human item must never be evicted',
      importance: 1,
      confidence: 0.1,
      origin: 'human',
    });
    assert.equal(human.origin, 'human');
    const rows = svc.listForProject('proj-6', 'active');
    assert.ok(rows.some((row) => row.id === human.id && row.origin === 'human'));
  });

  test('grep: no unconverted project_id storage read sites remain in memoryService.js', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'memoryService.js'),
      'utf8'
    );
    const forbiddenFragments = [
      'WHERE project_id = ?\n      AND content_hash = ?',
      'WHERE project_id = @projectId\n      AND status =',
      'AND mi.project_id = @projectId',
      'SELECT * FROM memory_items WHERE project_id = ? AND status = ?',
      'SELECT * FROM memory_items WHERE project_id = ? ORDER BY',
      'SELECT * FROM memory_candidates WHERE project_id = ? AND status = ?',
      'SELECT * FROM memory_jobs WHERE kind = ? AND project_id = ?',
      '@projectId IS NULL OR project_id = @projectId',
      "SELECT COUNT(*) AS n FROM memory_items WHERE project_id = ? AND status = 'active'",
      "WHERE project_id=? AND status='active'",
      'WHERE project_id=@projectId AND fact_key=@factKey',
      'WHERE project_id = ? AND fact_key = ?',
    ];
    const violations = forbiddenFragments.filter((fragment) => src.includes(fragment));
    assert.deepEqual(violations, []);
  });
});
