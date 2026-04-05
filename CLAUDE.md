# CLAUDE.md

Palantir Console — AI 코딩 에이전트 (Claude Code, Codex, OpenCode) 중앙 관제 허브.

## Commands

```bash
npm install          # 의존성 설치
npm start            # 서버 시작 (localhost:4177)
npm test             # 전체 테스트 실행 (node --test)
npm run dev          # 개발 서버 (동일)

# 특정 테스트 파일만
node --test server/tests/manager.test.js
node --test server/tests/v2-api.test.js
```

## Architecture

Express.js 5 + SQLite (WAL, better-sqlite3) + Preact/HTM (CDN 없이 vendor/ UMD).
빌드 스텝 없음 — `server/public/`의 파일이 그대로 서빙됨.

```
server/
  index.js                  — 진입점, 포트/auth 설정
  app.js                    — Express 앱 조립 (라우터, 서비스, 미들웨어)
  db/database.js            — SQLite 초기화 + 자동 마이그레이션
  db/migrations/            — SQL DDL (001_initial, 002_manager_sessions)
  routes/
    manager.js              — Manager Session API (/api/manager/*)
    tasks.js, runs.js, projects.js, agents.js, events.js
  services/
    streamJsonEngine.js     — Manager 전용: Claude Code CLI stream-json 프로토콜
    executionEngine.js      — Worker 전용: TmuxEngine / SubprocessEngine
    lifecycleService.js     — Health check, 상태 전환, 자동 정리
    runService.js           — Run CRUD
    taskService.js          — Task CRUD
    eventBus.js             — EventEmitter pub/sub
    worktreeService.js      — Git worktree 관리
  public/
    app.js                  — Preact SPA (단일 파일, ~3800줄)
    styles.css              — 전체 스타일
    vendor/                 — Preact/HTM UMD 번들 (빌드 불필요)
  tests/
    manager.test.js         — Manager 기능 11개 테스트
    v2-api.test.js          — v2 API 통합 테스트
```

## Key Patterns

### Manager Session (stream-json 프로토콜)
- Claude Code CLI를 `--print --output-format stream-json --input-format stream-json` 모드로 spawn
- **절대 `-p` 플래그와 `--input-format stream-json`을 함께 사용하지 말 것** — 충돌하여 CLI가 hooks 이후 멈춤
- 초기 프롬프트는 spawn 후 stdin으로 전송: `{"type":"user","message":{"role":"user","content":"..."}}`
- 매 턴마다 `result` 이벤트가 발생하지만, Manager는 `completed`로 전환하지 않음 (multi-turn 유지)
- `lifecycleService` health check에서 `is_manager` 런은 건너뜀 (TmuxEngine과 무관)

### Auth 전달
- `.claude-auth.json`에 OAuth 토큰 저장 (mode 0o600, gitignored)
- Claude Code 세션 내 서버 시작 시 자동 저장 → 이후 독립 실행 시 로드
- 환경변수: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`

### Worker Run 실행
- tmux 세션 또는 subprocess로 에이전트 CLI 실행
- git worktree로 파일시스템 격리
- `executionEngine.js`가 TmuxEngine (tmux 있을 때) / SubprocessEngine (없을 때) 자동 선택

### Frontend
- Preact + HTM (UMD) — `server/public/vendor/`에 번들됨, CDN 의존 없음
- 빌드 파이프라인 없음. `app.js`를 직접 수정
- 해시 라우팅: `#dashboard`, `#manager`, `#board`, `#projects`, `#agents`

### DB
- SQLite WAL 모드. `palantir.db` (gitignored)
- 서버 시작 시 `db/migrations/` 자동 실행
- `better-sqlite3` 동기 API 사용

## Style Guidelines

- 한국어 사용 (코드 주석/변수명은 영어)
- Express 5 (async 에러 자동 캐치)
- 테스트: Node.js built-in test runner (`node --test`), supertest로 HTTP 테스트
- 새 API 라우트 추가 시 `app.js`에서 `app.use()` 등록 필요

## Security

- `PALANTIR_TOKEN` 미설정 시 인증 비활성 + localhost only 바인딩
- 에이전트 명령어 allowlist 제한 (임의 명령 실행 불가)
- `.claude-auth.json`은 절대 커밋 금지
- CWD 검증: `/etc`, `/var`, `/usr` 등 위험 경로 차단

## Things to Watch Out For

- `server/public/app.js`가 ~3800줄 단일 파일 — 수정 시 해당 컴포넌트 영역만 탐색
- Manager 프로세스는 stdin이 닫히면 종료됨 — stdin pipe를 열어두어야 함
- `result` 이벤트 처리 시 Manager/Worker 분기 확인 (`proc.isManager`)
- Health check가 Manager를 잘못 죽이지 않는지 `lifecycleService.js`의 `is_manager` 가드 확인
