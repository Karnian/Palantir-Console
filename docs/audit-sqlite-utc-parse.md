# SQLite UTC 파싱 전수 조사 (#470)

## 범위와 판정 기준

초기 조사는 `server/db/migrations/*.sql`의 75개 `datetime('now')`
발생 지점과 `server/services/*.js`의 167개 발생 지점, 서비스의 날짜
파서를 대상으로 했다. 두 차례 교차검토에서 그 범위 밖의 프런트 소비자가
연속으로 발견됐으므로, 3차 정정에서는 `server/public/` 전체를 별도
범위로 다시 검색했다.

실제로 실행한 검색 명령은 다음과 같다. 첫 명령은 수정 전 `ace65ee`
트리의 기준 결과(42행), 둘째 명령은 작업트리 결과를 재현한다.

```sh
git grep -n -E 'Date\.parse[[:space:]]*\(|new[[:space:]]+Date[[:space:]]*\(' ace65ee -- server/public
rg -n --glob '*.{js,jsx,mjs,cjs,ts,tsx,html}' 'Date\.parse\s*\(|new\s+Date\s*\(' server/public
rg -n --glob '*.{js,jsx,mjs,cjs,ts,tsx,html}' 'created_at|updated_at|started_at|ended_at|_at\b|timestamp|timeAgo|formatTime|parseDate' server/public/app server/public/*.js
rg -n -C 4 'source_fetched_at|fetched_at|next_schedule_at|next_fire_at|scheduled_for|resetAt|updatedAt|created_at' server/routes server/services server/db/migrations
```

첫 두 명령의 모든 일치를 호출별로 분류했다. 주석, `new Date()` 현재시각
생성, 숫자/`Date` 복사 생성자도 결과에서 버리지 않고 아래에 별도로
기록했다. 입력 이름만 보고 DB 유래 여부를 추정하지 않고 route/service의
생성·기록 위치까지 역추적했다.

SQLite의 `datetime('now')`는 UTC를 `YYYY-MM-DD HH:MM:SS` 형식으로
저장하지만 zone 표시는 붙이지 않는다. 이 문자열을 JS의 `Date.parse`나
`new Date`에 그대로 넘기면 호스트 로컬 시간으로 해석된다. 따라서 이
감사에서는 다음 기준을 적용했다.

- JS에서 현재 시각과 빼거나 TTL과 비교하는 경과시간 소비자는
  `lifecycleService.js`의 기존 `parseSqliteUtc`를 사용한다.
- 프런트에서 SQLite 문자열을 정렬·비교·경과시간에 쓰는 소비자는
  `server/public/app/lib/format.js`의 `parseDate` 계약을 사용한다.
- SQL 안에서 `datetime(...)`끼리 비교하는 경로는 SQLite가 같은 시간
  체계에서 처리하므로 JS 로컬 timezone 결함이 없다.
- 고정 폭 UTC 문자열의 SQL 정렬은 시간순과 일치하므로 바꾸지 않는다.
- 순수 표시는 입력 형식이 명시적으로 zone 포함 ISO 또는 epoch인지
  기록 위치까지 확인한 경우에만 직접 `new Date`를 유지한다.
- `parseSqliteUtc` 자체는 수정하지 않았다. 따라서 SQLite 형식에만 `Z`를
  보완하고, 이미 `Z` 또는 offset이 있는 ISO 입력은 기존처럼 그대로
  `Date.parse`에 전달한다.

## 프런트엔드 직접 날짜 파서 전수 결과

DB/API 값이 `Date.parse` 또는 `new Date(value)`에 직접 들어갈 수 있는
지점은 아래와 같다. `format.js` 내부는 공용 계약의 구현이므로 남아 있는
직접 생성자가 의도된 것이다.

