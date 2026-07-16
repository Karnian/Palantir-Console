-- P2/P3 review: a durable non-retryable flag for runs rejected at a pre-claim
-- gate (worker_profile_invalid backstop / budget_exceeded). Unlike the
-- started_at heuristic, this survives a requeue and covers a goal-active retry
-- child, so goalVerdictService routes such a run to error/non_retryable instead
-- of re-attempting a permanently-doomed run within budget.
ALTER TABLE runs ADD COLUMN non_retryable INTEGER NOT NULL DEFAULT 0;
