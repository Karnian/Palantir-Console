# P9 Execution Brief

> 이 문서는 P9 phase 자율 실행용 일회성 브리핑이다. **작업이 전부 완료되면 이 문서를 삭제**해라 (마지막 PR 에서 같이 삭제 또는 별도 cleanup 커밋).

## 컨텍스트

Palantir Console repo (`/Users/K/Desktop/sub_project/palantir_console`). P8 (#65~#71) 전부 merge 완료. 현재 `510/510 tests green on main` (509 node:test + E2E). app.js ESM 전환 완료, hooks 7-module 분할 완료, ManagerView 3-file 분할 완료.

### 현재 프론트엔드 ESM 구조

```
server/public/app/
  main.js               — ESM 엔트리 (156줄), window bridge + dynamic import
  app.js                — App shell ES module (321줄): NAV_ITEMS, NavSidebar, App, mount

  components/           — 15 ESM 모듈
    AgentsView.js       (429줄)    ← window.* 9회
    BoardView.js        (629줄)    ← window.* 14회
    CommandPalette.js   (89줄)     ← window.* 2회
    DashboardView.js    (295줄)    ← window.* 7회
    DriftDrawer.js      (171줄)    ← window.* 1회
    Dropdown.js         (168줄)    ← window.* 0회 (preact만)
    EmptyState.js       (37줄)     ← window.* 0회 (preact만)
    ManagerChat.js      (657줄)    ← window.* 16회 (가장 많음)
    ManagerView.js      (37줄)     ← window.* 0회 (preact만)
    MentionInput.js     (225줄)    ← window.* 0회 (preact만)
    ProjectsView.js     (354줄)    ← window.* 11회
    RunInspector.js     (230줄)    ← window.* 9회
    SessionGrid.js      (185줄)    ← window.* 6회
    SessionsView.js     (931줄)    ← window.* 7회, 가장 큰 파일
    TaskModals.js       (603줄)    ← window.* 6회

  lib/                  — 7 ESM 유틸
    api.js, dueDate.js, format.js, markdown.js, notifications.js, toast.js
    hooks.js            — re-export barrel
    hooks/              — 7 모듈 (routing, utils, sse, data, conversation, dispatch, manager)
```

총 window.* helper/component 참조: **88회** (15개 컴포넌트). 이외 `window.preact`/`window.preactHooks`/`window.htm` 참조가 모든 컴포넌트 + hooks 모듈에 존재.

### main.js window bridge 현황 (156줄)

현재 main.js 가 bridge 하는 항목:
- **Preact core**: `window.preact`, `window.preactHooks`, `window.htm` (3)
- **Helpers**: `formatDuration`, `formatTime`, `timeAgo`, `renderMarkdown`, `apiFetch`, `dueState`, `formatDueDate`, `useNowTick`, `dueDateMeta` (9)
- **Toast**: `addToast`, `useToasts`, `ToastContainer`, `apiFetchWithToast` (4)
- **Hooks**: `useRoute`, `navigate`, `useEscape`, `useSSE`, `useTasks`, `useRuns`, `useProjects`, `useClaudeSessions`, `useAgents`, `useManagerLifecycle`, `useConversation`, `useDispatchAudit` (12)
- **Components**: `RunInspector`, `DriftDrawer`, `Dropdown`, `EmptyState`, `MentionInput`, `CommandPalette`, `DashboardView`, `BoardView`, `CalendarView`, `DirectoryPicker`, `ProjectsView`, `AgentsView`, `SessionsView`, `ManagerView`, `NewTaskModal`, `ExecuteModal`, `TaskDetailPanel` (17)
- **Notifications**: `requestNotificationPermission`, `showBrowserNotification`, `pulseTabTitle` (3)

**총 48개 bridge**. P8-2 에서 app.js 가 ESM 으로 전환되어 app.js 자체는 더 이상 bridge 가 필요 없다. Bridge 가 필요한 소비자는 오직 ESM 컴포넌트 파일들 (함수 본문 안에서 `const apiFetch = window.apiFetch` 등으로 런타임 resolve).

### SessionsView.js 구조 (931줄)

- L1-16: 모듈 셋업 (window.preact, preactHooks, htm)
- L21-805: `initLegacySessions(root)` — vanilla JS 함수 하나. DOM 쿼리, fetch, innerHTML, 이벤트 리스너로 구성된 모놀리스
  - L21-60: DOM 요소 쿼리 + 상태 변수
  - L62-180: `renderSessionList()` — 세션 목록 렌더
  - L182-300: `renderConversation()` — 대화 메시지 렌더 (marked + DOMPurify)
  - L302-440: `loadSessions()`, `loadConversation()`, `loadMoreMessages()` — 데이터 fetching
  - L442-560: `sendMessage()`, `deleteMessage()`, `exportSession()` — 액션 핸들러
  - L562-700: 이벤트 바인딩 (클릭, 키보드, 드래그 등)
  - L702-805: 폴링 타이머, cleanup 반환
- L811-931: `SessionsView()` — Preact wrapper (HTML 템플릿 + useEffect 로 initLegacySessions 호출)

핵심 문제: `initLegacySessions` 은 vanilla JS 모놀리스로, 테스트/유지보수가 어렵고 Preact 반응형 패턴과 불일치.

### spec deferred 항목 (건드리지 말 것)

- Phase 3b (Claude PM resume) — 트리거 미충족
- Reconciliation hard gate 승격 — 운영 데이터 부족
- dispatch_audit_log CASCADE FK — codex 거절

---

## P9 이슈 (6건)

### P9-1. ESM 컴포넌트 window.preact/preactHooks/htm → 직접 import

- 위치: 15개 컴포넌트 파일 + 7개 hooks 모듈
- 문제: 모든 ESM 파일이 `window.preact`, `window.preactHooks`, `window.htm` 을 모듈 최상단에서 참조. main.js 가 bridge 를 먼저 설정해야만 import 가 안전한 구조적 제약
- 수정:
  1. 각 컴포넌트/hooks 모듈에서 `const { h } = window.preact` → `import { h } from '../../vendor/preact.module.js'` (경로는 파일 위치에 따라 조정)
  2. `const { useState, ... } = window.preactHooks` → `import { useState, ... } from '../../vendor/hooks.module.js'`
  3. `const html = window.htm.bind(h)` → `import htmFactory from '../../vendor/htm.module.js'; const html = htmFactory.bind(h);`
  4. 각 파일 상단의 `window.preact`/`window.preactHooks`/`window.htm` 관련 주석도 갱신
- 주의:
  - ES module 은 싱글턴이므로 여러 파일이 같은 vendor 모듈을 import 해도 한 번만 평가됨
  - import 경로: `components/` 에서는 `../../vendor/`, `lib/hooks/` 에서는 `../../../vendor/`
  - `app.js` 는 이미 P8-2 에서 직접 import 완료 — 변경 불필요
- 예상 크기: ~22개 파일, 파일당 3줄 변경

### P9-2. ESM 컴포넌트 window.* helper/component 참조 → 직접 import

- 위치: 11개 컴포넌트 (88회 window.* 참조)
- 문제: 컴포넌트 함수 본문 안에서 `const apiFetch = window.apiFetch` 등으로 런타임 resolve. Import graph 가 불투명
- 수정:
  1. 각 컴포넌트 파일 상단에 필요한 helper/component import 추가
  2. 함수 본문의 `const X = window.X` 제거
  3. helper 경로: `../lib/api.js`, `../lib/format.js`, `../lib/toast.js`, `../lib/markdown.js`, `../lib/hooks/routing.js`, `../lib/hooks/conversation.js`, `../lib/hooks/utils.js`, `../lib/dueDate.js`, `../lib/notifications.js`
  4. component 간 참조: `./Dropdown.js`, `./EmptyState.js`, `./MentionInput.js`, `./RunInspector.js`, `./TaskDetailPanel` (from `./TaskModals.js`)
- 주의:
  - `ManagerChat.js` 가 window.* 16회로 가장 많음 — 집중 점검
  - `TaskDetailPanel` 은 `TaskModals.js` 에서 export. 현재 `ManagerChat.js` 와 `SessionGrid.js` 가 `window.TaskDetailPanel` 로 참조 → `import { TaskDetailPanel } from './TaskModals.js'`
  - 순환 참조 주의: A가 B를 import하고 B도 A를 import하는 경우 없는지 확인
- P9-1 완료 후 진행 (preact import 가 먼저 정리되어야 helper import 추가가 깔끔)

### P9-3. main.js window bridge 정리

- 위치: `server/public/app/main.js` (156줄)
- 문제: P8-2 + P9-1/P9-2 완료 후, bridge 소비자가 0 이 되는 항목이 대부분
- 수정:
  1. P9-1/P9-2 완료 후 `grep -r "window\.<name>"` 으로 각 bridge 의 소비자 확인
  2. 소비자가 0 인 bridge 제거
  3. `window.preact`, `window.preactHooks`, `window.htm` bridge — hooks 모듈과 컴포넌트가 직접 import 로 전환 후 제거 가능
  4. main.js 헤더 주석 현행화 (아직 "legacy app.js bundle as a classic script" 라고 되어 있음)
  5. `window.NAV_ITEMS` bridge (`app.js` 에서 설정) — `CommandPalette.js` 가 소비자. 이것도 import 로 전환 가능
- 주의: `SessionsView.js` 의 `initLegacySessions` 은 vanilla JS 라서 `window.marked`, `window.DOMPurify` 를 직접 참조할 수 있음 — 이 bridge 는 index.html `<script>` 에서 옴, main.js 와 무관
- P9-1 + P9-2 완료 후 진행

### P9-4. SessionsView.js 분할 — initLegacySessions Preact 전환

- 위치: `server/public/app/components/SessionsView.js` (931줄)
- 문제: `initLegacySessions` (784줄) 이 vanilla JS 모놀리스. DOM 직접 조작, fetch, innerHTML. Preact 반응형 패턴과 불일치
- 수정: Preact 컴포넌트로 재작성
  1. `SessionList.js` (~200줄) — 세션 목록 (검색, 정렬, 클릭 선택)
  2. `ConversationPanel.js` (~300줄) — 대화 메시지 표시 + 전송 + load more
  3. `SessionsView.js` (~100줄) — 레이아웃 셸 (SessionList + ConversationPanel 조합)
  4. 기존 HTML 템플릿은 `SessionsView.js` 의 L825-931 에 있는 정적 마크업을 htm 템플릿으로 전환
  5. `initLegacySessions` 및 `data-role`/`data-action` 패턴 완전 제거
- 주의:
  - marked + DOMPurify 렌더링: `dangerouslySetInnerHTML` 패턴 사용 (ManagerChat 과 동일)
  - 폴링 타이머: `useEffect` + `setInterval` 패턴으로 전환
  - 기존 테스트가 SessionsView 를 참조하는지 확인 (`frontend-a11y-envelope.test.js` 에 `loadSessionsViewSource()` 있음)
  - `fetch` → `apiFetch` 전환 (auth 호환)
- P9-1/P9-2 완료 후 진행 (직접 import 패턴이 확립된 후 새 컴포넌트도 같은 패턴으로)

### P9-5. main.js dynamic import → app.js 직접 import 전환

- 위치: `server/public/app/main.js`
- 문제: P9-1/P9-2/P9-3 완료 후 main.js 의 역할이 크게 축소됨. 현재 main.js → bridge → app.js import 체인을 단순화 가능
- 수정:
  1. main.js 에서 component dynamic import + bridge 를 전부 제거 (P9-3 에서 대부분 제거됨)
  2. `configureMarked()` 호출만 남기고, 나머지는 app.js 가 직접 import
  3. 최종 main.js 는 `configureMarked()` + `await import('../app.js')` 정도의 최소 부트스트래퍼
- P9-3 완료 후 진행

### P9-6. 테스트 + 문서 현행화

- 위치: `server/tests/`, `CLAUDE.md`, `docs/specs/manager-v3-multilayer.md`
- 수정:
  1. `boot.smoke.test.js` — main.js bridge 제거에 따른 테스트 갱신
  2. `frontend-a11y-envelope.test.js` — main.js bridge 테스트 갱신
  3. `sse-channels.test.js` — 경로 변경 반영
  4. SessionsView 분할에 따른 `loadSessionsViewSource()` 갱신
  5. CLAUDE.md Architecture 섹션 업데이트
  6. spec §15 P9 행 추가
  7. `docs/work/p9-execution-brief.md` 삭제

---

## 실행 방식

- default autonomous mode (CLAUDE.md "Working style" 섹션 참조)
- phase 기반 표준 체인: `branch → 구현 → npm test → codex 교차검증 (PASS까지 반복) → commit → PR → merge → main pull → 다음 phase`
- Codex 를 매 PR peer reviewer 로 참여시켜 PASS 받기
- 코드 작업은 각자 워크트리 생성해서 브랜치 기반으로 진행

## 사전 필독

1. `CLAUDE.md` 전체 — 특히 "Things to Watch Out For", "Key Patterns"
2. `docs/specs/manager-v3-multilayer.md` §15 (Implementation Log)
3. `server/public/app/main.js` — 현재 bridge 전체 목록
4. `server/public/app.js` — app.js ESM import 목록 (P8-2 결과)
5. `server/public/app/components/SessionsView.js` — initLegacySessions 구조
6. `server/public/app/components/ManagerChat.js` — window.* 가장 많은 파일, 전환 패턴 참고

## 반드시 준수

- `useSSE` channels 배열은 `server/public/app/lib/hooks/sse.js` 가 single source
- `pmCleanupService` 는 fail-closed
- **self-bridge 금지**: 컴포넌트 파일 하단에 `window.X = X` 넣지 말 것
- **Preact ref strip**: 함수 컴포넌트에 `ref=` 대신 커스텀 prop name 사용 (P7 hotfix)
- 커밋 메시지 끝 `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- 코드 작업은 각자 워크트리 생성해서 브랜치 기반으로 진행
- 순환 import 금지 — 컴포넌트 간 참조 방향 단방향 유지

**기각 항목 건드리지 말 것**: Phase 3b, Reconciliation hard gate, dispatch_audit_log CASCADE FK

---

## 권장 PR 분할

### 라운드 1
- **#72** P9-1: ESM preact/hooks/htm 직접 import (22개 파일, 기계적 변환)

### 라운드 2 (#72 merge 후)
- **#73** P9-2: ESM helper/component window.* → 직접 import (11개 컴포넌트, 88회 참조)

### 라운드 3 (#73 merge 후)
- **#74** P9-3 + P9-5: main.js bridge 정리 + 부트스트래퍼 최소화

### 라운드 4 (#74 merge 후)
- **#75** P9-4: SessionsView Preact 재작성 (initLegacySessions 제거)

### 라운드 5
- **#76** P9-6: 테스트 + 문서 현행화 + brief 삭제

## 완료 기준

- 전체 이슈 PR 생성 + Codex PASS + merge
- `npm test` 그린
- `window.preact` / `window.preactHooks` / `window.htm` bridge 제거
- ESM 컴포넌트의 `window.*` helper 참조 0
- main.js 가 최소 부트스트래퍼로 축소
- SessionsView 가 Preact 컴포넌트로 재작성, initLegacySessions 제거
- 각 PR 단독 롤백 가능
- **마지막 PR 에서 `docs/work/p9-execution-brief.md` 삭제**
- CLAUDE.md 아키텍처 섹션 업데이트
- spec §15 Implementation Log 에 P9 기록 추가
- 최종 보고: PR URL 리스트 + Codex 피드백 + 잔여 항목 + 회귀 리스크
