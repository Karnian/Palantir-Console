CREATE TABLE assistant_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) <= 80),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  next_seq INTEGER NOT NULL DEFAULT 1,
  deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0, 1))
);
CREATE TABLE assistant_active_thread (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id)
);
CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  turn_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool_note', 'system_note')),
  content TEXT NOT NULL CHECK(length(CAST(content AS BLOB)) <= 65536),
  request_id TEXT CHECK(request_id IS NULL OR role = 'user'),
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'error')),
  model_session_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE UNIQUE INDEX assistant_request_id ON assistant_messages(thread_id, request_id)
  WHERE request_id IS NOT NULL;
CREATE TABLE assistant_requests (
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'error')),
  PRIMARY KEY(thread_id, request_id)
);
CREATE INDEX assistant_request_turn ON assistant_requests(thread_id, turn_id);
