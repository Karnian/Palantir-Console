-- Migration 076 originally recognized only one literal space between
-- --permission-mode and its value. Repair databases that already recorded 076
-- while matching the runtime tokenizer's arbitrary horizontal/line whitespace.
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
