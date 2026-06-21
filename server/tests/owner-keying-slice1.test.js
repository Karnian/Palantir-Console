'use strict';

/**
 * P-A1 Slice 1: owner-keying foundation tests.
 *
 * Covers:
 *   1. migration 033 applies clean on a fresh DB.
 *   2. backfill: seed rows in all 9 tables, assert correct owner columns.
 *   3. checkOwnerParity() returns empty after backfill.
 *   4. normalizeOwner mapping table (L1 workspace, L2 user, cross_project→user, unknown→throw).
 *   5. dual-write: fresh inserts set owner; 0 NULL-owner rows after writes.
 *   6. cross-scope conflict KILL-test: same content_hash / fact_key across scopes → detection fires.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { createDatabase } = require('../db/database');
const { normalizeOwner } = require('../services/ownerKey');
const { createMemoryService } = require('../services/memoryService');
const { createMasterMemoryService } = require('../services/masterMemoryService');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Create a temp DB with all migrations applied (including 033).
async function setupDb(cleanup) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-ok-slice1-'));
  cleanup.push(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));
  const dbPath = path.join(tmp, 'test.db');
  // We need a projects row for FK constraints. Seed it after opening.
  const { db, migrate, close } = createDatabase(dbPath);
  cleanup.push(() => { try { close(); } catch { /* */ } });
  migrate();
  return db;
}

async function setupDbThroughMigration(cleanup, maxVersion) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-ok-slice1-pre-'));
  cleanup.push(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(tmp, 'test.db'));
  cleanup.push(() => { try { db.close(); } catch { /* */ } });
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);

  const migrDir = path.join(__dirname, '../db/migrations');
  const files = fs.readdirSync(migrDir)
    .filter(f => /^\d+.*\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = parseInt(file.match(/^(\d+)/)[1], 10);
    if (version > maxVersion) break;
    const sql = fs.readFileSync(path.join(migrDir, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
  }

  return db;
}

// ============================================================
// Helpers for seeding rows into each of the 9 tables
// ============================================================
function seedL1Rows(db, projectId = 'proj-test') {
  // Ensure project row exists (memory tables have FK to projects).
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?, ?, ?)"
  ).run(projectId, 'Test Project', '/tmp/test');

  // memory_items
  const itemId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO memory_items (id, project_id, kind, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES (?, ?, 'convention', ?, ?, '{}', 'human', 'workspace', ?)"
  ).run(itemId, projectId, 'seed content', sha256('seed content'), projectId);

  // memory_candidates
  const candId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO memory_candidates (id, project_id, rule, raw_json, dedup_key, owner_type, owner_id) VALUES (?, ?, 'R1b', ?, 'dk1', 'workspace', ?)"
  ).run(candId, projectId, JSON.stringify({ content: 'c', kind: 'convention' }), projectId);

  // memory_jobs (need status that satisfies single-flight index — use 'done' so we can insert freely)
  const jobId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO memory_jobs (id, kind, project_id, status, owner_type, owner_id) VALUES (?, 'distill', ?, 'done', 'workspace', ?)"
  ).run(jobId, projectId, projectId);

  // project_memory_revision
  db.prepare(
    "INSERT OR IGNORE INTO project_memory_revision (project_id, revision, owner_type, owner_id) VALUES (?, 1, 'workspace', ?)"
  ).run(projectId, projectId);

  // pm_memory_injection
  const runId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO pm_memory_injection (pm_run_id, project_id, injected_revision, owner_type, owner_id) VALUES (?, ?, 1, 'workspace', ?)"
  ).run(runId, projectId, projectId);

  return { projectId, itemId, candId, jobId, runId };
}

function seedL2Rows(db) {
  // master_memory_items
  const itemId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO master_memory_items (id, scope, kind, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES (?, 'user', 'pattern', ?, ?, '{}', 'human', 'user', 'user')"
  ).run(itemId, 'l2 seed content', sha256('l2 seed content'));

  // master_memory_candidates
  const candId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, owner_type, owner_id) VALUES (?, 'user', 'R4', ?, 'l2-dk1', 'user', 'user')"
  ).run(candId, JSON.stringify({ content: 'l2c', kind: 'pattern' }));

  // master_memory_revision
  db.prepare(
    "INSERT OR IGNORE INTO master_memory_revision (scope, revision, owner_type, owner_id) VALUES ('user', 1, 'user', 'user')"
  ).run();

  // master_memory_injection
  const masterRunId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO master_memory_injection (master_run_id, scope, injected_revision, owner_type, owner_id) VALUES (?, 'user', 1, 'user', 'user')"
  ).run(masterRunId);

  return { itemId, candId, masterRunId };
}

