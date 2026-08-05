# Action Control Plane — 구현 brief (LOCKED)

OP 트랙 §4 2단계 ★본체. `orca-parity-and-action-plane-brief.md` 는 방향만 lock 했고 이 문서가 구현
spec 이다. **codex 4라운드 적대 설계검토 GO** (R1 4B+8S → R2 1B+4S → R3 1B+1S → R4 GO). 사용자
lock-in 2026-08-05.

원칙(§6): "전 업무"는 기능 매트릭스가 아니라 **검증된 수직 슬라이스의 축적**. 첫 슬라이스를 끝까지
(ledger·승인·fencing·idempotency·read-back·unknown/reconcile) 제대로 만들고 템플릿으로 삼는다.

**설계 대전제 (codex R1)**: **외부 API(GitHub) 상대 exactly-once-create 는 불가능하다.** 안전 계약은
"**action 당 자동 `POST /issues` ≤ 1 → 결과 불명이면 durable `unknown` → read-only reconcile(자동
재-create 금지) → 재발행은 명시 reissue(새 승인)**".

## 0. 첫 수직 슬라이스 (lock)
connector=GitHub, operation=`github.create_issue`. §1.2 가 요구사항을 도출한 레퍼런스(Notion→GitHub):
문서화된 idempotency(본문 marker + 생성 전 검색)와 read-back(GitHub 이 권한 없으면 label 조용히 무시).
params `{ repo, title, body, labels? }`. **postcondition**: 그 repo 에 서버 marker 를 담은 **open** issue
가 존재하고 title/user-body 일치, 요청 label 이 **실제 적용**(subset — 무관 label 제거 안 함). typed op
하나 + fixed read-back/add-labels repair op 만. 범용 도구 버스·임의 MCP write 아님(§6 risk 3).

## 1. 실행 주체 = 서버 broker (worker 분리)
- 새 goal kind: task `goal_kind ∈ {deliverable(기존), action(신규)}`. action task 는 typed action 선언
  (connector+operation+params). 자유 외부 호출 아님.
- **실행 = 서버 execution broker(신규 서비스), CLI 워커 아님.** credential 이 워커로 나가면 leak(§4).
  broker 가 connector credential 을 서버에서만 쥐고 외부 호출+ledger+read-back 수행. durable-verdict(G3)
  패턴 재사용(persist + CAS + single-owner side effect + outbox + boot reconcile).

## 2. 상태기계 (codex 권고)
```
awaiting_approval ──cookie 승인(approved_params_hash 바인딩)──▶ queued
queued            ──fenced claim(attempt_id 발급, 승인·해시·만료 검사)──▶ executing
executing         ─ full GET 검증 통과 ─▶ succeeded
                  ─ 객체 존재하나 label 미흡 ─▶ partially_applied
                  ─ 영구·무효과 확정 거부(404 repo/422) ─▶ failed(no_effect)
                  ─ 일시·무효과 확정(rate-limit 429/abuse 403) ─▶ failed(no_effect, rate_limited)  ← 자동 재시도 안 함
                  ─ ambiguous(타임아웃/응답유실/5xx/파싱실패) ─▶ unknown
unknown           ──fenced read-only probe──▶ reconciling
reconciling       ─ 정확히 1개 full-valid ─▶ succeeded
                  ─ 정확히 1개 label 미흡 ─▶ partially_applied
                  ─ 다수/불일치 후보 ─▶ conflict
                  ─ 0건 or read-back 불명 ─▶ unknown (next_reconcile_at 재예약, **재생성 안 함**)
partially_applied ──fenced claim(repair_attempts++ < MAX, dispatch 전)──▶ repairing
repairing         ─ 검증 통과 ─▶ succeeded
                  ─ 영구 거부(권한) ─▶ repair_blocked(종결, 사람 개입)
                  ─ 일시(rate-limit) ─▶ repair_retry_wait ─▶ repairing
                  ─ ambiguous ─▶ unknown (add-labels 재판정만, create 재발행 없음)
                  ─ repair_attempts 상한 ─▶ repair_blocked
[orphan] executing/reconciling/repairing ──lease 만료 fenced──▶ unknown (절대 →queued 아님)
[expiry] queued(승인 만료) ──fenced + 감사──▶ awaiting_approval
```
- **failed = 종결·외부효과 없음 확정만.** conflict/partially_applied/unknown/repair_blocked 는 create
  재발행 트리거 아님.
- **자동 `POST /issues` ≤ 1/action.** rate-limit 도 종결(재시도는 명시 reissue=새 승인). 자동 재시도는
  **idempotent op 만**: read-only reconcile probe + add-labels repair(state-idempotent = 이미 있는 label
  재추가는 no-op). **gateway 내부 HTTP/proxy retry 금지**(POST) — 1 gateway 호출 = 1 실제 POST.

