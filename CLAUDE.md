# CLAUDE.md

Palantir Console — AI 코딩 에이전트 (Claude Code, Codex, OpenCode) 중앙 관제 허브.

## Working style (autonomous mode default ON)

이 repo에서는 Claude가 **default autonomous**로 동작한다. 사용자가 명시적으로 "이번엔 단계별로 확인해" / "자율 모드 꺼"라고 선언하지 않는 이상, 아래 범위는 승인 없이 진행하고 phase 종료 시점에 한 번만 요약 보고한다.

**승인 없이 진행**:
- codex PASS + 테스트 그린인 PR의 squash merge + branch 삭제 + main pull
- 테스트 / gitignore / cleanup / 문서 등 보조 작업 (발견 즉시 수정, 별도 작은 PR 포함)
- 명확한 테스트 찌꺼기 / orphan 리소스 정리
- smoke 레벨 자동 승격 (레벨 1 PASS → 즉시 레벨 2)
- codex 라운드 반복, 블로커 자동 수정, commit/PR 본문 작성
- 옵션 A/B/C 중 권장안 자동 선택 — 사후 "A로 했다" 통보만

**여전히 사용자 확인 필요**:
- 되돌리기 불가한 git: force push, 원격 브랜치 삭제, 사용자 작업물을 덮어쓸 `reset --hard`, published commit amend
- 사용자가 띄운 prod 서버 프로세스 kill (Claude가 직접 띄운 백그라운드는 예외)
- LLM 실제 호출이 상당량 누적되는 작업
- spec / lock-in / 원칙 재해석이 필요한 설계 결정
- 이전 feedback과 충돌하는 방향 전환
- codex가 ~5라운드 넘도록 수렴 안 되는 경우 (설계 전제 오류 가능성)

**Phase 기반 작업 표준 체인** (자동):
`branch → 구현 → npm test → codex 교차검증 (PASS까지 반복) → commit → PR → merge → main pull → 다음 phase 진입 여부 보고`

spec 소스: `docs/specs/manager-v3-multilayer.md`. 교차검증 루틴 세부: `.claude/memory/feedback_phase_workflow.md`.

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

**v3 기준 (Phase 0~9 merged)**: Top manager + 프로젝트 단위 PM (lazy-spawn, conversation identity), deterministic router, annotate-only drift reconciliation, SSE 시맨틱 envelope. P8: app.js ESM 전환, hooks 분할, ManagerView 분할. P9: 전 컴포넌트 직접 ESM import (window bridge 0개), SessionsView Preact 재작성.

