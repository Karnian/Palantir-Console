-- OS-4: one durable active turn per Operator, regardless of how many
-- schedules are registered on that Operator.
--
-- Reconcile any rows created before this invariant existed. A turn that may
-- already have crossed the adapter boundary is uncertain; rows that never
-- crossed it can be safely cancelled.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY operator_instance_id
           ORDER BY CASE status
             WHEN 'running' THEN 0
             WHEN 'delivering' THEN 1
             WHEN 'claimed' THEN 2
             ELSE 3
           END,
           created_at ASC,
           id ASC
         ) AS active_rank
    FROM operator_invocations
   WHERE status IN ('pending','claimed','delivering','running')
)
UPDATE operator_invocations
   SET status=CASE
         WHEN status IN ('delivering','running') THEN 'uncertain'
         ELSE 'cancelled'
       END,
       claim_token=NULL,
       locked_at=NULL,
       waiting_reason='operator_active_reconciled',
       last_error=COALESCE(last_error, 'reconciled by operator single-flight migration'),
       completed_at=datetime('now'),
       updated_at=datetime('now')
 WHERE id IN (SELECT id FROM ranked WHERE active_rank > 1);

CREATE UNIQUE INDEX idx_operator_invocations_active_operator
  ON operator_invocations(operator_instance_id)
  WHERE status IN ('pending','claimed','delivering','running');
