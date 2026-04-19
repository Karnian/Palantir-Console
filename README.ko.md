# Palantir Console

[English](README.md)

AI 코딩 에이전트(Claude Code, Codex, OpenCode)를 3계층 구조로 운영하는 중앙 관제 허브.

```
Main Manager (Top)          ← 전체 프로젝트와 PM을 총괄
 ├── PM (Project A)         ← 프로젝트 내 워커들을 관리
 │    ├── Worker 1          ← 실제 코딩 작업 수행
 │    ├── Worker 2
 │    └── Worker 3
 ├── PM (Project B)
 │    └── Worker 1
 └── PM (Project C)
      ├── Worker 1
      └── Worker 2
```

**Worker** — 프로젝트 안에서 실제 코딩 작업을 수행하는 AI 에이전트(Claude Code, Codex 등). 각 워커는 독립된 Git worktree에서 격리 실행되어 서로 충돌하지 않는다.

**PM (Project Manager)** — 프로젝트 단위로 할당되어 해당 프로젝트의 워커들을 관리한다. 태스크를 워커에게 분배하고, 진행 상황을 추적하며, 프로젝트의 컨벤션과 맥락을 유지해 일관된 방향으로 작업을 조율한다.

**Main Manager (Top)** — 최상위 관제자. 여러 프로젝트와 PM들을 총괄하며, 사용자의 지시를 적절한 PM에게 라우팅하고, 프로젝트 간 우선순위와 상태를 한눈에 파악할 수 있는 단일 대화 창구.

이 모든 계층을 웹 대시보드(`localhost:4177`)에서 실시간으로 모니터링하고 제어한다.

> **v3 Manager 재설계 완료.** 스펙은 `docs/specs/manager-v3-multilayer.md`, 사용자 시나리오는 `docs/test-scenarios.md` 참고.

## 빠른 시작

### 로컬 실행

```bash
npm install
npm start
open http://localhost:4177
```

### 자동 환경 설정 (nvm/volta/fnm)

```bash
bash setup.sh   # Node 20+ 자동 감지/설치, npm install 실행
npm start
```

Node 버전 매니저(nvm, volta, fnm)가 설치되어 있으면 자동으로 Node 20을 설치한다.

### Docker 실행

```bash
docker compose up --build
open http://localhost:4177
```

### Docker + 인증

```bash
# .env 파일
PALANTIR_TOKEN=my-secret-token
ANTHROPIC_API_KEY=sk-ant-...    # 선택: Claude 기반 Manager 용
CODEX_API_KEY=...               # 선택: Codex 기반 Manager 또는 PM 용

docker compose up --build
# → http://localhost:4177 (Authorization: Bearer my-secret-token 헤더로 호출)
```

### 바인딩 정책 (PR1 에서 변경)

기본값은 **`127.0.0.1`** 바인딩 (loopback, 인증 없음). `PALANTIR_TOKEN` 을
설정하면 자동으로 `0.0.0.0` 으로 승격된다. 토큰 없이 모든 인터페이스에
노출하려면 `HOST=0.0.0.0` 을 명시해야 한다 (권장하지 않음 — `[security] WARNING`
로그 출력).

| 설정 | `HOST` | `PALANTIR_TOKEN` | 바인딩 |
| --- | --- | --- | --- |
| 개발 기본 | 미지정 | 미지정 | `127.0.0.1` |
| 원격 + 인증 | 미지정 | 설정 | `0.0.0.0` |
| 레거시 (항상 0.0.0.0) | `0.0.0.0` | 미지정 | `0.0.0.0` (⚠️ 무인증 공개) |
| 커스텀 | `192.168.x.y` | 무관 | 지정값 |

```bash
PALANTIR_TOKEN=my-secret-token npm start
# → CLI: Authorization: Bearer my-secret-token
# → 브라우저: POST /api/auth/login 으로 palantir_token 쿠키 수립 (자동)
# → 바인딩: 0.0.0.0
```

