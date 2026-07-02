-- migrate:no-foreign-keys
-- 046_operator_rename_tighten.sql
-- Phase 4 (FINAL CLEANUP): drop all backward-compat that read 'pm' / 'pm:'.
-- Tighten runs.manager_layer and memory_composition_events.slot_kind CHECKs
-- to REJECT the legacy 'pm' form, keeping only 'top' / 'operator'.
--
-- Phase 1 (migration 045) relaxed the CHECKs to accept BOTH forms and rewrote
-- persisted 'pm' / 'pm:' values → 'operator' / 'operator:'. Phase 2 flipped all
-- producers to emit the new form. Phase 3 renamed symbols. By Phase 4 there is
-- no producer of the legacy form and the prod DB has 0 residual 'pm:' rows.
--
-- SAFETY: FK enforcement is OFF for this file (marker above). The runner
-- executes: PRAGMA foreign_keys=OFF -> BEGIN -> this SQL -> PRAGMA
-- foreign_key_check -> INSERT schema_version -> COMMIT -> PRAGMA foreign_keys=ON.
-- Any FK violation aborts before COMMIT.
--
-- No triggers on runs or memory_composition_events; no trigger recreation needed.

-- Step 1: Defensive sweep (idempotent) — rewrite ANY residual legacy form BEFORE
-- the tighter CHECK is installed, so a stale row cannot abort the rebuild INSERT.
-- Use substr(x,1,3) = 'pm:' (not LIKE; LIKE is case-insensitive).
UPDATE runs
  SET conversation_id = 'operator:' || substr(conversation_id, 4)
  WHERE substr(conversation_id, 1, 3) = 'pm:';

UPDATE runs
  SET manager_layer = 'operator'
  WHERE manager_layer = 'pm';

UPDATE memory_composition_events
  SET conversation_id = 'operator:' || substr(conversation_id, 4)
  WHERE substr(conversation_id, 1, 3) = 'pm:';

UPDATE memory_composition_events
  SET slot_kind = 'operator'
  WHERE slot_kind = 'pm';

-- Step 2: Rebuild runs with TIGHTENED manager_layer CHECK (drops 'pm').
CREATE TABLE runs_new (
  id                   TEXT    PRIMARY KEY,
  task_id              TEXT    REFERENCES tasks(id) ON DELETE CASCADE,
  agent_profile_id     TEXT    REFERENCES agent_profiles(id) ON DELETE SET NULL,
  worktree_path        TEXT,
  branch               TEXT,
  tmux_session         TEXT,
  status               TEXT    DEFAULT 'queued'
                               CHECK(status IN ('queued','running','paused','needs_input','completed','failed','cancelled','stopped')),
  prompt               TEXT,
  result_summary       TEXT,
  exit_code            INTEGER,
  input_tokens         INTEGER DEFAULT 0,
  output_tokens        INTEGER DEFAULT 0,
  cost_usd             REAL    DEFAULT 0,
  error_message        TEXT,
  started_at           TEXT,
  ended_at             TEXT,
  created_at           TEXT    DEFAULT (datetime('now')),
  is_manager           INTEGER DEFAULT 0,
  parent_run_id        TEXT    REFERENCES runs_new(id) ON DELETE SET NULL,
  claude_session_id    TEXT,
  manager_adapter      TEXT,
  manager_thread_id    TEXT,
  manager_layer        TEXT    CHECK(manager_layer IS NULL OR manager_layer IN ('top','operator')),
  conversation_id      TEXT,
  mcp_config_path      TEXT,
  mcp_config_snapshot  TEXT,
  preset_id            TEXT,
  preset_snapshot_hash TEXT,
  queued_args          TEXT,
  retry_count          INTEGER NOT NULL DEFAULT 0
);

INSERT INTO runs_new (
  id, task_id, agent_profile_id, worktree_path, branch, tmux_session, status,
  prompt, result_summary, exit_code, input_tokens, output_tokens, cost_usd,
  error_message, started_at, ended_at, created_at, is_manager, parent_run_id,
  claude_session_id, manager_adapter, manager_thread_id, manager_layer,
  conversation_id, mcp_config_path, mcp_config_snapshot, preset_id,
  preset_snapshot_hash, queued_args, retry_count
)
SELECT
  id, task_id, agent_profile_id, worktree_path, branch, tmux_session, status,
  prompt, result_summary, exit_code, input_tokens, output_tokens, cost_usd,
  error_message, started_at, ended_at, created_at, is_manager, parent_run_id,
  claude_session_id, manager_adapter, manager_thread_id, manager_layer,
  conversation_id, mcp_config_path, mcp_config_snapshot, preset_id,
  preset_snapshot_hash, queued_args, retry_count
FROM runs;

DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

-- Recreate all 7 indexes.
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_manager ON runs(is_manager) WHERE is_manager = 1;
CREATE INDEX IF NOT EXISTS idx_runs_manager_adapter ON runs(manager_adapter) WHERE manager_adapter IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_manager_layer ON runs(manager_layer) WHERE manager_layer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_conversation_id ON runs(conversation_id) WHERE conversation_id IS NOT NULL;

-- Step 3: Rebuild memory_composition_events with TIGHTENED slot_kind CHECK (drops 'pm').
CREATE TABLE memory_composition_events_new (
  id                   TEXT    PRIMARY KEY,
  run_id               TEXT    NOT NULL,
  conversation_id      TEXT,
  task_id              TEXT,
  slot_kind            TEXT    NOT NULL  CHECK(slot_kind IN ('top','operator')),
  provenance_key       TEXT    NOT NULL,
  mode                 TEXT,
  composer_version     TEXT    NOT NULL,
  policy_version       TEXT    NOT NULL,
  prompt_payload_hash  TEXT,
  retrieval_query_hash TEXT,
  token_budget         INTEGER,
  owner_vector_hash    TEXT,
  selected_set_hash    TEXT,
  fingerprint          TEXT    NOT NULL,
  block_hash           TEXT,
  status               TEXT    NOT NULL  DEFAULT 'pending'
                               CHECK(status IN ('pending','accepted')),
  created_at           TEXT    NOT NULL  DEFAULT (datetime('now')),
  accepted_at          TEXT
);

INSERT INTO memory_composition_events_new (
  id, run_id, conversation_id, task_id, slot_kind, provenance_key, mode,
  composer_version, policy_version, prompt_payload_hash, retrieval_query_hash,
  token_budget, owner_vector_hash, selected_set_hash, fingerprint, block_hash,
  status, created_at, accepted_at
)
SELECT
  id, run_id, conversation_id, task_id, slot_kind, provenance_key, mode,
  composer_version, policy_version, prompt_payload_hash, retrieval_query_hash,
  token_budget, owner_vector_hash, selected_set_hash, fingerprint, block_hash,
  status, created_at, accepted_at
FROM memory_composition_events;

DROP TABLE memory_composition_events;
ALTER TABLE memory_composition_events_new RENAME TO memory_composition_events;

-- Recreate the gate index.
CREATE INDEX IF NOT EXISTS idx_composition_events_gate
  ON memory_composition_events(run_id, slot_kind, provenance_key, status);
