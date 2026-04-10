# Manager Session V3 — Multi-Layer Redesign

> Version 0.2 | 2026-04-08
> Status: **Phase 0 ~ 7 merged to main.** Phase 3b (Claude PM resume) 보류 — spec §9.6 트리거 조건 미충족.
> 관련 문서: [manager-v2.md](./manager-v2.md), [manager-session-ui.md](./manager-session-ui.md), [../test-scenarios.md](../test-scenarios.md)
>
> v0.2 변경: 코덱스 2차 검증 반영. 스키마 충돌 (parent_run_id 재사용, pm_thread_id 리네임), Phase 1.5에 worker→Top parent notice 포함, 원칙 9 추가, PM lifecycle cleanup owner 명시.
>
> 본 문서 본문(§1~§14) 은 **lock-in 문서** 로 역사 기록을 위해 유지된다. 실제 구현 현황은 아래 §15 (Implementation Log) 를 참고.

---

## TL;DR

매니저 세션 재설계의 본질은 "에이전트 두뇌 강화"가 아니라 **"디스패처 의도와 권한 넓은 구현 사이의 갭 좁히기 + 사용자가 계층 밖에서 어느 노드와도 직접 대화할 수 있는 conversation 시맨틱 도입"** 이다.

- 어댑터 중립을 유지하면서 (Top=Claude / PM=Codex는 default 권장이지 정체성 고정이 아님)
- 자식 노드로 향하는 사용자 메시지는 **무조건** 부모 staleness 신호로 취급하고
- 시스템 프롬프트는 계층별로 분기하되 capability(도구)는 동일하게 좁힌다

가장 중요한 lock 포인트는 PM resume도 UI 데모도 아닌 **conversation identity + parent notice semantics** 이며, 이게 Phase 1.5의 핵심 산출물이다. PM 계층 자체는 트리거 조건이 발생할 때까지 보류하지만, 그 자리는 데이터 모델과 UI 모두에 미리 비어 있는 슬롯으로 준비되어 있어서 진입 시 빅뱅 마이그레이션이 없다.

---

## 1. Lock-in (이 세 줄만 잠근다)

다음 세 가지는 변경하지 않는다. 세부 구현·일정·인터페이스 모양은 발견 단계에서 조정 가능하다.

1. **어댑터 중립 유지. Codex PM 선검증, Claude PM resume은 후속.**
2. **자식 대상 사용자 메시지는 전부 부모 staleness 신호로 취급한다.** (plan-modification 분류 없음)
3. **시스템 프롬프트 분기와 conversation 추상화는 같이 간다.** (Phase 0의 prompt 슬림화 + Phase 1.5의 conversation identity가 한 쌍)

### 1.1 의도적으로 잠그지 않은 것

| 항목 | 잠그지 않은 이유 |
|---|---|
| Phase별 정확한 일정 | 코드 진입 후 reality check 필요 |
| Conversation identity의 정확한 스키마 | 서버 라우트 설계와 같이 결정 |
| UI: 탭 vs 드롭다운 vs @-mention 통합 | Phase 1.5 진입 후 사용성 평가 |
| Reconciliation hard gate 승격 시점 | 운영 데이터 기반 결정 |
| PM 트랙 진입 시점 | 트리거 조건 발생 시 (섹션 12 참조) |

---

## 2. 토론의 궤적 (어떻게 여기까지 왔나)

```
"매니저 구현 수준" → 4점 / v0.3 평가 (Claude + Codex 합의)
   ↓
"매니저 = 디스패처가 의도" → 6.5~7점, 의도-구현 갭이 진짜 문제
   ↓
"PM 계층 도입?" → 단일 세션은 격리 불가, PM 검토
   ↓
"Top=Claude / PM=Codex" → 두 어댑터 강점이 두 계층 요구에 자연스럽게 매칭
   ↓
"어댑터 중립 복원" 정정 → Claude도 가능하되 Codex PM 선검증
   ↓
"사용자는 계층 밖" → PM/워커 직접 대화 1급 시민
   ↓
"Conversation identity가 다음 락 포인트" → 코덱스 최종 검증
   ↓
"PM은 lazy 자동 생성" → ceremony 없는 PM 생성 모델 합의
```

이 궤적 자체가 결과의 일부다. 처음 본 약점 목록의 절반은 **사용자 관점 전환**으로 사라졌고, 나머지 절반은 보강 영역으로 옮겨졌으며, 도중에 발견한 **구조적 사실들**이 우선순위를 반복적으로 재정렬했다.

---

## 3. 발견한 구조적 사실들

토론 중 코드를 직접 읽고 발견한, **이 재설계의 토대가 되는 사실들**. 이것들은 코드 현실이며 변하지 않는 한 모든 의사결정의 입력값이다.

| # | 사실 | 출처 |
|---|---|---|
| 1 | `lifecycleService`가 worker supervision을 중앙화한다 (idle/needs_input/완료/task 전환) | `server/services/lifecycleService.js:254-389` |
| 2 | SSE 채널이 이미 존재한다 (단, reload trigger 수준) | `server/routes/events.js`, `server/public/app.js:3977-4001` |
| 3 | `agent_profiles`에 `capabilities_json`, `max_concurrent`, `env_allowlist` 컬럼이 dormant 상태로 존재한다 | `server/db/migrations/001_initial.sql:27` |
| 4 | `runs.manager_thread_id` 컬럼이 PR4에서 추가되었다 (Codex thread_id용) | `server/services/runService.js:59` |
| 5 | 어댑터 추상화가 완료되어 있다 (`getAdapter(type)`이 Claude/Codex 둘 다 반환) | `server/services/managerAdapters/index.js` |
| 6 | 워커 직접 input은 이미 가능하다 (`POST /api/runs/:id/input`) | `server/services/lifecycleService.js:494-510` |
| 7 | 매니저 단일 슬롯 가정이 routes/manager.js + hooks.js + ManagerView에 깊게 박혀 있다 | `server/routes/manager.js:44`, `server/public/app/lib/hooks.js:221`, `server/public/app.js:3298,3945,3952` |
| 8 | `getActiveManager()`는 "가장 최근 1개"만 반환한다 | `server/services/runService.js:199` |
| 9 | Codex의 sandbox bypass는 launch flag이다 (`--dangerously-bypass-approvals-and-sandbox`) | `server/services/managerAdapters/codexAdapter.js:142-143` |
| 10 | LLM 세션의 컨텍스트는 단조 누적이다 (replace 불가) | 본질적 |
| 11 | Codex(stateless+thread_id resume)와 Claude(영속+stdin pipe)의 구조 차이 | 두 어댑터 비교 |
| 12 | Codex는 cwd의 AGENTS.md를 자동 로드한다 | `server/services/managerAdapters/codexAdapter.js:23-28` |
| 13 | `buildCommonBase()`가 모든 매니저에 워커 cancel/input API를 공통 노출한다 | `server/services/managerSystemPrompt.js:80` |
| 14 | `claudeAdapter.capabilities.supportsResume: false` (현재 미구현) | `server/services/managerAdapters/claudeAdapter.js:202` |
| 15 | Codex의 `thread.started` 이벤트가 thread_id를 발급한다 (PM 생성의 자연스러운 트리거) | `server/services/managerAdapters/codexAdapter.js:245-252` |

