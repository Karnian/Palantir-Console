-- 039_owner_keying_slice5_storage.sql
-- P-A1 S5-STORAGE: owner-keying storage cutover for L1 (L2 already done via 034).
--
-- 1. ADD owner-unique partial indexes on memory_items (active rows only).
--    Mirrors the existing (project_id, *) partial-unique semantics from 025
--    but keyed by (owner_type, owner_id) instead, enabling multi-owner isolation.
--    The old (project_id, *) indexes (idx_memory_content_hash, idx_memory_factkey)
--    are DROPPED after the new owner-unique indexes exist — L1 workspace rows have
--    owner_id=project_id so both constraints are equivalent for all existing rows.
--
-- 2. TABLE REBUILD for memory_candidates (L1) and master_memory_candidates (L2).
--    The dedup UNIQUE is a table-level constraint (026:21 / 031:19), which SQLite
--    cannot drop/add without rebuilding. We follow the 022_mcp pattern:
--      CREATE TABLE <name>_new  (full schema with new UNIQUE)
--      INSERT INTO <name>_new SELECT ... FROM <name>
--      DROP TABLE <name>
--      ALTER TABLE <name>_new RENAME TO <name>
--    All CHECKs, column defaults, and non-UNIQUE indexes are preserved.
--    NO `CREATE TABLE AS SELECT` (silently drops constraints/CHECK/indexes).
--
-- INVARIANT: revision/injection ON CONFLICT keys are NEVER touched.
--   - project_memory_revision  ON CONFLICT(project_id)           [025]
--   - pm_memory_injection       ON CONFLICT(pm_run_id)            [025]
--   - master_memory_revision   ON CONFLICT(scope)                 [030]
--   - master_memory_injection  ON CONFLICT(master_run_id, scope)  [030]
-- Those are provenance-keyed BY DESIGN and must remain unchanged.
--
-- All runs inside the startup migration path (single WAL connection, no
-- concurrent writers) — no hot-lock risk for the table rebuilds.

-- ============================================================
-- PART 0: owner preflight (fail-closed) — Codex review SERIOUS-1.
-- SQLite treats NULL as DISTINCT in UNIQUE indexes, so a NULL-owner row would
-- silently bypass the new owner-keyed dedup once the old project/scope indexes
-- are dropped. 033 backfilled every row, so this passes in practice; it aborts
-- the migration (the runner wraps each file in a transaction → full rollback)
-- if any ACTIVE item lacks an owner, rather than fail-open. Candidate tables
-- enforce this structurally via NOT NULL owner columns in their rebuild below.
-- ============================================================
CREATE TEMP TABLE _m039_owner_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _m039_owner_guard (ok) SELECT CASE WHEN (
  (SELECT COUNT(*) FROM memory_items
     WHERE status = 'active' AND (owner_type IS NULL OR owner_id IS NULL))
  + (SELECT COUNT(*) FROM master_memory_items
     WHERE status = 'active' AND (owner_type IS NULL OR owner_id IS NULL))
) = 0 THEN 1 ELSE 0 END;
DROP TABLE _m039_owner_guard;

-- ============================================================
-- PART 1: memory_items owner-unique partial indexes
-- ============================================================

-- Owner-unique content_hash dedup (active rows only).
-- Pair to idx_memory_content_hash (project_id, content_hash) from 025.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_owner_content_hash
  ON memory_items(owner_type, owner_id, content_hash)
  WHERE status = 'active';

-- Owner-unique fact_key dedup (active fact rows only).
-- Pair to idx_memory_factkey (project_id, fact_key) from 025.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_owner_factkey
  ON memory_items(owner_type, owner_id, fact_key)
  WHERE fact_key IS NOT NULL AND status = 'active';

-- Drop old project_id-keyed unique indexes now that owner-unique exists.
-- L1 workspace invariant: owner_id = project_id, so no constraint is weakened.
DROP INDEX IF EXISTS idx_memory_content_hash;
DROP INDEX IF EXISTS idx_memory_factkey;

-- ============================================================
-- PART 2: memory_candidates table rebuild
-- Replace UNIQUE(rule, project_id, dedup_key) → UNIQUE(rule, owner_type, owner_id, dedup_key)
-- ============================================================

