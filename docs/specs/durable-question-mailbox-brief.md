# Durable 질문/승인 mailbox (격차 ①) — 설계 계약 v3

> **왜 1순위인가**: Orca 앱 소스 실측(`orca-parity-and-action-plane-brief.md` §1.0)으로 파리티를
> 재정의한 결과, 무인 운영의 가장 큰 결손은 **워커가 막혔을 때의 복구 경로**였다.
> 지금 Palantir 는 로컬 stdin 뿐이고 **원격은 아예 실패**한다(`remoteSshExecutor.sendInput` = 스텁).
> 큐에서 이 항목은 원래 "5단계 이후"였는데 실측하니 1순위였다 — 순서 판단도 추측이었다.

> **v2 는 v1 초안을 대체한다.** 층층이 덧붙이지 않고 통째로 다시 썼다 — `thin-cli-brief` 에서
> 개정을 겹쳐 쌓다가 폐기했어야 할 문언이 우회로 살아남는 사고가 있었다.
> v1 대비 바뀐 것은 §9 에 감사용으로 남긴다.

## 0. 한 줄 목표

**워커가 막혔을 때 질문을 durable 하게 남기고, 사람이 자리에 없어도 나중에 답하면 이어서 진행한다.**

이 목표가 §3(두 시간 분리)과 §5.5(응답→재개)를 강제한다. 그 둘이 없으면 목표가 공허하다.

> **정직한 한정(v3)**: "이어서 진행"은 **사람이 답하는 그 동작으로** 일어난다(§5.5 의 `resume:true`).
> 답만 남기고 재개를 미룰 수도 있으며, 그 경우 **"답변됨·미재개"가 UI 에 행동 가능한 상태로 남는다.**
> 즉 **사람 없이 자동으로 재개되지는 않는다** — 이 기능은 자동 복구가 아니라
> **비동기 인간 개입 복구**다. 자동화는 격차 ②(Task DAG) 이후에 재검토한다.

## 1. 착수 전 실측 (코드로 확인)

| 사실 | 근거 |
|---|---|
| 워커는 이미 **run 스코프 토큰**을 갖는다 — `PALANTIR_WORKER_TOKEN` + `PALANTIR_API_BASE` 주입, `POST /api/runs/:id/memory/propose` 호출을 프롬프트가 안내 | `lifecycleService.js:1247` |
| 그 토큰은 **경로·메서드로 스코프**된다. `workerProposalTokenService.verify` → grant `{runId, projectId}`, 그 외 경로는 `ForbiddenError` | `middleware/auth.js:47`, `:187-201` |
| `req.auth.method` = `worker`\|`bearer`\|`cookie` (actor split 선례) | `middleware/auth.js:191`, `:205` |
| **`remoteSshExecutor.sendInput` 은 스텁** — 원격 워커에 stdin push 불가 | 기존 brief §5단계 T1 주의 |
| single-flight 는 **partial unique index** 로 (`memory_jobs` CAS lease 선례) | CLAUDE.md ML PR3a |

**결론**: 답을 워커에 **push 할 수 없다. 워커가 pull 해야** 원격이 산다.

## 2. 범위

**v1 = 질문 등록 / 워커 pull 수신 / 사람 응답 / 응답 후 재개.**

**제외** — 범용 inter-agent 메시징(Orca `send`/`reply`/`inbox`, 9종 message type, 그룹 주소, 스레드),
Task DAG 연동, federation. 그건 코디네이터 다중화가 전제인데 우리 실사용 자동화는 선형이다.

**Operator 응답도 제외한다** — 이유는 §4.

## 3. 두 시간을 분리한다

v1 초안은 목표에 "사람이 자리에 없어도"라고 써놓고 만료를 **최대 30분**(Orca `ask` 값)으로 잡았다.
**자기모순**이다 — 밤새 자리를 비우면 만료된다. Orca 의 `ask` 는 *실행 중인 코디네이터*가 기다리는
시간이고 우리는 *부재중인 사람*을 기다린다. 값을 그대로 베낀 것이 오류였다.

| 개념 | 의미 | 값 |
|---|---|---|
| **worker wait budget** | 워커 프로세스가 이 run 안에서 기다리는 한계 | 기본 10분 / 최대 30분 |
| **question lifetime** | 질문이 **답변 가능한 상태로 남는 기간** | 기본 **7일** → `expired` |

