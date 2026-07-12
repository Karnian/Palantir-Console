-- G4b §5j: goal 산출물 전달 레코드. On task→done (gate2-accepted), the accepted
-- attempt's surviving branch is promoted to a stable `palantir/goal/<taskId>`
-- ref (code mode) or the deliverable bundle is recorded (deliverable mode). The
-- column doubles as the delivery CLAIM: a DB-CAS on json_extract(state) captures
-- the accepted run identity and serializes concurrent delivery attempts (the
-- task:updated trigger + the manual re-deliver route) — codex plan-review B2.
--
-- Shape: { mode:'branch'|'deliverable', run_id, state:'delivering'|'delivered'|'failed',
--          reason?, branch?, base?, stat?, files?, started_at?, delivered_at? }.
ALTER TABLE tasks ADD COLUMN goal_delivery_json TEXT;
