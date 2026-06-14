# T5: 자동 retry ↔ PM auto-review 이중 재시도 de-dupe

> 2026-06-15. Status: **r2 READY** (Codex r1 spec review 반영 — SERIOUS Q3 + NIT Q4/Q5)
> 작성: Claude (감독). 구현: Codex. branch: `feat/t5-retry-review-dedupe`
> 배경: 통합 교차리뷰(#191 Q4 계열) — failed worker 를 B-lite(#189) 가 1회 자동 retry 하는데,
> 동시에 H-1.5(#186) PM auto-review 가 PM 에게 "실패, 재시도 판단" 을 보내 PM(LLM)이 또 worker 를
> spawn → **이중 재시도**. 현재 advisory 문구 + circuit breaker 로 완화만. backlog T5.
>
> **r2 핵심 변경 (Codex r1 Q3)**: r1 의 hasActiveAttempt(task 의 *임의* active worker) 는 **최종 retry
> failed 도 억제** → PM 이 영영 못 봄 (재발송 큐 없음). r2 는 억제를 **"이 run 보다 retry_count 가 높은
> active attempt 가 있을 때"** 로 한정. retry run 은 `retry_count = 원+1` 이므로:
> - 원 run(rc=0) → retry(rc=1) active, `1>0` → 억제 (자동 retry 1차 대응)
> - retry run(rc=1) failed → task 에 rc>1 active 없음 → **review (최종 통지)** — hole 0
> - 동시 실행(같은 rc) → `>` false → 억제 안 함 (Q2 false-positive 제거)
> → maxRetry 상수 공유 불필요 + Q2(과억제)+Q3(최종 hole) 동시 해소. suppressed event 도 try/catch(Q4),
>   runService 미주입 → false(Q5).

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
2. **억제 조건 = "더 높은 retry_count 의 active attempt 존재"**: failed run 의 task 에, 이 run 보다
   `retry_count` 가 **큰** active(queued/running) non-manager worker run 이 있으면 억제. retry run 의
   retry_count 단조 증가로 "이 failed 의 자동 retry 가 진행 중" 을 정확히 식별 (maxRetry 상수 불요).
3. **최종 결과는 반드시 review (hole 0)**: 최종 retry failed(rc=MAX)는 task 에 더 높은 rc active 가
   없으므로 review 발송. 동시 실행/같은 rc/수동 재실행은 억제 안 함 (Q2 false-positive 제거).
4. **억제 = 발송 안 함 (+관측)**: `pm_review:suppressed`(reason: retry_pending) run event +
   circuit breaker counter **미증가**. addRunEvent 도 try/catch (never-throws, Q4).
5. **decoupled + 안전 fallback**: sendPmReview 는 lifecycleService 내부 몰라도 됨. runService 미주입/
   listRuns 실패 → hasHigherRetryAttempt false → **억제 안 함**(기존 review, 안전. Q5).

## 4. 구현 지침

### 4.1 `app.js` createPmAutoReview
- `createPmAutoReview({ eventBus, managerRegistry, conversationService, runService, ... })` — **runService 주입**.
- 신규 `hasHigherRetryAttempt(run)`:
  - runService 없으면 `return false` (Q5 안전 fallback, 기존 테스트 호환).
  - try: `runService.listRuns({ task_id: run.task_id })` → some:
    `r.id !== run.id && !r.is_manager && ['queued','running'].includes(r.status) &&
     Number(r.retry_count || 0) > Number(run.retry_count || 0)`.
  - catch → false (억제 안 함, never-throws).
- `sendPmReview({ run, harvestSummary })` 진입부 (circuit breaker check 전):
  - `const status = harvestSummary?.status || run.status`.
  - **`status === 'failed'` 이고 `hasHigherRetryAttempt(run)` → 억제**:
    `try { runService.addRunEvent(run.id, 'pm_review:suppressed', JSON.stringify({ reason:
    'retry_pending' })) } catch {}` (Q4) + `return false`. counter 미증가, sendMessage 안 함.
  - 그 외 → 기존 흐름 (reserve-then-send).
- `app.js` 조립: `createPmAutoReview({ ..., runService })`.

### 4.2 억제 판정 위치 + 타이밍
- run:harvested 구독자가 sendPmReview 호출. 억제는 sendPmReview 내부 (단일 지점, breaker 전단 → race 없음).
- run:harvested 시점에 retry run(rc=원+1, queued)이 존재함은 §1 (createRetryRun 동기 선행 → setImmediate
  harvest → run:harvested) 으로 보장. drain 으로 running 됐어도 retry_count 유지 → 조회됨.

## 5. 비범위
| 항목 | 이유 |
|---|---|
| spawn 측 backend de-dupe (PM 의 worker spawn 거부) | review 측 억제로 충분 (PM 이 애초에 review 안 받음) |
| retry attempt 정밀 식별 (동시 실행과 구분) | task 순차 기본. 과억제 영향 적음 |
| completed/needs_input 변경 | failed 만 대상 |
| 자동 retry 횟수 조정 (MAX_RETRY) | 별개 |

## 6. 수용 기준
1. 원 failed(rc=0) + task 에 retry run(rc=1, queued/running) → 원 run review **억제**
   (`pm_review:suppressed` + 발송 0 + counter 0).
2. 최종 retry failed(rc=1) + task 에 rc>1 active 없음 → **발송** (최종 실패 통지, hole 0).
3. retry completed → completed review 정상.
4. **동시 실행/같은 rc**(false-positive) → 억제 안 함 (`>` 비교).
5. failed + active attempt 없음(수동/미실행) → 발송.
6. completed run → 항상 발송 (불변).
7. runService 미주입/listRuns throw/addRunEvent throw → never-throws (억제 안 하거나 event 삼킴).
8. 억제는 circuit breaker counter 안 올림.
9. 전체 `node --test` 그린 + PM auto-review 테스트(harvest.test) 확장.

## 7. 테스트 지침
- `makeAutoReviewHarness` 에 fake `runService`(listRuns 주입, addRunEvent capture) 추가. 미주입 시 false.
- 케이스: failed rc0 + active rc1 → 억제(suppressed, sent 0, counter 0) / 최종 failed rc1 + active rc≤1
  없음 → 발송 / completed + active → 발송(failed 아님) / 동시실행 같은 rc → 발송(false-positive 0) /
  active 없음 → 발송 / listRuns throw → 발송(never-throws) / addRunEvent throw → 억제 유지 throw 0 /
  runService 미주입 → 발송(기존 호환).
- 통합(harvest.test): 실제 createPmAutoReview + fake runService 로 run:harvested → 억제/발송 분기.

## 8. 구현 순서
1. createPmAutoReview runService 주입 + hasHigherRetryAttempt(rc 비교) + sendPmReview 억제 분기 + suppressed event try/catch
2. app.js 조립 runService 전달
3. harvest.test PM auto-review 케이스 확장 (fake runService, rc 시나리오)
4. 검증: harvest.test → 회귀(queue/app/lifecycle) → 전체 --test-concurrency=2

## 9. Codex r1 spec review 처리 기록
| 판정 | 내용 | r2 |
|---|---|---|
| Q1 PASS | 타이밍 정확 (createRetryRun 동기 선행 → run:harvested 시 retry 존재) | 유지 |
| Q2 PASS(한정) | active attempt 가 retry 정확 식별 못 함 (동시실행 false-positive) | rc> 비교로 정밀 식별 |
| Q3 SERIOUS | "반드시 review" 가 과억제와 충돌 (최종 failed 억제 hole) | rc> 한정 → 최종(rc=MAX)은 더 높은 rc 없어 발송 |
| Q4 NIT | suppressed addRunEvent throw 가능 | try/catch |
| Q5 NIT | runService 미주입 호환 | 미주입 → false(발송) |
