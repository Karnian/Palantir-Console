# Fleet: 원격 실행 노드 (Pi 컨트롤 플레인 + 다중 이기종 실행 노드)

> 2026-07-01. Status: **r2 (Codex r1 spec review 반영 — BLOCKER 4 + SERIOUS 6 + NIT 2 처리)**
> 작성: Claude (감독). 구현: Codex (예정). branch: `feat/fleet-node-executor` (예정)
> 배경: Palantir 는 도그푸딩 — 실행 중인 서비스 == 편집 중인 코드. 맥에서 서비스를 띄우면 코드
> 편집/재시작/테스트와 충돌. 그래서 운영 인스턴스를 **Raspberry Pi(항상 켜짐)** 로 떼어내되, 무거운
> 실행(워커/PM/worktree/harvest/fs)은 **맥 및 여러 이기종 원격 머신에서 동시다발로** 돌린다.
> 미래엔 강력한 머신에 Palantir 를 설치해 **control+execution 을 co-locate** 하는 경우의 수도 열어둔다.
>
> **r2 핵심 변경 (Codex r1)**:
> - **P0 는 순수 리팩터 아님** (BLOCKER): Claude 워커는 `executionEngine` 을 우회해 `streamJsonEngine`
>   으로 spawn (`lifecycleService.js:571/620`). worktree 는 sync/throw `execFileSync` 인데 제안한
>   `executor.exec` 는 `{code,stdout,stderr}` 반환 → 반환 shape·동기성 불일치. P0 를 **(P0a) 로컬
>   executor + compat shim(throw/stdout/sync 의미 보존)** 과 **(P0b) 호출부 async 이관** 으로 분리.
> - **worktree fail-close 는 lifecycleService 도 고쳐야 성립** (BLOCKER): 폴백은 `worktreeService`
>   뿐 아니라 `lifecycleService.js:547/564` 의 `worktreePath || projectDir` 에도 있음. `isGitRepo` 를
>   **tri-state**(git / non_git / unknown-error) 로. git·unknown → cwd 해석 전에 run fail.
> - **큐/drain·claim 을 node 축으로** (BLOCKER): `countRunning`/`getOldestQueued`/claim 이 전부
>   profile-only (`runService.js:136/140/151`), retry 새 run 이 node 미복사 (`lifecycleService.js:847`).
>   node 를 claim/FIFO 에 포함, unreachable node 큐가 **다른 node 의 같은 profile FIFO 를 막지 않게**.
> - **매니저 배치 = defer 불가** (BLOCKER): `/api/manager/start` 는 로컬 spawn (`routes/manager.js:490`),
>   PM lazy spawn 은 active Top 없으면 거부 (`pmSpawnService.js:172`), Claude Top 은 persistent stdin
>   (`streamJsonEngine.js:63/466`, CLAUDE.md:316). Pi 가 CLI 0개면 **매니저도 노드에서 실행**해야 함 →
>   `default_manager_node_id` 도입, 원격 워커 수용보다 먼저. ⟶ **[USER LOCK B]**.
> - SERIOUS: Codex PM thread 는 node-sticky(resume 에 `-C` 없음 `:284`) → `pm_thread_node_id`+원 cwd
>   영속. health tri-state(alive/dead/unreachable, dead 만 terminal). 로컬 side-channel 누락
>   (`/api/runs/:id/diff`, `/api/fs`, harvest cleanup) 라우팅 인벤토리에 추가. pathGuard 는 prefix
>   문자열이라 약함 → `executor.realpath` canonical 비교 + symlink fail-closed. "secret not in argv"
>   는 현재 거짓(`codexMcpFlatten` env 가 argv, tmux 가 env 를 temp script 로) → "same-user/disk 가시"
>   와 구분. migration 은 CHECK/trigger/index 강화.

---

## 1. 현재 코드 사실 (설계 입력)

