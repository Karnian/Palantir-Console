'use strict';

// Operator P-B1 — Profile owner storage reservation.
//
// Verifies (storage-only, behavior-preserving, unwired):
//   1. normalizeOwner gains a profile mapping + stays fail-closed (exactly-one key).
//   2. Migration 042 lets a profile row EXIST in the L1 staging tables
//      (memory_jobs / memory_candidates) with project_id NULL, and the coherence
//      CHECK rejects incoherent shapes (Codex S1: owner_id=project_id for workspace).
//   3. Owner-unique dedup still holds for profile owners.
//   4. checkOwnerParity is profile-aware ONLY in staging tables (Codex S2); a
//      profile row in a non-staging table is flagged; workspace-only DB stays [].
//   5. The distill claim is workspace-only on the unfiltered drain path so a
//      profile job is never claimed (Codex B1).
//   6. idx_memory_jobs_active (project_id single-flight) is dropped (Codex Q4/N1);
//      listProjectsWithPendingCandidates excludes NULL project_id (Codex S3).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const { normalizeOwner } = require('../services/ownerKey');
const { createMemoryService } = require('../services/memoryService');

// ──────────────────────────────────────────────────────────────
// Helpers (mirror owner-keying-slice5-storage.test.js)
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

const CHECK = { code: 'SQLITE_CONSTRAINT_CHECK' };
const UNIQUE = { code: 'SQLITE_CONSTRAINT_UNIQUE' };

// ──────────────────────────────────────────────────────────────
// 1. normalizeOwner profile mapping + fail-closed
// ──────────────────────────────────────────────────────────────
test('normalizeOwner: profile_id maps to (profile, profile_id)', () => {
  assert.deepEqual(normalizeOwner({ profile_id: 'p1' }), { owner_type: 'profile', owner_id: 'p1' });
});

test('normalizeOwner: empty / whitespace / non-string profile_id throws', () => {
  assert.throws(() => normalizeOwner({ profile_id: '' }), /profile_id must be a non-empty string/);
  assert.throws(() => normalizeOwner({ profile_id: '   ' }), /profile_id must be a non-empty string/);
  assert.throws(() => normalizeOwner({ profile_id: 123 }), /profile_id must be a non-empty string/);
});

test('normalizeOwner (N2): two keys present throws (profile+project_id, profile+scope, project+scope)', () => {
  assert.throws(() => normalizeOwner({ profile_id: 'p', project_id: 'x' }), /exactly one of/);
  assert.throws(() => normalizeOwner({ profile_id: 'p', scope: 'user' }), /exactly one of/);
  assert.throws(() => normalizeOwner({ project_id: 'x', scope: 'user' }), /exactly one of/);
});

test('normalizeOwner: existing workspace/user mappings unchanged (behavior-preserving)', () => {
  assert.deepEqual(normalizeOwner({ project_id: 'proj' }), { owner_type: 'workspace', owner_id: 'proj' });
  assert.deepEqual(normalizeOwner({ scope: 'user' }), { owner_type: 'user', owner_id: 'user' });
  assert.deepEqual(normalizeOwner({ scope: 'cross_project' }), { owner_type: 'user', owner_id: 'user' });
});

// ──────────────────────────────────────────────────────────────
// 2. Migration 042: profile row INSERT + coherence CHECK
// ──────────────────────────────────────────────────────────────
test('042: a profile row inserts into memory_jobs and memory_candidates (project_id NULL)', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  assert.doesNotThrow(() => db.prepare(
    "INSERT INTO memory_jobs (id,kind,project_id,status,owner_type,owner_id) VALUES ('jp1','distill',NULL,'pending','profile','pf-a')"
  ).run());
  assert.doesNotThrow(() => db.prepare(
    "INSERT INTO memory_candidates (id,project_id,rule,raw_json,dedup_key,owner_type,owner_id) VALUES ('cp1',NULL,'R4','{}','k1','profile','pf-a')"
  ).run());
});

test('042 coherence CHECK: workspace row with NULL project_id is rejected', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  assert.throws(() => db.prepare(
    "INSERT INTO memory_jobs (id,kind,project_id,status,owner_type,owner_id) VALUES ('jw','distill',NULL,'pending','workspace','x')"
  ).run(), CHECK);
  assert.throws(() => db.prepare(
    "INSERT INTO memory_candidates (id,project_id,rule,raw_json,dedup_key,owner_type,owner_id) VALUES ('cw',NULL,'R4','{}','k','workspace','x')"
  ).run(), CHECK);
});

test('042 coherence CHECK: profile row with a non-null project_id is rejected', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  const proj = insertProject(db, 'proj-coh');
  assert.throws(() => db.prepare(
    "INSERT INTO memory_jobs (id,kind,project_id,status,owner_type,owner_id) VALUES ('jp2','distill',?, 'pending','profile','pf-a')"
  ).run(proj), CHECK);
});

test('042 coherence CHECK (S1): workspace owner_id != project_id is rejected', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  const proj = insertProject(db, 'proj-mm');
  assert.throws(() => db.prepare(
    "INSERT INTO memory_jobs (id,kind,project_id,status,owner_type,owner_id) VALUES ('jmm','distill',?, 'pending','workspace','NOT-THE-PROJECT')"
  ).run(proj), CHECK);
  assert.throws(() => db.prepare(
    "INSERT INTO memory_candidates (id,project_id,rule,raw_json,dedup_key,owner_type,owner_id) VALUES ('cmm',?, 'R4','{}','k','workspace','NOT-THE-PROJECT')"
  ).run(proj), CHECK);
});

test('042 coherence CHECK: profile row with empty owner_id is rejected', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  assert.throws(() => db.prepare(
    "INSERT INTO memory_jobs (id,kind,project_id,status,owner_type,owner_id) VALUES ('je','distill',NULL,'pending','profile','')"
  ).run(), CHECK);
});

