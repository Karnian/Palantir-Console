# Fleet: 원격 실행 노드 (Pi 컨트롤 플레인 + 다중 이기종 실행 pod)

> 2026-07-02. Status: **r4 LOCKED** — Operator 리네임(#269~#273) 완결 후 신규 코드 기준 재검증.
> Claude + Codex **병렬 독립 리뷰 → 상호 교차리뷰 2라운드** 수렴 반영. 앵커 전면 갱신.
> (r3: 사용자 락인 — Pi=운영서버 + multi-pod 큰그림 + Top-on-Pi. r2: Codex r1 리뷰 4B+6S+2N. §10 기록)
> 작성: Claude (감독). 구현: Codex (예정). branch: `feat/fleet-node-executor` (예정)
> 배경: Palantir 는 도그푸딩 — 실행 중인 서비스 == 편집 중인 코드. 맥에서 서비스를 띄우면 코드
> 편집/재시작/테스트와 충돌. 그래서 운영 인스턴스를 **Raspberry Pi(항상 켜짐)** 로 떼어내고, 무거운
> 실행(워커/Operator/worktree/harvest/fs)은 **맥 및 여러 이기종 pod 머신에서 동시다발로** 돌린다.
> 미래엔 강력한 머신에 Palantir 를 설치해 **control+execution 을 co-locate** 하는 경우의 수도 열어둔다.
>
> **r4 핵심 변경 (신규 코드 재검증 + 교차리뷰)**:
> - **컨셉·락 전부 생존**: 리네임은 wire-format/enum/심볼/UI 만 변경. 실행/파일 레이어의 로컬 가정
>   (executionEngine·worktree·harvest·streamJsonEngine·codexAdapter)은 구조적으로 동일 — 설계 입력 유효.
> - **migration 번호 045→047** (045/046 은 리네임이 소비). runs 는 046 에서 full 스키마로 rebuild 됨
>   (`046:39-70`) → `ALTER TABLE runs ADD COLUMN node_id`(nullable, NULL=local) 로 충분. index 는 별도
>   `CREATE INDEX`.
> - **네이밍 갱신**: `pmSpawnService`→`operatorSpawnService`, conversation id 는 **`operator:<id>` 전용**
>   (dual-read 제거 완결, `conversationId.js:12-19`), `manager_layer ∈ {NULL,'top','operator'}` (046 CHECK
>   `:63`). 단 **`project_briefs.pm_thread_id` 컬럼명은 유지**(내부 컬럼 리네임 비범위) → 확장 컬럼은
>   `pm_thread_node_id`/`pm_thread_cwd` 가 기존과 일관. **`manager_thread_id` 사용 금지** — 그건
>   `runs` 의 per-run transient 필드(005:7-8)로 별개 개념.
> - **Top-on-Pi 정직화 (교차리뷰 SERIOUS)**: codexAdapter 는 매니저에 **항상**
>   `--dangerously-bypass-approvals-and-sandbox` (`codexAdapter.js:299-303` — 매니저가 콘솔 API 를 curl
>   해야 해서 sandbox 네트워크 차단이 치명적). 즉 "오케스트레이션 전용"은 **부하 특성이지 권한 경계가
>   아님**. → v1 Top-on-Pi 는 **Claude Top** (tool diet 로 제약 가능). **Codex Top on Pi 는 안전모드
>   전까지 금지**. 이 co-location 권한 상태는 오늘 맥에서도 동일(리스크 이동이지 신설 아님) — Top 경화는
>   별도 트랙.
> - **P3 liveness tri-state 는 두 엔진 모두** (교차리뷰 수렴): lifecycle 워커 health 는 (a)
>   executionEngine tmux/ps 경로(`:938-948`) + (b) **streamJsonEngine Claude-워커 경로**(`:924-933`,
>   terminal 조건 = `isAlive=false && detectExitCode()!==null`) 2개. 원격 어댑터가 "pod unreachable" 을
>   isAlive=false+exitCode 로 뭉개면 오탐 terminal → **unreachable 은 절대 terminal 경로 호출 금지, dead
>   +known exit 만 전이**.
> - **경로 검증 소유권 명확화**: operatorContext/resolveSpawnCwd 는 원격 경로 검증자가 아님 — legacy
>   worker/Operator 컨텍스트는 enforcement-inert(`operatorContext.js:154-170`, stat 안 함), spawnCwd 는
>   verbatim 반환(`spawnCwd.js:28-33`). 그러나 **로컬 엔진들은 로컬 존재 검사를 함**(streamJsonEngine
>   `fs.existsSync` `:159-166`, executionEngine cwd 검증 `:37-45`) → **원격 cwd 문자열이 로컬 엔진에
>   닿기 전에 NodeExecutor(realpath/fileExists/exposed_roots)가 전담 차단/검증**.
> - **기존 라이브 버그 발견 (Fleet 무관, P4 전 수정 필수)**: `operatorSpawnService.js:332` 가
>   `project.mcp_config_path`(경로 문자열)를 codex adapter 에 넘기고, 주석은 "silently skips" 라지만
>   실제 `codexAdapter.js:327-343` 은 truthy 면 flatten 에 넣어 **문자열 거부 → run failed**. Codex
>   operator + mcp_config_path 조합 즉사. 별도 소형 PR 로 수정.
> - 기타: harvest node resolver 가 homebrew 편향(`harvestService.js:100`,
>   `PALANTIR_NODE_PREFIX || '/opt/homebrew/opt'`) → **node prefix 는 per-node 설정**으로.
>   conversationId seam 은 **identity 전용, node 라우팅 아님**(라우팅은 `projects.node_id`/`runs.node_id`
>   가드로). reconciliation 은 project-bound(`reconciliationService.js:321-330`) — node rebind 는 별도
>   가드 필요. specialist(folder-less, Anthropic API 직접 `specialistBackend.js:121-140`, CLI spawn 0)는
>   **Pi 실행 금지 대상에서 구조적으로 면제** — Top-on-Pi 와 정합.

---

## 1. 현재 코드 사실 (설계 입력 — 2026-07-02 HEAD `d242682` 기준 재검증)

모든 실행/repo 레이어가 **로컬 호스트 가정**. "파일이 있는 머신에 묶인 코드"는 워커 spawn 하나가 아니라 넓다:

- **interactive process engine seam**: `createExecutionEngine()` 팩토리 (`executionEngine.js:379`).
  tmux 엔진 full contract = `spawnAgent/getOutput/sendInput/kill/isAlive/detectExitCode` **+
  `listSessions` + `discoverGhostSessions`** (`:221-231`, subprocess `:364-374`). remote 구현은 full
  contract(발견 포함) 필수. **cwd 로컬 검증 내장** (`:37-45`, `:57/:240` 에서 호출) — 원격 경로가 오면
  여기서 깨짐 → NodeExecutor 가 앞단 전담.
- **Claude 워커는 이 엔진을 우회**: `profile.command` 에 claude 포함 시 `streamJsonEngine` 직접 spawn
  (`lifecycleService.js:575/:620`). streamJsonEngine 도 로컬 `fs.existsSync(cwd)` (`:159-166`).
  → 원격화 스코프에 **Claude 워커 경로 포함 필수**.
- **worker cwd + worktree fallback (2군데)**: `worktreeService.createWorktree` 비-git →
  `{path:projectDir}` (`:64`), `worktree add` 실패 → projectDir (`:115`). `lifecycleService` 는
  `worktreePath || projectDir` (`:564/:566`, createWorktree 호출 `:549`). **폴백은 두 파일 모두.**
- **worktree API 는 sync/throw**: `execFileSync` (`worktreeService.js:30/47/100`) — async
  `executor.exec` 와 shape·동기성 불일치 → compat shim 없이 P0 동작 불변 깨짐.
- **harvest**: 로컬 fs/git/spawn (`harvestService.js:346/362/369/404/432`). **node resolver homebrew
  편향** (`:100`) — per-node prefix 필요.
- **로컬 side-channel**: `/api/runs/:id/diff` 로컬 `fs.existsSync`+`git diff` (`routes/runs.js:288/293/
  343`, realpath 가드 `:312` 는 참고 패턴), `/api/fs` 로컬 (`routes/fs.js:14`, `fsService.js:7`).
- **Operator (Codex)**: `codexAdapter` 가 instruction 을 로컬 temp 에 (`:193`), 첫 turn `-C <cwd>`
  (`:293`), **resume 은 `-C` 불가** (`:287-289` 주석 명시) → **thread node-sticky**. 매니저 spawn 은
  **항상 bypass sandbox** (`:299-303`). `state.mcpConfig` truthy 면 flatten (`:327-343`) — 문자열 거부.
  Operator resume 은 `project_briefs.pm_thread_id` 사용 (`routes/manager.js:184/:224`).
- **Top/Operator (Claude)**: `streamJsonEngine` persistent stdin (`-p 충돌 `:64`, init write `:301`,
  후속 turn `:475/:501`). `/api/manager/start` 로컬 spawn (`routes/manager.js:496-511`). Operator lazy
  spawn 은 **active Top 없으면 거부** (`operatorSpawnService.js:173-180`). binary 탐색은 macOS 경로 →
  `~/.claude/bin` → `/usr/local/bin` → PATH 폴백 (`streamJsonEngine.js:29-50`) — **linux Pi 호환**.
- **operatorContext (P-B2b, 리네임 후 신규 확인)**: 워커 spawn 에 `deriveLegacyContext({run,
  workspaceDir})` threading (`lifecycleService.js:564`) — legacy 는 **enforcement-inert**
  (`operatorContext.js:113-123/:154-170`, `workspaceBinding.js:57-68` — fs 접근 없음).
  `resolveSpawnCwd` 는 verbatim (`spawnCwd.js:28-33/:42-48`, 존재검사는 caller 소유 명시).
- **auth**: keychain darwin 전용, 비-darwin false (`authResolver.js:64-65`), env/`.claude-auth.json`
  폴백 경로 완비 (`:173-231`) — **Top-on-Pi 성립 근거**. isolated auth secret temp 로컬 (`:420-445`).
  `codexMcpFlatten` 은 MCP env 를 argv 로 (`:35-45`) — "secret not in argv" 는 지금도 거짓.
- **B-lite 큐/drain**: statements profile-only (`runService.js:143-160`), wrappers `countRunning :371` /
  `getOldestQueued :375` / `claimQueuedRun :386`. `drainQueue` 는 `getRunningCount(profileId) <
  profile.max_concurrent` 루프 (`lifecycleService.js:861-876`). retry 새 run 은 node 미복사 (`:847-854`).
- **runs 스키마 (046 rebuild 후)**: `046:39-70` — node_id 없음. 컬럼: id, task_id, agent_profile_id,
  worktree_path, branch, tmux_session, status, prompt, …, manager_adapter, manager_thread_id,
  manager_layer, conversation_id, mcp_config_*, preset_*, queued_args, retry_count. index 재생성
  `:93-100`.
- **lifecycle health (2경로)**: (a) tmux/subprocess — 로컬 tmux/ps probe (`:51-67`), isAlive false →
  terminal (`:938-948`). (b) **streamJsonEngine 워커** — `hasProcess` 분기 (`:924-933`), terminal 조건
  = `isAlive=false && detectExitCode()!==null` (`streamJsonEngine.js:552-563` — spawnError→1 매핑).
  needs_input 복구는 stream-json skip (`:1053-1058`), **boot orphan 복구는 tmux 전용** (`:1107-1110`).
- **identity seam**: `conversationId.js:12-19` — `operator:<projectId>` 전용, **node 차원 없음**
  (identity 용도만, 라우팅 가드 아님). reconciliation 은 project-bound (`reconciliationService.js:
  321-330`) — node rebind 감지 못 함.
- **migration 러너**: FK ON + 파일별 tx (`database.js:17/42`). 최신 = **046** → Fleet 은 **047**.
- **SSE**: `SERVER_EMITS` (`eventChannels.js:42-85`, 전 emit 의 완전집합은 아님), 클라 hard-coded
  (`sse.js:62-74`), 둘 다 갱신 + `sse-channels.test`.
- **spawnGuard**: 테스트 중 실 spawn fail-closed (`spawnGuard.js:104-116`) — 실 `ssh` 도 차단됨 →
  remote 테스트는 **fake executor 주입** 필수.
- **specialist (신규, 직교)**: folder-less·ephemeral (`specialistService.js:6-16`), Anthropic Messages
  API 직접 fetch (`specialistBackend.js:121-140`), cap-gated server tools (`:190-197/:222`), CLI
  spawn/workspace 0 → **Pi 에서 합법 실행 가능한 유일한 "실행" 유형**.

## 2. 목표

1. **머신을 1급 `node`(pod) 로** — 레지스트리(connection, capability, exposed roots, health).
2. **프로젝트 → 노드 바인딩(1:1)** — worktree/harvest/spawn/fs 가 그 노드에서 해석.
3. **다중 이기종 pod 동시 사용** — 서로 다른 프로젝트가 서로 다른 pod 에서 병렬, per-node 동시성.
   **메인 서버(Pi)에 pod 를 여러 개 붙여 활용하는 것이 최종 그림** (사용자 락인).
4. **실행/파일 접근을 단일 `NodeExecutor` seam 으로** — 흩어진 로컬 명령 수렴, **local 먼저**.
   경로 존재/안전 검증의 **단일 소유자** — 로컬 엔진의 로컬 검사에 원격 경로가 닿지 않게.
5. **미래 co-located 강력머신 무손실** — 그 머신 설치는 자기 `local` executor 로 (P0~P1 만으로 성립).
6. **pod offline 안전** — unreachable 엔 dispatch 안 하고 queued 유지, online 시 drain.
7. **매니저 배치** — **Top = 컨트롤 플레인 로컬(Pi 상주, v1 Claude Top)**. Operator = 프로젝트 pod.

## 3. Lock-in

1. **노드 선택 = 프로젝트→노드 1:1** (`projects.node_id`). 동시성은 "다른 프로젝트 다른 pod". 단일
   프로젝트 cross-node 로드밸런싱 = 비범위(§5).
2. **NodeExecutor = transport-agnostic**. v1 remote = **SSH over Tailscale**(push). outbound-pull 러너는
   문서화된 future. **[LOCK A 확정]**.
3. **per-node 동시성/drain** — 큐/claim 키 = **(node_id, agent_profile_id)**. `countRunningOnNode` /
   `getOldestQueuedOnNode` / `claimQueuedRunOnNode`(CAS 에 node 포함). **retry 새 run 은 node_id 복사**.
   **unreachable node 큐는 다른 node 의 같은 profile FIFO 를 막지 않는다.** queued 는 슬롯 비점유(B-lite
   유지). **cap 의미 확정**: `agent_profiles.max_concurrent` 는 **per-node-per-profile** 상한으로 재정의
   (글로벌 cross-node 스로틀 아님) + `nodes.max_concurrent` 는 그 노드 워커 총량 상한 — 둘 다 만족해야
   spawn.
4. **worktree fail-closed (2군데)** — `isGitRepo` tri-state(git/non_git/unknown-error). **git·unknown →
   cwd 해석 전에 run failed** + `worktree:create_failed` event. `worktreeService` **와** `lifecycleService`
   의 `|| projectDir` 폴백 **양쪽 제거**. non-git shared-dir 실행은 DB 명시 opt-in 시에만 + run event 기록.
5. **실행 대상 3계층** — phase 분리:
   - (a) git/fs/diff **단발** (worktree 생성, `/runs/:id/diff`, `/api/fs`, harvest 명령) — stateless.
   - (b) **워커 run** (Claude Code/Codex CLI) — 장수명. **Claude 워커(streamJsonEngine 경로) 포함** —
     따라서 P3 tri-state 도 두 엔진 모두 커버.
   - (c) **Claude persistent 매니저** — **Top 은 Pi 로컬이라 원격화 불필요**. 남는 건 Claude Operator
     의 pod 실행 = P5. Codex Operator(per-turn)는 executor 친화 = P4.
6. **매니저 배치 (Top-on-Pi, 정직화 반영)**: **Top 은 컨트롤 플레인 호스트(Pi) 로컬 상주.** 매니저는
   API 클라이언트(부하 가벼움, repo-bound 아님), `streamJsonEngine` 로컬 가정이 자산, binary/auth 의
   linux 폴백 확인됨. pod 꺼져도 두뇌 생존. **단 "오케스트레이션 전용"은 권한 경계가 아님** —
   codexAdapter 매니저는 bypass sandbox (`:299-303`) → **v1 Top-on-Pi 는 Claude Top 만, Codex Top on
   Pi 는 안전모드 전까지 금지.** Operator 는 repo-bound → 프로젝트 pod (P4 = Codex Operator 만).
   "Pi 는 무거운 실행 0" 유지 — 워커 CLI 는 Pi 금지, Top(경량)과 **specialist(folder-less, API 직접,
   CLI 0)** 는 면제.
7. **이벤트 cardinality**: 신규 SSE 채널 = **`node:status` 1개만** — `eventChannels.js` SERVER_EMITS +
   `sse.js` channels + `sse-channels.test` 동시 갱신. `node:reachable`/`node:unreachable`/`node:drain`
   등은 run/node event type(기록), SSE 채널 아님.
8. **Mode P (파일을 Pi 로 pull) 비범위**. Mode R(run-on-node)만.
9. **secret 격리 정직화** — "not in argv" ≠ "불가시". 원격 pod 에 secret-bearing MCP `env` 금지,
   node-preprovisioned CLI auth 선호, `putSecretFile` 은 0600 + 사용 후 삭제.
10. **원격 출력/exit-code = 파일 기반 구조화 status** — stdout/stderr 로그 + exit sentinel 파일을 pod
   에 남기고 수거. **tmux scrollback 스크래핑 금지**. tmux 는 세션 생존 수단으로만.
11. **경로 검증 소유권 = NodeExecutor** (교차리뷰 수렴): operatorContext/resolveSpawnCwd 는 검증자
   아님(legacy inert + verbatim). **원격 cwd 문자열이 로컬 엔진(streamJsonEngine `:159-166`,
   executionEngine `:37-45`)에 닿기 전에** NodeExecutor 의 realpath/fileExists/exposed_roots 가 전담.
12. **identity ≠ placement**: `operator:<projectId>` 는 identity 전용. node 라우팅은
   `projects.node_id`/`runs.node_id` 가드로만. **project node rebind 시 살아있는/저장된 Operator thread
   는 reset 또는 affinity 검증 필수** (reconciliation 은 node 를 모름).

## 4. 구현 지침

### 4.1 DB — migration **047** (CHECK/trigger/index 강화)
```sql
CREATE TABLE nodes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'local' CHECK (kind IN ('local','ssh')),
  can_execute    INTEGER NOT NULL DEFAULT 1 CHECK (can_execute IN (0,1)),
  can_control    INTEGER NOT NULL DEFAULT 0 CHECK (can_control IN (0,1)),
  files_only     INTEGER NOT NULL DEFAULT 0 CHECK (files_only IN (0,1)),
  ssh_host       TEXT,
  ssh_user       TEXT,
  exposed_roots  TEXT,       -- JSON string[]; ssh 행 필수·유효 JSON 배열 (trigger 강제)
  node_prefix    TEXT,       -- harvest node resolver per-node prefix (homebrew 편향 해소)
  max_concurrent INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrent >= 0),
  last_heartbeat_at TEXT,
  reachable      INTEGER NOT NULL DEFAULT 0 CHECK (reachable IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (NOT (files_only = 1 AND can_execute = 1)),
  CHECK (kind <> 'ssh' OR (ssh_host IS NOT NULL AND ssh_user IS NOT NULL AND exposed_roots IS NOT NULL))
);
INSERT INTO nodes (id,name,kind,can_execute,can_control,reachable)
  VALUES ('local','Local','local',1,1,1);   -- 기존 동작 = local 노드로 보존

-- trigger: ssh 행 exposed_roots json_valid + json_type='array' (022/042 패턴, fail-closed)

ALTER TABLE projects ADD COLUMN node_id TEXT REFERENCES nodes(id);  -- NULL → 'local'
ALTER TABLE runs     ADD COLUMN node_id TEXT REFERENCES nodes(id);  -- spawn 시점 스냅샷
CREATE INDEX idx_projects_node ON projects(node_id);
CREATE INDEX idx_runs_node_drain ON runs(node_id, agent_profile_id, status, created_at);

-- Operator thread node affinity (기존 pm_ 접두 컬럼과 일관 — manager_thread_id 는 별개 runs 필드)
ALTER TABLE project_briefs ADD COLUMN pm_thread_node_id TEXT REFERENCES nodes(id);
ALTER TABLE project_briefs ADD COLUMN pm_thread_cwd TEXT;  -- resume 이 -C 불가 → 원 cwd 보존
```
- runs 는 046 rebuild 로 full 스키마 — nullable ADD COLUMN 으로 충분, rebuild 불필요.
- Top 배치엔 노드 컬럼 불필요 (Top=컨트롤 플레인 로컬 정의, Operator 노드=`projects.node_id`).
- **rebind 안전**: `project.node_id` 변경 시 살아있는/저장된 operator thread 면 **reset 요구**.

### 4.2 `nodeService` + `NodeExecutor` (full contract)
- `nodeService`: nodes CRUD, `resolveNode(projectId)`(project.node_id || 'local'),
  heartbeat/reachable, `pickExecutor(nodeId)`.
- **`NodeExecutor` 계약** (transport-agnostic, 발견·tri-state 포함):
  - `exec(command,args,{cwd,env,timeoutMs})` → `{code,stdout,stderr}` ((a)계층)
  - `spawnInteractive` + `getOutput/sendInput/kill/detectExitCode` ((b)계층)
  - **`liveness(runId)` → `'alive'|'dead'|'unreachable'`** — **두 엔진 경로 모두** 이 tri-state 로
  - **`listSessions()` / `discoverGhostSessions()`** (orphan 복구, 노드별)
  - `realpath / fileExists / readFile / writeTempFile / readdir / rmrf`
  - `putSecretFile(path,content,mode=0o600)` + 사용 후 삭제 훅
- **`LocalNodeExecutor`**: 로컬 구현 + **P0a compat shim** (sync/throw 의미 보존) — 동작 불변.
- **`RemoteSshNodeExecutor`**: `ssh` exec / `ssh tmux` interactive / `ssh 'cat >'`·sftp 파일.
  모든 경로 `realpath` 후 canonical `exposed_roots` 비교, **symlink escape fail-closed**.
  출력/exit-code 는 §3 #10 파일 기반 status 로 수거.

### 4.3 호출부 라우팅 인벤토리 (완전판)
`worktreeService`(생성/제거/diff), `harvestService`(autosave/diff/test/remove/cleanup + **per-node
node_prefix**), `fsService` + `routes/fs.js`, `routes/runs.js`(`/:id/diff`), `lifecycleService`
**워커 spawn 2경로(executionEngine + streamJsonEngine)** + worktree cwd + stale cleanup,
`codexAdapter`(instruction/MCP temp → `putSecretFile`, `-C` pod 경로). 매니저 spawn(`routes/manager.js`,
`operatorSpawnService`)은 **Top=로컬 유지**, Operator 만 P4 에서 pod 라우팅.

### 4.4 P0 분할 (순수 리팩터 아님 — r2 BLOCKER)
- **P0a**: `NodeExecutor` 인터페이스 + `LocalNodeExecutor` + **compat shim**. 회귀 그린 = 동작 불변 증명.
- **P0b**: 호출부 async 이관(필요한 곳만) + **Claude 워커 경로(streamJsonEngine) executor 라우팅 편입**.

### 4.5 per-node 동시성/drain (B-lite 확장)
- enqueue 시 `run.node_id = resolveNode(projectId)` 스냅샷. `createRetryRun`(`lifecycleService.js:847`)
  **node_id 복사**.
- `drainQueue`(`:861-876`) 를 **node 별**로: `node.reachable && countRunningOnNode < 상한(§3 #3)` 동안
  그 노드 oldest queued spawn. **unreachable node skip, 다른 node 는 계속 drain.**
- claim CAS 에 node 포함. boot drain 을 node 별로 (Top→Operator 순서 유지).

### 4.6 health / offline (tri-state — 두 엔진 모두)
- **`unreachable` 은 절대 terminal 경로 호출 금지; `dead`+known exit 만 전이.** 이 규칙은 (a)
  tmux/subprocess 경로(`:938-948`)와 (b) streamJsonEngine 워커 경로(`:924-933`) **양쪽에 적용** —
  원격 어댑터가 transport 단절을 isAlive=false+exitCode 로 뭉개면 안 됨.
- 노드별 heartbeat probe → reachable + `node:status`. reachable false→true 전이 + boot 에 노드별
  `discoverGhostSessions()`.
- reattach 성공 → drain 재개. 세션 부재 확정 시에만 stale→retry. 출력 회수는 pod status/로그 파일.

### 4.7 보안
- `exposed_roots`: **`executor.realpath` canonical 비교**(prefix 문자열 금지), symlink fail-closed.
  worktree 제거 경로 canonical 화 (`worktreeService.js` removeWorktree 가드 강화).
- per-node **command allowlist**. Tailscale ACL 로 Pi→pod 방향만. `ssrf.js` 사설 IP 허용 = 등록 노드
  host 한정.
- secret: 원격 pod secret-bearing MCP `env` 금지, `putSecretFile`(0600)+삭제, pod CLI 선로그인 선호.
- **Top-on-Pi 권한**: v1 Claude Top 만. Codex Top 은 bypass sandbox 라 Pi 에서 금지 (안전모드 별도).

## 5. 비범위 (v1)

| 항목 | 이유 |
|---|---|
| Mode P (파일을 Pi 로 pull 실행) | 복잡도 배증 + ARM 느림 |
| 단일 프로젝트 cross-node 로드밸런싱 | 1:1 로 시작. pod pool 스케줄링 후속 |
| Claude persistent 원격화 (Operator/워커, c계층) | P5 — Top 은 Pi 로컬이라 불필요 |
| Codex Top on Pi | bypass sandbox — 안전 매니저 모드 별도 트랙 |
| outbound-pull 러너 transport | 인터페이스만 열어둠 |
| 노드 auto-discovery / secret 자동 provisioning | 수동 등록, pod CLI 선로그인 |
| files-only 노드 원격 편집 | capability 컬럼 예약만 |

## 6. 수용 기준

1. `local` 시드 + node_id NULL 프로젝트 **동작 불변** (P0a 회귀 그린).
2. ssh pod 바인딩 → 워커가 원격 worktree 에서 실행, diff/harvest 도 그 pod, `runs.node_id` 스냅샷.
3. **다른 프로젝트가 다른 pod 에서 동시 실행**, per-node 동시성 독립 (cap 의미 = §3 #3).
4. worktree 생성 실패 → **폴백 없이 failed**, 2경로 모두. 원격 메인 체크아웃 오염 0.
5. pod unreachable → 그 pod dispatch 정지·queued 유지, **다른 pod/같은 profile 은 계속 drain**.
6. pod sleep 중 원격 워커 = `unreachable` → **terminal 전이 0** (두 엔진 경로 모두), 복귀 시
   reattach + status 파일 수거, 세션 부재 확정 시만 retry.
7. Codex Operator 원격 spawn(instruction pod 배치) + resume 같은 pod affinity(`pm_thread_node_id`).
   rebind 시 살아있는 thread 면 reset 요구. **P4 착수 전 mcp_config_path 문자열 버그 수정**.
8. secret argv/로그/원격 process listing 노출 0. exposed_roots 밖·symlink escape 거부.
9. Top = Pi 로컬 Claude Top 으로 기동(오늘 경로 그대로). Pi 에서 워커 CLI 실행 0 (specialist 는 면제).
10. 미래 co-located: `can_control=1,can_execute=1` 노드 설치 시 local executor 실행.
11. 원격 워커 출력/exit-code 가 파일 기반 구조화 status 로 수거 (scrollback 절단 무관).
12. 전체 `node --test` 그린 + 신규 `node-executor.test.js`/`fleet-routing.test.js`(**fake executor** —
    spawnGuard 가 실 ssh 차단).

## 7. 테스트 지침
- **fake NodeExecutor** 주입 — 실 SSH 0 (spawnGuard `:104-116` 이 실 ssh 차단).
- 케이스: P0a 동작 불변 / project→node 라우팅 / per-node 동시성(A max, B 자유) / unreachable A 가 B 의
  같은 profile drain 안 막음 / worktree fail-closed(2경로) / **liveness tri-state 두 엔진 모두**
  (unreachable≠dead, stream-json 경로의 spawnError→exitCode 뭉개기 금지) / run.node_id 스냅샷 + retry
  복사 / exposed_roots realpath·symlink escape 거부 / secret argv 미노출 / Claude 워커 경로 executor
  라우팅 / Operator thread node affinity + rebind reset / status 파일 수거 / cap 이중 상한(§3 #3).
- 회귀: `worktree`/`harvest`/`preset-spawn`/`manager-lifecycle`/`queue`/`sse-channels`.

## 8. 구현 순서

- **P0a — local executor + compat shim** (동작 불변). 회귀 그린.
- **P1 — migration 047 불변식 + 노드 레지스트리** + `#nodes` CRUD + project 바인딩 + **worktree
  fail-closed(2경로)** + per-node queue/claim 스키마.
- **P0b — 호출부 async 이관 + Claude 워커 경로 편입.**
- **P2 — RemoteSshNodeExecutor (a)계층**: 원격 git/fs/diff/harvest(+node_prefix), realpath 가드.
- **P3 — 원격 워커 (b)계층**: 원격 tmux spawn + **파일 기반 status 수거** + **두 엔진 tri-state** +
  노드별 ghost discovery + per-node drain.
- **P4 — Operator on pod**: Codex Operator 원격(putSecretFile, `-C` pod 경로, `pm_thread_node_id`).
  **선행: mcp_config_path 문자열 버그 수정** (별도 소형 PR, Fleet 무관 라이브 버그).
- **P5 — Claude persistent on pod (c)계층**: Claude Operator/워커 원격 — 별도 브리프(persistent SSH
  채널 or 얇은 relay). **managerRegistry 의 adapter.isSessionAlive/detectExitCode probe 도 tri-state 로**
  (transport 단절 ≠ 자연 종료). Top-on-Pi 덕에 크리티컬 패스 아님.

## 9. 확정/오픈 결정

- **[LOCK A] transport** = SSH over Tailscale(push). outbound-pull 러너 future.
- **[LOCK B] 매니저 배치 = Top-on-Pi (v1 Claude Top 만)**. Codex Top on Pi 금지(bypass sandbox).
  Operator 는 프로젝트 pod.
- **[LOCK C] multi-pod = 확정 로드맵** — "메인 서버에 pod 여러 개" (사용자, 2026-07-02 재확인).
- **[OPEN Q3] pod auth provisioning**: v1 = pod CLI 선로그인. Pi→pod secret push 별도 설계.
- **용어**: DB/코드 `nodes`, UI 라벨 "Pod" 후보 — P1 UI 때 결정.

## 10. 리뷰 처리 기록 (누적)

**r4 (2026-07-02, Operator 리네임 후 Claude+Codex 병렬 독립 리뷰 → 교차리뷰 2R 수렴)**:

| 출처 | 발견 | 판정/처리 |
|---|---|---|
| Codex r1 | migration 045/046 소비 → 047 | 반영 (§4.1) |
| Codex r1 | `pm_thread_id` 컬럼 유지 — `manager_thread_id` 는 별개 runs 필드, 사용 금지 | 반영 (§4.1) |
| Codex r1 | **Codex 매니저 bypass sandbox** (`codexAdapter:299-303`) → Top-on-Pi 는 Claude Top 만 | Claude 검증 확인 → §3 #6, §5 |
| Codex r1 | **mcp_config_path 문자열 라이브 버그** (`operatorSpawnService:332`+`codexAdapter:327-343`) | Claude 검증 확인 → P4 선행 수정 |
| Codex r1 | cap 의미 미정의 (profile vs node max_concurrent) | §3 #3 이중 상한으로 확정 |
| Codex r1 | harvest homebrew 편향 (`:100`) | Claude 검증 확인 → nodes.node_prefix |
| Claude | operatorContext enforcement vs 원격 workspaceDir | Codex NUANCE: enforcement 는 inert — 실 위험은 로컬 엔진의 로컬 검사 → §3 #11 소유권 규칙으로 반영 |
| Claude | 이중 health 경로 (executionEngine + streamJsonEngine 워커) | Codex NUANCE-확인: terminal 조건 정밀화(`isAlive=false && exitCode!==null`), P3 두 엔진 tri-state → §4.6 |
| Claude | runs 046 rebuild → ADD COLUMN 호재 | Codex CONFIRM (+index 별도) |
| Claude | conversationId seam 재사용 | Codex 대부분 REFUTE: identity 전용 → §3 #12 |
| Claude | specialist = Pi 면제 | Codex CONFIRM → §3 #6 |
| Codex 2R 신규 | P5 에서 managerRegistry probe 도 tri-state 필요 | §8 P5 반영 |

**r3 (2026-07-02 사용자 락인)**: Pi=운영서버 + multi-pod 큰그림 + Top-on-Pi + 파일 기반 status +
default_manager_node 제거. **r2 (Codex r1 spec review)**: BLOCKER 4(P0 분할 / worktree 2경로 fail-close /
큐 node 축 / 매니저 배치) + SERIOUS 6(thread affinity / health tri-state / side-channel / realpath /
secret argv / migration 강화) + NIT 2(SSE 규칙 / full contract) — 전부 본문 반영 유지.
