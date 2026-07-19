-- migrate:no-foreign-keys
-- B0: every operator instance owns exactly one operator profile.

ALTER TABLE operator_profiles
  ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;

INSERT INTO operator_profiles (
  id,
  name,
  description,
  persona,
  capabilities_json,
  is_private
)
SELECT
  'op_priv_' || oi.id,
  'Private: ' || oi.id,
  'Auto-generated private profile for ' || oi.id,
  NULL,
  '[]',
  1
FROM operator_instances oi
WHERE oi.profile_id IS NULL;

UPDATE operator_instances
SET profile_id = 'op_priv_' || id
WHERE profile_id IS NULL;

CREATE TABLE operator_instances_new (
  id                TEXT NOT NULL PRIMARY KEY CHECK(id GLOB 'oi_*' AND length(id) > 3),
  profile_id        TEXT NOT NULL REFERENCES operator_profiles(id),
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
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  fast_mode         INTEGER NULL
);

INSERT INTO operator_instances_new (
  id,
  profile_id,
  thread_id,
  pm_adapter,
  node_id,
  cwd,
  source_generation,
  source_hash,
  workspace_path,
  status,
  watchlist_version,
  created_at,
  updated_at,
  fast_mode
)
SELECT
  id,
  profile_id,
  thread_id,
  pm_adapter,
  node_id,
  cwd,
  source_generation,
  source_hash,
  workspace_path,
  status,
  watchlist_version,
  created_at,
  updated_at,
  fast_mode
FROM operator_instances;

DROP TABLE operator_instances;
ALTER TABLE operator_instances_new RENAME TO operator_instances;

CREATE INDEX idx_operator_instances_profile_id
  ON operator_instances(profile_id)
  WHERE profile_id IS NOT NULL;
