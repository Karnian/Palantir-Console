# Agent Guide

Palantir Console — AI 코딩 에이전트를 3계층(Main Manager → PM → Worker)으로 운영하는 중앙 관제 허브. Main Manager가 여러 프로젝트와 PM을 총괄하고, PM이 프로젝트 내 워커들을 관리하며, Worker가 실제 코딩 작업을 수행한다. 상세 내용은 `CLAUDE.md` 와 `docs/specs/manager-v3-multilayer.md` 참고. 이 파일은 빠른 오리엔테이션 용.

## Quick Start

```bash
npm install
npm start          # http://localhost:4177
npm test           # node --test (792 tests at Phase 10G merge)
npm run test:e2e   # Playwright e2e
```

## Architecture (v3 Phase 0~10G merged)

Express.js 5 + SQLite (WAL) + Preact/HTM (ESM, no build) + Inter font (self-hosted).

```
server/
  index.js              — 진입점 (포트, auth, graceful shutdown)
  app.js                — Express 조립 (라우터/서비스/미들웨어)
  db/migrations/        — 001~019 (v3: 006~010 PM/audit, 013~017 skill packs,
                          018 worker_presets, 019 preset idx)
  middleware/           — auth, errorHandler, asyncHandler, validate
  routes/
    manager.js          — Top/PM /api/manager/* + pm/:id/message + /reset
    conversations.js    — /api/conversations/:id/* (top|pm:<id>|worker:<id>)
    router.js           — /api/router/resolve (Phase 6 3-step matcher)
    dispatchAudit.js    — /api/dispatch-audit (Phase 4, annotate-only)
    auth.js             — POST /login, POST /logout (쿠키 인증)
    workerPresets.js    — Worker Preset CRUD (Phase 10B)
    skillPacks.js       — Skill Pack CRUD + gallery (Phase 10G)
    tasks.js runs.js projects.js agents.js events.js
    sessions.js trash.js fs.js usage.js claude-sessions.js
  services/
    managerAdapters/    — claudeAdapter, codexAdapter, eventTypes, index (팩토리)
    providers/          — anthropic, claude-code, gemini (provider registry)
    streamJsonEngine.js — Claude stream-json 엔진
    executionEngine.js  — TmuxEngine / SubprocessEngine (worker)
    lifecycleService.js — Health check, 상태 전환
    managerRegistry.js  — top/pm 슬롯 단일 source + onSlotCleared
    conversationService.js — 1급 conversation + parent-notice router
    pmSpawnService.js   — PM lazy spawn (brief-in-system-prompt)
    pmCleanupService.js — PM 단일 owner teardown (fail-closed)
    routerService.js    — 3-step @mention matcher
    reconciliationService.js — dispatch audit (annotate-only)
    runService.js       — Run CRUD + Phase 5 semantic envelope
    presetService.js    — Worker Preset CRUD + snapshot drift (Phase 10B)
    skillPackService.js — Skill Pack 설치/제거/resolve (Phase 10G)
    registryService.js  — Skill Pack 갤러리 레지스트리
    ssrf.js             — SSRF 방어 (내부 IP 차단)
    taskService.js projectService.js projectBriefService.js
    agentProfileService.js managerSystemPrompt.js authResolver.js
    eventBus.js eventChannels.js worktreeService.js
  data/
    skill-pack-registry.json — Skill Pack 갤러리 레지스트리
  public/
    app.js              — Preact SPA 셸 (~320줄, ESM)
    app/main.js         — ESM 부트스트래퍼 (~14줄), window bridge 없음
    app/lib/            — hooks.js (barrel), api.js, nav.js, a11y.js, markdown.js,
                          format.js, dueDate.js, toast.js, notifications.js
    app/lib/hooks/      — routing, utils, sse, data, conversation, dispatch, manager
    app/components/     — 22 ESM 컴포넌트 (ManagerChat, SessionGrid, RunInspector,
                          PresetsView, SkillPacksView, CommandPalette, DriftDrawer 등)
    styles/             — fonts.css + tokens.css
    vendor/             — Preact/HTM ESM+UMD + marked + DOMPurify + Inter woff2
  tests/                — 53 테스트 파일 + e2e/ 2개 + fixtures/ + helpers/
```