**브라우저 클라이언트**는 HttpOnly 쿠키로 인증한다. `http://host:4177/login.html`
로 접속해 POST 폼에 토큰을 입력하면 `palantir_token` 쿠키가 수립된 뒤 콘솔로
리다이렉트된다. 토큰은 URL 에 절대 노출되지 않는다 — 초기 PR1 초안은
`?token=` 쿼리 파람 부트스트랩을 허용했으나, 첫 document 요청이 이미 리버스
프록시 액세스 로그에 토큰을 기록한다는 Codex 리뷰 지적을 받고 제거했다.
`EventSource` 가 커스텀 헤더를 보낼 수 없어 Bearer 만으로는 `/api/events`
SSE 가 구조적으로 막히던 문제를 수정한 결과 (NEW-S1).

## 핵심 개념

```
Main Manager (Top)  →  PM (프로젝트별)  →  Worker (태스크별)
 (총괄 관제)          (프로젝트 관리)      (AI 코딩 에이전트)
```

| 개념 | 설명 |
|------|------|
| **Main Manager (Top)** | 최상위 관제자. 사용자 지시를 적절한 PM에게 라우팅하고 전체 프로젝트를 총괄 |
| **PM (Project Manager)** | 프로젝트별 관리자. 워커를 조율하고 태스크를 분배하며 프로젝트 맥락을 유지. 첫 메시지 시 lazy-spawn |
| **Worker** | 실제 코딩을 수행하는 AI 에이전트 (Claude Code, Codex, OpenCode). 독립 Git worktree에서 격리 실행 |
| **Project** | 작업 묶음. 예: "백엔드 API", "프론트엔드 리팩토링" |
| **Task** | 구체적인 할 일. 칸반 보드에서 관리. Backlog → Todo → In Progress → Review → Done |
| **Run** | Task에 대해 에이전트를 실행한 기록. 하나의 Task에 여러 Run 가능 |
| **Agent Profile** | 실행할 에이전트 설정 (Claude Code, Codex CLI, OpenCode, 커스텀) |
| **Conversation** | 모든 채팅 surface의 1급 식별자: `top`, `pm:<projectId>`, `worker:<runId>` |

## 화면 구성

### 1. Dashboard (◉)

**관제 허브.** 지금 바로 신경 써야 할 것만 보여준다.

- **Active** — 현재 실행 중인 에이전트 수
- **Needs Input** — 에이전트가 사용자 응답을 기다리는 중 (최우선)
- **Done Today** — 오늘 완료된 Run 수
- **Drift ⚠** (v3 Phase 7) — PM 이 DB 와 어긋난 주장을 기록했을 때 뜨는 annotate-only 배지. 0 이면 숨김. 클릭하면 **Drift Drawer** 가 열려 각 row 에 대해 PM 주장 vs DB truth 좌우 diff + 색상별 kind + Dismiss/Restore 동작을 제공한다.

아래의 **Triage Feed**:
- Needs Input (최우선) — `Respond` 로 바로 응답
- Failed — 실패한 Run, 재시도 가능
- Running — 정상 실행 중, `Inspect` 로 실시간 로그 확인
- Review — 에이전트가 끝냈으니 결과 확인 필요

### 2. Task Board (⊞)

**칸반 보드.** 5개 컬럼으로 Task 를 관리한다.

```
Backlog  →  Todo  →  In Progress  →  Review  →  Done
```

**기본 사용법:**
1. `+ New Task` 또는 키보드 `N` — 새 Task 생성
2. 카드를 드래그해 컬럼 간 이동
3. Todo → In Progress 드래그하면 **에이전트 실행 모달** 이 열림
4. 카드 클릭 시 상세 패널 (제목/설명/Status/Priority/Project inline edit + Runs + Delete)

### 3. Projects (▣)

프로젝트 목록. `+ New Project` 로 생성.

