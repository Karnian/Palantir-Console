# I0a — 여러 머신 세션 스냅샷 보드 (구현 brief)

> **상태**: v11 — 사용자 spec 승인 (2026-10-08). 원격 실행은 ssh stdin 번들(§2.3, §4). **PR1a 구현 중 범위 축소 반영**(§11 v11): Orca 터미널 제목 비반출, cwd 접두사 제외 제거, 다중 파일·혼합 세션·시각 부적합 세션 보류. codex 설계검토 GO (R1~R10), PR1a 코드 적대리뷰 R10 GO. **PR1b**(번들·실행기·원격·exclude CLI): 위협 모델 명시(§2.3), launcher 가 만드는 오류 envelope 의 `machine_id` 는 `unknown`, exclude 도 `--now` 허용(§11 PR1b).
> **상위 문서**: [`instruction-centric-direction-brief.md`](./instruction-centric-direction-brief.md) (LOCKED). 이 문서는 그중 §3.1 데이터 원칙, §5 사용성, §6 성공 기준, §7 I0/I0a 를 구현 수준으로 구체화한다.
> 상위 문서가 "구현 brief 에서 정한다"고 넘긴 네 가지를 여기서 확정한다: 반출 도구, 허용 필드, 측정 절차, U0 수치.

---

## 0. 목표와 범위

**목표**: Mac 과 codev2 의 Claude Code·Codex 세션을 살균한 스냅샷으로 만들어 Palantir 보드에 보여 준다. 사용자는 이 보드로 U0~U3 를 직접 측정한다.

| 범위 안 | 범위 밖 (I0b 이후) |
|---|---|
| **읽기 모듈**(snapshot CLI). 로컬은 직접 실행, 원격은 **ssh stdin 으로 단일 파일 번들을 보내 실행**한다(원격 설치·repo checkout 0, §2.3) | 상주 수집기, 증분 읽기, 훅 |
| 사람 지시 판별 parser (Claude, Codex) | 의미 병합, LLM 목적 요약 |
| 반출 정책: 재귀 allowlist, 문자열 슬롯별 살균, 머신 측 제외·삭제 | ingestion capability, 운영 DB 쓰기 |
| 읽기 전용 endpoint (기본 off) + 보드 화면 | 관리 에이전트, attention |
| 머신 측에서 계산한 세션↔Orca 연결 관측 | Orca 제어 |

---

## 1. 사람 지시 판별 (실측 기반 결정표)

실측은 구조, 필드명, 값 분포만 대상으로 했다. 본문은 열지 않았다(2026-10-08). 판별 규칙은 **지원 형식**에만 적용한다. 지원 형식이 아닌 레코드는 버리지 않고 coverage 에 `unverified_format` 으로 집계한다.

### 1.1 Claude Code — 레코드 단위, **위에서부터 처음 일치하는 행 적용**(제외 우선)

본문 경로는 `message.content` 이고, 문자열 또는 블록 배열이다.

| # | 조건 | 결과 |
|---|---|---|
| 1 | `type ≠ user` (`ai-title`·`queue-operation` 은 별도 처리) | 무시 |
| 2 | `content` 블록이 전부 `tool_result` | 제외 |
| 3 | `isMeta` / `isCompactSummary` / `isSidechain` | 제외 |
| 4 | 문자열이 `<task-notification>` `<local-command-stdout>` `<local-command-caveat>` `<bash-stdout>` `<bash-stderr>` 래퍼로 시작 | 제외 — **출력**이다. `turnOrigin=human` 이 붙어 있어도 제외한다 |
| 5 | `turnOrigin ∈ {task_notification, scheduled}` 또는 `promptSource=system` | 제외 |
| 6 | `origin.kind` 가 **있고** `human` 이 아니다 | 래퍼가 slash/shell 이면 `unknown`(출처 충돌), 그 밖은 제외 |
| 7 | 문자열이 `<command-name>`/`<command-message>` 래퍼 | `slash`. 명령명과 args 를 추출한다. **origin 이 없을 때만** 인정한다(실측: 래퍼 3건 중 2건이 origin 없음) |
| 8 | 문자열이 `<bash-input>` 래퍼 | `shell` (사용자가 `!` 로 친 셸 입력) |
| 9 | `origin.kind=human` 또는 `turnOrigin=human` 또는 `promptSource ∈ {typed, queued, suggestion_accepted}` | `human`. `<pasted>` 래퍼는 벗기고, `image` 블록은 `attachments` 로 센다. 텍스트 없이 이미지만 있으면 `text_missing=true` 인 지시 1건으로 남긴다 |
| 10 | 그 밖 | `unknown` (coverage) |

- **큐**: `queue-operation` 은 지시로 내보내지 않고 coverage 에 `queued_enqueued / dequeued / removed` 개수만 기록한다. 실제로 전달된 입력은 행 9 의 `promptSource=queued` 로 잡힌다. 큐에서 제거된 입력은 "취소된 입력" 개수로만 남는다.
- **`ai-title`**: 세션의 `ai_title` 로 쓴다. §2.1 의 TEXT 정책을 적용하고 파일 안 마지막 값을 쓴다. 실제 레코드에는 `timestamp` 가 없다(`type, aiTitle, sessionId` 만) — 시각을 요구하지 않는다.
- **명령 래퍼 표시**: 지시 텍스트가 `<command-name>`·`<command-message>`·`<command-args>` 래퍼로만 이뤄져 있으면 표시 텍스트를 `/name args` 로 정리한다(분류·지문·ref·삭제 신원은 원문 기준 그대로).
- **순서와 신원**: 순서는 `timestamp` → 파일 내 위치로 정한다. 세션 신원은 `sessionId`, **레코드 신원은 `uuid`** 다(§2 삭제 신원).

### 1.2 Codex — 세션 포함 여부와 실행 방식을 따로 판정한 뒤, 메시지·블록 단위로 판별

**(A) 실행 방식 `run_mode`**: `session_meta.source` 와 `thread_source` 로 정한다. originator 로는 정하지 않는다.

| source | thread_source | run_mode |
|---|---|---|
| `cli`, `vscode` | `user` | `interactive` |
| `exec` | `user` | `exec` |
| 객체 `{subagent…}` | `subagent`, `guardian_review` 등 | `subagent` |
| 그 밖 (`voice_chat` 등) | — | `unsupported` |

**(B) 포함 여부** (기본값):

- `interactive` → 포함한다.
- `exec` → **제외**하고 개수만 센다. 실측 기준 `codex_exec` 3,005건, `Codex Desktop`+exec 746건이며, Palantir 워커와 자동화가 포함된다. 옵션으로 포함할 수 있다(§9-Q4).
- `subagent`, `unsupported` → 제외하고 개수와 조합 코드만 센다.
- 포함 여부를 바꿔도 `run_mode` 는 원래 값을 기록한다(상위 §3.1-3).

**(C) 사람 지시 — 메시지 단위 결과, 블록 단위 분류**

근거: `response_item` / `type=message` / `role=user`. 블록마다 아래처럼 분류한다.

| 블록 | 분류 |
|---|---|
| `input_text` 가 `<environment_context>` · `<codex_internal_context>` · `# AGENTS.md instructions` 로 시작 | 주입 → 버림 |
| `input_text` 가 `<send_user_message_question_reply>` | reply |
| `input_text` 가 그 밖의 `<태그>` 로 시작 | unknown |
| 그 밖의 `input_text` | human |
| `input_image` | 첨부 |

메시지 하나는 지시 **최대 1건**이 된다.

- 텍스트는 human 블록과 reply 블록만 **원래 순서대로** 쓴다. 블록 사이는 빈 줄(`\n\n`)로 구분한다. 구분자 없이 붙여 새로운 검색어가 생기는 일을 막기 위해서다.
- `kind`: reply 블록이 하나라도 있으면 `reply`, 없으면 `human`.
- unknown 블록은 **텍스트에 넣지 않는다.** 지시에 `unknown_blocks` 개수를 기록하고, 세션 coverage 에도 더한다. unknown 을 human 으로 승격하지 않는다.
- human·reply 블록 없이 첨부만 있으면 `text_missing=true` 인 `human` 지시 1건으로 남긴다.
- human·reply·첨부가 모두 없으면(주입만, 또는 unknown 만) 지시가 아니다. unknown 이었다면 coverage 에만 남는다.
- `event_msg.user_message` 형식은 실측에서 발견되지 않았다. 이 형식이 있는 파일은 `unverified_format` 으로 표시하고, 합성 fixture 로 규칙을 고정하기 전까지는 지시로 반출하지 않는다.
- **레코드 신원**:
  - **원본 user 메시지에 `payload.id` 가 있으면 그것을 신원으로 쓴다.** 실측: 9,438건 중 6,519건이 id 를 가졌고, 형식은 40자 `xxx_…`, 세션 내 중복 0건이다.
  - id 가 없는 형식은 **세션 내 원본 user 메시지 순번** `n<순번>` 으로 표시한다. 다만 이 순번은 **표시와 삭제 지정에만** 쓴다. 위치로는 신원을 증명할 수 없기 때문이다(R4·R5 반례: 같은 내용이 여러 번 나오면 재작성 후에도 접두부가 같아질 수 있다).
    - **삭제는 내용 기준으로 한다.** 사용자가 id 없는 지시를 삭제하면 그 지시의 지문을 로컬에 저장한다. 지문은 `HMAC(local_key, 블록 구조 + 삭제용 정규화 텍스트 + 첨부 개수)` 다. 이후 실행에서는 그 세션에서 **이 지문과 같은 원본 메시지를 위치와 상관없이 모두 제외**한다.
    - **삭제용 정규화는 NFC 와 앞뒤 공백 제거까지만** 한다. 내부 공백은 축약하지 않는다. 그렇게 해야 `a  b` 와 `a b` 처럼 의미가 다른 텍스트가 같은 지문이 되지 않는다(검색용 정규화와는 별도 함수다). 첨부는 **내용이 아니라 개수만** 비교한다. 따라서 이미지만 다르고 구조가 같은 첨부 전용 메시지들은 함께 제외된다. 이 동치 범위는 등록 시 사용자에게 보여 주고 fixture 로 고정한다.
    - **`local_key` 는 회전하지 않는다.** 키 파일에는 키 지문(키 자체의 해시)을 함께 기록한다. 기존 삭제 규칙이 기록할 때와 다른 키 지문으로 저장돼 있으면(키가 교체된 경우), 해당 세션을 **전체 보류**하고 `withheld_sessions` 로 집계한다. 다른 키로 계산한 지문은 절대 비교하지 않는다.
    - 그래서 파일이 어떻게 재작성되더라도 삭제한 내용은 돌아오지 않는다. 대가로 같은 내용으로 반복 제출한 메시지도 함께 제외된다(보수적 과삭제). 화면에는 "삭제 규칙으로 n건 제외"라고 표시한다.
    - `local_key` 가 없거나 읽을 수 없으면 지문을 계산할 수 없다. 이때는 id 없는 지시 삭제가 하나라도 등록된 세션을 **전체 보류**하고 `withheld_sessions` 로 집계한다.
    - id 가 있는 형식(`payload.id`)과 Claude(`uuid`)는 지금처럼 신원 기준으로 삭제한다.
  - 내용 해시로 dedup 하지 않는다. 같은 문장을 두 번 제출한 것은 순번이 다르므로 두 건으로 남는다.

