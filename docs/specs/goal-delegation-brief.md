# Goal Delegation (G 트랙) — 워커 완결 작업 위임 brief

> **상태: DRAFT v2 — Codex R1 NO-GO(BLOCKER 5) 전부 반영. R2 진행 중. 사용자 lock-in 전.**
> 작성: 2026-07-10. 근거: routes/tasks.js, lifecycleService, harvestService, worktreeService, projectMaterializationService, app.js(auto-review), auth.js, migrations 006/014/023/024/048/050/051.

## 1. 문제 정의

현재 워커 위임은 **1회성 채팅**이다:

- `POST /api/tasks/:id/execute` 의 `prompt` 자유텍스트가 그대로 워커 CLI 에 전달된다. `tasks.acceptance_criteria` 는 존재하지만 (migration 006, *"Informational; not enforced"*) 프롬프트에도 검증에도 배선돼 있지 않다.
- 워커의 `completed` 는 프로세스가 에러 없이 종료됐다는 뜻 (Claude: `result.is_error`, codex: exit 0). goal 달성과 무관하고, 기계판독 가능한 자기보고 채널이 없다.
- **completed-but-wrong 은 자동 루프에 안 잡힌다.** B-lite 재시도는 `failed && started_at && retry_count < MAX_RETRY(=1)` 만 커버하고 (lifecycleService run:ended 구독자), 동일 프롬프트를 백지에서 재실행한다.
- 각 attempt 는 백지 시작: harvest 가 worktree 를 무조건 제거하고 retry 는 HEAD 에서 새로 만든다. autosave 브랜치는 남지만 base 로 쓰이지 않는다. **materialized(repo-defined) 경로는 attempt 산출물 ref 조차 cache 에 보존되지 않는다.**
- 유일한 품질 루프는 Operator auto-review (자연어, `AUTO_REVIEW_MAX=5` **in-memory** breaker) — 기계 검증이 사이에 없다.

## 2. 목표 / 비목표

**목표**: 태스크를 "goal 계약"(목표 + 수락 기준 + 검증 방법 + 반복 예산)으로 위임하면, 시스템이 **검증 통과까지 자율 반복**하고 예산 소진/무진전 시에만 에스컬레이션한다.

**비목표**: 워커 CLI 개조 / 태스크 자동 분해·multi-worker orchestration / Operator auto-review 대체 (확장만).

## 3. 설계 원칙

1. **검증은 서버가 (deterministic-first).** 워커 goal report 는 annotate-only. 게이트는 서버가 실행한 검증 결과만.
2. **verdict 는 단일 지점에서 결정·persist 후 전파.** 구독자 race 로 정책이 갈리지 않게, goal verdict 는 harvest 파이프라인 안에서 계산되어 DB 에 persist 된 뒤에야 `run:harvested` 가 emit 된다. 모든 구독자(재시도 드라이버, PM 리뷰)는 persisted verdict 만 읽는다.
3. **재시도 소유자는 하나.** goal-enabled 태스크에서 B-lite 는 비활성 — goal 루프가 failed/unverified 재시도의 단일 소유자.
4. **LLM 이 shell 을 정의하지 못한다.** 검증 명령은 human-defined named check 만. Operator 는 참조만 가능.
5. **Additive + flag-gated** (`PALANTIR_GOAL_MODE`, 기본 off). goal 미설정 태스크는 기존 동작 완전 불변.

## 4. 아키텍처 — 3-Gate + persisted verdict

```
워커 attempt 종료 (run:ended)
  │  goal-enabled: B-lite retry 블록 skip (§5d)
  ▼
harvest 파이프라인 (annotate-only, 단일 순차 소유자)
  autosave → attempt ref 보존(§5e) → diff(base=goal_root_commit)
  → test(기존) → Gate 1 acceptance(named check, stage-local catch)
  → verdict 계산 + persist (runs.goal_verdict, stage-local catch)
  → worktree cleanup (무조건, 순서 불변)
  → run:harvested emit (payload 에 verdict 포함)
  │
  ├─ verdict=retry      → lifecycle 구독자: CAS 재attempt spawn / PM 리뷰 suppressed
  ├─ verdict=gate2      → PM auto-review (Gate 2 의미 판단, 구조화 블록)
  ├─ verdict=exhausted  → task failed + 에스컬레이션 (PM 리뷰 + webhook)
  └─ verdict=error      → PM 리뷰에 에러 노트 (자동 재시도 안 함, fail-safe)
```

