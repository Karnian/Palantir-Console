-- 036_owner_keying_slice3.sql
-- P-A1 Slice 3: L1 memory_jobs owner-based partial-unique index.
-- Adds owner-based partial-unique alongside the existing project_id-based one.
-- Both coexist (dual index) until slice 5 drops the project_id index.
-- L1: owner_type='workspace', owner_id=project_id, so both constraints are
-- equivalent for all current rows — single-flight is preserved, not doubled.

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_jobs_owner_active
  ON memory_jobs(kind, owner_type, owner_id)
  WHERE status IN ('pending', 'running');