### 1.3 compact 와 복제 이력

- **Codex**: `compacted.replacement_history` 안의 항목은 원본의 **복제**다(실측: user 항목 2,090개 중 1,457개가 원본 payload 와 동일). 그래서 지시로 세지 않는다. 원본 `response_item` 만 센다.
  - compact 이전 원본이 파일에 없어 이력이 replacement 에만 남은 경우, I0a 는 **복구하지 않는다**. 세션 coverage 에 `compact_only_history` 로 표시한다.
- **Claude**: `isCompactSummary` 레코드는 결정표 행 3 에 따라 제외한다.
- **dedup**: 같은 원본 위치(파일 + 레코드 위치)인 경우만 하나로 합친다. **같은 문장을 두 번 제출한 것은 두 건으로 유지한다.**

### 1.4 관측 창과 세션 최초 지시

- **세션 선택**: `last_record_at` 이 최근 14일 안에 있는 세션만 고른다.
- **선택한 세션은 파일 전체를 읽는다.** 파일은 한 번에 하나씩 파싱하고, 지시 추출이 끝나면 원본 레코드를 버린다(실데이터 7GB 에서 전량 보유 시 OOM — PR1c).
- **창 밖 파일**(수정 시각이 `now - 14일` 이전)은 어떤 레코드도 창 안일 수 없으므로 세션 신원만 확인한다. 앞부분(최대 64KB)의 레코드에서 신원을 얻고, 못 얻으면 그 파일 하나만 상한 안에서 전체를 읽는다. 다중 파일 판정에는 참여하지만 내용은 파싱하지 않는다. 따라서 **coverage 의 레코드 카운트(unknown·unverified 등)는 관측 창 기준**이다.
- **Claude 하위 에이전트 파일**(`<sessionId>/subagents/agent-*.jsonl`, 레코드가 모두 `isSidechain`)은 본 세션과 같은 `sessionId` 를 쓰지만 사람 지시가 없다. 세션 그룹에서 빼고 `files_skipped` 로 센다(그러지 않으면 본 세션이 다중 파일로 통째 보류된다 — 실측 codev2 20/46).
- **최초 지시 복구 상태**는 세 값으로 표시한다. 첫 레코드의 타입만으로 판정하지 않는다. 실측에서 Claude 파일이 `last-prompt`·`queue-operation` 으로 시작하는 경우는 정상이었다.
  - **Claude**
    - 첫 human 지시의 `parentUuid` 가 null 이거나 파일 안에서 해소되고, 그보다 앞에 `isCompactSummary` 가 없으면 `recoverable`.
    - 첫 human 지시보다 앞에 compact summary 가 있거나, `parentUuid` 체인이 파일 밖을 가리키면 `unrecoverable`.
    - 그 밖은 `unknown`.
  - **Codex**
    - `session_meta` 뒤에 첫 원본 user 메시지가 있고, 그보다 앞에 `compacted` 가 없으면 `recoverable`.
    - 첫 원본 user 메시지보다 `compacted` 가 먼저 나오면 `unrecoverable`.
    - 그 밖은 `unknown`.
- **화면 표시**: `recoverable` 이면 최초 지시를 보여 준다. `unrecoverable` 이면 "최초 지시 복구 불가", `unknown` 이면 "최초 지시 확인 불가"라고 쓴다. 뒤의 두 경우는 U2 실패 원인으로 따로 집계한다.
- **세션별 coverage**: `first_record_at`, `last_record_at`, unknown·unverified 개수, `compact_only_history`.

### 1.5 버전

- 파일마다 CLI 버전(`version` / `cli_version`)을 기록한다.
- 결정표는 실측 버전 범위를 **지원 형식**으로 명시한다. 범위 밖 버전도 판별은 시도하되 세션에 `format_unverified` 를 표시한다.
- `unknown` 비율이 5% 를 넘는 세션은 경고로 표시한다.

---

## 2. 읽기 모듈 (snapshot CLI)

- **위치**:
  - CLI 진입점 `scripts/session-snapshot.mjs` — Mac 에서만 돈다. 번들 생성, 실행기 spawn, 응답 검증, 파일 기록, exclude 확인 입력을 맡는다(§2.3).
  - 읽기 본체 `scripts/lib/sessionSnapshotReader.cjs` — parser, 연결, 제외 적용, 스냅샷 조립, `observe.json` 관리. **번들에 들어가는 쪽**이다.
  - 반출 정책은 공유 모듈 `server/services/observeSnapshotPolicy.js` 에 둔다. 서버도 같은 모듈로 재검증한다.
  - 살균은 `memorySanitize.redactSecrets` 를 require 해서 쓴다. 로직을 복제하지 않는다.
  - npm 의존성이 없고 Node 18 이상에서 돈다. 시작할 때 Node major 를 검사하고, 미달이면 고정 코드 `node_unsupported` 로 끝낸다. 이 코드는 Node 14.18 이상에서 보장한다. 그보다 오래된 Node(`node:` 접두사 require 미지원)에서는 일반 실패로 끝나고, Mac 은 아무것도 기록하지 않는다.
  - **원격 머신에는 Node 만 있으면 된다.** repo checkout 도, 파일 설치도 필요 없다(§2.3). 원격에 남는 것은 `observe.json` 하나뿐이다.
- **읽는 경로**: Claude·Codex transcript 디렉터리 두 종류만 허용한다(기본 `~/.claude/projects`, `~/.codex/sessions`). 다른 종류의 경로는 거부한다. 심볼릭 링크는 따라가지 않는다. 파일 수와 파일당 바이트에 상한을 둔다.
- **머신 측 설정** `~/.config/palantir/observe.json` (0600):
  - `machine_id`: 최초 실행 때 생성하는 랜덤 값. hostname 과 무관하다.
  - `machine_label`: `[A-Za-z0-9._-]{1,32}`. 기본값 `machine`, `snapshot --label <name>` 으로 지정한다(잠금 안에서 라벨만 갱신).
  - `path_salt` 와 `path_gen`: 경로 OPAQUE 용이다. 회전하면 `path_gen` 이 증가한다.
  - `exclude`: 세션 신원(`provider:session_id`), **지시 신원** 목록. (cwd 접두사 제외는 v11 에서 제거 — cwd 는 세션이 아니라 레코드마다 바뀌어 세션 단위 판정이 반복 우회됐다. I0b 이후 레코드 단위 모델로 재설계한다. 비어 있지 않은 옛 `cwd_prefixes` 가 있으면 `request_invalid` 로 반출을 멈춘다.)
  - **삭제 신원은 경로나 salt 에 의존하지 않는다.** Claude 는 `claude:<sessionId>:u<uuid>`, Codex 는 id 가 있으면 `codex:<session_id>:i<payload.id>`, 없으면 `codex:<session_id>:n<순번>`(+ 로컬 지문, §1.2) 이다. 파일 rename, 파일 이동, salt 회전이 있어도 삭제가 유지된다. 재실행해도 그대로 적용된다.
  - `local_key`: 지문 전용 랜덤 키. `path_salt` 를 회전해도 바뀌지 않는다.
- **Orca**: 같은 실행 안에서 `orca worktree ps --json` / `orca terminal list --json` 을 호출한다. 실제 응답은 `{ok, result: {worktrees|terminals: [...], truncated}}` envelope 이고 시각은 epoch 밀리초 숫자, 터미널↔agent 연결 키는 `${tabId}:${leafId}` = agent `paneKey` 다(PR1c 실측). 비대화형 ssh 의 PATH 에 orca 가 없으면 `--orca-bin <절대경로>` 를 준다. 그 머신의 Orca runtime 을 쓴다. 실패하면 고정 코드(`orca_unavailable` 등)를 coverage 에 기록하고 계속 진행한다.
- **출력**:
  - 번들은 결과를 stdout envelope 으로만 낸다(§2.3). **실행 머신의 디스크에는 스냅샷·중간본을 쓰지 않는다.** 실행 머신에서 쓰는 것은 `observe.json`(+ 잠금·tmp)뿐이다.
  - Mac 이 검증을 통과한 스냅샷만 보드 디렉터리(`--out-dir`, 기본 `PALANTIR_OBSERVE_SNAPSHOT_DIR`)에 `<machine_id>.json` **하나**로 원자적으로 덮어쓴다(같은 디렉터리의 tmp + rename). 파일 권한은 0600, 디렉터리 권한은 0700 이다. 머신당 파일이 하나이므로 예전 스냅샷이 쌓이지 않는다.
- **`observe.json` 갱신 규칙**:
  - 모든 쓰기는 **잠금**(`observe.json.lock`, `O_EXCL`) 안에서 한다. 순서: 최신 파일을 다시 읽음 → 키 지문 검증 → **변경을 합집합으로만 반영**(제외·삭제 규칙은 단조 증가, 기존 항목은 지우지 않음) → tmp + rename.
  - 잠금이 이미 있으면 기다리지 않고 `config_busy` 로 끝낸다. 오래된 잠금 처리는 runbook 에 적는다.
  - 최초 실행의 설정 생성도 같은 규칙을 따른다.
  - `local_key` 가 없거나 키 지문이 맞지 않으면 **새 키를 만들지 않는다.** `key_unavailable` 로 끝낸다. 예외는 최초 실행(파일이 아예 없음) 하나다.

### 2.1 반출 정책 — 재귀 allowlist, 문자열 슬롯별 처리

**스냅샷의 모든 키는 §3 스키마에 명시된 것만 허용한다.** 모르는 키는 생성 단계에서 버리고, 서버 검증 단계에서는 거부한다. 문자열 슬롯은 아래 표 중 하나의 정책을 반드시 가진다.

