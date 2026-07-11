-- G1: Goal Delegation — prompt compiler + goalReport parser + final_output capture.
-- Additive columns only. The verify_checks table + verdict/workspace columns land
-- in G2/G3 (§7 phase table); this migration carries just what G1 reads/writes.
-- tasks/runs are read via SELECT *, so no statement changes are needed.

-- Task-level goal contract knobs (Operator-settable per §6).
ALTER TABLE tasks ADD COLUMN goal_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN goal_max_attempts INTEGER NOT NULL DEFAULT 3;

-- Per-run capture (goal runs only; NULL for every non-goal run).
ALTER TABLE runs ADD COLUMN goal_report TEXT;   -- parsed ```palantir-goal-report``` block
ALTER TABLE runs ADD COLUMN final_output TEXT;  -- final output 전문, cap 64KB (§5k-2)
