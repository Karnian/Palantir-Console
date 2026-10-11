# C1 개정 — 개인 비서 (세션 상태·영구 대화·승인 기억·Orca식 화면)

- 상태: v5 — codex 설계검토 R6 **GO** (2026-10-11). 구현 대기
- 상위 문서: [C1 세션 비서 brief](./c1-session-hub-chat-brief.md) v8. 이 문서는 C1 v8 의 **개정분**이다. 여기 적지 않은 경계(broker 응답 형식·hub 토큰·spawn argv·hook 관측·프로세스 그룹 회수·cookie/Origin 규칙·근거 칩 살균)는 v8 그대로다.
- 선행: PR-A #587, PR-B #588 merged. PR-C #589(draft)는 이 개정의 화면 PR 로 고쳐 쓴다.

## 0. 왜 개정하나

사용자가 PR-C 미리보기를 보고 남긴 말(2026-10-11, 원문):
"완료여부 제대로 확인을 못하는데? 그리고 컨셉이 좀 어색해. 오르카 ui 처럼 전체 세션 보면서 통합 비서 세션이 있으면 좋겠는거고, 그 비서는 대화가 초기화되지 않으면서 메모리가 계속 유지될 수 있는 구조여야 개인비서로서 제대로 동작하는거 아냐?"

실측한 원인:
- **상태가 안 보임**: live `orca worktree ps --json` 의 `agents[].state` 는 `working`/`done` 인데(실측 14개 = working 1, done 13), `server/services/observeSnapshotPolicy.js` 의 `agent_state` enum 에 이 값이 없어 `mapOrcaEnum` 이 전부 `unknown` 으로 떨어뜨린다. 스냅샷 179 세션 중 상태 값이 있는 카드 0. 게다가 Orca 확정 연결은 12/179 라, 나머지 세션은 상태 신호 자체가 없다. 스냅샷은 수동 생성이라 오래되기도 한다.
- **대화가 초기화됨**: 세션 비서 대화는 서비스 메모리에만 있다(v8 §1.3 "대화 상태"). 재시작하면 사라진다. 기억 수단도 없다(auto-memory off, 도구 0).

사용자 결정(2026-10-11, AskUserQuestion):
| 결정 | 선택 |
|---|---|
| 화면 배치 | **목록 \| 비서 채팅(항상 보임) \| 세션 상세(오른쪽, 좁으면 서랍)** |
| 목록 정렬 | 기본 **상태별 묶음**, **머신·repo 묶음**으로 바꿔 볼 수 있음 |
| Palantir Top·Operator·작업 그리드 | 사이드바의 **별도 묶음** |
| 기억 저장 | 비서가 **제안 → 사람이 승인** |

codex 교차검토(R1 GO, 합의): 상태는 reader 에서 계산 + 실제 스냅샷 갱신, 대화는 DB 영구 기록 + 재시작 시 **새 claude 세션에 맥락을 주입**(`--resume` 미사용), 기억은 **비서 전용 테이블**, PR-C 는 고쳐 쓴다.

| 범위 안 | 범위 밖 |
|---|---|
| 세션 상태(Orca 매핑 + transcript 턴 상태) | 실시간(초 단위) 상태·완료 알림 — 측정 후 판단 |
| 스냅샷 새로 만들기 버튼 + 5분 자동 수집 (= v8 PR-D) | 터미널 출력 읽기 (C1b) |
| 비서 대화 영구 기록·재시작 후 이어가기 | 다른 세션에 지시 보내기 (C2) |
| 비서 기억: 제안 → 승인 → 주입, 사람이 관리 | 비서 기억을 Top·Operator 와 공유 |
| Orca식 3단 화면, Palantir 매니저 묶음 | 일 "완료" 판정(응답 끝남과 구분) |

## 1. 세션 상태 (PR-S)

### 1.1 표시 의미 (고정)
상태는 **증거에서만** 만든다. "일 완료", "내 차례", "오래 멈춤" 은 이 신호에서 만들지 않는다.

