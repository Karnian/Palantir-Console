# P5 — Claude persistent stream-json on a remote pod (brief)

> 상위 브리프 `fleet-remote-nodes-brief.md` §8:306-308 이 명시적으로 요구한 "별도 브리프".
> P5 = **Claude Operator 를 원격 pod 에서 persistent 구동** (streamJsonEngine 경로). Top 은 Pi 로컬(설계상 원격화 불필요). **크리티컬 패스 아님** — Top-on-Pi 가 주 수요를 커버.

## 왜 P4 보다 근본적으로 어려운가

| 축 | Codex Operator (P4, 완료) | Claude Operator (P5) |
|---|---|---|
| 프로세스 모델 | **per-turn** subprocess (`codex exec` / `exec resume`) — turn 마다 spawn, `stdin.end()` | **하나의 장수 프로세스** — stdin 세션 내내 열림, multi-turn |
| ssh child 수명 | 짧음 (turn 당) | 긺 (세션 전체, 분~시간) |
| executor seam | codexAdapter 에 이미 있음 (S3a) | **streamJsonEngine 에 0개** — spawn hardcoded (`:1,:193`), 팩토리에 spawnFn/executor 없음 |
| auth env | `env:{}` (pod ~/.codex) | **`env:{}` 불가** — streamJsonEngine 이 manager env 를 authoritative 취급(`:172`)해서 HOME 소실 → pod ~/.claude 못 찾음 |
| liveness | per-turn exit | **tri-state 필요** — ssh 끊김(255) ≠ Claude 자연 종료 |

## 미구현 선결조건 (P5 착수 전 확인)

1. **Operator 는 현재 Claude 가 될 수 없다** — `resolveOperatorAdapterType`(operatorSpawnService.js:84-94)가 `preferred_pm_adapter='claude'` 도 **codex 로 hard-downgrade** ("Phase 3b required for claude PM"). Claude 어댑터(streamJsonEngine)는 지금 **Top 전용**. → P5 는 "Claude Operator 활성화"(= 코드가 참조하는 Phase 3b)를 먼저 필요로 함.
2. **streamJsonEngine 은 remote 무지원** — spawn hardcoded + local `fs.existsSync(cwd)`(`:159`) + local 바이너리 resolve.

## 설계 락인

### D1. 전송 = persistent SSH duplex (relay 아님)
`remoteSshExecutor.spawnInteractive`(`:509`)가 반환하는 raw duplex ssh child 를 **세션 내내 유지**. 이 경로는 `runRemoteScript` 의 timeout/maxBuffer killer 를 우회(`:509` ≠ `:296-401`)하므로 duration cap 없음. `'claude'` 는 이미 매니저 allowlist(`managerInteractiveCommands={codex,claude}`, `:269`). → 얇은 relay 프로세스 불필요, 기존 spawnInteractive 재사용.

### D2. streamJsonEngine executor seam (S3a 미러, persistent 변형)
- `createStreamJsonEngine({runService,eventBus})` + `spawnAgent(runId,{...})` 에 `executor`/`nodePrefix` 추가. hardcoded `spawn`(`:193`)을 `executor.spawnInteractive` 로 교체. 로컬 default executor(=child_process 직접) → **byte-equivalent**.
- **12 raw-handle 접점**(spawn/stdin.write/stdout readline/stderr/on(error)/on(exit)/kill/pid — 조사1 표)을 executor 의 duplex child 뒤로 라우팅.
- **stdin 은 절대 end() 안 함** (codex 와 반대) — executor 는 duplex child 만 반환, engine 이 persistent 하게 사용. sendInput 의 sync `stdin.write`(`:501`) + 초기 프롬프트(`:301`)를 **conditional-await** async 화(원격 write 는 async), caller 의 sync `{accepted}` 반환 유지(S3a runTurn 교훈).
- session_id capture(`:328`) + `--resume`(`:126`)는 stdout/argv 라 raw-handle 커플링 없음 → 자동 이식.
- cwd 의 local `fs.existsSync`(`:159`)는 원격이면 skip(pod 경로 검증은 executor 소유).

