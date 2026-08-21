-- Conditional activation for declarative environment providers.
--
-- Kept separate from 089 so the gate contract remains independently auditable.

ALTER TABLE environment_providers
  ADD COLUMN gate_env_key TEXT;

ALTER TABLE environment_providers
  ADD COLUMN gate_env_value TEXT
  CHECK (
    gate_env_key IS NOT NULL OR gate_env_value IS NULL
  );
