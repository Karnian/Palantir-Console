-- 040_drop_legacy_injection_ledgers.sql
-- S5-LEDGER PR B: drop the legacy injection ledgers, now fully retired.
--
-- Background: PR A (#242) made the memory Composer the sole injection path.
-- The legacy pm_memory_injection / master_memory_injection tables stopped
-- receiving writes (the dual-write was removed) and were only READ once at
-- startup by compositionLedger.seedFromLegacyLedgers() to bridge in-flight
-- manager runs into the composition ledger on the COMPOSER=1 flip.
--
-- Sequencing (why this is safe now): PR A shipped + the server restarted with
-- it, so seedFromLegacyLedgers already populated memory_composition_owner_state
-- for every active run that had a legacy injection record. shouldCompose now
-- reads the composition ledger exclusively. These tables are inert.
--
-- PR B removes seedFromLegacyLedgers (the only reader) in the same change, so
-- after this migration nothing references these tables.
--
-- INVARIANT (unchanged): the revision counters (project_memory_revision,
-- master_memory_revision) are NOT touched — they remain provenance-keyed and
-- are read by shouldCompose via getRevision().

DROP TABLE IF EXISTS pm_memory_injection;
DROP TABLE IF EXISTS master_memory_injection;
