-- Skill Pack Gallery v1.1: Install from URL provenance + origin_type
-- spec: docs/specs/skill-pack-gallery-v1.1.md §6.3
--
-- Existing rows are lossy-migrated to 'manual' (safe default). Previously
-- bundled-installed rows with registry_id matching 'core/%' or 'community/%'
-- are reclassified to 'bundled' during the ALTER. No ambiguous row is
-- auto-classified as 'bundled' otherwise.

ALTER TABLE skill_packs ADD COLUMN source_url TEXT;            -- full canonical URL (query included), server-only, never rendered in UI
ALTER TABLE skill_packs ADD COLUMN source_url_display TEXT;    -- query/fragment stripped canonical, safe to render
ALTER TABLE skill_packs ADD COLUMN source_hash TEXT;           -- SHA-256 hex of fetched bytes
ALTER TABLE skill_packs ADD COLUMN source_fetched_at TEXT;     -- ISO8601
ALTER TABLE skill_packs ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'manual';

-- Reclassify existing bundled rows (installed via v1.0 registry flow using
-- core/ or community/ namespace). Other rows with registry_id are left as
-- 'manual' because we cannot distinguish bundled install from JSON import.
UPDATE skill_packs
SET origin_type = 'bundled'
WHERE (registry_id LIKE 'core/%' OR registry_id LIKE 'community/%')
  AND source_url IS NULL;

-- Partial unique index: only URL-installed rows are unique on source_url
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_pack_source_url
  ON skill_packs(source_url) WHERE source_url IS NOT NULL;
