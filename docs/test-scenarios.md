# Palantir Console — 테스트 사용자 시나리오

> 수동/자동 테스트, QA, 회귀 검증 시 활용하는 핵심 사용자 여정 모음.
>
> 각 시나리오는 **Given (전제) → When (액션) → Then (기대 결과)** 형식.
> "Then"은 코드 내부 동작이 아닌 **관찰 가능한 결과**(DOM, API 응답, DB 상태, 토스트 등)로 작성한다.
> 시나리오 ID prefix: `PRJ`, `TSK`, `BRD`, `RUN`, `INS`, `MGR`, `PM`, `CONV`, `ROUTER`, `DRIFT`, `DSH`, `AGT`, `PRESET`, `KBD`, `SSE`, `AUTH`, `SES`, `TRS`, `FS`, `USG`, `CLS`, `REG`.
>
> *현재 main 기준. v3 Phase 0~10G merged (#20~#32, #60~#64, #65~#71, #85~#94, #99~#111).* Phase 3b 는 트리거 조건 미충족으로 대기. 자세한 phase 히스토리는 `docs/specs/manager-v3-multilayer.md` §15 참조.

---

## 1. Project 관리 (PRJ)

### PRJ-01 — 신규 프로젝트 생성
- **Given** Projects 페이지
- **When** `+ New Project` → name "백엔드 API", directory `/Users/me/api`, color 선택 후 저장
- **Then**
  - 목록에 새 프로젝트가 즉시 나타난다 (200 응답)
  - directory 존재 여부는 **검증하지 않는다** — 잘못된 경로도 저장됨 (현재 동작 기준; 나중에 검증을 추가하면 시나리오 갱신 필요)
  - SSE는 현재 project 변경 이벤트를 발행하지 않음 → 다른 탭은 자동 갱신되지 **않음**

### PRJ-02 — 프로젝트 삭제 시 task detach
- **Given** 프로젝트 P에 task 3개가 연결돼 있다
- **When** API 또는 UI에서 P 삭제 요청
- **Then**
  - 프로젝트가 삭제된다
  - 연결된 task들의 `project_id`가 `NULL`로 detach된다 (`ON DELETE SET NULL`, `001_initial.sql`)
  - task 자체는 삭제되지 않음
- **Note**: 현재 Projects 화면에는 직접 수정/삭제 UI가 없을 수 있음 — API 기준으로 검증

---

## 2. Task 생성 / 상세 (TSK)

### TSK-01 — 신규 Task 생성 (모달)
- **When** Board에서 `+ New Task` 또는 `N` 키 → 제목 "auth bug 수정", 설명, priority `high`, project 선택 후 Create
- **Then** Backlog 컬럼에 카드가 즉시 나타난다

### TSK-02 — Task 상세 패널 열기
- **When** Board의 task 카드 클릭
- **Then** 상세 모달이 열리고 title / description / status / priority / project / runs 목록 표시. ESC로 닫힘 (단 inline edit 중에는 모달이 닫히지 않음)

### TSK-03 — Title inline edit
- **When** 상세 모달에서 title 텍스트 클릭
- **Then**
  - input으로 전환, autoFocus, 기존 height 유지
  - 텍스트 수정 → Enter 또는 blur → PATCH `/api/tasks/:id` 호출 → 저장
  - Esc → 원본 복원, edit 종료
  - 빈 문자열 commit 시 → 원본 유지 (저장하지 않음)
  - **한글 IME 조합 중 Enter는 commit하지 않고 조합만 종료** (`isComposing`/`keyCode 229` 가드)

### TSK-04 — Description inline edit + 긴 본문 height 보존
- **Given** Task에 줄바꿈 포함된 긴 description (예: 20줄)이 있다
- **When** description 영역 클릭
- **Then**
  - textarea로 전환되되 **기존 readonly 영역의 `getBoundingClientRect().height`와 동일하게 표시** (모달이 줄어들거나 스크롤바가 갑자기 생기지 않음)
  - Cmd/Ctrl+Enter 또는 blur → 저장
  - Esc → 원본 복원
  - 빈 description (placeholder "Add a description...")도 클릭 가능

### TSK-05 — 텍스트 드래그 선택 시 edit 진입 차단
- **Given** Task 상세, description은 readonly
- **When** description 위에서 마우스 드래그로 텍스트 선택
- **Then** edit 모드로 전환되지 **않는다**. 드래그 거리 > 4px 또는 `window.getSelection()`에 비어있지 않은 selection이 있으면 click 핸들러가 edit 진입을 거부. 사용자는 정상적으로 텍스트를 선택해 복사 가능

### TSK-06 — Edit 중 다른 필드 클릭 시 hover 정리
- **Given** title이 edit 중
- **When** description 영역 클릭
- **Then**
  - title input의 blur → commit
  - description이 edit 모드로 전환
  - 직전 hover chrome이 잔류하지 않음 (`is-inline-editing` 루트 클래스로 일괄 비활성화)

### TSK-07 — Status / Priority / Project inline 변경
- **When** 상세 모달에서 Status select에서 `in_progress` 선택
- **Then** 즉시 PATCH `/api/tasks/:id/status` 호출, 토스트 없이 반영
- **Priority 변경 시**: 옵션은 `low | medium | high | critical` 만 (이전 코드에 `urgent`가 있었으나 DB CHECK 위반 버그였음 — 수정됨)

### TSK-08 — Task 삭제
- **When** 상세 모달 우하단 Delete
- **Then** confirm 후 DELETE → 모달 닫힘 → 보드에서 즉시 사라짐

---

## 3. Task Board (BRD)

### BRD-01 — 컬럼 간 드래그
- **When** Backlog의 task 카드를 Todo로 드래그
- **Then** PATCH status `todo`. 새로고침해도 유지

### BRD-02 — Todo → In Progress 드래그 시 실행 모달
- **Given** Todo에 task가 있다, agent profile이 1개 이상 등록돼 있다
- **When** Todo → In Progress로 드래그
- **Then**
  - 드롭 시점에는 status를 변경하지 **않는다**
  - Execute 모달이 열린다
  - 사용자가 Execute하면 task status → `in_progress`, run 생성
  - 사용자가 Cancel하면 task status는 **변경 없음** (롤백 개념 없음, 드롭 자체가 상태 전환을 일으키지 않았기 때문)

### BRD-03 — agent profile 0개 상태에서 실행 시도
- **Given** agent profile 0개
- **When** Run Agent 버튼 클릭 또는 In Progress 드롭
- **Then** "Create an agent first" 류의 가이드 표시 또는 모달 내 agent select가 비어있음

### BRD-04 — 필터 (project / priority)
- **When** 상단 필터 드롭다운에서 특정 project 또는 priority 선택
- **Then** 클라이언트 사이드로 즉시 필터링됨

### BRD-05 — Reorder via API (정렬)
- **Given** 같은 컬럼 내 task 다수
- **When** PATCH `/api/tasks/reorder` (현재 boardful drag UI 미구현; API만 존재)
- **Then** sort_order 갱신, 새로고침 후에도 순서 유지
- **Note**: 보드 카드 드래그로 reorder하는 UI는 현재 없음. UI 미구현 시나리오는 API 단위로만 검증

---

## 4. Worker Run 실행 (RUN)

### RUN-01 — Execute 모달에서 에이전트 실행
- **When** Task 상세 → Run Agent → agent 선택 + 프롬프트 + Start Agent
- **Then**
  - task status `in_progress` (이미 그 상태면 유지)
  - Run 생성, queued → running 전환
  - 새 Run의 RunInspector가 자동으로 열림
  - 모달 닫힘

### RUN-02 — 에이전트 spawn 실패 시 task status 롤백
- **When** 잘못된 cwd 또는 spawn 실패
- **Then** task status가 직전 값으로 롤백, 에러 토스트

### RUN-03 — 동일 task에 여러 Run
- **Given** task에 completed run 1개 존재
- **When** Run Agent 다시 실행
- **Then** 새 run 생성, 기존 run history 보존, 상세 패널의 Runs 목록에 둘 다 표시

### RUN-04 — failed/cancelled/stopped → queued 재시도
- **Given** failed 상태 run
- **When** 재시도 (Inspector 또는 API)
- **Then** 동일 run 또는 새 run이 queued로 전환되어 재실행 가능 (`runService` retry 허용 정책)

### RUN-05 — Dashboard에서 failed run dismiss
- **Given** failed run이 Triage Feed에 표시
- **When** dismiss/delete 액션
- **Then** Triage Feed에서 사라짐 (DELETE 또는 hidden flag)

---

## 5. Run Inspector (INS)

### INS-01 — 실시간 출력 스트리밍
- **Given** running 상태 Run
- **When** Inspector 오픈
- **Then** events가 실시간 추가됨. 사용자가 위로 스크롤하면 auto-scroll 멈춤

### INS-02 — needs_input 응답
- **Given** Run이 needs_input
- **When** Send Input에 텍스트 입력 후 전송
- **Then** stdin으로 전달, status가 running으로 복귀, 응답 이벤트 표시
- **Coverage**: `lifecycle.test.js` mock 기반 (idle timeout → needs_input → sendAgentInput → running 복구). LLM 비결정적이므로 live E2E 불가, unit test로 커버

### INS-03 — Run 취소
- **Given** running 상태
- **When** Cancel 버튼
- **Then** SIGTERM 전달, status `cancelled`. 직후 exit 핸들러가 발화해도 `cancelled`를 `failed`로 덮어쓰지 않음 (terminal status guard)

### INS-04 — terminal 상태 Run 재오픈
- **Given** completed/failed/cancelled 상태 Run
- **When** Inspector 오픈
- **Then** 상태 표시, 출력, 이벤트 목록 표시. 입력란/취소 버튼은 비활성/숨김
- **Note**: exit code, cost USD 전용 표시는 현재 UI에 없음 (필요 시 별도 시나리오로 추가)

---

## 6. Manager Session — Top (MGR)

### MGR-01 — Top 매니저 시작 (Claude 어댑터)
- **Given** Manager 세션 없음, `claude-code` 에이전트 프로필 `canAuth=ok`
- **When** Manager 페이지 → 에이전트 드롭다운에서 Claude Code 선택 → Start Manager
- **Then**
  - POST `/api/manager/start` → 201
  - Claude Code subprocess가 stream-json 모드로 spawn (PID 반환)
  - status badge "Active"
  - GET `/api/manager/status` → `{ active: true, run, usage, claudeSessionId, top: { conversationId:'top', run, usage, claudeSessionId }, pms: [] }`
  - **v3 Phase 2**: `status.top` 과 `status.pms[]` 이 shape 에 포함되고 `pms` 는 빈 배열

### MGR-01b — Top 매니저 시작 (Codex 어댑터)
- **Given** Codex 프로필 `canAuth=ok`
- **When** Manager 페이지 → 드롭다운에서 Codex CLI 선택 → Start Manager
- **Then**
  - `codex exec --json -C <cwd>` 가 **한 번** spawn 되어 첫 turn 진행 (stateless)
  - 턴 완료 후 subprocess 는 exit, `/var/folders/.../palantir-codex-run_mgr_*/system_prompt.md` 만 남음 (다음 턴은 resume)
  - status badge "Active", `run.manager_adapter='codex'`, `run.manager_thread_id` 에 vendor thread uuid 기록
  - **Phase 0**: Codex manager 턴은 기본값에서 `--dangerously-bypass-approvals-and-sandbox` 를 **붙이지 않는다**. `PALANTIR_CODEX_MANAGER_BYPASS=1` 환경변수일 때만 붙인다

### MGR-02 — Manager에게 텍스트 메시지 전송
- **Given** Manager 세션 active
- **When** 입력란에 텍스트 입력 후 전송
- **Then**
  - 메시지는 **`POST /api/router/resolve` 를 먼저 거쳐** target 결정 후 `/api/manager/message` 또는 `/api/conversations/:id/message` 로 전달 (v3 Phase 6)
  - `@mention` 이 없고 UI selector 가 Top 이면 target 은 `top`
  - `/api/manager/message` 는 내부적으로 `conversationService.sendMessage('top', ...)` 로 delegate — 기존 응답 shape `{ status:'sent' }` 보존
  - user_input 메시지가 채팅에 표시, `assistant_text` 또는 `mgr.assistant_message` 이벤트가 1개 이상 추가
- **Note**: Manager 가 어떤 API 를 호출하는지는 LLM 판단이라 비결정적

### MGR-03 — 이미지 첨부 메시지 (Claude 어댑터만)
- **Given** Claude Top 세션 active
- **When** 이미지 attach + 텍스트 + 전송
- **Then** content blocks 에 image + text 가 stdin 으로 전달, `image` 타입 user_input 이벤트 기록
- **Note**: Codex 어댑터는 현재 이미지 첨부를 지원하지 않음 (`conversationService.sendToWorker` 와 동일한 text-only 경로)

### MGR-04 — Manager 세션 stop
- **Given** Manager 세션 active
- **When** Stop 클릭 또는 POST `/api/manager/stop`
- **Then**
  - Top adapter 의 `disposeSession` 호출
  - DB run status `cancelled`
  - 직후 exit 핸들러가 발화해도 `cancelled` 를 덮어쓰지 않음 (terminal status guard)
  - `managerRegistry.clearActive('top')` + `onSlotCleared` 리스너가 `conversationService.clearParentNotices(topRunId)` 로 pending queue 정리
  - UI 는 empty state 로 복귀 (Conversation target 드롭다운도 사라짐)

### MGR-05 — Manager가 worker 에이전트 spawn (observable)
- **Given** Manager 세션 active, agent profile 등록됨
- **When** 사용자가 Manager 에게 worker 실행 지시
- **Then** (LLM 이 협조하면)
  - 새 worker run row 가 DB 에 생성됨 (`is_manager=0`)
  - Dashboard 와 Board 에 새 run 표시
  - **Dashboard active 카운트는 worker 만 반영** (`is_manager` 필터)

### MGR-06 — Manager 프로세스 비정상 종료 후 정리
- **Given** Manager 세션이 첫 turn 완료
- **When** Manager 프로세스가 외부 요인으로 exit
- **Then**
  - exit 핸들러가 isManager 케이스를 인식하여 DB status 를 `completed`/`failed` 로 finalize
  - Dashboard 에 stale `running` Manager run 이 남지 않음
  - 직전 status 가 `cancelled`/`stopped`/`completed`/`failed` 인 경우 덮어쓰지 않음

### MGR-07 — Manager 페이지 미방문 상태에서 dashboard 카운트
- **Given** Manager run 이 종료됐고 사용자는 Manager 페이지 미방문
- **When** Dashboard 진입
- **Then** Active 카운트에 Manager run 이 포함되지 않음 (`!is_manager` 필터)

### MGR-08 — 서버 재시작 시 stale manager 정리
- **Given** 서버가 죽기 전 Manager run 이 DB 에 status='running' 으로 남음
- **When** 서버 재시작
- **Then** `routes/manager.js` 의 startup hook 이 stale `is_manager=1` running/queued/needs_input run 들을 모두 `stopped` 로 마킹

### MGR-09 — Conversation target 드롭다운 노출 (v3 Phase 6)
- **Given** Top 매니저 active, 프로젝트 최소 1개 존재 (pm_enabled=1)
- **Then** chat header 에 `Conversation target` 셀렉트가 나타나고 옵션이 `Top manager` + 모든 활성 프로젝트 목록 (`@<projectName>` 또는 `@<projectName> · active`)
- **Note**: Top 이 idle 이면 셀렉트는 노출되지 않음

---

## 6.5. Manager Session — PM 계층 (PM) — v3 Phase 2/3a/6

### PM-01 — Top 없이 PM 메시지 시 409 거절
- **Given** Top 세션 없음, 프로젝트 `alpha` (pm_enabled=1) 존재
- **When** POST `/api/manager/pm/alpha/message` with text
- **Then**
  - 응답 409
  - error message 에 "no active Top manager" 포함
  - `managerRegistry.getActiveRunId('pm:alpha')` 는 여전히 null

### PM-02 — PM lazy spawn 첫 메시지
- **Given** Top 세션 active, 프로젝트 `alpha` (pm_enabled=1) + brief 존재
- **When** UI Conversation target 드롭다운에서 `@alpha` 선택 → 메시지 전송
- **Then**
  - 응답 `{ status:'sent', target:{ kind:'pm', runId, projectId:'alpha' } }`
  - `GET /api/manager/status` → `pms[]` 에 `conversationId='pm:alpha'` 슬롯 1개 등장
  - DB `runs` 테이블에 새 row: `is_manager=1`, `manager_layer='pm'`, `conversation_id='pm:alpha'`, `parent_run_id=<Top run id>`, `manager_adapter='codex'`, `manager_thread_id` 가 non-null (vendor thread uuid)
  - DB `project_briefs` 테이블에서 해당 프로젝트의 `pm_thread_id` 가 non-null 로 채워지고 `pm_adapter='codex'`
  - `GET /api/runs/<newRunId>/events` → 이벤트 시퀀스에 `started`, `mgr.session_started`, `assistant_text`/`mgr.assistant_message`, `mgr.turn_completed` 최소 1개씩 포함. `mgr.usage` 이벤트의 `summaryText` 에 `cached=` 가 0 또는 일부 값으로 등장
  - UI: 드롭다운 옵션이 `@alpha · active` 로 바뀌고, chat header 가 `PM · alpha` + badge `Active`, Reset PM 버튼 가시
- **Note**: 수동 확인 시 `/var/folders/.../palantir-codex-<runId>-*/system_prompt.md` 파일 내용에 `Project Scope`, `Project Conventions`, `Known Pitfalls`, `PM Role`, `Worker Plan Modification`, `Dispatch Audit` 섹션이 모두 포함되어 있어야 함 (PM-10 에서 다룸)

### PM-03 — PM 두 번째 메시지 (thread resume)
- **Given** PM `pm:alpha` 가 이미 spawn 되어 있고 `pm_thread_id` 가 DB 에 있음
- **When** 추가 메시지 전송
- **Then**
  - `pmSpawnService.ensureLivePm` fast-path (probeActive 가 run 반환)
  - Codex subprocess 는 `codex exec resume <thread_id>` 로 spawn → 이전 대화 맥락 유지
  - `cached_input_tokens` 가 non-zero (system prompt 캐시 hit)

### PM-04 — PM lazy spawn 후 서버 재시작 → 다음 메시지에서 thread resume
- **Given** PM 이 한 번 돌고 `project_briefs.alpha.pm_thread_id` 저장됨, 서버 재시작 (run row 는 `stopped` 로 마킹)
- **When** 사용자가 `pm:alpha` 에 메시지 재전송
- **Then**
  - 새 run row 생성되지만 `pmSpawnService` 가 `resumeThreadId` 로 이전 thread id 를 adapter 에 넘김
  - 첫 turn 이 바로 `codex exec resume <persisted_thread_id>` 로 실행
  - `onThreadStarted` callback 은 resume 시 synchronous 로 fire 하지만 `project_briefs` 에 같은 id 를 중복 저장하지 않음

### PM-05 — pm_enabled=0 프로젝트 PM 메시지 거절
- **Given** 프로젝트 `beta` (pm_enabled=0), Top active
- **When** POST `/api/manager/pm/beta/message`
- **Then** 응답 409, error message "PM is disabled for project beta"

### PM-06 — Reset PM (성공 경로)
- **Given** `pm:alpha` 가 active
- **When** UI 의 `Reset PM` 버튼 클릭 → confirm → 또는 API `POST /api/manager/pm/alpha/reset`
- **Then**
  - `pmCleanupService.reset(alpha)` 실행:
    - `liveAdapter.disposeSession(runId)` 호출
    - run row status `cancelled`
    - `managerRegistry.clearActive('pm:alpha')` → `onSlotCleared` fire → `conversationService.clearParentNotices(runId)`
    - `project_briefs.alpha.pm_thread_id` / `pm_adapter` NULL 로 clear
    - Codex `/var/folders/.../palantir-codex-<runId>-*/` tmp dir 자동 삭제
  - 응답 `{ status:'reset', projectId:'alpha', disposed:true, clearedBrief:true, cancelledRunId:<runId> }`
  - UI: `Reset PM` 버튼 사라짐, Conversation target 자동으로 `Top manager` 로 복귀
  - 다음 PM 메시지는 **새 thread** 로 시작 — PM 응답: "아까 대화를 직접 기억하진 못해요" 류

### PM-07 — Reset PM fail-closed (dispose 실패)
- **Given** PM active, 어댑터의 `disposeSession` 이 의도적으로 throw
- **When** `POST /api/manager/pm/alpha/reset`
- **Then**
  - 응답 502, error code 포함
  - `managerRegistry` 슬롯 **유지** (cleared 안 됨)
  - `project_briefs.pm_thread_id` **유지**
  - run row status **유지** (cancelled 아님)
  - 재시도 가능 — 어댑터를 정상화하고 다시 호출하면 end-to-end 성공

### PM-08 — DELETE /api/projects/:id cascade (v3 Phase 3a)
- **Given** `pm:alpha` 가 active, 프로젝트 `alpha` 삭제 시도
- **When** `DELETE /api/projects/alpha`
- **Then**
  - **BEFORE** projectService.deleteProject: `pmCleanupService.dispose(alpha)` 실행 (Codex 어댑터 dispose, registry slot clear, brief cascade 로 삭제)
  - dispose 가 throw 하면 route 는 502 `pm_dispose_failed` 반환하고 **project row 는 삭제하지 않음**
  - dispose 성공 시 projectService.deleteProject 실행, `project_briefs` 는 SQLite FK cascade 로 삭제

### PM-09 — 멀티 PM 동시 활성
- **Given** Top active + `pm:alpha` active
- **When** Top 탭에서 `@beta 간단 인사` 입력 후 전송
- **Then**
  - `/api/router/resolve` 가 `target=pm:beta` 로 rewrite
  - beta PM lazy spawn (alpha 와 **다른** run id + vendor thread id)
  - `status.pms[]` 에 alpha 와 beta 둘 다 등장 + UI 드롭다운에서 `@alpha · active` + `@beta · active`
  - Conversation target 자동으로 `pm:beta` 로 follow

### PM-10 — `pm_run_id` 는 system prompt 에서 self-reference 가능
- **Given** `pm:alpha` spawn 직후
- **When** `model_instructions_file` 내용 확인
- **Then**
  - `## Project Scope` 섹션에 `pm_run_id: run_mgr_<...>` 라인 존재 — 이 PM 의 실제 run id 값
  - `## PM Role` 섹션에 "use the pm_run_id value shown above" 지시어 존재
  - PM 이 이 값을 읽고 `POST /api/dispatch-audit` 의 `pm_run_id` envelope 필드에 사용할 수 있음

---

## 6.6. Conversation identity / parent-notice router (CONV) — v3 Phase 1.5/2

### CONV-01 — `/api/conversations/:id` 해석
- **When** `GET /api/conversations/top` (활성 Top 없음)
- **Then** 200 `{ conversation: { kind:'top', conversationId:'top', run: null } }`
- **When** `GET /api/conversations/worker:run_xyz` (해당 run 존재)
- **Then** 200 `{ conversation: { kind:'worker', conversationId:'worker:run_xyz', run: <row> } }`
- **When** `GET /api/conversations/bogus`
- **Then** 400

### CONV-02 — 잘못된 conversation id 로 메시지 전송
- **When** `POST /api/conversations/worker:run_nonexistent/message { text:'hi' }`
- **Then** 404 "worker run not found"

### CONV-03 — worker 직접 메시지 → Top 에 staleness notice 전달 (Phase 1.5)
- **Given** Top active (Top run id `T1`), worker run `W` 의 `parent_run_id = T1`
- **When** `POST /api/runs/W/input { text:'방향 바꿔' }` (또는 `POST /api/conversations/worker:W/message`)
- **Then**
  - 응답: `/api/runs/W/input` 은 `{ status:'ok', delivery:{ status:'sent', target } }` (legacy 호환 shape), `/api/conversations/worker:W/message` 는 `{ status:'sent', target:{ kind:'worker', runId:'W' } }`
  - Worker 프로세스의 `/api/runs/W/events` 에 새 `user_input` 이벤트 1개 추가
  - 직후 Top 에 일반 메시지 하나 (`POST /api/manager/message { text:'상태?' }`) 를 보낸다
  - Top 의 다음 턴 `GET /api/conversations/top/events` 에서 최신 `mgr.assistant_message` 응답 또는 `mgr.tool_call_finished` 가 `worker:W` / `run_id W` 를 언급하거나 해당 worker run 상태를 curl 로 재조회하는 행동을 보인다 (notice 가 prepend 되었음을 LLM 행동으로 확인. Codex 어댑터 live smoke 에서 이 패턴을 확인한 이력 있음)
- **Note**: LLM 응답 행동 기반 검증이 부담스럽다면 fake adapter 테스트 (`server/tests/conversation.test.js` 의 Phase 2 케이스들) 로 대체 — adapter.calls[0].payload.text 에 `[system notice]` 가 prepend 되는지 직접 assert

### CONV-04 — worker 직접 메시지 → PM 에 staleness notice 전달 (Phase 2)
- **Given** PM `pm:alpha` active (`pmRun`), worker run `W` 의 `parent_run_id = pmRun.id`, Top 도 active
- **When** `POST /api/runs/W/input { text:'X' }`
- **Then**
  - worker 의 `/api/runs/W/events` 에 `user_input` 추가
  - 직후 Top 에 일반 메시지 전송 → Top 응답에는 `worker:W` 언급 없음 (Top 큐는 empty)
  - 직후 PM 에 일반 메시지 전송 → PM 의 다음 `mgr.assistant_message` 에서 worker:W 의 상태를 언급하거나 curl 로 재조회하는 행동
- **Note**: 동일하게 `server/tests/conversation.test.js` 의 Phase 2 PM parent-notice 케이스로 대체 가능

### CONV-05 — PM 메시지 → Top 에 staleness notice 전달 (Phase 2)
- **Given** Top 과 PM `pm:alpha` 둘 다 active
- **When** 사용자가 `pm:alpha` 에 메시지 전송
- **Then**
  - PM 응답은 정상 반환 (`GET /api/conversations/pm:alpha/events` 에 `mgr.assistant_message` 추가)
  - 직후 Top 에 `"상태 공유"` 같은 일반 메시지 전송 → Top 의 다음 턴에서 PM 을 curl 로 재조회하거나 PM 언급 포함 응답 (Phase 6 smoke 에서 재현된 행동)
- **Note**: 자동화는 Phase 2 fake-adapter 테스트 (`conversation.test.js`) 로 커버. 실제 LLM 행동 smoke 는 수동 검증 대상

### CONV-06 — Stale parent notice drop (historical parent)
- **Given** Old Top `T_old` stop 됨, new Top `T_new` 시작 (다른 run id). worker `W` 의 `parent_run_id = T_old`
- **When** worker `W` 에 직접 메시지
- **Then**
  - Worker 에는 정상 전달 (`/api/runs/W/events` 에 user_input 추가)
  - 직후 `T_new` 에 일반 메시지 → 응답에 worker:W 를 언급하거나 재조회하지 **않음** (새 Top 은 notice 를 받지 않았음)
- **Note**: fake-adapter 테스트가 이 drop 시나리오를 직접 assert — adapter.runTurn payload 에 `[system notice]` 없음

### CONV-07 — Peek-then-drain race safety (Phase 2 R1)
- **Given** worker → Top 으로 두 번 연속 직접 메시지 (`notice A`, `notice B`)
- **When**
  - 첫 번째 Top 메시지 전송 시점에 runTurn 중간에 `notice B` 가 추가 push 된다 (strict fake adapter 에서 runTurn hook 으로 재현 가능)
- **Then**
  - 첫 번째 Top 응답 content 에는 `notice A` 의 worker 텍스트만 참조
  - 두 번째 Top 메시지 응답에는 `notice B` 의 worker 텍스트가 참조됨 (큐에서 유지되어 다음 턴에 prepend)
- **Note**: 자동 검증은 `server/tests/conversation.test.js` 의 "race-safe drain" 테스트 (strict fake adapter)

### CONV-08 — PM slot rotation 시 이전 run 의 notice 가 새 run 에 새지 않음 (Phase 2 R2)
- **Given** `pm:alpha` run `A` 에 worker→PM 경로로 notice 1개 queued
- **When** 사용자가 `POST /api/manager/pm/alpha/reset` 으로 A 를 종료하고, 다음 메시지로 새 PM run `B` 가 spawn
- **Then**
  - B 의 첫 `mgr.assistant_message` 응답에는 `A` 에 보냈던 worker 메시지 내용이 언급되지 않음
  - 즉, 이전 run 의 대기 notice 가 새 run 에 흘러들지 않음
- **Note**: fake-adapter 테스트가 `registry.setActive` 교체 시 adapter.runTurn payload 에 이전 notice 가 포함되지 않는지 직접 assert

---

## 6.7. Router (ROUTER) — v3 Phase 6

### ROUTER-01 — @mention 명시 prefix rewrite
- **Given** 프로젝트 `alpha` (pm_enabled=1)
- **When** `POST /api/router/resolve { text:"@alpha 상태" }`
- **Then** `{ target:'pm:<alphaId>', text:'상태', matchedRule:'1_explicit' }` — prefix 가 stripped

### ROUTER-02 — @mention 은 case-insensitive + project id 매칭
- **Given** 프로젝트 name 이 `Alpha`, id 가 `proj_abc`
- **When** `POST /api/router/resolve { text:"@ALPHA hi" }` 또는 `{ text:"@proj_abc hi" }`
- **Then** 둘 다 `target='pm:proj_abc'`

### ROUTER-03 — pm_enabled=0 → rule 1 fall-through
- **Given** 프로젝트 `alpha` 이 pm_enabled=0
- **When** `POST /api/router/resolve { text:"@alpha hi", currentConversationId:"top" }`
- **Then** `{ target:'top', matchedRule:'2_current' }` (mention 무시됨)

### ROUTER-04 — 현재 conversation id 가 wins
- **Given** 프로젝트 `alpha` pm_enabled=1
- **When** `POST /api/router/resolve { text:"alpha 관련", currentConversationId:"pm:<alphaId>" }`
- **Then** `{ target:'pm:<alphaId>', matchedRule:'2_current', text:"alpha 관련" }` (mention 아닌 토큰은 rewrite 안 함)

### ROUTER-05 — 현재 컨텍스트 없을 때 name fuzzy match
- **Given** 프로젝트 `alpha` + `beta`
- **When** `POST /api/router/resolve { text:"please check alpha status" }` (currentConversationId 없음)
- **Then** `{ target:'pm:<alphaId>', matchedRule:'3_namematch' }`

### ROUTER-06 — 다중 매칭 = ambiguous + default 로 fall-through
- **When** `POST /api/router/resolve { text:"alpha vs beta which one?" }` (currentConversationId 없음)
- **Then** `{ target:'top', matchedRule:'3_namematch', ambiguous:true, candidates:[{projectId,name}, ...] }`. UI 는 toast 로 사용자에게 알림.

### ROUTER-07 — 모두 실패 → default
- **When** `POST /api/router/resolve { text:"그냥 안녕" }`
- **Then** `{ target:'top', matchedRule:'4_default' }`

### ROUTER-08 — HTTP 400 on missing text
- **When** `POST /api/router/resolve {}` (text 누락)
- **Then** 400

### ROUTER-09 — UI @mention 실패 fail-closed (Phase 6 R1)
- **Given** 서버가 `/api/router/resolve` 에 네트워크 오류 반환
- **When** 사용자가 UI 에서 `@beta 메시지` 를 현재 `pm:alpha` 탭에서 전송
- **Then**
  - 라우터 실패 catch → `hasExplicitMention === true` → 전송 **취소**
  - input 영역에 텍스트와 이미지 원복 (사용자 유실 방지)
  - 에러 토스트 "라우터 해석 실패 — @mention 이 포함된 메시지는 전송 취소됩니다"
  - alpha 에도 beta 에도 메시지 전달되지 않음

### ROUTER-10 — @mention 없는 메시지는 fall-through 허용
- **Given** 동일 상황 (라우터 실패)
- **When** `@` 없는 일반 텍스트 전송
- **Then** 현재 UI 선택 (pm:alpha) 대상으로 정상 전달 (no rewrite intent 이므로 안전)

---

## 6.8. Dispatch audit (DRIFT) — v3 Phase 4/7

### DRIFT-01 — coherent task_complete claim
- **Given** task T 가 DB 에서 `status=done`
- **When** `POST /api/dispatch-audit { project_id, pm_claim:{kind:'task_complete', task_id:T} }`
- **Then** 201, audit row `incoherence_flag=0`, `incoherence_kind=null`

### DRIFT-02 — 허위 task_complete = pm_hallucination
- **Given** task T 가 `status=in_progress`
- **When** `POST /api/dispatch-audit { project_id, pm_claim:{kind:'task_complete', task_id:T} }`
- **Then** 201, `incoherence_flag=1`, `incoherence_kind='pm_hallucination'`, `db_truth={task_id,status:'in_progress'}`

### DRIFT-03 — worker_* claim 이 manager run 을 가리키면 reject
- **Given** T 와 상관없이 manager run id M
- **When** `POST /api/dispatch-audit { project_id, pm_claim:{kind:'worker_running', run_id:M} }`
- **Then** 400 (envelope binding — "is a manager run, not a worker run")

### DRIFT-04 — envelope 크로스프로젝트 거절
- **Given** project A 의 task T_A, project B 환경에서 호출
- **When** `POST /api/dispatch-audit { project_id:B, pm_claim:{kind:'task_complete', task_id:T_A} }`
- **Then** 400 "task T_A belongs to project A, not B"

### DRIFT-05 — envelope pm_run_id 바인딩 (Phase 4 R4)
- **When** `POST /api/dispatch-audit { project_id:P, pm_run_id:<Top run id>, pm_claim:... }`
- **Then** 400 "pm_run_id is layer='top', expected 'pm'"
- 다른 프로젝트의 PM run id 를 보내면 400 "belongs to pm:X, not pm:P"
- 존재하지 않는 id → 400 "pm_run_id not found"
- worker run id → 400 "is not a manager run"

### DRIFT-06 — selected_agent_profile_id 검증 (Phase 4 R5)
- **When** `POST /api/dispatch-audit { project_id:P, selected_agent_profile_id:'nonexistent', pm_claim:... }`
- **Then** 400 "selected_agent_profile_id not found"

### DRIFT-07 — user_intervention_stale 탐지
- **Given** PM `pm:alpha` (`pmRunId`) active. 사용자가 직전에 해당 PM 또는 PM 산하 worker 에 직접 메시지를 보냈고, PM 은 아직 다음 턴을 실행하지 않았다 (CONV-04 / CONV-05 이후 상태)
- **When** PM 이 (또는 테스트가 직접) `POST /api/dispatch-audit { project_id, pm_run_id, pm_claim:<coherent by DB truth> }` 호출
- **Then** 응답 audit row 의 `incoherence_flag=1`, `incoherence_kind='user_intervention_stale'` — claim 자체는 DB 와 일치하지만 PM 이 아직 최신 사용자 개입을 소화하지 못한 상태를 표시
- **Note**: 자동 검증은 `server/tests/reconciliation.test.js` 에 fake `conversationService` 를 주입해 peek 결과를 시뮬레이션하는 방식으로 구현됨 (실제 검증은 `pmRunId` 가 큐 소지 여부에 따라 flag 결과가 달라지는 것)

### DRIFT-08 — pm_hallucination 이 user_intervention_stale 보다 우선
- **Given** 동일 상황에서 claim 자체도 DB truth 와 불일치
- **Then** 두 조건 모두 충족해도 `kind='pm_hallucination'` (더 informative)

### DRIFT-09 — annotate-only: recordClaim 은 절대 block 하지 않음
- **Given** 어떤 이상한 claim (예: `worker_completed` for run that never existed)
- **Then** 201 반환 + `incoherence_flag=1` — 절대 500/400 throw 로 막지 않음 (envelope binding 실패 400 만 예외)

### DRIFT-10 — GET 목록 필터
- **When** `GET /api/dispatch-audit?project_id=P&incoherent_only=1&limit=10`
- **Then** 응답 `{ audit: [...] }` — 해당 프로젝트의 incoherent row 만, limit 적용

### DRIFT-11 — SSE live push (Phase 7)
- **Given** SSE 연결 open, 클라가 `useDispatchAudit` 또는 수동으로 `dispatch_audit:recorded` listener 등록
- **When** 서버에서 `POST /api/dispatch-audit` 성공
- **Then** SSE 이벤트 `dispatch_audit:recorded` 가 발생하고 payload 는 `{ audit:<row>, project_id, pm_run_id, incoherence_flag, incoherence_kind }`
- **Note**: eventBus.emit 실패해도 `recordClaim` 은 정상 완료 (annotate-only 불변: emit try/catch)

### DRIFT-12 — Dashboard Drift 배지 노출
- **Given** 프로젝트 어느 것이든 `incoherence_flag=1` 인 audit row 가 존재하고 사용자가 dismiss 하지 않음
- **When** Dashboard 진입
- **Then** stats bar 에 `N Drift ⚠` stat-chip 이 나타난다. 0 이면 배지 숨김

### DRIFT-13 — DriftDrawer 오픈 + row 렌더링
- **When** 배지 클릭
- **Then**
  - 우측 슬라이드 drawer open
  - 각 row 는 incoherence_kind 색상 bar + project name + timeAgo + Dismiss 버튼
  - PM claim / DB truth 가 좌우 `<pre>` diff 로 렌더링
  - pm_run_id / rationale 메타 존재 시 추가 표시

### DRIFT-14 — Dismiss 는 클라 로컬
- **When** 특정 row 의 Dismiss 버튼 클릭
- **Then**
  - drawer 에서 해당 row 사라짐
  - badge 총 count 감소
  - localStorage `palantir.drift.dismissed.v1` 에 row id 추가
  - 페이지 refresh 후에도 hidden 유지
  - **서버 row 는 무손상** (`GET /api/dispatch-audit?incoherent_only=1` 은 여전히 해당 row 반환)

### DRIFT-15 — "Restore N dismissed" 복원
- **Given** 1개 이상 dismiss 된 상태
- **Then** drawer header 에 `Restore N dismissed` 버튼 자동 노출
- **When** 클릭
- **Then** localStorage set 비워짐, 모든 row 복원

### DRIFT-16 — ManagerChat per-PM 배지
- **Given** `pm:alpha` 가 UI 에서 선택되어 있고 해당 프로젝트에 incoherent row 가 있음
- **Then** chat header 에 `⚠ N` 버튼 (Reset PM 옆) 노출, 같은 DriftDrawer 를 연다. N 이 0 이 되면 버튼 자동 사라짐

### DRIFT-17 — Esc 로 DriftDrawer 닫기
- **Given** DriftDrawer open
- **When** `Esc` 키
- **Then** drawer close. 다른 modal 도 열려 있으면 우선순위 기존 순서 유지 (Palette > DriftDrawer > RunInspector)

### DRIFT-18 — useDispatchAudit race fence (Phase 7 R1)
- **Given** drawer 열린 상태에서 poll/SSE/수동 reload 가 빠르게 연달아 호출됨
- **Then** `requestSeqRef` 모노토닉 토큰으로 가장 최신 응답만 commit. 역순으로 도착한 오래된 응답은 버려짐. 표시되는 rows 는 절대 역전되지 않음

---

## 7. Dashboard 트리아지 (DSH)

### DSH-01 — All clear
- **Given** running/needs_input/failed/review 모두 0
- **Then** "All clear. No items need attention." empty state

### DSH-02 — 우선순위 정렬
- **Given** needs_input 1개, failed 2개, running 3개, review 1개
- **Then** Triage Feed가 needs_input → failed → running → review 순

### DSH-03 — 카드 클릭 → Run Inspector
- **When** Triage 카드 클릭
- **Then** 해당 Run Inspector 오픈

### DSH-04 — Done Today 카운트
- **Given** 오늘 completed run 5개, 어제 10개
- **Then** "Done Today: 5"

---

## 8. Agent Profile (AGT)

### AGT-01 — 신규 프로필 생성
- **When** Agents → New Agent → name, command `claude`, args `-p {prompt}`, max concurrent 3
- **Then** 목록에 표시. command가 allowlist에 없으면 거절

### AGT-02 — 프로필 사용 현황
- **Then** GET `/api/agents/:id`가 `runningCount`를 반환 (UI 표시 여부는 별도)

### AGT-03 — 프로필 삭제
- **When** DELETE `/api/agents/:id`
- **Then** 항상 허용됨 (삭제 가드 없음 — 진행 중 run에서 사용 중이어도 삭제됨)
- **Note**: 가드를 추가하면 시나리오 갱신 필요

---

## 8b. Worker Preset (PRESET) — v3 Phase 10

> Spec: `docs/specs/worker-preset-and-plugin-injection.md`. Plugin 디렉토리는 `server/plugins/<name>/` (gitignored, 운영자 배치). CI fixture 는 `server/tests/fixtures/plugins/agent-olympus-mock/`.

### PRESET-01 — Preset 생성 (UI)
- **Given** `#presets` 페이지, `server/plugins/agent-olympus/` 가 디스크에 있음
- **When** "+ New Preset" → name `Olympus Iso`, isolated 토글 ON, plugin_refs 에서 `agent-olympus` 체크, base_system_prompt 입력, Save
- **Then**
  - 201 응답, 목록에 카드 추가
  - 카드에 "Isolated (Tier 2)" 배지
  - 새로고침해도 유지

### PRESET-02 — 잘못된 plugin_ref 차단
- **When** plugin_refs 에 `nonexistent` (디렉토리 없음) 으로 POST `/api/worker-presets`
- **Then** 400 + `Unknown plugin ref: 'nonexistent'`

### PRESET-03 — 16KB 프롬프트 차단
- **When** base_system_prompt 16,385 byte UTF-8 입력 후 Save
- **Then** UI 가 Save 비활성 (byte counter 빨강) + 서버 400

### PRESET-04 — Preset 수정
- **When** 카드 Edit → description 변경 → Save
- **Then** 200, 같은 카드 갱신. `updated_at` 진행

### PRESET-05 — Preset 삭제 cascade
- **Given** Task T1 의 `preferred_preset_id = preset.id`
- **When** Preset 삭제
- **Then**
  - 200, 카드 사라짐
  - `tasks.preferred_preset_id` 가 NULL 로 cascade
  - 과거 run snapshot (`run_preset_snapshots`) 은 보존 (preset_id 텍스트 그대로)

### PRESET-06 — Task 기본 preset 지정
- **Given** Preset P 존재
- **When** Task PATCH `{ preferred_preset_id: P.id }`
- **Then** ExecuteModal 다음 오픈 시 Worker Preset 드롭다운이 P 로 prefill

### PRESET-07 — ExecuteModal preset 오버라이드
- **Given** Task T 의 default preset = A, Preset B 도 존재
- **When** Execute → 드롭다운에서 B 선택 → Run
- **Then**
  - POST `/execute` body 에 `preset_id: B.id`
  - 모달 안에 "Task default is `<A.id>`" 힌트 표시 (Phase 10E)
  - 새 Run 의 `runs.preset_id = B.id`

### PRESET-08 — Tier 1 (non-Claude) MCP 주입
- **Given** Codex 워커 + preset (mcp_server_ids: [`tpl_ctx7`])
- **When** Execute
- **Then**
  - spawn args 에 `-c mcp_servers={"ctx7":...}` prepend
  - run_events 에 `preset:tier2_skipped` 없음 (isolated=false)
  - DB `runs.mcp_config_snapshot` 에 ctx7 포함

### PRESET-09 — OpenCode MCP 미지원 graceful degrade
- **Given** OpenCode 워커 + preset (mcp_server_ids 보유)
- **When** Execute
- **Then** spawn args 에 `-c` 없음, run_events 에 `preset:mcp_unsupported` 1건

### PRESET-10 — Tier 2 (Claude isolated) wiring
- **Given** Claude 워커 + preset `{ isolated: true, plugin_refs: ['agent-olympus'] }`, 인증 가능
- **When** Execute
- **Then**
  - spawn args 에 `--bare --strict-mcp-config --setting-sources '' --plugin-dir <abs>` 포함
  - `--settings <temp-path>` 추가 (apiKeyHelper materialization)
  - run_events: `preset:tier2_active` + `preset:auth_sources` (sources 배열)
  - 워커 종료 시 temp 디렉토리 자동 정리 (onCleanup)

### PRESET-11 — Tier 2 fail-closed (auth 없음)
- **Given** isolated preset, 환경에 `ANTHROPIC_API_KEY` / `.claude-auth.json` / keychain 모두 부재
- **When** Execute
- **Then** 400 `Isolated preset requires Claude auth`, run 은 `failed`, spawn 미발생

### PRESET-12 — `min_claude_version` mismatch
- **Given** preset.min_claude_version = `2.0.0`, 호스트 `claude --version` 이 1.8.5
- **When** Execute (Claude 워커)
- **Then** 400 `Preset requires Claude CLI >= 2.0.0`, run `failed` + `preset:version_mismatch` 이벤트

### PRESET-13 — Snapshot 즉시 persist
- **When** preset 으로 Run 생성
- **Then** `run_preset_snapshots` row 가 spawn 직전 (resolveForSpawn 직후) 에 INSERT.
  - `runs.preset_id` + `runs.preset_snapshot_hash` 도 같은 시점 binding
  - 파일 hash 는 `<pluginRef>/<relpath>` 네임스페이스 (예: `agent-olympus/skills/foo.md`)

### PRESET-14 — RunInspector "Preset" 탭
- **Given** preset 으로 실행된 run
- **When** RunInspector 열기
- **Then**
  - "Preset" 탭이 보임 (`currentRun.preset_id` 가 있을 때만)
  - 클릭 시 GET `/api/runs/:id/preset-snapshot` 호출, snapshot vs current side-by-side
  - drift 없음 → 초록 배너 "Preset matches the snapshot"

### PRESET-15 — Drift 감지 (preset edit 후)
- **Given** PRESET-14 의 run, 이후 preset 의 description 수정
- **When** RunInspector → Preset 탭 재오픈
- **Then**
  - 노랑 배너 "Preset drift detected. Changed fields: description"
  - 탭 라벨에 `⚠ 1` 배지

> **Note**: Legacy runs created before Phase D may not detect description drift (old snapshot_json rows do not include description; intentionally not backfilled for forensic integrity).

### PRESET-15b — Drift 감지 (plugin 파일 수정 후)
- **Given** PRESET-14 의 run, 이후 preset 에 연결된 plugin 디렉토리의 파일 1개 내용 수정
- **When** RunInspector → Preset 탭 재오픈
- **Then**
  - 노랑 배너 "Preset drift detected." + changed_files 목록
  - 수정된 파일: `agent-olympus/main.ts` — status: `modified`
  - 탭 라벨 배지: `⚠ 1` (changed_fields 0 + changed_files 1)
  - `has_drift: true`

### PRESET-15c — Drift 감지 (plugin 파일 삭제/추가 후)
- **Given** PRESET-14 의 run, 이후 plugin 파일 1개 삭제 + 1개 추가
- **When** RunInspector → Preset 탭 재오픈
- **Then**
  - changed_files 에 `deleted` 1건 + `added` 1건
  - 탭 배지: `⚠ 2`
  - `has_drift: true`

### PRESET-15d — Drift 없음 (파일 무변경)
- **Given** PRESET-14 의 run, preset 내용/파일 모두 동일
- **When** RunInspector → Preset 탭
- **Then**
  - `has_drift: false`, `changed_files: []`, 초록 배너
  - 탭 배지 없음

### PRESET-16 — Drift 감지 (preset 삭제 후)
- **Given** PRESET-14 의 run, 이후 preset DELETE
- **When** RunInspector → Preset 탭
- **Then**
  - 빨강 배너 "preset has been deleted since this run"
  - "Current preset" 패널 = `(deleted)`
  - snapshot.core / file_hashes 는 그대로 노출 (포렌식 데이터 보존)

### PRESET-17 — Preset 미사용 run 의 Preset 탭
- **Given** preset 없이 실행된 run
- **When** RunInspector
- **Then** "Preset" 탭 자체가 렌더되지 않음

### PRESET-18 — `/api/worker-presets/plugin-refs`
- **Given** `server/plugins/` 에 plugin.json 가진 디렉토리 2개 (a, b), plugin.json 없는 디렉토리 1개
- **When** GET `/api/worker-presets/plugin-refs`
- **Then** `plugin_refs: [{name:'a',...}, {name:'b',...}]` (a, b 만, 정렬됨)

---

## 9. 키보드 단축키 (KBD)

### KBD-01 — Cmd+K Command Palette
- **When** `Cmd+K` / `Ctrl+K`
- **Then** Command Palette 오픈

### KBD-02 — N 키로 Task 생성
- **Given** Board 뷰
- **When** `N` 키 (input 포커스 아닌 상태)
- **Then** New Task 모달 오픈

### KBD-03 — Esc로 모달 닫기
- **Given** 어떤 모달이 열려 있다
- **When** `Esc` 키
- **Then** 모달 닫힘. **단** Task 상세에서 inline edit 중인 경우 Esc는 edit 취소만 하고 모달은 유지

### KBD-04 — Command Palette에서 숫자키로 빠른 뷰 전환
- **Given** Command Palette 열림
- **When** 숫자키 1~N (N = `NAV_ITEMS.length`, 현재 7)
- **Then** NAV_ITEMS 순서대로 해당 뷰로 전환 (1=Dashboard, 2=Manager, 3=Task Board, 4=Projects, 5=Agents, 6=Skill Packs, 7=Presets — `NAV_ITEMS.length`만큼 매핑). 숫자키는 검색 query 가 비어있을 때만 동작 (타이핑 충돌 방지)

---

## 10. 실시간 업데이트 (SSE)

### SSE-01 — Task/Run 변경 시 다른 탭 자동 반영
- **Given** 동일 서버에 두 브라우저 탭 연결
- **When** 한 탭에서 task 생성 또는 run 상태 변경
- **Then** 다른 탭의 Board/Dashboard에 즉시 반영
- **Note**: project 변경에 대한 SSE 는 현재 없음 — task/run/dispatch_audit 만 보장

### SSE-02 — 연결 끊김 표시
- **When** 서버 재시작 또는 네트워크 끊김
- **Then** 좌측 하단 점이 빨강. 자동 재연결 시 초록 복귀

### SSE-03 — needs_input 브라우저 알림 + 탭 타이틀 pulse (v3 Phase 5)
- **Given** 알림 권한 허용, 탭 unfocused
- **When** 백그라운드 탭에서 run 이 `needs_input` 으로 전환 (idle timeout)
- **Then**
  - OS 알림 표시
  - 탭 타이틀이 `⚠ Needs input` 으로 변경 (`pulseTabTitle` 20 초 또는 focus 시점까지)
  - focus 시 원래 title 자동 복원
- **Note**: 이 경로는 `useSSE` channels 배열에 `run:needs_input` 이 포함되어 있어야 작동. Phase 7 에서 이 채널 누락 회귀가 발견되어 수정됨 (REG-09 참조)

### SSE-04 — run:status semantic envelope (v3 Phase 5)
- **Given** run 상태 전환 (queued→running 또는 running→completed 등)
- **When** 클라가 `run:status` 이벤트 수신
- **Then** event.data 는 다음 필드를 모두 포함:
  - `run` — 전체 run row (pre-Phase 5 호환)
  - `from_status` (string 또는 null) — 이전 상태
  - `to_status` (string) — 새 상태
  - `reason` (string 또는 null) — 이유 (`started`, `created`, `idle_timeout`, `agent-exit-success`, `agent-exit-error(N)` 등)
  - `task_id` (string 또는 null) — hoisted
  - `project_id` (string 또는 null) — hoisted

### SSE-05 — `createRun` 도 정규화된 envelope 를 발행 (Phase 5 R1)
- **Given** `runService.createRun` 호출
- **Then** `run:status` 이벤트 한 개가 즉시 발행되며 payload 는 `{ run, from_status:null, to_status:'queued', reason:'created', task_id, project_id }`
- **Note**: 이 R1 fix 전에는 `createRun` 만 bare `{ run }` 을 발행해서 같은 채널에 두 shape 가 섞여 있었다

### SSE-06 — dispatch_audit:recorded 라이브 푸시 (v3 Phase 7)
- **Given** 클라가 `useDispatchAudit` hook 으로 SSE 구독
- **When** `POST /api/dispatch-audit` 성공
- **Then** `dispatch_audit:recorded` 이벤트 수신 → debouncedReload 로 audit list 갱신. drawer open 중이면 rows 가 즉시 prepend 되고 badge count 증가

### SSE-07 — priority alert 중복 방지 (Phase 5 R3)
- **Given** idle timeout 발생 → 서버가 `run:status` (to_status=needs_input) + `run:needs_input` 두 이벤트를 발행
- **When** 클라가 둘 다 수신
- **Then** OS 알림 + 탭 타이틀 pulse 는 **정확히 한 번** (dedicated `run:needs_input` 핸들러가 전담). `run:status` 핸들러는 순수 reload 만 수행하고 알림을 발생시키지 않음

---

## 11. 인증 / 보안 (AUTH)

### AUTH-01 — 토큰 미설정 모드
- **Given** `PALANTIR_TOKEN` 미설정, `HOST` 환경변수 미설정
- **When** 서버 시작
- **Then**
  - 서버는 **`127.0.0.1`에 바인딩** (loopback 전용 — PR1 binding policy)
  - `PALANTIR_TOKEN` 설정 시 자동으로 `0.0.0.0` 승격, `HOST=` 명시 시 해당 값 사용
  - 모든 API에 인증 미적용 (next 통과)
  - 시작 시 `[security] No PALANTIR_TOKEN set — auth disabled.` 로그 출력

### AUTH-02 — 토큰 설정 모드 (Bearer + Cookie)
- **Given** `PALANTIR_TOKEN=secret`
- **When** API 호출
- **Then**
  - `Authorization: Bearer secret` 헤더 없거나 잘못 → 403
  - 헤더 일치 → 정상 응답
  - **Cookie 인증**: `palantir_token=secret` HttpOnly 쿠키로도 인증 가능 (EventSource SSE 는 커스텀 헤더 전송 불가 → Bearer 만으로는 SSE 가 구조적으로 막히기 때문)
  - Bearer 헤더가 존재하지만 잘못된 경우 → Cookie 로 fallback 하지 **않음** (명시적 실패, request-smuggling 방지)
  - **`?token=secret` 쿼리 파라미터 인증은 지원하지 않음** (access-log leak 방지)
  - 비교는 timing-safe (`crypto.timingSafeEqual`) — Bearer / Cookie 양쪽 모두

### AUTH-03 — Manager start 시 cwd 가드
- **Given** Manager start 요청
- **When** cwd가 home 또는 server cwd 하위가 아닌 경로 (`/etc`, `/var`, `/usr` 등)
- **Then** 400 BadRequest
- **Note**: worker run execute 요청에는 cwd 가드가 별도로 없음 — agent profile의 command/args allowlist로 제한

### AUTH-04 — 명령어 allowlist
- **Given** agent profile 생성
- **When** command가 allowlist에 없음 (`rm` 등)
- **Then** 거절. 기본 allowlist + `PALANTIR_ALLOWED_COMMANDS` 환경변수만 허용

---

## 12. Sessions (SES) — legacy session UI

### SES-01 — 세션 목록 조회
- **When** `GET /api/sessions`
- **Then** 저장된 OpenCode 세션 목록 반환 (`sessions[]`)

### SES-02 — 세션 메시지 전송
- **When** `POST /api/sessions/:id/message` with body `{ content }`
- **Then** 해당 세션의 cwd 기반으로 OpenCode CLI 에 메시지 큐잉 → 202/200 반환
- **Note**: 요청 body 는 `{ content }` (문자열). `text` 가 아님 — `server/routes/sessions.js` 참조

### SES-03 — 세션 rename / delete
- **When** `PATCH /api/sessions/:id` body `{ title }` 또는 `DELETE /api/sessions/:id`
- **Then**
  - PATCH: `title` 이 없거나 string 아니면 400 "title is required". 성공 시 `{ session }` 반환, 새 title 로 목록에 표시
  - DELETE: 세션이 휴지통으로 이동 (영구 삭제 아님 — 영구 삭제는 TRS-03)
- **Note**: body 필드는 `title` (단일 필드). 예전 `name` / `directory` 계약은 현재 서버가 지원하지 않음

---

## 13. Trash (TRS)

### TRS-01 — Trash 세션 목록 조회
- **When** `GET /api/trash/sessions`
- **Then** 응답 `{ items }` 배열 (각 항목에 `trashId` 포함 — `server/routes/trash.js:8`)
- **Note**: 마운트 prefix 는 `/api/trash/sessions` (단일 `/api/trash` 아님). 응답 키도 `items` 이며 `sessions` 가 아니다. Task/Project 휴지통은 현재 없음

### TRS-02 — Session restore
- **When** `POST /api/trash/sessions/:trashId/restore`
- **Then** 원래 위치로 복구, Sessions 목록에 다시 표시

### TRS-03 — Permanent delete
- **When** `DELETE /api/trash/sessions/:trashId`
- **Then** 파일시스템에서 영구 삭제, restore 불가

---

## 14. File System Browser (FS)

### FS-01 — Directory browse
- **When** GET `/api/fs?path=/Users/me`
- **Then** 디렉토리 목록 반환

### FS-02 — 디렉토리 브라우저 (상위 이동 + hidden 토글)
- **When** 디렉토리 브라우저 UI에서 상위 폴더 이동 또는 showHidden 토글 클릭
- **Then** UI 컴포넌트가 상위 폴더 이동, hidden 파일 표시 토글 지원

### FS-03 — Root guard
- **When** `/etc`, `/var` 등 시스템 경로 조회 시도
- **Then** 거절 또는 빈 결과

---

## 15. Usage (USG)

### USG-01 — Usage providers 조회
- **When** `GET /api/usage/providers`
- **Then** Codex / Anthropic / (기타 provider) 별 usage 반환. 각 provider 실패 시 fallback 또는 error entry 포함
- **Note**: 엔드포인트는 `/api/usage/providers` (단일 `/api/usage` 아님)

### USG-02 — Codex status 조회
- **When** `GET /api/usage/codex-status`
- **Then** Codex CLI 연결/인증 상태 반환 (타임아웃 시 error 필드)

### USG-03 — Usage 모달 표시
- **When** UI에서 usage 모달 오픈
- **Then** provider 별 입력/출력 토큰, 비용 표시. 미설정 provider 는 "not configured" 표시

---

## 16. Claude Sessions (CLS)

### CLS-01 — 활성 Claude session 조회
- **When** GET `/api/claude-sessions`
- **Then** Claude Code subprocess (Manager 포함) 목록 반환

### CLS-02 — Dashboard에서 Active Claude Sessions 표시
- **Given** Manager 또는 Worker가 Claude session으로 동작 중
- **When** Dashboard 화면 로드
- **Then** Dashboard에 "Active Claude Sessions (n)" 카운트 + 세션 목록 표시 (`/api/claude-sessions` detail endpoint 사용)

---

## 17. 회귀 방지 (REG)

> 이전 버그 수정의 회귀를 막기 위한 최소 시나리오.

### REG-01 — Dashboard에 Manager run이 stale로 남지 않음
- 관련: `streamJsonEngine.js` exit 핸들러 fix, `DashboardView` filter
- Manager 시작 → 첫 turn 응답 → Manager 프로세스 강제 종료 → Dashboard 진입 → Active 카운트 0

### REG-02 — Stop 후 status overwrite 방지
- Manager/Worker run을 사용자가 Stop → DB status `cancelled` → 직후 exit 핸들러 발화 → status가 `failed`로 바뀌지 **않음**

### REG-03 — Inline edit 드래그 선택 회귀
- TSK-05 동일. 드래그 선택 시 절대 edit 진입 안 됨

### REG-04 — Inline edit IME 회귀
- TSK-03 IME 부분. 한글 조합 중 Enter가 commit으로 새지 않음

### REG-05 — 긴 description 클릭 시 height shrink 회귀
- TSK-04. 긴 본문 클릭 → textarea의 height가 readonly와 동일

### REG-06 — 서버 재시작 시 stale manager 정리
- MGR-08 동일. 서버 재시작 후 stale `is_manager=1` running run이 자동으로 `stopped`로 마킹

### REG-07 — Todo→In Progress 모달 취소 시 status unchanged
- BRD-02 동일. 드롭이 status를 미리 바꾸지 않으므로 Cancel 시 별도 롤백 불필요. 회귀 방지 차원에서 명시

### REG-08 — Task priority inline edit `critical` 저장 가능
- 이전 버그: TaskDetailPanel inline priority select가 `urgent`를 보냈으나 DB CHECK는 `critical`만 허용 → PATCH 실패
- 수정: `PRIORITY_OPTIONS`(`['low','medium','high','critical']`) 사용으로 통일
- 회귀 검증: inline priority를 `critical`로 변경 → 200 응답 + DB에 반영됨

### REG-09 — useSSE channels 배열에 신규 채널 subscribe 누락 방지 (Phase 7 발견)
- **이전 버그**: `server/public/app/lib/hooks/sse.js` (P8-4 이전: `hooks.js`) `useSSE` 의 `channels` 배열이 hard-coded 되어 있어, Phase 5 에서 추가한 `run:needs_input` 과 Phase 7 에서 추가한 `dispatch_audit:recorded` 가 subscribe 되지 않아 App() 의 handler 가 dead code 상태였음
- **회귀 검증**:
  - `run:needs_input`: idle timeout 발생 시 클라에서 OS 알림 + 탭 타이틀 pulse 가 실제로 동작 (SSE-03)
  - `dispatch_audit:recorded`: `POST /api/dispatch-audit` 후 2초 이내에 클라의 drift badge 가 갱신 (DRIFT-11)
- **코드 가드**: `useSSE` 의 channels 배열은 수동 관리 (`server/public/app/lib/hooks/sse.js`). 새 SSE 채널 추가 시 반드시 이 배열에도 추가. CLAUDE.md "Things to Watch Out For" 에 경고 등록

### REG-10 — PM 단일-turn 가드 (Codex stateless) (Phase 3a R1)
- **이전 설계**: `pmSpawnService` 가 brief 을 **seed runTurn** 으로 PM 에 넣었고, `conversationService` 가 곧바로 사용자 메시지로 두 번째 runTurn 호출 → Codex 어댑터의 `currentChild` 가드가 "previous turn still running" throw
- **수정**: brief 은 정적 system prompt (`model_instructions_file`) 에 bake. pmSpawnService 는 **runTurn 을 호출하지 않음**
- **회귀 검증**: strict fake adapter (2nd runTurn 시 throw) 로 PM 첫 메시지 전송 → accept 확인

### REG-11 — pmCleanupService fail-closed (Phase 3a R2)
- **이전 설계**: `_terminate` 내부가 `disposeSession` 의 throw 를 log 만 하고 swallow → `/reset` 과 `DELETE /api/projects/:id` 가 실제로 false success 반환, in-memory PM 상태는 stranding
- **수정**: dispose 실패 시 상태 변경 **전에** re-throw. 호출자 (route) 가 502 로 거절. 재시도 시 깨끗한 end-to-end 성공
- **회귀 검증**: regression test `'pmCleanupService.reset rethrows disposeSession failures and leaves state intact'` (pm-phase3a.test.js)

### REG-12 — useConversation / useDispatchAudit stale async fence (Phase 6 R2~R4, Phase 7 R1)
- **이전 설계**: `useConversation.resolve()` / `loadEvents()` / `sendMessage()` 가 await 전 `conversationId` capture 없이 setRun/setEvents/setLoading 호출. id 변경 시 이전 fetch 의 늦은 응답이 새 id 의 state 를 덮어씀
- **수정**: `myId = conversationId` 캡처 + commit 전 `activeIdRef.current === myId` 확인. id 변경 effect 에서 setRun(null)/setEvents([])/setLoading(false) 동기 리셋
- **추가**: `useDispatchAudit.reload()` 도 동일 race 패턴 — `requestSeqRef` 모노토닉 토큰으로 fence (Phase 7 R1)
- **회귀 검증**: PM A → PM B 전환 직후 Reset PM 버튼이 이전 PM 의 상태로 발화되지 않음 (코드 리뷰)

### REG-13 — dispatch audit envelope forgeability (Phase 4 R1~R6)
- **이전 버그**: `recordClaim` 이 envelope 의 task_id / pm_run_id / selected_agent_profile_id 존재·소유 검증 없이 그대로 저장. cross-project claim / foreign PM run id / 가짜 agent profile id 등 다양한 forgery 경로 가능
- **수정**: `bindEnvelopeToClaim` strict 검증 — project 존재 + task/run 존재 + project 소유 + envelope.task_id ↔ pm_claim.task_id 일치 + pm_run_id 는 `is_manager=1 && manager_layer='pm' && conversation_id === 'pm:<projectId>'` + selected_agent_profile_id 존재
- **회귀 검증**: reconciliation.test.js 의 R1~R5 regression tests

### REG-14 — esc 로 DriftDrawer 닫기 (Phase 7 R1)
- **이전 버그**: App() 의 global keydown useEffect deps 배열에 `showDriftDrawer` 가 빠져 있어 handler closure 가 stale → drawer 의 Esc 닫기 분기가 발동하지 않음
- **수정**: deps 배열에 `showDriftDrawer` 추가
- **회귀 검증**: drawer 열고 Esc 키 → 닫힘

### REG-15 — DashboardView self-bridge 원칙 위반 (P8-1)
- **이전 버그**: `DashboardView.js` 가 `window.dueState/formatDueDate/useNowTick/dueDateMeta` 를 자체 bridge — "bridge 는 main.js 에서만" 원칙 위반
- **수정**: 4줄 self-bridge 제거, `main.js` 에서 static import + bridge
- **회귀 검증**: DashboardView 의 due date 표시, TaskDetailPanel 의 bare identifier 참조 모두 정상

### REG-16 — app.js ESM 전환 시 import 경로 (P8-2)
- **이전 상태**: `app.js` 가 classic script 로 window global 참조. `main.js` 가 `document.createElement('script')` 로 로드
- **수정**: ESM `import` 문으로 전환, `main.js` 에서 `await import('../app.js')`. vendor 경로: `./vendor/*.module.js`, lib 경로: `./app/lib/*.js`, component 경로: `./app/components/*.js`
- **회귀 검증**: boot.smoke.test.js 의 ESM import 패턴 검증 + 전체 테스트 green

### REG-17 — useManager 제거 후 compat 객체 shape (P8-3)
- **이전 상태**: `useManager()` 가 lifecycle + conversation 을 한 훅에서 처리
- **수정**: `useManagerLifecycle()` (start/stop/status) + `useConversation('top')` (events/sendMessage) 로 분리, App() 에서 `useMemo` 로 compat 객체 합성
- **회귀 검증**: ManagerView `{ status, events, loading, start, sendMessage, stop }` destructure 정상, DashboardView `manager.status.active` 정상

---

## 사용 가이드

### 수동 QA
- 새 기능 머지 전, 영향 영역의 시나리오 ID를 PR 설명에 적고 직접 클릭/검증
- 회귀 시나리오(`REG-*`)는 항상 회귀 테스트 전에 우선 실행

### 자동화 권장 매핑
- **supertest + node:test**:
  - Core: `PRJ`, `TSK` API, `RUN` 상태머신, `AUTH`, `MGR-04/06/07/08`, `TRS`, `FS`, `USG`, `CLS`, `SES`
  - v3: `CONV-01~08`, `PM-01/05/06/07/08`, `ROUTER-01~08`, `DRIFT-01~11`, `SSE-04~07` — fake adapter 주입 + 임시 SQLite 로 전부 커버
  - 실제 테스트 파일 매핑:
    - `CONV-*` → `server/tests/conversation.test.js`
    - `PM-*` → `server/tests/pm-phase3a.test.js`
    - `ROUTER-*` → `server/tests/router.test.js`
    - `DRIFT-*` → `server/tests/reconciliation.test.js`
    - `SSE-04~07` → `server/tests/phase5-sse-semantics.test.js`
- **Playwright (격리 포트 4188 + 임시 DB 권장, prod 4177 금지)**:
  - 기존: `TSK-03~07`, `BRD-02/04`, `INS-01~03`, `KBD`, `SSE-02`, sessions/trash/dir picker UI
  - v3: `MGR-09` (드롭다운 노출), `PM-02/06/09` (실제 Codex CLI 경유 lazy spawn / Reset / 멀티 PM), `DRIFT-12~17` (badge, drawer, per-PM, dismiss/restore, Esc), `ROUTER-09/10` (UI 라우터 fail-closed)
- **자동화 부적합 (LLM 의존)**:
  - `MGR-02` (Top 응답 내용)
  - `MGR-05` (LLM 이 실제로 worker 를 spawn 하는지)
  - `PM-03/04` 의 "이전 대화 맥락 유지" / "아까 얘기 기억나?" 검증 (LLM 응답 내용 기반)
  - 가능하면 stub/fake adapter 로 대체. CI 에서는 실제 codex/claude subprocess 금지.

### v3 Live smoke 체크리스트
Phase 2/3a/6/7 merge 시점에 실제 Codex adapter 경유로 수행한 end-to-end smoke:
- Phase 3a: 10 step (prod untouched)
- Phase 6: 8 step + UI selector/reset
- Phase 7: 6 step + SSE live push + 회귀 (useSSE channels)
전부 격리 포트 4188 + 임시 DB + prod 4177 무손상 원칙. 새 phase 작업 시 동일한 격리 규칙 준수.

### 시나리오 수정/추가 규칙
- 새 기능 추가 시 해당 영역에 시나리오 1~3개 추가
- 버그 수정 시 `REG` 섹션에 회귀 방지 시나리오 추가, ID 순차 증가
- "Then"은 **observable** (DOM/API/DB/log)으로 작성. "내부적으로 어떤 함수 호출"은 금지
- placeholder("현재 정책 명확화 필요" 등)는 추가 시 즉시 코드/문서로 확인 후 채울 것
