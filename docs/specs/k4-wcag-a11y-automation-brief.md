# Phase K-4 — WCAG AA a11y Automation Brief

> **상태 (2026-04-29): DRAFT — Codex K-4 r1 권장 7항목 lock-in 후 구현 PR 분리 진행.**
>
> 이 brief 는 K-2 launch 후속 후보 #4 ("WCAG AA 자동 검증") 의 spec lock-in 문서다. K-3α/β cleanup batch 종료 후 다음 단일 phase 로 선정 (`docs/handoff-post-k2-launch-2026-04-29.md` §10 + Codex K-3 다음 phase 협의 결과).

---

## 1. 컨텍스트

### 1.1 현재 a11y 가드 상태 (2026-04-29 main)

| 가드 | 형태 | 한계 |
|---|---|---|
| K-2a launch 시 contrast 측정 | manual (Codex 수동 계산) | 회귀 시 재측정 안 함 — 새 컴포넌트 / 토큰 변경 시 silent regression |
| K-3β `boot.smoke` token lock-step | 자동 (build) | tokens.css 두 light 블록 정합만 검증. 실제 렌더 contrast / label / ARIA / focus order 는 검증 X |
| K-2c `theme-init.js` FOUC 방지 | runtime | a11y 가드 아님 |
| `e2e/smoke.spec.js` 8 routes | Playwright | route 렌더 + 일부 nav 동작만. a11y 검증 0건 |

### 1.2 K-3β 와 K-4 의 보완성 (Codex 권장 사유)

K-3β 가드와 axe-core 의 검증 영역 차이:
- **K-3β**: tokens.css 두 light 블록의 token key/value 정합 (build-time)
- **axe-core**: 실제 rendered DOM 의 color contrast + label/role/ARIA/focus/landmark 검증 (runtime)

K-3β 통과인데 컴포넌트 조합으로 contrast 가 깨지는 케이스 (예: 토큰 위에 인라인 hex 가 덮음, 새 컴포넌트가 토큰 미사용, dynamic class 가 a11y 룰 위반) 는 axe-core 만 잡는다. 두 가드는 직교 — K-4 가 K-3β 의 자연스러운 보완.

### 1.3 e2e 환경 (재사용)

- `@playwright/test ^1.59.1` 이미 설치 (`devDependencies`)
- `playwright.config.js` — testDir `./server/tests/e2e`, baseURL `http://localhost:4177`, webServer `npm start`
- 기존 spec: `smoke.spec.js` (10 tests, 8 routes 커버) + `manager.spec.js`
- `npm run test:e2e` = `npx playwright test`

→ axe-core 통합은 Playwright 위에 얹는 게 가장 작은 변경. 새 러너 / 새 환경 변수 / 새 CI 잡 도입 불필요.

---

## 2. Lock-in (Codex K-4 r1 권장 7항목 + 본 brief 의 보강)

### L1. 검증 대상 routes + scan context

8 hash routes 전부 + 다크/라이트 양쪽:
- `#dashboard`, `#manager`, `#board`, `#projects`, `#agents`, `#skills`, `#presets`, `#mcp-servers`

→ 16 페이지 axe scan (8 × 2 themes). 모달/드로어/오버레이는 본 phase 비범위 (K-4-followup 으로 분리, §3 참고).

**Scan context** (Codex K-4 r1 NIT):
- 각 route 의 `[data-view="<route>"]` 루트만 axe context 로 지정 (sidebar/header 의 동일 violation 이 route 마다 반복되는 노이즈 방지).
- sidebar/header 자체는 별도 단일 시나리오 (`[data-view="dashboard"]` 의 시나리오에서 sidebar 도 같이 scan 하거나, 별도 `nav.nav-sidebar` context 시나리오 1개) — 구현 PR 결정 사항이지만 중복 카운팅 금지.

**Baseline state** (Codex K-4 r1 NIT):
- 서버 상태 영향 받는 routes (`#manager`, `#projects`, `#agents`, `#presets`, `#mcp-servers`) 는 **fresh DB / 빈 상태** 에서 scan. test 시작 시 `npm start` 가 새 `palantir.db` 로 띄우거나 (이미 webServer reuseExistingServer false 인 CI 모드와 동일), 또는 `palantir.db` 가 있어도 axe scan 자체는 빈 상태 fallback UI (EmptyState) 가 a11y 만족하는지 검증.
- dynamic content (PM dispatch / 워커 spawn 결과) 는 §3 비범위.

### L2. viewport matrix

초기 minimal:
- **desktop**: 1280 × 800 (Playwright 기본)
- **mobile / narrow**: 375 × 667 (iPhone SE 1st)

→ phase 시작 시 2 viewport 만. tablet / 다른 desktop size 는 K-4 launch 후 회귀 빈도 보고 추가 결정.

