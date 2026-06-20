'use strict';

// S5-STORAGE owner-keying tests.
//
// Verifies:
//   1. Migration 039 schema: owner-unique indexes on memory_items,
//      table-rebuilt memory_candidates with UNIQUE(rule, owner_type, owner_id, dedup_key),
//      old (project_id, *) uniques DROPPED.
//   2. Cross-contamination isolation: two different owners with the SAME
//      content_hash / fact_key / dedup_key both insert without colliding.
//   3. Same-owner dedup: second insert for same owner is idempotent (no duplicate).
//   4. revision/injection ON CONFLICT keys are UNTOUCHED (provenance-keyed by design).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const { createMemoryService } = require('../services/memoryService');
const { createMasterMemoryService } = require('../services/masterMemoryService');

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function buildMigratedDb({ upTo = 999 } = {}) {
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
    if (version > upTo) continue;
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
  }

  return db;
}

function insertProject(db, id) {
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(id, id);
  return id;
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

/** Returns true iff the table has a UNIQUE index over exactly those columns (in order). */
function hasUniqueIndex(db, table, expectedColumns) {
  const indexes = db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all();
  return indexes
    .filter((idx) => idx.unique)
    .some((idx) => {
      const columns = db.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all()
        .sort((a, b) => a.seqno - b.seqno)
        .map((row) => row.name);
      return (
        columns.length === expectedColumns.length &&
        columns.every((col, i) => col === expectedColumns[i])
      );
    });
}

/** Returns true iff ANY unique index on the table includes the given column set
 *  (order-insensitive, subset check). Used to verify old project_id uniques are gone. */
function noUniqueIndexWith(db, table, forbiddenColumns) {
  const indexes = db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all();
  for (const idx of indexes.filter((i) => i.unique)) {
    const columns = db.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all()
      .map((row) => row.name);
    if (forbiddenColumns.every((c) => columns.includes(c))) {
      return false; // found a unique index that contains the forbidden column set
    }
  }
  return true;
}

// ──────────────────────────────────────────────────────────────
// Schema tests — migration 039 effects
// ──────────────────────────────────────────────────────────────

test('039: memory_items has owner-unique content_hash partial index', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  assert.ok(
    hasUniqueIndex(db, 'memory_items', ['owner_type', 'owner_id', 'content_hash']),
    'idx_memory_owner_content_hash must exist'
  );
});

test('039: memory_items has owner-unique fact_key partial index', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  assert.ok(
    hasUniqueIndex(db, 'memory_items', ['owner_type', 'owner_id', 'fact_key']),
    'idx_memory_owner_factkey must exist'
  );
});

test('039: old project_id-keyed content_hash unique index is dropped from memory_items', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  // idx_memory_content_hash (project_id, content_hash) must be gone after 039
  const dropped = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_content_hash'"
  ).get();
  assert.equal(dropped, undefined, 'idx_memory_content_hash must be dropped by migration 039');
});

test('039: old project_id-keyed fact_key unique index is dropped from memory_items', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  const dropped = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_factkey'"
  ).get();
  assert.equal(dropped, undefined, 'idx_memory_factkey must be dropped by migration 039');
});

