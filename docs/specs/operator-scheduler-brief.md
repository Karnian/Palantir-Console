# OS 트랙 — Operator Scheduler + Durable Invocation Queue brief

> **상태: v1 LOCKED / MVP 구현 (2026-07-23).** 사용자 lock-in: 폴더에 Operator를 붙이는
> project-first UX가 아니라 **Operator 생성 → 작업 폴더 매핑 → 그 Operator에 schedule 등록** 순서다.
> OS-1~OS-4의 codebase schedule MVP가 migration 067과 Operator Roster에 구현됐다. invocation
> history API는 포함하며, history/retry 상세 UI와 auto-review queue 이관(OS-5)은 후속이다.
>
> **핵심 결정**: 스케줄은 `operator_profiles`가 아니라 실제 실행 문맥인
> `operator_instances`에 귀속한다. 단순 `setInterval → sendMessage`가 아니라 DB 기반 durable
> invocation을 먼저 만들고, 시간 트리거와 기존 이벤트 트리거가 같은 큐를 사용한다.
>
> 관련 구현: `conversationService`, `operatorSpawnService`, `managerRegistry`, `memory_jobs`,
> `goalVerdictService`, Fleet remote node, H-1.5 auto-review.

## 1. 배경과 사용자 가치

현재 Palantir의 Operator는 사용자 메시지나 Worker 완료 이벤트에 반응한다. 그러나 다음과 같은
주기 업무를 Operator별로 선언할 방법은 없다.

- 매일 아침 프로젝트 상태·실패 run·막힌 큐 점검
- 평일 특정 시각 백로그 정리와 우선순위 제안
- 주간 코드 품질·보안·의존성 감사
- 일정 주기의 리서치·보고서 생성
- 자동 리뷰 누락분 또는 장기 미해결 항목 catch-up

Operator scheduler가 생기면 Palantir는 “요청에 반응하는 관제 허브”에서 “정해진 책임을 스스로
수행하는 운영 허브”로 확장된다. 다만 LLM 호출과 외부 실행은 일반 cron보다 비용·권한·중복 실행
위험이 크므로, OS cron이나 프로세스 메모리 timer를 실행의 source of truth로 쓰지 않는다.

## 2. 현재 코드 사실

### 2.1 재사용 가능한 기반

- `memory_jobs`는 `pending|running|done|failed`, `claim_token`, `locked_at`, `run_after`,
  `attempts`와 active-row partial unique index를 사용한다. stale lease 회수 → CAS claim → 토큰
  조건부 완료/재시도 패턴이 이미 검증됐다.
- `goalVerdictService`는 DB에 pending effect를 기록하고 boot/runtime sweep에서 재전송하는 durable
  outbox 선례다.
- Worker run 큐는 `queued → running` CAS와 boot drain을 제공한다.
- remote node는 reachable/cordon/queue reason과 node recovery drain을 이미 제공한다.
- `conversationService.sendMessage()`는 Operator가 없으면 lazy-spawn할 수 있고, identity·memory
  composition·parent notice 경로를 단일화한다.
- Manager adapter는 `mgr.turn_started|completed|failed` normalized event를 이미 기록한다.

### 2.2 그대로 재사용하면 안 되는 기반

- `tasks.recurrence`는 시간 스케줄러가 아니다. task가 `done`으로 전이할 때 다음
  `daily|weekly|monthly` task를 생성할 뿐이며, 시각·timezone·boot catch-up·claim 의미가 없다.
- `eventBus`는 프로세스 메모리 기반이며 제한된 replay만 제공하므로 durable source가 아니다.
- 일반 auto-review는 `run:harvested`에서 활성 수신자에게 직접 전송한다. 활성 Operator가 없으면
  `no_manager`로 끝나며, goal Gate 2와 달리 일반 review에는 durable marker/sweep가 없다.
- Codex Operator는 동시 turn을 거부한다(`previous turn still running`). 예약 실행과 수동 메시지가
  겹치면 현재 전달 경로는 502가 된다.