| 위치 | 입력과 용도 | 조치와 근거 |
|---|---|---|
| `app/lib/format.js:30-38` | `formatTime`, `timeAgo` 및 직접 호출자의 server timestamp; 표시·경과시간·비교 | **유지** — 숫자는 epoch ms, 명시 zone 문자열은 offset을 존중하고, zone 없는 SQLite/ISO 문자열에만 `Z`를 붙이는 공용 계약이다 |
| `app/lib/nodeUi.js`의 `latestRunForTask` | DB `runs.created_at` (fallback `updated_at`)으로 최신 run 정렬; Board/SessionGrid 노드 배지 선택 | **수정** — 직접 `Date.parse`를 `parseDate(...).getTime()`으로 교체했다. LA DST spring-forward에서 `02:30`이 `03:00`보다 최신으로 뒤집히던 경로다 |
| `app/components/TaskModals.js`의 `taskRuns` | DB `runs.created_at`으로 상세 run 목록 정렬 및 첫 active run 선택 | **수정** — 직접 `new Date`를 `parseDate`로 교체했다. 목록 순서와 “실행 보기” 대상이 같은 정렬 결과를 쓴다 |
| `app/components/DriftDrawer.js`의 drift row | DB `dispatch_audit_log.created_at`으로 상대 경과시간 표시 | **수정** — 이 컬럼은 `010_dispatch_audit.sql:20`의 `INTEGER` epoch ms이고 `reconciliationService.js`가 `Date.now()` 계열 숫자로 기록하므로 기존 파싱도 timezone-safe였다. 그래도 경과시간 소비는 공용 계약을 거쳐야 한다는 기준에 맞춰 `timeAgo(row.created_at)`로 직접 전달한다 |
| `app/components/PackPreviewModal.js:95` | DB `skill_packs.source_fetched_at`을 설치/업데이트 미리보기에서 locale 문자열로 표시 | **유지** — `017_skill_pack_source_url.sql:12`가 ISO8601 컬럼으로 정의하고, `skillPackService.js:1160,1207`이 `new Date().toISOString()` 값만 기록한다. 정렬·비교·경과시간에 쓰지 않는 단일 표시이며 입력에 `Z`가 보장된다 |
| `app/components/OperatorsView.js:114-118` | DB `operator_schedules.next_fire_at` 및 그 `MIN(...)` 별칭 `operator_instances.next_schedule_at`을 locale 문자열로 표시 | **유지** — 두 호출처는 roster의 다음 일정과 schedule card의 다음 실행 표시뿐이다. `operatorScheduleService.js:673,714`가 `next.toISOString()`으로 기록하므로 `Z`가 보장되고, 프런트에서는 정렬·비교·경과시간에 사용하지 않는다 |

검색에 잡힌 나머지 호출도 다음과 같이 전부 확인했다.

- `dueDate.js:15-16,59-60`, `BoardView.js:203-210,523-577`:
  DB `tasks.due_date`는 timestamp가 아니라 사용자 로컬 달력 날짜
  `YYYY-MM-DD`다. 문자열을 직접 파싱하지 않고 연/월/일 숫자로 로컬
  자정을 만들며, 나머지는 현재시각·월 grid·기존 `Date` 복사 생성이다.
- `AgentsView.js:243,374,379`, `SessionsView.js:19-21,132`:
  `/api/agents/:id/usage`와 `/api/usage/providers`의 provider payload다.
  DB 행이 아니며 `resetAt`은 provider API의 epoch/zone 포함 값이
  server에서 `Date`로 검증된 뒤 JSON ISO가 되고, `updatedAt`은
  provider adapter가 `toISOString()`으로 만든다.
- `SkillPacksView.js:492`: `POST /api/skill-packs/registry/check-update-url` 응답의
  `fetched_at`을 확인 대화상자에 한 번 표시한다. route가 응답 시점에
  `new Date().toISOString()`으로 생성하며 DB 컬럼을 읽지 않는다.
- `OperatorsView.js:1204`: 새 one-shot schedule의 `<input
  type="datetime-local">` 사용자 입력을 로컬 시각으로 해석해 ISO로
  전송하는 생성 경로다. DB 값을 읽는 소비자가 아니다.
- `hooks/conversation.js:183-184,214`, `ManagerChat.js:667-668,691`,
  `UrlInstallDialog.js:78`: optimistic/preview 행에 넣을 현재시각을
  `toISOString()`으로 생성한다. 파싱 호출이 아니다.
- `DashboardView.js:34`와 나머지 `BoardView`/`dueDate.js`의 무인자
  `new Date()`는 현재시각 생성이다. `BoardView`의 `new Date(existingDate)`
  호출은 calendar grid용 복사다.

