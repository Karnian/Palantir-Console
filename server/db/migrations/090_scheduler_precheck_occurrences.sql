CREATE TABLE operator_schedule_occurrences (
  id                       TEXT PRIMARY KEY CHECK(id GLOB 'osocc_*' AND length(id) > 6),
  schedule_id              TEXT NOT NULL REFERENCES operator_schedules(id) ON DELETE CASCADE,
  operator_instance_id     TEXT NOT NULL REFERENCES operator_instances(id) ON DELETE CASCADE,
  scheduled_for            TEXT NOT NULL,
  schedule_revision        INTEGER NOT NULL,
  precheck_verify_check_id INTEGER NULL REFERENCES verify_checks(id) ON DELETE SET NULL,
  precheck_check_id_snapshot INTEGER NOT NULL,
  precheck_check_name      TEXT NOT NULL,
  precheck_kind            TEXT NOT NULL CHECK(precheck_kind IN ('command','artifact')),
  precheck_spec_hash       TEXT NOT NULL,
  precheck_node_id         TEXT NOT NULL,
  precheck_workspace_generation TEXT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
                             'pending','prechecking','passed','precheck_failed',
                             'precheck_unavailable','precheck_blocked','superseded')),
  outcome_reason           TEXT NULL,
  evaluator                TEXT NULL,
  attempts                 INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  claim_token              TEXT NULL,
  leased_until             TEXT NULL,
  next_attempt_at          TEXT NOT NULL,
  deadline_at              TEXT NOT NULL,
  invocation_id            TEXT NULL REFERENCES operator_invocations(id) ON DELETE SET NULL,
  detail_json              TEXT NULL,
  started_at               TEXT NULL,
  finished_at              TEXT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(schedule_id, scheduled_for)
);

CREATE UNIQUE INDEX idx_osocc_inflight_schedule
  ON operator_schedule_occurrences(schedule_id)
  WHERE status IN ('pending','prechecking');

CREATE INDEX idx_osocc_claimable
  ON operator_schedule_occurrences(status, next_attempt_at, deadline_at)
  WHERE status IN ('pending','prechecking');