```
server/
  index.js                    — 진입점, 포트/auth 설정
  app.js                      — Express 앱 조립 (라우터, 서비스, 미들웨어)
  db/database.js              — SQLite 초기화 + 자동 마이그레이션
  db/migrations/              — 001_initial ~ 010_dispatch_audit.sql
  routes/
    manager.js                — Top/PM /api/manager/* + /pm/:projectId/message + /reset
    conversations.js          — /api/conversations/:id/* (top|pm:<id>|worker:<id>)
    router.js                 — /api/router/resolve (v3 Phase 6 3-step matcher)
    dispatchAudit.js          — /api/dispatch-audit (POST/GET, annotate-only)
    tasks.js, runs.js, projects.js, agents.js, events.js
    sessions.js, trash.js, fs.js, usage.js, claude-sessions.js — legacy + support
  services/
    streamJsonEngine.js       — Claude Code CLI stream-json (Manager용)
    managerAdapters/
      claudeAdapter.js        — Claude 어댑터 (stream-json persistent process)
      codexAdapter.js         — Codex 어댑터 (stateless, thread resume)
    executionEngine.js        — Worker 전용: TmuxEngine / SubprocessEngine
    lifecycleService.js       — Health check, 상태 전환, 자동 정리
    managerRegistry.js        — top / pm:<id> 슬롯 단일 source + onSlotCleared 리스너
    conversationService.js    — 1급 conversation 엔트리 + peek-then-drain parent-notice 큐
    pmSpawnService.js         — PM lazy spawn (brief 을 static system prompt 에 bake)
    pmCleanupService.js       — PM 종료 단일 owner (fail-closed, reset/dispose)
    routerService.js          — 3-step 매처 (1 @mention → 2 current → 3 name fuzzy → 4 default)
    reconciliationService.js  — dispatch audit (pm_hallucination / user_intervention_stale)
    runService.js             — Run CRUD + SSE envelope (from_status/to_status/reason/…)
    taskService.js            — Task CRUD
    projectService.js         — Project CRUD + pm_enabled / preferred_pm_adapter
    projectBriefService.js    — project_briefs (conventions, pitfalls, pm_thread_id)
    agentProfileService.js    — Agent profile + capabilities_json / env_allowlist
    managerSystemPrompt.js    — layer='top'|'pm' 분기 시스템 프롬프트 빌더
    authResolver.js           — Claude/Codex auth preflight + 필터링 spawn env
    eventBus.js               — EventEmitter pub/sub (replay 200)
    worktreeService.js        — Git worktree 관리
  public/
    app.js                    — Preact SPA 진입 (ES module, P8-2), NavSidebar + App + mount
    app/main.js               — ESM 부트스트래퍼 (~14줄): configureMarked + import app.js
    app/lib/nav.js            — NAV_ITEMS 공유 모듈 (P9-2)
    app/lib/hooks.js          — re-export barrel (→ hooks/ 디렉토리)
    app/lib/hooks/             — P8-4 분할: routing, utils, sse, data, conversation, dispatch, manager
    app/components/ManagerView.js  — Manager 레이아웃 셸 (P8-5, ~35줄)
    app/components/ManagerChat.js  — Manager 채팅 패널 (P8-5, ~500줄)
    app/components/SessionGrid.js  — Task 세션 그리드 (P8-5, ~200줄)
    app/components/SessionsView.js — Sessions 레이아웃 셸 (P9-4, Preact 재작성)
    app/components/SessionList.js  — 세션 목록 (P9-4)
    app/components/ConversationPanel.js — 대화 패널 (P9-4)
    app/components/TaskModals.js   — NewTaskModal, ExecuteModal, TaskDetailPanel (P7-1)
    app/lib/notifications.js       — Browser notifications + tab pulse (P7-4)
    styles.css                — 전체 스타일
    vendor/                   — Preact/HTM UMD/ESM 번들 (빌드 불필요)
  tests/
    conversation.test.js      — Phase 1.5/2 parent-notice + registry + rotation
    pm-phase3a.test.js        — Phase 3a lazy spawn + cleanup (fail-closed)
    reconciliation.test.js    — Phase 4/7 envelope binding + audit + eventBus emit
    router.test.js            — Phase 6 3-step matcher (rules 1~4)
    phase5-sse-semantics.test.js — Phase 5 envelope shape (createRun/update/completed)
    manager.test.js           — Top manager 기본 동작
    manager-codex.test.js     — Codex adapter role/resume 동작
    v2-api.test.js, api.test.js, boot.smoke.test.js, …
```

> **509 tests** 기준 (P9 완료 시점). 새 phase 추가할 때 기존 파일에 끼워넣기 vs 신규 파일 생성은 "phase 단일 주제면 신규 파일" 규칙.

## Key Patterns

### Manager Session (Claude stream-json 프로토콜)
- Claude Code CLI를 `--print --output-format stream-json --input-format stream-json` 모드로 spawn
- **절대 `-p` 플래그와 `--input-format stream-json`을 함께 사용하지 말 것** — 충돌하여 CLI가 hooks 이후 멈춤
- 초기 프롬프트는 spawn 후 stdin으로 전송: `{"type":"user","message":{"role":"user","content":"..."}}`
- 매 턴마다 `result` 이벤트가 발생하지만, Manager는 `completed`로 전환하지 않음 (multi-turn 유지)
- `lifecycleService` health check에서 `is_manager` 런은 건너뜀 (TmuxEngine과 무관)