- Gate 1 은 LLM 호출 0. 기계적으로 잡히는 미달은 Operator 를 깨우지 않는다.
- Gate 2 는 기존 auto-review 확장 — Gate 1 결과 + goal report 가 구조화되어 들어간다.

### verdict 결정 함수 (pure, deterministic)

`decideGoalVerdict({ status, acceptance, attemptsUsed, budget, nonRetryable, fingerprintRepeat })`:

| 입력 | verdict |
|---|---|
| failed + non-retryable 분류 (materialize fail-closed, corrupt queued_args, preflight 등) | `error` |
| failed (retryable) + 예산 내 | `retry` |
| completed + Gate 1 FAIL + 예산 내 + fingerprint 미반복 | `retry` |
| completed + Gate 1 FAIL + **동일 실패 fingerprint 연속 반복** | `gate2` (reason: `no_progress`) |
| completed + Gate 1 PASS 또는 check 미지정 | `gate2` |
| 예산 소진 (위 retry 조건인데 attemptsUsed ≥ budget) | `exhausted` |
| acceptance/verdict 단계 내부 오류 | `error` |

- fingerprint = `hash(acceptance.exit_code + normalize(output_tail))` — 같은 실패가 두 번 연속이면 재시도 낭비 대신 조기 에스컬레이션 (Codex R1 §OQ3 반영).
- `needs_input` 은 terminal 이 아니고 harvest 대상도 아니다 — goal 루프는 관여하지 않고 기존 `run:needs_input` 알림/webhook 경로가 사람을 부른다. 입력 후 run 이 재개되어 terminal 에 도달하면 그때 verdict 가 돈다.

## 5. 컴포넌트 설계

### 5a. 스키마 (migration N, additive)

```sql
-- named verify checks: human-defined only (§7)
CREATE TABLE project_verify_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,               -- UNIQUE(project_id, name)
  command TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 300000,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

ALTER TABLE tasks ADD COLUMN goal_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN goal_max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tasks ADD COLUMN verify_check_id INTEGER;   -- → project_verify_checks

ALTER TABLE runs ADD COLUMN goal_report TEXT;            -- 워커 자기보고 (annotate-only)
ALTER TABLE runs ADD COLUMN acceptance_json TEXT;        -- Gate 1 결과 스냅샷
ALTER TABLE runs ADD COLUMN goal_verdict TEXT;           -- retry|gate2|exhausted|error
ALTER TABLE runs ADD COLUMN goal_verdict_reason TEXT;
ALTER TABLE runs ADD COLUMN goal_root_commit TEXT;       -- 루프 원점 = diff base 고정
ALTER TABLE runs ADD COLUMN attempt_base_commit TEXT;    -- 이 attempt 의 spawn base
ALTER TABLE runs ADD COLUMN goal_retry_run_id TEXT;      -- CAS: 단일 spawn 보장 (§5d)
```

- 수락 기준 텍스트는 기존 `tasks.acceptance_criteria` 재사용.
- goal 계보 루트는 기존 `retry_root_run_id` 재사용. `goal_root_commit` 은 첫 attempt 에서 기록되어 계보 전체에 복사 — **base branch 가 움직여도 diff/판정 기준 원점이 고정** (Codex R1 SERIOUS 반영, `retry_count` 만으로 예산 표현 금지).

### 5b. 프롬프트 컴파일러

`spawnQueuedRun` 에서 goal-enabled 태스크면 `run.prompt` 를 결정적 템플릿으로 합성:

```
[GOAL] <task.title + description>
[ACCEPTANCE CRITERIA — 전부 충족해야 완료] <task.acceptance_criteria>
<verify check 지정 시: "서버가 종료 후 검증 '<name>' 을 실행한다. 통과해야 완료다.">
[ATTEMPT n/max] <n>1: 피드백 블록 — 이전 diff stat / Gate1 실패 output tail / 이전 goal_report.blockers, 길이 cap>
[호출자 추가 지시] <execute body 의 prompt — append 채널로 보존>
[COMPLETION REPORT] 마지막 응답에 ```palantir-goal-report {goal_status, summary, blockers}``` 포함
```

### 5c. goal report 파서 (공통 모듈)

`services/goalReport.js` — fenced block 파서 단일 구현 (Codex R1 §OQ4):
- 1차: Claude 워커는 `result` 이벤트 텍스트에서 (streamJsonEngine 경유), codex/tmux 워커는 lifecycle 의 final output 캡처에서 파싱 → `runs.goal_report` 저장.
- 2차 fallback: harvest 가 goal_report 부재 시 output tail 재파싱으로 보강.
- 파싱 실패는 run 실패가 아님 (annotate-only). goal_report 는 게이트가 아니라 Gate 2 리뷰 재료.

### 5d. Goal 루프 드라이버 (재시도 단일 소유자, race-free)

**결정과 실행의 분리**:
- **결정**: harvest 파이프라인이 verdict 를 계산·persist (§4). `run:harvested` 이전. → PM auto-review 와 재시도 드라이버가 같은 이벤트를 구독해도 **둘 다 persisted verdict 를 읽으므로 순서 race 로 정책이 갈리지 않는다** (Codex R1 BLOCKER 1 해소).
- **실행**: lifecycleService 의 `run:harvested` 구독자가 verdict=retry 면 재attempt 생성. **CAS 멱등**: `UPDATE runs SET goal_retry_run_id=? WHERE id=? AND goal_retry_run_id IS NULL` 성공 시에만 spawn (claimQueuedRun CAS 선례). 재시작/중복 이벤트에도 단일 spawn.
- **PM 리뷰 suppression 은 persisted verdict 기반**: `verdict === 'retry'` → `pm_review:suppressed` (reason: `goal_retry`). in-memory 상태나 "active retry 존재 여부" 조회에 의존하지 않는다.
- **B-lite 통합**: `run:ended` 의 기존 retry 블록은 goal-enabled 태스크면 skip (task 1회 조회). non-goal 태스크는 B-lite 그대로 (기존 동작 불변). failed 도 harvest 대상이므로 (`isReviewTargetRun` 에 failed 포함) goal 태스크의 failed 재시도는 verdict 경로로 흡수된다.
- **non-retryable 분류**: materialize fail-closed, preflight 실패 (`preset:mcp_invalid`, auth), corrupt `queued_args` 등 인프라성 실패는 verdict=error — 재시도가 무의미한 실패의 루프 낭비 차단 (Codex R1 §OQ5).
- `AUTO_REVIEW_MAX`(in-memory) 는 외곽 2차 안전망으로 유지하되, goal 예산은 **DB 계보 기반** (`retry_root_run_id` 내 `started_at` 있는 run 수) — 서버 재시작에도 예산이 유지된다.

### 5e. Attempt 연속성 (ref 보존 모델)

Codex R1 BLOCKER 2 반영 — "브랜치가 남아있을 것" 전제를 버리고 **명시적 ref 보존**으로:

- **harvest 의 attempt ref 보존 단계** (autosave 직후, goal-enabled 만): repo 에 `git update-ref refs/palantir/attempts/<runId> <worktree tip>` — legacy 는 projectDir, materialized 는 cache repo 에 대해 **해당 run 의 node executor 로** 실행 (diff/test 가 이미 쓰는 경로와 동일 plumbing). 실패해도 stage-local catch (연속성만 포기, harvest 계속).
- **재attempt spawn base**: `refs/palantir/attempts/<prevRunId>` 가 resolve 되면 그것을 base 로 worktree 생성, `runs.attempt_base_commit` 에 기록. resolve 실패 시 기존 base (HEAD / resolved_commit) fallback + 피드백 블록에 "이전 작업분 계승 실패, 백지 시작" 명시.
  - legacy: `createWorktree(projectDir, branch, { baseRef })` 옵션 추가.
  - materialized: `git worktree add -- <path> <attemptRef>` (resolved_commit 대신). `runs.resolved_commit` 은 **root diff base 로 유지** — spawn base 와 diff base 분리 (Codex R1 §OQ2).
