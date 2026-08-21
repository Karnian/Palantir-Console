ALTER TABLE runs ADD COLUMN status_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER trg_runs_status_epoch_bump
AFTER UPDATE OF status ON runs
BEGIN
  UPDATE runs SET status_epoch = OLD.status_epoch + 1 WHERE id = OLD.id;
END;
