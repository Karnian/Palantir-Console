-- OS-1: Operator-first identity + durable schedule/invocation queue.
--
-- Existing project-owned compatibility instances remain valid. New instances
-- can be created before a primary codebase is mapped; schedules always belong
-- to the instance, never to a project/profile.

ALTER TABLE operator_instances ADD COLUMN display_name TEXT NULL
  CHECK(display_name IS NULL OR (length(trim(display_name)) BETWEEN 1 AND 120));

CREATE TABLE operator_schedules (
  id                    TEXT PRIMARY KEY CHECK(id GLOB 'os_*' AND length(id) > 3),
  operator_instance_id  TEXT NOT NULL REFERENCES operator_instances(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  prompt                TEXT NOT NULL CHECK(length(trim(prompt)) BETWEEN 1 AND 12000),
  codebase_project_id   TEXT NULL,
  rule_json             TEXT NOT NULL CHECK(json_valid(rule_json) AND json_type(rule_json)='object'),
  timezone              TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  next_fire_at          TEXT NULL,
  revision              INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  max_runs_per_day      INTEGER NOT NULL DEFAULT 24 CHECK(max_runs_per_day BETWEEN 1 AND 96),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  archived_at           TEXT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_operator_schedules_instance
  ON operator_schedules(operator_instance_id, archived_at, enabled);

CREATE INDEX idx_operator_schedules_due
  ON operator_schedules(enabled, next_fire_at)
  WHERE archived_at IS NULL AND enabled = 1 AND next_fire_at IS NOT NULL;

CREATE TABLE operator_invocations (
  id                    TEXT PRIMARY KEY CHECK(id GLOB 'oinv_*' AND length(id) > 5),
  schedule_id           TEXT NULL REFERENCES operator_schedules(id) ON DELETE SET NULL,
  operator_instance_id  TEXT NOT NULL REFERENCES operator_instances(id) ON DELETE CASCADE,
  schedule_revision     INTEGER NULL,
  source                TEXT NOT NULL CHECK(source IN ('scheduled','manual_run_now')),
  prompt_snapshot       TEXT NOT NULL,
  codebase_project_id   TEXT NULL,
  rule_snapshot_json    TEXT NULL CHECK(
                          rule_snapshot_json IS NULL
                          OR (json_valid(rule_snapshot_json) AND json_type(rule_snapshot_json)='object')
                        ),
  scheduled_for         TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','claimed','delivering','running','completed','failed','cancelled','uncertain')),
  run_after             TEXT NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  claim_token           TEXT NULL,
  locked_at             TEXT NULL,
  manager_run_id        TEXT NULL REFERENCES runs(id) ON DELETE SET NULL,
  waiting_reason        TEXT NULL,
  last_error            TEXT NULL,
  started_at            TEXT NULL,
  completed_at          TEXT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(schedule_id, scheduled_for)
);

CREATE INDEX idx_operator_invocations_due
  ON operator_invocations(status, run_after, scheduled_for);

CREATE INDEX idx_operator_invocations_manager_run
  ON operator_invocations(manager_run_id, status)
  WHERE manager_run_id IS NOT NULL;

CREATE UNIQUE INDEX idx_operator_invocations_active_schedule
  ON operator_invocations(schedule_id)
  WHERE schedule_id IS NOT NULL AND status IN ('pending','claimed','delivering','running');
