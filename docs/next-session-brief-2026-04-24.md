# Next Session Brief — 2026-04-24

> **목적**: 새 세션이 cold-start 에서 남은 백로그를 자율적으로 완료하기 위한 단일 진입 문서.
> 이 문서 하나만 있으면 컨텍스트 재구성 없이 R1/R3/R4 를 순서대로 처리할 수 있어야 한다.

---

## 1. 현재 상태 스냅샷 (진입 기준)

- **Main HEAD**: `01b84bb feat(ui): R2-C /api/manager/summary + SuggestedActions + Manager default landing (#123)` (이후 ao-wip 자동 커밋 몇 개가 얹혀 있을 수 있음 — ignore 가능, 실 작업은 이 커밋 이후에서 시작)
- **테스트 기준선**: `npm test` 882/882 PASS. 선존 flake 1건 (`install-from-url.test.js`) — R3 에서 해결 예정.
- **브랜치 상태**: main 만 살아있음, 모든 feature branch merged + deleted.

### 이전 세션 완료 목록 (되짚기용, 재작업 금지)

| PR | 커밋 | 요약 |
|---|---|---|
| #114 M1 | — | Codex MCP 주입을 leaf-level dotted path 로 교체 + fail-closed flatten |
| #115 M2 | — | `~/.codex/config.toml` legacy alias 충돌 감지 event |
| #116 B3 | — | `npm run diagnose:mcp` 운영자 도구 |
| #117 | — | flake 2건 제거 (preset-route 401, stream-json-engine sendInput race) |
| #118 | 3dca4c3 | docs: backlog.md + handoff 동기화 |
| #119 M3-UI | b2d6f98 | mcp_server_templates UI CRUD (`#mcp-servers` 탭) |
| #120 | 53fd2dc | docs: manager-session-ui gap analysis (R2) |
| #121 R2-A | 9bf3ae2 | AttentionBadge + AttentionStrip |
| #122 R2-B | 95cbcae | RunInspector slide-over + Diff/Costs tabs |
| #123 R2-C | 01b84bb | `/api/manager/summary` + SuggestedActions + Manager 기본 랜딩 |

---

## 2. 진행 규약 (CLAUDE.md 요약)

- **자율 모드 default ON**: Codex PASS + `npm test` green 인 PR 은 승인 없이 squash merge + branch 삭제 + main pull
- **Phase 표준 체인**: branch → 구현 → `npm test` → codex 교차검증 (PASS 까지 반복) → commit → PR → merge → main pull
- **Codex ask 경로** (async, rate-limit 대비): `/Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.3/scripts/ask.mjs async codex <<'EOF' ... EOF` → `collect <jobId> --wait --timeout 600`
- **orchestrator**: agent-olympus:atlas (self-driving, loop-until-done). 각 phase 별로 한 번씩 스폰.
- **브라우저 검증 규칙** (UI 변경 시): `PORT=4199 PALANTIR_TOKEN=dev_test_token_<phase>` 로 격리 서버 + playwright MCP. 사용자가 띄운 프로세스는 건드리지 말 것.
- **ao-wip 자동 커밋 처리**: 브랜치 상에서 wip 커밋이 쌓이면 PR 생성 전에 `git reset --soft main` 으로 squash 해서 의미 있는 단일 커밋으로 정리.

---

## 3. 진행할 작업

### R1 — Skill Pack Gallery v1.1 spec lock-in (반나절)

**상태**: spec 은 559 줄 Draft, **구현은 이미 PR #116 시점에 merged 되어 작동 중**. 남은 것은 Draft → Final 전환.

**Scope**:
- `docs/specs/skill-pack-gallery-v1.1.md` 의 현재 Draft 내용이 실제 구현과 정합적인지 Codex 에 검토받고, 불일치/NIT 반영 후 status 를 `Final / locked-in` 으로 변경
- 코드 변경은 **원칙적으로 없음**. Codex 가 implementation drift 를 발견하면 (예: spec 에 있는데 구현에 빠진 검증, 구현에 있는데 spec 에 없는 필드) 한 PR 에서 같이 처리
- Lock-in 후에는 이 spec 을 기반으로 향후 변경 시 PR 리뷰에서 참조될 수 있도록 문구 정리

**Codex 검토 포인트** (spec 의 각 섹션):
- §1 Lock-in (유지 6개 + 신설 4개 + 폐기 2개) — 현재 코드와 일치?
- §6.2 보안 파이프라인 — `services/ssrf.js` + `registryService.fetchPackFromUrl` 실제 구현과 spec 설명 일치?
- §6.3 DB 스키마 (`source_url`, `source_hash`, `source_fetched_at`, `origin_type`) — 013~017 마이그레이션과 일치?
- §6.5 API 라우트 (URL preview / install / update check) — `routes/skillPacks.js` 의 `/registry/install-url`, `/registry/check-update-url`, `/registry/update-url` 와 일치?
- 사용자 편집 필드 보존 정책 (name / scope / project_id / priority / conflict_policy / bindings) — `skillPackService.updateFromUrl` 실제 구현과 일치?