---

## 4. 8가지 원칙

이 원칙들은 lock-in 3줄에서 파생되며, 향후 결정의 가이드 역할을 한다.

| # | 원칙 | 핵심 |
|---|---|---|
| 1 | **권한 정합성이 prompt 정합성보다 우선** | "하지 마"라고 prompt로 막지 말고 capability 자체에서 빼라 |
| 2 | **라우팅은 코드, 추론은 LLM 아님** | UI selector + @-mention만. NLP/intent 분류 금지 |
| 3 | **책임을 줄일 때마다 어디로 갔는지 명시** | 책임 공백 방지. 각 결핍 항목은 owner를 가져야 함 |
| 4 | **구조 변경은 빅뱅이 아니라 계약 분리부터** | Phase 1.5의 존재 이유 |
| 5 | **계층화는 speculative하게 도입하지 않는다** | PM 트랙은 트리거 조건 발생 시에만 |
| 6 | **어댑터 중립은 1급 시민** | Top/PM × Claude/Codex는 직교. Default 권장은 있되 정체성 고정 아님 |
| 7 | **사용자는 계층 밖에 있다** | Top/PM/Worker 셋 다 1급 conversation surface |
| 8 | **시스템 프롬프트는 계층별로 분기된다** | capability는 동일하게 좁히되, prompt가 아는 API는 역할별로 다름. `buildCommonBase`까지 분기 |
| 9 | **시맨틱이 UI 데모보다 먼저 간다** | 자식 노드 conversation을 UI에 노출할 때는 동일 phase에서 parent stale notice도 함께 들어가야 한다. "기능 먼저, 시맨틱 나중"은 운영 중 멘탈 모델 붕괴 |

---

## 5. 책임 분담 (책임 공백 방지)

원칙 3의 구체화. 각 책임에 명시적 owner가 있어야 한다.

| 책임 | Owner | 상태 |
|---|---|---|
| 사용자 ↔ Top 대화 | Top Manager | 이미 존재 (`/api/manager/message`) |
| 사용자 ↔ PM 대화 (1급) | PM | Phase 3a 신규 (`/api/manager/pm/:projectId/message`) |
| 사용자 ↔ 워커 대화 (1급) | Worker | 백엔드 이미 존재, UI는 Phase 1.5 |
| 라우팅 결정 | UI selector + @-mention | deterministic, NLP 없음 |
| **자식 대상 메시지 → 부모 staleness notice (worker→Top)** | **라우터 코드 (default ON, 무조건)** | **Phase 1.5 신규** (worker direct chat UI와 동일 phase) |
| **자식 대상 메시지 → 부모 staleness notice (worker→PM, PM→Top)** | **라우터 코드 (default ON, 무조건)** | **Phase 2** (PM 계층 추가 시) |
| 워커 spawn | dispatch caller (PM 또는 Top) | `POST /api/tasks/:id/execute` |
| Worker supervision (idle/needs_input/완료) | `lifecycleService` | 이미 존재 |
| Run/task truth | SQLite (`runService`) | source of truth |
| Dispatch 결정 (계층별) | PM (PM 트랙) / Top (MVP) | Phase 0 + Phase 3a |
| 프로젝트 메모리 (컨벤션, pitfalls) | `project_briefs` 테이블 | Phase 1 신규 |
| Dispatch 결정 기록 (감사) | `dispatch_audit_log` 테이블 | Phase 4 신규 |
| **Conversation identity (서버)** | **`runs.conversation_id` 또는 별도 테이블** | **Phase 1.5 신규 (다음 락 포인트)** |
| Conversation 라이프사이클 (클라) | `useConversations()` Map | Phase 1.5 (top+worker), Phase 3a (PM 추가) |
| PM thread 발급 (lazy) | 라우터 코드 + Codex `thread.started` 이벤트 | Phase 3a |
| PM 어댑터 선택 (사용자 preference) | `projects.preferred_pm_adapter` → 글로벌 → `'codex'` | Phase 1 |
| PM 어댑터 (현재 thread의 actual) | `project_briefs.pm_adapter` (preference와 다를 수 있음, reset 시 동기화) | Phase 1 |
| PM 비활성화 | `projects.pm_enabled=false` (라우터가 우회) | Phase 1 |
| PM 리셋 (사용자 트리거) | UI → cleanup service 호출 | Phase 3a |
| 어댑터 변경 → thread reset (사용자 트리거) | UI confirm → cleanup service 호출 | Phase 3a |
| **PM lifecycle cleanup** (`pm_thread_id` clear, `pm_adapter` 동기화, in-memory adapter session dispose) | **`pmCleanupService` (신규)** — disable/adapter switch/project delete/manual reset 모든 경로의 단일 owner | **Phase 3a** |
| PM 환각 / 사용자 우회 후 stale 검출 | `reconciliationService` (annotate-only) | Phase 4 |
| 사용자 알림 (needs_input/failed) | UI + SSE 시맨틱 이벤트 | Phase 5 |

---

## 6. 거부된 대안

| 대안 | 거부 이유 |
|---|---|
| **PM-as-Data** (단일 매니저 + brief 주입) | LLM 세션 컨텍스트가 단조 누적이라 격리 불가능. 격리의 시뮬레이션일 뿐 |
| **PM-as-Process** (상주 PM 프로세스 N개) | Fleet 관리, healthcheck, 회의 지옥, 토큰 비용 — 너무 비쌈 |
| **Top=Claude 고정** (정체성 결정) | 어댑터 중립 위반. default 권장으로 격하 |
| **LLM 라우팅** (Top이 어느 PM에 보낼지 추론) | 누적 컨텍스트 + 회의 지옥 부활. 원칙 2 위반 |
| **Reconciliation hard gate (day 1)** | False positive 비용 큼. annotate-only로 시작 |
| **Plan modification 분류로 부모 알림 제한** | 시간차 stale / 충돌 명령 / 의미 오판이 안 잡힘. 자식 라우팅 = 무조건 부모 notice |
| **Phase 1.5에 PM conversation까지 포함** | 너무 큼. top + worker만 먼저, PM은 서버 라우팅 준비 후 |
| **Claude PM resume을 Phase 3a 필수 인프라로 격상** | 어댑터 계약 / 회복 / 이벤트 정규화까지 변경, 시기상조. Phase 3b로 분리 |
| **Phase 0~5 한 트랙 빅뱅** | 롤백 포인트 사라짐. 보수적 분기점 도입 |
| **워커 자동 컨텍스트 주입 (CLAUDE.md prepend)** | task 모델 풍부화로 흡수 가능 |
| **USD / 토큰 캐시 통합 추적** | 사용자 deprioritize |
| **PM 명시 생성 ceremony** | Lazy 자동 생성으로 충분 (Codex `thread.started`가 자연스러운 트리거) |

---

## 7. PM Lazy 생성 모델

PM은 별도 spawn 액션 없이, 첫 PM-targeting 메시지에서 자연스럽게 발급된다.

