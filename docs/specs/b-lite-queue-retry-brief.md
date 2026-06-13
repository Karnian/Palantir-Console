# B-lite: 경량 워커 큐 + 자동 재시도

> 2026-06-14. Status: **r2 READY** (Codex r1 spec review 반영 — BLOCKER 1 + SERIOUS 2 해소)
> 작성: Claude (감독). 구현: Codex. branch: `feat/b-lite-queue`
> 배경: 컨셉 리뷰에서 "오케스트레이션 부재" 로 지목 — `max_concurrent` 도달 시 `executeTask` 가
> throw 하고 사용자가 수동 재시도. 큐/자동시작/재시도 없음. "허브가 직렬화 책임을 져야 한다."
>
> **r2 핵심 변경 (Codex r1)**:
> - **retry = 새 attempt run** (BLOCKER Q5): 원 failed run 을 queued 로 되돌리면 harvest exactly-once
>   (failed 도 run:harvested emit) + checkTaskCompletion 과 충돌. 원 run 은 failed 로 harvest 정상,
>   **새 run** 을 같은 task/profile/args 로 생성해 큐에 넣는다. retry 분기는 checkTaskCompletion 보다 먼저.
> - **enqueue 시 effectivePresetId 확정** (SERIOUS Q3): presetId 없으면 spawn 시점에 task.preferred_preset_id
>   를 읽어 drift → enqueue 시점에 effective 값을 계산해 queued_args 에 고정.
> - **claim CAS** (Q4): `markRunStarted` 는 무조건 running update 라 락 아님. spawnQueuedRun 맨 앞에서
>   `UPDATE ... WHERE id=? AND status='queued'` 조건부 전이로 중복 spawn 차단.
> - **boot 단언 완화** (Q1): recoverOrphanSessions 는 `discoverGhostSessions()` 결과만 처리 — 미시작
>   queued(worktree null)는 애초에 안 건드림. 가드 불필요, boot drain 만 추가 (recoverOrphan 이후).

---

## 1. 현재 코드 사실 (설계 입력)

- `createRun` 의 default `status='queued'` (`runService.js`). spawn 후 `markRunStarted` 가 `running` 으로.
- `getRunningCount` = `COUNT(*) WHERE status IN ('queued','running')` (`agentProfileService.js:42`).
  즉 **queued 도 concurrency 에 셈** — 큐를 도입하면 "대기" 가 슬롯을 먹는 모순. 수정 대상.
- `executeTask(taskId, { agentProfileId, prompt, skillPackIds, presetId })`:
  max 체크(`>= max_concurrent` 면 **throw**, `:206-208`) → createRun(queued) → preset/skillpack/preflight
  → `spawnAgent` (`:548` claude / `:651` codex) → `markRunStarted`(`:660`) → return(`:671`).
- 상태머신 (`VALID_TRANSITIONS`): `queued→running,cancelled` / `running→...terminal` /
  **`failed→queued` / `cancelled→queued` / `stopped→queued` (retry 이미 허용)**.
- spawn 인자(`skillPackIds`, `presetId`) 는 run row 에 **저장 안 됨** — queued 재개·retry 의 핵심 난점.
- `getRunningCount` 사용처: `lifecycleService:206` (concurrency), `routes/agents.js:82,88` (UI 표시).
- boot `recoverOrphanSessions`: queued run 을 isAlive 검사 → dead 면 정리 (`:993,999`). 큐 run(worktree 없음)
  은 isAlive=false → 잘못 정리될 수 있음. 처리 필요.

## 2. 목표 (B-lite)

1. **max 도달 시 throw 안 함** — run 을 queued 로 유지하고 즉시 return.
2. **슬롯 비면 FIFO 자동 시작** — run terminal 시 같은 profile 의 가장 오래된 queued run spawn.
3. **failed 1회 자동 재시도** — cancelled/stopped 는 제외 (의도적 중단).

## 3. Lock-in

1. **FIFO only** — priority 정렬 / task 의존성 / 큐 깊이 제한은 비범위 (§5).
2. **재시도 1회, backoff 없음, 새 attempt run** — `MAX_RETRY=1`. failed worker 의 retry 는 **원 run 을
   되돌리지 않고 새 run 을 생성**해 큐에 넣는다 (원 run 은 failed 로 harvest 정상). 무한루프 차단이 목적.
3. **concurrency = running 만** — queued 는 대기지 슬롯 점유 아님. concurrency 판단을 running-only 로
   (Codex Q2: agents.js UI 라벨 "실행 중" 과도 정합 — `countRunning` 자체를 running-only 로 통일).
4. **이벤트 cardinality**: **신규 SSE 채널 0** — `queue:enqueued`/`queue:dequeued`/`queue:retry` 는 SSE
   채널이 아니라 **run event type** (addRunEvent 으로 기록, 기존 `run:event` 로 전달). eventChannels.js
   SERVER_EMITS 수정 불필요. payload `{ profile_id }` 수준 고정.
