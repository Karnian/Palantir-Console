-- 026_memory_candidates.sql
-- ML PR2b: rule-captured raw candidates. Deterministic rules (R1b fix-pairs,
-- R3 PM verdicts, R4 PM-origin remember) write here; promotion to active
-- memory_items is PR3 (batch LLM distill). This is the staging layer between
-- L0 episodic signals and L1 approved memory.
--
-- Spec: docs/specs/memory-layer-brief.md §4 (memory_candidates) + §5 (rules).
-- Idempotent via UNIQUE(rule, project_id, dedup_key) so process restart /
-- re-harvest / fixture replay cannot double-insert the same candidate.

CREATE TABLE memory_candidates (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule        TEXT NOT NULL,             -- 'R1b' | 'R3' | 'R4'
  raw_json    TEXT NOT NULL,             -- captured structured signal (object)
  dedup_key   TEXT NOT NULL,             -- idempotency key, rule-specific
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|promoted|rejected|merged
  promoted_to TEXT REFERENCES memory_items(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rule, project_id, dedup_key),
  CHECK (rule IN ('R1b','R3','R4')),
  CHECK (status IN ('pending','promoted','rejected','merged')),
  CHECK (json_valid(raw_json)),
  CHECK (json_type(raw_json) = 'object'),
  CHECK (length(dedup_key) BETWEEN 1 AND 512)
);
CREATE INDEX idx_memory_candidates_pending
  ON memory_candidates(project_id, status) WHERE status = 'pending';
