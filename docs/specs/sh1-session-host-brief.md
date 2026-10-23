# SH1 — 사람용 세션 호스트 (Claude 1개·머신 1대) 구현 brief

상태: **초안 v4 (2026-10-23)** — codex 설계검토 R4 GO, **사용자 승인 대기**. 승인 전에는 구현하지 않는다. 사용자 판정 항목은 §1.4(기존 자격 경로)와 §10 R6(과금 잔여 위험) 두 가지다. S1-0 스파이크 결과로 v5 를 만들어 다시 검토한 뒤 S1-a 에 들어간다. "S1-0 에서 확정"으로 남긴 항목은 모두 **확정 전 안전 기본값**(대개 unknown·차단)을 함께 적었다 — 스파이크가 어느 쪽으로 나와도 기본값보다 덜 안전해지지 않는다.
상위 계약: `docs/specs/instruction-centric-direction-brief.md` §0.2 (v6 LOCKED). 이 문서와 충돌하면 §0.2 가 우선한다.

## 0. 목적과 범위

사람이 매일 쓰는 Claude Code 세션을 Palantir 가 띄우고, Palantir 채팅에서 지시·도구 승인·인터럽트·종료를 다룬다. 서버를 재시작해도 진행 중인 작업이 죽지 않고, 원하면 같은 대화를 터미널 `claude --resume` 으로 넘긴다(§0.2.10 SH1 행).

**SH1 범위**: Claude 1개 provider, macOS 머신 1대(서버와 같은 머신, 서버는 사용자가 터미널에서 `npm start` 로 띄운다), 데스크톱 브라우저, 한 사용자.

**SH1 밖**:
- 원격 머신·폰(SH4), hooks 수집(SH2~SH3), Codex 호스트·비서 초안 경유 지시(SH5).
- **터미널 → Palantir 되찾기**: 밖에서 도는 실행의 종료를 확인할 수단이 SH1 에 없다(§0.2.4 "확인 불가면 거부"). 넘기기는 한 방향이다(§5-8).
- 진행 중 턴에 메시지 합류(§5-2 — 한 번에 하나의 미완료 지시).
- "승인하고 기억"(설정 파일에 규칙 쓰기), systemd·launchd 운영 배포, 기존 Top/Operator/Worker 경로 변경.

**필수 증거**(§0.2.10): ① 사용자가 실제 작업에 써 보고 화면·흐름 lock-in ② 전달·복구 정확성 — 오입력 0, 중복 전송 0, 불명은 불명으로 표시(U8 데스크톱 부분, §8). ①이 ②를 대신하지 않고, **②의 최소 안전 기준을 통과한 뒤에 ①의 실사용을 시작한다**(§9).

## 1. 선행 확인 — 인증·과금 (§0.2.9)

확인일 2026-10-23. 공식 문서·도움말이 근거이고, 보도는 경위에만 썼다. 각 SH 단계 착수 때 같은 문서를 다시 확인하고 바뀌었으면 이 절을 고친다.

### 1.1 결론: 개인·단일 사용자 구성에 한해 조건부 허용

이 판정은 **사용자 본인이, 자기 머신에서, 자기 구독 계정으로** 쓰는 구성에만 적용한다. Palantir 를 다른 사람에게 제공하는 제품으로 쓰는 경우는 판정하지 않았다(그 경우 SDK 개요의 "제3자 개발자는 claude.ai 로그인·한도를 자기 제품에 제공할 수 없다" 제한과 Commercial Terms 가 걸린다).