| 정책 | 대상 | 처리 |
|---|---|---|
| `TEXT` | 지시 본문, `ai_title` | `finalizeText(slot)` — 아래 고정점 규칙. 상한은 지시 2000자, 제목 200자. 결과로 `redacted` boolean 을 남긴다 |
| `LABEL` | `repo_label`(git toplevel basename), `git_branch` | `finalizeLabel` — 문자 집합 `[\p{L}\p{N}._/-]` 치환, 64자. 같은 고정점 규칙을 따른다 |
| `OPAQUE` | 경로(cwd, worktree path) | 머신 안에서 `g<path_gen>-` + `HMAC-SHA256(path_salt, 원값)` 앞 16 hex 로 만든다. 원값은 반출하지 않는다. **세대(`path_gen`)가 다른 id 끼리는 같은 경로로 보지 않는다** |
| `ENUM` | `provider`, `kind`, `run_mode`, Orca `state`·`status`·`agentType`, coverage 코드 | 고정 집합만 허용한다 |
| `ID` | `session_id`, Orca `paneKey`·`handle`·`worktreeId` 의 id 부분 | `[A-Za-z0-9:_-]{1,128}` 만 허용한다. **지시 신원은 별도 문법** `INSTR_ID` = `^(claude|codex):[A-Za-z0-9_-]{1,64}:[uin][A-Za-z0-9_-]{1,64}$` 를 따르며, 생성기·로컬 삭제 설정·서버 검증이 같은 정규식을 공유한다. Orca `worktreeId` 에는 경로가 섞여 있으므로 `::` 뒤 경로를 `OPAQUE` 로 바꾼다 |
| `TIME` / `INT` / `BOOL` | 시각, 개수, 플래그 | 타입과 범위를 검사한다 |

- **고정점 규칙 (생성과 서버가 같은 함수 사용)**: `finalize(slot, x)` 는 다음과 같이 동작한다.
  1. `redactSecrets` → 슬롯 변환(문자 치환·잘림) → `redactSecrets` 를 반복한다.
  2. 결과가 바뀌지 않으면(최대 3회) 그 값을 쓴다.
  3. 3회 안에 수렴하지 않으면 슬롯별 **고정 대체값**으로 바꾼다. TEXT 는 `[redacted]`, LABEL 은 `redacted` 다(LABEL 문자 집합에 대괄호가 없으므로). 대체값은 `finalize(slot, 대체값) === 대체값` 을 만족해야 하며, 이를 테스트로 고정한다.
  - 잘림은 반드시 마지막 살균 **이전**에 한다. 그래야 잘린 경계에서 새로 생긴 패턴도 마지막에 걸러진다.
  - **멱등성 계약**: 모든 x 에 대해 `finalize(slot, finalize(slot, x)) === finalize(slot, x)`. 수렴한 경우에는 정의상 성립하고, 미수렴한 경우에는 대체값의 고정점으로 성립한다. 서버는 이 등식을 검사한다(§5). 테스트는 무작위 입력 property 테스트로 이 등식을 확인한다.
- **Orca 에서 버리는 필드**: `prompt`, `lastAssistantMessage`, `toolInput`, `toolName`, `preview`, `comment`, 그리고 `displayName` 같은 모든 비명시 필드.
- **Orca 텍스트를 쓰는 곳**: 연결 계산(§2.2)에서 머신 안에서만 쓴다.
- **Orca 터미널 제목은 내보내지 않는다** (v11). 제목은 transcript 의 `ai_title` 과 겹치고, 제외·보류 세션과의 연결을 증명해 차단하는 로직이 라운드마다 새 우회를 냈다.
- **보류 규칙** (v11): 같은 `provider:session_id` 가 여러 파일에 있으면(`multi_file_withheld`), 한 파일에 서로 다른 sessionId 가 섞이면(`mixed_session_withheld`), 레코드에 시각이 있는데 TIME 문법·범위를 벗어나면(`invalid_time_withheld`) 그 세션(파일)을 통째로 보류한다. 같은 파일 안 같은 신원이 두 위치에 나오면 그 세션만 보류하고 `records_unverified` 에 더한다. 보류 세션은 exclude 조회에서 `target_not_found`, Orca 연결 후보에서 빠진다. 어떤 입력에서도 수집 전체가 실패하지 않는다(슬롯 부적합 값은 항목 단위 제외 + coverage).
- **coverage 오류**: 고정 코드만 쓴다. 예외 메시지 문자열은 반출하지 않는다.

### 2.2 Orca ↔ 세션 연결 관측 (머신 측 계산)

- **비교 대상**: Orca agent 의 `prompt` 와 같은 cwd 를 가진 세션의 **마지막 사람 지시**. 둘 다 NFC 와 공백 축약으로 정규화한다.
- **증거 등급**:
  - `prompt_exact`: 두 문장이 완전히 같고, 정규화된 길이가 **8자 이상**이다.
  - `prompt_prefix`: 한쪽이 다른 쪽의 접두어이고, 공통 길이가 **24자 이상**이다. **후보로만 쓴다.**
  - `cwd_only`, `none`: 후보로만 쓴다.
- **시간 조건**: Orca agent 의 `stateStartedAt` 또는 `updatedAt` 이 세션의 `[first_record_at, last_record_at + 10분]` 범위 안에 있어야 한다.
- **유일성**: 하나의 Orca `paneKey` 가 둘 이상의 세션과 맞으면 둘 다 `ambiguous` 로 처리한다. 세션이 둘 이상의 pane 과 맞을 때도 `ambiguous` 다.
- **화면 표시**: `prompt_exact` 이면서 시간 조건과 유일성을 모두 만족할 때만 "Orca 터미널 연결됨 (스냅샷 시점 관측)"으로 표시한다. 그 밖에는 모두 "연결 불명"이다.

### 2.3 실행 경로 — 번들 하나, 로컬·원격 공통

원격 머신(codev2 등)은 Palantir 노드 등록과 무관하게 **ssh 로 접속만 되면** 붙일 수 있다. 원본 transcript 를 ssh 로 끌어오지 않는다. **번들을 그 머신에서 실행하고, 살균이 끝난 결과만 돌려받는다.** 원본은 머신 밖으로 나가지 않는다(상위 §3.1). 노드 executor 의 `exposed_roots` 는 넓히지 않는다(상위 §7 I2).

**실행 경로는 하나다.** 로컬(Mac)도 원격과 같은 번들을 같은 방식으로 실행한다. 차이는 실행기뿐이다.

| 대상 | 실행기 (argv 배열 spawn, 셸 경유 없음) |
|---|---|
| 로컬 | `process.execPath --no-warnings -` |
| 원격 | `ssh -o BatchMode=yes -- <host> <node> --no-warnings -` |

`<node>` 는 기본 `node`, 또는 `--remote-node <절대경로>` 다. **원격 명령 문자열은 이 고정 토큰뿐이다.** 동적 값은 원격 명령에 넣지 않는다.

- **요청은 번들 안의 데이터다.**
  - Mac 은 요청 객체(작업 종류, `--now`, exclude 대상, `orca_bin` 등)를 만든다. 이를 번들 맨 앞에 `const REQUEST = <JSON.stringify 결과>;` 한 줄로 넣는다.
  - 번들 안 reader 는 이 요청을 **다시 검증**한다. 작업 종류는 닫힌 enum, 각 필드는 문법·길이 상한을 따르고, 모르는 키는 거부한다. 검증에 실패하면 오류 envelope 을 낸다.
  - 세션 제외 대상 같은 사용자 입력도 이 경로로만 전달한다.
- **번들**: Mac 이 실행할 때마다 메모리에서 만든다. 커밋하지 않는다.
  - 대상은 **고정 manifest** 다: `memorySanitize.js`, `observeSnapshotPolicy.js`, `sessionSnapshotReader.cjs`, 번들 launcher.
  - 작은 모듈 레지스트리로 감싼다. **런타임 resolver** 는 manifest 안 상대경로와 내장 모듈 allowlist(`node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`)만 해석하고, 그 밖은 throw 한다.
  - **정적 검사 (단어 규칙)**: 형태별 정규식이 아니라 단어로 판정한다. manifest 소스에 `import`, `binding`, `dlopen`, `getBuiltinModule`, `createRequire` 단어가 하나라도 있으면 번들 생성이 고정 코드로 실패한다. `require` 단어는 모든 출현이 `require('<manifest 또는 allowlist>')` 형태(사이 공백·주석 불허)이거나, 뒤에 영문자가 오는 산문(주석)이어야 한다. 앞에 `.` 이 오거나(`module.require`), 그 밖의 문자가 따라오면(별칭 대입·주석 끼우기 등) 실패한다. 런타임도 모듈 컴파일 전에 `process.getBuiltinModule` 을 없앤다.
  - **위협 모델 (PR1b 확정)**: 정적 검사와 런타임 resolver 는 **검토된 manifest 코드가 실수로 import 를 넓히는 것**을 막는다. 악의적인 manifest 코드를 격리하지는 않는다(manifest 는 이 repo 의 코드다). 그 범위 안에서 다음을 둔다: 모듈은 전역 스코프에서 strict mode 로 지연 컴파일한다(`new Function`, 런타임 클로저·호출 스택 비노출). 실행 전에 전역 `require`·`module`·`exports` 를 지운다. 내장 allowlist 는 null-prototype 객체로 조회한다. prototype 변조 같은 적대적 코드 경로는 다루지 않는다.
  - `reader_build` 는 **출처 추적값**이다. 정의는 SHA-256(정규 인코딩 `["palantir.snapshot-bundle/1", [경로, 바이트 길이, 바이트]…]`, manifest 경로순)의 앞 16 hex 이고, 문법은 `^[0-9a-f]{16}$` 다. REQUEST 줄은 해시 입력에 포함하지 않는다. Mac 은 받은 응답의 `reader_build` 가 **자기가 보낸 번들의 값과 같은지** 확인한다.
- **응답 프로토콜 — stdout 의 envelope 하나.**
  - 번들은 stdout 에 JSON envelope **하나만** 쓴다. 작업이 끝나고 완성·검증한 뒤에 한 번만 쓴다.
  - envelope 종류는 닫힌 스키마 세 가지다: 스냅샷(§3), exclude 조회 결과(§4), 상태 envelope `{ "schema": "palantir.snapshot-status/1", "machine_id", "reader_build", "code": ENUM, "counts": {ENUM: INT} }`.
  - 오류도 상태 envelope 의 **고정 code** 로만 낸다.
