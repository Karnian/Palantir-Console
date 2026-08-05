-- PR1b-2b: repair retries have an independent backoff clock.
ALTER TABLE actions ADD COLUMN next_repair_at TEXT;
