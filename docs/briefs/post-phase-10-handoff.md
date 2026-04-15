# Post-Phase 10 — 새 세션 핸드오프

> **목적**: Phase 10 완주 후 새 Claude Code 세션이 현재 상태를 빠르게 파악하고 다음 작업으로 진입하기 위한 컨텍스트.
> **작성**: 2026-04-15 | **main HEAD**: `27733a3`

---

## 1. 직전까지 한 일

**v3 Phase 10 (Worker Preset & Plugin Injection) — GREEN, shipped.**

| PR | 내용 |
|---|---|
| #87 | 10A spike (`--bare` auth 호환성) — CONDITIONAL PASS |
| #89 | 10B DB + presetService + REST CRUD |
| #90 | 10C Tier 1 spawn wiring (Claude/Codex/OpenCode worker) |
| #91 | 10D Tier 2 isolated Claude + apiKeyHelper auth |
| #92 | 10E `#presets` UI + ExecuteModal preset 드롭다운 + task.preferred_preset_id |
| #93 | 10F RunInspector "Preset" 탭 + drift 감지 |
| #94 | 10G agent-olympus 경로 + CI fixture + smoke + README |
| #95 | docs cleanup — US-007 EXCLUDED, PRESET 시나리오 18개 추가 |

각 PR Codex 교차리뷰 최종 PASS. `npm test` 727 PASS / 0 fail.

US-007 (host plugin canary listing) 은 정식 제외 — argv-level Tier 2 wiring 검증으로 G1 보장 충분으로 판단. 운영자 수동 검증으로 대체.

## 2. 현재 상태

- **브랜치**: `main`, `origin/main` 동기화.
- **테스트 baseline**: 727 PASS. 알려진 플레이크 (`engine: spawn args` race, `sendInput single-shot`) 는 isolated 재실행 시 항상 PASS.
- **DB 마이그레이션**: 018 적용. `worker_presets`, `run_preset_snapshots`, `runs.preset_id`, `runs.preset_snapshot_hash`, `tasks.preferred_preset_id`.
- **운영자 다음 단계 (코드 작업 아님)**: 실제 ecosystem plugin (예: agent-olympus) 을 `server/plugins/agent-olympus/` 에 드롭하면 즉시 사용 가능. 디렉토리는 gitignored.

## 3. 다음 후보 작업

다음 phase 의 spec 은 아직 없음. 우선순위는 사용자 결정.

1. **새 feature / Phase 11** — spec 작성부터. 사용자 요청 받아야.
2. **MCP Bifrost 연동** (`reference_mcp_bifrost.md` 메모리) — 멀티 워크스페이스 MCP 브릿지. 미시작.
3. **잡일 정리**:
   - Skill Pack v1.1 이후 누적된 작은 UX 개선
   - 알려진 플레이크 2건 (`stream-json-engine.test.js sendInput single-shot`, parallel orphan sweep race) 근본 수정
   - `manager-v3-multilayer.md` Phase 3b (Claude PM resume) — 조건 충족 시 진입

## 4. 새 세션 진입 시

1. `git status` + `git log --oneline -5` — main HEAD `27733a3` 인지 확인.
2. `npm test 2>&1 | tail -5` — 727 PASS baseline 확인 (1 known flake 허용).
3. `docs/specs/worker-preset-and-plugin-injection.md` §12 acceptance — Phase 10 GREEN 확인.
4. 사용자에게 다음 작업 지시 받기. spec 없는 새 작업이면 `/ask codex` 로 옵션 권장안 받아 사용자 협의.

## 5. 자율 모드 규칙 (CLAUDE.md)

- 승인 없이: 브랜치 / 구현 / npm test / Codex PASS / commit / PR / merge / main pull / 다음 phase.
- 승인 필요: spec 재해석 / 이전 결정 충돌 / Codex 5 라운드 미수렴.
- Codex 불가 시 Gemini fallback (현재 GEMINI_API_KEY 없음 → 사용자 보고 후 진행).

---

**이 브리프만으로 새 세션이 현재 컨텍스트를 잡고 사용자 지시를 받을 준비가 끝남.**
