# Agent Guide

This repo hosts Palantir Console, a small web UI for browsing OpenCode sessions.

## Quick Start

- Docker (preferred):
  - `cp .env.example .env`
  - `docker compose up --build`
  - Open `http://localhost:4177`
- Local:
  - `npm install`
  - `export OPENCODE_STORAGE="$HOME/.local/share/opencode/storage"`
  - `export OPENCODE_BIN="opencode"`
  - `npm run dev`

## Commands

- `npm run dev` (local server)
- `npm run start` (local server)
- `npm test` (node --test)

## Notes

- The UI is served from `server/public`.
- Runtime config is driven by env vars listed in `README.md`.
- Avoid committing secrets from `.env`.
