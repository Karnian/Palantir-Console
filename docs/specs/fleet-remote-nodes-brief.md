# Fleet: 원격 실행 노드 (Pi 컨트롤 플레인 + 다중 이기종 실행 노드)

> 2026-07-01. Status: **draft (Codex spec review 대기)**
> 작성: Claude (감독). 구현: Codex (예정). branch: `feat/fleet-node-executor` (예정)
> 배경: Palantir 는 도그푸딩 — 실행 중인 서비스 == 편집 중인 코드. 맥에서 서비스를 띄우면 코드
> 편집/재시작/테스트와 충돌. 그래서 운영 인스턴스를 **Raspberry Pi(항상 켜짐)** 로 떼어내되, 무거운
> 실행(워커/PM/worktree/harvest/fs)은 **맥 및 여러 이기종 원격 머신에서 동시다발로** 돌린다.
> 미래엔 강력한 머신에 Palantir 를 설치해 **control+execution 을 co-locate** 하는 경우의 수도 열어둔다.
>
> **3-소스 결론 (deep-research 업계근거 + Codex 파일단위 교차검증 + 코드 그라운딩)**:
> - 두-플레인 분리(가벼운 코디네이터 / 무거운 실행 노드)는 업계 표준 (Buildkite·Jenkins·Nomad·
>   GitHub Actions·Red Hat AAP 만장일치). "코디네이터는 실행 0" 은 Jenkins 공식 권장(executors=0).
> - **"agentless(노드에 상주 프로세스 0)" 는 강한 의미로 성립 불가**: `streamJsonEngine` 의 Claude Top
>   은 persistent stdin/stdout 프로세스 → 단발 SSH 로 못 태움. 정직한 목표는 **"노드에 커스텀 *상시
>   데몬*(Palantir)은 없다"** — 세션 동안만 사는 프로세스/relay 는 불가피.
> - "Pi 는 CLI 안 돌림" 은 *배포 선택*이지 *코드 불변식* 아님 → 실행은 **per-node capability** 로.
> - Tailscale = 올바른 fabric (node key, deny-by-default 방향성 ACL, SSH 를 공용 인터넷서 제거).

---

## 1. 현재 코드 사실 (설계 입력)

모든 실행/repo 레이어가 **로컬 호스트 가정**. "맥 파일에 묶인 코드" 는 워커 spawn 하나가 아니라 넓다:

- **executionEngine seam (깨끗)**: `createExecutionEngine()` 팩토리 + `createTmuxEngine`/
  `createSubprocessEngine` (`executionEngine.js:379/389`). 인터페이스 =
  `spawnAgent(runId,{command,args,cwd,env})` / `getOutput` / `sendInput` / `kill` / `isAlive` /
  `detectExitCode` (`:223,:366`). **여기에 remote 구현을 한 종류 더 끼울 수 있다.**
- **worker cwd + worktree fallback**: `lifecycleService` (~`:541`) 이 `worktreeService.createWorktree
  (projectDir, ...)` 호출, 실패/비-git 이면 **projectDir 로 폴백**. `createWorktree` 는 (a) 비-git →
  `{path:projectDir,created:false}` (`worktreeService.js:64-65`), (b) `worktree add` 실패 → 역시
  projectDir (`:106-116`). **원격화 시 이 폴백 = 원격 노드의 메인 체크아웃에 에이전트 직접 쓰기 = 사고.**
- **harvest**: autosave/diff/test/remove 가 전부 로컬 경로 cwd (`harvestService.js`), test 실행은 로컬
  `spawn` + 로컬 node 해석 (T4). worktree 가 원격이면 harvest 도 그 노드에서 돌아야 한다.
- **fs 브라우저**: `fsService` 가 로컬 루트 기준 (`fsService.js:7`).
- **PM (Codex)**: `codexAdapter` 가 `system_prompt.md` 를 **로컬 temp 에 쓰고**(`:193`) `codex exec -C
  <cwd> -c model_instructions_file="<path>"` (`:291`) — 원격 노드엔 그 temp 경로 부재. **resume 은
  `-C` 안 받음**, 원 cwd 를 상속(`:284`) → thread 는 **노드 sticky**.
- **Top/PM (Claude)**: `streamJsonEngine` 이 `--input-format stream-json` persistent 프로세스,
  초기 프롬프트/후속 턴 모두 같은 `child.stdin` 파이프 (`:63/293/466`). CLAUDE.md:316 "stdin 계속
  열어둬야 함". **단발 SSH exec 로는 모델 불가 — persistent 채널/relay 필요.**