따라서 수정 후 프런트에 남은 DB 직접 파싱은 위 두 **유지** 표시 지점뿐이고,
둘 다 zone 포함 ISO가 기록 위치에서 보장되는 순수 locale 표시다.

## JS 파서와 실제 SQLite 기록 컬럼의 교차 결과

| 컬럼 | UTC 기록 위치 | JS 소비 위치 | 판정 |
|---|---|---|---|
| `runs.created_at` | `001_initial.sql:58`, 최종 runs 재구성 `050_project_repo_source.sql:68` | `lifecycleService.js:2465`의 queue 대기시간, `lifecycleService.js:2882`의 idle fallback, `routes/manager.js`의 오늘 집계, `nodeUi.js`의 최신 run 선택, `TaskModals.js`의 run 정렬/active 선택 | lifecycle 두 곳은 `parseSqliteUtc`, route는 명시적 `Z`, 프런트 두 곳은 공용 `parseDate`를 사용한다. 표시 helper 호출도 `parseDate`를 경유한다 |
| `runs.materialize_started_at` | 컬럼은 `050_project_repo_source.sql:94`, 값은 `runService.js:285-301`의 `datetime('now')` | `lifecycleService.js:2512`의 materialize 대기시간 | `parseSqliteUtc`로 수정. 경과시간 계산이다. |
| `runs.started_at` | 컬럼은 `001_initial.sql:56`, 값은 `runService.js:190-192`, `281-283`의 `datetime('now')` | `lifecycleService.js:2882`의 idle fallback | `parseSqliteUtc`로 수정. 경과시간 계산이다. |
| `run_events.created_at` | `001_initial.sql:66` 기본값 | `lifecycleService.js:2708`의 remote ownership TTL, `lifecycleService.js:2881`의 idle activity, `ManagerChat.js`의 메시지 정렬 | 경과시간 소비는 모두 `parseSqliteUtc`를 사용한다. UI 정렬은 공용 `parseDate`를 사용해 queue 행과 같은 UTC 체계로 비교하도록 수정했다. |
| `manager_message_queue.created_at` | `071_manager_message_queue.sql:27` 기본값 | `ManagerChat.js`의 메시지 정렬 | `run_events` 행 및 zone 포함 optimistic 행과 섞여 정렬되므로 공용 `parseDate`를 사용하도록 수정했다. |

위 표는 SQLite 문자열을 JS에서 정렬·비교·경과시간에 사용하는 교차점이다.
이전 문서의 “위 다섯 컬럼 외에는 교차점이 없다”는 단정은 삭제했다.
프런트의 전체 직접 파서 결과와 안전하게 유지한 표시 지점은 바로 위
전수 표에 별도로 남겼다.

## `datetime('now')` 기록 컬럼 전체 목록

아래 표는 역사적 테이블 재구성 migration의 같은 컬럼을 한 행으로
합쳤다. 이 표의 “JS 파서 없음”은 원래 조사 범위인 **서비스 내부 직접
파서**가 없다는 뜻이다. 프런트 직접 파서와 `formatTime`/`timeAgo` 같은
공용 파서 경유 소비는 위 두 표가 우선하며, raw API 반환을 “소비자 없음”으로
다시 오인하지 않도록 범위를 구분한다.

