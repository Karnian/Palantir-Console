-- Declarative environment providers for issue #457.
--
-- Provider rows record operator-supplied env key names only. They never store
-- values and this migration intentionally seeds no vendor/provider defaults.
-- Agent profiles reference providers by stable id so provider names and key
-- declarations can be maintained without rewriting profile rows.

CREATE TABLE environment_providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  env_keys    TEXT NOT NULL DEFAULT '[]'
              CHECK (json_valid(env_keys) AND json_type(env_keys) = 'array'),
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agent_profile_environment_providers (
  agent_profile_id       TEXT NOT NULL
                         REFERENCES agent_profiles(id) ON DELETE CASCADE,
  environment_provider_id TEXT NOT NULL
                         REFERENCES environment_providers(id) ON DELETE RESTRICT,
  PRIMARY KEY (agent_profile_id, environment_provider_id)
);

CREATE INDEX idx_agent_profile_environment_providers_provider
  ON agent_profile_environment_providers(environment_provider_id);
