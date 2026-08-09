-- Historical action rows predate declaration provenance. Cookie is the safest
-- legacy attribution because only human approval was production-mounted then;
-- every new declaration supplies the server-derived method explicitly.
ALTER TABLE actions ADD COLUMN declared_by_method TEXT NOT NULL DEFAULT 'cookie'
  CHECK(declared_by_method IN ('bearer', 'cookie'));

DROP TRIGGER trg_actions_intent_immutable;
CREATE TRIGGER trg_actions_intent_immutable
BEFORE UPDATE ON actions
WHEN NEW.task_id != OLD.task_id
  OR NEW.action_slot != OLD.action_slot
  OR NEW.connector != OLD.connector
  OR NEW.operation != OLD.operation
  OR NEW.params_json != OLD.params_json
  OR NEW.params_hash != OLD.params_hash
  OR NEW.reissues_action_id IS NOT OLD.reissues_action_id
  OR NEW.declared_by_method != OLD.declared_by_method
BEGIN
  SELECT RAISE(ABORT, 'action intent columns are immutable');
END;
