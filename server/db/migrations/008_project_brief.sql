-- 008_project_brief.sql
-- v3 Phase 1: Per-project brief for context encapsulation.
--
-- See docs/specs/manager-v3-multilayer.md §7 (PM Lazy 생성 모델) and §8.3.
--
-- conventions: project-specific rules (CLAUDE.md / AGENTS.md 요약 또는
--   사용자가 직접 입력). Injected as part of the first user message for
--   Top Manager and (in Phase 3a) PM sessions. NOT baked into system
--   prompt — keeps cached_input_tokens stable for Codex.
-- known_pitfalls: operator-level notes ("don't touch file X without
--   checking Y"). Free text.
-- pm_thread_id: NULL until the first PM-targeting message in this project
--   spawns a Codex thread. Then set to the thread_id captured from
--   thread.started event. See §7.1 for lifecycle.
--
-- CRITICAL NAMING: pm_thread_id is NOT the same as runs.manager_thread_id
-- (added in 005). The latter is per-manager-run (transient), the former
-- is per-project (persistent). pmCleanupService (Phase 3a) owns the
-- lifecycle of pm_thread_id.
--
-- pm_adapter: actual adapter of the current pm_thread_id ('claude'|'codex').
-- May differ from projects.preferred_pm_adapter until next reset.

CREATE TABLE project_briefs (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  conventions TEXT,
  known_pitfalls TEXT,
  pm_thread_id TEXT,
  pm_adapter TEXT CHECK (pm_adapter IS NULL OR pm_adapter IN ('claude', 'codex')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_project_briefs_pm_thread
  ON project_briefs(pm_thread_id) WHERE pm_thread_id IS NOT NULL;
