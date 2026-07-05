-- migrate:no-foreign-keys
-- Project repository source metadata and durable workspace bookkeeping.
-- Rebuild runs so the persisted status CHECK admits materializing.
--
-- Safety (mirrors 045/046 runs rebuild): the FK-off runner executes
-- PRAGMA foreign_keys=OFF -> BEGIN -> this SQL -> PRAGMA foreign_key_check
-- -> INSERT schema_version -> COMMIT -> PRAGMA foreign_keys=ON. Child tables
-- referencing runs(id) (run_events, run_acceptance_checks, task_skill_packs
-- via runs, memory_composition_events) keep their rows; the rename restores
-- the 'runs' name so their FKs resolve, and foreign_key_check validates the
-- whole graph before commit. runs has no triggers, so none are recreated;
-- runs indexes are recreated below. status CHECK lists the 8 existing states
-- in VALID_STATUSES order plus 'materializing' (runService VALID_STATUSES).

ALTER TABLE projects
  ADD COLUMN source_type TEXT
  CHECK(source_type IN ('git','legacy_directory'))
  DEFAULT 'legacy_directory';

ALTER TABLE projects
  ADD COLUMN repo_url TEXT;

ALTER TABLE projects
  ADD COLUMN repo_ref TEXT
  DEFAULT 'HEAD';

ALTER TABLE projects
  ADD COLUMN repo_subdir TEXT;

ALTER TABLE projects
  ADD COLUMN repo_remote_fingerprint TEXT;

ALTER TABLE projects
  ADD COLUMN source_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE projects
  ADD COLUMN last_repo_preflight_at TEXT;

ALTER TABLE projects
  ADD COLUMN last_repo_preflight_error TEXT;

ALTER TABLE projects
  ADD COLUMN mcp_config_source TEXT
  CHECK(mcp_config_source IN ('legacy_control_plane_path','repo_relpath'))
  DEFAULT 'legacy_control_plane_path';

ALTER TABLE projects
  ADD COLUMN mcp_config_relpath TEXT;

CREATE TABLE runs_new (
  id                       TEXT PRIMARY KEY,
  task_id                  TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_profile_id         TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  worktree_path            TEXT,
  branch                   TEXT,
  tmux_session             TEXT,
  status                   TEXT DEFAULT 'queued'
                           CHECK(status IN ('queued','running','paused','needs_input','completed','failed','cancelled','stopped','materializing')),
  prompt                   TEXT,
  result_summary           TEXT,
  exit_code                INTEGER,
  input_tokens             INTEGER DEFAULT 0,
  output_tokens            INTEGER DEFAULT 0,
  cost_usd                 REAL DEFAULT 0,
  error_message            TEXT,
  started_at               TEXT,
  ended_at                 TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  is_manager               INTEGER DEFAULT 0,
  parent_run_id            TEXT REFERENCES runs_new(id) ON DELETE SET NULL,
  claude_session_id        TEXT,
  manager_adapter          TEXT,
  manager_thread_id        TEXT,
  manager_layer            TEXT CHECK(manager_layer IS NULL OR manager_layer IN ('top','operator')),
  conversation_id          TEXT,
  mcp_config_path          TEXT,
  mcp_config_snapshot      TEXT,
  preset_id                TEXT,
  preset_snapshot_hash     TEXT,
  queued_args              TEXT,
  retry_count              INTEGER NOT NULL DEFAULT 0,
  node_id                  TEXT REFERENCES nodes(id),
  source_type_snapshot     TEXT,
  run_source_generation    INTEGER,
  repo_url_snapshot        TEXT,
  repo_ref_snapshot        TEXT,
  repo_subdir_snapshot     TEXT,
  repo_cache_path          TEXT,
  workspace_path           TEXT,
  workspace_generation     INTEGER,
  resolved_commit          TEXT,
  materialize_attempts     INTEGER NOT NULL DEFAULT 0,
  materialize_run_after    TEXT,
  materialize_started_at   TEXT,
  materialize_claim_token  TEXT,
  materialize_last_error   TEXT,
  workspace_ref_released_at TEXT
);

INSERT INTO runs_new (
  id, task_id, agent_profile_id, worktree_path, branch, tmux_session, status,
  prompt, result_summary, exit_code, input_tokens, output_tokens, cost_usd,
  error_message, started_at, ended_at, created_at, is_manager, parent_run_id,
  claude_session_id, manager_adapter, manager_thread_id, manager_layer,
  conversation_id, mcp_config_path, mcp_config_snapshot, preset_id,
  preset_snapshot_hash, queued_args, retry_count, node_id
)
SELECT
  id, task_id, agent_profile_id, worktree_path, branch, tmux_session, status,
  prompt, result_summary, exit_code, input_tokens, output_tokens, cost_usd,
  error_message, started_at, ended_at, created_at, is_manager, parent_run_id,
  claude_session_id, manager_adapter, manager_thread_id, manager_layer,
  conversation_id, mcp_config_path, mcp_config_snapshot, preset_id,
  preset_snapshot_hash, queued_args, retry_count, node_id
FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_manager ON runs(is_manager) WHERE is_manager = 1;
CREATE INDEX IF NOT EXISTS idx_runs_manager_adapter ON runs(manager_adapter) WHERE manager_adapter IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_manager_layer ON runs(manager_layer) WHERE manager_layer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_conversation_id ON runs(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_node_drain ON runs(COALESCE(node_id, 'local'), agent_profile_id, status, created_at);

ALTER TABLE project_briefs
  ADD COLUMN pm_thread_source_generation INTEGER;

ALTER TABLE project_briefs
  ADD COLUMN pm_thread_source_hash TEXT;

ALTER TABLE project_briefs
  ADD COLUMN pm_thread_workspace_path TEXT;

CREATE TABLE project_node_workspaces (
  project_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  repo_url TEXT,
  repo_ref TEXT,
  resolved_commit TEXT,
  repo_cache_path TEXT,
  status TEXT,
  last_error TEXT,
  materialized_at TEXT,
  last_used_at TEXT,
  PRIMARY KEY(project_id,node_id,source_generation)
);

CREATE TABLE project_materialization_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  claim_token TEXT,
  locked_at TEXT,
  owner_run_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE UNIQUE INDEX idx_matlease_singleflight
  ON project_materialization_leases(project_id,node_id,source_generation)
  WHERE status IN ('pending','running');

CREATE TABLE project_workspace_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  project_id TEXT,
  node_id TEXT,
  source_generation INTEGER,
  repo_cache_path TEXT,
  worktree_path TEXT,
  ref_type TEXT,
  acquired_at TEXT,
  heartbeat_at TEXT,
  released_at TEXT,
  expires_at TEXT
);

CREATE INDEX idx_project_workspace_refs_run_id
  ON project_workspace_refs(run_id);

CREATE INDEX idx_project_workspace_refs_active
  ON project_workspace_refs(project_id,node_id,source_generation)
  WHERE released_at IS NULL;
