-- Memory Layer (ML) PR1: L1 project memory index + FTS5 retrieval + revision
-- counter + injection ledger. External deps 0 (better-sqlite3 FTS5/bm25 only).
--
-- Spec: docs/specs/memory-layer-brief.md §4 (PR1 scope: items + fts + triggers
-- + project_memory_revision + pm_memory_injection ONLY — memory_candidates /
-- memory_jobs are PR2/PR3 and intentionally NOT created here, §10).
--
-- memory_items is the approved memory index. evidence_json is an L1 snapshot
-- (L0 = run_events/harvest/dispatch_audit_log can CASCADE-delete; the snapshot
-- survives). content_hash partial-UNIQUE (status='active') blocks concurrent
-- active dup writes; the service catches the constraint and merges source_count.
--   transport of writes (PR1): memoryService internal CRUD + seed/tests only.
--   fact ⇔ fact_key is enforced both at the app layer and by the DB CHECK below.

CREATE TABLE memory_items (
  rowid_pk      INTEGER PRIMARY KEY AUTOINCREMENT,   -- FTS5 external-content 매핑
  id            TEXT NOT NULL UNIQUE,                -- uuid
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  fact_key      TEXT,                                -- fact 전용 upsert 키
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,                       -- dedup 1차
  evidence_json TEXT NOT NULL DEFAULT '{}',          -- 서비스가 {schema_version,redaction_version,run_ids[],task_id,diff_stat,test,excerpt,hashes[]} 보장(아래 CHECK는 json_valid만)
  origin        TEXT NOT NULL,                       -- human|rule:R1b|rule:R3|rule:R6|batch_llm
  source_count  INTEGER NOT NULL DEFAULT 1,
  confidence    REAL NOT NULL DEFAULT 0.5,
  importance    INTEGER NOT NULL DEFAULT 5,          -- create 1회 IMMUTABLE
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  valid_to      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT,
  CHECK (kind IN ('convention','pitfall','heuristic','constraint','fact')),
  CHECK (status IN ('active','superseded','archived')),
  CHECK (origin IN ('human','rule:R1a','rule:R1b','rule:R3','rule:R6','batch_llm')),
  CHECK (confidence BETWEEN 0 AND 1),
  CHECK (importance BETWEEN 1 AND 10),
  CHECK (json_valid(evidence_json)),
  CHECK ((kind='fact') = (fact_key IS NOT NULL))     -- r3: fact ⇔ fact_key 존재 (양방향 강제)
);
CREATE UNIQUE INDEX idx_memory_factkey ON memory_items(project_id, fact_key)
  WHERE fact_key IS NOT NULL AND status='active';
CREATE UNIQUE INDEX idx_memory_content_hash ON memory_items(project_id, content_hash)
  WHERE status='active';                             -- r3: 동시 write active 중복 차단
CREATE INDEX idx_memory_project_status ON memory_items(project_id, status, importance DESC);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  content, content='memory_items', content_rowid='rowid_pk', tokenize='unicode61'
);

-- FTS5 external-content sync triggers (standard ai/ad/au shape). The 'delete'
-- command rows keep the FTS index consistent with memory_items.
CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid_pk, new.content);
END;
CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid_pk, old.content);
END;
CREATE TRIGGER memory_fts_au AFTER UPDATE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.rowid_pk, old.content);
  INSERT INTO memory_fts(rowid, content) VALUES (new.rowid_pk, new.content);
END;
INSERT INTO memory_fts(memory_fts) VALUES('rebuild');

-- PR1: 단조 revision 카운터 (r3 — max(updated_at) 해시 금지). memoryService가
-- active 변경(insert active / status↔active / content update) 트랜잭션 내에서
-- 단일 경로로 bump한다:
--   INSERT INTO project_memory_revision(project_id,revision) VALUES (?,1)
--     ON CONFLICT(project_id) DO UPDATE SET revision=revision+1;
-- r4: VALUES(...,1)로 첫 변경=1 보장 (default 0 insert면 injected_revision=0
-- 세션이 첫 메모리를 미감지하는 버그).
CREATE TABLE project_memory_revision (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL DEFAULT 0
);

-- PR1: 주입 ledger (resume 중복/매턴 재주입 방지). 세션당 1회 또는 revision
-- 변경 시에만 user-payload 주입.
CREATE TABLE pm_memory_injection (
  pm_run_id         TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- r3: FK
  injected_revision INTEGER NOT NULL DEFAULT 0,
  injected_at       TEXT
);