- `ensureLiveOperator()`의 active probe부터 run 생성·registry 등록까지 instance 단위 single-flight가
  없다. 사용자 cold-send와 scheduler cold-send가 겹치면 중복 spawn 위험이 있다.
- Operator cold-spawn은 활성 Top을 요구한다. Top 부재는 terminal failure가 아니라 대기 사유로
  다뤄야 한다.

## 3. 목표 / 비목표

### 목표

1. 사용자가 Operator instance별로 one-shot/반복 스케줄을 만들고 활성화할 수 있다.
2. 서버 재시작·Operator busy·Top 부재·remote node offline을 견디며 due invocation을 유실하지 않는다.
3. 같은 회차를 중복 생성하지 않고, 실행 중첩·미실행 catch-up 정책이 명확하다.
4. scheduled turn의 비용·권한을 대화형 turn보다 보수적으로 제한한다.
5. 다음 실행 시각, 대기 사유, 최근 결과, 실패 이력을 UI에서 감사할 수 있다.
6. 후속 단계에서 auto-review 같은 이벤트 트리거도 같은 invocation queue를 사용할 수 있다.

### 비목표

- folder-less Resident Operator 재도입. idle 프로세스를 유지하지 않고 due 시 lazy/one-shot 실행한다.
- 이메일 발송·티켓 생성 같은 외부 side effect 자동화. receipt/idempotency/approval을 요구하는
  `action` goal은 별도 설계다.
- MVP의 임의 raw cron, 초 단위 실행, 분 단위 무제한 LLM 호출.
- Scheduler가 Top을 임의로 시작하거나 human auth를 보유하는 것.
- active-active 다중 Palantir 서버 지원. 현행 single-server invariant는 유지하되 DB claim으로
  재진입·중복 tick을 막는다.
- 기존 event-driven auto-review를 cron polling으로 대체하는 것.

## 4. 핵심 모델

### 4.1 Schedule 소유자는 Operator Instance

스케줄은 `operator_instances.id`에 귀속한다.

- Profile은 공유 가능한 persona/capability/memory identity다. 같은 profile을 여러 instance가 공유할
  수 있어 실행 노드·primary folder·thread가 결정되지 않는다.
- Instance는 실제 conversation identity, thread, node affinity, primary/reference folder 문맥을 가진다.
- profile 재할당이나 thread reset 뒤에도 instance id는 유지되므로 schedule 연속성이 보존된다.
- profile-level schedule은 후속에서 **템플릿** 또는 folder-less **one-shot invocation**으로만 추가한다.

사용자 생성 흐름은 다음으로 고정한다.

1. 기존 Operator Profile을 선택해 folder-less `operator_instance`를 먼저 만든다.
2. 그 instance에 하나의 `primary` 작업 폴더를 매핑한다. 외부 노드/경로는 기존 Project의
   `node_id + directory` 바인딩을 그대로 사용한다.
3. 필요하면 `reference` 폴더를 더 매핑한다.
4. primary가 있는 instance에 schedule을 등록하고, 실행 대상은 그 instance에 매핑된 폴더 중에서
   선택한다. 기본 대상은 primary다.

즉 Project나 폴더가 Operator/Schedule의 소유자가 아니다. Project 삭제 시 해당 폴더를 대상으로
하거나 그 Project를 primary로 쓰던 schedule만 transaction 안에서 archive하고 active invocation을
cancel한다.

### 4.2 Schedule과 Invocation을 분리

```text
operator_schedule (반복 규칙/정책)
  └─ due 계산 → operator_invocation (회차별 durable 실행 의도)
                    └─ claim → lazy-spawn/전달 → turn 완료/실패 관측
```

- Schedule은 “언제 무엇을 할지”의 설정이다.
- Invocation은 특정 `scheduled_for`에 실행해야 할 불변 snapshot이다.
- schedule 수정은 이미 생성된 invocation의 prompt/rule을 바꾸지 않는다.
- 수동 `Run now`도 별도 invocation을 생성하며 같은 비용·overlap·권한 정책을 통과한다.

### 4.3 Trigger source와 turn mode는 직교