각 프로젝트는 다음 v3 필드를 갖는다:
- `pm_enabled` — 프로젝트가 PM 을 lazy-spawn 할 수 있는지 여부
- `preferred_pm_adapter` — `codex` 또는 `claude` 선호도 (Claude resume 은 Phase 3b 전까지 codex 로 fallback)
- `project_brief` — conventions + known pitfalls. 이 값은 PM 시스템 프롬프트에 static 하게 주입되어 cached_input_tokens 를 유지한다.

### 4. Manager (✦)

**중앙 오케스트레이터.** Claude Code 또는 Codex CLI 를 Manager 에이전트로 실행해 워커를 관제한다.

- **40/60 분할 레이아웃**: 왼쪽 채팅(40%) + 오른쪽 워커 세션 그리드(60%)
- **Start Manager** — Top 매니저 세션 시작. 에이전트 프로필 드롭다운에서 Claude Code 또는 Codex 선택 가능.
- **Conversation target 드롭다운** (v3 Phase 6) — 사용자가 Top 세션 또는 현재 활성 PM(`pm:<projectId>`) 을 선택해서 메시지 target 전환. 각 PM 옵션은 현재 활성 여부(`active`) 마커로 표시된다. `@<projectName> 메시지` 형식으로 입력하면 `/api/router/resolve` 가 해당 PM 으로 rewrite 해준다 (미스/다중 매칭 시 toast 로 명시).
- **Reset PM** — 선택된 PM 의 Codex thread 를 종료하고 `pm_thread_id` 를 지운다. 다음 메시지부터 새 thread 로 시작.
- **Per-PM drift 인디케이터** (v3 Phase 7) — 해당 PM 에 대기 중인 incoherent audit row 가 있으면 Reset PM 옆에 `⚠ N` 버튼이 나타나 같은 Drift Drawer 를 연다.
- Manager 는 Palantir Console REST API 를 curl 로 직접 조회해 실제 run/task 상태를 파악한다.
- 지원 프로토콜:
  - **Claude Code CLI**: `--print --output-format stream-json --input-format stream-json` (multi-turn)
  - **Codex CLI**: `codex exec --json` (첫 턴) + `codex exec resume <thread_id>` (이후 턴) + `model_instructions_file` 로 시스템 프롬프트 캐싱

### 5. Agents (⚙)

에이전트 프로필 관리. 기본 3개:

| 프로필 | 명령어 | 용도 |
|--------|--------|------|
| Claude Code | `claude` | Anthropic Claude Code CLI |
| Codex CLI | `codex` | OpenAI Codex CLI |
| OpenCode | `opencode` | OpenCode CLI |

커스텀 에이전트 추가 가능. `capabilities_json`, `max_concurrent`, `env_allowlist` 는 매니저 dispatch 추론과 lifecycleService 동시성 게이트에 연결된다. 보안: 허용된 명령어만 실행 가능 (allowlist). `PALANTIR_ALLOWED_COMMANDS` 로 추가 허용.

### 6. Skill Packs (♢)

MCP 서버 템플릿과 스킬 팩 관리. 갤러리 레지스트리 브라우즈, 레지스트리/URL 설치, JSON import/export. 팩은 프로젝트, 태스크, run 에 바인딩 가능.

### 7. Presets (❖)

Worker Preset 관리. 에이전트 프로필 + 플러그인 refs + MCP 서버 템플릿 + 시스템 프롬프트를 재사용 가능한 프리셋으로 묶음. `preferred_preset_id` 로 태스크에 연결. Run Inspector 에서 frozen snapshot vs 현재 preset drift 감사 가능.

## 에이전트 실행 흐름

