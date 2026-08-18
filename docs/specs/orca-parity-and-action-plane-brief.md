# Orca 파리티 + Action Control Plane — 트랙 brief

> **상태**: v1 초안 (2026-08-02). Codex 4라운드 교차검토 완료, 사용자 lock-in 완료.
> **전제 확정**: Palantir 로 **Orca 를 대체**한다. 범위는 코드 작업이 아니라 **코드 + 일상 업무 전반**을 아우르는 에이전트 오케스트레이션 플랫폼이다.
> 계층은 Master → Operator → Worker 를 유지하고, 매니저를 통한 **전체 관리·통제·보고**가 제품의 축이다. 인프라 학습(메모리)도 중요 축이다.
> **선행 완료**: R-1 계약 드리프트 수리 (PR #498, `7a3ca1f`).

> ## ⚠️ 이 문서의 lock-in 범위
>
> 이 brief 가 lock 하는 것은 **방향·순서·기각 사유**다. **구현 spec 이 아니다.**
> `goal-session-protocol.md` §1 의 lock-in 규약("이 문서를 가리켜 진행 지시 = 큐 항목 spec lock-in 승인")을 이 문서에 그대로 적용하면 안 된다.
>
> 각 단계는 착수 시점에 **별도 구현 brief** 가 필요하다. 최소한 다음이 정해지지 않았다:
> - **T6**: manifest 에 담을 operation 목록, 생성 방식, 검증·allowlist 와의 결합 지점
> - **Action plane**: 첫 connector 와 수직 슬라이스, action 상태 전이(`pending|succeeded|failed|unknown`)와 reconciliation 계약, migration/flag/rollout 순서, 수락 기준
>
> 따라서 각 단계는 "spec 재독 → 구현 brief 작성 → codex 설계검토 → 위임" 순으로 진행한다. 이 문서만 보고 바로 구현에 들어가지 말 것.

---

## 0. 왜 이 문서가 있나

사용자는 Orca(상용 데스크탑 에이전트 IDE, v1.4.159)를 **이미 실운영 중**이다. Palantir 와 겉보기 기능이 겹쳐 보여 "컨셉과 방향"을 재검토했고, 그 결과 **대체 대상과 차별 지점, 착수 순서**가 정리됐다. 판단 근거가 세션 대화에만 남으면 다른 기기·새 세션에서 재현되지 않으므로 repo 문서로 고정한다.

검토 이력: Codex 4라운드 (R1 "개발 중단" 권고 → R2 이식 설계 → R3 자기비판·충돌 정리 → R4 대체 전제 재계산). **R1 의 폐기 권고는 전제 오류로 R3 에서 Codex 스스로 철회했다** (§6).

---

## 1. Orca 실측 (명령 실행으로 확인)

`orca --help`, `orca skills get orchestration`, `orca automations create --help`, `orca orchestration task-list --json` 실행 결과.

| 축 | 실측 내용 |
|---|---|
| 형태 | macOS 데스크탑 앱 + `orca` CLI + 런타임 RPC. **`orca serve` 로 headless 가능**, `environment add --pairing-code` 로 원격 런타임 |
| 1차 단위 | repo → worktree(부모/자식 lineage, `--no-parent`) → terminal(에이전트 CLI TUI) |
| 비-repo 지원 | `project setup-existing-folder --kind git\|folder` — **폴더 워크스페이스 지원**. 다만 worktree/base-branch/lineage/PR 등 핵심 개념이 git 전제 |
| automations | cron/RRULE/timezone/missed-run-grace/workspace-mode(existing\|new-per-run)/reuse-session/**precheck+timeout**/provider(claude·codex·gemini) |
| orchestration (실험) | task DAG(deps/parent), `dispatch --inject`(lifecycle preamble 주입), `check --wait`, `ask`/`reply`, decision_gate, escalation, heartbeat, **3연속 실패 circuit-break**, `orchestration run` 자율 코디네이터 |
| 완료 권위 | 유효한 `worker_done` 을 **즉시 완료 권위로 사용**. lifecycle authority = payload `taskId`+`dispatchId` 를 dispatch 된 pane 에 대조 |
| 상태 지속성 | orchestration 메시지·태스크는 **persistent**(과거 기록 조회됨). "휘발성"이라는 초기 가정은 **틀렸다** |
| 원격 | SSH 연결 모드는 pod 에 `orca serve` 조차 설치하지 않고 **relay 로 직접 접속** |
| 없는 것 | 에이전트 메모리/학습 축적, 모델·effort·비용 정책, 예산 상한, 자기보고 외의 결정론적 완료 검증, **외부 액션의 멱등성·영수증** |

### 1.0 소스 실측 정정 (2026-08-18) — §1 표의 일부 항목을 덮어쓴다

위 표는 **`--help` 출력과 명령 실행**으로 만든 것이다. 이번에 **Orca 앱 소스를 직접 읽어** 확인했고,
그 결과 **전제 하나가 틀렸음이 드러났다.** 아래가 우선한다.

읽은 곳: `/Applications/Orca.app` — `Contents/Resources/app.asar.unpacked/out/cli/{specs,handlers}/*.js`
(평문) 및 `app.asar` 내부 `out/main/index.js`(9.1MB, `@electron/asar extract-file` 로 추출).

#### (a) Orca 는 CLI 가 아니라 **Electron 데스크톱 앱**이다

- `app.asar` 122MB + `Frameworks` + 다국어 `.lproj` = Electron 앱.
- `/usr/local/bin/orca` 는 **VS Code 식 런처 33줄 bash** — `ELECTRON_RUN_AS_NODE=1` 로
  앱 안의 `out/cli/index.js` 를 실행할 뿐이다.
- 메인 화면에 **xterm.js + node-pty 로 진짜 PTY 터미널이 임베드**돼 있다.
- **CLI 는 GUI 런타임의 RPC 클라이언트이자 에이전트용 action surface 이지 본체가 아니다.**

**따라서 "웹 UI 만으로는 대체 선언에 부족하다"는 §4 4단계의 근거는 폐기한다.**
그 문장은 "Orca 의 본체가 터미널/CLI"라는 오해에서 나왔다. Orca 도 GUI 가 주 경로다.
**"Orca 터미널 UI 전체를 복제하지 않는다"는 유지**하되 표현을 고친다 —
Orca 는 단순 터미널 UI 가 아니라 **GUI workspace/terminal 자원 관리자**이고,
split/focus/tab topology·renderer-backed TUI·worktree 사이드바 복제는 우리 방향과 맞지 않는다.

**대체 판정 기준을 바꾼다**: UI 종류가 아니라 —
> 사람과 에이전트 양쪽이 **같은 durable control-plane 연산**을 부를 수 있고,
> 실제 운영 workflow(terminal lifecycle · 질문/승인 · retry · workspace · automation 이력)가
> **손실 없이 이식**됐는가.

#### (b) `orchestration run` 자율 코디네이터는 **퇴역했다**

§1 표의 "`orchestration run` 자율 코디네이터" 는 현 버전과 맞지 않는다.
`orchestration.run` / `orchestration.runStop` 은 `RETIRED_ORCHESTRATION_METHODS` 이고
handler 가 migration 안내만 반환한다. 실제 코디네이터 루프는 **에이전트가 orchestration skill 을
읽고 경량 primitive 를 조합**하는 방식이다.

#### (c) 실제 데이터 모델 — `orchestration.db` (SQLite/WAL, Electron userData)

명령 표면이 아니라 **스키마 원문**이다. 우리가 mailbox 를 설계할 때의 기준선이다.

```sql
messages(id, run_id,
  delivery_contract CHECK('legacy_direct'|'current_delivery'|'audit_only'),
  from_handle, to_handle, subject, body,
  type CHECK('status'|'dispatch'|'worker_done'|'merge_ready'|'escalation'
            |'handoff'|'decision_gate'|'question'|'heartbeat'),
  priority CHECK('normal'|'high'|'urgent'),
  thread_id, payload, read,
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,   -- 단조 순서
  created_at, delivered_at, sender_pane_key)    -- 송신자 신원을 기록 시점에 고정

deliveries(id, run_id, consumer_generation, message_ids,
  status CHECK('outstanding'|'acknowledged'|'fenced'), created_at, acknowledged_at)
UNIQUE INDEX ON deliveries(run_id) WHERE status='outstanding'   -- run 당 outstanding 1개

mutation_receipts(caller_fingerprint, request_id, method, payload_hash,
  state CHECK('pending'|'completed'), receipt,
  PRIMARY KEY(caller_fingerprint, request_id))                  -- 멱등 영수증

tasks(id, run_id, parent_id, deps,                              -- deps = JSON 배열
  created_by_terminal_handle, created_by_pane_key,
  created_by_process_incarnation, created_by_run_generation,    -- 생성자 provenance
  spec, status CHECK('pending'|'ready'|'dispatched'|'completed'|'failed'|'blocked'), result)

dispatch_contexts(id, run_id, task_id, contract_version,
  launch_token_hash, assignee_handle, assignee_pane_key,
  capability_hash, process_incarnation, capability_revoked_at,   -- capability 모델
  status CHECK('pending'|'dispatched'|'completed'|'failed'|'circuit_broken'),
  failure_count, last_failure, last_heartbeat_at)

decision_gates(id, run_id, task_id, question, options,
  status CHECK('pending'|'resolved'|'timeout'), resolution)

question_threads(message_id PK, run_id, dispatch_id, asker_handle,
  status CHECK('pending'|'answered'|'closed'),
  answer_message_id, answer_body, answered_by_generation)

worker_dispatches(dispatch_id, runtime_epoch,
  state CHECK('starting'|'ready'|'start_unknown'|'failed'|'succeeded'
             |'stopping'|'stop_unknown'|'stopped'|'abandoned'),
  stage, worktree_id, agent_terminal_handle, setup_state,
  effects, residual_resources, start_options, last_error)
```

#### (d) 검증된 계약 (설계 기준선)

- **ack 는 삭제가 아니다** — Delivery 를 `acknowledged` 로, 포함 Message 를 `read=1` 로. **멱등**.
- **ack 전 재호출은 같은 Delivery ID·같은 메시지 목록을 replay**. 새 메시지가 와도 구성이 안 바뀐다.
- Delivery = unread 메시지를 `sequence ASC` 로 **최대 50개** 묶은 FIFO 배치.
- **`consumer_generation`** 으로 consumer 재바인딩 시 이전 Delivery 를 `fenced`.
- **timeout·연결끊김·취소는 아무것도 소비하지 않는다**(출력이 "no messages were consumed" 로 명시).
- **replay 는 "MAY HAVE BEEN SEEN" 라벨** — at-least-once 를 소비자에게 드러낸다.
- **`check` 는 기본이 파괴적**(mark-read). `peek`/`all`/`unread:false` 만 읽기 전용
  (`isOrchestrationMutation` 이 이걸 mutation 분류의 기준으로 쓴다).
- `ask` 기본 **600s** / 최대 **1800s**, 클라이언트 timeout = 서버 + **5s** grace.
  `check --wait` 기본 **120s**. wait 중 **keepalive JSON 을 stderr 로** 흘린다(stdout 은 payload 전용).
- **`start_unknown`/`stop_unknown` 이 1급 상태**이고 `residual_resources` 를 동반한다.
- `dispatch_contexts` 에 **`circuit_broken` + `failure_count`** — attempt 단위 circuit breaker.

#### (e) automations 는 격차가 작다 (재평가)

§2 갭 표는 스케줄러를 큰 결손으로 적었으나, A1/A2 완료 후 **timezone·grace·misfire·durable
occurrence/history·run-now·precheck·연속 3회 precheck 오류 disable** 이 모두 있다.
남은 차이는 **cron/RRULE 범용성**과 **automation 별 workspace/session mode** 뿐이고,
precheck 은 오히려 우리가 더 안전하다(Orca = raw command, 우리 = human-attested artifact check).

#### (f) 가장 큰 격차 3개 (재정의)

1. **durable mailbox + ask/reply + decision gate** — 무인 운영 중 워커가 막혔을 때 필요한 것은
   stdin 대기가 아니라 *질문을 durable 하게 등록 → 나중에 응답 → 그동안 Task block → 재시작 후 resume*
   이다. 우리는 로컬 stdin 뿐이고 **원격은 아예 실패**한다. **1순위.**
2. **Task DAG + Dispatch attempt identity** — "A·B 끝나면 C", "실패한 시도만 교체",
   "이 완료 보고가 현재 시도 것인가"를 표현 못 한다. 다만 실사용 자동화 2개가 선형이라 **2순위**.
3. **원격 포함 워커 terminal lifecycle** — `stop/abandon/retain/release` 와 `unknown` 표면화.
   "DB status 를 cancelled 로 바꿨다"와 "실제 프로세스가 멈췄다"는 다르다.

#### (g) 얇은 CLI 의 위치 (정직한 평가)

Orca 대응물은 `worker-start`/`worker-read`/`terminal send`/`worker-stop` 이지만 **의미 파리티가 낮다** —
`spawn` 은 worktree placement·retry linkage·terminal ownership 을 못 담고, `input` 은 durable
message 가 아니라 stdin 이며 원격에서 실패한다. **Orca 에서도 CLI 는 본체가 아니다.**

다만 **S-A/S-B 의 커서 설계는 검증됐다** — Orca `worker-read` 도 커서를 소스에 pin 하고
`source_changed` 를 알린다. 우리가 독립적으로 같은 결론에 도달했다.

### 1.1 결정적 관측 — 지식이 프롬프트에 하드코딩된다

사용자가 운영 중인 automation 2개의 프롬프트 길이:

- `C2 Code Review` — **15,615자**
- `Notion 버그 → GitHub 이슈 동기화` — **6,258자**

그 안에 실패에서 배운 운영 지식이 자연어로 박혀 있다.

> "이 레포는 병렬 PR 이 각각 마이그레이션을 추가한 뒤 rebase 없이 순차 머지되면 develop 에 head 가 2개 이상 생기는 회귀가 **반복**된다"
> "단일 문자열만 파싱하면 head 개수를 크게 틀린다(**실제로 3개를 151개로 오판한 사례가 있다**)"
> "**실제로 그렇게 2시간 넘게 멈춘 적이 있다**" (rmdir 승인 프롬프트)

**새 교훈은 사람이 프롬프트를 손으로 고쳐야 반영되고, 다른 automation 으로 재사용되지 않는다.**

⚠️ **다만 이것을 전부 자연어 메모리로 옮기면 퇴행한다** (Codex R4). 포트 목록·판정법·건수 산정법은 가능한 만큼 **typed configuration · deterministic check · regression test 로 승격**하고, 메모리는 **이유와 맥락**을 보완해야 한다.

### 1.2 Notion→GitHub automation 이 손으로 구현한 것

이 프롬프트는 사실상 **Palantir 가 시스템으로 제공해야 할 것의 명세서**다.

| 프롬프트가 해결한 문제 | 원문 근거 | 시스템이 줘야 할 것 |
|---|---|---|
| 멱등성 | "GitHub 이슈 생성 API 에는 idempotency key 가 없다. 201 직후 Notion 쓰기 전에 죽는 경로를 막지 못한다" → 본문에 `<!-- notion-page-id: ... -->` marker 심고 생성 전 검색 | action ledger + idempotency key |
| 부분 실패 3-state | "생성 호출이 타임아웃되면 **실패가 아니라 '결과 불명'으로 취급**한다" | `unknown` 상태를 1급으로 |
| 조용한 실패 | "GitHub REST 는 권한이 없으면 라벨·Issue Type 을 **조용히 무시**하므로 `201` 만으로는 규칙 충족이 보장되지 않는다" | read-back validator(영수증) |
| 트랜잭션 경계 | "경과 17분을 넘기면 새 이슈 생성을 시작하지 않는다 — 강제 종료되면 **고아 이슈**가 남는다" | 액션 단위 커밋 경계 |
| 스키마 드리프트 | "property ID 를 실행 내내 사용한다. **이 DB 는 상태 속성 이름이 비어 있던 이력이 있다**" | R6 환경 사실 메모리 |

---

## 2. Palantir 갭 (실코드 확인)

| 갭 | 근거 |
|---|---|
| **워커→Operator 질문 경로 없음** | `run:needs_input` 은 SSE(UI)와 webhook 으로만 소비. `conversationService` 라우팅 0건 (`eventChannels.js`, `webhookService.js`) |
| **원격 워커에 입력 전달 불가** | `remoteSshExecutor.js:1973` `sendInput` 이 `return false` 스텁 — "Interactive remote input is deferred to P5" |
| **구조화된 워커 진행(phase) 보고 없음** | health loop(`lifecycleService.js:318` timer 선언, `:4264` 스케줄, `:3541` 루프 본체)은 출력 변경 감지·출력 snippet·CPU 활동·idle timeout·terminal 전이를 처리한다. 즉 "생존 확인만"은 아니지만 **워커가 자기 작업 단계를 선언하는 채널은 없다** |
| Task 의존 DAG 없음 | `parent_task_id`(migration 004)의 원래 의도는 recurrence 계보다. 다만 `taskService.createTask`(`:180`,`:213`)와 생성 라우트(`routes/tasks.js:98`)가 호출자 입력을 그대로 받으므로 **필드가 recurrence 전용으로 강제되지는 않는다.** 없는 것은 **의존성 enforcement 와 ready 계산**이다 |
| 회로 차단기 비영속 | `app.js` `autoReviewCounts` 가 in-memory Map. **실패 횟수가 아니라 자율 검토 라운드 수**이므로 Orca 의 "3연속 실패"로 치환하면 안 됨 |
| 인바운드 이벤트 트리거 없음 | `server/routes/` 에 webhook 수신 라우트 0건. `webhookService` 는 아웃바운드 전용 |
| **`action` goal kind 미구현** | `goal-delegation-brief.md` §2 가 "외부 side effect 업무는 receipt/action ledger + idempotency key + approval boundary 가 필요한 별도 goal kind — **v2 유보**" 로 명시 |
| durable artifact/action doer 부재 | folder-less specialist 는 `PALANTIR_OPERATOR_SPECIALIST=1` + API key 뒤에 있고, `registry_metadata_search` 서버 도구로 최대 10회 model/tool-use 반복을 한다(`specialistBackend.js:12`,`:165`,`:260`). 즉 **순수 텍스트 전용은 아니다** — 정확히는 "제한된 읽기 전용 doer 는 있으나 durable run·artifact·외부 action 을 만드는 doer 가 없다". ⚠️ `goal-delegation-brief.md:21` 의 "텍스트 전용 1회 API 턴" 표현도 현재 코드보다 좁다 |
| cap 이 실제로는 soft | `lifecycleService` budget lookup 이 fail-open + 예약 없음. **codex 워커는 비용도 토큰도 집계되지 않는다** — `lifecycleService:3485` 경로가 `exit_code`/`result_summary` 만 저장하고(claude 워커는 `:3282` 에서 usage 파싱), 매니저 codex 는 `codexAdapter:967` 이 `cost_usd:null` 을 넘긴다. **그리고 `runService.updateRunResult` 가 `cost_usd ?? 0` 으로 저장하고 스키마 기본값도 `0`(`001_initial.sql:54`)이라 DB 에는 `NULL` 이 아니라 `0` 이 남는다** → codex 워커에 cap 무력 |
| goal 성공 판정 범위 | `goalVerdict.js` — gating check 가 **ran+failed** 일 때만 결정론 분기. 부재/skipped/advisory 는 전부 `gate2`. "서버가 성공을 결정론적으로 증명"하지는 **않는다** |

---

## 3. 구조적 우위 (Codex R4 판정)

| 자산 | 판정 |
|---|---|
| MCP 중앙 관리·정책 주입 | **실제 무기.** stdio/http transport, env denylist, immutable alias, snapshot drift 관측. 단 이는 *capability distribution* plane 이지 *action governance* plane 이 아니다 |
| Operator 일반화 | 방향은 맞으나 **부분 구현**. 실제 coder Operator 는 여전히 항상 folder+dispatcher |
| 메모리 3축(workspace/profile/user) | **전 업무에서 실제 차별점.** 단 외부 action receipt 로 확인된 사실만 자동 승격해야 하고, workflow 정책을 메모리로 대체하면 안 된다 |
| 웹 서버 | **실제 무기.** headless·원격·모바일 접근이 한 서버에. 단 외부 webhook 공개 전 별도 trigger auth + TLS/reverse proxy 경계 필요 |
| durable verdict | **가장 강한 재사용 자산.** persist·CAS·retry child·outbox·boot reconcile 을 한 소유자가 처리. action ledger 의 설계 패턴으로 재사용 |

> 우위는 "에이전트를 많이 띄운다"가 아니라 **도구·기억·검증·승인·실행 이력을 중앙 서버 정책으로 묶을 수 있는 구조**다.

---

## 4. 착수 순서

### 0단계 — 선행 수리 (외부 권한 추가 전 필수)

외부 side effect 를 만들기 시작하면 **잘못된 계약이 외부로 확대**되므로 먼저 닫는다.

- **R-1 계약 드리프트** ✅ 완료 (PR #498) — goal/non-goal 분기, non-goal 자동 done 보존
- **R-2 + R-3 — ⏸ DEFER (2026-08-03, 사용자 결정)**

  **왜 미루나**: 최소안(cap 을 "soft spend-governance guard" 로 재명명 + 비용 미집계 표면화)은 **cap 을 고치지 않는다.** "cap 이 고장나 있다"를 보이게 할 뿐이다. 그런데 `budget_usd` 를 설정한 프로젝트가 실제로 없다 — 아무도 안 쓰는 기능의 고장을 표면화하는 셈이다.

  예산 통제가 실제로 필요해지는 시점은 **2단계 action control plane 에서 외부 API 호출 비용이 커질 때**인데, 그때 필요한 것은 run 단위 USD cap 이 아니라 **액션 단위 비용·쿼터**라는 다른 설계다. 지금 반쪽짜리 표면화를 만들어두면 그때 걷어내야 한다.

  **재개 조건**: (a) `budget_usd` 를 실제 운영에 쓰기 시작하거나, (b) action plane 에서 비용 통제 설계를 할 때 함께. 그때는 아래 사실들이 입력값이다.

  **현재 사실 (재개 시 출발점)**:
  - **claude 워커만 비용이 잡힌다.** stream-json `result` 이벤트의 `costUsd` 를 저장(`lifecycleService:3282`).
  - **codex 워커는 비용도 토큰도 저장되지 않는다** — `exit_code`/`result_summary` 만(`lifecycleService:3485`). codex 매니저는 토큰은 저장하되 `cost_usd:null`(`codexAdapter:967`).
  - **`cost_usd` 는 DB 에 `NULL` 이 아니라 `0` 으로 남는다** — `runService.updateRunResult` 가 `?? 0`, 스키마 기본값도 `0`(`001_initial.sql:54`). 따라서 **`cost_usd IS NULL` 탐지는 무효**이고, codex 워커는 토큰조차 없어 "토큰>0인데 cost=0" 도 못 쓴다. 실현 가능한 후보는 **벤더 판별**(`utils/agentVendor.resolveAgentVendor(profile.command)`) 또는 "계측이 전무한 terminal run" 이다.
  - cap 은 lookup fail-open + 예약 없음 → 동시 spawn 이 함께 통과 가능.

  **기각된 전체안** (재검토 시 이 사유부터 반박할 것)
  - ⚠️ **전체안은 기각됨**: (a) 추정 가격표 + `--json` 은 codex 워커의 현재 plain stdout 계약을 바꾸고 출력 수집 경로들을 함께 손대야 하며 가격표 갱신 부채를 만든다. (b) 원자적 reservation 은 **codex 계획이 제안한 "남은 잔액 전체를 예약" 방식일 때** capped 프로젝트를 상시 직렬화(워커 1개)한다 — per-run 최대 지출 상한이라는 새 제품 계약이 없어서 부분 예약을 할 수 없기 때문이다. cap 이 이미 fail-open 이고 단일 run 초과도 못 막는 상황에서 비용/편익이 맞지 않는다. per-run 상한을 도입한다면 재검토 가능하다
- **R-4** — 대상 없음으로 종결. `goal-delegation-brief.md` 의 deterministic 서술은 이미 정확하다

### 1단계 — T6-min: manager-callable operation manifest

Operator 가 호출 가능한 API 만 담은 작은 manifest 를 만들고 **auth allowlist · 요청 검증 · 프롬프트 계약 · `GET /api/agent-context` 의 공통 원천**으로 쓴다. 전체 Express route 자동생성은 스키마가 없어 불가.

근거: R-1 같은 드리프트가 구조적으로 재발하지 않게 하고, 이후 모든 이식 API 의 계약 원천이 된다.

### 2단계 — Action control plane ★ 본체

`action` goal kind + execution broker + postcondition + 승인 정책을 **쪼개지 말고 하나로** 설계한다.

- action ledger (무엇을·언제·어디에)
- idempotency key
- read-back validator (선언한 효과가 실제 발생했는지 외부 API 재조회)
- **`unknown` 상태 1급** — 외부 호출 직후 죽은 경우를 `failed` 로 보고 재시도하면 중복이 생긴다. unknown 과 reconciliation 을 **정상 상태로 인정**
- 승인 경계 — 외부 메시지·배포·merge 는 `req.auth.method === 'cookie'` **서버 유도 provenance만**
- action worker 분리 — 직접 credential 없이 서버 gateway 만 호출

### 3단계 — 스케줄러 파리티

`precheck`(raw command 금지, named verify check 참조) · missed-run grace + misfire policy · **프롬프트 외부화/버전관리** · action target.
**비채택**: `workspace_mode` / `reuse_session` — Operator 는 지속 identity 라 세션 교체가 thread 소유권을 깬다. RRULE 은 P3.

### 4단계 — 얇은 `palantir` CLI

spawn / follow / input / cancel 만. **Orca 터미널 UI 전체를 복제하지 않는다.** 웹 UI 만으로는 대체 선언에 부족하다는 판정.

### 5단계 이후

T1 durable 질문/승인 mailbox → inbound event inbox → T5 durable review ledger → T2 worker progress → **T3 DAG 마지막**.

#### T1 설계 주의 (초안 기각됨)

`POST /runs/:id/input` 으로 Operator 답변을 워커에 복귀시키는 설계는 **fleet 에서 조용히 실패**한다 (`remoteSshExecutor.sendInput` = `return false`). 워커가 **가져가는** 구조여야 원격이 산다.

```
POST /api/runs/:runId/questions   워커가 질문 등록(idempotency key + class + options)
GET  /api/questions/:id/wait      워커가 long-poll 로 응답 수신 (stdin 불요)
POST /api/questions/:id/respond   Operator 또는 사람이 CAS 로 1회 답변
```

질문 class 를 서버가 판정하는 enum 으로 제한한다. **Operator 가능**: 정보 요청·명확화·가역적 선택. **사람(cookie)만**: 예산 증액·자격증명·권한 상승·파괴 작업·외부 메시지/배포/merge·정책 예외·분류 불명확.
수신자 귀속: archived instance 를 **조용히 재귀속하지 않는다** — 원 귀속 보존 후 사람 inbox 로.

---

## 5. 안 할 것 (자르기 목록)

1. **Orca IDE 복제** — 내장 브라우저·iOS/Android 에뮬레이터·computer-use·터미널 pane. 브라우저는 Playwright MCP 로 남긴다
2. **vendor·connector marketplace 확장** — Claude/Codex 와 Notion/GitHub 에 집중
3. **범용 DAG / 비주얼 워크플로 빌더 / 완전한 RRULE / 세션 lineage** — 실사용 자동화와 action plane 이 먼저다
4. **`orcaExecutor`** — Orca CLI 는 worktree/terminal/orchestration 이라는 **상위 상태머신**이라 `nodeExecutor` 의 exec/fs/secret/liveness 시맨틱과 층위가 맞지 않는다. 얇은 어댑터가 아니라 두 상태머신의 소유권을 번역하는 새 시스템이 된다

---

## 6. 리스크 (Codex R4)

1. **범위 폭발** — 1인 개발이 connector × operation × provider × 인증 × 재시도 × 검증을 모두 일반화하면 조합 행렬 유지에 시간이 소진된다. 대응: "전 업무"를 기능 목록이 아니라 **검증된 수직 슬라이스의 축적**으로 정의
2. **Orca IDE 재현** — 제품 정체성이 Orca 복제품으로 변한다
3. **범용 도구 버스 오해** — 모든 MCP write 를 허용하면 데모는 빠르지만 중복·오발송·감사 불능이 뒤따른다. connector 마다 typed operation 과 postcondition 을 만들지 않을 거면 **그 connector 는 아직 지원하지 않는 편이 맞다**
4. **외부 실행 경계 불확실성** — `unknown` 을 정상 상태로 인정하지 않으면 중복이 생긴다
5. **아키텍처가 실제 이식을 가린다** — 스키마·계층만 만들고 실제 workflow 가 계속 Orca 에서만 돌면 대체가 진행된 것이 아니다. **Orca 를 폐기 대상이 아니라 이식 기간의 동작 기준**으로 두고 workflow 별 shadow run → 대조 → 개별 cutover

### 6.1 Codex R1 의 폐기 권고가 왜 틀렸나 (자기비판, R3)

- "Orca 가 실행·조정을 제공하므로 Palantir 전체가 불필요" → **실행기의 중복과 운영 통제 제품의 중복을 혼동**
- "차별점은 persistence 와 무인 실행" → 사실이 틀렸고(Orca 도 persistent·headless), Orca 기능 변화 한 번에 무너지는 차별화
- "1인 유지보수 비용" → 우선순위를 좁힐 근거이지 **제품 목적을 취소할 근거가 아니다**
- 여러 노드·세션을 **중앙 Manager hierarchy 아래 통제**한다는 사용 사례를 계산에서 누락

여전히 유효한 논거: IDE surface 재구현은 중복 / `orcaExecutor` 위험 / cap·결정론 표현이 실제 보장보다 강함 / 한정된 역량은 **"모든 것을 실행하는 도구"가 아니라 "실행들을 통제·판정·기억하는 도구"** 로 집중해야 한다.

---

## 7. 한 문장

**Orca 는 에이전트를 띄우고, Palantir 는 띄운 것들을 책임진다** — 질문·승인·비용·검증·기억·실행 영수증을 하나의 관제면에서.
