-- 027_memory_jobs.sql
-- ML PR3a: durable batch-distill job queue (candidate -> active promotion).
--
-- The deterministic rules (R1b/R3) stage raw candidates in memory_candidates
-- (migration 026). A periodic, low-cost batch LLM distiller generalizes a
-- project's pending candidates into active memory_items. That distill pass is
-- expensive and must be:
--   - durable      : survive process restart mid-run (no lost / double work)
--   - single-flight: one distill in flight per (kind, project) at a time
--   - recoverable  : a crashed worker's lease must be requeued, not stuck
--
-- This table is the CAS lease the distiller claims. Spec: §4 (memory_jobs) +
-- §7 ("job 유실" row). claim/requeue/release invariants live in memoryService;
-- the SQL contract they rely on is documented here.
--
-- CAS claim (memoryService.claimDistillJob): a single UPDATE flips exactly one
-- pending+due row to running, stamping a fresh claim_token + locked_at and
-- bumping attempts. Acquisition is confirmed by changes()===1 — two racing
-- claimers can never both win the same row.
--   UPDATE memory_jobs
--      SET status='running', claim_token=?, locked_at=now, attempts=attempts+1,
--          updated_at=now
--    WHERE id = (SELECT id FROM memory_jobs
--                 WHERE status='pending' AND (run_after IS NULL OR run_after<=now)
--                 ORDER BY created_at, id LIMIT 1)
--      AND status='pending';
--
-- stale requeue (recovery): a running row whose locked_at is older than the
-- lease TTL is assumed dead -> back to pending, claim_token cleared. A row that
-- has already burned through max attempts is parked at failed instead.
--
-- release: token-guarded so a worker whose lease was stolen (stale-requeued and
-- re-claimed by someone else) can never overwrite the new owner's outcome:
--   UPDATE ... WHERE id=? AND claim_token=? AND status='running'.
--
-- The partial UNIQUE index enforces single-flight: at most one pending|running
-- row per (kind, project_id). done/failed rows are terminal history and do not
-- count, so a fresh distill can always be enqueued after the prior one settles.

CREATE TABLE memory_jobs (
  id          TEXT PRIMARY KEY,                    -- uuid
  kind        TEXT NOT NULL,                       -- 'distill' (only kind for now)
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending|running|done|failed
  claim_token TEXT,                                -- set on claim, cleared on requeue/terminal
  locked_at   TEXT,                                -- when the current lease was taken
  run_after   TEXT,                                -- earliest claim time (backoff), NULL = now
  attempts    INTEGER NOT NULL DEFAULT 0,          -- claim count; >= MAX -> failed
  last_error  TEXT,                                -- last transient failure detail
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending','running','done','failed'))
);

-- single-flight per (kind, project): only one in-progress (pending|running) job.
-- Terminal rows (done|failed) are excluded so re-enqueue after settle works.
CREATE UNIQUE INDEX idx_memory_jobs_active
  ON memory_jobs(kind, project_id) WHERE status IN ('pending','running');

-- claim scan: pending + due, oldest first.
CREATE INDEX idx_memory_jobs_claimable
  ON memory_jobs(status, run_after, created_at);