**워커가 못 기다리면 run 은 `failed` + `terminal_reason='question_unanswered'` 로 끝난다.
질문은 살아남고, 사람이 답한 뒤 §5.5 로 재개한다.

## 4. 응답 권한 — v1 은 **사람(cookie)만**

초안은 `class ∈ {clarification, choice, approval}` 로 나눠 `approval` 만 cookie-only 로 막았다.
**그런데 `class` 는 워커가 선언하는 값이다.** 승인이 필요한 일을 `clarification` 으로 라벨해
Operator 에게 답을 받아내면 게이트가 무력화된다 — **#515(프롬프트 provenance 마커 위조)와 같은 부류**,
주장 주체가 곧 검증 주체다.

**결정**: v1 은 **모든 질문을 사람(cookie)만 답한다.**
- `class` 는 **권한 근거가 아니라 UI 표시·감사 라벨**로만 남긴다.
- Operator 는 질문을 **볼 수** 있으나 답할 수 없다.
- Operator 응답은 **class 를 위조 불가능한 원천에서 얻을 수 있을 때** 재검토한다
  (사람이 태스크에 미리 붙인 정책 — `verify_checks.created_by` provenance 모델 선례).

"사소한 질문에도 사람을 깨운다"는 비용이 생기지만 **승인 우회보다 낫다.**

## 5. 데이터 모델과 API

### 5.1 스키마

```sql
CREATE TABLE worker_questions (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id),   -- CASCADE 없음: 이력 보존
  task_id          TEXT,                                -- 조회 편의. 권한 근거 아님
  project_id       TEXT,
  idempotency_key  TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,                       -- 멱등 키 재사용 검증용
  class            TEXT NOT NULL
    CHECK(class IN ('clarification','choice','approval')),  -- 라벨 전용 (§4)
  question         TEXT NOT NULL,                       -- 원본 저장 (살균은 렌더 시점)
  options_json     TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','answered','cancelled','expired')),
  answer           TEXT,
  answered_at      TEXT,
  resumed_run_id   TEXT,                                -- 답을 실어 만든 새 attempt
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL   -- 서버 생성, UTC `datetime('now','+7 days')` 형식 고정
);

-- 재개된 run 이 어느 질문에서 왔는지 (§5.5.1)
ALTER TABLE runs ADD COLUMN source_question_id TEXT;

CREATE UNIQUE INDEX idx_worker_questions_one_pending
  ON worker_questions(run_id) WHERE status = 'pending';   -- run 당 pending 1개
CREATE UNIQUE INDEX idx_worker_questions_idem
  ON worker_questions(run_id, idempotency_key);
```

`answered_by` 컬럼을 두지 않는다 — v1 은 사람만 답하므로 상수다.
**사람 신원은 기록할 수 없다**: 현재 인증이 단일 공유 cookie 라 `'human'` 이상을 만들 수 없다.
**한계로 명시**한다. 사용자 principal 은 별도 트랙.

### 5.2 `POST /api/runs/:runId/questions` — 워커 등록

- 인증: **worker 토큰만** (`req.auth.method === 'worker'` ∧ `auth.runId === :runId`).
  `middleware/auth.js` 경로 allowlist 에 **이 경로 하나만** 추가.
- body: `{ idempotency_key, class, question, options?, wait_budget_ms? }`
- **run active CAS**: run 이 이미 terminal 이면 **409 `run_not_active`**.
  INSERT 가 run 상태를 같은 문장에서 확인한다(등록 ↔ 종료 경합, §6).
- **멱등**: 같은 `(run_id, idempotency_key)` + **같은 `payload_hash`** → 기존 행 반환.
  **payload 가 다르면 409 `idempotency_conflict`** — 조용히 옛 행을 돌려주지 않는다.
- **run 당 pending 1개**: 다른 키로 두 번째 pending → **409 `question_pending`**.

### 5.3 `GET /api/runs/:runId/questions/:id/wait` — 워커 pull

- 인증: 동일(worker, 자기 run). **run 스코프라 다른 run 의 질문은 구조적으로 못 본다.**
- 최대 **25초** 대기 후 현재 상태 반환(프록시 타임아웃보다 짧게). 워커가 다시 부른다.
- **timeout·연결끊김은 아무것도 바꾸지 않는다.** 상태 전이 없음.
- **동시 waiter 는 run 당 1개**(초과 즉시 반환), 전역 상한 초과도 즉시 반환.
- `Cache-Control: no-store`, 프록시 버퍼링 비활성. graceful shutdown 시 대기 연결을 현재 상태로 종료.

