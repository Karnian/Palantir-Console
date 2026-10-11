ALTER TABLE assistant_threads ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0, 1));
CREATE TABLE assistant_requests (
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'error')),
  PRIMARY KEY(thread_id, request_id)
);
CREATE INDEX assistant_request_turn ON assistant_requests(thread_id, turn_id);
