-- 066_b_adm_episodic_node_fact_cleanup.sql
-- B-adm follow-up (integration-review BLOCKER, prospective-cleanup half).
--
-- Before B-adm, createR6FactCapture upserted env.node_resolution on EVERY harvest,
-- including node-specific fallback/server/executor content
-- ("... falls back to the server node", "No project-specific Node declaration ...").
-- B-adm now promotes ONLY the stable, node-independent project requirement
-- (content normalized to "Project requires Node major N"). This one-time cleanup
-- archives the accumulated episodic rows so they stop being retrieved/injected.
--
-- Scope: active env.node_resolution rows whose content is NOT the stable
-- "Project requires Node major ..." form. Legitimate project-source facts are
-- preserved. Archive (not delete) — reversible via the memory correction UI, and
-- consistent with decay/eviction which also archive rather than hard-delete.
--
-- No revision bump is needed: migrations run at boot before any operator run, so
-- no accepted composition references these rows yet. Human/pinned facts never
-- carry this fact_key, so none are protected-set casualties.

UPDATE memory_items
   SET status = 'archived',
       archived_at = datetime('now'),
       archive_reason = 'b_adm_episodic_cleanup',
       updated_at = datetime('now')
 WHERE fact_key = 'env.node_resolution'
   AND status = 'active'
   AND content NOT LIKE 'Project requires Node major%';
