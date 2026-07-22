-- Retire the original seeded OpenCode profile without deleting a user-repurposed row.
-- Only fail work that cannot own a live tmux session or materialization attempt.
UPDATE runs
SET status = 'failed',
    ended_at = datetime('now'),
    non_retryable = 1
WHERE agent_profile_id = 'opencode'
  AND status IN ('queued', 'paused', 'needs_input')
  AND EXISTS (
    SELECT 1
    FROM agent_profiles
    WHERE id = 'opencode' AND command = 'opencode'
  );

-- Migrations are one-shot (tracked in schema_version and never re-run), so a
-- running/materializing reference permanently skips this deletion rather than
-- retrying after that run ends. This deliberately favors never creating a
-- zombie process or leaking a materialization lease over guaranteed cleanup in
-- this narrow edge case. The leftover row is harmless because Phase 2's
-- rejectRetiredAgentType blocks every new OpenCode profile.
DELETE FROM agent_profiles
WHERE id = 'opencode'
  AND command = 'opencode'
  AND NOT EXISTS (
    SELECT 1
    FROM runs
    WHERE agent_profile_id = 'opencode'
      AND status IN ('running', 'materializing')
  );
