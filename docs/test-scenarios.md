# Palantir Console — 테스트 사용자 시나리오

> 수동/자동 테스트, QA, 회귀 검증 시 활용하는 핵심 사용자 여정 모음.
>
> 각 시나리오는 **Given (전제) → When (액션) → Then (기대 결과)** 형식.
> "Then"은 코드 내부 동작이 아닌 **관찰 가능한 결과**(DOM, API 응답, DB 상태, 토스트 등)로 작성한다.
> 시나리오 ID prefix: `PRJ`, `TSK`, `BRD`, `RUN`, `INS`, `MGR`, `DSH`, `AGT`, `KBD`, `SSE`, `AUTH`, `SES`, `TRS`, `FS`, `USG`, `CLS`, `REG`.
>
> *코덱스 교차검증 1차 완료. 모든 시나리오는 현재 코드 (main 브랜치) 기준.*

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

## 6. Manager Session (MGR)

### MGR-01 — Manager 세션 시작
- **Given** Manager 세션 없음
- **When** Manager 페이지 → Start Manager
- **Then**
  - POST `/api/manager/start` → 201
  - Claude Code subprocess가 stream-json 모드로 spawn (PID 반환)
  - status badge "Active"
  - GET `/api/manager/status` → `{ active: true, run, usage, claudeSessionId }`
- **Note**: init 메타정보(모델/세션 ID)는 채팅 영역에 직접 렌더링되지 않음. status API로만 노출

### MGR-02 — Manager에게 텍스트 메시지 전송
- **Given** Manager 세션 active
- **When** 입력란에 텍스트 입력 후 전송
- **Then**
  - POST `/api/manager/message` → `{ status: 'sent' }`
  - user_input 메시지가 채팅에 표시
  - GET `/api/manager/events`로 polling 시 `assistant_text` 또는 `tool_use` 이벤트가 1개 이상 추가됨
  - assistant 메시지가 markdown으로 렌더링됨
- **Note**: Manager가 내부적으로 어떤 API를 호출하는지는 LLM 판단이라 비결정적. 자동화는 "이벤트 추가"라는 observable 결과로 검증

### MGR-03 — 이미지 첨부 메시지
- **Given** Manager 세션 active
- **When** 이미지 파일 attach + 텍스트 + 전송
- **Then** content blocks에 image + text가 stdin으로 전달, `image` 타입 user_input 이벤트 기록

### MGR-04 — Manager 세션 stop
- **Given** Manager 세션 active
- **When** Stop 클릭 또는 POST `/api/manager/stop`
- **Then**
  - SIGTERM 전달
  - DB run status `cancelled`
  - 직후 exit 핸들러가 발화해도 `cancelled`를 덮어쓰지 않음 (terminal status guard)
  - UI는 empty state로 복귀

### MGR-05 — Manager가 worker 에이전트 spawn (observable)
- **Given** Manager 세션 active, agent profile 등록됨
- **When** 사용자가 Manager에게 worker 실행 지시
- **Then** (LLM이 협조하면)
  - 새 worker run row가 DB에 생성됨 (`is_manager=0`)
  - Dashboard와 Board에 새 run 표시
  - **Dashboard active 카운트는 worker만 반영** (`is_manager` 필터)
- **Note**: LLM이 거부하거나 다른 도구 선택 시 시나리오는 신뢰할 수 없음. 통합 테스트에서는 stub agent profile 권장

### MGR-06 — Manager 프로세스 비정상 종료 후 정리
- **Given** Manager 세션이 첫 turn 완료 (proc.result 세팅됨)
- **When** Manager 프로세스가 외부 요인으로 exit
- **Then**
  - exit 핸들러가 isManager 케이스를 인식하여 DB status를 `completed`/`failed`로 finalize (`streamJsonEngine.js`의 fix)
  - Dashboard에 stale `running` Manager run이 남지 않음
  - 직전 status가 `cancelled`/`stopped`/`completed`/`failed`인 경우 덮어쓰지 않음

### MGR-07 — Manager 페이지 미방문 상태에서 dashboard 카운트
- **Given** Manager run이 종료됐고 사용자는 Manager 페이지 미방문
- **When** Dashboard 진입
- **Then** Active 카운트에 Manager run이 포함되지 **않는다** (`DashboardView`가 `!is_manager` 필터)

### MGR-08 — 서버 재시작 시 stale manager 정리 (startup recovery)
- **Given** 서버가 죽기 전 Manager run이 DB에 status='running'으로 남음
- **When** 서버 재시작
- **Then** `routes/manager.js`의 startup hook이 stale `is_manager=1` running/queued/needs_input run들을 모두 `stopped`로 마킹

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
- **When** 숫자키 1~5
- **Then** NAV_ITEMS 순서대로 해당 뷰로 전환 (1=Dashboard, 2=Manager, 3=Task Board, 4=Projects, 5=Agents — `NAV_ITEMS.length`만큼 매핑)

---

## 10. 실시간 업데이트 (SSE)

### SSE-01 — Task/Run 변경 시 다른 탭 자동 반영
- **Given** 동일 서버에 두 브라우저 탭 연결
- **When** 한 탭에서 task 생성 또는 run 상태 변경
- **Then** 다른 탭의 Board/Dashboard에 즉시 반영
- **Note**: project 변경에 대한 SSE는 현재 없음 — task/run만 보장

