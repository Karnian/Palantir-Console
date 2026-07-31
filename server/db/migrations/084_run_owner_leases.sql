-- S1a: durable process-owner observations for worker runs.
-- A held lease with acquired_at NULL is reserved: claim succeeded, but local
-- process acceptance has not yet been recorded. started_at is deliberately not
-- used as spawn evidence because claimQueuedRun stamps it before spawn.
CREATE TABLE run_owner_leases (
  run_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('held','released','abandoned')),
  engine TEXT CHECK(engine IN ('subprocess','tmux','stream-json','remote')),
  acquired_at TEXT,
  terminal_observed_at TEXT,
  closed_at TEXT,
  -- Why the lease was closed. Lives HERE (not only in run_events) because a
  -- deleted run cascades its events away; the lease row has no FK on purpose
  -- and is the durable ownership record (codex S1a R1 #4).
  evidence TEXT,
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

-- Last line of defense for EVERY run-deletion path. runService.deleteRun closes
-- the lease explicitly (with an event) before deleting; but task/project
-- cascade deletes bypass the service entirely (codex S1a R2), and a tmux or
-- remote run has no onExit to recover later — permanent held. AFTER DELETE
-- catches them all; the explicit path has already closed its lease by the time
-- this fires, so it is a no-op there.
CREATE TRIGGER trg_run_owner_leases_run_deleted
AFTER DELETE ON runs
BEGIN
  UPDATE run_owner_leases
  SET state = 'abandoned', closed_at = datetime('now'), evidence = 'run_deleted'
  WHERE run_id = OLD.id AND state = 'held';
END;