- **stderr 차단 — 원격에서 한다.**
  - launcher 는 시작하자마자 다음을 처리한다: `process.stderr.write` 를 no-op 으로 교체, `uncaughtException`·`unhandledRejection` 처리기 설치, `--no-warnings` 와 함께 `warning` 리스너 제거.
  - 예외가 나면 **stdout 에 아직 아무것도 쓰지 않았을 때만** 상태 envelope `internal_error` 를 쓴다. 이미 썼다면 아무것도 덧붙이지 않고 종료한다.
  - 번들이 띄우는 Orca 자식 프로세스는 stdout·stderr 를 모두 pipe 로 받는다. 이 출력은 허용 키만 파싱하고, 나머지는 버린다. 자식 출력을 그대로 전달하지 않는다.
  - Mac 은 원격 stderr 를 **표시도 저장도 하지 않는다.** 바이트 수만 센다.
  - 남는 신뢰 전제: launcher 실행 전 Node 자체 출력과 원격 셸 시작 출력은 번들 코드와 환경에서만 나오며 transcript 데이터를 담지 않는다.
- **Mac 수신**:
  - 상한: stdout 16MB(초과하면 즉시 kill), 실행 시간 120초. kill 은 실행기의 **프로세스 그룹 전체**에 보내고 파이프를 닫는다. ssh 가 파이프를 물려받은 자손(ProxyCommand 등)을 남겨도 상한 안에 끝난다. 실행기는 별도 프로세스 그룹이라 Mac CLI 를 Ctrl-C 로 끊으면 실행기가 잠시 남을 수 있다. stdin 이 닫혀 있고 부모가 사라져 출력이 EPIPE 로 끝나며, 기록은 Mac 검증 뒤에만 일어나므로 파일 변화는 없다(수용).
  - 종료 코드가 0 이 아니거나, 상한을 넘거나, envelope 이 하나가 아니거나, 스키마·정책 검증(§5.5 와 같은 모듈, `finalize(x) === x`)에 실패하면 **아무것도 쓰지 않는다. 기존 파일도 보존한다.**
  - 스냅샷이면 `<machine_id>.json` 을 원자적으로 쓴다(§2 출력).
  - 상태 envelope 의 `code` 는 **정확한 코드 목록**에서, `counts` 는 키 목록·정수 범위에서 확인한 뒤 표시한다.
- **입력 검증 (Mac)**: 검증에 실패하면 spawn 0회다.
  - `--host` 는 `^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$` 또는 `^[A-Za-z0-9._-]+$` 만 허용하고, `-` 로 시작하면 거부한다.
  - `--remote-node` 는 `^/[A-Za-z0-9._/-]+$` 만 허용한다.
- **spawn 가드**:
  - Mac 쪽 spawn 지점(실행기, ssh)은 `spawnGuard.assertSpawnAllowed` 를 거친다. 테스트는 `server/tests/fixtures/bin/` 의 가짜 ssh 를 쓴다. 가짜 ssh 는 로컬에서 `process.execPath` 로 번들을 실행한다.
  - 번들 안 Orca spawn 은 `REQUEST.orca_bin` 으로 주입한다. 테스트는 fixture 가짜 orca 의 절대경로를 넣는다. Mac 은 가드가 켜져 있으면 이 경로도 `assertSpawnAllowed` 로 검사한 뒤에 넣는다. 번들 안 reader 는 `NODE_TEST_CONTEXT` 나 `PALANTIR_BLOCK_REAL_SPAWN` 이 보이면 절대경로가 아닌 `orca_bin` 을 spawn 하지 않고 `orca_unavailable` 로 처리한다.
- **보드 위치**: I0a 보드는 명령을 실행하는 Mac 에서 띄운다. 폰은 tailnet 으로 그 보드에 접속한다. 다른 머신에서 보드를 띄우는 경우는 I0b(codev1 push)에서 다룬다.

---

## 3. 스냅샷 스키마 v1

```jsonc
{
  "schema": "palantir.session-snapshot/1",
  "machine": { "id": "ID", "label": "LABEL" },
  "generated_at": "TIME", "window_since": "TIME",
  "reader_version": "ENUM", "reader_build": "ID", "redaction_version": "INT", "policy_version": "INT",
  "coverage": {
    "claude": { "files_scanned": 0, "files_skipped": 0, "files_failed": 0, "records_unknown": 0,
                "records_unverified": 0, "excluded_sessions": 0, "deleted_instructions": 0,
                "queued_enqueued": 0, "queued_dequeued": 0, "queued_removed": 0,
                "multi_file_withheld": 0, "mixed_session_withheld": 0, "invalid_time_withheld": 0 },
    "codex":  { "files_scanned": 0, "files_failed": 0, "exec_sessions_excluded": 0,
                "subagent_excluded": 0, "unsupported_sessions": 0, "records_unknown": 0, "records_unverified": 0,
                "withheld_sessions": 0, "content_rule_excluded": 0,
                "excluded_sessions": 0, "deleted_instructions": 0,
                "multi_file_withheld": 0, "mixed_session_withheld": 0, "invalid_time_withheld": 0 },
    "orca":   { "state": "ok|unavailable|partial", "code": "ENUM|null" }
  },
  "sessions": [ { "key": "ID",                       // machine.id + ':' + provider + ':' + session_id
                  "provider": "claude|codex", "run_mode": "interactive|exec|subagent|unsupported",
                  "session_id": "ID", "cwd_id": "OPAQUE", "path_gen": 0, "repo_label": "LABEL|null", "git_branch": "LABEL|null",
                  "cli_version": "ENUM", "format_unverified": false,
                  "first_record_at": "TIME", "last_record_at": "TIME",
                  "first_instruction": "recoverable|unrecoverable|unknown", "compact_only_history": false,
                  "ai_title": "TEXT|null", "instruction_count": 0, "unknown_count": 0,
                  "orca_link": { "evidence": "prompt_exact|prompt_prefix|cwd_only|ambiguous|none",
                                 "confirmed": false, "pane_key": "ID|null", "terminal_handle": "ID|null" } } ],
  "instructions": [ { "id": "INSTR_ID",             // claude:<sid>:u<uuid> | codex:<sid>:i<id> | codex:<sid>:n<순번>
                      "session_key": "ID", "seq": 0, "ts": "TIME",
                      "kind": "human|slash|shell|reply", "text": "TEXT", "text_missing": false, "truncated": false,
                      "redacted": false, "attachments": 0, "unknown_blocks": 0,
                      "ref": "ID" } ],                // 등록 참조, §4
  "orca": { "worktrees": [ { "worktree_id": "ID", "repo_label": "LABEL", "path_id": "OPAQUE",
                             "branch": "LABEL", "status": "ENUM", "last_activity_at": "TIME", "live_terminals": 0,
                             "agents": [ { "pane_key": "ID", "state": "ENUM", "agent_type": "ENUM",
                                           "state_started_at": "TIME", "updated_at": "TIME", "interrupted": false } ] } ],
            "terminals": [ { "handle": "ID", "worktree_id": "ID", "agent_identity": "ENUM",
                             "last_output_at": "TIME", "connected": false } ] }
}
```

`machine.id` 가 identity 다. `label` 은 화면 표시용일 뿐이다. `reader_build` 는 `^[0-9a-f]{16}$` 다(§2.3). `ref` 는 `HMAC(local_key, 정규 인코딩 ["palantir.instr-ref/1", machine.id, INSTR_ID, 지시의 지문, ts])` 의 앞 16 hex 이고, 서버는 문법만 검증한다.

---

## 4. 반출 (Mac 과 codev2 → 보드가 도는 Mac)

- **이동**:
  - Mac 은 로컬 모드로 `PALANTIR_OBSERVE_SNAPSHOT_DIR` 에 직접 쓴다.
  - codev2 는 Mac 에서 `remote --host codev@codev2 snapshot` 으로 받아 같은 디렉터리에 쓴다(§2.3). scp 단계는 없다.
  - 파일명은 둘 다 `<machine_id>.json` 이고 덮어쓴다. 디렉터리 권한은 0700 이다.
- **제외·삭제 등록** (I0a 에는 보드 삭제 버튼이 없다):
  1. 보드에서 **등록 지정자** `<INSTR_ID>#<ref>` 를 복사한다. 세션 제외는 지정자 없이 세션 신원을 직접 준다.
  2. Mac 에서 `node scripts/session-snapshot.mjs [remote --host <user@host>] exclude --instruction <INSTR_ID>#<ref>` 를 실행한다.
  3. **조회 실행**(번들, 기록 0):
     - 현재 원본에서 그 지시를 다시 찾는다. `u`/`i` 신원은 신원으로, `n<순번>` 은 순번으로 찾는다.
     - 찾은 지시의 `ref` 를 다시 계산한다. **보드의 `ref` 와 다르면** `target_changed` 로 끝낸다. 보드를 본 뒤 조회하기 전에 원본이 다시 쓰여 순번이 다른 지시를 가리키게 된 경우다.
     - 일치하면 조회 envelope 을 돌려준다. 이 envelope 은 닫힌 스키마다: `{ "schema": "palantir.snapshot-exclude-preview/1", "machine_id", "reader_build", "op": ENUM, "target": INSTR_ID|"session:<ID>", "ts": TIME|null, "preview": TEXT(첫 줄, ≤200, §2.1 고정점)|null, "equiv_count": INT, "token": "^[0-9a-f]{64}$" }`. 경로, 키, 지문 입력은 넣지 않는다. Mac 은 이 envelope 도 §5.5 와 같은 방식으로 검증한 뒤에 표시한다.
     - `token` = `HMAC(local_key, 정규 인코딩 ["palantir.exclude-confirm/1", machine_id, op, 대상의 정규 인코딩, reader_build, 대상 지문, ts])`. `+` 연결은 쓰지 않는다.
  4. **확인**: 사용자 확인 입력은 **Mac 의 터미널**에서 받는다(기본값 No). 원격 stdin 은 번들 전송에 쓰이므로 원격 tty 를 쓰지 않는다.
  5. **기록 실행**(번들 재전송, 요청에 `token` 포함):
     - 조회와 같은 과정으로 대상을 다시 찾고 토큰을 다시 계산한다.
     - 원본이 바뀌었거나, 번들 빌드나 머신이 다르거나, 대상이 다르면 `confirm_mismatch` 로 거부하고 기록하지 않는다.
     - 일치하면 **검증한 그 신원과 지문**을 §2 갱신 규칙(잠금, 합집합)으로 기록한다.
     - 같은 토큰을 다시 써도 결과는 같다(멱등 — 이미 있는 항목은 합집합이라 변화 없음). 만료는 두지 않는다.
  6. 스냅샷을 다시 생성해 같은 파일명으로 덮어쓰고, 보드를 새로고침한다.
