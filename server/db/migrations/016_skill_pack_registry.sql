-- Skill Pack Gallery: registry tracking columns
ALTER TABLE skill_packs ADD COLUMN registry_id TEXT;
ALTER TABLE skill_packs ADD COLUMN registry_version TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_pack_registry_id
  ON skill_packs(registry_id) WHERE registry_id IS NOT NULL;
