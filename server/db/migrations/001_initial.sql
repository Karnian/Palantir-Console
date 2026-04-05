-- Palantir Console v2: Agent Session Manager
-- Initial schema: projects, tasks, runs, run_events, agent_profiles, approvals, external_sessions

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  directory TEXT,
  description TEXT,
  color TEXT DEFAULT '#3b82f6',
  budget_usd REAL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'backlog' CHECK(status IN ('backlog','todo','in_progress','review','done')),
  priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  command TEXT NOT NULL,
  args_template TEXT,
  capabilities_json TEXT DEFAULT '{}',
  env_allowlist TEXT DEFAULT '[]',
  icon TEXT,
  color TEXT,
  max_concurrent INTEGER DEFAULT 3,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
  worktree_path TEXT,
  branch TEXT,
  tmux_session TEXT,
  status TEXT DEFAULT 'queued' CHECK(status IN ('queued','running','paused','needs_input','completed','failed','cancelled')),
  prompt TEXT,
  result_summary TEXT,
  exit_code INTEGER,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  error_message TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  response TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  responded_at TEXT
);

CREATE TABLE external_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_runs_task ON runs(task_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_run_events_run ON run_events(run_id);
CREATE INDEX idx_run_events_type ON run_events(event_type);
CREATE INDEX idx_external_sessions_run ON external_sessions(run_id);

-- Default agent profiles
INSERT INTO agent_profiles (id, name, type, command, args_template, icon, color) VALUES
  ('claude-code', 'Claude Code', 'claude-code', 'claude', '-p {prompt}', 'C', '#f97316'),
  ('codex', 'Codex CLI', 'codex', 'codex', 'exec {prompt}', 'X', '#8b5cf6'),
  ('opencode', 'OpenCode', 'opencode', 'opencode', '', 'O', '#3b82f6');

INSERT INTO schema_version (version) VALUES (1);