- **diff base 고정**: goal-enabled run 의 harvest diff 는 `goal_root_commit` 기준 (getWorktreeDiff base override). 각 attempt 의 diff 가 "루프 전체 산출물"을 일관되게 보여준다.
- **source_generation 변경 가드**: goal 루프 중 repo url/ref 등 source-generation 필드가 바뀌면 계승 중단 — verdict=error + 에스컬레이션 (repo-defined 409 가드와 동일 정신).
- **ref GC**: goal terminal (gate2 done / exhausted / error 후 task terminal) 시 계보의 attempt refs 삭제 (orphan ref 누적 방지).

### 5f. Gate 1 — 기계 검증 (harvest 확장)

- 기존 test 단계(project.test_command) 직후, goal-enabled + `verify_check_id` 지정 시 named check 의 command 를 worktree 에서 실행 → `acceptance_json` persist + `harvest:acceptance` run event.
- **stage-local try/catch — cleanup 은 어떤 경우에도 실행** (기존 위치·순서 불변, Codex R1 BLOCKER 5). acceptance 내부 오류는 `acceptance_json={error}` + verdict=error.
- 실행기·timeout 규율은 test 단계와 동일 (`/bin/sh -c`, output tail cap). materialized 는 run.node_id executor 경유 (원격 포함).
- Gate 1 은 **completed run 에서만** 실행 (test 단계와 동일 조건). failed run 은 acceptance 없이 verdict 로 직행.

### 5g. task status 전이 (goal-aware)

Codex R1 BLOCKER 3 반영 — `checkTaskCompletion` 분기:
- non-goal: 기존 그대로 (하나라도 completed → review, 아니면 failed).
- goal-enabled: run 의 completed 여부가 아니라 **persisted verdict 가 결정** — `retry` → `in_progress` 유지, `gate2` → `review`, `exhausted` → `failed`, `error` → `review` (사람/Operator 판단 필요 노트와 함께). completed-but-Gate1-fail attempt 가 task 를 review 로 오염시키지 않는다.
- 타이밍: goal-enabled 태스크는 `run:ended` 시점의 checkTaskCompletion 을 skip 하고 verdict persist 직후(harvest 내) 전이 — status 가 verdict 보다 먼저 움직이는 창을 없앤다.

### 5h. Gate 2 — Operator 의미 게이트 + 이벤트/UI

- `buildPmReviewText` 구조화 블록: acceptance criteria / Gate 1 결과 (PASS·FAIL·NOT DEFINED·ERROR) / worker goal_report / attempt n/max / verdict reason (`no_progress`, `exhausted` 등). exhausted 는 "예산 소진 — 사용자 에스컬레이션 권고" 문구.
- Operator 의 corrective dispatch 는 기존 `/execute` — goal-enabled 태스크면 그 run 도 컴파일러/루프를 태우고 Operator 지시는 append 채널.
- 신규 run event: `harvest:acceptance`, `goal:verdict` (payload shape 고정, cardinality 규율). `addRunEvent` 는 `run:event` 채널로 UI 에 이미 도달하므로 **신규 SSE 채널은 만들지 않는다** — `useSSE` channels 하드코딩 회귀 여지 자체를 제거 (Codex R1 지적 반영). 대시보드용 집계가 필요해지면 그때 별도 채널 + channels 배열 동시 추가.
- UI: TaskDetailPanel goal 섹션 (기준 / verify check 선택 / attempt 타임라인 = retry 계보 / Gate 1 뱃지 / goal_report). `run_acceptance_checks` 수동 체크 UI 공존.

