# Palantir Console: Manager Session UI/UX Specification

> Version 0.1 | 2026-04-05
> Status: Design Proposal (구현 전 검토 필요)

---

## 1. Problem Statement

**누가**: Palantir Console를 사용하여 여러 AI 코딩 에이전트(Claude Code, Codex, OpenCode)를 동시에 운용하는 개발자.

**무엇이 문제인가**: 현재 UI는 칸반 보드(Backlog > Todo > In Progress > Review > Done)로 설계되어 있어, 사용자가 직접 태스크를 생성하고, 카드를 드래그하고, 각 에이전트를 개별적으로 실행/모니터링해야 한다. 5-10개 에이전트가 동시에 돌아가는 상황에서 이것은 "수동 교환원" 역할을 강요하는 것이며, 에이전트가 blocked/failed 상태인지 발견하려면 일일이 각 카드를 열어봐야 한다.

**왜 지금 해결해야 하는가**: 2026년 4월 현재, Cursor 3의 Agents Window, Devin의 Manager Session, Claude Code의 Agent Teams 등 업계가 "대화형 오케스트레이션"으로 빠르게 이동하고 있다. 칸반 기반 수동 관리는 에이전트 수가 3개를 넘으면 인지 부하가 급격히 증가하여 사용자가 이탈한다.

---

## 2. Target Users

| Persona | 설명 | 핵심 니즈 |
|---------|------|-----------|
| **Solo Orchestrator** | 혼자서 5-15개 에이전트를 운용하는 개인 개발자. 프로젝트 1-3개를 동시에 진행. | "지금 뭐가 막혀있는지 2초 안에 파악하고 싶다" |
| **Mobile Monitor** | 이동 중 폰으로 에이전트 상태를 확인하는 사용자 | "에이전트가 죽었는지만 알면 된다. 읽기 전용이면 충분" |

---

## 3. Appetite

**Scale: L (Large)** -- 2-3주 구현 기간 (Phase별 점진 배포)

이 변경은 Palantir Console의 핵심 인터랙션 모델을 "수동 칸반 관리"에서 "대화형 오케스트레이션"으로 전환하는 것이므로, UI 아키텍처 전체에 영향을 미친다.

---

## 4. Goals (측정 가능한 목표)

| ID | 목표 | 측정 기준 |
|----|------|-----------|
| G-1 | 사용자가 전체 에이전트 상태를 한 화면에서 파악 | 상태 확인까지 소요 시간 3초 이내 (현재: 개별 카드 클릭 필요, 15초+) |
| G-2 | blocked/failed 에이전트가 자동으로 시야에 올라옴 | attention-required 항목이 화면 최상단에 0.5초 이내 표시 |
| G-3 | 자연어로 에이전트 작업 지시 가능 | "failing test 전부 고쳐" 같은 high-level 명령을 Manager가 분해하여 실행 |
| G-4 | 모바일에서 읽기 전용 모니터링 가능 | 375px 뷰포트에서 상태 확인 + 로그 읽기 가능 |

---

## 5. Non-Goals (명시적 제외)

- **칸반 보드 제거**: 기존 Task Board는 유지. Manager Session은 *위에 쌓이는 레이어*이지, 대체가 아님
- **에이전트 자동 실행 엔진**: Manager가 사용자 확인 없이 자동으로 에이전트를 실행하는 "full autopilot" 모드는 이 스펙 범위 밖 (추후 옵션으로 검토)
- **멀티유저 협업**: 동시에 여러 사람이 같은 Manager Session에 접속하는 시나리오는 제외
- **에이전트 간 직접 통신**: 에이전트끼리 직접 메시지를 주고받는 기능은 제외 (모든 조율은 Manager를 통해)

---

## 6. Competitive Landscape Analysis (리서치 결과)

### 6.1 주요 레퍼런스 제품 분석

| 제품 | 핵심 UI 패턴 | Palantir에 차용할 점 | 차용하지 않을 점 |
|------|-------------|---------------------|-----------------|
| **Cursor 3 Agents Window** (2026.04.02) | Tab/Grid 레이아웃의 병렬 에이전트 세션. 각 탭이 독립 에이전트. Design Mode로 시각적 피드백 | Grid 레이아웃으로 병렬 세션 한눈에 보기. 탭 간 빠른 전환 | IDE 통합 전제 (우리는 standalone 웹앱) |
| **Devin Manager Session** | 메인 세션이 coordinator 역할. 하위 Devin을 spawn하고 모니터링. 대화형 인터페이스 | **대화형 Manager** 개념 그대로 차용. Manager가 worker를 spawn/모니터 | 각 Devin이 전용 VM (우리는 worktree) |
| **Claude Code Agent Teams** | Coordinator 모드에서 하나의 세션이 팀 리더 역할. teammate들에게 작업 분배 | Task 분배 + progress tracking + 실패 시 retry 패턴 | CLI 전용 (UI가 없음) |
| **Mission Control (builderz-labs)** | 32패널 대시보드 + Quality Gates(Aegis) + Trust Score | Quality Gate / HITL 승인 시스템, Trust Score 개념 | 32패널은 과도. 5-8개면 충분 |
| **Agent Deck** | Conductor 패턴 (persistent meta-agent), MCP Socket Pool | **Conductor 패턴** -- persistent Manager 세션이 다른 세션을 감시 | TUI 전용 |
| **Claude Squad** | tmux 기반 멀티세션, yolo/background 모드, review-before-apply | background 실행 모드, review gate 워크플로 | Terminal-only UI |

### 6.2 업계 수렴 패턴 (2026년 4월 기준)