| 테이블 | `datetime('now')`로 기록되는 컬럼 | 기록 위치 | JS 소비 및 조치 |
|---|---|---|---|
| `projects` | `created_at`, `updated_at` | `001_initial.sql:11-12`; 갱신은 `projectService.js` | JS 파서 없음. 미수정. |
| `tasks` | `created_at`, `updated_at` | `001_initial.sql:23-24`, 재구성 `048_task_status_failed.sql:14-15`; 갱신은 `taskService.js` | JS 파서 없음. SQL 정렬/API 반환만 하므로 미수정. |
| `agent_profiles` | `created_at` | `001_initial.sql:38` | JS 파서 없음. 미수정. |
| `runs` | `created_at`, `started_at`, `ended_at`, `materialize_started_at`, `materialize_run_after`, `workspace_ref_released_at` | `001_initial.sql`, runs 재구성 `012`, `045`, `046`, `050`; 쓰기는 `runService.js:188-191`, `282-318`, `448-493`, `069_remove_opencode_agent_profile.sql:12` | `created_at`, `started_at`, `materialize_started_at`의 경과시간 소비는 위 교차표처럼 수정. 나머지는 JS 파서 없음. |
| `run_events` | `created_at` | `001_initial.sql:66` | 경과시간 소비 두 곳은 위 교차표처럼 `parseSqliteUtc` 사용. `ManagerChat` 정렬은 공용 `parseDate` 사용. |
| `approvals` | `created_at` | `001_initial.sql:74` | JS 파서 없음. 미수정. |
| `external_sessions` | `created_at` | `001_initial.sql:83` | JS 파서 없음. 미수정. |
| `project_briefs` | `created_at`, `updated_at` | `008_project_brief.sql:30-31`; `projectBriefService.js:29-49`, 동적 갱신 | JS 파서 없음. 미수정. |
| `mcp_server_templates` | `created_at`, `updated_at` | `013_skill_packs.sql:11`, 재구성 `022_mcp_template_http_transport.sql:32`; `updated_at`은 `mcpTemplateService.js`, `skillPackService.js` | JS 파서 없음. drift 판정은 문자열/DB 값 전달이며 미수정. |
| `skill_packs` | `created_at`, `updated_at` | `013_skill_packs.sql:36-37`; 갱신은 `skillPackService.js` | JS 파서 없음. 미수정. |
| `run_skill_packs` | `applied_at` | `013_skill_packs.sql:140` | JS 파서 없음. 미수정. |
| `worker_presets` | `created_at`, `updated_at` | `018_worker_presets.sql:16-17`; 갱신은 `presetService.js` | JS 파서 없음. 미수정. |
| `run_preset_snapshots` | `applied_at` | `018_worker_presets.sql:29` | JS 파서 없음. 미수정. |
| `memory_items` | `created_at`, `updated_at`, `valid_to`, `archived_at`, `reviewed_at` | 기본값/재구성은 `025`, `039`, `044`; 상태·TTL 기록은 `memoryService.js`, `066_b_adm_episodic_node_fact_cleanup.sql` | JS 파서 없음. TTL은 SQLite `datetime(...)` 비교, 목록은 SQL 정렬이므로 미수정. |
| `memory_candidates` | `created_at`, `updated_at` | `026_memory_candidates.sql:19-20`, 재구성 `039`, `042`; 갱신은 `memoryService.js` | JS 파서 없음. 미수정. |
| `memory_jobs` | `created_at`, `updated_at`, `locked_at`, `run_after` | `027_memory_jobs.sql:50-51`, 재구성 `042`; lease/backoff 기록은 `memoryService.js:983-1023` | JS 파서 없음. lease와 due 판정은 SQLite 안에서 하므로 미수정. |
| `master_memory_items` | `created_at`, `updated_at`, `valid_to`, `archived_at`, `reviewed_at` | `030_master_memory.sql:32-33`; 상태·TTL 기록은 `masterMemoryService.js`, `ownerMergeSlice2a.js` | JS 파서 없음. TTL은 SQLite 비교, 목록은 SQL 정렬이므로 미수정. |
| `master_memory_candidates` | `created_at`, `updated_at` | `031_master_memory_candidates.sql:17-18`, 재구성 `039`; 갱신은 `masterMemoryService.js` | JS 파서 없음. 미수정. |
| `memory_composition_events` | `created_at`, `accepted_at` | `038_composition_ledger.sql:33`; accept 기록은 `compositionLedger.js:52-64`, `103-107`; 재구성 `045`, `046` | JS 파서 없음. 최신 항목 선택은 SQL 정렬이므로 미수정. |
| `operator_profiles` | `created_at`, `updated_at` | `043_operator_profiles.sql:22-34` | JS 파서 없음. 미수정. |
| `nodes` | `created_at`, `updated_at`, `last_heartbeat_at` | `047_fleet_nodes.sql:18-19`; heartbeat/갱신은 `nodeService.js:179-237` | JS 파서 없음. 미수정. |
| `operator_instances` | `created_at`, `updated_at` | `051_operator_instances.sql:17-18`, 재구성 `064`; 갱신은 `operatorInstanceService.js`와 `runService.js` | JS 파서 없음. 미수정. |
| `operator_codebase_refs` | `created_at` | `051_operator_instances.sql:25` | JS 파서 없음. 미수정. |
| `verify_checks` | `created_at`, `updated_at` | `055_verify_checks.sql:20-21`; 갱신은 `verifyCheckService.js` | JS 파서 없음. 미수정. |
| `goal_effects` | `created_at`, `sent_at` | `057_goal_verdict.sql:25`; sent 기록은 `runService.js:593-600` | JS 파서 없음. 미수정. |
| `model_policies` | `updated_at` | `061_model_policies.sql:11,28` | JS 파서 없음. 미수정. |
| `model_policy_audit` | `created_at` | `061_model_policies.sql:42` | JS 파서 없음. 미수정. |
| `operator_schedules` | `created_at`, `updated_at`, `archived_at` | `067_operator_scheduler.sql:24-25`; 갱신/보관은 `operatorScheduleService.js` | JS 파서 없음. SQL due/정렬과 raw 반환만 하므로 미수정. |
| `operator_invocations` | `created_at`, `updated_at`, `started_at`, `completed_at` | `067_operator_scheduler.sql:59-60`; 상태 기록은 `operatorScheduleService.js`, 보정은 `068_operator_scheduler_hardening.sql` | JS 파서 없음. `scheduled_for` 파싱은 아래처럼 ISO 기록이므로 이 행과 무관하다. |
| `manager_message_queue` | `created_at`, `updated_at`, `delivered_at`, `failed_at`, `cancelled_at` | `071_manager_message_queue.sql:27-28`; 상태 기록은 `managerMessageQueueService.js` | `created_at`은 `ManagerChat`에서 run event 및 optimistic 행과 함께 정렬되며 공용 `parseDate`로 수정. FIFO는 정수 `sequence`, lease는 정수 epoch이다. 나머지 timestamp는 JS 파서 없음. |
| `project_node_workspaces` | `materialized_at`, `last_used_at` | 컬럼은 `050_project_repo_source.sql:148-149`; 기록은 `runService.js:360-402` | JS 파서 없음. 미수정. |
| `project_materialization_leases` | `locked_at` | 컬럼은 `050_project_repo_source.sql:160`; 기록은 `runService.js:414-424` | JS 파서 없음. stale 판정은 SQLite `datetime(...)` 비교라 미수정. |
| `project_workspace_refs` | `acquired_at`, `heartbeat_at`, `released_at` | 컬럼은 `050_project_repo_source.sql:179-181`; 기록은 `runService.js:431-446` | JS 파서 없음. 미수정. |

