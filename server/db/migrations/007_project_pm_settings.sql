-- 007_project_pm_settings.sql
-- v3 Phase 1: Per-project PM configuration.
--
-- See docs/specs/manager-v3-multilayer.md §7 (PM Lazy 생성 모델).
--
-- pm_enabled: if 0, the router treats the project as PM-less. The Top
--   Manager handles all dispatch for this project directly. User can
--   toggle this; cleanup of existing pm_thread_id is handled by
--   pmCleanupService (Phase 3a).
-- preferred_pm_adapter: user preference ('claude' | 'codex' | NULL).
--   NULL falls back to global default (env PALANTIR_DEFAULT_PM_ADAPTER)
--   which itself falls back to 'codex' per spec.
--
-- Note: the *actual* adapter of the current PM thread is stored in
-- project_briefs.pm_adapter (migration 008). preferred_pm_adapter is
-- the user's stated preference; they can differ until the next reset.

ALTER TABLE projects ADD COLUMN pm_enabled INTEGER DEFAULT 1
  CHECK (pm_enabled IN (0, 1));

ALTER TABLE projects ADD COLUMN preferred_pm_adapter TEXT
  CHECK (preferred_pm_adapter IS NULL OR preferred_pm_adapter IN ('claude', 'codex'));