### 5.4 `POST /api/questions/:id/respond` — 사람 응답

- 인증: **cookie 전용 + same-origin CSRF** (`modelPolicies` 선례).
- **CAS 1회**: `UPDATE ... WHERE id=? AND status='pending' AND expires_at > datetime('now')`.
  0행이면 **409** + 현재 상태 반환. respond·cancel·expire 가 모두 같은 CAS 를 두고 경쟁하며
  **first-commit-wins**.
- `options_json` 이 비어있지 않으면 답이 **그 안의 값이어야 한다**(서버 강제).
  비어있으면 길이 상한만. > Orca 의 options 는 advisory 지만 우리는 강제한다 — 승인 감사에 필요하다.

### 5.5 재개 — **사람이 명시적으로 트리거한다** (v3 정정)

v2 는 "응답이 커밋되면 새 attempt 를 생성"이라고 했다. **구현 불가에 가까웠다.** codex 지적대로:
respond 커밋과 run 생성 사이에 **crash gap** 이 있고(answered 인데 `resumed_run_id` NULL 로 영구 고착),
B-lite `createRetryRun` 은 **원 prompt 를 그대로 복사**하며 `retry_count`/`MAX_RETRY` 예산을 공유한다.
정확히 한 번 생성을 보장하려면 outbox + CAS drain 이 필요한데, **그 복잡도가 정당화되지 않는다 —
답을 하는 시점에 사람이 이미 자리에 있기 때문이다.**

**결정: 답변과 재개를 한 트랜잭션에 넣는다. 재개 시점은 사람이 정한다.**

```
POST /api/questions/:id/respond   { answer, resume: true|false }
POST /api/questions/:id/resume    (answered 인데 미재개인 것을 나중에 재개)
```

**`resume:true` 면 한 SQLite 트랜잭션 안에서 전부 커밋한다**:

```
BEGIN
  UPDATE worker_questions
     SET status='answered', answer=?, answered_at=datetime('now'), resumed_run_id=?
   WHERE id=? AND status='pending' AND expires_at > datetime('now');   -- 0행이면 ROLLBACK → 409
  INSERT INTO runs (... status='queued', source_question_id=?, prompt=<컴파일된 프롬프트> ...);
COMMIT
```

- **spawn 은 커밋 이후 기존 queue drain 에 맡긴다**(`claimQueuedRun` CAS 경로). 새 spawn 경로를 만들지 않는다.
- **v3 중간안의 결함을 이렇게 닫는다**: CAS 와 run 생성을 분리하면 *CAS 승자가 run 생성에 실패했을 때
  CAS 가 재시도를 막아 복구 불가로 고착*된다. 같은 트랜잭션이면 **둘 다 되거나 둘 다 안 된다.**
  outbox·drain 워커가 필요 없다.
- **`resume:false`** 면 질문만 `answered` 로 커밋한다(`resumed_run_id` NULL).
  나중에 `POST /resume` 이 **같은 트랜잭션 형태**로 `WHERE status='answered' AND resumed_run_id IS NULL`
  CAS + INSERT 를 수행한다. 진 쪽은 **409 + 기존 `resumed_run_id`**.
- `answered ∧ resumed_run_id IS NULL` 은 **UI 에 "답변됨·미재개"로 노출**된다(수락기준 19).
  묻히지 않고 사람이 다시 누를 수 있다.
- **B-lite 를 재사용하지 않는다.** `retry_count` 예산과 무관하며, 원 prompt 복사가 아니라
  §5.5.1 블록을 포함해 새로 컴파일한다.

#### 5.5.0 run 생성 경로 통합 계약 (codex R4)

`runService.createRun` 은 **INSERT 직후 `eventBus.emit('run:status', …)`** 를 한다
(`runService.js:1037`). 그대로 트랜잭션 안에서 재사용하면 **커밋되지 않은/롤백된 run 의 이벤트가 샌다.**
반대로 raw SQL 로 INSERT 하면 기본값·검증·필드 구성과 drain wakeup 을 **우회**한다.

**결정: `createRun` 을 세 조각으로 분리한다** (A2 PR2b 의 `artifactCheck` 순수 코어 분리 선례).