- **중간 사본 없음**: 스냅샷은 실행기 stdout 으로만 이동한다. 실행 머신의 디스크, 공유 위치, 다른 경유지에는 쓰지 않는다.
- **평가 종료 시 삭제**: 보드 디렉터리(Mac)를 지운다. 원격에는 스냅샷 파일이 없다. `observe.json` 은 삭제 목록을 담고 있으므로 지우지 않는다. `path_salt` 를 회전하면 `path_gen` 이 올라가 옛 경로 id 와의 연결이 끊긴다. 지시 삭제 신원은 salt 와 무관하므로 **삭제 목록은 회전 뒤에도 유지**된다.
- 보드는 브라우저 저장소(localStorage·IndexedDB)를 쓰지 않는다. 데이터는 다음 경우에 메모리에서 해제한다: 라우트 이탈, 로그아웃(401 bounce), 탭 종료.
- 실제 명령은 runbook 단락으로 문서화한다(PR2).

---

## 5. 서버: 읽기 전용 endpoint

### 5.1 활성 상태 — 부팅 시 봉인

- 활성 판정은 **부팅 시 한 번만** 한다. 아래 조건을 모두 만족해야 `on` 이다.
  - `PALANTIR_OBSERVE_SNAPSHOT_DIR` 설정됨
  - human 인증(`PALANTIR_TOKEN`) 켜짐
  - 루트 디렉터리 검사 통과: 설정값이 절대경로이고 realpath 가 설정값과 **글자 그대로** 같으며(정규화 비교 금지), 서버 사용자 소유이고, group/other 쓰기 권한이 없으며, 공개 정적 폴더(`server/public`) 안이 아님
- 하나라도 실패하면 `off` 이고, 경로를 설정했는데 실패한 경우에만 부팅 로그에 고정 코드로 경고를 남긴다(미설정은 무음).
- 상태를 바꾸려면 재시작해야 한다.
- 토큰 없이 auth 가 꺼진 상태(`method=none`)는 cookie 로 간주하지 않는다.

### 5.2 off 게이트

- `app.use('/api/observe', offGate)` 를 전역 `app.use('/api', auth)` **앞에** 마운트한다.
- 게이트는 **봉인된 boolean 만** 읽는다. 무인증 요청이 파일시스템 작업을 일으키지 않게 하기 위해서다.
- off 상태에서는 모든 메서드와 하위 경로에 404 를 돌려준다.
- 이 비노출은 서버 응답 수준까지만 보장한다. 클라이언트 번들에는 라우트 코드가 포함된다.

### 5.3 on 상태 — 인증 뒤

- 라우트 안에서 `req.auth.method === 'cookie'` 만 허용한다(`routes/questions.js` 선례).
- bearer 는 human·PM·worker 모두 403 이다. **cookie 가 아닌 요청은 오류 종류와 무관하게 403** 이다(잘못된 인코딩·본문 파싱 오류 포함, 인증 미들웨어의 401 만 예외). observe 는 본문을 auth 뒤에서 파싱한다.
- `GET /api/observe/snapshots` 는 검증을 통과한 파일의 메타데이터(machine id·label, generated_at, 크기, coverage 요약)를 돌려준다. 실패한 파일은 `{name_id, error_code}` 만 돌려준다.
- `GET /api/observe/snapshots/:machineId` 는 `machineId` 를 정책 ID 슬롯(정규식 + 비밀값 탐지)으로 검사하고, 파일명은 서버가 조합한다. 디렉터리 항목에 **정확히** `<machineId>.json` 이 있을 때만 연다(대소문자 무시 파일시스템 대비). 목록도 같은 이름 필터를 쓰고, 통과 못 한 이름은 항목째 제외한다. 목록 대상 파일이 256개를 넘으면 413 이다.

### 5.4 파일 읽기

- 매 요청마다 루트 realpath 를 다시 확인한다. 값이 다르면 503 과 `observe_root_changed` 를 돌려준다. 이때 상태는 바꾸지 않는다.
- 파일은 아래 순서로 연다.
  1. `lstat` 으로 regular file 이고 symlink 가 아닌지 확인한다.
  2. `open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)` 로 연다(FIFO 로 바뀌어도 대기하지 않음).
  3. 연 fd 를 `fstat` 해서 **dev/ino 가 1 의 lstat 결과와 같은지** 대조한다.
  4. 바이트 상한까지만 읽는다. 파일당 16MB, 응답 합계 64MB 다.
- 정적 서빙은 디코딩·정규화한 경로가 `/api` 아래면 건너뛴다. CLI 는 출력 폴더가 `server/public` 안이면 기록 전에 `out_dir_public` 으로 거부한다(공개 폴더의 파일은 인증 없이 서빙되기 때문).
- **신뢰 전제**: 루트는 서버 사용자 소유이고 다른 사용자가 쓸 수 없다. 따라서 디렉터리 교체 공격에는 서버 사용자 권한이 필요하다. 이 범위 밖은 위협 모델에 넣지 않는다.

### 5.5 재검증

- **구조 검증**: schema 와 버전.
- **정책 검증**: 재귀 allowlist, 타입, 길이, 금지 키, `redaction_version`/`policy_version` 하한. 모든 `TEXT`·`LABEL` 문자열이 `finalize(slot, x) === x` 인지 확인한다(§2.1 고정점). 생성기와 **같은 공유 함수**를 쓰므로 정상 출력은 반드시 통과한다.
- 실패하면 422 와 고정 `reason` 코드를 돌려준다.

### 5.6 무저장

- DB 쓰기와 캐시 파일이 없고, `Cache-Control: no-store` 를 붙인다.
- cookie-only 제한은 `/api/observe` 에만 적용한다. 전역 auth 와 SSE 는 바꾸지 않는다.

## 6. 화면: 세션 보드

- **라우트**: 정확히 `#work` 하나만 쓴다. `#work/...` 같은 하위 경로는 이 보드로 보내지 않는다. `#sessions` 는 레거시 SessionsView 가 쓰고 있다.
- **진입** (상위 §5 "전체 세션 보드가 기본 화면"):
  - 클라이언트는 활성 상태를 `pending | on | off | error` 로 관리한다. 판정은 `GET /api/observe/snapshots` 로 하며 200 이면 on, 404 면 off, 그 밖은 error 다. 401 은 기존 apiFetch 의 로그인 bounce 를 그대로 따른다.
  - `on` 이면 `NAV_ITEMS` 에 라벨이 붙은 "작업" 항목을 노출한다.
  - **기본 경로는 판정이 끝난 시점에 hash 가 비어 있을 때만 적용한다.** 이미 hash 가 있거나 사용자가 다른 곳으로 이동했으면 덮어쓰지 않는다.
  - 판정 대기 중이고 hash 가 비어 있으면 최대 1.5초 동안 로딩 셸을 보여 준다. 그 안에 판정이 나지 않으면 dashboard 를 렌더한다(**hash 는 쓰지 않는다**).
  - **늦게 도착한 응답**(fallback 이후)은 화면을 전환하지 않는다. 늦은 on 이면 "작업" nav 만 노출하고, 늦은 off·error 이면 아무것도 바꾸지 않는다. 사용자가 직접 이동한 경로는 어떤 경우에도 보존한다.
  - off 와 error 상태는 기존 동작과 같다. **운영 codev1 은 off 다.**
- **로드**: 목록을 받은 뒤 머신별 스냅샷을 병렬로 가져온다(AbortController 사용). "불러오는 중 (n/m)"을 표시한다. 일부가 실패하면 coverage 패널에 표시하고 나머지는 계속 보여 준다. 화면 상단에는 머신별 `generated_at`(평가 기준 시각)을 고정 표시한다.
- **세션 카드** (정렬 기본값: `last_record_at` 내림차순):
  - 1행: **최근 지시** 첫 줄.
  - 2행: **세션 최초 지시** 첫 줄. 최근 지시와 같으면 생략한다. 복구할 수 없으면 "최초 지시 복구 불가"를 표시한다.
  - 메타: 머신 · repo · git branch · 마지막 관측 시각(상대 + 절대) · 지시 수 · AI 제목(라벨 표시) · Orca 연결(연결됨 / 불명) · Orca agent `state`(스냅샷 시점) · 경고 배지(형식 미검증, compact 이력, unknown 비율).
  - 상태는 항상 "스냅샷 시점 관측"으로 표시한다. 단정 표현은 쓰지 않는다.
- **펼침 — 지시 타임라인**: 시각 · 종류 · 텍스트 · 잘림·살균 표시 · 첨부 개수 · 등록 지정자 `<INSTR_ID>#<ref>` 복사(§4).
- **검색** (상단 입력 하나, 클라이언트에서 즉시):
  - 대상: 지시 텍스트와 AI 제목.
  - 정규화: NFC + 소문자 변환. 공백을 남긴 형태와 공백을 제거한 형태를 둘 다 비교한다. 부분 문자열 매칭이다.
  - **결정적 순위**: 일치 대상은 (1) 지시 텍스트 > AI 제목 순으로 앞선다. 같은 대상 안에서는 (2) 공백 유지 형태 일치 > 공백 제거 형태 일치, (3) 일치 위치가 앞일수록, (4) 최신일수록 높다. 세션 점수는 그 세션의 최고 일치 점수다. 점수가 같으면 (5) `last_record_at` 내림차순, (6) 세션 key 사전순으로 가른다. 결과는 세션 단위로 중복 없이 보여 주고, 일치한 줄을 강조한다.
  - U3 의 "상위 3위"는 이 세션 순위를 기준으로 판정한다.
- **coverage 패널**: 머신별로 스캔·제외·삭제·unknown·미검증·exec 제외·Orca 상태를 보여 준다.
- **렌더 안전**: 모든 스냅샷 문자열은 htm 텍스트 노드로만 렌더한다. markdown, innerHTML, `dangerouslySetInnerHTML` 은 금지한다.
- **사용성**: 모바일 폭에서 한 손으로 조작할 수 있어야 하고, 탭 영역은 44px 이상이다. 디자인 토큰만 쓴다(라이트/다크 lock-step). 영문 원시 오류를 노출하지 않는다. 빈 상태와 off 상태 문구는 한국어로 쓴다.

---

## 7. 테스트

모든 fixture 는 **합성**이다. 실제 transcript 는 쓰지 않는다. **부정 단언 앞에는 반드시 보존돼야 할 항목의 정확한 비영 개수와 값을 단언한다.** 그렇게 해야 빈 출력이나 전부 거부하는 구현이 테스트를 통과하지 못한다.

