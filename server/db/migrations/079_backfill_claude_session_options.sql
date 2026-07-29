-- Migration 078 made fresh Claude Manager sessions immutable but left every
-- pre-existing session NULL. The launch-time options of those sessions were
-- never persisted, so the mutable profile visible now cannot prove what the
-- running process used (the profile may already have changed before upgrade).
-- Mark such sessions explicitly unresumable: boot resume fails closed once
-- instead of silently dropping an original tool ban or budget cap.
UPDATE runs
SET session_claude_options_json = json_object(
  'legacyUnresumable', json('true')
)
WHERE is_manager = 1
  AND COALESCE(manager_adapter, 'claude-code') = 'claude-code'
  AND session_claude_options_json IS NULL;