| 값 | 화면 문구 | 증거 |
|---|---|---|
| `working` | 작업 중 | Orca `working` / transcript 의 열린 턴(사용자 지시 뒤 턴 종료 증거 없음) |
| `waiting` | 입력 대기 | Orca 의 승인·입력 대기 값(실제 값 집합은 §1.2 에서 확인) |
| `ended` | 응답 끝남 | Orca `done`(중단 아님) / transcript 턴 종료 증거 |
| `interrupted` | 중단됨 | Orca `interrupted:true` / Codex `turn_aborted` / Claude 사용자 중단 레코드 |
| `unknown` | 알 수 없음 | 증거 없음·형식 미검증·해석 불가 |

`working` 이 오래 지속된 것은 상태가 아니라 **관측 시각**(`evidence_at`)으로 보여 준다("작업 중 · 2시간 전 마지막 활동").

### 1.2 Orca 상태 매핑
- Orca 1.4.207 의 agent state 전체 값 집합을 app.asar(`out/main/index.js`, `out/main/chunks/*`)에서 원문으로 확인하고, 정책 enum 을 그 값으로 바꾼다. 매핑 표(Orca 값 → §1.1 값)를 정책 모듈에 둔다. 모르는 값은 `unknown`.
- `interrupted:true` 는 state 와 무관하게 `interrupted`.

### 1.3 transcript 턴 상태 (reader, 작업 머신에서 계산)
- 이미 읽는 transcript 의 **완전한 레코드**만 쓴다. assistant 본문·tool 결과 본문은 새로 반출하지 않는다 — 반출하는 것은 상태 값·근거 시각·이유 코드뿐이다.
- **상태 형식 지원 판정 (`format_unverified` 와 별개)**: 기존 `format_unverified` 는 지금 모든 세션에 true 로 하드코딩돼 있고(지시 텍스트 해석의 미검증 표시) 그 의미를 바꾸지 않는다. 상태 계산은 별도 판정 `status_format_ok` 를 쓴다 — 아래 전이에 필요한 필드(Claude: 체인 레코드의 `uuid`·`parentUuid`·`type`·assistant `message.stop_reason`; Codex: `event_msg` 의 `task_started`/`task_complete`/`turn_aborted` 와 그 `turn_id`)가 지원 형식대로 있는지 레코드 단위로 검사한다. 판정 실패면 `unknown` + `reason:'status_format_unsupported'`.
- **현재 턴 식별 후 순서대로 전이**: 먼저 현재 분기(Claude: **체인 레코드**(`uuid` 를 가진 user/assistant/system 레코드) 중 파일상 마지막 것에서
  `parentUuid` 사슬을 거슬러 올라간 본선 — `ai-title`·`queue-operation`·`summary` 등 비체인 메타데이터는 말단 후보가 아니다. 사이드체인·하위 에이전트
  파일 제외. 사슬이 끊기거나 같은 위치의 말단이 여럿이라 모호하면 `unknown` + `reason:'branch_ambiguous'`)와 그 분기의 **마지막 사람 지시**(기존 판정 그대로
  — tool_result·로컬 명령 caveat·stdout 제외, 명령 래퍼 포함, 작업 중 지시 attachment 포함)를 찾는다. 그 지시 **이후** 레코드만 파일 순서대로 훑어 상태
  전이를 적용하고, **마지막 유효 전이**가 상태다. 앞선 종료가 있어도 뒤에 재개(새 tool_use·assistant 진행) 증거가 있으면 `working`. "존재 검사"로 구현하지
  않는다.
- **말단 후보 집합과 지시 집합을 구분**한다: 분기 말단·사슬 탐색은 체인 레코드로 하고, 마지막 사람 지시 판정은 reader 가 이미 인정하는 사람 지시 전부(user 레코드 + 작업 중 지시 `attachment{queued_command, origin.kind=human}`)로 한다. attachment 는 `parentUuid` 가 있으면 그것으로, 없으면 **파일상 바로 앞의 비사이드체인 체인 레코드**가 현재 본선에 속할 때만 그 뒤로 결속한다(다른 분기 레코드를 건너뛰어 과거 본선 레코드에 붙이지 않는다). 파일상 가장 최근 사람 지시 후보를 현재 분기에 결속할 수 없으면 이전 `ended` 를 재사용하지 않고 `unknown` + `reason:'instruction_unbound'`.
- Claude 전이: assistant `stop_reason:"end_turn"` → `ended`; `stop_reason:"tool_use"` 또는 tool_result 뒤 후속 진행 → `working`; 사용자 중단 레코드(형식은 실데이터에서 확인해 fixture 로 고정) → `interrupted`. 지시 이후 레코드가 하나도 없으면 `working`.
- Claude 로컬 명령: 마지막 사람 지시가 명령 래퍼이고 그 지시의 현재 분기 후손에 `<local-command-stdout>` 레코드가 있으면 `ended` +
  `reason:'local_command'`. user 문자열 내용 또는 system `subtype:'local_command'` 의 content 를 인정하고 그 레코드 시각을 근거로 쓴다.
  stdout 이 없으면 `working`; 스킬·커스텀 명령은 기존 assistant 전이를 따른다. caveat 는 지시가 아니며 stdout 본문은 반출하지 않는다.
