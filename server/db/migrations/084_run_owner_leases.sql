-- S1a: durable process-owner observations for worker runs.
-- A held lease with acquired_at NULL is reserved: claim succeeded, but local
-- process acceptance has not yet been recorded. started_at is deliberately not
-- used as spawn evidence because claimQueuedRun stamps it before spawn.
CREATE TABLE run_owner_leases (
  run_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('held','released','abandoned')),
  acquired_at TEXT,
  terminal_observed_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX ux_run_owner_leases_held_run
  ON run_owner_leases(run_id)
  WHERE state = 'held';

CREATE INDEX idx_run_owner_leases_state
  ON run_owner_leases(state);

-- Existing active workers have unknown ownership after migration. Preserve all
-- of them as reserved until S1b can probe alive/dead/unknown deterministically.
INSERT INTO run_owner_leases (run_id, lease_id, state, acquired_at)
SELECT
  id,
  lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random() % 4) + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  'held',
  NULL
FROM runs
WHERE is_manager = 0
  AND status IN ('running', 'paused', 'needs_input');
