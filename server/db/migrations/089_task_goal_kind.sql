ALTER TABLE tasks ADD COLUMN goal_kind TEXT NOT NULL DEFAULT 'deliverable'
  CHECK(goal_kind IN ('deliverable', 'action'))
  CHECK(goal_kind != 'action' OR goal_enabled = 1);