- `source ∈ {scheduled, auto_review, event, manual_run_now}`: 왜 실행됐는지.
- `turn_mode ∈ {generic, codebase}`: 어떤 memory/codebase 문맥을 주입할지.
- `auto_review`는 외부 schedule에서 선택할 수 있는 turn mode가 아니다. 시스템이 소유한 source다.
- scheduled codebase turn의 `codebase_project_id`는 생성·수정·실행 시 존재 검증한다. 일반 대화의
  shared-pool 정책과 달리 scheduler UI/API는 사용자 lock-in을 명확히 보존하기 위해 해당 instance에
  primary/reference로 매핑된 folder만 허용한다. 삭제/비활성 folder는 fail-closed한다.

## 5. 스키마

실제 MVP 스키마는 `server/db/migrations/067_operator_scheduler.sql`이다. 아래 r1 설계안에서 MVP는
사용자 lock-in에 맞춰 `codebase` turn만 열었고, `generic`/event source, 명시적 skip history,
failed/uncertain retry API는 후속으로 남겼다. 중복·overlap은 active partial unique index와 최신 회차
coalesce로 강제한다.

### 5.1 `operator_schedules`

```sql
CREATE TABLE operator_schedules (
  id                    TEXT PRIMARY KEY,
  operator_instance_id  TEXT NOT NULL REFERENCES operator_instances(id),
  name                  TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  turn_mode             TEXT NOT NULL CHECK(turn_mode IN ('generic','codebase')),
  codebase_project_id   TEXT NULL,
  rule_json             TEXT NOT NULL CHECK(json_valid(rule_json) AND json_type(rule_json)='object'),
  timezone              TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  next_fire_at          TEXT,
  overlap_policy        TEXT NOT NULL DEFAULT 'coalesce'
                          CHECK(overlap_policy IN ('coalesce','skip')),
  misfire_policy        TEXT NOT NULL DEFAULT 'coalesce'
                          CHECK(misfire_policy IN ('coalesce','skip')),
  misfire_grace_seconds INTEGER NOT NULL DEFAULT 86400 CHECK(misfire_grace_seconds >= 0),
  max_fires_per_day     INTEGER NOT NULL DEFAULT 24 CHECK(max_fires_per_day >= 1),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  revision              INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  archived_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (turn_mode='generic' AND codebase_project_id IS NULL)
    OR (turn_mode='codebase' AND codebase_project_id IS NOT NULL)
  )
);

CREATE INDEX idx_operator_schedules_due
  ON operator_schedules(enabled, next_fire_at)
  WHERE enabled = 1 AND archived_at IS NULL;
```

`codebase_project_id`는 의도적으로 FK를 걸지 않는 historical snapshot이다. 프로젝트 삭제 시
서비스/트리거가 해당 스케줄을 archive+disable하고 아직 전달되지 않은 invocation을 cancel한다.
스케줄 생성·수정과 실제 전달 직전에는 프로젝트 존재 여부를 각각 검증한다.

`rule_json` MVP vocabulary:

- `{ "kind":"once", "at":"<ISO timestamp>" }`
- `{ "kind":"daily", "at":"09:00" }`
- `{ "kind":"weekdays", "at":"09:00" }`
- `{ "kind":"weekly", "weekday":1, "at":"09:00" }`
- `{ "kind":"interval", "minutes":N }`, 단 `N >= 15`

raw cron은 UI·검증·비용 상한이 안정된 뒤 후속으로 둔다. timezone은 IANA 이름으로 검증하고,
`next_fire_at`과 invocation `scheduled_for`는 UTC timestamp로 저장한다.

### 5.2 `operator_invocations`

