-- Migration 078 made fresh Claude Manager sessions immutable but left every
-- pre-existing session NULL. Freeze the profile template visible at this
-- upgrade boundary so the first boot resume cannot consult a later profile
-- edit. The application deliberately reparses argsTemplate with the same
-- production parser used at fresh spawn instead of duplicating that tokenizer
-- in SQL.
--
-- Top Managers retain their selected profile. Operators historically had no
-- agent_profile_id and selected the first matching profile from the
-- name-ordered profile list, so preserve that same resolution rule here.
UPDATE runs
SET session_claude_options_json = CASE
  WHEN agent_profile_id IS NOT NULL THEN COALESCE(
    (
      SELECT json_object(
        'argsTemplate', COALESCE(agent_profiles.args_template, ''),
        'legacyProfileSnapshot', json('true')
      )
      FROM agent_profiles
      WHERE agent_profiles.id = runs.agent_profile_id
    ),
    json_object(
      'argsTemplate', '',
      'legacyProfileSnapshot', json('true')
    )
  )
  ELSE COALESCE(
    (
      SELECT json_object(
        'argsTemplate', COALESCE(agent_profiles.args_template, ''),
        'legacyProfileSnapshot', json('true')
      )
      FROM agent_profiles
      WHERE agent_profiles.type = 'claude-code'
      ORDER BY agent_profiles.name ASC
      LIMIT 1
    ),
    json_object(
      'argsTemplate', '',
      'legacyProfileSnapshot', json('true')
    )
  )
END
WHERE is_manager = 1
  AND COALESCE(manager_adapter, 'claude-code') = 'claude-code'
  AND session_claude_options_json IS NULL;