- Codex 전이: 실측(2026-10-02 rollout)상 `event_msg/task_started{turn_id}` → 사람 지시 → `event_msg/task_complete{turn_id}` 순이다. 마지막 사람 지시를 **직전 `task_started` 의 turn_id** 에 결속하고, **같은 turn_id** 의 `task_complete` → `ended`, `turn_aborted` → `interrupted`, 같은 turn_id 의 종료가 없으면 `working`. 결속할 `task_started` 가 없거나 turn_id 가 다르면 종료 이벤트를 쓰지 않고 `unknown` + `reason:'turn_unbound'`. reader 가 지금 건너뛰는 이 이벤트들을 상태 계산용으로만 읽는다(본문·`last_agent_message` 미반출).
- 상태 형식 미지원(`status_format_ok=false`)·잘린 파일·파싱 실패·순서 불명(시각 역전 등) → `unknown` + 이유 코드. 기존 `format_unverified` 는 상태 계산의 게이트로 쓰지 않는다.

### 1.4 합성
세션 카드에 `status: { state, source: 'orca'|'transcript'|'none', evidence_at, reason }` 를 추가한다.
- `evidence_at`: transcript = 상태를 정한 레코드의 timestamp, Orca = **`state_started_at`(상태 전이 시각)** 만. Orca `updated_at` 으로 최신성을 추정하지 않는다.
- 둘 다 있으면 evidence_at 이 더 새로운 쪽. 동률이면 Orca(live 관측)를 쓴다. 다른 쪽과 값이 다르면 `reason` 에 `conflict`. 한쪽 시각이 없으면 있는 쪽.
- 스냅샷 수집 시각은 기존 `generated_at`(머신별).

### 1.5 스키마 버전
- 정책 버전을 올리고 새 슬롯을 닫힌 스키마에 추가한다. 이전 정책 버전 스냅샷은 **거부하지 않고 `status` 없이 읽어 `unknown`** 으로 보인다(읽기 호환). broker·화면은 `status` 부재를 `unknown` 으로 다룬다.
- broker 세션 요약에 `status` 를 추가한다(필드 allowlist 갱신). 세션 비서 프롬프트가 이 의미를 쓴다(§6).

## 2. 스냅샷 갱신 (PR-D)

v8 §3 의 요구를 그대로 구현하고 자동 주기를 더한다.
- 서버가 `scripts/session-snapshot.mjs` 를 자식 프로세스로 실행한다: Mac = `snapshot`, 원격 = `remote --host <고정 대상> snapshot`. **대상 목록은 부팅 시 env/설정으로 고정**(`PALANTIR_SNAPSHOT_TARGETS`, 예: `local:Mac,ssh:codev@codev2:codev2`), 대상 ↔ 예상 machine id 를 등록한다. 예상 machine id 가 중복되는 설정은 부팅 시 거부.
- **staging 후 게시**: 자식은 정본 디렉터리가 아니라 대상별 staging 디렉터리(`--out-dir <정본 옆 .staging/<대상>>`, 0700)에 쓴다. 서버가 결과 파일을 기존 observe 검증(닫힌 스키마·크기)으로 읽고, machine id 가 예상과 같고 그 실행이 취소되지 않았음을 확인한 뒤에만 정본 `<machine_id>.json` 으로 원자 rename 한다. mismatch·timeout·shutdown·검증 실패에서는 정본을 바꾸지 않는다.
- **수동**: `POST /api/session-hub/snapshots/refresh` (cookie-only + Origin 정확 일치). 세션 비서 hub 토큰으로는 호출 불가.
- **자동**: 5분 주기(`PALANTIR_SNAPSHOT_REFRESH_MS`, 기본 300000, 0=끔). 이미 실행 중이면 건너뜀(single-flight, 대상별). 
- 자식 프로세스 그룹은 timeout(대상당 120초)·서버 shutdown 에서 회수(v8 §1.3 회수 절차 재사용). stdout/stderr bounded. 결과는 닫힌 코드(`ok`/`timeout`/`failed:<STATUS_CODE>`/`machine_mismatch`).
- 상태 조회 `GET /api/session-hub/snapshots/status` (cookie): 대상별 마지막 성공 시각·마지막 시도 결과·진행 중 여부. 실패해도 **마지막 성공 파일은 유지**(정본은 staging 검증 뒤에만 교체).
- 테스트 차단: 자식에 `NODE_TEST_CONTEXT`·`PALANTIR_BLOCK_REAL_SPAWN` 강제 전파, ssh/orca 실행 파일 fixture 고정, fixture 누락 시 spawn 전 실패. spawnGuard 경유.

