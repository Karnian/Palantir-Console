-- W-P3: annotate dispatch audit rows with the server-derived operator instance.
-- Nullable for legacy rows and non-operator/top claims.

ALTER TABLE dispatch_audit_log ADD COLUMN operator_instance_id TEXT NULL;
