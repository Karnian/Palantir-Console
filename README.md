# Palantir Console

Palantir Console is a lightweight web UI for browsing and managing OpenCode
sessions stored on disk. It reads session/message metadata from the OpenCode
storage layout and lets you search, load, and resume conversations from your
browser.

## Features

- Session list with activity status, directory, and last activity time.
- Search by title, slug, or directory.
- Message viewer with load-more paging and expand/collapse for long content.
- Create, rename, and delete sessions (deletes move sessions to trash).
- Trash panel to restore or permanently remove sessions.
- Directory picker powered by the server-side filesystem API.
- Send messages to a session using the local `opencode` CLI.

## Requirements

- Node.js 18+ and npm (for local dev/run).
- Docker + Docker Compose (for containerized run).
- OpenCode CLI available on the host or in the container.

## Setup

### Docker

1. Copy `.env.example` to `.env` and update host paths as needed.
2. Provide any required API keys in your environment or `.env` file.
3. Build and start the service.

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:4177`.

### Local

1. Install dependencies.
2. Export the environment variables listed below (at minimum
   `OPENCODE_STORAGE` and `OPENCODE_BIN`).
3. Start the server.

```bash
npm install
export OPENCODE_STORAGE="$HOME/.local/share/opencode/storage"
export OPENCODE_BIN="opencode"
npm run dev
```

Open `http://localhost:4177`.

## Environment Variables

### Server/runtime

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | HTTP port for the console server. | `4177` |
| `OPENCODE_STORAGE` | Path to OpenCode storage root (contains `session`, `message`, `part`, `trash`). | `$HOME/.local/share/opencode/storage` |
| `OPENCODE_BIN` | Path to the `opencode` CLI binary. | `opencode` |
| `OPENCODE_FS_ROOT` | Filesystem root exposed to the directory picker. | `$HOME` |
| `NODE_TLS_REJECT_UNAUTHORIZED` | TLS enforcement for outbound calls made by the CLI. `0` disables verification. | `0` (Docker) |
| `OPENAI_API_KEY` | API key for OpenAI models used by OpenCode. | none |
| `ANTHROPIC_API_KEY` | API key for Anthropic models used by OpenCode. | none |
| `GEMINI_API_KEY` | API key for Google Gemini models used by OpenCode. | none |
| `GROQ_API_KEY` | API key for Groq models used by OpenCode. | none |

### Docker host paths

These map host paths into the container (see `docker-compose.yml`).

| Variable | Description | Example |
| --- | --- | --- |
| `OPENCODE_STORAGE_HOST` | Host path for OpenCode storage. | `~/.local/share/opencode/storage` |
| `OPENCODE_CONFIG_HOST` | Host path for OpenCode config. | `~/.config/opencode` |
| `OPENCODE_STATE_HOST` | Host path for OpenCode state. | `~/.local/share/opencode/state` |
| `OPENCODE_AUTH_HOST` | Host path for OpenCode auth JSON. | `~/.local/share/opencode/auth.json` |
| `OPENCODE_MCP_AUTH_HOST` | Host path for MCP auth JSON. | `~/.local/share/opencode/mcp-auth.json` |
| `OPENCODE_ANTIGRAVITY_HOST` | Host path for OpenCode antigravity accounts. | `~/.local/share/opencode/antigravity-accounts.json` |

## Usage

- **Sessions**: Select a session from the left panel to view its messages.
- **Search**: Use the search input to filter sessions by title, slug, or path.
- **Load more**: Click "Load more" to page older messages for the session.
- **Send messages**: Type a prompt and press Enter to enqueue a message via
  the `opencode` CLI.
- **Create**: Click "New" and choose a directory to create a session.
- **Rename**: Use the rename action in the session header.
- **Trash/restore**: Delete moves a session to trash; open the trash panel to
  restore or permanently delete.

## Troubleshooting

### TLS errors

If outbound requests fail due to TLS issues (common in self-signed networks),
set `NODE_TLS_REJECT_UNAUTHORIZED=0` in your environment. If you require
strict TLS verification, set it to `1` and provide valid certificates.

### OpenCode authentication

If sending messages fails, verify OpenCode is authenticated and the auth files
are mounted:

- Ensure `~/.local/share/opencode/auth.json` and
  `~/.local/share/opencode/mcp-auth.json` exist on the host.
- Run `opencode auth login` on the host to refresh credentials.
- In Docker, confirm the volume mounts in `docker-compose.yml` point to the
  correct files and the container user can read them.

## Security Notes

- The server can read directories under `OPENCODE_FS_ROOT`. Keep this scoped to
  a safe path and avoid exposing the service to untrusted networks.
- OpenCode storage includes session content and metadata. Protect it like other
  sensitive logs.
- API keys are passed through environment variables. Use `.env` locally and
  avoid committing secrets.

## License

TBD
