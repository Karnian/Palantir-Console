# P5 Execution Brief

> 이 문서는 P5 phase 자율 실행용 일회성 브리핑이다. **P5 작업이 전부 완료되면 이 문서를 삭제**해라 (마지막 PR 에서 같이 삭제 또는 별도 cleanup 커밋).

## 컨텍스트

Palantir Console repo (`/Users/K/Desktop/sub_project/palantir_console`). P4 (#50~#54) 전부 merge 완료. 현재 `411/411 tests green on main`. app.js 4297줄.

## 실행 방식

- default autonomous mode (CLAUDE.md "Working style" 섹션 참조)
- phase 기반 표준 체인: `branch → 구현 → npm test → codex 교차검증 (PASS까지 반복) → commit → PR → merge → main pull → 다음 phase`
- Codex 를 매 PR peer reviewer 로 참여시켜 PASS 받기
- 의사결정 포인트는 Codex 합의로 진행. 사용자에게 물어보지 말 것
- 다음 상황만 사용자 보고:
  - Codex 가 5라운드 넘도록 수렴 안 됨
  - spec 재해석이 필요한 충돌
  - 대규모 리팩토링이 phase 본질과 무관하게 강요되는 경우

## 사전 필독

1. `CLAUDE.md` 전체 — 특히 "Things to Watch Out For"
2. `docs/specs/manager-v3-multilayer.md` §15 (Implementation Log)
3. `git log --oneline -20` 으로 P4 merge 맥락 파악

## 반드시 준수

- `useSSE` channels 배열은 `server/services/eventChannels.js` 가 single source
- `pmCleanupService` 는 fail-closed
- `app.js` 4297줄 단일 파일 — 수정 시 해당 컴포넌트 영역만
- ESM 추출 시 window bridge 패턴 (`main.js` 에서 dynamic import → `window.X = X`) 유지. 선례: DriftDrawer / RunInspector / Dropdown / EmptyState / MentionInput / CommandPalette
- 커밋 메시지 끝 `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- 코드 작업은 각자 워크트리 생성해서 브랜치 기반으로 진행

**기각 항목 건드리지 말 것**: Phase 3b (Claude PM resume — 트리거 조건 미충족), events.js seenIds leak 주장, drift badge "완전 무방비" 주장, A3 PM→Top notice drop 정책, MCP Phase 3 Proxy (P6+)

## P5 이슈 (10건)

### Frontend / ESM phase 4 (app.js 4297줄 → 목표 ~3000줄)

**P5-1. DashboardView ESM 추출**
- 위치: `server/public/app.js` L141~L419 (~280줄, `function DashboardView` ~ `function NewTaskModal` 직전)
- 문제: app.js 단일 파일 크기 지속 감소 필요. DashboardView 는 display 위주로 가장 추출하기 쉬움
- 수정: `server/public/app/components/DashboardView.js` 로 추출
  - 함께 추출: `dueState`, `formatDueDate`, `useNowTick`, `dueDateMeta` (L13~L95, DashboardView 전용이면)
  - `NavSidebar`, `Loading` 은 App 에서도 사용하므로 app.js 잔류
  - window bridge: `window.DashboardView = DashboardView`
- 주의: `useNowTick` 이 다른 곳에서도 쓰이는지 확인 → 쓰이면 별도 훅 파일 또는 window bridge
- 선례: CommandPalette 추출 (P4-3) 과 동일 패턴
- app.js 예상 감소: ~280줄 + 유틸 ~90줄 → 약 370줄 감소
- PR: P5-2와 묶을 수 있음

**P5-2. BoardView + CalendarView ESM 추출**
- 위치: `server/public/app.js` L1025~L1596 (~570줄)
  - `TaskCard` L1025~L1067
  - `BoardModeTabs` L1069~L1088
  - `BoardView` L1090~L1354
  - `CalendarView` L1355~L1492
  - `DirectoryPicker` L1493~L1596
- 문제: Board 섹션 전체가 자체 완결적 — 한 모듈로 추출 가능
- 수정: `server/public/app/components/BoardView.js` 로 추출 (TaskCard, BoardModeTabs, CalendarView, DirectoryPicker 를 내부 함수로 포함)
  - BoardView 만 export, 나머지는 모듈 내부
  - drag-drop 이벤트 핸들러가 app.js 의 `setTasks` 에 의존 — prop 으로 전달
- app.js 예상 감소: ~570줄

**P5-3. ProjectDetailModal + ProjectsView ESM 추출**
- 위치: `server/public/app.js` L1602~L1835 (~234줄)
  - `ProjectDetailModal` L1602~L1727
  - `ProjectsView` L1728~L1835
- 수정: `server/public/app/components/ProjectsView.js` 로 추출 (ProjectDetailModal 포함)
- app.js 예상 감소: ~234줄

**P5-4. AgentModal + AgentDetailModal + AgentsView ESM 추출**
- 위치: `server/public/app.js` L2834~L3233 (~400줄)
  - `AgentModal` L2834~L2973
  - `AgentDetailModal` L2975~L3149
  - `AgentsView` L3150~L3233
- 수정: `server/public/app/components/AgentsView.js` 로 추출
  - `managerProfileAuthState` (L3239~L3243) 는 ManagerView 에서도 쓰일 수 있으니 확인 후 결정
- app.js 예상 감소: ~400줄

### 테스트 커버리지 확대

**P5-5. lifecycleService 단위 테스트**
- 위치: `server/services/lifecycleService.js` (597줄) — 가장 크고 테스트 없는 서비스
- 문제: agent spawning, input dispatch, health check, status transition 등 핵심 로직에 전용 테스트 없음
- 수정: `server/tests/lifecycle.test.js` 신규
  - executeTask: spawn args 검증 (cwd, env, allowedTools, mcpConfig)
  - handleRunInput: active run 에 input 전달, inactive run 거절
  - health check: is_manager 가드 동작, stale run 정리
  - status transition: running→completed, running→needs_input
- mock: streamJsonEngine, executionEngine 을 stub 으로 주입
- 목표: 10~15 테스트

**P5-6. conversationService 단위 테스트**
- 위치: `server/services/conversationService.js` (446줄) — v3 Phase 1.5 핵심
- 문제: parent notice 큐, peek-then-drain, resolveParentSlot 등 race-sensitive 로직에 전용 테스트 없음
- 수정: `server/tests/conversation-unit.test.js` 신규
  - sendMessage: 대상 run 에 메시지 전달 + parent notice 큐잉
  - peek-then-drain: commitDrainParentNotices 가 count 만큼만 splice
  - resolveParentSlot: worker parent 가 Top 또는 PM 인 경우 분기
  - onSlotCleared: notice 큐 scrub 동작
- 목표: 8~12 테스트

### P4 Codex 피드백 잔여

**P5-7. mcp_config_path 입력 검증 + 기존 프로젝트 수정 UI**
- 위치: `server/services/projectService.js`, `server/public/app.js` (ProjectsView 영역)
- 문제 (P4 Codex 리뷰):
  1. mcp_config_path 에 validation 없음 — 절대경로 + `.json` 확장자 검증 권장
  2. 기존 프로젝트에서 mcp_config_path 수정하는 UI 필드 없음 (create 만 있음)
- 수정:
  1. `projectService.createProject` / `updateProject` 에서 mcp_config_path 값 검증: 비어있지 않으면 절대경로(`/`로 시작) + `.json` 확장자
  2. ProjectsView 의 프로젝트 편집 UI 에 MCP Config Path 입력 추가
- P5-3 (ProjectsView ESM 추출) 와 같은 PR 가능

**P5-8. Playwright webServer timeout + E2E 확장**
- 위치: `playwright.config.js`, `server/tests/e2e/smoke.spec.js`
- 문제 (P4 Codex 리뷰): webServer.timeout 이 10s 로 짧음 — cold start 시 실패 가능
- 수정:
  1. `playwright.config.js` 에서 `timeout: 30000` 으로 변경
  2. 기존 smoke 테스트에 project CRUD 흐름 추가 (API + UI 검증)
  3. agent profile 생성/조회 E2E 추가
- PR: 단독 또는 다른 테스트 이슈와 묶음

### 코드 품질

**P5-9. API 라우트 입력 스키마 검증**
- 위치: `server/routes/tasks.js`, `server/routes/agents.js`, `server/routes/projects.js`
- 문제: POST/PATCH 라우트에서 `req.body` 를 타입 검증 없이 서비스에 전달
- 수정:
  1. 경량 검증 미들웨어 작성 (`server/middleware/validate.js`) — zod/ajv 대신 수동 검증 (의존성 추가 최소화)
  2. 각 라우트에 필수 필드 + 타입 검증 적용
  3. 잘못된 입력 시 400 + 명확한 에러 메시지
- 범위: tasks, agents, projects 3개 라우트만. runs/manager/dispatch 는 이번에 안 건드림
- 테스트: 기존 API 테스트에 invalid input 케이스 추가

**P5-10. jsdom 테스트 헬퍼 loadComponent 강화**
- 위치: `server/tests/helpers/jsdom-preact.js`
- 문제 (P4 Codex 리뷰):
  1. `loadComponent` regex 가 `export function` 하나만 strip — 다중 export 컴포넌트에서 실패
  2. dom.window.close() 미호출로 timer leak 가능
- 수정:
  1. `/^export\s+function\s+/gm` 으로 `g` 플래그 추가 (모든 export function strip)
  2. `createPreactEnv` 반환값에 `cleanup()` 함수 추가 — `dom.window.close()` 호출
  3. 기존 driftdrawer/dropdown/mentioninput 테스트의 after() 훅에서 cleanup() 호출
- PR: P5-8 또는 테스트 이슈와 묶음

## 권장 PR 분할 (Codex 합의 후 조정)

- **#55** ESM phase 4a: P5-1 + P5-2 (DashboardView + BoardView 추출) — app.js ~940줄 감소
- **#56** ESM phase 4b: P5-3 + P5-4 + P5-7 (ProjectsView + AgentsView 추출 + mcp_config_path fix)
- **#57** 서비스 단위 테스트: P5-5 + P5-6 (lifecycleService + conversationService)
- **#58** 테스트 인프라: P5-8 + P5-10 (Playwright timeout + E2E 확장 + jsdom 헬퍼 강화)
- **#59** API 검증: P5-9 (라우트 입력 스키마 검증)

## 완료 기준

- 10건 전부 PR 생성 + Codex PASS + merge
- `npm test` 그린 (현재 411 → 목표 440+)
- app.js 줄 수: 4297 → 목표 ~3100 이하 (~1200줄 감소)
- 각 PR 단독 롤백 가능
- **마지막 PR 에서 `docs/work/p5-execution-brief.md` 삭제** (또는 별도 cleanup 커밋)
- 최종 보고: PR URL 리스트 + Codex 피드백 + 잔여 P6 + 회귀 리스크

## P6 후보 (이번에 하지 않음, 기록만)

- MCP Phase 3: Proxy 방식 (멀티 테넌트 / 감사)
- Phase 3b: Claude PM resume (spec 트리거 조건 미충족)
- ManagerView ESM 추출 (796줄 — 가장 복잡, useManager→useConversations 이관과 동시 진행 권장)
- SessionsView + legacy initLegacySessions ESM 추출/정리
- Reconciliation hard gate 승격 (운영 데이터 관찰 후)
- PM force-delete escape hatch
- streamJsonEngine 단위 테스트 (481줄)
- Worker 실행 결과 요약 UI 노출 (result_summary 필드 존재하나 미사용)
