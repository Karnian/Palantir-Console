-- F-1: Codex Fast Mode toggle (per Operator instance).
-- fast_mode ∈ {1 = fast service tier, 0 = standard, NULL = follow PALANTIR_CODEX_FAST env}.
-- NULL default keeps every existing instance on the global env-derived tier.
-- getOperatorInstance / listInstances are `SELECT *`, so the column is read
-- automatically by spawn/resume paths with no statement changes.
ALTER TABLE operator_instances ADD COLUMN fast_mode INTEGER;
