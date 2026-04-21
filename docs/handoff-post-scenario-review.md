# Handoff: Post-M1/M2/B3 + Flake Stabilization

> **상태: 전체 완료** — 2026-04-21/22 세션에서 Codex MCP 주입 재설계 (M1/M2/B3) + flake 2건 제거 + 문서 업데이트.
> 이 파일은 기계/사람 모두를 위한 재입장 요약이다.

## 완료된 작업 요약 (이 세션)

- **PR #114 — M1 (fix)**: Codex worker/PM 의 MCP 주입을 `-c mcp_servers=<JSON>` (broken) → `-c mcp_servers.<alias>.<key>=<TOML>` leaf-level dotted path 로 교체. 공통 유틸 `codexMcpFlatten.js` + fail-closed (malformed shape / silent vanish / 지원 안 되는 type 전부 throw). Codex 교차검증 5 라운드 PASS.
- **PR #115 — M2 (feat)**: `~/.codex/config.toml` legacy alias 충돌 감지 — `mcp:legacy_alias_conflict` run event. worker + PM 양쪽 통합. payload shape 고정 `{ alias, source, message }`. Codex 2 라운드 PASS.
- **PR #116 — B3 (chore)**: `npm run diagnose:mcp` 운영자 진단 도구. spawn 없이 현재 DB preset ↔ user config alias 교집합 출력. flags: `--db`, `--config`, `--fail-on-conflict`, `--json`, `--help`. Codex 3 라운드 PASS.
- **GitHub issue #113 (reopen)**: M3 follow-up — MCP `env` argv leak → file-based transport. M2 event 운영 관측 1-2 주 후 착수 여부 결정.
- **PR #117 — flake 제거 (chore, 진행 중)**:
  1. `preset-route.test.js` 401 flake — `createApp` 호출에 `authToken: null` 명시 (sibling `PALANTIR_TOKEN` leak 차단)
  2. `stream-json-engine.test.js` `sendInput after exit` flake — `sendInput` 이 `proc.exitCode`/`stdin.destroyed`/`stdin.writableEnded` 도 함께 체크 (result 이벤트 → exit 이벤트 race 해결)
  3. CLAUDE.md 업데이트 — Phase 상태 (M1/M2/B3 추가), managerAdapters 목록, tests 목록, 테스트 수 (792 → 835), Key Patterns 에 "Codex MCP 주입" 섹션, Watch-out 항목 3개 추가.

## 현재 상태 기준선

- 브랜치: `main` (이 handoff 커밋 포함 시점)
- 테스트: 835/835 PASS, 5회 연속 stable
- Codex CLI: 0.120.0
- Open issues: **#113** (M3 follow-up, 관측 대기)
- Deferred: Phase 3b (Claude PM resume, 트리거 대기)

## 남은 백로그

전체 항목은 [`backlog.md`](./backlog.md) 에 카테고리별로 정리되어 있음 (Ready / Data-wait / Trigger-wait / Draft-review).
주요 포인트:

- **Data-wait**: M3 (#113) — argv → file-based transport. 2026-04-22 + 1-2주 관측 후 결정.
- **Trigger-wait**: Phase 3b (Claude PM resume).
- **Ready**: skill-pack-gallery v1.1 spec Codex review, manager-session-ui 구현 gap 분석, install-from-url flake, test-scenarios stale 점검.

## 재입장 prompt 예시

```
docs/handoff-post-scenario-review.md 참고. 다음 중 하나 선택:

(1) M3 착수 데이터 근거 검토
    - runs 테이블의 mcp:legacy_alias_conflict event 를 집계
    - `npm run diagnose:mcp` 로 현재 상태 비교
    - 빈도 / alias 분포 / user 무시율 (alias 에 대한 run 이 실제로 실패했는지) 수집
    - 그 후 M3 착수 여부 결정

(2) skill-pack-gallery-v1.1.md Codex cross-review + 구현 착수 여부 결정

(3) 기타 — 사용자 지정
```

## 참고

- Codex async 루틴: `.ao/artifacts/ask/ask-codex-*.md` jsonl 파싱 (collect exit 신뢰 불가).
- M1/M2 구현 위치: `server/services/managerAdapters/codexMcpFlatten.js`, `server/services/managerAdapters/codexUserConfigScan.js`, `server/services/lifecycleService.js` (worker 경로), `server/services/managerAdapters/codexAdapter.js` (PM 경로).
- B3 도구: `scripts/diagnose-mcp-conflicts.mjs` + `npm run diagnose:mcp`.
- Codex 교차검증 세션 artifacts (이 세션):
  - M1: `ask-codex-20260421-195738-1fd7.md` ~ `ask-codex-20260421-214212-37d4.md` (5 rounds)
  - M2: `ask-codex-20260421-230310-744d.md`, `ask-codex-20260421-230837-5d60.md` (2 rounds)
  - B3: `ask-codex-20260421-233824-5c05.md` ~ `ask-codex-20260421-234413-b3c5.md` (3 rounds)
  - M2 권장 전략 결정: `ask-codex-20260421-224906-e518.md`, `ask-codex-20260421-232614-8621.md`
