# SH1 S1-e2 최소 안전 실측 기록 (2026-10-26)

`docs/specs/sh1-session-host-brief.md` §8.2 "최소 안전 실측"을 실제 CLI 로 수행한 기록이다. S1-a~S1-e1 이 merge 된 main(`4d32b30`) 기준. 관측은 이 환경·버전에 한정된다.

## 환경과 방법

| 항목 | 값 |
|---|---|
| 머신 | macOS (Darwin 25.5.0), arm64, Node v22.22.2 |
| SDK·CLI | `@anthropic-ai/claude-agent-sdk@0.3.308`, 동봉 CLI 2.1.308(해시 `ca923c86…` 일치) |
| 인증 | 사용자 구독 로그인(키체인). 인증 env 없음, `CLAUDE_CONFIG_DIR` 없음 |
| 사용자 설정 | `~/.claude/settings.json` 의 hooks 13종(PermissionRequest 포함), `env` 비어 있음, `apiKeyHelper` 없음 — 터미널 claude 와 같은 조건 그대로 |
| 호스트 | 실제 `server/sessionHost/main.js`(실제 SDK 어댑터 + 실제 `ps` 신원 조회), 런타임 디렉터리는 소켓 경로 길이 때문에 `$TMPDIR` 아래 |
| 서버 | 실제 `ownedSessionService` + `routes/ownedSessions.js` 만 띄운 별도 프로세스(`docs/sh1-s1-e2-measure/bridge.cjs`, cookie 인증만 대체). 전체 Palantir 서버를 하나 더 띄우면 부팅 복구가 사용자의 실제 tmux 워커를 건드릴 수 있어(메모리 기록) 쓰지 않았다 |
| 작업 폴더 | 저장소 밖 임시 폴더(공백 든 이름 `work dir`) |
| 독립 증거 | ① 카운터 파일(도구가 실행될 때마다 한 줄) ② CLI 자신의 대화 원문 `~/.claude/projects/<cwd>/<session>.jsonl` 의 사용자 지시 수 ③ 호스트 기록(snapshot) |
| 스크립트 | `docs/sh1-s1-e2-measure/`(p1~p5, tui.py). 저장소 밖으로 복사해 경로를 맞춘 뒤 실행 |

LLM 호출은 기본 모델의 짧은 턴 약 35회.

## 결과 요약

