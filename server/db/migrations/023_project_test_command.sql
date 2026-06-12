-- H-1: Run Harvest opt-in test command.
-- NULL means the harvest test stage is skipped.

ALTER TABLE projects ADD COLUMN test_command TEXT;
