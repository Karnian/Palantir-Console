# Goal Delegation (G 트랙) — 워커 완결 작업 위임 brief

> **상태: DRAFT — Codex 교차리뷰 진행 중. 사용자 lock-in 전.**
> 작성: 2026-07-10. 근거 코드 조사: routes/tasks.js, lifecycleService, harvestService, app.js(auto-review), worktreeService, migrations 006/014/023/024/048/050/051.

## 1. 문제 정의

현재 워커 위임은 **1회성 채팅**이다:

- `POST /api/tasks/:id/execute` 의 `prompt` 자유텍스트가 그대로 워커 CLI 에 전달된다 (`lifecycleService.spawnQueuedRun`, `run.prompt`). `tasks.acceptance_criteria` 는 스키마에 존재하지만 (migration 006, *"Informational; not enforced"*) 프롬프트에도 검증에도 배선돼 있지 않다.
- 워커의 `completed` 는 **프로세스가 에러 없이 종료됐다**는 뜻이다 (Claude: `result` 이벤트 `is_error` 여부, codex: exit code 0). goal 달성 여부와 무관하다. 워커가 "다 했다"를 기계판독 가능하게 보고하는 채널이 없다.
- **completed-but-wrong 은 자동 루프에 잡히지 않는다.** B-lite 자동 재시도(`createRetryRun`)는 `failed` + `retry_count < 1` 만 커버하고, 동일 프롬프트를 백지에서 재실행한다 (실패 원인 피드백 없음).
- 각 attempt 는 **완전 백지**에서 시작한다. harvest 가 worktree 를 무조건 제거하고, retry run 은 HEAD 에서 새 worktree 를 만든다. 이전 attempt 의 진행분은 autosave 브랜치(`palantir/run-<id>`)에 커밋으로 남지만 아무도 그걸 base 로 쓰지 않는다.
- 유일한 품질 루프는 Operator auto-review (자연어 harvest 요약 → Operator 가 자유텍스트 corrective 프롬프트로 재dispatch, `AUTO_REVIEW_MAX=5`). LLM 판단에 전적으로 의존하고, 기계 검증(acceptance command)이 사이에 없다.

## 2. 목표 / 비목표

**목표**: 태스크를 "goal 계약"(목표 + 수락 기준 + 검증 방법 + 반복 예산)으로 위임하면, 시스템이 **검증 통과까지 자율 반복**하고, 예산 소진 시에만 사람에게 에스컬레이션한다.

**비목표**:
- 워커 CLI 자체 개조 (프롬프트/검증은 전부 서버 측)
- 태스크 자동 분해 / multi-worker orchestration (별도 트랙)
- Operator auto-review 파이프라인 대체 (확장만)

## 3. 설계 원칙

1. **검증은 서버가 한다 (deterministic-first).** 워커의 자기보고(goal report)는 annotate-only — 리뷰/메모리 입력이지 게이트가 아니다. 게이트는 서버가 worktree 에서 직접 실행한 검증 결과만.
2. **재시도 소유자는 하나.** B-lite(failed retry)와 goal 루프(unverified retry)가 이중으로 돌면 T5 사고 재발. goal-enabled 태스크에서는 goal 루프가 재시도의 단일 소유자.
3. **기존 인프라 재사용**: `tasks.acceptance_criteria`(배선만), `retry_root_run_id` 계보, harvest 이벤트 파이프라인, auto-review breaker, autosave 브랜치.
4. **Additive + flag-gated**: `PALANTIR_GOAL_MODE` (기본 off → 검증 후 on flip). goal 미설정 태스크는 기존 동작 완전 불변.

## 4. 아키텍처 — 3-Gate 모델

```
워커 attempt 종료
  │
  ├─ Gate 0: 프로세스 종료 판정 (기존) ── failed → goal 루프가 재시도 (B-lite 대체)
  │                                        completed ↓
  ├─ Gate 1: 기계 검증 (harvest 확장) ─── verify checks 실행 in worktree
  │            FAIL → 피드백 주입 재attempt (예산 내) / 예산 소진 → 에스컬레이션
  │            PASS ↓ (또는 기계 검증 미정의 시 skip ↓)
  └─ Gate 2: 의미 검증 (Operator auto-review, 기존 확장)
               자유텍스트 기준을 LLM 이 판단 → done 또는 corrective dispatch
```

- Gate 1 은 결정적/저비용 — LLM 호출 0. 기계적으로 잡히는 미달(테스트 실패, 빌드 깨짐)은 Operator 를 깨우지 않고 루프를 돈다.
- Gate 2 는 기존 auto-review 를 그대로 쓰되, 리뷰 메시지에 **Gate 1 결과 + 워커 goal report** 가 구조화되어 들어간다. Operator 는 "기계 검증은 통과했으니 의미 판단만 하라"는 좁은 질문을 받는다.

## 5. 컴포넌트 설계

### 5a. Goal 계약 (스키마)