| # | 항목(§8.2) | 결과 | 독립 증거 |
|---|---|---|---|
| 1 | 시작·게이트 | 설정 미리보기 ok(PermissionRequest 경고 표시) → 시작 → 구독 게이트 통과 4.7초 → 첫 지시 completed 2초 | — |
| 2 | **정상 경로 최소 기준**: 지시 20·승인 10 | 지시 20 전부 `completed/completed`, 승인 10 전부 `provider_observed`, **unknown 0** | 카운터 n2…n20 정확히 1회씩, CLI 원문 지시 21(1+20) |
| 3 | 서버 재시작 — SIGTERM(승인 대기 중) | 재시작 뒤 카드 `pending` 유지, 결정 1회 → observed, 지시 completed | 카운터 1줄 |
| 4 | 서버 재시작 — SIGKILL(승인 대기 중) | 같음 | 카운터 1줄 |
| 5 | 탭 2개 — 같은 카드에 다른 키로 허용·거부 | 하나만 `written`, 다른 하나 `rejected(tool_not_pending)`, 효과 1회 | 카운터 1줄 |
| 6 | 탭 2개 — idle 에서 동시 지시 | 둘 다 접수(queued) → 서로 다른 턴(25·26)으로 순서대로 실행, 합쳐진 턴 0, `attribution_uncertain` 0 | CLI 원문 지시 +2 |
| 7 | 인터럽트(허용된 `python3 time.sleep(40)` 실행 중) | 지시 `provider_observed/interrupted`, 인터럽트 `completed`, 도구 결정 `unknown/tool_finished_error`(규칙대로 — 오류 결과), 장벽 0, 다음 턴 정상 | 카운터 0줄(도구 정지, 45초 뒤에도 없음) |
| 8 | 호스트 SIGKILL(허용된 도구 실행 중) | 자식은 고아로 남아 도구를 끝까지 실행 후 30초 안에 종료(S1-0 ⑤ 와 같음). 복구 뒤 incarnation `exited/host_lost`, 지시 `provider_observed/outcome_unknown`("받음·결과 불명"), 결정 `unknown/host_lost`, 다시 보내기 0 | 카운터 1줄(고아가 씀) |
| 9 | 이어서 시작(resume) | 새 incarnation 게이트 통과, 다음 지시 completed, 대화 연속("처음 답한 단어" → alpha) | CLI 원문 같은 세션 파일 |
| 10 | 터미널로 넘기기 | handoff 6초 만에 `handed_off`, 명령 생성, 넘긴 뒤 지시 rejected | — |
| 11 | 넘기기 명령 실행(비대화형 `-p` 추가) | **부모 셸에 가짜 `ANTHROPIC_API_KEY`·`CLAUDECODE`·`PALANTIR_TOKEN` 을 넣은 채** 실행 → 같은 대화로 "alpha" 응답, exit 0(가짜 키가 넘어갔다면 인증 실패) | CLI 원문 지시 +1 |
| 12 | 넘기기 명령 실행(대화형 TUI, 의사 터미널) | TUI 가 뜨고 **처음 쓰는 폴더면 "이 폴더를 신뢰하나요?" 확인**이 먼저 나온다(SDK 의 `-p` 경로는 이 확인을 건너뜀). 신뢰를 고르면 사용자 `~/.claude.json` 에 기록되므로 실측에서는 누르지 않았다 — TUI 이후 연속성은 11번(같은 실행 파일·세션)으로 갈음 | — |

판정: §8.2 최소 안전 실측의 모든 항목이 브리프 계약대로 동작했다. 정상 경로에서 unknown 0. 결함 주입(서버·호스트 강제 종료, 인터럽트)에서 생긴 unknown·outcome_unknown 은 모두 규칙상 허용된 경우이고 다시 보내기·자동 재전송은 0이다.

## 발견과 조치

1. **호스트 크래시 뒤 읽기가 호스트를 다시 띄우지 않음**(8번): 호스트가 죽은 동안 화면은 `not_running`("호스트 꺼짐")만 보였고, 복구는 다음 변경 요청(실측에서는 설정 미리보기)이 와야 일어났다. 브리프 §3.1 은 "서버가 handshake 에 실패하면 호스트를 띄운다"이다 — S1-c1 의 "읽기는 호스트를 띄우지 않는다" 판정이 이보다 좁았다. → 이 PR 에서 수정: 이전 호스트 기록(런타임 디렉터리의 호스트 DB)이 있으면 읽기도 호스트를 띄워 복구를 돌린다.
2. **넘기기 화면에 폴더 신뢰 확인 안내 없음**(12번) → 이 PR 에서 넘기기 확인창·명령 옆 문구 추가.
3. 넘긴 세션에 지시를 보내면 사유가 `incarnation_mismatch` 로 나온다(거부 자체는 맞음). 화면은 넘긴 세션의 입력을 이미 막으므로 사용자에게 보이지 않는다 — 기록만.
4. 실측 중 정리: S1-e1 라운드에서 codex 샌드박스가 띄운 `node --test` 프로세스(표지 env 를 가진 자식 포함)가 PID 1 아래 고아로 남아 있어 종료했다. 실측용 호스트는 넘기기 뒤 유휴 종료로 스스로 내려갔다(남은 표지 프로세스 0).

## S1-d 로

U8 데스크톱 실사용(사용자 기록지)과 화면 lock-in 은 S1-d 이다. S1-c2 의 "자동 후속 동작 제거"(중단하고 보내기·실행 끝내고 이어서 시작을 두 단계로) 판단도 그때 한다.