```sql
CREATE TABLE operator_invocations (
  id                    TEXT PRIMARY KEY,
  target_kind           TEXT NOT NULL DEFAULT 'operator'
                          CHECK(target_kind IN ('operator','top')),
  schedule_id           TEXT NULL REFERENCES operator_schedules(id) ON DELETE SET NULL,
  schedule_revision     INTEGER,
  operator_instance_id  TEXT NULL REFERENCES operator_instances(id),
  source                TEXT NOT NULL
                          CHECK(source IN ('scheduled','auto_review','event','manual_run_now')),
  dedupe_key            TEXT NOT NULL UNIQUE,
  scheduled_for         TEXT NOT NULL,
  prompt_snapshot       TEXT NOT NULL,
  turn_mode             TEXT NOT NULL CHECK(turn_mode IN ('generic','codebase')),
  codebase_project_id   TEXT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN (
                            'pending','claimed','delivering','running',
                            'completed','failed','skipped','uncertain','cancelled'
                          )),
  waiting_reason        TEXT,
  claim_token           TEXT,
  locked_at             TEXT,
  run_after             TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  manager_run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  turn_index            INTEGER,
  last_error            TEXT,
  delivered_at          TEXT,
  ended_at              TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(schedule_id, scheduled_for),
  CHECK (
    (target_kind='operator' AND operator_instance_id IS NOT NULL)
    OR (target_kind='top' AND operator_instance_id IS NULL)
  ),
  CHECK (
    (turn_mode='generic' AND codebase_project_id IS NULL)
    OR (turn_mode='codebase' AND codebase_project_id IS NOT NULL)
  )
);

CREATE INDEX idx_operator_invocations_claimable
  ON operator_invocations(status, run_after, scheduled_for);

CREATE UNIQUE INDEX idx_operator_invocations_active_schedule
  ON operator_invocations(schedule_id)
  WHERE status IN ('pending','claimed','delivering','running');
```

`dedupe_key` 예시:

- schedule: `schedule:<scheduleId>:<scheduledForUtc>`
- run now: `run-now:<requestId>`
- auto-review 후속: `auto-review:<workerRunId>`

## 6. 실행 의미

### 6.1 Due materialization

1. boot 직후 한 번, 이후 15~30초 주기로 `next_fire_at <= now` schedule을 스캔한다.
2. 한 DB transaction에서 invocation insert와 schedule의 다음 `next_fire_at` 갱신을 수행한다.
3. `UNIQUE(schedule_id, scheduled_for)`가 중복 tick·boot race의 같은 회차 중복을 차단한다.
4. 서버 downtime 동안 여러 회차가 누락됐으면 기본 `coalesce`는 최신 의미의 invocation 1개만
   생성한다. `skip`도 회차별 row를 폭증시키지 않고 누락 개수와 시간 범위를 담은 summary
   history/event 하나를 남긴다.
5. enable/update 시 다음 시각을 서버가 재계산한다. 클라이언트가 `next_fire_at`을 쓰지 못한다.

### 6.2 Claim과 delivery

1. stale lease를 회수한 뒤 `pending → claimed` CAS를 수행한다.
2. schedule enabled/revision/codebase 존재/일일 cap을 재검증한다.
3. 활성 Top이 없으면 `waiting_reason=top_unavailable`로 pending/backoff한다. Scheduler가 Top을
   자동 시작하지 않는다.
4. remote node가 unreachable/cordoned이면 각각 `node_unreachable|node_cordoned`로 대기한다.
5. Operator가 없으면 `ensureLiveOperator()`로 lazy-spawn한다. 그 전에 instance 단위 spawn
   single-flight를 추가한다.
6. Operator turn이 진행 중이면 `operator_busy`로 pending/backoff한다. terminal failure로 세지 않는다.
7. `conversationService.sendMessage()`를 통해 identity/memory/parent-notice 불변식을 유지한다.
8. adapter에 `source:'scheduled'`와 `invocationId`를 전달한다. normalized turn event payload에
   `invocationId`를 포함해 `running → completed|failed`를 상관시킨다.

### 6.3 Delivery crash window

DB와 외부 CLI/API turn 사이에 원자 commit은 불가능하다.

- enqueue는 dedupe key로 exactly-once다.
- adapter가 accepted 하기 전 실패는 안전하게 pending/backoff한다.
- `delivering` 이후 프로세스가 죽고 durable `mgr.turn_started(invocationId)` 존재 여부를 확정할 수
  없으면 `uncertain`으로 둔다.
