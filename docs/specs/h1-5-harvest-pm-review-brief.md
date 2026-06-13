# H-1.5: Harvest → PM auto-review 연결 (자율 루프 폐쇄)

> 2026-06-13. Status: **r2 READY** (Codex r1 spec review 반영 — Q1/Q2/Q3 FAIL + BLOCKER 해소)
> 작성: Claude (감독). 구현: Codex. branch: `feat/h1-5-harvest-pm-review`
> 배경: 운영 DB 조회 결과 이 허브는 5주간 정지 (worker run 4월 43 → 5월 1). 근본 원인은
> "위임하고 잊을 수 없음" = 자율 루프의 마지막 판단 고리 단절. H-1 이 산출물 수확(diff/test)을
> 만들었으나, 그 결과가 자율 루프의 의사결정자인 PM 에게 전달되지 않는다.
>
> **r2 핵심 변경**: r1 의 "두 채널(run:completed + run:harvested) 분산" 설계가 review 누락 hole 을
> 만든다는 Codex 지적(Q1/Q2) 을 받아, **PM review 트리거를 `run:harvested` 단일 채널로 통일**.
> 근거(코드 확정): `runService.updateRunStatus` 가 모든 terminal 전환(completed/failed/cancelled/
> stopped)에서 `run:ended` 를 emit (`runService.js:274`) — tmux/streamJson 경로 무관한 **단일·완전
> 신호**. 반면 `run:completed`(tmux only) / `run:result`(streamJson only) 는 경로마다 제각각이라
> review 트리거로 부적합. r1 의 결함 #3("failed 누락") 도 부정확 — tmux failed 는 run:completed 채널로
> 오고 streamJson failed 는 run:result 로 와서 **혼재**가 진짜 문제였음.

---

## 1. 문제 (코드 사실)

`server/app.js` 에 **PM auto-review 가 이미 존재**한다 (Codex 발견):
- `run:completed` 구독 → 활성 PM 이 있는 프로젝트면 worker 결과를 PM 에게 전송 → PM 이 자율적으로
  리뷰하고 task done / 재지시 / escalate 판단. circuit breaker `AUTO_REVIEW_MAX=5`, counter rollback,
  `setImmediate` defer ("previous turn still running" 회피).

그러나 결함:
1. **검증 결과 미전달**: review 메시지는 status/exit_code/result_summary 만 주고, harvest 가 만든
   diff(파일/커밋) 와 test 통과/실패를 **요약해 넣지 않는다**. "GET /api/runs/{id}/events 로 직접 봐라"
   고 PM 에게 떠넘긴다. PM 이 검증되지 않은 정보로 판정.
2. **타이밍**: harvest 는 `run:ended` 뒤 `setImmediate` 비동기로 돈다 (`lifecycleService` run:ended
   구독자). PM auto-review 는 `run:completed` 에 즉시 반응 → review 발송 시점에 `harvest:diff`/
   `harvest:test` 가 아직 기록 안 됐을 수 있다.
3. **트리거 채널 혼재** (Codex r1 Q3 확정): `run:completed` 는 tmux 경로만 emit (status 무관),
   streamJson 워커 실패는 `run:result` 로만 온다 (`streamJsonEngine.js:450`). 즉 현재 PM review 는
   streamJson 워커 결과를 일부 놓친다. 신뢰 가능한 단일 신호는 `run:ended` 뿐.

## 2. 목표

worker terminal → harvest(autosave→diff→test) **완료 후**, diff/test 요약을 PM auto-review 메시지에
**직접 주입**한다. PM 이 "워커가 N파일/M커밋 바꿨고 테스트 통과/실패" 를 별도 fetch 없이 보고 판정.
→ worker 완료 → 자동 수확·검증 → PM 자율 판정의 **자율 루프 폐쇄**.

## 3. 설계

### 3.1 신규 eventBus 채널 `run:harvested` (PM review 단일 트리거)