## 3. 승인 = durable 불변식
- `awaiting_approval → queued` 는 **cookie 승인 tx** 에서만. 원자 기록: `approved_at`, `approved_by`
  (인증된 actor id — 방법 아니라 주체), `approval_auth_method='cookie'`, `approved_params_hash`,
  `approval_policy_version`, `approval_expires_at`.
- **실행 claim CAS**: `WHERE status='queued' AND approved_params_hash=<현재 params_hash> AND
  approval_expires_at > now`. 승인된 params immutable — 재사용 행이 params/승인 provenance 덮어쓰기 금지.
  background runner/boot/scheduler 어느 진입점도 이 CAS 없이 실행 불가(route 하나에 의존하는 보안경계 금지).
- provenance = `req.auth.method` 서버 derive, **request body 금지**(G2 §6). bearer(agent)=선언만, 승인 못 함.
- **재승인은 provenance 소거 금지**: 이전 승인 세대를 append-only 로 보존, action 은 현재 세대 포인터만.
- 만료는 **claim 시점 원자 평가**: 만료 후 새 claim(create·repair) 금지, 이미 claim 된 op 은 완료 허용.

## 4. Attempt fencing
- claim tx 가 랜덤 `attempt_id`(=`active_attempt_id`) + `claimed_at`(lease) 발급. **actions 의 attempt-파생
  모든 변이**(external_id, candidate, receipt, error, next_reconcile_at, verdict/status)는
  `WHERE id=? AND status=<expected phase> AND active_attempt_id=?`. external_id persist(응답 즉시)도 fenced.
  **구 attempt 지연 콜백은 현재 행 변이 금지 — `action_events` 에 append 만**(증거).

## 5. Idempotency (논리적 intent)
- 정체성 = **`(task_id, action_slot)`**(또는 caller `Idempotency-Key`), connector instance+operation 스코프.
  **params-hash 를 정체성으로 쓰지 않음**(내용동일≠의도동일). `run_id` 미포함(restart/rerun = 같은 intent).
  같은 key+다른 params → **409**. 의도적 새 issue = 새 key. 별도 `params_hash`(canonical) 저장(승인 바인딩).
- connector marker: 본문에 `<!-- palantir-action-id: <action.id> -->` 심고 생성 전 검색(후보 식별). marker
  는 예약 구문 — user body 에 있으면 pre-validate 거부. 검색은 후보만 → §6 full GET 재확인.

## 6. Read-back (영수증)
- 2xx 불신. **external_id 는 응답 즉시 persist(fenced)** — 이후 GET-by-id 가 search 보다 강함.
- full GET 검증: (a) marker 가 **본문**(comment 아님) + 정확히 서버 생성 marker, (b) connector
  instance/repo 일치, (c) title/user-body 일치, (d) `state='open'`, (e) 요청 label subset 실제 적용.
  전부 → succeeded. label 미흡 → partially_applied → typed add-labels repair. 불일치/다수 → conflict.
- success = `validated_at` 시점 관측. 이후 사람 편집·close 는 drift(소급 rewrite 금지).

## 7. HTTP 분류 (op별)
영구·무효과 확정(404 repo, 422 검증) → failed. 일시·무효과 확정(rate-limit) → failed(no_effect,
rate_limited) — **자동 재시도 없음**(§2). 5xx/응답유실/파싱실패/모호 transport → unknown. 불완전 객체
→ partially_applied. read-back 실패/불명 → unknown 유지. **모든 연결실패를 보수적으로 unknown 처리해도
안전**(liveness 희생).

## 8. Durable 큐 + outbox
- **`actions` 테이블 자체가 durable 실행 큐.** in-memory 큐는 wake-up 최적화만.
- **외부 호출은 어떤 SQLite tx 안에서도 하지 않음.** 순서: ① 짧은 tx 승인/queue + outbox persist → ②
  짧은 tx fenced claim(attempt_id) → ③ **tx 밖** 외부 호출 → ④ 짧은 fenced tx 결과 + outbox 원자 커밋.
- outbox 소비자 dedup. **attempt-파생 outbox/verdict 이벤트는 fenced CAS 승자만 emit.** stale events=증거.

## 9. Evidence = append-only
- `action_events`(append-only): `action_id, attempt_id, phase, request_digest, transport_class,
  external_request_id, candidate_external_id, receipt_json(sanitized), error(sanitized redact), ts`.
  타임아웃→reconcile→repair 각 단계 독립 증거. `actions`=현재상태, 이력=events.