- **auth**: keychain 탐지가 macOS 로컬 전용 (`authResolver.js:64`) → Pi 에선 false. isolated Claude
  auth 는 secret 임시파일을 로컬에 씀 (`:420`) → 원격 CLI 가 못 읽음. **secret 을 원격 노드로 어떻게
  건넬지가 보안 핵심.**
- **B-lite 큐/drain (재사용 자산)**: `countRunning` = running-only, **agent_profile_id 기준**
  (`runService.js`). drain 은 profile 별 FIFO. retry = 새 attempt run. boot drain 존재. →
  **다중 노드에선 concurrency/drain 을 node 축으로 확장**해야 한다.
- **runs / projects 스키마**: 둘 다 **node_id 없음**. runs 는 `tmux_session`/`worktree_path`/`branch`/
  `claude_session_id` 같은 **로컬 실행 핸들**을 저장하지만 실행 노드 정체성은 없음.
- **lifecycle health**: orphan 복구가 `executionEngine.type==='tmux'` 로컬 tmux/ps 셸아웃
  (`lifecycleService.js:1107/:51`). **맥 sleep 을 프로세스 죽음과 구분 못 함.**
- **spawnGuard**: 테스트 중 실제 spawn 을 fail-closed 차단, node/fixture binary 만 허용
  (`spawnGuard.js:98`). **remote executor 도 fake executor seam 으로 테스트 (실 SSH 금지).**

## 2. 목표

1. **머신을 1급 `node` 로** — 레지스트리에 등록(connection, capability, exposed roots, health).
2. **프로젝트 → 노드 바인딩** — 그 프로젝트의 worktree/harvest/spawn/fs 가 **그 노드에서** 해석.
3. **다중 이기종 노드 동시 사용** — 서로 다른 프로젝트가 서로 다른 노드에서 병렬 실행, per-node 동시성.
4. **실행을 단일 seam 으로** — 흩어진 로컬 cwd 명령을 `NodeExecutor` 하나로 수렴, **local 구현 먼저**.
5. **미래 co-located 강력머신 무손실** — 실행 경로가 abstraction 이라, 그 머신 설치는 자기 `local`
   executor 로 co-locate. Fleet 을 안 지어도 (P0~P1 만으로) 이 케이스가 1급이 됨.
6. **노드 offline 안전** — unreachable 노드엔 dispatch 안 하고 queued 유지, online 시 drain.

## 3. Lock-in

1. **노드 선택 = 프로젝트→노드 바인딩 (1:1)**. `projects.node_id` 로 결정. 동시 다중 노드는 "다른
   프로젝트가 다른 노드에서" 로 달성. **단일 프로젝트 작업을 여러 노드에 분산(로드밸런싱)은 비범위(§5).**
2. **NodeExecutor 는 transport-agnostic 인터페이스**. v1 remote 구현 = **SSH over Tailscale**
   (command exec + file 오퍼레이션). ⟶ **[USER LOCK A]** outbound-pull 러너(노드가 Pi 로 dial-out)는
   업계 정석이나 "노드에 얇은 러너 설치" 를 요구 → v1 은 SSH-push 로 시작, 인터페이스는 러너 추가가
   무리없게 설계(문서화된 future). 같은 tailnet 이면 SSH-push 의 NAT 약점은 사라짐.