- `uncertain`은 자동 재전송하지 않는다. 이미 실행된 side effect와 LLM 비용을 중복시키는 것보다
  운영자 `Retry`가 안전하다.
- 향후 adapter가 vendor turn idempotency key를 제공할 때만 자동 replay 범위를 넓힌다.

### 6.4 Overlap / failure / circuit breaker

- 같은 schedule의 active invocation은 최대 1개다.
- 기본 `coalesce`: 이전 invocation이 active면 새 회차는 별도 실행하지 않고 skipped/coalesced history를
  남긴다.
- `skip`: 겹친 회차를 즉시 skipped 처리한다.
- Top/node/operator busy 같은 인프라 대기는 `consecutive_failures`를 증가시키지 않는다.
- accepted turn의 `mgr.turn_failed`, 잘못된 schedule snapshot, 영구 spawn/config 오류만 실패로 센다.
- 연속 실제 실패 3회면 schedule을 자동 disable하고 알림을 남긴다. 재활성화는 human-only다.

## 7. 비용·권한·보안 계약

1. schedule 생성/수정/삭제/enable/disable/Run now는 **cookie human-only + Origin 검증**이다.
   Operator bearer가 자기 schedule을 만들거나 빈도를 올릴 수 없다.
2. `source:'scheduled'` Codex turn은 **항상 standard tier**다. instance fast mode와
   `PALANTIR_CODEX_FAST`를 상속하지 않는다. model/effort는 기존 Operator 정책을 따르되 tier만
   강제한다.
3. `max_fires_per_day`와 최소 interval을 서버에서 강제한다. UI 제한만 신뢰하지 않는다.
4. schedule prompt와 snapshot은 길이 상한을 둔다. secret redaction 대상 로그에 prompt 전문을
   쓰지 않는다.
5. scheduled Operator가 Worker를 spawn하면 기존 project budget/non-retryable/preflight 정책을 그대로
   통과한다. Scheduler가 budget gate를 우회하지 않는다.
6. schedule mutation API는 Manager system prompt/tool 예시에 노출하지 않는다.
7. disabled schedule은 미래 invocation을 만들지 않는다. 아직 미전달 pending invocation은 cancelled로
   전이하고, 이미 running인 turn은 강제 kill하지 않는다.

## 8. API 제안

```text
GET    /api/operator-instances/:id/schedules
POST   /api/operator-instances/:id/schedules          # human-only
GET    /api/operator-schedules/:id
PATCH  /api/operator-schedules/:id                    # human-only + revision CAS
DELETE /api/operator-schedules/:id                    # human-only; history 보존/soft delete 후보
POST   /api/operator-schedules/:id/run-now             # human-only
GET    /api/operator-schedules/:id/invocations
POST   /api/operator-invocations/:id/retry             # uncertain/failed, human-only
```

- PATCH는 `expected_revision` CAS로 stale modal 저장을 409 처리한다.
- API 응답은 서버 계산 `next_fire_at`, 다음 24시간 예상 fire 수, effective timezone, last invocation과
  waiting reason을 포함한다.
- 내부 scheduler/Operator는 HTTP로 자기 schedule을 변경하지 않는다.

## 9. UI 제안

Operator Roster에 실행 중 여부와 무관한 **Configured Operators** 섹션을 둔다. 사용자는 여기서
Operator를 먼저 만들고, 폴더 매핑을 열어 primary/reference를 설정한 다음 **Schedules** 액션으로
활성 개수·다음 실행 시각을 관리한다. primary가 없으면 schedule 액션은 비활성이다.

Schedule 편집 modal:

- 이름, prompt
- 문맥: Generic 또는 프로젝트 폴더 선택
- 규칙: 한 번/매일/평일/매주/간격
- IANA timezone(기본 브라우저 timezone)
- overlap/misfire 정책(기본값은 advanced 영역에 접음)
- 일일 최대 횟수
- 활성화 토글과 “지금 실행”

