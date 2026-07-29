-- Conditional activation for declarative environment providers.
--
-- Kept separate from 075 so databases that already applied the provider
-- migration while fix/457 was under review still receive the gate columns.

ALTER TABLE environment_providers
  ADD COLUMN gate_env_key TEXT;

ALTER TABLE environment_providers
  ADD COLUMN gate_env_value TEXT
  CHECK (
    (gate_env_key IS NULL AND gate_env_value IS NULL)
    OR
    (gate_env_key IS NOT NULL AND gate_env_value IS NOT NULL)
  );