추가로 migration runner가 만드는 `schema_version.applied_at`도
`server/db/database.js:20-24`에서 `datetime('now')` 기본값을 사용한다.
요청된 두 검색 디렉터리 밖이지만 누락 방지를 위해 확인했으며 JS 파서
소비는 없다.

## 서비스의 다른 `Date.parse` / `new Date` 입력

전수 검색에서 나온 나머지 날짜 파서는 SQLite `datetime('now')` 값의
소비자가 아니다.

- `codexService.js`의 reset 시각은 Codex 응답 payload의 epoch 또는
  zone 포함 문자열이다.
- `goalVerdictService.js`의 `judge.deadline`은
  `harvestService.js`가 `toISOString()`으로 만든 JSON 값이다.
- `operatorScheduleService.js`의 `rule.at`, `next_fire_at`,
  `scheduled_for`는 입력 검증 후 `toISOString()`으로 기록한 값이다.
  `scheduled_for` 경과시간 계산은 zone 포함 ISO를 읽으므로 변경하지
  않았다.
- `operatorInstanceService.js`의 `now`와 `taskService.js`의 날짜 생성은
  호출 인자/달력 날짜 처리이며 SQLite timestamp 소비가 아니다.
- `new Date()` 또는 `new Date(milliseconds)`로 현재 시각·epoch를
  생성하는 호출은 파싱 결함과 무관하다.

따라서 표시용 timestamp나 문자열 정렬을 UTC 파서로 일괄 변환하지
않았고, 기존 행 형식을 바꾸는 migration도 추가하지 않았다.
