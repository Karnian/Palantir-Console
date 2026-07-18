# CLAUDE.md

Palantir Console — AI 코딩 에이전트(Claude Code, Codex, OpenCode)를 3계층(Main Manager → Operator → Worker)으로 운영하는 중앙 관제 허브. Main Manager가 여러 프로젝트와 Operator을 총괄, Operator이 프로젝트 내 워커들을 관리, Worker가 실제 코딩 작업을 수행.

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

spec 소스: `docs/specs/manager-v3-multilayer.md`. 교차검증 루틴 세부: `.claude/memory/feedback_phase_workflow.md`. 현재 백로그: [`docs/backlog.md`](./docs/backlog.md) (Ready / Data-wait / Trigger-wait / Draft-review 카테고리).

## Commands

```bash
npm install          # 의존성 설치
npm start            # 서버 시작 (localhost:4177)
npm test             # 전체 테스트 실행 (node --test)
npm run dev          # 개발 서버 (동일)
npm run test:e2e     # Playwright e2e 테스트
npm run diagnose:mcp # M2: preset ↔ ~/.codex/config.toml alias 충돌 진단

# 특정 테스트 파일만
node --test server/tests/manager.test.js
node --test server/tests/v2-api.test.js
```

## Architecture

Express.js 5 + SQLite (WAL, better-sqlite3) + Preact/HTM (CDN 없이 vendor/ UMD) + Inter font (self-hosted woff2).
빌드 스텝 없음 — `server/public/`의 파일이 그대로 서빙됨. 외부 CDN 의존 0개.

**v3 기준 (Phase 0~10G + M1/M2/M3 + M4-a + UI/UX cleanup F~K-2 merged)**: Top manager + 프로젝트 단위 Operator (lazy-spawn, conversation identity), deterministic router, annotate-only drift reconciliation, SSE 시맨틱 envelope. P8: app.js ESM 전환, hooks 분할, ManagerView 분할. P9: 전 컴포넌트 직접 ESM import (window bridge 0개), SessionsView Preact 재작성. P10: Worker Preset DB/Service (10B), Tier 1/2 spawn wiring (10C/10D), Task linkage + #presets UI (10E), Preset snapshot drift audit UI (10F), agent-olympus integration (10G). **M1 (PR #114)**: Codex worker/Operator MCP 주입을 leaf-level dotted path (`-c mcp_servers.<alias>.<key>=<TOML>`) 로 교체 + fail-closed flatten. **M2 (PR #115)**: user `~/.codex/config.toml` 과의 legacy alias 충돌을 `mcp:legacy_alias_conflict` run event 로 observability. **B3 (PR #116)**: `npm run diagnose:mcp` ops 도구. **M3-UI (PR #119)**: `mcp_server_templates` UI CRUD (`#mcp-servers` 탭) — `mcpTemplateService` + `routes/mcpTemplates.js` + `McpTemplatesView.js`. **M4-a (PR TBD)**: MCP Streamable HTTP transport 1급 추가 — `mcp_server_templates.transport` ∈ {stdio, http} discriminated union (migration 022, table rebuild + 2 trigger), `ssrf.assertSafeUrl` async helper (DNS resolve + IP pinning), `codexMcpFlatten` http 분기 (url-only emit, no transport key), `mcpPreflight` (HEAD only / 200·204·405·501 pass / 3s timeout / Authorization 첨부 / fail-closed `preset:mcp_unreachable`), `authResolver.resolveBearerForPreflight` + `buildManagerSpawnEnv` 자동 allowlist, McpTemplatesView transport selector. spec: `docs/specs/m4-mcp-http-streamable-transport-brief.md`. **UI/UX cleanup (#129~#143)**: a11y / 한국어화 / 디자인 토큰 / Modal primitive / e2e selector attribute 화. **K-2 라이트 모드 (#145~#153)**: `[data-theme="light"]` 22 의미 토큰 + CSP-safe `theme-init.js` (FOUC 방지) + NavSidebar 3-state toggle + `prefers-color-scheme` system 자동.