5. **claim CAS 락** — spawnQueuedRun 진입 즉시 (await 전) `UPDATE runs SET status='running' WHERE
   id=? AND status='queued'`; `changes()===0` 이면 이미 누가 집은 것 → skip. better-sqlite3 동기라
   await 전 CAS 면 run:ended 다발에도 중복 spawn 0.
6. **manager run 제외** — is_manager 는 큐/재시도 대상 아님 (기존 가드 유지).
7. **harvest 불간섭** — retry 는 새 run 이므로 원 run 의 harvest exactly-once 와 독립. retry 분기는
   run:ended 의 harvest 분기·checkTaskCompletion 보다 **먼저** 실행 (task 가 failed 로 튀기 전 새 run 등록).

## 4. 구현 지침

### 4.1 DB — migration 024
```sql
ALTER TABLE runs ADD COLUMN queued_args TEXT;     -- JSON {skillPackIds, presetId(effective)}; NULL이면 빈 인자
ALTER TABLE runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
```
agent_profile_id/prompt/task_id 는 기존 컬럼. queued_args 의 `presetId` 는 **enqueue 시점에 확정한
effective 값** (presetId || task.preferred_preset_id 를 그 순간 계산 — SERIOUS Q3 drift 방지).
`skillPackIds` 는 호출자가 명시한 값. project-auto / task-binding skill pack 은 spawn 시점 재계산 —
이는 즉시 spawn 과 동일 동작이므로 큐 특유 문제 아님 (명시).

### 4.2 `runService`
- `createRun` 에 `queued_args`, `retry_count` 수용 (worker run 생성 시 저장).
- `getRunningCount` (`countRunning`): **running 만** 세도록 변경 (Codex Q2 PASS — UI/concurrency 양쪽 정합).
- queued FIFO 조회: `getOldestQueued(profileId)` = `status='queued' AND agent_profile_id=? AND
  is_manager=0 ORDER BY created_at ASC LIMIT 1`.
- **claimQueuedRun(runId)** (CAS 락): `UPDATE runs SET status='running', started_at=datetime('now')
  WHERE id=? AND status='queued'` → `changes()` 반환. 1 이면 claim 성공, 0 이면 이미 누가 집음.
  (markRunStarted 는 worktree/tmux 채우는 용도로 spawn 후 그대로 — running→running idempotent.)

### 4.3 `lifecycleService` — executeTask 분리
- **`executeTask(taskId, args)`** (진입점, 호출부 시그니처 불변):
  task/profile 검증 → effectivePresetId 확정 → `createRun(queued, queued_args={skillPackIds,
  presetId:effectivePresetId}, retry_count=0)` →
  - `getRunningCount(profileId) < max_concurrent` → `spawnQueuedRun(run.id)` 즉시 → return run
  - 아니면 → queued 유지, `queue:enqueued` event, return run (**throw 제거**)
- **`spawnQueuedRun(runId)`** (신규, executeTask 의 preset~spawn 로직 추출):
  1. **claim**: `claimQueuedRun(runId)` 동기 CAS → 0 이면 즉시 return (중복 spawn 차단, await 전).
  2. run + queued_args 로 인자 복원 → preset/skillpack resolve → MCP preflight → spawnAgent →
     markRunStarted (worktree/tmux 기록).
  3. 실패는 기존 fail-closed 경로 (run failed + cleanup). claim 후 실패해도 retry 대상 (failed terminal).
- **run:ended 구독자** — 순서 **엄수** (BLOCKER Q5):
  ```
  (1) retry 판단:  to_status==='failed' && !is_manager && run.retry_count < MAX_RETRY
        → createRun(같은 task/profile/prompt, queued_args 복사, retry_count=run.retry_count+1, status=queued)
        → queue:retry event.  ※ checkTaskCompletion 보다 먼저 — task 가 failed 로 튀기 전 새 run 등록
  (2) checkTaskCompletion(task_id)   (기존)
  (3) harvest 분기 (completed/failed):  harvestRun(원 run)  (기존, exactly-once — 원 run 만 수확)
  (4) drain:  getRunningCount(profileId) < max_concurrent 인 동안 getOldestQueued → spawnQueuedRun
        (retry 로 새로 든 run 포함. 한 슬롯이지만 루프는 안전망.)
  ```
  retry 의 새 run 은 **원 run 과 별개** → 원 run harvest 와 충돌 0. cancelled/stopped 는 retry 안 함.
  drain/retry 는 health loop 비차단 (동기 or setImmediate).
- **boot**: recoverOrphanSessions 는 ghost session 목록만 처리하므로 미시작 queued 는 안 건드림 (가드 불요).
  `app.js` 의 recoverOrphanSessions **이후** 에 profile 별 `drainQueue` 1회 호출 (재시작 후 대기 큐 재개).

### 4.4 동시성/race (claim CAS 가 핵심)
- 두 run:ended 가 거의 동시 → 각자 drain → getOldestQueued 로 **같은** queued run 을 집을 수 있으나,
  `spawnQueuedRun` 첫 줄 `claimQueuedRun` (동기 CAS, await 없음) 이 먼저 성공한 쪽만 진행, 나머지는
  `changes()===0` 으로 즉시 return. better-sqlite3 동기 실행이라 CAS~다음 getOldestQueued 사이 yield 없음.
