-- PR1a: durable action ledger, approval boundary, and append-only evidence.
CREATE TABLE actions (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  action_slot TEXT NOT NULL,
  connector TEXT NOT NULL CHECK(connector IN ('github')),
  operation TEXT NOT NULL CHECK(operation IN ('github.create_issue')),
  params_json TEXT NOT NULL,
  params_hash TEXT NOT NULL CHECK(length(params_hash) = 64),
  status TEXT NOT NULL CHECK(status IN (
    'awaiting_approval',
    'queued',
    'executing',
    'succeeded',
    'partially_applied',
    'failed',
    'unknown',
    'reconciling',
    'repairing',
    'repair_retry_wait',
    'repair_blocked',
    'conflict'
  )),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  approval_auth_method TEXT CHECK(
    approval_auth_method IS NULL OR approval_auth_method = 'cookie'
  ),
  approved_params_hash TEXT CHECK(
    approved_params_hash IS NULL OR length(approved_params_hash) = 64
  ),
  approval_policy_version TEXT,
  approval_expires_at TEXT,
  active_attempt_id TEXT,
  claimed_at TEXT,
  external_id TEXT,
  external_node_id TEXT,
  receipt_json TEXT,
  last_error TEXT,
  next_reconcile_at TEXT,
  verdict TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0 CHECK(repair_attempts >= 0),
  reissues_action_id TEXT REFERENCES actions(id),
  UNIQUE(task_id, action_slot),
  CHECK(
    (active_attempt_id IS NULL AND claimed_at IS NULL)
    OR (active_attempt_id IS NOT NULL AND claimed_at IS NOT NULL)
  ),
  CHECK(
    status = 'awaiting_approval'
    OR (
      approved_at IS NOT NULL
      AND approved_by IS NOT NULL
      AND approval_auth_method IS NOT NULL
      AND approved_params_hash IS NOT NULL
      AND approval_policy_version IS NOT NULL
      AND approval_expires_at IS NOT NULL
    )
  ),
  CHECK(
    status NOT IN ('awaiting_approval', 'queued')
    OR active_attempt_id IS NULL
  ),
  CHECK(
    status NOT IN ('executing', 'reconciling', 'repairing')
    OR active_attempt_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX ux_actions_external_node
  ON actions(connector, external_node_id)
  WHERE external_node_id IS NOT NULL;

CREATE INDEX idx_actions_status ON actions(status);

CREATE TABLE action_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES actions(id),
  attempt_id TEXT,
  phase TEXT NOT NULL,
  request_digest TEXT,
  transport_class TEXT,
  external_request_id TEXT,
  candidate_external_id TEXT,
  receipt_json TEXT,
  error TEXT,
  ts TEXT NOT NULL
);

CREATE INDEX idx_action_events_action_ts
  ON action_events(action_id, ts, id);

CREATE TRIGGER trg_action_events_no_update
BEFORE UPDATE ON action_events
BEGIN
  SELECT RAISE(ABORT, 'action_events is append-only');
END;

CREATE TRIGGER trg_action_events_no_delete
BEFORE DELETE ON action_events
BEGIN
  SELECT RAISE(ABORT, 'action_events is append-only');
END;
