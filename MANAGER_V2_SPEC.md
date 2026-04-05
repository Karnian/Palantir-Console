# Manager Session V2 -- UI/UX Specification

> Palantir Console의 "Manager" 기능 스펙.
> Manager는 별도 LLM 통합 없이, Claude Code CLI 세션 하나를 더 띄워서
> Palantir Console REST API를 도구 삼아 worker 에이전트들을 관리하는 구조다.

---

## 1. Problem Statement

**WHO**: 여러 AI 코딩 에이전트를 동시에 운영하는 개발자 (1인 또는 소규모 팀).

**WHAT**: 현재 Palantir Console은 "사람이 직접" Task Board에서 에이전트를 하나씩 실행하고,
Dashboard에서 상태를 확인하고, needs_input에 응답하는 수동 워크플로우다.
에이전트가 3개 넘어가면 컨텍스트 스위칭 비용이 폭증하고,
"이 에이전트 끝나면 다음 에이전트 실행" 같은 조건부 오케스트레이션이 불가능하다.

**WHY NOW**: Claude Code CLI가 `-p` 모드와 interactive stdin 모드를 모두 지원하므로,
Manager를 별도 LLM 서비스로 만들 필요 없이 "Claude Code 세션 하나 더 띄우기"로 해결 가능.
기존 스펙(MANAGER_SESSION_UI_SPEC.md)의 복잡한 LLM 통합, managerService,
manager_plans 테이블 등을 전부 제거하고 단순한 구조로 전환한다.

---

## 2. Scale Assessment

**M (Medium)** -- 1~2주, 2 Phase.

기존 코드베이스(ExecutionEngine, lifecycleService, RunInspector)를 최대한 재사용.
새로운 서비스 레이어는 최소화하고, 주된 작업은 UI 컴포넌트 추가 + subprocess engine 강화.

---

## 3. Architecture

```
사용자 ←→ [Manager Chat UI]  ←→  [Manager Session = Claude Code CLI subprocess]
                                          │
                                          │  system prompt에 API 사용법 포함
                                          │  stdin/stdout 파이프로 통신
                                          ▼
                                [Palantir Console REST API]
                                    (localhost:4177)
                                          │
                                ┌─────────┼─────────┐
                                ▼         ▼         ▼
                            [Worker 1] [Worker 2] [Worker 3]
                            (Claude)   (Codex)    (Claude)
```

### 핵심 원칙

1. **Manager = 특수한 Run**: `runs` 테이블에 `is_manager=1` 플래그만 추가. 별도 테이블 불필요.
2. **SubprocessEngine 사용**: Manager 세션은 반드시 subprocess로 실행 (tmux 불가 -- stdin 파이프 필요).
3. **System Prompt**: Manager 세션 시작 시, Palantir API 사용법이 담긴 system prompt를 자동 주입.
4. **기존 API 그대로**: Manager가 `curl` 또는 Claude Code의 bash tool로 `/api/runs`, `/api/tasks` 등을 호출.

### Manager에게 제공할 API (system prompt에 문서화)

| Method | Endpoint | 용도 |
|--------|----------|------|
| GET | /api/runs | 현재 세션들 상태 조회 |
| GET | /api/runs/:id/output | 세션 실시간 출력 확인 |
| GET | /api/runs/:id | 특정 Run 상세 조회 |
| POST | /api/tasks/:id/execute | 새 에이전트 실행 |
| POST | /api/runs/:id/input | 에이전트에 텍스트 입력 전달 |
| POST | /api/runs/:id/cancel | 에이전트 취소 |
| GET | /api/tasks | 태스크 목록 |
| POST | /api/tasks | 태스크 생성 |
| PATCH | /api/tasks/:id/status | 태스크 상태 변경 |
| GET | /api/projects | 프로젝트 목록 |

---

## 4. Data Model Changes (Minimal)

### 4.1 Migration: 002_manager_flag.sql

```sql
-- runs 테이블에 is_manager 컬럼 추가
ALTER TABLE runs ADD COLUMN is_manager INTEGER DEFAULT 0;

-- Manager run에는 task_id가 없을 수 있음 (프로젝트 레벨 관리자)
-- 기존 task_id는 이미 nullable (REFERENCES ... ON DELETE CASCADE)

CREATE INDEX idx_runs_manager ON runs(is_manager) WHERE is_manager = 1;

INSERT INTO schema_version (version) VALUES (2);
```