## 3. 영구 대화 (PR-P)

### 3.1 저장
- migration: `assistant_threads(id, title, created_at, archived_at)` — title 은 생성·수정 전 `redactSecrets` + 80자 상한, `assistant_messages(id, thread_id, seq, role∈{user,assistant,tool_note,system_note}, content, created_at, model_session_id, status∈{complete,partial,error})`. tool 호출은 한 줄 요약(`tool_note`)만, 원본 도구 응답 JSON 은 저장하지 않는다.
- 저장 시 `redactSecrets` 를 적용한다. 메시지당 상한 64KB, 스레드당 보관 상한(예: 5,000 메시지) 넘으면 오래된 것부터 정리(정리 사실을 system_note 로).
- **보내기 전 커밋**: 사용자 메시지와 진행 중 assistant 행(`partial`)을 **모델 stdin 에 쓰기 전에** 한 트랜잭션으로 커밋한다. 두 행은 공유 `turn_id` 로 연결하고, 클라이언트 요청 ID(`request_id`, 화면이 생성)는 **사용자 행에만** 저장한다. `UNIQUE(thread_id, seq)`, 사용자 행의 `UNIQUE(thread_id, request_id)`.
- **전송 요청은 스레드에 결속**: `POST /chat/message` body = `{ thread_id, request_id, text }`. 같은 (thread_id, request_id) 가 이미 있으면, 재전송 본문에 **저장 때와 같은 살균**을 적용한 결과가 저장 content 와 같을 때 기존 턴 상태를 돌려주고, 다르면 409(원문은 따로 보관하지 않는다). 새 요청은 지정 thread_id 가 **여전히 활성**인지 확인하고 턴 예약·커밋을 "새 대화" 전환과 **같은 직렬화 구간**(서비스 단일 mutex + DB 트랜잭션) 안에서 한다. 활성이 아니면 409 `thread_not_active` — 다른 스레드로 재귀속하지 않는다.
- assistant 부분 출력은 최대 2초 간격으로 갱신, 턴 종료 시 최종 커밋(`complete`/`error`). 서버가 턴 도중 죽으면 다음 부팅에 `partial` → `error`("서버 재시작으로 중단됨")로 닫고 **자동 재전송하지 않는다**.