// ============================================================
// Test 1: migration 033 applies clean on fresh DB
// ============================================================
test('migration 033 applies on a fresh DB: all 9 tables gain owner_type and owner_id columns', async (t) => {
  const cleanup = [];
  try {
    // Pin to v33: this verifies migration 033's effect (owner cols on all 9
    // tables of that era). The pm/master_memory_injection tables are dropped by
    // migration 040 (S5-LEDGER PR B), so the "all 9 tables" assertion is scoped
    // to the post-033 schema where they still existed.
    const db = await setupDbThroughMigration(cleanup, 33);

    // Verify columns exist by querying table_info
    const tables = [
      'memory_items', 'memory_candidates', 'memory_jobs',
      'project_memory_revision', 'pm_memory_injection',
      'master_memory_items', 'master_memory_candidates',
      'master_memory_revision', 'master_memory_injection',
    ];

    for (const tbl of tables) {
      const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map(r => r.name);
      assert.ok(cols.includes('owner_type'), `${tbl} missing owner_type`);
      assert.ok(cols.includes('owner_id'), `${tbl} missing owner_id`);
    }

    // Verify non-unique indexes on the 4 read-path tables
    const idxTables = ['memory_items', 'memory_candidates', 'master_memory_items', 'master_memory_candidates'];
    for (const tbl of idxTables) {
      const idxList = db.prepare(`PRAGMA index_list(${tbl})`).all().map(r => r.name);
      const hasOwnerIdx = idxList.some(n => n.includes('owner'));
      assert.ok(hasOwnerIdx, `${tbl} missing owner index`);
    }

    // Verify idx_memory_jobs_active is NOT changed (single-flight preserved)
    const jobIdxList = db.prepare(`PRAGMA index_list(memory_jobs)`).all().map(r => r.name);
    assert.ok(jobIdxList.includes('idx_memory_jobs_active'), 'idx_memory_jobs_active must still exist');
  } finally {
    for (const fn of cleanup) await fn();
  }
});