### L3. CI gate severity 정책

axe violation `impact` 4단계 → 정책:
- `critical` / `serious` → **fail** (gate)
- `moderate` → **report-only** (CI 로그에 출력하나 빌드 통과). K-4 launch 후 cleanup 따라 fail 로 승격 검토 (별도 phase).
- `minor` → **report-only**.

→ binary gate 는 critical/serious 만. moderate 까지 즉시 fail 로 잡으면 기존 화면 정리 부담이 phase 사이즈를 L→XL 로 키움.

### L4. WCAG 룰셋 + color contrast 단정

- 룰셋: **`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`** 4개 태그 (axe `withTags()` 호출)
- color contrast: 예외 없이 critical/serious gate 대상. waiver 적용 금지 (K-2 launch 시 manual 측정한 ≥4.5:1 정책 유지).

### L5. waiver 정책 (필수 lock-in)

K-4 launch 시 기존 화면이 critical/serious 룰을 한두 개 fail 하면:
- **즉시 fix** 가 1차 권장 (해당 PR 안에서 처리)
- fix 가 사이즈 큰 경우 → **명시적 waiver** 만 허용. 형식:
  - 위치: `server/tests/e2e/a11y-waivers.json` (단일 파일, 별도 디렉토리 X)
  - 필드: `{ route, theme, viewport, ruleId, selector, reason, expiresAt (YYYY-MM-DD) }`
  - 만료: 30일 default. 갱신 시 PR 에서 명시적 사유 + Codex 리뷰 요구.
  - axe 결과에서 selector + ruleId 가 매칭되면 violation 카운트에서 제외 (test pass).
- waiver 없는 critical/serious violation 은 무조건 빌드 fail.

**Strict waiver 룰** (Codex K-4 r1 NIT):
- **`expiresAt` 만료 → fail**: 만료된 waiver 가 있으면 매칭되더라도 violation 으로 처리 (test fail). 갱신 강제.
- **unused waiver → fail**: waiver 가 정의됐는데 실제 axe 결과에 매칭되는 violation 이 없으면 fail (불필요한 waiver 가 누적되는 것 차단).
- **`color-contrast` ruleId 는 waiver 금지** (L4 의 "color contrast 예외 없음" 정책과 일관). 시도 시 test 즉시 fail + "color-contrast must not be waived; fix the contrast or restructure the surface" 메시지.

L4 / L5 의 충돌 해소: L4 = "color contrast 는 gate 대상" / L5 = "여기서 waiver 도 거부". 두 룰이 함께 작동.

### L6. 실패 산출물

axe violation 발생 시 Playwright/test output 에 다음 5필드 모두 출력 (CI workflow 는 §3 비범위 — 본 룰은 로컬 / 사람-드라이븐 PR 게이트의 출력 형식 정의):
- `route` (hash key)
- `theme` (`dark` | `light`)
- `viewport` (`desktop` | `mobile`)
- `ruleId` (axe rule id, e.g. `color-contrast`)
- `selector` + axe `failureSummary` (개발자가 즉시 수정 가능한 정보)

→ 단일 violation 마다 한 줄 + JSON dump 첨부. test name 은 `a11y: <route> [<theme>/<viewport>]` 패턴으로 grep 가능.

### L7. 로컬 실행 경로

`package.json` scripts:
- **`npm run test:a11y`** = `playwright test --grep '@a11y'` (a11y spec 만 격리 실행)
- 기존 `npm run test:e2e` 는 `--grep-invert '@a11y'` 또는 그대로 (a11y 도 같이 돌리는 superset). 결정: **superset 유지** (e2e 면 a11y 도 같이 돌게).
- a11y spec 파일: `server/tests/e2e/a11y.spec.js` (단일 파일 시작, 라우트별로 `test.describe` 로 분할)

---

## 3. 비범위 (K-4 launch 에 포함 X)

phase 사이즈 통제 + 즉시 launch 가능성 확보:

1. **모달 / 드로어 / 오버레이 a11y** — DriftDrawer, Modal, ExecuteModal, NewTaskModal, PackPreviewModal, UrlInstallDialog, CommandPalette 의 열린 상태 a11y. K-4 launch 후 K-4-followup 으로 분리.
2. **interaction flow a11y** — keyboard nav order, focus trap, screen reader announce 정합. axe 정적 룰셋 외 동작 검증은 별도 phase.
3. **moderate severity 자동 fail 로 승격** — K-4 launch 후 회귀 빈도 보고 결정.
4. **CI integration (GitHub Actions)** — 본 phase 는 로컬 + Playwright 위에서만 동작. `npm run test:a11y` 가 PR 머지 전 사람이 돌리는 형태. CI workflow 추가는 별도 작업 (현재 repo 가 PR 자동 CI 없음 — 동일 패턴 유지).