상세/history:

- next/last scheduled time
- pending/running/completed/failed/skipped/uncertain 상태
- Top 부재·노드 offline·Operator busy 등의 대기 사유
- 실제 manager run/Operator conversation 링크
- failed/uncertain human retry
- schedule 자동 disable 사유

Available(folder-less one-shot) Profile 카드에는 MVP에서 schedule 버튼을 노출하지 않는다. profile
one-shot schedule은 별도 phase에서 invoke contract와 비용 정책을 확정한 뒤 추가한다.

## 10. 이벤트와 관측

- durable truth는 `operator_invocations`다. SSE/eventBus는 UI hint일 뿐이다.
- 신규 SSE 채널은 **`operator:schedule` 하나**로 제한한다.
- payload 후보:

```json
{
  "kind": "schedule_changed|invocation_status",
  "schedule_id": "...",
  "invocation_id": "...",
  "from_status": "pending",
  "to_status": "claimed",
  "reason": "due",
  "at": "..."
}
```

- 채널 추가 시 `eventChannels.js` SERVER_EMITS/CLIENT_REQUIRED_LIVE,
  `hooks/sse.js` channels, `sse-channels.test.js`를 lock-step 갱신한다.
- manager run event에도 `operator:schedule_dispatched|completed|failed`를 invocation id와 함께 남긴다.
- scheduler tick 자체의 정상 empty scan은 로그하지 않는다. 상태 전이·실패·breaker만 기록한다.

## 11. Auto-review 및 OCI review node 연계

자동 리뷰는 Worker 완료 직후 판단해야 하므로 시간 schedule로 대체하지 않는다.

- 기존 `run:harvested`는 그대로 즉시 trigger다.
- OS 후속 phase에서 `dispatchReview()`의 직접 send를
  `operator_invocations(source='auto_review', dedupe_key='auto-review:<runId>')` enqueue로 바꾼다.
- 기존 수신자 순서(Worker를 spawn한 instance → primary instance → Top), T5 retry suppress,
  `AUTO_REVIEW_MAX`, goal Gate 2 durable marker 의미는 유지한다.
- 일반 auto-review도 Operator/Top 부재·busy·node offline 시 pending으로 남아 유실되지 않는다.
- 별도 Reviewer instance/node를 선택하는 `auto_review_operator_instance_id` 또는 placement 정책은
  OS scheduler와 분리된 후속 lock-in이다. Scheduler 도입만으로 project→node 배치 의미를 바꾸지 않는다.
- OCI가 회수되거나 offline이면 review invocation은 pending 유지하고 node recovery drain으로 재개한다.

Scheduler는 “매일 미처리 리뷰/실패 run 감사” 같은 catch-up을 담당하고, 각 Worker 결과의 1차 리뷰는
계속 event-driven으로 처리한다.

## 12. Phasing

| Phase | 내용 | 규모 |
|---|---|---|
| **OS-0** | ✅ Operator-first 소유/흐름 lock-in | 문서 |
| **OS-1** | ✅ migration + schedule/invocation service(CRUD, rule 계산, CAS claim/recovery) | 완료 |
| **OS-2** | ✅ scheduler driver(boot due scan, tick, coalesce, graceful shutdown) + service tests | 완료 |
| **OS-3** | ✅ delivery: instance spawn single-flight, `source/invocationId`, completion correlation, wait/uncertain 정책 | 완료 |
| **OS-4** | ✅ human-only API + Origin/revision CAS + Roster UI + history API + `operator:schedule` SSE | MVP 완료 |
| **OS-5** | 일반 auto-review를 durable invocation으로 이관, 기존 receiver/T5/goal parity | 후속 |
| **OS-6** | 선택 후속: folder-less profile one-shot schedule / reviewer placement / raw cron | 별도 lock |

MVP는 하나의 통합 phase로 구현했다. OS-5/6은 별도 lock-in 없이 확장하지 않는다.

## 13. 수용 조건 / 테스트 매트릭스

### Schedule 계산