| 조각 | 성격 | 호출 위치 |
|---|---|---|
| `buildRunRow(args)` | **순수** — 기본값·검증·필드 구성 | tx 안 |
| `insertRunRow(row)` | INSERT 만 | **tx 안** |
| `emitRunCreated(row)` | `run:status` emit | **커밋 이후** |

- 기존 `createRun` 은 이 셋을 순서대로 부르는 **얇은 래퍼**가 된다 — 기존 호출자 **동작 불변**.
- 질문 재개는 tx 안에서 `buildRunRow` + `insertRunRow` 만 쓰고,
  **커밋 후** `emitRunCreated` + **drain wakeup**(`executeTask` 가 생성 후 부르는 것과 동일한 공개 API)을 호출한다.
- **롤백 시 이벤트가 0건**이어야 한다(수락기준 15).

#### 5.5.1 답이 새 attempt 에 전달되는 형식

새 run 은 `source_question_id` 를 갖고, 컴파일된 워커 프롬프트에 **신뢰 데이터 블록**으로 답을 싣는다:

```
[ANSWERED QUESTION]
question_id: <id>
question: <원문>
answer: <원문>
```

- **주입 시점에 살균**한다(`detectInjection`/`redactSecrets`) — 저장은 원본(§7).
- **이 블록이 없으면 새 attempt 는 같은 질문을 반복한다.** 구현 시 프롬프트 계약을 함께 만든다(§11).

#### 5.5.2 `question_unanswered` 로 끝난 run 의 처리

- run 최종 상태는 **`failed` + `terminal_reason='question_unanswered'`** 다.
  (`runs.terminal_reason` 은 migration 076 으로 이미 존재한다. v2 가 적은 `waiting_reason` 은
  **스키마에 없다** — 오류였다.)
- **B-lite 자동 retry 를 억제**한다: terminal 처리와 같은 경로에서 `setRetryCount(run.id, MAX_RETRY)`.
  `run:ended` 구독자의 retry 조건이 `retry_count < MAX_RETRY` 이므로 이걸로 확실히 막힌다
  (`lifecycleService.js:4358-4364`). **이미 3곳에서 쓰는 확립된 패턴**이다(`:1147`, `:1178`, `:1192`).
- 이 사유로 끝난 run 의 질문은 **cancel 하지 않는다**(§6).

### 5.6 `GET /api/questions?status=pending` — 사람 inbox

cookie 또는 bearer. 웹 UI 가 쓴다. Operator 도 **읽기만** 가능(§4).

## 6. 생명주기와 경합

| 사건 | 처리 |
|---|---|
| run 이 terminal (`terminal_reason` ≠ `question_unanswered`) | **같은 트랜잭션**에서 pending → `cancelled` |
| run 이 terminal (`terminal_reason` = `question_unanswered`) | 질문 **유지**. 나중 응답이 재개시킨다 |
| `expires_at` 경과 | `expired`. sweep 은 기존 스케줄러 루프에 얹되, **respond CAS 가 `expires_at` 을 직접 검사**하므로 sweep 지연이 만료 후 응답을 허용하지 않는다 |
| 등록 ↔ 종료 동시 | 등록이 run active 를 같은 문장에서 확인 → 진 쪽 409 |
| respond ↔ cancel ↔ expire 동시 | 전부 `status='pending'` CAS. first-commit-wins, 진 쪽 409 |

워커는 `cancelled`/`expired` 를 받으면 **질문 없이 진행하거나 스스로 실패**한다 — 서버가 대신 정하지 않는다.

## 7. 안전

- **워커 토큰 확장은 2개 경로뿐** (`POST /runs/:id/questions`, `GET /runs/:id/questions/:qid/wait`).
  나머지는 기존대로 `ForbiddenError`. allowlist 는 **원문 `originalUrl` 매칭**(T6-min 규율).
- **응답은 cookie-only + same-origin.** bearer(PM token 포함)로 답할 수 없다.
- **살균은 저장이 아니라 주입·렌더 시점**에 한다(`detectInjection`/`redactSecrets`).
  원본을 보존해야 감사가 된다 — 메모리 레이어와 같은 규율.
