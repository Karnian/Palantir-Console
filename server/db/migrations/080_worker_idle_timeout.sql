ALTER TABLE agent_profiles
  ADD COLUMN idle_timeout_ms INTEGER
  CHECK (
    idle_timeout_ms IS NULL
    OR (typeof(idle_timeout_ms) = 'integer' AND idle_timeout_ms > 0)
  );

ALTER TABLE runs ADD COLUMN terminal_reason TEXT;
