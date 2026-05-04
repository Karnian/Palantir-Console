# Palantir Console Backlog

> Last updated: 2026-04-30 (post PR #172 — M4-a MCP Streamable HTTP transport 1급 추가 머지. 직전 세션의 K-2~K-5 41 PR 시리즈 + 본 세션의 M4 phase 2 PR 모두 종결)
>
> 이 문서는 *현재 시점에서* 남은 작업들을 카테고리별로 정리한다.
> 완료된 작업의 한 화면 요약 + 새 세션 재입장 prompt 는 [`handoff-post-k2-launch-2026-04-29.md`](./handoff-post-k2-launch-2026-04-29.md) 를 본다 (§9 post-launch fixups + §10 K-3 cleanup + §11 K-4 launch + §12 K-5 launch). 그 이전 시리즈 (M1/M2/B3 + R1/R3/R4) 는 [`handoff-post-scenario-review.md`](./handoff-post-scenario-review.md) 에 있다.

## 카테고리 정의

| 카테고리 | 의미 |
|---------|------|
| **Ready** | 외부 트리거 없이 지금 당장 착수 가능. blocker 없음. |
| **Data-wait** | 기능적으로는 준비되었으나 착수 여부 결정에 운영 데이터 / 관측 기간이 필요한 항목. |
| **Trigger-wait** | 사용자 선언 (use case 발생) 이 필요한 항목. 기능 자체는 spec 에 정의되어 있음. |
| **Draft-review** | spec 은 있으나 Codex cross-review / lock-in 이 아직 안 끝난 항목. |

---

## Ready

**비어 있음.** 모든 K-2 launch 후속 후보 5건 + K-3α/β cleanup + K-4 a11y automation + K-5 visual regression 모두 종결. 신규 phase 트리거 없음.

진행 가능한 후속 nice-to-have (deferred — 사용자 트리거 시):
- **K-5-followup** — 모달/드로어 visual regression (K-5 spec §3 비범위 → 별도 phase)
- **K-5 NIT** — `data-dynamic` → `data-visual-mask` 이름 변경 (의도 명확화) + leaf text 룰 명시
- **K-4 NIT** — moderate severity gate 승격 (현재 report-only)
- **K-4-card-markup NIT** — `.agent-card` / `.project-card` heading semantics 복원 (`<h3>` 별도 위치)
- **interactive state visual** — hover/focus/pressed (Codex K-5 r1 권장 분리)
- **performance regression** (LCP/CLS) — 별도 phase

---

## 최근 완료된 phase 시리즈 (참고)

상세는 모두 `handoff-post-k2-launch-2026-04-29.md` 참고 (단 M4 시리즈는 spec brief 자체가 출처).

### M4-a MCP Streamable HTTP transport (LAUNCHED 2026-04-30)
- **PR #171** spec brief (`docs/specs/m4-mcp-http-streamable-transport-brief.md`, r7 READY, Claude opus-4.7 + Codex gpt-5.5 cross-check 7회), **#172** impl
- `mcp_server_templates.transport ∈ {stdio, http}` discriminated union (migration 022 — table rebuild + INSERT/UPDATE 정합성 trigger 2개: column-shape + transport/alias immutable). Bifrost / Linear / Notion / Sentry 같은 원격 Streamable HTTP MCP 를 워커 spawn 경로에 1급으로 등록 가능.
- **B-lite** — transport 추상화 레이어 / Strategy 패턴 도입 안 함, `if (transport === 'http')` 두 줄 분기로 처리.
- 신규 / 분기 모듈: `ssrf.assertSafeUrl` async helper (validator + preflight 공유, DNS resolve + IP pinning), `codexMcpFlatten` http 분기 (url + bearer_token_env_var leaf only, transport 키 미emit), `mcpPreflight` (HEAD only / 200·204·405·501 pass / 3s timeout / Authorization 첨부 / fail-closed `preset:mcp_unreachable`), `authResolver.resolveBearerForPreflight` 단일 entry point + `buildManagerSpawnEnv` bearerEnvKeys 자동 allowlist, `lifecycleService.executeTask` async 전환, `McpTemplatesView` transport selector + 동적 필드 + 카드 list 분기, `diagnose-mcp-conflicts.mjs` transport / url / bearer-env-key 출력 + `***` 마스킹.
- **테스트**: 902 → 959 (+57). `mcp-preflight.test.js` 신규 (시나리오 매트릭스 + real http server 통합 — lookup hook IP pinning / Authorization 헤더 / 302 redirect_blocked).
- **Codex r1 cross-check**: 0 BLOCKER, 2 SERIOUS (lookup hook 테스트 갭 / `buildManagerSpawnEnv` legacy 주석) 모두 fix 후 머지.
- **§7 deferred**: M4-b (clone-as-other-transport + bulk repoint), M5 (file-based MCP config delivery → issue #113), `'sse'` transport, dynamic `tools/list_changed`, OAuth-aware template, egress proxy. 모두 use case 발생 시.

### K-5 visual regression (LAUNCHED 2026-04-29)
- **PR #168** spec brief, **#169** impl
- Playwright screenshot diff 32 시나리오 (8 routes × 2 themes × 2 viewports), isolated webServer (:4189, fresh DB+HOME+OPENCODE+CODEX), threshold `maxDiffPixels: 100, threshold: 0.2`
- Codex 4 라운드 BLOCK→PASS (DB isolation / host state isolation / prestart bypass fix)

### K-4 WCAG AA a11y automation (LAUNCHED 2026-04-29)
- **PR #162** spec brief, **#163** impl + **#164~167** baseline cleanup (waiver 30 → **0**)
- axe-core 32 시나리오, transitional waiver 시스템, 5 라운드 fix 통해 baseline 완전 종결
- 신규 토큰: `--priority-high-fg`, `--button-primary-bg`, `--origin-url-fg`, `--info-light`. 카드 markup 재설계 (`<article>` + body-spanning trigger button).

### K-3α/β cleanup batch (LAUNCHED 2026-04-29)
- **PR #158** `--status-active-bright`, **#159** `--field-bg` adoption + `--surface-hover` 삭제, **#160** tokens.css light blocks lock-step 자동 가드, **#161** stamp
- K-2 launch 후속 후보 #1, #2, #5 종결

### K-2 라이트 모드 launch (LAUNCHED 2026-04-28)
- **PR #145~#153** Post-K cleanup + Theme Contract α/β/γ + K-2a/b/c/d
- `[data-theme="light"]` 22 의미 토큰 + system 자동 + 사용자 토글 + FOUC 방지 theme-init.js

### UI/UX cleanup follow-up (LAUNCHED 2026-04-26~27)
- **PR #129~#143** Phase F~K-1b (a11y / 한국어화 / 디자인 토큰 / Modal primitive / e2e selector attribute 화) + **#144** docs phase stamp = 16 PR

### Post-launch fixups (2026-04-29)
- **PR #154** handoff stamp, **#155** ExecuteModal task null deref BoardView 빈 화면 fix, **#156** SkillPacksView MCP 템플릿 콜랩서블 제거

---

## 직전 세션 통계 (2026-04-26~04-29 — K-2~K-5 41 PR 시리즈)

> 이 블록은 K-series 시리즈에 한정된 스냅샷이다. 본 세션 (M4 phase) 의 누적 카운트는 아래 footer 를 본다.

- **41 PR 시리즈 종료**: #129~#169
  - UI/UX cleanup follow-up 16 (#129~#144)
  - K-2 hybrid + launch 9 (#145~#153)
  - Post-launch fixups 3 (#154~#156)
  - 정합화 sync 1 (#157)
  - K-3α/β 4 (#158~#161)
  - K-4 spec+impl+followup 6 (#162~#167)
  - K-5 spec+impl 2 (#168~#169)
- **테스트** (직전 세션 종료 시점): node 902 + e2e a11y 32 + visual 32 = **966 tests**
- **3-layer K-2 token contract 방어 완성**:
  1. K-3β (build-time) — tokens.css light blocks lock-step
  2. K-4 (runtime axe) — WCAG rule 검증, baseline waiver 0
  3. K-5 (runtime visual) — Playwright screenshot diff
- **Codex 교차검증**: 모든 PR 머지 전 PASS, BLOCK 8건 모두 fix, NIT 다수 즉시 적용

**M4 phase 후 누적 (2026-04-30 시점)**: node 959 + e2e a11y 32 + visual 32 = **1023 tests** (M4-a 가 +57 node tests).

---

## Data-wait

### D1. M5 — Codex MCP `env` argv leak → file-based config transport
- **Tracked as**: [#113](https://github.com/Karnian/Palantir-Console/issues/113). spec 의 §7 후속 백로그명 = "M5 (가칭)".
- **Scope 추정**: Large. Codex 0.120 공식 `--config-file`급 진입점 부재 → upstream 기여 or Palantir-owned TOML fragment + 명시적 Codex 부팅 경로.
- **M4-a 후 잔여 범위**: HTTP MCP 의 token 노출 (argv) 문제는 M4-a 가 이미 우회 — `bearer_token_env_var` 의 **값** 은 워커 process.env 에서만 읽혀 argv 에 안 나오고, argv 에는 env var **이름** (예: `BIFROST_MCP_TOKEN`) 만 노출됨 (이름은 secret 아님). 본 항목의 잔여 표면은 **stdio MCP 의 env-via-argv** (skill pack 의 `env_overrides` 로 들어간 secret 이 `-c mcp_servers.<alias>.env={KEY="..."}` 로 *값까지* 노출). HTTP 로 마이그레이션 가능한 alias 는 그쪽으로 옮기는 것도 부분 해결책.
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

### T2. M4-b — transport migration helper
- **Spec**: `docs/specs/m4-mcp-http-streamable-transport-brief.md` §7
- **Trigger**: 첫 transport 전환 시나리오 (운영 preset ~10개 넘는 환경) 또는 긴급 transport 전환 사고면.
- **Why deferred**: M4-a 의 `transport+alias immutable` 정책이 운영 preset 1~2개에서는 §3.3 manual path (새 alias 로 새 template + preset edit) 로 충분. ~10개 넘으면 partial-migration risk + 손-편집 부담.
- **착수 시 범위 (~100 LOC)**: (a) clone-as-other-transport 액션, (b) impacted references 표시 (worker_presets / skill_packs / 활성 run preset snapshot 목록), (c) bulk repoint (`mcp_server_ids` / `mcp_servers` 일괄 갱신 + audit event), (d) "참조 0개" 카드 표시.

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
- M4-a Bifrost 연동 runbook: `docs/runbook-m4a-bifrost-setup.md` (셋업 / 검증 명령 / 트러블슈팅 매트릭스 / 운영 패턴)
- 이번 세션 handoff: `docs/handoff-post-k2-launch-2026-04-29.md` (UI/UX cleanup + K-2 launch + K-3 + K-4 + K-5 시리즈 41 PR 종료 stamp)
- 이전 세션 handoff: `docs/handoff-post-scenario-review.md` (M1/M2/B3 + R1/R3/R4)