| 영역 | 테스트 |
|---|---|
| Claude 결정표 | 행 2~10 각각과 **행 순서 충돌**: `local-command-stdout` + `turnOrigin=human` → 제외, origin 없는 `command-name` → slash, `origin.kind=system` + command 래퍼 → unknown. `<pasted>` 벗기기, 이미지만 있는 지시 → `text_missing`, queue 집계, ai-title, 같은 문장 두 번 → 2건, 삭제 신원 = uuid |
| Codex | run_mode 표(cli/vscode/exec/subagent/guardian_review/voice_chat), **Desktop+exec → exec 제외**. 블록 결합: 주입+human → 주입 제거, human+reply → `reply` + 빈 줄 구분, unknown 블록 → 텍스트에서 빠지고 `unknown_blocks` 기록, 첨부만 → `text_missing`, 주입만 → 0건. **위치가 다른 replacement_history 복제 → 추가 0건**, compact-only 플래그, `event_msg.user_message` → unverified, id 없는 메시지의 표시·등록 지정자 = 원본 순번(복제는 순번에 포함하지 않음), 삭제는 지문 기준 |
| 최초 지시 | 14일보다 오래된 세션 → 파일 첫 지시. `last-prompt` 로 시작하는 정상 파일 → recoverable. compact 가 선행 → unrecoverable. 판정 불가 → unknown. Claude·Codex 각각 |
| 반출 정책 | **모든 문자열 슬롯에 secret sentinel 을 넣고 출력에 원문 0회.** Orca 허용 키 정확 집합(비영). 경로 원문 0회, 금지 키 0개, 고정 오류 코드. 대체값 고정점(TEXT `[redacted]`, LABEL `redacted`). **property 테스트**(TEXT·LABEL 각각, 무작위 입력 + 변환·잘림 경계 입력): ① 멱등성, ② 출력 제약(길이·문자 집합), ③ **안전한 정상 입력은 그대로 보존**(대체값만 돌려주는 구현을 걸러 냄), ④ sentinel 제거. 경계 사례: 잘림 경계에서 생기는 Basic 패턴, LABEL 치환 뒤 생기는 토큰 패턴 |
| 제외·삭제 | 세션 / 지시 단위 → 해당 0건 + **나머지 정확 개수**. Codex id 있음 → `i` 신원, id 없음 → `n` 신원. **id 없는 세션 반례 2종(`A,B₁,B₂`→`B₁,B₂`, `A,B₁,B₂,B₃` 에서 B₂ 삭제 후 `A,B₂,B₃`) → 같은 지문 전부 제외, 삭제 내용 재등장 0, **지문이 다른** 내용은 정확 개수 보존**. 내부 공백만 다른 텍스트는 별개 지문. 키 교체 → 해당 세션 보류. `exclude` CLI 의 원본 재확인 → 순번이 어긋난 등록 거부. 첨부 전용 동일 메시지도 지문으로 제외. `local_key` 누락 → 해당 세션 보류(`withheld_sessions`). replacement_history 에 원본과 같은 `payload.id` 를 가진 복제 → 추가 0건. INSTR_ID 정규식을 생성기·설정·서버가 공유. 연결된 Orca title 차단. **파일 rename·salt 회전 후에도 삭제 유지.** 재실행 유지, 같은 파일명 덮어쓰기 |
| 연결 | exact 8자 경계, prefix 24자 경계, 빈 prompt, 시간창 밖, pane 중복 → ambiguous, Orca 실패 → 코드 |
| 경로 경계 | 허용 외 경로, symlink, 파일 수·바이트 상한 |
| 번들·원격 | **원격 경로 전체를 가짜 ssh 로**(가짜 ssh 는 `process.execPath -r <쓰기 계측 preload> -` 로 번들을 실행한다). 먼저 비영 결과를 선단언한다: 합성 HOME 의 **정확한 지시 값·개수**, 기존 스냅샷 파일 바이트, 기존 삭제 규칙. 그다음 확인할 것: 정상 → 파일 1개 원자적 기록, `reader_build` 가 Mac 기대값과 같음. **로컬 실행기와 원격 실행기로 같은 HOME 을 읽은 결과가 바이트 동일**(`--now` 고정). **실패 시 기록 0·기존 바이트 보존**: stdout 16MB 초과, 시간 초과, 종료 코드 ≠ 0, envelope 2개, 깨진 JSON, 정책 위반(sentinel 미살균), `reader_build` 불일치. **stderr**: 번들 안에서 sentinel 을 담은 예외를 던지고 경고를 발생시킨 뒤에도 원격 stderr 바이트가 0 이고, stdout 은 `internal_error` envelope 하나. Orca 가짜 바이너리의 stderr sentinel → 출력 0. 상태 envelope 의 모르는 code/count 키 → 표시 0. **쓰기 계측**: 실행 머신의 실제 쓰기 연산(open-for-write·rename·unlink·mkdir) 대상이 config 디렉터리의 `observe.json`·잠금·tmp 뿐임(최초 실행의 생성 1건 선단언). **입력**: `--host`(`-oProxyCommand=…`, 공백, `;`, 빈 값)·`--remote-node`(상대경로, 메타문자) → spawn 0. 원격 명령 argv 가 고정 토큰과 정확히 같음. 셸 메타문자·따옴표·`$(…)` 를 담은 세션 제외 대상 → REQUEST 데이터로만 전달되어 원격에서 재검증됨(문법 위반은 `request_invalid`). 모르는 REQUEST 키 → 거부. **번들 폐쇄**: manifest 밖 require·비리터럴 require·`import(` → 번들 생성 실패, 런타임 resolver 가 allowlist 밖 내장 모듈 거부. Node major 미달 → `node_unsupported`. **exclude**: 조회 기록 0. **조회 전 재작성**(`A,B,C`→`A,C`, 보드는 옛 `n2`=B) → `target_changed`. 조회와 기록 사이 원본 변경·빌드 변경·다른 머신 키·다른 대상 → `confirm_mismatch` + 기록 0. 일치 → 기록 1, 같은 토큰 재사용 → 변화 0. `local_key` 누락이나 지문 불일치 → `key_unavailable` + 새 키 생성 0. **동시 A·B 등록**(잠금 경합 포함) → 둘 다 남거나 하나가 `config_busy` 로 실패하고, 어느 쪽이든 기존 규칙 손실 0. Mac 확인 기본값 No. **spawn 가드 음성**(가드 활성, spawn 계측으로 실제 실행 차단): fixture 밖 ssh 경로 → `PALANTIR_SPAWN_BLOCKED` + 실행기 spawn 0. fixture 밖 절대경로 `orca_bin`(예: `/bin/true`) → Mac 이 거부, **실행기 spawn 0 + Orca spawn 0**. 비절대경로 `orca_bin` 을 REQUEST 에 직접 넣어 번들을 실행 → reader 가 spawn 0 + `orca_unavailable`. 그 전에 fixture 경로로 각각 spawn 1회를 선단언한다 |
| endpoint (`createApp` 통합) | 부팅 봉인: 디렉터리 + 토큰 + 루트 검사 조합별 on/off. off → 무인증·cookie·bearer 모두 404(하위 경로 포함) + **FS 접근 0**(spy). on → cookie 200 / bearer(human·PM·worker) 403. machineId 정규식, symlink, **lstat 후 symlink 교체(dev/ino 불일치) → 거부**, 비정규 파일, 루트 realpath 변경 → 503, 바이트 상한, 정책 위반(미살균·모르는 키) → 422, 정상 생성 출력 → 200(고정점), no-store, 전역 auth·SSE 무변경 |
| UI | 카드(최근/최초, 생략, 복구 3상태), 타임라인, 검색 순위(공백 변형·부분어·대상 우선·동점 규칙 결정성), coverage, 부분 로드 실패, abort, **XSS fixture 가 텍스트로만 렌더**. 활성 상태 pending/on/off/error: 빈 hash 에서만 기본 경로 적용, 명시 hash 보존, 1.5초 fallback 은 hash 를 쓰지 않음, **fallback 이후 늦은 on 이면 nav 만 노출하고 화면 전환 0**, 늦은 off 이면 변화 0, 사용자 이동 보존 |
| 게이트 | `npm test` 그린. 기존 a11y·visual 매트릭스는 **observe off 상태 그대로 유지**한다(baseline 변화 0). observe UI spec 은 `server/tests/e2e/observe/` 에 둔다. 기존 project 들은 이 디렉터리를 `testIgnore` 로 제외하고, 새 `observe` project 는 이 디렉터리만 `testMatch` 로 잡는다(상호 배타). 전용 webServer 는 `PALANTIR_TOKEN` + observe on + 합성 스냅샷으로 띄운다. **observe 전용 setup project** 가 `POST /api/auth/login` 을 호출하고, 그 결과인 cookie storageState 는 observe project 에서만 쓴다. 대상은 `#work`(라이트/다크 × 데스크톱/모바일)와 "작업" nav 가 보이는 공통 chrome 이며 `@a11y`·`@visual` 태그를 유지한다. 실행은 `npm run test:observe-ui` 이고, **기존 a11y·visual 과 같은 수동 게이트**다(CI 는 `npm test` 만). contrast waiver 는 불가 |

**역회귀**(구현을 되돌리면 실패해야 하는 항목): Mac 의 실행기·ssh·`orca_bin` 가드 호출(각각 제거하면 음성 테스트 실패), reader 의 비절대 `orca_bin` 차단, 번들 런타임 resolver 폐쇄, launcher stderr 차단, 수신 후 정책 재검증(기록 전), 실패 시 기존 파일 보존, `ref` 대조(`target_changed`), 확인 토큰 재검증, `observe.json` 잠금·합집합 갱신, 키 누락 시 키 생성 0, 결정표 행 4·6·7 순서, Codex run_mode(source) 판정, 주입 블록 필터, unknown 블록 비승격, replacement_history 무시, Orca 텍스트 필드 차단, 문자열 슬롯 고정점, salt 무관 삭제 신원, offGate 위치(auth 앞) + 봉인 상태(FS 0), cookie-only, 서버 정책 재검증, O_NOFOLLOW + dev/ino 대조, XSS 렌더, 빈 hash 에서만 적용되는 기본 경로.

---

## 8. 작업 단위 (codex-goal 위임)

