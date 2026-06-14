# T5: 자동 retry ↔ PM auto-review 이중 재시도 de-dupe

> 2026-06-15. Status: **draft r1** (Codex spec review 전)
> 작성: Claude (감독). 구현: Codex. branch: `feat/t5-retry-review-dedupe`
> 배경: 통합 교차리뷰(#191 Q4 계열) — failed worker 를 B-lite(#189) 가 1회 자동 retry 하는데,
> 동시에 H-1.5(#186) PM auto-review 가 PM 에게 "실패, 재시도 판단" 을 보내 PM(LLM)이 또 worker 를
> spawn → **이중 재시도**. 현재 advisory 문구 + circuit breaker 로 완화만. backlog T5.

---

## 1. 현재 코드 사실

- `run:ended` 구독자 순서 (`lifecycleService.js`): **`createRetryRun`(동기)** → `checkTaskCompletion`
  → harvest(`setImmediate` → `run:harvested`). 즉 **run:harvested 발화 시점에 자동 retry run 이 이미
  task 에 생성돼 있다** (queued 또는 drain 으로 running). retry 조건: failed + !is_manager +
  started_at + retry_count < MAX_RETRY(1).
- PM auto-review: `run:harvested` → `sendPmReview({ run, harvestSummary })` (`app.js:150,193`).
  현재 `createPmAutoReview` 에 runService **미주입**.
- `runService.listRuns({ task_id })` → `getByTask` (created_at DESC, `runService.js:172`).

## 2. 목표

failed worker 의 PM review 를, **자동 retry 가 진행 중이면 억제** — 자동 retry 가 1차 대응, PM 은
**retry 의 최종 결과**(성공 → completed review / 최종 실패 → retry 소진 후 review)만 받는다.
→ 이중 재시도(자동 + PM) 차단.

## 3. Lock-in

1. **failed 만 대상**: completed run 의 review 는 불변 (항상). needs_input 무관 (run:harvested 는 terminal).
2. **억제 = 발송 안 함 (+관측 이벤트)**: 억제 시 `pm_review:suppressed`(reason: retry_pending) run event
   + circuit breaker counter **미증가** (발송 안 했으니). 절대 throw 안 함.
3. **최종 결과는 반드시 review**: 자동 retry 가 소진(retry_count=MAX → createRetryRun 안 함)된 failed,
   또는 retry 후 completed → review 정상 발송. PM 이 "영영 안 봄" 은 없음.
4. **decoupled**: sendPmReview 는 lifecycleService retry 내부 로직(MAX_RETRY 상수 등)을 몰라도 됨 —
   "task 에 이 run 외 active(queued/running) worker attempt 가 있나" 만 runService 로 조회.
5. **과억제 허용 범위**: 같은 task 에 동시 실행 worker(max_concurrent>1)도 억제될 수 있으나, task 당 순차가
   기본이라 실질 영향 적음. 정밀 식별(retry attempt only)은 비범위.

## 4. 구현 지침

### 4.1 `app.js` createPmAutoReview
- `createPmAutoReview({ eventBus, managerRegistry, conversationService, runService, ... })` — **runService 주입**.
- 신규 `hasActiveAttempt(run)`:
  - `runService.listRuns({ task_id: run.task_id })` → filter:
    `r.id !== run.id && !r.is_manager && ['queued','running'].includes(r.status)`.
  - 하나라도 있으면 true (자동 retry/재실행 진행 중). runService/listRuns 실패는 catch → false (억제 안 함, 안전).
- `sendPmReview({ run, harvestSummary })` 진입부 (circuit breaker check 전):
  - `const status = harvestSummary?.status || run.status` (failed 판정).
  - **failed 이고 `hasActiveAttempt(run)` true → 억제**: `pm_review:suppressed` run event
    (`{ reason: 'retry_pending' }`) 기록 + return false. counter 미증가.
  - 그 외 → 기존 흐름 (reserve-then-send).
- `app.js` 조립: `createPmAutoReview({ ..., runService })`.

### 4.2 억제 판정 위치
- run:harvested 구독자가 sendPmReview 호출. 억제는 sendPmReview 내부 (단일 지점).
- run:harvested 시점에 retry run 이 존재함은 §1 (createRetryRun 동기 선행) 으로 보장 → 조회 race 없음
  (단일 스레드, createRetryRun → setImmediate harvest → run:harvested 순).

## 5. 비범위
| 항목 | 이유 |
|---|---|
| spawn 측 backend de-dupe (PM 의 worker spawn 거부) | review 측 억제로 충분 (PM 이 애초에 review 안 받음) |
| retry attempt 정밀 식별 (동시 실행과 구분) | task 순차 기본. 과억제 영향 적음 |
| completed/needs_input 변경 | failed 만 대상 |
| 자동 retry 횟수 조정 (MAX_RETRY) | 별개 |

## 6. 수용 기준
1. failed worker 가 자동 retry 를 유발(started_at + retry_count<MAX) → 그 run 의 PM review **억제**
   (`pm_review:suppressed` + 발송 0).
2. retry run 이 또 실패(retry_count=MAX → 새 retry 없음) → 그 run 은 review **발송** (최종 실패 통지).
3. retry run 이 completed → completed review 정상 (이중 아님).
4. 억제된 run 은 circuit breaker counter 를 안 올린다.
5. failed 인데 active attempt 없음(수동 failed/미실행 등) → 기존 review.
6. completed run → 항상 review (불변).
7. runService 조회 실패 → 억제 안 함(기존 review), never-throws.
8. 전체 `node --test` 그린 + PM auto-review 테스트(harvest.test) 확장.

## 7. 테스트 지침
- harvest.test 의 `makeAutoReviewHarness` 에 fake runService(listRuns 주입) 추가.
- 케이스: failed + active retry attempt 존재 → 억제(suppressed event, sent 0, counter 0) /
  failed + active 없음 → 발송 / completed + active 있어도 → 발송(failed 아님) /
  retry 소진 failed(active 없음) → 발송 / listRuns throw → 발송(never-throws) /
  억제 후 다른 run 정상.
- 통합(queue.test 또는 harvest.test): 실제 lifecycleService createRetryRun → run:harvested → 억제 경로.

## 8. 구현 순서
1. createPmAutoReview runService 주입 + hasActiveAttempt + sendPmReview 억제 분기
2. app.js 조립 runService 전달
3. harvest.test PM auto-review 케이스 확장 (fake runService)
4. 검증: harvest.test → 회귀(queue/app) → 전체 --test-concurrency=2