3. **per-node 동시성**. `max_concurrent` 판단·drain 을 **node×profile** 축으로. queued 는 여전히 슬롯
   비점유(B-lite lock-in #3 유지). drain 은 "그 노드가 reachable 할 때" 만.
4. **worktree fallback 제거(fail-closed)**. git 프로젝트에서 worktree 생성 실패 시 **projectDir 로
   폴백 금지** — run 을 `failed` + `worktree:create_failed` event. (원격서 메인 체크아웃 오염 사고 차단.)
   비-git 프로젝트는 명시적 opt-in 시에만 projectDir 실행 허용(기존 동작 보존, 단 경고 event).
5. **실행 대상 3계층 분리** — 난이도별로 phase 분리, 하나의 executor 로 뭉개지 않는다:
   - (a) **git/fs 단발 명령** (worktree 생성, diff, fs 브라우저) — stateless, SSH exec 한 방. **쉬움**.
   - (b) **워커 run** (Claude Code/Codex CLI in worktree, tmux) — 장수명, tmux detach/reattach. **중간**.
   - (c) **Claude Top/PM persistent 매니저** (`streamJsonEngine`) — stdin 을 대화 내내 열어둠. **어려움**,
     별도 phase. Codex PM(`codex exec resume`, per-turn stateless)은 (c) 중 쉬운 쪽.
6. **manager run 은 큐/재시도 대상 아님** (기존 가드 유지). **매니저 노드 배치**는 ⟶ **[OPEN Q2]**.
7. **이벤트 cardinality 규율**: 신규 SSE 채널은 **node 헬스 1개만** (`node:status`) 신설 —
   `sse.js` channels 배열 + `eventChannels.js` SERVER_EMITS 동시 수정(회귀 방지). 그 외
   `node:reachable`/`node:unreachable`/`node:drain` 등은 **run/node event type** (기록용), SSE 채널 아님.
8. **Mode P (파일을 Pi 로 pull 해 Pi 에서 실행) 비범위** — 경로·auth·node 버전·harvest 의미를 배로
   늘리고 ARM 느림. Mode R(run-on-node)이 유일한 v1 실행 모드.
9. **secret 은 argv 로 안 나간다**. 원격 auth 는 env/파일 주입 경로로만 (M1 의 bearer_token_env_var
   원칙 계승). Tailscale ACL + per-node command allowlist 로 실행 권한 최소화.

## 4. 구현 지침

### 4.1 DB — migration 045
```sql
CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,          -- 'local' 시드 포함
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'local'  -- 'local' | 'ssh'
                  CHECK (kind IN ('local','ssh')),
  -- capability (per-node, 코드 불변식 아님)
  can_execute   INTEGER NOT NULL DEFAULT 1,   -- 그 노드에서 프로세스 실행 허용
  can_control   INTEGER NOT NULL DEFAULT 0,   -- (미래) 그 노드가 컨트롤 플레인 co-locate
  files_only    INTEGER NOT NULL DEFAULT 0,   -- 파일만 노출, 실행 불가
  -- ssh transport (kind='ssh' 일 때만)
  ssh_host      TEXT,                         -- tailnet hostname/IP
  ssh_user      TEXT,
  exposed_roots TEXT,                         -- JSON string[] — 허용 경로 prefix (fail-closed)
  max_concurrent INTEGER NOT NULL DEFAULT 2,  -- per-node 워커 상한
  -- health
  last_heartbeat_at TEXT,
  reachable     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO nodes (id,name,kind,can_execute,can_control,reachable)
  VALUES ('local','Local',
          'local',1,1,1);                     -- 기존 동작 = local 노드로 보존

ALTER TABLE projects ADD COLUMN node_id TEXT REFERENCES nodes(id);  -- NULL → 'local' 취급
ALTER TABLE runs     ADD COLUMN node_id TEXT REFERENCES nodes(id);  -- spawn 시점 노드 스냅샷
```
- `runs.node_id` 는 **Codex 지적**: 프로젝트 바인딩이 나중에 바뀌어도 진행 중 run 이 어느 노드에서
  도는지 진실을 잃지 않게 spawn 시점 스냅샷. orphan 복구/재접속이 이걸로 노드를 안다.
- `exposed_roots` fail-closed: worktree/harvest/fs 경로가 이 prefix 밖이면 거부 (`pathGuard` 확장).

### 4.2 `nodeService` (신규) + `nodeExecutor` (신규 seam)
- **`nodeService`**: nodes CRUD, `resolveNode(projectId)` (project.node_id || 'local'),
  heartbeat/reachable 갱신, `pickExecutor(nodeId)`.
- **`NodeExecutor` 인터페이스** (transport-agnostic):
  - `exec(command, args, {cwd, env, timeoutMs})` → `{code, stdout, stderr}` (단발, (a)계층)
  - `spawnInteractive(runId, {command,args,cwd,env})` + `getOutput/sendInput/kill/isAlive/
    detectExitCode` — **executionEngine 5-메서드와 동형** ((b)계층). tmux-backed.
  - `fileExists / readFile / writeTempFile / realpath / readdir / rmrf` ((a)/fs)
  - `putSecretFile(path, content, mode)` — MCP config / codex instruction 파일 원격 배치 (secret은
    argv 아닌 파일/env 로).
- **`LocalNodeExecutor`**: 위를 로컬 `execFile`/기존 executionEngine 으로 구현. **P0 에서 이걸로 전
  경로를 통과시키되 동작 불변** (순수 리팩터).
- **`RemoteSshNodeExecutor`**: `ssh <user>@<host> --` 로 `exec`, `ssh ... tmux new -d` +
  `tmux capture-pane`/`send-keys` 로 interactive, `scp`/`sftp` or `ssh 'cat >'` 로 파일. 모든 경로
  `exposed_roots` 검증 통과 후에만.

### 4.3 호출부 라우팅 (P0 = local 통과, 동작 불변)
- `worktreeService` 의 모든 `execFileSync('git', ..., {cwd})` → `executor.exec('git', ...)`.
- `harvestService` autosave/diff/test/remove → `executor.exec` / `executor.spawnInteractive`.
- `fsService` 루트 조회 → `executor.readdir/realpath` + `exposed_roots` 가드.
- `lifecycleService` 워커 spawn: `createExecutionEngine()` 대신 `nodeService.pickExecutor(run.node_id)
  .spawnInteractive(...)`. worktree 생성도 그 executor 로.
- `codexAdapter` PM: instruction/MCP temp 를 `executor.putSecretFile` 로 **노드에** 쓰고 `-C` 를 그
  노드 경로로. thread 는 `runs.node_id` affinity 로 resume 시 같은 노드.

### 4.4 per-node 동시성 / drain (B-lite 확장)
- `countRunning` → `countRunningOnNode(nodeId, profileId)` (running-only 유지).
- enqueue 시 `run.node_id = resolveNode(projectId)` 확정 (queued_args 처럼 스냅샷).
- drain: run:ended 구독자의 drain 루프를 **node 별**로 — `node reachable && countRunningOnNode <
  node.max_concurrent` 동안 그 노드의 oldest queued spawn. **unreachable 노드는 skip (queued 유지).**
- claim CAS(B-lite lock-in #5) 그대로 — 중복 spawn 0.

### 4.5 헬스 / offline (신규 최소)
- **heartbeat**: lifecycle monitor 가 노드별 `executor.exec('true')` (또는 `ssh -O check`) 주기 probe
  → `reachable` + `last_heartbeat_at` 갱신, 변화 시 `node:status` SSE.
- **node_unreachable ≠ 프로세스 죽음**: 원격 워커 run 이 probe 실패 중이면 `failed` 로 안 내리고
  `running`(stale) 유지. 노드 복귀 시 tmux reattach 로 재접속 시도, tmux 부재 확인 시에만 stale→retry.
- **online drain 훅**: `reachable` false→true 전이에 그 노드 `drainQueue`.
- **boot**: 기존 boot drain 을 node 별로. Top→PM 순서 유지.
- webhook(`webhookService`) 재사용: "노드 복귀/큐 소진 시작" 통지에 활용 가능(선택).

### 4.6 보안
- Tailscale ACL 로 Pi→node 방향만 허용(역방향 deny). `ssrf.js` 사설 IP 정책을 노드 host 에 한해 허용
  (allowlist = 등록 노드 host 만).
- per-node **command allowlist** (기존 에이전트 allowlist 계승) — 원격서 임의 명령 실행 차단.
- auth: secret 은 `putSecretFile`(mode 0600) 또는 env 주입으로만. **argv 금지**. Claude OAuth /
  Codex key 를 노드로 어떻게 provisioning 할지 = ⟶ **[OPEN Q3]** (v1 은 노드에 이미 로그인된 CLI
  가정 = "노드는 원래 코딩 도구가 있는 머신" 원칙, Pi 에서 secret push 최소화).

## 5. 비범위 (v1)

| 항목 | 이유 |
|---|---|
| Mode P (파일을 Pi 로 pull 실행) | 복잡도 배증 + ARM 느림. Mode R 만 |
| 단일 프로젝트의 cross-node 로드밸런싱 | 프로젝트→노드 1:1 로 시작. node pool 스케줄링은 후속 |
| Claude Top persistent 원격화 (c계층) | 별도 phase (§4.1 lock-in #5). v1 은 (a)/(b)/Codex PM |
| outbound-pull 러너 transport | 인터페이스만 열어둠. SSH-push 로 시작 |
| 노드 자동 발견 / provisioning 자동화 | 수동 등록. secret 자동 배포 안 함 |
| files-only 노드의 원격 편집 | capability 컬럼만 예약, 동작은 후속 |

## 6. 수용 기준

1. `local` 노드 시드 + 기존 프로젝트(node_id NULL)가 **동작 불변** (전 회귀 그린) — P0 순수 리팩터 증명.
2. 프로젝트에 ssh 노드 바인딩 → 그 프로젝트 워커가 **원격 노드 worktree 에서** 실행, diff/harvest 도
   그 노드에서. run.node_id 스냅샷 기록.
3. **서로 다른 프로젝트가 서로 다른 노드에서 동시 실행** (per-node 동시성 독립).
4. worktree 생성 실패 시 **projectDir 폴백 없이 failed** (`worktree:create_failed`). 원격 메인
   체크아웃 오염 0.
5. 노드 unreachable → 그 노드 dispatch 정지, run queued 유지, **다른 노드는 영향 없음**. 복귀 시 자동
   drain.
6. 원격 워커가 노드 sleep 중이면 **failed 로 안 내려가고** stale 유지 → 복귀 시 reattach, tmux 부재 시만
   retry.
7. Codex PM 이 원격 노드에서 instruction 파일과 함께 spawn, resume 시 같은 노드 affinity.
8. secret 이 **argv/로그에 노출 0** (putSecretFile/env 만).
9. 미래 co-located: `can_control=1,can_execute=1` 노드에 Palantir 설치 시 자기 local executor 로 실행
   (P0~P1 만으로 성립).
10. 전체 `node --test` 그린 + 신규 `node-executor.test.js` / `fleet-routing.test.js`
    (**fake executor**, 실 SSH 0).

## 7. 테스트 지침
- **fake NodeExecutor** 주입 — 실 SSH/원격 없이 라우팅·큐·헬스 전이 검증 (spawnGuard 철학 계승).
- 케이스: local 통과 동작 불변 / project→node 라우팅 / per-node 동시성(노드A max 도달, 노드B 자유) /
  worktree fail-closed(폴백 0) / node unreachable→queued 유지→복귀 drain / stale vs 죽음 구분 /
  run.node_id 스냅샷 / exposed_roots 밖 경로 거부 / secret argv 미노출.
- 회귀: `worktree` / `harvest` / `preset-spawn` / `manager-lifecycle` / `queue` — 로컬 경로 보존.

## 8. 구현 순서 (phase 로 나눠, 각 phase 끝에 Codex 교차검증)

- **P0 — seam 도입 (SSH 없음, 동작 불변)**: migration 045(nodes+node_id+local 시드) + NodeExecutor
  인터페이스 + LocalNodeExecutor + 호출부(worktree/harvest/fs/lifecycle/PM) 를 local executor 로 통과.
  회귀 그린 = 성공. **여기서 멈춰도 미래 co-located 강력머신 확보.**
- **P1 — worktree fail-closed + 노드 레지스트리 UI/API**: 폴백 제거, `#nodes` CRUD, project 바인딩.
- **P2 — RemoteSshNodeExecutor (a)계층**: 원격 git/fs/diff. exposed_roots 가드. fake→실 노드 스파이크.
- **P3 — 원격 워커 (b)계층**: 원격 tmux spawn + reattach + per-node drain + 헬스/offline.
- **P4 — Codex PM 원격**: putSecretFile + `-C` 노드 경로 + thread node affinity.
- **P5 — Claude Top/PM persistent (c)계층)**: 별도 브리프. persistent SSH 채널 or 얇은 relay.

## 9. 오픈 결정 (사용자/Codex 확인)

- **[USER LOCK A] transport 기본값**: v1 = SSH over Tailscale (push). outbound-pull 러너는 future.
  → 다중 이기종·비-tailnet 노드가 많아지면 러너가 유리. 지금 규모(맥+소수 박스, 같은 tailnet)면 SSH-push
  권장. **확인 필요.**
- **[OPEN Q2] 매니저 노드 배치**: Top(Claude, 싱글, 비-프로젝트)/PM(프로젝트별)을 어느 노드에서?
  Pi 는 CLI 안 돌리므로 매니저도 실행 노드 필요. "default manager node" 개념 도입? v1 은 워커 중심,
  매니저 원격은 P4~P5 로.
- **[OPEN Q3] 노드 auth provisioning**: v1 = "노드에 이미 로그인된 CLI" 가정(secret push 최소). Pi 가
  노드로 OAuth/key 를 밀어야 하는 케이스는 별도 설계.
- **files-only capability 의미**: 지금은 컬럼 예약만. 실제 "파일만 읽어와 작업" 은 Mode P 이므로 비범위.
