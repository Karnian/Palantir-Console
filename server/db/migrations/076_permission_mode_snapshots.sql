-- Before permission_mode was structured, the Agents UI encouraged operators
-- to put Claude's flag in args_template. The stream-json worker path no longer
-- executes that template, so leaving the new column NULL would silently turn a
-- visibly safer legacy profile into bypassPermissions. Preserve the explicit
-- legacy intent. Keep args_template unchanged for auditability and backwards
-- compatibility; save-time validation prevents new raw flags.
WITH normalized AS (
  SELECT
    id,
    ' ' || replace(
      replace(
        replace(
          replace(args_template, '"', ''),
          char(9),
          ' '
        ),
        char(10),
        ' '
      ),
      char(13),
      ' '
    ) || ' ' AS args
  FROM agent_profiles
  WHERE permission_mode IS NULL
    AND lower(command) LIKE '%claude%'
    AND args_template LIKE '%--permission-mode%'
),
tails AS (
  SELECT
    id,
    substr(
      args,
      instr(args, ' --permission-mode') + length(' --permission-mode')
    ) AS tail
  FROM normalized
  WHERE instr(args, ' --permission-mode') > 0
),
values_after_flag AS (
  SELECT
    id,
    CASE
      WHEN substr(tail, 1, 1) = '=' THEN substr(tail, 2)
      WHEN substr(tail, 1, 1) = ' ' THEN ltrim(tail, ' ')
      ELSE NULL
    END AS value_tail
  FROM tails
),
promotions AS (
  SELECT
    id,
    CASE
      WHEN substr(value_tail, 1, length('acceptEdits') + 1) = 'acceptEdits ' THEN 'acceptEdits'
      WHEN substr(value_tail, 1, length('auto') + 1) = 'auto ' THEN 'auto'
      WHEN substr(value_tail, 1, length('bypassPermissions') + 1) = 'bypassPermissions ' THEN 'bypassPermissions'
      WHEN substr(value_tail, 1, length('default') + 1) = 'default ' THEN 'default'
      WHEN substr(value_tail, 1, length('dontAsk') + 1) = 'dontAsk ' THEN 'dontAsk'
      WHEN substr(value_tail, 1, length('manual') + 1) = 'manual ' THEN 'manual'
      WHEN substr(value_tail, 1, length('plan') + 1) = 'plan ' THEN 'plan'
      ELSE NULL
    END AS permission_mode
  FROM values_after_flag
)
UPDATE agent_profiles
SET permission_mode = (
  SELECT promotions.permission_mode
  FROM promotions
  WHERE promotions.id = agent_profiles.id
)
WHERE id IN (
  SELECT id
  FROM promotions
  WHERE permission_mode IS NOT NULL
);

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