### D3. Auth 계약 (Claude 고유 — codex 와 다름)
- **pod ~/.claude 선로그인** (brief §3#9: node-preprovisioned CLI auth). secret 을 env 로 넣지 않음.
- 하지만 `env:{}`(codex 방식) 금지: streamJsonEngine `:172` 가 manager env authoritative → HOME 소실 → pod claude 가 ~/.claude 못 찾음. → 원격 Claude env 는 **최소 {HOME:pod-home} 정도** 또는 아예 executor 가 pod 로그인 셸의 HOME 을 쓰도록(exec env … 가 pod env 상속). buildCommandScript 가 `exec env PATH=… command` 라 명시 env 없으면 pod 셸 env(HOME 포함) 상속 → **env 에 HOME 미포함이 오히려 정답일 수 있음**(검증 필요). streamJsonEngine `:172` 의 `{...process.env,...env}` 분기가 원격에서 Mac process.env 를 안 섞도록 원격 분기 필요.
- Claude `isRemoteNode || canAuth` 우회(P4-S3b 의 codex 우회 미러) — 컨트롤 플레인(darwin)의 keychain/file 체크는 pod 와 무관.

### D4. Liveness tri-state (brief §8:308)
ssh transport 끊김(exit 255 / close)을 **unreachable** 로, Claude 자연 종료를 **dead+exitCode** 로 구분. transport 끊김을 dead 로 뭉개면 resumable `claude_session_id` 소실 + run 오탐 terminal. `isSessionAlive`/`detectExitCode`(claudeAdapter → streamJsonEngine `:552-563`)를 tri-state 화.

### D5. ssh keepalive
persistent spawnInteractive 경로에 `-o ServerAliveInterval=<n> -o ServerAliveCountMax=<m>` 추가(`sshArgsFor` `:286-293` 는 현재 없음). 유휴 연결이 조용히 reaped 되면 다음 write 까지 `close` 미발화 → keepalive 로 prompt 하게 표면화.

### D6. Resume affinity (claude_session_id ↔ node)
pod ~/.claude 세션이라 resume 은 **같은 pod** 에서만. codex 의 `pm_thread_node_id` affinity(rebind-reset)를 `runs.claude_session_id` + node 로 미러. 현재 Claude 경로엔 affinity 체크 0개.

## 슬라이스 계획 (병렬 고려)

**Wave 0 (foundation, 순차 — 나머지 전부의 전제)**
- **S0 streamJsonEngine executor seam** (D2) — 핵심 리팩터. spawnFn/executor 주입 + 12 접점 라우팅 + async-ify + local byte-equivalent. codex-goal + 직접 리뷰 + **실 Pi 하네스로 persistent Claude over ssh 증명**(S1 이 codex 증명한 것의 Claude 판).

**Wave 1 (S0 후 병렬 — 서로 독립, 다른 파일)**
- **S1 keepalive** (D5) — remoteSshExecutor `sshArgsFor` 에 ServerAliveInterval (persistent 경로만). 작고 독립. → athena/codex-goal.
- **S2 liveness tri-state** (D4) — claudeAdapter/streamJsonEngine exit/close 처리 (transport 255 판별). → athena/codex-goal.
- **S3 claudeAdapter executor 배선** (D2 후반) — claudeAdapter.startSession 이 executor/nodePrefix 수용→spawnAgent 전달 + env 계약(D3). S0 위.

**Wave 2 (productization)**
- **S4 Claude Operator 활성화** — resolveOperatorAdapterType 이 claude 허용(원격/일반) + operatorSpawnService 가 Claude Operator 를 executor 로 라우팅(codex 미러) + resume affinity(D6).
- **S5 실 Pi Claude Operator-on-pod** — 프로젝트 preferred_pm_adapter=claude + Pi 바인딩 → Claude Operator 가 Pi 에서 persistent 구동 → multi-turn → 응답.

**병렬성**: Wave 1 의 S1/S2 는 S0 와 다른 파일(remoteSshExecutor / adapter-exit)이라 S0 진행 중에도 착수 가능(단 통합 검증은 S0 후). athena 로 S1/S2 병렬 오케스트레이션, S0/S3/S4 는 codex-goal + 직접 리뷰(persistent 코어의 복잡도 — athena underdeliver 교훈).

## 안전/원칙
- 로컬 Claude(Top + 로컬 Operator) **byte-equivalent** = 하드 바. 기존 manager/streamJsonEngine 테스트 무수정 그린.
- 실 Pi 검증이 각 slice 의 최종 gate (P4 에서 fake 가 놓친 env/auth 버그를 실 Pi 가 반복 검출).
- 감독 체인: codex-goal → 실 Pi → Claude 리뷰/수정 → Codex 적대 리뷰(PASS) → 병합.
