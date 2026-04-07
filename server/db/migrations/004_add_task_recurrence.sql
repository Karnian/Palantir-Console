-- 004_add_task_recurrence.sql
-- Minimal recurring task support. Each task carries a recurrence rule
-- (none/daily/weekly/monthly). When a recurring task is marked 'done',
-- the lifecycle service generates a new task with the next due_date.
--
-- Design decisions (see CLAUDE.md / planning notes):
--  - No separate template table — recurrence lives on the task itself.
--  - parent_task_id links generated instances back to their origin so
--    we can compute the chain (informational only; not enforced).
--  - We do NOT backfill missed instances on server restart — only the
--    next instance is generated on completion or via ticker.

ALTER TABLE tasks ADD COLUMN recurrence TEXT
  CHECK (recurrence IS NULL OR recurrence IN ('daily', 'weekly', 'monthly'));

ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX idx_tasks_recurrence ON tasks(recurrence) WHERE recurrence IS NOT NULL;
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
