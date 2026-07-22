-- Retire the original seeded OpenCode profile without deleting a user-repurposed row.
-- Only fail work that cannot own a live tmux session or materialization attempt.
-- 'queued' is the only status that structurally guarantees no process was ever
-- spawned. 'paused' and 'needs_input' both transition FROM 'running' (see
-- runService.js's VALID_STATUSES transition map) — needs_input in particular
-- is assigned by lifecycleService._doHealthCheck() only after confirming
-- channel.isAlive(), and is actively polled for recovery, so its process can
-- still be alive. Treat both the same as running/materializing: never touched
-- directly by this migration (Codex adversarial review r2 finding).
UPDATE runs
SET status = 'failed',
    ended_at = datetime('now'),
    non_retryable = 1
WHERE agent_profile_id = 'opencode'
  AND status = 'queued'
  AND EXISTS (
    SELECT 1
    FROM agent_profiles
    WHERE id = 'opencode' AND command = 'opencode'
  );

-- Migrations are one-shot (tracked in schema_version and never re-run), so a
-- running/materializing/paused/needs_input reference permanently skips this
-- deletion rather than retrying after that run ends. This deliberately favors
-- never creating a zombie process or leaking a materialization lease over
-- guaranteed cleanup in this narrow edge case. The leftover row is harmless
-- because Phase 2's rejectRetiredAgentType blocks every new OpenCode profile.
DELETE FROM agent_profiles
WHERE id = 'opencode'
  AND command = 'opencode'
  AND NOT EXISTS (
    SELECT 1
    FROM runs
    WHERE agent_profile_id = 'opencode'
      AND status IN ('running', 'materializing', 'paused', 'needs_input')
  );
