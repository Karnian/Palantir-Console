-- Fleet P1a: node identity registry and additive node bindings.
-- The migration runner wraps this file in a transaction with FK enforcement ON.

CREATE TABLE nodes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'local' CHECK (kind IN ('local','ssh')),
  can_execute    INTEGER NOT NULL DEFAULT 1 CHECK (can_execute IN (0,1)),
  can_control    INTEGER NOT NULL DEFAULT 0 CHECK (can_control IN (0,1)),
  files_only     INTEGER NOT NULL DEFAULT 0 CHECK (files_only IN (0,1)),
  ssh_host       TEXT,
  ssh_user       TEXT,
  exposed_roots  TEXT,
  node_prefix    TEXT,
  max_concurrent INTEGER CHECK (max_concurrent IS NULL OR max_concurrent >= 1),
  last_heartbeat_at TEXT,
  reachable      INTEGER NOT NULL DEFAULT 0 CHECK (reachable IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (NOT (files_only = 1 AND can_execute = 1)),
  CHECK (kind <> 'ssh' OR (ssh_host IS NOT NULL AND ssh_user IS NOT NULL AND exposed_roots IS NOT NULL))
);

INSERT INTO nodes (id, name, kind, can_execute, can_control, reachable, max_concurrent)
  VALUES ('local', 'Local', 'local', 1, 1, 1, NULL);

CREATE TRIGGER nodes_ssh_exposed_roots_insert
BEFORE INSERT ON nodes
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'ssh' AND NEW.exposed_roots IS NULL
      THEN RAISE(ABORT, 'ssh node requires exposed_roots')
    WHEN NEW.kind = 'ssh' AND json_valid(NEW.exposed_roots) <> 1
      THEN RAISE(ABORT, 'ssh node exposed_roots must be valid JSON')
    WHEN NEW.kind = 'ssh' AND json_type(NEW.exposed_roots) <> 'array'
      THEN RAISE(ABORT, 'ssh node exposed_roots must be a JSON array')
  END;
END;

CREATE TRIGGER nodes_ssh_exposed_roots_update
BEFORE UPDATE ON nodes
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN OLD.id != NEW.id
      THEN RAISE(ABORT, 'node id is immutable')
    WHEN OLD.kind != NEW.kind
      THEN RAISE(ABORT, 'node kind is immutable')
    WHEN NEW.kind = 'ssh' AND NEW.exposed_roots IS NULL
      THEN RAISE(ABORT, 'ssh node requires exposed_roots')
    WHEN NEW.kind = 'ssh' AND json_valid(NEW.exposed_roots) <> 1
      THEN RAISE(ABORT, 'ssh node exposed_roots must be valid JSON')
    WHEN NEW.kind = 'ssh' AND json_type(NEW.exposed_roots) <> 'array'
      THEN RAISE(ABORT, 'ssh node exposed_roots must be a JSON array')
  END;
END;

ALTER TABLE projects ADD COLUMN node_id TEXT REFERENCES nodes(id);
ALTER TABLE projects ADD COLUMN allow_non_git_dir INTEGER NOT NULL DEFAULT 0 CHECK (allow_non_git_dir IN (0,1));

ALTER TABLE runs ADD COLUMN node_id TEXT REFERENCES nodes(id);

ALTER TABLE project_briefs ADD COLUMN pm_thread_node_id TEXT REFERENCES nodes(id);
ALTER TABLE project_briefs ADD COLUMN pm_thread_cwd TEXT;

CREATE INDEX idx_projects_node ON projects(node_id);
-- Expression index matching the drain queries' COALESCE(node_id,'local')
-- normalization (legacy rows carry NULL) — a plain node_id index would never
-- be used by those queries (Codex P1a review, NIT).
CREATE INDEX idx_runs_node_drain ON runs(COALESCE(node_id, 'local'), agent_profile_id, status, created_at);
