-- Master Memory verification-spike store (FTS-only; sqlite-vec/graph deferred).
-- Faithful subset of docs/specs/master-memory-brief.md §4 (v1.0 LOCK-IN).
-- Standalone throwaway: does NOT reuse server/ memoryService (spike measures efficacy, not prod wiring).

CREATE TABLE IF NOT EXISTS mm_events (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  actor         TEXT,
  project_id    TEXT,                       -- NULL = user-global
  occurred_at   TEXT NOT NULL,
  content_redacted TEXT,                     -- broad events = NULL (metadata-only, U3); high-signal only carry content
  sensitivity   TEXT NOT NULL DEFAULT 'normal',
  ttl_at        TEXT,
  metadata_hash TEXT NOT NULL,               -- always
  content_hash  TEXT,                         -- stored-content hash only; NULL for metadata-only
  ingested_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mm_events_proj_time ON mm_events(project_id, occurred_at);

CREATE TABLE IF NOT EXISTS mm_chunks (
  rowid_pk    INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  owner_type  TEXT NOT NULL,                  -- event|claim
  owner_id    TEXT NOT NULL,
  text        TEXT NOT NULL,                  -- local retrieval text (lexically intact; redact only outbound/injection)
  project_id  TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- porter+unicode61: stemming improves NL-query recall (tests->test); both A4 raw-FTS and A7 claim retrieval use it equally
CREATE VIRTUAL TABLE IF NOT EXISTS mm_chunks_fts USING fts5(text, content='mm_chunks', content_rowid='rowid_pk', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS mm_chunks_ai AFTER INSERT ON mm_chunks BEGIN
  INSERT INTO mm_chunks_fts(rowid, text) VALUES (new.rowid_pk, new.text); END;
CREATE TRIGGER IF NOT EXISTS mm_chunks_ad AFTER DELETE ON mm_chunks BEGIN
  INSERT INTO mm_chunks_fts(mm_chunks_fts, rowid, text) VALUES('delete', old.rowid_pk, old.text); END;
CREATE TRIGGER IF NOT EXISTS mm_chunks_au AFTER UPDATE ON mm_chunks BEGIN
  INSERT INTO mm_chunks_fts(mm_chunks_fts, rowid, text) VALUES('delete', old.rowid_pk, old.text);
  INSERT INTO mm_chunks_fts(rowid, text) VALUES (new.rowid_pk, new.text); END;

CREATE TABLE IF NOT EXISTS mm_claims (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  object_json   TEXT NOT NULL,
  scope_project_id TEXT,                      -- NULL = user-global
  context       TEXT,
  kind          TEXT NOT NULL,
  page          TEXT, slot_key TEXT,          -- wiki render grouping
  source_kind   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  confidence    REAL NOT NULL DEFAULT 0.5,
  importance    INTEGER NOT NULL DEFAULT 5,
  explicitness  INTEGER NOT NULL DEFAULT 5,
  pinned        INTEGER NOT NULL DEFAULT 0,
  valid_from    TEXT, valid_to TEXT,
  tx_from       TEXT NOT NULL DEFAULT (datetime('now')), tx_to TEXT,
  supersedes_id TEXT,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT,
  CHECK (kind IN ('constraint','preference','commitment','decision','fact','pattern')),
  CHECK (status IN ('active','candidate','superseded','archived')),
  CHECK (source_kind IN ('human','deterministic','llm_candidate')),
  CHECK (confidence BETWEEN 0 AND 1),
  CHECK (importance BETWEEN 1 AND 10)
);
-- R2 blocker1 (live-verified): split partial-unique so NULL-scope (user-global) claims dedup correctly
CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_claims_hash_global ON mm_claims(content_hash)
  WHERE scope_project_id IS NULL AND status IN ('active','candidate');
CREATE UNIQUE INDEX IF NOT EXISTS idx_mm_claims_hash_scoped ON mm_claims(scope_project_id, content_hash)
  WHERE scope_project_id IS NOT NULL AND status IN ('active','candidate');
CREATE INDEX IF NOT EXISTS idx_mm_claims_page ON mm_claims(page, slot_key, status);
CREATE INDEX IF NOT EXISTS idx_mm_claims_scope ON mm_claims(scope_project_id, status, importance DESC);

CREATE TABLE IF NOT EXISTS mm_claim_evidence (
  claim_id TEXT NOT NULL REFERENCES mm_claims(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES mm_events(id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, event_id)
);

CREATE TABLE IF NOT EXISTS mm_tombstones (
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_ref TEXT NOT NULL,
  reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mm_retrieval_log (
  id TEXT PRIMARY KEY, request_id TEXT, query_hash TEXT,
  returned_claim_ids_json TEXT, gate_decisions_json TEXT, scores_json TEXT, injected_at TEXT
);