```
1. Task Board 에서 "In Progress" 로 드래그
   (또는 Task 상세 → Run Agent)
        ↓
2. 에이전트 선택 + 프롬프트 입력 → Start Agent
        ↓
3. Run 생성 (queued → running)
   - tmux 세션에서 에이전트 실행 (tmux 없으면 subprocess fallback)
   - 독립 git worktree 에서 격리 실행
        ↓
4. Dashboard 에서 실시간 모니터링
   - Running / Needs Input / Failed
   - 매 상태 전환이 SSE 시맨틱 envelope(from_status, to_status, reason, task_id, project_id) 로 발행
        ↓
5. 완료 시 Task 자동으로 "Review" 로 이동
        ↓
6. 결과 확인 후 "Done"
```

## Run Inspector

Run 을 클릭하면 열리는 상세 패널:

- **Status** — 현재 상태 (running/needs_input/completed/failed …)
- **Events** — 상태 변경 이력 실시간 표시
- **Send Input** — `needs_input` 상태일 때 에이전트에게 텍스트 전달. 이 호출은 내부적으로 `conversationService.sendMessage('worker:<runId>', ...)` 로 가서 **부모(Top 또는 PM) 에 parent-staleness notice 를 자동 큐잉** 한다 (v3 lock-in #2: 의도 분류 없이 무조건).
- **Cancel** — 실행 중인 Run 취소

## 키보드 단축키

| 키 | 동작 |
|----|------|
| `Cmd+K` / `Ctrl+K` | Command Palette 열기 |
| `N` | 새 Task 생성 (Board 뷰에서) |
| `Esc` | 모달/드로어 닫기 (Drift Drawer 포함) |
| `1-5` | Command Palette 에서 빠른 뷰 전환 |

## 실시간 업데이트 (SSE)

브라우저는 서버와 SSE 연결을 유지한다. 좌측 하단 점: 초록=연결됨, 빨강=연결 끊김 (자동 재연결).

### 이벤트 채널 (v3 시맨틱 envelope)

| 채널 | 의미 | v3 envelope 필드 |
|---|---|---|
| `task:created` / `task:updated` / `task:deleted` | Task 변경 | — |
| `run:created` | 새 run row | — |
| `run:status` | 모든 run 상태 전환 (createRun 초기 방출 포함) | `from_status`, `to_status`, `reason`, `task_id`, `project_id` |
| `run:ended` | 터미널 전환 | 동일 |
| `run:completed` | Health loop 에서 에이전트 exit 감지 | 동일 + `reason='agent-exit-success' \| 'agent-exit-error(N)'` |
| `run:needs_input` | **우선순위 알림** — idle timeout 감지 | 동일 + `priority: 'alert'` |
| `run:event` | 벤더 원본 이벤트 (고volume) | — |
| `manager:started` / `manager:stopped` | Top manager lifecycle | — |
| `dispatch_audit:recorded` | PM 디스패치 claim 감사 기록 (annotate-only) | `audit`, `project_id`, `pm_run_id`, `incoherence_flag`, `incoherence_kind` |

클라이언트 패턴:
- Drift 배지 + drawer 와 `run:needs_input` 의 탭 타이틀 pulse 는 모두 위 envelope 로 구동된다.
- `run:status` 는 순수 reload 트리거로만 쓴다. 우선순위 알림은 dedicated 채널(`run:needs_input`, `run:completed`) 이 전담해서 중복 알림을 방지한다.

## API

REST API 로 외부에서 제어 가능. 인증 설정 시 `Authorization: Bearer <token>` 헤더 필요.

### Projects
```
GET    /api/projects           — 목록
POST   /api/projects           — 생성 { name, directory?, color?, pm_enabled?, preferred_pm_adapter? }
GET    /api/projects/:id       — 조회
PATCH  /api/projects/:id       — 수정
DELETE /api/projects/:id       — 삭제 (pmCleanupService 가 live PM 정리 실패 시 fail-closed 로 abort)
GET    /api/projects/:id/tasks — 프로젝트의 task 목록
GET    /api/projects/:id/brief — project brief 조회
PATCH  /api/projects/:id/brief — 부분 수정 { conventions?, known_pitfalls? }
```

### Tasks
```
GET    /api/tasks              — 목록 (?project_id=, ?status=)
POST   /api/tasks              — 생성 { title, project_id?, priority?, description?, task_kind?, requires_capabilities?, acceptance_criteria? }
GET    /api/tasks/:id          — 조회
PATCH  /api/tasks/:id          — 수정
PATCH  /api/tasks/:id/status   — 상태 변경 { status }
DELETE /api/tasks/:id          — 삭제
PATCH  /api/tasks/reorder      — 순서 변경 { orderedIds: [] }
POST   /api/tasks/:id/execute  — 에이전트 실행 { agent_profile_id, prompt? }
```

### Runs
```
GET    /api/runs               — 목록 (?task_id=, ?status=)
GET    /api/runs/:id           — 조회
GET    /api/runs/:id/events    — 이벤트 목록
GET    /api/runs/:id/output    — 실시간 출력 (tmux)
POST   /api/runs/:id/input     — 입력 전달 { text } (내부적으로 conversationService 경유 → parent-notice 라우터 트리거)
POST   /api/runs/:id/cancel    — 취소
DELETE /api/runs/:id           — 삭제
```

### Agents
```
GET    /api/agents             — 프로필 목록
POST   /api/agents             — 생성 { name, type, command, args_template?, max_concurrent?, capabilities_json?, env_allowlist? }
GET    /api/agents/:id         — 조회 (+ runningCount)
GET    /api/agents/:id/usage   — 이 프로필 provider 기반 usage 스냅샷
PATCH  /api/agents/:id         — 수정
DELETE /api/agents/:id         — 삭제
```

### Manager Session (Top + PM)
```
POST   /api/manager/start                 — Top 매니저 시작 { prompt?, cwd?, model?, agent_profile_id? }
POST   /api/manager/message               — Top 에 메시지 전송 (conversationService 경유)
GET    /api/manager/status                — { active, run, usage, claudeSessionId, top: {...}, pms: [...] }
GET    /api/manager/events                — Top 이벤트 목록 (?after=<id> 증분)
GET    /api/manager/output                — Top 출력 텍스트
POST   /api/manager/stop                  — Top 종료 (해당 runId 의 pending parent-notice 도 함께 정리)
POST   /api/manager/pm/:projectId/message — 필요 시 PM lazy spawn + 메시지 전송
POST   /api/manager/pm/:projectId/reset   — 단일 owner 정리: adapter dispose + run cancel + pm_thread_id clear + registry slot drop
```

### Conversations (1급) — v3 Phase 1.5+
```
GET    /api/conversations/:id           — { conversation: { kind, conversationId, run? } } — id 는 'top' | 'pm:<projectId>' | 'worker:<runId>'
POST   /api/conversations/:id/message   — 메시지 전송 { text, images? }
GET    /api/conversations/:id/events    — 이벤트 (?after=<id> 증분)
```

### Router (v3 Phase 6)
```
POST   /api/router/resolve  — { text, currentConversationId?, defaultConversationId? }
                              → { target, text, matchedRule, ambiguous?, candidates? }
```

### Dispatch Audit (v3 Phase 4 + 7) — annotate-only
```
POST   /api/dispatch-audit  — PM claim 기록 { project_id, task_id?, pm_run_id?, selected_agent_profile_id?, rationale?, pm_claim }
                              → 201 { audit: { ..., incoherence_flag, incoherence_kind } }
GET    /api/dispatch-audit  — 목록 (?project_id=, ?incoherent_only=1, ?limit=<1..500>)
```

지원 `pm_claim.kind`: `task_complete`, `task_in_progress`, `worker_spawned`, `worker_running`, `worker_completed`, `worker_failed`. 모르는 kind 는 `incoherence_flag=0, incoherence_kind='unknown_kind'` 로 저장되어 후속 matcher 확장이 과거 기록을 재작성하지 않도록 한다.

### Legacy / 지원 라우트
```
GET    /api/sessions                    — legacy OpenCode 세션 목록
GET    /api/sessions/:id                — 단일 세션 조회 (메시지 포함)
POST   /api/sessions                    — 새 세션 생성
POST   /api/sessions/:id/message        — 메시지 추가 { content }
PATCH  /api/sessions/:id                — 이름 변경
DELETE /api/sessions/:id                — trash 로 이동

GET    /api/trash/sessions              — 휴지통 세션 목록
POST   /api/trash/sessions/:trashId/restore — 복구
DELETE /api/trash/sessions/:trashId     — 영구 삭제

GET    /api/fs                          — 디렉토리 브라우즈 (?path=)

GET    /api/usage/providers             — provider usage 집계 (Codex / Anthropic / …)
GET    /api/usage/codex-status          — Codex 연결/인증 상태

GET    /api/claude-sessions             — 활성 Claude Code subprocess (Manager + worker) 목록
```

### SSE / Health
```
GET    /api/events  — SSE 스트림
GET    /api/health  — 헬스체크
```

### Worker Presets (Phase 10B)
```
GET    /api/worker-presets             — 목록
POST   /api/worker-presets             — 생성
GET    /api/worker-presets/:id         — 조회
PATCH  /api/worker-presets/:id         — 수정
DELETE /api/worker-presets/:id         — 삭제 (app-level cascade: tasks.preferred_preset_id → NULL)
GET    /api/worker-presets/plugin-refs — 사용 가능한 플러그인 디렉토리
```

### Skill Packs (Phase 10G)
```
GET    /api/skill-packs                — 설치된 목록 (MCP 서버 템플릿)
POST   /api/skill-packs               — 템플릿 생성
GET    /api/skill-packs/:id            — 조회
PATCH  /api/skill-packs/:id            — 수정
DELETE /api/skill-packs/:id            — 삭제
GET    /api/skill-packs/:id/export     — JSON 으로 내보내기
POST   /api/skill-packs/import         — JSON 에서 가져오기
GET    /api/skill-packs/templates      — 템플릿 목록
GET    /api/skill-packs/registry       — 갤러리 레지스트리 브라우즈
GET    /api/skill-packs/registry/pack  — 단일 팩 상세
POST   /api/skill-packs/registry/install     — 레지스트리에서 설치
POST   /api/skill-packs/registry/install-url — URL 에서 설치 (SSRF 방어 경유)
POST   /api/skill-packs/registry/update      — 설치된 팩 업데이트
POST   /api/skill-packs/registry/refresh     — 레지스트리 캐시 갱신
```
Project/Task/Run 바인딩 (`skillPacks.projectBindings` / `taskBindings` / `runSnapshots` 로 mount):
```
GET    /api/projects/:id/skill-packs   — 프로젝트의 skill packs
POST   /api/projects/:id/skill-packs   — 팩 바인딩
PATCH  /api/projects/:id/skill-packs/:packId — 바인딩 수정
DELETE /api/projects/:id/skill-packs/:packId — 바인딩 해제
GET    /api/tasks/:id/skill-packs      — 태스크의 skill packs
POST   /api/tasks/:id/skill-packs      — 팩 바인딩
DELETE /api/tasks/:id/skill-packs/:packId   — 바인딩 해제
GET    /api/runs/:id/skill-packs       — run 의 resolved packs
PATCH  /api/runs/:id/skill-packs/checks — 팩 체크 업데이트
```

> **API 레퍼런스 완결성**: 위 섹션들은 `server/app.js` (Phase 10G merge 시점) 가 mount 하는 모든 라우트를 열거한다. 새 라우트 추가 시 `app.js` 에 mount 하는 동시에 이 섹션에도 추가하지 않으면 이 파일이 서버와 조용히 drift 됨.

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `4177` | 서버 포트 |
| `PALANTIR_TOKEN` | (없음) | Bearer/쿠키 인증 활성화 + 기본 바인딩을 `127.0.0.1` → `0.0.0.0` 으로 승격 |
| `HOST` | 자동 | 바인딩 주소 명시적 오버라이드. 토큰 없이 `0.0.0.0` 이면 경고 로그 |
| `PALANTIR_ALLOWED_COMMANDS` | (없음) | 추가 허용 CLI 명령어 (쉼표 구분) |
| `PALANTIR_DEFAULT_PM_ADAPTER` | `codex` | 프로젝트 preference 미설정 시 전역 PM 어댑터 기본값. Claude preference 도 Phase 3b 전까지는 codex 로 fallback |
| `PALANTIR_CODEX_MANAGER_BYPASS` | (미설정) | `1` 로 설정하면 Codex 매니저 턴이 `--dangerously-bypass-approvals-and-sandbox` 를 붙인다. 기본값은 sandbox 정책 유지 |
| `ANTHROPIC_BASE_URL` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | — | Claude Code 인증 (서버 시작 시 감지되면 `.claude-auth.json` 에 저장) |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | — | Codex 인증 (`~/.codex/auth.json` preflight 체크) |
| `CODEX_BIN` | `codex` | Codex CLI 경로 |
| `CODEX_HOME` | `~/.codex` | Codex config home |
| `OPENCODE_STORAGE` | `~/.local/share/opencode/storage` | OpenCode 세션 저장소 경로 |
| `OPENCODE_BIN` | `opencode` | OpenCode 바이너리 경로 |
| `OPENCODE_FS_ROOT` | `$HOME` | 디렉토리 피커 루트 경로 |

## 기술 스택

- **Backend**: Express.js 5, SQLite (WAL, better-sqlite3), EventEmitter SSE
- **Frontend**: Preact + HTM (ESM + UMD, 빌드 불필요), hash router, self-hosted Inter font
- **Worker 에이전트**: tmux 세션 + git worktree 격리
- **Manager 에이전트**: Claude Code CLI(stream-json NDJSON) 또는 Codex CLI (`codex exec --json` + thread resume). 에이전트 프로필 단위로 선택
- **실시간**: SSE (Server-Sent Events) + `Last-Event-ID` 재생
- **테스트**: Node.js built-in test runner + supertest + Playwright e2e (Phase 10G 머지 시점 792 tests)

## 개발

```bash
npm test     # 전체 테스트
npm run dev  # 개발 서버
```

데이터는 `palantir.db` (SQLite) 에 저장된다. 서버 시작 시 `server/db/migrations/001..019_*.sql` 자동 마이그레이션.

관련 문서:
- `docs/specs/manager-v3-multilayer.md` — v3 재설계 스펙 (lock-in + phase 역사)
- `docs/specs/worker-preset-and-plugin-injection.md` — Phase 10 Worker Preset 스펙
- `docs/specs/skill-packs.md` — Skill Pack 스펙
- `docs/test-scenarios.md` — QA 시나리오 (`PRJ`, `TSK`, `BRD`, `RUN`, `INS`, `MGR`, `PM`, `DRIFT`, `ROUTER`, `SSE`, `REG`, `PRESET`, …)
- `CLAUDE.md` — 프로젝트 컨벤션 + 자율 모드 작업 스타일

## 보안

- `PALANTIR_TOKEN` 미설정 시 기본 `127.0.0.1` 바인딩 (loopback only). 토큰 설정 시 자동 `0.0.0.0` 승격. 토큰 없이 `HOST=0.0.0.0` 시 경고 로그 출력
- 에이전트 명령어는 allowlist 로 제한 (임의 명령 실행 불가)
- tmux 세션에서 에이전트 실행 시 shell injection 방지 (execFileSync + temp script)
- git worktree 로 에이전트 간 파일시스템 격리
- `.claude-auth.json` 은 mode `0o600` + gitignore — 절대 커밋 금지

## 라이선스

ISC