```
server/
  index.js                    — 진입점, 포트/auth 설정, SIGINT/SIGTERM graceful shutdown
  app.js                      — Express 앱 조립 (라우터, 서비스, 미들웨어)
  db/database.js              — SQLite 초기화 + 자동 마이그레이션
  db/migrations/              — 001_initial ~ 027_memory_jobs.sql
                                (020: mcp_template_updated_at, 021: skill_pack origin_type CHECK trigger,
                                 022: M4-a — mcp_server_templates table rebuild w/ transport ∈ {stdio,http},
                                      url + bearer_token_env_var 컬럼, INSERT/UPDATE 정합성 trigger
                                      (column-shape + transport/alias immutable),
                                 025: ML memory_items+FTS5+revision+injection ledger, 026: ML memory_candidates,
                                 027: ML PR3a memory_jobs — batch-distill CAS lease (single-flight partial unique))
  middleware/
    auth.js                   — PALANTIR_TOKEN 쿠키/Bearer 인증
    errorHandler.js           — 중앙 에러 핸들러
    asyncHandler.js           — async 래퍼
    validate.js               — 요청 검증 미들웨어
  routes/
    manager.js                — Top/Operator /api/manager/* + /pm/:projectId/message + /reset
    conversations.js          — /api/conversations/:id/* (top|pm:<id>|worker:<id>)
    router.js                 — /api/router/resolve (v3 Phase 6 3-step matcher)
    dispatchAudit.js          — /api/dispatch-audit (POST/GET, annotate-only)
    auth.js                   — POST /login, POST /logout (쿠키 인증)
    tasks.js, runs.js, projects.js, agents.js, events.js
    sessions.js, trash.js, fs.js, usage.js, claude-sessions.js — legacy + support
    workerPresets.js          — Worker Preset CRUD (Phase 10B)
    skillPacks.js             — Skill Pack CRUD + gallery (Phase 10G)
    mcpTemplates.js           — MCP server template CRUD (M3-UI, /api/mcp-server-templates)
  utils/
    pathGuard.js              — isWithinRoot() 경로 traversal 방어 유틸
    errors.js                 — AppError / BadRequestError / NotFoundError
  data/
    skill-pack-registry.json  — Skill Pack 갤러리 레지스트리
  services/
    streamJsonEngine.js       — Claude Code CLI stream-json (Manager용)
    managerAdapters/
      claudeAdapter.js        — Claude 어댑터 (stream-json persistent process)
      codexAdapter.js         — Codex 어댑터 (stateless, thread resume + M1 flatten + M2 legacy scan)
      codexMcpFlatten.js      — M1: JSON mcpServers → `-c mcp_servers.<alias>.<key>=<TOML>` 평탄화 + fail-closed (M4-a: http 분기 — url + bearer_token_env_var leaf 만 emit, transport 키 미emit)
      codexUserConfigScan.js  — M2: ~/.codex/config.toml alias 스캔 + legacy 충돌 감지
      eventTypes.js           — 어댑터 공통 이벤트 타입
      index.js                — 어댑터 팩토리 (type → adapter 매핑)
    providers/
      anthropic.js            — Anthropic API provider
      claude-code.js          — Claude Code CLI provider
      gemini.js               — Gemini provider
      index.js, registered.js — provider registry
    executionEngine.js        — Worker 전용: TmuxEngine / SubprocessEngine
    lifecycleService.js       — Health check, 상태 전환, 자동 정리
    managerRegistry.js        — top / pm:<id> 슬롯 단일 source + onSlotCleared 리스너
    conversationService.js    — 1급 conversation 엔트리 + peek-then-drain parent-notice 큐
    operatorSpawnService.js         — Operator lazy spawn (brief 을 static system prompt 에 bake)
    operatorCleanupService.js       — Operator 종료 단일 owner (fail-closed, reset/dispose)
    routerService.js          — 3-step 매처 (1 @mention → 2 current → 3 name fuzzy → 4 default)
    reconciliationService.js  — dispatch audit (pm_hallucination / user_intervention_stale)
    runService.js             — Run CRUD + SSE envelope (from_status/to_status/reason/…)
    taskService.js            — Task CRUD + preferred_preset_id 검증
    projectService.js         — Project CRUD + pm_enabled / preferred_pm_adapter
    projectBriefService.js    — project_briefs (conventions, pitfalls, pm_thread_id)
    agentProfileService.js    — Agent profile + capabilities_json / env_allowlist
    presetService.js          — Worker Preset CRUD + snapshot drift 비교 (Phase 10B)
    skillPackService.js       — Skill Pack 설치/제거/resolve (Phase 10G)
    registryService.js        — Skill Pack 갤러리 레지스트리 조회
    mcpTemplateService.js     — MCP server template CRUD + boot seed upsert (M3-UI). M4-a: async (validateUrl 에 ssrf.assertSafeUrl 호출). transport 분기 + alias+transport immutable. http 행은 url + bearer_token_env_var 컬럼 사용 (command/args/allowed_env_keys NULL 강제, DB trigger 가 마지막 방어선)
    mcpPreflight.js           — M4-a: http MCP HEAD preflight + IP pinning + Authorization 첨부 + fail-closed reasons (preflight_4xx/5xx/timeout/connect_refused/redirect_blocked/ssrf_blocked/bearer_env_missing). PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP=1 로 디버그 시 비활성
    managerSystemPrompt.js    — layer='top'|'pm' 분기 시스템 프롬프트 빌더
    authResolver.js           — Claude/Codex auth preflight + 필터링 spawn env
    eventBus.js               — EventEmitter pub/sub (replay 200)
    eventChannels.js          — SSE 채널 상수 정의
    messageService.js         — 메시지 처리 서비스
    ssrf.js                   — SSRF 방어 (내부 IP 차단)
    codexService.js           — Codex CLI 서비스
    opencodeService.js        — OpenCode 서비스 (TLS 기본값 관리)
    fsService.js              — 파일시스템 브라우저 서비스
    storage.js                — 스토리지 경로 관리
    worktreeService.js        — Git worktree 관리 (H-1: autoSaveWorktree export, removeWorktree { autosave } opt, getWorktreeDiff 경화)
    harvestService.js         — H-1: run terminal 시 자동 수확 — autosave → diff 캡처 → opt-in test_command 실행 → worktree 제거. annotate-only (never throws), 이벤트 harvest:diff/test/error 3종 고정. H-1.5: eventBus 주입 + review 대상 worker run(completed/failed, !is_manager)에 exactly-once run:harvested emit (worktree/projectDir 부재·harvest 실패 무관, harvested 플래그). Operator auto-review 단일 트리거
    webhookService.js         — C: PALANTIR_WEBHOOK_URL 설정 시 run:needs_input + run:ended(failed) 외부 POST 통지. SSRF-safe (assertSafeUrl {allowPrivate} + pinned IP lookup hook), 화이트리스트 payload, 구독 콜백 self-isolation + never-throws. options.webhookUrl 우선
  public/
    app.js                    — Preact SPA 진입 (ES module, P8-2), NavSidebar + App + mount (~320줄)
    theme-init.js             — K-2c CSP-safe 테마 부트스트랩 (FOUC 방지) — head 에서 styles 보다 먼저 로드, localStorage `palantir.theme` ∈ {light, dark, system} 읽고 `<html data-theme="...">` + `<meta name="theme-color">` 동적 갱신
    index.html / login.html   — entry pages (login.html 은 K-2b 에서 token contract migrate)
    app/main.js               — ESM 부트스트래퍼 (~14줄): configureMarked + import app.js
    app/lib/nav.js            — NAV_ITEMS 공유 모듈 (P9-2)
    app/lib/hooks.js          — re-export barrel (→ hooks/ 디렉토리)
    app/lib/hooks/             — P8-4 분할: routing, utils, sse, data, conversation, dispatch, manager
    app/lib/api.js            — apiFetch() + 401 bounce 로직
    app/lib/format.js         — 포맷 유틸리티
    app/lib/markdown.js       — marked 설정 + DOMPurify 래퍼
    app/lib/dueDate.js        — 마감일 계산 유틸
    app/lib/toast.js          — 토스트 알림
    app/lib/notifications.js  — Browser notifications + tab pulse (P7-4)
    app/lib/a11y.js           — clickableProps() 키보드 접근성 유틸
    app/components/           — 25 ESM 컴포넌트
      ManagerView.js          — Manager 레이아웃 셸 (P8-5)
      ManagerChat.js          — Manager 채팅 패널 (P8-5)
      SessionGrid.js          — Task 세션 그리드 (P8-5)
      SessionsView.js         — Sessions 레이아웃 셸 (P9-4, Preact 재작성)
      SessionList.js          — 세션 목록 (P9-4)
      ConversationPanel.js    — 대화 패널 (P9-4)
      TaskModals.js           — NewTaskModal, ExecuteModal, TaskDetailPanel (P7-1)
      DashboardView.js        — 대시보드 뷰
      AttentionStrip.js       — Dashboard 상단 attention strip (UI/UX cleanup)
      BoardView.js            — Task Board 뷰 (칸반)
      ProjectsView.js         — 프로젝트 관리 뷰
      AgentsView.js           — 에이전트 프로필 관리 뷰
      PresetsView.js          — Worker Preset 관리 뷰 (P10E)
      SkillPacksView.js       — Skill Pack 관리 뷰 (P10G)
      McpTemplatesView.js     — MCP server template 관리 뷰 (M3-UI, `#mcp-servers`)
      GalleryView.js          — Skill Pack 갤러리 브라우저
      RunInspector.js         — Run 상세 + preset drift 감사 (P10F)
      DriftDrawer.js          — Dispatch drift 서랍 패널
      CommandPalette.js       — Cmd+K 커맨드 팔레트
      MentionInput.js         — @mention 자동완성 입력
      Dropdown.js             — 공통 드롭다운 컴포넌트
      EmptyState.js           — 빈 상태 표시 컴포넌트
      Modal.js                — 공통 Modal primitive (Phase F, focus trap + ESC stack)
      PackPreviewModal.js     — Skill Pack 미리보기 모달 (P10G)
      UrlInstallDialog.js     — URL 기반 Skill Pack 설치 다이얼로그
    styles.css                — 전체 스타일 (K-2 라이트 모드 swap 적용)
    styles/fonts.css          — Inter @font-face 정의 (self-hosted)
    styles/tokens.css         — CSS 디자인 토큰 (색상, 간격, 타이포 변수). K-2a 의 `[data-theme="light"]` 블록 + `@media (prefers-color-scheme: light) :root:not([data-theme])` 블록이 lock-step 으로 양쪽 정의 (CSS 가 selector 를 media 경계 가로질러 공유 못 하므로)
    vendor/                   — Preact/HTM UMD/ESM 번들 + marked + DOMPurify + Inter woff2 (빌드 불필요)
  tests/                      — 59 테스트 파일 + e2e 2개
    codex-mcp-flatten.test.js — M1: flatten 유틸 unit (TOML encoding, fail-closed shape/leaf)
    codex-user-config-scan.test.js — M2: ~/.codex/config.toml alias 스캔 + 충돌 감지 unit
    mcp-preflight.test.js          — M4-a: HTTP MCP HEAD preflight (pass/4xx/5xx/timeout/redirect/bearer/SSRF/skip)
    conversation.test.js      — Phase 1.5/2 parent-notice + registry + rotation
    pm-phase3a.test.js        — Phase 3a lazy spawn + cleanup (fail-closed)
    reconciliation.test.js    — Phase 4/7 envelope binding + audit + eventBus emit
    router.test.js            — Phase 6 3-step matcher (rules 1~4)
    phase5-sse-semantics.test.js — Phase 5 envelope shape (createRun/update/completed)
    manager.test.js           — Top manager 기본 동작
    manager-codex.test.js     — Codex adapter role/resume 동작
    session-resume.test.js    — 부팅 시 session resume 로직
    preset.service.test.js    — Preset CRUD + snapshot drift
    preset-spawn.test.js      — Preset spawn wiring (Tier 1/2)
    skill-packs.test.js       — Skill Pack 설치/제거
    sse-channels.test.js      — SSE 채널 등록 검증
    stream-json-engine.test.js — stream-json 엔진 유닛
    ssrf.test.js              — SSRF 방어 검증
    providers.test.js         — Provider registry
    v2-api.test.js, api.test.js, boot.smoke.test.js, …
    e2e/                      — Playwright e2e (smoke.spec.js, manager.spec.js)
    fixtures/                 — 테스트 픽스처 (agent-olympus-mock 등)
    helpers/                  — jsdom-preact.js 등
