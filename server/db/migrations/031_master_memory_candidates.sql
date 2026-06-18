-- 031_master_memory_candidates.sql
-- L2 Master Memory P1c Slice 1: rule-captured raw candidates.
--
-- Mirrors L1 026_memory_candidates.sql for the user/cross-project Master layer:
-- deterministic captures stage structured signals here, and a human-approved
-- promotion path writes to master_memory_items. Idempotent via
-- UNIQUE(rule, scope, dedup_key), so retries/replays cannot double-stage.

CREATE TABLE master_memory_candidates (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  rule        TEXT NOT NULL,
  raw_json    TEXT NOT NULL,
  dedup_key   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  promoted_to TEXT REFERENCES master_memory_items(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rule, scope, dedup_key),
  CHECK (scope IN ('user','cross_project')),
  CHECK (rule IN ('R4','XPROJECT')),
  CHECK (status IN ('pending','promoted','rejected','merged')),
  CHECK (json_valid(raw_json)),
  CHECK (json_type(raw_json) = 'object'),
  CHECK (length(dedup_key) BETWEEN 1 AND 512)
);
CREATE INDEX idx_master_memory_candidates_scope_status
  ON master_memory_candidates(scope, status);
