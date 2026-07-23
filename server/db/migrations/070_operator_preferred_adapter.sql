-- Operator CLI preference belongs to the durable Operator instance.
--
-- pm_adapter remains the adapter of the currently persisted vendor thread.
-- preferred_adapter is the user's desired adapter for the next/live thread.
-- NULL preserves the legacy project/global fallback chain.

ALTER TABLE operator_instances ADD COLUMN preferred_adapter TEXT NULL
  CHECK(preferred_adapter IS NULL OR preferred_adapter IN ('codex', 'claude'));
