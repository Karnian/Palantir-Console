-- migrate:no-foreign-keys
-- PR1b-2a: read-only reconcile claims do not require a live mutation approval.
CREATE TABLE actions_new (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  action_slot TEXT NOT NULL,
  connector TEXT NOT NULL CHECK(connector IN ('github')),
  operation TEXT NOT NULL CHECK(operation IN ('github.create_issue')),
  params_json TEXT NOT NULL CHECK(json_valid(params_json)),
  params_hash TEXT NOT NULL CHECK(
    params_hash GLOB '[0-9a-f]*'
    AND params_hash NOT GLOB '*[^0-9a-f]*'
    AND length(params_hash) = 64
  ),
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
    approved_params_hash IS NULL
    OR (
      approved_params_hash GLOB '[0-9a-f]*'
      AND approved_params_hash NOT GLOB '*[^0-9a-f]*'
      AND length(approved_params_hash) = 64
    )
  ),
  approval_policy_version TEXT,
  approval_expires_at TEXT,
  active_attempt_id TEXT,
  claimed_at TEXT,
  external_id TEXT,
  external_node_id TEXT,
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  last_error TEXT,
  next_reconcile_at TEXT,
  verdict TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0 CHECK(repair_attempts >= 0),
  reissues_action_id TEXT REFERENCES actions_new(id),
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
  CHECK(status = 'awaiting_approval' OR approved_params_hash = params_hash),
  CHECK(
    (active_attempt_id IS NOT NULL)
    = (status IN ('executing', 'reconciling', 'repairing'))
  ),
  CHECK(
    status NOT IN ('executing', 'repairing')
    OR (
      claimed_at IS NOT NULL
      AND julianday(approval_expires_at) IS NOT NULL
      AND julianday(claimed_at) IS NOT NULL
      AND julianday(approval_expires_at) > julianday(claimed_at)
    )
  )
);

INSERT INTO actions_new SELECT * FROM actions;
DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;

CREATE TRIGGER trg_actions_intent_immutable
BEFORE UPDATE ON actions
WHEN NEW.task_id != OLD.task_id
  OR NEW.action_slot != OLD.action_slot
  OR NEW.connector != OLD.connector
  OR NEW.operation != OLD.operation
  OR NEW.params_json != OLD.params_json
  OR NEW.params_hash != OLD.params_hash
  OR NEW.reissues_action_id IS NOT OLD.reissues_action_id
BEGIN
  SELECT RAISE(ABORT, 'action intent columns are immutable');
END;

CREATE UNIQUE INDEX ux_actions_external_node
  ON actions(connector, external_node_id)
  WHERE external_node_id IS NOT NULL;

CREATE INDEX idx_actions_status ON actions(status);