### 3.2 모델 맥락 복원 (새 세션 + 주입)
- claude 프로세스를 띄울 때(첫 메시지, 재시작 후, 맥락 회전) 첫 user payload 앞에 **맥락 블록**을 붙인다: ① 승인된 기억(§4 — 순서: kind=preference 먼저, 그 안에서 `updated_at` 최신순, 동률 id; 예산은 ID·종류·구분자를 포함한 직렬화 UTF-8 4KB; 빠진 개수를 "기억 n개 더 있음" 으로 표시) ② 최근 대화 창(최근 메시지부터 거꾸로 24KB 까지, 오래된 것부터 잘림) ③ "이전 대화가 더 있음 — 필요하면 `search_assistant_history` 로 찾을 것". 맥락 블록은 시스템 프롬프트에 bake 하지 않는다.
- 맥락 블록 안 과거 대화·기억도 **자료**로 표시한다(지시 아님). 주입 직전 `redactSecrets` + `detectInjection` 재적용(걸린 기억은 빼고 표시).
- **맥락 회전**: `result` 이벤트의 누적 input token 이 임계값(기본 120k)을 넘거나 기억이 바뀌면, 다음 사용자 턴 전에 프로세스를 정상 종료하고 새로 띄운다(같은 스레드, 새 맥락 블록). 회전은 화면에 "맥락을 새로 정리함" system_note 로 남긴다.
- LLM 요약은 v1 에 넣지 않는다(파생 자료의 출처·손실 문제). 오래된 내용은 기록 조회 도구로 다시 찾는다.
- 새 MCP 도구 `search_assistant_history(q, limit)` — **활성 스레드**의 저장 메시지를 검색. 서버 경로 `GET /api/session-hub/history/search?q=&limit=` 을 hub 토큰 게이트 allowlist 에 정확 일치로 추가한다. 검색 대상 thread_id 는 인자로 받지 않고 **토큰의 프로세스 세대에 결속된 thread_id** 로 서버가 정한다. 응답 65,536 바이트 상한, 분당 30회(broker 와 공유하지 않는 별도 버킷), 결과는 seq·role·시각·일치 주변 512자.

### 3.3 transcript 정리
- DB 가 정본이다. 프로세스가 회전·종료되면 그 프로세스의 owned transcript 를 지운다(v8 의 소유권 확인 삭제 helper 재사용). 남으면 다음 정리 때 재시도하고 화면 상태에 남은 개수를 보인다.

### 3.4 화면 동작
- **활성 스레드는 하나**다. claude 프로세스 세대는 시작 시 활성 thread_id 에 **불변으로 결속**되고, 출력·도구 호출·기억 제안·DB 쓰기는 모두 그 결속을 쓴다(세대가 바뀐 뒤 늦은 출력은 버림).
- "새 대화": 진행 턴이 있으면 409. 없으면 현재 프로세스 그룹을 회수하고 새 스레드를 활성으로 만든다(기억 유지). **이전 스레드는 읽기 전용으로만 다시 볼 수 있다**(이전 스레드를 다시 활성화하지 않는다 — 맥락 섞임 방지).
- "대화 기록 삭제": 읽기 전용(비활성) 스레드만 대상. 그 스레드 메시지 + **그 스레드에 결속돼 기록된 owned session ID 의 transcript 만** 삭제(owned-sessions 기록에 thread_id 를 함께 저장; v8 의 cwd 전역 삭제 helper 를 그대로 쓰지 않는다). 활성 스레드를 지우려면 먼저 "새 대화". 기억·audit 는 지우지 않는다(출처 참조는 `deleted` 로 남김).
- 상태 API `GET /api/session-hub/chat/state` 와 SSE 는 현재 스레드의 **최근 창**만 보낸다: 최대 50개 **그리고** 직렬화 UTF-8 256KB 이하(넘으면 오래된 것부터 뺌). 한 메시지가 창 예산의 절반을 넘으면 창에는 앞 8KB + `truncated:true` 만 넣고 전체는 `GET /api/session-hub/chat/threads/:id/messages/:mid` 로 연다. DB 전체를 publish 하지 않는다. 모든 응답에 `thread_id` 와 `seq` 를 넣는다. 이전 메시지는 `GET /api/session-hub/chat/threads/:id/messages?before=<seq>` 로 페이지 조회.
- 서버 재시작 안내 문구("대화가 사라짐")는 제거한다.

## 4. 승인 기억 (PR-M)

### 4.1 저장
- 전용 테이블 둘. 기존 `memory_items`·masterMemory 의 owner 에 편입하지 않는다(다른 에이전트 주입 경로와 섞이지 않게).
  - `assistant_memories(id, content, kind∈{preference,fact,person,project,other}, status∈{active,archived}, revision, content_hash, created_at, updated_at, origin∈{proposal,human})` — 실제 기억.
  - `assistant_memory_proposals(id, operation∈{add,forget}, content, kind, reason, target_memory_id, target_revision, target_content_hash, status∈{pending,approved,rejected,stale}, revision, content_hash, source_thread_id, source_message_id, proposed_at, decided_at)` — 제안. 제안은 기존 active 행을 바꾸지 않는다.
  - `assistant_memory_audit` (append-only) + 단일 `assistant_memory_revision` 카운터(active 집합이 바뀔 때만 증가 — 맥락 회전 신호).
