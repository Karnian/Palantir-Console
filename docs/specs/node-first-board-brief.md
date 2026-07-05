# N 트랙 — 노드 퍼스트 작업보드·프로젝트 재기획 (brief)

> v1.2 (2026-07-05) — **Codex R4 GO**. R1(REVISE: 3B+6S+3N) → R2(REVISE: 3B+3S+2N) →
> R3(REVISE: 0B+1S+3N) → R4(GO, 신규 결함 0) 4라운드 적대 리뷰 수렴. 구현 착수는 사용자 lock-in 후.
> 리서치 근거: 코드베이스 4각도 병렬 분석 (task-board / project / scheduling / surfaces) +
> 프라이어아트 2각도 (CI 러너 5종 / 오케스트레이터 UI 7종).
> 관련 spec: `fleet-remote-nodes-brief.md` (r4 LOCKED), `node-usage-brief.md` (v1.1, U 트랙 완결).

## 1. 배경 & 문제 정의

작업보드(BoardView 칸반)·프로젝트 구성(ProjectsView)·대시보드는 전부 **노드 개념 도입(migration 047) 이전 설계**다.
Fleet 트랙으로 실행 계층(Operator/Worker on pod)은 완성됐지만, 계획·관제 계층이 이를 모른다:

- **데이터는 있는데 표면이 없다**: `runs.node_id` 스냅샷, 노드별 동시성 집계 SQL
  (`server/services/runService.js:147-184` countRunningOnNode/countRunningTotalOnNode/getOldestQueuedOnNode),
  reachable/heartbeat 전부 존재. 그러나 프론트엔드에서 node 를 아는 화면은 ProjectsView 배지와
  `#resources/nodes` 뿐 — BoardView/SessionGrid/RunInspector/TaskModals 의 node 참조 **0건**.
- **대기가 불투명하다**: 노드 unreachable/슬롯 포화 시 run 은 무기한 queued 인데
  (`server/services/lifecycleService.js:339-347`), 보드에는 "왜 안 도는지"가 안 보인다. Dashboard
  stats 에는 진짜 queued 카운트가 없다 (`DashboardView.js:21-31` — `stat-queued` 클래스는 이름과
  달리 `needs_input` 값을 렌더, `DashboardView.js:159`).
- **노드 이벤트가 없다**: heartbeat 프로버는 eventBus 미주입 — reachable flip 이 DB 만 갱신
  (`server/services/nodeHeartbeatService.js:1-6,44-46`). 노드가 죽어도 대시보드·알림·webhook 어디에도
  신호 0. `node:*` SSE 채널 부재 (`server/services/eventChannels.js:42-85`,
  `server/public/app/lib/hooks/sse.js:62-74`).
- **스케줄링 실버그**: ① 노드 복구(reachable 0→1)가 어떤 drain 도 촉발하지 않음 — 같은 프로필의
  다른 run 이 끝나거나 서버 재시작 전까지 복구된 노드가 놀고 큐는 잠김 (`nodeHeartbeatService.js:44`
  에 drain 연결 없음; 평시 drain 트리거는 `run:ended` 의 profile-scoped `scheduleDrain` 뿐 —
  `lifecycleService.js:1411`). ② `tasks.status` DB CHECK(001)에 'failed' 누락 —
  `server/services/taskService.js:4` 의 VALID_STATUSES 와 불일치, checkTaskCompletion 의 failed
  전이가 조용히 거부됨 (`lifecycleService.js:1281-1286` catch 가 삼킴), BoardView failed 컬럼
  이동은 서버 에러.
- **프로젝트 구성이 노드를 반쯤만 안다**: `projects.node_id` 단일 바인딩은 있지만 —
  `directory` 와 `mcp_config_path` 는 노드 네임스페이스 없는 단일 TEXT(로컬↔원격 rebind 시 수동
  수정, spawn 시점 exposed_roots 가드가 유일한 검증), ProjectNodeSelect 는 노드 헬스를 안 보여주고,
  rebind 409 ("reset the operator before rebinding") 는 generic toast 로 끝나 액션 유도 없음
  (`ProjectsView.js:411-431`).

## 2. 설계 원칙 (프라이어아트 도출)

