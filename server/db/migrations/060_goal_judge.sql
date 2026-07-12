-- G3c §5k-4: Gate 1.5 judge (an LLM rubric judgment between Gate 1 machine
-- verification and Gate 2 Operator review). Default OFF (PALANTIR_GOAL_JUDGE +
-- tasks.goal_judge_enabled). The judge is ADVISORY: a judge FAIL loops retry
-- (within budget), a judge error/timeout fail-opens to gate2, and a judge PASS
-- never makes a task 'done' — Gate 2 (Operator) → human is always the final
-- accept authority.
--
-- goal_judge_active: the per-run activation decision, STAMPED AT SPAWN (mirrors
-- goal_active) so a mid-attempt flag/config toggle cannot change judge behavior
-- or cost (codex plan-review SERIOUS).
--
-- judge_json: the Gate 1.5 result. Also a durable at-most-once CLAIM — the harvest
-- CASes it NULL → {status:'pending', deadline} before the model call, so only the
-- CAS winner invokes and a crash/concurrent path never re-invokes (codex BLOCKER).
--   { status: 'pending'|'pass'|'fail'|'error', deadline?, reasons?, model?, input_fp? }
ALTER TABLE runs ADD COLUMN goal_judge_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN judge_json TEXT;