```

> **1249 tests** 기준 (P0~webhook+T4+T5+ML(PR3a~PR5+PR3c-1) 시점, 2026-06-16 — +harvest node resolve / Operator review de-dupe. **T4 (PR #194)**: harvest test_command 는 프로젝트 선언(.nvmrc/engines major)을 **서버 node 가 만족하면 서버 유지**(퇴행 0), 다른 단일 major 만 `<PALANTIR_NODE_PREFIX||/opt/homebrew/opt>/node@N/bin` 전환. range/오염 입력 → 서버 node. **T5 (PR #195)**: Operator auto-review 는 failed run 의 task 에 **더 높은 retry_count 의 active worker(=자동 retry)** 가 있으면 억제(`pm_review:suppressed`) — B-lite 자동 retry 와 Operator 수동 retry 의 이중 재시도 차단, 최종 failed 는 발송(hole 0). **C webhook (PR #192)**: `PALANTIR_WEBHOOK_URL` 설정 시 `run:needs_input` + `run:ended`(to_status=failed) 를 외부 POST 통지 (`webhookService`). SSRF-safe — `ssrf.assertSafeUrl(url, {allowPrivate})` 옵션화(기본 false→M4-a 무영향) + pinned IP POST(lookup hook rebinding 방어). 화이트리스트 payload(prompt/output 미포함). **`eventBus.emit` 은 구독자별 try/catch 격리** — 한 구독자 throw 가 emit 중단·뒤 구독자 starve 안 함 (PR #192 Q4). **B-lite 큐 (PR #189)**: `max_concurrent` 도달 시 throw 대신 queued 유지 → 슬롯 비면 FIFO 자동 spawn (`drainQueue`), failed worker 1회 자동 재시도(`createRetryRun` = 새 attempt run, 원 run harvest 와 독립). `claimQueuedRun` CAS(`UPDATE WHERE status='queued'`)로 동시 drain 중복 spawn 차단. `countRunning` 은 **worker-only**(`is_manager=0`) — codex Top/Operator 이 같은 profile 로 떠도 worker slot 안 먹음. retry 는 `started_at` 있는(실제 spawn 경로) run 만 (수동 PATCH failed 제외). **P0 (PR #183)**: `node --test` 중 실제 CLI spawn 은 spawnGuard 가 fail-closed 차단 — 테스트는 `server/tests/fixtures/bin/` 의 mock binary 또는 `process.execPath` 만 spawn 가능, 우회는 `PALANTIR_ALLOW_REAL_SPAWN=1` 명시 시에만. 2026-06-12 spawn storm 사고 (`docs/incident-2026-06-12-test-claude-spawn-storm.md`) 의 근본 수정). **H-1.5 (PR #186)**: Operator auto-review 는 `run:harvested` 단일 트리거 — worker terminal 시 harvestService 가 exactly-once emit, app.js 가 harvest 요약(diff/test)을 Operator 리뷰 메시지에 주입. `run:completed`/`run:result` 는 더 이상 Operator review 안 함 (채널 혼재 회귀 방지). 새 phase 추가할 때 기존 파일에 끼워넣기 vs 신규 파일 생성은 "phase 단일 주제면 신규 파일" 규칙. 단독 실행 시 모두 PASS, 풀 런 시 race-y flake 1~2건 알려진 패턴 (`engine: system:init event sets sessionId` 등 — `docs/handoff-post-k2-launch-2026-04-29.md` §6 참고). e2e: a11y 36 + visual 36 (#212 로 #memory 추가, 별도, 각각 `npm run test:a11y` / `test:visual`).
>
> **ML 메모리 레이어 (PR #197~#200 + PR3a·PR3b, 2026-06-16)**: 3계층 누적 암묵지 — worker harvest / Operator판정 → Operator 프로젝트 메모리 자동 증강 → 다음 Operator 세션 주입. **PR1 #197** read→inject 뼈대 (`services/memoryService.js` + `conversationService` user-payload 주입, **system prompt bake 금지**=Codex 캐싱/thread-resume 안전, fresh+resume system prompt 불변 회귀). **PR2a #198** R6 환경사실(harvest:test의 test_command/node 해석) → fact **즉시 active** (`upsertFact` fact_key supersede tx, node_source 3-way 오염방지). **PR2b #199** R1b 실패→수정(harvest:test FAIL run 의 직전 RUN → PASS = fix 쌍, runs `rowid AS _seq` 생성순 정렬) → candidate. **PR2c #200** R3 Operator판정(`dispatch_audit:recorded` 의 coherent task_complete 만, hallucination 제외) → candidate. `app.js` create{R6Fact,R1b,R3}Capture (eventBus 독립구독, never-throws), migration **025**(memory_items+FTS5+revision+pm_memory_injection ledger)/**026**(memory_candidates: rule∈R1b/R3/R4, UNIQUE dedup). **PR3a** batch-distill 뼈대 (candidate→active 정제): migration **027**(`memory_jobs` CAS lease, single-flight partial unique) + `memoryService` enqueue/claim/requeueStale/release(token-guarded) + **`promoteCandidatesBatchTx`** (lease 재확인 + sanitize + kind/importance/confidence clamp + evidence + createMemoryItem + candidate status = **한 tx, 모든 안전장치의 단일 강제 지점** — public 직접 호출자도 우회 불가) + `memorySanitize`(secret redact·injection reject·length) + `memoryDistillService.runOnce`(claim→list→distill(주입형)→promote→release→successor drain, never-throws) + `distillers/fakeDistiller`. terminal-bad(bad_kind/sanitize) candidate 는 rejected 마킹(starvation 방지), exact content_hash 병합. **fake distiller 로 전 경로 검증, LLM 0 호출. Codex 3라운드 적대리뷰 PASS.** **PR3b** live distiller + scheduler: `distillers/liveDistiller.js`(Anthropic Messages API `claude-haiku-4-5`, **주입형 callModel=mock 테스트**, `parseProposals` string-aware balanced-array + output cap, `data.content` 비배열 가드) + `memoryDistillService` `drainAll`(pending-project 스캔→enqueue→runOnce drain)/`startScheduler`(setInterval unref + busy guard) + `memoryService.listProjectsWithPendingCandidates` + app.js wiring(`PALANTIR_MEMORY_DISTILL=1` **기본 off** + `ANTHROPIC_API_KEY`/`options.distiller`, `app.shutdown` 이 `scheduler.stop()`). **루프 닫힘: 플래그 on 시 candidate→live distill→promote→active→Operator 주입 = 비전 완성.** 안전(secret/injection/clamp/evidence)은 promote(writer)가 강제하므로 distiller 우회 불가. Codex 적대리뷰 PASS(no blockers). **R4 remember** ✅ `POST /api/projects/:id/memory/remember` actor split: **cookie=human→active** / **bearer·none=R4 candidate**(never active) / **fact cookie-only**(promoter가 fact candidate 거부). 전 content sanitize(secret redact·injection reject·cap 2000; fact는 length floor만 skip). `fact_key` ASCII allowlist+`env.*` 예약(R6 namespace). `req.auth.method`(auth.js, 성공 후만 set, route fail-closed) + **`PALANTIR_PM_TOKEN` opt-in**(spoof-proof bearer, cookie는 PALANTIR_TOKEN만). Codex 3R 적대리뷰 PASS. **PR4 사후교정** ✅ (#206 PR4a backend + PR4b UI): migration 028(archived_at, pinned) + memoryService CRUD(update/archive/restore/review/pin — **active-set 변경만 revision bump**) + PATCH `/api/projects/:id/memory/:id`(**cookie-only** actor split) + GET ?status + GET/provenance(evidence 재귀 redact 값+키) + `MemoryView`(#memory: 목록/편집/archive/pin/provenance, XSS-safe, 디자인토큰). Codex 적대리뷰 PASS(evidence-key redact + PATCH cookie-only + stale-fetch/modal SERIOUS 반영). **PR5 안전·decay** ✅ (#208~#210+): hard-cap admission control(score=confidence×importance eviction, human/pinned 절대 보호, restore 도 admission, migration 029 archive_reason) + graceful shutdown(scheduler awaitDrain, app.shutdown 멱등, index watchdog/server.close-first) + poisoning gate(12 안전 불변식 + `buildInjectionBlock` injection-time re-sanitize) + decay(`valid_to` datetime() 정규화 + TTL 90일 batch_llm-only + `expireStaleMemories` maintenance + `markReviewed` re-observation refresh + `memory:decayed`). spec `docs/specs/memory-layer-brief.md`, handoff `docs/handoff-memory-layer-pr1-2c.md`. **PR3c-1 LLM semantic merge** ✅(#214): Jaccard 자동병합 원안 Codex NO-GO(순서·극성 맹점→정반대 병합·run_id gaming) → distiller(LLM)가 existingItems 보고 중복이면 `mergeTargetId` 제안 → promote 가 재검증(`getMergeTargetStmt` active+project+NOT-expired SQL + kind + Jaccard 0.3 floor=sanity) → **누적만**(source_count++/evidence, confidence 불변·cap·valid_to·revision 불변). existingItems 는 `listActiveForDistill` 로 LLM 프롬프트 전 살균(secret redact+injection skip+truncate+cap60), shown==validated. cap-60 dedup 한계는 `memory:distill_context_capped` observable. Codex 2R 적대(1차 NO-GO 2 BLOCKER secret유출·expired merge + 4 SERIOUS → 전부 수정·테스트재현, 2차 GO). **a11y·visual #memory 가드** ✅(#212, 36 시나리오). 남음(선택): PR3c-2 cross-run confidence / per-candidate FTS(cap-60 dedup) / L2(여러 Operator→Master). **athena 위임은 PR1만 성공, PR2a 부터 직접구현 + Codex 독립 교차리뷰**. node@22 테스트(better-sqlite3 ABI — codex node26 rebuild 시 `npm rebuild`), repo-local Karnian push helper.

## Key Patterns

### Manager Session (Claude stream-json 프로토콜)
- Claude Code CLI를 `--print --output-format stream-json --input-format stream-json` 모드로 spawn
- **절대 `-p` 플래그와 `--input-format stream-json`을 함께 사용하지 말 것** — 충돌하여 CLI가 hooks 이후 멈춤
- 초기 프롬프트는 spawn 후 stdin으로 전송: `{"type":"user","message":{"role":"user","content":"..."}}`
- 매 턴마다 `result` 이벤트가 발생하지만, Manager는 `completed`로 전환하지 않음 (multi-turn 유지)
- `lifecycleService` health check에서 `is_manager` 런은 건너뜀 (TmuxEngine과 무관)

### Session Resume on Boot
- 서버 재시작 시 이전 매니저/Operator 세션을 자동 resume (기존: 무조건 stopped)
- **Claude (top)**: `runs.claude_session_id` 를 `--resume <id>` 로 전달하여 CLI 세션 재접속. `streamJsonEngine` 이 `system:init` 이벤트에서 session_id 를 DB 에 persist
- **Codex (Operator)**: `operator_instances.thread_id` 로 `codex exec resume <thread_id>` 재접속. `project_briefs.pm_thread_id` 는 thread state 가 없는 legacy row 의 read-only bridge 로만 사용
- 부팅 순서: **Top 먼저 → Operator 나중** (Operator 은 parent-notice 라우팅을 위해 active Top 필요)
- resume 실패 시 기존 동작 fallback (`stopped` 마킹 + `disposeSession`)
- Operator resume 시 project brief (conventions/pitfalls/pm_run_id) 를 system prompt 에 bake (operatorSpawnService 와 동일)

### Codex MCP 주입 (M1/M2)
- **절대 `-c mcp_servers=<JSON blob>` 형태로 넣지 말 것** — Codex 0.120 이 "invalid type: string, expected a map" 으로 전체 config 로드를 fail 시킨다 (기존 Phase 10C worker 경로 버그).
- 올바른 형태는 leaf-level dotted path: `-c mcp_servers.<alias>.command="npx"`, `-c mcp_servers.<alias>.args=["-y","@pkg/mcp"]`, `-c mcp_servers.<alias>.env={KEY="val"}`. Worker (`lifecycleService`) + Operator (`codexAdapter.spawnOneTurn`) 둘 다 `managerAdapters/codexMcpFlatten.js` 의 `flattenMcpToCodexArgs` 를 공유.
- **Fail-closed**: flatten 실패 시 annotate-only 로 degrade 하지 않고 run 을 failed 로 마킹 + `preset:mcp_invalid` 이벤트 emit 후 throw. worker 는 executeTask catch 가 cleanup, Operator 은 `TURN_FAILED` + `SESSION_ENDED` + `runTurn` 이 `{ accepted: false }` 반환.
- 보안: direct `bearer_token` 값은 거부 (argv 노출 위험). `bearer_token_env_var` 로 env var 이름만 전달. 단, MCP `env` 는 여전히 argv 로 나가므로 secret 을 env 에 넣지 말 것 (issue #113, M3 에서 file-based transport 로 근본 해결 예정).
- **M2 legacy alias detection**: spawn 전에 `~/.codex/config.toml` 의 alias 목록을 스캔해서 preset/project/skillpack alias 와 교차검사. 충돌이면 `mcp:legacy_alias_conflict` run event emit (annotate-only, spawn 은 계속). 이벤트 payload shape 고정: `{ alias, source, message }`. Codex 가 leaf-merge 하므로 preset 이 `ctx7.command="npx"` 만 지정해도 user 의 `ctx7.args` 는 살아남아 silent drift — 이 경고가 그걸 가시화.
- 운영자 진단: `npm run diagnose:mcp` — spawn 없이 현재 DB 의 preset 들과 user config 의 alias 교집합을 보여줌. `--fail-on-conflict` 로 CI gate, `--json` 으로 자동화.

### Codex service tier / Fast Mode (F-1)
- **모든 codex spawn 은 `-c service_tier="fast"|"default"` 를 항상 명시 emit** — user `~/.codex/config.toml` 의 `service_tier` 를 절대 상속하지 말 것 (fast=2.5× 크레딧이 배치 run 에 silent 유출되는 M2-패턴 드리프트). codexAdapter `spawnOneTurn` 이 fresh/resume 양 경로에서 `model_instructions_file` 직후·`-` 앞에 emit. fast 시 `-c features.fast_mode=true` 동시 emit.
- tier 우선순위: `operator_instances.fast_mode` (1/0/null) → `PALANTIR_CODEX_FAST` env → standard. `resolveCodexServiceTier(fastMode, {env})` (codexAdapter export) — **null-check 를 Number 변환보다 먼저** (Number(null)===0 함정). null=env-follow.
- `startSession({ serviceTier })` 는 **문자열|함수 오버로드**: Top 은 정적 문자열(env 1회 해석), Operator 는 함수 `() => resolveCodexServiceTier(getOperatorInstance(id)?.fast_mode)` (매 턴 재읽기 → ⚡ 토글이 재spawn 없이 다음 턴 반영). Claude 어댑터는 `serviceTier` 를 무시.
- **배치는 항상 standard**: codex worker 는 `lifecycleService` extraArgs 에 `-c service_tier="default"` (판별=`resolveAdapterName(profile)`, profile.type 금지). auto-review 턴은 `conversationService` `source` plumbing 으로 `runTurn(_, { source:'auto_review' })` → codexAdapter 가 default 강제. 이 외 모든 interactive 경로는 source 없이 instance/env tier 를 따른다.
- fast 턴 실패 시 `codex:fast_unavailable` annotate (per-turn `_fastUnavailEmitted` guard, child error/exit/async-catch 3경로, fast 턴만). **v1 fallback 재시도 없음** (accepted:true 동기 반환 구조상 재시도 불안전, spec §6 기각). UI: ManagerChat ⚡ 토글은 active codex Operator 에서만, `PATCH /api/operator-instances/:id/fast-mode` **cookie-only**. migration **053** (`operator_instances.fast_mode`). spec: `docs/specs/codex-fast-mode-brief.md`.

### Model/Effort 정책 레이어 (MP, Phase 1 완료 — 설정 페이지)
- **모델·effort·tier 를 UI 에서 구조적으로 설정.** 축 = **Role×Vendor + per-Codebase(operator)** (Node×CLI 아님 — 모델은 벤더 능력이라 노드 독립). spec `docs/specs/model-policy-brief.md`. migration **061**: `model_policies`(scope_type↔scope_id CHECK[global/layer:top/layer:operator=scope_id `'*'`, codebase=projects.id], JSON-object CHECK, per-vendor UNIQUE, updated_at bump trigger), `model_policy_audit`(append-only), AFTER DELETE ON projects orphan trigger, `runs.session_model`/`session_effort`.
- **필드 단위 tri-state**: params_json 에 키 부재=inherit / 값=explicit / `'__cli_default__'`=cli-default(상속 차단; tier 는 cli-default 없음). `services/modelPolicyResolver.resolveModelPolicy`(순수) 가 scopedPolicies 를 most→least specific 순회, 필드별 독립 해석. **F-1 절대우선**: layer='worker' 또는 source='auto_review' → tier standard, model/effort null (short-circuit).
- `services/modelPolicyService`: 단일 better-sqlite3 tx CAS(`putPolicy` — validate→project-exists→INSERT(rev1, UNIQUE→409)|conditional UPDATE WHERE revision=expected(0행→재확인 409/404)→audit, 전부 원자적) + `resolveEffective`(scoped 행 fetch+resolver) + `resolveServiceTier`(**리졸버 tier 'standard'→codex 'default' 매핑 단일 지점**). `routes/modelPolicies`: GET(open)/PUT·DELETE(**cookie-only + same-origin CSRF**, changed_by 서버 derive).
- **spawn 배선**: Top(routes/manager.js) + Operator(operatorSpawnService) fresh spawn 이 `resolveEffective` 로 model/effort resolve → **`runs` 스냅샷 persist** → 어댑터 전달. **boot resume 는 스냅샷 재사용**(리졸버 재실행 금지 — thread 연속성). codexAdapter `reasoning_effort` 옵션 → `-c model_reasoning_effort` (set 일 때만). **tier=live**(fast_mode 매턴 재읽기), **model/effort=session-snapshot**(spawn 1회 고정). `modelPolicyService` 없으면(테스트 미주입) `resolveCodexServiceTier` fallback → **빈 정책 = byte-identical**.
- **worker tier 토큰 refuse**: codex worker 의 args_template 에 `service_tier`/`features.fast_mode` 토큰 있으면 fail-closed(`worker:tier_forbidden` + throw). **raw 템플릿만 스캔**(치환 전, `{prompt}` 오탐 방지) — 강제 `-c service_tier="default"`(extraArgs)는 미스캔. UI: `ModelPoliciesView`(#resources/models 서브탭, tri-state 편집 + effective-source 미리보기, cookie PUT/409 refetch). a11y/visual 게이트에 resources/models 추가.

### Worker 구조화 (MP Phase 2 — agent_profiles 구조화 model/effort)
- 워커 model/effort 를 자유문자열 `args_template` 대신 **구조화 컬럼**으로. migration **062**: `agent_profiles.model`/`reasoning_effort`(NULL=opt-out, 기존 템플릿 그대로=byte-identical). **model_policies 테이블은 워커에 미적용** — 워커는 프로필(agent_profiles) authoritative.
- `utils/agentVendor.resolveAgentVendor(command)`: 공용 command-based vendor 판별(claude/codex/opencode/gemini/other), save·spawn 공유.
- `agentProfileService.validateStructuredModelEffort(mergedProfile)`: create + update-**merged-state**(PATCH `{...existing,...fields}`) 검증. reasoning_effort=codex만(low/medium/high), model=codex+claude(비어있지 않음 ≤200, 제어문자·leading `-` 금지, 그 외 vendor 거부). **double-set = tokenizer**(`-m`/`-mX`/`-m=`/`--model`/`--model=`/`-c model=`/`-c model_reasoning_effort=` 감지, `--permission-mode`/`--mcp-config`/`--max-budget-usd` 오탐 안 함; 유니코드 escape 키는 best-effort=footgun, tier 아님). 라우트는 `req.body` 그대로 전달.
- 주입(lifecycleService, NULL=미주입=byte-identical): **codex 워커** extraArgs 순서 `구조화(-c model_reasoning_effort / -m) → 강제 service_tier="default" → baseArgs` (F-1 tier refuse 불변). **claude 워커** stream-json `spec.model = profile.model`. 워커 실행값 `runs.session_model/effort` snapshot(관측).
- **claim-전 fail-closed non-retryable backstop**: `spawnQueuedRun` 최상단(claimQueuedRun 전)에서 `validateStructuredModelEffort` 재검증 — raw-SQL 오염 profile(구조화+baked flag) → `worker:profile_invalid` + failed + 0 spawn. claim 전이라 `started_at` null → **B-lite 재시도 skip + goal isNonRetryable** 자연 성립. UI: `AgentsView` 구조화 필드(vendor-aware, NULL 계약, 새 codex 기본=structured effort). **DROP/DEFER**: claude thinking(CLI 플래그 없음)/gemini vendor(manager 어댑터 없음)/operator_profile 스코프(specialist=non-CLI backend) — 소비자 부재.

### Cost cap + pre-claim reject 인프라 (MP Phase 3 — 프로젝트 예산 상한)
- `projects.budget_usd`(기존 dormant) 활성화: `runService.sumProjectCost(projectId)`(task-linked runs `SUM(cost_usd)`, 매니저 run=task_id NULL 제외) + `spawnQueuedRun`이 **claim 전** `spent >= budget_usd` → **reject**(never silent downgrade). **NULL=opt-out**(byte-identical), 0/음수도 cap(spent≥0 차단), **lookup 에러 fail-open**(예산체크 버그가 작업 중단 못 함) + reject write는 catch 밖.
- **pre-claim 거부 단일 경로 `runService.rejectQueuedRun(runId, {reason, retryCount})`** (P2 profile-invalid backstop + P3 budget 공유): 원자 CAS `UPDATE runs SET status='failed', retry_count=MAX(retry_count,?), non_retryable=1, ended_at=datetime('now') WHERE id=? AND status='queued'`. **queued-only**(멱등, running/terminal run 안 건드림, 재호출 no-op), retry_count는 **MAX**(기존 attempt 안 낮춤), terminal이라 ended_at 스탬프. won 이면 run:status/run:ended envelope emit.
- **non-retryable 계약**: migration **063** `runs.non_retryable`(durable). `goalVerdictService.isNonRetryable = failed && (!started_at || non_retryable)`. B-lite는 retry_count=MAX로 skip. **왜 started_at만으론 부족**: goal retry-child는 queued 생성 시 이미 `goal_active=1`이고 `failed→queued` requeue가 started_at을 보존 → started_at 휴리스틱만으론 goal이 budget 내 재시도. durable non_retryable가 이 반례를 종결(Codex 5R 검토, R3에서 컬럼 도입). node feasibility 검증은 defer(워커 모델에러=executionEngine 출력 경로).

### Goal Delegation — G1 (프롬프트/파서/캡처, 후속 phase 예정)
- **G 트랙**은 워커를 goal 계약(목표+수락기준+검증+반복예산)으로 위임 — spec `docs/specs/goal-delegation-brief.md`. **G1 은 캡처·파싱 기반만** (verdict 루프/verify_checks/workspace/judge/UI 는 G2~G5). migration **054**: `tasks.goal_enabled`/`goal_max_attempts` + `runs.goal_report`/`final_output`.
- `services/goalPrompt.compileGoalPrompt` — 순수·결정적 컴파일러. `spawnQueuedRun` 이 goal-enabled 태스크의 worker prompt 를 이걸로 교체 (`run.prompt` 는 `[ADDITIONAL INSTRUCTIONS]` 로 verbatim 보존). **non-goal 완전 불변.** verifyCheckName/attemptFeedback 은 G2/G3 용 forward-compat 훅 (null 이면 inert, attempt 는 G1 항상 1).
- `services/goalReport.parseGoalReport` — ` ```palantir-goal-report {json}``` ` fenced block 파서, **never-throws** (부재/malformed→null, 마지막 fence 우선). 파싱 실패는 run 실패 아님.
- `lifecycleService.captureGoalOutput` — run terminal 시 goal-enabled worker 만 `runs.final_output`(64KB byte-cap) + `runs.goal_report` persist + `harvest:goal_capture` emit. **annotate-only/never-throws, harvestService 존재와 독립** (없어도 캡처). 출력 소스 우선순위: **file-backed tee**(§5k-2 — 로컬 SubprocessEngine write-stream / TmuxEngine `pipe-pane`, `outputLogPath` opt-in, `runtime/goal-output/<runId>.log`) → `channel.getOutput`(원격/in-process fallback). tee 는 goal 로컬 run 만, cleanup 이 unlink. **run terminal 재구조화**: `run:ended` 구독자가 completed/failed worker 에 capture→(harvest if service)→cleanup, cleanup 분기(harvest→runtime files / no-harvest→worktree)는 pre-G1 불변.
- **G2 (verify_checks + §6 + workspace + deliverable + Gate 1)**: migration **055** verify_checks(kind command|artifact discriminated union, created_by human|operator provenance, 표현식 unique index, command→project_id trigger) + tasks(verify_check_id/goal_judge_enabled/deliverable_json) + runs(acceptance_json/goal_workspace_path/deliverable_state). **§6 보안 핵심 — `goalMode.goalFeatureActive()`** = PALANTIR_GOAL_MODE=1 + PALANTIR_PM_TOKEN 분리(else fail-closed). **모든 goal surface(prompt·workspace·acceptance·verify_check 라우트)가 이 단일 게이트로 lock-step** — false 면 goal_enabled 태스크는 일반 태스크로 동작(주입: lifecycle/harvest/route 에 `goalFeatureActive`, app.js options 로 테스트 override). `buildManagerSpawnEnv({scrubHumanToken})` = goal 모드 시 Operator spawn env 에서 `PALANTIR_TOKEN` 제거+PM만(operatorSpawnService+boot resume, 비-goal byte-identical). **provenance = `req.auth.method` 에서만 derive(절대 request body 금지)** — command CRUD/할당 cookie-only, operator 가 human check spec 수정 시 downgrade. verify_check 할당은 `taskService.assignVerifyCheck` 전용경로(verify_check_id 는 TASK_UPDATABLE 제외, cross-project guard). goal workspace(§5k-1) = deliverable 모드(git workspace 없음) 격리 `runtime/goal-workspaces/<runId>`, **생성실패/remote=fail-closed non-retryable**. Gate 1 acceptance(§5f, harvestService, `goalAcceptance.runAcceptance`) = command(harvest test runner 재사용)/artifact(pure eval) 실행→`runs.acceptance_json`+`harvest:acceptance`. **verdict/전이는 G3 — G2 는 관측만**. deliverable 수확(§5k-2) 순서 enumerate→acceptance(live)→bundle. **enumerate/read/copy 전부 하드 바운드**(opendirSync 스트리밍+visit/stack cap, size-first lstat, `hashCappedFile`/`copyCappedFile` descriptor 기반 TOCTOU-safe capped). `artifactCheck`(선언적, symlink 미추적, isWithinRoot). PM리뷰(`formatHarvestSummary`) Gate1 블록+"전이 강제 G3" 명시. codex 계획 R1 NO-GO(2B) + 최종 diff R1(2B)→R2→R3→R4→R5 수렴(bounded-I/O 강화 반복). spec `docs/specs/goal-delegation-brief.md` §5a/5f/5k/§6.

### Manager Session (Codex stateless + thread resume) — v3 Phase 3a
- `codex exec --json` 으로 첫 turn, 이후 턴은 `codex exec resume <thread_id>` — Codex 는 stateless 어댑터 (매 턴마다 subprocess 생성/종료)
- system prompt 는 `-c 'model_instructions_file="<path>"'` — stable 파일 경로 + stable 내용이면 `cached_input_tokens` hit
- `codexAdapter.startSession` 의 `resumeThreadId` 옵션: `operator_instances.thread_id` 가 있으면 seed 해서 첫 runTurn 이 바로 resume 으로 감. 없을 때만 `project_briefs.pm_thread_id` bridge 를 읽음
- `onThreadStarted(threadId)` 콜백: `thread.started` 이벤트 (또는 resume 시 synchronous) 때 정확히 한 번 호출 — `operatorSpawnService` 가 이걸로 `operator_instances.thread_id` 를 persist
- **brief 은 static system prompt 에 bake** — 절대 seed runTurn 으로 넣지 말 것 (codex 어댑터는 단일-turn 가드가 있어서 back-to-back runTurn 이면 두 번째 turn 이 "previous turn still running" 으로 실패)

### v3 Manager 계층 (top / operator slots)
- `managerRegistry` 가 `top` / `operator:<slot>` 슬롯별 단일 source. live canonical slot 은 `operator:oi_*`, legacy alias 는 resolver 로 수렴한다. `setActive` / `probeActive` / `clearActive` / `snapshot` / `onSlotCleared` 리스너.
- `conversationService` 가 모든 send 경로의 단일 엔트리. peek-then-drain parent-notice 큐 (race-safe splice, myId fence).
- **lock-in #2 (Phase 1.5)**: 자식 타깃 사용자 메시지 = 무조건 부모 staleness notice. 의도 분류 금지.
- `resolveParentSlot(parentRunId)` 로 worker 의 parent 가 활성 Top 인지 활성 Operator 인지 판정 → 해당 슬롯에만 notice 큐잉.
- `operatorCleanupService.reset` / `.dispose` 는 **fail-closed**: `disposeSession` throw 시 레지스트리/brief/run 상태를 유지한 채 re-throw (Phase 3a R2).
- `run.is_manager=1` 이면 lifecycleService health loop 가 건너뜀. Top/Operator 양쪽 모두 이 가드 하나로 커버.

### Operator↔Codebase Refs (watch-list) — W-P0~W-P7
- Operator live identity 는 instance 기준: `operator:oi_*`. `operator:<projectId>` 는 외부 진입/기존 데이터 호환용 **legacy dual-read alias** 로 계속 유지하며, 단일 resolver 가 해당 codebase 의 primary ref instance 로 수렴시킨다.
- `operator_codebase_refs`: `primary` = codebase 당 최대 1 + instance 당 최대 1(라우터 기본 수신자, auto-review fallback, cwd 기준). `reference` = 다수 허용(컨텍스트 참조 + watch/favorite; **dispatch 권한 아님** — 공용 풀 favorite 모델로 재정의됨, `docs/specs/codebase-pool-memory-axes-brief.md` §4 LOCKED. attribution 은 refs 가 아니라 pm_run_id 파생. 현 reconciliation 은 primary-only, A1 에서 favorite 정합 예정). codebase 는 Operator 를 소유하지 않고 Operator instance 가 codebase refs 를 가진다.
- Attribution 은 서버 derive 만 신뢰: `/execute` 는 `pm_run_id` 로 operator instance 를 찾고, `runs.operator_instance_id` / `dispatch_audit_log.operator_instance_id` 에 기록한다. client/body 의 instance 주장은 권한 근거가 아니다.
- Auto-review 수신자 체인: ① worker 를 spawn 한 operator instance → ② worker codebase 의 primary instance → ③ Top. **watcher broadcast 금지**.
- Thread 상태 소유자는 `operator_instances` (`thread_id`, `pm_adapter`, `node_id`, `cwd`, `source_generation`, `source_hash`, `workspace_path`). `project_briefs.pm_thread_id` 계열은 W-P1 이전 데이터용 read-only bridge 로만 읽는다.
- Memory 주입은 turn context 기준: codebase-specific turn 은 해당 Workspace, generic turn 은 User/Profile + watch-list 요약, auto-review turn 은 worker codebase Workspace 만. ledger 는 실제 선택 주입된 owner 만 기록한다. (⚠ **현 코드**: 상주 오퍼레이터 generic-turn 주입엔 profile/watch-list 요약이 아직 없고 workspace(+조건부 user)만 — profile 축·watch-list 요약·turnMode 계약은 후속 `docs/specs/codebase-pool-memory-axes-brief.md` B1/B2 에서 배선.)
- `projects.pm_enabled` / `preferred_pm_adapter` 는 현재 spawn 정책 소스다. instance 로 이전하는 것은 별도 설계 결정이며 W-P7 cleanup 에서 제거하지 않는다.

### Dispatch audit & router (v3 Phase 4/6/7)
- Operator 이 definitive claim 을 만들 때마다 `POST /api/dispatch-audit` 로 기록 → `reconciliationService` 가 DB truth 와 비교. incoherent 시 flag + kind (`pm_hallucination`, `user_intervention_stale`, …). Annotate-only — **절대 block 안 함** (recordClaim 은 never throws except on hard envelope binding errors).
- 클라 `useDispatchAudit` hook 이 GET 폴링 + `dispatch_audit:recorded` SSE 구독. `requestSeqRef` 모노토닉 토큰으로 stale-response fence.
- `routerService.resolveTarget({text, currentConversationId})` 3-step:
  1. `@<name|id>` prefix → codebase primary Operator instance(`operator:oi_*`) + prefix strip
  2. 유효 `currentConversationId` → 그대로 유지
  3. (현재 context 없을 때만) 프로젝트명 exact-insensitive 매칭; primary 없음/다중 매칭 = no-primary/ambiguous
  4. default (`top`)
- **envelope binding**: `pmRunId` 는 must-exist + `is_manager=1` + Operator conversation resolver 통과. `taskId` / `run_id` 는 해당 instance refs 안이어야 하고, `selectedAgentProfileId` must exist. incoherence 는 annotate-only, hard envelope 위반만 400.

### SSE semantic envelope (v3 Phase 5) — additive
- `runService` 가 `createRun` / `updateRunStatus` / `markRunStarted` 에서 `{ run, from_status, to_status, reason, task_id, project_id }` 를 emit. Pre-Phase 5 의 `{ run }` 구독자는 그대로 동작.
- `lifecycleService` 의 `run:completed` / `run:needs_input` 도 동일 envelope + `reason` + (priority alert 의 경우) `priority: 'alert'`.
- **중요**: `useSSE` 의 channels 배열은 hard-coded. 새 SSE 채널 추가 시 반드시 `server/public/app/lib/hooks/sse.js` 의 channels 배열에도 추가할 것. Phase 5/7 에서 `run:needs_input` / `dispatch_audit:recorded` 를 까먹어 dead code 되는 회귀가 있었음.
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

### Project Repo-Defined (git repo 프로젝트, `PALANTIR_PROJECT_REPO` — 기본 ON, `=0` 으로 disable)
- 프로젝트를 folder-bound(`projects.directory`) 에서 **repo-defined**(git repo/ref/subdir)로 확장. 폴더는 각 노드가 실행 시점에 **materialize**(clone/fetch/worktree)하는 파생물. `projects.source_type ∈ {legacy_directory, git}`. spec `docs/specs/project-repo-defined-brief.md` (PR #323~#331, 전 구현 완료). **flag 기본 ON**(`repoFeatureEnabled()` = `PALANTIR_PROJECT_REPO !== '0'`, 5 정의: lifecycle/materialization/harvest/runService/repoOperatorThread) — git 프로젝트가 실제 materialize+실행. **`PALANTIR_PROJECT_REPO=0` 으로 rollback**(git run 은 fail-closed `run:repo_materialize_unavailable`). legacy_directory 는 flag 무관 불변(git 프로젝트 0개면 default-on 도 런타임 무영향).
- **상태 머신**(worker): `queued → materializing → queued(ready) → running`. `materializing` 은 worker 슬롯 미소비(countRunning* running-only) → 느린 clone 이 실행 큐 무영향. `started_at` 은 worker claim 에서만.
- **`projectMaterializationService.ensureWorkspace`**: single-flight lease(`project_materialization_leases`, project+node+source_generation, partial-unique CAS + heartbeat + stale steal) 로 cache repo 는 clone 1회 공유, per-run worktree 는 **attempt-token(materialize_claim_token) 격리**. materializing 떠나는 모든 전이 + worktree/ref 파괴는 token+state CAS(지연 attempt 가 winner 리소스 못 건드림). fs 부작용은 `executor` 경유(로컬=nodeExecutor / 원격=remoteSshExecutor, `move` 포함). 로컬·원격 통일.
- **원격(pod) materialize**: `canMaterializeOnNode` 원격 허용, 경로=`exposed_roots[0]/.palantir-*`, git argv 전부 옵션 종결자(`--`/`--end-of-options`), write-전 canonical 강제(assertWithinRoots), GIT_TERMINAL_PROMPT=0 + GIT_SSH_COMMAND BatchMode. **git auth=node-local only**(controller token 반출 0; askpass 2순위 미구현). 실 Pi 검증됨.
- **consumer**: `spawnQueuedRun` git → cwd=`resolveMaterializedRepoCwd`(workspace_path+subdir). MCP(PR4) = `mcp_config_source ∈ {legacy_control_plane_path, repo_relpath}`(repo_relpath 은 원격 executor.readFile). Operator(PR5) = materialized cwd + live source-change 409 reset guard(`repoOperatorThread`). harvest(PR5c) = materialized 는 run.node_id executor 로 diff(base=resolved_commit)+test+worktree remove.
- **watch**: git argv 는 반드시 옵션 종결자(repoUrl=`--upload-pack=` smuggling 방지). source-generation 필드(repo_url/ref/subdir/mcp_config_source/relpath) 변경 = live Operator 있으면 409. harvest 는 여전히 annotate-only/never-throws/exactly-once run:harvested.

### Frontend
- Preact + HTM (ESM) — `server/public/vendor/`에 번들됨, CDN 의존 없음
- 빌드 파이프라인 없음. `app.js`는 App/mount 셸. 실제 뷰/모달은 `app/components/` ESM 모듈에 있음
- `server/public/app/main.js` 는 최소 부트스트래퍼 (~14줄): `configureMarked()` + `import('../app.js')`. window bridge 없음 (P9에서 전부 제거)
- 모든 ESM 컴포넌트는 vendor/ 에서 직접 import (`import { h } from '../../vendor/preact.module.js'` 등)
- 해시 라우팅: `#dashboard`, `#manager`, `#board`, `#projects`, `#agents`, `#skills`, `#presets`, `#mcp-servers`
- **클라이언트 async fence 패턴** (Phase 6/7): id-change 시 `setRun(null); setEvents([])` 동기 reset + await 이전 `myId = conversationId` 캡처 + commit 전 `activeIdRef.current === myId` 비교. `useDispatchAudit` 는 `requestSeqRef` 시퀀스 토큰.

