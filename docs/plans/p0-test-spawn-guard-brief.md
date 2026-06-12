# P0: 테스트의 실제 CLI spawn 차단 — fail-closed spawn guard

> 2026-06-13. 작성: Claude (감독). 구현: Codex. branch: `fix/p0-test-spawn-guard`
> 배경: `docs/incident-2026-06-12-test-claude-spawn-storm.md` — `npm test`의 /execute 계열 테스트가
> 실제 `claude` CLI를 spawn하여 기하급수 증식 (suite당 ~6개 → 피크 ~25개). 테스트는 "spawn이 실패할 것"을
> *가정*만 하고 차단하지 않았음. 이 repo 원칙 #1 (권한 정합성 > prompt 정합성) 위반 상태.

## 목표 (수용 기준)

1. `NODE_TEST_CONTEXT` 환경변수가 존재하거나 `PALANTIR_BLOCK_REAL_SPAWN=1`이면, 모든 워커/매니저
   spawn 경로에서 **fixtures 밖 실행파일 spawn이 typed error로 fail-closed** 된다.
2. `PALANTIR_ALLOW_REAL_SPAWN=1` 명시 시에만 가드 비활성 (의도적 통합 테스트용 opt-in).
3. 전체 `node --test` 그린 + 풀런 동안 실제 `claude`/`codex` CLI 프로세스 spawn **0개**.
4. `package.json`의 `"test"` 스크립트를 `node --test`로 복원, `test:UNSAFE-original` 제거.
5. node 버전 고정: `package.json`에 `"engines": { "node": "^22" }` + 루트 `.nvmrc` (`22`).
   (사고 부원인: brew node v26과 node@22 혼재로 better-sqlite3 ABI 불일치)
6. 신규 `server/tests/spawn-guard.test.js`로 가드 자체를 회귀 보호.

## 구현 지침

### 1. 신규 `server/utils/spawnGuard.js`
- `assertSpawnAllowed({ command, source })` export. `source`는 호출 지점 식별 문자열 (에러 메시지용).
- 활성 판정: `(process.env.NODE_TEST_CONTEXT || process.env.PALANTIR_BLOCK_REAL_SPAWN === '1') && process.env.PALANTIR_ALLOW_REAL_SPAWN !== '1'`.
- 활성 시 허용 목록 (그 외 전부 throw):
  - `process.execPath` (node 자신) 및 node로 실행되는 스크립트
  - `server/tests/fixtures/` 디렉토리 내부로 resolve되는 실행파일 (mock binary 패턴)
- typed error는 `server/utils/errors.js` 스타일을 따르고, 메시지에 `source`와 차단된 `command`를 명시.
- PATH 상의 bare command (`claude` 등)는 resolve 시도 후 판정하되, resolve 실패 시에도 차단 (fail-closed).

### 2. Call site 주입 (스폰 직전, 최소 4곳)
- `server/services/executionEngine.js` — **SubprocessEngine과 TmuxEngine 공통 진입점**.
  주의: tmux 자체가 아니라 **tmux가 실행할 내부 명령**이 차단 대상. TmuxEngine은 세션 생성 전에 내부 command를 검사할 것.
- `server/services/streamJsonEngine.js` (claude manager spawn, ~L190)
- `server/services/managerAdapters/codexAdapter.js` (codex exec spawn, ~L348)
- `server/services/opencodeService.js` / `codexService.js`에 spawn이 있으면 동일 적용.
- 기존 에러 처리 흐름을 그대로 탈 것: worker는 executeTask catch가 run failed 마킹, PM은 TURN_FAILED 경로.
  **새 이벤트 타입/SSE 채널 만들지 말 것** (M2 cardinality 규율).

### 3. 기존 테스트 정합
- "spawn이 실패할 것"을 가정하던 테스트들 (`skill-packs-resolve.test.js`, `preset-spawn.test.js` 등)은
  이제 가드에 의해 **결정적으로** 실패하게 됨 — 수정 없이 그대로 통과해야 함. assertion이 특정 에러 메시지에
  의존하면 그 부분만 조정.
- 엔진 동작 자체를 검증하는 테스트 (`stream-json-engine.test.js`, `manager.test.js`, `manager-codex.test.js` 등)가
  실제 바이너리를 spawn하고 있었다면, `server/tests/fixtures/` 아래 mock binary (node 스크립트)로 대체.
  기존 fixtures 패턴 (`fixtures/plugins/`)을 따르고, 테스트가 mock 경로를 agent command로 주입하는 방식 권장.
- e2e Playwright (별도 `npm run test:e2e`)는 NODE_TEST_CONTEXT가 없으므로 영향 없음 — 건드리지 말 것.

### 4. 검증 절차 (순서 엄수 — 안전상 중요)
1. `node --test server/tests/spawn-guard.test.js`
2. `node --test server/tests/skill-packs-resolve.test.js server/tests/preset-spawn.test.js`
3. `node --test server/tests/manager.test.js server/tests/stream-json-engine.test.js server/tests/manager-codex.test.js`
4. 마지막에만 전체: `node --test --test-concurrency=2` (메모리 16GB 머신 — 기본 동시성은 OOM 위험)
5. 풀런 직후 `ps aux | grep -c "claude --print"` 가 0인지 확인하고 결과를 보고에 포함.

## 금지 사항
- 가드를 prompt/주석/가정으로 대체 금지 — capability 차단이어야 함 (원칙 #1).
- `-c mcp_servers=<JSON>` 형태 재도입 금지 (M1), `useSSE` channels 배열 등 무관 영역 수정 금지.
- 기존 fail-closed 패턴 (pmCleanupService 등) 약화 금지.
- migration / DB 스키마 변경 없음 — 이 작업은 순수 서비스/테스트 레이어.