**추가/변경 없음:**
- manager_plans 테이블 -- 불필요 (Manager CLI가 텍스트로 설명)
- plan_runs 테이블 -- 불필요
- manager_messages 테이블 -- 불필요 (run_events로 충분)
- /api/manager/* 엔드포인트 -- 불필요

### 4.2 Manager Run의 구조

```
runs 테이블의 한 row:
{
  id: "mgr-xxxx",
  task_id: null,           // Manager는 특정 Task에 종속되지 않음
  agent_profile_id: "claude-code",
  is_manager: 1,
  status: "running",       // queued → running → completed/failed
  prompt: "...",           // Manager system prompt
  tmux_session: null,      // subprocess 전용
  ...
}
```

---

## 5. API Changes (Minimal)

### 5.1 Manager 세션 시작

**POST /api/manager/start**

```json
// Request
{
  "project_id": "proj-123"   // optional: 특정 프로젝트 컨텍스트
}

// Response
{
  "run": { "id": "mgr-xxxx", "is_manager": 1, "status": "running", ... }
}
```

서버 내부 동작:
1. `runs` 테이블에 `is_manager=1`인 Run 생성
2. SubprocessEngine으로 `claude` 프로세스 spawn (interactive 모드)
3. System prompt를 stdin으로 주입

### 5.2 Manager 세션 입력/출력

기존 API를 그대로 사용:
- **POST /api/runs/:id/input** -- Manager에게 사용자 메시지 전달
- **GET /api/runs/:id/output** -- Manager의 stdout 출력 가져오기
- **POST /api/runs/:id/cancel** -- Manager 세션 종료

### 5.3 기존 API 필터 추가

**GET /api/runs** 에 `exclude_manager=true` 옵션 추가 (기존 Dashboard에서 Manager run이 worker 목록에 섞이지 않도록).

```
GET /api/runs?exclude_manager=true   → is_manager=0인 run만 반환
GET /api/runs?is_manager=true        → Manager run만 반환
```

---

## 6. UI Layout

### 6.1 Navigation 변경

기존 NAV_ITEMS에 Manager 뷰 추가:

```javascript
const NAV_ITEMS = [
  { hash: 'dashboard', icon: '\u25C9', label: 'Dashboard' },
  { hash: 'manager',   icon: '\u2630', label: 'Manager' },   // 신규
  { hash: 'board',     icon: '\u2592', label: 'Task Board' },
  { hash: 'projects',  icon: '\u25A3', label: 'Projects' },
  { hash: 'agents',    icon: '\u2699', label: 'Agents' },
];
```

### 6.2 Manager View -- 와이어프레임

```
┌──────────────────────────────────────────────────────────────────────┐
│ ☰ Manager                                                    [Stop] │
├──────────────────────────┬───────────────────────────────────────────┤
│                          │                                           │
│   MANAGER CHAT PANEL     │         SESSION GRID                      │
│                          │                                           │
│   ┌──────────────────┐   │   ┌─ Attention Strip ──────────────────┐  │
│   │ [Manager output] │   │   │ ⚠ Worker-3: needs_input  [Respond] │  │
│   │ ...              │   │   │ ✗ Worker-5: failed       [Retry]   │  │
│   │ ...              │   │   └────────────────────────────────────┘  │
│   │ ...              │   │                                           │
│   │ ...              │   │   ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│   │ ...              │   │   │Worker-1 │ │Worker-2 │ │Worker-4 │   │
│   │                  │   │   │claude   │ │codex    │ │claude   │   │
│   │                  │   │   │running  │ │running  │ │completed│   │
│   │                  │   │   │ 5m ago  │ │ 2m ago  │ │ done    │   │
│   └──────────────────┘   │   └─────────┘ └─────────┘ └─────────┘   │
│                          │                                           │
│   ┌──────────────────┐   │                                           │
│   │ [user input]  ▶  │   │                                           │
│   └──────────────────┘   │                                           │
│                          │                                           │
├──────────────────────────┴───────────────────────────────────────────┤
│ (Session Detail slide-over -- 카드 클릭 시 오른쪽에서 슬라이드)       │
└──────────────────────────────────────────────────────────────────────┘
```

**레이아웃 비율**: Chat Panel 40% / Session Grid 60% (리사이즈 가능하면 좋지만 MVP에선 고정).

**Manager 세션이 없을 때 (초기 상태)**:

```
┌──────────────────────────────────────────────────────────────────────┐
│ ☰ Manager                                                           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│              ┌────────────────────────────────┐                      │
│              │  No active Manager session.     │                      │
│              │                                 │                      │
│              │  Manager는 Claude Code CLI를    │                      │
│              │  사용하여 worker 에이전트들을    │                      │
│              │  자동으로 조율합니다.            │                      │
│              │                                 │                      │
│              │  [Start Manager Session]        │                      │
│              │                                 │                      │
│              │  Optional: Project [▾ Select]   │                      │
│              └────────────────────────────────┘                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 7. Component Structure

### 7.1 Component Tree

```
App
├── NavSidebar (기존 -- Manager 항목 추가)
├── ManagerView (신규)
│   ├── ManagerEmptyState        -- 세션 없을 때
│   ├── ManagerChatPanel         -- 좌측 채팅
│   │   ├── ChatMessageList      -- Manager stdout 렌더링
│   │   └── ChatInput            -- 사용자 입력 → stdin
│   ├── SessionGrid              -- 우측 worker 그리드
│   │   ├── AttentionStrip       -- needs_input + failed만
│   │   └── SessionCard[]        -- 개별 worker 카드
│   └── SessionDetailSlideOver   -- 카드 클릭 시 상세
│       ├── OutputViewer         -- 실시간 출력
│       ├── EventTimeline        -- run_events
│       └── InputBar             -- send input
├── DashboardView (기존)
├── BoardView (기존)
├── ProjectsView (기존)
└── AgentsView (기존)
```

### 7.2 Component 상세

#### ManagerView

최상위 Manager 뷰. Manager Run의 존재 여부에 따라 분기.

```
State:
- managerRun: Run | null        (is_manager=1인 active run)
- workerRuns: Run[]             (is_manager=0인 run 목록)
- selectedWorker: Run | null    (slide-over 대상)

Mount 시:
1. GET /api/runs?is_manager=true → active manager run 확인
2. GET /api/runs?exclude_manager=true → worker runs 로드
3. SSE 연결로 실시간 업데이트
```

#### ManagerChatPanel

Manager CLI 세션의 stdin/stdout을 릴레이하는 채팅 UI.

```
Props:
- managerRunId: string

동작:
- 2초 간격으로 GET /api/runs/:id/output 폴링하여 새 출력 표시
- 사용자 입력 → POST /api/runs/:id/input
- 출력은 monospace font, 터미널 스타일
- auto-scroll to bottom (새 출력 시)
- 최대 표시 라인: 500줄 (이전 내용은 truncate)
```

#### AttentionStrip

긴급 대응이 필요한 worker만 최상단에 표시.

```
Props:
- runs: Run[]

필터: status === 'needs_input' || status === 'failed'
정렬: needs_input 먼저, 그 다음 failed. 각 그룹 내에서는 updated_at 오래된 순.

각 항목:
- Worker 이름 (Task title 또는 Run prompt 앞 30자)
- 상태 배지
- 경과 시간
- 액션 버튼: [Respond] (needs_input) / [Retry] (failed)
- [Respond] 클릭 → SessionDetailSlideOver 열기
- [Retry] 클릭 → 재실행 확인 후 POST /api/tasks/:id/execute
```

#### SessionCard

개별 worker 세션 요약 카드.

```
Props:
- run: Run

표시:
- Agent 아이콘 + 이름 (agent_profiles에서)
- Task title (task_id로 조회) 또는 prompt 앞 40자
- Status 배지 (색상 코드: running=green, needs_input=amber, failed=red, completed=blue)
- 경과 시간 (started_at 기준)
- 출력 미리보기 (마지막 2줄, 단색 monospace)

클릭 → SessionDetailSlideOver 열기
```

#### SessionDetailSlideOver

오른쪽에서 슬라이드 인 하는 상세 패널. 기존 RunInspector의 리팩토링 버전.

```
Props:
- run: Run
- onClose: () => void

내용:
- 상단: Run 메타 (status, agent, task, started_at, duration)
- 중단: 실시간 출력 (GET /api/runs/:id/output, 2초 폴링)
- 하단: 입력 바 (active 상태일 때만)
- 우상단: [Cancel] 버튼 (active 상태일 때만)

기존 RunInspector의 모달 형태를 slide-over로 변경.
Manager View 안에서만 slide-over, 다른 뷰에서는 기존 모달 유지.
```

---

## 8. Interaction Flow

### 8.1 Manager 세션 시작

```
1. 사용자: Manager 뷰 진입 (#manager)
2. UI: ManagerEmptyState 표시 (활성 Manager 없으면)
3. 사용자: [Start Manager Session] 클릭
   - Optional: 프로젝트 선택
4. UI → API: POST /api/manager/start { project_id? }
5. Server:
   a. Run 생성 (is_manager=1, status=queued)
   b. SubprocessEngine.spawnAgent() -- claude interactive 모드
   c. System prompt를 stdin으로 주입
   d. Run status → running
6. UI: ManagerChatPanel + SessionGrid 레이아웃으로 전환
7. 사용자: Chat input에 자연어 지시 입력
   예: "auth 모듈 리팩토링을 Claude에게 시키고,
        테스트 작성은 Codex에게 시켜줘"
8. Manager Claude:
   a. curl로 POST /api/tasks 호출 → Task 생성
   b. curl로 POST /api/tasks/:id/execute 호출 → Worker 실행
   c. 주기적으로 GET /api/runs 호출 → 상태 모니터링
   d. needs_input 감지 시 사용자에게 보고하거나 직접 응답
9. UI: SessionGrid에 새 Worker 카드 실시간 추가
```

### 8.2 Manager가 Worker 모니터링

```
1. Manager Claude: GET /api/runs → running workers 확인
2. Manager Claude: GET /api/runs/:id/output → 특정 worker 출력 확인
3. Worker가 needs_input 상태 진입
4. SSE → UI: AttentionStrip에 해당 worker 표시
5. 동시에 Manager Claude가 다음 폴링에서 감지
6. Manager Claude: POST /api/runs/:id/input → worker에게 응답
   또는: 사용자에게 "Worker-3이 DB 마이그레이션 방향을 물어봅니다.
   어떻게 할까요?" 라고 보고
7. 사용자: Chat input으로 지시 → Manager가 대신 응답
```

### 8.3 Worker 완료/실패

```
1. Worker 프로세스 종료 → lifecycleService.checkHealth() 감지
2. Run status → completed 또는 failed
3. SSE → UI: SessionCard 상태 업데이트
4. failed인 경우: AttentionStrip에 표시
5. Manager Claude: 다음 폴링에서 감지 → 사용자에게 보고
   예: "Worker-1(auth 리팩토링)이 완료되었습니다.
        Worker-5(테스트)는 실패했습니다. 재시도할까요?"
```

### 8.4 Manager 세션 종료

```
1. 사용자: [Stop] 버튼 클릭 (Manager View 헤더)
2. UI → API: POST /api/runs/:managerRunId/cancel
3. Server: SubprocessEngine.kill(managerRunId)
4. Manager Run status → cancelled
5. Worker들은 계속 실행됨 (독립 프로세스)
6. UI: ManagerEmptyState로 전환
```

---

## 9. Manager System Prompt

Manager Claude Code 세션 시작 시 stdin으로 주입할 system prompt.
`server/prompts/manager-system.md` 파일로 관리.

```markdown
# Palantir Console Manager

당신은 AI 코딩 에이전트 오케스트레이터입니다.
Palantir Console의 REST API를 사용하여 worker 에이전트들을 관리합니다.

## 사용 가능한 API

Base URL: http://localhost:{{PORT}}
{{#if AUTH_TOKEN}}Authorization: Bearer {{AUTH_TOKEN}}{{/if}}

### 세션 관리
- GET /api/runs -- 모든 run 목록 (status 필터: ?status=running)
- GET /api/runs/:id -- 특정 run 상세
- GET /api/runs/:id/output -- run의 실시간 터미널 출력 (최근 200줄)
- POST /api/runs/:id/input -- run에 텍스트 입력 전달. Body: {"text": "..."}
- POST /api/runs/:id/cancel -- run 취소

### 태스크 관리
- GET /api/tasks -- 태스크 목록
- POST /api/tasks -- 태스크 생성. Body: {"title": "...", "project_id": "...", "priority": "high"}
- PATCH /api/tasks/:id/status -- 상태 변경. Body: {"status": "todo"}

### 에이전트 실행
- GET /api/agents -- 사용 가능한 에이전트 프로필
- POST /api/tasks/:id/execute -- 에이전트 실행. Body: {"agent_profile_id": "claude-code", "prompt": "..."}

### 프로젝트
- GET /api/projects -- 프로젝트 목록

## 행동 지침

1. 사용자의 지시를 받으면, 적절한 API를 호출하여 작업을 수행하세요.
2. Worker 상태를 주기적으로 확인하세요 (GET /api/runs?status=running).
3. Worker가 needs_input 상태이면 사용자에게 보고하세요.
4. Worker가 실패하면 원인을 파악하고 (GET /api/runs/:id/output) 사용자에게 보고하세요.
5. 한 번에 너무 많은 worker를 실행하지 마세요 (최대 동시 3개 권장).
6. bash tool로 curl 명령을 사용하여 API를 호출하세요.

## 현재 상태
{{CURRENT_STATUS}}
```

`{{PORT}}`, `{{AUTH_TOKEN}}`, `{{CURRENT_STATUS}}`는 세션 시작 시 서버가 치환.
`CURRENT_STATUS`에는 현재 active runs, tasks 목록 요약이 포함됨.

---

## 10. ExecutionEngine Refactoring

### 10.1 방향: SubprocessEngine을 primary로, TmuxEngine은 선택적 fallback

현재 상태:
- `createExecutionEngine()`: tmux 있으면 TmuxEngine, 없으면 SubprocessEngine
- Manager는 반드시 SubprocessEngine 필요 (stdin 파이프)
- 일반 Worker는 어느 쪽이든 가능

변경:

```javascript
function createExecutionEngine(options = {}) {
  const hasTmux = detectTmux();
  const preferSubprocess = options.preferSubprocess ?? true;  // 기본값 변경

  if (preferSubprocess || !hasTmux) {
    console.log('[executionEngine] Using SubprocessEngine');
    return createSubprocessEngine();
  }

  console.log('[executionEngine] Using TmuxEngine');
  return createTmuxEngine();
}
```

### 10.2 SubprocessEngine 강화

Manager 세션을 위해 SubprocessEngine에 필요한 개선사항:

```javascript
// 1. Output 버퍼 크기 증가 (Manager는 대화가 길어짐)
const MAX_BUFFER_LINES = 2000;  // 기존 500 → 2000

// 2. Output callback 지원 (SSE push용)
function spawnAgent(runId, { command, args, cwd, env, onOutput }) {
  // ...기존 코드...

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    outputBuffer.push(...lines);
    while (outputBuffer.length > MAX_BUFFER_LINES) outputBuffer.shift();
    // 새 출력 콜백 (선택적)
    if (onOutput) onOutput(data.toString());
  });
}

// 3. Incremental output API
// 기존 getOutput()은 전체 버퍼를 반환 → 폴링마다 전체 전송은 비효율
function getOutputSince(runId, afterLine = 0) {
  const proc = processes.get(runId);
  if (!proc) return { lines: [], total: 0 };
  return {
    lines: proc.outputBuffer.slice(afterLine),
    total: proc.outputBuffer.length,
  };
}
```

### 10.3 tmux 제거 판단 기준

Phase 1에서는 tmux를 제거하지 않는다. 이유:
- 기존 worker들이 tmux에서 잘 동작하고 있음
- tmux의 장점: 서버 재시작 후에도 세션 생존 (orphan recovery)
- subprocess의 단점: 서버 프로세스가 죽으면 child도 죽음

Phase 2에서 평가 후 결정:
- subprocess가 안정적으로 동작하면 tmux를 deprecated로 표시
- process supervisor (PM2 등)로 서버 안정성 확보 후 tmux 제거 가능

---

## 11. User Stories

### US-001: Manager 세션 시작

> 여러 에이전트를 동시에 관리해야 하는 개발자로서,
> 자연어로 지시하면 에이전트들을 자동으로 생성/실행/모니터링하는
> Manager를 시작하고 싶다.

**GIVEN** Manager 뷰에 진입했고, 활성 Manager 세션이 없을 때
**WHEN** [Start Manager Session] 버튼을 클릭하면
**THEN** Claude Code CLI가 subprocess로 시작되고, Manager Chat Panel이 나타나며,
1초 이내에 Manager의 첫 출력이 Chat Panel에 표시된다.

**GIVEN** Manager 세션이 이미 실행 중일 때
**WHEN** Manager 뷰에 진입하면
**THEN** 기존 Manager 세션의 Chat Panel과 SessionGrid가 즉시 표시된다.

### US-002: Manager에게 작업 지시

> Manager가 실행 중인 상태에서,
> 자연어로 복합 작업을 지시하고 싶다.

**GIVEN** Manager Chat Panel이 활성 상태일 때
**WHEN** "auth 모듈을 리팩토링하고, 완료되면 테스트를 작성해줘"라고 입력하면
**THEN** 입력이 Manager stdin으로 전달되고, 입력 필드가 비워지며,
Manager의 응답(stdout)이 Chat Panel에 표시된다.

### US-003: Worker 세션 실시간 모니터링

> Manager가 Worker를 실행한 상태에서,
> 모든 Worker의 상태를 한눈에 파악하고 싶다.

**GIVEN** Manager가 Worker 에이전트 2개를 실행했을 때
**WHEN** Session Grid를 확인하면
**THEN** 각 Worker가 개별 카드로 표시되며,
상태(running/needs_input/completed/failed), 에이전트 종류, 경과 시간이 보인다.
SSE로 3초 이내에 상태 변경이 반영된다.

### US-004: Attention Strip -- 긴급 대응

> Worker가 사용자 입력을 기다리거나 실패했을 때,
> 즉시 인지하고 대응하고 싶다.

**GIVEN** Worker-3이 needs_input 상태이고 Worker-5가 failed 상태일 때
**WHEN** Session Grid를 확인하면
**THEN** Attention Strip에 Worker-3과 Worker-5만 표시되며,
Worker-3에는 [Respond] 버튼, Worker-5에는 [Retry] 버튼이 있다.
needs_input이 failed보다 상위에 위치한다.

### US-005: Worker 상세 보기 (Slide-over)

> 특정 Worker의 상세 출력을 확인하고, 직접 입력을 보내고 싶다.

**GIVEN** Session Grid에 Worker 카드가 있을 때
**WHEN** Worker 카드를 클릭하면
**THEN** 오른쪽에서 Session Detail slide-over가 나타나며,
실시간 출력(2초 폴링), 이벤트 타임라인, 입력 바가 표시된다.

**GIVEN** Slide-over가 열린 상태에서
**WHEN** 입력 바에 텍스트를 입력하고 Enter를 누르면
**THEN** POST /api/runs/:id/input이 호출되고, Worker에 입력이 전달된다.

### US-006: Manager 세션 종료

> Manager 세션을 종료하되, Worker들은 계속 실행하고 싶다.

**GIVEN** Manager 세션이 실행 중일 때
**WHEN** [Stop] 버튼을 클릭하면
**THEN** Manager 프로세스만 종료되고, Worker들은 계속 실행된다.
UI는 ManagerEmptyState로 전환된다.

### US-007: Dashboard에서 Manager 분리

> 기존 Dashboard에서 Manager run이 일반 Worker와 섞이지 않아야 한다.

**GIVEN** Manager 세션과 Worker 3개가 실행 중일 때
**WHEN** Dashboard 뷰를 확인하면
**THEN** Worker 3개만 표시되고, Manager run은 표시되지 않는다.

---

## 12. Success Metrics

| Metric | Target | 측정 방법 |
|--------|--------|-----------|
| Manager 세션 시작 시간 | 2초 이내 | 버튼 클릭 → 첫 출력 표시 |
| Worker 상태 반영 지연 | 3초 이내 | SSE 이벤트 → UI 업데이트 |
| Manager Chat 출력 지연 | 2초 이내 | stdout 데이터 → Chat Panel 표시 (폴링 간격) |
| Attention Strip 표시 | needs_input/failed 발생 후 3초 이내 | SSE 기반 |
| 동시 Worker 관리 수 | 5개 이상 | Session Grid에 5개 카드 정상 표시 |

---

## 13. Non-Goals (Out of Scope)

- Manager 전용 LLM SDK 통합 (Manager = Claude Code CLI)
- manager_plans, plan_runs 등 별도 데이터 모델
- /api/manager/* 전용 엔드포인트 (start 제외)
- ActionPlanCard UI (Manager가 텍스트로 설명)
- Manager 간 멀티 세션 (동시에 1개만)
- Worker 자동 재시도 로직 (Manager가 판단)
- 비용 추적 통합 (별도 기능)
- tmux 완전 제거 (Phase 2에서 평가)

---

## 14. Constraints

- **기술 스택**: Express.js 5 + Preact/HTM CDN (빌드 없음) + SQLite (better-sqlite3)
- **SubprocessEngine 필수**: Manager 세션은 stdin 파이프가 필요하므로 반드시 subprocess
- **Claude Code CLI 의존**: Manager는 `claude` 명령이 PATH에 있어야 함
- **단일 Manager**: 동시에 1개의 Manager 세션만 허용
- **기존 뷰 보존**: Dashboard, Board, Projects, Agents 뷰는 변경 최소화
- **인증**: PALANTIR_TOKEN 설정 시, Manager의 API 호출에도 토큰 필요 (system prompt에 포함)

---

## 15. Risks & Unknowns

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude Code interactive 모드의 stdin/stdout 형식이 예상과 다를 수 있음 | 높음 | Phase 1 시작 전 spike: claude interactive 모드의 stdin/stdout 프로토콜 검증 |
| Manager Claude가 curl 대신 다른 방식으로 API를 호출할 수 있음 | 중간 | System prompt에 curl 예제를 구체적으로 제공 |
| SubprocessEngine에서 서버 재시작 시 Manager 세션 유실 | 중간 | 서버 재시작 시 Manager 세션은 "lost" 처리, UI에서 재시작 유도 |
| stdout 출력이 너무 많아 브라우저 성능 저하 | 중간 | 출력 버퍼 cap (2000줄), UI 렌더링은 최근 500줄만 |
| Claude Code의 --verbose 등 플래그에 따라 출력 형식 변화 | 낮음 | 기본 옵션만 사용, 출력은 raw text로 처리 |

---

## 16. Open Questions

1. **Claude Code interactive 모드 프로토콜**: `claude` 명령을 interactive 모드로 실행할 때,
   stdin으로 보낸 메시지와 stdout 응답의 구분자는 무엇인가?
   JSON streaming인가, plain text인가? -- **Spike 필요**

2. **Manager system prompt 주입 방식**:
   `claude -p "system prompt"` 로 one-shot 실행 후 종료되는가,
   아니면 `claude --system-prompt "..." ` 같은 interactive 모드 옵션이 있는가?
   --> `claude` CLI의 `--system-prompt` 플래그 또는 CLAUDE.md 활용 검토

3. **Manager가 자체적으로 폴링해야 하나, 아니면 사용자가 "상태 확인해줘"라고 요청해야 하나?**
   --> Phase 1에서는 사용자 요청 기반, Phase 2에서 자동 폴링 고려

4. **동시 Manager 수 제한**: 1개로 충분한가?
   프로젝트별로 다른 Manager를 원할 수 있는가?
   --> Phase 1에서는 1개로 제한

---

## 17. Implementation Phases

### Phase 1: Core (1주)

Manager 세션의 시작/입출력/종료가 동작하는 최소 기능.

**Backend:**
- [ ] Migration 002: `runs.is_manager` 컬럼 추가
- [ ] `POST /api/manager/start` 엔드포인트
- [ ] `GET /api/runs` 에 `exclude_manager`, `is_manager` 필터 추가
- [ ] SubprocessEngine: `MAX_BUFFER_LINES` 2000으로 증가
- [ ] SubprocessEngine: `getOutputSince(runId, afterLine)` 메서드 추가
- [ ] Manager system prompt 템플릿 (`server/prompts/manager-system.md`)
- [ ] Manager 세션 spawn 로직 (lifecycleService 또는 별도 managerLifecycle)

**Frontend:**
- [ ] NAV_ITEMS에 Manager 추가
- [ ] ManagerView 컴포넌트
- [ ] ManagerEmptyState 컴포넌트
- [ ] ManagerChatPanel 컴포넌트 (output 폴링 + input 전송)
- [ ] SessionGrid 컴포넌트 (worker 카드 목록)
- [ ] SessionCard 컴포넌트
- [ ] AttentionStrip 컴포넌트
- [ ] DashboardView에서 Manager run 제외 (`exclude_manager=true`)

**Spike (Phase 1 첫날):**
- [ ] Claude Code CLI interactive 모드 stdin/stdout 프로토콜 검증
- [ ] System prompt 주입 방식 확정

### Phase 2: Polish & Stability (3~5일)

**Frontend:**
- [ ] SessionDetailSlideOver 컴포넌트 (기존 RunInspector에서 리팩토링)
- [ ] Chat Panel 스크롤 안정화, 코드 블록 렌더링
- [ ] SessionCard 출력 미리보기 (마지막 2줄)
- [ ] Manager 상태를 NavSidebar 아이콘에 표시 (활성=green dot)

**Backend:**
- [ ] ExecutionEngine factory: `preferSubprocess` 옵션 (기본값 true로 변경)
- [ ] SubprocessEngine: output callback (onOutput) 지원 → SSE push 가능성
- [ ] Manager 세션 crash 감지 + UI 알림
- [ ] Manager 동시 1개 제한 로직

**QA:**
- [ ] Manager 시작/종료 반복 테스트
- [ ] Worker 5개 동시 실행 시 UI 성능
- [ ] 서버 재시작 시 Manager 세션 유실 처리
- [ ] PALANTIR_TOKEN 설정 시 Manager API 호출 정상 동작

---

## 18. File Map (예상)

```
server/
  db/migrations/
    002_manager_flag.sql              -- 신규
  prompts/
    manager-system.md                 -- 신규: Manager system prompt 템플릿
  routes/
    manager.js                        -- 신규: POST /api/manager/start
  services/
    executionEngine.js                -- 수정: SubprocessEngine 강화
    lifecycleService.js               -- 수정: Manager spawn 로직
    runService.js                     -- 수정: is_manager 필터
  public/
    app.js                            -- 수정: Manager UI 컴포넌트 추가
  app.js                              -- 수정: manager route 등록
```

---

## Appendix: ASCII Component Reference

### SessionCard

```
┌───────────────────────────┐
│ C  Auth Module Refactor   │   C = Agent icon (claude)
│    claude-code  ● running │   ● = status dot (green)
│    started 5m ago         │
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│ > Analyzing auth module.. │   최근 출력 2줄 미리보기
│ > Found 3 files to ref.. │
└───────────────────────────┘
```

### AttentionStrip Item

```
┌────────────────────────────────────────────────────────┐
│ ⚠ Test Writer (codex) -- needs_input since 3m ago  [→] │
│ ✗ DB Migration (claude) -- failed 1m ago           [↻] │
└────────────────────────────────────────────────────────┘
```

### ManagerChatPanel

```
┌─────────────────────────────┐
│ ┃ Manager                   │
│ ┃                           │
│ ┃ 현재 상태를 확인합니다... │
│ ┃ $ curl localhost:4177/... │
│ ┃ 활성 worker: 2개          │
│ ┃ Worker-1: running (5m)    │
│ ┃ Worker-2: needs_input     │
│ ┃                           │
│ ┃ Worker-2가 입력을 기다리  │
│ ┃ 고 있습니다. DB 스키마    │
│ ┃ 방향을 결정해주세요.      │
│                             │
│ ┌─────────────────────┐     │
│ │ PostgreSQL로 가자   │ [▶] │
│ └─────────────────────┘     │
└─────────────────────────────┘
```