1. **PR1 — 읽기 모듈 + 정책 모듈 + 실행 경로**: `scripts/session-snapshot.mjs`, `scripts/lib/sessionSnapshotReader.cjs`, `server/services/observeSnapshotPolicy.js`, parser, 연결, 번들·launcher·실행기(§2.3), envelope 검증, `observe.json` 갱신 규칙, exclude 조회·기록, 가짜 ssh·orca fixture, 단위 테스트.
2. **PR2 — endpoint + 보드 + runbook** (PR2a = endpoint + runbook, PR2b = 보드·진입·UI 테스트로 나눔): `routes/observe.js`(auth 앞 offGate), `WorkBoardView`, 진입 분기, UI·통합 테스트, a11y/visual, 반출 runbook 단락.

단위마다: codex-goal 위임 → 호스트 외부검증(RED→GREEN, 역회귀) → codex 적대리뷰 PASS → merge.

---

## 9. 열린 질문

| # | 질문 | 기본값 |
|---|---|---|
| Q1 | ~~codev2 에 repo checkout 과 Node 18 이상이 있나~~ | **해소 (2026-10-08)**: checkout 은 필요 없다(§2.3). `codev@codev2` 에 Node v22.23.2(`~/.local/bin`, 비대화형 ssh PATH 에 잡힘), `~/.claude/projects`, `~/.codex/sessions`, Orca CLI 가 있음을 실측했다 |
| Q2 | Orca 터미널 딥링크가 있나 | 없으면 handle 과 worktree(repo·branch 라벨)를 표시한다. 터미널 제목은 v11 에서 비반출 |
| Q3 | AI 제목을 얼마나 강조하나 | 라벨을 붙인 보조 정보로 둔다. U2 결과로 재판단한다 |
| Q4 | `codex_exec` 제외가 맞나 | 기본 제외 + 개수 표시. 측정에서 누락이 보이면 포함 옵션을 켠다 |

---

## 10. U0 기준과 측정 절차

**U0 기준** (대상 규모: 머신 ≤ 2, 세션 ≤ 300, 지시 ≤ 10,000):

| 항목 | 기준 |
|---|---|
| 스냅샷 생성 (머신당) | ≤ 60초. Mac 명령 시작부터 검증된 파일의 rename 완료까지 잰다. 원격은 번들 생성·ssh 연결·전송·실행·수신·검증을 모두 포함한다(매 수집마다 발생) |
| 보드 첫 로드 (스냅샷 목록 → 카드 표시) | 데스크톱 ≤ 3초, 폰(tailnet) ≤ 5초 |
| 서버 재시작 후 보드 준비 | ≤ 5초 |
| 검색 응답 (클라이언트, 검색어 10개 p95) | ≤ 200ms |
| 최초 1회 준비(observe.json 생성, ssh 키 확인, 보드 로그인) | 측정하고 보고만 한다. 1회성이므로 기준은 두지 않는다 |
| 반영 지연 | I0a 에서는 제외한다. I0b 에서 측정한다 |

**절차**: 상위 §6 의 공통 규칙(4분류 집계, 정확도/만족도 분리, 최소 표본, 전체 분모, 표본 교대)을 따른다.

1. 두 머신에서 스냅샷을 생성하고 U0 항목을 측정한다.
2. **U1**: 스냅샷 시점 Orca 기준 **live 세션 전체**를 대상으로 한다(상위 §6 — 최소 10개, 미달이면 판정하지 않음). 보드만 보고 세션마다 한 줄씩 적은 뒤 원본과 대조한다. 기존 방식(Orca 탭 순회)은 **순서를 교대**한 다른 측정 회차에서 시간을 잰다.
3. **U2**: 지시 수 상위 세션 최소 5개를 고른다. 원래 목적과 현재 하는 일을 각각 적은 뒤 대조한다. 실패하면 원인을 기록한다.
4. **U3**: 보드를 보기 **전에** 기억만으로 검색어를 최소 5개 적는다. 그다음 검색해서 세션 순위 상위 3위 안에 정답이 있는지, 걸린 시간은 얼마인지 기록한다.
5. **상위 §3.2 실측**: 중복·오귀속 사례 수와 원인을 기록한다.
6. 종료 보고를 작성한다. 통과 여부는 사용자가 판정한다(상위 §7 I0a).

---

## 11. 검토 이력

- **R1 (v1)**: **NO-GO** (BLOCKER 2 / SERIOUS 13 / MODERATE 4). 호스트가 다음을 대조해 사실임을 확인했다: Claude `command-name` 레코드에 origin 이 없음, `local-command-stdout`·`bash-stdout` 에 `turnOrigin=human` 이 붙음, `app.js:1859` 전역 auth 가 라우트보다 앞섬. v2 반영:
  - 재귀 allowlist + 문자열 슬롯 정책(TEXT/LABEL/OPAQUE/ENUM/ID), hostname 독립 machine_id, 고정 오류 코드 (§2.1)
  - 머신당 단일 파일 덮어쓰기, 지시 단위 삭제, 제외에서 파생된 Orca 텍스트 차단, salt 회전 (§2, §4)
  - Claude 제외 우선 결정표, 출력 래퍼 제외, origin 없는 slash 인정, 큐 집계 (§1.1)
  - Codex 세션 포함표(Desktop 포함, run_mode 분리, 미지원 집계), 블록 단위 판별, `event_msg` 는 unverified (§1.2)
  - replacement_history 를 복제로 판정, compact-only 플래그 (§1.3)
  - 세션 최초 지시와 관측 창 분리 (§1.4)
  - 연결 증거 등급·길이·시간·유일성 (§2.2)
  - machine.id identity (§3)
  - offGate 를 auth 앞에 마운트, 토큰 필수, 루트·파일 읽기 안전, 서버 정책 재검증 (§5)
  - observe on 인스턴스에서 기본 화면 + 라벨 내비 (§6)
  - 정확 hash, 로드 상한·abort, 결정적 검색 순위, XSS 렌더 금지 (§6)
  - 비영 선단언 테스트·sentinel·역회귀 확장 (§7)
  - U0 수치 (§10)
  - 살균 횟수 → `redacted` boolean (§2.1)
- **R2 (v2)**: **NO-GO**. R1 의 19개 검토 단위는 닫힘 11, 부분 8 이었다. 새로 나온 결함은 SERIOUS 7 / MODERATE 3 이다. 호스트 대조로 사실을 확인했다: Codex `Desktop + source=exec` 746건, `guardian_review`·`voice_chat` thread_source 존재, `playwright.config.js` 의 visual 서버 `PALANTIR_TOKEN=`. v3 반영:
  - 삭제 신원을 경로·salt 와 분리했다(Claude uuid, Codex 원본 순번). 경로 OPAQUE 에는 세대 `path_gen` 을 붙였다(§2, §3, §4).
  - 슬롯 finalize 고정점 규칙을 두고, 생성과 서버가 같은 함수를 쓰게 했다. 잘림은 마지막 살균 전에 한다(§2.1, §5.5).
  - Codex run_mode 를 source 로 판정하고 포함 여부와 분리했다(§1.2 A·B).
  - 블록 결합 계약을 정했다: unknown 비승격, reply 우선, 빈 줄 구분자, 첨부 전용 → `text_missing`(§1.2 C, Claude 행 9).
  - 최초 지시 복구를 3상태로 바꾸고 provider 별 증거를 정했다(§1.4).
  - 파일 열기를 `O_NOFOLLOW` + dev/ino 대조로 바꾸고 신뢰 전제를 명시했다(§5.4).
  - observe 전용 Playwright project 를 두고 기존 매트릭스는 그대로 뒀다(§7 게이트).
  - 클라이언트 활성 4상태를 두고, 기본 경로는 빈 hash 에서만 적용한다(§6).
  - 부팅 시 봉인한 활성 상태를 둔다. 게이트는 FS 를 건드리지 않는다(§5.1–5.2).
  - 명시적 비인간 origin 을 래퍼보다 앞에 두고, 충돌 시 unknown 으로 처리한다(§1.1 행 6).
  - 부분 판정이던 항목: U1 을 live 전체(최소 10) + 순서 교대로, 검색 대상 우선순위와 동점 규칙.
- **R3 (v3)**: **NO-GO**. R2 의 10건은 닫힘 8 / 부분 2, R1 의 부분 8건은 닫힘 6 / 부분 2 였다. 새로 SERIOUS 3 / MODERATE 2 가 나왔다. 호스트가 대조해 확인한 사실: Codex 원본 user 메시지 9,438건 중 6,519건에 `payload.id` 가 있다(40자, 세션 내 중복 0). brief 의 "id 없음" 전제가 틀렸다. v4 반영:
  - LABEL 대체값을 `redacted` 로 바꿔 고정점을 보장하고, 멱등 property 테스트를 추가했다(§2.1).
  - Codex 신원을 `payload.id` 우선으로 바꿨다. id 가 없으면 순번 + 로컬 지문을 쓰고, 재작성이 감지되면 세션을 보류한다(§1.2, §2).
  - 지시 신원 전용 문법 `INSTR_ID` 를 만들고 3자가 공유하도록 했다(§2.1, §3).
  - Playwright 의 observe 디렉터리를 상호 배타적인 testMatch/testIgnore 로 분리했다. setup·storageState 는 observe 전용으로 한정했고, 수동 게이트로 명시했다(§7).
  - fallback 이후에는 화면을 전환하지 않는다. 늦은 on 이면 nav 만 노출한다(§6).
- **R4 (v4)**: **NO-GO** — SERIOUS 1, MODERATE 1. 나머지 R3 항목은 닫혔다. codex 가 로컬 구조로 확인한 사항: INSTR_ID 가 Claude 의 36자 sessionId·uuid, Codex 의 36자 session_id·40자 payload.id 를 모두 수용한다. replacement 의 user 항목 2,899건 중 2,079건이 원본과 같은 id 지만, §1.3 이 replacement 전체를 먼저 제외하므로 추가 0건이다. v5 반영 내용:
  - id 없는 세션: 순위치 지문 비교를 **접두부 지문열 완전 일치 검증**으로 바꿨다. 불일치·단축·키 누락·검증 불가는 모두 세션 보류로 처리한다(§1.2).
  - property 테스트에 정상 입력 보존·출력 제약·sentinel 검사를 추가했다(§7).
  - replacement 동일 id fixture 를 명시했다(§7).