- `eventChannels.js` 의 `SERVER_EMITS` 에 추가 (문서화/일관성 — Codex r1 Q5: sse-channels.test 가
  server-emit 누락은 강제 안 하지만, list 정합성 위해 추가). **`CLIENT_REQUIRED_LIVE` / `sse.js`
  channels 에는 넣지 않는다** (프론트 미구독 — RunInspector 는 기존 `harvest:diff` polling 으로 봄).
  단 표현 주의: `/api/events` 가 모든 eventBus 이벤트를 SSE 로 흘리므로 (`routes/events.js:42`)
  "서버 내부 전용" 이 아니라 "프론트 미구독" 이 정확.
- payload: `{ run, summary }` where
  `summary = { files: number, commits: number, statText: string(≤500), test: { passed, timed_out, exit_code, duration_ms, output_tail: string(≤500) } | null, errors: string[], harvested: boolean }`
  (errors = harvest:error 단계명 배열; harvested=false 면 diff/test 없이 status 만 — worktree/projectDir 부재 케이스).

### 3.2 `harvestService` — eventBus 주입 + emit 계약 (BLOCKER 해소)

r1 의 hole(Codex Q1/Q2): `run:completed` skip 기준(worktree+branch)과 실제 harvest 진입 기준
(추가로 `resolveProjectDirForRun` 성공)이 어긋나 review 가 누락되는 경로들이 있었다
(`lifecycleService.js:1055/1061`, harvestRun 의 `!resolvedProjectDir`/worktree-gone early-return).
**해결: PM review 를 `run:harvested` 단일 트리거로 통일하고, harvestRun 이 review 대상 run 에
대해 항상 emit 하도록 보장한다.**

- `createHarvestService({ ..., eventBus })` 주입.
- **emit 계약 (lock)**: `harvestRun` 은 **review 대상 worker run** (= `run.id` 있음 +
  `!is_manager` + status ∈ {completed, failed}) 에 대해, harvest 작업의 성공·실패·worktree 유무·
  projectDir 해결 여부와 **무관하게 정확히 1회** `run:harvested` 를 emit 한다.
  - worktree 있고 projectDir 해결됨 → 정상 harvest (autosave→diff→test→remove) 후 summary 채워 emit
    (`harvested: true`).
  - worktree 없음 / projectDir 미해결 / worktree-gone → harvest 작업은 skip, `summary={files:0,
    commits:0, statText:'', test:null, errors:[<사유>], harvested:false}` 로 emit. (예: errors=
    ['no_worktree'] / ['no_project_dir'] / ['worktree_missing'].)
  - **dedupe**(seenRunIds in-memory + 기존 DB `harvest:diff`/`harvest:error` 존재) 만 emit 예외.
    재시작 후 boot 경로는 harvest 를 재호출하지 않으므로(H-1: boot 은 stale worktree cleanup 만)
    런타임 중 1회 보장으로 충분. (극단: harvest:diff 기록 직후·emit 직전 크래시 시 재시작 후 미emit
    — B-lite 로 수용, §5.)
  - is_manager / non-terminal(`cancelled`/`stopped`/그 외) / `!run.id` 는 emit 안 함 (review 대상 아님).
    cancelled/stopped worker run 은 기존 동기 cleanup 경로 유지 (변경 없음).
- summary 는 harvestRun 내부에서 이미 계산한 diff/test 결과를 모아 구성. emit 은 cleanup 후(worktree
  있는 경우) 또는 즉시(없는 경우).

### 3.3 `lifecycleService` run:ended 구독자 — 진입 조건 확대

현재 harvest 분기는 `completed/failed + worktree + branch + projectDir 해결` 일 때만 harvestRun 호출
(`:1055-1069`). 이걸 **review 대상 worker run(`completed/failed` + `!is_manager`)이면 worktree/
projectDir 유무와 무관하게 항상 `harvestService.harvestRun(run, { projectDir })` 호출**로 확대.
(projectDir 해결 실패해도 harvestRun 에 넘기고, harvestRun 이 §3.2 대로 emit-only 처리.)
- cancelled/stopped 는 기존 동기 cleanup 그대로 (harvest 안 탐).
- harvest 는 여전히 `setImmediate` 비차단. cleanup 은 harvestRun 내부가 수행(worktree 있을 때).
- worktree 없는 worker run 도 이제 harvestRun 을 거치지만, 정리할 worktree 가 없으므로 emit 만 하고
  기존 runtime-files cleanup 은 lifecycleService 가 계속 담당 (현 구조 유지).