test('039: memory_candidates table UNIQUE is now owner-keyed (rule, owner_type, owner_id, dedup_key)', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  // Verify that inserting the same dedup_key for the SAME owner is blocked
  // but different owners succeed — this confirms the constraint columns.
  insertProject(db, 'schema-proj-a');
  insertProject(db, 'schema-proj-b');

  const base = {
    rule: 'R1b',
    raw_json: '{}',
    dedup_key: 'schema-check-key',
    status: 'pending',
    created_at: (new Date()).toISOString(),
    updated_at: (new Date()).toISOString(),
  };

  // First insert: owner_type=workspace, owner_id=schema-proj-a
  db.prepare(
    'INSERT INTO memory_candidates (id, project_id, rule, raw_json, dedup_key, status, created_at, updated_at, owner_type, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('id-a-1', 'schema-proj-a', base.rule, base.raw_json, base.dedup_key, base.status, base.created_at, base.updated_at, 'workspace', 'schema-proj-a');

  // Same dedup_key, different owner_id — must succeed (owner isolation)
  db.prepare(
    'INSERT INTO memory_candidates (id, project_id, rule, raw_json, dedup_key, status, created_at, updated_at, owner_type, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('id-b-1', 'schema-proj-b', base.rule, base.raw_json, base.dedup_key, base.status, base.created_at, base.updated_at, 'workspace', 'schema-proj-b');

  const count = db.prepare('SELECT COUNT(*) AS n FROM memory_candidates WHERE dedup_key = ?').get(base.dedup_key).n;
  assert.equal(count, 2, 'two different owners with same dedup_key must both exist');

  // Same owner, same dedup_key, same rule — must fail (dedup)
  assert.throws(
    () => db.prepare(
      'INSERT INTO memory_candidates (id, project_id, rule, raw_json, dedup_key, status, created_at, updated_at, owner_type, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('id-a-2', 'schema-proj-a', base.rule, base.raw_json, base.dedup_key, base.status, base.created_at, base.updated_at, 'workspace', 'schema-proj-a'),
    { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    'same owner + rule + dedup_key must be blocked by UNIQUE constraint'
  );
});

test('039: old UNIQUE(rule, project_id, dedup_key) is gone from memory_candidates after rebuild', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  // The old constraint used project_id as a key. After rebuild it must not exist
  // as a unique index including project_id.
  assert.ok(
    noUniqueIndexWith(db, 'memory_candidates', ['rule', 'project_id', 'dedup_key']),
    'old UNIQUE(rule, project_id, dedup_key) must not exist after rebuild'
  );
});

test('039: master_memory_candidates table UNIQUE is now owner-keyed after rebuild', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  const base = {
    rule: 'R4',
    raw_json: '{}',
    dedup_key: 'mm-schema-key',
    status: 'pending',
    created_at: (new Date()).toISOString(),
    updated_at: (new Date()).toISOString(),
  };

  // Two owner rows (user/user — single L2 owner collapses, but the table allows the insert)
  // We test isolation at the same-owner level for master_memory_candidates.
  // Insert with owner_type=user, owner_id=user:
  db.prepare(
    'INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, status, created_at, updated_at, owner_type, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('mm-id-1', 'user', base.rule, base.raw_json, base.dedup_key, base.status, base.created_at, base.updated_at, 'user', 'user');

  // Same owner, same dedup_key, same rule — must be blocked by new UNIQUE
  assert.throws(
    () => db.prepare(
      'INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, status, created_at, updated_at, owner_type, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('mm-id-2', 'cross_project', base.rule, base.raw_json, base.dedup_key, base.status, base.created_at, base.updated_at, 'user', 'user'),
    { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    'same L2 owner dedup_key must be blocked across scope variants'
  );
});

// ──────────────────────────────────────────────────────────────
// Cross-contamination isolation tests — service layer
// ──────────────────────────────────────────────────────────────

test('two owners with same content produce separate memory_items without collision', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  const projA = insertProject(db, 'xcontam-proj-a');
  const projB = insertProject(db, 'xcontam-proj-b');
  const svc = createMemoryService(db);

  const content = 'Always use early returns in guard clauses';

  const itemA = svc.createMemoryItem({
    projectId: projA,
    kind: 'convention',
    content,
    origin: 'human',
  });
  const itemB = svc.createMemoryItem({
    projectId: projB,
    kind: 'convention',
    content,
    origin: 'human',
  });

  assert.notEqual(itemA.id, itemB.id, 'different owners must produce separate items');
  assert.equal(itemA.project_id, projA);
  assert.equal(itemB.project_id, projB);
  assert.equal(itemA.content_hash, itemB.content_hash, 'same content → same hash');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE content_hash = ? AND status = 'active'").get(itemA.content_hash).n,
    2,
    'two distinct active rows — one per owner'
  );
});

test('same owner with same content deduplicates (source_count merge)', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  const projA = insertProject(db, 'sameowner-proj');
  const svc = createMemoryService(db);

  const content = 'Prefer composition over inheritance';

  const first = svc.createMemoryItem({ projectId: projA, kind: 'convention', content, origin: 'human' });
  const second = svc.createMemoryItem({ projectId: projA, kind: 'convention', content, origin: 'human' });

  assert.equal(first.id, second.id, 'same owner + same content must return same item (merge)');
  const row = db.prepare("SELECT source_count FROM memory_items WHERE id = ?").get(first.id);
  assert.equal(row.source_count, 2, 'source_count incremented on merge');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE content_hash = ? AND status = 'active'").get(first.content_hash).n,
    1,
    'only one active row for same owner'
  );
});

