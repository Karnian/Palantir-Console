CREATE TABLE worker_questions (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id),
  task_id          TEXT,
  project_id       TEXT,
  idempotency_key  TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  class            TEXT NOT NULL
    CHECK(class IN ('clarification','choice','approval')),
  question         TEXT NOT NULL,
  options_json     TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','answered','cancelled','expired')),
  answer           TEXT,
  answered_at      TEXT,
  resumed_run_id   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_worker_questions_one_pending
  ON worker_questions(run_id) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_worker_questions_idem
  ON worker_questions(run_id, idempotency_key);
CREATE INDEX idx_worker_questions_status ON worker_questions(status);
