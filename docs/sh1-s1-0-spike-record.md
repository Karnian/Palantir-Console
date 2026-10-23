# SH1 S1-0 스파이크 관측 기록 (2026-10-24)

`docs/specs/sh1-session-host-brief.md` §9 S1-0 의 8개 확인 항목을 실제 Agent SDK + 동봉 CLI 로 실측한 기록이다. brief v5 의 "S1-0 에서 확정" 칸은 이 문서를 근거로 채운다. 관측은 이 환경·버전에 한정된다. 버전을 올리면 같은 스크립트로 다시 잰다.

## 환경

| 항목 | 값 |
|---|---|
| 머신 | macOS (Darwin 25.5.0), arm64 |
| Node | v22.22.2 |
| SDK | `@anthropic-ai/claude-agent-sdk@0.3.308` (라이선스 "SEE LICENSE IN README.md") |
| 동봉 CLI | `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, `2.1.308 (Claude Code)` |
| 동봉 CLI SHA-256 | `ca923c86ac84b30574a82331a05b6e066c27477a926ceaffe46a845a33e4dd37` — 사용자 설치 `~/.local/share/claude/versions/2.1.308` 과 **바이트 동일**. codesign Identifier `com.anthropic.claude-code`, TeamIdentifier `Q6L2SF6YDW` (둘 다 같음) |
| 계정 | 구독 로그인(Claude Max), 키체인 |
| 모델 | 턴이 필요한 항목은 `haiku`. 프로토콜 동작 확인용이며 모델과 무관하다 |
| 실행 방식 | 스크립트는 저장소 밖 임시 디렉터리에서 `env -i PATH HOME USER LANG TMPDIR SHELL node <script>` 로 실행(부모 Claude Code 세션 env 차단). 자식은 `spawnClaudeCodeProcess` 로 직접 띄우고 env 를 고정 목록 + 표지 `PALANTIR_OWNED_INCARNATION` 으로 만든다 |

재현: `docs/sh1-s1-0-spike/` 의 스크립트를 저장소 밖 디렉터리로 복사하고 `npm i @anthropic-ai/claude-agent-sdk@0.3.308` 뒤 실행한다(`work/` 가 그 아래에 생긴다 — cwd 를 저장소 안에 두면 프로젝트 hooks 가 돈다). LLM 호출은 ①⑤⑥⑦⑧ 합쳐 haiku 짧은 턴 약 15회, 결과에 찍힌 추정 비용 합계 약 $0.1~0.2.

## 결과 요약

| # | 항목 | 결론 | brief 반영 |
|---|---|---|---|
| ① | prompt 수신 신호·1:1 | **uuid 단위 수신 신호 있음**: `command_lifecycle`(capability `msg_lifecycle_v1`)의 `command_uuid` = 보낸 uuid, `queued → started → completed\|cancelled`. 첫 assistant 와 result 가 `user_message_uuid(s)` 로 같은 uuid 를 돌려준다 | §4.3 prompt 관측 |
| ② | 동봉 실행 파일의 키체인 로그인 | **읽는다**. 인증 env 를 모두 뺀 상태에서 `subscriptionType: "Claude Max"` | §2.3 |
| ③ | account 실제 값 | 인증 방식 6가지가 서로 구별된다(아래 표). 모델 요청 없이 확인 가능 | §1.2-3 게이트 규칙 |
| ④ | pid·시작시각·표지 | spawn 직후 `child.pid`, `ps -o lstart= -p` (초 단위), `ps -E -ww -o command= -p` 로 같은 UID 프로세스의 env 표지 조회 **됨**. 도구 하위 프로세스(python)도 표지를 물려받음 | §3.3, R4 해소 |
| ⑤ | 호스트 종료 시 자식 | **호스트 SIGKILL → 자식은 고아로 남아 진행 중 턴을 끝까지 수행**(모델 요청·자동 허용 도구 포함) 뒤 종료. 승인 대기 중이면 약 10초 안에 도구 미실행으로 종료. 호스트 정상 종료 → SDK 가 자식 트리 종료. 자식 SIGTERM → 3초 안에 Bash 트리·`&` 백그라운드·MCP 까지 정리. claude 정상 종료는 `&` 백그라운드를 남긴다 | §3.1·§3.4·§5-9 |
| ⑥ | `canUseTool` 장시간 대기 | 300초 보류 → timeout 없음, signal abort 없음, 허용 후 도구 1회 실행(카운터 1줄) | §5-3 |
| ⑦ | 인터럽트 영수증 | `interrupt()` → `{"still_queued":[<D uuid>]}`. 진행 중 Bash 정지, 결과 `error_during_execution`(umu = 중단된 메시지), lifecycle `cancelled`. 이어서 D 가 다음 턴으로 실행됨 | §5-5 |
| ⑧ | resume 뒤 사용자 설치 CLI | 사용자 설치 `claude -p --resume <SDK 세션 id>` 가 같은 세션 id 로 이전 대화("alpha delta")를 이어감 | §5-8 |

## 상세

### ① prompt 수신 신호 (`s1-turns.mjs` phase 1·3)

보낸 메시지 A(uuid `08b94c37…`)에 대해 순서대로 관측:
```
command_lifecycle command_uuid=08b94c37… state=queued
command_lifecycle command_uuid=08b94c37… state=started
assistant user_message_uuid=08b94c37… user_message_uuids=["08b94c37…"] text:alpha
result success user_message_uuid=08b94c37… user_message_uuids=["08b94c37…"]
command_lifecycle command_uuid=08b94c37… state=completed
```
- 사용자 메시지 자체는 replay 로 돌아오지 않는다(`isReplay` 프레임 없음). **수신 신호는 `command_lifecycle queued`** 다. SDK 문서도 uuid 를 넣은 메시지에만 echo 한다고 적는다 — 모든 메시지에 uuid 를 넣는다.
- 앞 턴의 result 를 받은 뒤 보낸 메시지는 매번 `user_message_uuids` 가 자기 uuid 하나뿐이었다(1:1 성립). 턴 진행 중에 보낸 메시지 D 는 `queued` 만 찍히고 대기했다(이번엔 인터럽트 뒤 다음 턴으로 실행). 문서상 `priority` 미지정(`next`)이면 도구 호출 사이에 같은 턴으로 흡수될 수 있다 — 1:1 규칙(진행 중 전송 금지)을 유지한다.
- init `capabilities`: `interrupt_receipt_v1, interrupt_cancel_queued_v1, interrupt_send_now_v1, interrupt_requeue_taken_v1, msg_lifecycle_v1, request_marker_lists_v1, lifecycle_wakeup_source_v1, sdk_mcp_tools_list_changed, sdk_mcp_manifests, mcp_read_resource_v1, mcp_tool_ui_meta_v1, ui_surface_v1, mcp_call_result_not_for_model_v1`.

### ③ account 실제 값 (`s3-auth.mjs`, 모델 요청 0)

스트리밍 `query()` 에 아무것도 내보내지 않는 입력 iterable 을 주고 `initializationResult()`·`accountInfo()` 를 읽었다(약 0.8~1.3초). 두 값은 항상 같았다. 가짜 키는 요청을 보내지 않으므로 과금 없음.

| 변형 | 자식 env | `account` |
|---|---|---|
| 구독(키체인) | 인증 변수 없음 | `{"email":…,"organization":…,"subscriptionType":"Claude Max","apiProvider":"firstParty"}` — `tokenSource`·`apiKeySource` **없음** |
| API 키 | `ANTHROPIC_API_KEY=sk-ant-api03-FAKE…` | `{"tokenSource":"claude.ai","apiKeySource":"ANTHROPIC_API_KEY","apiProvider":"firstParty"}` |
| bearer | `ANTHROPIC_AUTH_TOKEN=fake` | `{"tokenSource":"ANTHROPIC_AUTH_TOKEN","apiProvider":"firstParty"}` |
| OAuth env | `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKE…` | `{"tokenSource":"CLAUDE_CODE_OAUTH_TOKEN","apiProvider":"firstParty"}` |
| apiKeyHelper | settings `apiKeyHelper` | `{"tokenSource":"apiKeyHelper","apiKeySource":"apiKeyHelper","apiProvider":"firstParty"}` |
| Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` | `{"apiProvider":"bedrock"}` |

