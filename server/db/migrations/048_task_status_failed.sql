-- migrate:no-foreign-keys
-- 048_task_status_failed.sql
-- Rebuild tasks so the persisted CHECK constraint accepts failed tasks.

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'backlog'
    CHECK(status IN ('backlog','todo','in_progress','failed','review','done')),
  priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  due_date TEXT
    CHECK (due_date IS NULL OR due_date GLOB '????-??-??'),
  recurrence TEXT
    CHECK (recurrence IS NULL OR recurrence IN ('daily', 'weekly', 'monthly')),
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  task_kind TEXT
    CHECK (task_kind IS NULL OR task_kind IN
      ('code_change','investigation','review','docs','refactor','other')),
  requires_capabilities TEXT
    CHECK (
      requires_capabilities IS NULL
      OR (json_valid(requires_capabilities) AND json_type(requires_capabilities) = 'array')
    ),
  suggested_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  acceptance_criteria TEXT,
  preferred_preset_id TEXT
);

INSERT INTO tasks_new (
  id, project_id, title, description, status, priority, sort_order,
  created_at, updated_at, due_date, recurrence, parent_task_id,
  task_kind, requires_capabilities, suggested_agent_profile_id,
  acceptance_criteria, preferred_preset_id
)
SELECT
  id, project_id, title, description, status, priority, sort_order,
  created_at, updated_at, due_date, recurrence, parent_task_id,
  task_kind, requires_capabilities, suggested_agent_profile_id,
  acceptance_criteria, preferred_preset_id
FROM tasks;

DROP TRIGGER IF EXISTS trg_task_skill_packs_cross_project_insert_guard;
DROP TRIGGER IF EXISTS trg_task_skill_packs_cross_project_update_guard;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_recurrence ON tasks(recurrence) WHERE recurrence IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_task_kind ON tasks(task_kind) WHERE task_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_suggested_agent ON tasks(suggested_agent_profile_id)
  WHERE suggested_agent_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_preferred_preset_id
  ON tasks(preferred_preset_id)
  WHERE preferred_preset_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_task_skill_packs_cross_project_insert_guard
  BEFORE INSERT ON task_skill_packs
  WHEN EXISTS (
    SELECT 1 FROM skill_packs sp
    JOIN tasks t ON t.id = NEW.task_id
    WHERE sp.id = NEW.skill_pack_id
      AND sp.scope = 'project'
      AND (t.project_id IS NULL OR sp.project_id != t.project_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'Cannot bind project-scope skill pack to task in different project');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_skill_packs_cross_project_update_guard
  BEFORE UPDATE ON task_skill_packs
  WHEN EXISTS (
    SELECT 1 FROM skill_packs sp
    JOIN tasks t ON t.id = NEW.task_id
    WHERE sp.id = NEW.skill_pack_id
      AND sp.scope = 'project'
      AND (t.project_id IS NULL OR sp.project_id != t.project_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'Cannot bind project-scope skill pack to task in different project');
END;
