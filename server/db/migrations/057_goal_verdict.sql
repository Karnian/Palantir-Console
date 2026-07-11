-- G3: verdict loop. Additive columns for the goal verdict + retry lineage.
-- (§5e attempt-continuity columns — goal_root_commit / attempt_base_commit /
--  attempt_ref — land in the G3 attempt-continuity follow-up, not here.)
--
-- goal_verdict is the SINGLE source of a goal task's transition (§5g). It is
-- CAS-persisted (WHERE goal_verdict IS NULL) so a duplicate harvest / boot
-- sweeper race produces exactly one winner + one set of side effects (§5d).
ALTER TABLE runs ADD COLUMN goal_verdict TEXT;          -- retry|gate2|exhausted|error
ALTER TABLE runs ADD COLUMN goal_verdict_reason TEXT;   -- fixed enum: non_retryable|source_changed|no_progress|exhausted|harvest_incomplete|runner_unavailable|internal
ALTER TABLE runs ADD COLUMN goal_retry_run_id TEXT;     -- child retry run, set with the parent CAS in one tx (§5d)
ALTER TABLE runs ADD COLUMN goal_fingerprint TEXT;      -- hash(acceptance) — same-failure repeat → early gate2 (§4)

-- Transactional outbox (§5d, codex plan-review R4). A verdict's side effects
-- (goal:verdict / goal:exhausted / goal:error) are recorded as durable 'pending'
-- INTENT inside the SAME tx that CAS-persists the verdict — so a crash after the
-- verdict commits but before the effect dispatches never loses the effect. A
-- replayable dispatcher emits each pending effect then marks it 'sent'; a crash
-- before 'sent' re-drives on the next reconcile/boot (AT-LEAST-ONCE, never lost).
-- Webhook subscribers dedup on the stable key run_id:effect_type. Once 'sent' a
-- row is never re-emitted (bounded reboot duplication).
CREATE TABLE IF NOT EXISTS goal_effects (
  run_id       TEXT NOT NULL,
  effect_type  TEXT NOT NULL,   -- goal:verdict | goal:exhausted | goal:error
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | sent
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at      TEXT,
  PRIMARY KEY (run_id, effect_type)
);

-- Boot sweeper / dispatcher scan of undelivered effects across all runs.
CREATE INDEX IF NOT EXISTS idx_goal_effects_pending ON goal_effects(status) WHERE status = 'pending';
