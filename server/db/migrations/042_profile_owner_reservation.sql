-- 042_profile_owner_reservation.sql
-- Operator P-B1: reserve owner_type='profile' in the L1 STAGING tables.
--
-- A folder-less specialist (Operator P-B) has NO project. Its memory owner is
-- (owner_type='profile', owner_id=<profile_id>). The two tables where a profile
-- owner's pending work would first land — memory_jobs (distill queue) and
-- memory_candidates (raw signal staging) — currently force project_id NOT NULL
-- (027 / 039), which blocks any profile row. This migration relaxes that, so the
-- schema can REPRESENT a profile owner. No read/write path is wired (P-B2):
--   - createCandidate / enqueueDistillJob stay workspace-only;
--   - the distill drain claims workspace-only (memoryService claim guard);
--   - the scheduler still skips non-workspace owners.
-- So at runtime no profile row is ever created today → behavior-preserving.
--
-- memory_items (the promotion TARGET) is deliberately NOT relaxed here: it carries
-- the FTS5 virtual table + 3 triggers, and promotion is a write path. Its
-- relaxation is folded into P-B2 where profile promotion is wired & tested.
--
-- Pattern: 022/039 table rebuild (CREATE _new → INSERT SELECT → DROP → RENAME).
-- NEVER `CREATE TABLE AS SELECT` (silently drops constraints/CHECK/indexes).
-- foreign_keys=ON inside the runner's per-file transaction; both tables have NO
-- inbound FK references (grep: none), so DROP is safe (039 rebuilt
-- memory_candidates the same way). Outbound FKs (projects, memory_items) are
-- recreated and reference still-existing rows.
--
-- FAIL-CLOSED on bad existing data: the _new tables declare owner_type/owner_id
-- NOT NULL and a coherence CHECK; any pre-existing row that violates them makes
-- the INSERT SELECT throw → the runner's transaction rolls the whole file back.
-- 033 backfilled every row to (workspace, project_id), so this passes in practice.
--
-- COHERENCE CHECK (Codex P-B1 review S1): owner_id is the SAME owner key
-- normalizeOwner() derives and checkOwnerParity() re-derives, so the DB must pin
-- owner_id = project_id for workspace rows (not just owner_type↔project_id-null).
--   workspace -> project_id NOT NULL AND owner_id = project_id
--   profile   -> project_id NULL     AND owner_id non-empty
-- These L1 staging tables only ever hold workspace|profile (user lives in
-- master_* / L2), so hardcoding the two arms is the intended fail-closed vocab —
-- a future owner type is a deliberate, migration-gated change.

-- ============================================================
-- PART 1: memory_jobs rebuild
--   027 base + 033 owner cols (nullable→NOT NULL here) + 036 owner index.
--   project_id NOT NULL -> nullable. Drop idx_memory_jobs_active (027, project_id
--   single-flight): project_id is now nullable so a project_id-keyed single-flight
--   is incoherent for profile rows; idx_memory_jobs_owner_active (036) is the
--   canonical single-flight and is recreated below. (Completes the slice5 cleanup
--   intent that left memory_jobs' old index in place.)
-- ============================================================
CREATE TABLE memory_jobs_new (
  id          TEXT PRIMARY KEY,                    -- uuid
  kind        TEXT NOT NULL,                       -- 'distill' (only kind for now)
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- nullable (profile owner has no project)
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending|running|done|failed
  claim_token TEXT,
  locked_at   TEXT,
  run_after   TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  owner_type  TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  CHECK (status IN ('pending','running','done','failed')),
  CHECK (
    (owner_type = 'workspace' AND project_id IS NOT NULL AND owner_id = project_id)
    OR
    (owner_type = 'profile'   AND project_id IS NULL     AND owner_id IS NOT NULL AND length(owner_id) > 0)
  )
);

INSERT INTO memory_jobs_new
  (id, kind, project_id, status, claim_token, locked_at, run_after, attempts, last_error, created_at, updated_at, owner_type, owner_id)
SELECT
  id, kind, project_id, status, claim_token, locked_at, run_after, attempts, last_error, created_at, updated_at, owner_type, owner_id
FROM memory_jobs;

DROP TABLE memory_jobs;
ALTER TABLE memory_jobs_new RENAME TO memory_jobs;

-- Canonical owner-based single-flight (036). NOT recreating idx_memory_jobs_active.
CREATE UNIQUE INDEX idx_memory_jobs_owner_active
  ON memory_jobs(kind, owner_type, owner_id) WHERE status IN ('pending','running');
-- claim scan: pending + due, oldest first (027).
CREATE INDEX idx_memory_jobs_claimable
  ON memory_jobs(status, run_after, created_at);

-- ============================================================
-- PART 2: memory_candidates rebuild
--   039 schema, project_id NOT NULL -> nullable, + coherence CHECK.
--   Preserves owner-keyed UNIQUE + all CHECKs + non-unique indexes (slice5
--   contract: owner-keyed dedup present, old (rule, project_id, dedup_key) absent).
-- ============================================================
CREATE TABLE memory_candidates_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- nullable (profile owner)
  rule        TEXT NOT NULL,             -- 'R1b' | 'R3' | 'R4'
  raw_json    TEXT NOT NULL,             -- captured structured signal (object)
  dedup_key   TEXT NOT NULL,             -- idempotency key, rule-specific
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|promoted|rejected|merged
  promoted_to TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  owner_type  TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  UNIQUE (rule, owner_type, owner_id, dedup_key),
  CHECK (rule IN ('R1b','R3','R4')),
  CHECK (status IN ('pending','promoted','rejected','merged')),
  CHECK (json_valid(raw_json)),
  CHECK (json_type(raw_json) = 'object'),
  CHECK (length(dedup_key) BETWEEN 1 AND 512),
  CHECK (
    (owner_type = 'workspace' AND project_id IS NOT NULL AND owner_id = project_id)
    OR
    (owner_type = 'profile'   AND project_id IS NULL     AND owner_id IS NOT NULL AND length(owner_id) > 0)
  )
);

INSERT INTO memory_candidates_new
  (id, project_id, rule, raw_json, dedup_key, status, promoted_to, created_at, updated_at, owner_type, owner_id)
SELECT
  id, project_id, rule, raw_json, dedup_key, status, promoted_to, created_at, updated_at, owner_type, owner_id
FROM memory_candidates;

DROP TABLE memory_candidates;
ALTER TABLE memory_candidates_new RENAME TO memory_candidates;

-- Recreate non-UNIQUE indexes (039).
CREATE INDEX idx_memory_candidates_pending
  ON memory_candidates(project_id, status) WHERE status = 'pending';
CREATE INDEX idx_memory_candidates_owner
  ON memory_candidates(owner_type, owner_id);
