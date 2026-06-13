# H-1.5: Harvest → PM auto-review 연결 (자율 루프 폐쇄)

> 2026-06-13. Status: **draft r1** (Codex spec review 전)
> 작성: Claude (감독). 구현: Codex. branch: `feat/h1-5-harvest-pm-review`
> 배경: 운영 DB 조회 결과 이 허브는 5주간 정지 (worker run 4월 43 → 5월 1). 근본 원인은
> "위임하고 잊을 수 없음" = 자율 루프의 마지막 판단 고리 단절. H-1 이 산출물 수확(diff/test)을
> 만들었으나, 그 결과가 자율 루프의 의사결정자인 PM 에게 전달되지 않는다.

---

## 1. 문제 (코드 사실)

`server/app.js` 에 **PM auto-review 가 이미 존재**한다 (Codex 발견):
- `run:completed` 구독 → 활성 PM 이 있는 프로젝트면 worker 결과를 PM 에게 전송 → PM 이 자율적으로
  리뷰하고 task done / 재지시 / escalate 판단. circuit breaker `AUTO_REVIEW_MAX=5`, counter rollback,
  `setImmediate` defer ("previous turn still running" 회피).

그러나 두 가지 결함:
1. **검증 결과 미전달**: review 메시지는 status/exit_code/result_summary 만 주고, harvest 가 만든
   diff(파일/커밋) 와 test 통과/실패를 **요약해 넣지 않는다**. "GET /api/runs/{id}/events 로 직접 봐라"
   고 PM 에게 떠넘긴다. PM 이 검증되지 않은 정보로 판정.
2. **타이밍**: harvest 는 `run:ended` 뒤 `setImmediate` 비동기로 돈다 (`lifecycleService` run:ended
   구독자). PM auto-review 는 `run:completed` 에 즉시 반응 → review 발송 시점에 `harvest:diff`/
   `harvest:test` 가 아직 기록 안 됐을 수 있다.
3. **failed 누락**: 구독이 `run:completed` 뿐이라 failed worker run 은 review 를 못 받는다
   (주석은 "completes/fails" 라 하지만 코드는 completed 만).

## 2. 목표

worker terminal → harvest(autosave→diff→test) **완료 후**, diff/test 요약을 PM auto-review 메시지에
**직접 주입**한다. PM 이 "워커가 N파일/M커밋 바꿨고 테스트 통과/실패" 를 별도 fetch 없이 보고 판정.
→ worker 완료 → 자동 수확·검증 → PM 자율 판정의 **자율 루프 폐쇄**.

## 3. 설계

### 3.1 신규 eventBus 채널 `run:harvested` (서버 내부 전용)

- `eventChannels.js` 의 `SERVER_EMITS` 에 추가. **`CLIENT_REQUIRED_LIVE` 에는 넣지 않는다**
  (클라 미구독 — RunInspector 는 기존 `harvest:diff` 이벤트 polling 으로 봄). 따라서
  `public/app/lib/hooks/sse.js` channels 배열 수정 **불필요**. (sse-channels.test.js 가 SERVER_EMITS
  를 검증하므로 거기에만 추가.)
- payload: `{ run, summary }` where
  `summary = { files: number, commits: number, statText: string(≤500), test: { passed, timed_out, exit_code, duration_ms, output_tail: string(≤500) } | null, errors: string[] }`
  (errors = harvest:error 단계명 배열, 예 `['test']`).

### 3.2 `harvestService` — eventBus 주입 + emit 보장

- `createHarvestService({ ..., eventBus })` 주입 (app.js 에서 전달).
- **emit 계약 (lock)**: `harvestRun` 은 **review 가 필요한 terminal worker run** (worker +
  `worktree_path` + `branch` + status ∈ {completed, failed}, is_manager 아님) 에 대해,
  harvest 작업의 성공·실패·중단과 무관하게 **정확히 1회** `run:harvested` 를 emit 한다.
  - worktree-gone gate (H-1 에서 추가한 `!fs.existsSync` early return) 케이스도 emit 한다
    (summary.errors=['worktree_missing'], test=null) — 안 그러면 run:completed 에서 skip 된 run 이
    영영 review 를 못 받는 hole 발생.
  - **dedupe early return** (seenRunIds / 기존 DB harvest 이벤트) 만 emit 예외 — 이미 첫 호출에서 emit·review 됨.
  - is_manager / non-terminal early return 은 emit 안 함 (애초에 review 대상 아님).
- summary 는 harvestRun 이 내부에서 이미 계산한 diff/test 결과를 모아서 구성. emit 은 cleanup(removeWorktree) **후**.

### 3.3 PM auto-review 재배선 (`server/app.js`)

현재 단일 `run:completed` 구독자를 다음으로 재구성. **공통 review 발송 로직을 헬퍼로 추출**
(circuit breaker check + 메시지 빌드 + setImmediate defer + counter rollback — 기존 동작 그대로):

```
function sendPmReview({ run, status, harvestSummary }) { ...기존 로직 + harvestSummary 섹션... }
```

- **`run:completed` 구독자 (수정)**: worker run 에 대해
  - harvest 대상이면 (worktree_path + branch 있음) → **skip** (run:harvested 가 처리할 것)
  - harvest 비대상이면 (worktree 없음) → `sendPmReview({ run, status, harvestSummary: null })` (기존 동작)