- `startup()` 이 돌려주는 `WarmQuery` 에는 `initializationResult()` 가 없다(`query`·`close` 만). 첫 지시 전 게이트는 **입력이 비어 있는 스트리밍 `query()` + `initializationResult()`** 로 한다.
- 첫 prompt 를 보내면 `system/init` 에 `apiKeySource:"none"` 이 온다(구독).
- init 단계에서 **사용자 수준 SessionStart hooks(3개)와 사용자 MCP 서버(playwright)가 실행됐다**. SDK 기본 설정 소스에 사용자 설정이 들어 있다.

### ④ 자식 신원·표지

- custom spawn 이 받은 것: `command` = 동봉 실행 파일 절대 경로, `args` = `--output-format stream-json --verbose --input-format stream-json --permission-mode=default`, SDK 가 넣는 env 는 `CLAUDE_AGENT_SDK_VERSION`·`CLAUDE_CODE_ENTRYPOINT`·`CLAUDE_CODE_SDK_READS_SESSION_STATE`.
- `ps -o lstart= -p <pid>` → `Sat Oct 24 00:52:00 2026`(초 단위). `ps -E -ww -o command= -p <pid>` 출력에 `PALANTIR_OWNED_INCARNATION=inc_spike_sub` 가 보임.
- 자식은 호스트의 프로세스 그룹을 그대로 쓴다(별도 pgid 아님). Bash 도구 트리는 자기 pgid 를 가진다.
- 도구가 띄운 python 프로세스의 env 에도 표지가 있었다.

