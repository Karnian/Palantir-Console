-- Phase 5-3: Add requires_capabilities to skill_packs
ALTER TABLE skill_packs ADD COLUMN requires_capabilities TEXT;  -- JSON array of capability strings
