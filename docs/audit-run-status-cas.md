# `runService.updateRunStatus` CAS audit

Issue #465 changes `updateRunStatus` from an unconditional write to a
compare-and-swap (CAS). This audit covers every production
`updateRunStatus(..., { force: true })` call site as of 2026-07-29.

## Preserved contract

- `force` still bypasses `VALID_TRANSITIONS`.
- A transition to a different status still writes and emits the same status
  events as before.
- A transition from one terminal status to a different terminal status still
  writes and emits. This matters when a later authoritative observer corrects a
  prior terminal result.
- Only `terminal -> same terminal` is now a no-op. It does not rewrite
  `ended_at`, add `status:*`, emit `run:status`, or emit `run:ended`.
- Same-state non-terminal forced writes retain their previous behavior. For
  example, boot resume may write `running -> running` and still emit.

The focused tests are:

- `Phase 5: repeated forced write of the same terminal state is a silent no-op`
- `Phase 5: force still permits transitions between distinct terminal states`
- `Phase 5: terminal transition emits run:ended with semantic envelope`

## Call-site inventory

The “expected source” column is derived from the caller's query/guard and the
surrounding lifecycle. “Race” means another lifecycle observer may have changed
the row after the caller read it.

### `server/services/lifecycleService.js` (28)

| Line | Purpose | Expected transition | CAS impact |
|---:|---|---|---|
| 1033 | Invalid persisted queue args after claim | `running -> failed` | Unchanged; a repeated outer failure observation is silent. |
| 1064 | Goal activation stamp failed | `running -> failed` | Unchanged. |
| 1078 | Goal judge activation stamp failed | `running -> failed` | Unchanged. |
| 1160 | Materialized repo workspace unavailable | `running -> failed` | Unchanged. |
| 1166 | Repo feature unavailable | `running -> failed` | Unchanged. |
| 1261 | Preset resolution failed | `running -> failed` | Unchanged; the outer spawn catch may later repeat `failed -> failed`, which is now silent. |
| 1295 | Invalid skill-pack resolution | `running -> failed` | Unchanged; a later outer catch duplicate is silent. |
| 1300 | Other skill-pack resolution failure | `running -> failed` | Unchanged; a later outer catch duplicate is silent. |
| 1325 | Repo-relative MCP resolution failed | `running -> failed` | Unchanged; a later outer catch duplicate is silent. |
| 1380 | MCP bearer policy failed | `running -> failed` | Unchanged; a later outer catch duplicate is silent. |
| 1421 | HTTP MCP preflight failed | `running -> failed` | Unchanged; a later outer catch duplicate is silent. |
| 1552 | Remote goal workspace unsupported | `running -> failed` | Unchanged. |
| 1561 | Remote goal workspace creation failed | `running -> failed` | Unchanged. |
| 1574 | Local goal workspace creation failed | `running -> failed` | Unchanged. |
| 1622 | Remote Claude assets unsupported | `running -> failed` | Unchanged. |
| 1946 | Worker spawn catch | Normally `running -> failed`; it can be `failed -> failed` after an inner fail-closed path | The real failure transition is unchanged; the duplicate terminal write is now silent. |
| 2773 | Missed stream-json exit reconciliation | `running -> completed/failed` | Unchanged. |
| 2825 | Worker health observes a durable exit/result | `running -> completed/failed/needs_input` | Unchanged; duplicate terminal observations are silent. |
| 2933 | Idle check proves process dead | `running -> completed/failed` | Unchanged. |
| 2940 | Live but idle process needs input | `running -> needs_input` | Unchanged. |
| 3002 | Output resumes after `needs_input` | `needs_input -> running` | Unchanged. |
| 3009 | Process exits while awaiting input | `needs_input -> completed/failed` | Unchanged. |
| 3069 | Boot recovery obtains a durable terminal result | `running/paused/needs_input -> completed/failed/needs_input` | Unchanged; same terminal duplicates are silent, while same non-terminal `needs_input` retains emission. |
| 3209 | Revoke an expired remote worker capability | `running/paused/needs_input -> stopped` | Unchanged. |
| 3346 | Revoke an expired local worker capability | `queued/materializing/running/paused/needs_input -> stopped` | Unchanged. |
| 3392 | Boot recovery finds a dead local session | `queued/running -> completed/failed` | Unchanged. |
| 3649 | Accepted user input resumes a worker | `needs_input -> running` | Unchanged. |
| 3672 | Explicit worker cancellation | Guarded non-terminal `-> cancelled` | Unchanged; the public method returns early for terminal runs. |

### `server/services/operatorCleanupService.js` (3)

| Line | Purpose | Expected transition | CAS impact |
|---:|---|---|---|
| 87 | Normal Operator reset/dispose | Active manager `-> cancelled` | Unchanged. If a race already wrote `cancelled`, the duplicate is silent; another terminal status can still be overwritten because `force` is preserved. |
| 188 | Last-resort force reset | Active or stale manager `-> failed` | Unchanged. Same `failed` is silent; a different terminal status still changes to `failed`. |
| 253 | Operator-instance reset | Active manager `-> cancelled` | Unchanged, with the same race behavior as line 87. |

### `server/services/managerRegistry.js` (2)

| Line | Purpose | Expected transition | CAS impact |
|---:|---|---|---|
| 177 | Superseded manager slot | Prior active run `-> stopped` | Unchanged. A stale different terminal status can still be authoritatively replaced with `stopped`; duplicate `stopped` is silent. |
| 237 | Liveness probe sees manager exit | Active/stale run `-> completed/failed` | Unchanged. Duplicate exit observations no longer emit a second terminal event. |

### `server/services/streamJsonEngine.js` (7)