리서치에서 반복적으로 등장하는 패턴 5가지:

1. **Attention Routing > Chat Viewer**: 최고의 UX는 "채팅 뷰어"가 아니라 "주의력 라우터". 사용자의 시선을 needs_input, blocked, failed에 먼저 보낸다
2. **Hybrid UI (Chat + Dashboard)**: 순수 대화형도, 순수 대시보드도 아닌 **하이브리드**. 대화로 지시하고, 대시보드로 모니터링
3. **Conductor Pattern**: persistent meta-agent가 worker 세션들을 관리. Devin, Agent Deck, Claude Code Agent Teams 모두 이 패턴
4. **Progressive Disclosure**: 평상시에는 요약만 보여주고, 문제가 생기면 자동으로 디테일을 펼침
5. **Ambient → Summary → Full 3-tier 정보 계층**: 아무것도 안 해도 보이는 ambient 지표 > 클릭하면 보이는 summary > 필요할 때만 보는 full detail

---

## 7. Information Architecture

### 7.1 정보 계층 (가장 중요한 것이 먼저)

```
Level 0: Ambient (항상 보임, 의식적 주의 불필요)
├── 전체 에이전트 수 / 활성 수
├── Attention Badge (needs_input + failed 합계)
└── SSE 연결 상태

Level 1: Triage (주의가 필요한 것만)
├── needs_input 에이전트 목록 (가장 위)
├── failed 에이전트 목록
├── blocked/stalled 에이전트 목록
└── review 대기 태스크

Level 2: Overview (전체 상황)
├── 모든 활성 에이전트 상태 그리드
├── 최근 완료된 작업
└── 비용/토큰 집계

Level 3: Detail (개별 세션 깊이 보기)
├── 에이전트 실시간 출력
├── 파일 변경 diff
├── 이벤트 타임라인
└── 에러 로그
```

### 7.2 상태 시스템 (Status Visualization)

에이전트/Run의 상태별 시각적 표현:

