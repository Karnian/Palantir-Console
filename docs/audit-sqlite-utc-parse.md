# SQLite UTC 파싱 전수 조사 (#470)

## 범위와 판정 기준

조사 범위는 `server/db/migrations/*.sql`의 75개
`datetime('now')` 발생 지점과 `server/services/*.js`의 167개 발생
지점(기록뿐 아니라 SQL 내부 비교 포함), 그리고 서비스의 모든
`Date.parse(...)` / `new Date(...)` 호출이다. 두 디렉터리에는
`CURRENT_TIMESTAMP` 사용이 없다.

**소비자는 `services/` 밖에도 있다.** 교차검토에서 지적되어 추가 확인한 것:

| 위치 | 컬럼 | 상태 |
|---|---|---|
| `server/routes/manager.js:1076-1111` (`GET /api/manager/summary`) | `runs.created_at` | **이미 정확** — 비교 전에 `Z`를 명시적으로 붙인다. 다만 바로 위 `:1100-1103` 주석이 "zone 표시 없는 JS `Date()`가 마침 원하는 동작" 이라고 반대로 설명하고 있어 코드와 모순된다. 이 PR 이전부터 있던 것이라 건드리지 않았다 |
| `server/public/app/lib/format.js:31-39`, `NodesView.js:169-190` | 표시용 상대 시각 | **이미 정확** — 이전 K-low-3 수정으로 TZ-safe |
| `server/public/app/components/ManagerChat.js`의 메시지 정렬 | `run_events.created_at`, `manager_message_queue.created_at` | **결함 발견 및 수정** — SQLite UTC 행과 `toISOString()` optimistic 행을 같은 배열에서 정렬하면서 둘 다 `Date.parse`에 직접 전달했다. 공용 `parseDate`를 사용해 SQLite 형식은 UTC로 고정하고 zone 포함 ISO는 그대로 해석한다. |

즉 이 감사의 1차 스윕은 `migrations/` + `services/` 였고, `routes/` 와
프런트엔드는 교차검토 단계에서 별도 확인했다. 그 과정에서
`ManagerChat`의 혼합 timestamp 정렬 결함이 발견되어 수정했다.
"전수 조사"라는 표현이 1차 스윕 범위만 가리키지 않도록 여기 명시한다.

SQLite의 `datetime('now')`는 UTC를 `YYYY-MM-DD HH:MM:SS` 형식으로
저장하지만 zone 표시는 붙이지 않는다. 이 문자열을 JS의 `Date.parse`나
`new Date`에 그대로 넘기면 호스트 로컬 시간으로 해석된다. 따라서 이
감사에서는 다음 기준을 적용했다.

- JS에서 현재 시각과 빼거나 TTL과 비교하는 경과시간 소비자는
  `lifecycleService.js`의 기존 `parseSqliteUtc`를 사용한다.
- SQL 안에서 `datetime(...)`끼리 비교하는 경로는 SQLite가 같은 시간
  체계에서 처리하므로 JS 로컬 timezone 결함이 없다.
- 고정 폭 UTC 문자열의 SQL 정렬은 시간순과 일치하므로 바꾸지 않는다.
- 화면 표시나 API 반환을 위한 값은 이번 경과시간 결함과 별개이므로
  형식을 바꾸지 않는다.
- `parseSqliteUtc` 자체는 수정하지 않았다. 따라서 SQLite 형식에만 `Z`를
  보완하고, 이미 `Z` 또는 offset이 있는 ISO 입력은 기존처럼 그대로
  `Date.parse`에 전달한다.

## JS 파서와 실제 SQLite 기록 컬럼의 교차 결과

| 컬럼 | UTC 기록 위치 | JS 소비 위치 | 판정 |
|---|---|---|---|
| `runs.created_at` | `001_initial.sql:58`, 최종 runs 재구성 `050_project_repo_source.sql:68` | `lifecycleService.js:2465`의 queue 대기시간, `lifecycleService.js:2882`의 idle fallback | 두 곳 모두 `parseSqliteUtc`로 수정. 경과시간 계산이다. |
| `runs.materialize_started_at` | 컬럼은 `050_project_repo_source.sql:94`, 값은 `runService.js:285-301`의 `datetime('now')` | `lifecycleService.js:2512`의 materialize 대기시간 | `parseSqliteUtc`로 수정. 경과시간 계산이다. |
| `runs.started_at` | 컬럼은 `001_initial.sql:56`, 값은 `runService.js:190-192`, `281-283`의 `datetime('now')` | `lifecycleService.js:2882`의 idle fallback | `parseSqliteUtc`로 수정. 경과시간 계산이다. |
| `run_events.created_at` | `001_initial.sql:66` 기본값 | `lifecycleService.js:2708`의 remote ownership TTL, `lifecycleService.js:2881`의 idle activity, `ManagerChat.js`의 메시지 정렬 | 경과시간 소비는 모두 `parseSqliteUtc`를 사용한다. UI 정렬은 공용 `parseDate`를 사용해 queue 행과 같은 UTC 체계로 비교하도록 수정했다. |
| `manager_message_queue.created_at` | `071_manager_message_queue.sql:27` 기본값 | `ManagerChat.js`의 메시지 정렬 | `run_events` 행 및 zone 포함 optimistic 행과 섞여 정렬되므로 공용 `parseDate`를 사용하도록 수정했다. |

위 다섯 컬럼 외에는 `datetime('now')`로 기록된 값을 서비스 또는
확인된 프런트엔드 정렬의 `Date.parse` / `new Date`가 소비하는 교차점이 없었다.

## `datetime('now')` 기록 컬럼 전체 목록

아래 표는 역사적 테이블 재구성 migration의 같은 컬럼을 한 행으로
합쳤다. “JS 파서 없음”은 서비스에서 값이 raw row로 반환되거나 SQL
정렬/비교에만 쓰인다는 뜻이다.

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