### ⑤ 호스트 종료 시 자식 동작 (`s5-hostexit.mjs` + `s5-observe.sh`)

도구: `(sleep 300; echo late >> late.txt) & <90~120초 대기>; echo fg >> fg.txt`, 허용 직후 5초에 사건을 일으킴.

| 사건 | 관측 |
|---|---|
| 호스트 SIGKILL (도구 실행 중) | 자식 ppid → 1. 도구가 끝까지 돌고(`fg` 기록), **이어서 모델 요청을 더 보내 도구(`ls`)를 한 번 더 호출하고 "done" 으로 턴을 마친 뒤** 종료. `&` 백그라운드는 claude 종료 뒤 약 3분 더 살아 `late` 기록 |
| 호스트 SIGKILL (승인 대기 중) | 자식 고아로 남았다가 +3~10초 사이 종료. 도구 미실행 |
| 호스트가 자식 stdin 만 닫음 (60초 유지) | 자식은 종료하지 않고 도구 계속 실행. **호스트가 정상 종료(`process.exit`)하자 그 순간 자식 트리가 종료**(도구 결과 `Exit code 137`) — SDK 의 종료 처리 |
| 자식에 SIGTERM | exit 143 이 1초 안. Bash 트리·`&` 백그라운드·MCP 서버 모두 3초 안에 사라짐 |

### ⑥ `canUseTool` 300초 보류

`echo B >> counter.txt` 허용을 300,004ms 보류 → 그동안 signal abort 없음, 보류를 풀자 도구 1회 실행·카운터 `["B"]`, result 정상. SDK 문서: "permission prompts don't time out".

### 거부 신호 (`s7-deny.mjs`)

`deny` + 메시지 `Denied by Palantir user. request=pln_8ba26843` → 같은 `tool_use_id` 의 `tool_result` 가 `is_error: true`, 내용이 메시지 그대로(nonce 보임). 도구 미실행.

### ⑦ 인터럽트 영수증

C(`python3 -c "time.sleep(40)" && echo C`) 허용 → 6초 뒤 D 전송(`queued`) → 1.5초 뒤 `interrupt()`:
```
INTERRUPT receipt {"still_queued":["<D>"]}
task_notification status=stopped (Bash)
tool_result "The user doesn't want to proceed with this tool use. …"
user text "[Request interrupted by user for tool use]"
result error_during_execution is_error=true user_message_uuid=<C>
command_lifecycle <C> cancelled
command_lifecycle <D> started → assistant "delta" → result success umu=<D> → completed
```
카운터에 C 없음(도구 정지 확인). SDK `interrupt()` 는 `cancel_queued` 를 보내지 않는다(capability `interrupt_cancel_queued_v1` 은 있으나 SDK 경로로는 못 씀).

### ⑧ resume 호환

SDK 세션 `bb1c6e8f…` 를 사용자 설치 `claude -p --resume bb1c6e8f… --model haiku` 로 이어 "앞서 답한 단어"를 물음 → `success`, 같은 세션 id, 답 `alpha delta`. 세션 파일은 `~/.claude/projects/<cwd 인코딩>/<id>.jsonl`. 대화형 TUI `--resume` 은 TTY 가 필요해 여기서 재지 않았다(S1-e 실측 항목).

