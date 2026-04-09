# Palantir Console

[한국어](README.ko.md)

Central control hub for managing AI coding agents (Claude Code, Codex, OpenCode).

Monitor multiple agents across multiple projects — see who's doing what, where they're stuck, and how much they cost, all from one screen.

> **v3 Manager redesign shipped.** The Manager is now a project-scoped dispatcher with a Top session, optional per-project PM sessions (lazy-spawned Codex), conversation identity for every node (Top / PM / Worker), deterministic routing, annotate-only drift reconciliation, and semantic lifecycle events. See `docs/specs/manager-v3-multilayer.md` for the spec and `docs/test-scenarios.md` for the user-facing scenarios.

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
ANTHROPIC_API_KEY=sk-ant-...    # optional: for a Claude-backed Manager
CODEX_API_KEY=...               # optional: for a Codex-backed Manager or PM

docker compose up --build
# → http://localhost:4177 (send Authorization: Bearer my-secret-token)
```

### Binding policy (changed in PR1)

By default the server now binds to **`127.0.0.1`** (loopback only, no auth).
Setting `PALANTIR_TOKEN` automatically promotes the bind to `0.0.0.0` so remote
clients can reach an authenticated API. If you want to listen on all
interfaces without auth (discouraged), pass `HOST=0.0.0.0` explicitly — the
server will log a `[security] WARNING` in that case.

| Setup | `HOST` | `PALANTIR_TOKEN` | Bind |
| --- | --- | --- | --- |
| Dev default | unset | unset | `127.0.0.1` |
| Remote + auth | unset | set | `0.0.0.0` |
| Legacy ("always 0.0.0.0") | `0.0.0.0` | unset | `0.0.0.0` (⚠️ open, logged) |
| Custom interface | `192.168.x.y` | either | as specified |

```bash
PALANTIR_TOKEN=my-secret-token npm start
# → all APIs require Authorization: Bearer my-secret-token (CLI) OR
#   the palantir_token cookie set by POST /api/auth/login (browser).
# → binds to 0.0.0.0
```

**Browser clients** use an HttpOnly cookie under the hood. Visit
`http://host:4177/login.html`, enter your token in the POST form, and
you'll be redirected to the console with a `palantir_token` cookie set.
The token never appears in a URL — earlier PR1 drafts accepted `?token=`
as a one-shot bootstrap, but that was removed after Codex review because
the first document request would already leak the token into reverse
proxy access logs. This is required because `EventSource` cannot send
custom headers, so the `/api/events` SSE stream would otherwise be
unreachable with auth enabled.

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
| **Manager layer** | `top` (singleton dispatcher) or `pm:<projectId>` (project-scoped PM, lazy-spawned) |
| **Conversation** | 1st-class identity for any chat surface: `top`, `pm:<projectId>`, or `worker:<runId>` |

## Views

### 1. Dashboard (◉)

**Control hub.** Shows only what needs attention right now — active agents, needs-input, failures, and the new **Drift ⚠** badge.

- **Drift badge** — summary of PM dispatch-audit incoherences (annotate-only; hidden when zero). Click to open the Drift Drawer with per-row PM claim vs DB truth diffs, dismiss/restore, and kind color bar.

### 2. Task Board (⊞)

**Kanban board.** Drag tasks across 5 columns. Drag to In Progress → agent execution modal opens.

### 3. Projects (▣)

Project list. Tasks are grouped by project. Each project exposes:

- `pm_enabled` — whether the project can lazy-spawn a PM
- `preferred_pm_adapter` — Codex or Claude preference (Claude resume falls back to Codex until Phase 3b)
- `project_brief` — conventions + known pitfalls injected into PM system prompt

### 4. Manager (✦)

**Central orchestrator.** Runs a manager agent (Claude Code or Codex CLI) with multi-turn chat and v3 multi-layer routing.

- 40/60 split layout: chat (left) + worker session grid (right)
- **Conversation target dropdown** (v3 Phase 6) — lets the user send messages to the Top session or any `pm:<projectId>` slot. PM rows are marked `active` when a PM is currently spawned. `@<projectName>` in a message is rewritten to the matching PM via `/api/router/resolve`.
- **Reset PM** button — disposes the Codex thread and clears the persisted `pm_thread_id`; the next message starts a fresh thread.
- **Per-PM drift indicator** (v3 Phase 7) — `⚠ N` button next to Reset PM when the selected PM has pending incoherent audit rows.
- Manager queries the Palantir Console REST API via curl to report real agent/task status.
- Supports Claude Code CLI (`--print --output-format stream-json --input-format stream-json` protocol) and Codex CLI (`codex exec --json` + resume via `codex exec resume <thread_id>`).

