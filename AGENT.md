# Agent Guide

Palantir Console — AI 코딩 에이전트 중앙 관제 허브. 상세 내용은 `CLAUDE.md` 와 `docs/specs/manager-v3-multilayer.md` 참고. 이 파일은 빠른 오리엔테이션 용.

## Quick Start

```bash
npm install
npm start          # http://localhost:4177
npm test           # node --test (238 tests at Phase 7 merge)
```

## Architecture (v3 Phase 0~7 merged)

Express.js 5 + SQLite (WAL) + Preact/HTM (UMD, no build).

```
server/
  index.js              — 진입점 (포트, auth 로딩)
  app.js                — Express 조립 (라우터/서비스 조립)
  db/migrations/        — 001~010 (v3: 006 task enrichment, 007 pm settings,
                          008 project_briefs, 009 manager_layer/conversation_id,
                          010 dispatch_audit_log)
  routes/
    manager.js          — Top/PM /api/manager/* + pm/:id/message + /reset
    conversations.js    — /api/conversations/:id/* (top|pm:<id>|worker:<id>)
    router.js           — /api/router/resolve (Phase 6 3-step matcher)
    dispatchAudit.js    — /api/dispatch-audit (Phase 4, annotate-only)
    tasks.js runs.js projects.js agents.js events.js
    sessions.js trash.js fs.js usage.js claude-sessions.js
  services/
    managerAdapters/claudeAdapter.js  — stream-json persistent process
    managerAdapters/codexAdapter.js   — stateless + thread resume
    streamJsonEngine.js  — Claude stream-json 엔진
    executionEngine.js   — TmuxEngine / SubprocessEngine (worker)
    lifecycleService.js  — Health check, 상태 전환
    managerRegistry.js   — top/pm 슬롯 단일 source + onSlotCleared
    conversationService.js — 1급 conversation + parent-notice router
    pmSpawnService.js    — PM lazy spawn (brief-in-system-prompt)
    pmCleanupService.js  — PM 단일 owner teardown (fail-closed)
    routerService.js     — 3-step @mention matcher
    reconciliationService.js — dispatch audit (annotate-only)
    runService.js        — Run CRUD + Phase 5 semantic envelope
    taskService.js projectService.js projectBriefService.js
    agentProfileService.js managerSystemPrompt.js authResolver.js
    eventBus.js worktreeService.js
  public/
    app.js               — Preact SPA (~4500줄)
    app/main.js          — ESM 엔트리 + window 브릿지
    app/lib/hooks.js     — useSSE, useConversation, useDispatchAudit, useManager
    vendor/              — Preact/HTM UMD+ESM
  tests/
    conversation.test.js pm-phase3a.test.js reconciliation.test.js
    router.test.js phase5-sse-semantics.test.js
    manager.test.js manager-codex.test.js v2-api.test.js ...
```

## Key Concepts (v3)

- **Conversation identity**: 모든 채팅 surface 가 1급 식별자를 가짐 — `top`, `pm:<projectId>`, `worker:<runId>`. `conversationService` 가 단일 엔트리.
- **PM lazy spawn**: 첫 `pm:<projectId>` 메시지에서 `pmSpawnService.ensureLivePm` 이 Codex 어댑터로 run 생성 + brief 을 static system prompt 에 bake. 이후 턴은 thread resume.
- **Parent-notice router** (lock-in #2): 자식 타깃 사용자 메시지 = 무조건 부모 staleness notice. worker→Top (Phase 1.5), worker→PM + PM→Top (Phase 2). 의도 분류 금지.
- **Single-owner PM cleanup**: `pmCleanupService.reset` / `.dispose` 가 유일한 종료 경로. fail-closed — dispose 실패 시 상태 유지 + re-throw.
- **Dispatch audit** (annotate-only): PM claim 을 `POST /api/dispatch-audit` 로 기록 → `reconciliationService` 가 DB truth 와 비교해 `incoherence_flag` 만 남김. 절대 block 안 함.
- **Router 3-step**: `@<name|id>` → current context → name fuzzy → default. 서버 함수 + HTTP wrapper.
- **SSE semantic envelope**: `run:*` 이벤트가 `from_status/to_status/reason/task_id/project_id` 를 additive 로 운반. `run:status` 는 pure reload, `run:needs_input`/`run:completed` 가 priority alert.

## Important Notes

- Manager 에서 `--input-format stream-json` + `-p` 플래그 조합은 동작하지 않음 (Claude). 초기 프롬프트는 반드시 stdin 으로 전송
- **Codex 어댑터는 stateless** — back-to-back runTurn 은 "previous turn still running" 으로 실패. brief 은 seed runTurn 이 아니라 system prompt 에 넣는다
- **`pmCleanupService` 는 fail-closed**. dispose 실패 시 절대 swallow 하지 말 것
- **`useSSE` channels 배열은 hard-coded** — 새 SSE 채널 추가 시 `server/public/app/lib/hooks.js` 에도 반드시 추가. Phase 5/7 에서 이 회귀가 있었음
- Manager 의 result 이벤트는 "한 턴 끝남" 이지 "세션 끝남" 아님. completed 로 전환하지 않음
- UI 는 CDN 없이 `server/public/vendor/` 에 번들된 Preact/HTM 사용
- `.claude-auth.json` 은 gitignore. 민감 정보 커밋 금지
- 환경변수: `PALANTIR_DEFAULT_PM_ADAPTER`, `PALANTIR_CODEX_MANAGER_BYPASS`, Claude/Codex auth 키들

## 관련 문서

- `CLAUDE.md` — 상세 컨벤션 + 자율 모드 working style + things to watch out for
- `docs/specs/manager-v3-multilayer.md` — v3 재설계 스펙 (lock-in, phase 구조)
- `docs/test-scenarios.md` — QA 사용자 시나리오 (PRJ/TSK/BRD/RUN/INS/MGR/PM/DRIFT/ROUTER/SSE/REG)
- `README.md` / `README.ko.md` — 사용자 가이드 + API 레퍼런스
