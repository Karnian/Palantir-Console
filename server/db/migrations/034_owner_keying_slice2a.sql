-- 034_owner_keying_slice2a.sql
-- P-A1 Slice 2a: L2 owner-unique structure after the JS cross-scope merge.
--
-- owner cap=1000 transition is slice 2b. Reads/retrieve/admission remain
-- scope-keyed in 2a; the existing per-scope cap stays 500.
--
-- Keep the existing scope-based unique indexes. Slice 5 drops them after the
-- full owner-key transition; on clean data both index families hold.

CREATE UNIQUE INDEX IF NOT EXISTS idx_master_memory_owner_content_hash
  ON master_memory_items(owner_type, owner_id, content_hash)
  WHERE status='active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_master_memory_owner_factkey
  ON master_memory_items(owner_type, owner_id, fact_key)
  WHERE fact_key IS NOT NULL AND status='active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_master_memory_candidates_owner_dedup
  ON master_memory_candidates(owner_type, owner_id, rule, dedup_key);
