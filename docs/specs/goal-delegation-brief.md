# Goal Delegation (G 트랙) — 워커 완결 작업 위임 brief

> **상태: Codex 6R 적대리뷰 완료 — v4 core R4 GO + v6 일반화 레이어 R6 GO. 사용자 lock-in 대기.**
> 리뷰 이력: R1 NO-GO(B5) → R2 NO-GO(B4+S5) → R3 NO-GO(B1+S6+M1) → R4 **GO** (code 전용 core) → [워크로드 전제 교정: 전 업무] → R5 NO-GO(B4+S5+M2) → R6 **GO** (일반화 레이어).
> **v5~v6 개정 사유**: 이 시스템의 워크로드는 코딩만이 아니라 사람이 하는 모든 업무 (리서치/문서/분석/운영) 이고 단위는 프로젝트가 아니라 Operator 다 (P-B folder-less specialist, Operator-중심 UI). v4 는 Gate 1·연속성·전달이 전부 git 에 결박 — 비코드 업무에 불충분. v6 은 R5 의 신뢰 경계 (check provenance)·원격 노드 소유권·crash 안전·범위 선언을 닫음.
> 작성: 2026-07-10. 근거: routes/tasks.js, lifecycleService, harvestService, worktreeService, projectMaterializationService, app.js(auto-review), auth.js, operatorSpawnService, webhookService, remoteSshExecutor, migrations 006/014/023/024/048/050/051.

## 1. 문제 정의

현재 워커 위임은 **1회성 채팅**이다:

- `POST /api/tasks/:id/execute` 의 `prompt` 자유텍스트가 그대로 워커 CLI 에 전달된다. `tasks.acceptance_criteria` 는 존재하지만 (migration 006, *"Informational; not enforced"*) 프롬프트에도 검증에도 배선돼 있지 않다.
- 워커의 `completed` 는 프로세스가 에러 없이 종료됐다는 뜻 (Claude: `result.is_error`, codex: exit 0). goal 달성과 무관하고, 기계판독 가능한 자기보고 채널이 없다.
- **completed-but-wrong 은 자동 루프에 안 잡힌다.** B-lite 재시도는 `failed && started_at && retry_count < MAX_RETRY(=1)` 만 커버하고, 동일 프롬프트를 백지에서 재실행한다.
- 각 attempt 는 백지 시작: harvest 가 worktree 를 무조건 제거하고 retry 는 HEAD 에서 새로 만든다. materialized 경로는 autosave 조차 없어 uncommitted 산출물이 사라진다.
- 유일한 품질 루프는 Operator auto-review (자연어, `AUTO_REVIEW_MAX=5` in-memory breaker) — 기계 검증이 사이에 없다.

**비코드 업무의 추가 갭 (v5 조사, 코드 실측)**:
- project 없는 태스크도 워커는 spawn 되지만 **cwd = `process.cwd()` (서버 루트)** — 파일 산출물이 서버 FS 에 방치·충돌하고 (`spawnCwd.js` no-dir policy), harvest 는 `harvested:false, errors:['no_worktree']` 만 남긴다.
- **워커 최종 출력 전문이 어디에도 저장 안 됨** — Claude 는 `result_summary` 2000자 컷, codex/tmux 는 정적 문자열 (`'Agent completed successfully'`). goal 판정의 입력으로 쓸 수 없다.
- folder-less specialist (B2c) 는 workspace:none + 텍스트 전용 1회 API 턴 — "산출물 있는 완결 업무"의 doer 가 될 수 없다. 실제 doer 는 워커 spawn 경로.
- project-less run 은 메모리 캡처 (R6/R1b) 도 전부 skip 된다 (`!run.project_id` early return).

## 2. 목표 / 비목표 / 한계 명시

**목표**: 태스크를 "goal 계약"(목표 + 수락 기준 + 검증 방법 + 반복 예산)으로 위임하면, 시스템이 **검증 통과까지 자율 반복**하고 예산 소진/무진전 시에만 에스컬레이션하며, **통과한 산출물이 사람이 집을 수 있는 형태로 전달**된다 (§5j). **적용 범위는 전 업무** — 코드 작업(git workspace)과 일반 업무(리서치/문서/분석, deliverable workspace §5k) 모두. goal 계약·verdict 루프·예산·에스컬레이션은 워크로드-불문 동일하고, 검증·연속성·전달만 워크로드별 구현이 갈린다.

**비목표**: 워커 CLI 개조 / 태스크 자동 분해·multi-worker orchestration / 자동 merge (산출물 merge/채택은 human 결정) / Operator auto-review 대체.

**한계 (정직)**:
- 결정적 enforcement 는 **human-provenance check** 가 있는 태스크에서 성립한다 (§5k-3 — Operator 작성 check 는 advisory). artifact check 는 **형식 게이트**다 — "산출물이 존재하고 형태를 갖췄는가"까지고, "내용이 맞는가"는 judge (Gate 1.5) 와 Gate 2 의 몫. LLM 판정의 본질적 불확실성은 남으며 Gate 2 (Operator) 와 human 에스컬레이션이 최종 방어선이다.
- **외부 시스템 액션 업무는 v1 범위 밖 (명시 유보, Codex R5 B4)**: 메일 발송·티켓 생성·CRM 업데이트처럼 결과가 파일이 아니라 **외부 side effect** 인 업무는 receipt/action ledger + idempotency key + approval boundary 가 필요한 별도 goal kind — **`action` goal kind 는 별도 brief 로 v2 유보**. v1 이 커버하는 것은 "산출물(파일/텍스트)을 만드는 업무" 전부: 코드, 문서, 리서치 보고서, 분석, 기획안.

