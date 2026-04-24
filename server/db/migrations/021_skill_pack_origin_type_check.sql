-- Skill Pack Gallery v1.1 R1: enforce origin_type enum
--
-- Migration 017 added `origin_type TEXT NOT NULL DEFAULT 'manual'` but spec
-- §6.3 (skill-pack-gallery-v1.1.md) also requires a
-- `CHECK (origin_type IN ('bundled','url','manual','import'))` constraint.
-- SQLite doesn't support adding a CHECK constraint to an existing column
-- without a table rebuild, so we enforce the enum via BEFORE INSERT/UPDATE
-- triggers instead. Behavior is equivalent: invalid values are aborted with
-- a clear error, Lock-in #9 is honored at the DB layer.

CREATE TRIGGER IF NOT EXISTS trg_skill_packs_origin_type_insert_check
  BEFORE INSERT ON skill_packs
  WHEN NEW.origin_type NOT IN ('bundled','url','manual','import')
BEGIN
  SELECT RAISE(ABORT, 'origin_type must be one of: bundled, url, manual, import');
END;

CREATE TRIGGER IF NOT EXISTS trg_skill_packs_origin_type_update_check
  BEFORE UPDATE OF origin_type ON skill_packs
  WHEN NEW.origin_type NOT IN ('bundled','url','manual','import')
BEGIN
  SELECT RAISE(ABORT, 'origin_type must be one of: bundled, url, manual, import');
END;