### 7.1 라이프사이클

> **네이밍 주의**: `project_briefs.pm_thread_id` (프로젝트별 PM thread)와 기존 `runs.manager_thread_id` (manager run이 붙잡은 vendor thread, 005 마이그레이션)는 의미가 다르다. 전자는 프로젝트당 1개로 영속, 후자는 manager run 단위로 transient. v3에서는 PM용 영속 식별자를 `pm_thread_id`로 일관되게 사용한다.

```
1. 프로젝트 alpha 생성 (사용자 액션)
   → project_briefs.alpha 행 생성 (pm_thread_id = NULL, pm_adapter = NULL)
   → conventions, known_pitfalls 비어 있어도 OK
   → PM 어댑터 선택은 첫 turn 시점으로 미룸
   ❌ PM 프로세스 spawn 없음, thread_id 없음

2. 사용자가 alpha에 PM-targeting 메시지를 보냄
   - UI에서 alpha 선택 후 입력창
   - @alpha 명시 prefix
   - Top Manager가 alpha 관련 dispatch 필요 시 라우터가 PM에 위임
   ↓
3. 라우터가 project_briefs.alpha 조회
   - pm_thread_id가 NULL → 첫 turn
   - 어댑터 결정: project.preferred_pm_adapter → 글로벌 default → 'codex'
   - codex exec --json (thread_id 없이) + project_brief.conventions를 first user message로
   - thread.started 이벤트에서 thread_id 캡처
   - project_briefs.alpha.pm_thread_id = <captured>
   - project_briefs.alpha.pm_adapter = 'codex' (현재 thread의 actual adapter 기록)
   ↓
4. 다음부터는
   - codex exec resume <pm_thread_id> + 사용자 메시지
   - project_brief.conventions는 system prompt에 정적 (캐시 보호)
```

### 7.2 어댑터 선택 fallback

```
1. project.preferred_pm_adapter (있으면)
2. 글로벌 default (settings: PALANTIR_DEFAULT_PM_ADAPTER)
3. 하드코드 default = 'codex'
```

### 7.3 결정된 정책

| 항목 | 정책 |
|---|---|
| PM 비활성화 | `projects.pm_enabled = false` → Top이 직접 처리, 라우터가 PM 우회. 기존 `pm_thread_id`는 `pmCleanupService`가 정리 |
| 빈 brief 시 첫 turn | 그냥 진행. 사용자 첫 메시지가 곧 컨텍스트. Codex는 어차피 cwd의 AGENTS.md 자동 로드 |
| PM thread 리셋 | UI → `pmCleanupService.reset(projectId)` → `pm_thread_id=NULL`, in-memory adapter session dispose. 다음 메시지에서 새 thread |
| 단일 thread per project | 복수 PM 안 함. 멘탈 모델 단순성. 주제 분리는 task로 |
| 어댑터 변경 | Reset과 동등. UI confirm 강제 → `pmCleanupService.reset(projectId)` 호출. 새 thread, 새 기억 |
| 프로젝트 삭제 | `projects` 삭제 cascade → `project_briefs` 삭제 + `pmCleanupService.dispose(projectId)` |
| 어댑터 preference vs actual | `projects.preferred_pm_adapter` = 사용자 의도, `project_briefs.pm_adapter` = 현재 thread의 actual. 둘이 다르면 다음 reset 시점에 동기화 |

### 7.4 UX 시나리오

**시나리오 1: 새 프로젝트 + 즉시 작업**
1. "New Project: alpha" 클릭
2. project alpha 생성 (PM 자리는 비어 있지만 사용자는 모름)
3. alpha 선택 후 입력창에 "이거 리팩터해줘"
4. 라우터가 "alpha 컨텍스트, PM thread 없음" 감지 → Codex 새 thread 시작
5. 사용자에겐 그냥 "PM이 응답"으로 보임 — ceremony 없음

**시나리오 2: 프로젝트별로 어댑터 다르게 (Phase 3b 진행 후)**
1. 프로젝트 설정 → "PM Adapter: Claude"
2. 다음 alpha 메시지부터 Claude PM이 응답

**시나리오 3: PM 잘못 학습됨**
1. 프로젝트 alpha의 PM 패널 → "Reset PM" 클릭
2. Confirm
3. 다음 메시지부터 새 thread

**시나리오 4: PM 없이 Top 직접 처리**
1. 프로젝트 설정 → "Use PM: Off"
2. alpha 관련 메시지는 모두 Top Manager가 직접 처리

---

## 8. 데이터 모델 변경

> **중요**: 이 섹션은 **기존 마이그레이션 002, 005에 이미 존재하는 컬럼을 재사용**하도록 정렬되어 있다. v0.1 초안의 `parent_manager_run_id` 신규 추가와 `project_briefs.manager_thread_id` 네이밍은 코덱스 검증에서 충돌이 발견되어 폐기됨.

### 8.1 기존 컬럼 재사용 (신규 X, 의미 확장만)

- **`runs.parent_run_id`** (002 마이그레이션, 이미 존재)
  - v3에서 layer-aware하게 의미 확장:
    - Top run: `parent_run_id = NULL`
    - PM run: `parent_run_id = <Top run id>` (PM이 어느 Top 세션에 속하는지)
    - Worker run: `parent_run_id = <spawn한 Top 또는 PM의 run id>`
  - **신규 컬럼 추가하지 않음.** 의미는 코드 + 본 문서로 enforce.

- **`runs.manager_thread_id`** (005 마이그레이션, 이미 존재)
  - 의미 그대로: manager run이 잡은 vendor thread (Codex thread_id, 미래에 Claude session_id)
  - **`project_briefs.pm_thread_id`와 혼동 금지** — 이쪽은 manager run의 transient 식별자, 저쪽은 프로젝트별 영속 식별자

### 8.2 새 컬럼

```sql
-- Phase 1: projects
ALTER TABLE projects ADD COLUMN pm_enabled INTEGER DEFAULT 1;
ALTER TABLE projects ADD COLUMN preferred_pm_adapter TEXT;  -- 'claude' | 'codex' | NULL (사용자 preference)

-- Phase 1: tasks
ALTER TABLE tasks ADD COLUMN task_kind TEXT;                   -- 'code_change' | 'investigation' | 'review' | 'docs' | 'refactor' | 'other'
ALTER TABLE tasks ADD COLUMN requires_capabilities TEXT;       -- JSON array
ALTER TABLE tasks ADD COLUMN suggested_agent_profile_id TEXT;  -- FK
ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;

-- Phase 1.5: runs
ALTER TABLE runs ADD COLUMN manager_layer TEXT;     -- 'top' | 'pm' | NULL (worker)
ALTER TABLE runs ADD COLUMN conversation_id TEXT;   -- 'top' | 'pm:<projectId>' | 'worker:<runId>'
-- parent_manager_run_id는 추가하지 않음 (기존 parent_run_id 재사용)
```

### 8.3 새 테이블