## 3. 설계 원칙

1. **검증은 서버가 (deterministic-first).** 워커 goal report 는 annotate-only.
2. **verdict 는 단일 지점에서 결정·persist 후 전파.** 모든 정책 구독자(재시도, PM 리뷰, webhook, task 전이)는 persisted verdict 만 읽는다.
3. **재시도 소유자는 하나.** goal-enabled 태스크에서 B-lite 비활성.
4. **LLM 은 shell 을 정의할 수도, human 검증 채널을 스푸핑할 수도 없어야 한다** — PM token 분리가 goal 모드의 전제조건 (§6).
5. **crash-safe**: verdict 계산·재시도 spawn 은 재시작을 견딘다 (stage-resume + 단일 tx + boot sweeper).
6. **Additive + flag-gated** (`PALANTIR_GOAL_MODE`, 기본 off). goal 미설정 태스크는 기존 동작 완전 불변.

## 4. 아키텍처 — 3-Gate + persisted verdict

```
워커 attempt 종료 (run:ended)
  │  goal-enabled: B-lite retry 블록 + checkTaskCompletion + failed-webhook 전부 skip (§5d/§5g)
  ▼
harvest 파이프라인 (annotate-only, 단일 순차 소유자, stage-resume idempotent §5f-2)
  autosave (legacy 기존 / materialized 신규 §5e) → attempt ref 보존
  → diff(base=goal_root_commit) → test(기존)
  → Gate 1 acceptance(named check, stage-local catch)
  → verdict 계산 + persist (runs.goal_verdict) → goal-aware task 전이
  → worktree cleanup (무조건, 순서 불변)
  → run:harvested emit (payload 에 verdict 포함)
  │
  ├─ verdict=retry      → lifecycle 구독자: 단일 tx 재attempt (§5d) / PM 리뷰·webhook suppressed
  ├─ verdict=gate2      → PM auto-review (Gate 2 의미 판단, 구조화 블록)
  ├─ verdict=exhausted  → task failed + goal:exhausted webhook + PM 리뷰 (에스컬레이션)
  └─ verdict=error      → PM 리뷰에 에러 노트 + goal:error webhook (자동 재시도 안 함)
```

### verdict 결정 함수 (pure, deterministic)

`decideGoalVerdict({ status, acceptance, attemptsUsed, budget, nonRetryable, fingerprintRepeat, sourceGenerationChanged })`:

| 입력 | verdict |
|---|---|
| failed + non-retryable (materialize fail-closed, preflight, corrupt queued_args) | `error` |
| source_generation 변경 감지 (§5e) | `error` (reason: `source_changed`) |
| failed (retryable) + 예산 내 | `retry` |
| completed + Gate 1 FAIL (command/artifact) + 예산 내 + fingerprint 미반복 | `retry` |
| completed + Gate 1 PASS + **Gate 1.5 judge FAIL** (§5k-4) + 예산 내 + fingerprint 미반복 | `retry` (judge reasons 피드백 주입) |
| completed + Gate 1/1.5 FAIL + 동일 실패 fingerprint 연속 반복 | `gate2` (reason: `no_progress`) |
| completed + 전 gate PASS / check 미지정 / check skipped(원격 미지원 §5f) / judge 오류(fail-open §5k-4) | `gate2` |
| retry 조건인데 attemptsUsed ≥ budget | `exhausted` |
| acceptance/verdict 단계 내부 오류 | `error` |

- fingerprint = `hash(acceptance.exit_code + normalize(output_tail))` — 같은 실패 연속 2회면 조기 에스컬레이션.
- `needs_input` 은 terminal 아님 — goal 루프 비관여. 기존 `run:needs_input` 알림/webhook 이 사람을 부르고, 입력 후 terminal 도달 시 verdict 가 돈다.

## 5. 컴포넌트 설계

### 5a. 스키마 (migration N, additive)

```sql
-- v5: check 일반화 — kind 별 discriminated union (mcp_server_templates transport 선례)
CREATE TABLE verify_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('command','artifact')),
  project_id TEXT,                       -- command: 필수 (workspace 에서 실행). artifact: NULL 허용 (워크로드 무관)
  name TEXT NOT NULL,                    -- UNIQUE(coalesce(project_id,''), name)
  spec_json TEXT NOT NULL,               -- command: {command, timeout_ms} / artifact: 선언적 스펙 (§5k-3)
  created_by TEXT NOT NULL CHECK(created_by IN ('human','operator')),  -- provenance = 게이트 자격 (§5k-3)
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- INSERT/UPDATE trigger: kind='command' → project_id NOT NULL 강제 (column-shape trigger 선례: migration 022)

ALTER TABLE tasks ADD COLUMN goal_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN goal_max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tasks ADD COLUMN verify_check_id INTEGER;     -- command=human-only 할당 (§6), artifact=Operator 허용 (§5k-3)
ALTER TABLE tasks ADD COLUMN goal_judge_enabled INTEGER NOT NULL DEFAULT 0;  -- Gate 1.5 (§5k-4)
ALTER TABLE tasks ADD COLUMN deliverable_json TEXT;       -- 최종 전달물 manifest (§5j: branch 또는 artifact bundle)

ALTER TABLE runs ADD COLUMN goal_report TEXT;
ALTER TABLE runs ADD COLUMN final_output TEXT;            -- 최종 출력 전문 (goal run 만, cap 64KB — §5k-2)
ALTER TABLE runs ADD COLUMN acceptance_json TEXT;         -- Gate 1 결과 (command+artifact 집계)
ALTER TABLE runs ADD COLUMN judge_json TEXT;              -- Gate 1.5 결과 (§5k-4)
ALTER TABLE runs ADD COLUMN goal_verdict TEXT;            -- retry|gate2|exhausted|error
ALTER TABLE runs ADD COLUMN goal_verdict_reason TEXT;
ALTER TABLE runs ADD COLUMN goal_root_commit TEXT;        -- code 모드: 루프 원점 = diff base 고정
ALTER TABLE runs ADD COLUMN attempt_base_commit TEXT;     -- code 모드: 이 attempt 의 spawn base
ALTER TABLE runs ADD COLUMN attempt_ref TEXT;             -- code 모드: 보존 ref (GC 추적 §5e)
ALTER TABLE runs ADD COLUMN goal_workspace_path TEXT;     -- deliverable 모드: 격리 workspace (§5k-1)
ALTER TABLE runs ADD COLUMN deliverable_state TEXT;       -- deliverable 모드 stage marker: captured|bundled|cleaned (§5k-2)
ALTER TABLE runs ADD COLUMN goal_retry_run_id TEXT;       -- 단일 tx 로 child 와 동시 기록 (§5d)
```

