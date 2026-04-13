-- Phase 4-4: Acceptance checklist check state persistence
CREATE TABLE IF NOT EXISTS run_acceptance_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  check_index INTEGER NOT NULL,
  checked     INTEGER NOT NULL DEFAULT 0,
  checked_by  TEXT,         -- 'user' or 'pm'
  checked_at  TEXT,
  UNIQUE(run_id, check_index)
);
