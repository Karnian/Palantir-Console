-- 005: manager adapter columns + seed env_allowlist for manager-capable profiles
-- PR3: lets a manager run remember which adapter spawned it and which vendor
-- thread id (Codex resume) it was bound to. Existing manager runs created
-- before this migration get NULL for both columns; PR3 routes default a NULL
-- adapter to 'claude-code' for one minor version of backward compatibility.

ALTER TABLE runs ADD COLUMN manager_adapter TEXT;
ALTER TABLE runs ADD COLUMN manager_thread_id TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_manager_adapter
  ON runs(manager_adapter)
  WHERE manager_adapter IS NOT NULL;

-- Seed env_allowlist for the built-in manager-capable agent profiles so the
-- PR2 authResolver has something to filter against once PR3 plumbs it through.
-- Only update rows that still hold the empty default; never overwrite a user
-- customization.
UPDATE agent_profiles
   SET env_allowlist = '["CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_API_KEY","ANTHROPIC_BASE_URL"]'
 WHERE id = 'claude-code'
   AND (env_allowlist IS NULL OR env_allowlist = '[]' OR env_allowlist = '');

UPDATE agent_profiles
   SET env_allowlist = '["CODEX_API_KEY","OPENAI_API_KEY"]'
 WHERE id = 'codex'
   AND (env_allowlist IS NULL OR env_allowlist = '[]' OR env_allowlist = '');

INSERT INTO schema_version (version) VALUES (5);
