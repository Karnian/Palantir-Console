# Handoff: UI/UX Cleanup Follow-up + K-2 라이트 모드 LAUNCHED + K-3 + K-4 + K-5

> **상태: 전체 완료** — 2026-04-26 ~ 2026-04-29 세션 (총 **41 PR** / ~60 Codex async review):
> - UI/UX cleanup follow-up 16 PR (#129~#144)
> - K-2 hybrid path + launch 9 PR (#145~#153)
> - Post-launch fixups 3 PR (#154~#156)
> - 정합화 sync 1 PR (#157)
> - K-3α/β cleanup batch 4 PR (#158~#161)
> - K-4 a11y automation 6 PR (#162~#167) — spec + impl + 4 PR baseline cleanup → waiver 0
> - K-5 visual regression 2 PR (#168~#169) — spec + impl + 32 baseline
>
> 합: **16+9+3+1+4+6+2 = 41 PR**
>
> 이 파일은 새 세션 / 재입장 시 컨텍스트 복원을 위한 한 화면 요약이다.
> 자세한 phase 별 산출물은 각 brief 의 §7 진행 기록을 본다.
> §9 post-launch fixups, §10 K-3 cleanup batch, §11 K-4 a11y launch, §12 K-5 visual regression launch 참고.

---

## 1. 한 줄 요약

다크-only Palantir Console 에 라이트 모드 (system 자동 감지 + 사용자 토글) 가 들어갔고, 그 사전 작업으로 UI 카피 한국어 통일 / e2e selector attribute 화 / 디자인 토큰 정리 / race-y 테스트 안정화 / semantic 토큰 인프라 도입 / JS 인라인 색 토큰화 가 모두 끝났다 (#129~#153, 16 + 9 = 25 PR). 그 위에 K-2 launch 후속 후보 5건이 모두 phase 화되어 종결: post-launch 3 (#154~#156) + 정합화 1 (#157) + K-3 4 (#158~#161) + K-4 6 (#162~#167) + K-5 2 (#168~#169). 합 41 PR.

## 2. K-2 launch core 시리즈 (#137~#153, 8 + 5 + 4 = 17 PR)

> 이 §2 는 본 handoff 의 origin scope (K-1b ~ K-2 launch). 그 이전 사전 작업 (Phase F~K-1a, #129~#136 = 8 PR) 은 brief `docs/specs/ui-ux-cleanup-followup-2026-04-26.md` §7 진행 기록. 그 이후 phase (#154~#169 = 16 PR) 는 §9 (post-launch fixups) / §10 (K-3) / §11 (K-4) / §12 (K-5) 참고.

### 2.1 UI/UX cleanup follow-up (8 PR, brief: `docs/specs/ui-ux-cleanup-followup-2026-04-27.md`)
- **#137** K-1b — RunInspector / DriftDrawer / TaskModals 한국어화 + a11y 강화
- **#138** PostK-e2e-migrate — e2e selector attribute 기반 (`data-action` / `data-state` / `data-view` / `data-stat`)
- **#139** K-low-1 — ProjectsView / AgentsView / ManagerChat aux / DirectoryPicker
- **#140** K-low-2 — Presets / SkillPacks (My + Gallery) / McpTemplates / PackPreview / UrlInstall
- **#141** K-low-3 — DashboardView + 시간 helper 한국어 + `parseDate()` ISO Z 파싱 fix
- **#142** Token-Cleanup — `--radius-2xs/sm-plus/pill` + MANAGER_LABELS 중복 제거
- **#143** Test-Stabilize — supertest auto-listen race + authToken leak race + engine.isAlive
- **#144** Docs-Stamp — 시리즈 진행 기록 stamp

### 2.2 K-2 hybrid path (5 PR — light launch 전 사전 정리)
- **#145** Post-K Cleanup — CommandPalette/hooks toast 한국어 + 999px pill 통합 + parseDate zone-less ISO + jsdom regex 안정화
- **#146** Theme Contract α — semantic 토큰 추가 (다크 값만)
- **#147** Theme Contract β — styles.css mechanical swap (visual delta 0)
- **#148** CommandPalette formatter — Codex Post-K NIT cleanup
- **#149** Theme Contract γ — JS 인라인 색 → 의미 토큰

### 2.3 K-2 라이트 모드 launch (4 PR, brief: `docs/specs/light-theme-k2-brief-2026-04-28.md`)
- **#150** K-2a — `[data-theme="light"]` 블록 + 22 의미 토큰 light counterpart + WCAG AA contrast
- **#151** K-2b — `<meta name="theme-color">` mobile chrome + login.html token contract
- **#152** K-2c — CSP-safe `theme-init.js` (FOUC 방지) + NavSidebar 3-state toggle + localStorage
- **#153** K-2d — `prefers-color-scheme` system 자동 + `:root[data-theme="dark"]` override + theme-color 동적 update + cascade contract 가드

## 3. 사용자 동작 매트릭스 (현재)

| OS | toggle 상태 | 결과 |
|----|---|---|
| 다크 | system (미설정) | 다크 |
| 다크 | light | 라이트 |
| 라이트 | system (미설정) | 라이트 (자동) |
| 라이트 | dark | 다크 (cascade 우선) |

토글 위치: NavSidebar 하단 (◑ system / ☀ light / ☽ dark) — 모바일에서는 hide.

## 4. 현재 기준선 (2026-04-29 세션 종료 시점)

- 브랜치: `main` HEAD = `1e5b866` (#169 — K-5 visual regression launch; §12 참고)
- 테스트:
  - **node `npm test`**: **902 tests** (단독 실행 모두 PASS, 풀 런 시 race-y flake 1~2건 알려진 패턴)
  - **e2e a11y `npm run test:a11y`**: **32/32 PASS** (waiver 0)
  - **e2e visual `npm run test:visual`**: **32/32 PASS** (32 PNG baseline, isolated server :4189)
  - 합 **902 + 32 + 32 = 966 tests**
- Open PR: 0 — 모든 작업 commit/push/squash-merge 완료
- Local working tree: clean
- Codex CLI: 0.125.0
- **3-layer K-2 token contract 방어 완성**:
  1. **K-3β** (build-time) — tokens.css 두 light 블록 lock-step
  2. **K-4** (runtime axe) — WCAG rule 검증
  3. **K-5** (runtime visual) — Playwright screenshot diff

## 5. K-2 launch 후속 후보 처리 (모두 종결)

`docs/backlog.md` 와 동기. 5건 모두 phase 화 후 종결:

1. ~~**ManagerChat dotColor `'#22c55e'`**~~ — K-3α PR #158 (`--status-active-bright` 의미 토큰 신규, option B: 의미 분리).

2. ~~**`--field-bg` / `--surface-hover` adoption**~~ — K-3α PR #159. `--field-bg` alias 정정 (`var(--bg-base)`) + form 컨트롤 adopt. `--surface-hover` 는 hover 의미 분화로 단일 alias 부적합 → 삭제 (boot.smoke 토큰 가드 동기).

3. ~~**K-2 시각 회귀 자동화**~~ — **K-5 LAUNCH** PR #168 (spec) + #169 (impl). Playwright screenshot diff 32 시나리오, isolated webServer (:4189, fresh DB+HOME+OPENCODE+CODEX), 32 PNG baseline (920KB). §12 참고.

4. ~~**WCAG AA 자동 검증**~~ — **K-4 LAUNCH** PR #162-#167. axe-core 32 시나리오, transitional waiver 시스템, baseline 30→0 (4 PR followup cleanup). §11 참고.

5. ~~**K-2 brief 업데이트** (lock-step 가드 문서화)~~ — K-3β PR #160. `boot.smoke.test.js` 가 두 light 블록 token key/value 일치 자동 검증.

K-5 launch 후 추가로 분리된 nice-to-have (deferred, 사용자 트리거 시 별도 phase):
- **K-5-followup**: 모달/드로어 visual regression
- **K-5 NIT**: `data-dynamic` → `data-visual-mask` 이름 변경
- **K-4 NIT**: moderate severity gate 승격 (현재 report-only)
- **K-4-card-markup NIT**: heading semantics 복원 (`<h3>` 별도 위치)
- **interactive state visual** (hover/focus/pressed)
- **performance regression** (LCP/CLS)

## 6. 알려진 함정 / 회귀 주의점

- **light/dark 토큰 lock-step**: tokens.css 의 `:root[data-theme="light"]` 블록과 `@media (prefers-color-scheme: light) :root:not([data-theme])` 블록이 중복 정의 (CSS 가 selector 를 media 경계 가로질러 공유 못 함). 새 의미 토큰 추가 시 양쪽 다 갱신 필요. Codex 직접 검증 시 42/42 일치.

- **better-sqlite3 NODE_MODULE_VERSION mismatch**: `npm test` 가 0/X 로 떨어지면 가장 먼저 의심. `cd node_modules/better-sqlite3 && NODE_TLS_REJECT_UNAUTHORIZED=0 npx prebuild-install` 또는 `npm rebuild better-sqlite3` 로 복구.

- **ao-wip hook**: 자동 wip commit 남기므로 `git diff HEAD` 가 비어 있어도 변경은 직전 commit 에 들어 있음. `git show HEAD` 로 확인.

- **race-y flake 알려진 패턴** (Test-Stabilize phase 명시):
  - `engine: sendInput for worker returns false after process exits` — process exit 타이밍
  - `engine: worker spawn args ...` — disk i/o race (timeout 2.5s 로 완화됨)
  - `boot.smoke.test.js` port:null — pre-listen `http.Server` + 'listening'/'error' 이벤트 패턴으로 차단됨
  - 단독 재실행 시 모두 PASS

## 7. 재입장 prompt 예시

```
docs/handoff-post-k2-launch-2026-04-29.md 참고. K-2 launch 후속 후보
5건 모두 종결 (§5). K-3α/β + K-4 + K-5 phase 모두 LAUNCHED. 즉시
착수 가능한 phase 없음. 다음 중 선택:

(1) K-5 launch 후 분리된 nice-to-have (§5 하단) 중 하나 진행
   - K-5-followup (모달 visual regression)
   - K-5 NIT (data-dynamic → data-visual-mask 이름 변경)
   - K-4 NIT (moderate severity gate 승격)
   - K-4-card-markup NIT (heading semantics 복원)
   - interactive state visual (hover/focus/pressed)
   - performance regression (LCP/CLS)

(2) Data-wait / Trigger-wait 항목 (docs/backlog.md 참고)
   - D1 M3 Codex MCP env argv leak (결정 포인트 2026-05-06~5-13)
   - T1 Phase 3b Claude PM resume (사용자 선언 트리거)

(3) 새 기능 / 다른 백로그
```

## 8. 참고

- 이전 세션 handoff: `docs/handoff-post-scenario-review.md` (M1/M2/B3 + R1/R3/R4)
- UI/UX cleanup brief 1: `docs/specs/ui-ux-cleanup-followup-2026-04-26.md` (Phase F~K-1a, 본 세션 진입 이전 완료)
- UI/UX cleanup brief 2: `docs/specs/ui-ux-cleanup-followup-2026-04-27.md` (Phase K-1b 이후)
- K-2 launch brief: `docs/specs/light-theme-k2-brief-2026-04-28.md` (LAUNCHED stamp + 사용자 동작 매트릭스)
- 백로그: `docs/backlog.md`
- Codex 교차검증 artifact: `.ao/artifacts/ask/ask-codex-2026042{6,7,8}-*.jsonl`
- 워크플로우 가이드: `CLAUDE.md` "Working style (autonomous mode default ON)"

## 9. Post-launch fixups (2026-04-29, #154~#156)

K-2 launch (#153) 직후 같은 날 이어진 housekeeping 3 PR. 모두 launch 직후 발견된 작은 결함/중복으로, K-2 본 작업의 일부로 간주해 같은 handoff 에 stamp.

- **#154** docs(handoff) — 본 handoff 문서 + `backlog.md` Last updated 2026-04-29 stamp. 산출물 문서뿐이라 npm test 영향 없음.

- **#155** fix(board): ExecuteModal task null deref → BoardView 빈 화면 (`5569ea3`)
  - **증상**: BoardView 본문 전체가 빈 화면 (트리 throw).
  - **원인**: `TaskModals.js:302` 에서 `task.preferred_preset_id` 를 옵셔널 체이닝 없이 접근. htm tagged template 이 자식 `${...}` 표현식을 tag 호출 *전*에 eager evaluate 하므로 `<\${Modal} open=\${open && !!task}>` 게이트가 자식 평가를 막지 못함 — task 가 null 인 첫 mount 에서 throw.
  - **fix**: `task?.preferred_preset_id` 로 옵셔널 체이닝. 같은 라인 두 번째 occurrence 는 첫 번째의 단축평가로 보호됨.
  - **회귀 가드**: htm 의 자식 eager evaluation 특성상, Modal `open` 게이트는 자식 evaluation 을 막지 않는다 — 모달 내부에서 nullable prop 접근 시 항상 옵셔널 체이닝.

- **#156** ui(skillpacks): MCP 템플릿 콜랩서블 제거 — `#mcp-servers` 와 중복 (`58e48ce`)
  - **배경**: M3-UI (PR #119) 에서 `#mcp-servers` 라우트 + `McpTemplatesView` 가 별도 페이지로 추가되면서, `SkillPacksView` 본문의 "MCP 템플릿 보기" 토글 + 콜랩서블 read-only 표가 그 페이지와 완전 중복.
  - **제거 범위** (~38 라인): `SkillPacksView.js` showTemplates state + 토글 버튼 + 콜랩서블 섹션 / `copy.js` 7개 라벨 (`actionShowTemplates`, `actionHideTemplates`, `templatesTitle`, `templatesAlias`, `templatesCommand`, `templatesDescription`, `templatesAllowedEnv`) / `styles.css` `.skill-templates-*` 6개 룰.
  - **유지**: 편집 모달 안의 "MCP 서버" 탭 (스킬팩이 어떤 MCP alias 를 attach 하는지 + env_overrides 입력) — 의미가 다름. templates fetch 도 모달 MCP 탭 + PresetsView 에서 계속 사용되므로 유지.

## 10. K-3 cleanup batch (2026-04-29, #158~#160)

K-2 launch 후속 후보 5개 (§5) 중 작은 것 3건을 mini-cleanup batch 로 정리. Codex 권장 분할로 K-3α (token cleanup 2건) + K-3β (lock-step 자동 가드 1건) 진행. PR-A/B 직렬, 각 PR 마다 Codex 교차검증 PASS.

- **#158** ui(k3-alpha): `--status-active-bright` 토큰 신규 + ManagerChat dot swap (`42fd27b`)
  - K-2 후속 후보 #1 종결. Theme γ phase 가 mechanical swap 못 했던 ManagerChat:652 인라인 hex `'#22c55e'` 케이스. Codex 권장 옵션 B (의미 토큰 분리) 채택 — `--success` 와 hue/의미 모두 분리 유지.
  - dark `#22c55e` (visual delta 0) / light `#15803d` emerald-700 (`#fafafa` 4.81:1, `#ffffff` 5.02:1, WCAG AA text). hover bg 3.95:1 도 8px Dropdown dot graphical 3:1 만족.
  - `tokens.css` lock-step 3 블록 모두 갱신.

- **#159** ui(k3-alpha): `--field-bg` adoption + `--surface-hover` dead-token 삭제 (`3553196`)
  - K-2 후속 후보 #2 종결. δ phase cancel 로 dead alias 로 남아있던 두 토큰 정리. Codex 권장 옵션 A 의 제한 적용.
  - `--field-bg`: alias `var(--bg-elevated)` → `var(--bg-base)` 정정 (실제 form input chrome 과 의미 통일) + `.form-input/.form-textarea/.form-select` adopt. alias-only 라 light propagation 자동.
  - `--surface-hover`: ~6개 hover 사용처 의미 분화 (selection / row-highlight / interactive-affordance) 라 단일 alias 부적합 → 삭제. 단일 의미 consumer 와 함께 재도입 가드 stamp.
  - `boot.smoke.test.js` 토큰 가드 리스트 + backlog/handoff 동시 갱신 (Codex NIT).

- **#160** test(k3-beta): tokens.css light blocks lock-step 자동 가드 (`b3d8a2a`)
  - K-2 후속 후보 #5 종결. K-2 launch 의 두 light 블록 (`[data-theme="light"]` + `@media prefers-color-scheme:light :root:not([data-theme])`) 사이 token drift 자동 차단.
  - `boot.smoke.test.js` 신규 테스트 — comment strip + brace-balanced block 추출 + token key/value 비교 → 누락 시 빌드 fail + 어느 블록에 빠졌는지 명확한 메시지.
  - alias-only 토큰 (`--field-bg`) 은 base swap 으로 자동 propagate → 테스트 대상 외 (양쪽 light 블록 안에 명시된 토큰만 비교).
  - 수동 negative 검증으로 가드 강도 확인. CLAUDE.md / AGENT.md K-2 lock-step 항목을 "테스트가 막는 계약" 으로 강화.

남은 후속 후보 (모두 별도 phase / spec brief 필요 — §5 참고):
- ~~#3 K-2 시각 회귀 자동화 (Playwright screenshot diff)~~ — K-5 PR #169 launch (§12 참고)
- ~~#4 WCAG AA 자동 검증 (axe-core / pa11y)~~ — K-4 PR #163 launch (§11 참고)

**K-2 launch 후속 후보 5건 모두 종결.**

## 11. K-4 WCAG a11y automation LAUNCH (2026-04-29, #162~#163)

K-2 launch 후속 후보 #4 종결. axe-core 기반 a11y 자동 검증 framework + transitional waiver 시스템.

- **#162** docs(k4-spec): WCAG AA a11y automation phase spec brief — `docs/specs/k4-wcag-a11y-automation-brief.md` lock-in. Codex r1 NIT 4건 적용. PR-1 (spec) + PR-2 (구현) 분리 결정.

- **#163** test(k4): axe-core e2e 통합 + transitional waiver 시스템
  - **deps**: `axe-core ^4.11.3`, `@axe-core/playwright ^4.11.2`
  - **scripts**: `npm run test:a11y` (a11y 격리 실행), `npm run test:e2e` 는 superset
  - **`server/tests/e2e/a11y.spec.js`** — 8 routes × 2 themes (dark/light) × 2 viewports (1280×800, 375×667) = 32 시나리오. axe `wcag2a/wcag2aa/wcag21a/wcag21aa` 4 태그. critical/serious gate, moderate report-only.
  - **scan context**: `[data-view="<route>"]` 루트 한정 (sidebar/header 노이즈 차단)
  - **theme switch**: `localStorage.palantir.theme` set + `page.reload()` 로 `theme-init.js` 재실행 (hash navigation 만으로는 head 스크립트 재실행 안 됨)
  - **fix 들어간 surface**:
    - DashboardView `.triage-feed` — `tabindex="0" role="region" aria-label` 추가 (scrollable-region-focusable)
    - `.task-badge.priority-high` — 신규 토큰 `--priority-high-fg` (dark amber-300 #fcd34d / light amber-800 #92400e) 도입 + body text contrast 4.5:1 만족
  - **transitional waiver 시스템** (`server/tests/e2e/a11y-waivers.json`):
    - schema: `{route, theme, viewport, ruleId, selector, reason, expiresAt, ownerSurface?, followupRef?, approvedBy?, kind?}`
    - `theme: "*"` / `viewport: "*"` wildcard 매칭 (route/ruleId 는 정확)
    - `selector` 는 substring 매칭 (`.nth-child(N)` variant 흡수)
    - **color-contrast 는 `kind: "transitional"` 만 허용** + `expiresAt ≤ 14일` + `ownerSurface`/`followupRef`/`approvedBy` 필수
    - **만료 waiver fail** + **unused waiver fail** (negative case 수동 검증 완료)
  - **K-4 baseline waivers**: 30 row (color-contrast 28 + nested-interactive 2). 모두 transitional/structural baseline. 후속 PR (`K-4-followup-contrast`, `K-4-followup-card-markup`) 으로 정리.
  - **CLAUDE.md / AGENT.md / README** Things to Watch Out For 에 K-4 가드 항목 추가 ("신규 contrast violation 은 waiver 불가" 명시)
  - **테스트**: 단독 `npm run test:a11y` 32/32 PASS. 풀 `npm test` 901/901 PASS.

후속 (모두 K-5 launch 후 종결):
- ~~K-4-followup-contrast~~ — PR #164-166 머지 완료. waiver 30 → 2.
- ~~K-4-followup-card-markup~~ — PR #167 머지 완료. waiver 0.
- ~~#3 K-2 시각 회귀 자동화~~ — K-5 PR #168(spec)+#169(impl) 머지 완료.
