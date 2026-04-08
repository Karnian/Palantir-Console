-- 006_task_enrichment.sql
-- v3 Phase 1: Task model enrichment for dispatcher-mode manager.
--
-- Motivation: In v3, the manager becomes a thin dispatcher (spec:
-- docs/specs/manager-v3-multilayer.md). For that model to be healthy,
-- dispatch decisions must be expressible as *data* on the task, not
-- re-derived from free-text prompt on every turn. Otherwise the dispatcher
-- degenerates into "prompt-driven shell operator" (principle 3).
--
-- New columns:
--   task_kind              — classification for dispatch routing
--                           ('code_change'|'investigation'|'review'|'docs'
--                            |'refactor'|'other'). NULL allowed for legacy
--                           tasks and for tasks the user hasn't classified yet.
--   requires_capabilities  — JSON array of capability strings the worker
--                           must provide (e.g. ["filesystem_write","web"]).
--                           Matched against agent_profiles.capabilities_json.
--   suggested_agent_profile_id — optional user/PM preference. Dispatcher
--                           should prefer this when set; falls back to
--                           capability-based selection when NULL.
--   acceptance_criteria    — short text the worker uses to self-judge
--                           completion. Informational; not enforced.
--
-- All columns are nullable to avoid breaking existing rows. Dispatcher
-- code must handle NULL gracefully (principle: backward-compat).

ALTER TABLE tasks ADD COLUMN task_kind TEXT
  CHECK (task_kind IS NULL OR task_kind IN
    ('code_change','investigation','review','docs','refactor','other'));

-- requires_capabilities is a JSON array of strings. SQLite's json1 extension
-- is compiled into better-sqlite3; json_valid() + json_type() gate enforces
-- the shape at the DB level so out-of-band writes or manual SQL cannot
-- inject non-array payloads that the service layer would later dereference.
ALTER TABLE tasks ADD COLUMN requires_capabilities TEXT
  CHECK (
    requires_capabilities IS NULL
    OR (json_valid(requires_capabilities) AND json_type(requires_capabilities) = 'array')
  );

ALTER TABLE tasks ADD COLUMN suggested_agent_profile_id TEXT
  REFERENCES agent_profiles(id) ON DELETE SET NULL;

ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;

CREATE INDEX idx_tasks_task_kind ON tasks(task_kind) WHERE task_kind IS NOT NULL;
CREATE INDEX idx_tasks_suggested_agent ON tasks(suggested_agent_profile_id)
  WHERE suggested_agent_profile_id IS NOT NULL;