모든 실행/repo 레이어가 **로컬 호스트 가정**. "맥 파일에 묶인 코드" 는 워커 spawn 하나가 아니라 넓다:

- **interactive process engine seam**: `createExecutionEngine()` 팩토리 (`executionEngine.js:379/389`).
  tmux 엔진 실제 계약 = `spawnAgent(runId,{command,args,cwd,env})` / `getOutput` / `sendInput` /
  `kill` / `isAlive` / `detectExitCode` **+ `listSessions` + `discoverGhostSessions`**
  (`:221`). remote 구현은 **이 full contract(발견 포함)** 를 만족해야 한다 (NIT: "5-method" 부정확).
- **Claude 워커는 이 엔진을 우회**: `profile.command` 에 `claude` 포함 시 `streamJsonEngine` 으로 직접
  spawn (`lifecycleService.js:571/620`). → 원격화 스코프에 **Claude 워커 경로 포함 필수** (executionEngine
  만 바꾸면 Claude 워커는 여전히 로컬).
- **worker cwd + worktree fallback (2군데)**: `worktreeService.createWorktree` 가 비-git →
  `{path:projectDir}` (`:64`), `worktree add` 실패 → projectDir (`:115`). 그리고 `lifecycleService`
  가 `worktreePath || projectDir` 로 spawn (`:547/:564`). **폴백은 두 파일 모두에 있다.**
- **worktree API 는 sync/throw**: `execFileSync(..., {cwd})` (`worktreeService.js:30/47/100`). 제안한
  async `executor.exec` 와 **반환 shape·동기성 불일치** → compat shim 없이는 P0 동작 불변 깨짐.
- **harvest**: autosave/diff/test/remove 로컬 cwd + 로컬 spawn/node 해석 (`harvestService.js:346/404`).
- **로컬 side-channel (라우팅 인벤토리 누락분)**: `/api/runs/:id/diff` 가 로컬 `fs.existsSync`+`git diff`
  (`routes/runs.js:293/343`, 단 realpath 가드 `:312` 는 참고 패턴), `/api/fs` 가 로컬 경로
  (`routes/fs.js:14`, `fsService.js:7`).
- **PM (Codex)**: `codexAdapter` 가 `system_prompt.md` 를 로컬 temp 에 쓰고(`:193`) thread/cwd 를 메모리에
  보관(`:207`), `-C <cwd>` (`:291`). **resume 은 `-C` 안 받음** → 원 cwd 상속(`:284`) = **thread node-sticky**.
  PM resume 은 `project_briefs.pm_thread_id`+현재 project dir 만 읽음 (`routes/manager.js:178/213`).
- **Top/PM (Claude)**: `streamJsonEngine` persistent stdin (`:63/293/466`), stdin 상시 open (CLAUDE.md:316).
  `/api/manager/start` 는 어댑터를 **로컬 spawn** (`routes/manager.js:490`). PM lazy spawn 은 **active
  Top 없으면 거부** (`pmSpawnService.js:172`). → 매니저는 로컬 가정에 깊게 묶임.
- **auth / secret argv 누수**: keychain 탐지 macOS 로컬 전용 (`authResolver.js:64`), isolated auth
  secret 임시파일 로컬 (`:420`). **`codexMcpFlatten` 은 MCP env 를 argv 로** 흘려 process listing 노출
  (`codexMcpFlatten.js:35`, CLAUDE.md:225). tmux 엔진도 env export 를 temp script 로 씀
  (`executionEngine.js:64/70`). → "secret not in argv" 는 지금도 거짓.
- **B-lite 큐/drain**: `countRunning` running-only·**profile-only** (`runService.js:136`),
  `getOldestQueued` profile-only (`:140`), claim id/status만 (`:151`). retry = 새 run, **node 미복사**
  (`lifecycleService.js:847`).
- **runs / projects 스키마**: 둘 다 **node_id 없음**. runs 는 로컬 실행 핸들(tmux_session/worktree_path/
  branch/claude_session_id) 저장, 실행 노드 정체성 없음.