test('two owners with same fact_key produce separate fact items without collision', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  const projA = insertProject(db, 'fact-proj-a');
  const projB = insertProject(db, 'fact-proj-b');
  const svc = createMemoryService(db);

  const factA = svc.upsertFact({ projectId: projA, factKey: 'env.node_version', content: 'v22.1.0' });
  const factB = svc.upsertFact({ projectId: projB, factKey: 'env.node_version', content: 'v22.1.0' });

  assert.notEqual(factA.id, factB.id, 'different owners must produce separate fact items');
  assert.equal(factA.fact_key, 'env.node_version');
  assert.equal(factB.fact_key, 'env.node_version');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE fact_key = ? AND status = 'active'").get('env.node_version').n,
    2,
    'two distinct active fact rows — one per owner'
  );
});

test('same owner upsertFact supersedes previous value (no contamination)', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  const projA = insertProject(db, 'upsert-proj');
  const svc = createMemoryService(db);

  const v1 = svc.upsertFact({ projectId: projA, factKey: 'env.node_version', content: 'v22.0.0' });
  const v2 = svc.upsertFact({ projectId: projA, factKey: 'env.node_version', content: 'v22.1.0' });

  assert.notEqual(v1.id, v2.id, 'upsert must create a new active row');
  const rows = db.prepare("SELECT status FROM memory_items WHERE project_id = ? AND fact_key = 'env.node_version' ORDER BY rowid_pk").all(projA);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'superseded');
  assert.equal(rows[1].status, 'active');
});

test('two owners with same candidate dedup_key produce separate candidates without collision', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  const projA = insertProject(db, 'cand-proj-a');
  const projB = insertProject(db, 'cand-proj-b');
  const svc = createMemoryService(db);

  const sharedDedupKey = 'run-abc:task-123:fix';

  const candA = svc.createCandidate({ projectId: projA, rule: 'R1b', rawJson: { fix: 'patched' }, dedupKey: sharedDedupKey });
  const candB = svc.createCandidate({ projectId: projB, rule: 'R1b', rawJson: { fix: 'patched' }, dedupKey: sharedDedupKey });

  assert.notEqual(candA.id, candB.id, 'different owners must get separate candidates');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM memory_candidates WHERE dedup_key = ?').get(sharedDedupKey).n,
    2,
    'two distinct candidate rows — one per owner'
  );
});

test('same owner with same candidate dedup_key deduplicates (idempotent)', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  const projA = insertProject(db, 'cand-dedup-proj');
  const svc = createMemoryService(db);

  const first = svc.createCandidate({ projectId: projA, rule: 'R3', rawJson: { v: 1 }, dedupKey: 'same-cand-key' });
  const second = svc.createCandidate({ projectId: projA, rule: 'R3', rawJson: { v: 2 }, dedupKey: 'same-cand-key' });

  assert.equal(first.id, second.id, 'same owner + same dedup_key must return same candidate');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM memory_candidates WHERE dedup_key = ?').get('same-cand-key').n,
    1,
    'only one candidate row for same owner'
  );
});

// ──────────────────────────────────────────────────────────────
// Master memory cross-contamination tests
// ──────────────────────────────────────────────────────────────

test('master_memory createCandidate: same dedup_key across scopes deduplicates to one owner row', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  const svc = createMasterMemoryService(db, null);

  const sharedKey = 'xproject-hash-abc';
  const cand1 = svc.createCandidate({ scope: 'user', rule: 'R4', rawJson: { x: 1 }, dedupKey: sharedKey });
  // cross_project collapses to same (user, user) owner — must deduplicate
  const cand2 = svc.createCandidate({ scope: 'cross_project', rule: 'R4', rawJson: { x: 2 }, dedupKey: sharedKey });

  assert.equal(cand1.id, cand2.id, 'cross_project and user scopes collapse to same owner — must deduplicate');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM master_memory_candidates WHERE dedup_key = ?').get(sharedKey).n,
    1,
    'only one master candidate row'
  );
});

// ──────────────────────────────────────────────────────────────
// Invariant: revision/injection ON CONFLICT keys are UNTOUCHED
// ──────────────────────────────────────────────────────────────