```sql
-- Phase 1
CREATE TABLE project_briefs (
  project_id TEXT PRIMARY KEY,
  conventions TEXT,             -- CLAUDE.md/AGENTS.md 요약
  known_pitfalls TEXT,          -- 사람이 PM에게 알려주는 것
  pm_thread_id TEXT,            -- NULL이면 PM thread 미생성, 첫 turn에 생성. runs.manager_thread_id와 의미 다름 (섹션 8.1 참조)
  pm_adapter TEXT,              -- 현재 pm_thread_id의 actual adapter ('claude' | 'codex'). preferred_pm_adapter와 다를 수 있음
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Phase 4
CREATE TABLE dispatch_audit_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  pm_run_id TEXT,
  selected_agent_profile_id TEXT NOT NULL,
  rationale TEXT NOT NULL,            -- PM이 왜 이 agent를 골랐는지
  pm_claim TEXT,                      -- PM이 보고한 결과
  db_truth TEXT,                      -- 실제 run/task 상태
  incoherence_flag INTEGER DEFAULT 0, -- annotate, don't block (Phase 4 초반)
  created_at INTEGER NOT NULL
);
```

### 8.4 Dormant 필드 활성화 (신규 컬럼 아님)

`agent_profiles` 테이블의 기존 컬럼:
- `capabilities_json` → 매니저 dispatch 추론에서 실제 사용
- `max_concurrent` → `lifecycleService` 동시성 게이트에 연결
- `env_allowlist` → 이미 부분 활용됨, 점검만

---

## 9. Phase 계획

```
                          【MVP 트랙 — 반드시】
Phase 0  →  Phase 1  →  Phase 1.5  ─────►  분기점
Capability  데이터       Contract +
diet        모델         Conversation
1~1.5주     2주          identity
                         2~3주
                                            │ 트리거 조건 발생 시 ↓
                                            ▼
                          【PM 트랙 — 조건부】
                  Phase 2 → Phase 3a → Phase 4 → Phase 5
                  멀티슬롯  Codex PM   Reconcil.  Lifecycle
                  + parent  활성화     (annotate)  시맨틱
                  notice    2주        1주         1주
                  2주
                                                    ↓
                                          Phase 3b (옵션)
                                          Claude PM
                                          (3a 검증 후 별도 트리거)
```

### 9.1 Phase 0 — Capability Diet (1~1.5주)

**목적**: 매니저 권한과 정책의 정합성 회복. 어떤 어댑터가 매니저 역할로 spawn되든 동일 정책 적용.

**작업**:
- `server/services/managerAdapters/claudeAdapter.js:218` — `allowedTools`에서 `Write`, `Edit` 제거
  - 남기는 것: `Bash, Read, Glob, Grep, WebSearch, WebFetch`
- `server/services/managerSystemPrompt.js:buildCommonBase` 시그니처 변경: `buildCommonBase({ layer })`
  - `layer='top'`: 디스패처 5개 API만 (`GET /runs`, `GET /projects`, `GET /agents`, `POST /tasks`, `POST /tasks/:id/execute`)
  - `layer='pm'`: Top 5개 + 워커 내부 개입 API (`PATCH /tasks/:id/status`, `POST /runs/:id/input`, `POST /runs/:id/cancel`) — Phase 3a에서 사용
  - 두 변형 모두 "Always query the actual Palantir API" 조항 유지
- `server/services/managerAdapters/codexAdapter.js:142-143` — 매니저 역할 spawn에서 `--dangerously-bypass-approvals-and-sandbox` 비활성화
  - `spawnOneTurn`에 `role` 인자 추가 (`'manager' | 'worker'`)
  - 매니저 역할에서는 sandbox bypass 제외
- `server/tests/manager.test.js` — 회귀 테스트 추가

**완료 정의**:
- 매니저가 Edit/Write 시도 → 자연스럽게 워커 spawn으로 유도
- 매니저 prompt가 워커 내부 개입 API를 모름 (layer='top'일 때)
- 어떤 어댑터로 매니저 역할 spawn해도 동일 정책 적용 (어댑터 중립)

---

### 9.2 Phase 1 — 데이터 모델 풍부화 (2주)

**목적**: dispatch 결정의 부담을 prompt 추론에서 데이터로 이전. task 모델 풍부화 없이는 디스패처 모델이 자기 합리화로 전락.

**작업**:
- `server/db/migrations/006_task_enrichment.sql` — task_kind / requires_capabilities / suggested_agent_profile_id / acceptance_criteria
- `server/db/migrations/007_project_pm_settings.sql` — projects.pm_enabled, preferred_pm_adapter
- Dormant 필드 활성화:
  - `agent_profiles.capabilities_json`을 매니저 시스템 프롬프트의 dispatch 컨텍스트에 포함 (capability 매트릭스 brief)
  - `agent_profiles.max_concurrent`을 `lifecycleService`의 동시성 게이트에 연결
- `server/db/migrations/008_project_brief.sql` — `project_briefs` 테이블 (conventions, known_pitfalls, **`pm_thread_id`**, `pm_adapter`) — 섹션 8.3 참조. **`runs.manager_thread_id`(005)와 이름 혼동 금지**
- 매니저 시작 시 활성 프로젝트의 `brief.conventions`를 first user message에 포함 → **PM 없이도 프로젝트별 컨텍스트 캡슐화의 절반 확보**
- (선택) `CLAUDE.md` / `AGENTS.md` → `brief.conventions` 자동 추출 헬퍼

**완료 정의**:
- task 생성 시 task_kind / requires_capabilities를 채울 수 있음
- 매니저가 dispatch할 때 `agent_profile.capabilities_json`을 실제로 봄
- `max_concurrent`가 워커 spawn 시 강제됨

---

### 9.3 Phase 1.5 — Contract Split + Conversation Identity + Worker Parent Notice (2~3주, 다음 락 포인트)

**목적**: 단순 contract split이 아니라 **conversation identity가 1급 시민**이 되는 작업. 그리고 **원칙 9에 따라 worker direct chat UI와 worker→Top parent notice 시맨틱이 동일 phase에 함께 들어간다**. "UI 먼저, 시맨틱 나중" 위반 금지.

**서버 작업**:
- `server/db/migrations/009_manager_layer.sql` (Phase 1이 006/007/008을 소비하므로 1.5는 009. 실제 번호는 코딩 시점에 최종 결정)
  - `runs.manager_layer` (`'top'` / `'pm'` / NULL)
  - `runs.conversation_id`
  - **`parent_manager_run_id`는 추가하지 않음** — 기존 `runs.parent_run_id` 재사용 (002 마이그레이션, 섹션 8.1)
- Conversation identity 도입:
  - 식별자 체계: `'top'` | `'pm:<projectId>'` (Phase 3a에서 사용) | `'worker:<runId>'`
  - 일관된 인터페이스: `/api/conversations/:id/message`, `/api/conversations/:id/events` (또는 기존 `/api/manager/*`를 layer-aware하게)
  - 기존 `/api/manager/*`와 `/api/runs/:id/input`은 새 entry point로의 thin alias로 보존 (호환성)
