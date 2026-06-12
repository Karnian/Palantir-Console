# H-1: Run Harvest — 워커 산출물 자동 수확 (diff 캡처 + 테스트 자동 실행)

> 2026-06-13. Status: **draft r1** (Codex cross-review 전)
> 작성: Claude (감독). 구현 예정: Codex. branch: `feat/h1-run-harvest`
> 배경: 2026-06-12~13 컨셉 리뷰 — "관제 허브의 루프가 안 닫힘. Worker 산출물이 branch에 commit으로
> 남는 데서 끝나고, 검증·수확이 전부 수동" 이 최대 컨셉 갭으로 판정됨. 본 phase 는 그 첫 단계.

---

## 1. 문제

워커 run 이 terminal 상태에 도달하면 `lifecycleService.cleanupRunWorktree` 가 worktree 를
즉시 제거한다 (autosave commit 후 branch 는 보존). 이후 사용자가 얻는 것은 branch 이름뿐:

- **무엇이 바뀌었는지** 콘솔에서 볼 수 없다 (`worktreeService.getWorktreeDiff` 는 구현돼 있으나
  **사용처 0 — dead code**)
- **결과물이 검증됐는지** 알 수 없다 (테스트는 누구도 안 돌림)
- run 완료 알림을 받아도 다음 행동(리뷰→머지)을 위해 터미널로 가야 한다

## 2. 목표 (MVP, B-lite)

worker run terminal 시점에 자동으로:

1. **Diff 캡처** — base..branch 의 stat / 파일 목록 / 커밋 목록을 run event 로 기록
2. **테스트 자동 실행 (opt-in)** — 프로젝트에 `test_command` 가 설정돼 있으면 worktree 제거 *전에*
   그 안에서 실행, 결과를 run event 로 기록
3. **RunInspector 노출** — Harvest 섹션에서 diff 요약 + 테스트 결과 + branch 복사 확인 가능

## 3. Lock-in (이 다섯 줄만 잠근다)

1. **Annotate-only**: harvest 의 어떤 실패도 run 상태를 바꾸거나 worktree cleanup 을 막지 않는다.
   실패는 `harvest:error` 이벤트로만 기록 (reconciliationService 와 동일 철학).
2. **순서**: terminal 전환 → (기존 autosave) → diff 캡처 → 테스트 실행 → worktree 제거.
   테스트는 worktree 가 살아있는 동안만 가능하므로 cleanup 은 harvest 완료 후로 미뤄진다.
3. **Health loop 비차단**: harvest 는 fire-and-forget async. 30s health monitor 를 절대 블록하지 않는다.
4. **이벤트 cardinality 고정**: 신규 SSE 채널 없음 (`run:event` 가 이미 emit됨). 이벤트 타입은
   `harvest:diff` / `harvest:test` / `harvest:error` 3개만. payload shape 는 §5 에 고정.
5. **Manager run 제외**: `is_manager=1` 은 harvest 대상 아님 (기존 lifecycle 가드와 동일 패턴).

## 4. 비범위 (명시적 deferred)

