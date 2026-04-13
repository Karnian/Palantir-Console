-- Skill Packs: Agent-Agnostic Capability Injection (Phase 1a)

-- MCP server templates (code/config seed-only, no API CRUD in v1)
CREATE TABLE IF NOT EXISTS mcp_server_templates (
  id               TEXT PRIMARY KEY,
  alias            TEXT NOT NULL UNIQUE,
  command          TEXT NOT NULL,
  args             TEXT,              -- JSON array, max 4KB
  allowed_env_keys TEXT,              -- JSON array of permitted env key names
  description      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Skill pack definitions
CREATE TABLE IF NOT EXISTS skill_packs (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT,
  scope                    TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','project')),
  project_id               TEXT REFERENCES projects(id) ON DELETE CASCADE,
  icon                     TEXT,
  color                    TEXT,
  -- Prompt Overlay
  prompt_full              TEXT,
  prompt_compact           TEXT,
  estimated_tokens         INTEGER DEFAULT 0,
  estimated_tokens_compact INTEGER DEFAULT 0,
  -- Tooling Overlay (alias ref + env override only)
  mcp_servers              TEXT,          -- JSON: { "alias": { "env_overrides"?: {...} } }
  conflict_policy          TEXT NOT NULL DEFAULT 'fail' CHECK(conflict_policy IN ('fail','warn')),
  -- Acceptance Overlay
  checklist                TEXT,          -- JSON array of strings
  inject_checklist         INTEGER NOT NULL DEFAULT 0,
  -- Meta
  priority                 INTEGER NOT NULL DEFAULT 100,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  -- Constraints
  CHECK (scope = 'global' OR project_id IS NOT NULL),
  CHECK (scope = 'project' OR project_id IS NULL)
);

-- Name uniqueness (partial unique indexes)
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_pack_name_global
  ON skill_packs(name) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_pack_name_project
  ON skill_packs(name, project_id) WHERE scope = 'project';

-- Project-skill pack bindings
CREATE TABLE IF NOT EXISTS project_skill_packs (
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_pack_id        TEXT NOT NULL REFERENCES skill_packs(id) ON DELETE CASCADE,
  priority             INTEGER NOT NULL DEFAULT 100,
  auto_apply           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, skill_pack_id)
);

-- Task-skill pack bindings
CREATE TABLE IF NOT EXISTS task_skill_packs (
  task_id              TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  skill_pack_id        TEXT NOT NULL REFERENCES skill_packs(id) ON DELETE CASCADE,
  priority             INTEGER NOT NULL DEFAULT 100,
  pinned_by            TEXT NOT NULL CHECK(pinned_by IN ('pm','user')),
  excluded             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, skill_pack_id)
);

-- Lock-in #4: user-exclusion DB-level enforcement
CREATE TRIGGER IF NOT EXISTS trg_task_skill_packs_user_exclusion_guard
  BEFORE UPDATE ON task_skill_packs
  WHEN OLD.excluded = 1 AND OLD.pinned_by = 'user'
       AND (NEW.excluded != 1 OR NEW.pinned_by != 'user')
BEGIN
  SELECT RAISE(ABORT, 'Cannot override user-excluded skill pack binding');
END;

-- Cross-project binding integrity: project_skill_packs INSERT
CREATE TRIGGER IF NOT EXISTS trg_project_skill_packs_cross_project_insert_guard
  BEFORE INSERT ON project_skill_packs
  WHEN EXISTS (
    SELECT 1 FROM skill_packs
    WHERE id = NEW.skill_pack_id AND scope = 'project' AND project_id != NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Cannot bind project-scope skill pack to different project');
END;

-- Cross-project binding integrity: project_skill_packs UPDATE
CREATE TRIGGER IF NOT EXISTS trg_project_skill_packs_cross_project_update_guard
  BEFORE UPDATE ON project_skill_packs
  WHEN EXISTS (
    SELECT 1 FROM skill_packs
    WHERE id = NEW.skill_pack_id AND scope = 'project' AND project_id != NEW.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Cannot bind project-scope skill pack to different project');
END;

-- Cross-project isolation: task_skill_packs INSERT
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

-- Cross-project isolation: task_skill_packs UPDATE
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

-- Run skill pack snapshots (denormalized)
CREATE TABLE IF NOT EXISTS run_skill_packs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id               TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  skill_pack_id        TEXT REFERENCES skill_packs(id) ON DELETE SET NULL,
  skill_pack_name      TEXT NOT NULL,
  prompt_text          TEXT,
  prompt_hash          TEXT,
  mcp_config_snapshot  TEXT,
  checklist_snapshot   TEXT,
  applied_mode         TEXT CHECK(applied_mode IN ('full','compact')),
  applied_order        INTEGER NOT NULL DEFAULT 0,
  effective_priority   INTEGER NOT NULL DEFAULT 100,
  applied_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Partial unique index: only enforce uniqueness when skill_pack_id IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS uq_run_skill_pack
  ON run_skill_packs(run_id, skill_pack_id) WHERE skill_pack_id IS NOT NULL;

-- Extend runs table for MCP config lifecycle
ALTER TABLE runs ADD COLUMN mcp_config_path TEXT;
ALTER TABLE runs ADD COLUMN mcp_config_snapshot TEXT;