- 수락 기준 텍스트는 기존 `tasks.acceptance_criteria` 재사용. 계보 루트는 기존 `retry_root_run_id` 재사용.
- `goal_root_commit` 은 첫 attempt 에서 기록, 계보 전체 복사 — base branch 이동에도 diff/판정 원점 고정.
- **워크로드 모드 판별은 런타임 사실 기준**: run 에 git workspace (worktree 또는 materialized) 가 있으면 **code 모드**, 없으면 **deliverable 모드** (§5k). 설정이 아니라 실제 workspace 존재로 갈린다 — non-git legacy directory 프로젝트도 자연히 deliverable 모드.

### 5b. 프롬프트 컴파일러

`spawnQueuedRun` 에서 goal-enabled 태스크면 `run.prompt` 를 결정적 템플릿으로 합성:

```
[GOAL] <task.title + description>
[ACCEPTANCE CRITERIA — 전부 충족해야 완료] <task.acceptance_criteria>
<verify check 있으면: "서버가 종료 후 검증 '<name>' 실행. 통과해야 완료다.">
[ATTEMPT n/max] <n>1: 피드백 블록 — 이전 diff stat / Gate1 실패 output tail / 이전 goal_report.blockers, 길이 cap>
[호출자 추가 지시] <execute body 의 prompt — append 채널 보존>
[COMPLETION REPORT] 마지막 응답에 ```palantir-goal-report {goal_status, summary, blockers}``` 포함
```

### 5c. goal report 파서 (공통 모듈)

`services/goalReport.js` — fenced block 파서 단일 구현. 1차: Claude 는 `result` 이벤트 텍스트 (streamJsonEngine 경유), codex/tmux 는 lifecycle final output 캡처. 2차: harvest 에서 부재 시 output tail 재파싱 보강. 파싱 실패는 run 실패 아님 (annotate-only).

### 5d. Goal 루프 드라이버 (단일 소유자, race-free, crash-safe)

**결정** (harvest 안):
- verdict 계산·persist 는 `run:harvested` emit 이전. 구독자들은 persisted verdict 만 읽으므로 순서 race 없음.

**실행** (lifecycle 의 `run:harvested` 구독자):
- verdict=retry → **단일 better-sqlite3 tx**: child run 생성(queued) + `UPDATE runs SET goal_retry_run_id=<child> WHERE id=<parent> AND goal_retry_run_id IS NULL` — CAS 실패 시 tx rollback (중복 이벤트/이중 구독에도 단일 child). **crash 창 제거**: parent claim 과 child 존재가 원자적 (Codex R2 BLOCKER 2 해소). spawn 은 tx 밖 — child 는 queued row 이므로 기존 queue drain 이 집는다.
- **tx 범위 최소화 (Codex R3)**: 프롬프트 컴파일, 이전 attempt 요약/diff 읽기, attempt ref resolve 등 I/O·무거운 read 는 전부 **tx 밖에서 사전 준비**. tx 안은 source_generation 재검증 + child insert + parent CAS 만 (동기 better-sqlite3 tx 를 짧게 유지).
- **tx 내 source_generation 불일치 (Codex R4)**: tx rollback 후 parent 를 `retry` 상태로 방치하지 않는다 — `UPDATE runs SET goal_verdict='error', goal_verdict_reason='source_changed' WHERE id=? AND goal_verdict='retry' AND goal_retry_run_id IS NULL` 교정 CAS 로 전환하고 error side effect (PM 리뷰 + `goal:error` webhook + task 전이) 를 발화. "retry verdict 인데 child 없음" 상태가 지속 불가능함을 테스트로 강제 (G3 필수 목록).
- **boot sweeper**: 부팅 시 (a) terminal + goal-enabled + `goal_verdict IS NULL` 인 run → verdict-only 재계산 (§5f-2), (b) queued goal child run → 기존 drain 경로 합류. "claimed but lost child" 모드는 tx 통합으로 소멸. **부팅 순서 (Codex R3)**: sweeper 는 `cleanupStaleTerminalWorktrees()` 등 stale worktree 정리보다 **먼저** 실행하고, 이중 방어로 stale cleanup 은 `goal_enabled && goal_verdict IS NULL` run 의 worktree 를 제외한다 — 정리가 먼저 돌아 acceptance 기회를 없애고 `harvest_incomplete` fail-open 으로 새는 경로 차단.

**verdict persist 도 CAS (Codex R3)**: `UPDATE runs SET goal_verdict=?, goal_verdict_reason=? WHERE id=? AND goal_verdict IS NULL` — **CAS 승자만** `goal:verdict` 이벤트·webhook·retry tx·task 전이 side effect 를 발생시킨다. duplicate harvest / sweeper 동시 진입에도 이중 side effect 없음.

