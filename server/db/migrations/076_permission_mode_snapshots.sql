-- Before permission_mode was structured, the Agents UI encouraged operators
-- to put Claude's flag in args_template. The stream-json worker path no longer
-- executes that template, so leaving the new column NULL would silently turn a
-- visibly safer legacy profile into bypassPermissions. Preserve the explicit
-- legacy intent. Keep args_template unchanged for auditability and backwards
-- compatibility; save-time validation prevents new raw flags.
UPDATE agent_profiles
SET permission_mode = CASE
  WHEN replace(args_template, '"', '') LIKE '%--permission-mode acceptEdits'
    OR replace(args_template, '"', '') LIKE '%--permission-mode acceptEdits %'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=acceptEdits'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=acceptEdits %' THEN 'acceptEdits'
  WHEN replace(args_template, '"', '') LIKE '%--permission-mode auto'
    OR replace(args_template, '"', '') LIKE '%--permission-mode auto %'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=auto'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=auto %' THEN 'auto'
  WHEN replace(args_template, '"', '') LIKE '%--permission-mode bypassPermissions'
    OR replace(args_template, '"', '') LIKE '%--permission-mode bypassPermissions %'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=bypassPermissions'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=bypassPermissions %' THEN 'bypassPermissions'
  WHEN replace(args_template, '"', '') LIKE '%--permission-mode default'
    OR replace(args_template, '"', '') LIKE '%--permission-mode default %'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=default'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=default %' THEN 'default'
  WHEN replace(args_template, '"', '') LIKE '%--permission-mode dontAsk'
    OR replace(args_template, '"', '') LIKE '%--permission-mode dontAsk %'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=dontAsk'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=dontAsk %' THEN 'dontAsk'
  WHEN replace(args_template, '"', '') LIKE '%--permission-mode manual'
    OR replace(args_template, '"', '') LIKE '%--permission-mode manual %'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=manual'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=manual %' THEN 'manual'
  WHEN replace(args_template, '"', '') LIKE '%--permission-mode plan'
    OR replace(args_template, '"', '') LIKE '%--permission-mode plan %'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=plan'
    OR replace(args_template, '"', '') LIKE '%--permission-mode=plan %' THEN 'plan'
END
WHERE permission_mode IS NULL
  AND lower(command) LIKE '%claude%'
  AND args_template LIKE '%--permission-mode%';

-- A resumed Claude manager must use the permission mode selected at the fresh
-- spawn boundary, even if its mutable profile is later edited or deleted.
ALTER TABLE runs ADD COLUMN session_permission_mode TEXT;

-- Snapshot pre-existing live/history rows according to the resolution rule
-- used before this column existed. Top runs prefer their selected profile;
-- Operators historically selected the first same-type profile by name.
UPDATE runs
SET session_permission_mode = COALESCE(
  (
    SELECT COALESCE(agent_profiles.permission_mode, 'bypassPermissions')
    FROM agent_profiles
    WHERE agent_profiles.id = runs.agent_profile_id
  ),
  (
    SELECT COALESCE(agent_profiles.permission_mode, 'bypassPermissions')
    FROM agent_profiles
    WHERE agent_profiles.type = 'claude-code'
    ORDER BY agent_profiles.name ASC
    LIMIT 1
  ),
  'bypassPermissions'
)
WHERE is_manager = 1
  AND COALESCE(manager_adapter, 'claude-code') = 'claude-code';
