-- 037_owner_keying_slice3b.sql
-- P-A1 slice 3b [2]: owner-unique dedup index on memory_candidates.
-- This closes the gap where candidates used project_id-based UNIQUE but
-- the table already has owner_type/owner_id columns (added in slice3/033).
-- Dual index: both old UNIQUE(rule, project_id, dedup_key) and new
-- UNIQUE(owner_type, owner_id, rule, dedup_key) coexist until slice5 drops the old one.
-- L1: owner_id=project_id so existing rows satisfy both constraints.
-- No data migration needed.

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_candidates_owner_dedup
  ON memory_candidates(owner_type, owner_id, rule, dedup_key);