### Manager Session (Codex stateless + thread resume) — v3 Phase 3a
- `codex exec --json` 으로 첫 turn, 이후 턴은 `codex exec resume <thread_id>` — Codex 는 stateless 어댑터 (매 턴마다 subprocess 생성/종료)
- system prompt 는 `-c 'model_instructions_file="<path>"'` — stable 파일 경로 + stable 내용이면 `cached_input_tokens` hit
- `codexAdapter.startSession` 의 `resumeThreadId` 옵션: `project_briefs.pm_thread_id` 가 있으면 seed 해서 첫 runTurn 이 바로 resume 으로 감
- `onThreadStarted(threadId)` 콜백: `thread.started` 이벤트 (또는 resume 시 synchronous) 때 정확히 한 번 호출 — `pmSpawnService` 가 이걸로 `project_briefs.pm_thread_id` 를 persist
- **brief 은 static system prompt 에 bake** — 절대 seed runTurn 으로 넣지 말 것 (codex 어댑터는 단일-turn 가드가 있어서 back-to-back runTurn 이면 두 번째 turn 이 "previous turn still running" 으로 실패)

### v3 Manager 계층 (top / pm:&lt;id&gt;)
- `managerRegistry` 가 `top` / `pm:<projectId>` 슬롯별 단일 source. `setActive` / `probeActive` / `clearActive` / `snapshot` / `onSlotCleared` 리스너.
- `conversationService` 가 모든 send 경로의 단일 엔트리. peek-then-drain parent-notice 큐 (race-safe splice, myId fence).
- **lock-in #2 (Phase 1.5)**: 자식 타깃 사용자 메시지 = 무조건 부모 staleness notice. 의도 분류 금지.
- `resolveParentSlot(parentRunId)` 로 worker 의 parent 가 활성 Top 인지 활성 PM 인지 판정 → 해당 슬롯에만 notice 큐잉.
- `pmCleanupService.reset` / `.dispose` 는 **fail-closed**: `disposeSession` throw 시 레지스트리/brief/run 상태를 유지한 채 re-throw (Phase 3a R2).
- `run.is_manager=1` 이면 lifecycleService health loop 가 건너뜀. Top/PM 양쪽 모두 이 가드 하나로 커버.

### Dispatch audit & router (v3 Phase 4/6/7)
- PM 이 definitive claim 을 만들 때마다 `POST /api/dispatch-audit` 로 기록 → `reconciliationService` 가 DB truth 와 비교. incoherent 시 flag + kind (`pm_hallucination`, `user_intervention_stale`, …). Annotate-only — **절대 block 안 함** (recordClaim 은 never throws except on hard envelope binding errors).
- 클라 `useDispatchAudit` hook 이 GET 폴링 + `dispatch_audit:recorded` SSE 구독. `requestSeqRef` 모노토닉 토큰으로 stale-response fence.
- `routerService.resolveTarget({text, currentConversationId})` 3-step:
  1. `@<name|id>` prefix → `pm:<projectId>` + prefix strip
  2. 유효 `currentConversationId` → 그대로 유지
  3. (현재 context 없을 때만) 프로젝트명 exact-insensitive 매칭; 다중 매칭 = ambiguous + candidates
  4. default (`top`)
- **envelope binding** (R5 최종): `pmRunId` 는 must-exist + `is_manager=1` + `manager_layer='pm'` + `conversation_id === 'pm:<projectId>'`. `taskId` / `run_id` cross-project 차단. `selectedAgentProfileId` must exist.

### SSE semantic envelope (v3 Phase 5) — additive
- `runService` 가 `createRun` / `updateRunStatus` / `markRunStarted` 에서 `{ run, from_status, to_status, reason, task_id, project_id }` 를 emit. Pre-Phase 5 의 `{ run }` 구독자는 그대로 동작.
- `lifecycleService` 의 `run:completed` / `run:needs_input` 도 동일 envelope + `reason` + (priority alert 의 경우) `priority: 'alert'`.
- **중요**: `useSSE` 의 channels 배열은 hard-coded. 새 SSE 채널 추가 시 반드시 `server/public/app/lib/hooks.js useSSE` 의 channels 배열에도 추가할 것. Phase 5/7 에서 `run:needs_input` / `dispatch_audit:recorded` 를 까먹어 dead code 되는 회귀가 있었음.
- 클라는 `run:status` 를 pure reload 로만 쓴다. 우선순위 알림은 dedicated 채널(`run:needs_input`, `run:completed`) 이 전담해야 duplicate 알림 안 생김.

