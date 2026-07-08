-- W-P1: inert OperatorInstance watch-list schema.
-- This phase is schema/backfill only. Runtime code must not read from or write
-- to these tables until later dual-read phases.

CREATE TABLE operator_instances (
  id                TEXT NOT NULL PRIMARY KEY CHECK(id GLOB 'oi_*' AND length(id) > 3),
  profile_id        TEXT NULL REFERENCES operator_profiles(id),
  thread_id         TEXT NULL,
  pm_adapter        TEXT NULL,
  node_id           TEXT NULL,
  cwd               TEXT NULL,
  source_generation INTEGER NULL,
  source_hash       TEXT NULL,
  workspace_path    TEXT NULL,
  status            TEXT NOT NULL DEFAULT 'idle',
  watchlist_version INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE operator_codebase_refs (
  instance_id TEXT NOT NULL REFERENCES operator_instances(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('primary','reference')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_operator_codebase_refs_primary_project
  ON operator_codebase_refs(project_id)
  WHERE role = 'primary';

CREATE UNIQUE INDEX idx_operator_codebase_refs_primary_instance
  ON operator_codebase_refs(instance_id)
  WHERE role = 'primary';

CREATE UNIQUE INDEX idx_operator_codebase_refs_instance_project
  ON operator_codebase_refs(instance_id, project_id);

ALTER TABLE runs ADD COLUMN operator_instance_id TEXT NULL;
ALTER TABLE runs ADD COLUMN retry_root_run_id TEXT NULL;

INSERT INTO operator_instances (
  id,
  thread_id,
  pm_adapter,
  node_id,
  cwd,
  source_generation,
  source_hash,
  workspace_path
)
SELECT
  'oi_' || p.id,
  pb.pm_thread_id,
  pb.pm_adapter,
  pb.pm_thread_node_id,
  pb.pm_thread_cwd,
  pb.pm_thread_source_generation,
  pb.pm_thread_source_hash,
  pb.pm_thread_workspace_path
FROM projects p
LEFT JOIN project_briefs pb ON pb.project_id = p.id
WHERE p.pm_enabled != 0
  AND NOT EXISTS (SELECT 1 FROM operator_instances oi WHERE oi.id = 'oi_' || p.id);

INSERT INTO operator_codebase_refs (instance_id, project_id, role)
SELECT
  'oi_' || p.id,
  p.id,
  'primary'
FROM projects p
WHERE p.pm_enabled != 0
  AND NOT EXISTS (
    SELECT 1 FROM operator_codebase_refs r
    WHERE r.instance_id = 'oi_' || p.id AND r.project_id = p.id
  );

-- FK/scan hygiene (Codex W-P1 review): reference-role lookups and cascade
-- checks by project, and profile joins, shouldn't full-scan.
CREATE INDEX idx_operator_codebase_refs_project_id
  ON operator_codebase_refs(project_id);
CREATE INDEX idx_operator_instances_profile_id
  ON operator_instances(profile_id)
  WHERE profile_id IS NOT NULL;