**suppression (전부 persisted verdict 기반)**:
- PM 리뷰: verdict=retry → `pm_review:suppressed` (reason: `goal_retry`).
- **webhook**: goal-enabled 태스크의 `run:ended`(failed) 외부 발송 suppress (webhookService 가 task goal 여부 조회) — 대신 verdict 후 `goal:exhausted` / `goal:error` 를 webhook 채널로 발송 (Codex R2 BLOCKER 3 해소). **payload 는 기존 webhook 화이트리스트 원칙 (Codex R3)**: `{ task_id, run_id, project_id, verdict, reason, attempts_used, budget }` 만 — `goal_report`·acceptance output tail·diff stat·criteria 전문은 외부 발송 금지. `reason` 은 raw exception 문자열이 아니라 **고정 enum code** (`source_changed`/`no_progress`/`exhausted`/`harvest_incomplete`/`non_retryable`/`runner_unavailable` 등) 만 (Codex R4). `run:needs_input` webhook 은 기존 그대로 (goal 비관여).
- **B-lite**: `run:ended` retry 블록은 goal-enabled 면 skip. non-goal 완전 불변.
- non-retryable 분류: 인프라성 실패 (materialize fail-closed, preflight, corrupt queued_args) 는 verdict=error.
- 예산은 DB 계보 기반 (`retry_root_run_id` 내 `started_at` 있는 run 수) — 재시작에도 유지. `AUTO_REVIEW_MAX`(in-memory) 는 외곽 2차 안전망.

### 5e. Attempt 연속성 (ref 보존 모델)

- **materialized autosave 신설** (Codex R2 SERIOUS): materialized harvest 는 현재 uncommitted diff 를 읽고 worktree 를 지운다 — ref 보존 전에 workspace 에서 `git add -A && git commit`(autosave, executor 경유) 을 먼저 수행. legacy 는 기존 autosave 그대로. commit 은 `-c user.name=palantir -c user.email=palantir@local` 고정 author 로 실행 — git identity 미설정 노드(pod)에서의 실패 차단 (Codex R3 MINOR).
- **attempt ref 보존**: autosave 직후 `git update-ref refs/palantir/attempts/<runId> <tip>` — legacy 는 projectDir, materialized 는 cache repo, 실행은 run.node_id executor (diff/test 와 동일 plumbing). ref 이름을 `runs.attempt_ref` 에 persist (GC 추적 근거 — `project_workspace_refs` 는 별개 모델이므로 재사용 안 함). stage-local catch — 실패 시 연속성만 포기.
- **재attempt spawn base**: `refs/palantir/attempts/<prevRunId>` resolve 성공 시 base 로 worktree 생성 + `attempt_base_commit` 기록. 실패 시 기존 base (HEAD / resolved_commit) fallback + 피드백 블록에 "계승 실패, 백지 시작" 명시.
  - legacy: `createWorktree(projectDir, branch, { baseRef })` 옵션 추가.
  - materialized: `git worktree add -- <path> <attemptRef>`. `runs.resolved_commit` 은 root diff base 로 유지 (spawn base 와 분리).
- **diff base 고정**: goal run 의 harvest diff 는 `goal_root_commit` 기준 (getWorktreeDiff base override).
- **source_generation 가드 (DB 강제)**: 재attempt tx 안에서 parent 의 `run_source_generation` vs 현재 프로젝트 source_generation 비교 — 불일치면 tx 중단 + verdict=error(`source_changed`) 로 상향. live Operator 409 가드와 동일 정신을 goal 계보에도 DB 조건으로 강제 (Codex R2 SERIOUS 해소).
- **ref GC**: goal terminal (task done/failed 확정) 시 계보 run 들의 `attempt_ref` 를 조회해 executor 로 삭제. 주기 maintenance 가 orphan ref (task 삭제 등) 를 `runs.attempt_ref` 기준으로 sweep.

### 5f. Gate 1 — 기계 검증 (harvest 확장)

- 기존 test 단계 직후, goal-enabled + check 지정 시 실행 → `acceptance_json` persist + `harvest:acceptance` run event. completed run 에서만 (test 와 동일 조건).
- **check kind 별 평가**: `command` 는 code 모드 workspace 에서 shell 실행 (v4 그대로), `artifact` 는 deliverable/code 모드 공통 — 서버가 선언적 스펙을 pure function 으로 평가 (§5k-3). 둘 다 결과를 `acceptance_json` 에 집계. judge (Gate 1.5) 는 Gate 1 PASS 후 별도 단계 (§5k-4).
- **runner 정책 (Codex R2 BLOCKER 4)**: Gate 1 은 **harvest test 단계와 완전히 같은 runner** 를 쓴다. 해당 노드에서 그 runner 가 불가하면 (원격 executor 의 exec allowlist 가 `sh` 를 불허하는 경우 등) **acceptance = `{skipped, reason: 'runner_unavailable'}` → verdict=gate2** (fail-open to 의미 게이트, 조용한 통과 아님 — Gate 2 리뷰 텍스트에 "기계 검증 skipped" 명시). 원격 check runner 의 allowlist 확장은 별도 opt-in PR (G3b) 로 분리 — 원격 노드 정책 (fleet 트랙) 과 함께 결정.
- stage-local try/catch — cleanup 은 어떤 경우에도 실행 (기존 위치·순서 불변).