- `runService.getActiveManager()` → `getActiveManagers({ layer })` 배열 반환
- `/api/manager/status` shape 변경: `{ top: {...}, pms: [] }` (PM은 항상 빈 배열)
- **워커→Top Parent Notice 라우터 (lock-in #2 + 원칙 9)**:
  - 사용자가 conversation target=`worker:<runId>`로 메시지 보낼 때, 해당 워커의 `parent_run_id`로 연결된 Top Manager run의 next first-user-message에 system notice 자동 첨부
  - 의도 분류 없음, 무조건
  - notice 형식 예시:
    ```
    [system notice] 사용자가 worker:abc123에 직접 메시지를 보냈음 (방금):
    "방향 바꿔, X 말고 Y로"
    이를 반영하여 상태를 다시 조회하세요.
    ```
  - PM 계층은 아직 없으므로 worker→Top 케이스만 구현. PM 계층 추가 시 worker→PM, PM→Top 케이스가 Phase 2에서 추가됨

**클라이언트 작업** (`server/public/app/lib/hooks.js`, `server/public/app.js`):
- `useManager()` → `useConversations()` Map<conversationId, Conversation>
  - 각 Conversation = `{ layer, target, status, events, sendMessage, lastEventCursor }`
  - **이번 Phase에서는 `top` + `worker:<runId>` 두 종류만**. PM은 Phase 3a에서 추가
- `App()`의 단일 `const manager = useManager()` 패턴 해체
- `ManagerView`의 단일 세션 전제 분해
- 깨질 가능성 있는 곳 (코덱스 검증):
  1. dashboard의 manager 요약
  2. manager route 전용 렌더링
  3. polling cursor reset 로직
  4. manager 전용 메시지 정규화
- 워커 detail 페이지에 conversation 패널 추가 (백엔드는 이미 존재) — **단, parent notice 라우터가 같이 활성화될 때만 노출**

**UI 결정**:
- "현재 컨텍스트" 드롭다운 + `@-mention`으로 deterministic 라우팅
- 시각적으로는 거의 그대로, 내부 모델만 일반화
- PM 카드/탭은 "PM 트랙 진입 시 활성화" 플레이스홀더

**완료 정의**:
- 모든 매니저/워커 호출이 conversation identity로 흐름
- 현재 동작 100% 보존, 회귀 테스트 통과
- 워커 직접 채팅 UI 작동
- **워커 직접 메시지 시 Top Manager가 stale notice를 받음** (수동 검증 + 자동 테스트)
- PM 자리는 데이터 모델 + UI 모두 미리 준비되어 있지만 비어 있음

**🚦 분기점**: MVP 트랙 종료. 멈춰도 의미 있게 좋아짐.

얻은 것:
- 매니저가 진짜 디스패처 (capability + prompt 정합성)
- task 모델이 dispatch를 데이터로 표현
- agent_profile dormant 필드 활성화
- 프로젝트별 컨텍스트 캡슐화의 절반 (brief.conventions)
- **Conversation identity 1급 시민** — 워커 직접 대화 UI, 미래 PM 추가 인프라
- 시스템 프롬프트 계층별 분기 토대

---

### 9.4 Phase 2 — 멀티 슬롯 런타임 + PM 계층 Parent Notice 확장 (PM 트랙, 2주)

**트리거**: 섹션 12의 PM 트랙 트리거 조건 둘 이상 충족

**작업**:
- `server/routes/manager.js`의 `activeManagerRunId` → `activeTopRunId + activePmRunIds: Map<projectId, runId>`
- `POST /api/manager/pm/:projectId/message`
- `lifecycleService:258-259`의 `is_manager` 가드 활용 (top/pm 모두 `is_manager=true`라 health loop가 건너뜀)
- **Phase 1.5의 worker→Top notice 라우터를 PM 계층으로 확장** (원칙 9 + lock-in #2):
  - worker→PM: 워커의 `parent_run_id`가 PM run을 가리키면 PM에게 notice
  - PM→Top: 사용자가 PM에 보낸 메시지는 PM의 `parent_run_id`로 연결된 Top에게 notice
  - worker→Top: Phase 1.5에서 이미 구현됨, 그대로 유지
  - 모든 케이스에서 의도 분류 없음, 자식 라우팅 = 무조건 부모 notice

---

### 9.5 Phase 3a — Codex PM 활성화 (1~2주)

**작업**:
- `server/services/managerAdapters/codexAdapter.js`로 PM 시나리오 가동
- 라우터의 lazy 생성 로직: `pm_thread_id IS NULL` → 새 thread, `thread.started`에서 캡처 후 `project_briefs.pm_thread_id` 저장
- system prompt **완전히 정적** (cached_input_tokens 보호)
- **PM용 시스템 프롬프트 신규 작성**: `buildCommonBase({ layer: 'pm' })` 사용
- `server/services/routerService.js` 신규 — deterministic 3단계 매처:
  1. UI에서 선택된 현재 프로젝트 컨텍스트
  2. 명시적 prefix `@alpha`
  3. 프로젝트명 exact/alias match
  4. 셋 다 실패 → ambiguous → Top이 사용자에게 되묻기
- **`server/services/pmCleanupService.js` 신규** (책임 분담표의 단일 owner):
  - `reset(projectId)` — manual reset, adapter switch 시 호출. `pm_thread_id=NULL`, `pm_adapter=NULL`로 클리어 + in-memory adapter session dispose
  - `dispose(projectId)` — `pm_enabled=false` 토글, project 삭제 시 호출. reset과 동일 작업
  - 라우트(`POST /api/manager/pm/:projectId/reset`)와 `projectService.deleteProject` 양쪽에서 호출
- `useConversations()`에 `pm:` 타입 추가
- "Reset PM" UI 버튼 + API → `pmCleanupService.reset` 호출
- 어댑터 변경 시 confirm → `pmCleanupService.reset` 호출

---

### 9.6 Phase 3b — Claude PM 활성화 (옵션, 별도 트리거)

**조건**: Phase 3a 검증 완료 + Claude로 PM 띄울 실제 use case 발생

**작업**:
- `server/services/streamJsonEngine.js`에 `--resume <session_id>` 또는 `--continue` 지원 추가
- `claudeAdapter.capabilities.supportsResume: true`로 전환
- 어댑터 계약 / 종료 감지 / 회복 / 이벤트 정규화 모두 검토 (단순 플래그 추가가 아님)
- `runs.manager_thread_id`를 Claude session_id에도 재사용 (또는 별도 컬럼)
- 일정은 현재 단계에서 추정하지 않음

---

### 9.7 Phase 4 — Reconciliation (annotate-only, 1주)

**철학**: hard gate 아님. False positive 비용이 큼.

**작업**:
- `server/db/migrations/010_dispatch_audit.sql` — `dispatch_audit_log` 테이블
- `server/services/reconciliationService.js`
- PM 응답이 Top에 전달되기 전에 검사하지만 **차단하지 않음**
- 검사 대상:
  1. PM 환각 (PM이 "task X 완료"라고 했지만 DB에 still running)
  2. **사용자 직접 개입 후 PM 메모리 staleness** (원칙 7의 자연스러운 후속, 더 자주 발생할 시나리오)
- 불일치 시 `incoherence_flag=1` + UI warning 배지
- 운영 후 false positive율이 낮으면 hard gate로 승격 검토

---

### 9.8 Phase 5 — Lifecycle Event 시맨틱 정제 (1주)

**목적**: SSE 채널은 이미 존재. 신규 도입이 아니라 의미 강화.

**작업**:
- `server/routes/events.js` SSE 페이로드에 시맨틱 필드 추가:
  - `from_status`, `to_status`, `reason`, `task_id`, `project_id`
- 클라이언트(`server/public/app.js`)에서 `needs_input` / `failed`에 우선순위 알림:
  - 탭 타이틀 변경 / 사운드 / OS notification
- 단순 reload trigger와 의미 있는 alert 분리

---

## 10. 받아들인 위험과 모니터링

| 위험 | 받아들인 이유 | 모니터링 방법 |
|---|---|---|
| Capability diet로 매니저가 일부 워크플로 못 함 | 정합성 회복의 본질 | 매니저가 task 생성 후 stuck되는 빈도 |
| **책임 공백** (코덱스 경고) | 책임 분담표 + 원칙 3로 mitigate, 완전 제거 안 됨 | 시스템 수준 실패 발생 시 owner 사후 분석 |
| Conversation identity 데이터 모델이 한 번에 잘 안 잡힐 수 있음 | Phase 1.5에서 시간 들여서 잡는 게 빅뱅보다 안전 | Phase 1.5 끝났을 때 Phase 2 진입이 매끄러운지 |
| Reconciliation annotate-only는 PM 환각/stale을 막지 못함 | hard gate false positive가 더 큼 | `incoherence_flag` 발생률 |
| 모든 자식 메시지를 무조건 부모 notice로 보내면 부모 컨텍스트 비대화 | 안전이 우선. notice는 짧게 (한 줄) | Top context window 사용량 |
| Claude PM이 영원히 안 만들어질 수 있음 | "어댑터 중립 = 두 경로가 구조적으로 가능"이지 "두 경로 동시 구현"은 아님 | 사용자 요구 발생 시에만 |
| PM 트랙이 영원히 미뤄질 수 있음 | Contract split 비용이 1.5배 정도로 작고 미래 옵션 가치가 큼 | 6개월 내 트리거 조건 발생 여부 |
| **Manager prompt 비대화** (task 모델 빈약하면 prompt가 보완) | Phase 1이 task 모델 풍부화 + Phase 0이 prompt 슬림화. 한 쌍 | 매니저 system prompt 길이 |
| **기존 단일 매니저 API thin alias의 영구 잔존** | Phase 1.5의 호환성 보장. 종료 시점은 별도 결정 (PM 트랙 진입 후 6개월 이상 지난 뒤 검토) | alias 호출 빈도 (사용 안 되면 제거 candidate) |
| **PM thread cleanup 누락으로 vendor side에 orphan thread 누적** | `pmCleanupService`가 in-memory dispose만 보장. Codex vendor 측의 orphan은 어차피 외부, 우리가 정리 못 함 | Codex 사용량 모니터링에서 이상 감지 시 대응 |

---

## 11. 명시적 비목표

다음 항목들은 **이번 재설계 범위에 포함되지 않는다.** 향후 별도 결정으로 추가 가능.

| 항목 | 이유 |
|---|---|
| USD 비용 추적 통합 (Claude Top + Codex PM 단위) | 사용자 deprioritize |
| 토큰 캐시 효율성 모니터링 (cached_input_tokens) | 사용자 deprioritize |
| 진짜 PM-as-Process (상주 PM 프로세스) | Codex thread_id resume이면 충분 |
| 워커 자동 컨텍스트 주입 (CLAUDE.md prepend) | task 모델 풍부화로 흡수 가능 |
| LLM 기반 라우팅 / 의도 분류 | 원칙 2 |
| Plan modification 의도 감지 | 정정 — 자식 라우팅 = 무조건 부모 notice로 단순화 |
| Reconciliation hard gate | 정정 — annotate-only로 시작 |
| Top Manager fixed adapter 결정 | 정정 — 어댑터 중립 |
| UI 데모를 conversation identity보다 먼저 출시 | 코덱스 경고 — 시맨틱 먼저 |
| PM 명시 spawn ceremony | Lazy 자동 생성으로 충분 |
| 멀티 PM thread per project | 멘탈 모델 단순성, 주제 분리는 task로 |
| Vendor thread 어댑터 간 마이그레이션 | 기술적 불가, 어댑터 변경 = reset |
| 기존 단일 매니저 API thin alias의 즉시 종료 | Phase 1.5에서 호환성 보장. 종료는 PM 트랙 진입 후 별도 결정 (위험 표 참조) |
| Codex vendor 측 orphan thread 청소 | 우리 시스템 외부. `pmCleanupService`는 in-memory dispose만 |

---

## 12. PM 트랙 진입 트리거 조건

PM 트랙(Phase 2~5)은 아래 조건 **둘 이상**이 충족될 때만 진입한다. Speculative 도입 금지 (원칙 5).

1. **사용자가 한 매니저 세션에서 3개 이상 프로젝트를 정기적으로 다룬다.**
2. **단일 매니저 컨텍스트 윈도우 비대화가 체감된다.** (응답 품질 저하, 토큰 비용 급증)
3. **프로젝트 간 추론/결정 오염 사례가 실제로 발생한다.** (예: 프로젝트 A 컨벤션이 프로젝트 B 결정에 영향)

---

## 13. 다음 행동

### 13.1 즉시 (Phase 0 착수)

1. `server/services/managerAdapters/claudeAdapter.js:218` — `allowedTools`에서 `Write`, `Edit` 제거
2. `server/services/managerSystemPrompt.js:buildCommonBase` 시그니처 변경 (`{ layer }`) + `layer='top'` 슬림화
3. `server/services/managerAdapters/codexAdapter.js:spawnOneTurn` — `role` 인자 추가 + sandbox bypass 분기
4. `server/tests/manager.test.js` — 회귀 테스트
5. (이미 완료) 본 문서 `docs/specs/manager-v3-multilayer.md` 저장

### 13.2 단기 (Phase 1)

1. Migration 006 (task enrichment)
2. Migration 007 (project pm settings)
3. Migration 008 (project_briefs)
4. Dormant 필드 활성화 (capabilities_json, max_concurrent)
5. (선택) CLAUDE.md/AGENTS.md → brief.conventions 추출 헬퍼

### 13.3 중기 (Phase 1.5 — 다음 락 포인트)

1. Migration 009 (`runs.manager_layer`, `runs.conversation_id`) — `parent_run_id`(002) 재사용, **`parent_manager_run_id` 신규 추가 금지** (섹션 8.1)
2. Conversation identity 서버 인터페이스 설계 미니 토론 (스키마 + API shape 동시 결정)
3. `useConversations()` 구현 (top + worker)
4. 워커 detail 페이지에 conversation 패널
5. 회귀 테스트 — Phase 1.5 끝나면 동작 100% 보존 확인

### 13.4 분기점

MVP 트랙 종료. 트리거 조건 모니터링 시작. PM 트랙 진입 여부는 별도 결정.

---

## 14. 한 줄 결론

> 매니저 세션 재설계의 본질은 **"디스패처 의도와 권한 넓은 구현 사이의 갭 좁히기 + 사용자가 계층 밖에서 어느 노드와도 직접 대화할 수 있는 conversation 시맨틱 도입"** 이다. 어댑터 중립을 유지하면서 (Top=Claude/PM=Codex는 default 권장), 자식 메시지를 무조건 부모 staleness 신호로 취급하고, 시스템 프롬프트는 계층별로 분기하되 capability는 동일하게 좁힌다. 가장 중요한 락 포인트는 **conversation identity + parent notice semantics** 이며, 이게 Phase 1.5의 핵심 산출물이다. PM 계층 자체는 트리거 조건이 발생할 때까지 보류하지만, 그 자리는 데이터 모델과 UI 모두에 미리 비어 있는 슬롯으로 준비되어 있어서 진입 시 빅뱅 마이그레이션이 없다.

---

## Appendix A: 코덱스 교차검증 요약

본 종합안은 두 차례의 코덱스 교차검증을 거쳤다.

### A.1 1차 검증 (5단계 Phase 방안)

**코덱스가 잡아낸 것**:
- API/UI contract split (Phase 1.5) 추가 권고 — 멀티 슬롯의 진짜 비용은 DB가 아니라 `hooks.js`의 단일 세션 lifecycle
- Phase 0 1주는 "Top=Claude 고정 선결" 시에만 가능 (Codex sandbox bypass가 launch flag라서)
- Reconciliation은 hard gate가 아니라 annotate-only로 시작
- Router는 deterministic 3단계 (NLP 절대 금지)
- 보수적 분기점 도입 권고 — Phase 0+1+1.5만 먼저, PM 트랙은 트리거 발생 시

### A.2 2차 검증 (정정 3가지 + PM lazy 생성)

**코덱스가 잡아낸 추가 5가지**:
- **정정 A**: Claude PM resume "필수 인프라" 격상 시기상조 → Phase 3b로 분리, 별도 트리거
- **정정 B**: "plan modification 감지" 폐기 → 자식 라우팅 = 무조건 부모 notice (시간차 stale, 충돌 명령, 의미 오판 모두 커버)
- **정정 C**: `buildCommonBase()`도 계층별 분기 (`buildRoleSection`만으론 부족)
- **정정 D**: Phase 1.5 conversation 추상화는 top + worker만 먼저, PM 제외
- **정정 E (가장 큼)**: 새 모순 발견 — PM conversation identity가 서버에 없음. 다음 락 포인트는 "PM resume"이 아니라 **conversation identity + parent notice semantics**

**코덱스의 lock-in 권고** (그대로 채택):
> "lock-in 대상은 최종 세부 구현이 아니라 아래 세 줄이어야 한다.
> 1. 어댑터 중립 유지, Codex PM 선검증, Claude PM resume은 후속.
> 2. 자식 대상 사용자 메시지는 전부 부모 staleness 신호로 취급.
> 3. prompt 분기와 conversation 추상화는 같이 간다."

**가장 큰 잠재 위험** (코덱스 경고):
> "PM/worker direct chat을 UI에서 먼저 열고, 부모 stale 처리와 conversation identity를 나중에 붙이는 순서. 그렇게 가면 기능은 데모되지만 운영 중 멘탈 모델 붕괴가 바로 발생한다."

→ 이 위험을 피하기 위해 Phase 1.5의 본질이 "UI 작업"이 아니라 "conversation identity 데이터 모델 + 시맨틱 도입"으로 정의됨. v0.2에서 worker→Top parent notice를 Phase 1.5로 이동시켜 sequencing 위반을 완전 차단.

### A.3 3차 검증 (v0.1 문서 검증, v0.2로 정정)

**코덱스가 잡아낸 4가지 + 1가지 누락**:
- **스키마 충돌**: v0.1이 `runs.parent_manager_run_id`를 신규 추가하려 했으나 기존 `runs.parent_run_id`(002)와 중복. → 기존 컬럼 재사용으로 정정 (섹션 8.1)
- **네이밍 충돌**: `project_briefs.manager_thread_id`가 기존 `runs.manager_thread_id`(005)와 의미 다른데 이름 같음. → `pm_thread_id`로 리네임 (섹션 8.3)
- **Sequencing 위반**: v0.1이 worker direct chat UI를 Phase 1.5에 두고 worker→Top notice는 Phase 2로 미룸 — 원칙 9 위반. → 둘 다 Phase 1.5로 통합 (섹션 9.3)
- **책임 공백**: PM disable / adapter switch / project delete cleanup owner 불명확. → `pmCleanupService` 신규 + 책임 분담표 추가 (섹션 5, 9.5)
- **원칙 누락**: "UI 데모보다 시맨틱이 먼저"가 비목표로만 강등됨. → 원칙 9로 격상 (섹션 4)

---

## Appendix B: 관련 문서

- [manager-v2.md](./manager-v2.md) — 현재 매니저 세션 (Claude Code subprocess + stream-json) UI/UX 스펙
- [manager-session-ui.md](./manager-session-ui.md) — 매니저 세션 초기 설계 제안
- [research-and-review.md](../research/research-and-review.md) — 프로젝트 리서치 노트
- [../test-scenarios.md](../test-scenarios.md) — QA 사용자 시나리오 (Phase 0~7 포함)
- `CLAUDE.md` (프로젝트 루트) — 프로젝트 컨벤션과 아키텍처 개요

---

## 15. Implementation Log (Phase 0 ~ 7)

> 이 섹션은 lock-in 이 아니라 **구현 결과 기록** 이다. 본 문서 §1~§14 는 역사 고정, 이 섹션은 실제 merge 된 내용을 반영한다.

### Phase 매핑

| Phase | 설명 | PR | 상태 |
|---|---|---|---|
| 0 | Capability Diet (Write/Edit 제거, layer prompt, Codex role-based sandbox) | #20 | ✅ merged |
| 1 | 데이터 모델 풍부화 (task_kind, pm settings, project_briefs, agent dormant fields) | #21 | ✅ merged |
| 1.5 | Conversation identity + worker→Top parent notice (`managerRegistry`, `conversationService`, migration 009, `/api/conversations/*`, `/api/runs/:id/input` alias, Principle 9 hints) | #22 | ✅ merged |
| 2 | 멀티 슬롯 PM 런타임 + PM-layer parent notice 확장 (`sendToManagerSlot`, `resolveParentSlot`, `POST /api/manager/pm/:projectId/message`, `status.pms[]`, `onSlotCleared` 리스너, race-safe drain splice) | #27 | ✅ merged |
| 3a | Codex PM lazy spawn + single-owner cleanup (`pmSpawnService`, `pmCleanupService` fail-closed, `codexAdapter.resumeThreadId` + `onThreadStarted`, `/reset` 라우트, project delete cascade, brief 을 static system prompt 에 bake) | #28 | ✅ merged |
| 4 | Annotate-only reconciliation (migration 010, `reconciliationService.recordClaim`, pm_hallucination + user_intervention_stale 탐지, strict envelope/entity binding, `/api/dispatch-audit`) | #29 | ✅ merged |
| 5 | SSE lifecycle 시맨틱 envelope (from/to_status/reason/task_id/project_id additive, `run:needs_input` priority alert, client pulseTabTitle) | #30 | ✅ merged |
| 6 | PM UI exposure + routerService (3-step matcher `/api/router/resolve`, ManagerView Conversation dropdown + PM label + Reset PM 버튼, `useConversation` race fence 5 layer) | #31 | ✅ merged |
| 7 | Dispatch audit UI (Dashboard Drift 배지 + DriftDrawer, ManagerView per-PM drift indicator, `useDispatchAudit` + SSE live push, `useSSE` channels 회귀 수정 run:needs_input + dispatch_audit:recorded) | #32 | ✅ merged |
| P6 (ESM) | ManagerView(P6-1) + self-bridge 정리(P6-7), SessionsView ESM(P6-3), streamJsonEngine 테스트 + pm:id 커버리지(P6-5/P6-8), result_summary UI(P6-6) | #60~#61, #64 | ✅ merged |
| P7 (ESM) | TaskModals ESM(P7-1) + Notifications ESM(P7-4), PM force-delete 탈출구(P7-2), legacy alias deprecation(P7-3), app.js 슬림화→291줄(P7-5) | #62~#64 | ✅ merged |
| 3b | Claude PM adapter resume (`streamJsonEngine --resume/--continue`, claudeAdapter supportsResume) | — | 🚦 트리거 조건 미충족 (§9.6, "Claude PM use case 발생") |

### 구현 결과 vs 본문 §9 / §12 의 차이점

본문의 phase 설계는 lock-in 이지만, 실제 코드 진입 후 조정된 것은 다음과 같다:

0. **PM 트랙 진입 트리거 조건 (§12) 의 실질 유예** — **가장 중요한 변경점**.
   - 본문 §12 는 PM 트랙 (Phase 2~5) 진입을 "세 트리거 중 둘 이상 충족 시" 로 잠갔다. 트리거: (a) 3+ 프로젝트 동시 취급, (b) 단일 매니저 컨텍스트 비대화 체감, (c) 프로젝트 간 추론 오염 관찰.
   - **실제 merge 이력은 트리거 조건 없이 Phase 2→7 까지 연속 진행됨.** 사용자가 "자율모드로 쭉 진행해" 라고 선언하여 트리거 gating 을 명시적으로 철회했고, 그 선언에 따라 Phase 2 (멀티 슬롯 런타임) → Phase 3a (Codex PM 활성화) → Phase 4/5/6/7 까지 한 세션에 전부 merge 되었다.
   - 결과적으로 §12 는 **역사 기록** 으로만 의미를 갖는다. "트리거 없이 진입해도 된다" 는 런타임 증명은 Phase 3a/6/7 각각의 live Playwright smoke 로 수행되었고, 실제 운영 손실 없음을 확인.
   - Phase 3b (Claude PM resume) 만 §9.6 의 독립 트리거 ("Claude PM use case 발생") 로 여전히 gated 상태 유지.
1. **Phase 6 (UI exposure) 독립** — 본문에 독립 phase 로 정의되지 않았다. 본문 §9.3 (Phase 1.5) 이 "conversation identity + worker 직접 채팅 UI" 를 포함했고, PM UI 는 §9.4 (Phase 2) 에 암묵적으로 들어갈 것으로 설계되었다. 실제로는 §9.4 를 "런타임 플러밍" 과 "사용자 노출 UI" 로 나누어 각각 Phase 2 / Phase 6 으로 분리. Spec 원칙 9 ("UI 노출은 시맨틱 먼저") 는 이 분리로 유지된다.
2. **Phase 7 (Dispatch audit UI) 독립** — 본문에 독립 phase 로 없었다. 본문 §9.7 (Phase 4 Reconciliation) 이 서버 기록 + UI warning 배지를 한 phase 로 묶었지만, 실제 코드는 서버 배선 (Phase 4) 과 사용자 노출 (Phase 7) 로 분리. Phase 4 를 완성하는 마지막 조각이 Phase 7.
3. **`useManager()` dismantle 보류** — 본문 §9.3 완료 정의에 포함되지만, Phase 6 에서 의도적으로 **공존 구조 (C안)** 로 남겼다. 전면 마이그레이션은 별도 phase 로 분리. 근거: codex 상호 리뷰에서 "Phase 6 범위에서 `ManagerView` 재구축은 과함" 판정.
4. **PM 시스템 프롬프트에 Dispatch Audit 섹션 + pm_run_id 주입 추가** — 본문에 없던 Phase 4 R1/R3 교차 리뷰 결과. PM 이 실제로 audit API 를 호출하려면 프롬프트 지시 + 자기 run id 접근이 필요하다는 발견.
5. **Phase 6 과 Phase 7 에서 `useSSE` channels 회귀 발견** — 본문 §9.8 의 Phase 5 가 `run:needs_input` 을 추가했지만 `server/public/app/lib/hooks.js useSSE` 의 hard-coded channels 배열에 등록하는 것을 누락했다. Phase 7 live smoke 에서 `dispatch_audit:recorded` 채널도 같은 누락을 시도하다가 발견되어, 두 채널을 함께 복구. Phase 5 의 tab-title pulse 경로는 이 수정 전까지 dead code 였음. 이 사실은 CLAUDE.md "Things to Watch Out For" + test-scenarios REG-09 에 기록됨.

### Codex 교차검증 누적 요약

Phase 2~7 merge 시점까지 누적 codex round: **17+ rounds** (Phase 4 가 6 rounds 로 가장 많음 — 매 라운드마다 새로운 envelope forgery vector 발견). 모든 phase 최종 PASS. 자세한 blocker 기록은 각 PR 본문 참조 (#27~#32).

### 누적 테스트 상태

- Phase 1.5 merge 시점: ~172 tests
- Phase 7 merge 시점: **238 tests** (server-side unit + supertest HTTP + fake adapter)
- P6+P7 ESM 추출 + 정리 완료 시점: **498 tests**
- Playwright live smoke: Phase 3a/6/7 에서 각각 수행 (격리 포트 4188 + 임시 DB, prod 4177 무손상)
- 회귀 0

### Trigger-gated / 의도적 deferred 항목

- **Phase 3b (Claude PM resume)**: §9.6 의 "Claude PM use case 발생" 트리거 미충족. 사용자 선언 전까지 대기.
- **Reconciliation hard gate 승격** (§9.7 후반): 운영 false-positive 율 관찰 후 결정. Phase 7 로 UI 가 붙은 이후부터 데이터 수집 가능.
- **`useManager()` → `useConversations()` 전면 마이그레이션**: 공존 구조가 막힌 기능 없음. 별도 phase 로 분리.
- **`dispatch_audit_log` CASCADE FK**: codex 상호 리뷰에서 "거절" — audit trail 의미 유지. 필요 시 read-side filter 로 대응.
- **Force-delete 탈출구** (고장난 PM 복구용): Phase 3a R3 에서 "future work" 판정. fail-closed 가 현 기본값.
