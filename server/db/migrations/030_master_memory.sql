-- Master Memory Layer (L2) P1a: cross-project, user-scoped GOVERNED TOP-K RETRIEVAL memory.
-- Mirrors L1 025_memory_layer.sql (memory_items + FTS5 + revision + injection ledger) but scoped to
-- the USER (not a project). DE-SCOPED per docs/specs/master-memory-brief.md §12: lean governed top-K
-- retrieval ONLY — NO distillation/graph/WikiGraph layer (the kill-test spike showed it does not earn
-- its keep for answer quality; the model resolves from retrieved context). External deps 0 (FTS5/bm25).
--
-- scope is NOT NULL ('user' = global across all projects; 'cross_project' = a fact spanning projects with
-- project_id as provenance). Dedup indexes key on (scope, content_hash) — scope being NOT NULL avoids the
-- SQLite "NULL distinct in UNIQUE index" dedup hole the spike hit with a nullable scope key.
-- Transport (P1a): masterMemoryService internal CRUD + remember + tests only. Manager injection wiring = P1b.

CREATE TABLE master_memory_items (
  rowid_pk      INTEGER PRIMARY KEY AUTOINCREMENT,   -- FTS5 external-content mapping
  id            TEXT NOT NULL UNIQUE,                -- uuid
  scope         TEXT NOT NULL DEFAULT 'user',        -- user | cross_project
  project_id    TEXT,                                -- provenance only (nullable; no FK so user-global has none)
  kind          TEXT NOT NULL,
  fact_key      TEXT,                                -- fact-only upsert key (env.* etc.)
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,                       -- dedup
  evidence_json TEXT NOT NULL DEFAULT '{}',
  origin        TEXT NOT NULL,                       -- human | deterministic | llm_candidate
  source_count  INTEGER NOT NULL DEFAULT 1,
  confidence    REAL NOT NULL DEFAULT 0.5,
  importance    INTEGER NOT NULL DEFAULT 5,
  pinned        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  valid_to      TEXT,
  archived_at   TEXT,
  archive_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT,
  CHECK (scope IN ('user','cross_project')),
  CHECK (kind IN ('constraint','preference','commitment','decision','fact','pattern')),
  CHECK (status IN ('active','superseded','archived','candidate')),
  CHECK (origin IN ('human','deterministic','llm_candidate')),
  CHECK (confidence BETWEEN 0 AND 1),
  CHECK (importance BETWEEN 1 AND 10),
  CHECK (json_valid(evidence_json)),
  CHECK ((kind='fact') = (fact_key IS NOT NULL))     -- fact ⇔ fact_key (both directions)
);
-- scope is NOT NULL so these partial-unique indexes dedup correctly (no NULL-distinct hole).
CREATE UNIQUE INDEX idx_master_memory_factkey ON master_memory_items(scope, fact_key)
  WHERE fact_key IS NOT NULL AND status='active';
CREATE UNIQUE INDEX idx_master_memory_content_hash ON master_memory_items(scope, content_hash)
  WHERE status='active';
CREATE INDEX idx_master_memory_scope_status ON master_memory_items(scope, status, importance DESC);

CREATE VIRTUAL TABLE master_memory_fts USING fts5(
  content, content='master_memory_items', content_rowid='rowid_pk', tokenize='unicode61'
);

-- FTS5 external-content sync triggers (standard ai/ad/au shape, mirrors 025).
CREATE TRIGGER master_memory_fts_ai AFTER INSERT ON master_memory_items BEGIN
  INSERT INTO master_memory_fts(rowid, content) VALUES (new.rowid_pk, new.content);
END;
CREATE TRIGGER master_memory_fts_ad AFTER DELETE ON master_memory_items BEGIN
  INSERT INTO master_memory_fts(master_memory_fts, rowid, content) VALUES('delete', old.rowid_pk, old.content);
END;
CREATE TRIGGER master_memory_fts_au AFTER UPDATE ON master_memory_items BEGIN
  INSERT INTO master_memory_fts(master_memory_fts, rowid, content) VALUES('delete', old.rowid_pk, old.content);
  INSERT INTO master_memory_fts(rowid, content) VALUES (new.rowid_pk, new.content);
END;
INSERT INTO master_memory_fts(master_memory_fts) VALUES('rebuild');

-- Monotonic revision counter, scope-keyed (mirrors project_memory_revision). VALUES(...,1) so the first
-- active change = 1 (a default-0 insert would make an injected_revision=0 session miss the first memory).
CREATE TABLE master_memory_revision (
  scope    TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);

-- Injection ledger (caching-safe once-per-session / per-revision injection into the Master manager).
CREATE TABLE master_memory_injection (
  master_run_id     TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,
  injected_revision INTEGER NOT NULL DEFAULT 0,
  injected_at       TEXT
);