| Line | Purpose | Expected transition | CAS impact |
|---:|---|---|---|
| 448 | Remote worker SSH transport loss | Explicitly guarded non-terminal `-> failed` | Unchanged. |
| 482 | Process exit without an owning result event | Explicitly guarded non-terminal `-> completed/failed` | Unchanged. |
| 562 | Async remote spawn failure | Explicitly guarded non-terminal `-> failed` | Unchanged. |
| 724 | Claude worker error result | Normally `running -> failed` | Unchanged; an exit-handler race repeating `failed` is silent. |
| 731 | Claude worker turn/token limit | `running -> needs_input` | Unchanged. |
| 753 | Claude worker successful result | `running -> completed` | Unchanged; an exit-handler duplicate is silent. |
| 758 | Claude manager error result | Active manager `-> failed` | Unchanged; repeated error/exit observations are silent only when already `failed`. |

### `server/services/conversationService.js` (1)

| Line | Purpose | Expected transition | CAS impact |
|---:|---|---|---|
| 1075 | Accepted manager message resumes session | Guarded `needs_input -> running` | Unchanged. |

### `server/services/managerAdapters/codexAdapter.js` (6)

| Line | Purpose | Expected transition | CAS impact |
|---:|---|---|---|
| 575 | MCP argument preparation failed | Manager `queued/running/needs_input -> failed` | Unchanged; later cleanup/probe duplicates are silent. |
| 613 | Spawn guard rejected the Codex process | Manager `queued/running/needs_input -> failed` | Unchanged; later duplicates are silent. |
| 699 | Child process emitted a spawn error | Manager `queued/running/needs_input -> failed` | Unchanged; later duplicates are silent. |
| 731 | Codex turn exited nonzero | Manager `queued/running/needs_input -> failed` | Unchanged; later duplicates are silent. |
| 762 | Async placement/spawn failed | Manager `queued/running/needs_input -> failed` | Unchanged; later duplicates are silent. |
| 1027 | Synchronous turn MCP validation failed | Manager `queued/running/needs_input -> failed` | Unchanged; later duplicates are silent. |

### `server/services/operatorSpawnService.js` (3)

| Line | Purpose | Expected transition | CAS impact |
|---:|---|---|---|
| 148 | Shared Operator materialization failure helper | `queued/materializing -> failed` | Unchanged; repeated helper/outer error observations are silent. |
| 590 | Remote Operator executor unavailable | `queued -> failed` | Unchanged. |
| 799 | Operator adapter startup failed | `queued/running -> failed` | Unchanged; a callback may already have moved the run to `running`. |

### `server/routes/manager.js` (6)

| Line | Purpose | Expected transition | CAS impact |
|---:|---|---|---|
| 229 | Resume stale Top manager | `queued/needs_input/running -> running` | Unchanged, including `running -> running` emission because it is non-terminal. |
| 243 | Top manager cannot resume at boot | `queued/needs_input/running -> stopped` | Unchanged. |
| 544 | Resume stale Operator manager | `queued/needs_input/running -> running` | Unchanged, including same-state non-terminal emission. |
| 561 | Operator manager cannot resume at boot | `queued/needs_input/running -> stopped` | Unchanged. |
| 885 | New Top manager startup failed | `queued/running -> failed` | Unchanged. |
| 1294 | Explicit Top manager stop | Active/stale manager `-> cancelled` | Unchanged. Same `cancelled` is silent; a different terminal state can still be overwritten by this forced command. |

## Beyond the `force: true` inventory

이 문서의 호출 지점 목록은 제목대로 `force: true` 만 다룬다. 교차검토에서
그 범위 **밖**의 두 인접 지점이 지적되어 함께 기록한다.

**1. 유일한 unforced 프로덕션 호출자 — `server/routes/runs.js` 의
`PATCH /api/runs/:id/status`.** 초기 구현은 terminal-same-state 검사를
`if (!force)` 게이트 **앞**에 두어, 이 라우트가 terminal run 에 같은 상태를 다시
쓸 때 400 대신 **조용히 200** 을 반환하게 만들었다. 내부 관측자를 de-duplicate
하려다 외부 API 계약을 부수적으로 바꾼 것이다.

수정: 그 검사를 `force` 로 게이트했다. unforced 경로는 `VALID_TRANSITIONS` 를
그대로 타므로 기존 400 이 유지되고, 테스트가 이를 고정한다.

**2. `runService.persistGoalVerdictTxRun` (G3, 이 변경 이전 코드)** 도
`retry_root_run_id` / `retry_count` 를 쓰므로 새 부분 유니크 인덱스의 적용을 받는다.
검토 결과 안전하다 — 자체 per-run CAS(`WHERE goal_verdict IS NULL`)로 부모당 자식이
최대 1개이고 `retry_count` 는 `parent.retry_count + 1` 로 결정적이며, goal-active run 은
구조적으로 B-lite 에서 제외되므로 두 계보가 충돌할 수 없다. 결함은 아니지만
인덱스를 건드릴 때 함께 봐야 하는 지점이라 남긴다.

## Conclusion

The CAS does not narrow `force`. All 56 callers retain their ability to bypass
the state machine, including terminal-to-different-terminal correction. The only
observable contraction is the intended idempotency rule for a repeated write of
the same terminal state — and that rule now applies to forced writers only.

중복으로 버려지는 쓰기도 완전히 사라지지는 않는다. 경합에서 진 관측자가 오히려
더 유용한 `reason` 을 들고 있을 수 있으므로(idle timeout 이 rate-limit 분류를
이길 수 있다), 그 reason 은 `status:duplicate_terminal` **annotate-only** 이벤트로
남는다. status 행도 `run:ended` 도 만들지 않으므로 CAS 의 목적은 그대로다.