### DB
- SQLite WAL 모드. `palantir.db` (gitignored)
- 서버 시작 시 `db/migrations/` 자동 실행 (현재 001~021)
- `better-sqlite3` 동기 API 사용
- `runs.manager_layer`, `runs.conversation_id` (009), `dispatch_audit_log` (010), `project_briefs` (008), `worker_presets` (018), `tasks.preferred_preset_id` index (019), `mcp_server_templates.updated_at` (020 — RunInspector 가 preset snapshot 캡처 이후 template 변경을 drift 로 감지하기 위함), `skill_packs.origin_type` enum CHECK trigger (021 — `bundled|url|manual|import`) 등 v3 필드 존재

## Style Guidelines

- 한국어 사용 (코드 주석/변수명은 영어)
- Express 5 (async 에러 자동 캐치)
- 테스트: Node.js built-in test runner (`node --test`), supertest로 HTTP 테스트
- 새 API 라우트 추가 시 `app.js`에서 `app.use()` 등록 필요

## Security

- **바인딩 정책 (PR1 / NEW-S1 + P0-1)**: 기본 `127.0.0.1`. `PALANTIR_TOKEN` 이 설정되면 자동으로 `0.0.0.0` 으로 승격. 사용자가 `HOST=` 를 명시하면 그대로 사용하되, 토큰 없이 `HOST=0.0.0.0` 이면 위험 경고를 찍음. 토큰 미설정 시 auth 비활성 + `[security] No PALANTIR_TOKEN set — auth disabled.` 로그. 이전(항상 0.0.0.0) 동작은 breaking change — 기존 배포는 `HOST=0.0.0.0` 을 명시하거나 토큰을 설정해야 같은 바인딩을 얻는다.
- **브라우저 쿠키 인증**: `PALANTIR_TOKEN` 이 설정된 경우 브라우저는 `palantir_token` HttpOnly 쿠키로 인증한다 (EventSource 는 커스텀 헤더 전송 불가 → Bearer 만으로는 SSE 가 구조적으로 막혔던 문제를 수정). 사용자는 `/login.html` 에서 POST 폼으로 토큰을 입력하고, 서버가 쿠키를 set 한 뒤 sanitized `next` 경로로 리다이렉트한다. 토큰은 URL 에 절대 노출되지 않음 (초기 PR1 draft 의 `?token=` 부트스트랩은 Codex review 에서 access-log leak 블로커로 지적되어 제거). `apiFetch` 는 401/403 응답을 받으면 `/login.html?next=…` 로 bounce. CLI / 테스트는 `Authorization: Bearer` 헤더 사용. Bearer 경로가 invalid 면 cookie 로 fallback 하지 않음 — 명시적 실패.
- **CSP self-host**: `marked` / `DOMPurify` / Inter font 는 `server/public/vendor/` 에서 직접 서빙. CSP 는 `script-src 'self'; connect-src 'self'; font-src 'self'` (외부 CDN 의존 0개 — googleapis/gstatic/jsdelivr 전부 제거).
- **세션 path traversal 방어**: `sessionService.createSession` + `trashService.restoreTrashedSession` 에서 `isWithinRoot()` 검증. `routes/sessions.js` 에서 route 레벨 `hasInvalidSessionProjectId` 이중 방어.
- **SSRF 방어**: 외부 URL 요청 (Skill Pack URL install 등) 은 반드시 `services/ssrf.js` 경유. 내부 IP 범위 차단.
- **TLS 검증**: `opencodeService.js` 의 `NODE_TLS_REJECT_UNAUTHORIZED` 기본값 `'1'` (secure). 운영자가 명시적 `'0'` 설정 시 override 가능.
- 에이전트 명령어 allowlist 제한 (임의 명령 실행 불가)
- `.claude-auth.json`은 절대 커밋 금지
- CWD 검증: `/etc`, `/var`, `/usr` 등 위험 경로 차단

