-- #444: Operator instances are archived, never hard-deleted. Historical runs
-- and dispatch audit rows intentionally retain their instance/profile
-- attribution, while active roster queries ignore archived rows.

ALTER TABLE operator_instances ADD COLUMN archived_at TEXT NULL;

CREATE INDEX idx_operator_instances_active
  ON operator_instances(updated_at DESC, created_at DESC, id)
  WHERE archived_at IS NULL;
