-- 009_manager_layer_conversation.sql
-- v3 Phase 1.5: Conversation identity as first-class citizen.
--
-- See docs/specs/manager-v3-multilayer.md §9.3.
--
-- Background — what this migration does NOT add:
--   * parent_manager_run_id  → already exists as runs.parent_run_id (002)
--   * manager_thread_id      → already exists on runs (005)
--   * manager_adapter        → already exists on runs (005)
--
-- New columns:
--   manager_layer   — 'top' | 'pm' | NULL. NULL means "worker" (is_manager=0).
--                     In Phase 1.5 only 'top' is actually produced; 'pm' is
--                     reserved for Phase 3a. We enumerate it up front so the
--                     CHECK constraint does not need to be rewritten later.
--   conversation_id — stable conversation identity. Format:
--                       'top'              for singleton Top manager (MVP)
--                       'pm:<projectId>'   for PM sessions (Phase 3a)
--                       'worker:<runId>'   for worker direct-chat surface
--                     A manager run may be replaced across server restarts,
--                     but its conversation_id stays stable so the client can
--                     keep using one SSE/polling cursor across the gap.
--
-- Backfill policy:
--   * Existing Top managers (is_manager=1): manager_layer='top',
--     conversation_id='top'. Because there is only one Top at a time the
--     collision risk is zero.
--   * Existing workers (is_manager=0): conversation_id='worker:' || id.
--     manager_layer stays NULL.
--
-- Index choices:
--   * Partial index on manager_layer because the overwhelming majority of
--     rows are workers (manager_layer IS NULL); a full index would be waste.
--   * Non-unique index on conversation_id. A unique constraint is INCORRECT
--     here: over time many historical Top manager runs accumulate, all
--     sharing conversation_id='top'. Uniqueness at "only one RUNNING Top"
--     level is enforced in code (activeManagerRunId + routes/manager.js
--     startingManager guard), not at the DB level.

ALTER TABLE runs ADD COLUMN manager_layer TEXT
  CHECK (manager_layer IS NULL OR manager_layer IN ('top', 'pm'));

ALTER TABLE runs ADD COLUMN conversation_id TEXT;

-- Backfill: existing manager runs → layer='top', conversation_id='top'.
UPDATE runs
   SET manager_layer = 'top',
       conversation_id = 'top'
 WHERE is_manager = 1
   AND manager_layer IS NULL;

-- Backfill: existing worker runs → conversation_id='worker:<id>'.
UPDATE runs
   SET conversation_id = 'worker:' || id
 WHERE is_manager = 0
   AND conversation_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_runs_manager_layer
  ON runs(manager_layer)
  WHERE manager_layer IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runs_conversation_id
  ON runs(conversation_id)
  WHERE conversation_id IS NOT NULL;

INSERT INTO schema_version (version) VALUES (9);