// ──────────────────────────────────────────────────────────────
// 3. Owner-unique dedup still holds for profile owners
// ──────────────────────────────────────────────────────────────
test('042: profile owner-unique dedup — same (owner,rule,dedup_key) blocked, different owner coexists', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  const ins = db.prepare(
    "INSERT INTO memory_candidates (id,project_id,rule,raw_json,dedup_key,owner_type,owner_id) VALUES (?,NULL,'R4','{}',?, 'profile',?)"
  );
  ins.run('c1', 'k', 'pf-A');
  // same owner + rule + dedup_key -> UNIQUE
  assert.throws(() => ins.run('c2', 'k', 'pf-A'), UNIQUE);
  // different profile owner, same dedup_key -> allowed
  assert.doesNotThrow(() => ins.run('c3', 'k', 'pf-B'));
  const n = db.prepare("SELECT COUNT(*) AS n FROM memory_candidates WHERE dedup_key='k'").get().n;
  assert.equal(n, 2);
});

// ──────────────────────────────────────────────────────────────
// 4. checkOwnerParity: profile-aware in staging only (Codex S2)
// ──────────────────────────────────────────────────────────────
test('parity: workspace-only DB returns [] (behavior-preserving)', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  const proj = insertProject(db, 'proj-ws');
  const svc = createMemoryService(db);
  svc.enqueueDistillJob(proj);
  db.prepare(
    "INSERT INTO memory_candidates (id,project_id,rule,raw_json,dedup_key,owner_type,owner_id) VALUES ('cw',?, 'R4','{}','dkw','workspace',?)"
  ).run(proj, proj);
  assert.deepEqual(svc.checkOwnerParity(), []);
});

test('parity: coherent profile staging rows pass ([])', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  insertProject(db, 'proj-ws2');
  const svc = createMemoryService(db);
  svc.enqueueDistillJob('proj-ws2');
  db.prepare("INSERT INTO memory_jobs (id,kind,project_id,status,owner_type,owner_id) VALUES ('jpf','distill',NULL,'pending','profile','pf-1')").run();
  db.prepare("INSERT INTO memory_candidates (id,project_id,rule,raw_json,dedup_key,owner_type,owner_id) VALUES ('cpf',NULL,'R4','{}','dk','profile','pf-1')").run();
  assert.deepEqual(svc.checkOwnerParity(), []);
});

test('parity (S2): a profile row in a non-staging table (memory_items) is flagged', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  const proj = insertProject(db, 'proj-pi');
  // memory_items has no coherence CHECK and project_id is still NOT NULL (relaxed
  // only in P-B2); a profile owner there is incoherent → parity must flag it.
  db.prepare(
    "INSERT INTO memory_items (id, project_id, kind, content, content_hash, evidence_json, origin, owner_type, owner_id) VALUES ('mi-1',?, 'convention','c','h','{}','human','profile','profile-x')"
  ).run(proj);
  const mism = createMemoryService(db).checkOwnerParity();
  assert.ok(
    mism.some((m) => m.table === 'memory_items' && m.pk === 'mi-1'),
    `expected memory_items profile row flagged, got ${JSON.stringify(mism)}`
  );
});

// ──────────────────────────────────────────────────────────────
// 5. B1: drain claim is workspace-only (profile job never claimed)
// ──────────────────────────────────────────────────────────────
test('B1: unfiltered drain claim (projectId=null) claims workspace, never a profile job', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  const svc = createMemoryService(db);
  const proj = insertProject(db, 'proj-claim');
  svc.enqueueDistillJob(proj); // workspace job (coherent, via service)
  db.prepare( // profile job (schema allows it; service path unwired)
    "INSERT INTO memory_jobs (id,kind,project_id,status,owner_type,owner_id) VALUES ('job-pf','distill',NULL,'pending','profile','pf-xyz')"
  ).run();

  const claimed = svc.claimDistillJob({ projectId: null });
  assert.ok(claimed, 'claims a job');
  assert.equal(claimed.owner_type, 'workspace');
  assert.equal(claimed.project_id, proj);

  // profile job stays pending; no further workspace job is claimable
  assert.equal(db.prepare("SELECT status FROM memory_jobs WHERE id='job-pf'").get().status, 'pending');
  assert.equal(svc.claimDistillJob({ projectId: null }), null, 'profile job excluded from drain');
});

// ──────────────────────────────────────────────────────────────
// 6. Index drop (Q4/N1) + legacy enumerator null-guard (S3)
// ──────────────────────────────────────────────────────────────
test('042 (Q4/N1): idx_memory_jobs_active dropped; idx_memory_jobs_owner_active present', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  const idx = db.prepare("PRAGMA index_list('memory_jobs')").all().map((i) => i.name);
  assert.ok(!idx.includes('idx_memory_jobs_active'), 'old project_id single-flight index dropped');
  assert.ok(idx.includes('idx_memory_jobs_owner_active'), 'owner single-flight index present');
});

test('S3: listProjectsWithPendingCandidates excludes NULL project_id (profile candidate)', (t) => {
  const db = buildMigratedDb();
  t.after(() => db.close());
  const proj = insertProject(db, 'proj-s3');
  const svc = createMemoryService(db);
  svc.createCandidate({ projectId: proj, rule: 'R4', rawJson: { content: 'x', kind: 'convention' }, dedupKey: 'dk-w' });
  db.prepare("INSERT INTO memory_candidates (id,project_id,rule,raw_json,dedup_key,owner_type,owner_id) VALUES ('cpf2',NULL,'R4','{}','dk-pf','profile','pf-9')").run();
  assert.deepEqual(svc.listProjectsWithPendingCandidates(), [proj]);
});