- **R5 (v5)**: **NO-GO** — SERIOUS 1, MODERATE 1. 새 반례 `A,B₁,B₂,B₃` 에서 B₂ 를 삭제한 뒤 B₁ 이 제거되면, 접두부가 여전히 같아서 B₂ 가 재반출된다. property 테스트 지적은 닫혔다. 다만 호스트가 확인해 보니 **v3 의 줄 교체 접두어 `| 반출 정책` 이 §0 범위 행에도 일치해서 §0 행을 덮었고, 테스트 행은 갱신되지 않은 상태**였다. codex 가 이 배치 오류를 짚었다. v6 반영:
  - id 없는 Codex 지시의 삭제를 **내용 지문 기준**으로 바꿨다. 같은 지문은 위치와 무관하게 전부 제외하고, 그 대가로 과삭제를 허용한다. 이로써 접두부 검증이 불필요해졌다(§1.2).
  - `withheld_sessions`·`content_rule_excluded` 를 coverage 스키마에 추가했다(§3).
  - §0 범위 행을 복구하고 테스트 행에 property 계약을 넣었다(§0, §7).
- **R6 (v6)**: **GO**. R5 의 지적은 모두 닫혔다. 새로 MODERATE 3건이 나왔고 v7 에서 반영했다.
  - 삭제용 정규화를 NFC 와 trim 으로만 한정했다(내부 공백 보존). 첨부는 개수만 비교한다는 점을 명시했다.
  - `local_key` 는 회전하지 않는다. 키 지문이 다르면 해당 세션을 보류한다.
  - `exclude` CLI 로 등록하는 절차를 정했다. 원본을 다시 확인하고 사용자 확인을 받은 뒤에 기록한다(§4).
  - §7 의 잔존 문구 2건을 정정했다.
- **R7 (v7)**: **GO** — R6 의 5건이 모두 닫혔고, 새 BLOCKER/SERIOUS 는 없다. 설계검토를 종료한다.
- **v8 개정 (사용자 결정, 2026-10-08)**: 원격 머신에 repo checkout 을 요구하던 전제(§9-Q1)를 없앴다. 사용자가 "작업공간 추가는 ssh 로 하지 않느냐"고 짚었다. 원본을 ssh 로 끌어오는 방식은 상위 §3.1(원본 반출 금지)·§7 I2(`exposed_roots` 비확대) 위반이라 버렸다. 대신 **번들을 ssh stdin 으로 보내 그 머신에서 실행하고, 살균 결과만 받는다.** scp 단계는 없어졌다.
- **R8 (v8)**: **NO-GO** — BLOCKER 2, SERIOUS 6, MODERATE 1. 모두 v8 개정이 만든 경계 공백이었다. v9 반영:
  - 원격 stderr 정규식 필터는 allowlist 가 아니다. 게다가 필터링 시점에는 이미 머신 밖이다 → **원격 launcher 에서 stderr 를 차단**하고, 결과는 stdout envelope 하나로만 낸다. 오류는 고정 code 로만 내고, Mac 은 stderr 를 버린다(§2.3).
  - exclude 조회 응답에 반출 스키마가 없었다 → 닫힌 preview envelope 을 정의하고, Mac 도 검증하게 했다(§4).
  - exclude 의 동적 인자(cwd 등)가 원격 명령으로 들어갈 수 있었다 → **요청은 번들 안의 REQUEST 데이터**로 보내고 원격에서 재검증한다. 원격 명령은 고정 토큰뿐이다(§2.3).
  - 조회 **전**에 재작성된 순번은 토큰으로 걸러지지 않았다 → 스냅샷에 지시별 `ref` 를 넣고, 보드는 `<INSTR_ID>#<ref>` 를 복사하게 했다. 조회에서 `ref` 가 다르면 `target_changed` (§3, §4, §6).
  - 토큰 입력의 정규 인코딩이 없었고, 머신·작업·대상 구분과 키 누락 처리도 없었다 → 도메인 태그를 단 정규 튜플로 바꿨다. 키가 없거나 맞지 않으면 키를 새로 만들지 않고 `key_unavailable` 로 끝낸다. 토큰은 멱등이다(§2, §4).
  - `observe.json` 을 동시에 쓰면 삭제가 유실될 수 있었다 → 잠금 아래 다시 읽고 **합집합으로만 반영**하게 했다(§2).
  - `reader_build` 는 정책 동일성을 증명하지 못했다 → 출처 추적값으로 정의를 좁혔다. 문법과 Mac 기대값 대조, 런타임 resolver 폐쇄를 넣었고, **로컬도 같은 번들·실행 경로를 쓰도록** 실행 경로를 하나로 합쳤다(§2.3).
  - 테스트가 쓰기 0 과 spawn 가드를 증명하지 못했다 → 쓰기 연산 계측 preload, 비영 선단언, 번들 안 Orca spawn 주입(`orca_bin`)과 가드 경로를 정했다(§2.3, §7).
  - U0 측정 경계를 Mac 명령 시작부터 rename 완료까지로 정의했다(§10).
- **R9 (v9)**: **NO-GO** — SERIOUS 1. R8 의 9건 중 8건은 닫혔다. 남은 1건은 spawn 가드에 음성 테스트가 없다는 것이다. 가짜 실행 파일로 성공 경로만 검사하면, 가드 호출을 지워도 테스트가 통과한다. v10 반영: fixture 밖 ssh·`orca_bin` 을 넣었을 때 spawn 0 임을 확인하는 음성 테스트(비영 선단언 포함)와 역회귀 항목을 추가했다(§7).
- **R10 (v10)**: **GO** — R9 의 1건이 닫혔고 새 BLOCKER/SERIOUS 는 없다. 개정분 검토를 종료한다.
- **v11 (PR1a 구현 중, 2026-10-08)**: codex 코드 적대리뷰 R1~R9 NO-GO → R10 GO. 리뷰가 라운드마다 같은 계열의 우회를 찾아 아래처럼 범위를 줄였다.
  - Orca 터미널 `title` 비반출 (R1·R3·R4 — 제외·보류 세션과의 연결을 증명해 제목을 막는 로직이 매번 우회됐다).
  - cwd 접두사 제외 제거 — **사용자 결정** (R1·R4·R5·R6 — cwd 는 레코드마다 바뀌는 값인데 세션 단위로 판정했다).
  - 다중 파일·혼합 세션·시각 부적합 세션은 병합·부분 필터 대신 **통째 보류 + coverage** (R2·R5·R7~R9 — 병합과 부분 필터가 신원·순번·증거 계산과 얽혔다).
  - 그 밖에 preview 는 전체 살균 뒤 첫 줄, 정책 슬롯은 생성 단계에서 미리 검증, Codex 내용 삭제 규칙은 provider·session 범위로 한정.
- **PR1b (2026-10-10)**: codex 코드 적대리뷰. 구현 단계에서 확정한 것:
  - 런타임 resolver 우회 2건(클로저의 `nativeRequire`, stdin 실행에서 노출되는 전역 `require`)을 재현 후 막았다. 모듈을 전역 스코프에서 strict 로 지연 컴파일한다. 이 덕분에 오래된 Node 에서도 문법 해석 전에 `node_unsupported` 를 낼 수 있다.
  - 정적 검사·resolver 의 **위협 모델을 "실수로 인한 import 확장"으로 한정**했다(§2.3). prototype 변조·호출 스택 접근 같은 적대적 manifest 코드는 범위 밖이다. 리뷰가 같은 계열 우회를 반복해 찾는 것을 막기 위해서다.
  - launcher 가 스스로 만드는 상태 envelope(`request_invalid`·`node_unsupported`·`internal_error`·reader 오류 변환)은 `machine_id` 를 `unknown` 으로 고정한다. 설정 파일을 다시 읽어 반출하면 정책 검사를 거치지 않은 값이 나갈 수 있었다.
  - 실행기는 실행 파일을 **spawn 에 넘길 env 의 PATH 로** 절대경로까지 해석한 뒤, 그 경로로 가드 검사와 spawn 을 함께 한다.
  - exclude 도 `--now` 를 받는다. 조회와 기록은 같은 now 를 쓴다.
  - R2: `process.getBuiltinModule`·`createRequire` 로 import 를 넓히는 경로를 정적 검사와 런타임 양쪽에서 막았다. spawn 가드 음성 테스트는 실제 spawn 을 부르지 않는 기록 전용 스텁으로 바꿨다(가드를 지워도 fixture 밖 프로그램이 실행되지 않음). `node_unsupported` 보장 범위를 Node 14.18 이상으로 좁혔다.
  - R3: 주석을 끼운 동적 import 가 정적 검사를 피했다 → 형태를 쫓지 않고 `import` 토큰 자체를 금지했다(manifest 에 이 단어가 없다). 테스트가 import 성공과 차단을 구분하도록, 쓰기 허용 목록이 잠금·정확한 tmp 형식만 받도록 좁혔다.
  - R4: 같은 계열(주석을 끼운 `process.binding`·`dlopen`·`require`)이 다시 나왔다 → 정적 검사를 **형태 추적에서 단어 규칙으로** 바꿔 계열 전체를 닫았다(§2.3). 그 밖에 CLI timeout 뒤 기존 파일 보존, 큰 정상 envelope 의 flush 를 테스트로 고정했다.
  - R5: 정적 검사 계열은 닫힘. timeout 때 ssh 자손이 파이프를 쥐면 끝나지 않던 문제 → 프로세스 그룹 kill + 파이프 닫기 + 2초 backstop. 로컬 실행기의 가드 호출을 호출 기록으로 검증.
- **PR2a (2026-10-10)**: endpoint + runbook. codex 코드 적대리뷰 R1~R3 NO-GO → R4 GO. 반영: 파일명도 정책 ID 슬롯(비밀값 탐지)으로 거르기, `O_NONBLOCK`(FIFO 교체 대기), 목록 파일 수 상한 256, 상세의 정확한 파일명 대조(대소문자 무시 FS), 루트 설정값 글자 그대로 비교·공개 폴더 안 거부, 정적 서빙의 디코딩 기준 `/api` 제외, CLI 의 공개 폴더 출력 거부, cookie 아닌 요청은 오류 종류와 무관하게 403(단일 규칙). 범위 밖으로 확정: 죽은 manager capability 요청 때 전역 auth 의 `probeActive` 정리(전역 auth 기존 동작, "전역 auth 무변경").
- **PR1c (2026-10-10, 실데이터 검증으로 발견)**: Mac 실데이터(Claude 1.6GB·Codex 5.6GB)에서 번들이 V8 힙 4GB OOM 으로 죽었다 — 합성 fixture 로는 드러나지 않았다. 고친 것: 창 밖 파일은 신원만, 창 안 파일은 한 번에 하나씩 파싱 후 원본 폐기(10.8초, 정상 종료). 하위 에이전트 파일 제외(codev2 보류 20→0), `--label`, Orca CLI 실제 envelope·숫자 시각·`tabId:leafId` 연결, `ai-title` 시각 미요구(AI 제목 0/153 → Mac 65/96), 명령 래퍼 표시 정리.