### Auth 전달
- `.claude-auth.json`에 OAuth 토큰 저장 (mode 0o600, gitignored)
- Claude Code 세션 내 서버 시작 시 자동 저장 → 이후 독립 실행 시 로드
- 환경변수: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `OPENAI_API_KEY`
- `authResolver.resolveManagerAuth(type, { envAllowlist, hasKeychain })` 가 preflight. 테스트는 `authResolverOpts: { hasKeychain: true }` 로 주입 가능.
- `buildManagerSpawnEnv({ authEnv, envAllowlist })` 가 credential leak 방지 필터링 env 생성.

### Worker Run 실행
- tmux 세션 또는 subprocess로 에이전트 CLI 실행
- git worktree로 파일시스템 격리
- `executionEngine.js`가 TmuxEngine (tmux 있을 때) / SubprocessEngine (없을 때) 자동 선택

### Frontend
- Preact + HTM (ESM) — `server/public/vendor/`에 번들됨, CDN 의존 없음
- 빌드 파이프라인 없음. `app.js`는 App/mount 셸. 실제 뷰/모달은 `app/components/` ESM 모듈에 있음
- `server/public/app/main.js` 는 최소 부트스트래퍼 (~14줄): `configureMarked()` + `import('../app.js')`. window bridge 없음 (P9에서 전부 제거)
- 모든 ESM 컴포넌트는 vendor/ 에서 직접 import (`import { h } from '../../vendor/preact.module.js'` 등)
- 해시 라우팅: `#dashboard`, `#manager`, `#board`, `#projects`, `#agents`
- **클라이언트 async fence 패턴** (Phase 6/7): id-change 시 `setRun(null); setEvents([])` 동기 reset + await 이전 `myId = conversationId` 캡처 + commit 전 `activeIdRef.current === myId` 비교. `useDispatchAudit` 는 `requestSeqRef` 시퀀스 토큰.

### DB
- SQLite WAL 모드. `palantir.db` (gitignored)
- 서버 시작 시 `db/migrations/` 자동 실행 (현재 001~010)
- `better-sqlite3` 동기 API 사용
- `runs.manager_layer`, `runs.conversation_id` (009), `dispatch_audit_log` (010), `project_briefs` (008) 등 v3 필드 존재

## Style Guidelines

- 한국어 사용 (코드 주석/변수명은 영어)
- Express 5 (async 에러 자동 캐치)
- 테스트: Node.js built-in test runner (`node --test`), supertest로 HTTP 테스트
- 새 API 라우트 추가 시 `app.js`에서 `app.use()` 등록 필요

## Security