| Status | 색상 | 아이콘 | 애니메이션 | 우선순위 (triage 순서) |
|--------|------|--------|-----------|---------------------|
| `needs_input` | `--warning` (#f59e0b) Amber | `⏸` Pause | **Pulse 애니메이션** (느린 호흡) | 0 (최우선) |
| `failed` | `--danger` (#ef4444) Red | `✕` Cross | 없음 (정적, 즉각적 인식) | 1 |
| `running` | `--status-running` (#3b82f6) Blue | `●` Dot | **Spin 애니메이션** (회전) | 2 |
| `queued` | `--status-queued` (#6b7280) Gray | `◌` Ring | 없음 | 3 |
| `completed` | `--success` (#10b981) Green | `✓` Check | 없음 | 4 |
| `cancelled` | `--text-muted` (#63636e) Dim Gray | `—` Dash | 없음 | 5 |

**핵심 원칙**: `needs_input`과 `failed`는 사용자가 **행동해야 하는** 상태이므로, 다른 모든 상태보다 시각적으로 우위에 있어야 한다. Pulse 애니메이션은 사용자의 주변 시야(peripheral vision)에서도 감지되어야 한다.

---

## 8. Layout Architecture

### 8.1 전체 레이아웃 (Desktop, >= 1024px)

```
┌──────────────────────────────────────────────────────────────┐
│ [Nav Sidebar 56px]  [Main Content Area]                      │
│                                                              │
│  ◈ Brand          ┌─────────────────────────────────────────┐│
│                    │                                         ││
│  ◉ Manager  ←NEW  │   현재 활성 View가 여기에 렌더링          ││
│  ▒ Board           │                                         ││
│  ◫ Projects        │   (Manager View가 기본 랜딩 페이지)      ││
│  ⚙ Agents          │                                         ││
│                    │                                         ││
│  ┈┈┈┈┈┈           │                                         ││
│  ● SSE             │                                         ││
│  ⚠ 3  ←Badge      └─────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**변경 사항**:
- `Dashboard` 네비게이션 항목이 `Manager`로 교체됨
- 사이드바 하단에 **Attention Badge** 추가 (needs_input + failed 합산 숫자)
- Manager View가 앱의 기본 랜딩 페이지

### 8.2 Manager View 레이아웃 (핵심 신규 화면)

```
┌─────────────────────────────────────────────────────────────┐
│ MANAGER VIEW                                                │
│                                                             │
│ ┌─────────────────────────┬─────────────────────────────────┤
│ │                         │                                 │
│ │   Manager Chat Panel    │    Session Overview Panel       │
│ │   (좌측, 고정 폭)        │    (우측, 가변 폭)              │
│ │                         │                                 │
│ │   [대화 히스토리]         │   ┌──────────────────────────┐ │
│ │                         │   │ ATTENTION STRIP           │ │
│ │   user: "failing test   │   │ ⏸ Agent-2: needs input   │ │
│ │   전부 고쳐줘"           │   │ ✕ Agent-5: test failed   │ │
│ │                         │   └──────────────────────────┘ │
│ │   manager: "3개의       │                                 │
│ │   failing test를         │   ┌──────────────────────────┐ │
│ │   발견했습니다.           │   │ SESSION GRID             │ │
│ │   Agent-1, Agent-2에    │   │                          │ │
│ │   분배합니다."           │   │ ┌──────┐ ┌──────┐       │ │
│ │                         │   │ │ A-1  │ │ A-2  │       │ │
│ │   [실행 계획 카드]        │   │ │ ●run │ │ ⏸wait│       │ │
│ │                         │   │ └──────┘ └──────┘       │ │
│ │                         │   │ ┌──────┐ ┌──────┐       │ │
│ │   ┌─────────────────┐   │   │ │ A-3  │ │ A-4  │       │ │
│ │   │ 메시지 입력       │   │   │ │ ✓done│ │ ●run │       │ │
│ │   │ [전송]           │   │   │ └──────┘ └──────┘       │ │
│ │   └─────────────────┘   │   └──────────────────────────┘ │
│ │                         │                                 │
│ └─────────────────────────┴─────────────────────────────────┤
└─────────────────────────────────────────────────────────────┘
```

**비율**: Chat Panel 40% / Session Overview 60% (드래그로 리사이즈 가능)

### 8.3 Session Detail (세션 상세 -- Slide-over Panel)

Session Grid에서 카드를 클릭하면 우측에서 슬라이드하는 패널:

```
┌────────────────────────────────────────────────┐
│ SESSION DETAIL PANEL (slide-over from right)    │
│                                                │
│ ┌──────────────────────────────────────────────┤
│ │ Header                                       │
│ │ Agent-2 (Claude Code) · running · 4m 23s     │
│ │ Task: "Fix auth middleware tests"             │
│ │ Branch: fix/auth-tests · Worktree: /tmp/wt3  │
│ ├──────────────────────────────────────────────┤
│ │ Tab Bar: [Output] [Diff] [Events] [Costs]    │
│ ├──────────────────────────────────────────────┤
│ │                                              │
│ │ (선택된 탭의 콘텐츠)                           │
│ │                                              │
│ │ Output 탭:                                   │
│ │ > Analyzing test failures...                 │
│ │ > Found 3 failing tests in auth.test.js      │
│ │ > Fixing validateToken()...                  │
│ │ > [실시간 스트리밍 출력]                       │
│ │                                              │
│ ├──────────────────────────────────────────────┤
│ │ Actions:                                     │
│ │ [Send Input] [Pause] [Cancel] [Retry]        │
│ └──────────────────────────────────────────────┘
```

### 8.4 Mobile Layout (<= 768px)

모바일에서는 **읽기 전용 단일 컬럼** 레이아웃:

```
┌──────────────────────┐
│ ◈ Palantir Console   │
│ ────────────────────  │
│ ATTENTION (2)         │
│ ┌──────────────────┐ │
│ │ ⏸ Agent-2 input  │ │
│ │ ✕ Agent-5 failed │ │
│ └──────────────────┘ │
│                      │
│ ACTIVE (4)           │
│ ┌──────────────────┐ │
│ │ ● Agent-1 running│ │
│ │ ● Agent-3 running│ │
│ │ ● Agent-4 running│ │
│ │ ✓ Agent-6 done   │ │
│ └──────────────────┘ │
│                      │
│ [세션 카드 클릭 →     │
│  상세 보기 페이지]     │
└──────────────────────┘
```

모바일에서는 Manager Chat Panel이 없음. 상태 확인 + 로그 읽기만 가능. Chat은 데스크톱에서만 사용.

---

## 9. Component Hierarchy

```
App
├── NavSidebar
│   ├── NavBrand
│   ├── NavItem (Manager) ← 기본 선택
│   ├── NavItem (Board)
│   ├── NavItem (Projects)
│   ├── NavItem (Agents)
│   ├── NavSpacer
│   ├── AttentionBadge ← NEW (needs_input + failed count)
│   └── SSEStatus
│
├── ManagerView ← NEW (기본 랜딩 페이지)
│   ├── ManagerChatPanel
│   │   ├── ChatHistory
│   │   │   ├── UserMessage
│   │   │   ├── ManagerMessage
│   │   │   └── ActionPlanCard ← Manager의 실행 계획을 구조화된 카드로 표시
│   │   ├── SuggestedActions ← 상황별 제안 버튼 ("retry failed", "check status")
│   │   └── ChatInput
│   │       ├── TextArea
│   │       └── SendButton
│   │
│   └── SessionOverviewPanel
│       ├── AttentionStrip ← 최상단 경고 영역
│       │   └── AttentionItem (needs_input / failed / stalled)
│       ├── SessionGrid
│       │   └── SessionCard (반복)
│       │       ├── AgentIcon
│       │       ├── StatusIndicator (색상 + 애니메이션)
│       │       ├── TaskTitle (truncated)
│       │       ├── Duration
│       │       └── MiniProgress (한줄 요약)
│       └── CompletedSection (접힌 상태, 토글 가능)
│           └── CompletedCard (반복)
│
├── SessionDetailPanel ← slide-over
│   ├── SessionHeader
│   │   ├── AgentInfo (name, type, icon)
│   │   ├── StatusBadge
│   │   ├── TaskInfo (title, branch, worktree)
│   │   └── CloseButton
│   ├── TabBar [Output | Diff | Events | Costs]
│   ├── TabContent
│   │   ├── OutputTab (실시간 로그 스트리밍)
│   │   ├── DiffTab (파일 변경 사항)
│   │   ├── EventsTab (이벤트 타임라인)
│   │   └── CostsTab (토큰/비용)
│   └── ActionBar
│       ├── SendInputButton (needs_input일 때만 활성)
│       ├── PauseButton
│       ├── CancelButton
│       └── RetryButton (failed/cancelled일 때만 활성)
│
├── BoardView (기존 유지)
├── ProjectsView (기존 유지)
├── AgentsView (기존 유지)
├── CommandPalette (기존 유지, Manager 명령 추가)
└── ToastContainer (기존 유지)
```

---

## 10. Interaction Flows

### 10.1 Flow: 사용자가 Manager에게 작업 지시

```
사용자 → ChatInput에 "failing test 전부 고쳐" 입력 → [전송]
                    │
                    ▼
        Manager가 현재 상태를 분석:
        - 현재 활성 run들의 상태 확인
        - 프로젝트 내 test 실패 현황 파악
                    │
                    ▼
        Manager가 ActionPlanCard를 표시:
        ┌─────────────────────────────┐
        │ 실행 계획                     │
        │                             │
        │ 1. auth.test.js (3 failures) │
        │    → Agent-1 (Claude Code)   │
        │ 2. api.test.js (1 failure)   │
        │    → Agent-2 (Codex)         │
        │                             │
        │ [승인하고 실행] [수정] [취소]   │
        └─────────────────────────────┘
                    │
          사용자가 [승인하고 실행] 클릭
                    │
                    ▼
        Manager가 API를 통해:
        - Task 생성 (또는 기존 Task에 연결)
        - Run 생성 (각 에이전트별)
        - 에이전트 실행 시작
                    │
                    ▼
        Session Grid에 새 카드 즉시 나타남 (queued → running)
        SSE로 실시간 상태 업데이트
```

### 10.2 Flow: 에이전트가 Input을 요청할 때

```
Agent-2가 실행 중 사용자 입력 필요 상태 진입
                    │
                    ▼
        SSE 이벤트: run:status { status: 'needs_input' }
                    │
                    ▼ (동시에 3곳에서 반응)
        ┌───────────┼───────────────┐
        │           │               │
        ▼           ▼               ▼
  AttentionBadge  AttentionStrip  SessionCard
  숫자 증가       새 항목 추가     Pulse 시작
  (sidebar)      (패널 상단)      (Grid 내)
                    │
                    │ + Browser Notification
                    │ + 소리 (선택적)
                    │
                    ▼
        사용자가 AttentionStrip 또는 SessionCard 클릭
                    │
                    ▼
        SessionDetailPanel 슬라이드 오픈
        - "Agent-2가 다음을 묻고 있습니다: ..."
        - [Send Input] 버튼 활성화
        - 또는 Manager Chat에서 "agent-2에게 Y라고 응답해" 입력
                    │
                    ▼
        Manager가 해당 세션에 입력 전달
        → run:status { status: 'running' } 으로 전환
```

### 10.3 Flow: 에이전트 실패 시 처리

```
Agent-5 실행 중 에러 발생 → run:status { status: 'failed' }
                    │
                    ▼
        AttentionStrip에 빨간 항목 추가
        Browser Notification: "Run failed: Agent-5"
                    │
                    ▼
        사용자 선택지:
        ├── (a) SessionCard 클릭 → Detail에서 에러 로그 확인 → [Retry] 클릭
        ├── (b) Manager Chat에서 "agent-5 뭐가 잘못됐어?" → Manager가 요약 제공
        │       → "다시 해봐" → Manager가 retry 실행
        └── (c) Manager Chat에서 "agent-5 결과 무시하고 agent-1에게 넘겨"
                → Manager가 Agent-5 cancel + Agent-1에 새 run 생성
```

### 10.4 Flow: "지금 상태가 어때?" (상태 조회)

```
사용자 → ChatInput에 "status" 또는 "지금 뭐하고 있어?" 입력
                    │
                    ▼
        Manager가 구조화된 상태 요약을 표시:

        ┌────────────────────────────────────┐
        │ 현재 상태 요약                       │
        │                                    │
        │ ● 활성: 3개 에이전트 실행 중          │
        │   - Agent-1: auth 테스트 수정 (2분)  │
        │   - Agent-3: API 리팩토링 (8분)      │
        │   - Agent-4: docs 업데이트 (1분)     │
        │                                    │
        │ ⏸ 대기: 1개                         │
        │   - Agent-2: 입력 필요 (권한 확인)    │
        │                                    │
        │ ✓ 완료: 2개 (오늘)                   │
        │ ✕ 실패: 0개                         │
        │                                    │
        │ 총 비용: $0.47 (오늘)                │
        └────────────────────────────────────┘
```

---

## 11. Manager Chat Panel -- 상세 설계

### 11.1 Manager의 역할

Manager는 **읽기 + 오케스트레이션** 레이어이다. 자체적으로 코드를 작성하지 않으며, worker 에이전트에게 작업을 위임한다.

Manager가 할 수 있는 것:
- 현재 모든 run/task/session의 상태를 집계하여 요약 제공
- 사용자의 high-level 지시를 구체적 task + run으로 분해
- 에이전트에게 입력 전달 (needs_input 응답)
- 실패한 run을 retry하거나 다른 에이전트에 재할당
- 비용/토큰 사용량 보고
- 실행 계획 제안 + 사용자 승인 대기

Manager가 할 수 없는 것 (이 스펙에서):
- 사용자 승인 없이 자동으로 에이전트 실행 (full autopilot)
- 에이전트 간 직접 통신 중재
- 코드 직접 수정

### 11.2 Suggested Actions (상황별 제안)

Chat Input 위에 현재 상황에 맞는 빠른 액션 버튼이 표시된다:

| 상황 | 제안 버튼 |
|------|----------|
| needs_input 에이전트 있음 | `[Agent-2에게 응답하기]` |
| failed 에이전트 있음 | `[Agent-5 재시도]` `[에러 로그 보기]` |
| 모든 에이전트 idle | `[새 작업 시작]` `[상태 요약]` |
| review 대기 태스크 있음 | `[리뷰 대기 확인]` |
| 아무것도 실행 중 아님 | `[이전 작업 이어하기]` `[프로젝트 상태]` |

### 11.3 ActionPlanCard 구조

Manager가 작업 계획을 세울 때 표시하는 구조화된 카드:

```
┌─────────────────────────────────────────┐
│ 📋 실행 계획                             │
│                                         │
│ Step 1: auth.test.js 수정               │
│   에이전트: Agent-1 (Claude Code)        │
│   예상: ~5분                             │
│   브랜치: fix/auth-tests                 │
│                                         │
│ Step 2: api.test.js 수정                │
│   에이전트: Agent-2 (Codex)              │
│   예상: ~3분                             │
│   브랜치: fix/api-tests                  │
│                                         │
│ ─────────────────────────────           │
│ 예상 총 비용: ~$0.15                     │
│                                         │
│ [승인하고 실행]  [수정]  [취소]            │
└─────────────────────────────────────────┘
```

### 11.4 Manager Backend Architecture

Manager Chat은 서버 사이드에서 다음과 같이 동작한다:

```
클라이언트                    서버
   │                          │
   │ POST /api/manager/chat   │
   │ { message: "fix tests" } │
   │ ─────────────────────▶   │
   │                          ├── 현재 runs/tasks 상태 조회
   │                          ├── 프로젝트 컨텍스트 수집
   │                          ├── LLM에 프롬프트 구성:
   │                          │   - system: "You are a manager..."
   │                          │   - context: { runs, tasks, agents }
   │                          │   - user message
   │                          ├── LLM 응답 파싱
   │                          │   - 텍스트 응답
   │                          │   - 구조화된 액션 (optional):
   │                          │     { type: "plan", steps: [...] }
   │  ◀───────────────────── │
   │ SSE stream:              │
   │  manager:message          │
   │  manager:plan             │
   │                          │
   │ POST /api/manager/       │
   │   execute-plan           │
   │ { planId, approved: true}│
   │ ─────────────────────▶   │
   │                          ├── Task 생성
   │                          ├── Run 생성
   │                          ├── 에이전트 실행 시작
   │  ◀───────────────────── │
   │ SSE: run:created,        │
   │      run:status           │
```

**새로운 API 엔드포인트:**

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/manager/chat` | Manager에게 메시지 전송. SSE로 응답 스트리밍 |
| GET | `/api/manager/history` | Manager 대화 히스토리 조회 |
| POST | `/api/manager/execute-plan` | Manager가 제안한 실행 계획 승인/실행 |
| POST | `/api/manager/respond-to-agent` | 특정 에이전트에게 입력 전달 (Manager 경유) |
| GET | `/api/manager/summary` | 현재 전체 상태 요약 (Manager 없이도 사용 가능) |

---

## 12. Session Overview Panel -- 상세 설계

### 12.1 Attention Strip

화면 상단의 고정 영역. attention-required 항목만 표시. 항목이 없으면 영역 자체가 사라짐 (공간 절약).

```html
<div class="attention-strip">
  <!-- needs_input이 가장 먼저 -->
  <div class="attention-item attention-input">
    <span class="attention-icon pulse">⏸</span>
    <span class="attention-agent">Agent-2</span>
    <span class="attention-message">권한을 확인해주세요: /etc/config 접근 필요</span>
    <span class="attention-time">2분 전</span>
    <button class="attention-action">응답하기</button>
  </div>

  <!-- failed 두번째 -->
  <div class="attention-item attention-failed">
    <span class="attention-icon">✕</span>
    <span class="attention-agent">Agent-5</span>
    <span class="attention-message">Exit code 1: npm test failed</span>
    <span class="attention-time">5분 전</span>
    <button class="attention-action">재시도</button>
  </div>
</div>
```

**디자인 원칙:**
- needs_input: amber 배경 (#f59e0b at 10% opacity), amber 좌측 보더 3px
- failed: red 배경 (#ef4444 at 10% opacity), red 좌측 보더 3px
- 각 항목에 **인라인 액션 버튼** 포함 (클릭 한 번으로 대응 가능)
- 최대 5개까지 표시, 초과 시 "+3 more" 접기

### 12.2 Session Grid

활성 에이전트 세션을 카드 그리드로 표시. 칸반이 아닌 **flat grid**.

**카드 크기:** 최소 200px x 120px. 에이전트 수에 따라 자동 조절:
- 1-4개: 2x2 그리드
- 5-9개: 3x3 그리드
- 10+: 스크롤, 3열 유지

**SessionCard 구조:**

```
┌────────────────────────────┐
│ ● Agent-1                  │  ← 상태 색상 dot + 에이전트 이름
│ Claude Code                │  ← 에이전트 타입 (dimmed)
│ ─────────────────────────  │
│ Fix auth middleware tests  │  ← 태스크 제목 (truncated 2줄)
│                            │
│ 4m 23s     $0.08           │  ← 경과 시간 + 비용
│ ▓▓▓▓▓▓▓▓░░ 80%            │  ← 진행률 (추정, 선택적)
└────────────────────────────┘
```

**카드 상태별 스타일:**
- `running`: 좌측 보더 3px blue, 상태 dot에 spin 애니메이션
- `needs_input`: 전체 카드 amber border, pulse 애니메이션, 약간 확대(scale 1.02)
- `failed`: 전체 카드 red border, 배경 살짝 어둡게
- `completed`: 배경 약간 밝게, green check
- `queued`: gray, opacity 0.7

### 12.3 Completed Section

완료된 세션은 기본적으로 접혀 있는 섹션에 표시:

```
▶ 완료됨 (12) ─────────────────────────────
  (클릭하면 펼쳐짐)

▼ 완료됨 (12) ─────────────────────────────
  ✓ Agent-6: Update README      3분 전  $0.02
  ✓ Agent-7: Fix typo           15분 전 $0.01
  ✓ Agent-8: Add test           1시간 전 $0.05
  ...
```

---

## 13. Session Detail Panel -- 상세 설계

### 13.1 진입 방법

- Session Grid에서 카드 클릭
- Attention Strip에서 항목 클릭
- Manager Chat에서 에이전트 이름 클릭
- Command Palette에서 "inspect agent-2"
- 키보드 단축키: `1`-`9`로 해당 순서의 세션 열기

### 13.2 탭 구성

| 탭 | 내용 | 실시간 여부 |
|----|------|-----------|
| **Output** | 에이전트의 실시간 터미널 출력. 자동 스크롤 (하단 고정, 사용자가 위로 스크롤하면 해제) | SSE 스트리밍 |
| **Diff** | 에이전트가 변경한 파일의 unified diff. 파일별 접기/펼치기 | 주기적 갱신 (5초) |
| **Events** | run_events 타임라인. tool_use, file_edit, test_run 등 구조화된 이벤트 목록 | SSE 스트리밍 |
| **Costs** | 토큰 사용량, 모델별 비용, 누적 그래프 | 주기적 갱신 (10초) |

### 13.3 Action Bar

패널 하단 고정. 현재 상태에 따라 활성/비활성:

| 상태 | 활성 버튼 |
|------|----------|
| `running` | [Pause] [Cancel] |
| `needs_input` | [Send Input] (텍스트 입력 필드 포함) [Cancel] |
| `paused` | [Resume] [Cancel] |
| `failed` | [Retry] [Retry with different agent] |
| `completed` | [View diff] [Apply changes] |
| `queued` | [Cancel] [Change agent] |

---

## 14. Status Visualization System

### 14.1 Ambient Indicators (항상 보임)

**Nav Sidebar의 Attention Badge:**
```css
.attention-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--danger);
  color: white;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: badge-pulse 2s ease-in-out infinite;
}

@keyframes badge-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.15); }
}
```

**규칙:**
- needs_input + failed 합산이 0이면 badge 숨김
- 1-9: 숫자 표시
- 10+: "9+" 표시

### 14.2 Status Dot 애니메이션

```css
/* Running: 회전 */
.status-dot-running {
  width: 8px; height: 8px;
  border-radius: 50%;
  border: 2px solid var(--status-running);
  border-top-color: transparent;
  animation: spin 1s linear infinite;
}

/* Needs Input: 호흡 */
.status-dot-input {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--warning);
  animation: breathe 2s ease-in-out infinite;
}

@keyframes breathe {
  0%, 100% { opacity: 0.4; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.1); }
}

/* Failed: 정적 (즉각 인식) */
.status-dot-failed {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--danger);
}
```

### 14.3 Session Card 전이 애니메이션

상태가 변경될 때 카드에 짧은 전이 효과:
- `queued → running`: 카드가 0.3s에 걸쳐 gray에서 blue 보더로 전환
- `running → needs_input`: 카드가 0.5s에 걸쳐 amber 보더로 전환 + 한 번 진동(shake)
- `running → failed`: 카드가 빨간 flash 한 번 후 red 보더로 전환
- `running → completed`: 카드가 green으로 전환 후 2초 뒤 Completed Section으로 이동 (slide)

---

## 15. User Stories

### US-001: Manager에게 대화로 작업 지시

**As a** Solo Orchestrator
**I want to** Manager Chat에 자연어로 작업을 지시
**So that** 수동으로 Task 생성 > Agent 선택 > Run 실행하는 3단계를 1단계로 줄일 수 있다

**Acceptance Criteria:**
- GIVEN Manager Chat이 열려있고 에이전트가 1개 이상 등록되어 있을 때
- WHEN 사용자가 "failing test 전부 고쳐"라고 입력하고 전송하면
- THEN Manager가 3초 이내에 실행 계획(ActionPlanCard)을 표시하고, 계획에는 할당할 에이전트와 예상 작업이 포함된다

- GIVEN ActionPlanCard가 표시되었을 때
- WHEN 사용자가 [승인하고 실행]을 클릭하면
- THEN 2초 이내에 Session Grid에 새 카드가 나타나고, 해당 Run의 상태가 queued > running으로 전환된다

### US-002: Attention Routing으로 차단 상태 즉시 인식

**As a** Solo Orchestrator
**I want to** blocked/failed 에이전트가 자동으로 시야에 올라오기를
**So that** 일일이 각 세션을 열어보지 않아도 문제를 즉시 발견할 수 있다

**Acceptance Criteria:**
- GIVEN 에이전트가 running 상태에서 needs_input으로 전환될 때
- WHEN SSE 이벤트가 도착하면
- THEN 0.5초 이내에 (a) Attention Strip에 해당 항목이 추가되고, (b) Attention Badge 숫자가 증가하고, (c) Browser Notification이 발생하고, (d) 해당 SessionCard에 pulse 애니메이션이 시작된다

- GIVEN Attention Strip에 needs_input 항목이 있을 때
- WHEN 사용자가 해당 항목의 [응답하기] 버튼을 클릭하면
- THEN Session Detail Panel이 열리고 입력 필드에 포커스가 자동으로 이동한다

### US-003: 전체 상태를 한 화면에서 파악

**As a** Solo Orchestrator
**I want to** 모든 에이전트의 상태를 한 화면에서 한눈에 보기를
**So that** 현재 작업 진행 상황을 3초 이내에 파악할 수 있다

**Acceptance Criteria:**
- GIVEN 5개 에이전트가 다양한 상태(2 running, 1 needs_input, 1 completed, 1 failed)로 존재할 때
- WHEN Manager View를 열면
- THEN Session Grid에 5개 카드가 모두 표시되고, 각 카드의 상태 색상/아이콘이 구별 가능하며, Attention Strip에 needs_input 1개 + failed 1개가 표시된다

### US-004: 모바일에서 읽기 전용 모니터링

**As a** Mobile Monitor
**I want to** 폰에서 에이전트 상태를 확인
**So that** 이동 중에도 문제가 생겼는지 알 수 있다

**Acceptance Criteria:**
- GIVEN 375px 뷰포트에서 Palantir Console에 접속할 때
- WHEN 페이지가 로드되면
- THEN Attention 항목이 최상단에 표시되고, 각 세션 카드가 단일 컬럼으로 나열되며, Manager Chat Panel은 숨겨진다

- GIVEN 모바일에서 세션 카드를 탭하면
- WHEN Session Detail이 열릴 때
- THEN Output 탭의 로그가 읽을 수 있는 크기로 표시되고, 가로 스크롤 없이 볼 수 있다

### US-005: Manager를 통한 실패 복구

**As a** Solo Orchestrator
**I want to** Manager Chat에서 실패한 에이전트에 대해 대화로 복구 지시
**So that** 실패 원인을 확인하고 즉시 다음 행동을 결정할 수 있다

**Acceptance Criteria:**
- GIVEN Agent-5가 failed 상태이고 Manager Chat이 열려있을 때
- WHEN "agent-5 뭐가 잘못됐어?"라고 입력하면
- THEN Manager가 해당 run의 에러 로그와 exit code를 요약하여 표시한다

- GIVEN Manager가 에러 요약을 표시한 후
- WHEN "다시 해봐"라고 입력하면
- THEN Manager가 해당 task에 새로운 run을 생성하고 에이전트를 재실행한다

---

## 16. CSS Variables 추가

기존 `styles.css`의 `:root`에 추가할 변수:

```css
:root {
  /* ... 기존 변수 유지 ... */

  /* Manager Chat */
  --chat-panel-width: 40%;
  --chat-panel-min: 320px;
  --chat-panel-max: 600px;
  --chat-bg: var(--bg-surface);
  --chat-user-bg: var(--accent-muted);
  --chat-manager-bg: var(--bg-elevated);

  /* Attention Strip */
  --attention-input-bg: rgba(245, 158, 11, 0.08);
  --attention-input-border: rgba(245, 158, 11, 0.5);
  --attention-failed-bg: rgba(239, 68, 68, 0.08);
  --attention-failed-border: rgba(239, 68, 68, 0.5);

  /* Session Grid */
  --card-min-width: 200px;
  --card-gap: 12px;

  /* Session Detail Slide-over */
  --detail-panel-width: 480px;
}
```

---

## 17. Data Model Additions

기존 스키마([../research/research-and-review.md](../research/research-and-review.md)에 정의된 것)에 추가:

```sql
-- Manager conversation history
CREATE TABLE IF NOT EXISTS manager_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('user', 'manager', 'system')),
  content TEXT NOT NULL,
  structured_data TEXT,   -- JSON: action plans, status summaries, etc.
  created_at TEXT DEFAULT (datetime('now'))
);

-- Manager action plans (pending approval)
CREATE TABLE IF NOT EXISTS manager_plans (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'executed')),
  plan_json TEXT NOT NULL,  -- JSON: { steps: [...] }
  message_id INTEGER REFERENCES manager_messages(id),
  created_at TEXT DEFAULT (datetime('now')),
  executed_at TEXT
);

-- Link plans to created runs
CREATE TABLE IF NOT EXISTS plan_runs (
  plan_id TEXT REFERENCES manager_plans(id),
  run_id TEXT REFERENCES runs(id),
  step_index INTEGER,
  PRIMARY KEY (plan_id, run_id)
);
```

---

## 18. SSE Event Additions

기존 이벤트 채널에 추가:

| Channel | Payload | 트리거 |
|---------|---------|--------|
| `manager:message` | `{ role, content, structured_data }` | Manager 응답 스트리밍 |
| `manager:plan` | `{ planId, steps, status }` | 실행 계획 생성/상태 변경 |
| `manager:summary` | `{ active, needs_input, failed, completed, total_cost }` | 주기적 상태 요약 (30초) |

---

## 19. Implementation Phases

### Phase A: Session Overview (UI만, Manager 없이) -- 1주

Manager Chat 없이 먼저 Session Overview Panel만 구현. 기존 Dashboard를 대체.

- Attention Strip 컴포넌트
- Session Grid 컴포넌트 (기존 runs 데이터 사용)
- Session Detail slide-over (기존 RunInspector 리팩토링)
- Attention Badge (NavSidebar)
- Status 애니메이션 시스템
- Mobile responsive 레이아웃

**검증 기준**: 사용자가 에이전트 상태를 3초 이내에 파악 가능. needs_input/failed가 자동으로 상단에 표시.

### Phase B: Manager Chat (대화형 인터페이스) -- 1주

- Manager Chat Panel UI
- `/api/manager/*` 엔드포인트
- Manager LLM 통합 (system prompt + context injection)
- ActionPlanCard 컴포넌트
- Suggested Actions 컴포넌트
- 대화 히스토리 저장/조회
- SSE 스트리밍 응답

**검증 기준**: "status"라고 입력하면 전체 상태 요약을 받을 수 있다. 작업 지시 > 계획 제안 > 승인 > 실행 플로우가 동작.

### Phase C: Polish & Mobile -- 0.5주

- 모바일 레이아웃 최적화
- 키보드 단축키 추가
- 상태 전이 애니메이션 polish
- Command Palette에 Manager 명령 통합
- 에러 핸들링 / edge case 처리

---

## 20. Risks & Unknowns

| Risk | 심각도 | 대응 |
|------|--------|------|
| Manager LLM 비용이 worker 에이전트 비용 위에 추가됨 | Medium | Manager에 경량 모델 사용 (Haiku/Flash). Context를 최소화하여 토큰 절약 |
| Manager 응답 지연으로 UX 저하 | High | 스트리밍 응답 필수. 첫 토큰 2초 이내 목표. 타임아웃 시 fallback 메시지 |
| Manager가 잘못된 계획을 세울 수 있음 | Medium | 모든 실행 계획은 사용자 승인 필수 (ActionPlanCard의 [승인] 버튼). Full autopilot 없음 |
| 10+ 에이전트 동시 실행 시 Session Grid 가독성 저하 | Medium | 3열 고정 + 스크롤. 추후 그룹핑(프로젝트별) 검토 |
| Manager Chat과 Session Overview의 화면 비율 경쟁 | Low | 리사이즈 핸들 제공. Chat 접기/펼치기 토글 |

---

## 21. Open Questions (사용자 결정 필요)

1. **Manager LLM 선택**: Manager에 어떤 모델을 사용할 것인가? 옵션:
   - (a) Claude Sonnet (비용 효율 + 충분한 능력)
   - (b) Claude Haiku (최저 비용, 단순 라우팅에 충분할 수 있음)
   - (c) 사용자가 설정에서 선택

2. **Manager 대화 지속성**: Manager Chat 히스토리를 얼마나 유지할 것인가?
   - (a) 세션 단위 (브라우저 새로고침 시 리셋)
   - (b) 영구 저장 (SQLite)
   - (c) 최근 N개 메시지만 유지

3. **Autopilot 모드**: 추후 "사용자 승인 없이 자동 실행" 옵션을 제공할 것인가?
   - 이 스펙에서는 제외했으나, 로드맵에 포함할지 결정 필요

4. **기존 Dashboard 처리**: Manager View가 Dashboard를 완전히 대체하는가, 병존하는가?
   - 권장: Manager View가 기본 랜딩, 기존 Dashboard는 제거 (중복)

5. **Manager Chat의 언어**: Manager가 한국어로 응답해야 하는가, 영어인가, 사용자 설정인가?

---

## 22. Success Metrics

| Metric | 현재 | 목표 | 측정 방법 |
|--------|------|------|-----------|
| 전체 상태 파악 소요 시간 | 15초+ (개별 카드 클릭) | 3초 이내 | 사용자 테스트 |
| attention-required 항목 발견 시간 | 30초+ (발견 못할 수도 있음) | 0.5초 이내 | SSE 이벤트 → UI 표시 지연 측정 |
| 작업 지시에서 에이전트 실행까지 | 5단계 (Task생성 > Agent선택 > 프롬프트작성 > 실행 > 확인) | 2단계 (메시지 입력 > 승인) | 인터랙션 카운트 |
| 모바일 상태 확인 가능 여부 | 불가 (반응형 미지원) | 가능 (375px) | 뷰포트 테스트 |

---

## Appendix A: Nav Sidebar Modification

현재 NAV_ITEMS 배열 (app.js:229):
```javascript
const NAV_ITEMS = [
  { hash: 'dashboard', icon: '\u25C9', label: 'Dashboard' },
  { hash: 'board',     icon: '\u2592', label: 'Task Board' },
  { hash: 'projects',  icon: '\u25A3', label: 'Projects' },
  { hash: 'agents',    icon: '\u2699', label: 'Agents' },
];
```

변경 후:
```javascript
const NAV_ITEMS = [
  { hash: 'manager',   icon: '\u2726', label: 'Manager' },  // ✦ 기존 brand 아이콘 재사용
  { hash: 'board',     icon: '\u2592', label: 'Task Board' },
  { hash: 'projects',  icon: '\u25A3', label: 'Projects' },
  { hash: 'agents',    icon: '\u2699', label: 'Agents' },
];
```

## Appendix B: File Impact Analysis

| 파일 | 변경 유형 | 설명 |
|------|-----------|------|
| `server/public/app.js` | **Major** | ManagerView, SessionOverviewPanel, ManagerChatPanel, AttentionStrip, SessionGrid, SessionCard 컴포넌트 추가. DashboardView 제거 또는 교체 |
| `server/public/styles.css` | **Major** | Manager 레이아웃, Attention Strip, Session Grid/Card, Chat Panel, 애니메이션 스타일 추가 |
| `server/app.js` | **Minor** | Manager 라우트 마운트 추가 |
| `server/routes/manager.js` | **New** | `/api/manager/*` 엔드포인트 |
| `server/services/managerService.js` | **New** | Manager LLM 통합, 상태 집계, 계획 생성/실행 |
| `server/db/migrations/NNN_manager.sql` | **New** | manager_messages, manager_plans, plan_runs 테이블 |
| `server/services/eventBus.js` | **Minor** | manager:* 이벤트 채널 추가 |

---

*이 스펙은 구현 전 사용자 리뷰를 기다리는 상태입니다. Open Questions (Section 21)에 대한 결정이 필요합니다.*
