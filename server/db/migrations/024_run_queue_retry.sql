-- B-lite: queued worker arguments + retry attempt counter.
-- queued_args stores enqueue-time effective worker args as JSON:
--   { "skillPackIds": [...], "presetId": "<effective preset id or null>" }
-- retry_count counts automatic retry attempts on new attempt runs.

ALTER TABLE runs ADD COLUMN queued_args TEXT;
ALTER TABLE runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