| 항목 | 미루는 이유 | 후속 |
|---|---|---|
| PR 자동 생성 / push | remote/auth/push 정책 얽힘 — 프로젝트별 정책 설계 필요 | H-2 |
| branch 자동 머지 | 동일 | H-2 |
| diff 전문(patch body) 저장·표시 | payload 비대화. stat+파일목록으로 충분한지 운영 관측 후 | H-2 후보 |
| PM 에게 harvest 결과 자동 통지 | parent-notice 시맨틱 재설계 필요 (lock-in #2 건드림) | 별도 |
| test_command 의 preset/task 단위 오버라이드 | 프로젝트 단위로 시작, 필요 시 확장 | 후속 |

## 5. 구현 지침

### 5.1 신규 `server/services/harvestService.js`

```
createHarvestService({ runService, worktreeService, projectService, eventBus })
  → { harvestRun(run, { projectDir }) }   // async, never throws (annotate-only)
```

- `harvestRun` 은 per-run 1회 보장 (in-memory Set dedupe — 프로세스 재시작 후 중복은 DB 의
  기존 `harvest:diff` 이벤트 존재 여부로 차단).
- **diff 캡처**: `worktreeService.getWorktreeDiff` 를 확장해 commits (`git log base..branch
  --oneline`, ≤50줄) 포함. event `harvest:diff` payload:
  `{ base, branch, stat, files, commits, truncated }` — stat ≤8KB, files ≤500개,
  초과 시 truncate + `truncated: true`.
- **테스트 실행**: `projects.test_command` 가 truthy 하고 run.status='completed' 일 때만.
  - `spawn('/bin/sh', ['-c', test_command], { cwd: worktreePath, ... })`
  - timeout 기본 300_000ms (`PALANTIR_HARVEST_TEST_TIMEOUT_MS` 로 조정), 초과 시 SIGKILL
  - event `harvest:test` payload: `{ command, exit_code, passed, timed_out, duration_ms,
    output_tail }` — output_tail 은 stdout+stderr 합산 마지막 ≤8KB
  - **P0 spawn guard 경유 필수**: `/bin/sh` spawn 전 `assertSpawnAllowed` 호출. 테스트 환경에서는
    fixtures 의 fake 커맨드만 통과 (P0 인프라 재사용 — node --test 안에서 real shell 실행 차단됨.
    harvest 유닛 테스트는 `process.execPath` + fixture 스크립트로 test_command 를 구성할 것)
- **에러**: 단계별 try/catch → `harvest:error` `{ stage: 'diff'|'test', error }` 기록 후 다음 단계 진행.

### 5.2 `lifecycleService` 연결 (choke point 단일화)

- terminal 전환 시 worker run 의 cleanup 경로가 현재 복수 존재 (health loop ~L1047,
  run:ended 구독 ~L671 등). **반드시 전체 호출부를 조사**해서 worker terminal 경로를
  `harvestThenCleanup(run)` 하나로 모을 것:
  `harvestService.harvestRun(run) → 완료 후 cleanupRunWorktree(run)` (async chain, 비차단).
- harvest 진행 중 서버 종료 → worktree 잔존. 기존 boot-time orphan 정리 경로가 수습하는지
  확인하고, 없으면 boot cleanup 에 잔존 worktree 제거를 추가 (orphan MCP config 정리와 동일 위치).
- `cleanupRunWorktree` 자체는 변경하지 않는다 (idempotent 유지).

### 5.3 DB — migration 023

```sql
ALTER TABLE projects ADD COLUMN test_command TEXT;  -- NULL = harvest 테스트 단계 skip
```

### 5.4 API / UI

- `projectService` / `routes/projects.js`: `test_command` CRUD 허용 (기존 필드 패턴 따름.
  validate: string ≤500자 또는 null).
- `ProjectsView.js`: 프로젝트 편집 폼에 "테스트 명령" 입력 필드 (한국어 라벨, 토큰만 사용,
  e2e selector attribute 부여 — K-시리즈 규율).
- `RunInspector.js`: Harvest 섹션 추가 — `harvest:diff` 이벤트가 있으면 stat/파일수/커밋수 +
  branch 이름 표시, `harvest:test` 가 있으면 PASS/FAIL/TIMEOUT 뱃지 + output_tail 접기.
  이벤트는 기존 getRunEvents 폴링/구독 경로 재사용 — 신규 API 없음.

### 5.5 보안

- `test_command` 는 인증된 운영자가 설정하는 프로젝트 설정 — agent_profiles.command 와 동일
  신뢰 수준 (이미 임의 CLI 실행 권한). 단 worktree 밖에서 실행 금지 (cwd 고정),
  env 는 `buildManagerSpawnEnv` 수준의 필터링은 불요하되 `.claude-auth.json` 류 secret 변수를
  추가 주입하지 말 것 (현재 process.env 상속 금지 — PATH 등 최소 화이트리스트만).
- output_tail 기록 전 제어문자 strip (로그 인젝션 방어).

## 6. 수용 기준

1. worktree+branch 가 있는 worker run 이 completed 되면 `harvest:diff` 이벤트가 자동 기록된다.
2. `projects.test_command` 설정 시 worktree 안에서 실행되고 `harvest:test` 가 기록된다.
   미설정 시 테스트 단계는 조용히 skip (이벤트 없음).
3. failed run 도 diff 는 캡처되지만 테스트는 실행되지 않는다.
4. harvest 실패(어느 단계든)가 run 상태·cleanup 을 막지 않는다 (`harvest:error` 만 남음).
5. worktree 는 harvest 완료 후 제거된다 — 테스트 실행 시점에 파일이 존재함을 테스트로 증명.
6. manager run 은 harvest 가 발생하지 않는다.
7. RunInspector 에서 diff 요약과 테스트 결과를 확인할 수 있다.
8. 전체 `node --test` 그린 + 신규 `server/tests/harvest.test.js` (단계별 + annotate-only +
   dedupe + timeout + 순서 보장). e2e/visual 영향 시 K-5 규율 (`npm run test:visual`) 준수.

## 7. 테스트 지침

- fixture git repo 패턴은 기존 worktree 테스트 재사용.
- test_command 는 `process.execPath` + `server/tests/fixtures/bin/` 스크립트로 구성
  (spawn guard allowlist 통과). 실패/타임아웃 fixture 도 각각.
- lifecycleService 통합: terminal 전환 → harvest 이벤트 → 그 후에만 worktree 제거 순서를
  이벤트/파일시스템 관찰로 검증.