- **`run:harvested` 구독자 (신규)**: `sendPmReview({ run, status: run.status, harvestSummary: summary })`.
  - failed run 도 여기로 들어옴 → failed review 자동 커버 (결함 #3 해소).

review 메시지 빌드에 harvestSummary 가 있으면 추가:
```
  [harvest] files: N, commits: M
  [harvest] test: PASS|FAIL|TIMEOUT (exit C, Dms)
  <statText 일부>
  <test output_tail 일부, 있으면>
```
없으면 (worktree 없는 run) 기존 메시지 그대로.

### 3.4 중복 발송 방지 (핵심 불변식)

한 run 은 PM review 를 **정확히 1회** 받는다:
- harvest 대상 run: run:completed(skip) + run:harvested(send) = 1회
- worktree 없는 run: run:completed(send) + run:harvested 안 옴 = 1회
- 두 경로의 "harvest 대상" 판정 기준은 동일해야 함: `!run.is_manager && run.worktree_path && run.branch`.
  (run:completed 의 status 는 completed, run:harvested 는 completed/failed.)

## 4. Lock-in

1. circuit breaker (`AUTO_REVIEW_MAX=5`), per-(project,task) counter, **counter 는 send 성공 후에만 증가**
   (rollback 보존), `setImmediate` defer, onSlotCleared counter reset — **전부 보존**.
2. 한 run = review 정확히 1회 (§3.4). 중복/누락 금지.
3. `run:harvested` 는 서버 내부 전용 — SSE 클라 노출 안 함, sse.js channels 미수정.
4. harvest summary 주입은 capped (statText/output_tail 각 ≤500자) — review 메시지 비대화 방지.
5. PM 없는 프로젝트 / pmRunId 없음 → 기존처럼 발송 안 함 (early return 보존).
6. 이벤트 cardinality: 신규 채널 1개(`run:harvested`)만. harvest:diff/test/error 3종은 불변 (H-1 lock).

## 5. 비범위

| 항목 | 이유 | 후속 |
|---|---|---|
| PM 판정 결과로 task status 자동 변경 검증 | PM 이 자율적으로 API 호출 — 기존 동작, 본 phase 는 입력(요약)만 개선 | 관측 후 |
| harvest summary 를 RunInspector UI 에도 표시 | 이미 H-1 Harvest 섹션이 diff/test 표시 중 | — |
| webhook 등 외부 알림 | needs_input 실측 0건 — 루프 돌기 시작 후 | 별도 (C) |
| failed run 의 재시도 정책 | PM 자율 판단에 위임 | B-lite |

## 6. 수용 기준

1. worktree 있는 completed worker run → harvest 후 PM 이 받는 review 메시지에 diff(파일/커밋) +
   test 결과가 포함된다.
2. worktree 없는 worker run → 기존대로 즉시 review (harvest 요약 없음), **정확히 1회**.
3. 한 run 에 대해 PM review 가 **중복 발송되지 않는다** (run:completed + run:harvested 동시 케이스 테스트).
4. failed worker run 도 harvest 후 review 를 받는다 (기존 누락 해소).
5. harvest 가 실패해도 (errors 채워짐) run:harvested 는 emit 되고 PM 은 "검증 실패" 를 안다.
6. circuit breaker 5회 / counter rollback / PM 없으면 미발송 — 전부 보존.
7. worktree-gone 케이스도 review 가 누락되지 않는다 (run:harvested emit 보장).
8. 전체 `node --test` 그린 + 신규/확장 테스트. UI 무변경이므로 visual 불요 (변경 시에만).

## 7. 테스트 지침

- app.js 의 PM auto-review 는 통합이 무거우므로, **review 트리거 로직을 테스트 가능한 단위로** 다룬다:
  헬퍼(`sendPmReview`) 또는 eventBus 구독 배선을 가짜 `conversationService`(sendMessage 호출 capture) +
  가짜 `managerRegistry`(getActiveRunId 고정) 로 구동. 기존 `harvest.test.js` / `conversation.test.js` 패턴 참고.
- 케이스: (a) harvest 대상 run → run:completed skip + run:harvested 에서 1회 발송 + 메시지에 diff/test 포함,
  (b) worktree 없는 run → run:completed 에서 1회, (c) 중복 없음, (d) failed run review,
  (e) circuit breaker 5회 후 skip, (f) PM 없으면 미발송, (g) harvest emit 계약 (worktree-gone 도 emit,
  dedupe 는 미emit), (h) summary cap (≤500자).
- harvestService emit 단위 테스트: `run:harvested` payload shape + emit 1회 보장.

## 8. 구현 순서 제안

1. eventChannels `run:harvested` 추가 + sse-channels.test 통과 확인
2. harvestService eventBus 주입 + emit 계약 구현 + 단위 테스트
3. app.js sendPmReview 헬퍼 추출 (리팩터, 동작 불변 — 기존 테스트 그린 유지)
4. run:completed 구독자 skip 분기 + run:harvested 구독자 신규
5. 통합/단위 테스트 작성
6. 검증: 신규 테스트 → 회귀(harvest/conversation/manager) → 전체 --test-concurrency=2