**참고 파일**:
- `docs/specs/skill-pack-gallery-v1.1.md` (559 줄)
- `docs/specs/skill-pack-gallery.md` (v1.0, 참조용만 — 변경하지 말 것)
- `server/routes/skillPacks.js` (URL install 라우트들)
- `server/services/skillPackService.js` (installFromUrl, updateFromUrl, validateRegistryPack)
- `server/services/registryService.js` (fetchPackFromUrl, issuePreviewToken)
- `server/db/migrations/013_skill_packs.sql`, `016_skill_pack_registry.sql`, `017_skill_pack_source_url.sql`

**완료 기준**:
- Codex 가 "spec ↔ 구현 일치 + 누락된 검증 없음" 판정 (PASS)
- spec 헤더의 `Status: Draft — pending Codex cross-review` → `Status: Final (locked in 2026-04-24)`
- Implementation drift 발견 시 같은 PR 에서 수정 + 테스트
- PR merge + backlog.md 의 R1 항목 제거

---

### R3 — `install-from-url.test.js` flake 안정화 (1-2h)

**상태**: 병렬 실행 시 간헐적 409 (name collision) — 재현 빈도 낮음.

**Scope**:
- `server/tests/install-from-url.test.js` 의 각 test case 가 독립적으로 fixture 를 생성하고 cleanup 하는지 검토
- 현재 의심 원인 (코드 보기 전 가설):
  - 팩 이름이 테스트 간 겹침 (uniqueness 부재)
  - 이전 테스트의 DB state 가 다음 테스트로 leak
  - createTestApp 의 storageRoot/fsRoot/dbDir 격리가 불완전
- 재현: `node --test server/tests/install-from-url.test.js` 를 10회 반복 실행 중 1회 이상 실패하면 flake 재현
- 고정: unique name generator (testName + crypto.randomUUID slice) or per-test DB reset

**Codex 검토 포인트**:
- 수정 후 race 가 실제로 사라지는지 (반복 실행 10회 green 요구)
- cleanup 누락 없는지
- 병렬 실행 안전성 (node `--test` 기본 parallelism)

**참고 파일**:
- `server/tests/install-from-url.test.js`
- `server/tests/preset-route.test.js` (참조 패턴: authToken: null + dbDir isolation)

**완료 기준**:
- 반복 실행 10회 모두 PASS (shell loop: `for i in {1..10}; do node --test server/tests/install-from-url.test.js || echo FAIL $i; done`)
- Codex PASS
- PR merge

---

### R4 — `docs/test-scenarios.md` stale 점검 (2-3h)

**상태**: 1059 줄. 2026-04-19 세션 이후 M1/M2/B3/M3/R2-A/R2-B/R2-C 변경이 반영 안 됨.

**Scope**: 다음 신규 시나리오 추가 + 기존 시나리오 중 변경된 것 업데이트

추가할 시나리오:
1. **M2 `mcp:legacy_alias_conflict` event** — worker path / PM path 에서 `~/.codex/config.toml` 에 같은 alias 있을 때 event emit 확인
2. **B3 `npm run diagnose:mcp`** — spawn 없이 alias 교집합 출력, `--fail-on-conflict` exit code, `--json` 출력 shape
3. **M3 `#mcp-servers` 탭** — 템플릿 create/edit (alias immutable)/delete with references (409 + blocking list)
4. **R2-A AttentionBadge + AttentionStrip** — `needs_input + failed` 카운트 반영, 빈 상태 hide, Dashboard triage-feed regression 없음
5. **R2-B RunInspector slide-over** — 우측에서 슬라이드, Diff 탭 (worktree 있음/없음), Costs 탭 (cost_usd + mgr.usage)
6. **R2-C `/api/manager/summary`** — 집계 정확성 (manager excluded, cost NULL 처리), SuggestedActions (needs_input/failed/idle 조건부), Manager 기본 랜딩

업데이트 검토:
- 기존 "Dashboard 가 기본 랜딩" 기술 → Manager 기본으로 변경됨 (R2-C.3)
- CSP / auth / session 관련 시나리오는 변경 없음 — skip

**참고 파일**:
- `docs/test-scenarios.md`
- `docs/specs/manager-session-ui.md` (R2 phases 스펙 참조)
- `docs/plans/manager-session-ui-gap-analysis.md` (R2 변경 요약)
- CLAUDE.md (M1/M2/B3/M3 기술)

**완료 기준**:
- 6개 신규 시나리오 추가 완료, GIVEN/WHEN/THEN 포맷 유지
- Codex 가 시나리오의 재현 가능성 + 정확성 검토 PASS
- PR merge

---

## 4. 진행하지 않는 작업 (제외 사유 명시)

### D1 — Codex MCP env argv leak (issue #113)

