-- Phase 10B: Worker Preset & Plugin Injection (spec §6.1)
--
-- Worker Preset 은 "워커 spawn 시 어떤 도구/플러그인/프롬프트를 주입받을지"
-- 정의하는 adapter-중립 스키마. 기존 Skill Pack 과 직교 (비파괴).

CREATE TABLE IF NOT EXISTS worker_presets (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  description        TEXT,
  isolated           INTEGER NOT NULL DEFAULT 0,
  plugin_refs        TEXT NOT NULL DEFAULT '[]',        -- JSON array of plugin dir names under server/plugins/
  mcp_server_ids     TEXT NOT NULL DEFAULT '[]',        -- JSON array of mcp_server_templates.id
  base_system_prompt TEXT,                              -- optional, ≤16KB enforced in service
  setting_sources    TEXT DEFAULT '',                   -- for --setting-sources flag (Tier 2)
  min_claude_version TEXT,                              -- semver string e.g. "2.0.0"
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Snapshot table stores FROZEN preset at spawn time. No FK to worker_presets
-- so that deleting a preset does NOT destroy past run forensic data.
CREATE TABLE IF NOT EXISTS run_preset_snapshots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id               TEXT NOT NULL,
  preset_id            TEXT NOT NULL,                   -- historical reference; no FK
  preset_snapshot_hash TEXT NOT NULL,
  snapshot_json        TEXT NOT NULL,
  file_hashes          TEXT NOT NULL,                   -- JSON: [{path, sha256}] with <pluginRef>/ namespace
  applied_at           TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_preset_snapshots_run_id
  ON run_preset_snapshots(run_id);

-- Extend runs: preset_id NULL = legacy path (no preset applied)
ALTER TABLE runs ADD COLUMN preset_id TEXT;
ALTER TABLE runs ADD COLUMN preset_snapshot_hash TEXT;

-- Task can reference a preferred preset. SQLite ALTER TABLE cannot add
-- enforced FK — app-level cascade in presetService.deletePreset transaction
-- (UPDATE tasks SET preferred_preset_id=NULL WHERE preferred_preset_id=?).
ALTER TABLE tasks ADD COLUMN preferred_preset_id TEXT;