- **lifecycle health**: `isAlive` false → 바로 terminal (`:938/941`). process 활성은 로컬 `tmux`/`ps`
  셸아웃 (`:51/57`). orphan 복구는 글로벌 engine type==tmux 일 때만 (`:1107`).
- **migration 러너**: FK ON + 파일별 transaction (`database.js:17/42`). 최근 migration 은 rebuild/CHECK/
  trigger 로 불변식 강제 (`022:21/47`, `042:19`). 최신 = **044** → 다음 045.
- **SSE**: server 채널은 `SERVER_EMITS` (`eventChannels.js:42`), 클라 구독은 hard-coded (`sse.js:62`),
  둘 다 갱신해야 (CLAUDE.md:308). `sse-channels.test` 로 검증.
- **spawnGuard**: 테스트 중 실제 spawn fail-closed (`spawnGuard.js:98`). remote 도 **fake executor** 로.

## 2. 목표

1. **머신을 1급 `node` 로** — 레지스트리(connection, capability, exposed roots, health).
2. **프로젝트 → 노드 바인딩(1:1)** — worktree/harvest/spawn/fs 가 그 노드에서 해석.
3. **다중 이기종 노드 동시 사용** — 서로 다른 프로젝트가 서로 다른 노드에서 병렬, per-node 동시성.
4. **실행/파일 접근을 단일 `NodeExecutor` seam 으로** — 흩어진 로컬 명령을 수렴, **local 먼저**.
5. **미래 co-located 강력머신 무손실** — abstraction 이라 그 머신 설치는 자기 `local` executor 로.
6. **노드 offline 안전** — unreachable 엔 dispatch 안 하고 queued 유지, online 시 drain.
7. **매니저 배치 명시** — Pi 는 CLI 0개 → 매니저(Top/PM)를 `default_manager_node_id` 에서 실행.

## 3. Lock-in

1. **노드 선택 = 프로젝트→노드 1:1** (`projects.node_id`). 동시성은 "다른 프로젝트 다른 노드". 단일
   프로젝트 cross-node 로드밸런싱 = 비범위(§5).
2. **NodeExecutor = transport-agnostic**. v1 remote = **SSH over Tailscale**(push). outbound-pull 러너는
   문서화된 future. ⟶ **[USER LOCK A]** (같은 tailnet 이면 SSH-push 의 NAT 약점 소거, 현재 규모 권장).
