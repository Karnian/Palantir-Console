# Palantir Console Backlog

> Last updated: 2026-04-24 (post PR #126 — R1/R3/R4 완료)
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

*(현재 비어있음 — R1/R2/R3/R4 는 2026-04-24 세션에서 모두 완료. §Non-backlog 의 "완료 항목 이동" 규율에 따라 handoff-post-scenario-review.md 로 이동됨)*

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

## Draft-review

*(현재 비어있음 — `skill-pack-gallery-v1.1.md` 는 PR #124 에서 Final / locked-in, `manager-session-ui.md` 는 PR #120 의 gap analysis + PR #121-123 R2-A/B/C 로 대부분 소화. 추후 새 spec draft 가 생기면 여기에 등록)*

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