CREATE TABLE memory_candidates_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule        TEXT NOT NULL,             -- 'R1b' | 'R3' | 'R4'
  raw_json    TEXT NOT NULL,             -- captured structured signal (object)
  dedup_key   TEXT NOT NULL,             -- idempotency key, rule-specific
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|promoted|rejected|merged
  promoted_to TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  owner_type  TEXT NOT NULL,           -- SERIOUS-1: NULL would bypass owner dedup
  owner_id    TEXT NOT NULL,           -- (033 backfilled; INSERT SELECT aborts on NULL)
  -- Owner-keyed dedup UNIQUE replaces the old (rule, project_id, dedup_key):
  UNIQUE (rule, owner_type, owner_id, dedup_key),
  CHECK (rule IN ('R1b','R3','R4')),
  CHECK (status IN ('pending','promoted','rejected','merged')),
  CHECK (json_valid(raw_json)),
  CHECK (json_type(raw_json) = 'object'),
  CHECK (length(dedup_key) BETWEEN 1 AND 512)
);

INSERT INTO memory_candidates_new
  (id, project_id, rule, raw_json, dedup_key, status, promoted_to, created_at, updated_at, owner_type, owner_id)
SELECT
  id, project_id, rule, raw_json, dedup_key, status, promoted_to, created_at, updated_at, owner_type, owner_id
FROM memory_candidates;

DROP TABLE memory_candidates;
ALTER TABLE memory_candidates_new RENAME TO memory_candidates;

-- Recreate non-UNIQUE indexes (dropped with old table).
CREATE INDEX idx_memory_candidates_pending
  ON memory_candidates(project_id, status) WHERE status = 'pending';

CREATE INDEX idx_memory_candidates_owner
  ON memory_candidates(owner_type, owner_id);

-- Owner-unique dedup index (now backed by the table UNIQUE, this is redundant
-- but kept for read-path performance on queries that use it as a covering index).
-- Note: the table UNIQUE already enforces this constraint at write time.
-- The explicit index here is for EXPLAIN/query-plan clarity; SQLite uses the
-- table constraint's implicit index for enforcement.
-- Actually, the table UNIQUE already creates an implicit index named after the
-- constraint. We do NOT add a separate idx_memory_candidates_owner_dedup here to
-- avoid duplicating constraint enforcement. The table UNIQUE suffices.

-- ============================================================
-- PART 3: master_memory_candidates table rebuild
-- Replace UNIQUE(rule, scope, dedup_key) → UNIQUE(rule, owner_type, owner_id, dedup_key)
-- ============================================================

CREATE TABLE master_memory_candidates_new (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  rule        TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  dedup_key   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  promoted_to TEXT REFERENCES master_memory_items(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  owner_type  TEXT NOT NULL,           -- SERIOUS-1: NULL would bypass owner dedup
  owner_id    TEXT NOT NULL,           -- (033 backfilled; INSERT SELECT aborts on NULL)
  -- Owner-keyed dedup UNIQUE replaces the old (rule, scope, dedup_key):
  UNIQUE (rule, owner_type, owner_id, dedup_key),
  CHECK (scope IN ('user','cross_project')),
  CHECK (rule IN ('R4','XPROJECT')),
  CHECK (status IN ('pending','promoted','rejected','merged')),
  CHECK (json_valid(raw_json)),
  CHECK (json_type(raw_json) = 'object'),
  CHECK (length(dedup_key) BETWEEN 1 AND 512)
);

INSERT INTO master_memory_candidates_new
  (id, scope, rule, raw_json, dedup_key, status, promoted_to, created_at, updated_at, owner_type, owner_id)
SELECT
  id, scope, rule, raw_json, dedup_key, status, promoted_to, created_at, updated_at, owner_type, owner_id
FROM master_memory_candidates;

DROP TABLE master_memory_candidates;
ALTER TABLE master_memory_candidates_new RENAME TO master_memory_candidates;

-- Recreate non-UNIQUE indexes.
CREATE INDEX idx_master_memory_candidates_scope_status
  ON master_memory_candidates(scope, status);

CREATE INDEX idx_master_memory_candidates_owner
  ON master_memory_candidates(owner_type, owner_id);

-- ============================================================
-- PART 4: drop L2 master_memory_items old scope-unique indexes (slice5 completeness).
-- 034 added owner-unique replacements (idx_master_memory_owner_content_hash /
-- idx_master_memory_owner_factkey); the owner-unique is STRICTER than the old
-- scope-unique (cross_project + user collapse to owner=(user,user)), and after
-- the slice2a merge no (owner) duplicates exist, so dropping the looser old
-- scope dedup indexes is safe. The non-unique read index
-- idx_master_memory_scope_status (provenance reads) is KEPT.
-- INVARIANT (unchanged): master_memory revision/injection stay scope-keyed.
-- ============================================================
DROP INDEX IF EXISTS idx_master_memory_content_hash;
DROP INDEX IF EXISTS idx_master_memory_factkey;