## 부수 관측

- **CLI 가 `sleep N && 명령` 형태의 Bash 를 막는다**(`tool_use_error: Blocked: sleep 40 followed by: …`). 실측·테스트에서 긴 명령은 `python3 -c "time.sleep(N)"` 같은 형태로 만든다.
- 긴 Bash 는 CLI 가 백그라운드 작업(`system/task_started`, `task_notification`)으로 옮길 수 있다. 인터럽트하면 `stopped` 로 정지됐다.
- **`rate_limit_event.rate_limit_info`** 에 `status`, `resetsAt`, `rateLimitType`(`five_hour` 등), `overageStatus`(`rejected`), `overageDisabledReason`(`out_of_credits`), `isUsingOverage`(false) 가 온다 — 유료 사용 크레딧(overage) 사용 여부는 Palantir 가 표시할 수 있다. Max 월간 API 크레딧과 구독 한도의 차감 순서는 여전히 알 수 없다.
- 결과의 `total_cost_usd`(haiku 짧은 턴 $0.003~0.013)는 클라이언트 추정치다.

## 보충 실측 (codex R5 지적 후, 모델 요청 0)

### settings `env` 로 들어오는 인증 (`s9-gate2.mjs <variant> close`)

SDK `settings` 옵션의 `env` 블록(= 플래그 설정 계층, 파일 settings 의 `env` 와 같은 병합 경로)에 인증 변수를 넣고 초기화만 했다.

| settings `env` | `account` | 게이트 |
|---|---|---|
| `ANTHROPIC_API_KEY` | `{"tokenSource":"claude.ai","apiKeySource":"ANTHROPIC_API_KEY","apiProvider":"firstParty"}` | 걸러짐 |
| `ANTHROPIC_AUTH_TOKEN` | `{"tokenSource":"ANTHROPIC_AUTH_TOKEN",…}` | 걸러짐 |
| `CLAUDE_CODE_OAUTH_TOKEN` | `{"tokenSource":"CLAUDE_CODE_OAUTH_TOKEN",…}` | 걸러짐 |
| `CLAUDE_CODE_USE_BEDROCK` | `{"apiProvider":"bedrock"}` | 걸러짐 |
| **`ANTHROPIC_BASE_URL`** | **구독과 똑같음**(`subscriptionType:"Claude Max"`, `apiProvider:"firstParty"`) | **account 로는 못 거름** |

### `resolveSettings()` (`s10-resolve.mjs`, CLI 미실행)

임시 cwd 의 `.claude/settings.json` 에 `env.ANTHROPIC_BASE_URL`·`apiKeyHelper`·`PreToolUse` hook 을 넣고 `resolveSettings({cwd})` → `effective.env` 키 `["ANTHROPIC_BASE_URL"]`, `effective.apiKeyHelper` 값, `provenance.env`·`provenance.apiKeyHelper` = 그 파일 경로(`source:"project"`), `effective.hooks` 의 이벤트 목록, `sources` = user + project 파일. 깨끗한 cwd 에서는 `env` 비어 있음, hooks 출처 = 사용자 설정. **사용자 설정에 `PermissionRequest` hook 이 있다**(Orca agent hook — `ORCA_*` env 가 없으면 `{}` 만 출력하므로 결정하지 않는다).

### 정리 동작

`q.close()` 와 `abortController.abort()` 모두 자식이 약 0.2~1.1초 안에 `exit 0`(7회 반복).

### 초기화 응답의 다른 필드 (`s11-initfields.mjs`)

`initializationResult()` 에 `pid`(custom spawn 의 pid 와 같음), `claude_code_version:"2.1.308"`, `current_permission_mode:"default"`, `session_state:"idle"`, `remote_control_available:true`, `remote_control_auto_enable:false`, `fast_mode_state:"off"`, `capabilities:["ui_surface_v1","mcp_call_result_not_for_model_v1"]` 가 있다. **`msg_lifecycle_v1`·`interrupt_receipt_v1` 은 이 목록에 없고, 첫 prompt 전에는 `system/init` 이 오지 않는다**(5초 대기에도 없음) — 두 capability 는 첫 prompt 뒤에만 확인된다.
