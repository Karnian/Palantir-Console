CREATE TABLE assistant_memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL CHECK(length(content) <= 500),
  kind TEXT NOT NULL CHECK(kind IN ('preference', 'fact', 'person', 'project', 'other')),
  status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('proposal', 'human'))
);
CREATE TABLE assistant_memory_proposals (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK(operation IN ('add', 'forget')),
  content TEXT NOT NULL CHECK(length(content) <= 500),
  kind TEXT NOT NULL CHECK(kind IN ('preference', 'fact', 'person', 'project', 'other')),
  reason TEXT NOT NULL CHECK(length(reason) <= 300),
  target_memory_id TEXT,
  target_revision INTEGER,
  target_content_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'stale')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  content_hash TEXT NOT NULL,
  source_thread_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK((operation = 'add' AND target_memory_id IS NULL AND target_revision IS NULL
    AND target_content_hash IS NULL) OR (operation = 'forget' AND target_memory_id IS NOT NULL
    AND target_revision IS NOT NULL AND target_content_hash IS NOT NULL))
);
CREATE INDEX assistant_memory_pending ON assistant_memory_proposals(status);
CREATE TABLE assistant_memory_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  memory_id TEXT,
  proposal_id TEXT,
  text TEXT NOT NULL CHECK(length(text) <= 300),
  created_at TEXT NOT NULL
);
CREATE TRIGGER assistant_memory_audit_no_update BEFORE UPDATE ON assistant_memory_audit
BEGIN SELECT RAISE(ABORT, 'assistant_memory_audit_append_only'); END;
CREATE TRIGGER assistant_memory_audit_no_delete BEFORE DELETE ON assistant_memory_audit
BEGIN SELECT RAISE(ABORT, 'assistant_memory_audit_append_only'); END;
CREATE TABLE assistant_memory_revision (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  revision INTEGER NOT NULL CHECK(revision >= 0)
);
INSERT INTO assistant_memory_revision VALUES (1, 0);
ALTER TABLE assistant_messages ADD COLUMN memory_proposal_id TEXT;
