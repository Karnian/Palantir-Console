-- Retire the original seeded OpenCode profile without deleting a user-repurposed row.
-- Fail active work first so ON DELETE SET NULL cannot leave it invisible to queue drains.
UPDATE runs
SET status = 'failed',
    ended_at = datetime('now'),
    non_retryable = 1
WHERE agent_profile_id = 'opencode'
  AND status IN ('queued', 'materializing', 'running', 'paused', 'needs_input')
  AND EXISTS (
    SELECT 1
    FROM agent_profiles
    WHERE id = 'opencode' AND command = 'opencode'
  );

DELETE FROM agent_profiles
WHERE id = 'opencode' AND command = 'opencode';