1. once/daily/weekdays/weekly/interval next fire 계산.
2. IANA timezone validation, UTC 저장, DST spring-forward/fall-back에서 중복·역행 0.
3. 같은 due tick 2회와 boot+runtime 경합에서 invocation 1개.
4. downtime 다회 누락: coalesce 1회 / skip history 계약.
5. schedule 수정 revision CAS와 prompt snapshot 불변.

### Claim / 복구

6. pending claim CAS 동시 호출 승자 1명.
7. stale claimed lease 회수, token 불일치 late finalize 차단.
8. graceful shutdown이 tick 중단 후 in-flight drain을 기다리고 DB를 닫음.
9. disabled schedule 미래 enqueue 0 + pending cancel + running non-kill.
10. daily cap과 최소 interval 서버 검증.

### Delivery

11. Operator busy → failed가 아니라 pending/backoff, 다음 drain에서 정확히 1회 accepted.
12. 사용자 send와 scheduler cold-spawn 경합 → instance manager run 1개.
13. Top offline → pending(`top_unavailable`), Top start 후 drain.
14. remote node unreachable/cordoned → pending, recover/uncordon 후 drain.
15. deleted codebase target → fail-closed + breaker 대상 영구 오류.
16. scheduled source는 instance fast mode/env fast에도 Codex standard.
17. normalized turn completed/failed가 invocation id에 정확히 귀속.
18. delivering crash ambiguity → uncertain, 자동 재전송 0.

### 권한 / UI / 회귀

19. bearer/PM actor schedule mutation·Run now·Retry 403, cookie+Origin만 성공.
20. schedule prompt/token/secret 로그 상한과 redaction.
21. Operator Roster schedule modal a11y moderate 이상 0 + light/dark visual.
22. 신규 SSE 3목록 lock-step 테스트.
23. scheduler disabled/테이블 empty에서 기존 Top/Operator/Worker spawn argv와 auto-review byte-equivalent.
24. OS-5: 기존 auto-review receiver chain, T5 suppress, goal Gate 2 marker, circuit breaker parity.

## 14. 결정 결과와 후속 리스크

1. **Turn completion correlation — 해결**: Claude/Codex terminal normalized event에 `invocationId`를
   기록하고, durable completion은 manager run id로 상관시킨다.
2. **Cold-spawn single-flight — 해결(single-server)**: instance slot별 Promise flight를 사용한다. 향후
   multi-process가 필요하면 DB lease로 승격해야 한다.
3. **Schedule 삭제 — 해결**: `archived_at` soft delete로 history를 보존한다.
4. **Top parent notice**: scheduled Operator turn도 현재 lock-in상 Top staleness notice를 만든다. 빈번한
   schedule의 notice spam을 줄이되 parent-notice 불변식을 깨지 않는 집계 방식 검토가 필요하다.
5. **Run now**: overlap/daily cap을 그대로 적용하는 것이 권장안. 긴급 bypass는 별도 human-confirmed
   API가 필요하며 MVP에서는 제외한다.
6. **기본 최소 interval — 해결**: 서버 최소 15분, UI 기본 60분, schedule별 rolling 24시간 cap을
   강제한다.
7. **Auto-review OS-5 — 후속**: scheduler MVP와 분리한다. 기존 event-driven 경로는 유지한다.

## 15. 구현 금지선

- `setInterval` callback에서 직접 `conversationService.sendMessage()` 호출 금지.
- eventBus 이벤트만을 schedule/delivery truth로 사용 금지.
- `tasks.recurrence`에 Operator schedule 의미를 덧씌우지 않는다.
- schedule을 `operator_profiles`에 직접 귀속해 공유 instance마다 암묵 복제하지 않는다.
- Top/node/operator busy를 terminal failed로 오분류하지 않는다.
- stale `delivering`을 근거 없이 자동 replay하지 않는다.
- scheduled turn이 fast tier나 human token을 암묵 상속하지 않는다.
- raw cron 자유입력과 15분 미만 LLM 반복 호출을 MVP에 열지 않는다.
- auto-review를 cron polling으로 바꾸지 않는다.
