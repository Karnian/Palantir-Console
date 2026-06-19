-- migration 038: composition ledger (A2-2)
--
-- 3-part ledger for persisting composer output (memoryComposer.compose()).
-- Separate from the legacy pm_memory_injection / master_memory_injection ledgers
-- (migrations 025/030); those remain live until A2-3 parity retire.
--
-- Retention policy:
--   Per (run_id, slot_kind, provenance_key): keep only the latest accepted
--   composition; older accepted records are pruned by compositionLedger.cleanup().
--   Stale pending records (> 1 day, never accepted) are also pruned.
--   FK CASCADE ensures owner_state and item_edges rows are deleted with the event.

-- ── Table 1: composition event header ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory_composition_events (
  id                  TEXT    PRIMARY KEY,
  run_id              TEXT    NOT NULL,
  conversation_id     TEXT,
  task_id             TEXT,
  slot_kind           TEXT    NOT NULL  CHECK(slot_kind IN ('top','pm')),
  provenance_key      TEXT    NOT NULL,
  mode                TEXT,
  composer_version    TEXT    NOT NULL,
  policy_version      TEXT    NOT NULL,
  prompt_payload_hash TEXT,
  retrieval_query_hash TEXT,
  token_budget        INTEGER,
  owner_vector_hash   TEXT,
  selected_set_hash   TEXT,
  fingerprint         TEXT    NOT NULL,
  block_hash          TEXT,
  status              TEXT    NOT NULL  DEFAULT 'pending'
                              CHECK(status IN ('pending','accepted')),
  created_at          TEXT    NOT NULL  DEFAULT (datetime('now')),
  accepted_at         TEXT
);

-- Gate index: fast lookup for shouldCompose and cleanup
-- (run_id, slot_kind, provenance_key, status)
CREATE INDEX IF NOT EXISTS idx_composition_events_gate
  ON memory_composition_events(run_id, slot_kind, provenance_key, status);

-- ── Table 2: per-owner snapshot at compose time ──────────────────────────────
-- Invariant: one row per (composition_id, owner_type, owner_id).
CREATE TABLE IF NOT EXISTS memory_composition_owner_state (
  composition_id    TEXT    NOT NULL
                    REFERENCES memory_composition_events(id) ON DELETE CASCADE,
  owner_type        TEXT    NOT NULL,
  owner_id          TEXT    NOT NULL,
  provenance_key    TEXT,
  revision          INTEGER,
  selected_set_hash TEXT,
  suppressed_set_hash TEXT,
  selected_count    INTEGER,
  suppressed_count  INTEGER,
  budget_limit      INTEGER,
  budget_used       INTEGER,
  PRIMARY KEY (composition_id, owner_type, owner_id)
);

-- ── Table 3: per-item decision edges ────────────────────────────────────────
-- Invariant: one decision per (composition_id, item_table, item_id).
-- item_id may be NULL for fact items that have no stable id (e.g., row with only fact_key).
-- Because NULL != NULL in SQL, PK on (composition_id, item_table, item_id) does NOT
-- enforce uniqueness when item_id IS NULL. The service uses INSERT OR IGNORE and a
-- surrogate rowid for null-id edges; the PK acts as a dedup guard for non-null ids.
CREATE TABLE IF NOT EXISTS memory_composition_item_edges (
  composition_id    TEXT    NOT NULL
                    REFERENCES memory_composition_events(id) ON DELETE CASCADE,
  item_table        TEXT    NOT NULL
                    CHECK(item_table IN ('memory_items','master_memory_items')),
  item_id           TEXT,
  item_revision     INTEGER,
  content_hash      TEXT,
  fact_key          TEXT,
  kind              TEXT,
  source_owner_type TEXT,
  source_owner_id   TEXT,
  provenance_key    TEXT,
  decision          TEXT    NOT NULL
                    CHECK(decision IN ('included','suppressed','truncated','deduped','conflicted','budget_exceeded')),
  reason            TEXT,
  rank              INTEGER,
  token_cost        INTEGER
  -- Note: no PK here; rowid is the implicit PK.
  -- The item_id NULL problem (NULL != NULL) makes a composite PK unsafe.
  -- Dedup is enforced by the service layer (INSERT OR IGNORE on non-null item_id
  -- via a partial unique index below).
);

-- Partial unique index: one decision per (composition_id, item_table, item_id)
-- for non-null item_ids. NULL item_ids (fact-only edges) bypass this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_composition_item_edges_dedup
  ON memory_composition_item_edges(composition_id, item_table, item_id)
  WHERE item_id IS NOT NULL;
