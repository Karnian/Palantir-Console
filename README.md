# Palantir Console

[한국어](README.ko.md)

Central control hub for managing AI coding agents (Claude Code, Codex, OpenCode).

Monitor multiple agents across multiple projects — see who's doing what, where they're stuck, and how much they cost, all from one screen.

## Quick Start

### Local

```bash
npm install
npm start
open http://localhost:4177
```

### Docker

```bash
docker compose up --build
open http://localhost:4177
```

### Auto Setup (nvm/volta/fnm)

```bash
bash setup.sh   # auto-detects and installs Node 20+, runs npm install
npm start
```

### Docker with Auth

```bash
# .env
PALANTIR_TOKEN=my-secret-token
ANTHROPIC_API_KEY=sk-ant-...    # optional: for Manager Session

docker compose up --build
# → http://localhost:4177?token=my-secret-token
```

By default, the server binds to `localhost` with no authentication. To enable remote access:

```bash
PALANTIR_TOKEN=my-secret-token npm start
# → binds to 0.0.0.0:4177, all APIs require Bearer token
```

## Core Concepts

```
Project  →  Task  →  Run  →  Agent
 (group)   (work)  (exec)  (Claude/Codex/OpenCode)
```

| Concept | Description |
|---------|-------------|
| **Project** | Logical grouping of tasks. e.g. "Backend API", "Frontend Refactor" |
| **Task** | A unit of work. Managed on a kanban board. Status: Backlog → Todo → In Progress → Review → Done |
| **Run** | An agent execution against a Task. Multiple Runs per Task allowed |
| **Agent Profile** | Agent configuration (Claude Code, Codex CLI, OpenCode, custom) |

## Views

### 1. Dashboard (◉)
**Control hub.** Shows only what needs attention right now — active agents, needs-input, failures.

### 2. Task Board (⊞)
**Kanban board.** Drag tasks across 5 columns. Drag to In Progress → agent execution modal opens.

### 3. Projects (▣)
Project list. Tasks are grouped by project.

### 4. Manager (✦)
**Central orchestrator.** Runs Claude Code CLI as a Manager agent with multi-turn chat.

- 40/60 split layout: chat (left) + worker session grid (right)
- Manager queries the Palantir Console REST API via curl to report real agent/task status
- Uses Claude Code CLI `--print --output-format stream-json --input-format stream-json` protocol

### 5. Agents (⚙)
Agent profile management. Default profiles: Claude Code, Codex CLI, OpenCode.

## API

REST API for external control. When auth is enabled, include `Authorization: Bearer <token>` header.

### Projects
```
GET    /api/projects           — list
POST   /api/projects           — create { name, directory?, color? }
GET    /api/projects/:id       — get
PATCH  /api/projects/:id       — update
DELETE /api/projects/:id       — delete
GET    /api/projects/:id/tasks — list tasks
```

### Tasks
```
GET    /api/tasks              — list (?project_id=, ?status=)
POST   /api/tasks              — create { title, project_id?, priority?, description? }
GET    /api/tasks/:id          — get
PATCH  /api/tasks/:id          — update
PATCH  /api/tasks/:id/status   — change status { status }
DELETE /api/tasks/:id          — delete
PATCH  /api/tasks/reorder      — reorder { orderedIds: [] }
POST   /api/tasks/:id/execute  — run agent { agent_profile_id, prompt? }
```

### Runs
```
GET    /api/runs               — list (?task_id=, ?status=)
GET    /api/runs/:id           — get
GET    /api/runs/:id/events    — event list
GET    /api/runs/:id/output    — live output (tmux)
POST   /api/runs/:id/input     — send input { text }
POST   /api/runs/:id/cancel    — cancel
DELETE /api/runs/:id           — delete
```

### Agents
```
GET    /api/agents             — list profiles
POST   /api/agents             — create { name, type, command, args_template?, max_concurrent? }
GET    /api/agents/:id         — get (+ runningCount)
PATCH  /api/agents/:id         — update
DELETE /api/agents/:id         — delete
```

### Manager Session
```
POST   /api/manager/start      — start manager { prompt?, cwd?, model? }
POST   /api/manager/message    — send message { text }
GET    /api/manager/status     — status (active, run, usage, claudeSessionId)
GET    /api/manager/events     — event list
GET    /api/manager/output     — output text
POST   /api/manager/stop       — stop manager
```

### SSE / Health
```
GET    /api/events             — SSE stream (task:*, run:*, manager:* events)
GET    /api/health             — health check
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4177` | Server port |
| `PALANTIR_TOKEN` | (none) | Enables Bearer auth + remote access |
| `PALANTIR_ALLOWED_COMMANDS` | (none) | Additional allowed CLI commands (comma-separated) |
| `OPENCODE_STORAGE` | `~/.local/share/opencode/storage` | OpenCode session storage path |
| `OPENCODE_BIN` | `opencode` | OpenCode binary path |
| `OPENCODE_FS_ROOT` | `$HOME` | Directory picker root path |

## Tech Stack

- **Backend**: Express.js 5, SQLite (WAL mode, better-sqlite3)
- **Frontend**: Preact + HTM (UMD, no build step)
- **Worker agents**: tmux session + git worktree isolation
- **Manager agent**: Claude Code CLI stream-json protocol (NDJSON)
- **Real-time**: SSE (Server-Sent Events)
- **Tests**: Node.js built-in test runner + supertest

## Development

```bash
npm test     # run tests
npm run dev  # dev server
```

Data is stored in `palantir.db` (SQLite). Auto-migrated on server start.

## License

ISC