- **run 당 pending 1개 + waiter 1개**가 DoS 방어를 겸한다.
- **stale attempt 방어**: 질문이 `run_id` 에 묶이고 토큰이 run 스코프라, 이전 attempt 의 워커는
  자기 run 의 질문만 본다. Orca 의 `consumer_generation` fencing 은 **배치 replay 용이라 안 가져오지만,
  그 fencing 이 막던 stale consumer 문제는 run 스코프가 대신 막는다.**

## 8. 관측

- SSE 채널 **`question:pending`** / **`question:answered`**.
  **`app/lib/hooks/sse.js` 의 channels 배열에 반드시 추가**(Phase 5/7 회귀 선례).
- 이벤트는 **commit 이후** emit. UI 는 이벤트를 힌트로 쓰고 **목록은 재조회**한다
  (`run:status` = pure reload 규율).
- run event: `question:asked` / `question:answered` / `question:expired` / `question:cancelled`.

## 9. v1 초안에서 바뀐 것 (감사용)

codex 적대검토 R1 이 **블로커 3 + SERIOUS 8** 을 냈고 전부 반영했다.

| 초안 | v2 |
|---|---|
| `approval` 만 cookie-only, 나머지는 Operator 가능 | **전부 cookie-only** — `class` 가 워커 주장이라 게이트 우회 (§4) |
| 만료 최대 30분 | **worker wait budget 과 question lifetime 분리**, 후자 7일 (§3) |
| 응답 후 재개 메커니즘 없음 | v2 = 응답 시 자동 생성 → **v3 = 사람이 명시 트리거**(crash gap 을 배경 복구 대신 **관측 가능 상태**로) (§5.5) |
| 등록/종료 경합 미정의 | **양쪽 CAS + first-commit-wins** (§6) |
| 멱등 키 재사용 시 옛 행 반환 | **payload 다르면 409** (§5.2) |
| 살균 시점 모호 | **저장은 원본, 렌더·주입에서 살균** (§7) |
| DDL 이 CASCADE 를 쓰고 본문은 "안 씀" | **DDL 에서 제거** (§5.1) |
| fencing 을 통째로 버림 | **배치는 안 가져오되 stale consumer 방어는 run 스코프로 유지** (§7) |
| long-poll 위생 없음 | **no-store / 버퍼링 / waiter 상한 / shutdown** (§5.3) |

## 10. 수락 기준

1. **원격에서 동작** — remote pod 워커가 등록·pull 로 답 수신. `sendInput` 스텁 경로를 타지 않는다.
2. **멱등** — 같은 키+같은 canonical payload 2회 → 행 1개·같은 id. **payload 다르면 409 `idempotency_conflict`**.
   canonicalization: JSON 키 정렬, `options` 순서 보존, 생략된 필드는 기본값으로 채운 뒤 해시.
   `wait_budget_ms` 는 **해시에 포함하지 않는다**(같은 질문의 재시도가 예산만 바꿔도 같은 질문이다).
3. **run 당 pending 1개** — 다른 키로 두 번째 pending → 409 `question_pending`.
4. **timeout 무소비** — wait 타임아웃 후에도 `pending`. 반복 wait 가능.
5. **재시작 재개(구체화)** — wait 중 워커를 죽인다 → 질문은 `pending` 유지 → 사람이 respond →
   같은 질문 id 로 다시 wait → **`{status:'answered', answer}` 를 정확히 수신**한다.
   (v2 기준 5 는 "정상 수신"이 모호해 vacuous 했다.)
6. **CAS 1회** — 동시 respond 2건 → 하나만 200, 하나는 409 + 현재 상태.
7. **응답 actor** — bearer 로 respond → **403**. cookie + same-origin → 200. **Origin 불일치 → 403**.
8. **options 강제** — options 밖의 답 → 400. options 원소는 문자열, 최대 10개, 각 200자, 중복 불가.
9. **만료 후 응답 거부** — `expires_at` 경과 후 respond → 409 (sweep 미실행 상태에서도).
   **API 는 `expired` 로 materialize 해 반환**한다(pending 을 그대로 보이지 않는다).
10. **run terminal 시 cancel** — `terminal_reason` ≠ `question_unanswered` → pending → `cancelled`,
    **같은 트랜잭션**에서. 이벤트 구독 후 cancel 로 바꾸면 실패하는 역회귀가 있어야 한다.
11. **`question_unanswered` 는 유지** — 그 사유의 종료는 질문을 남기고, **B-lite 자동 retry 가 뜨지 않는다**
    (`retry_count === MAX_RETRY` 확인).
