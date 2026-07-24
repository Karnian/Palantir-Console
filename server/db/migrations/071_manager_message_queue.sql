-- Durable FIFO queue for Top/Operator manager chat messages.
--
-- `sequence` is the global monotonic tiebreaker; FIFO is enforced by
-- (conversation_id, sequence).  A message id is also used as the adapter
-- invocation id so terminal manager events can correlate completion after a
-- process restart.
CREATE TABLE manager_message_queue (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  adapter_invocation_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  display_text TEXT NOT NULL DEFAULT '',
  attachment_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'processing', 'delivered', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  claim_token TEXT,
  claimed_by TEXT,
  lease_expires_at INTEGER,
  run_id TEXT,
  manager_adapter TEXT,
  last_error TEXT,
  terminal_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  failed_at TEXT,
  cancelled_at TEXT,
  UNIQUE (conversation_id, idempotency_key)
);

CREATE INDEX idx_manager_message_queue_fifo
  ON manager_message_queue (conversation_id, status, available_at, sequence);

CREATE INDEX idx_manager_message_queue_claim
  ON manager_message_queue (status, lease_expires_at);

CREATE INDEX idx_manager_message_queue_run
  ON manager_message_queue (run_id, status);