### 5i. 메모리 레이어 연계 (명시 배선)

Codex R1 SERIOUS 반영 — R1b/R6 캡처는 `harvest:test` 하드코딩이므로 자동으로 안 따라온다:
- G5 에서 `createR1bCapture` 에 `harvest:acceptance` 구독 추가 (FAIL→PASS attempt 쌍 = 고품질 실패→수정 candidate).
- goal_report.blockers 는 R3/R4 재료 (annotate-only 원칙 유지).

## 6. 보안/신뢰 경계

Codex R1 BLOCKER 4 반영 — **v1 부터 named check only**:

- **Operator(LLM) 는 shell 을 정의할 수 없다.** 태스크에는 `verify_check_id` 참조만. check 정의 (`project_verify_checks` CRUD) 는 human 채널 전용:
  - `PALANTIR_PM_TOKEN` 설정 시: cookie actor 만 CRUD 허용 (R4 remember actor split 재사용 — bearer=Operator 거부).
  - PM token 미설정 시: `req.auth.method` 는 보안 경계가 아니라 hint (auth.js 주석 명시) — 이 경우에도 named-check 간접화 덕에 **Operator 프롬프트 인젝션으로는 새 command 를 만들 수 없고**, 기존 human-등록 check 를 잘못 참조하는 것이 최악 (test_command 와 동일 신뢰 수준 유지).
- raw `verify_command` 컬럼은 도입하지 않는다 (v2 에서도 named check 확장으로 감).
- check command 실행 표면은 기존 `project.test_command` 와 동일 (동일 실행기/timeout/output cap) — 신규 권한 상승 없음.

## 7. 페이즈 계획

| PR | 내용 | 리스크 |
|---|---|---|
| G1 | 프롬프트 컴파일러 + goalReport 파서 (1차 저장 + harvest fallback). 루프 없음 | 낮음 |
| G2 | `project_verify_checks` 스키마/CRUD/actor gate + harvest acceptance 단계 + `acceptance_json`/`harvest:acceptance` (verdict 없이 annotate-only) | 낮음~중간 |
| G3 | verdict 함수 + persist + 루프 드라이버 (CAS) + B-lite skip + goal-aware task 전이 + attempt ref 보존/계승 (legacy+materialized) + non-retryable 분류 + fingerprint 조기 에스컬레이션 | **높음** (본체) |
| G4 | Gate 2 리뷰 구조화 + TaskDetail goal UI | 중간 |
| G5 | 메모리 연계 (`harvest:acceptance` → R1b) + flag 기본 on 검토 | 낮음 |

G1+G2 만으로도 가치 (기준이 프롬프트에 들어가고 서버가 검증을 기록 → Operator 리뷰 품질 상승). G3 가 본체이며 테스트 필수 시나리오: failed retry 단일 소유 (B-lite 이중 spawn 없음), completed+Gate1 FAIL suppression, CAS 멱등 (중복 이벤트/재시작), max_concurrent 큐 상호작용, needs_input 비관여, materialized ref 계승 + fallback, cleanup 실패에도 verdict persist, source_generation 변경 가드, fingerprint 조기 종료, memory capture.

## 8. Codex R1 blocker 해소 매핑

| R1 BLOCKER | 해소 |
|---|---|
| 1. run:ended 타이밍 + run:harvested 이중 spawn race | verdict 를 harvest 내 persist 후 emit (§4) + CAS spawn (§5d) + persisted-verdict suppression |
| 2. materialized 계승 전제 오류 | `refs/palantir/attempts/<runId>` 명시 보존 + spawn base/diff base 분리 (§5e) |
| 3. checkTaskCompletion review 오염 | goal-aware 전이 — verdict 가 status 를 결정 (§5g) |
| 4. verify_command 보안 | raw column 폐기, human-defined named check only + PM token actor gate (§6) |
| 5. harvest cleanup 순서/never-throws | acceptance/verdict 전부 stage-local catch, cleanup 위치 불변 (§5f) |