// ============================================================
// Test 2: backfill — owner columns are set correctly on existing rows
// ============================================================
test('migration 033 backfill: L1 rows get workspace/project_id, L2 rows get user/user', async (t) => {
  // Create DB at migration 032 first, seed some rows, then apply 033.
  // Instead of rolling back to 032, we test on the fresh DB (no prior rows, backfill is a no-op)
  // and seed + recheck. The real backfill path is exercised by the parity test below.
  const cleanup = [];
  try {
    // Pin to v33 (post-033, pre-040): the injection tables still exist here so
    // seedL1Rows/seedL2Rows can write them; migration 040 drops them later.
    const db = await setupDbThroughMigration(cleanup, 33);
    const projectId = 'proj-backfill';
    const { itemId, candId, jobId, runId } = seedL1Rows(db, projectId);
    const { itemId: l2Id, candId: l2CandId, masterRunId } = seedL2Rows(db);

    // L1 checks
    const mi = db.prepare('SELECT owner_type, owner_id FROM memory_items WHERE id=?').get(itemId);
    assert.equal(mi.owner_type, 'workspace');
    assert.equal(mi.owner_id, projectId);

    const mc = db.prepare('SELECT owner_type, owner_id FROM memory_candidates WHERE id=?').get(candId);
    assert.equal(mc.owner_type, 'workspace');
    assert.equal(mc.owner_id, projectId);

    const mj = db.prepare('SELECT owner_type, owner_id FROM memory_jobs WHERE id=?').get(jobId);
    assert.equal(mj.owner_type, 'workspace');
    assert.equal(mj.owner_id, projectId);

    const pmr = db.prepare('SELECT owner_type, owner_id FROM project_memory_revision WHERE project_id=?').get(projectId);
    assert.equal(pmr.owner_type, 'workspace');
    assert.equal(pmr.owner_id, projectId);

    const pmi = db.prepare('SELECT owner_type, owner_id FROM pm_memory_injection WHERE pm_run_id=?').get(runId);
    assert.equal(pmi.owner_type, 'workspace');
    assert.equal(pmi.owner_id, projectId);

    // L2 checks
    const mmi = db.prepare('SELECT owner_type, owner_id FROM master_memory_items WHERE id=?').get(l2Id);
    assert.equal(mmi.owner_type, 'user');
    assert.equal(mmi.owner_id, 'user');

    const mmci = db.prepare('SELECT owner_type, owner_id FROM master_memory_candidates WHERE id=?').get(l2CandId);
    assert.equal(mmci.owner_type, 'user');
    assert.equal(mmci.owner_id, 'user');

    const mmr = db.prepare('SELECT owner_type, owner_id FROM master_memory_revision WHERE scope=?').get('user');
    assert.equal(mmr.owner_type, 'user');
    assert.equal(mmr.owner_id, 'user');

    const mminj = db.prepare('SELECT owner_type, owner_id FROM master_memory_injection WHERE master_run_id=?').get(masterRunId);
    assert.equal(mminj.owner_type, 'user');
    assert.equal(mminj.owner_id, 'user');
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('migration 033 backfill: pre-existing rows are correctly backfilled by the migration UPDATE', async (t) => {
  const cleanup = [];
  try {
    // Create temp dir + raw SQLite DB (bypass createDatabase to control migrations manually)
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-bf-pre-'));
    cleanup.push(() => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}));
    const dbPath = path.join(tmp, 'pre-migration.db');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    cleanup.push(() => { try { db.close(); } catch { /* */ } });

    // Apply migrations 001..032 only (stop before 033)
    const migrDir = path.join(__dirname, '../db/migrations');
    const allFiles = fs.readdirSync(migrDir)
      .filter(f => /^\d+.*\.sql$/.test(f))
      .sort();

    // Bootstrap schema_version table (mirrors database.js)
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )`);

    for (const file of allFiles) {
      const num = parseInt(file.match(/^(\d+)/)[1], 10);
      if (num > 32) break;
      const sql = fs.readFileSync(path.join(migrDir, file), 'utf8');
      db.exec(sql);
      db.prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (?)").run(num);
    }

    // Verify owner_type/owner_id columns do NOT exist yet (pre-033)
    const colsBefore = db.prepare("PRAGMA table_info(memory_items)").all().map(r => r.name);
    assert.ok(!colsBefore.includes('owner_type'), 'owner_type must not exist before 033');

    // Seed all 9 tables using OLD column shapes (no owner_* columns)
    const projectId = 'proj-bf';
    db.prepare("INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?, ?, ?)").run(projectId, 'BF', '/tmp/bf');

    // L1 seeds
    const itemId = crypto.randomUUID();
    db.prepare("INSERT INTO memory_items (id, project_id, kind, content, content_hash, evidence_json, origin) VALUES (?, ?, 'convention', 'bf content', ?, '{}', 'human')").run(itemId, projectId, sha256('bf content'));

    const candId = crypto.randomUUID();
    db.prepare("INSERT INTO memory_candidates (id, project_id, rule, raw_json, dedup_key) VALUES (?, ?, 'R1b', ?, 'dk-bf')").run(candId, projectId, JSON.stringify({ content: 'c', kind: 'convention' }));

    const jobId = crypto.randomUUID();
    db.prepare("INSERT INTO memory_jobs (id, kind, project_id, status) VALUES (?, 'distill', ?, 'done')").run(jobId, projectId);

    db.prepare("INSERT OR IGNORE INTO project_memory_revision (project_id, revision) VALUES (?, 1)").run(projectId);

    const pmRunId = crypto.randomUUID();
    db.prepare("INSERT INTO pm_memory_injection (pm_run_id, project_id, injected_revision) VALUES (?, ?, 1)").run(pmRunId, projectId);

    // L2 seeds — two scope values to prove cross_project→user collapse
    const l2ItemUserScopeId = crypto.randomUUID();
    db.prepare("INSERT INTO master_memory_items (id, scope, kind, content, content_hash, evidence_json, origin) VALUES (?, 'user', 'pattern', 'l2 user content', ?, '{}', 'human')").run(l2ItemUserScopeId, sha256('l2 user content'));

    const l2ItemCrossId = crypto.randomUUID();
    db.prepare("INSERT INTO master_memory_items (id, scope, kind, content, content_hash, evidence_json, origin) VALUES (?, 'cross_project', 'pattern', 'l2 cross content', ?, '{}', 'human')").run(l2ItemCrossId, sha256('l2 cross content'));

    const l2CandId = crypto.randomUUID();
    db.prepare("INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key) VALUES (?, 'user', 'R4', ?, 'l2-dk-bf')").run(l2CandId, JSON.stringify({ content: 'l2c', kind: 'pattern' }));

    db.prepare("INSERT OR IGNORE INTO master_memory_revision (scope, revision) VALUES ('user', 1)").run();
    db.prepare("INSERT OR IGNORE INTO master_memory_revision (scope, revision) VALUES ('cross_project', 1)").run();

    const masterRunId = crypto.randomUUID();
    db.prepare("INSERT INTO master_memory_injection (master_run_id, scope, injected_revision) VALUES (?, 'user', 1)").run(masterRunId);

    const masterRunId2 = crypto.randomUUID();
    db.prepare("INSERT INTO master_memory_injection (master_run_id, scope, injected_revision) VALUES (?, 'cross_project', 1)").run(masterRunId2);

    // Apply migration 033
    const sql033 = fs.readFileSync(path.join(migrDir, '033_owner_keying_slice1.sql'), 'utf8');
    db.exec(sql033);
    db.prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (?)").run(33);

    // Assert no NULL-owner rows across all 9 tables
    const tables9 = [
      'memory_items', 'memory_candidates', 'memory_jobs',
      'project_memory_revision', 'pm_memory_injection',
      'master_memory_items', 'master_memory_candidates',
      'master_memory_revision', 'master_memory_injection',
    ];
    for (const tbl of tables9) {
      const count = db.prepare(`SELECT COUNT(*) as n FROM ${tbl} WHERE owner_type IS NULL OR owner_id IS NULL`).get().n;
      assert.equal(count, 0, `${tbl}: expected 0 NULL-owner rows after backfill, got ${count}`);
    }

    // Assert L1 rows have correct owner
    const mi = db.prepare('SELECT owner_type, owner_id FROM memory_items WHERE id=?').get(itemId);
    assert.equal(mi.owner_type, 'workspace');
    assert.equal(mi.owner_id, projectId);

    const mc = db.prepare('SELECT owner_type, owner_id FROM memory_candidates WHERE id=?').get(candId);
    assert.equal(mc.owner_type, 'workspace');
    assert.equal(mc.owner_id, projectId);

    const mj = db.prepare('SELECT owner_type, owner_id FROM memory_jobs WHERE id=?').get(jobId);
    assert.equal(mj.owner_type, 'workspace');
    assert.equal(mj.owner_id, projectId);

    const pmr = db.prepare('SELECT owner_type, owner_id FROM project_memory_revision WHERE project_id=?').get(projectId);
    assert.equal(pmr.owner_type, 'workspace');
    assert.equal(pmr.owner_id, projectId);

    const pmi = db.prepare('SELECT owner_type, owner_id FROM pm_memory_injection WHERE pm_run_id=?').get(pmRunId);
    assert.equal(pmi.owner_type, 'workspace');
    assert.equal(pmi.owner_id, projectId);

    // Assert L2 rows — both scope='user' and scope='cross_project' collapse to user/user
    const mmiUser = db.prepare('SELECT owner_type, owner_id FROM master_memory_items WHERE id=?').get(l2ItemUserScopeId);
    assert.equal(mmiUser.owner_type, 'user');
    assert.equal(mmiUser.owner_id, 'user');

    const mmiCross = db.prepare('SELECT owner_type, owner_id FROM master_memory_items WHERE id=?').get(l2ItemCrossId);
    assert.equal(mmiCross.owner_type, 'user', 'cross_project scope must backfill to user owner_type');
    assert.equal(mmiCross.owner_id, 'user', 'cross_project scope must backfill to user owner_id');

    const mmci = db.prepare('SELECT owner_type, owner_id FROM master_memory_candidates WHERE id=?').get(l2CandId);
    assert.equal(mmci.owner_type, 'user');
    assert.equal(mmci.owner_id, 'user');

    const mmrUser = db.prepare('SELECT owner_type, owner_id FROM master_memory_revision WHERE scope=?').get('user');
    assert.equal(mmrUser.owner_type, 'user');
    assert.equal(mmrUser.owner_id, 'user');

    const mmrCross = db.prepare('SELECT owner_type, owner_id FROM master_memory_revision WHERE scope=?').get('cross_project');
    assert.equal(mmrCross.owner_type, 'user', 'cross_project revision must backfill to user owner_type');
    assert.equal(mmrCross.owner_id, 'user', 'cross_project revision must backfill to user owner_id');

    const mminjUser = db.prepare('SELECT owner_type, owner_id FROM master_memory_injection WHERE master_run_id=?').get(masterRunId);
    assert.equal(mminjUser.owner_type, 'user');
    assert.equal(mminjUser.owner_id, 'user');

    const mminjCross = db.prepare('SELECT owner_type, owner_id FROM master_memory_injection WHERE master_run_id=?').get(masterRunId2);
    assert.equal(mminjCross.owner_type, 'user', 'cross_project injection must backfill to user owner_type');
    assert.equal(mminjCross.owner_id, 'user', 'cross_project injection must backfill to user owner_id');

    // checkOwnerParity() returns [] on this db
    const svc = createMemoryService(db);
    const mismatches = svc.checkOwnerParity();
    assert.deepEqual(mismatches, [], `Expected no parity mismatches, got: ${JSON.stringify(mismatches)}`);

  } finally {
    for (const fn of cleanup) await fn();
  }
});

// ============================================================
// Test 3: checkOwnerParity returns empty after correctly seeded rows
// ============================================================
test('checkOwnerParity: returns empty list when all rows have correct owner', async (t) => {
  const cleanup = [];
  try {
    // Pin to v33: seedL1Rows/seedL2Rows write the legacy injection tables, which
    // migration 040 (S5-LEDGER PR B) drops. checkOwnerParity no longer checks
    // those tables, so parity holds for the remaining owner-keyed tables.
    const db = await setupDbThroughMigration(cleanup, 33);
    const projectId = 'proj-parity';
    seedL1Rows(db, projectId);
    seedL2Rows(db);

    const svc = createMemoryService(db);
    const mismatches = svc.checkOwnerParity();
    assert.deepEqual(mismatches, [], `Expected no parity mismatches, got: ${JSON.stringify(mismatches)}`);
  } finally {
    for (const fn of cleanup) await fn();
  }
});

// ============================================================
// Test 4: normalizeOwner mapping table
// ============================================================
test('normalizeOwner: L1 project_id -> workspace', () => {
  const r = normalizeOwner({ project_id: 'proj-abc' });
  assert.equal(r.owner_type, 'workspace');
  assert.equal(r.owner_id, 'proj-abc');
});

test('normalizeOwner: L2 scope=user -> user/user', () => {
  const r = normalizeOwner({ scope: 'user' });
  assert.equal(r.owner_type, 'user');
  assert.equal(r.owner_id, 'user');
});

test('normalizeOwner: L2 scope=cross_project -> user/user (collapse)', () => {
  const r = normalizeOwner({ scope: 'cross_project' });
  assert.equal(r.owner_type, 'user');
  assert.equal(r.owner_id, 'user');
});

test('normalizeOwner: unknown shape throws (fail-closed)', () => {
  assert.throws(() => normalizeOwner({}), /project_id|scope/);
  assert.throws(() => normalizeOwner({ scope: 'bad_scope' }), /scope/);
  assert.throws(() => normalizeOwner({ project_id: '' }), /non-empty/);
  assert.throws(() => normalizeOwner(null), /non-null/);
  assert.throws(() => normalizeOwner(undefined), /non-null/);
  assert.throws(() => normalizeOwner('string'), /non-null/);
  assert.throws(() => normalizeOwner([]), /non-null/);
});

test('normalizeOwner: both project_id and scope present → throws (fail-closed, reject-both)', () => {
  assert.throws(
    () => normalizeOwner({ project_id: 'p1', scope: 'user' }),
    /exactly one of project_id.*scope|not both/
  );
});

// ============================================================
// Test 5: dual-write — fresh inserts via service set owner correctly
// ============================================================
test('dual-write L1: createMemoryItem sets owner_type=workspace, owner_id=project_id', async (t) => {
  const cleanup = [];
  try {
    const db = await setupDb(cleanup);
    const projectId = 'proj-dw1';
    db.prepare("INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?, ?, ?)").run(projectId, 'DW1', '/tmp/dw1');

    const svc = createMemoryService(db);
    const item = svc.createMemoryItem({
      projectId,
      kind: 'convention',
      content: 'test dual write content',
      origin: 'human',
    });
    assert.ok(item && item.id, 'item created');

    const row = db.prepare('SELECT owner_type, owner_id FROM memory_items WHERE id=?').get(item.id);
    assert.equal(row.owner_type, 'workspace', 'owner_type must be workspace');
    assert.equal(row.owner_id, projectId, 'owner_id must match project_id');

    // Assert 0 NULL owner rows
    const nullCount = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE owner_type IS NULL OR owner_id IS NULL").get().n;
    assert.equal(nullCount, 0, 'no NULL owner rows in memory_items');
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('dual-write L1: upsertFact sets owner_type=workspace', async (t) => {
  const cleanup = [];
  try {
    const db = await setupDb(cleanup);
    const projectId = 'proj-dw-fact';
    db.prepare("INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?, ?, ?)").run(projectId, 'DWFact', '/tmp/dwfact');

    const svc = createMemoryService(db);
    svc.upsertFact({ projectId, factKey: 'env.node_version', content: 'node 22', origin: 'rule:R6' });

    const nullCount = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE owner_type IS NULL OR owner_id IS NULL").get().n;
    assert.equal(nullCount, 0);
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('dual-write L1: createCandidate (memory_candidates) sets owner', async (t) => {
  const cleanup = [];
  try {
    const db = await setupDb(cleanup);
    const projectId = 'proj-dw-cand';
    db.prepare("INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?, ?, ?)").run(projectId, 'DWCand', '/tmp/dwcand');

    const svc = createMemoryService(db);
    svc.createCandidate({
      projectId,
      rule: 'R1b',
      rawJson: JSON.stringify({ content: 'cand content', kind: 'convention' }),
      dedupKey: 'dk-dw',
    });

    const nullCount = db.prepare("SELECT COUNT(*) n FROM memory_candidates WHERE owner_type IS NULL OR owner_id IS NULL").get().n;
    assert.equal(nullCount, 0);
    const row = db.prepare("SELECT owner_type, owner_id FROM memory_candidates WHERE project_id=? AND dedup_key='dk-dw'").get(projectId);
    assert.equal(row.owner_type, 'workspace');
    assert.equal(row.owner_id, projectId);
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('dual-write L1: enqueueDistillJob (memory_jobs) sets owner', async (t) => {
  const cleanup = [];
  try {
    const db = await setupDb(cleanup);
    const projectId = 'proj-dw-job';
    db.prepare("INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?, ?, ?)").run(projectId, 'DWJob', '/tmp/dwjob');

    const svc = createMemoryService(db);
    svc.enqueueDistillJob(projectId);

    const nullCount = db.prepare("SELECT COUNT(*) n FROM memory_jobs WHERE owner_type IS NULL OR owner_id IS NULL").get().n;
    assert.equal(nullCount, 0);
    const row = db.prepare("SELECT owner_type, owner_id FROM memory_jobs WHERE project_id=?").get(projectId);
    assert.equal(row.owner_type, 'workspace');
    assert.equal(row.owner_id, projectId);
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('dual-write L2: createMemoryItem (master_memory_items) sets owner user/user', async (t) => {
  const cleanup = [];
  try {
    const db = await setupDb(cleanup);
    const svc = createMasterMemoryService(db);
    const item = svc.createMemoryItem({
      scope: 'user',
      kind: 'pattern',
      content: 'l2 dual write content',
      origin: 'human',
    });
    assert.ok(item && item.id, 'L2 item created');

    const row = db.prepare('SELECT owner_type, owner_id FROM master_memory_items WHERE id=?').get(item.id);
    assert.equal(row.owner_type, 'user');
    assert.equal(row.owner_id, 'user');

    const nullCount = db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE owner_type IS NULL OR owner_id IS NULL").get().n;
    assert.equal(nullCount, 0);
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('dual-write L2: createCandidate (master_memory_candidates) sets owner user/user', async (t) => {
  const cleanup = [];
  try {
    const db = await setupDb(cleanup);
    const svc = createMasterMemoryService(db);
    svc.createCandidate({
      scope: 'cross_project',
      rule: 'XPROJECT',
      rawJson: JSON.stringify({ content: 'xproj candidate', kind: 'pattern', content_hash: sha256('xproj candidate') }),
      dedupKey: sha256('xproj candidate'),
    });

    const nullCount = db.prepare("SELECT COUNT(*) n FROM master_memory_candidates WHERE owner_type IS NULL OR owner_id IS NULL").get().n;
    assert.equal(nullCount, 0);
    const row = db.prepare("SELECT owner_type, owner_id FROM master_memory_candidates WHERE scope='cross_project'").get();
    assert.equal(row.owner_type, 'user');
    assert.equal(row.owner_id, 'user');
  } finally {
    for (const fn of cleanup) await fn();
  }
});

// ============================================================
// Test 6: cross-scope conflict KILL-test
// ============================================================
test('detectCrossScopeConflicts: same content_hash across user+cross_project scopes → conflict detected', async (t) => {
  const cleanup = [];
  try {
    // Slice 2a adds owner-unique indexes that correctly reject this fixture.
    // Keep this slice-1 detector test on the through-033 schema.
    const db = await setupDbThroughMigration(cleanup, 33);

    const content = 'shared pattern cross scope';
    const hash = sha256(content);

    // Seed scope='user' item
    db.prepare(
      "INSERT INTO master_memory_items (id, scope, kind, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES (?, 'user', 'pattern', ?, ?, '{}', 'human', 'user', 'user')"
    ).run(crypto.randomUUID(), content, hash);

    // Seed scope='cross_project' item with SAME content_hash
    // This requires bypassing the UNIQUE(scope, content_hash) WHERE status='active' index,
    // since different scopes are allowed to have the same hash.
    // After slice 1 owner collapse both become ('user','user') -> conflict.
    db.prepare(
      "INSERT INTO master_memory_items (id, scope, kind, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES (?, 'cross_project', 'pattern', ?, ?, '{}', 'deterministic', 'user', 'user')"
    ).run(crypto.randomUUID(), content, hash);

    const svc = createMemoryService(db);
    const conflicts = svc.detectCrossScopeConflicts();

    const hashConflict = conflicts.items.find(c => c.key === 'content_hash' && c.key_value === hash);
    assert.ok(hashConflict, 'Expected content_hash conflict to be detected');
    assert.ok(hashConflict.count >= 2, `Expected count >= 2, got ${hashConflict.count}`);
    assert.equal(hashConflict.owner_type, 'user');
    assert.equal(hashConflict.owner_id, 'user');
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('detectCrossScopeConflicts: same fact_key across user+cross_project scopes → conflict detected', async (t) => {
  const cleanup = [];
  try {
    // Slice 2a adds owner-unique indexes that correctly reject this fixture.
    // Keep this slice-1 detector test on the through-033 schema.
    const db = await setupDbThroughMigration(cleanup, 33);

    const factKey = 'env.node_version';

    // Scope='user' fact
    db.prepare(
      "INSERT INTO master_memory_items (id, scope, kind, fact_key, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES (?, 'user', 'fact', ?, ?, ?, '{}', 'human', 'user', 'user')"
    ).run(crypto.randomUUID(), factKey, 'node 22 user', sha256('node 22 user'));

    // Scope='cross_project' fact with SAME fact_key — normally UNIQUE(scope, fact_key) allows this
    // since scope differs. After collapse to ('user','user') it becomes a conflict.
    db.prepare(
      "INSERT INTO master_memory_items (id, scope, kind, fact_key, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES (?, 'cross_project', 'fact', ?, ?, ?, '{}', 'deterministic', 'user', 'user')"
    ).run(crypto.randomUUID(), factKey, 'node 22 xproj', sha256('node 22 xproj'));

    const svc = createMemoryService(db);
    const conflicts = svc.detectCrossScopeConflicts();

    const fkConflict = conflicts.items.find(c => c.key === 'fact_key' && c.key_value === factKey);
    assert.ok(fkConflict, 'Expected fact_key conflict to be detected');
    assert.ok(fkConflict.count >= 2, `Expected count >= 2, got ${fkConflict.count}`);
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('detectCrossScopeConflicts: no conflict when rows are distinct', async (t) => {
  const cleanup = [];
  try {
    const db = await setupDb(cleanup);

    // Seed two distinct items across scopes — different content/fact_key
    db.prepare(
      "INSERT INTO master_memory_items (id, scope, kind, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES (?, 'user', 'pattern', ?, ?, '{}', 'human', 'user', 'user')"
    ).run(crypto.randomUUID(), 'unique user content', sha256('unique user content'));

    db.prepare(
      "INSERT INTO master_memory_items (id, scope, kind, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES (?, 'cross_project', 'pattern', ?, ?, '{}', 'deterministic', 'user', 'user')"
    ).run(crypto.randomUUID(), 'unique xproj content', sha256('unique xproj content'));

    const svc = createMemoryService(db);
    const conflicts = svc.detectCrossScopeConflicts();

    assert.equal(conflicts.items.length, 0, 'No item conflicts expected');
    assert.equal(conflicts.candidates.length, 0, 'No candidate conflicts expected');
  } finally {
    for (const fn of cleanup) await fn();
  }
});

// ============================================================
// Test 7: checkOwnerParity detects a mismatch when introduced manually
// ============================================================
test('checkOwnerParity: detects a row with wrong owner_id', async (t) => {
  const cleanup = [];
  try {
    const db = await setupDb(cleanup);
    const projectId = 'proj-parity-bad';
    db.prepare("INSERT OR IGNORE INTO projects (id, name, directory) VALUES (?, ?, ?)").run(projectId, 'PB', '/tmp/pb');

    // Insert with WRONG owner_id
    const itemId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO memory_items (id, project_id, kind, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES (?, ?, 'convention', 'c', 'h', '{}', 'human', 'workspace', 'WRONG_ID')"
    ).run(itemId, projectId);

    const svc = createMemoryService(db);
    const mismatches = svc.checkOwnerParity();

    const m = mismatches.find(r => r.table === 'memory_items' && r.pk === itemId);
    assert.ok(m, 'Should detect the mismatch in memory_items');
    assert.equal(m.actual.owner_id, 'WRONG_ID');
    assert.equal(m.expected.owner_id, projectId);
  } finally {
    for (const fn of cleanup) await fn();
  }
});

// ============================================================
// Test 8: candidates conflict detection — fix 1 regression suite
// ============================================================

test('detectCrossScopeConflicts candidates: same rule+dedup_key across different scopes → conflict reported', async (t) => {
  // Kill-test: directly INSERT two master_memory_candidates rows with the same rule
  // and dedup_key but different scopes (different scopes are allowed by the existing
  // UNIQUE(rule, scope, dedup_key) index). After owner collapse both map to user/user.
  // The fixed SQL (GROUP BY owner_type, owner_id, rule, dedup_key, no status filter)
  // must surface this pair.
  const cleanup = [];
  try {
    // Slice 2a adds owner-unique indexes that correctly reject this fixture.
    // Keep this slice-1 detector test on the through-033 schema.
    const db = await setupDbThroughMigration(cleanup, 33);

    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    db.prepare(
      "INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, owner_type, owner_id) VALUES (?, 'user', 'R4', ?, 'K', 'user', 'user')"
    ).run(id1, JSON.stringify({ content: 'c1', kind: 'pattern' }));

    db.prepare(
      "INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, owner_type, owner_id) VALUES (?, 'cross_project', 'R4', ?, 'K', 'user', 'user')"
    ).run(id2, JSON.stringify({ content: 'c2', kind: 'pattern' }));

    const svc = createMemoryService(db);
    const { candidates } = svc.detectCrossScopeConflicts();

    const conflict = candidates.find(c => c.rule === 'R4' && c.key_value === 'K');
    assert.ok(conflict, 'Expected R4/K candidate conflict to be detected');
    assert.ok(conflict.count >= 2, `Expected count >= 2, got ${conflict.count}`);
    assert.equal(conflict.owner_type, 'user');
    assert.equal(conflict.owner_id, 'user');
    assert.equal(conflict.key, 'dedup_key');
    // Both ids must appear in the conflict record
    const conflictIds = conflict.ids;
    assert.ok(conflictIds.includes(id1), 'id1 must appear in conflict ids');
    assert.ok(conflictIds.includes(id2), 'id2 must appear in conflict ids');
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('detectCrossScopeConflicts candidates: same dedup_key but DIFFERENT rules → no false positive', async (t) => {
  // Anti-regression: R4/scope=user/dedup_key=K2 and XPROJECT/scope=cross_project/dedup_key=K2
  // share dedup_key but differ in rule — the fixed GROUP BY (includes rule) must NOT
  // report them as a conflict.
  const cleanup = [];
  try {
    const db = await setupDb(cleanup);

    db.prepare(
      "INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, owner_type, owner_id) VALUES (?, 'user', 'R4', ?, 'K2', 'user', 'user')"
    ).run(crypto.randomUUID(), JSON.stringify({ content: 'r4 content', kind: 'pattern' }));

    db.prepare(
      "INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, owner_type, owner_id) VALUES (?, 'cross_project', 'XPROJECT', ?, 'K2', 'user', 'user')"
    ).run(crypto.randomUUID(), JSON.stringify({ content: 'xp content', kind: 'pattern' }));

    const svc = createMemoryService(db);
    const { candidates } = svc.detectCrossScopeConflicts();

    // No candidate conflict must exist for dedup_key='K2' (different rules → separate buckets)
    const falsePositive = candidates.find(c => c.key_value === 'K2');
    assert.ok(!falsePositive, `Expected no false-positive for K2, got: ${JSON.stringify(falsePositive)}`);
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('detectCrossScopeConflicts candidates: one row promoted → still detected (all-status scan)', async (t) => {
  // Regression: the old status='pending' filter would miss a conflict where one row
  // has been promoted. The fixed SQL drops the status filter entirely.
  const cleanup = [];
  try {
    // Slice 2a adds owner-unique indexes that correctly reject this fixture.
    // Keep this slice-1 detector test on the through-033 schema.
    const db = await setupDbThroughMigration(cleanup, 33);

    const idPending = crypto.randomUUID();
    const idPromoted = crypto.randomUUID();

    db.prepare(
      "INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, owner_type, owner_id) VALUES (?, 'user', 'R4', ?, 'K3', 'user', 'user')"
    ).run(idPending, JSON.stringify({ content: 'pending row', kind: 'pattern' }));

    db.prepare(
      "INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key, owner_type, owner_id, status) VALUES (?, 'cross_project', 'R4', ?, 'K3', 'user', 'user', 'promoted')"
    ).run(idPromoted, JSON.stringify({ content: 'promoted row', kind: 'pattern' }));

    const svc = createMemoryService(db);
    const { candidates } = svc.detectCrossScopeConflicts();

    const conflict = candidates.find(c => c.rule === 'R4' && c.key_value === 'K3');
    assert.ok(conflict, 'Expected conflict to be detected even when one row is promoted');
    assert.ok(conflict.ids.includes(idPending), 'pending id must be in conflict');
    assert.ok(conflict.ids.includes(idPromoted), 'promoted id must be in conflict');
  } finally {
    for (const fn of cleanup) await fn();
  }
});

test('normalizeOwner: both project_id and scope → throws (reject-both hardening)', () => {
  assert.throws(
    () => normalizeOwner({ project_id: 'p', scope: 'user' }),
    /exactly one of project_id.*scope|not both/,
    'Should throw when both project_id and scope are present'
  );
});