## 10. Credential 분리
GitHub token 은 **trusted gateway 에만.** 워커/에이전트 spawn = 명시 allowlist env(token 상속 0 —
`buildManagerSpawnEnv`/env_allowlist 재사용). fine-grained PAT / GitHub App installation token(repo
allowlist + 최소 Issues 권한). error/receipt/trace/outbox 에서 credential·Authorization redact. gateway
는 create_issue + fixed read-back/add-labels op 에만 typed.

## 11. Canonicalization + external identity
- `canonical(params)`: repo=lowercase(owner/name); labels=정렬+중복제거 배열(대소문자 보존), absent==`[]`;
  JSON key 사전순; body/title NFC; trim 안 함. `params_hash=sha256(canonical json)`.
- external identity: **`node_id`(GitHub global id)** + repo identity + issue number + html_url(json).
  **UNIQUE(connector_instance, external_node_id)** — 두 action 이 같은 issue 채택 금지.

## 12. 명시 re-create (reissue) 계약
- unknown 재발행(중복 감수)은 **별도 명시 액션**: 새 `action.id` + 새 `action_slot`(또는 새 Idempotency-Key)
  + 새 marker + `reissues_action_id` FK + **fresh cookie 승인(중복위험 ack, 정책 버전 명시)**. **원 unknown
  action 불변.** `POST /api/actions/:id/reissue`(cookie-only+CSRF) 도 idempotent(재시도 시 stable key →
  같은 child, 다른 data → 409).

## 13. migration / flag / rollout
- migration N: `actions`(불변 컬럼 NOT NULL, status/connector/operation CHECK, UNIQUE(task_id,action_slot),
  UNIQUE(connector_instance,external_node_id), reissues_action_id FK) + `action_events`(append-only).
- `PALANTIR_ACTION_PLANE=1` **기본 off** → action goal_kind 선언은 되나 실행경로 fail-closed, 기존
  deliverable/코드 goal **byte-identical**. connector-level: github token 있을 때만 enabled(없으면
  `action:connector_unavailable`).
- **하나로 설계·다중 PR**: **PR1** = migration + 전 상태기계 + 승인 gate + fencing + idempotency + outbox +
  reconcile, connector=**주입형 fake GitHub gateway(fault 주입)** 로 전 경로 결정적 검증(외부 0). **PR2**
  = 실 GitHub gateway(token/allowlist/redaction) + 승인·reissue 라우트(cookie-only+CSRF) + 격리 시험 repo
  실검증. **PR3** = UI(#actions: 목록/상태/승인/reconcile/evidence). **PR4** = task=action goal_kind 배선
  + Operator 가 action 선언.

## 14. 수락 기준 (PR1, fake gateway, 외부 0)
- **핵심 불변식**: 어떤 fault 조합에서도 fake gateway 의 `POST /issues` 호출 = action 당 자동 ≤ 1(+명시
  reissue 수). 자동 create 재발행 경로 존재 = 실패.
- 승인: bearer→awaiting_approval 만, 실행 시도 403 / cookie 승인→queued→실행 / approved_params_hash
  불일치(params 변조)→실행 거부 / 만료→awaiting_approval 재전이.
- fencing: 지연 구-attempt 콜백이 새 결과 못 덮어씀(external_id 포함).
- idempotency: 같은 (task_id,slot) 재선언→같은 행 / 다른 params 같은 key→409 / 새 slot→새 action.
- fault: client 타임아웃 후 완료 / create 성공인데 marker search empty / dispatch 후 crash / 응답 후
  external_id persist 전 crash / label 누락+응답유실 / 지연 stale 완료 / marker 다수·comment-only /
  rate-limit vs permission / background runner 미승인 action / outbox crash 경계 / orphan lease 만료 재판정.
- repair: 영구거부→repair_blocked(무한루프 0, 카운터 crash-safe pre-dispatch).
- 뮤테이션: 승인 CAS 제거→미승인 실행 / fencing 제거→stale 덮어쓰기 / unknown→queued 자동전이 추가→중복
  create / read-back 제거→label 미흡을 succeeded / repair 카운트 post-dispatch→무한 repair.
- boot reconcile: executing/unknown/reconciling/repairing 걸린 행 재판정, 자동 create 0.

## 15. 명시적 non-goal
범용 도구 버스·임의 MCP write 금지. 다른 connector(Slack/Notion/deploy/merge) 밖(축적 확장). run 단위
USD cap(#10 DEFER) 무접촉. CLI 워커 외부 credential 직접 호출 금지. exactly-once-create 미주장(불가) —
at-most-one-auto + 승인부 재발행.
