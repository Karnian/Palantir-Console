-- 028_memory_correction.sql
-- ML PR4: post-hoc correction surface. Two columns the correction CRUD needs:
--   archived_at — when an item was archived (status='archived'); NULL otherwise.
--                 archive HIDES an item from injection without deleting it, so
--                 provenance/audit survive and a restore is possible.
--   pinned      — 0/1. A pinned item is protected from PR5 decay/cap eviction
--                 (a human marked it important). Independent of status.
--
-- status already supports 'archived' (migration 025 CHECK). reviewed_at,
-- valid_to, superseded_by also already exist. Decay-specific columns
-- (last_decayed_at, decay_reason) are deferred to PR5.

ALTER TABLE memory_items ADD COLUMN archived_at TEXT;
ALTER TABLE memory_items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
