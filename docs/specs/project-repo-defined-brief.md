# Project Repo-Defined 재정의 (C안) — brief

> v1.0 LOCKED (2026-07-05). Codex 분석·계획(R1) → Claude 적대 리뷰(REVISE: 3 BLOCKER/SERIOUS
> load-bearing 결정 미결 + 3 SERIOUS + 3 NIT) → Codex R2 개정(6개 결정 확정) → Claude R2 검증 GO.
> 워크플로우: Codex 가 계획, Claude 가 리뷰 (사용자 지정). 구현은 별도 트랙 — 트리거 시 착수.
> 관련: `node-first-board-brief.md`(N 트랙, 완료), `fleet-remote-nodes-brief.md`(r4).
>
> **✅ 전 구현 완료 (2026-07-06, PR #323~#330 + #324)**: PR1 schema(#323/#324) · PR2 API+preflight·PR6 UI(#325)
> · PR3 로컬 materialize+queue(#326, Codex 5R) · PR4 MCP source split(#327) · PR5 Operator 통합+reset guard(#328)
> · PR5a 원격 clone/auth(#329, 보안 R3 GO + 실 Pi spike 6/6) · **PR5b 원격 worker cwd = PR5a+PR3 로 배선(별도 PR
> 불필요)** · PR5c 원격 harvest/diff/test(#330, R2 GO + 실 Pi spike 6/6) · PR7 cleanup/rollback 테스트+docs.
> flag `PALANTIR_PROJECT_REPO` 기본 ON(#333; `=0` 으로 rollback). 실 Raspberry Pi 로 원격 clone/materialize/harvest 실증.
> **남은 것(선택)**: PR5a-2 controller-token askpass 2순위(현재 node-local auth only, 부재 시 fail-closed).

## 0. 방향 (사용자 확정)

프로젝트를 **folder-bound → repo-defined 로 재정의**한다. 현재 `projects.directory`(단일 절대경로) +
`node_id`(단일 바인딩) 는 "프로젝트 = 특정 머신의 특정 폴더" — directory 가 머신 종속 문자열이라
로컬(`/Users/K/…`)과 원격 Pi(`/home/karnian/…`)에서 같은 프로젝트가 다른 경로인데 컬럼이 하나뿐이라
노드 간 이동·멀티노드가 불가능하다. **C안**: 프로젝트 = **코드베이스(git repo/remote 식별자)**,
폴더는 **각 노드가 실행 시점에 materialize(clone/fetch/worktree)** 하는 파생물로 강등. CI 러너
(GitHub Actions/Buildkite) 모델 — 잡은 레포를 선언하고 러너가 자기 워크스페이스에 체크아웃한다.

## 1. 핵심 결정 (R2 에서 확정 — 되돌리지 말 것)

1. **materialize 타이밍 = worker slot claim 이전.** repo run 은 `queued → materializing → queued(ready)
   → running`. `materializing` 은 worker 프로세스가 없으므로 `running` 카운트에 넣지 않는다
   (`countRunning*` 은 계속 `status='running' AND is_manager=0`). `started_at` 은 worker claim 에서만
   기록(materialize 시작은 `materialize_started_at`) → materialize 실패는 `started_at` null 유지라
   B-lite 자동 retry 가 중복 attempt 를 안 만든다. materializer 는 별도 동시성
   (`max_materializing_per_node`/`_global`)으로 제한 — 느린 clone 이 worker 슬롯을 고갈시키지 않음.
2. **동시성 = (project,node,source_generation) single-flight lease.** `project_materialization_leases`
   partial unique index + CAS + token-guarded release + stale TTL steal — `memory_jobs`(027)와 동일
   클래스. 승자만 clone/fetch, 패자는 cache ready 대기. cache ready 후 per-run worktree 는 run-id
   유니크라 병렬 (git lock 은 bounded jitter retry).
3. **GC = refcount lease.** worker/Operator cwd 마다 `project_workspace_refs` 획득. GC 는 (활성
   materialization lease 없음 ∧ 미해제 ref 없음 ∧ 그 경로를 가리키는 live run 없음 ∧ live Operator
   메타 없음 ∧ `git worktree list` 에 live worktree 없음 ∧ LRU/size 선정) 전부일 때만 cache repo 삭제.
   만료 ref 는 health/boot 재조정으로 run/operator terminal 확인 후에만 해제. **원격 노드 unreachable
   이면 `git worktree list` 검증 불가 → GC 보수적 skip.**
4. **live Operator repo/ref 변경 = 강제 reset.** `repo_url/ref/subdir/mcp_relpath/source_generation`
   변경은 stored thread 또는 live Operator 존재 시 **409** (node rebind 가드와 동일 클래스,
   `projectService.js:173,185`). persistent Operator(P5 stream-json)와 Codex resume 은 cwd 고정
   (`codexAdapter.js:360` resume 은 `-C` 없이 cwd 상속)이라 변경 시 cwd 가 사라짐. boot resume 은
   stored generation/cwd 가 현재 source 와 일치할 때만.
5. **mcp_config = 2 source.** `legacy_control_plane_path`(기존 절대경로, control-plane FS 읽기 유지 —
   legacy 로컬·원격 모두 동작, source 가 명시적으로 controller-local) vs `repo_relpath`(워크스페이스
   상대경로, `.json`·비절대·`..` 금지 — 원격이면 `executor.readFile` 로 pod 워크스페이스에서 읽어
   boundary 검증 후 control-plane 이 파싱·flatten). codex 는 flatten 된 객체를 받으므로 pod 파일
   경로 불요 (`codexMcpFlatten`). N2 의 control-plane mcp 결정은 legacy source 로 보존.
6. **legacy 원격 directory 보존.** N 트랙(P4/P5 + N0~N3)에서 **실 Raspberry Pi 로 검증·배포한
   `legacy_directory + remote node + directory=/home/…`** 를 깨지 않는다. `nodeBindingValidator` 는
   legacy directory 의 hard validator 로 유지. local-only 제한 없음. 기존 Pi 프로젝트는 명시적
   "promote to repo" 전까지 `legacy_directory`.

기타 확정: `repo_url` **비유일**(같은 repo 다중 프로젝트 허용, identity=project id) / repo preflight
(`git ls-remote` 류)는 create/update/retarget 시 **필수**(N2 즉시검증 UX 보존) / PR5 는 5a·5b·5c
sub-slice. **`materializing` 추가는 runs.status CHECK 부재 → 테이블 rebuild 불필요, VALID_STATUSES +
ALLOWED_TRANSITIONS(JS) 편집만** (N0-1 tasks.status 와 다름). v050 은 컬럼·테이블만 additive.

## 2. 데이터 모델 (v050, additive)

**projects 추가**:
- `source_type TEXT CHECK(source_type IN ('git','legacy_directory')) DEFAULT 'legacy_directory'`
- `repo_url TEXT`, `repo_ref TEXT DEFAULT 'HEAD'`, `repo_subdir TEXT`, `repo_remote_fingerprint TEXT`
- `source_generation INTEGER NOT NULL DEFAULT 0`
- `last_repo_preflight_at TEXT`, `last_repo_preflight_error TEXT`
- `mcp_config_source TEXT CHECK(IN ('legacy_control_plane_path','repo_relpath')) DEFAULT 'legacy_control_plane_path'`, `mcp_config_relpath TEXT`
- 기존 `directory`/`mcp_config_path`/`allow_non_git_dir` 는 `legacy_directory` 에서 계속 유효.

**runs.status**: `materializing` 추가 = JS(VALID_STATUSES+VALID_TRANSITIONS) **+ DB CHECK rebuild**(v050 이
runs 재생성해 CHECK 에 포함 — 045/046 미러). 전이 `queued→materializing`, `materializing→{queued,failed,
cancelled,stopped}`. `countRunning*` 불변(running-only). `countLiveOperatorRuns` live set 에 `materializing` 포함.

**runs 추가 (durable workspace)**: `source_type_snapshot`, `source_generation`, `repo_url_snapshot`,
`repo_ref_snapshot`, `repo_subdir_snapshot`, `repo_cache_path`, `workspace_path`, `workspace_generation`,
`resolved_commit`, `materialize_attempts`, `materialize_run_after`, `materialize_started_at`,
`materialize_claim_token`, `materialize_last_error`, `workspace_ref_released_at`.
(현행 in-memory `_runProjectDirs`(`lifecycleService.js:76`) 대체 — 재시작/삭제 견고.)

**신규 테이블**:
- `project_node_workspaces(project_id, node_id, source_generation, repo_url, repo_ref, resolved_commit, repo_cache_path, status, last_error, materialized_at, last_used_at)` — cache/truth 아님, truth 는 projects.repo_*.
- `project_materialization_leases(id, project_id, node_id, source_generation, status, claim_token, locked_at, owner_run_id, attempts, last_error)` + partial unique `(project_id,node_id,source_generation) WHERE status IN ('pending','running')`.
- `project_workspace_refs(run_id, project_id, node_id, source_generation, repo_cache_path, worktree_path, ref_type, acquired_at, heartbeat_at, released_at, expires_at)`.

**project_briefs 추가**: `pm_thread_source_generation`, `pm_thread_source_hash`, `pm_thread_workspace_path`
(`pm_thread_cwd` 는 047 에 존재). Codex resume 이 cwd 못 바꾸므로 이 메타 비교로 generation 불일치 감지.

## 3. Materialize 메커니즘

`projectMaterializationService.ensureWorkspace({ project, nodeId, runId })`:
1. `executeTask` 는 오늘처럼 `queued` 생성.
2. drain 이 workspace 필드 없음/stale 인 repo run 발견 → `queued→materializing` CAS(started_at 미설정).
3. materializer: cache repo 확보(없으면 clone, 있으면 fetch) → commit resolve → per-run worktree 생성 →
   run durable 필드 저장. workspace root = local `PALANTIR_WORKSPACES||~/.palantir/workspaces`,
   remote `node.workspace_root` 또는 `exposed_roots[0]/.palantir-workspaces`. path slug =
   project_id+fingerprint+ref (traversal 문자 금지). **remote 는 clone target parent+target 을
   `executor.assertWithinRoots` 로 검증** (exec cwd guard 만으론 git target arg 미보호).
4. 성공 → `materializing→queued(ready)` + `materialize:ready` emit + drain 예약.
5. `claimQueuedRun` 에 repo guard: source_type='git' 은 current workspace_generation/workspace_path/
   resolved_commit 필수 (generation 불일치 → 재materialize).
6. `canMaterializeOnNode`(reachable ∧ !cordoned ∧ executable ∧ materializer 동시성) — nodes.max_concurrent
   미소비. `getOldestQueuedOnNode` 는 `materialize_run_after` 미래분 제외 + ready 우선.
7. `queue:stuck` 은 `queue_entered_at` 기준(장기 materialize 가 false stuck 만들지 않게). 신규
   `materialize:stuck` sweep 이 stale materializing/lease 처리.

**git auth**: 1순위 node-local(deploy key/GH auth/credential helper) — controller token 반출 0.
2순위 controller token 은 `putSecretFile` one-shot askpass 만(URL/argv/env/log/DB/run event 금지),
clone/fetch 후 삭제. `repo_url` 은 credential 금지(저장 전 reject). `GIT_TERMINAL_PROMPT=0`. 전 git 호출 argv array.

## 4. 마이그레이션 전략 (helper→persisted→producer→consumer→cleanup)

1. `ProjectSource`/`WorkspaceResolver` 인터페이스 (초기 legacy directory 동작만 — 무변경).
2. v050 스키마 (§2).
3. repo API 검증 + **필수 preflight**. 기존 directory create/update 유지.
4. **legacy_directory + remote 보존** — nodeBindingValidator 유지, local-only 제한 없음.
5. 로컬 repo materialization **feature flag** 뒤 활성(예 `PALANTIR_PROJECT_REPO=1` 기본 off). legacy 는 현행 경로.
6. consumer 를 resolver 로: lifecycle/Operator/harvest/diff/UI 라벨.
7. live Operator source-change 409 guard (§1-4).
8. remote materialization 슬라이스 (5a/5b/5c). repo 프로젝트는 shared-dir 실행 금지, legacy 만 유지.
9. cleanup: UI 기본 legacy 숨김, 컬럼·지원 유지(flag 로 repo 비활성 가능, legacy row 무손상).

**promote**: 기존 git directory 프로젝트는 origin/current ref 읽어 "promote to repo" 제안 — 자동 mutating backfill 금지. Pi 원격 directory 는 명시 promote 전까지 legacy.

## 5. PR Phasing

1. **PR1** schema + helper (v050, materializing enum, foreign_key_check clean, 런타임 무변경)
2. **PR2** API 검증 + 필수 preflight (repo fields, repo_url 비유일, target-node git ls-remote, legacy 로컬·원격 불변)
3. **PR3** 로컬 materialization + queue 모델 (queued→materializing→queued→running, 느린 clone 이 max_concurrent 무영향, single-flight=2run 1clone 테스트)
4. **PR4** MCP source split (legacy absolute 유지, repo-relpath executor 읽기, codex flatten 객체, 원격 mocked executor 테스트)
5. **PR5** Operator 통합 + reset guard (fresh cwd=워크스페이스, boot resume generation/cwd 검증, repo/ref/subdir/mcp 변경 시 live reset, codex resume cwd 상속 커버)
6. **PR5a** 원격 clone/auth/preflight (exposed_roots 내부, token argv/env/log/event/DB 부재, stale lease 복구)
7. **PR5b** 원격 worktree/worker cwd (per-run worktree, repo 프로젝트 shared-dir bypass 제거, legacy 원격 directory 불변)
8. **PR5c** 원격 harvest/diff/test 경계 (run.node_id executor + stored workspace path, project.directory 경계 미사용)
9. **PR6** UI 마이그레이션 (repo URL/ref/subdir 기본 폼, directory picker 는 legacy 접힘, node 라벨 "기본 실행 노드")
10. **PR7** cleanup (repo 프로젝트 directory 쓰기 금지, docs/tests, 컬럼 유지, flag 로 비활성)

**rollback**: 각 phase 는 legacy_directory 무손상. repo 프로젝트는 flag 로 비활성 가능(directory row/원격 배포 지속).

## 6. 비범위·리스크·열린 결정

**열린 결정 (구현 착수 시 lock)**:
- `repo_ref='HEAD'` 가 매 run branch head fetch vs 최초 resolved SHA pin (reproducibility).
- shallow/partial/full clone + LFS/submodule 정책.
- node workspace root = 명시 `nodes.workspace_root` 컬럼 vs `exposed_roots[0]/.palantir-workspaces` 파생.
- `max_materializing_per_node` / lease TTL 기본값.
- monorepo `repo_subdir` 가 project identity 일부인지 execution cwd 옵션인지 (어느 쪽이든 source_generation bump).

**리스크**:
- Codex resume cwd 상속 (§1-4 메타 비교로 방어).
- 대용량 repo/오프라인 노드 materialization latency (materializing status 분리로 슬롯 보호).
- cache GC 가 live workspace 삭제 (§1-3 refcount 로 방어).

**비범위**: 단일 프로젝트 cross-node 로드밸런싱 / pod pool (fleet brief v1 비범위 유지).

## 7. N 트랙과의 관계

- **유지**: `runs.node_id` actual placement, 노드 배지, summary, cordon/drain.
- **의미 변경**: `projects.node_id` = "folder binding node" → "기본 실행 노드/affinity". Board filter 라벨 갱신.
- **재작업**: N2 bind-time directory 검증 + N3 retarget directory 검증 → repo 는 materialization preflight 로 대체
  (legacy 는 유지). retarget CAS 는 `status='queued'` 라 `materializing` run 자연 제외.
- **강화**: node rebind 409 가드가 repo/ref/subdir/mcp source 변경까지 확장.
- **N3-2 sweep**: `queue:stuck`(queued cordon/unreachable) 유지 + `materialize:stuck`(stale clone/fetch lease) 신설.
- **compat 요건**: N 트랙 실 Pi 원격 directory 는 폐기 사고가 아니라 요건 — `legacy_directory` 로 유효.

## 8. 리뷰 로그

- **Codex R1 (2026-07-05)**: A~H 구조 초안 (directory 결합 전수 분석 + source_type/repo_* 모델 + materialize
  서비스 + phasing).
- **Claude 적대 리뷰 (REVISE)**: BLOCKER 1(materialize 타이밍/상태 모델 미결 — drain/큐/카운트/sweep 상호작용),
  SERIOUS 5(동시성 lease 부재 / GC refcount 미설계 / live Operator repo·ref 변경 reset / mcp repo-relative ×
  원격 = N2 반전 충돌 / legacy 원격 directory 하위호환 파손 위험), NIT 3(repo_url 비유일 / preflight 필수화 /
  PR5 sub-slice).
- **Codex R2**: 6개 전부 결정으로 확정(§1) + NIT 3 반영.
- **Claude R2 검증 (GO)**: 6 결정 타당성 확인 + 사실 확인으로 단순화 반영 — runs.status 는 CHECK 부재라
  materializing 이 rebuild 불요(JS-only), feature flag 명시, retarget 이 materializing 자연 제외,
  unreachable 노드 GC 보수적 skip. lock-in.
- **정정 (2026-07-05, PR1 구현 중)**: R2 GO 시 "runs.status CHECK 부재 → rebuild 불요"로 판단했으나,
  Codex 가 PR1 에서 runs.status 에 CHECK 존재(045/046)를 검출. v050 은 runs 테이블 rebuild(FK-off,
  materializing CHECK 추가 + 신규 컬럼 동시)로 정정 — N0-1 tasks.status 와 동일 클래스.