### SSE-02 — 연결 끊김 표시
- **When** 서버 재시작 또는 네트워크 끊김
- **Then** 좌측 하단 점이 빨강. 자동 재연결 시 초록 복귀

### SSE-03 — needs_input 브라우저 알림
- **Given** 알림 권한 허용
- **When** 백그라운드 탭에서 run이 needs_input으로 전환
- **Then** OS 알림 표시, 클릭 시 해당 Run Inspector

---

## 11. 인증 / 보안 (AUTH)

### AUTH-01 — 토큰 미설정 모드
- **Given** `PALANTIR_TOKEN` 미설정
- **When** 서버 시작
- **Then**
  - 서버는 **항상 `0.0.0.0`에 바인딩** (localhost 전용 아님)
  - 모든 API에 인증 미적용 (next 통과)
  - 시작 시 `[security] WARNING: No PALANTIR_TOKEN set` 로그 출력

### AUTH-02 — 토큰 설정 모드
- **Given** `PALANTIR_TOKEN=secret`
- **When** API 호출
- **Then**
  - `Authorization: Bearer secret` 헤더 없거나 잘못 → 403
  - 헤더 일치 → 정상 응답
  - **`?token=secret` 쿼리 파라미터 인증은 현재 지원하지 않음** (Bearer 헤더만)
  - 비교는 timing-safe (`crypto.timingSafeEqual`)

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
- **When** GET `/api/sessions`
- **Then** 저장된 세션 목록 반환

### SES-02 — 세션 메시지 전송
- **When** POST `/api/sessions/:id/message` with text
- **Then** opencode/codex/claude provider 분기에 따라 메시지 dispatch

### SES-03 — 세션 rename / delete
- **When** PATCH/DELETE `/api/sessions/:id`
- **Then** UI와 DB 둘 다 반영

---

## 13. Trash (TRS)

### TRS-01 — Trash 목록 조회
- **When** GET `/api/trash`
- **Then** 삭제된 task/project 목록 반환

### TRS-02 — Restore
- **When** POST `/api/trash/:id/restore`
- **Then** 원래 위치로 복구, Board/Projects에 다시 표시

### TRS-03 — Permanent delete
- **When** DELETE `/api/trash/:id`
- **Then** DB에서 영구 삭제, restore 불가

---

## 14. File System Browser (FS)

### FS-01 — Directory browse
- **When** GET `/api/fs?path=/Users/me`
- **Then** 디렉토리 목록 반환

### FS-02 — Up 한 단계 / hidden 파일 토글
- **Then** UI 컴포넌트가 상위 폴더 이동, hidden 파일 표시 토글 지원

### FS-03 — Root guard
- **When** `/etc`, `/var` 등 시스템 경로 조회 시도
- **Then** 거절 또는 빈 결과

---

## 15. Usage (USG)

### USG-01 — Usage providers 조회
- **When** GET `/api/usage`
- **Then** Codex / Anthropic / Gemini provider별 usage 반환. 각 provider 실패 시 fallback 또는 error entry 포함

### USG-02 — Usage 모달 표시
- **When** UI에서 usage 모달 오픈
- **Then** provider별 입력/출력 토큰, 비용 표시. 미설정 provider는 "not configured" 표시

---

## 16. Claude Sessions (CLS)

### CLS-01 — 활성 Claude session 조회
- **When** GET `/api/claude-sessions`
- **Then** Claude Code subprocess (Manager 포함) 목록 반환

### CLS-02 — Dashboard에서 Active Claude Sessions 표시
- **Given** Manager 또는 Worker가 Claude session으로 동작 중
- **Then** Dashboard에 "Active Claude Sessions (n)" 카운트 표시

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

---

## 사용 가이드

### 수동 QA
- 새 기능 머지 전, 영향 영역의 시나리오 ID를 PR 설명에 적고 직접 클릭/검증
- 회귀 시나리오(`REG-*`)는 항상 회귀 테스트 전에 우선 실행

### 자동화 권장 매핑
- **supertest + node:test**: `PRJ`, `TSK` API, `RUN` 상태머신, `AUTH`, `MGR-04/06/07/08`, `TRS`, `FS`, `USG`, `CLS`, `SES` (서비스가 stub 가능한 경우)
- **Playwright**: `TSK-03~07`, `BRD-02/04`, `INS-01~03`, `KBD`, `SSE-02`, sessions/trash/dir picker UI
- **자동화 부적합 (LLM 의존)**: `MGR-02`, `MGR-05`. 가능하면 stub agent profile 또는 mock provider로 대체

### 시나리오 수정/추가 규칙
- 새 기능 추가 시 해당 영역에 시나리오 1~3개 추가
- 버그 수정 시 `REG` 섹션에 회귀 방지 시나리오 추가, ID 순차 증가
- "Then"은 **observable** (DOM/API/DB/log)으로 작성. "내부적으로 어떤 함수 호출"은 금지
- placeholder("현재 정책 명확화 필요" 등)는 추가 시 즉시 코드/문서로 확인 후 채울 것
