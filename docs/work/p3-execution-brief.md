# P3 Execution Brief

> 이 문서는 P3 phase 자율 실행용 일회성 브리핑이다. **P3 작업이 전부 완료되면 이 문서를 삭제**해라 (마지막 PR 에서 같이 삭제 또는 별도 cleanup 커밋).

## 컨텍스트

Palantir Console repo (`/Users/K/Desktop/sub_project/palantir_console`) 의 P3 이슈 7건을 자율 실행으로 전부 처리한다. 직전 phase (PR #38~#45) 에서 P2 10건 + codex manager fix 가 merge 됐고 현재 `346/346 tests green on main`. P2 에서 deferred 된 항목 5건 + MCP worker access 제안서 기반 2건.

## 실행 방식

- default autonomous mode (CLAUDE.md "Working style" 섹션 참조)
- phase 기반 표준 체인: `branch → 구현 → npm test → codex 교차검증 (PASS까지 반복) → commit → PR → merge → main pull → 다음 phase`
- `.ao/autonomy.json` 이 `{codex:{approval:"auto-edit",hostSandbox:"workspace-write"}}` 로 이미 설정됨 — codex exec 비대화형 호출 가능
- Codex 를 매 phase peer reviewer 로 참여시켜 PASS 받기. 가능하면 `agent-olympus:athena` 로 Claude+Codex peer-to-peer 팀 구성
- 의사결정 포인트는 Codex 합의로 진행. 사용자에게 물어보지 말 것
- 다음 상황만 사용자 보고:
  - Codex 가 5라운드 넘도록 수렴 안 됨
  - spec 재해석이 필요한 충돌
  - 대규모 리팩토링이 phase 본질과 무관하게 강요되는 경우

## 사전 필독

1. `CLAUDE.md` 전체 — 특히 "Things to Watch Out For"
2. `docs/specs/manager-v3-multilayer.md` (v3 lock-in 원칙)
3. `docs/mcp-worker-access-proposal.md` (MCP 접근 방안 — 방안 A 우선 적용)
4. `git log --oneline -15` 로 #38~#45 의 변경 맥락 파악

## 반드시 준수

- `useSSE` channels 배열은 이제 `server/services/eventChannels.js` 가 single source. 새 SSE 채널 추가 시 여기만 수정 + `sse-channels.test.js` 가 drift 자동 감지
- `pmCleanupService` 는 fail-closed
- `app.js` 4486줄 단일 파일 — 수정 시 해당 컴포넌트 영역만
- ESM 추출 시 window bridge 패턴 (`main.js` 에서 dynamic import → `window.X = X`) 유지. DriftDrawer + RunInspector 가 선례
- 커밋 메시지 끝 `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

**기각 항목 건드리지 말 것**: P1-7 (run:needs_input fresh), ADD-2 (projects.js 이미 502), ADD-4 (factory singleton), events.js seenIds leak 주장, drift badge "완전 무방비" 주장, A3 PM→Top notice drop 정책

## P3 이슈 (7건)

### Frontend / ESM

**P3-1. @mention 자동완성** (P2-9b deferred)
- 위치: `server/public/app.js` ManagerView input 영역
- 문제: PM router 의 `@<name>` prefix 를 사용자가 직접 타이핑해야 함. 프로젝트명 기억 부담.
- 수정: input 에서 `@` 타이핑 시 프로젝트 목록 dropdown 표시 (exact-insensitive 필터). 선택 시 `@projectName ` prefix 삽입. `routerService` 의 매칭 로직과 일관되게.
- 구현 참고: `app.js:425` 의 기존 `Dropdown` 컴포넌트 재사용 or 경량 inline autocomplete. ESM 모듈로 추출 권장 (`app/components/MentionInput.js`).
- Codex 합의: Dropdown 재사용 vs 신규 autocomplete 컴포넌트. 키보드 내비게이션 (↑↓Enter Esc) 필수.
- 테스트: source invariant — `@` handler 존재 + dropdown render 확인.

**P3-2. app.js ESM 추출 phase 2** (P2-10 후속)
- 위치: `server/public/app.js` (~4486줄)
- 선례: DriftDrawer (`app/components/DriftDrawer.js`), RunInspector (`app/components/RunInspector.js`) 가 이미 ESM 추출 완료. `main.js` 에서 dynamic import → `window.X` bridge.
- 추출 대상 (우선순위순):
  1. `Dropdown` (L425, ~116줄) — P3-1 @mention 에서도 재사용, 범용 컴포넌트
  2. `EmptyState` (L131, ~30줄) — 순수 presentational, 의존 없음
  3. `CommandPalette` (L4144, ~340줄) — 독립적, keyboard shortcut 바인딩 포함
- **한 번에 전부 금지**. 1-2개씩 추출 → 테스트 → merge. P3-1 과 묶어서 진행 가능.
- 테스트: 기존 `frontend-a11y-envelope.test.js` source invariant 에 ESM export 확인 추가.

**P3-3. DriftDrawer jsdom 테스트** (P2-6 deferred)
- 위치: `server/tests/frontend-a11y-envelope.test.js` (현재 source grep 수준)
- 문제: focus trap / Tab cycle / auto-focus 실제 DOM 동작 검증 없음.
- 수정: `jsdom` devDependency 추가. DriftDrawer 가 이미 ESM export 이므로 jsdom window 에서 preact render 가능.
- 주의: jsdom + preact 10.x 조합 검증. `window.preact` / `window.htm` mock 필요.
- Codex 합의: jsdom 추가가 `npm install` 시간 / CI 에 주는 영향. 테스트 범위 (focus trap만? 전체 렌더?).
- 테스트: focus trap cycle (Tab → 마지막 요소 → 첫 요소), auto-focus on open, Esc close.

### Backend / MCP

**P3-4. MCP Worker/PM 접근 — Phase 1: allowedTools 확장** (mcp-worker-access-proposal.md 방안 A)
- 위치: `server/services/agentProfileService.js`, `server/services/managerAdapters/claudeAdapter.js`, `server/services/lifecycleService.js`
- 문제: Worker/PM 이 MCP 도구를 사용할 수 없음. CLI 가 `~/.claude/.mcp.json` 을 자동 로드하지만 `allowedTools` 화이트리스트에 MCP 도구가 없음.
- 수정 (proposal §6 참조):
  1. `capabilities_json` 에 `mcp_tools` 배열 지원 (`["mcp__slack__*", "mcp__notion__*"]`)
  2. `claudeAdapter.startSession()` 에서 allowedTools 빌드 시 MCP 도구 병합
  3. `lifecycleService.executeTask()` 에서 profile 의 MCP 도구를 Worker spawn 에 전달
  4. UI: Agent profile 편집에서 MCP 도구 입력 (textarea or chip input)
- **미결 검증** (proposal §7): allowedTools 와일드카드 (`mcp__slack__*`) 지원 여부, OAuth 토큰 자식 프로세스 전달 여부. 실제 테스트 필요 — 실패 시 scope 축소하고 사용자 보고.
- Codex 합의: 와일드카드 동작 확인 방법, Worker `bypassPermissions` + allowedTools 미지정 시 이미 MCP 접근 가능한지.
- 테스트: agent profile mcp_tools 파싱, allowedTools 병합 로직, spawn args 에 MCP 도구 포함 확인.

**P3-5. MCP config UI + 프로젝트 설정 연동**
- 위치: `server/public/app.js` Agent profile 편집 영역, `server/routes/agents.js`
- 문제: P3-4 의 backend 가 완성돼도 사용자가 UI 에서 MCP 도구를 설정할 방법이 없음.
- 수정:
  1. Agent profile 편집 화면에 "MCP Tools" 섹션 추가 (textarea — 줄바꿈 구분 or JSON 배열)
  2. 저장 시 `capabilities_json.mcp_tools` 로 persist
  3. profile 목록/상세에서 MCP 도구 표시
- P3-4 와 같은 PR 로 묶어도 됨.
- 테스트: UI source invariant (MCP Tools 입력 필드 존재).

### Observability

**P3-6. derivePmProjectId diagnostic → eventBus 연결** (P2 deferred)
- 위치: `server/services/runService.js`
- 문제: P2-4 에서 warn 로그는 추가됐지만 eventBus / run_events 테이블로 라우팅 안 됨.
- 수정: mismatch 발생 시 `eventBus.emit('diagnostic:pm_project_mismatch', { runId, derived, joined })`. 선택적으로 `run_events` 에 `{type: 'diagnostic', subtype: 'pm_project_mismatch'}` 기록.
- 주의: eventChannels.js 에 새 채널 추가 시 `CLIENT_REQUIRED_LIVE` 에는 넣지 말 것 (diagnostic 은 서버 관측 전용, 프론트 SSE 불필요).
- 테스트: `p2-observability.test.js` 확장 — mismatch 시 eventBus emit 확인.

### Cleanup

**P3-7. mcp-worker-access-proposal.md 정리**
- P3-4/P3-5 가 merge 되면 proposal 의 Phase 1 이 완료. proposal 문서 상태를 `Phase 1 완료` 로 업데이트하고 체크리스트 반영.
- 별도 PR 불필요 — P3-4 또는 P3-5 PR 에 포함.

## 권장 PR 분할 (Codex 합의 후 조정)

- **#46** ESM phase 2 + @mention: P3-1 + P3-2 (Dropdown ESM 추출 → @mention input 에서 사용)
- **#47** jsdom a11y: P3-3 (jsdom devDep + DriftDrawer focus trap 테스트)
- **#48** MCP access phase 1: P3-4 + P3-5 + P3-7 (backend allowedTools + UI + proposal 문서 업데이트)
- **#49** observability round 2: P3-6 (diagnostic eventBus 연결)

## 완료 기준

- 7건 전부 PR 생성 + Codex PASS + merge (MCP 와일드카드 미지원 시 P3-4 scope 축소 허용)
- `npm test` 그린 (현재 346 → 목표 370+)
- 각 PR 단독 롤백 가능
- **마지막 PR 에서 `docs/work/p3-execution-brief.md` 삭제** (또는 별도 cleanup 커밋)
- 최종 보고: PR URL 리스트 + Codex 피드백 + 잔여 P4 + 회귀 리스크

## P4 후보 (이번에 하지 않음, 기록만)

- codex error classifier regex 추가 하드닝 (벤더 structured field 안정화 대기)
- MCP Phase 2: `--mcp-config` 파이프라인 완성 (프로젝트별 MCP 분리)
- MCP Phase 3: Proxy 방식 (멀티 테넌트 / 감사)
- Phase 3b: Claude PM resume (spec 트리거 조건 미충족)
- app.js ESM phase 3+ (ManagerView, BoardView 등 대형 컴포넌트)