- **바인딩 정책 (PR1 / NEW-S1 + P0-1)**: 기본 `127.0.0.1`. `PALANTIR_TOKEN` 이 설정되면 자동으로 `0.0.0.0` 으로 승격. 사용자가 `HOST=` 를 명시하면 그대로 사용하되, 토큰 없이 `HOST=0.0.0.0` 이면 위험 경고를 찍음. 토큰 미설정 시 auth 비활성 + `[security] No PALANTIR_TOKEN set — auth disabled.` 로그. 이전(항상 0.0.0.0) 동작은 breaking change — 기존 배포는 `HOST=0.0.0.0` 을 명시하거나 토큰을 설정해야 같은 바인딩을 얻는다.
- **브라우저 쿠키 인증**: `PALANTIR_TOKEN` 이 설정된 경우 브라우저는 `palantir_token` HttpOnly 쿠키로 인증한다 (EventSource 는 커스텀 헤더 전송 불가 → Bearer 만으로는 SSE 가 구조적으로 막혔던 문제를 수정). 사용자는 `/login.html` 에서 POST 폼으로 토큰을 입력하고, 서버가 쿠키를 set 한 뒤 sanitized `next` 경로로 리다이렉트한다. 토큰은 URL 에 절대 노출되지 않음 (초기 PR1 draft 의 `?token=` 부트스트랩은 Codex review 에서 access-log leak 블로커로 지적되어 제거). `apiFetch` 는 401/403 응답을 받으면 `/login.html?next=…` 로 bounce. CLI / 테스트는 `Authorization: Bearer` 헤더 사용. Bearer 경로가 invalid 면 cookie 로 fallback 하지 않음 — 명시적 실패.
- **CSP self-host**: `marked` / `DOMPurify` 는 `server/public/vendor/` 에서 직접 서빙. CSP 는 `script-src 'self'; connect-src 'self'` (더 이상 cdn.jsdelivr.net 허용 안 함).
- 에이전트 명령어 allowlist 제한 (임의 명령 실행 불가)
- `.claude-auth.json`은 절대 커밋 금지
- CWD 검증: `/etc`, `/var`, `/usr` 등 위험 경로 차단

## Things to Watch Out For

- `server/public/app.js`는 ES module (P8-2). NavSidebar + App + mount 만 남은 셸 — 뷰/모달 수정은 `app/components/`, hooks 수정은 `app/lib/hooks/` 디렉토리를 직접 탐색. NAV_ITEMS 는 `app/lib/nav.js` 에 분리 (P9-2)
- `useSSE` channels 배열이 hard-coded (`app/lib/hooks/sse.js`) — 새 SSE 채널 추가 시 반드시 이 배열에도 추가. Phase 5/7 에서 까먹어 "핸들러는 등록됐지만 실제 subscribe 안 됨" 회귀가 있었음
- `ManagerView.js`는 thin layout shell (P8-5) — 채팅 로직은 `ManagerChat.js`, 세션 그리드는 `SessionGrid.js`에 있음
- `SessionsView.js`는 thin layout shell (P9-4) — 세션 목록은 `SessionList.js`, 대화 패널은 `ConversationPanel.js`에 있음. `initLegacySessions` 는 삭제됨
- `app/main.js` 는 최소 부트스트래퍼 (~14줄) — window bridge 없음. 모든 컴포넌트는 vendor/ 에서 직접 import
- `pmSpawnService` 에서 **seed runTurn 금지** — brief 은 static system prompt 에 bake. Codex 어댑터는 back-to-back runTurn 에서 "previous turn still running" 을 던진다
- `pmCleanupService` 는 fail-closed — dispose 실패 시 상태를 유지한 채 re-throw. 호출자 (DELETE /api/projects/:id, /reset) 가 502 로 거절해야 함. 절대 swallow 하지 말 것
- `reconciliationService.recordClaim` 의 envelope binding 은 strict — `projectId`/`taskId`/`pmRunId`/`selectedAgentProfileId` 전부 존재+소유 검증. hard input error 는 400 throw, incoherence 는 flag 로만 표시 (annotate-only 원칙: PM drift 는 기록만, block 안 함)
- Manager 프로세스는 stdin이 닫히면 종료됨 — stdin pipe를 열어두어야 함 (Claude adapter)
- `result` 이벤트 처리 시 Manager/Worker 분기 확인 (`proc.isManager`)
- Health check가 Manager를 잘못 죽이지 않는지 `lifecycleService.js`의 `is_manager` 가드 확인
- `conversationService` 의 peek-then-drain 은 race-safe: `commitDrainParentNotices(runId, count)` 가 `splice(0, count)` — 절대 `pendingNotices.delete(key)` 로 돌리지 말 것 (runTurn 중 도착한 notice 가 소실됨)
- `managerRegistry.onSlotCleared` 리스너가 3 경로 (`clearActive`, `probeActive` dead detection, `setActive` replacement) 모두에서 발화. 이게 notice 큐 scrub 의 유일한 hook
