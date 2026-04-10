# P8 Execution Brief

> 이 문서는 P8 phase 자율 실행용 일회성 브리핑이다. **작업이 전부 완료되면 이 문서를 삭제**해라 (마지막 PR 에서 같이 삭제 또는 별도 cleanup 커밋).

## 컨텍스트

Palantir Console repo (`/Users/K/Desktop/sub_project/palantir_console`). P6+P7 (#60~#64 + hotfix) 전부 merge 완료. 현재 `498/498 tests green on main`. app.js 291줄.

### 현재 프론트엔드 ESM 구조

```
server/public/app/
  main.js               — ESM 엔트리 (145줄), dynamic import + window bridge
  app.js                — App shell (291줄): NAV_ITEMS, NavSidebar, Loading, App, mount

  components/           — 13 ESM 모듈
    AgentsView.js       — Agent profiles UI (431줄)
    BoardView.js        — Kanban + Calendar + DirectoryPicker (506줄)
    CommandPalette.js   — Cmd+K overlay (200줄)
    DashboardView.js    — Attention Dashboard (266줄)
    DriftDrawer.js      — Dispatch audit drawer (259줄)
    Dropdown.js         — Reusable dropdown (116줄)
    EmptyState.js       — Empty state helper (37줄)
    ManagerView.js      — Manager chat + sessions (836줄)
    MentionInput.js     — @mention textarea (198줄)
    ProjectsView.js     — Projects management (356줄)
    RunInspector.js     — Run detail inspector (216줄)
    SessionsView.js     — Legacy sessions (931줄)
    TaskModals.js       — NewTaskModal + ExecuteModal + TaskDetailPanel (603줄)

  lib/                  — 7 ESM 유틸
    api.js, dueDate.js, format.js, hooks.js (723줄),
    markdown.js, notifications.js, toast.js
```

총 프론트엔드 JS: ~6510줄 (ESM 분산). 서버 테스트: 28 파일, 498 tests.

### 주요 기술 부채 / 잔여 이슈

1. **DashboardView.js self-bridge** — `window.dueState/formatDueDate/useNowTick/dueDateMeta` 4개가 DashboardView.js 내부에서 bridge됨. main.js 원칙 위반
2. **hooks.js 723줄** — 12개 export function. useManager(118줄)는 useConversation과 기능 중복
3. **useManager/useConversation 공존** — P6-2 에서 연기. 인터페이스 불일치로 단순 치환 불가
4. **app.js → ESM 모듈 전환** — app.js 가 여전히 classic script. main.js 의 legacy loader 제거 가능
5. **SessionsView.js 931줄** — initLegacySessions (vanilla JS 800줄) 리팩토링 여지
6. **ManagerView.js 836줄** — 가장 큰 ESM 컴포넌트. 하위 분할 가능
7. **Playwright E2E 부족** — jsdom 테스트 위주. 실제 브라우저 인터랙션 E2E 커버리지 낮음
8. **MentionInput ref hotfix** — Preact ref strip 이슈로 inputRef prop 전환 완료. 관련 jsdom 테스트 보강 필요

### spec deferred 항목 (건드리지 말 것)

- Phase 3b (Claude PM resume) — 트리거 미충족
- Reconciliation hard gate 승격 — 운영 데이터 부족
- dispatch_audit_log CASCADE FK — codex 거절
- events.js seenIds leak 주장 — 기각

---

## P8 이슈 (9건)

### P8-1. DashboardView self-bridge 제거 + main.js bridge 이동

- 위치: `server/public/app/components/DashboardView.js` L23~L26
- 문제: `window.dueState`, `window.formatDueDate`, `window.useNowTick`, `window.dueDateMeta` 를 DashboardView.js 내부에서 bridge. "bridge는 main.js에서만" 원칙 위반
- 수정:
  1. DashboardView.js에서 4줄의 `window.X = X` 제거
  2. `main.js`에서 `dueDate.js`를 직접 import + bridge:
     ```js
     import { dueState, formatDueDate, useNowTick, dueDateMeta } from './lib/dueDate.js';
     window.dueState = dueState;
     window.formatDueDate = formatDueDate;
     window.useNowTick = useNowTick;
     window.dueDateMeta = dueDateMeta;
     ```
  3. DashboardView.js 내부에서는 `import { ... } from '../lib/dueDate.js';` 유지 (자체 사용)
- 주의: bridge 순서. DashboardView dynamic import 전에 dueDate static import 완료되어야 함
- 예상 크기: ~10줄 변경

### P8-2. app.js → ESM 모듈 전환

- 위치: `server/public/app.js` (291줄), `server/public/app/main.js` (legacy script loader)
- 문제: app.js 가 여전히 classic script. main.js 가 `document.createElement('script')` 로 로드
- 수정:
  1. app.js 를 ES module 로 전환 (`export` 불필요 — 자체 실행)
  2. 모든 `window.X` 참조를 직접 ESM import 로 교체
  3. main.js 에서 legacy script loader 제거, 대신 `await import('./app.js')` 또는 app.js 의 코드를 main.js 에 합체
  4. index.html 에서 `<script type="module" src="app/main.js">` 확인 (이미 이렇게 되어있는지)
- 주의:
  - `NAV_ITEMS` 는 CommandPalette.js 에서 `window.NAV_ITEMS` 로 참조 → bridge 유지 또는 import 전환
  - App 내부의 모든 bare identifier (`DashboardView`, `ManagerView` 등)가 window 에서 resolve 중 → import 전환 필요
  - 가장 큰 변경. P8-1 완료 후 진행
- 예상 감소: main.js legacy loader ~15줄 삭제, app.js 를 clean ES module 로 전환

### P8-3. hooks.js 분할 — useManager 제거 + useConversation 통합

- 위치: `server/public/app/lib/hooks.js` (723줄)
- 문제: `useManager()` (L606~L723, 118줄) 는 `/api/manager/*` legacy API 를 소비하는 훅. `useConversation('top')` 과 기능 중복
- 수정:
  1. `useManager` 가 반환하는 인터페이스 완전 분석: `{ status, events, loading, start, sendMessage, stop, checkStatus }`
  2. `useConversation('top')` 인터페이스: `{ run, events, loading, sendMessage, reload }`
  3. 부족한 부분: `start`, `stop`, `status.active`, `status.usage`, `checkStatus`
  4. `useConversation('top')` 에 `start` / `stop` 을 추가하거나, App 레벨에서 별도 `useManagerLifecycle()` 훅으로 분리
  5. App 의 `const manager = useManager()` → 새 구조로 전환
  6. ManagerView 의 `manager` prop 인터페이스 조정
  7. `useManager` 삭제 + main.js bridge 제거
- 주의: ManagerView 는 `manager.status.active`, `manager.start()`, `manager.stop()` 등을 직접 사용. 인터페이스 변경 시 ManagerView 전체 확인 필수
- P8-2 (app.js ESM 전환) 완료 후 진행 권장

### P8-4. hooks.js 파일 분할

- 위치: `server/public/app/lib/hooks.js` (723줄)
- 문제: 12개 hook 이 한 파일. 관심사 분리 부족
- 수정: P8-3 (useManager 제거) 후 hooks.js 를 분할:
  - `hooks/routing.js` — useRoute, navigate
  - `hooks/sse.js` — useSSE
  - `hooks/data.js` — useTasks, useRuns, useProjects, useClaudeSessions, useAgents
  - `hooks/conversation.js` — useConversation, useDispatchAudit
  - `hooks/utils.js` — useEscape
  - `hooks/index.js` — re-export all (기존 import 호환)
- main.js bridge 를 `hooks/index.js` 에서 한번에 처리
- P8-3 후 진행 (useManager 제거 후 분할이 깔끔)

### P8-5. ManagerView 하위 분할

- 위치: `server/public/app/components/ManagerView.js` (836줄)
- 문제: ESM 컴포넌트 중 가장 큼. Chat panel + Session grid + Agent picker + 여러 핸들러
- 수정: 후보 분할:
  - `ManagerChat.js` — 채팅 패널 (메시지 파싱, 입력, 전송)
  - `SessionGrid.js` — 오른쪽 태스크 세션 그리드
  - ManagerView.js — 레이아웃 + 상태 관리 (두 하위 컴포넌트 조합)
- P8-2 후 진행 (ESM import 가 가능해야 하위 컴포넌트를 깔끔하게 분리)

### P8-6. MentionInput ref 관련 테스트 보강

- 위치: `server/tests/mentioninput-jsdom.test.js`
- 문제: P7 hotfix 로 `ref` → `inputRef` 변경. 기존 jsdom 테스트가 이 패턴을 커버하는지 확인 필요
- 수정:
  1. `inputRef` prop 이 textarea DOM element 를 정확히 참조하는지 테스트
  2. `inputRef.current.style.height` 접근이 정상 동작하는지 테스트
  3. `inputRef.current.focus()` 호출이 정상 동작하는지 테스트
- 목표: 3~5 테스트 추가

### P8-7. Playwright E2E — Manager 채팅 흐름

- 위치: `server/tests/` 또는 `e2e/`
- 문제: Manager 채팅의 전체 흐름을 커버하는 E2E 테스트 없음. P7 hotfix 의 ref 버그는 unit test 로는 잡기 어려웠음
- 수정: Playwright 기반 E2E 테스트 추가
  1. Manager Start → Active 상태 확인
  2. 채팅 입력 → 전송 → 응답 표시 확인
  3. PM 대화 전환 → 메시지 전송 확인
  4. Manager Stop → Idle 상태 확인
- 주의: 실제 Claude CLI 없이 테스트하려면 mock 서버 또는 fake adapter 필요. 기존 `server/tests/` 패턴 참고
- 선택적: 기존 Playwright smoke (P4-8) 에 추가

### P8-8. frontend-a11y-envelope.test.js 현행화

- 위치: `server/tests/frontend-a11y-envelope.test.js`
- 문제: P6 에서 `loadManagerViewSource()` 추가했지만, 다른 추출된 컴포넌트들 (TaskModals, SessionsView) 에 대한 소스 로더는 미추가. 향후 해당 컴포넌트에 a11y 테스트 추가 시 로더 필요
- 수정:
  1. `loadTaskModalsSource()`, `loadSessionsViewSource()` 로더 추가
  2. TaskModals 의 aria 패턴 검증 테스트 추가 (NewTaskModal close button, ExecuteModal agent picker 등)
- 목표: 5~8 테스트 추가

### P8-9. spec §15 deferred 항목 업데이트

- 위치: `docs/specs/manager-v3-multilayer.md` §15 마지막 섹션
- 문제: Force-delete 탈출구가 P7-2 에서 구현 완료되었으나 deferred 목록에 남아있음
- 수정:
  1. "Force-delete 탈출구" 항목을 deferred 목록에서 제거하고 P7 (ESM) 행에 반영 (이미 반영되어있으면 중복 항목만 제거)
  2. P8 행 추가 준비 (작업 완료 시)

---

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

1. `CLAUDE.md` 전체 — 특히 "Things to Watch Out For", "Key Patterns"
2. `docs/specs/manager-v3-multilayer.md` §15 (Implementation Log) — deferred 항목 목록
3. `git log --oneline -15` 으로 P6+P7 merge 맥락 파악
4. `server/public/app/main.js` — ESM bridge 패턴 + legacy loader 확인
5. `server/public/app.js` — 현재 App shell 구조 확인
6. `server/public/app/lib/hooks.js` — useManager / useConversation 인터페이스 비교

## 반드시 준수

- `useSSE` channels 배열은 `server/services/eventChannels.js` 가 single source
- `pmCleanupService` 는 fail-closed
- ESM 추출 시 window bridge 패턴 (`main.js` 에서 dynamic import → `window.X = X`) 유지
- **self-bridge 금지**: 컴포넌트 파일 하단에 `window.X = X` 넣지 말 것. bridge 는 main.js 에서만 (P5 Codex 피드백)
- **Preact ref strip**: 함수 컴포넌트에 `ref=` 대신 커스텀 prop name 사용 (P7 hotfix)
- 커밋 메시지 끝 `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- 코드 작업은 각자 워크트리 생성해서 브랜치 기반으로 진행

**기각 항목 건드리지 말 것**: Phase 3b (Claude PM resume — 트리거 조건 미충족), events.js seenIds leak 주장, drift badge "완전 무방비" 주장, A3 PM→Top notice drop 정책, MCP Phase 3 Proxy (trigger 미충족), Reconciliation hard gate 승격 (운영 데이터 부족), dispatch_audit_log CASCADE FK 변경

---

## 권장 PR 분할

### 라운드 1 (병렬 실행 가능)
- **#65** 코드 품질: P8-1 (DashboardView self-bridge 이동) + P8-9 (spec deferred 정리) — 작은 변경
- **#66** 테스트: P8-6 (MentionInput ref 테스트) + P8-8 (frontend-a11y 현행화)

### 라운드 2 (#65 merge 후)
- **#67** ESM 전환: P8-2 (app.js → ES module 전환) — 핵심 리팩토링

### 라운드 3 (#67 merge 후)
- **#68** hooks 통합: P8-3 (useManager 제거 + useConversation 통합)
- **#69** hooks 분할: P8-4 (hooks.js 파일 분할)

### 라운드 4 (#67 merge 후, 라운드 3과 병렬 가능)
- **#70** UI 분할: P8-5 (ManagerView 하위 분할)
- **#71** E2E: P8-7 (Playwright Manager 채팅 E2E)

## 완료 기준

- 전체 이슈 PR 생성 + Codex PASS + merge
- `npm test` 그린 (현재 498 → 목표 515+)
- app.js 가 ES module 로 전환 (classic script 탈출)
- `useManager()` 제거, hooks.js 분할 완료
- DashboardView self-bridge 해소
- 각 PR 단독 롤백 가능
- **마지막 PR 에서 `docs/work/p8-execution-brief.md` 삭제**
- CLAUDE.md 아키텍처 섹션 업데이트
- spec §15 Implementation Log 에 P8 기록 추가
- 최종 보고: PR URL 리스트 + Codex 피드백 + 잔여 항목 + 회귀 리스크
