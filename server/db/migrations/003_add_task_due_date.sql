-- 003_add_task_due_date.sql
-- Add due_date (마감일) to tasks for deadline tracking on the board.
-- Stored as ISO YYYY-MM-DD string (DATE-only). Server validates format;
-- the GLOB CHECK is a lightweight guard against malformed inserts.

ALTER TABLE tasks ADD COLUMN due_date TEXT
  CHECK (due_date IS NULL OR due_date GLOB '????-??-??');

CREATE INDEX idx_tasks_due_date ON tasks(due_date);
