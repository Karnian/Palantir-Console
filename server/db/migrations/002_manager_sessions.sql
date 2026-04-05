-- 002_manager_sessions.sql
-- Add manager session support to runs table

-- is_manager: flag for manager sessions (vs worker sessions)
-- parent_run_id: links worker runs to their manager run
-- claude_session_id: Claude Code session_id from stream-json init event
ALTER TABLE runs ADD COLUMN is_manager INTEGER DEFAULT 0;
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN claude_session_id TEXT;

-- Make task_id optional (manager sessions don't need a task)
-- SQLite doesn't support ALTER COLUMN, but task_id already allows NULL via LEFT JOIN usage
-- Just add an index for parent_run_id lookups
CREATE INDEX idx_runs_parent ON runs(parent_run_id);
CREATE INDEX idx_runs_manager ON runs(is_manager) WHERE is_manager = 1;
