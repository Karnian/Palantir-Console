ALTER TABLE operator_schedules ADD COLUMN grace_seconds INTEGER NULL
  CHECK(grace_seconds IS NULL OR grace_seconds >= 0);

ALTER TABLE operator_schedules ADD COLUMN misfire_policy TEXT NOT NULL DEFAULT 'coalesce_latest'
  CHECK(misfire_policy IN ('coalesce_latest','skip'));
