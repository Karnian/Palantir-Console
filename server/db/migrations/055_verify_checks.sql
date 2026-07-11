-- G2: Goal Delegation — verify_checks (Gate 1) + goal workspace / deliverable
-- columns. Additive only. The verdict-loop columns (goal_verdict, attempt_ref,
-- …) land in G3 (§7 phase table); this migration carries what G2 reads/writes.

-- Named, reusable verify checks (Gate 1). kind is a discriminated union:
--   command  — {command, timeout_ms}; runs in a code-mode workspace shell.
--              project_id REQUIRED (execution boundary), human-only CRUD (§6).
--   artifact — declarative {files, report}; server evaluates as a pure function.
--              project_id optional (workload-agnostic), Operator-authorable (§5k-3).
-- created_by is the provenance that decides gate eligibility (§5k-3): only
-- human-authored checks gate a verdict; operator-authored checks are advisory.
CREATE TABLE verify_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK(kind IN ('command','artifact')),
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  spec_json   TEXT NOT NULL,
  created_by  TEXT NOT NULL CHECK(created_by IN ('human','operator')),
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Name is unique within a project scope ('' bucket for project-less artifact checks).
CREATE UNIQUE INDEX idx_verify_checks_scope_name
  ON verify_checks(coalesce(project_id, ''), name);

CREATE INDEX idx_verify_checks_project ON verify_checks(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_verify_checks_default ON verify_checks(project_id, is_default) WHERE is_default = 1;

-- Column-shape enforcement: a command check MUST be project-scoped (its shell
-- runs in that project's workspace). Mirrors migration 022's trigger pattern.
CREATE TRIGGER verify_checks_command_requires_project_insert
BEFORE INSERT ON verify_checks
WHEN NEW.kind = 'command' AND NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'command verify_check requires project_id');
END;

CREATE TRIGGER verify_checks_command_requires_project_update
BEFORE UPDATE ON verify_checks
WHEN NEW.kind = 'command' AND NEW.project_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'command verify_check requires project_id');
END;

-- Task-level goal knobs consumed by G2 (assignment) + G3c (judge flag) + §5j.
ALTER TABLE tasks ADD COLUMN verify_check_id INTEGER REFERENCES verify_checks(id);
ALTER TABLE tasks ADD COLUMN goal_judge_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN deliverable_json TEXT;

-- Per-run Gate 1 + deliverable capture (goal runs only; NULL otherwise).
ALTER TABLE runs ADD COLUMN acceptance_json TEXT;      -- Gate 1 aggregate (§5f)
ALTER TABLE runs ADD COLUMN goal_workspace_path TEXT;  -- deliverable-mode isolated cwd (§5k-1)
ALTER TABLE runs ADD COLUMN deliverable_state TEXT;    -- captured|bundled|cleaned (§5k-2)