## Things to Watch Out For

- `server/public/app.js`는 ES module (P8-2). NavSidebar + App + mount 만 남은 셸 — 뷰/모달 수정은 `app/components/`, hooks 수정은 `app/lib/hooks/` 디렉토리를 직접 탐색. NAV_ITEMS 는 `app/lib/nav.js` 에 분리 (P9-2)
- `useSSE` channels 배열이 hard-coded (`app/lib/hooks/sse.js`) — 새 SSE 채널 추가 시 반드시 이 배열에도 추가. Phase 5/7 에서 까먹어 "핸들러는 등록됐지만 실제 subscribe 안 됨" 회귀가 있었음
- `ManagerView.js`는 thin layout shell (P8-5) — 채팅 로직은 `ManagerChat.js`, 세션 그리드는 `SessionGrid.js`에 있음
- `SessionsView.js`는 thin layout shell (P9-4) — 세션 목록은 `SessionList.js`, 대화 패널은 `ConversationPanel.js`에 있음. `initLegacySessions` 는 삭제됨
- `app/main.js` 는 최소 부트스트래퍼 (~14줄) — window bridge 없음. 모든 컴포넌트는 vendor/ 에서 직접 import
- `operatorSpawnService` 에서 **seed runTurn 금지** — brief 은 static system prompt 에 bake. Codex 어댑터는 back-to-back runTurn 에서 "previous turn still running" 을 던진다
- `operatorCleanupService` 는 fail-closed — dispose 실패 시 상태를 유지한 채 re-throw. 호출자 (DELETE /api/projects/:id, /reset) 가 502 로 거절해야 함. 절대 swallow 하지 말 것
- `reconciliationService.recordClaim` 의 envelope binding 은 strict — `projectId`/`taskId`/`pmRunId`/`selectedAgentProfileId` 전부 존재+소유 검증. hard input error 는 400 throw, incoherence 는 flag 로만 표시 (annotate-only 원칙: Operator drift 는 기록만, block 안 함)
- **Watch-list legacy 계약**: `operator:<projectId>` dual-read alias 는 외부 진입 호환 계약이므로 임의 제거 금지. 제거 여부는 별도 phase 에서 운영 데이터로 판정한다.
- **Bridge fallback 기준**: `project_briefs.pm_thread_id` bridge 는 instance ROW 부재가 아니라 instance thread **STATE 부재**(`operator_instances.thread_id` null) 때만 fallback. `project_briefs` 로 dual-write 하지 말 것.
- **watchlist_version bump**: refs 변경 bump 는 live Operator invalidation 신호다. non-live instance 는 next spawn 에서 refs 를 다시 읽으므로 live-only bump 계약을 유지한다.
- **Auto-review broadcast 금지**: worker harvest 는 spawn instance → primary instance → Top 단일 수신자 체인만 허용. reference watcher 전체 발송은 retry/T5/breaker 중복을 만든다.
- **`oi_` parser 계약**: `parseProjectConversationId('operator:oi_*')` 는 null 이어야 한다. project join 이 필요하면 resolver 의 `primaryProjectId` 또는 서버 snapshot 의 `legacyConversationId` 를 사용한다.
- **Graceful shutdown**: `index.js` 가 SIGINT/SIGTERM → `app.shutdown()` 연결 (10s forced exit). `app.shutdown()` 은 매니저 dispose + lifecycle monitor 중단 + DB 닫기. 테스트에서는 `app.shutdown()` 직접 호출
- Manager 프로세스는 stdin이 닫히면 종료됨 — stdin pipe를 열어두어야 함 (Claude adapter)
- `result` 이벤트 처리 시 Manager/Worker 분기 확인 (`proc.isManager`)
- Health check가 Manager를 잘못 죽이지 않는지 `lifecycleService.js`의 `is_manager` 가드 확인
- `conversationService` 의 peek-then-drain 은 race-safe: `commitDrainParentNotices(runId, count)` 가 `splice(0, count)` — 절대 `pendingNotices.delete(key)` 로 돌리지 말 것 (runTurn 중 도착한 notice 가 소실됨)
- `managerRegistry.onSlotCleared` 리스너가 3 경로 (`clearActive`, `probeActive` dead detection, `setActive` replacement) 모두에서 발화. 이게 notice 큐 scrub 의 유일한 hook
- **Codex MCP flatten (M1)**: `-c mcp_servers=<JSON>` 재도입 금지. 무조건 `flattenMcpToCodexArgs` 경유. 테스트 assertion 도 leaf-level dotted path 검사여야 함 (`/^mcp_servers\.<alias>\.<key>=/`)
- **M2 legacy scan**: 새 SSE channel 또는 event consumer 만들 때 `mcp:legacy_alias_conflict` payload shape `{ alias, source, message }` 를 확장하지 말 것 — M3 (file-based transport) 때 event 자체가 사라지거나 의미 바뀔 수 있음. cardinality 규율 유지
- **`preset-route.test.js`**: 테스트에서 `createApp` 호출 시 반드시 `authToken: null` 명시. 안 넘기면 `process.env.PALANTIR_TOKEN` 으로 fall back 해서 sibling test 가 token 설정한 상태면 401 flake 발생 (PR #117 에서 근본 해결)
- **K-2 라이트/다크 토큰 lock-step (테스트가 막는 계약)**: `tokens.css` 의 `:root[data-theme="light"]` 블록과 `@media (prefers-color-scheme: light) :root:not([data-theme])` 블록은 중복 정의 (CSS 가 selector 를 media 경계 가로질러 공유 못 함). **K-3β (PR #160) 부터 `boot.smoke.test.js` 의 `tokens.css light blocks lock-step` 테스트가 두 블록의 token key set + value 일치를 자동 검증** — 새 의미 토큰을 한 쪽에만 추가하면 빌드 fail. alias-only 토큰 (`--field-bg: var(--bg-base)` 등) 은 base 변수가 light 에서 swap 되어 자동 propagate 되므로 light 블록 명시 불필요 (테스트는 양쪽 블록 안에 명시된 토큰만 비교). 새 컴포넌트가 색을 인라인 하드코딩 하면 라이트 모드 회귀 — 반드시 `var(--<token>)` 사용. K-2 launch 직후 후속 후보는 `docs/backlog.md` Ready 섹션 참고
- **`theme-init.js` 위치 고정**: `server/public/theme-init.js` 는 반드시 `<head>` 에서 `tokens.css` 보다 먼저 로드. ESM 으로 옮기거나 defer 붙이면 FOUC 회귀. CSP `script-src 'self'` 유지를 위해 인라인 `<script>` 화 금지
- **`login.html` 로직은 외부 `login.js` 로만**: CSP 가 `script-src 'self'`(unsafe-inline/nonce 없음) 라 login.html 의 **인라인 `<script>` 는 브라우저가 차단** → submit 리스너 미부착 → Sign in 이 native GET(`?token=`) 으로 새면서 인증 자체가 안 됨(맞는 토큰도 "안 됨"). 폼 핸들러(sanitizeNext redirect 가드 포함)는 반드시 `server/public/login.js`(same-origin 파일) 에 두고 `<script src="login.js">` 로 로드. **절대 인라인화 금지** (theme-init/app.js/vendor 와 동일 규칙). `auth.test.js` 가 login.js 에서 POST·sanitizeNext 존재를 검증
- **`mcp_server_templates` 와 preset snapshot drift**: preset snapshot 은 template **id 만** 저장. body 변경은 `mcp_server_templates.updated_at` (migration 020) 으로 감지 — RunInspector 가 snapshot 시점 vs current `updated_at` 비교. boot seed upsert 는 내용 실제 변경 시에만 `updated_at` 을 bump (no-op 변경으로 false drift 만들지 말 것)
- **K-4 axe-core a11y 가드 (런타임)**: `npm run test:a11y` 가 14 routes × 2 themes × 2 viewports = 56 시나리오에서 axe `wcag2a/wcag2aa/wcag21a/wcag21aa` 룰 검증. **critical/serious/moderate violation → fail (gate)** — moderate 는 #367(2026-07-13, 사용자 lock-in)에서 report-only→gate 승격(위반 0 도달 후). minor 만 report-only. **신규 surface 의 contrast violation 은 waiver 불가** — 즉시 fix 필수. `color-contrast` waiver 는 K-4 baseline transitional kind 만 허용 (`expiresAt ≤14일` + `ownerSurface` + `followupRef` + `approvedBy` 메타데이터 필수). spec: `docs/specs/k4-wcag-a11y-automation-brief.md`. waiver 파일: `server/tests/e2e/a11y-waivers.json` (만료/unused waiver 모두 fail). K-4-followup 시리즈 (#164-167 + #365 fleet-strip contrast + #366 card `<h2>` heading + #367 moderate gate) 로 baseline 0 종결 — 신규 contrast/moderate 회귀는 waiver 우회 불가.
- **K-5 시각 회귀 가드 (런타임)**: `npm run test:visual` 이 **74 시나리오**(56 route[14 routes × 2 themes × 2 viewports] + 4 interactive-state[#368: NavSidebar hover 툴팁 + keyboard-focus skip-link, 고정 sidebar CLIP] + 4 modal[#369: Command Palette + New Agent modal 열린 상태, element-scoped dialog] + 2 drawer[#370: DriftDrawer 열린 상태, **data-gated 라 `page.route` 로 drift API mock**+`.drift-row-time` mask] + 2 inspector[#371: RunInspector 완료 run Output 탭, `**/api/runs**` catch-all mock+`.run-status-started` mask] + 6 form-modal[#372: New Codebase/MCP/Task 폼 모달, Modal primitive aria-labelledby dialog, mock/mask 불요])에서 Playwright screenshot diff 검증. baseline 위치: `server/tests/e2e/visual.spec.js-snapshots/<name>-chromium-darwin.png` (macOS arm64 lock-in, single-developer 환경). threshold `maxDiffPixels: 100, threshold: 0.2`. dynamic surface (timestamp / claude-session-item / triage-feed children / status badge) 는 mask 처리. animation/scrollbar 안정화 page.addStyleTag 로 inject. **interaction/modal/drawer 상태 캡처 원칙: out-of-bbox 어포던스(툴팁·focus ring·다이얼로그 backdrop)는 고정 CLIP 또는 element-scoped 다이얼로그 스냅샷, `.focus()` 는 `:focus-visible` 미매칭→keyboard Tab, data-gated 드로어는 `page.route` API mock 으로 결정적 오픈, `toBeVisible()` 계약으로 열기실패 loud fail.** interactive/modal/drawer 는 codex-goal 위임 구현(격리 worktree)+호스트 외부검증(결정성 2회+baseline 육안+Themis). spec: `docs/specs/k5-visual-regression-brief.md`. baseline 갱신 PR 은 commit body 에 사유 명시 + 코드 변경과 같이.