migration N (additive):
```sql
ALTER TABLE tasks ADD COLUMN goal_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN goal_max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tasks ADD COLUMN verify_command TEXT;          -- Gate 1 (nullable)
ALTER TABLE runs  ADD COLUMN goal_report TEXT;             -- 워커 자기보고 JSON (annotate-only)
ALTER TABLE runs  ADD COLUMN acceptance_json TEXT;         -- Gate 1 결과 스냅샷
```
- **수락 기준 텍스트는 기존 `tasks.acceptance_criteria` 재사용** (신규 컬럼 없음). Gate 2 의 판단 기준 + 워커 프롬프트 재료.
- `verify_command`: `projects.test_command`(migration 023)의 태스크 레벨 일반화. 동일 실행기(harvest 의 test 단계), 동일 timeout 규율, worktree cwd. v1 은 단일 command (multi-check 은 v2).
- 신뢰 경계: §7 참조.

### 5b. 프롬프트 컴파일러 (Gate 0 진입 전)

`spawnQueuedRun` 에서 goal-enabled 태스크면 `run.prompt` 를 결정적 템플릿으로 합성:

```
[GOAL]
<task.title>
<task.description>

[ACCEPTANCE CRITERIA — 아래를 전부 충족해야 완료임]
<task.acceptance_criteria>
<verify_command 있으면: "서버가 종료 후 `<verify_command>` 를 실행해 검증한다. 이것이 통과해야 한다.">

[ATTEMPT <n>/<max>]
<n>1 이면: 이전 attempt 피드백 블록 (§5d)>

[COMPLETION REPORT — 마지막 응답에 반드시 포함]
```palantir-goal-report
{ "goal_status": "met" | "blocked" | "partial", "summary": "...", "blockers": "..." }
```
```

- 호출자(execute body)의 `prompt` 는 추가 지시로 뒤에 append (기존 계약 보존).
- goal_report 는 `result_summary` 텍스트에서 fenced block 파싱 → `runs.goal_report` 저장. **파싱 실패해도 run 은 실패 처리하지 않음** (annotate-only).

### 5c. Gate 1 — 기계 검증 (harvest 확장)

`harvestService` 의 기존 test 단계(현재 `project.test_command`, completed 에서만) 직후에:
- goal-enabled + `verify_command` 존재 시 worktree 에서 실행 → `harvest:acceptance` 이벤트 emit (`{ passed, exit_code, duration_ms, output_tail }`) + `runs.acceptance_json` 저장.
- **worktree 제거는 기존대로 무조건 수행** — attempt 연속성은 디렉토리가 아니라 **autosave 브랜치**로 확보 (§5e). harvest 의 "annotate-only, never throws, 항상 cleanup" 불변식 유지.
- materialized(repo-defined) 경로: `harvestMaterializedRun` 에 동일 분기. 원격 executor 로 실행 (test_command 와 같은 경로).

### 5d. Goal 루프 드라이버 (재시도 단일 소유자)

`run:ended` 구독자(현재 B-lite 자리)를 확장 — goal-enabled 태스크면:

| attempt 결과 | Gate 1 | 동작 |
|---|---|---|
| failed | — | 피드백 주입 재attempt (예산 내) |
| completed | FAIL | 피드백 주입 재attempt (예산 내) |
| completed | PASS 또는 미정의 | Gate 2 로 (Operator auto-review) |
| 예산 소진 | — | task → `failed` + `goal:exhausted` emit + 에스컬레이션 (webhook 경로 재사용) |

- **피드백 주입**: 재attempt 의 프롬프트 템플릿에 이전 attempt 의 (a) diff stat, (b) Gate 1 실패 output tail, (c) 워커 goal_report 의 blockers 를 결정적으로 삽입. 길이 cap.
- **예산**: `goal_max_attempts` = 계보(`retry_root_run_id`) 내 `started_at` 있는 run 수. B-lite 의 `MAX_RETRY=1` 은 goal-enabled 태스크에서 비활성 (goal 루프가 failed 도 흡수).
- **T5 정합**: goal 재attempt 가 큐에 있으면 `pm_review:suppressed` (reason: `goal_retry_pending`) — 기존 suppression 재사용. Gate 1 FAIL 재attempt 는 Operator 리뷰 자체를 발화시키지 않음 (Gate 2 도달 시에만 리뷰).
- `AUTO_REVIEW_MAX=5` 는 외곽 breaker 로 유지 (goal 루프와 독립 이중 안전망).

### 5e. Attempt 연속성 (worktree 계승)

재attempt 의 worktree base 를 **HEAD 가 아니라 이전 attempt 의 autosave 브랜치 tip** 으로:
- legacy 경로: `createWorktree(projectDir, newBranch, { baseBranch: prevRunBranch })` — 이전 브랜치가 `branchHasWork` 일 때만; 아니면 기존대로 HEAD.
- materialized 경로: cache repo 에 이전 attempt 브랜치가 남아 있으므로 `git worktree add -- <path> <prevBranchTip>` (resolved_commit 대신). run 의 `resolved_commit` 스냅샷은 **원래 base 유지** (diff 의 기준점이 흔들리면 harvest diff 가 attempt 간 증분만 보이게 됨 — diff base 는 goal 루프 전체의 원점 커밋으로 고정).
- 이점: 이전 진행분 계승으로 attempt 마다 처음부터 다시 안 함. 워커가 "이전 워커의 미완성 작업 이어받기"를 피드백 블록으로 인지.

