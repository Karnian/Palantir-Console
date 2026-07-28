-- #465: automatic retries are unique per root and attempt number. Historical
-- duplicate rows are retained for auditability, but later duplicates are moved
-- above the root's existing maximum retry_count before the index is created.
-- Their parent/root links and run events remain intact, and the elevated count
-- prevents a historical duplicate from becoming eligible for B-lite again.
WITH ranked AS (
  SELECT
    rowid AS run_rowid,
    retry_root_run_id,
    retry_count,
    ROW_NUMBER() OVER (
      PARTITION BY retry_root_run_id, retry_count
      ORDER BY rowid ASC
    ) AS duplicate_rank
  FROM runs
  WHERE retry_root_run_id IS NOT NULL
),
duplicate_rows AS (
  SELECT
    run_rowid,
    retry_root_run_id,
    ROW_NUMBER() OVER (
      PARTITION BY retry_root_run_id
      ORDER BY retry_count ASC, run_rowid ASC
    ) AS extra_rank
  FROM ranked
  WHERE duplicate_rank > 1
),
root_maxima AS (
  SELECT retry_root_run_id, MAX(retry_count) AS max_retry_count
  FROM runs
  WHERE retry_root_run_id IS NOT NULL
  GROUP BY retry_root_run_id
)
UPDATE runs
SET retry_count = (
  SELECT root_maxima.max_retry_count + duplicate_rows.extra_rank
  FROM duplicate_rows
  JOIN root_maxima USING (retry_root_run_id)
  WHERE duplicate_rows.run_rowid = runs.rowid
)
WHERE rowid IN (SELECT run_rowid FROM duplicate_rows);

CREATE UNIQUE INDEX ux_runs_retry_root_count
  ON runs(retry_root_run_id, retry_count)
  WHERE retry_root_run_id IS NOT NULL;