5개 CI/오케스트레이션 시스템(GitHub Actions/Buildkite/GitLab/Nomad/K8s) + 7개 오케스트레이터 UI
(Temporal/Airflow/Jenkins/Slurm/Devin/Cursor/Agent HQ) 조사에서 수렴한 패턴:

- **P1. 배치 = 명시 바인딩 + default local. 스케줄러를 만들지 않는다.**
  노드 2~5개 + 프로젝트별 바인딩 환경은 Nomad node_pool / Buildkite queue 계열("명시 지목 +
  default 폴백")과 동형. 라벨 AND 매칭은 이종 대형 플릿용. 워크스페이스가 노드에 귀속되는 잡의
  자동 재라우팅은 프라이어아트상 표준이 아님 (CI 계열 전부 "대기 + 명시적 stuck 사유 + 수동 조치").
- **P2. 대기는 실패가 아니다 — 단, 사유는 항상 보이고, 방치는 sweep 이 잡는다.**
  전 시스템이 매칭 불가 잡을 queued/pending 유지 + 명시 사유(GitLab stuck 배너, Jenkins 시계
  툴팁) + TTL/sweep(GitHub 24h, Buildkite 30d, GitLab StuckCiJobsWorker) 3종 세트로 처리.
- **P3. 연결성 축과 점유 축은 직교.** reachable/stale(연결성) ≠ busy/idle(슬롯 점유) ≠
  cordon(운영자 의도). GitHub Idle/Active/Offline, GitLab online/offline/stale, K8s
  Ready/Unknown + cordon 전부 이 분리를 지킴.
- **P4. 잡→노드 귀속은 1급 배지+링크, 노드→잡은 역링크 드릴다운.**
  모든 시스템이 잡 상세에 실행 노드를 1급 필드로 남기고 링크한다. 한 화면 통합(topology 맵)은
  소규모 플릿에 과함 — Temporal/sview 식 상호 링크면 충분.
- **P5. 실행 위치는 저노출 배지, 개입 지점은 고노출.** AI 플릿 제품(Devin 세션 링크, Cursor
  take-over/푸시) 공통 — 노드 상세에서 그 노드의 Operator/워커 세션으로 바로가기가 빈 곳.
- **P6. repo 규율 유지**: additive, flag 불요한 것은 annotate-only, 스키마 예약은 하되 semantics 최소,
  SSE 채널 3-목록 lock-step(§N1-2), 신규 표면 디자인 토큰 + a11y AA.

## 3. 기획 — Phase 구성

### N0. 정합 수리 (버그 선행, 2 PR) — ✅ 구현 완료 (PR #309 N0-1 + #310 N0-2 + #311 복원, 2026-07-05. 실 Pi e2e: flip 4초 내 자동 drain + codex 완주. prod v48)

**N0-1. tasks.status CHECK rebuild + 태스크 폼 정합** (migration 048)

- SQLite 는 CHECK-only ALTER 를 지원하지 않으므로 **테이블 rebuild 필수**. migration 048 은
  첫 줄에 `-- migrate:no-foreign-keys` 마커(러너 FK-off 지원, 045/046 전례) 를 명시하고,
  **현행 tasks 스키마를 있는 그대로 재생성**한다: 17 컬럼 전부(001+003+004+006+018), FK 는
  **현존하는 3개만** — project_id→projects ON DELETE SET NULL(001), parent_task_id 자기참조(004),
  suggested_agent_profile_id→agent_profiles(006). **preferred_preset_id 는 FK 를 만들지 않는다**
  (018 은 의도적으로 FK 없이 추가 — app-level cascade 설계, `018_worker_presets.sql:40` +
  `presetService.js:407`. R2 BLOCKER: FK 신설은 legacy 값/삭제 semantics 변경). 인덱스(019
  idx_tasks_preferred_preset 포함 전수), 기존 CHECK 전부 유지 — 변경점은 status CHECK 에
  `'failed'` 추가 **단 하나**. 인덱스명은 실제 `idx_tasks_preferred_preset_id`(019) 그대로.
  id 보존 rebuild(045 전례), 사후 `PRAGMA foreign_key_check` 빈 배열 + rebuild 전후
  `sqlite_master` DDL diff 가 status CHECK 한 줄뿐임을 테스트로 고정.
- 노드 컬럼(preferred_node_id 등)은 **지금 예약하지 않는다** (D4 결정 — v2 스키마는 v2 brief 에서).
- 같은 PR 에서 태스크 폼 dead field 정리: NewTaskModal 이 보내는 `agent_profile_id` 는 서버가
  무시함 (`validate.js:88` 은 suggested_agent_profile_id 만, `taskService.js:181-185` destructure 에
  없음) — 폼을 `suggested_agent_profile_id` 로 정합화하고 TaskCard 의 렌더 불가능한 ⚙ 배지 제거.

**N0-2. 노드 복구 drain + transport_lost node_id**

- heartbeat 복구 drain: reachable **0→1 flip 감지 시에만** (매 성공 tick 아님). 기존
  `drainQueue(profileId)`/`scheduleDrain(profileId)` 은 **profile-wide**(그 profile 의 모든 노드
  순회 — `lifecycleService.js:1024,1035,1062`) 이므로 그대로 못 쓴다 (R2 BLOCKER). **신규 scope
  옵션을 명시적으로 추가**: `drainQueue(profileId, { nodeId })` (queued 수집을 해당 노드로 한정)
  + `scheduleDrainForNode(nodeId)` (그 노드에 queued run 이 있는 distinct profile 을 SQL 로 추출해
  profile 별 node-scoped drain 을 coalesce 디스패치). heartbeat 루프에서 await 하지 않고
  `setImmediate` + 재진입 가드 (`scheduleDrain` 기존 패턴 준용). `claimQueuedRun` CAS 는 중복
  spawn 방지용일 뿐 drain 범위를 제한하지 않음을 전제로 설계.
- `transport_lost` payload 의 `node:'remote'` literal(`streamJsonEngine.js:277`) → 실제 node_id.
  **한 줄 수정 아님**: `spawnAgent` 옵션은 현재 executor/nodePrefix 만 받으므로
  (`streamJsonEngine.js:147`) `nodeId` 를 spawnAgent → claudeAdapter.startSession 호출 체인에
  명시적으로 스레딩 + 각 계층 테스트. **호출 사이트는 2곳 모두**: fresh Operator spawn
  (`operatorSpawnService`) 과 **boot resume** (`routes/manager.js:272` 의 adapter.startSession —
  R2 SERIOUS).

### N1. 노드 문맥 1급화 — 관측 (annotate-only, 3~4 PR) — ✅ 구현 완료 (PR #313 N1-1/2 + #314 N1-4 + #315 N1-3/5, 2026-07-05. reason enum 에 profile_missing 추가 — Codex 리뷰 반영. a11y/visual 52/52, dashboard baseline 4장 재생성. 라이브 실 Pi 플릿 스트립 시각 검증)

**N1-1. run envelope `node_id` hoist + webhook**
`runService.js:295-302,352-359` / `lifecycleService.js:1160-1167,1216-1225` envelope 에 `node_id`
를 task_id/project_id 와 동렬로 추가 (additive), `webhookService.js:18-32` 화이트리스트 payload 에
`node_id` 추가.

**N1-2. `node:status` SSE 채널 신설**
heartbeatService 에 eventBus 주입, reachable **flip 시에만** emit. payload 고정:
`{node_id, from_reachable, to_reachable, at}` (from/to 로 flip 방향 검증 가능). 등록은 **3-목록
lock-step + 테스트**: ① `eventChannels.js` SERVER_EMITS ② 같은 파일 CLIENT_REQUIRED_LIVE
③ `hooks/sse.js` useSSE channels 배열, 그리고 `sse-channels.test.js:102` 갱신. (Phase 5/7 채널
누락 회귀 패턴의 재발 방지가 이 3중 계약의 존재 이유.)

**N1-3. 노드 배지 (UI-only)**
TaskCard·TaskDetailPanel run 목록·SessionGrid·RunInspector 헤더에 노드 배지 + `#resources/nodes/:id`
링크. local 은 무배지, 원격만 표시 (P5 저노출). **배지의 소스는 `runs.node_id`** (실제 실행 위치,
run 별 사실) — 보드 필터(N2-4)의 소스인 프로젝트 바인딩과 의미가 다름을 UI 카피에 반영.

**N1-4. 대기 사유 — 서버 계산** (Jenkins 시계 패턴)

- ~~클라 파생~~ → **서버가 queued run 별 `queue_reason` 을 읽기 시점에 계산** (R1 BLOCKER:
  `profile_capacity` 는 profile×node 카운트(`runService.js:147`)가 필요해 노드 요약만으로 클라
  파생 불가). 저장하지 않음 (stale 사유 회피, annotate-only).
- reason enum + **우선순위 = canDispatchOnNode 평가 순서 고정** (`lifecycleService.js:204-217`):
  `node_unreachable` → `node_not_executable` → `node_cordoned`(N3-1 후) → `profile_capacity` →
  `node_capacity`. 첫 매치 반환. **로직 복제 금지** (R2 NIT — drift 방지): canDispatchOnNode 를
  공용 helper `explainDispatch(node, profile) → {ok, reason}` 로 추출해 dispatch 게이트와 summary
  API 가 **같은 함수를 소비**, 순서 고정 테스트를 수용 기준에 포함.
- API 형태: `GET /api/nodes/summary` 하나로 N1-4/N1-5 겸용 —
  노드별 `{node_id, name, reachable, can_execute, files_only, cordoned, max_concurrent,
  running_total, queued_total, running_by_profile, queued_by_profile}` + queued run 목록
  `[{run_id, task_id, project_id, agent_profile_id, node_id, queue_reason, enqueued_at}]`.
  기존 SQL 재사용, 신규 집계 테이블 없음. **라우트는 `/:id` 보다 먼저 등록** (`routes/nodes.js:23`
  동적 라우트 선점 — U 트랙 `/:id/usage` 와 같은 교훈, R2 NIT).

**N1-5. Dashboard 플릿 스트립 + AttentionStrip 승격**
**진짜 queued 총계**(현행 대시보드에 부재) + unreachable/cordoned 노드 경고 + 노드별 슬롯 바
(`running M / queued N / slots K`, Airflow pool 식). AttentionStrip 에 "노드 다운 + 그 노드
queued ≥ 1" 신호 승격. 데이터는 N1-4 summary API 재사용.

### N2. 노드-인지 UX — 조작 (3~4 PR) — ✅ 구현 완료 (PR #317, 2026-07-05. 3 슬라이스 통합. mcp_config_path 는 hard-block 대신 UI 안내로 완화[P4-2 회귀 방지, Codex 리뷰]. a11y/visual 52/52, board baseline 4장 재생성. 라이브 검증)

**N2-1. ProjectNodeSelect 헬스 + rebind guided flow**
노드 선택지에 reachable dot + 슬롯 점유 표시, unreachable 노드 선택 시 경고. rebind 409 응답을
특정해 "Operator reset 후 재시도" 인라인 액션 (reset 버튼) 제공 (`ProjectsView.js:411-431` 현행
generic toast 대체).

**N2-2. bind-time 사전검증 — directory + mcp_config_path (semantics 구분)**
원격 노드 바인딩(생성/수정) 시:
- `directory`: 그 노드 executor 로 exposed_roots 내부 + 존재 검증. 실패 시 400 + 구체 사유
  (현행: spawn 시점 가드뿐이라 run 실패로만 드러남).
- `mcp_config_path`: **현행 semantics 는 control-plane FS 읽기다** (R2 SERIOUS 교정 —
  `lifecycleService.js:527,532` 는 `fs.realpathSync/readFileSync`, 노드 FS 아님. 원격 워커에서
  control-plane 에 없는 경로면 조용히 누락). v1 은 이 semantics 를 **유지**하고: ① bind-time 에
  control-plane 기준 존재 검증 ② 원격 노드 + mcp_config_path 설정 조합에 "이 파일은 컨트롤
  플레인에서 읽힘" 안내 + 부재 시 경고 표시. 노드 FS 에서 읽는 전환(`nodeExecutor.readFile`)은
  v2 후보 (adapter 별 제약 — 원격 Claude worker 자체가 미지원 `lifecycleService.js:701` — 과 함께
  결정).
- `allow_non_git_dir` 등 로컬 전용 필드는 노드 kind 조건부 표시.

**N2-3. NodesView 역링크 + 라이브화**
노드 상세에 "이 노드의 running/queued run 목록" + Operator 세션 바로가기 (P4/P5). `node:status`
SSE 구독으로 목록/상세 라이브화 (`NodesView.js:816-827` mount-1회 로드 탈피).

**N2-4. BoardView 노드 필터**
기존 프로젝트/우선순위/마감일 Dropdown 과 동렬 1개 추가. **필터 기준 = 프로젝트 바인딩 노드**
(task→project.node_id — task 당 결정적 단일 값; run 기준은 한 task 에 여러 run 이 있어 다의적,
R1 SERIOUS 반영). 카드 배지(N1-3)는 run 의 실제 위치라는 의미 차이를 필터 라벨 카피에 명시
("배치 노드" vs 배지 "실행 노드"). 스윔레인/group-by-node 는 **하지 않음** (소규모 플릿 과설계, P4).

### N3. 운영 semantics — 제어 (2~3 PR)

**N3-1. 노드 cordon** (migration 049 — `nodes.cordoned` 컬럼, reachable 과 직교(P3))

경로별 semantics 를 명시한다 (R1 BLOCKER — worker 게이트만으로는 불완전):

| 경로 | cordon 중 동작 |
|---|---|
| worker dispatch (`canDispatchOnNode`, `lifecycleService.js:204-217`) | 차단 — queued 유지, reason `node_cordoned` |
| worker drain (`drainQueue`) | 같은 게이트 공유로 자동 차단 |
| **fresh Operator spawn** (`operatorSpawnService.js:186,281,303`) | **fail-closed 거부** (기존 fail-closed 502 패턴) + run event `operator:spawn_blocked_cordoned` |
| **boot resume** (`routes/manager.js:192,291`) | **skip + annotate `operator:resume_skipped_cordoned` + stale run `stopped` 마킹** (기존 resumed=false 폴백과 동일 처리 — `routes/manager.js:305`. R2 SERIOUS: run 을 live 로 남기면 rebind 가드(`projectService.js:72,185`)가 유령 run 을 세고 lazy spawn 과 이중화). **`project_briefs.pm_thread_id` 는 보존** — uncordon 후 lazy respawn 이 기존 resume affinity 로 세션을 이음 |
| 기존 running (worker + Operator) | 계속 소진 (드레인 모드의 정의) |
| heartbeat probe | **무관** — cordon 게이트를 `pickExecutor` 에 넣지 않는다 (heartbeat 가 pickExecutor 를 사용, `nodeHeartbeatService.js:22` — cordon 이 heartbeat 를 죽이는 역효과 금지, R1 지적) |

NodesView 토글 + cordoned 배지. 현재는 안전한 유지보수 경로가 없음 (reachable=0 수동 PATCH 는
다음 heartbeat 가 되돌리고, can_execute=0 은 pickExecutor throw 로 기존 run health check 까지 깨짐).

**N3-2. queued stuck sweep**
노드 unreachable(또는 cordoned) N분(기본 15) 경과한 queued run 에 `queue:stuck` run event
annotate + AttentionStrip 승격. **auto-fail 하지 않음** (P2 — TTL 만료는 v2 결정). lifecycle
monitor tick 편승, 중복 annotate 방지(run 당 1회 or 상태 변화 시).

**N3-3. queued re-target** (프로젝트 rebind 후속)

- 프로젝트 rebind 성공 시 옛 노드에 핀된 queued run N건에 대해 "새 노드로 이동?" 제안 배너.
- 이동 전 검증 (N2-2 와 동일 semantics 분리): **directory 는 새 노드 기준** (executor 로
  exposed_roots + 존재), **mcp_config_path 는 control-plane 기준** 존재/경고 (N2-2 참조 — 노드
  FS 검증 아님). queued_args 는 skillPackIds/presetId 만 담아(`lifecycleService.js:143,335`) 노드
  종속 경로 스냅샷은 없음 — spawn 시점에 project.directory 를 다시 읽으므로
  (`lifecycleService.js:387`) 이동 자체는 안전하나, 검증 실패 시 **이동 0건** (all-or-nothing).
- 이동은 **runService 신규 프리미티브 `retargetQueuedRuns(runIds, fromNodeId, toNodeId)` — 단일
  better-sqlite3 트랜잭션** (R2 BLOCKER: 개별 CAS 는 일부 run 이 그 사이 claim 되면 부분 이동):
  tx 내에서 run 별 `UPDATE runs SET node_id=? WHERE id=? AND status='queued' AND
  COALESCE(node_id,'local')=?` 실행, `changes` 합계 ≠ N 이면 **rollback + 409** (그 사이 시작된
  run 존재). run event `queue:retargeted {from_node, to_node}` 기록도 **같은 tx**. 커밋 후 새
  노드 대상 `scheduleDrainForNode`(N0-2 프리미티브 재사용) 로 drain 촉발.

### v2 후보 (명시 비범위 — 트리거 시 별도 brief)

| 항목 | 왜 지금 아닌가 |
|---|---|
| task-level node override + per-node 경로 매핑(`project_node_paths`) | override 가 의미 있으려면 같은 repo 가 여러 노드에 존재해야 함 = 멀티노드 트랙. fleet brief v1 비범위(cross-node LB)와 동일 경계 |
| soft affinity (weight 선호, "로컬 우선 Pi 폴백") | Nomad/K8s hard/soft 이원화 프라이어아트. v1 은 hard 바인딩뿐 |
| 글로벌 프로필 cap | profile.max_concurrent 가 노드×cap 으로 팽창하는 현행 semantics 는 계정 단위 rate-limit(claude/codex)와 부정합 가능. 운영 데이터 관측 후 |
| 매니저 슬롯 가중치 | countRunningTotalOnNode 가 is_manager=0 만 — Pi 급 노드에서 Operator 부하 과소평가. cordon+슬롯 바 관측 후 |
| usage 임계 알림 / run 단위 사용량 attribution | U 트랙 확장 (Devin ACU 동형). 스냅샷 저장/히스토리 선행 필요 |
| 원격 DirectoryPicker (pod FS 브라우징) | N2-2 사전검증이 실수 클래스를 먼저 잡음. UX 개선은 후속 |
| 원격 worktree 격리 | fleet brief 기존 follow-up (`lifecycleService.js:649-651`) |
| queued TTL auto-expire | sweep annotate 관측 후 만료 정책 결정 |

## 4. 비범위 (v1)

- 스케줄러/로드밸런싱/자동 failover — P1 원칙. 배치는 계속 `project.node_id || 'local'`.
- 멀티노드 프로젝트, 태스크 레벨 노드 지정 — v2 후보 표 참조.
- 노드 topology 시각화 (Nomad 식) — 상호 링크로 충분.
- Grafana 급 메트릭/시계열 — 슬롯 숫자 + stuck 강조로 충분 (조사 일관 결론).

## 5. 수용 기준

1. 노드 미등록·전부 local 환경에서 **동작/표시 불변** (배지 미표시, 스트립 자연 축소).
2. N0-1 후 worker 전멸 태스크가 실제로 `failed` 컬럼에 나타난다. rebuild 후
   `PRAGMA foreign_key_check` 빈 배열 + `sqlite_master` DDL diff 가 status CHECK 한 줄뿐
   (**preferred_preset_id FK 신설 없음** 포함) — prod 복사본 검증, 045 전례.
3. N0-2 후 노드 복구 시 30초(heartbeat 주기) 내 **그 노드의 queued run 만** node-scoped drain
   (`drainQueue(profileId, { nodeId })`) 되고, 다른 노드 큐는 촉발되지 않는다.
4. 원격 run 의 실행 위치가 보드 카드·RunInspector 에서 보이고 노드 상세로 링크된다.
5. queued run 에 서버 계산 사유가 표시된다 — dispatch 게이트와 summary 가 **공용
   `explainDispatch` helper 를 공유**하고 평가 순서 고정 테스트 존재. 노드 다운 기인 대기는
   AttentionStrip 에 승격된다.
6. cordon 노드: 신규 worker dispatch 0 + fresh Operator spawn 거부 + boot resume skip(annotate
   + **stale run `stopped` 마킹 + `pm_thread_id` 보존** 테스트) + 기존 running 소진 +
   **heartbeat 는 계속 동작** + heartbeat 로 해제되지 않음.
7. rebind 후 re-target 수락 시: 새 노드 검증 통과 → **단일 tx 로 N건 전부 이동** (그 사이
   1건이라도 claim 되면 rollback + 409, 부분 이동 0) → 새 노드에서 drain. 검증 실패 → 이동
   0건 + 사유 표시. 모든 이동에 `queue:retargeted` 감사 이벤트 (같은 tx).
8. `transport_lost` payload 에 실제 node_id — spawnAgent 체인 스레딩 테스트 + **fresh spawn·
   boot resume 두 호출 사이트 모두** 커버.
9. 전 신규 표면 a11y AA (contrast waiver 불가) + visual baseline (nav 변경 시 52장 전체 재생성).
10. `node:status` 채널이 SERVER_EMITS + CLIENT_REQUIRED_LIVE + useSSE channels **3곳 동시 등록**
    + `sse-channels.test.js` 갱신.

## 6. 결정 기록

- **D1** (R1 BLOCKER 로 확정): 대기 사유는 **서버 계산·읽기 시점·비저장**. 클라 파생은
  profile_capacity 판정 불가로 기각.
- **D2**: cordon 저장 = `nodes.cordoned` 컬럼 (reachable 과 직교, P3). status enum 확장 기각.
- **D3**: `GET /api/nodes/summary` 1개로 N1-4/N1-5 겸용 (shape 는 §N1-4).
- **D4**: N0-1 rebuild 는 status CHECK 수정만 — 노드 컬럼 예약 없음. v2 스키마는 v2 brief 에서
  결정 (멀티노드 요구가 구체화되기 전 스키마 선점은 P6 위반).

## 7. 리뷰 로그

- **Codex R1 (2026-07-05): REVISE** — BLOCKER 3 (tasks rebuild DDL 전량 명시 필요 / 대기 사유
  클라 파생 불가 / cordon 의 Operator·boot-resume·heartbeat 경로 미정의), SERIOUS 6 (drain 범위
  과잉 / SSE 3-목록 계약 / transport_lost 체인 스레딩 / re-target 검증·감사 / 보드 필터 의미
  다의성 / mcp_config_path 누락), NIT 3 (핵심 진단 3건은 사실로 확인 / dashboard stat-queued
  는 needs_input 렌더 / 파일 경로 표기). → 전부 v1.0 에 반영.
- **Codex R2 (2026-07-05): REVISE** — BLOCKER 3 (preferred_preset_id 는 018 이 의도적 FK-없음
  → rebuild 시 FK 신설 금지 / drainQueue·scheduleDrain 이 profile-wide 라 node-scope 프리미티브
  신설 필요 / re-target 개별 CAS 는 부분 이동 race → 단일 tx + changes 검증), SERIOUS 3
  (mcp_config_path 는 control-plane FS 읽기가 현행 semantics — 노드 FS 검증 주장 교정 /
  boot resume skip 시 stale run stopped 마킹 필수(rebind 가드·lazy spawn 이중화 방지) /
  transport_lost nodeId 는 boot resume 호출 사이트도 포함), NIT 2 (summary 라우트 `/:id` 선점 /
  explainDispatch 공용 helper 로 로직 복제 방지). → 전부 v1.1 에 반영.
- **Codex R3 (2026-07-05): REVISE** — BLOCKER 0. SERIOUS 1 (N3-3 의 mcp_config_path 검증 문구가
  N2-2 의 control-plane semantics 와 충돌 → directory=새 노드 기준 / mcp_config_path=control-plane
  기준으로 분리), NIT 3 (AC6 에 stopped 마킹+pm_thread_id 보존 명시 / AC8 에 boot resume 사이트
  포함 / 인덱스명 idx_tasks_preferred_preset_id 교정). R2 항목 전부 해소 확인. → v1.2 반영.
- **Codex R4 (2026-07-05): GO** — R3 4건 해소 확인, 신규 BLOCKER/SERIOUS 0.