- drain 루프의 `getRunningCount` 는 claim 으로 running 이 +1 되므로 슬롯 초과 spawn 없음.

## 5. 비범위 (B-lite 한정)

| 항목 | 이유 |
|---|---|
| 우선순위 큐 (priority 정렬) | FIFO 로 충분. task.priority 연동은 후속 |
| task 의존성 (depends_on) | 별도 기능 |
| 큐 깊이 제한 / backpressure | 단일 운영자, 무제한으로 시작 |
| 재시도 backoff / 지수 / N회 | 1회 즉시. flaky 무한루프 방지가 목적 |
| 전용 큐 UI | runs 목록의 queued status 로 가시. 별도 phase |
| cross-profile 글로벌 큐 | profile 별 독립 큐 |

## 6. 수용 기준

1. max_concurrent 도달 상태에서 execute → run 이 **queued 로 생성되고 throw 안 함**.
2. 실행 중 run 이 terminal 되면 같은 profile 의 가장 오래된 queued 가 **자동 spawn** (FIFO).
3. queued 재개 시 enqueue 시점에 확정된 effective presetId + skillPackIds 로 spawn (drift 없음).
4. failed worker run 은 **새 attempt run 으로 1회 자동 재시도** (retry_count 1 → 2회째 skip).
   원 failed run 은 그대로 남아 harvest 된다 (run:harvested 1회). cancelled/stopped 는 재시도 0.
5. queued 는 concurrency 계산에서 빠진다 (running 만) — 큐가 max 에서 막히지 않음.
6. 같은 queued run 이 **두 번 spawn 되지 않는다** (동시 run:ended → claim CAS 로 한 번만).
7. manager run 은 큐/재시도 대상 아님.
8. retry 새 run 등록이 checkTaskCompletion 보다 먼저라, retry 중 task 가 failed 로 안 튄다.
9. 서버 재시작 후 대기 queued 가 boot drain 으로 재개된다.
10. 전체 `node --test` 그린 + 신규 `queue.test.js`.

## 7. 테스트 지침
- spawn 은 P0 spawn guard 로 테스트 환경에서 차단 → **큐 상태 전이**를 검증 (enqueue/claim/drain/retry).
  spawnQueuedRun 의 실제 spawn 호출은 stub/fake engine, 또는 claim 까지만 검증.
- 케이스: max 도달 enqueue(throw 없음) / terminal 후 FIFO drain / queued_args(effective preset) 복원 /
  **failed → 새 attempt run retry 1회 + 2회째 skip** / **원 run harvest 1회 유지** / cancelled·stopped no-retry /
  **동시 run:ended 2개 → claim CAS 로 중복 spawn 0** / retry 가 checkTaskCompletion 보다 먼저(task 안 튐) /
  manager 제외 / boot drain.
- 회귀: `preset-spawn.test.js` / `manager-lifecycle.test.js` / `harvest.test.js` (executeTask 분리 +
  run:ended 구독자 확장이 기존 harvest/완료 경로 보존하는지).

## 8. 구현 순서
1. migration 024 + runService(createRun queued_args/retry_count, countRunning→running, getOldestQueued, claimQueuedRun CAS)
2. executeTask 분리 → spawnQueuedRun 추출 (claim 으로 시작) — 동작 불변 회귀 그린 유지
3. max 도달 enqueue 분기 (throw 제거) + effectivePresetId 확정 저장
4. run:ended 구독자: retry(새 run, checkTaskCompletion 전) → harvest(기존) → drain 순서
5. app.js boot drain (recoverOrphanSessions 이후)
6. queue.test.js + 검증 (신규 → 회귀 harvest/preset/lifecycle → 전체 --test-concurrency=2)

## 9. Codex r1 spec review 처리 기록

| 판정 | 내용 | r2 처리 |
|---|---|---|
| Q1 부분FAIL | boot 단언 과함 (recoverOrphan 은 ghost session 만 처리) | §4.3 가드 제거, boot drain 만 |
| Q2 PASS | countRunning running-only 정합 | countRunning 자체를 running-only 통일 |
| Q3 SERIOUS | queued_args 가 effective preset 고정 못 함 (task.preferred drift) | enqueue 시 effectivePresetId 확정 저장 |
| Q4 조건부 | claim 은 markRunStarted 아닌 CAS 필요 | claimQueuedRun CAS (spawnQueuedRun 첫 줄, await 전) |
| Q5 BLOCKER | retry-harvest-taskcompletion 순서 충돌 | retry=새 attempt run, checkTaskCompletion 전, 원 run harvest 독립 |
| Q6 조건부 | boot drain 은 recoverOrphan 이후 | §4.3 명시 |
| NIT | queue:* 는 SSE channel 아닌 run event type | §3 lock-in #4 명시 |