### 3.4 PM auto-review 재배선 (`server/app.js`)

- **`run:completed` 구독자 → 제거** (또는 PM review 로직 제거). PM review 트리거는 `run:harvested` 단일.
- **공통 발송 로직 헬퍼 추출** (`sendPmReview({ run, harvestSummary })`): circuit breaker check +
  메시지 빌드 + `setImmediate` defer + counter rollback — **기존 동작 그대로 보존**.
- **`run:harvested` 구독자 (신규)**: `sendPmReview({ run, harvestSummary: summary })`.
  모든 review 대상 worker run(tmux/streamJson/completed/failed)이 단일 경로로 수렴 → 누락·중복 0.
- review 메시지: harvestSummary.harvested=true 면 추가
  ```
    [harvest] files: N, commits: M
    [harvest] test: PASS|FAIL|TIMEOUT (exit C, Dms)   // test 있을 때
    <statText 일부> / <output_tail 일부>
  ```
  harvested=false 면 기존 메시지 + `[harvest] 수집 불가 (사유)` 1줄.

### 3.5 중복/누락 0 불변식 (핵심)

- **단일 트리거**: PM review 는 오직 `run:harvested` 에서. `run:completed`/`run:result` 는 더 이상
  review 안 함 → 두 채널 동시 발화로 인한 중복 원천 제거.
- **누락 0**: 모든 review 대상 worker run 은 `run:ended`(완전 신호) → harvestRun → `run:harvested`
  (항상 1회 emit) → review 1회. worktree/projectDir 부재도 emit 되므로 hole 없음.
- counter 는 send 성공 후에만 증가(rollback 보존) — 단일 트리거라 per-run exactly-once 가 구조적으로 성립.

## 4. Lock-in

1. circuit breaker (`AUTO_REVIEW_MAX=5`), per-(project,task) counter, **counter 는 send 성공 후에만 증가**
   (rollback 보존), `setImmediate` defer, onSlotCleared counter reset — **전부 보존**.
2. 한 run = review 정확히 1회 (§3.5). 단일 트리거(`run:harvested`)로 구조적 보장.
3. `run:harvested` 는 프론트 미구독 — `CLIENT_REQUIRED_LIVE`/sse.js channels 미수정 (SERVER_EMITS 만 추가).
4. harvest summary 주입은 capped (statText/output_tail 각 ≤500자) — review 메시지 비대화 방지.
5. PM 없는 프로젝트 / pmRunId 없음 → 기존처럼 발송 안 함 (early return 보존).
6. 이벤트 cardinality: 신규 채널 1개(`run:harvested`)만. harvest:diff/test/error 3종은 불변 (H-1 lock).
7. cancelled/stopped worker run 의 기존 동기 cleanup 경로 불변 (harvest 미진입).

## 5. 비범위

| 항목 | 이유 | 후속 |
|---|---|---|
| PM 판정 결과로 task status 자동 변경 검증 | PM 이 자율적으로 API 호출 — 기존 동작, 본 phase 는 입력(요약)만 개선 | 관측 후 |
| harvest summary 를 RunInspector UI 에도 표시 | 이미 H-1 Harvest 섹션이 diff/test 표시 중 | — |
| webhook 등 외부 알림 | needs_input 실측 0건 — 루프 돌기 시작 후 | 별도 (C) |
| failed run 의 재시도 정책 | PM 자율 판단에 위임 | B-lite |

## 6. 수용 기준