---

## 4. Phase 분할 (단일 phase, 2 PR 제안)

### PR-1: K-4-spec (이 brief)
- `docs/specs/k4-wcag-a11y-automation-brief.md` 신규
- `docs/backlog.md` Ready 섹션 stamp
- Codex 교차검증 PASS 후 머지 → 다음 PR 의 lock-in source

### PR-2: K-4 구현 (axe-core e2e 통합)
1. `package.json`:
   - `devDependencies`: `axe-core`, `@axe-core/playwright`
   - `scripts`: `test:a11y`
2. `server/tests/e2e/a11y.spec.js` 신규:
   - 8 routes × 2 themes × 2 viewports = 32 시나리오
   - 각 시나리오: 페이지 로드 → axe scan (`wcag2a/wcag2aa/wcag21a/wcag21aa`) → critical/serious violation 추출 → waiver 차감 → assert 0
   - 실패 메시지 § L6 5필드 포함
3. `server/tests/e2e/a11y-waivers.json`: 빈 배열 `[]` 로 시작. 첫 라운드에서 fail 발생 시 fix-or-waiver 선택.
4. `playwright.config.js`: `webServer.timeout` 검토 (axe scan 추가로 30s → 60s 확장 필요할 수 있음). projects 분기 (`chromium` 단일 default).
5. 첫 번째 PASS 본 → Codex 교차검증 → NIT/BLOCK 처리.
6. 문서 stamp:
   - `CLAUDE.md` / `AGENT.md` Things to Watch Out For 에 K-4 가드 항목 추가
   - `docs/backlog.md` 후속 후보 #4 strikethrough + 종결 stamp
   - `docs/handoff-post-k2-launch-2026-04-29.md` §11 신규 (K-4 launch stamp)

→ 구현은 PR-2 안에서 라운드 반복. spec 결정은 본 brief 가 lock-in.

---

## 5. 검증 체크리스트 (구현 PR 머지 전)

- [ ] `npm run test:a11y` 단독 실행 PASS
- [ ] `npm run test:e2e` 풀 실행 PASS (a11y superset)
- [ ] 32 시나리오 (8 routes × 2 themes × 2 viewports) 모두 실행
- [ ] critical/serious violation 0 (or 명시 waiver 만 남음)
- [ ] waiver 가 있다면 expiresAt 30일 이내 + 사유 명시
- [ ] CI 로그에 fail 시 § L6 5필드 모두 출력 확인 (수동 negative 검증)
- [ ] `package.json` 새 deps 가 npm audit clean
- [ ] Codex 교차검증 PASS

---

## 6. 회귀 / 알려진 함정

- **theme switch 타이밍**: Playwright 가 페이지 로드 → localStorage set → reload 시퀀스를 명시적으로 처리해야 함. `theme-init.js` 가 head 에서 동기 실행되므로 set 후 무조건 reload.
- **dynamic content**: PM dispatch / 워커 spawn 등 동적 surface 는 K-4 비범위. 정적 routes 만 scan.
- **CSS color-mix()**: 일부 브라우저에서 axe 가 contrast 계산 못 할 수 있음. K-2 launch 시 Codex manual 측정한 색은 직접 hex 값. axe 가 fail 시 컴포넌트 selector 개별 검사로 cross-check.
- **better-sqlite3 ABI**: Playwright 가 `npm start` webServer 띄우는데, ABI mismatch 시 0/X fail. 새 phase 시작 시 `npm rebuild better-sqlite3` 먼저.
- **report-only moderate noise**: 첫 launch 후 moderate violation 이 다수 발견될 수 있음. test output 가 노이즈 중심이 되지 않도록 moderate 는 별도 섹션 출력 + summary count 만 남김. launch 후 "0 에 가까워지면 fail 승격" (별도 phase) — Codex K-4 r1 합의.

---

## 7. 진행 기록 (PR merge 시 stamp)

- [ ] **PR-1 K-4-spec** — 본 brief + backlog stamp. (PASS / blocker fix / merge 시 stamp)
- [ ] **PR-2 K-4 구현** — axe-core 통합 + 32 시나리오 PASS + waiver 정책 + 문서 stamp.

---

## 8. 참고

- 이전 phase: K-3β (`#160`) — token lock-step 자동 가드. 본 phase 의 보완.
- K-2 launch brief: `docs/specs/light-theme-k2-brief-2026-04-28.md` — light token 22개 + WCAG AA manual 측정 stamp.
- handoff: `docs/handoff-post-k2-launch-2026-04-29.md` §10 — K-3α/β cleanup batch 종료 + 남은 후속 후보 명시.
- backlog: `docs/backlog.md`.
- Codex K-4 r1 권장: `npm run diagnose:mcp` 패턴과 동일한 lockin-after-codex-PASS 진행 형태.
