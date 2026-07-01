-- 043_operator_profiles.sql
-- Operator Profile entity (PF-1). A first-class stored bundle a specialist
-- resolves by id: { name, persona, capabilities } — so operators pick a named
-- profile instead of typing raw persona/capabilities per request.
--
-- NEW table, distinct from agent_profiles (which is CLI adapter config:
-- command/args/type). The brief's agent_profiles→adapter_config rename is a
-- separate high-blast-radius refactor and is NOT done here.
--
-- P-B1 connection: operator_profiles.id IS the memory owner_id for a profile
-- owner (normalizeOwner({profile_id}) → owner_type='profile', owner_id=id).
-- Memory owner columns are plain TEXT with NO FK by design (historical
-- preservation — same reason run_preset_snapshots has no FK to worker_presets),
-- so deleting a profile never cascades into profile-scoped memory.

CREATE TABLE operator_profiles (
  id                TEXT PRIMARY KEY,                 -- 'op_' + uuid slice
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  persona           TEXT,                             -- appended AFTER the fixed specialist preamble
  capabilities_json TEXT NOT NULL DEFAULT '[]',       -- JSON array of capability strings
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (json_valid(capabilities_json) AND json_type(capabilities_json, '$') = 'array')
);

-- Bump updated_at on any UPDATE that didn't already set it (mirrors
-- 020_mcp_template_updated_at.sql; avoids service-layer drift).
CREATE TRIGGER operator_profiles_updated_at
AFTER UPDATE ON operator_profiles
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE operator_profiles SET updated_at = datetime('now') WHERE id = OLD.id;
END;
