-- M4-a: MCP Streamable HTTP transport — promote `mcp_server_templates` to a
-- discriminated union (`transport` ∈ {'stdio','http'}). Existing rows are
-- migrated as `stdio`. http rows hold `url` (+ optional `bearer_token_env_var`)
-- instead of `command`/`args`/`allowed_env_keys`.
--
-- Spec: docs/specs/m4-mcp-http-streamable-transport-brief.md §L3
--
-- Required structural change: 013_skill_packs.sql created `command TEXT NOT
-- NULL`. SQLite's ALTER TABLE cannot drop NOT NULL, so we rebuild the table.
-- The whole script runs inside a single transaction (provided by the
-- migrations runner), so partial state is impossible.
--
-- Trigger truth table (column-shape + immutability — service validator is
-- canonical, triggers are the last line of defense):
--   transport='stdio': command NOT NULL & non-empty; args/allowed_env_keys
--                       optional; url/bearer_token_env_var MUST be NULL.
--   transport='http' : url NOT NULL & non-empty; bearer_token_env_var
--                       optional; command/args/allowed_env_keys MUST be NULL.
--   transport+alias  : both immutable post-creation.

CREATE TABLE mcp_server_templates_new (
  id                   TEXT PRIMARY KEY,
  alias                TEXT NOT NULL UNIQUE,
  transport            TEXT NOT NULL DEFAULT 'stdio'
                       CHECK (transport IN ('stdio', 'http')),
  command              TEXT,
  args                 TEXT,
  allowed_env_keys     TEXT,
  url                  TEXT,
  bearer_token_env_var TEXT,
  description          TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT
);

-- Existing rows are stdio by definition (transport column is new).
INSERT INTO mcp_server_templates_new
  (id, alias, transport, command, args, allowed_env_keys, description, created_at, updated_at)
SELECT
  id, alias, 'stdio', command, args, allowed_env_keys, description, created_at, updated_at
FROM mcp_server_templates;

DROP TABLE mcp_server_templates;
ALTER TABLE mcp_server_templates_new RENAME TO mcp_server_templates;

-- BEFORE INSERT: column-shape per transport.
CREATE TRIGGER mcp_template_transport_consistency_insert
BEFORE INSERT ON mcp_server_templates
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.transport = 'stdio' AND (NEW.command IS NULL OR trim(NEW.command) = '')
      THEN RAISE(ABORT, 'stdio template requires non-empty command')
    WHEN NEW.transport = 'stdio' AND NEW.url IS NOT NULL
      THEN RAISE(ABORT, 'stdio template must not have url')
    WHEN NEW.transport = 'stdio' AND NEW.bearer_token_env_var IS NOT NULL
      THEN RAISE(ABORT, 'stdio template must not have bearer_token_env_var')
    WHEN NEW.transport = 'http' AND (NEW.url IS NULL OR trim(NEW.url) = '')
      THEN RAISE(ABORT, 'http template requires non-empty url')
    WHEN NEW.transport = 'http' AND NEW.command IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have command')
    WHEN NEW.transport = 'http' AND NEW.args IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have args')
    WHEN NEW.transport = 'http' AND NEW.allowed_env_keys IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have allowed_env_keys')
  END;
END;

-- BEFORE UPDATE: same column-shape + transport/alias immutability.
CREATE TRIGGER mcp_template_transport_consistency_update
BEFORE UPDATE ON mcp_server_templates
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN OLD.transport != NEW.transport
      THEN RAISE(ABORT, 'transport is immutable — create a new template instead')
    WHEN OLD.alias != NEW.alias
      THEN RAISE(ABORT, 'alias is immutable — create a new template instead')
    WHEN NEW.transport = 'stdio' AND (NEW.command IS NULL OR trim(NEW.command) = '')
      THEN RAISE(ABORT, 'stdio template requires non-empty command')
    WHEN NEW.transport = 'stdio' AND NEW.url IS NOT NULL
      THEN RAISE(ABORT, 'stdio template must not have url')
    WHEN NEW.transport = 'stdio' AND NEW.bearer_token_env_var IS NOT NULL
      THEN RAISE(ABORT, 'stdio template must not have bearer_token_env_var')
    WHEN NEW.transport = 'http' AND (NEW.url IS NULL OR trim(NEW.url) = '')
      THEN RAISE(ABORT, 'http template requires non-empty url')
    WHEN NEW.transport = 'http' AND NEW.command IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have command')
    WHEN NEW.transport = 'http' AND NEW.args IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have args')
    WHEN NEW.transport = 'http' AND NEW.allowed_env_keys IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have allowed_env_keys')
  END;
END;