12. **등록/종료 경합** — terminal 이 된 run 에 등록 → 409 `run_not_active`.
    **성공 응답 유실 후 재전송**이 종료 뒤에 도착하면: 같은 (key, payload) 면 **기존 행 반환**(멱등 우선),
    새 키면 `run_not_active`.
13. **워커 토큰 스코프(구체화)** — 워커 토큰으로 **다른 run 의 `wait`** → 403.
    **자기 run 이어도 `respond`/`resume`** → 403(worker 는 응답 주체가 아니다).
    (v2 기준 13 은 respond 가 cookie-only 라 항상 403 이어서 run 격리를 검증하지 못했다.)
14. **살균 sink 별 검증(분리)** —
    (a) **UI**: 질문 원문이 **텍스트로 표시**되고 HTML/스크립트로 실행되지 않는다(escaping).
    (b) **Operator 프롬프트/재개 블록**: injection 패턴이 `detectInjection` 으로 걸러지거나
    데이터 경계 안에 갇힌다. (c) **저장**: 원본이 그대로 남는다.
    **악성 입력 고정**: `<script>`·`\n\nIgnore previous instructions` 등을 넣었을 때
    (a) 저장 원문 = 입력 그대로, (b) UI 는 `textContent` 로 표시(HTML 파싱 0),
    (c) 컴파일된 프롬프트는 **거부하거나 데이터 경계 안에 가둔다** — 셋을 **각각** 단언한다.
    (v2 기준 14 는 세 sink 를 "살균" 하나로 묶어 기대가 모순이었다.)
15. **SSE 와 트랜잭션 경계** — `question:pending` 이 channels 배열에 있고 실제 구독된다.
    **롤백된 재개 시도에서 `run:status`·`question:answered` 이벤트가 0건**이고,
    커밋 후에만 발생한다. tx 안에서 emit 하도록 바꾸면 실패하는 역회귀가 있어야 한다.
16. **waiter 상한(구체화)** — run 당 2번째 동시 wait 는 **429 + `Retry-After`** 로 즉시 반환하고,
    **첫 waiter 는 계속 유지**된다. 끊긴 waiter 는 정리되어 재연결이 막히지 않는다.
    (v2 기준 16 은 "즉시 반환"만 요구해 아무 구현이나 통과했다.)
17. **재개 원자성** — `resume` 2회 → 하나만 200, 하나는 409 + 기존 `resumed_run_id`, run 은 1개만.
    **추가로**: 트랜잭션 안에서 run INSERT 를 실패시키면 **질문도 롤백**되어
    `resumed_run_id` 가 NULL 이고 **재시도가 성공**한다. CAS 와 INSERT 를 분리한 구현으로 바꾸면
    이 테스트가 실패해야 한다(고착 재현).
    **생성 경로 호환**: 만들어진 queued run 이 기존 `claimQueuedRun` 을 통과해 실제 spawn 가능한
    필드를 갖고, **커밋 후 drain 이 그것을 claim** 한다.
18. **재개 run 이 답을 소비** — 새 run 의 컴파일된 프롬프트에 `[ANSWERED QUESTION]` 블록과
    `source_question_id` 가 있다. 블록을 제거하면 실패하는 역회귀가 있어야 한다.
19. **answered·미재개 가시성** — `answered` ∧ `resumed_run_id IS NULL` 이 목록·UI 에서
    **행동 가능한 상태**로 노출된다(조용히 묻히지 않는다).

## 11. 미해결로 남기는 것

- **Task blocking** — Orca `decision_gates` 는 Task 를 `blocked` 로 만든다. 우리는 Task DAG(격차 ②)가
  없어 `blocked` 의 의미가 약하다. v1 은 **run 만 막고 Task 상태를 바꾸지 않는다.**
- **Operator 응답** — `class` 를 위조 불가능한 원천에서 얻을 수 있을 때 재검토 (§4).
- **사람 신원 감사** — 단일 공유 cookie 한계 (§5.1).
- **워커 실행 계약** — 서버가 답을 저장해도 CLI 가 저절로 재개되지 않는다.
  **"등록 → 반복 wait → 상태별 분기"를 워커 프롬프트(`goalPrompt` 계열)에 명시**해야 실제로 동작한다.
  이건 이 문서가 아니라 프롬프트의 계약이며, **구현 시 반드시 함께** 한다.