- **살균은 모든 쓰기에 동일**: 제안·사람 직접 추가·수정 모두 저장 전에 `redactSecrets` + `detectInjection`(걸리면 거부 400/도구 오류) + 500자 **초과 거부**(잘라서 성공 처리하지 않음). `reason`·audit 텍스트도 redact + 300자 상한. `content_hash` 는 최종 저장 내용으로 계산.
- 상한: pending 20개(넘으면 제안 거부 → 비서가 사용자에게 정리 요청), active 200개(넘으면 승인 409 → 보관 후 재시도).

### 4.2 제안 (비서)
- MCP 도구 `propose_memory(content, kind, reason)`, `propose_forget(memory_id, reason)`. 서버 경로는 hub 토큰 전용 `POST /api/session-hub/memory/proposals` 하나 — 만들 수 있는 것은 `pending` 제안 행뿐. hub 토큰 게이트 allowlist 에 **메서드·경로 정확 일치**로 추가한다(이력 GET §3.2 와 이 POST 둘만 새로 열림; 공용 chat·memory API 는 계속 403). body 는 JSON 4KB 상한, 분당 5회.
- `propose_forget` 은 서버가 그 시점 대상의 `revision`·`content_hash` 를 제안 행에 복사한다(대상이 active 가 아니면 거부).
- **출처는 서버가 정한다**: `source_thread_id` = 토큰 세대의 결속 스레드, `source_message_id` = 그 스레드에서 **현재 진행 중 턴의 사용자 메시지**. 모델이 출처를 지정하지 않는다.
- 새 도구 3개(`search_assistant_history`, `propose_memory`, `propose_forget`)를 고정 argv `--allowedTools`·MCP 스키마·dispatch 에 추가한다.
- pending 은 모델 맥락에 들어가지 않는다.

### 4.3 승인 (사람)
- 채팅에 제안 카드 + [기억] [거절]. 카드는 **실제 저장될 전체 살균 내용**, 종류, 이유, 출처 사용자 발언(그 메시지 본문), forget 이면 대상 기억 전체 내용을 보여 준다.
- `POST /api/session-hub/memory/proposals/:id/decision` (cookie + Origin 정확 일치), body `{ decision, revision, content_hash }`. **단일 DB 트랜잭션**: 제안이 `pending` 이고 revision·hash 가 일치하고, forget 이면 대상이 여전히 active 이며 `target_revision`·`target_content_hash` 가 현재 대상과 일치할 때만 적용 — 제안 상태 변경 + 기억 생성/보관 + audit + `assistant_memory_revision` 증가를 같이 커밋. 하나라도 불일치하면 409(대상이 바뀐 forget 제안은 `stale`). 이미 결정된 제안에 같은 결정 재전송은 200 멱등, 다른 결정은 409.
- 사람은 기억을 직접 추가·수정·보관할 수 있다(같은 cookie 경로). 수정은 revision 을 올린다.
- 기억 관리 화면: `#memory` 에 "비서 기억" 범위를 추가한다(목록·수정·보관·pending 승인).
- 기억이 바뀌면(승인·수정·보관) 다음 턴 전에 맥락 회전(§3.2).

## 5. 화면 (PR-C 고쳐 쓰기)

