-- G4a: composite index for the Gate 2 review sweep's correlated NOT-EXISTS
-- (listReviewableGoalRunsWithoutReview scans run_events by run_id + event_type
-- every sweep interval; the two single-column indexes are suboptimal for the
-- correlated subquery — codex plan-review MINOR).
CREATE INDEX IF NOT EXISTS idx_run_events_run_type ON run_events(run_id, event_type);

-- G4a: partial index so the periodic review sweep's outer scan touches only goal
-- runs (the vast majority of runs are goal_active=0) instead of the full runs
-- table every interval (codex diff-review MINOR).
CREATE INDEX IF NOT EXISTS idx_runs_goal_verdict ON runs(goal_verdict) WHERE goal_active = 1;
