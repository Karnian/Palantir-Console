# P4 Execution Brief

> 이 문서는 P4 phase 자율 실행용 일회성 브리핑이다. **P4 작업이 전부 완료되면 이 문서를 삭제**해라 (마지막 PR 에서 같이 삭제 또는 별도 cleanup 커밋).

## 컨텍스트

Palantir Console repo (`/Users/K/Desktop/sub_project/palantir_console`). 직전 phase (PR #46~#49) 에서 P3 7건 merge 완료. 현재 `379/379 tests green on main`. app.js 4352줄.

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
2. `docs/specs/manager-v3-multilayer.md` (v3 lock-in 원칙)
3. `docs/mcp-worker-access-proposal.md` (MCP Phase 1 완료 상태, Phase 2 계획)
4. `git log --oneline -20` 으로 P3 merge 맥락 파악

## 반드시 준수

- `useSSE` channels 배열은 `server/services/eventChannels.js` 가 single source. 새 SSE 채널 추가 시 여기만 수정
- `pmCleanupService` 는 fail-closed
- `app.js` 4352줄 단일 파일 — 수정 시 해당 컴포넌트 영역만
- ESM 추출 시 window bridge 패턴 (`main.js` 에서 dynamic import → `window.X = X`) 유지. DriftDrawer / RunInspector / Dropdown / EmptyState / MentionInput 이 선례
- 커밋 메시지 끝 `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- 코드 작업은 각자 워크트리 생성해서 브랜치 기반으로 진행

**기각 항목 건드리지 말 것**: Phase 3b (Claude PM resume — 트리거 조건 미충족), events.js seenIds leak 주장, drift badge "완전 무방비" 주장, A3 PM→Top notice drop 정책

## P4 이슈 (11건)

### MCP 후속

**P4-1. MCP Phase 1 실제 검증** (수동 테스트)
- 위치: 코드 변경 없음 — 실행 확인 + 결과 문서화
- 내용: P3-4에서 allowedTools MCP 확장을 구현했지만 실제 MCP 도구 호출 검증 미완료
- 확인 항목:
  1. Agent profile에 `mcp_tools: ["mcp__claude_ai_Slack__*"]` 설정
  2. Worker(Claude) spawn 시 해당 도구가 실제로 사용 가능한지 확인 — **allowedTools 와일드카드가 CLI에서 동작하는지**가 핵심
  3. CLI `--allowed-tools` 플래그에 와일드카드 전달 시 동작 확인 (`claude --print --allowed-tools "mcp__claude_ai_Slack__*" -p "list your tools"` 같은 smoke)
  4. 결과를 `docs/mcp-worker-access-proposal.md` §7 미결 검증 항목에 기록
- **와일드카드 미지원 확인 시**: `parseMcpTools`가 와일드카드 대신 구체적 도구명을 요구하도록 문서화. 코드 변경 불필요 (사용자가 구체적 도구명을 입력하면 됨).
- PR: 문서 업데이트만이므로 다른 이슈와 묶어도 됨
- Codex 합의: 불필요 (수동 확인)

**P4-2. MCP Phase 2: `--mcp-config` 파이프라인 완성**
- 위치: `server/db/migrations/`, `server/services/`, `server/routes/projects.js`, `server/public/app.js`
- 문제: 프로젝트별 MCP 서버 설정 분리 불가. 현재 글로벌 `~/.claude/.mcp.json` 공유.
- 수정:
  1. 마이그레이션 011: `projects` 테이블에 `mcp_config_path TEXT` 컬럼 추가
  2. `projectService`에서 mcp_config_path CRUD
  3. `claudeAdapter.startSession()`에 `mcpConfig` 파라미터 전달 → `streamJsonEngine.spawnAgent()` (이미 mcpConfig 지원 코드 있음, line 93-95)
  4. `lifecycleService.executeTask()`에서 task의 project mcp_config_path를 spawn에 전달
  5. `pmSpawnService`에서 project의 mcp_config_path를 adapter에 전달
  6. UI: 프로젝트 설정에서 MCP config 파일 경로 입력 필드
- 주의: Codex CLI `--mcp-config` 지원 여부 미확인. codexAdapter는 미지원이면 무시 (silent skip).
- Codex 합의: 마이그레이션 스키마, streamJsonEngine 기존 mcpConfig 코드 활용 방법
- 테스트: 마이그레이션 검증, projectService CRUD, spawn args에 --mcp-config 포함 확인

### Frontend / ESM

**P4-3. CommandPalette ESM 추출**
- 위치: `server/public/app.js` L4144 (~340줄, `function CommandPalette` ~ 끝)
- 문제: app.js 단일 파일 크기 지속 감소 필요
- 수정: `server/public/app/components/CommandPalette.js` 로 추출
  - `NAV_ITEMS` 배열도 같이 추출 (CommandPalette 내부에서만 사용되면) 또는 별도 constants 파일
  - `navigate` 함수 참조 — window.navigate 로 접근 (이미 main.js에서 bridge 됨)
  - `useEscape` 훅은 CommandPalette 내부에서 쓰는지 확인 → 쓴다면 window.useEscape
- 선례: Dropdown/EmptyState 추출과 동일 패턴
- `main.js`에 dynamic import + `window.CommandPalette = CommandPalette` bridge
- 테스트: source invariant — CommandPalette.js export 확인, app.js에 `function CommandPalette` 부재 확인
- app.js 예상 감소: ~340줄 → 4012줄

**P4-4. jsdom 테스트 확장 — Dropdown, MentionInput**
- 위치: `server/tests/` 신규 파일 (P3-3 driftdrawer-jsdom.test.js 인프라 재사용)
- 문제: Dropdown과 MentionInput이 ESM 추출됐지만 DOM 동작 테스트 없음
- 수정:
  1. `server/tests/dropdown-jsdom.test.js`: open/close 동작, 키보드 네비게이션 (↑↓Enter Esc), outside click close, flip-up 계산
  2. `server/tests/mentioninput-jsdom.test.js`: `@` 트리거 시 드롭다운 표시, 필터링, ↑↓Enter로 선택 시 `@projectName ` 삽입, Esc로 닫기
- jsdom 인프라: P3-3에서 만든 vm.createContext + Preact UMD 패턴 재사용. 공통 setup을 `server/tests/helpers/jsdom-preact.js`로 추출 권장.
- 테스트: Dropdown 5개, MentionInput 5개 정도

**P4-5. MentionInput 고도화**
- 위치: `server/public/app/components/MentionInput.js`
- 문제: 현재 프로젝트명 exact-insensitive 필터만 지원
- 수정:
  1. 프로젝트 아이콘/색상 드롭다운에 표시
  2. 최근 사용 순 정렬 (localStorage 기반 `palantir.mention.recent`)
  3. 빈 프로젝트 목록일 때 "프로젝트 없음" 안내
- P4-3 또는 P4-4와 같은 PR 가능

### Runtime / 안정성

**P4-6. Codex error classifier regex 하드닝**
- 위치: `server/services/managerAdapters/codexAdapter.js`
- 문제: codex의 에러 응답 파싱이 regex 기반이라 벤더 포맷 변경에 취약
- 수정:
  1. 현재 classifier 패턴 목록 감사 — 누락된 에러 유형 추가
  2. codex JSON 출력에 structured error field가 있으면 regex보다 우선 사용
  3. 분류 실패 시 fallback을 `unknown_error`로 (현재 silent drop 여부 확인)
- Codex 합의: 현재 패턴의 커버리지 분석, structured field 사용 가능 여부
- 테스트: `manager-codex.test.js` 확장 — 각 에러 패턴별 분류 검증

**P4-7. allowedTools shell 우회 수정 (Phase X)**
- 위치: `server/services/managerAdapters/claudeAdapter.js` L230 KNOWN LIMITATION
- 문제: `Bash(curl:*)` 패턴은 명령어명만 매칭 — `curl ... > file` 로 파일 쓰기 우회 가능
- 수정 방안:
  - A: `Bash(curl:*)` 를 제거하고 Manager가 `WebFetch` 도구만 사용하도록 변경 (system prompt에서 curl 사용 안내 삭제)
  - B: Palantir API endpoint 추가 (`POST /api/tools/http-request`) + Manager allowedTools에 Bash(curl) 대신 이 도구 추가
  - 방안 A 권장 (최소 변경, WebFetch가 이미 allowedTools에 있음)
- 주의: Manager system prompt에서 curl 예시가 있는지 확인 → 있으면 WebFetch로 교체
- Codex 합의: Manager가 curl을 실제로 쓰는 상황이 있는지. Bash(jq/ls/pwd)도 같은 문제 있는지.
- 테스트: allowedTools에 Bash(curl:*) 미포함 확인 source invariant

### Observability / 테스트

**P4-8. E2E smoke test (Playwright)**
- 위치: `server/tests/e2e/` 신규
- 문제: 서버 → 브라우저 → 매니저 라이프사이클 전체 흐름의 통합 테스트 없음
- 수정:
  1. `playwright` devDependency 추가
  2. 테스트 시나리오: 서버 시작 → 브라우저 open → dashboard 로드 → #manager 네비게이션 → agent profile 존재 확인
  3. 별도 npm script: `npm run test:e2e` (기본 `npm test`에는 포함하지 않음 — CI 선택 실행)
  4. playwright MCP 서버가 이미 설치되어 있음 — 활용 가능
- 범위 제한: 매니저 세션 시작/메시지 전송은 auth + CLI 의존이므로 이번에는 UI 렌더링 + 네비게이션만
- Codex 합의: playwright vs puppeteer, test script 분리 전략

## 권장 PR 분할 (Codex 합의 후 조정)

- **#50** ESM phase 3 + MentionInput 고도화: P4-3 + P4-5 (CommandPalette 추출 + MentionInput 개선)
- **#51** jsdom 테스트 확장: P4-4 (Dropdown/MentionInput DOM 테스트 + 공통 헬퍼 추출)
- **#52** MCP Phase 2: P4-2 + P4-1 (--mcp-config 파이프라인 + 검증 결과 문서화)
- **#53** Runtime 하드닝: P4-6 + P4-7 (Codex classifier + allowedTools shell 우회)
- **#54** E2E smoke: P4-8 (Playwright 기본 스모크)

## 완료 기준

- 11건 전부 PR 생성 + Codex PASS + merge (P4-1 수동 검증 결과에 따라 scope 조정 허용)
- `npm test` 그린 (현재 379 → 목표 400+)
- 각 PR 단독 롤백 가능
- **마지막 PR 에서 `docs/work/p4-execution-brief.md` 삭제** (또는 별도 cleanup 커밋)
- 최종 보고: PR URL 리스트 + Codex 피드백 + 잔여 P5 + 회귀 리스크

## P5 후보 (이번에 하지 않음, 기록만)

- MCP Phase 3: Proxy 방식 (멀티 테넌트 / 감사)
- Phase 3b: Claude PM resume (spec 트리거 조건 미충족)
- app.js ESM phase 4+: ManagerView, BoardView 등 대형 컴포넌트
- Dashboard 위젯 커스터마이징
- Worker 실행 결과 요약 자동 생성