### 5.1 배치 (sessionHubActive 일 때 `#manager`)
```
┌ 사이드바 ────────┬ 가운데 ─────────────┬ 오른쪽 (열렸을 때) ┐
│ 검색 · [묶음▾]   │ 선택된 대화          │ 세션 상세  ✕        │
│ 스냅샷 3분 전 ⟳  │ (기본: 비서)         │ 제목 · 머신·repo    │
│ ★ 비서           │                      │ 상태 · 근거 시각    │
│ ▸ Palantir       │                      │ 지시 타임라인       │
│   Top / Operator │                      │ [비서에게 묻기]     │
│   작업           │                      │                     │
│ ● 입력 대기 (n)  │                      │                     │
│ ● 작업 중 (n)    │                      │                     │
│ ○ 응답 끝남 (n)  │                      │                     │
│ ◌ 알 수 없음 (n) │                      │                     │
└──────────────────┴──────────────────────┴─────────────────────┘
```
- **사이드바**: 위에 검색·묶음 선택(상태별 기본 / 머신·repo)·필터(머신·도구, 기존 `Dropdown`)·스냅샷 시각과 새로 만들기 버튼(진행 중이면 표시). 고정 항목 "★ 비서", 접을 수 있는 "Palantir" 묶음(Top, 각 Operator, "작업"=기존 SessionGrid), 그 아래 세션 묶음. 묶음 상태는 localStorage 로 기억.
- **세션 행**: 상태 점 + 제목 1줄 + `머신 · repo · 상대 시각`. 누르면 오른쪽 상세가 열린다(가운데 채팅은 그대로).
- **가운데는 항상 비서 채팅**(`SessionHubChat`)이다(사용자 결정). Palantir 묶음의 Top·Operator 를 누르면 **오른쪽 칸**에 기존 `ManagerChat` 이, "작업" 을 누르면 오른쪽 칸에 기존 `SessionGrid` 가 열린다(오른쪽 칸 = 선택한 항목의 상세 자리). 오른쪽 칸을 닫아도 비서 컴포넌트·진행 턴·SSE 는 유지된다. "★ 비서" 고정 항목은 오른쪽 칸을 닫고 채팅 입력에 포커스.
- **오른쪽 상세**: 세션 헤더(상태·출처·근거 시각·Orca 연결), 지시 타임라인(기존 `SessionSnapshotParts`), 제외 지정자 복사, [비서에게 묻기](채팅 입력에 "이 세션 [[칩]] 지금 상태와 원래 목적 알려줘" 를 채움, 전송은 사람이). 근거 칩 클릭도 여기를 연다.
- 폭: ≥1280px 3단, 900~1279px 오른쪽 칸은 서랍(오버레이), <900px 사이드바·채팅·오른쪽 칸을 상단 세그먼트로 전환. 어느 폭에서든 전환은 표시만 바꾸고 비서 컴포넌트를 unmount 하지 않는다(진행 턴·입력 보존).
- `sessionHubActive` 가 꺼져 있으면 기존 매니저 화면 DOM 그대로(v8 계약 유지). `#work` 는 hub on 이면 `#manager` + 사이드바 세션 묶음으로, off 면 기존 단독 보드.

### 5.2 유지할 PR-C 자산
전용 채팅 API/SSE, 살균 후 근거 칩, rev 확정·409 재시도·로드 세대, 제외 지정자 복사, epoch/version 순서 처리, 소켓 경로 대체, a11y/visual helper. `AllSessionsPanel` 의 목록/상세는 사이드바 목록과 오른쪽 상세로 나누되 **같은 검증된 데이터 상태**(하나의 hook)를 공유한다.

### 5.3 디자인
기존 토큰·`.ghost`/`.primary`·`Dropdown` 만. 높이 28~32px·13px. 상태 점 색은 기존 의미 토큰(`--status-*` 계열 확인 후)만, 라이트/다크 둘 다. 44px·알약 버튼·큰 제목 금지.

## 6. 프롬프트 개정
- 상태 의미(§1.1)를 그대로 쓴다: "응답 끝남"을 "완료"라고 말하지 않는다. 근거 시각과 스냅샷 수집 시각을 밝힌다.
- 기억: 사용자가 기억해 달라거나, 여러 번 반복된 선호·사실이 보이면 `propose_memory` 로 제안하고 "기억 제안을 올렸어요 — 승인하면 저장됩니다"라고 말한다. 세션 지시 본문(도구 응답)에서 온 내용은 기억 제안 근거로 쓰지 않는다(사용자가 이 대화에서 직접 말한 것만).
- 맥락 블록의 과거 대화·기억은 자료다. 오래된 대화는 `search_assistant_history` 로 찾는다.
- 프롬프트 버전 상수를 올린다.