근거:
- Claude Code [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance) "Authentication and credential use": 금지 대상은 제3자 개발자가 자기 앱에 Claude.ai 로그인을 제공하는 것, 사용자를 대신해 Free/Pro/Max 자격으로 요청을 중계하는 것, Claude.ai 자격·세션 토큰을 **수집·저장·중계**하는 것이다. 같은 절은 end user 가 **수정하지 않은 Claude Code 실행 파일**에 자기 구독으로 로그인하는 것은 막지 않는다고 적는다. Pro/Max 한도는 "ordinary, individual usage of Claude Code and the Agent SDK" 전제다.
- 소비자 약관 §3-7([consumer-terms](https://www.anthropic.com/legal/consumer-terms), 2025-10-08 시행): 자동화된 접근은 API 키 경유이거나 **Anthropic 이 명시적으로 허용한 경우**만.
- 도움말 [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): 2026-06-15 공지 — Agent SDK·`claude -p`·제3자 앱 사용은 구독 한도에서 차감(5월에 발표한 별도 크레딧 전환은 시행 전 보류). 2026-10-07 공지 — Max·Team 에 월간 API 크레딧 추가, Agent SDK·`claude -p` 에도 쓰임, 구독 한도 사용도 유지. **두 재원의 차감 순서는 문서에 없다.** 위 "명시적 허용"의 근거다.
- 경위(시행된 변경만): 2026-04-04 부터 OpenClaw 등 "제3자 harness"는 구독 한도 대신 추가 사용량(extra usage) 과금. 같은 공지에서 Claude Code 자체는 구독에 계속 포함된다고 했다. 5월 발표는 시행되지 않았다.

### 1.2 SH1 이 지켜야 할 조건 (계약)

1. **실행 파일 무수정**: Anthropic 이 배포한 Claude Code 실행 파일을 그대로 쓴다(§2.3 — SDK 동봉 실행 파일). 인증 수단을 끄거나 바꾸지 않는다.
2. **Palantir 는 Claude 자격을 만지지 않는다**: 새 호스트는 OAuth 토큰·키체인 값·자격 파일을 읽거나 저장하거나 env 로 넘기지 않는다. 실행 파일이 사용자 `HOME` 의 로그인을 스스로 읽는다. 로그인이 필요하면 사용자가 터미널에서 `claude` 로 Anthropic 절차를 마친다. **기존 서버 경로가 이 조건을 깨는 문제는 §1.4 — SH1 수락의 선행 조건이다.**
3. **구독 로그인 강제 (경고가 아니라 차단)**:
   - 자식 env 에서 인증 순위([authentication](https://code.claude.com/docs/en/authentication) "Authentication precedence")상 구독 로그인보다 앞서는 변수를 제거한다: `CLAUDE_CODE_USE_BEDROCK`·`CLAUDE_CODE_USE_VERTEX`·`CLAUDE_CODE_USE_FOUNDRY`·`ANTHROPIC_AUTH_TOKEN`·`ANTHROPIC_API_KEY`·`CLAUDE_CODE_OAUTH_TOKEN`·`ANTHROPIC_PROFILE`·`ANTHROPIC_BASE_URL`.
   - 설정 파일(`apiKeyHelper`, settings 의 `env` 블록, gateway 로그인)로도 다른 인증이 들어올 수 있으므로, **첫 지시를 보내기 전에** SDK `startup()` 으로 초기화만 끝내고 `initializationResult().account`(`tokenSource`·`apiKeySource`·`subscriptionType`)를 확인한다. 구독 로그인으로 판정되지 않으면 세션을 닫고 "구독 로그인이 아닌 인증 — 시작하지 않음"을 표시한다. 판정에 쓸 정확한 값은 S1-0 에서 실측해 고정한다.
   - **prompt 를 보낼 때마다 직전에 `accountInfo()` 로 다시 확인**한다. 달라졌거나 조회가 실패하거나 모르는 값이면 보내지 않는다(rejected).
   - **보장 범위(낮춤)**: 인증을 실행 동안 고정하는 공식 수단은 없다. 위 확인은 "첫 모델 요청 전"과 "각 prompt 전"까지만 보장한다. 한 턴 안의 후속 모델 요청(승인 뒤 계속 등) 사이에 설정 파일·로그인이 바뀌면 감지하지 못할 수 있다. 결과·`system/api_retry` 의 인증 오류는 장애로 표시하지만 전환 자체를 막지는 못한다. **이 잔여 위험은 사용자 판정 항목이다(§10 R6).**
   - startup 이전에도 프로젝트 hooks·MCP 는 실행된다 — 그래서 시작 전 확인 화면(§5-1)이 게이트보다 앞에 있다.
4. **`--bare` 를 쓰지 않는다**: bare 는 OAuth·키체인을 읽지 않는다. 장래 `-p` 기본이 된다는 예고는 버전 고정(§2.3)과 3번 게이트가 막는다.
5. **개인 사용**: Palantir 허브 인증(`PALANTIR_TOKEN` cookie)을 유지하고, 소유 세션 조작은 사람 cookie 로만 한다(§7).

표시: **인증 수단과 청구 재원을 따로** 적는다. 인증 = "구독 로그인". 재원 = "구독 한도 / Max·Team 월간 API 크레딧(차감 순서 문서 미명시) / 한도 소진 뒤 계정에서 켠 경우 유료 사용 크레딧". 유료 사용 크레딧([usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans))은 opt-in 이고 Claude Code 사용에도 적용되며, 월 상한·자동 충전은 계정 설정이다. Palantir 는 어느 재원이 쓰였는지 알 수 없으므로 **무과금을 보장하지 않는다.** 계정의 유료 사용 크레딧 설정은 사용자가 정하는 선행 조건이다(§10 R6).

### 1.3 비용·한도·장애

- 턴마다 결과의 `total_cost_usd` 를 **클라이언트 추정치**로 표시한다(문서가 실제 청구와 다를 수 있다고 명시). 구독 차감량은 provider 가 주지 않으므로 표시하지 않는다.
- `system/api_retry` 의 `error`(`authentication_failed`·`rate_limit`·`billing_error`·`account_on_hold` 등)와 결과 오류를 **장애 사실**로 따로 기록·표시한다. 턴 결과는 실패 증거가 있을 때만 실패, 아니면 불명(§0.2.9). 자동 재시도·재전송 없음. 미전송 승인 대기는 만료.
- 비서(C1) 비용과 소유 세션 비용을 섞지 않는다.
- **재검토·중단 조건**: §1.1 의 문서 중 하나라도 개인 사용 허용·구독 차감 서술이 바뀌면, 오류가 나지 않더라도 SH1 사용을 멈추고 이 절을 다시 판정한다.

### 1.4 기존 서버의 자격 처리 — SH1 수락 선행 조건 (사용자 판정 필요)

서버가 뜨는 것만으로 §1.2-2 를 깨는 경로가 둘 있다. 새 호스트가 이 경로를 안 써도, SH1 을 쓰려면 서버를 켜야 하므로 해당된다.
- **부팅 시 자격 저장·복원**: `server/index.js:31` → `authResolver.bootstrapClaudeAuthFromEnv`(`server/services/authResolver.js:381`). 서버 env 에 `CLAUDE_CODE_OAUTH_TOKEN`·`ANTHROPIC_API_KEY` 가 있으면 repo 루트 `.claude-auth.json` 에 저장하고, 다음 부팅에 `process.env` 로 되읽는다.
- **사용량 조회의 토큰 조회**: `server/services/providers/claude-code.js:100` 이 env 또는 키체인·자격 파일에서 OAuth 토큰 값을 읽어, 문서화되지 않은 `api.anthropic.com/api/oauth/usage` 를 curl 로 호출한다. 토큰이 curl **argv 에 실려**(118행 부근) 같은 머신의 프로세스 목록에 보이는 보안 결함도 있다.
- 키체인 **존재 확인**(`hasClaudeKeychainCredentials`, `-w` 없이 값 미조회)은 해당하지 않는다.

권장안(사용자 판정): 두 경로를 **기본 꺼짐**으로 바꾸고(명시 opt-in 환경변수로만 켬), argv 노출은 opt-in 상태에서도 고친다. 휴면 manager 의 인증 동작이 바뀌는 결정이라 별도 PR(S1-pre)로 승인받는다. 판정이 나기 전에는 §1.2 충족도 미결이고 SH1 수락을 선언하지 않는다.

### 1.5 Codex (SH5 참고)

OpenAI 문서는 ChatGPT 계정 로그인으로 `codex exec` 를 허용하고, CI 같은 프로그램 작업에는 API 키를 권장한다([Codex auth](https://developers.openai.com/codex/auth)). 금지 문구는 찾지 못했다. SH5 착수 때 다시 확인한다.

## 2. 인터페이스 선택

### 2.1 채택: Claude Agent SDK (TypeScript) — 별도 호스트 프로세스 안에서

`@anthropic-ai/claude-agent-sdk` 를 정확한 버전으로 고정한다. 문서화된 능력이 SH1 요구에 맞는다:

| SH1 요구 | SDK 문서 계약 |
|---|---|
| 자식 생성 통제 | `spawnClaudeCodeProcess(SpawnOptions) → SpawnedProcess` — 호스트가 직접 spawn(§3.3) |
| 시작 전 인증 확인 | `startup()` 으로 초기화 후 `initializationResult()`/`accountInfo()` |
| 지시 | streaming input(`AsyncIterable<SDKUserMessage>`), 메시지마다 `uuid` |
| 도구 승인·거부 | `permissionMode: 'default'` + `canUseTool(toolName, input, {signal, suggestions})` → `allow`/`deny`. 콜백은 무기한 대기 가능 |
| 질문 응답 | `AskUserQuestion` 도 `canUseTool` 로 온다 |
| 인터럽트 | `interrupt()` — `interrupt_receipt_v1` 이면 `still_queued` 영수증 |
| 재개 | `resume: <session_id>`. 세션 파일은 CLI 가 기록 → 터미널 `claude --resume <id>` 와 같은 대화 |
| 기능 탐지 | `system/init` 의 `capabilities` |

기각:
- **기존 `streamJsonEngine`/`claudeAdapter`**: 기본 `bypassPermissions`, 승인 경로 없음, `cancelTurn()` 미구현, `accepted:true` 가 메모리 버퍼 접수 포함, 5,000자 절단(§0.2.3).
- **CLI 제어 프로토콜 직접 구현**: 제어 메시지 wire 형식은 SDK 타입으로만 간접 문서화돼 있다. 제품 경로는 SDK 로 한다(테스트용 가짜 실행 파일은 §8.1-b).
- **PTY/tmux 키 주입**: §0.2.1-4 금지.
- **PreToolUse `defer`**: 한 턴에 도구 호출이 하나일 때만 동작. SH1 에서 쓰지 않는다.

**대체 후보**(교체재 아님): `--permission-prompt-tool` MCP 도구 경로. 인터럽트 영수증이 없고 승인마다 MCP 왕복이 낀다. SDK 를 쓸 수 없게 되면 이 경로를 **별도 수락 기준으로 다시 검증**한 뒤에만 붙이고, 자동 교체하지 않는다.

### 2.2 의존 원칙과의 관계

SDK 는 오픈소스가 아니다(라이선스 "SEE LICENSE IN README.md", Anthropic 약관). §0.2.1-5(OSS 반입)가 아니라 §0.2.1-2(벤더 공식 인터페이스 우선)에 해당한다. 개인 설치(`npm install`)만 가정하고 재배포·vendoring 은 하지 않는다.

### 2.3 실행 파일과 버전쌍

- **SDK 가 동봉한 실행 파일을 쓴다**(`@anthropic-ai/claude-agent-sdk-darwin-arm64`). SDK 버전과 동봉 CLI 버전이 1:1 로 묶여 있어(문서: SDK v0.3.191 ↔ CLI v2.1.191) 호환 조합이 하나로 정해진다. 사용자 설치 `claude` 는 자동 업데이트로 바뀌므로 자식 실행에 쓰지 않는다.
- 고정 항목: SDK 버전, 동봉 실행 파일의 절대 경로·SHA-256. custom spawn(§3.3)이 `SpawnOptions.command` 가 그 경로인지, 파일 해시가 기록값과 같은지 spawn 직전에 확인한다. 다르면 시작하지 않는다.
- 터미널 넘기기(§5-8)도 **같은 동봉 실행 파일의 절대 경로**로 한다. PATH 의 `claude` 는 쓰지 않는다 — 실행 파일·버전이 호스트 실행과 같아서 세션 파일 호환을 따로 맞출 필요가 없다. 넘기기 직전에 해시를 다시 확인하고, 다르면 넘기지 않는다.
- 동봉 실행 파일이 사용자의 키체인 로그인을 그대로 읽는지는 S1-0 필수 확인 항목이다. 못 읽으면 이 절을 다시 정한다.

### 2.4 어댑터 경계

`start / send(uuid, text) / decide(toolUseId, decision) / interrupt / close / events`. 각 반환·이벤트는 **증거 수준**(`effect_done` / `provider_observed(근거)` / `none`), 상관 ID(message uuid, tool_use_id), 프로세스 identity 를 싣는다. 능력은 provider·버전·모드별로 판정해 표시한다(§0.2.3): `observe / prompt / tool_approval / cancel / resume`. 대체 경로가 같은 배지를 같은 의미로 쓰려면 같은 증거 수준을 내야 한다.

## 3. 프로세스 구조

```
브라우저 ──HTTP/SSE──▶ Palantir 서버 ──Unix socket──▶ 세션 호스트 ──SDK(custom spawn)──▶ claude 자식
                          (재시작 가능)                  (세션 소유, 유일한 writer)
```

### 3.1 호스트 수명

- 세션 호스트는 서버와 분리된 Node 프로세스다. 소유 세션의 SDK `query` 와 대기 중인 `canUseTool` 콜백을 들고 있다. **서버 재시작이 호스트를 죽이지 않는다**(§0.2.7).
- 기동: 서버가 소켓 handshake 에 실패하면 호스트를 **새 세션(setsid)·stdio 분리**로 띄운다. 터미널 종료(SIGHUP)·서버 프로세스 그룹 종료에서 살아남는다. systemd 등 서비스 관리자 아래에서는 cgroup 단위로 정리될 수 있어 SH1 지원 밖이다(SH4 선행 조건).
- **단일 인스턴스**: 호스트는 부팅 첫 단계에 잠금 파일에 `flock(LOCK_EX|LOCK_NB)` 을 잡고 **종료까지 놓지 않는다**. 못 잡으면 즉시 종료한다(동시 기동 경쟁은 여기서 끝난다). 잠금을 가진 호스트만 소켓 파일을 지우고 다시 만들고 capability 파일을 교체한다. 잠금 FD 는 close-on-exec 로 열어 **claude 자식에 상속하지 않는다**(상속되면 호스트가 죽어도 잠금이 풀리지 않는다 — 테스트로 고정).
- **준비 완료 handshake**: 서버는 소켓 연결 후 `hello` 로 `{host_boot_id, 저장소 스키마 버전, SDK 버전}` 을 받은 뒤에만 요청한다. host_boot_id 가 바뀌었으면 이전 연결의 미완료 요청은 모두 결과 조회로 다시 확인한다.
- **요청 접수 규칙**: 호스트는 요청을 durable 기록한 **뒤에만** `accepted(request_key)` 를 답한다. 서버가 응답을 못 받으면 상태는 "접수 미확인"이고, 같은 request_key 로 결과를 조회·재시도한다(멱등, §4.4) — 이미 접수됐으면 기존 결과를, 아니면 새로 접수된다. 시작·지시·승인·질문 응답·인터럽트·종료·넘기기·삭제 전부 이 규칙과 request_key 를 쓴다.
- **유휴 종료**: 소유 세션이 없고 진행 중 요청이 없는 상태가 N분 지속되면 ① 새 연결 거부 ② 이미 받은 요청 중 접수 응답을 안 한 것은 `not_accepted` 로 답하고 닫음 ③ 큐 재확인 ④ 종료. ③ 에서 접수된 요청이 있으면 종료를 취소한다.

### 3.2 서버↔호스트 인증과 노출 축소

- Unix domain socket(디렉터리 0700, 소켓 0600) + 호스트가 부팅마다 만드는 capability(0600 파일, 서버가 읽음).
- capability·`PALANTIR_*` 값은 claude 자식 env·argv·프롬프트에 넣지 않는다(§0.2.7). 같은 UID 라 격리는 주장하지 않는다.

### 3.3 자식 생성과 실행 신원

pid 와 pgid 는 그것만으로 신원이 아니다(owner-exit 트랙 교훈 — 재사용됨). 호스트는 `spawnClaudeCodeProcess` 로 자식을 직접 만들고 다음 순서를 지킨다:
1. **예약 기록**: `incarnations` 에 `state=spawning`, 예약 id 를 커밋.
2. **spawn**: env 에 비밀이 아닌 표지 `PALANTIR_OWNED_INCARNATION=<예약 id>` 를 넣는다. 자식의 Bash 등 하위 프로세스도 이 env 를 물려받는다.
3. **신원 기록**: spawn 직후 `{pid, 프로세스 시작시각}` 을 읽어 `state=alive` 로 커밋.

복구 규칙(호스트 재기동 시). **모든 신원 조회는 세 값 중 하나다: `match` / `mismatch_confirmed` / `query_failed`.** `query_failed`(조회 명령 실패, 부분 결과, 시작시각을 못 읽음, 권한 오류)는 어떤 경우에도 사망으로 바꾸지 않고 `liveness_unknown` 으로 간다. 표지 조회가 macOS 에서 되는지는 S1-0 필수 확인이고, **안 되면 표지 조회 결과는 항상 `query_failed`** 다.
- `spawning`(pid 없음): 표지로 찾음 → 신원을 붙이고 아래 `alive` 판정. 표지 조회가 성공했고 결과가 비었음 → `never_started`. `query_failed` → `liveness_unknown`.
- `alive`: pid 가 없음 → `mismatch_confirmed`(사망). pid 가 있고 시작시각이 다름 → `mismatch_confirmed`(pid 재사용, 사망). pid·시작시각 일치 → 살아 있음(`orphaned`). 그 밖에는 `query_failed` → `liveness_unknown`.
- `liveness_unknown` 인 세션은 새 실행·resume·넘기기·삭제를 막고 "프로세스 확인 필요"를 표시한다. 사람이 고를 수 있는 것은 "다시 확인"과, 신원이 확인된 경우의 "종료"뿐이다.
- 사람이 고르는 "종료": 신호 직전에 신원을 다시 대조하고, 일치할 때만 SIGINT → (유예) → SIGTERM 을 그 pid 에 보낸다. 일치하지 않으면 아무 신호도 보내지 않는다.

### 3.4 호스트 상실과 실행 종료는 다른 사실이다

세 값을 따로 기록·표시한다:
- **호스트 연결**: connected / lost(서버가 호스트와 통신 불가).
- **실행 생존**: alive / exited / unknown — §3.3 판정.
- **제어 가능**: 이 실행을 지금 호스트가 들고 있는가. 호스트가 재기동했는데 이전 실행이 살아 있으면 stdio 가 끊겨 다시 붙을 수 없다 → `orphaned`: "제어 상실 — 실행 중일 수 있음". 사람은 §3.3 "종료"만 할 수 있다.

**종료 확인**의 정의 — 보장 범위를 둘로 나눈다:
- **대화 실행 종료(보장)**: claude 본체 프로세스가 끝났다. 증거 = 호스트가 직접 본 exit 이벤트, 또는 재기동 뒤 신원 조회 `mismatch_confirmed`. resume·넘기기의 필수 조건은 이것 **그리고** 아래 하위 프로세스 확인 통과다 — 같은 대화를, 또는 같은 지시의 남은 작업을 두 곳에서 실행하는 것(§0.2.4·§0.2.7)을 막는다.
- **하위 프로세스 정리(최선 노력, 보장 아님)**: 표지를 물려받은 하위 프로세스가 0개. CLI 는 SIGTERM 때 Bash 프로세스 트리를 정리한다고 문서화돼 있다(headless 문서). 그러나 `env -i`·데몬화·별도 서비스처럼 표지를 버린 프로세스는 찾을 수 없다. **표지가 남은 프로세스가 하나라도 보이거나 표지 조회가 `query_failed` 면 resume·넘기기를 막는다**(사람 확인으로 우회하지 않는다). 사람이 할 수 있는 것은 목록 보기, 프로세스별 "종료"(§3.3 과 같은 신원 재대조 뒤 신호), "다시 확인"이다. 표지를 버린 프로세스는 찾을 수 없다 — 이것은 SH1 의 **알려진 한계**이며, 화면에 "표지를 버리고 분리된 백그라운드 프로세스는 확인 범위 밖"이라고 적는다.

## 4. 저장 계약

### 4.1 저장 주체

- **writer = 호스트**(호스트 전용 SQLite, WAL). 전달 상태를 관측하는 쪽이 호스트이고, 서버가 없을 때도 기록돼야 하기 때문이다. 서버 DB 에는 소유 세션 원문을 복제하지 않는다.
- **서버는 호스트 DB 를 직접 읽지 않는다**(v2 의 읽기 전용 경로 폐기 — 서버·호스트 스키마 결합과 일관성 문제를 새로 만든다). 호스트가 응답하지 않으면 화면은 마지막으로 받은 내용을 **"호스트 응답 없음 — 아래는 HH:MM 기준, 현재 상태 불명"** 으로 표시하고 모든 조작을 막는다. 현재 상태처럼 보이게 두지 않는다. 진단에는 잠금 파일의 호스트 pid 와 신원 조회 결과만 보인다.
- **재생**: 모든 이벤트·상태 전이는 단조 증가 `seq` 를 가진다. 호스트는 snapshot 을 **한 read transaction** 에서 만들어 `{상태, seq_high}` 를 함께 준다. 구독은 `since_seq=seq_high` 로 이어 받고, 호스트는 active 세션의 이벤트를 지우지 않으므로 재생 구간이 보존된다. `since_seq` 가 보존 범위 밖이면 호스트는 재생 대신 새 snapshot 을 요구한다.
- **저장 실패 시 fail-closed**: 마이그레이션 실패·DB 손상·디스크 부족이면 호스트는 새 전송·새 실행을 거부하고 장애를 보고한다. 대기 중인 승인은 결정을 기록할 수 없으므로 전달하지 않는다.

### 4.2 테이블

| 테이블 | 핵심 필드 |
|---|---|
| `owned_sessions` | id, cwd, claude_session_id, title, state(active/handed_off/closed/deleting/deleted), created_at |
| `incarnations` | id(=예약 id), session_id, host_boot_id, state(spawning/alive/exited/orphaned/never_started/liveness_unknown), pid, pid_started_at, sdk_version, cli_path, cli_sha256, account_snapshot, capabilities, started_at, ended_at, end_reason |
| `deliveries` | id, session_id, incarnation_id, kind(prompt/tool_decision/question_answer/interrupt), body, target_tool_use_id, turn_gen, request_key, fingerprint, message_uuid, state, 상태별 시각·seq, reason |
| `tool_requests` | id, incarnation_id, tool_use_id, tool_name, input(원문), state(pending/decided/cancelled/expired), decision(allow/deny/answer + 내용), answer_delivery_id — **사람의 결정 확정(state=decided)과 provider 전달(delivery state)은 별도 필드** |
| `events` | incarnation_id, seq, 원문 JSON(SDK 메시지 전문 — 화면 절단과 분리, §0.2.12) |
| `request_tombstones` | request_key, fingerprint 해시, 원래 전달 최종 state(unknown 포함), session_deleted 여부, 만료 시각 — 삭제 뒤 멱등 유지(§4.6) |

### 4.3 전달 상태 기계 (§0.2.6)

`queued → sending → written → provider_observed → completed`, 그리고 `→ unknown | rejected | expired | cancelled`. `rejected` = 재검증 실패로 효과 없음, `cancelled` = 선형화 지점(§4.5)에서 막혀 효과 없음 확정, `expired` = 유효기간·incarnation 종료로 보내지 않음.

- **queued**: 기록됨. 외부 효과 없음.
- **sending**: 외부 효과(SDK 입력 yield, 콜백 resolve, `interrupt()`) **직전에 커밋**한다. 효과는 이 커밋 뒤에만 일어난다.
- **written**: 효과 호출이 반환된 뒤 커밋.
- **단조성**: 상태는 앞으로만 간다. 모든 전이는 `UPDATE … WHERE state IN (<허용 이전 상태>)` 조건부다. 예: 관측 이벤트가 `written` 커밋보다 먼저 처리되면 `sending → provider_observed` 로 바로 가고, 늦은 `written` 커밋은 조건에서 떨어진다.
- 복구: `queued` 는 그대로 남아도 된다(효과 없음 보장). **`sending`·`written` 인데 관측이 없는 것은 전부 `unknown`** 이다. `sending` 을 `queued` 로 되돌리지 않는다. 승인 카드는 `decided` 를 유지하고 "결정 기록됨 · 전달 불명"으로 보인다. 같은 요청에 다시 답할 수 없다.
- **unknown 은 자동 재전송하지 않고, 같은 incarnation 에서는 다시 보내기도 막는다.** 원본이 provider 안에 남아 늦게 실행될 수 있기 때문이다.
  - incarnation 이 살아 있으면 세션은 `attribution_uncertain` 상태가 되어 새 prompt 를 막는다. 사람의 선택지: "기다리기"(관측이 오면 해제) 또는 "세션 끝내고 이어서 시작"(종료 확인 → resume).
  - incarnation 이 끝난 뒤(대화 실행 종료 확인, §3.4)에만 "다시 보내기"가 열린다. 새 incarnation 에서 새 request_key 로 보내며, 화면에 "원본이 실행됐을 수 있음 — 대화 기록을 먼저 확인"을 보인다.

kind 별 관측 증거 — **상관 ID 로 특정되는 증거만 인정**한다:

| kind | provider_observed | completed |
|---|---|---|
| prompt | 그 message uuid 로 특정되는 수신 신호. 후보: 출력의 같은 uuid 사용자 메시지, 또는 "idle 상태에서 이 prompt 하나만 쓴 뒤 시작된 턴"(§5-2 의 1:1 규칙). **S1-0 에서 어느 신호가 실제로 나오는지 확정** | 그 턴의 `result`. 1:1 규칙이 성립할 때만 귀속 |
| tool_decision | 같은 `tool_use_id` 의 `tool_result` 이고 **그 결과가 이번 결정에서 나왔다고 구별될 때만**: 거부 → 결과에 거부 메시지에 넣은 요청 nonce 가 보임. 허용 → 결과가 인터럽트·취소 결과가 아님(구별 신호는 S1-0 에서 확정). **구별 못 하면 전달은 unknown, 도구 종료는 따로 "도구 끝남"으로 표시** | 별도 단계 없음 — observed 가 "결정이 전달됨"이다 |
| question_answer | 같은 `tool_use_id`(AskUserQuestion)의 `tool_result` 에 보낸 답이 보임 | 같음 |
| interrupt | 영수증 수신(`interrupt_receipt_v1`) | 대상 턴 세대(`turn_gen`)의 `result` 관측 |

상관 ID 로 특정할 수 없으면 `written` 에 머물고, 실행이 끝나면 `unknown` 이 된다. 다른 도구의 결과·다른 턴의 결과로 올리지 않는다. 호스트는 prompt 를 하나 쓸 때마다 `turn_gen` 을 1 올리고, 모든 턴 귀속은 이 값으로 한다.

### 4.4 멱등

- **request_key 는 제출 한 번마다** 클라이언트가 만든다. 첫 전송 전에 브라우저 저장소에 보존하고, 응답을 못 받은 재시도·새로고침·재접속은 같은 키를 다시 쓴다. 응답(최종 상태 포함)을 받으면 지운다.
- 서버·호스트는 `request_key` 에 **fingerprint**(session_id, incarnation_id, kind, target_tool_use_id, body 해시)를 묶는다. 같은 키·같은 fingerprint → 기존 행을 돌려준다. **같은 키·다른 fingerprint → 409 충돌로 거부.**
- 같은 승인 요청에는 키와 무관하게 **한 번만** 답할 수 있다(`tool_requests` 의 `pending → decided` 조건부 전이). 두 탭이 서로 다른 키로 답하면 늦은 쪽은 rejected.
- **재시도 유효기간 24시간 — 호스트 시계 기준**: request_key 에 클라이언트 생성 시각 `t` 를 넣는다. 호스트는 새 키를 `host_now − 24h ≤ t ≤ host_now + 5분` 일 때만 받고, 첫 접수 시각을 durable 기록한다. 범위 밖이면 실행하지 않는다(`expired`, 미래 시각은 `rejected`). 이렇게 하면 접수된 키의 `t` 는 접수 시각 + 5분을 넘지 못하므로, 30일 뒤(tombstone 만료 뒤) 같은 키가 다시 와도 `t < host_now − 24h` 라 실행되지 않는다. 기존 행·tombstone 이 있으면 그 결과를 돌려준다.
- 처리 순서: ① request_key 조회(행·tombstone 이 있으면 그 결과 반환) ② 유효기간 ③ 대상 세션 유효성(삭제된 세션은 영구 거부) ④ 재검증(§4.5).

### 4.5 직렬화와 재검증

- 호스트는 incarnation 마다 **명령 큐 하나**로 모든 상태 전이와 외부 효과를 순서대로 처리한다: prompt, 승인·질문 응답, 인터럽트, close, SDK `signal` abort, 자식 exit.
- 재검증은 그 큐 안에서, `sending` 커밋과 **같은 트랜잭션**의 조건부 갱신으로 한다: 대상 incarnation 이 alive 이고 제어 가능, tool_decision·question_answer 는 대상 요청이 `pending`, prompt 는 세션이 idle(§5-2), 인증 재확인(§1.2-3) 통과. 하나라도 아니면 `rejected` + 이유.
- **선형화 지점**: 외부 효과를 내는 명령은 큐 안에서 ① 조건부 `sending` 커밋 ② **같은 동기 구간에서** SDK 측 사실을 마지막으로 확인(승인이면 `canUseTool` 의 `signal.aborted`, 공통으로 incarnation 세대·자식 exit 여부) ③ 효과 호출, 순서로 한다. ②에서 걸리면 `sending → rejected` 로 되돌리지 않고 `cancelled`(효과 없음 확정)로 닫는다 — ①~③ 은 await 없이 한 동기 구간에서 실행되므로(better-sqlite3 는 동기 API) ②에서 걸리면 효과가 나가지 않았음이 보장된다.
- SDK `signal` 의 abort 와 자식 exit 는 리스너가 즉시 조건부 갱신한다(큐 밖). **abort 가 무효로 만드는 것은 아직 효과가 나가지 않은 것뿐이다**: tool_request 가 `pending`, 또는 `decided` 이고 그 delivery 가 `queued` 일 때만 → `cancelled`. delivery 가 `sending`·`written` 이후면 전달 상태는 그대로 두고(관측이 오면 observed, 아니면 unknown), "결정 뒤 도구 취소됨"을 별도 사실로 기록한다. 자식 exit 는 incarnation 을 exited 로 표시한다. 정리는 큐로 보낸다. 큐는 provider 의 비동기 완료를 기다리며 점유되지 않는다 — 완료는 이벤트로 다시 큐에 들어온다.
- 따라서 "검사 통과 → 인터럽트로 카드 취소 → 앞선 allow 가 resolve" 는 생길 수 없다: 인터럽트가 먼저 처리되면 요청은 `cancelled` 라 결정의 조건부 갱신이 떨어지고, SDK 가 먼저 abort 했으면 ②에서 걸린다.

### 4.6 보존·삭제·살균 (§0.2.12 §8-4)

- 원문은 사용자가 지울 때까지 보존한다. 화면은 접어 보이되 원문은 자르지 않는다.
- **삭제는 active 가 아닌 세션만**(closed·handed_off). 진행 중 세션은 먼저 끝내야 한다 → 늦은 이벤트 재유입이 없다.
- 순서: ① 세션 state=`deleting` 커밋(이후 모든 mutation·재생 거부, 화면 "삭제 중") ② 아래 표대로 삭제 ③ WAL checkpoint(TRUNCATE)와 VACUUM ④ state=`deleted`. 호스트는 재기동할 때마다 `deleting` 세션의 ②~④ 를 처음부터 다시 실행한다(멱등). ④ 전에는 "삭제 완료"를 보이지 않는다.

| 데이터 | 처리 |
|---|---|
| events 원문, deliveries 본문·reason, tool_requests 입력·decision 내용 | 삭제 |
| 세션 제목·cwd, incarnations 의 account_snapshot·cli_path | 삭제 |
| 세션 id, incarnation id, 상태 | 남김(`deleted` 표시, 재사용 금지) |
| request_tombstones | 남김 30일(키·fingerprint 해시·원래 최종 state·삭제 여부) — 삭제 직후 같은 키 재시도는 기존 결과(삭제됨)를 받고 재실행되지 않는다 |
| 호스트·서버 로그 | 처음부터 본문·도구 입력·account 정보를 쓰지 않는다(오류 로그 포함) |
| CLI transcript `~/.claude/projects/...` | 사용자 파일 — 지우지 않고 삭제 확인 화면에 경로를 적는다 |

- 구분: "Palantir 가 자격 파일을 읽지 않는다"(§1.2-2)와 "대화 안에 사용자가 붙여 넣은 비밀을 저장하지 않는다"는 다르다. SH1 은 앞의 것만 보장한다. 대화 원문은 사용자 입력 그대로 보존된다.
- CLI 가 쓴 transcript(`~/.claude/projects/...`)는 사용자 파일이라 지우지 않고, 삭제 확인 화면에 그 경로를 적는다.
- C1 비서는 소유 세션 원문을 조회 대상에 넣지 않는다(SH1 기본, SH5 에서 재판정).

## 5. 흐름별 계약

1. **시작**: 사람이 cwd 를 고른다(로컬 노드 DirectoryPicker). `claude -p` 계열은 workspace trust 대화상자를 건너뛰고 프로젝트 hooks·MCP 를 실행한다(headless 문서) → 시작 화면에 "이 폴더의 `.claude/settings.json` hooks·`.mcp.json` 이 실행됨"을 보이고 사람이 확인해야 시작한다. `settingSources` 는 user/project/local 전부. `permissionMode: 'default'`. `bypassPermissions`·`allowDangerouslySkipPermissions` 는 **코드 경로에 두지 않는다**(테스트로 고정). 예약 → spawn → `startup()` → 인증 게이트(§1.2-3) → idle.
2. **지시 — 한 번에 하나**: 세션이 idle(직전 턴의 result 관측, 미완료 prompt 없음)일 때만 prompt 를 쓴다. 턴 진행 중에는 입력창이 "중단하고 보내기" 또는 "턴 끝나면 보내기(Palantir 대기열)"만 제공한다. Palantir 대기열의 항목은 `queued` 로 남고, idle 이 되면 사람이 아니라 큐가 순서대로 보내되 재검증을 다시 거친다. 이 규칙으로 prompt 와 턴이 1:1 로 묶인다.
3. **도구 승인**: `canUseTool` → `tool_requests(pending)` 커밋 → 화면 카드(도구명, 입력 전문, cwd, 요청 시각) → 사람의 허용/거부(사유 입력 가능) → 큐에서 조건부 `pending → decided` + delivery(tool_decision) `sending` → 선형화 확인(§4.5) → resolve → `written` → §4.3 의 구별 신호가 있는 tool_result 일 때만 observed. abort 처리는 §4.5 를 따른다(효과 전이면 cancelled·카드 비활성, 효과 뒤면 전달 상태 유지 + "결정 뒤 도구 취소됨").
4. **질문**: `AskUserQuestion` → 선택지 카드 + 직접 입력 → delivery(question_answer), 재검증·관측 규칙은 3과 같다.
5. **인터럽트**: SH1 은 `interrupt_receipt_v1` 을 광고하는 CLI 만 지원한다(§2.3 버전쌍). 버튼 → delivery(interrupt) → `interrupt()` → 영수증.
   - pending 승인 카드는 `cancelled`.
   - 1:1 규칙상 `still_queued` 는 비어야 한다. 비어 있지 않으면(규칙이 깨진 비정상) 그 uuid 들의 delivery 를 `provider_observed`("중단 뒤 실행 예정")로 올리고, 세션을 `attribution_uncertain` 으로 바꾼다: 새 prompt·Palantir 대기열 배출을 막고, 그 뒤 나오는 턴 결과는 특정 메시지에 귀속하지 않고 "귀속 불명 결과"로 표시한다. **이 incarnation 안에서는 해제하지 않는다** — survivor 가 언제 소비·종결됐는지 증명할 신호가 없고, 사람 확인은 증거를 대신하지 못한다. 사람의 선택지는 "세션 끝내고 이어서 시작"(대화 실행 종료 확인 → 새 incarnation 으로 resume)뿐이다. 1:1 규칙을 지키면 이 상태는 생기지 않아야 하므로, 생기면 결함으로 기록한다.
   - 영수증 미수신·타임아웃 → interrupt `unknown`, 세션 "중단 여부 불명". 대상 `turn_gen` 의 result 를 관측하면 해제한다. 관측이 없으면 사람의 선택지는 "기다리기"와 "세션 끝내고 이어서 시작"(대화 실행 종료 확인 → resume)뿐이다.
   - interrupt 는 쓸 당시의 `turn_gen` 에 묶인다. completed 는 그 세대의 result 관측뿐이다(이전 턴 result 로 완료되지 않는다).
   - 진행 중인 interrupt 가 있으면 추가 버튼은 같은 요청을 돌려준다.
   - "중단하고 보내기" = interrupt completed **그리고** 세션 idle·`attribution_uncertain` 아님일 때만 prompt 를 보낸다.
6. **서버 재시작**: 호스트·자식 유지. 서버가 뜨면 handshake → snapshot(seq_high) → 이어 받기 → 화면 "재연결됨". 서버가 없는 동안 생긴 승인 요청은 pending 으로 남아 있다. 서버가 응답을 못 받은 제출은 같은 request_key 재시도로 결과를 받는다.
7. **호스트 상실**(크래시·머신 재부팅): 재기동 시 §3.3 복구. 이전 실행이 죽었으면 `end_reason=host_lost`, pending 승인 `expired`, 관측 없는 sending·written `unknown`. 살아 있으면 `orphaned`(§3.4). 화면의 "이어서 시작"은 **resume**(새 incarnation 이 이력을 이어받음)이며 재연결과 다른 문구로 보인다(§0.2.7). 버튼은 이전 실행의 대화 실행 종료 확인 **그리고** §3.4 하위 프로세스 확인 통과 전에는 비활성이다.
8. **터미널로 넘기기(한 방향)**: interrupt → close → **대화 실행 종료 확인 + 하위 프로세스 확인 통과**(§3.4) → 세션 `handed_off` → 복사할 명령 표시. 명령은 호스트 실행과 같은 실행 파일·설정·인증 환경을 재현한다:
   `cd <cwd> && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_PROFILE -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY [-u CLAUDE_CONFIG_DIR] HOME=<호스트가 쓴 HOME> [CLAUDE_CONFIG_DIR=<값>] <동봉 실행 파일 절대 경로> --resume <session_id>`
   `env` 는 모든 `-u` 옵션이 `name=value` 보다 앞에 와야 한다(macOS `env(1)`). `CLAUDE_CONFIG_DIR` 은 둘 중 하나만 나온다. 모든 값은 shell-quote 한다. 설정 디렉터리가 없었다는 사실도 `-u CLAUDE_CONFIG_DIR` 로 재현한다. **넘긴 뒤의 보장 범위**: Palantir 는 그 실행을 제어·관측하지 않고 인증 게이트도 없다. 사용자가 명령을 바꿔 실행하면 위 재현은 깨진다 — 화면에 그대로 적는다. 종료 확인이 안 되면 넘기지 않는다(§0.2.4). 넘긴 세션은 Palantir 에서 읽기 전용이고 다시 열지 않는다. Palantir 에서 다시 작업하려면 새 세션을 연다.
9. **종료**: "세션 끝내기" → close → 종료 확인 → `end_reason=user_stop`. 확인이 안 되면 "종료 확인 안 됨"으로 남는다.

## 6. 화면 (사용성 1급 — codex 위임 불가)

lock-in 은 사용자가 실제 작업에 써 본 뒤 정한다. brief 는 화면이 **반드시 보여야 할 상태**만 고정한다.

- 소유 세션("내가 띄운 세션")과 C1 비서 채팅을 같은 앱 안에서 구분한다. 외부 세션은 관측 전용 배지.
- 세션 머리: 호스트 연결 · 실행 생존 · 제어 가능 여부 · 상호작용(running/awaiting_permission/awaiting_user/idle/unknown) · cwd · CLI 버전 · 인증 수단과 청구 재원(§1.2) · 능력 배지 5종.
- 메시지마다 전달 상태(queued/sending/written/observed/completed/unknown/rejected). unknown 은 눈에 띄게, 다시 보내기는 사람 버튼으로만.
- 승인 카드: 도구명·입력 전문(접기 가능, 자르지 않음)·허용/거부·거부 사유.
- 재연결과 resume 을 다른 문구로. 턴당 추정 비용. 넘긴 세션은 읽기 전용 표시.

## 7. 보안

- 자식 env: 고정 허용 목록(PATH·HOME·LANG·LC_*·TERM·USER·SHELL·TMPDIR, 호스트 env 에 있으면 `CLAUDE_CONFIG_DIR`) + §3.3 표지. SH1 은 사용자 추가 env 를 받지 않는다. spawn 직전 최종 env 를 검사한다: ① 표지 `PALANTIR_OWNED_INCARNATION` 이 정확히 하나이고 값이 이번 예약 id ② 그 밖의 `PALANTIR_` 로 시작하는 이름이 하나도 없음(`PALANTIR_TOKEN`·`PALANTIR_PM_TOKEN` 등) ③ 호스트 capability 값이 어떤 변수 값에도 없음 ④ §1.2-3 인증 변수 없음. 하나라도 어기면 spawn 하지 않는다. 표지는 비밀이 아니고, 금지 대상은 credential 이다.
- 서버 라우트: 시작·지시·승인·질문 응답·인터럽트·종료·넘기기·삭제 전부 **cookie(사람) 전용**, bearer(PM 토큰 등) 거부. origin 검사는 `server/routes/sessionHubChat.js` 의 엄격한 mutation origin 검사를 쓴다. `server/utils/sameOrigin.js` 의 same-host 검사(Origin 누락 허용)는 쓰지 않는다.
- 호스트 API 는 소켓 capability 로만.
- 승인 카드의 도구 입력·대화 원문은 신뢰하지 않는 텍스트로 렌더한다(기존 markdown 살균 경로).

## 8. 수락 기준

### 8.1 자동 검증 — 세 층을 나눈다 (실제 LLM 호출 0)

- **(a) 상태 기계**: 가짜 어댑터로 §4 전 계약. 결함 주입 지점을 호스트에 둔다 — `sending` 커밋 직후, 효과 직후·`written` 커밋 전, spawn 직후·신원 커밋 전, 승인 `decided` 커밋 직후, 삭제 `deleting` 커밋 직후, `accepted` 응답 직전. 각 지점에서 호스트를 죽이고 재기동해 복구 규칙(§4.3·§3.3)을 확인한다.
- **(b) 실제 SDK + 가짜 실행 파일**: 고정한 SDK 버전이 말하는 제어 프로토콜을 흉내 내는 가짜 `claude` 를 `server/tests/fixtures/bin/` 패턴으로 둔다(테스트 전용, 제품 경로 아님). 승인 콜백·인터럽트 영수증·custom spawn·자식 exit·표지 상속을 SDK 를 통해 검증한다. 가짜는 **메시지를 버리거나·합치거나·늦게 내는 모드**를 가져야 한다 — 늘 정확히 한 번 응답하는 가짜만으로는 unknown 경로를 증명하지 못한다.
- **(c) 실제 CLI**: S1-0 과 §8.2.

필수 사례(각각 역회귀로 테스트가 실제로 막는지 확인):
- 같은 키 동시 2요청 → 행 1개, 효과 1회. 같은 키·다른 본문 → 409.
- 같은 승인에 두 탭이 다른 키로 답함 → 하나만 decided, 효과 1회.
- 승인과 인터럽트 동시 → 인터럽트가 먼저 처리되면 결정은 rejected, resolve 0회.
- 크래시 지점 4곳 → `sending`/`written` 은 unknown, 자동 재전송 0. spawn 직후 크래시 → 표지로 찾거나 liveness_unknown, 새 실행 0.
- 동시 호스트 기동 2개 → 하나만 생존, 소켓 교체 없음.
- 서버 SIGTERM·SIGKILL·터미널 닫기 → 호스트·자식 생존, 재연결 후 pending 카드 유지, 결정 1회 전달.
- 호스트 소켓만 고장 → 화면 "호스트 응답 없음 — HH:MM 기준, 현재 상태 불명", 모든 조작 비활성, 현재 상태처럼 보이지 않음(§4.1).
- DB 쓰기 실패 → 새 전송·실행 거부.
- 인증 게이트: 가짜 account 가 API 키·bearer·cloud provider 를 보고하면 첫 지시 전에 닫힘. 전송 직전 재확인 실패 → rejected.
- 자식 env 에 `PALANTIR_TOKEN`·capability·§1.2-3 변수 없음. `bypassPermissions` 를 넘기는 코드 경로 없음.
- origin: 다른 origin·Origin 누락·bearer 로 mutation → 거부.
- 삭제: active 세션 삭제 거부. 삭제 뒤 같은 키 재시도 → 재실행 0.
- alive 신원·표지 조회 실패(명령 실패·부분 결과·권한 오류 각각) → liveness_unknown, resume·넘기기 0회.
- `still_queued` 비어 있지 않음 → 새 prompt·대기열 배출 0, 결과 귀속 0.
- unknown 원본이 늦게 실행됨(가짜가 지연 소비) → 같은 incarnation 재전송 0, 그 결과를 다른 메시지에 귀속 0.
- `decided`·`sending` 커밋 직후 크래시 → 카드 "결정 기록됨·전달 불명", 재답변 0.
- 관측 이벤트가 `written` 커밋보다 먼저 → 상태 역행 0.
- `signal` abort 와 결정이 같은 틱 → resolve 0.
- snapshot 과 구독 사이 이벤트 삽입 → 누락 0.
- 24시간 지난 키 → 실행 0. tombstone 만료 뒤 오래된 키 → 실행 0.
- 잠금 FD 가 자식에 상속되지 않음. 유휴 종료 중 도착 요청 → `not_accepted` 후 재시도 성공, 중복 0.
- 인증: account 조회 실패·모르는 값 → 시작·전송 0.
- abort 가 효과 뒤에 옴(`written` 뒤 인터럽트) → 전달 상태 유지, "결정 뒤 도구 취소됨" 기록, `cancelled` 로 덮어쓰기 0.
- `attribution_uncertain` → 사람 확인으로 해제 0, 새 prompt 0, 종료 확인 → resume 경로만 성공.
- 표지 남은 하위 프로세스 / 하위 조회 `query_failed` → 사람 확인 유무와 무관하게 resume·넘기기 0.
- 최종 env 검사: 표지 1개·다른 `PALANTIR_*` 0 → spawn 성공. `PALANTIR_TOKEN` 섞임 → spawn 0.
- 넘기기 명령: 생성한 문자열을 셸로 파싱한 **argv 순서**를 검증(`-u` 전부가 `name=value` 앞), 인증 변수 `-u` 전부, `CLAUDE_CONFIG_DIR` 있음/없음 각각 재현, 공백·따옴표 든 cwd 의 shell-quote. 가짜 실행 파일로 실제 실행해 받은 env 를 확인.
- request_key 시각: 미래 6분 → rejected, 25시간 전 → expired, 접수 30일 뒤(tombstone 만료 뒤) 재시도 → 실행 0.
- `accepted` 응답 직전 크래시 → 서버 "접수 미확인" → 같은 키 재시도로 기존 결과, 효과 1회.
- `deleting` 직후 크래시 → 재기동 시 삭제 재개, `deleted` 전에는 "삭제 완료" 표시 0.

**정상 경로 최소 성공 기준**: 결함을 주입하지 않은 실행에서는 지시·승인·거부·질문 응답이 **전부** observed(또는 completed)에 도달해야 한다. unknown 은 결함 주입 사례에서만 허용한다 — 모든 것을 unknown 으로 남기는 구현은 수락되지 않는다. (b)·(c) 에서 정상 지시 20회·승인 10회 중 unknown 이 하나라도 나오면 실패다(S1-0 에서 관측 신호가 없다고 확정된 kind 는 v5 에서 기준을 다시 정한다).

**"효과 1회"의 정의**: 호스트의 SDK 호출 횟수가 아니라 **provider 쪽 효과**로 센다. (b) 에서는 가짜 실행 파일이 자기 로그에 기록한 수신·도구 실행 횟수, (c) 에서는 독립된 도구 효과(예: 지시마다 파일에 한 줄 추가하게 하고 줄 수를 센다).

### 8.2 실제 CLI — 두 번에 나눈다

- **최소 안전 실측**(S1-e, 사용자 실사용 전): 개발자가 실제 CLI 로 각 장애를 한 번 이상 일으킨다 — 서버 재시작(승인 대기 중 포함), 호스트 강제 종료(턴 진행 중), 인터럽트, 탭 2개 동시 입력, 넘기기. 판정은 호스트 기록과 **독립 증거**를 대조한다: 무해한 카운터 파일(지시·승인된 도구마다 한 줄), CLI transcript 의 사용자 메시지 수·uuid, 화면 기록. transcript 는 안정 계약이 아니라 대조 보조다(§0.2.1-3). 필요한 관측을 얻지 못한 항목은 unknown·unsupported 로 남았는지를 확인한다.
- **U8 데스크톱**(S1-d 실사용 중, 사용자 기록지): 지시 30회 이상(새로고침·탭 2개 각 3회 포함), 승인·거부 각 5회 이상, 인터럽트 3회, 서버 재시작 3회(1회는 승인 대기 중), 호스트 강제 종료 1회, 넘기기 1회. 판정: 오입력(다른 세션·incarnation 으로 간 입력) 0, 중복 전송 0, 결과를 모르는 경우는 전부 unknown, 인증 표시 정상. 각 항목을 독립 증거와 대조한다.

## 9. 단계

| 단계 | 내용 | 증거 |
|---|---|---|
| **S1-pre** | §1.4 판정 → 승인 시 부팅 자격 저장·사용량 토큰 조회 기본 꺼짐 + argv 노출 수정 | 사용자 판정 기록, 테스트 |
| **S1-0 스파이크** | 실제 SDK+동봉 CLI 로 확인: ① prompt 수신 신호(uuid echo 여부, 1:1 규칙 성립) ② 동봉 실행 파일의 키체인 로그인 사용 ③ `account`·`tokenSource`·`apiKeySource` 실제 값(구독·API 키·bearer 각각) ④ custom spawn 에서 pid·시작시각 확보, macOS 표지 조회 ⑤ 호스트 종료 시 자식 동작(stdin 닫힘·SIGTERM·진행 중 Bash·백그라운드 작업) ⑥ `canUseTool` 장시간 대기 ⑦ 인터럽트 영수증 ⑧ resume 뒤 사용자 설치 `claude --resume` 호환. 소량 LLM 호출(사용자 승인 후) | 관측 기록 문서 + **brief v5**(§1.2-3·§2.3·§3.3·§4.3 의 "S1-0 확정" 칸을 채움) → codex 재검토 → 사용자 승인 |
| **S1-a** | 호스트 프로세스(잠금·handshake·유휴 종료) + 저장소 + 상태 기계 + 결함 주입, 가짜 어댑터 | §8.1-(a) |
| **S1-b** | SDK 어댑터(custom spawn·신원·버전쌍 확인·env 허용 목록·인증 게이트·능력 판정) | §8.1-(b) |
| **S1-c** | 서버 브리지(handshake·seq 재생·읽기 전용 장애 경로·cookie-only·origin) + 최소 화면(상태·전달 배지·승인 카드) | 서버 재시작·장애 사례 |
| **S1-e** | 터미널 넘기기 + §8.2 최소 안전 실측 | 실측 기록. 미달이면 S1-d 진입 안 함 |
| **S1-d** | 화면 다듬기 → 사용자 실사용(U8 기록지 병행) → lock-in. lock-in 뒤 e2e visual baseline | 사용자 lock-in 기록 + U8 |

각 구현 단계: codex-goal 위임 → 호스트 외부 검증(RED→GREEN·역회귀) → codex 적대리뷰 반복 → merge. S1-d 화면 lock-in 은 위임하지 않는다.

## 10. 리스크와 열린 질문

- **R1 정책 변동**: 구독 관련 정책이 2026-04 에 실제로 바뀌었고 5월 발표·6월 보류가 있었다. 대응: §1.2-3 게이트(구독 아니면 시작 안 함), §1.3 재검토·중단 조건, 버전 고정.
- **R2 SDK 비공개 라이선스**: 개인 설치만. 재배포·vendoring 은 Anthropic 약관 확인 전 금지.
- **R3 같은 UID**: 작업 세션은 호스트 DB·capability 파일을 읽을 수 있다(§0.2.7). 격리를 주장하지 않는다.
- **R4 표지 조회 의존**: §3.3 복구 중 spawn 직후 크래시 처리는 macOS 에서 같은 UID 프로세스의 env 를 읽을 수 있다는 전제에 선다. 안 되면 기본값은 그 경우 항상 liveness_unknown(사람 판정)이고, 대안(자식 argv 표지, 별도 감시 프로세스)은 v5 에서 정한다. pid·시작시각 신원 판정은 표지와 무관하게 동작한다.
- **R6 과금 잔여 위험 (사용자 판정)**: ① 한 턴 안의 인증 전환은 감지하지 못할 수 있다(§1.2-3). ② 구독 한도 소진 뒤 계정에서 켠 유료 사용 크레딧으로 이어질 수 있고 Palantir 는 이를 구별하지 못한다(§1.2 표시). SH1 착수 전에 사용자가 이 두 가지를 받아들이는지, 계정 설정(유료 사용 크레딧 끔/월 상한)을 어떻게 둘지 정한다.
- **R5 1:1 규칙의 사용성**: 진행 중 턴 합류를 막는 것이 실사용에서 불편할 수 있다. S1-d 에서 사용자 판정으로 다시 본다(합류를 열려면 uuid 단위 수신 증거가 먼저 있어야 한다).
- **Q1 호스트 자동 기동**: 서버가 setsid 로 띄우는 안(권장) vs launchd 등록. 후자는 SH4 원격·로그인 시 상시 기동과 맞지만 설치 단계가 늘어난다.

## 11. 검토 이력

- v1 (2026-10-23): 초안. §0.2.9 선행 확인 결과 포함.
- codex **R1**: **NO-GO** (BLOCKER 3 / SERIOUS 14 / MODERATE 2). 반영:
  - BLOCKER — 터미널 되찾기를 SH1 밖으로(§0·§5-8), 전송·저장 사이 크래시 구간에 `sending` 선기록 + 복구 규칙(§4.3), 자식 생성·신원 기록 사이 구간에 예약·custom spawn·표지·liveness_unknown(§3.3).
  - SERIOUS·MODERATE — prompt·턴 1:1 규칙(§5-2), tool_use_id 로만 관측 인정(§4.3), 제출별 키 + fingerprint 충돌(§4.4), incarnation 명령 큐 + 조건부 전이(§4.5), 인터럽트 영수증 전체 처리(§5-5), 호스트 상실·실행 생존·제어 가능 분리(§3.4), 잠금 평생 보유·handshake·유휴 종료 순서(§3.1), 인증 순위 전체 제거 + 첫 지시 전 게이트 + 전송 직전 재확인(§1.2-3), 기존 자격 경로를 수락 선행 조건으로(§1.4·S1-pre), 허용 판정을 개인 구성으로 한정 + 시행·발표 구분 + 중단 조건(§1.1·§1.3), 동봉 실행 파일·해시 고정(§2.3), 대체 경로를 후보로 강등 + 증거 수준(§2.1·§2.4), 읽기 전용 장애 경로·seq 재생·fail-closed(§4.1), 삭제 tombstone·active 삭제 금지·WAL 처리(§4.6), origin 검사 지정(§7), 검증 세 층·결함 주입·가짜의 이상 모드·안전 실측을 실사용 앞으로(§8·§9).
- codex **R2**: **NO-GO** (R1 19건 중 닫힘 6 / 부분 13, 새·잔여 BLOCKER 2 / SERIOUS 11 / MODERATE 2). 반영(v3):
  - BLOCKER — 신원 조회 세 값(`query_failed` 는 절대 사망 아님, §3.3), `still_queued` 비정상 시 `attribution_uncertain` 으로 입력 차단·귀속 중지 + interrupt 를 `turn_gen` 에 묶음(§4.3·§5-5).
  - SERIOUS·MODERATE — 종료 확인을 "대화 실행 종료(보장)"와 "하위 프로세스 정리(최선 노력)"로 분리(§3.4), unknown 은 같은 incarnation 재전송 금지(§4.3), 결정 확정과 전달 분리 + 단조 전이(§4.2·§4.3), 결정 관측은 nonce·구별 신호 있을 때만(§4.3), 선형화 지점과 abort 리스너(§4.5), 인증 게이트 보장 범위를 낮추고 잔여 위험을 사용자 판정으로(§1.2-3·R6), 유료 사용 크레딧 재원 추가·무과금 미보장(§1.2), 잠금 FD 비상속·접수 응답 규칙·유휴 종료 순서(§3.1), 넘기기를 동봉 실행 파일 절대 경로 + `CLAUDE_CONFIG_DIR` + shell-quote 로(§2.3·§5-8), 재시도 유효기간 24시간·처리 순서·삭제 세션 영구 거부(§4.4), 서버의 호스트 DB 직접 읽기 폐기 + 한 read transaction snapshot(§4.1), 삭제 필드 표·삭제 상태 선기록·env 고정 목록(§4.6·§7), 반례 테스트·"효과 1회" 정의·카운터 파일 대조(§8).
- codex **R3**: **NO-GO** (R2 15건 중 닫힘 7 / 부분 8, BLOCKER 0 / SERIOUS 6 / MODERATE 3). 반영(v4) — 사람 확인으로 우회하던 경로를 없애고 "종료 확인 → resume" 한 길로 줄였다:
  - SERIOUS — abort 는 효과 전 요청만 무효화, 효과 뒤면 전달 상태 유지 + "결정 뒤 도구 취소됨"(§4.5·§5-3), `attribution_uncertain`·interrupt 불명은 incarnation 안에서 해제 안 함(§5-5), 표지 남은 하위·조회 실패면 resume·넘기기 차단(§3.4), 최종 env 검사를 표지 1개·다른 `PALANTIR_*` 0 으로(§7), 넘기기 명령이 인증 변수 제거·HOME·`CLAUDE_CONFIG_DIR` 유무까지 재현 + 넘긴 뒤 보장 범위 명시(§5-8), request_key 유효기간을 호스트 시계 기준 `[now−24h, now+5분]` 으로(§4.4).
  - MODERATE — accepted 는 durable 기록 뒤에만, 무응답은 "접수 미확인"(§3.1), 삭제 `deleting` 상태와 재기동 재개(§4.6), 정상 경로 최소 성공 기준·새 반례·소켓 장애 사례 정정·v 번호 정리(§8·§9).
- codex **R4**: **GO** (R3 9건 중 닫힘 8 / 부분 1, SERIOUS 0). MODERATE 2 / MINOR 1 반영: 넘기기 명령의 `env` 옵션 순서(`-u` 먼저) + argv 순서 검증(§5-8·§8.1), 사람 확인 우회 문구가 남은 수락 기준 삭제(§8.1), 호스트 상실 resume 버튼 조건을 §3.4 와 통일(§5-7). 이 GO 는 설계 단계 판정이며 구현·실사용 수락이 아니다.