1. worktree 있는 completed worker run → harvest 후 PM review 메시지에 diff(파일/커밋) + test 결과 포함.
2. worktree 없는 worker run → `run:harvested`(harvested=false) 1회 → review 1회 (harvest 요약 없이, 사유 1줄).
3. 한 run 에 대해 PM review **중복 발송 0** — `run:completed`/`run:result` 는 더 이상 review 안 함.
4. tmux 워커 + streamJson 워커 모두 review 받음 (단일 `run:ended`→`run:harvested` 경로). failed 도 커버.
5. projectDir 미해결 / worktree-gone 케이스도 `run:harvested`(harvested=false) emit → review 누락 0.
6. harvest 가 실패해도 (summary.errors 채워짐) run:harvested 는 emit, PM 은 검증 상태를 안다.
7. circuit breaker 5회 / counter rollback / PM 없으면 미발송 — 전부 보존.
8. cancelled/stopped worker run → harvest 미진입, 기존 cleanup, review 없음 (기존 동작).
9. 전체 `node --test` 그린 + 신규/확장 테스트. UI 무변경 → visual 불요.

## 7. 테스트 지침

- app.js 의 PM auto-review 는 통합이 무거우므로, **review 발송 헬퍼(`sendPmReview`) + eventBus 구독 배선**을
  가짜 `conversationService`(sendMessage capture) + 가짜 `managerRegistry`(getActiveRunId 고정) 로 단위 구동.
  기존 `harvest.test.js` / `conversation.test.js` 패턴 참고.
- harvestService emit 계약 단위 테스트 (가장 중요 — BLOCKER 회귀 가드):
  - completed+worktree → run:harvested 1회 (harvested=true, summary 채워짐)
  - completed, worktree 없음 → run:harvested 1회 (harvested=false, errors=['no_worktree'])
  - projectDir 미해결 → run:harvested 1회 (harvested=false, errors=['no_project_dir'])
  - worktree-gone → run:harvested 1회 (harvested=false, errors=['worktree_missing'])
  - failed+worktree → run:harvested 1회
  - cancelled/stopped/manager/non-terminal → emit 0
  - dedupe(2회 호출 / 기존 DB harvest 이벤트) → emit 1회
- PM review 케이스: (a) run:harvested → 1회 발송 + diff/test 포함, (b) 중복 0 (run:completed 무시 확인),
  (c) circuit breaker 5회 후 skip, (d) PM 없으면 미발송, (e) summary cap(≤500자), (f) harvested=false 메시지.

## 8. 구현 순서 제안

1. eventChannels `run:harvested` → SERVER_EMITS 추가 + sse-channels.test 통과 확인
2. harvestService eventBus 주입 + emit 계약(§3.2) 구현 + 단위 테스트 (BLOCKER 가드 먼저)
3. lifecycleService run:ended 진입 조건 확대(§3.3) — completed/failed worker 항상 harvestRun
4. app.js sendPmReview 헬퍼 추출 (리팩터, 동작 불변 — 기존 테스트 그린 유지) + run:completed PM 로직 제거 + run:harvested 구독 신규
5. 통합/단위 테스트 작성
6. 검증: 신규 → 회귀(harvest/conversation/manager/lifecycle) → 전체 --test-concurrency=2

## 9. Codex r1 spec review 처리 기록

| 판정 | 내용 | r2 처리 |
|---|---|---|
| Q1 FAIL | run:completed skip 기준(worktree) ≠ 실제 harvest 진입 기준(+projectDir) → review 누락 hole | PM review 단일 트리거(run:harvested)로 통일, run:completed 구독 제거 |
| Q2 FAIL | harvestRun early-return 다수(!projectDir, worktree-gone) 가 emit 계약에 누락 | emit 계약을 "review 대상 worker run 은 항상 1회 emit (harvested 플래그로 구분)" 로 재정의 |
| Q3 FAIL | failed 채널 혼재 (tmux=run:completed, streamJson=run:result), r1 "failed 누락" 부정확 | run:ended 단일 신호 기반으로 전환, 채널 혼재 무관화 |
| Q4 PASS | emit 순서 race-safe (단 Q1/Q2 선결) | 단일 트리거로 해소 |
| Q5 PASS(정정) | run:harvested SSE 노출 표현 부정확 ("내부 전용" → "프론트 미구독") | §3.1 표현 수정, SERVER_EMITS 만 추가 |
| Q6 PASS | counter 가 exactly-once 보장 아님 | 단일 트리거로 구조적 1회 보장 (§3.5) |
