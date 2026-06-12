# H-1: Run Harvest — 워커 산출물 자동 수확 (diff 캡처 + 테스트 자동 실행)

> 2026-06-13. Status: **r2 READY** (Codex r1 cross-review 반영 — Q1/Q2/Q3/Q5 FAIL + BLOCKER 2건 전부 해소)
> 작성: Claude (감독). 구현: Codex. branch: `feat/h1-run-harvest`
> 배경: 2026-06-12~13 컨셉 리뷰 — "관제 허브의 루프가 안 닫힘. Worker 산출물이 branch에 commit으로
> 남는 데서 끝나고, 검증·수확이 전부 수동" 이 최대 컨셉 갭으로 판정됨. 본 phase 는 그 첫 단계.
>
> r2 변경: autosave 분리 export + removeWorktree autosave opt (BLOCKER #1), 테스트 산출물 오염 방지
> (BLOCKER #2), cancelled 제외로 sync cleanup 시맨틱 보존, test runner 주입화 (spawn guard 정합),
> getWorktreeDiff 보안 경화, RunInspector polling 연장, boot stale-worktree 정리.

---

## 1. 문제

워커 run 이 terminal 상태에 도달하면 `lifecycleService.cleanupRunWorktree` 가 worktree 를
즉시 제거한다 (autosave commit 후 branch 는 보존). 이후 사용자가 얻는 것은 branch 이름뿐:

- **무엇이 바뀌었는지** 콘솔에서 볼 수 없다 (`worktreeService.getWorktreeDiff` 는 구현돼 있으나
  **사용처 0 — dead code**)
- **결과물이 검증됐는지** 알 수 없다 (테스트는 누구도 안 돌림)
- run 완료 알림을 받아도 다음 행동(리뷰→머지)을 위해 터미널로 가야 한다

## 2. 목표 (MVP, B-lite)

worker run 이 **completed/failed** 로 자연 종료되는 시점에 자동으로:

1. **Autosave** — 에이전트 작업을 먼저 branch 에 커밋 (기존 내부 함수 재사용)
2. **Diff 캡처** — base..branch 의 stat / 파일 목록 / 커밋 목록을 run event 로 기록
3. **테스트 자동 실행 (opt-in)** — `projects.test_command` 가 설정돼 있고 status=completed 면
   worktree 안에서 실행, 결과를 run event 로 기록
4. **RunInspector 노출** — Harvest 섹션에서 diff 요약 + 테스트 결과 확인

## 3. Lock-in

1. **Annotate-only**: harvest 의 어떤 실패도 run 상태를 바꾸거나 worktree cleanup 을 막지 않는다.
   실패는 `harvest:error` 이벤트로만 기록. `harvestRun` 은 **never throws**.
2. **순서 (harvest 가 단일 owner)**: terminal 감지 → `autoSaveWorktree` (에이전트 작업 커밋) →
   diff 캡처 → 테스트 실행 → `removeWorktree(..., { autosave: false })`.
   **테스트가 만든 산출물은 절대 branch 에 커밋되지 않는다** (autosave 가 테스트보다 먼저 + 제거 시 autosave off).
3. **Health loop / cancel 비차단**: harvest 는 fire-and-forget async.
   **cancelled run 은 harvest 대상이 아니며** 기존 동기 cleanup 경로를 그대로 탄다
   (cancelRun → DELETE 연쇄의 sync 가정 보존).
4. **이벤트 cardinality 고정**: 신규 SSE 채널 없음 (`run:event` 가 이미 emit·구독됨).
   이벤트 타입은 `harvest:diff` / `harvest:test` / `harvest:error` 3개만. payload shape §5.1 고정.
5. **Manager run 제외**: `is_manager=1` 은 harvest 대상 아님.

## 4. 비범위 (명시적 deferred)

| 항목 | 미루는 이유 | 후속 |
|---|---|---|
| PR 자동 생성 / push / branch 자동 머지 | remote/auth/push 정책 설계 필요 | H-2 |
| diff 전문(patch body) 저장·표시 | payload 비대화. stat+파일목록으로 충분한지 관측 후 | H-2 후보 |
| test_command 의 진짜 sandbox 격리 | test_command 는 agent_profiles.command 와 동일 신뢰 수준 (운영자 설정, 이미 임의 CLI 실행 권한). cwd 고정은 sandbox 가 아님을 명시하고 거짓 보안 주장 안 함 | egress proxy 등과 함께 별도 |
| cancelled run 의 diff 캡처 | sync cleanup 시맨틱 보존이 우선 | 필요 시 |
| PM 에게 harvest 결과 자동 통지 | parent-notice 시맨틱 재설계 필요 | 별도 |
| run_events LIMIT(1000/500) 초과 장기 run 의 harvest 이벤트 노출 | 이벤트 1000개 초과 run 은 희귀. 관측 후 | 필요 시 |

## 5. 구현 지침

### 5.1 신규 `server/services/harvestService.js`

```
createHarvestService({ runService, worktreeService, projectService, testRunner })
  → { harvestRun(run, { projectDir }) }   // async, never throws (annotate-only)
```

- **dedupe**: per-run 1회 (in-memory Set + 시작 전 DB 의 기존 `harvest:diff`/`harvest:error` 이벤트
  존재 확인). run row 가 도중 삭제되면 (DELETE race) addRunEvent 실패를 삼키고 종료.
- **단계** (각 단계 try/catch → `harvest:error` `{ stage, error }` 기록 후 다음 단계):
  1. `worktreeService.autoSaveWorktree(worktreePath, runId)` — **export 필요** (현재 내부 함수 :142)
  2. diff: `worktreeService.getWorktreeDiff(projectDir, branch)` (경화 버전, §5.3) + commits
     (`git log base..branch --oneline`, ≤50줄). event `harvest:diff`:
     `{ base, branch, stat, files, commits, truncated }` — stat ≤8KB, files ≤500, 초과 시 truncate
     + `truncated: true`. **cap 은 service 가 강제** (DB 는 TEXT 라 안 막아줌).
  3. test (조건: `project.test_command` truthy AND run.status='completed'):
     `spawn(testRunner.bin, [...testRunner.args, test_command], { cwd: worktreePath, env: 최소 env })`
     - **testRunner 주입화**: default `{ bin: '/bin/sh', args: ['-c'] }`. 유닛 테스트는
       `{ bin: process.execPath, args: [<fixtures/bin/fake-test-runner.js>] }` 주입 —
       P0 spawn guard 가 `/bin/sh` 를 차단하므로 (guard allowlist: execPath + fixtures)
       테스트에서 real shell 경로는 실행 불가·불필요. spawn 직전 `assertSpawnAllowed({ command:
       testRunner.bin, source: 'harvestService:test' })` 호출 (prod 에선 guard 비활성).
     - timeout 기본 300_000ms (`PALANTIR_HARVEST_TEST_TIMEOUT_MS`), 초과 시 SIGKILL
     - env: process.env 상속 금지. `{ PATH: executionEngine 과 동일한 증강 PATH, HOME, LANG }`
       화이트리스트만 (npm test 가 동작하는 최소셋. executionEngine.js:244-251 의 extraPaths 패턴 재사용).
     - event `harvest:test`: `{ command, exit_code, passed, timed_out, duration_ms, output_tail }`
       — output_tail 은 stdout+stderr 마지막 ≤8KB, 기록 전 제어문자 strip (로그 인젝션 방어).
  4. `worktreeService.removeWorktree(projectDir, worktreePath, branch, { runId, autosave: false })`
     — 테스트 산출물 폐기. **opt 추가 필요** (§5.3).

### 5.2 `lifecycleService` 연결

- **terminal 경로 전수** (Codex r1 Q1 확인): run:ended 구독 :1042-1048 (funnel — health loop
  :814/:886/:943, cancel :1104, API 직접 전환 routes/runs.js:372-375 모두 여기로),
  executeTask spawn-failure catch :667-680 (동기 cleanup), orphan recovery :1005.
- **run:ended 구독자 분기가 유일한 harvest 진입점**:
  - `to_status ∈ {completed, failed}` AND worker AND worktree 존재 → `harvestService.harvestRun(run)`
    (async, await 안 함 — health loop/emit 비차단). cleanup 은 harvestRun 내부 4단계가 수행.
  - `to_status = 'cancelled'` 또는 그 외 → **기존 동기 cleanupRunWorktree 그대로** (변경 없음).
- executeTask spawn-failure catch 의 동기 cleanup 은 그대로 둔다 (수확할 것 없음. harvest dedupe 가
  이중 진입도 무해하게 만듦).
- **boot stale-worktree 정리 (Codex r1 SERIOUS)**: harvest 도중 서버 종료 시 terminal run 의
  worktree 가 잔존. boot cleanup (orphan MCP config 정리 :1115-1143 과 같은 위치) 에서
  terminal status 인데 worktree 디렉토리가 남은 run 을 스캔해 `removeWorktree` (autosave **on** —
  중단된 에이전트 작업 보존) 호출. 이때 harvest 는 재시도하지 않음 (B-lite).

### 5.3 `worktreeService` 변경 (3건)

1. `autoSaveWorktree` 를 export 목록에 추가 (구현 변경 없음).
2. `removeWorktree(projectDir, worktreePath, branchName, opts)` 에 `opts.autosave` (default `true`)
   추가 — `false` 면 내부 autosave 호출 skip. 기존 호출부는 무변경 (default 로 현행 유지).
3. `getWorktreeDiff` 보안 경화 (Codex r1 Q5): routes/runs.js:37-60 의 기존 방어와 동일하게
   `--no-ext-diff` / `--no-textconv` 플래그 + env wipe 적용. (이 함수는 현재 dead code 라 호환성 부담 없음)

### 5.4 DB — migration 023

```sql
ALTER TABLE projects ADD COLUMN test_command TEXT;  -- NULL = harvest 테스트 단계 skip
```

(022 와 충돌 없음 — projects 테이블엔 trigger 없음, runner 는 파일명 순 적용. Codex r1 Q6 PASS)

### 5.5 API / UI

- `projectService` / `routes/projects.js`: `test_command` CRUD (string ≤500자 또는 null, trim).
- `ProjectsView.js`: 프로젝트 편집 폼에 "테스트 명령" 입력 (한국어 라벨, 디자인 토큰만,
  e2e selector attribute — K-시리즈 규율).
- `RunInspector.js`: Harvest 섹션 — `harvest:diff` 있으면 stat/파일수/커밋수 + branch 이름,
  `harvest:test` 있으면 통과/실패/시간초과 뱃지 + output_tail 접기. 기존 events 경로 재사용, 신규 API 없음.
- **terminal 후 polling 연장 (Codex r1 SERIOUS)**: RunInspector 는 현재 terminal 감지 시 polling
  중단 (:188-210) → async harvest 이벤트를 놓침. terminal 후에도 `harvest:diff` 또는
  `harvest:error` 이벤트가 보일 때까지 최대 120s 폴링 연장 (worktree 없는 run 은 즉시 중단 유지).

### 5.6 시각 변경 규율

ProjectsView/RunInspector 표면 변경 → **머지 전 `npm run test:visual` 실행 의무** (K-5 spec §L4,
M4-a 누락 회귀 lessons learned). baseline 갱신 필요 시 같은 PR 에 사유와 함께 포함.

## 6. 수용 기준

1. worktree+branch 가 있는 worker run 이 completed 되면 `harvest:diff` 이벤트가 자동 기록된다.
2. **uncommitted 에이전트 작업도 diff 에 잡힌다** (autosave 가 diff 보다 먼저 — r2 핵심).
3. `projects.test_command` 설정 시 worktree 안에서 실행되고 `harvest:test` 가 기록된다.
   미설정 시 테스트 단계는 조용히 skip (이벤트 없음).
4. **테스트가 만든 파일은 branch 에 커밋되지 않는다** (removeWorktree autosave off — r2 핵심).
5. failed run 은 autosave+diff 만, 테스트는 실행 안 됨. cancelled run 은 harvest 자체가 없고
   기존 동기 cleanup 경로를 탄다.
6. harvest 실패(어느 단계든)가 run 상태·cleanup 을 막지 않는다.
7. worktree 는 harvest 완료 후 제거된다 — 테스트 실행 시점에 파일 존재를 테스트로 증명.
8. manager run 은 harvest 가 발생하지 않는다.
9. boot 시 terminal run 의 잔존 worktree 가 정리된다 (autosave 보존).
10. RunInspector 에서 terminal 직후 도착하는 harvest 이벤트가 표시된다 (polling 연장).
11. 전체 `node --test` 그린 + 신규 `server/tests/harvest.test.js`. UI 변경분 visual run 그린.

## 7. 테스트 지침

- fixture git repo 패턴은 기존 worktree 테스트 재사용.
- testRunner 주입: `{ bin: process.execPath, args: [fixtures/bin/fake-test-runner.js] }` —
  fixture 는 받은 인자에 따라 exit 0 / exit 1 / sleep(타임아웃 유발) / 산출물 파일 생성을 시뮬레이트.
- 산출물 오염 테스트: fake-test-runner 가 worktree 에 파일을 만들고 → harvest 종료 후 branch 에
  그 파일이 **없음**을 git 으로 검증.
- 순서 테스트: diff 이벤트 payload 에 autosave 된 uncommitted 변경이 포함됨을 검증.
- lifecycleService 통합: terminal 전환 → harvest 이벤트 → 그 후에만 worktree 제거.
- dedupe / never-throws / cancelled-skip / manager-skip / DELETE race (run 삭제 후 addRunEvent 무해) 각각.

## 8. Codex r1 cross-review 처리 기록

| 판정 | 내용 | r2 처리 |
|---|---|---|
| Q1 FAIL | terminal 경로 누락 (executeTask catch, API 직접 전환 등) | §5.2 전수 명시, funnel 단일 진입점 |
| Q2 FAIL | sync cleanup 가정 파괴 + autosave 순서 모순 (BLOCKER) + 재시작 race | cancelled 는 sync 유지, autosave 분리 export, boot 정리 추가 |
| Q3 FAIL | /bin/sh 가 P0 guard 에 차단 | testRunner 주입화 |
| Q4 PASS(제한) | payload cap 은 service 책임, LIMIT 1000 노출 한계 | cap 명시, LIMIT 은 비범위 표기 |
| Q5 FAIL | cwd≠sandbox, getWorktreeDiff 방어 부재, PATH 부족 | 신뢰모델 명시, diff 경화, env 화이트리스트+증강 PATH |
| Q6 PASS | migration 023 안전 | 유지 |
| BLOCKER 2 | autosave 양립불가 / 테스트 산출물 오염 | lock-in #2 재설계로 해소 |
| SERIOUS 2 | RunInspector polling 중단 / boot 정리 부재 | §5.5 / §5.2 반영 |