### 5f. Gate 2 — Operator 의미 게이트 (기존 확장)

`buildPmReviewText` 에 구조화 블록 추가:
```
[goal] acceptance criteria: <...>
[goal] machine verification: PASS (verify_command exit 0) | NOT DEFINED
[goal] worker report: met — "<summary>"
[goal] attempt 3/3
→ 기준 충족이면 task done. 미충족이면 남은 예산 내 corrective dispatch (구체 지시 포함).
```
Operator 의 corrective dispatch 는 기존 `/execute` 그대로 — 단 goal-enabled 태스크면 그 run 도 goal 루프/프롬프트 컴파일러를 태운다 (Operator 의 지시는 append 채널).

### 5g. 이벤트/SSE/UI

- 신규 run event: `harvest:acceptance`, `goal:exhausted`, `goal:met` (cardinality 규율 — payload shape 고정).
- **`useSSE` channels 배열에 추가 필수** (Phase 5/7 회귀 교훈).
- UI: TaskDetailPanel 에 goal 섹션 (기준, attempt 타임라인 = retry 계보, Gate 1 결과 뱃지). `run_acceptance_checks` 수동 체크 UI 는 그대로 공존.

## 6. 메모리 레이어 시너지

- Gate 1 FAIL→PASS attempt 쌍은 R1b(실패→수정) candidate 의 고품질 소스 — 기존 캡처가 `harvest:test` 기반이므로 `harvest:acceptance` 도 구독 추가.
- goal_report 의 blockers 는 R3/R4 후보 재료 (annotate-only 원칙 유지).

## 7. 보안/신뢰 경계 (Codex 리뷰 요청 핵심)

`verify_command` 는 서버(또는 원격 node)가 worktree 에서 실행하는 임의 shell 이다.
- 위험 완화 프레임: `projects.test_command` 가 이미 동일 신뢰 수준으로 존재 (Operator 가 프로젝트를 수정할 수 있으면 test_command 로 이미 임의 실행 가능). 워커 자체도 worktree 에서 임의 코드를 실행하는 에이전트다.
- 그러나 **Operator(LLM) 가 태스크 생성 시 verify_command 를 직접 쓰는 것**은 새 표면: prompt-injection 된 Operator 가 검증 명령을 조작할 수 있음.
- **제안 (v1)**: `verify_command` 설정/수정은 **cookie(human) actor 전용** (R4 remember 의 actor split 재사용, `req.auth.method`). Operator(bearer)는 verify_command 를 못 쓰고, `acceptance_criteria` 텍스트 + `goal_enabled` 만 설정 가능. 프로젝트 레벨 `test_command` 는 goal 태스크에서도 항상 실행되므로 Operator 는 "기존 등록된 검증"에만 올라탈 수 있다.
- 대안 (v2): 프로젝트에 human 이 등록한 named check 프리셋 목록 → Operator 는 이름으로만 참조.

## 8. 페이즈 계획

| PR | 내용 | 리스크 |
|---|---|---|
| G1 | 프롬프트 컴파일러 + goal_report 파싱/저장 (배선만, 루프 없음) | 낮음 — 순수 additive |
| G2 | Gate 1: harvest acceptance 실행 + `harvest:acceptance` + acceptance_json | 낮음 — harvest 불변식 유지 |
| G3 | Goal 루프: 피드백 재attempt + 브랜치 계승 + B-lite/T5 통합 + 예산/에스컬레이션 | **높음** — 재시도 소유권 재편 |
| G4 | Gate 2 리뷰 텍스트 구조화 + UI (TaskDetail goal 섹션) + SSE | 중간 |
| G5 | 메모리 시너지 (R1b acceptance 소스) + flag 기본 on 검토 | 낮음 |

G1+G2 만으로도 "기준이 프롬프트에 들어가고 서버가 검증 결과를 기록"하는 가치가 나온다 (루프 없이도 Operator 리뷰 품질 상승). G3 가 본체.

## 9. Open Questions (Codex 리뷰 포인트)

1. verify_command 신뢰 경계 — §7 의 cookie-only v1 이 충분한가, 아니면 named-check 프리셋을 v1 부터?
2. 브랜치 계승 (§5e) — materialized 경로에서 diff base 고정 방식이 맞는가? 충돌/오염 시나리오?
3. Gate 1 FAIL 재attempt 가 Operator 를 완전히 우회하는 것이 맞는가, 아니면 N 회마다 Operator 에게 중간 보고?
4. goal_report 파싱을 streamJsonEngine 에 넣을지 harvest 에 넣을지 (codex/tmux 워커는 result 이벤트가 없어 stdout tail 파싱이 필요).
5. B-lite 완전 대체 vs 공존 — goal-enabled 에서 MAX_RETRY 비활성이 회귀를 만들 지점?
