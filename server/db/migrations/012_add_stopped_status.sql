-- Add 'stopped' to the runs status CHECK constraint.
-- SQLite cannot ALTER CHECK constraints, so we recreate the table.
-- 'stopped' is used by the boot cleanup path (routes/manager.js) to mark
-- stale manager runs from previous server instances.

-- Disable FK enforcement during table rebuild (self-referencing parent_run_id).
PRAGMA foreign_keys = OFF;

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  worktree_path TEXT,
  branch TEXT,
  tmux_session TEXT,
  status TEXT DEFAULT 'queued' CHECK(status IN ('queued','running','paused','needs_input','completed','failed','cancelled','stopped')),
  prompt TEXT,
  result_summary TEXT,
  exit_code INTEGER,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  error_message TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  is_manager INTEGER DEFAULT 0,
  parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  claude_session_id TEXT,
  manager_adapter TEXT,
  manager_thread_id TEXT,
  manager_layer TEXT CHECK (manager_layer IS NULL OR manager_layer IN ('top', 'pm')),
  conversation_id TEXT
);

INSERT INTO runs_new SELECT * FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

-- Recreate indexes lost during table rebuild.
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_manager ON runs(is_manager) WHERE is_manager = 1;
CREATE INDEX IF NOT EXISTS idx_runs_manager_adapter ON runs(manager_adapter) WHERE manager_adapter IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_manager_layer ON runs(manager_layer) WHERE manager_layer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_conversation_id ON runs(conversation_id) WHERE conversation_id IS NOT NULL;

PRAGMA foreign_keys = ON;
