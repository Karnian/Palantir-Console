ALTER TABLE operator_schedules ADD COLUMN precheck_verify_check_id INTEGER NULL
  REFERENCES verify_checks(id) ON DELETE RESTRICT;

ALTER TABLE operator_schedules ADD COLUMN consecutive_precheck_errors INTEGER NOT NULL DEFAULT 0
  CHECK(consecutive_precheck_errors >= 0);

-- A verify check's execution boundary is immutable after creation. The service
-- already preserves these fields; keep raw SQL and future write paths honest.
CREATE TRIGGER verify_checks_kind_immutable
BEFORE UPDATE ON verify_checks
WHEN NEW.kind != OLD.kind OR NEW.project_id IS NOT OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'verify_check kind/project_id are immutable');
END;
