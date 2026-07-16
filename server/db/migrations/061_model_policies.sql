-- MP-1: Model/Effort Policy schema.

CREATE TABLE model_policies (
  scope_type    TEXT NOT NULL CHECK (scope_type IN ('global','layer:top','layer:operator','codebase')),
  scope_id      TEXT NOT NULL,
  vendor        TEXT NOT NULL CHECK (vendor IN ('codex','claude')),
  params_json   TEXT NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision      INTEGER NOT NULL DEFAULT 0,
  changed_by    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (scope_type IN ('global','layer:top','layer:operator') AND scope_id = '*')
    OR (scope_type = 'codebase' AND scope_id <> '*')
  ),
  CHECK (json_valid(params_json) AND json_type(params_json, '$') = 'object')
);

CREATE UNIQUE INDEX idx_model_policies_scope
  ON model_policies(scope_type, scope_id, vendor);

CREATE TRIGGER model_policies_updated_at
AFTER UPDATE ON model_policies
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE model_policies
  SET updated_at = datetime('now')
  WHERE scope_type = NEW.scope_type
    AND scope_id = NEW.scope_id
    AND vendor = NEW.vendor;
END;

CREATE TABLE model_policy_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type        TEXT NOT NULL,
  scope_id          TEXT NOT NULL,
  vendor            TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('insert','update','delete')),
  params_json_after TEXT,
  changed_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER model_policies_project_orphan
AFTER DELETE ON projects
FOR EACH ROW
BEGIN
  INSERT INTO model_policy_audit (
    scope_type,
    scope_id,
    vendor,
    action,
    params_json_after,
    changed_by
  )
  SELECT
    scope_type,
    scope_id,
    vendor,
    'delete',
    NULL,
    'system:project_delete'
  FROM model_policies
  WHERE scope_type = 'codebase' AND scope_id = OLD.id;

  DELETE FROM model_policies
  WHERE scope_type = 'codebase' AND scope_id = OLD.id;
END;

ALTER TABLE runs ADD COLUMN session_model TEXT;
ALTER TABLE runs ADD COLUMN session_effort TEXT;
