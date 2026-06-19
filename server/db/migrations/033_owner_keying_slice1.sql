-- 033_owner_keying_slice1.sql
-- P-A1 Slice 1: owner-keying foundation — add nullable (owner_type, owner_id)
-- columns to the 9 memory tables, backfill existing rows, and add read-path
-- indexes.
--
-- IMPORTANT (Q2/Q6c): for the 4 revision/injection tables below
--   (project_memory_revision, pm_memory_injection, master_memory_revision,
--    master_memory_injection), slice 1 keeps the OLD PRIMARY KEY and OLD-key
-- bump/dedup semantics intact. The owner columns on those tables are
-- INFORMATIONAL in this slice — they will be promoted to structural keys in
-- the slice-4 table rebuild. Do NOT create owner-based UNIQUE indexes on
-- them here.
--
-- CORRECTION Q3: memory_jobs already has idx_memory_jobs_active on
-- (kind, project_id) WHERE status IN ('pending','running'). That index is the
-- single-flight enforcement. We do NOT add any owner-based partial-unique index
-- here; that is slice 3. The existing index is left untouched.
--
-- CORRECTION Q2: no existing UNIQUE or PRIMARY KEY is altered or dropped.
-- SQLite cannot ALTER a PK; table rebuilds are slice 4.
--
-- CORRECTION Q4: FTS5 virtual tables (memory_fts, master_memory_fts) and
-- their ai/ad/au triggers are not touched. owner is not an FTS field; ADD
-- COLUMN on the base tables does not affect the external-content FTS index.

-- ============================================================
-- L1 tables (owner_type='workspace', owner_id=project_id)
-- ============================================================

-- memory_items
ALTER TABLE memory_items ADD COLUMN owner_type TEXT;
ALTER TABLE memory_items ADD COLUMN owner_id TEXT;
UPDATE memory_items SET owner_type = 'workspace', owner_id = project_id;

-- memory_candidates
ALTER TABLE memory_candidates ADD COLUMN owner_type TEXT;
ALTER TABLE memory_candidates ADD COLUMN owner_id TEXT;
UPDATE memory_candidates SET owner_type = 'workspace', owner_id = project_id;

-- memory_jobs
ALTER TABLE memory_jobs ADD COLUMN owner_type TEXT;
ALTER TABLE memory_jobs ADD COLUMN owner_id TEXT;
UPDATE memory_jobs SET owner_type = 'workspace', owner_id = project_id;

-- project_memory_revision (INFORMATIONAL — old PK project_id unchanged)
ALTER TABLE project_memory_revision ADD COLUMN owner_type TEXT;
ALTER TABLE project_memory_revision ADD COLUMN owner_id TEXT;
UPDATE project_memory_revision SET owner_type = 'workspace', owner_id = project_id;

-- pm_memory_injection (INFORMATIONAL — old PK pm_run_id unchanged)
ALTER TABLE pm_memory_injection ADD COLUMN owner_type TEXT;
ALTER TABLE pm_memory_injection ADD COLUMN owner_id TEXT;
UPDATE pm_memory_injection SET owner_type = 'workspace', owner_id = project_id;

-- ============================================================
-- L2 tables (owner_type='user', owner_id='user')
-- scope IN ('user','cross_project') — both collapse to ('user','user')
-- ============================================================

-- master_memory_items
ALTER TABLE master_memory_items ADD COLUMN owner_type TEXT;
ALTER TABLE master_memory_items ADD COLUMN owner_id TEXT;
UPDATE master_memory_items SET owner_type = 'user', owner_id = 'user'
  WHERE scope IN ('user', 'cross_project');

-- master_memory_candidates
ALTER TABLE master_memory_candidates ADD COLUMN owner_type TEXT;
ALTER TABLE master_memory_candidates ADD COLUMN owner_id TEXT;
UPDATE master_memory_candidates SET owner_type = 'user', owner_id = 'user'
  WHERE scope IN ('user', 'cross_project');

-- master_memory_revision (INFORMATIONAL — old PK scope unchanged)
ALTER TABLE master_memory_revision ADD COLUMN owner_type TEXT;
ALTER TABLE master_memory_revision ADD COLUMN owner_id TEXT;
UPDATE master_memory_revision SET owner_type = 'user', owner_id = 'user';

-- master_memory_injection (INFORMATIONAL — old composite PK (master_run_id, scope) unchanged)
ALTER TABLE master_memory_injection ADD COLUMN owner_type TEXT;
ALTER TABLE master_memory_injection ADD COLUMN owner_id TEXT;
UPDATE master_memory_injection SET owner_type = 'user', owner_id = 'user';

-- ============================================================
-- Read-path indexes (non-unique) for owner-based filtering.
-- Only the 4 tables we will filter by owner on reads in future slices.
-- memory_jobs, project_memory_revision, pm_memory_injection,
-- master_memory_revision, master_memory_injection are omitted per design.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_memory_items_owner
  ON memory_items(owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_owner
  ON memory_candidates(owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_master_memory_items_owner
  ON master_memory_items(owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_master_memory_candidates_owner
  ON master_memory_candidates(owner_type, owner_id);