3. **per-node 동시성/drain** — `countRunningOnNode(nodeId,profileId)` / `getOldestQueuedOnNode` /
   `claimQueuedRunOnNode`. **retry 새 run 은 node_id 복사**. **unreachable node 큐는 다른 node 의 같은
   profile FIFO 를 막지 않는다**(node 별 독립 큐). queued 는 슬롯 비점유(B-lite #3 유지).
4. **worktree fail-closed (2군데)** — `isGitRepo` tri-state(git/non_git/unknown-error). **git·unknown →
   cwd 해석 전에 run failed** + `worktree:create_failed` event. `worktreeService` **와** `lifecycleService`
   의 `|| projectDir` 폴백 **양쪽 제거**. non-git shared-dir 실행은 **DB 에 저장된 명시적 project opt-in**
   시에만, run event/snapshot 에 기록.
5. **실행 대상 3계층** — phase 분리:
   - (a) git/fs/diff **단발** (worktree 생성, `/runs/:id/diff`, `/api/fs`, harvest 명령) — stateless.
   - (b) **워커 run** (Claude Code/Codex CLI, tmux) — 장수명. **Claude 워커(streamJsonEngine 경로) 포함**.
   - (c) **Claude Top/PM persistent** (`streamJsonEngine`, stdin 상시) — 별도 phase. Codex 매니저(per-turn)
     는 (c) 중 쉬운 쪽.
6. **매니저 배치** ⟶ **[USER LOCK B]**: Pi 는 CLI 0개. 매니저(Top/PM)는 `default_manager_node_id` 노드에서
   Pi 가 NodeExecutor 로 spawn. **near-term = Codex 매니저(per-turn, executor.exec 친화) 우선(P4)**,
   Claude Top persistent 는 P5. → **P0~P3 는 원격 워커 실행 + 상태/큐/UI 를 제공하고, 매니저 자율 루프는
   P4 부터** (Codex 대안: "P0-P3 는 수동 워커 실행만" 을 정직히 명시한 것과 동일).
7. **이벤트 cardinality**: 신규 SSE 채널 = **`node:status` 1개만** (라이브 노드 헬스 UI 용) — `sse.js`
   channels + `eventChannels.js` SERVER_EMITS + `sse-channels.test` 동시 갱신. `node:reachable`/
   `node:unreachable`/`node:drain` 등은 **run/node event type**(기록), SSE 채널 아님.
7. **Mode P (파일을 Pi 로 pull) 비범위**. Mode R(run-on-node)만.
8. **secret 격리 정직화** — "not in argv" ≠ "same-user/process/disk 불가시". **원격 노드엔 secret-bearing
   MCP `env` 금지**(argv 노출), node-preprovisioned CLI auth 선호, `putSecretFile` 은 mode 0600 +
   lifecycle(사용 후 삭제) 명시.

## 4. 구현 지침

### 4.1 DB — migration 045 (CHECK/trigger/index 강화)
```sql
CREATE TABLE nodes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'local' CHECK (kind IN ('local','ssh')),
  can_execute    INTEGER NOT NULL DEFAULT 1 CHECK (can_execute IN (0,1)),
  can_control    INTEGER NOT NULL DEFAULT 0 CHECK (can_control IN (0,1)),
  files_only     INTEGER NOT NULL DEFAULT 0 CHECK (files_only IN (0,1)),
  is_manager_node INTEGER NOT NULL DEFAULT 0 CHECK (is_manager_node IN (0,1)), -- default_manager_node
  ssh_host       TEXT,
  ssh_user       TEXT,
  exposed_roots  TEXT,   -- JSON string[]; ssh 행은 필수·유효 JSON 배열
  max_concurrent INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrent >= 0),
  last_heartbeat_at TEXT,
  reachable      INTEGER NOT NULL DEFAULT 0 CHECK (reachable IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- files_only 와 can_execute 는 상호배타 (coherence)
  CHECK (NOT (files_only = 1 AND can_execute = 1)),
  -- ssh 는 host/user 필수
  CHECK (kind <> 'ssh' OR (ssh_host IS NOT NULL AND ssh_user IS NOT NULL AND exposed_roots IS NOT NULL))
);
INSERT INTO nodes (id,name,kind,can_execute,can_control,is_manager_node,reachable)
  VALUES ('local','Local','local',1,1,1,1);   -- 기존 동작 = local 노드로 보존

-- exposed_roots 가 유효 JSON 배열인지 강제하는 trigger (022/042 패턴)
-- INSERT/UPDATE 시 ssh 행에 대해 json_valid + json_type='array' 확인 (fail-closed)

ALTER TABLE projects ADD COLUMN node_id TEXT REFERENCES nodes(id);  -- NULL → 'local'
ALTER TABLE runs     ADD COLUMN node_id TEXT REFERENCES nodes(id);  -- spawn 시점 스냅샷
CREATE INDEX idx_projects_node ON projects(node_id);
CREATE INDEX idx_runs_node_drain ON runs(node_id, agent_profile_id, status, created_at);

-- 매니저 thread node affinity (SERIOUS): project_briefs 확장 or 신규 테이블
ALTER TABLE project_briefs ADD COLUMN pm_thread_node_id TEXT REFERENCES nodes(id);
ALTER TABLE project_briefs ADD COLUMN pm_thread_cwd TEXT;  -- resume 가 -C 못 받으므로 원 cwd 보존
```
- **default_manager_node**: `is_manager_node=1` 유일성은 서비스 레벨(or partial unique index)로 강제.
- **rebind 안전**: `project.node_id` 변경 시 살아있는 pm_thread 가 있으면 **reset 요구**(orphan 방지).

### 4.2 `nodeService` + `NodeExecutor` (full contract)
- `nodeService`: nodes CRUD, `resolveNode(projectId)`(project.node_id || 'local'),
  `resolveManagerNode()`(is_manager_node), heartbeat/reachable, `pickExecutor(nodeId)`.
- **`NodeExecutor` 계약** (transport-agnostic, 발견·tri-state 포함):
  - `exec(command,args,{cwd,env,timeoutMs})` → `{code,stdout,stderr}` ((a)계층)
  - `spawnInteractive` + `getOutput/sendInput/kill/detectExitCode` ((b)계층)
  - **`liveness(runId)` → `'alive'|'dead'|'unreachable'`** (health tri-state)
  - **`listSessions()` / `discoverGhostSessions()`** (orphan 복구, 노드별)
  - `realpath / fileExists / readFile / writeTempFile / readdir / rmrf`
  - `putSecretFile(path,content,mode=0o600)` + 사용 후 삭제 훅
- **`LocalNodeExecutor`**: 위를 로컬로 구현. **P0a 에서 compat shim**(sync/throw 경로는 sync 유지,
  stdout 의미 보존)으로 전 경로 통과 — 동작 불변.
- **`RemoteSshNodeExecutor`**: `ssh` exec / `ssh tmux` interactive / `ssh 'cat >'`·sftp 파일. 모든
  경로 `realpath` 후 canonical `exposed_roots` 비교, **symlink escape fail-closed**.

### 4.3 호출부 라우팅 인벤토리 (완전판 — SERIOUS 반영)
`worktreeService`(생성/제거/diff), `harvestService`(autosave/diff/test/remove/cleanup),
`fsService` + `routes/fs.js`, `routes/runs.js`(`/:id/diff`), `lifecycleService` **워커 spawn(2경로:
executionEngine + streamJsonEngine)** + worktree cwd + stale worktree cleanup, `codexAdapter`(instruction/
MCP temp → `putSecretFile`, `-C` 노드 경로), 매니저 spawn(`routes/manager.js`, `pmSpawnService`).

### 4.4 P0 분할 (BLOCKER — 순수 리팩터 아님)
- **P0a**: `NodeExecutor` 인터페이스 + `LocalNodeExecutor` + **compat shim**. 호출부는 여전히 sync/throw
  의미로 동작(동기 경로는 shim 이 sync 반환). 회귀 그린 = 동작 불변 증명.
- **P0b**: 호출부 async 이관(필요한 곳만) + Claude 워커 경로(streamJsonEngine)를 executor 라우팅에 편입.
  각 단계 회귀 그린.

### 4.5 per-node 동시성/drain (B-lite 확장, BLOCKER)
- enqueue 시 `run.node_id = resolveNode(projectId)` 스냅샷. `createRetryRun` **node_id 복사**.
- `countRunningOnNode`/`getOldestQueuedOnNode`/`claimQueuedRunOnNode`(CAS 에 node 포함).
- run:ended drain 을 **node 별**로. `node.reachable && countRunningOnNode < node.max_concurrent` 동안
  그 노드 oldest queued spawn. **unreachable node skip, 다른 node 는 계속 drain**(starvation 차단).
- boot drain 을 node 별로 (Top→PM 순서 유지).

### 4.6 health / offline (tri-state, SERIOUS)
- `liveness` tri-state: **`dead` 만 terminal 전이 허용**. `unreachable` → run 은 stale(running) 유지.
- 노드별 heartbeat probe(`exec('true')`/`ssh -O check`) → reachable + `node:status`.
- **노드별 ghost discovery**: boot + reachable false→true 전이에 `discoverGhostSessions()`로 재접속/정리.
- reattach 성공 → drain 재개. tmux 부재 확정 시에만 stale→retry.

### 4.7 보안 (SERIOUS)
- `exposed_roots`: **`executor.realpath` canonical 비교**(prefix 문자열 금지), symlink fail-closed.
  worktree 제거 경로도 canonical 화 (`worktreeService.js:195` 강화).
- per-node **command allowlist**(기존 에이전트 allowlist 계승).
- secret: 원격 노드 secret-bearing MCP `env` **금지**, `putSecretFile`(0600)+삭제, node-preprovisioned
  CLI auth 선호. Tailscale ACL 로 Pi→node 방향만. `ssrf.js` 사설 IP 허용 = 등록 노드 host 한정.

## 5. 비범위 (v1)

| 항목 | 이유 |
|---|---|
| Mode P (파일을 Pi 로 pull 실행) | 복잡도 배증 + ARM 느림 |
| 단일 프로젝트 cross-node 로드밸런싱 | 프로젝트→노드 1:1 로 시작 |
| Claude Top persistent 원격화 (c계층) | 별도 phase P5 |
| outbound-pull 러너 transport | 인터페이스만 열어둠 |
| 노드 auto-discovery / secret 자동 provisioning | 수동 등록, 노드 CLI 선로그인 가정 |
| files-only 노드 원격 편집 | capability 컬럼만 예약 |

## 6. 수용 기준

1. `local` 시드 + node_id NULL 프로젝트 **동작 불변** (P0a 회귀 그린).
2. ssh 노드 바인딩 → 워커가 원격 worktree 에서 실행, diff/harvest 도 그 노드, `runs.node_id` 스냅샷.
3. **다른 프로젝트가 다른 노드에서 동시 실행**, per-node 동시성 독립.
4. worktree 생성 실패 → **폴백 없이 failed**(`worktree:create_failed`), `worktreeService`+`lifecycleService`
   양쪽. 원격 메인 체크아웃 오염 0. non-git 은 DB opt-in 시에만 실행.
5. 노드 unreachable → 그 노드 dispatch 정지·queued 유지, **다른 노드/같은 profile 은 계속 drain**.
6. 원격 워커 노드 sleep 중 = `unreachable` → **failed 로 안 내려감**, 복귀 시 reattach, tmux 부재 시만 retry.
7. Codex PM 원격 spawn(instruction 파일 노드 배치) + resume 시 같은 노드 affinity(`pm_thread_node_id`).
   project rebind 시 살아있는 thread 면 reset 요구.
8. secret 이 argv/로그/원격 process listing 에 노출 0. exposed_roots 밖·symlink escape 경로 거부.
9. 매니저 배치: `default_manager_node` 에서 (P4 Codex) spawn, Pi 는 CLI 0개.
10. 미래 co-located: `can_control=1,can_execute=1` 노드 설치 시 local executor 실행 (P0~P1 만으로).
11. 전체 `node --test` 그린 + 신규 `node-executor.test.js`/`fleet-routing.test.js`(**fake executor**).

## 7. 테스트 지침
- **fake NodeExecutor** 주입 — 실 SSH 0. 라우팅·큐·헬스 전이 검증(spawnGuard 철학).
- 케이스: P0a 동작 불변 / project→node 라우팅 / per-node 동시성(A max, B 자유) / **unreachable A 가 B 의
  같은 profile drain 안 막음** / worktree fail-closed(2경로 폴백 0) / liveness tri-state(unreachable≠dead) /
  run.node_id 스냅샷 + retry 복사 / exposed_roots realpath·symlink escape 거부 / secret argv 미노출 /
  Claude 워커 경로도 executor 라우팅 / PM thread node affinity + rebind reset.
- 회귀: `worktree`/`harvest`/`preset-spawn`/`manager-lifecycle`/`queue`/`sse-channels`.

## 8. 구현 순서 (r2 — 불변식·claim·fail-closed·매니저배치 front-load)

- **P0a — local executor + compat shim** (동작 불변): 인터페이스 + LocalNodeExecutor + 호출부 통과
  (sync/throw 보존). 회귀 그린.
- **P1 — migration 045 불변식 + 노드 레지스트리** (CHECK/trigger/index) + `#nodes` CRUD + project 바인딩 +
  **worktree fail-closed(2경로)** + per-node queue/claim 스키마(node_id, *OnNode).
- **P0b — 호출부 async 이관 + Claude 워커 경로 편입** (executor 라우팅 완결).
- **P2 — RemoteSshNodeExecutor (a)계층**: 원격 git/fs/diff/harvest, realpath 가드. fake→실 노드 스파이크.
- **P3 — 원격 워커 (b)계층**: 원격 tmux spawn + tri-state health + 노드별 ghost discovery + per-node drain.
- **P4 — 매니저 배치**: `default_manager_node` + Codex Top/PM 원격(putSecretFile, node affinity).
- **P5 — Claude Top/PM persistent (c)계층**: 별도 브리프(persistent SSH 채널 or 얇은 relay).

## 9. 오픈 결정 (사용자 확인)

- **[USER LOCK A] transport 기본값** = SSH over Tailscale(push). outbound-pull 러너 future. 확인 필요.
- **[USER LOCK B] 매니저 배치** = `default_manager_node` 에서 매니저 실행(Pi CLI 0개), 자율 매니저 루프는
  P4 부터. 대안: Pi 에서 매니저만 예외 실행(단순하나 ARM-heavy + 미감 위배). **확인 필요(BLOCKER 승격).**
- **[OPEN Q3] 노드 auth provisioning**: v1 = 노드 CLI 선로그인 가정. Pi→node secret push 는 별도 설계.

## 10. Codex r1 spec review 처리 기록

| 판정 | 내용 | r2 처리 |
|---|---|---|
| BLOCKER | P0 순수 리팩터 아님 (Claude 워커 streamJsonEngine 우회, worktree sync/throw vs async exec) | §r2요약·§4.4 P0a/P0b 분할 + compat shim + Claude 워커 스코프 포함 |
| BLOCKER | worktree fail-close 는 lifecycleService(`:547/564`)도 고쳐야 | §3 lock-in #4 tri-state + 2경로 폴백 제거 |
| BLOCKER | 큐/claim/retry 가 profile-only, node 미포함 | §3 #3 + §4.5 *OnNode + retry node 복사 + unreachable 격리 |
| BLOCKER | 매니저 배치 defer 불가 (Pi CLI 0개) | §3 #6 [USER LOCK B] default_manager_node, P4 front |
| SERIOUS | Codex PM thread node-sticky (resume `-C` 없음) | §4.1 pm_thread_node_id+cwd, rebind reset |
| SERIOUS | health 로컬 가정 (isAlive→terminal) | §4.6 liveness tri-state, dead 만 terminal, 노드별 ghost |
| SERIOUS | 로컬 side-channel 누락 (`/runs/:id/diff`, `/api/fs`, harvest) | §4.3 라우팅 인벤토리 완전판 |
| SERIOUS | pathGuard prefix 문자열 약함 | §4.7 realpath canonical + symlink fail-closed |
| SERIOUS | "secret not in argv" 현재 거짓 (codexMcpFlatten env argv, tmux temp script) | §3 #8 정직화 + 원격 secret env 금지 + putSecretFile lifecycle |
| SERIOUS | migration 045 loose | §4.1 CHECK/trigger/index (kind/reachable/coherence/exposed_roots json/ssh 필수) |
| NIT | SSE 규칙 명시 | §3 #7 node:status 만 SSE, 3파일 동시 갱신 |
| NIT | "5-method seam" 부정확 | §1 full contract(+listSessions/discoverGhostSessions) |
