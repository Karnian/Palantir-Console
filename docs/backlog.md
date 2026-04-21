# Palantir Console Backlog

> Last updated: 2026-04-22 (post PR #117)
> 
> 이 문서는 *현재 시점에서* 남은 작업들을 카테고리별로 정리한다.
> 완료된 작업은 [handoff-post-scenario-review.md](./handoff-post-scenario-review.md) 및 각 spec 문서의 Implementation Log를 본다.

## 카테고리 정의

| 카테고리 | 의미 |
|---------|------|
| **Ready** | 외부 트리거 없이 지금 당장 착수 가능. blocker 없음. |
| **Data-wait** | 기능적으로는 준비되었으나 착수 여부 결정에 운영 데이터 / 관측 기간이 필요한 항목. |
| **Trigger-wait** | 사용자 선언 (use case 발생) 이 필요한 항목. 기능 자체는 spec 에 정의되어 있음. |
| **Draft-review** | spec 은 있으나 Codex cross-review / lock-in 이 아직 안 끝난 항목. |

---

## Ready

### R1. `docs/specs/skill-pack-gallery-v1.1.md` Codex cross-review + lock-in
- **크기**: 반나절 (async 리뷰 + NIT 반영)
- **Spec 상태**: 559줄, "Draft — pending Codex cross-review". Stage 1 (Bundled Registry + Gallery UI) 은 v1.0 그대로 유지, Stage 2 (중앙 Remote Registry) 는 폐기하고 **URL 기반 설치** (US-008/009/010) 로 대체.
- **산출물**:
  - 보안 검증 파이프라인 (§6.2) 리뷰
  - DB 스키마 변경 (§6.3) — `source_url`, `source_hash`, `source_fetched_at`, `origin_type`
  - API 라우트 변경 (§6.5) — URL preview / install / update check
  - 사용자 편집 필드 (name/scope/project_id/priority/conflict_policy) 보존 정책
- **Why Ready**: 구현 착수 시점에 또 다시 5라운드 교차검증 돌리지 않으려면 lock-in 이 먼저여야 함 (M1 전례).
- **Blocker 없음**

### R2. `docs/specs/manager-session-ui.md` 구현 gap 분석
- **크기**: 반나절 ~ 1일 (읽기 + 현 구현과 diff 표 작성)
- **Spec 상태**: 1001줄, Scale L (2-3주 구현), "Design Proposal (구현 전 검토 필요)". Information Architecture / Status system / Layout / Component Hierarchy / Manager Chat / Session Overview 구조 설계.
- **산출물**:
  - 현재 `ManagerView` / `SessionsView` / `ManagerChat` / `SessionGrid` 컴포넌트가 Proposal 의 어디까지 커버하는지 매트릭스
  - Phase 분할 가능한 작은 작업들로 쪼개기
  - "spec 의 어느 부분은 이미 현 구현과 동일, 어느 부분은 미구현" 명확화
- **Why Ready**: Proposal 채택 여부 결정을 위해 diff 정량화 선행.

### R3. `install-from-url.test.js` flaky 원인 고정
- **크기**: 1-2시간
- **증상**: 병렬 실행 시 간헐적 409 (name collision). 이번 세션의 flake 2건과는 별개인 pre-existing.
- **Why Ready**: flake 2건 (#117) 으로 test noise 대폭 감소했으므로 이것까지 고치면 완전 clean. 재현 빈도 낮아서 priority 낮지만 스코프 작음.

### R4. `docs/test-scenarios.md` stale 점검
- **크기**: 2-3시간
- **Context**: 2026-04-19 세션 기준으로 AUTH-01/02, KBD-04, 헤더 정정 완료 (`6948b8a`). 그 후 M1/M2/B3 에서 새 이벤트/필드 추가됨 — 시나리오에 반영 안 됨.
- **산출물**: `mcp:legacy_alias_conflict` 관련 시나리오 (worker path / PM path), `npm run diagnose:mcp` 도구 검증 시나리오 추가.

---

## Data-wait

### D1. M3 — Codex MCP `env` argv leak → file-based config transport
- **Tracked as**: [#113](https://github.com/Karnian/Palantir-Console/issues/113)
- **Scope 추정**: Large. Codex 0.120 공식 `--config-file`급 진입점 부재 → upstream 기여 or Palantir-owned TOML fragment + 명시적 Codex 부팅 경로.
- **착수 기준** (Codex M2 권장):
  - 1-2주 실사용 관측
  - `runs` 테이블 `mcp:legacy_alias_conflict` event 빈도
  - alias 분포 (어떤 MCP 가 주로 충돌?)
  - 사용자 무시율 (event 발생했는데 run 이 의도대로 완료됐나?)
- **대체 지표 (관측 불충분 시)**:
  - 보안 정책상 argv leak 즉시 제거 필요 선언
  - 운영자가 `npm run diagnose:mcp` 경고를 해결 못 하는 패턴이 반복
- **관측 시작**: 2026-04-22 (PR #117 merge). 1-2주 후 = 2026-05-06 ~ 2026-05-13 사이 결정 포인트.

---

## Trigger-wait

### T1. Phase 3b — Claude PM resume
- **Spec**: `docs/specs/manager-v3-multilayer.md` §9.6
- **Trigger**: "Claude PM use case 발생" 사용자 선언.
- **Why deferred**: Codex PM (Phase 3a) 로 모든 use case 커버 중. Claude PM 을 쓸 실제 요구가 없는 상태에서 adapter contract / recovery / event 정규화 변경은 over-build.
- **착수 시 참고**: manager-v3-multilayer.md §9.6 (entire), 원칙 #9 (sandbox bypass 정책), `pmSpawnService` + `pmCleanupService` 의 현재 Codex 전용 경로를 어떻게 adapter-agnostic 하게 만들지.

---

## Draft-review (R1/R2 와 겹치지만 별도 서술)

| Spec | 줄수 | 상태 | 다음 단계 |
|------|-----|------|----------|
| `skill-pack-gallery-v1.1.md` | 559 | Draft — pending Codex cross-review | R1 |
| `manager-session-ui.md` | 1001 | Design Proposal | R2 |

---

## Non-backlog: 진행 방식 규율

(이 문서를 업데이트할 때 다음 세션이 일관된 출발점을 갖도록)

- **완료 항목 이동**: Ready/Data-wait/Trigger-wait 에서 완료되면 해당 섹션에서 제거하고 `handoff-post-scenario-review.md` 의 "완료된 작업 요약" 에 한 줄 추가. 이중 관리 금지.
- **새 항목 추가**: spec 또는 issue 가 먼저 생겨야 함. backlog 는 aggregator, source of truth 아님.
- **Last updated 날짜** 갱신: 편집 시마다 맨 위 timestamp.

---

## 참고 링크

- 전체 phase 구현 기록: `docs/specs/manager-v3-multilayer.md` §15 Implementation Log
- Worker preset 경로: `docs/specs/worker-preset-and-plugin-injection.md` (M1/M2/M3 known-limit 포함)
- Skill Pack v1.0: `docs/specs/skill-pack-gallery.md`
- Skill Pack v1.1 (draft): `docs/specs/skill-pack-gallery-v1.1.md`
- Manager UI Proposal: `docs/specs/manager-session-ui.md`
- 이번 세션 handoff: `docs/handoff-post-scenario-review.md`
