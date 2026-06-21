-- 041_owner_state_provenance_key.sql
-- A2-4b / D2: make composition owner snapshots provenance-aware.
--
-- Top can now compose two entries with the same owner tuple
-- (owner_type='user', owner_id='user') but different provenance. SQLite table
-- rebuild is required because the PRIMARY KEY changes. Keep explicit DDL so
-- constraints, defaults, and FK behavior are preserved.

CREATE TABLE IF NOT EXISTS memory_composition_owner_state_new (
  composition_id      TEXT    NOT NULL
                      REFERENCES memory_composition_events(id) ON DELETE CASCADE,
  owner_type          TEXT    NOT NULL,
  owner_id            TEXT    NOT NULL,
  provenance_key      TEXT    NOT NULL DEFAULT '',
  revision            INTEGER,
  selected_set_hash   TEXT,
  suppressed_set_hash TEXT,
  selected_count      INTEGER,
  suppressed_count    INTEGER,
  budget_limit        INTEGER,
  budget_used         INTEGER,
  PRIMARY KEY (composition_id, owner_type, owner_id, provenance_key)
);

INSERT INTO memory_composition_owner_state_new
  (composition_id, owner_type, owner_id, provenance_key, revision,
   selected_set_hash, suppressed_set_hash, selected_count, suppressed_count,
   budget_limit, budget_used)
SELECT
  composition_id, owner_type, owner_id, COALESCE(provenance_key, '') AS provenance_key,
  revision, selected_set_hash, suppressed_set_hash, selected_count, suppressed_count,
  budget_limit, budget_used
FROM memory_composition_owner_state;

DROP TABLE memory_composition_owner_state;
ALTER TABLE memory_composition_owner_state_new RENAME TO memory_composition_owner_state;