**5f-2. stage-resume idempotency (Codex R2 BLOCKER 1)**:
- 현행 `hasExistingHarvestEvent` (이벤트 하나면 전체 skip) 는 non-goal 경로에서만 유지.
- goal-enabled run 의 idempotency 키는 **`runs.goal_verdict` 컬럼**: verdict 가 NULL 이면 harvest 재진입 시 남은 stage 를 재개한다 — 이미 persist 된 stage (acceptance_json 존재 등) 는 skip, 미완 stage 만 실행. worktree 가 이미 제거된 뒤라면 (diff/acceptance 불가) 그 시점 가용 데이터로 verdict 를 **보수적으로** 계산 (acceptance 부재 → gate2, reason: `harvest_incomplete`) — verdict 영구 미계산 상태가 존재할 수 없다. boot sweeper (§5d) 가 이 경로의 최종 안전망.

### 5g. task status 전이 (goal-aware, 전 call-site)

- non-goal: 기존 그대로.
- goal-enabled: **모든 `checkTaskCompletion` call site** 가 goal 분기를 태운다 (run:ended 구독자 하나만이 아니라 — Codex R2 지적). 전이는 persisted verdict 가 결정: `retry` → `in_progress` 유지, `gate2` → `review`, `exhausted` → `failed`, `error` → `review` (판단 필요 노트). 전이 시점은 verdict persist 직후 (harvest 내) — status 가 verdict 를 앞지르는 창 없음.

### 5h. Gate 2 — Operator 의미 게이트 + 이벤트/UI

- `buildPmReviewText` 구조화 블록: acceptance criteria / Gate 1 결과 (PASS·FAIL·SKIPPED·NOT DEFINED·ERROR) / worker goal_report / attempt n/max / verdict reason. exhausted 는 "예산 소진 — 사용자 에스컬레이션 권고".
- Operator corrective dispatch 는 기존 `/execute` — goal 태스크면 컴파일러/루프를 태우고 Operator 지시는 append 채널.
- 신규 run event: `harvest:acceptance`, `goal:verdict` (payload shape 고정). `addRunEvent` → `run:event` 채널로 UI 도달 — **신규 SSE 채널 없음** (channels 배열 회귀 여지 제거).
- UI: TaskDetailPanel goal 섹션 (기준 / check 선택[human-only 표시] / attempt 타임라인 / Gate 1 뱃지 / goal_report / 결과 브랜치 §5j).

### 5i. 메모리 레이어 연계 (명시 배선)

- G5 에서 `createR1bCapture` 에 `harvest:acceptance` 구독 추가 (FAIL→PASS attempt 쌍 = 고품질 실패→수정 candidate). 자동으로 따라오지 않음을 명시 (`harvest:test` 하드코딩).
- goal_report.blockers 는 R3/R4 재료.

### 5j. 산출물 전달 (Codex R2 큰 그림 — "완결"의 마지막 조각)

goal 이 gate2 통과 (Operator done 판정) 또는 사람이 done 처리하면:
- 최종 attempt 의 보존 ref 를 **안정 브랜치 `palantir/goal/<taskId>`** 로 승격 (`git branch -f`, executor 경유).
- task/UI 에 결과 브랜치명 + 최종 diff stat 노출 — 사람이 리뷰/merge 할 대상이 항상 명확하다.
- **자동 merge 는 하지 않는다** (비목표). merge 는 human 결정 — 기존 워크플로 (PR 생성 등) 는 브랜치가 있으면 그대로 가능.
- **실패 모드 (Codex R3)**: 승격은 annotate-only — attempt_ref 미존재·branch -f 실패·원격 executor 실패 어느 것도 **task done 전이를 막지 않는다**. 실패 시 `goal:deliver_failed` run event + UI 뱃지 + 수동 재승격 액션 제공. **GC 순서 강제: attempt refs GC 는 승격 성공 후에만** — 승격 실패 시 refs 는 보존되어 수동 복구가 항상 가능하다.
- **deliverable 모드 (§5k)**: 브랜치 대신 최종 attempt 의 **artifact bundle** 이 전달물 — `tasks.deliverable_json` 에 manifest (bundle 경로, 파일 목록, report) 기록 + UI 노출/다운로드. 동일하게 annotate-only + 이전 attempt bundle GC 는 최종 bundle 확정 후에만.

### 5k. 워크로드 일반화 — deliverable 모드 (v5 신설)

goal 계약·verdict 루프·예산·suppression (§4, §5d) 은 워크로드-불문 동일하다. 아래 4개만 code 모드와 구현이 갈린다.

**5k-1. Goal workspace (격리 cwd) — node-aware provider (Codex R5 B2)**:
- goal-enabled run 에 git workspace 가 없으면 **run 의 node_id 에 맞는 workspace provider** 가 격리 디렉토리를 만들어 **cwd 로 강제** (`spawnCwd.js` 의 기존 `requireExplicit` seam):
  - **local**: `<dataDir>/goal-workspaces/<runId>/` (storage 경유).
  - **remote**: `exposed_roots[0]/.palantir-goal/<runId>/` — materialization 의 `.palantir-*` 경로 선례. fs 작업은 전부 해당 노드 executor 경유 (nodeExecutor / remoteSshExecutor — projectMaterializationService 가 이미 쓰는 패턴). remote executor 의 cwd 검증 (`spec.cwd` ⊂ exposed_roots) 을 자연히 통과. **exposed_roots 부재/생성 실패는 non-retryable → verdict=error** (Codex R6 — 재시도 낭비 금지).
  - 로컬 dataDir 은 원격 산출물의 **mirror/메타데이터 저장소** 역할 (manifest + report 발췌) — bundle 본체는 산출 노드에 보존, 다운로드는 executor 경유 on-demand.
- 경로 안전: `taskId`/`runId`/상대 경로 전부 safe-segment 강제 + `isWithinRoot` + **symlink 를 follow 하지 않는 enumerator** (Codex R5 MINOR — prefix guard 만으로 부족).
- non-goal project-less run 은 기존 no-dir policy 그대로 (완전 불변).