### 5. Agents (⚙)

Agent profile management. Default profiles: Claude Code, Codex CLI, OpenCode. Agent profiles can gate dispatch via `capabilities_json` and `max_concurrent`.

## API

REST API for external control. When auth is enabled, include `Authorization: Bearer <token>` header.

### Projects
```
GET    /api/projects           — list
POST   /api/projects           — create { name, directory?, color?, pm_enabled?, preferred_pm_adapter? }
GET    /api/projects/:id       — get
PATCH  /api/projects/:id       — update
DELETE /api/projects/:id       — delete (fail-closed: aborts if pmCleanupService cannot dispose a live PM)
GET    /api/projects/:id/tasks — list tasks
GET    /api/projects/:id/brief — read project brief (conventions + known pitfalls)
PATCH  /api/projects/:id/brief — partial update { conventions?, known_pitfalls? }
```

### Tasks
```
GET    /api/tasks              — list (?project_id=, ?status=)
POST   /api/tasks              — create { title, project_id?, priority?, description?, task_kind?, requires_capabilities?, acceptance_criteria? }
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
POST   /api/runs/:id/input     — send input { text } (delegates to conversationService, same parent-notice router)
POST   /api/runs/:id/cancel    — cancel
DELETE /api/runs/:id           — delete
```

### Agents
```
GET    /api/agents             — list profiles
POST   /api/agents             — create { name, type, command, args_template?, max_concurrent?, capabilities_json?, env_allowlist? }
GET    /api/agents/:id         — get (+ runningCount)
GET    /api/agents/:id/usage   — provider-backed usage snapshot for this profile
PATCH  /api/agents/:id         — update
DELETE /api/agents/:id         — delete
```

### Manager Session (Top + PM)
```
POST   /api/manager/start              — start the Top manager { prompt?, cwd?, model?, agent_profile_id? }
POST   /api/manager/message            — send to Top (delegates to conversationService.sendMessage('top', ...))
GET    /api/manager/status             — { active, run, usage, claudeSessionId, top: {...}, pms: [...] }
GET    /api/manager/events             — Top event list (incremental via ?after=<id>)
GET    /api/manager/output             — Top output text
POST   /api/manager/stop               — stop Top (also clears pending parent-notice queue for Top's runId)
POST   /api/manager/pm/:projectId/message — lazy-spawn PM if needed, then send
POST   /api/manager/pm/:projectId/reset   — single-owner teardown: dispose adapter, cancel run, clear pm_thread_id, drop registry slot
```

### Conversations (1st-class) — v3 Phase 1.5+
```
GET    /api/conversations/:id          — resolve { conversation: { kind, conversationId, run? } }
POST   /api/conversations/:id/message  — send { text, images? } — `id` is 'top' | 'pm:<projectId>' | 'worker:<runId>'
GET    /api/conversations/:id/events   — event list (incremental ?after=<id>)
```

### Router (v3 Phase 6)
```
POST   /api/router/resolve             — { text, currentConversationId?, defaultConversationId? }
                                         → { target, text, matchedRule, ambiguous?, candidates? }
```

### Dispatch Audit (v3 Phase 4 + 7) — annotate-only reconciliation
```
POST   /api/dispatch-audit             — record a PM claim
                                         { project_id, task_id?, pm_run_id?, selected_agent_profile_id?, rationale?, pm_claim: { kind, task_id? / run_id? } }
                                         → 201 { audit: { ..., incoherence_flag, incoherence_kind } }
GET    /api/dispatch-audit             — list (?project_id=, ?incoherent_only=1, ?limit=<1..500>)
```

Supported `pm_claim.kind` values: `task_complete`, `task_in_progress`, `worker_spawned`, `worker_running`, `worker_completed`, `worker_failed`. Unknown kinds are stored with `incoherence_flag=0, incoherence_kind='unknown_kind'` so later matchers can widen without rewriting history.

### Legacy / support routes
```
GET    /api/sessions                    — list legacy OpenCode sessions
GET    /api/sessions/:id                — read a single session (with messages)
POST   /api/sessions                    — create a new session
POST   /api/sessions/:id/message        — append a message { content }
PATCH  /api/sessions/:id                — rename
DELETE /api/sessions/:id                — move to trash

GET    /api/trash/sessions              — list trashed sessions
POST   /api/trash/sessions/:trashId/restore — restore a trashed session
DELETE /api/trash/sessions/:trashId     — permanent delete

GET    /api/fs                          — directory browse (?path=)

GET    /api/usage/providers             — aggregated provider usage (Codex / Anthropic / …)
GET    /api/usage/codex-status          — Codex-specific connection/auth status

GET    /api/claude-sessions             — active Claude Code subprocesses (Manager + workers)
```