test('project_memory_revision ON CONFLICT(project_id) still works after migration 039', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  insertProject(db, 'rev-test-proj');

  // Bump via raw SQL (mirrors memoryService._bumpRevision)
  db.prepare(`
    INSERT INTO project_memory_revision(project_id, revision, owner_type, owner_id)
    VALUES (?, 1, 'workspace', ?)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1
  `).run('rev-test-proj', 'rev-test-proj');

  db.prepare(`
    INSERT INTO project_memory_revision(project_id, revision, owner_type, owner_id)
    VALUES (?, 1, 'workspace', ?)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1
  `).run('rev-test-proj', 'rev-test-proj');

  const row = db.prepare('SELECT revision FROM project_memory_revision WHERE project_id = ?').get('rev-test-proj');
  assert.equal(row.revision, 2, 'revision must bump correctly via ON CONFLICT(project_id)');
});

test('pm_memory_injection ON CONFLICT(pm_run_id) still works after migration 039', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  insertProject(db, 'inject-test-proj');

  const stmt = db.prepare(`
    INSERT INTO pm_memory_injection(pm_run_id, project_id, injected_revision, injected_at, owner_type, owner_id)
    VALUES ('run-x', 'inject-test-proj', 5, datetime('now'), 'workspace', 'inject-test-proj')
    ON CONFLICT(pm_run_id) DO UPDATE SET
      injected_revision = excluded.injected_revision,
      injected_at = excluded.injected_at
  `);
  stmt.run();
  stmt.run(); // second run should upsert

  const count = db.prepare("SELECT COUNT(*) AS n FROM pm_memory_injection WHERE pm_run_id = 'run-x'").get().n;
  assert.equal(count, 1, 'ON CONFLICT(pm_run_id) upsert must not duplicate');
});

// ──────────────────────────────────────────────────────────────
// Review fixes (Codex R-final): completeness (L2 items drop) + F1 (NULL-owner fail-closed)
// ──────────────────────────────────────────────────────────────

test('039 PART 4: old scope-unique dedup indexes dropped from master_memory_items (slice5 completeness)', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  // 030's (scope, content_hash) / (scope, fact_key) dedup uniques must be gone.
  for (const name of ['idx_master_memory_content_hash', 'idx_master_memory_factkey']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?").get(name);
    assert.equal(row, undefined, `${name} must be dropped by migration 039 PART 4`);
  }
  // 034's owner-unique replacement must remain (stricter dedup).
  assert.ok(
    hasUniqueIndex(db, 'master_memory_items', ['owner_type', 'owner_id', 'content_hash']),
    'owner-unique content_hash index must remain on master_memory_items'
  );
  // Non-unique provenance read index is KEPT.
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_master_memory_scope_status'").get(),
    'idx_master_memory_scope_status (read path) must be kept'
  );
});

test('039 F1: memory_candidates owner columns are NOT NULL (NULL-owner row rejected)', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  insertProject(db, 'notnull-proj');

  assert.throws(
    () => db.prepare(
      'INSERT INTO memory_candidates (id, project_id, rule, raw_json, dedup_key, status, created_at, updated_at, owner_type, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('null-owner-cand', 'notnull-proj', 'R1b', '{}', 'k', 'pending', '2026-01-01', '2026-01-01', null, null),
    /NOT NULL/,
    'NULL owner candidate must be rejected structurally'
  );
});

test('039 F1: master_memory_candidates owner columns are NOT NULL', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());

  assert.throws(
    () => db.prepare(
      'INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, status, created_at, updated_at, owner_type, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('null-owner-mm', 'user', 'R4', '{}', 'k', 'pending', '2026-01-01', '2026-01-01', null, null),
    /NOT NULL/,
    'NULL owner master candidate must be rejected structurally'
  );
});

test('039 F1 PART 0: a NULL-owner ACTIVE memory_items row aborts migration 039 (fail-closed)', (t) => {
  // Build to 038 (pre-039), create a normal item (owner set), corrupt it to
  // NULL owner, then apply 039 — PART 0 preflight must abort the migration.
  const db = buildMigratedDb({ upTo: 38 });
  t.after(() => db.close());
  insertProject(db, 'preflight-proj');
  const svc = createMemoryService(db);
  svc.createMemoryItem({ projectId: 'preflight-proj', kind: 'convention', content: 'x', origin: 'human' });
  db.prepare("UPDATE memory_items SET owner_type = NULL WHERE project_id = 'preflight-proj'").run();

  const sql039 = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '039_owner_keying_slice5_storage.sql'),
    'utf8'
  );
  assert.throws(
    () => db.exec(sql039),
    /constraint failed/i,
    'PART 0 preflight must abort when an active item has a NULL owner'
  );
});
