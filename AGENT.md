# Agent Guide

Palantir Console — AI 코딩 에이전트 중앙 관제 허브.

## Quick Start

```bash
npm install
npm start          # http://localhost:4177
npm test           # node --test
```

## Architecture

```
server/
  index.js              — 서버 진입점 (포트, auth 로딩)
  app.js                — Express 앱 설정, 라우터/서비스 조립
  db/
    database.js         — SQLite (WAL mode, better-sqlite3) 초기화 + 마이그레이션
    migrations/         — SQL 마이그레이션 (001_initial, 002_manager_sessions)
  routes/
    manager.js          — Manager Session API (/api/manager/*)
    tasks.js            — Task CRUD + execute
    runs.js             — Run CRUD + input/cancel
    projects.js         — Project CRUD
    agents.js           — Agent Profile CRUD
    events.js           — SSE 스트림
    claude-sessions.js  — Legacy OpenCode 세션
  services/
    streamJsonEngine.js — Claude Code CLI stream-json 프로토콜 엔진 (Manager용)
    executionEngine.js  — TmuxEngine/SubprocessEngine (Worker용)
    lifecycleService.js — Health check, 상태 전환, 자동 정리
    runService.js       — Run DB CRUD
    taskService.js      — Task DB CRUD
    projectService.js   — Project DB CRUD
    agentProfileService.js — Agent Profile DB CRUD
    eventBus.js         — EventEmitter pub/sub
    worktreeService.js  — Git worktree 관리
  public/
    app.js              — Preact + HTM SPA (빌드 없음)
    styles.css          — CSS 스타일
    index.html          — HTML 진입점
  tests/
    manager.test.js     — Manager 기능 테스트 (11개)
    v2-api.test.js      — v2 API 통합 테스트
```

## Key Concepts

- **Manager Session**: Claude Code CLI를 stream-json 모드로 실행하여 multi-turn 대화. `--input-format stream-json`으로 stdin을 통해 메시지 전달.
- **Worker Run**: tmux/subprocess로 에이전트 CLI 실행. Task에 연결됨.
- **StreamJsonEngine**: NDJSON 이벤트 파싱 (system/init, assistant, result 등). Manager 전용.
- **Health Check**: lifecycleService가 주기적으로 실행 중인 run 체크. Manager run은 건너뜀 (`is_manager` 가드).
- **Auth Persistence**: `.claude-auth.json`에 OAuth 토큰 저장. Claude Code 세션 내에서 서버 시작 시 자동 저장, 이후 독립 실행 시 로드.

## Important Notes

- Manager에서 `--input-format stream-json` + `-p` 플래그 조합은 동작하지 않음. 초기 프롬프트는 반드시 stdin으로 전송.
- Manager의 result 이벤트는 "한 턴 끝남"을 의미하지 "세션 끝남"이 아님. completed로 전환하지 않음.
- UI는 CDN 없이 `server/public/vendor/`에 번들된 Preact/HTM UMD 사용.
- `.claude-auth.json`은 gitignore에 포함. 민감 정보 커밋 금지.
