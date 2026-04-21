-- M3: track updated_at on mcp_server_templates so RunInspector can detect
-- template modifications that happened after a run's preset snapshot was
-- captured (template body is NOT part of preset snapshot_json — only the
-- template id is — so without updated_at there is no drift signal at all).
--
-- SQLite ALTER TABLE ADD COLUMN does not allow NOT NULL with a non-constant
-- default, so we add the column nullable and backfill from created_at.
-- The service layer writes updated_at explicitly on every API-driven CUD;
-- the boot seed upsert only bumps updated_at when content actually changed.
ALTER TABLE mcp_server_templates ADD COLUMN updated_at TEXT;
UPDATE mcp_server_templates SET updated_at = created_at WHERE updated_at IS NULL;
