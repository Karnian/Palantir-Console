-- 044: profile owner in memory_items (the P-B2 relaxation that 042 deferred).
--
-- memory_items already has owner_type/owner_id (033); the ONLY blocker to a profile
-- row was `project_id NOT NULL`. Rebuild the table to make project_id NULLABLE and
-- add an owner coherence CHECK (workspace: project_id=owner_id; profile: project_id
-- NULL). This mirrors migration 042 (candidates/jobs), but memory_items adds two
-- hazards 042 didn't have (Codex design review):
--   (a) an FTS5 external-content index `memory_fts` keyed by rowid_pk + 3 triggers,
--   (b) an INBOUND FK `memory_candidates.promoted_to -> memory_items(id)
--       ON DELETE SET NULL`. The migration runner runs with foreign_keys=ON, so a
--       plain DROP TABLE would null every promoted_to pointer.
-- So: snapshot+restore promoted_to, copy rowid_pk verbatim (FTS mapping key),
-- restore the AUTOINCREMENT high-water, recreate triggers, and FTS 'rebuild'.
-- No caller creates profile rows yet (createCandidate/remember/promote stay
-- workspace-only until R4b) → this migration is additive/inert for workspace memory.

-- 0. Belt-and-suspenders: any legacy NULL-owner row is workspace memory (profile
--    ownership did not exist), so the copy into NOT NULL owner columns can't fail.
UPDATE memory_items SET owner_type = 'workspace', owner_id = project_id
  WHERE owner_type IS NULL OR owner_id IS NULL;

-- 1. Snapshot the inbound FK refs + the AUTOINCREMENT high-water before the drop.
CREATE TEMP TABLE _m044_promoted AS
  SELECT id, promoted_to FROM memory_candidates WHERE promoted_to IS NOT NULL;
CREATE TEMP TABLE _m044_seq AS
  SELECT seq FROM sqlite_sequence WHERE name = 'memory_items';

-- 2. New table shape: project_id NULLABLE, owner_* NOT NULL, coherence CHECK. All
--    current columns (025 + 028 archived_at + 029 pinned/archive_reason + 033 owner).
CREATE TABLE memory_items_new (
  rowid_pk      INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,   -- now nullable
  kind          TEXT NOT NULL,
  fact_key      TEXT,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  origin        TEXT NOT NULL,
  source_count  INTEGER NOT NULL DEFAULT 1,
  confidence    REAL NOT NULL DEFAULT 0.5,
  importance    INTEGER NOT NULL DEFAULT 5,
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  valid_to      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT,
  archived_at   TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archive_reason TEXT,
  owner_type    TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  CHECK (kind IN ('convention','pitfall','heuristic','constraint','fact')),
  CHECK (status IN ('active','superseded','archived')),
  CHECK (origin IN ('human','rule:R1a','rule:R1b','rule:R3','rule:R6','batch_llm')),
  CHECK (confidence BETWEEN 0 AND 1),
  CHECK (importance BETWEEN 1 AND 10),
  CHECK (json_valid(evidence_json)),
  CHECK ((kind='fact') = (fact_key IS NOT NULL)),
  CHECK (
    (owner_type = 'workspace' AND project_id IS NOT NULL AND owner_id = project_id)
    OR
    (owner_type = 'profile'   AND project_id IS NULL     AND owner_id IS NOT NULL AND length(owner_id) > 0)
  )
);

-- 3. Copy verbatim, INCLUDING rowid_pk (external-content FTS mapping key).
INSERT INTO memory_items_new
  (rowid_pk, id, project_id, kind, fact_key, content, content_hash, evidence_json,
   origin, source_count, confidence, importance, status, superseded_by, valid_to,
   created_at, updated_at, reviewed_at, archived_at, pinned, archive_reason,
   owner_type, owner_id)
SELECT
  rowid_pk, id, project_id, kind, fact_key, content, content_hash, evidence_json,
  origin, source_count, confidence, importance, status, superseded_by, valid_to,
  created_at, updated_at, reviewed_at, archived_at, pinned, archive_reason,
  owner_type, owner_id
FROM memory_items;

-- 4. Drop old (triggers gone; promoted_to nulled by the FK — restored below), rename.
DROP TABLE memory_items;
ALTER TABLE memory_items_new RENAME TO memory_items;

-- 5. Restore the AUTOINCREMENT high-water (never reuse a deleted rowid_pk). Robust to
--    however RENAME touched sqlite_sequence: set 'memory_items' to max(old hw, current
--    max rowid_pk); clear any stale 'memory_items_new' entry.
DELETE FROM sqlite_sequence WHERE name IN ('memory_items', 'memory_items_new');
INSERT INTO sqlite_sequence(name, seq)
  SELECT 'memory_items', MAX(hw) FROM (
    SELECT COALESCE((SELECT seq FROM _m044_seq), 0) AS hw
    UNION ALL
    SELECT COALESCE(MAX(rowid_pk), 0) AS hw FROM memory_items
  );

-- 6. Restore inbound promoted_to refs that the DROP nulled.
UPDATE memory_candidates
   SET promoted_to = (SELECT promoted_to FROM _m044_promoted s WHERE s.id = memory_candidates.id)
 WHERE id IN (SELECT id FROM _m044_promoted);

-- 7. Recreate indexes (current post-039 set).
CREATE INDEX idx_memory_project_status ON memory_items(project_id, status, importance DESC);
CREATE INDEX idx_memory_cap ON memory_items(project_id, status, valid_to);
CREATE INDEX idx_memory_xproject_scan ON memory_items(content_hash, project_id) WHERE status='active' AND kind!='fact';
CREATE INDEX idx_memory_items_owner ON memory_items(owner_type, owner_id);
CREATE UNIQUE INDEX idx_memory_owner_content_hash ON memory_items(owner_type, owner_id, content_hash) WHERE status = 'active';
CREATE UNIQUE INDEX idx_memory_owner_factkey ON memory_items(owner_type, owner_id, fact_key) WHERE fact_key IS NOT NULL AND status = 'active';

-- 8. Recreate FTS triggers (external-content memory_fts).
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

-- 9. Resync FTS index (rowid_pk preserved verbatim → 'rebuild' re-reads all rows).
INSERT INTO memory_fts(memory_fts) VALUES('rebuild');

-- 10. Drop snapshots.
DROP TABLE _m044_promoted;
DROP TABLE _m044_seq;
