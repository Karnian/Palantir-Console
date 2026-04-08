-- v3 Phase 4: dispatch audit log for reconciliation (annotate-only).
-- Spec §9.7 + §8.3. Rows are written AFTER a PM claims a dispatch outcome
-- (e.g. "I kicked off worker X for task Y" or "task Z is done") and
-- reconciliationService compares the claim against the actual DB state.
-- incoherence_flag is purely informational for Phase 4 — the UI renders
-- a warning badge but the message is NOT blocked. If false-positive rates
-- stay low in operation, a later phase can promote this to a hard gate.

CREATE TABLE IF NOT EXISTS dispatch_audit_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,                         -- nullable: some claims do not reference a specific task
  pm_run_id TEXT,                       -- nullable: claims from Top (no PM layer) leave this null
  selected_agent_profile_id TEXT,       -- nullable: not every audited claim is a spawn
  rationale TEXT,                       -- PM's stated reason for the dispatch / claim
  pm_claim TEXT NOT NULL,               -- what the PM said happened (JSON)
  db_truth TEXT NOT NULL,               -- what the DB actually shows at check time (JSON)
  incoherence_flag INTEGER DEFAULT 0,   -- 0 = coherent, 1 = mismatch (annotate, don't block)
  incoherence_kind TEXT,                -- short tag: 'pm_hallucination' | 'user_intervention_stale' | 'other'
  created_at INTEGER NOT NULL           -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_dispatch_audit_project
  ON dispatch_audit_log(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_audit_incoherent
  ON dispatch_audit_log(incoherence_flag, created_at DESC)
  WHERE incoherence_flag = 1;
