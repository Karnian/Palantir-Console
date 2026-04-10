# P6+P7 Execution Brief

> 이 문서는 P6+P7 phase 자율 실행용 일회성 브리핑이다. **작업이 전부 완료되면 이 문서를 삭제**해라 (마지막 PR 에서 같이 삭제 또는 별도 cleanup 커밋).

## 컨텍스트

Palantir Console repo (`/Users/K/Desktop/sub_project/palantir_console`). P5 (#55~#59) 전부 merge 완료. 현재 `460/460 tests green on main`. app.js 2796줄.

### 현재 app.js 함수 지도 (2796줄)

| 함수 | 줄 범위 | 크기 | 비고 |
|------|---------|------|------|
| NavSidebar | 46~71 | 25줄 | App shell — 잔류 |
| Loading | 72~99 | 27줄 | App shell — 잔류 |
| NewTaskModal | 100~218 | 118줄 | P7-1 추출 대상 |
| ExecuteModal | 219~283 | 64줄 | P7-1 추출 대상 |
| TaskDetailPanel | 284~714 | 430줄 | P7-1 추출 대상 |
| SessionsView | 715~840 | 125줄 | P6-3 추출 대상 |
| initLegacySessions | 841~1641 | 800줄 | P6-3 추출 대상 |
| requestNotificationPermission | 1642~1650 | 8줄 | notification 유틸 — P7-1과 함께 |
| showBrowserNotification | 1651~1668 | 17줄 | notification 유틸 — P7-1과 함께 |
| pulseTabTitle | 1669~1737 | 68줄 | notification 유틸 — P7-1과 함께 |
| managerProfileAuthState | 1738~1743 | 5줄 | ManagerView 종속 — P6-1과 함께 |
| ManagerView | 1744~2539 | 795줄 | P6-1 추출 대상 (가장 큰 컴포넌트) |
| App | 2540~2784 | 244줄 | App shell — 잔류 |
| mount | 2785~2796 | 11줄 | App shell — 잔류 |

### 이미 추출된 ESM 모듈

```
server/public/app/
  components/: DriftDrawer, Dropdown, EmptyState, RunInspector, CommandPalette,
               MentionInput, DashboardView, BoardView, ProjectsView, AgentsView
  lib/:        api, dueDate, format, hooks, markdown, toast
```

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
3. `git log --oneline -20` 으로 P5 merge 맥락 파악
4. `server/public/app/main.js` — ESM bridge 패턴 확인
5. 기존 추출 선례 1개 이상 읽기 (예: `DashboardView.js`, `BoardView.js`)

## 반드시 준수

- `useSSE` channels 배열은 `server/services/eventChannels.js` 가 single source
- `pmCleanupService` 는 fail-closed
- ESM 추출 시 window bridge 패턴 (`main.js` 에서 dynamic import → `window.X = X`) 유지
- **self-bridge 금지**: 컴포넌트 파일 하단에 `window.X = X` 넣지 말 것. bridge 는 main.js 에서만 (P5 Codex 피드백)
- 커밋 메시지 끝 `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- 코드 작업은 각자 워크트리 생성해서 브랜치 기반으로 진행

**기각 항목 건드리지 말 것**: Phase 3b (Claude PM resume — 트리거 조건 미충족), events.js seenIds leak 주장, drift badge "완전 무방비" 주장, A3 PM→Top notice drop 정책, MCP Phase 3 Proxy (trigger 미충족), Reconciliation hard gate 승격 (운영 데이터 부족), dispatch_audit_log CASCADE FK 변경

---

## P6 이슈 (8건)

### P6-1. ManagerView ESM 추출

- 위치: `server/public/app.js` L1744~L2539 (795줄) + `managerProfileAuthState` L1738~L1743 (5줄)
- 문제: app.js 최대 단일 컴포넌트. 추출하면 ~800줄 감소
- 수정: `server/public/app/components/ManagerView.js` 로 추출
  - `managerProfileAuthState` 포함
  - `ManagerView` 만 export + window bridge (main.js 에서만)
  - ManagerView 는 `useConversation`, `useDispatchAudit`, `useManager` 등 많은 훅 사용 — 전부 window 에서 참조
  - notification 유틸 (`requestNotificationPermission`, `showBrowserNotification`, `pulseTabTitle`) 은 ManagerView 내부에서만 쓰이는지 확인 → 쓰이면 함께 추출, App 에서도 쓰이면 별도 lib 또는 잔류
- 주의:
  - `useManager()` 호출이 App 에서 1회 (`const manager = useManager()`), ManagerView 에서 직접 사용 안 함 — manager 는 prop 으로 받음
  - ManagerView 의 props 를 정확히 파악해서 App → ManagerView 전달 구조 유지
- 예상 감소: ~800줄

### P6-2. `useManager()` → `useConversations()` 전면 마이그레이션

- 위치: `server/public/app/lib/hooks.js` (`useManager` 정의), `server/public/app.js` (App 에서 호출)
- 문제: Phase 6 에서 공존 구조(C안)로 남긴 것. `useManager()` 는 단일 세션 가정의 legacy 훅
- 수정:
  1. `useManager()` 가 반환하는 데이터를 `useConversation('top')` + 추가 상태로 대체할 수 있는지 분석
  2. App 에서 `useManager()` 호출을 `useConversation('top')` 기반으로 전환
  3. `useManager()` 를 hooks.js 에서 제거 (또는 thin wrapper 로 deprecated 표시)
  4. 관련 window bridge 정리
- 주의: `useManager` 가 반환하는 전체 인터페이스 (run, events, connected, status 등) 를 먼저 완전히 파악할 것. 빠뜨리면 ManagerView 전체가 깨짐
- P6-1 과 같은 PR 가능 (또는 P6-1 이후 바로 이어서)

### P6-3. SessionsView + initLegacySessions ESM 추출

- 위치: `server/public/app.js` L715~L1641 (925줄)
  - `SessionsView` L715~L840 (125줄) — Preact wrapper
  - `initLegacySessions` L841~L1641 (800줄) — vanilla JS legacy 코드
- 문제: initLegacySessions 가 800줄의 vanilla JS. 기능적으로 완전 자체 완결적
- 수정: `server/public/app/components/SessionsView.js` 로 추출
  - `SessionsView` + `initLegacySessions` 한 파일 (내부적으로만 연결)
  - `SessionsView` 만 export + window bridge
- 주의: initLegacySessions 가 `apiFetch` 등 window 글로벌을 사용하는지 확인
- 예상 감소: ~925줄

### P6-4. MCP Phase 3: Proxy 방식 (보류 → 스킵)

- **스킵 사유**: execution brief 기각 항목에 "MCP Phase 3 Proxy" 포함. trigger 미충족
- 이 이슈는 건너뛴다

### P6-5. streamJsonEngine 단위 테스트

- 위치: `server/services/streamJsonEngine.js` (481줄)
- 문제: Claude adapter 의 핵심 엔진인데 전용 테스트 없음
- 수정: `server/tests/stream-json-engine.test.js` 신규
  - spawnAgent: spawn args 조합 (cwd, env, claudeFlags, mcpConfig)
  - sendInput: stdin 에 stream-json 프로토콜 메시지 전달
  - parseOutput: stream-json 이벤트 파싱 (result, error, system 등)
  - process lifecycle: stdin close → process exit, kill 동작
  - isAlive / getOutput 동작
- mock: child_process.spawn 을 stub (실제 Claude CLI 호출 불필요)
- 목표: 10~15 테스트

### P6-6. Worker 실행 결과 요약 UI

- 위치: DB `runs` 테이블에 `result_summary` 필드 존재하나 UI 미노출
- 수정:
  1. `result_summary` 가 실제로 어디서 쓰여지는지 확인 (lifecycleService? executionEngine?)
  2. ManagerView 또는 TaskDetailPanel 에서 run 완료 시 `result_summary` 표시
  3. DashboardView 의 run 목록에서도 간략 표시
- 범위: UI 노출만. 새 데이터 수집 로직은 만들지 않음 — 이미 저장되는 데이터만 보여줌
- P6-1 (ManagerView 추출) 완료 후 작업

### P6-7. Self-bridge 중복 정리

- 위치: `server/public/app/components/AgentsView.js`, `server/public/app/components/ProjectsView.js`
- 문제: P5 Codex 피드백 — 두 파일 하단에 `window.X = X` self-bridge 가 있으나 main.js 에서도 bridge 하므로 중복
- 수정: 두 파일에서 self-bridge 라인 제거
- 매우 작은 변경 — 다른 PR 에 포함

### P6-8. pm:\<id\> 테스트 커버리지 확대

- 위치: `server/tests/conversation-unit.test.js` (P5-6 에서 생성)
- 문제: P5 Codex 피드백 — pm:\<id\> sendMessage 라우팅, onSlotCleared probeActive/setActive 경로 미커버
- 수정: 기존 `conversation-unit.test.js` 에 추가 테스트:
  1. `pm:<id>` 대상 sendMessage 라우팅 테스트
  2. `onSlotCleared` via `probeActive` dead detection 테스트
  3. `onSlotCleared` via `setActive` replacement 테스트
- 목표: 5~8 테스트 추가

---

## P7 이슈 (5건)

### P7-1. NewTaskModal + ExecuteModal + TaskDetailPanel ESM 추출

- 위치: `server/public/app.js` L100~L714 (614줄)
  - `NewTaskModal` L100~L218 (118줄)
  - `ExecuteModal` L219~L283 (64줄)
  - `TaskDetailPanel` L284~L714 (430줄) — app.js 잔류 중 두 번째로 큰 컴포넌트
- 문제: 마지막 대형 컴포넌트 추출
- 수정: `server/public/app/components/TaskModals.js` 로 추출
  - 세 컴포넌트 모두 export + window bridge (main.js 에서)
  - notification 유틸 (`requestNotificationPermission`, `showBrowserNotification`, `pulseTabTitle`) 도 이때 정리:
    - ManagerView 에서만 쓰이면 ManagerView.js 로 이동
    - 여러 곳에서 쓰이면 `app/lib/notifications.js` 신규
- 주의:
  - TaskDetailPanel 이 `dueState`, `formatDueDate`, `dueDateMeta` 사용 — 이미 window bridge 됨
  - `BOARD_COLUMNS` 참조 여부 확인
  - `RunInspector` 참조 여부 확인 (이미 ESM 추출됨, window bridge 있음)
- 예상 감소: ~614줄
- P6-1 (ManagerView 추출) + P6-3 (SessionsView 추출) 이후에 진행

### P7-2. Force-delete 탈출구

- 위치: `server/services/pmCleanupService.js`, `server/routes/projects.js` 또는 `server/routes/manager.js`
- 문제: Phase 3a R3 에서 "future work" 판정. 현재 PM dispose 실패 시 fail-closed 로 상태가 잠김 → 복구 방법 없음
- 수정:
  1. `DELETE /api/projects/:id/pm?force=true` 또는 `POST /api/manager/pm/:projectId/force-reset` 엔드포인트 추가
  2. force 모드: dispose 실패를 무시하고 registry + brief + DB 상태를 강제 정리
  3. 일반 모드(기존): fail-closed 유지
  4. 감사 로그: force-delete 사용 시 이벤트 기록
- 주의: fail-closed 원칙을 우회하는 탈출구이므로 명시적 `force=true` 파라미터 필수
- 테스트: force-delete 성공/실패 케이스

### P7-3. 단일 매니저 API thin alias 폐기 검토

- 위치: `server/routes/manager.js` (legacy alias 경로들)
- 문제: Phase 1.5 에서 호환성 보장용 thin alias 유지. 실제 사용 여부 확인 필요
- 수정:
  1. 코드에서 legacy alias 식별 (grep 으로 old endpoints 사용처 확인)
  2. 프론트엔드에서 사용 중이면 새 API 로 전환
  3. 미사용 alias 제거
  4. 사용 중인 alias 에 deprecation 경고 로그 추가
- 범위: 분석 + 전환 가능한 것만 처리. 무리하게 전부 제거하지 말 것

### P7-4. Notification 유틸 정리

- 위치: `server/public/app.js` L1642~L1737
  - `requestNotificationPermission` (8줄)
  - `showBrowserNotification` (17줄)
  - `pulseTabTitle` (68줄)
- 수정: `server/public/app/lib/notifications.js` 로 추출
  - 세 함수 모두 export + window bridge
  - ManagerView, App 등에서 bare identifier 로 참조 가능하도록
- 예상 감소: ~93줄
- P7-1 과 같은 PR 가능

### P7-5. 최종 app.js 슬림화 + 정리

- 목표: app.js 에 순수 App shell 만 남기기
  - `NAV_ITEMS` + `NavSidebar` + `Loading` + `App` + `mount` = ~307줄
  - 더 이상 추출할 컴포넌트가 없는 상태
- 수정:
  1. P6-1/P6-3/P7-1/P7-4 완료 후 app.js 검사
  2. 남아있는 orphan 코드 정리
  3. `/* global */` 주석 최종 정리
  4. CLAUDE.md 의 app.js 줄 수, 아키텍처 섹션 업데이트
  5. spec §15 Implementation Log 에 P6+P7 기록 추가

---

## 권장 PR 분할

### 라운드 1 (병렬 실행 가능)
- **#60** ESM phase 5a: P6-1 + P6-2 (ManagerView 추출 + useManager 마이그레이션) — app.js ~800줄 감소
- **#61** ESM phase 5b: P6-3 (SessionsView + initLegacySessions 추출) — app.js ~925줄 감소
- **#62** 테스트: P6-5 + P6-8 (streamJsonEngine 테스트 + pm:\<id\> 커버리지)
- **#63** 코드 품질: P6-7 (self-bridge 정리) — 작은 변경, 다른 PR 에 포함해도 됨

### 라운드 2 (#60, #61 merge 후)
- **#64** ESM phase 5c: P7-1 + P7-4 (TaskModals + Notifications 추출) — app.js ~707줄 감소
- **#65** Force-delete: P7-2 (PM force-reset 탈출구)

### 라운드 3 (최종)
- **#66** 정리: P7-3 + P7-5 + P6-6 (alias 폐기 + app.js 최종 정리 + result_summary UI + docs/work 삭제)

## 완료 기준

- 전체 이슈 PR 생성 + Codex PASS + merge (P6-4 스킵 제외)
- `npm test` 그린 (현재 460 → 목표 485+)
- app.js 줄 수: 2796 → 목표 ~350 이하 (순수 App shell)
- 각 PR 단독 롤백 가능
- **마지막 PR 에서 `docs/work/p6p7-execution-brief.md` 삭제**
- CLAUDE.md 아키텍처 섹션 업데이트 (app.js 줄 수, 추출된 모듈 목록)
- spec §15 Implementation Log 에 P6+P7 기록 추가
- 최종 보고: PR URL 리스트 + Codex 피드백 + 잔여 항목 + 회귀 리스크