### SSE / Health
```
GET    /api/events             — SSE stream
GET    /api/health             — health check
```

> **API reference completeness**: the sections above enumerate every route mounted by `server/app.js` at commit `7a3affa` (Phase 7 merge). When adding a new route, mount it in `app.js` AND add it to this section — otherwise this file silently drifts out of sync with the server.

#### SSE channels
| Channel | Meaning | v3 semantic envelope fields |
|---|---|---|
| `task:created` / `task:updated` / `task:deleted` | Task mutations | — |
| `run:created` | New run row | — |
| `run:status` | Any run status transition (incl. `createRun` normalized emit) | `from_status`, `to_status`, `reason`, `task_id`, `project_id` |
| `run:ended` | Terminal transition | same as `run:status` |
| `run:completed` | Agent exit captured in health loop | same + `reason='agent-exit-success' \| 'agent-exit-error(N)'` |
| `run:needs_input` | **Priority alert** — idle timeout detected | same + `priority: 'alert'` |
| `run:event` | Per-vendor raw event (high volume) | — |
| `manager:started` / `manager:stopped` | Top manager lifecycle | — |
| `dispatch_audit:recorded` | New PM dispatch claim audited | `audit`, `project_id`, `pm_run_id`, `incoherence_flag`, `incoherence_kind` |

Client pattern: the Drift badge + drawer and `run:needs_input` tab-title pulse are both wired through these semantic fields. `run:status` is a pure reload trigger and does NOT fire priority notifications — that responsibility belongs to the dedicated channels (`run:needs_input`, `run:completed`) to avoid duplicate alerts.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4177` | Server port |
| `PALANTIR_TOKEN` | (none) | Enables Bearer/cookie auth and promotes bind from `127.0.0.1` to `0.0.0.0` |
| `HOST` | auto | Override the bind address. `0.0.0.0` without a token logs a security warning |
| `PALANTIR_ALLOWED_COMMANDS` | (none) | Additional allowed CLI commands (comma-separated) |
| `PALANTIR_DEFAULT_PM_ADAPTER` | `codex` | Global default PM adapter when a project has no `preferred_pm_adapter`. Claude preference still falls through to Codex until Phase 3b (Claude PM resume) ships |
| `PALANTIR_CODEX_MANAGER_BYPASS` | (unset) | Set to `1` to let Codex manager turns run with `--dangerously-bypass-approvals-and-sandbox`. Default (unset) keeps the manager role in the sandboxed policy |
| `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | — | Claude Code auth (persisted to `.claude-auth.json` when set at server start) |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | — | Codex auth (preflight checks `~/.codex/auth.json`) |
| `CODEX_BIN` | `codex` | Codex CLI path |
| `CODEX_HOME` | `~/.codex` | Codex config home |
| `OPENCODE_STORAGE` | `~/.local/share/opencode/storage` | OpenCode session storage path |
| `OPENCODE_BIN` | `opencode` | OpenCode binary path |
| `OPENCODE_FS_ROOT` | `$HOME` | Directory picker root path |

## Tech Stack

- **Backend**: Express.js 5, SQLite (WAL mode, better-sqlite3), EventEmitter SSE
- **Frontend**: Preact + HTM (UMD, no build step), hash router
- **Worker agents**: tmux session + git worktree isolation
- **Manager agents**: Claude Code CLI (stream-json NDJSON) OR Codex CLI (`codex exec --json` + thread resume), selected per agent profile
- **Real-time**: SSE (Server-Sent Events) with `Last-Event-ID` replay
- **Tests**: Node.js built-in test runner + supertest (238 tests at time of v3 Phase 7 merge)

## Development

```bash
npm test     # run tests
npm run dev  # dev server
```

Data is stored in `palantir.db` (SQLite). Auto-migrated on server start (`server/db/migrations/001..010_*.sql`).

See also:
- `docs/specs/manager-v3-multilayer.md` — the v3 redesign spec (lock-in + phase history)
- `docs/test-scenarios.md` — QA scenarios (`PRJ`, `TSK`, `BRD`, `RUN`, `INS`, `MGR`, `PM`, `DRIFT`, `ROUTER`, `SSE`, `REG`, …)
- `CLAUDE.md` — project conventions + autonomous-mode working style

## License

ISC