**5k-2. 산출물 수확 (harvest deliverable stage)** — git diff 의 대응물, **first-class idempotent stage (Codex R5 B3)**:
- deliverable 모드는 `no_worktree` early-return 으로 빠지지 않고 verdict 파이프라인의 정식 stage 를 탄다. 순서는 **copy → verify → persist → delete** (move 금지):
  (a) workspace 파일 enumerate → manifest (경로/크기/**hash**; cap: 파일 20개·총 10MB, 초과분은 truncated 표시 — no-silent-cap, 초과는 판정에 `manifest_truncated` 로 표기). UI/문서는 이를 **bounded deliverable** 로 명시 노출 (Codex R6 — "전 업무" 표현과의 오해 방지),
  (b) 최종 출력 전문 캡처 → `runs.final_output` + workspace 에 `_report.md`,
  (c) bundle 을 artifact 영역 (`goal-artifacts/<taskId>/attempt-<n>/`, 노드-로컬) 으로 **복사** → hash 재검증 → manifest 를 `acceptance_json` 계열에 persist (**stage marker**: `runs.deliverable_state` = captured→bundled→cleaned),
  (d) 검증 통과 후에만 workspace 삭제. crash 재개는 stage marker + destination 존재를 먼저 확인 — artifact 유실 창 없음.
- **최종 출력 캡처는 G1 의 신규 코드, file-backed (Codex R5 SERIOUS)**: Claude 는 `result` 이벤트 전문, codex/subprocess/tmux 는 **stdout 을 파일로 tee** 해 process-local 메모리 buffer 에 의존하지 않음 (재시작 손실 차단; remote 는 기존 stdout log 파일 재사용). `harvest:deliverable` run event (payload shape 고정).
- Gate 1 acceptance 실행 위치: copy **전** workspace 에서 (artifact check 가 파일 검사).
- **judge 입력 (Codex R5 SERIOUS)**: `final_output` (64KB) 만이 아니라 **artifact 발췌** 포함 — 텍스트 파일별 head 발췌 + hash manifest, 발췌 총량 cap 32KB. 비텍스트 (PDF/스프레드시트) 는 v1 에서 메타데이터 (파일명/크기/hash) 만 — 본문 추출은 v2.
- retention: `goal-artifacts` 는 storage 정책에 편입 — 최종 bundle 보존, 비최종 attempt bundle 은 task terminal 후 GC, orphan sweep (Codex R5 MINOR).

**5k-3. artifact check (선언적) — provenance 가 게이트 자격을 결정 (Codex R5 B1)**:
- `spec_json` 은 **shell 이 아니라 선언적 스펙**: `{ files: [{glob, must_exist, min_bytes}], report: {min_chars, must_contain: [..], format: 'markdown'|'json'} }` — 서버가 스키마 검증 후 pure function 평가 (파일 read 만, timeout/크기 cap, no-symlink).
- **신뢰 경계**: 검증 기준을 작성한 주체가 워커/Operator(LLM) 면 그 기준은 **게이트가 될 수 없다** (항상-PASS 기준으로 goal 세탁 가능). 따라서:
  - **human-provenance check (cookie 작성)** 만 Gate 1 판정 근거 (`verify_checks.created_by ∈ {human}` — command 와 동일 규율).
  - **Operator-authored artifact check 는 advisory** — 평가는 하되 verdict 에 불참, Gate 2 리뷰 텍스트에 "advisory check: PASS/FAIL (Operator 작성)" 로만 표기. human 이 UI 에서 승인하면 (cookie PATCH) gate-grade 로 승격.
  - **provenance 갱신 불변식 (Codex R6)**: `created_by` 는 "최신 spec 의 provenance" 다 — **spec_json 을 수정한 actor 가 Operator 면 human-created check 라도 operator provenance 로 강등** (gate 자격 상실, human 재승인 필요). UPDATE 경로가 이 불변식을 서버에서 강제 — 아니면 B1 (세탁) 재발.
- **gaming 한계 명시**: artifact check 는 human 작성이라도 **형식 게이트**다 — 워커가 `must_contain` 문자열만 박아넣는 gaming 은 구조적으로 가능. 형식 통과 후 내용 판정은 judge (Gate 1.5) 와 Gate 2 가 담당 — 3층이 한 세트다.
- command check 는 v4 그대로 (code 모드 전용, human-only).

**5k-4. Gate 1.5 — judge (구조화 LLM 판정, 별도 flag)**:
- 비코드 업무의 수락 기준은 대부분 의미 기준 — artifact check 만으로는 "존재하는가"까지고 "맞는가"는 못 본다. `PALANTIR_GOAL_JUDGE=1` (기본 off, `PALANTIR_MEMORY_DISTILL` 선례) + `tasks.goal_judge_enabled` 시: Gate 1 PASS 후 서버가 **Messages API 직접 호출** (기본 `claude-haiku-4-5`, liveDistiller/specialistBackend 선례) 로 rubric 판정 — 입력: acceptance_criteria (rubric) + `final_output` + artifact 발췌 (§5k-2) + manifest, 출력 → `runs.judge_json`.
- **injection 방어는 다층 (Codex R5)**: ① 서버 고정 system prompt (판정 대상은 데이터, 내부 지시 무시 명시), ② **JSON schema 강제 출력** (`{pass, reasons[]}`) + 서버측 output parser (스키마 불일치 = 판정 실패 처리), ③ **no tool use**, ④ bounded excerpts (cap 된 발췌만, 전문 주입 금지), ⑤ 재살균 (memorySanitize 계열). 
- **판정 권한 서열**: judge 는 **보조 판정/retry hint** 다 — judge FAIL 은 verdict=retry (reasons 피드백, fingerprint 에 reasons hash 포함) 로 루프를 돌리지만, **최종 accept 권한은 항상 Gate 2 (Operator) → human** 이다. judge PASS 가 task done 을 만들지 않는다.
- **비용 규율**: attempt 당 judge 호출 1회 고정, haiku 기본 — max_attempts=3 기준 태스크당 최대 3 호출. 기본 off + 사용자 opt-in (CLAUDE.md 승인 원칙 부합).
- judge 오류/timeout 은 gate2 로 fail-open (annotate — 판정 실패가 루프를 죽이지 않는다).

**5k-5. attempt 연속성 (deliverable 모드)**:
- 다음 attempt 의 goal workspace 를 **이전 attempt bundle 복사로 seed** + 피드백 블록 (artifact/judge 실패 사유). git ref 계승의 대응물 — 구현은 단순 디렉토리 복사 (cap 동일).
- 앵커 노트: goal 단위는 task (project_id nullable — 이미 1급). Operator 귀속은 기존 `runs.operator_instance_id` 로 충분, 신규 앵커 스키마 v1 불요.

## 6. 보안/신뢰 경계 (R1#4 + R2 잔존 지적 해소)

핵심 전제: **Operator 는 현재 `PALANTIR_TOKEN` bearer 를 주입받는다** (operatorSpawnService) — 이 상태에서 cookie/bearer actor split 은 스푸핑 가능 (Operator 가 토큰 값을 cookie 로 보낼 수 있음). 따라서:

- **`PALANTIR_GOAL_MODE=1` 의 활성 전제조건 = `PALANTIR_PM_TOKEN` 분리 운영** (R4 remember 의 spoof-proof 계약 재사용: cookie 는 `PALANTIR_TOKEN` 만, bearer 는 PM token). 서버는 goal 모드 + PM token 미분리 조합이면 **goal 기능을 fail-closed 비활성** + 경고 로그.
- **Operator-visible context 전체에서 human token 제거 (Codex R3 BLOCKER)**: goal 모드에서 Operator 가 보는 **모든** 표면 — spawn env, system prompt 의 curl 예시 (`managerSystemPrompt.js` 가 현재 `PALANTIR_TOKEN` 을 직접 인라인), API 사용 안내 텍스트 — 는 `PALANTIR_PM_TOKEN` 만 담는다. `PALANTIR_TOKEN` 이 PM-visible context 어디에든 들어가면 cookie-only gate 는 스푸핑 가능하므로, 이것은 G2 의 gate 구현과 같은 PR 에서 원자적으로 처리한다.
- **human-only 채널 (cookie actor, fail-closed)**: `command` kind check 의 CRUD **및 command check 의 task 할당** (Codex R2 SERIOUS — 할당도 human-only). 할당 시 **`task.project_id == check.project_id` 서버 검증** (Codex R3 — cross-project check 참조 금지, command 실행 경계 유지).
- **artifact kind 는 Operator(bearer) 작성/할당 허용 (v5)**: 선언적 스펙만 있고 실행 표면이 없다 — 서버가 스키마를 fail-closed 검증하고 pure function 으로 평가하므로, prompt-injection 된 Operator 가 만들 수 있는 최악은 "잘못된 파일 기준" (임의 실행 아님). glob 평가는 workspace 루트 안으로 제한 (`isWithinRoot` 선례).
- **judge (Gate 1.5)**: rubric 은 `acceptance_criteria` 텍스트 자체 — Operator 가 쓸 수 있는 것은 v4 와 동일 범위. judge 프롬프트 템플릿은 서버 고정, 판정 대상 컨텐츠는 데이터 취급 + 재살균 (§5k-4).
- **Operator 가 할 수 있는 것**: `goal_enabled`/`goal_max_attempts`/`acceptance_criteria`/`goal_judge_enabled`/artifact check 설정, goal 태스크 dispatch. command check 미할당 code 태스크는 `verify_checks.is_default` (human 지정) 가 있으면 그것을 사용.
- raw `verify_command` 컬럼 없음. command 실행 표면은 기존 `project.test_command` 와 동일 — 신규 권한 상승 없음. goal workspace (§5k-1) 는 `<dataDir>` 하위 고정 + `isWithinRoot` 검증.

## 7. 페이즈 계획

| PR | 내용 | 리스크 |
|---|---|---|
| G1 | 프롬프트 컴파일러 + goalReport 파서 + **최종 출력 전문 캡처 (`runs.final_output`, 비Claude engine 포함 — §5k-2)** | 낮음 |
| G2 | `verify_checks` 스키마 (kind union + provenance + trigger)/CRUD + PM token 전제 gate + **goal workspace local provider (§5k-1)** + harvest deliverable stage (copy-verify-delete, annotate-only) + artifact 평가기 (advisory/gate 분리). **혼합 UX 완화**: acceptance 결과를 PM 리뷰 텍스트에 즉시 배선 | 중간 |
| G2b | **goal workspace remote provider** — exposed_roots 하위 `.palantir-goal/` + executor 경유 수확 + mirror/on-demand 다운로드 (fleet 실 Pi 검증 필수) | 중간~높음 |
| G3 | verdict 함수 + stage-resume idempotency + 단일 tx 재시도 + boot sweeper + B-lite/webhook/checkTaskCompletion goal 분기 + attempt 연속성 (code=ref 보존/계승 §5e, deliverable=bundle seed §5k-5) + source_generation 가드 + fingerprint 조기 종료 | **높음** (본체) |
| G3b | 원격 노드 check runner allowlist 확장 (opt-in, fleet 정책과 결정) | 중간 |
| G3c | **Gate 1.5 judge (§5k-4)** — `PALANTIR_GOAL_JUDGE` flag, 서버 Messages API, 구조화 판정 + 재살균 + 비용 규율 | 중간 (LLM 비용/poisoning) |
| G4 | Gate 2 리뷰 구조화 + TaskDetail goal UI + 산출물 전달 (code=브랜치 승격, deliverable=bundle manifest — §5j) | 중간 |
| G5 | 메모리 연계 (`harvest:acceptance` → R1b) + **project-less goal run 의 메모리 캡처 경로 검토** (현재 `!run.project_id` early-return) + flag 기본 on 검토 | 낮음 |

G3 테스트 필수 시나리오: failed retry 단일 소유 (B-lite 이중 spawn 0), completed+Gate1 FAIL suppression, tx 원자성 (parent claim ↔ child 존재), **source_generation mismatch-in-retry-tx → retry→error 교정 CAS (Codex R4 필수 지정)**, boot sweeper (verdict NULL 재계산 / queued child drain / stale cleanup 선행 금지), harvest 중간 crash stage-resume, verdict CAS 이중 side effect 0, webhook suppression + goal:exhausted 발송 + payload 화이트리스트, max_concurrent 큐 상호작용, needs_input 비관여, materialized autosave + ref 계승 + runner_unavailable fail-open, fingerprint 조기 종료, ref GC (승격 성공 후에만), 전 checkTaskCompletion call-site goal 분기.

## 8. Codex 리뷰 이력 매핑

| 지적 | 해소 |
|---|---|
| R1-1 run:ended 타이밍 + 이중 spawn race | persisted verdict (§4) + 단일 tx (§5d) — R2 RESOLVED |
| R1-2 materialized 계승 전제 오류 | 명시 ref 보존 + spawn/diff base 분리 (§5e) — R2 RESOLVED |
| R1-3 checkTaskCompletion review 오염 | goal-aware 전이, 전 call-site (§5g) — R2 RESOLVED |
| R1-4 verify_command 보안 | named check + **PM token 분리 전제조건 + 할당도 human-only** (§6) |
| R1-5 harvest cleanup 순서 | stage-local catch, cleanup 위치 불변 (§5f) — R2 RESOLVED |
| R2-1 harvest idempotency vs verdict | goal run 은 `goal_verdict` 키 stage-resume + 보수적 verdict + boot sweeper (§5f-2) |
| R2-2 CAS lost retry | child 생성 + parent CAS 단일 tx, spawn 은 queue drain (§5d) |
| R2-3 webhook failed 즉시 발송 | goal 태스크 failed webhook suppress → `goal:exhausted`/`goal:error` 로 대체 (§5d) |
| R2-4 원격 runner 불가 | 같은-runner 원칙 + skipped→gate2 fail-open + G3b opt-in (§5f) |
| R2-S materialized autosave 부재 | materialized autosave 신설 (§5e) |
| R2-S ref GC 모델 부재 | `runs.attempt_ref` persist + terminal GC + maintenance sweep (§5e) |
| R2-S check 할당 오용 | 할당 human-only + is_default (§6) |
| R2-S G2 혼합 UX | G2 에서 리뷰 텍스트 즉시 배선 (§7) |
| R2-S source_generation 계보 가드 | 재시도 tx 내 DB 조건 강제 (§5e) |
| R2-큰그림 산출물 완료 처리 | §5j 안정 브랜치 승격 + human merge |
| R2-큰그림 의미 기준 enforcement 한계 | §2 정직한 한계 + Gate 1.5 (LLM judge) v2 유보 |
| R3-B PM prompt 내 PALANTIR_TOKEN 인라인 | Operator-visible 전 표면 PM token 화, G2 와 원자 처리 (§6) |
| R3-S boot sweeper vs stale cleanup 순서 | sweeper 선행 + stale cleanup 의 verdict-NULL 제외 (§5d) |
| R3-S verdict persist 비-CAS | verdict CAS — 승자만 side effect (§5d) |
| R3-S retry tx 범위 과다 | tx = 재검증+insert+CAS 만, 준비는 tx 밖 (§5d) |
| R3-S webhook payload 무제한 | goal webhook 화이트리스트 명시 (§5d) |
| R3-S cross-project check 참조 | project_id 일치 서버 검증 (§6) |
| R3-S 승격 실패 모드 부재 | annotate-only + deliver_failed + GC 순서 강제 (§5j) |
| R3-M autosave git identity | 고정 author config (§5e) |
| R5-B1 Operator artifact check = goal 세탁 | provenance 기반 gate/advisory 분리 + human 승격 (§5k-3) |
| R5-B2 goal workspace 원격 노드 소유권 | node-aware provider (local dataDir / remote exposed_roots) + G2b 분리 (§5k-1) |
| R5-B3 deliverable 수확 crash 안전 | copy-verify-persist-delete + deliverable_state marker (§5k-2) |
| R5-B4 외부 액션 업무 미커버 | `action` goal kind 명시 유보 — §2 한계 선언 |
| R5-S final_output 만으로 judge 입력 부족 | artifact 발췌 + hash manifest, 비텍스트는 메타만 v1 (§5k-2) |
| R5-S 비Claude capture 휘발성 | file-backed stdout tee (§5k-2) |
| R5-S judge injection 다층 방어 | 고정 system prompt + schema 강제 + no tool + bounded excerpts + Gate 2 최종권 (§5k-4) |
| R5-M storage/retention, path safety | retention·orphan GC + safe-segment·no-symlink enumerator (§5k-1/2) |
