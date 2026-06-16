-- 029_memory_archive_reason.sql
-- ML PR5a: hard-cap admission control.
--   archive_reason — why a row was archived. cap eviction, manual archive, TTL
--     expiry (PR5d) and correction cleanup all share this one column (Codex:
--     prefer a general archive_reason over a decay-specific one).
--   idx_memory_cap — composite index for the cap/decay scan
--     (lowest-score evictable active row per project, and PR5d valid_to expiry).

ALTER TABLE memory_items ADD COLUMN archive_reason TEXT;

CREATE INDEX idx_memory_cap ON memory_items(project_id, status, valid_to);