**제외 사유**: 관측 데이터 대기 중. 2026-05-06 ~ 2026-05-13 사이 결정 포인트. 현재 2026-04-24 기준 관측 기간이 아직 절반도 경과 안 함. 착수 기준 (M2 event 빈도, alias 분포, 사용자 무시율) 이 축적되지 않은 상태에서 착수하면 file-based transport 방향이 잘못 설정될 위험.

**다시 열릴 조건**: 2026-05-06 이후 사용자가 "관측 결과 검토" 명시적 지시.

### T1 — Phase 3b Claude PM resume

**제외 사유**: 사용자 use case 선언 대기. Codex PM (Phase 3a) 이 현재 모든 use case 를 커버하고 있어서, Claude PM 이 필요한 실제 요구가 없는 상태에서 adapter contract / recovery / event 정규화 변경은 over-build.

**다시 열릴 조건**: 사용자가 "Claude PM 을 써야 할 프로젝트가 생겼다" 선언.

---

## 5. 참조 파일 맵 (cold-start 용)

| 의도 | 파일 |
|---|---|
| 프로젝트 전체 컨텍스트 | `CLAUDE.md` |
| 현재 백로그 | `docs/backlog.md` |
| Manager Session UI gap | `docs/plans/manager-session-ui-gap-analysis.md` |
| R1 대상 spec | `docs/specs/skill-pack-gallery-v1.1.md` |
| R3 대상 테스트 | `server/tests/install-from-url.test.js` |
| R4 대상 문서 | `docs/test-scenarios.md` |
| 이전 세션 handoff | `docs/handoff-post-scenario-review.md` |
| Atlas skill 위치 | `/Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.3/skills/atlas` |

---

## 6. 진행 순서 권장

1. **R1 먼저** — spec lock-in 이 가장 먼저여야 이후 사용자가 해당 영역에 참조할 때 문서가 Final 상태. Drift 발견되면 코드도 같이 수정되므로 R3/R4 에 영향 없음.
2. **R3** — 작은 flake fix, 병렬 실행 시 noise 감소.
3. **R4** — doc 업데이트. R2 의 모든 변경이 반영되어야 하므로 R2-C 결과가 main 에 있는 지금 시점이 적절.

R1/R3/R4 전부 atlas 로 진행하고, 각 phase 끝마다 Codex 교차검증. 한 세션에서 전부 처리 가능 (총 4-6 시간 예상).

---

## 7. 다음 세션 invocation prompt

다음 문장을 새 세션에서 그대로 붙여넣으세요:

```
docs/next-session-brief-2026-04-24.md 를 먼저 읽고, 남은 백로그 R1 / R3 / R4 를 순서대로 atlas 로 전부 진행해. CLAUDE.md 의 자율 모드 규칙 준수 (codex PASS + 테스트 green 이면 squash merge + 다음 phase 로 자동 진입). 각 phase 끝날 때마다 codex 로 교차검증, PASS 받으면 PR 생성 + merge + main pull. D1 (issue #113) 과 T1 (Claude PM resume) 은 brief 의 §4 사유로 제외. 전체 완료 후 backlog.md 의 해당 항목 제거 + 이 brief 에 완료 도장 찍는 commit 도 포함해.
```

---

## 8. 완료 정의 (Session exit)

이 세션을 닫을 수 있는 조건:
- [x] R1 merged, `skill-pack-gallery-v1.1.md` status = Final
- [x] R3 merged, `install-from-url.test.js` 10회 반복 green
- [x] R4 merged, `test-scenarios.md` 6개 신규 시나리오 + 1개 업데이트 반영
- [x] `docs/backlog.md` 의 Ready 섹션에서 R1/R3/R4 항목 제거
- [x] 이 brief 파일에 `## Completion Stamp` 섹션 추가 (각 PR 번호 + merge 커밋)

---

## Completion Stamp

세션 종료: 2026-04-24.

| Phase | PR | Merge commit | 요약 |
|---|---|---|---|
| R1 | [#124](https://github.com/Karnian/Palantir-Console/pull/124) | `60dda43` | skill-pack-gallery v1.1 Draft → Final (Codex 3 라운드 cross-review PASS, NIT 반영) |
| R3 | [#125](https://github.com/Karnian/Palantir-Console/pull/125) | `9b7a65c` | install-from-url flake 근본 해결 (supertest persistent server + UUID 기반 fixture 이름) |
| R4 | [#126](https://github.com/Karnian/Palantir-Console/pull/126) | `13c4c27` | docs/test-scenarios.md — M2/B3/M3/R2-A/R2-B/R2-C 6개 섹션 추가 + Manager 기본 랜딩 업데이트. Codex 2 라운드 PASS |
| Batch cleanup | [#127](https://github.com/Karnian/Palantir-Console/pull/127) | `99b2530` | backlog.md 에서 R1/R3/R4 제거 + 이 stamp 추가 + handoff 업데이트 |

D1 (issue #113) 과 T1 (Claude PM resume) 은 §4 의 사유로 이 세션에서 제외. 다음 세션은 2026-05-06 ~ 2026-05-13 사이 M2 event 관측 결과로 M3 착수 여부 재평가.