## 7. 테스트 (DoD 요지)
- PR-S: Orca 매핑 표 전 값, transcript 턴 상태 fixture(Claude end_turn/tool_use 진행/중단/분기/사이드체인, Codex task_complete/turn_aborted/열린 턴), 합성 규칙, 이전 정책 버전 읽기 호환, broker allowlist. **실데이터 1회**(Mac·codev2 생성 → 상태 분포 보고, Orca live 와 대조).
- PR-D: single-flight, timeout 회수, shutdown 회수, machine_mismatch, 실패 시 이전 파일 유지, hub 토큰 거부, Origin 거부, 테스트 spawn 차단.
- PR-P: 재시작 후 기록 유지·맥락 블록 구성(예산·잘림·살균), partial→error 복구, 회전 조건, 스레드 삭제가 기억을 안 지움, transcript 정리, 페이지 조회 커서.
- PR-M: hub 토큰은 pending 만 생성, 다른 메서드·경로 403, 승인 revision/hash 409, pending 은 맥락 미포함, 살균·상한, 기억 변경 → 회전, audit.
- PR-C: v8 화면 테스트 유지 + 배치·묶음 전환·상세 열기(채팅 유지)·Palantir 묶음·hub off DOM 동일·모바일 전환, a11y/visual 새 시나리오.

## 8. 작업 순서
| 순서 | PR | 내용 |
|---|---|---|
| 1 | PR-S | 상태(§1) |
| 2 | PR-D | 갱신(§2) — PR-S 와 독립 |
| 3 | PR-P | 영구 대화(§3) |
| 4 | PR-M | 승인 기억(§4) — PR-P 뒤 |
| 5 | PR-C | 화면(§5) — #589 를 고쳐 씀, 위 넷 연결 |
| 6 | 측정 | v8 §7 U1~U3 + 재시작 후 이어가기·기억 반영 확인. 이후 C2 |

각 PR: codex-goal 위임, 호스트 RED→GREEN·역회귀, codex 적대리뷰 GO, 실데이터 1회. PR-C 만 사용자 화면 확인 후 merge.

## 9. 검토 이력
- v5 R6 (2026-10-11): **GO** (새 BLOCKER·SERIOUS·MINOR 0).
- v5 (2026-10-11): codex R5 NO-GO(SERIOUS 1 = 부모 없는 attachment 가 다른 분기를 건너뛰어 본선에 붙음). 반영: 바로 앞 체인 레코드가 본선일 때만 결속, 아니면 instruction_unbound=unknown.
- v4 (2026-10-11): codex R4 NO-GO(SERIOUS 1 = 체인 한정이 작업 중 지시 attachment 배제; MINOR 2 = 옛 format_unverified 게이트 문장, 재전송 본문 비교 기준). 반영: 말단 집합/지시 집합 분리 + attachment 위치 결속 + 미결속=unknown, 게이트 문장 교체, 같은 살균 결과로 비교.
- v3 (2026-10-11): codex R3 NO-GO(BLOCKER 0; SERIOUS 4 = turn_unbound 를 ended 로 확정, 비체인 메타데이터가 분기 말단, `format_unverified` 하드코딩 true 로 상태 전부 차단, 전송 요청 스레드 미결속; MINOR 2 = request_id 위치, 스레드 제목 살균). 반영: 결속 실패=unknown(Codex task_started/task_complete turn_id 실측), 체인 레코드만 말단·모호=unknown, 별도 `status_format_ok` 판정, message body 에 thread_id + 전환과 직렬화, request_id 사용자 행만, 제목 redact·80자.
- v2 (2026-10-11): codex R2 NO-GO(BLOCKER 1 = forget 승인 대상 미결속; SERIOUS 8 = 보내기 전 커밋·중복 요청, 스레드↔프로세스 결속·스레드 삭제 범위, staging 후 게시, 턴 식별 후 순서 전이·Orca 전이 시각, 새 도구 게이트 계약, 모든 쓰기 살균·서버 결정 출처, state/SSE 바이트 창, 가운데 비서 고정; MINOR 1 = 기억 주입 순서·초과 거부). 전부 반영: 제안 테이블 분리·단일 tx 결정, request_id 멱등, 활성 스레드 1개·이전 스레드 읽기 전용, staging rename, 마지막 유효 전이, 정확 일치 allowlist 2개, Top·Operator·작업은 오른쪽 칸.
- v1 (2026-10-11): codex R1(초안 GO) 합의안 + 사용자 화면·기억 결정 반영.