## Key Concepts (v3)

- **Conversation identity**: 모든 채팅 surface 가 1급 식별자를 가짐 — `top`, `pm:<projectId>`, `worker:<runId>`. `conversationService` 가 단일 엔트리.
- **PM lazy spawn**: 첫 `pm:<projectId>` 메시지에서 `pmSpawnService.ensureLivePm` 이 Codex 어댑터로 run 생성 + brief 을 static system prompt 에 bake. 이후 턴은 thread resume.
- **Parent-notice router** (lock-in #2): 자식 타깃 사용자 메시지 = 무조건 부모 staleness notice. worker→Top (Phase 1.5), worker→PM + PM→Top (Phase 2). 의도 분류 금지.
- **Single-owner PM cleanup**: `pmCleanupService.reset` / `.dispose` 가 유일한 종료 경로. fail-closed — dispose 실패 시 상태 유지 + re-throw.
- **Dispatch audit** (annotate-only): PM claim 을 `POST /api/dispatch-audit` 로 기록 → `reconciliationService` 가 DB truth 와 비교해 `incoherence_flag` 만 남김. 절대 block 안 함.
- **Router 3-step**: `@<name|id>` → current context → name fuzzy → default. 서버 함수 + HTTP wrapper.
- **SSE semantic envelope**: `run:*` 이벤트가 `from_status/to_status/reason/task_id/project_id` 를 additive 로 운반. `run:status` 는 pure reload, `run:needs_input`/`run:completed` 가 priority alert.
- **Worker Preset** (Phase 10B~10G): agent + plugin refs + env 를 프리셋으로 묶어 재사용. task 에 `preferred_preset_id` 로 연결. `presetService` 가 CRUD + snapshot drift 비교 (file hash 기반).
- **Skill Pack** (Phase 10G): 재사용 가능한 명령/스킬 팩. 갤러리 레지스트리에서 검색/설치, URL 직접 설치 지원. `skillPackService` + `registryService`.

## Important Notes

- Manager 에서 `--input-format stream-json` + `-p` 플래그 조합은 동작하지 않음 (Claude). 초기 프롬프트는 반드시 stdin 으로 전송
- **Codex 어댑터는 stateless** — back-to-back runTurn 은 "previous turn still running" 으로 실패. brief 은 seed runTurn 이 아니라 system prompt 에 넣는다
- **`pmCleanupService` 는 fail-closed**. dispose 실패 시 절대 swallow 하지 말 것
- **`useSSE` channels 배열은 hard-coded** (`app/lib/hooks/sse.js`) — 새 SSE 채널 추가 시 반드시 이 배열에도 추가. Phase 5/7 에서 이 회귀가 있었음
- Manager 의 result 이벤트는 "한 턴 끝남" 이지 "세션 끝남" 아님. completed 로 전환하지 않음
- UI 는 CDN 없이 `server/public/vendor/` 에 번들된 Preact/HTM + marked + DOMPurify 사용. CSP: `script-src 'self'`
- `.claude-auth.json` 은 gitignore. 민감 정보 커밋 금지
- 해시 라우팅: `#dashboard`, `#manager`, `#board`, `#projects`, `#agents`, `#skills`, `#presets`
- 환경변수: `PALANTIR_DEFAULT_PM_ADAPTER`, `PALANTIR_CODEX_MANAGER_BYPASS`, Claude/Codex auth 키들

## 관련 문서

- `CLAUDE.md` — 상세 컨벤션 + 자율 모드 working style + things to watch out for
- `docs/specs/manager-v3-multilayer.md` — v3 재설계 스펙 (lock-in, phase 구조)
- `docs/specs/worker-preset-and-plugin-injection.md` — Phase 10 Worker Preset 스펙
- `docs/specs/skill-packs.md` — Skill Pack 스펙
- `docs/test-scenarios.md` — QA 사용자 시나리오 (PRJ/TSK/BRD/RUN/INS/MGR/PM/DRIFT/ROUTER/SSE/REG/PRESET)
- `docs/handoff-post-scenario-review.md` — 시나리오 리뷰 후 개선사항 (완료됨)
- `README.md` / `README.ko.md` — 사용자 가이드 + API 레퍼런스
