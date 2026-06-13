# B-lite: 경량 워커 큐 + 자동 재시도

> 2026-06-14. Status: **draft r1** (Codex spec review 전)
> 작성: Claude (감독). 구현: Codex. branch: `feat/b-lite-queue`
> 배경: 컨셉 리뷰에서 "오케스트레이션 부재" 로 지목 — `max_concurrent` 도달 시 `executeTask` 가
> throw 하고 사용자가 수동 재시도. 큐/자동시작/재시도 없음. "허브가 직렬화 책임을 져야 한다."

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
2. **재시도 1회, backoff 없음** — `MAX_RETRY=1`, 즉시 재큐. 무한루프 차단이 목적.
3. **concurrency = running 만** — queued 는 대기지 슬롯 점유 아님. `getRunningCount` 를 running 만 세도록.
4. **이벤트 cardinality**: 신규 SSE 채널 0. run event 타입 `queue:enqueued` / `queue:dequeued` /
   `queue:retry` 만 (run:status 는 기존대로 emit). payload `{ profile_id, position? }` 수준 고정.
5. **spawn 동시성 가드** — run:ended 다발 시 같은 queued run 이 두 번 spawn 되지 않도록 status 전이로 락
   (queued→running 은 단일 트랜잭션, 이미 running 이면 skip).
6. **manager run 제외** — is_manager 는 큐/재시도 대상 아님 (기존 가드 유지).

## 4. 구현 지침

### 4.1 DB — migration 024
```sql
ALTER TABLE runs ADD COLUMN queued_args TEXT;     -- JSON {skillPackIds, presetId}; NULL이면 빈 인자
ALTER TABLE runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
```
agent_profile_id/prompt/task_id 는 기존 컬럼 재사용. queued_args 는 **그 외 spawn 인자만** 보존.

### 4.2 `runService`
- `createRun` 에 `queued_args` 수용 (worker run 생성 시 `JSON.stringify({skillPackIds, presetId})` 저장).
- `getRunningCount` (또는 신규 `getActiveCount`): **running 만** 세도록 변경. agents.js UI 영향 검토 —
  표시 의미가 "실행 중" 이면 정합. (queued 별도 표시가 필요하면 `getQueuedCount` 추가는 선택.)
- queued FIFO 조회: `getOldestQueued(profileId)` = `status='queued' AND agent_profile_id=? AND
  is_manager=0 ORDER BY created_at ASC LIMIT 1`.

### 4.3 `lifecycleService` — executeTask 분리
- **`executeTask(taskId, args)`** (진입점, 호출부 시그니처 불변):
  task/profile 검증 → `createRun(queued, queued_args=args)` →
  - `getRunningCount(profileId) < max_concurrent` → `spawnQueuedRun(run.id)` 즉시 (기존 동작) → return run
  - 아니면 → queued 유지, `queue:enqueued` 이벤트, return run (**throw 제거**)
- **`spawnQueuedRun(runId)`** (신규, executeTask 의 preset~spawn~markRunStarted 로직 추출):
  run + queued_args 로 인자 복원 → preset/skillpack resolve → MCP preflight → spawnAgent → markRunStarted.
  실패는 기존 fail-closed 경로 그대로 (run failed + cleanup).
- **run:ended 구독자 (harvest 옆)**: worker terminal 시
  - **drain**: `getRunningCount(profileId) < max_concurrent` 인 동안 `getOldestQueued(profileId)` →
    `spawnQueuedRun`. (한 슬롯만 비므로 보통 1개, 루프는 안전망.)
  - **retry**: `to_status==='failed'` AND `retry_count < MAX_RETRY` AND worker →
    `retry_count++` + status `failed→queued` (force) + `queue:retry` 이벤트 → drain 이 자동 재시작.
    cancelled/stopped 는 재시도 안 함.
  - 순서: harvest(setImmediate) 와 독립. drain/retry 는 동기 또는 setImmediate, health loop 비차단.
- **boot**: `recoverOrphanSessions` 가 worktree/tmux 없는 queued run 을 dead 로 오인 정리하지 않도록
  가드 (queued + worktree_path null 이면 "미시작 큐" 로 보존). startup 말미에 profile 별 drain 1회 호출
  (서버 재시작 후 대기 큐 자동 재개).

### 4.4 동시성/race
- queued→running 전이는 `spawnQueuedRun` 진입 직후 단일 지점에서 (이미 running 이면 즉시 return — 중복 spawn 차단).
- drain 루프는 getOldestQueued → spawn 을 순차. 두 run:ended 가 거의 동시면 각자 drain 시도하나,
  queued→running 락으로 한 run 은 한 번만 spawn.

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
3. queued 재개 시 원래 skillPackIds/presetId 가 보존돼 동일하게 spawn 된다.
4. failed worker run 은 **1회 자동 재시도** (retry_count 1 → 더는 재시도 안 함). cancelled/stopped 는 재시도 0.
5. queued 는 concurrency 계산에서 빠진다 (running 만) — 큐가 max 에서 막히지 않음.
6. 같은 queued run 이 **두 번 spawn 되지 않는다** (동시 run:ended race 테스트).
7. manager run 은 큐/재시도 대상 아님.
8. 서버 재시작 후 대기 queued 가 정리되지 않고 drain 으로 재개된다.
9. 전체 `node --test` 그린 + 신규 `queue.test.js`.

## 7. 테스트 지침
- spawn 은 P0 spawn guard 로 테스트 환경에서 차단됨 → executeTask/spawnQueuedRun 의 **큐 상태 전이**를
  검증 (실제 spawn 은 guard 가 막으니, spawn 직전까지의 enqueue/dequeue/retry 로직을 단위 검증).
  fake executionEngine 또는 spawnQueuedRun 의 spawn 호출을 stub.
- 케이스: max 도달 enqueue / terminal 후 FIFO drain / queued_args 복원 / failed retry 1회 + 2회째 skip /
  cancelled·stopped no-retry / 동시 run:ended 중복 spawn 방지 / manager 제외 / boot drain.
- 기존 `preset-spawn.test.js` / `manager-lifecycle.test.js` 회귀 (executeTask 분리가 기존 경로 보존하는지).

## 8. 구현 순서
1. migration 024 + runService(createRun queued_args, getRunningCount→running, getOldestQueued)
2. executeTask 분리 → spawnQueuedRun 추출 (동작 불변 회귀 그린 유지)
3. max 도달 enqueue 분기 (throw 제거)
4. run:ended drain + retry
5. boot drain + recoverOrphan 가드
6. queue.test.js + 검증 (신규 → 회귀 → 전체 --test-concurrency=2)
