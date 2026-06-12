# 사고 보고: npm test가 실제 Claude CLI를 증식 spawn (2026-06-12 23:48~00:00 KST)

> 작성: 테스트가 spawn한 headless Claude 인스턴스 중 하나 (`claude --print -p test`, PID 46466).
> 이 파일은 stdout이 테스트 하네스에 버려질 가능성에 대비한 영속 기록임.

## 무슨 일이 있었나

1. `npm test` 실행 → `/execute` 를 호출하는 테스트들 (`server/tests/skill-packs-resolve.test.js` 등)이
   worker spawn 을 시도. 테스트 주석은 "no real claude binary → spawn 실패" 를 **가정**만 하고 차단하지 않음.
2. 이 머신에는 실제 `claude` CLI 가 PATH 에 있어 **suite 1회당 headless claude ~6개가 실제로 spawn** 됨
   (`claude --print --output-format stream-json --verbose -p test ...`).
3. 각 claude 는 이 repo 의 CLAUDE.md (자율 모드 ON) 를 읽고 "test" 프롬프트에 따라 환경 진단 →
   `npm test` / `npm rebuild` 재실행 → **또 claude 들이 spawn** → 기하급수 증식 (branching ~6).
4. 관측 피크: headless claude ~25개 + `node --test` 러너 ~40개 + better-sqlite3 native 빌드 다중 경합
   (load average 25+). 23:59 에 kill -9 반복 스윕으로 전부 정리 (본 인스턴스 1개만 잔존 후 정상 종료).

## 동반 발견된 환경 문제 (수리 완료)

- **brew node 가 simdjson 업그레이드로 깨져 있었음** (`libsimdjson.31.dylib` 소실 → node 실행 불가).
  `brew reinstall node` 로 복구했으나 formula 가 올라가 **v25.8.2 → v26.3.0** 이 됨 (의도치 않은 업그레이드).
- better-sqlite3 는 node 26 prebuilt 가 없고, 이 프로젝트의 `node_modules` 는 **node@22 (ABI 127)** 기준.
  → node@22 로 rebuild 해 둠. **이 프로젝트는 `/opt/homebrew/opt/node@22/bin` 경로의 node 로 실행할 것.**
- claude 세션 셸에 `NODE_TEST_CONTEXT=child-v8` 이 누출되면 `node --test` 가 "skipping running files" 로
  아무것도 안 돌림 → `env -u NODE_TEST_CONTEXT` 필요 (이번 사고처럼 테스트 자식에서 파생된 셸일 때).
- 검증: `ssrf.test.js` + `codex-mcp-flatten.test.js` (claude spawn 없는 단위 테스트) 77/77 PASS.
  전체 suite 는 spawn 벡터 수정 전이라 **의도적으로 재실행하지 않음**.

## 남은 조치 (수정 필요)

1. **[P0] 테스트 spawn fail-closed**: 테스트 환경 (예: `NODE_ENV=test` 또는 전용 env var) 에서
   `executionEngine` / worker spawn 이 실제 CLI 를 실행하지 못하게 차단하거나,
   `tests/fixtures/` 의 mock binary 를 PATH 앞에 강제 주입. "spawn 이 실패할 것" 가정 금지.
2. **[P1] node 버전 정리**: brew 메인 node 가 v26 이 됨. 프로젝트를 node@22 로 고정하든지
   (`.nvmrc`/`package.json engines`/실행 스크립트), better-sqlite3 가 node 26 지원할 때 일괄 이전.
3. **[P2] 잔여물 확인**: 5월 27일부터 떠 있는 orphan `npm run dev` (PID 78282) 는 사용자 프로세스일 수
   있어 건드리지 않음. 불필요하면 직접 종료 요망.
