# Phase K-5 — Visual Regression Automation Brief

> **상태 (2026-04-29): DRAFT — Codex K-5 r1 권장 7항목 + 추가 4 결정 lock-in 후 구현 PR 분리.**
>
> K-2 launch 후속 후보 #3 ("K-2 시각 회귀 자동화") 의 spec lock-in 문서. K-4-followup-card-markup (PR #167) 으로 K-4 baseline 완전 종결 (waiver 0) 후 마지막 후속 후보 진입. spec PR 분리 (K-4 와 동일 패턴) — 본 PR 은 spec lock-in 만, 구현 + initial baseline 은 별도 PR.

---

## 1. 컨텍스트

### 1.1 K-4 axe a11y 와 K-5 visual regression 의 직교 보완

| 가드 | 잡는 회귀 | 못 잡는 회귀 |
|---|---|---|
| **K-3β** build-time token lock-step | tokens.css 두 light 블록 token key/value 정합 | 실제 렌더 회귀 |
| **K-4** axe a11y (32 시나리오) | WCAG color-contrast / nested-interactive / scrollable-region / etc | 의도치 않은 시각 변경 (token swap → 색이 4.5+ 만족이지만 UI delta), spacing drift, font rendering, layout shift |
| **K-5 (본 phase)** visual regression | 위 모든 시각 변경 — token / spacing / font / layout | 동작 (interaction) — interactive flow 는 별도 |

→ 세 가드 (K-3β + K-4 + K-5) 가 함께 K-2 라이트 모드 launch 의 token contract 회귀를 다층 차단.

### 1.2 e2e 환경 (재사용)

- `@playwright/test ^1.59.1` 이미 설치 + `playwright.config.js` 셋업
- 기존 spec: `smoke.spec.js` + `manager.spec.js` + `a11y.spec.js` (K-4)
- `npm run test:e2e` superset, `npm run test:a11y` 격리
- K-5 도 같은 패턴 — `npm run test:visual` 격리, e2e superset 에 포함

### 1.3 single-developer macOS arm64 환경

- 현재 프로젝트는 단일 maintainer (Karnian, macOS arm64) 가 관리. CI workflow (GitHub Actions) 없음 — 로컬 `npm run test:e2e` 가 PR 게이트.
- 이는 K-5 baseline 의 OS 의존성 (macOS-only baseline) 을 단순화 — multi-OS snapshot suffix 불필요.
- 미래에 CI / multi-OS 지원 시 별도 phase 로 baseline matrix 확장.

---

## 2. Lock-in (Codex K-5 r1 권장 7항목 + 추가 4 결정)

### L1. 검증 대상 routes / matrix

K-4 와 동일: 8 hash routes × 2 themes (dark/light) × 2 viewports (1280×800 desktop, 375×667 mobile) = **32 screenshot baseline**.

### L2. baseline 저장 위치 / 파일명

- **Playwright default** (`server/tests/e2e/visual.spec.js-snapshots/<test-name>-<browser>-<platform>.png`) 사용
  - Codex K-5 r1 권장: snapshot suffix 처리가 자연스럽고 유지보수 쉬움
  - `--platform` suffix 가 macOS-only 환경에서는 단일 (`-darwin.png`)
- snapshot 파일은 git 추적 (PNG 가 commit 됨 — repo weight 영향 있으나 < 100KB × 32 = 3.2MB 이내 예상)

### L3. threshold (Codex K-5 r1 초기값)

- `toHaveScreenshot({ maxDiffPixels: 100, threshold: 0.2 })` — initial baseline PR 에서 실제 noise 보고 조정
- per-screenshot `mask` 옵션으로 dynamic surface 마스킹 (SSE indicator dot, timestamp, etc.)

### L4. CI gate / 갱신 절차

- 본 phase 는 K-4 와 동일하게 **로컬 / 사람-드라이븐 PR 게이트** (CI workflow 비범위)
- diff 발견 시 fail. 의도된 visual change 라면 `npx playwright test visual --update-snapshots` 후 PR 에 새 PNG 포함
- snapshot PR 은 author + Codex 둘 다 PNG diff 확인
- **시각 변경을 동반한 phase PR 은 머지 전 `npm run test:visual` 실행 + baseline 갱신 의무** (PR-4 회귀로 lock-in, 2026-05-05): McpTemplatesView 같이 visible UI 를 만지는 phase 는 visual run 을 안 돌리고 머지하면 mcp-servers 4개 baseline 이 stale 되는 시간만 늘어나고 후속 검증 사이클 PR 들이 이미 broken 한 상태에서 진행돼 발견이 늦어진다 (M4-a 머지 후 4 PR 검증 사이클 동안 발견 못 함). visible UI 를 안 만지는 phase 는 면제.

### L5. baseline 갱신 룰

- **모든 snapshot 갱신 PR 은 reason 명시** — commit body 에 "K-5: snapshot updated for X reason" 명시
- snapshot 파일 단독 변경 PR 금지 — UI 변경 코드와 같은 PR 에 묶음
- 의도하지 않은 diff 발견 시 코드 fix 우선 (snapshot fix 금지)
- **예외 — corrective baseline-only PR** (PR-4 회귀로 lock-in, 2026-05-05): 이미 머지된 UI PR 의 누락 baseline 을 사후 정렬하는 PR 은 baseline-only 로 허용. 단 PR body 에 (1) 어느 머지된 PR 의 누락인지 명시, (2) 갱신 전후 visual run 결과 (예: "28 PASS / 4 FAIL → 32/32 PASS") 명시, (3) 갱신된 PNG 의 시각 검증 사실 (어떤 변경이 캡처됐는지) 명시.

### L6. 비범위

- **animations** (CSS transition / keyframe) — Playwright `reducedMotion: 'reduce'` config 로 disable
- **dynamic content** — PM dispatch / 워커 spawn 결과 / SSE 실시간 update / claude-session-item 목록 (mtime 변경) 등. K-5 비범위.
- **hover state** — interaction state 별도 phase
- **모달 / 드로어 열린 상태** — K-4 비범위와 동일. K-5-followup 으로 분리 가능.
- **CI integration** — 동일. 로컬 / PR 게이트 만.

### L7. 로컬 실행 경로

- `npm run test:visual` = `playwright test --grep @visual` (screenshot spec 만 격리)
- `npm run test:e2e` superset (a11y + visual 모두 포함)
- spec 파일: `server/tests/e2e/visual.spec.js` (단일 파일)

### L8. (추가 결정) Font 안정화

- Playwright `page.evaluate(() => document.fonts.ready)` 로 font loading 완료 후 screenshot
- `theme-init.js` 가 `<head>` 에 동기 로드 — FOUC 없으니 추가 fence 불필요
- self-hosted Inter font (vendor/) 라 환경 의존성 없음

### L9. (추가 결정) Scrollbar 렌더링 안정화

- macOS overlay scrollbar 가 hover 시 나타남 — screenshot 시점에 scrollbar 가 보이지 않도록
- CSS `* { scrollbar-width: none; -ms-overflow-style: none; }` 를 visual scan 한정 inject (page.addStyleTag) 또는 mask
- 권장: page.addStyleTag 로 scrollbar hide (단일 위치 lock-in)

### L10. (추가 결정) Dynamic surface masking

- `[data-visual-mask="true"]` 또는 selector 명시 (e.g. `.claude-session-item`, `.timestamp`, `.relative-time`) 를 `toHaveScreenshot({ mask: [...] })` 에 등록
- mask 영역은 black box 로 처리 — diff 무시
- 본 phase 에서 mask 등록 후 갱신 시 spec 명시 변경 필요
- **Leaf-text 룰** (K-5 NIT, 2026-05-05 lock-in): mask selector 는 반드시 volatile text 를 직접 렌더하는 leaf element 만 가리켜야 한다. EmptyState 같은 fallback 을 함께 swap-in 하는 container 에 mask 를 걸면 fallback 까지 가려져 visual coverage 가 사라진다.
  - DO: `.triage-feed > .triage-item` (feed container 는 비범위)
  - DO: `data-visual-mask="true"` 를 timestamp 를 직접 출력하는 leaf `<div>` / `<span>` 에 부여
  - DON'T: dynamic content ↔ EmptyState 조건부 swap 이 일어나는 section 자체에 class-level mask 를 걸지 말 것
- 속성명 history: 초기 spec L10 은 `data-dynamic="true"` 였으나 의도 (시각 회귀 mask 전용 opt-in) 가 모호 → K-5 NIT 에서 `data-visual-mask="true"` 로 rename. 이름 변경만으로 mask 영역은 동일하므로 baseline 갱신 불필요.

### L11. (추가 결정) 모든 snapshot animation disable

- Playwright config `use: { reducedMotion: 'reduce' }` 전역 설정
- CSS `prefers-reduced-motion` 미지원 케이스는 page.addStyleTag 로 `* { animation: none !important; transition: none !important; }`

### L12. (추가 결정 — Codex K-5 r1 NIT) Browser/project pin + baseline data state

- **Browser**: `chromium` 단일 (`@playwright/test` package.json devDep 으로 자연 lock). visual.spec.js 의 `test.describe.configure({ projects: ['chromium'] })` 또는 playwright.config 의 `projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]` 로 명시 pin.
- **Baseline data state**: dirty DB / 진행 중 work 가 시각에 영향 → **fresh DB / EmptyState fallback** 만 baseline (K-4 L1 와 동일 패턴). `playwright.config.js` 의 `webServer.reuseExistingServer: !process.env.CI` 가 visual run 에선 `false` 강제 (또는 별도 `PALANTIR_DB=:memory:` 또는 fresh `palantir.db` 분리). 명시 lock-in.
- 현재 `playwright.config.js:12` 의 `reuseExistingServer: !process.env.CI` 는 local 에서 dirty server 재사용 위험 — 구현 PR 에서 visual.spec.js 만 별도 server 강제 옵션 검토.

---

## 3. 비범위 (K-5 launch 에 포함 X)

§2 L6 + 다음:
1. **CI workflow** (GitHub Actions matrix) — 별도 phase. multi-OS 시 baseline 갱신 룰도 같이.
2. ~~**모달 / 드로어 / 오버레이 시각 검증**~~ — **부분완료 (2026-07-13, #369)**: 결정적으로 열 수 있는 두 모달(Command Palette=`Ctrl+K`, New Agent modal=`#agents` "새 에이전트" 버튼) 의 열린 상태를 dark/light × desktop 4 시나리오로 캡처. **element-scoped 다이얼로그 스크린샷**(배경/route 커플링 회피) + `toBeVisible()` 계약(열기 실패 시 loud fail). 드로어(DriftDrawer 등, 데이터 필요) + 나머지 모달은 후속. codex-goal 위임 구현 + 호스트 외부검증(결정성 2회 + baseline 육안 + Themis PASS).
3. ~~**interactive state** (hover / focus / pressed)~~ — **부분 완료 (2026-07-13, #368)**: NavSidebar hover(nav-item 툴팁) + keyboard-focus(skip-to-content 링크) 4 시나리오 추가(desktop×2 themes). element-bbox 스냅샷은 out-of-bbox 어포던스(툴팁 `left:100%+8px`·focus ring)를 잘라내므로 **고정 sidebar CLIP 영역** 사용, `.focus()` 는 Chromium `:focus-visible` 미매칭이라 **keyboard Tab** 으로 트리거. `pressed`(active) 는 미보류(전이적·비결정적 캡처 난이도) — 후속.
4. **performance regression** (LCP, CLS) — 별도 phase

---

## 4. Phase 분할

### PR-1: K-5-spec (이 brief)
- `docs/specs/k5-visual-regression-brief.md` 신규
- `docs/backlog.md` Ready 섹션 stamp (K-5 phase entry)
- Codex 교차검증 PASS 후 머지

### PR-2: K-5 구현 + initial baseline
1. `playwright.config.js`:
   - `use: { reducedMotion: 'reduce' }`
2. `server/tests/e2e/visual.spec.js` 신규:
   - 32 시나리오 (8 routes × 2 themes × 2 viewports)
   - 각 시나리오: page.goto + setTheme + scrollbar hide + font ready → `toHaveScreenshot({ mask: [...], maxDiffPixels: 100, threshold: 0.2 })`
3. `package.json` `test:visual` script
4. initial baseline 캡처: `npx playwright test visual --update-snapshots`
5. PR 본문: PNG snapshot 32개 list + 각 mask 영역 사유
6. Codex 교차검증 PASS — visual 부분은 PNG diff 직접 검증 어려우니 spec 정합성 + threshold 적정성 + mask 룰 검증
7. 문서 stamp:
   - CLAUDE.md / AGENT.md Things to Watch Out For 에 K-5 가드 항목
   - backlog #3 strikethrough + 종결
   - handoff §12 신규

### (옵션) PR-3+: K-5-followup
- 모달 / 드로어 / interactive state — phase 후보로 등록만, 트리거 시 진행

---

## 5. 검증 체크리스트 (구현 PR 머지 전)

- [ ] `npm run test:visual` 단독 실행 PASS (initial baseline 캡처 후)
- [ ] `npm run test:e2e` 풀 실행 PASS (a11y + visual superset)
- [ ] 32 screenshot baseline 모두 생성
- [ ] mask 영역이 의도된 dynamic surface 만 가림 (정상 영역 가리지 않음)
- [ ] negative case 수동 검증 — 임의 token 변경 시 정확히 어떤 screenshot 가 fail 하는지 출력
- [ ] PNG file size 합 < 5MB
- [ ] Codex 교차검증 PASS

---

## 6. 회귀 / 알려진 함정

- **macOS 의존**: snapshot 이 macOS arm64 에서 캡처. 다른 OS 에서 `--update-snapshots` 실행 시 baseline drift. CI 도입 시 OS matrix 결정 필요.
- **font 미로딩 시 layout shift**: `document.fonts.ready` await 누락 시 첫 screenshot 의 폰트 fallback 으로 잡힘. 후속 PR 모두 fail.
- **scrollbar hover state**: macOS overlay scrollbar 가 hover 시점에 나타남. 정확한 hide 룰 필수.
- **dynamic surface drift**: PM dispatch / 워커 spawn 등이 fresh DB seed 후에도 random order 또는 timestamp 변동. mask 명시 필수.
- **Playwright browser update**: `npx playwright install` 시 chromium 버전 변경 → font hinting / sub-pixel rendering 미세 변화 → diff. browser 버전 lock 필요 (`@playwright/test` package.json devDep 으로 자연 lock).
- **PNG diff noise**: macOS dark mode 의 native scrollbar / focus ring 등 가끔 1~2 px diff. `maxDiffPixels: 100` 으로 흡수.

---

## 7. 진행 기록 (PR merge 시 stamp)

- [x] **PR-1 K-5-spec** (#168, 2026-04-29) — 본 brief + backlog stamp. Codex r1 NIT 1건 (L12 browser pin + baseline state) 적용 후 PASS.
- [x] **PR-2 K-5 구현** (#169, 2026-04-29) — visual.spec.js (32 시나리오, ~100 라인) + 32 PNG baseline (1.3MB) + playwright.config (reducedMotion + chromium pin) + 문서 stamp 6 파일.
- [x] **PR-3 K-5 NIT — visual-mask rename + leaf-text 룰** (#180, 2026-05-05) — `data-dynamic="true"` → `data-visual-mask="true"` 의도 명확화 + L10 leaf-text 룰 lock-in. McpTemplatesView.js leaf 1곳 / visual.spec.js locator 1곳 / spec L10 / backlog / handoff 갱신. 마스킹 element 동일 → PNG baseline 갱신 불필요.
- [x] **PR-4 K-5 baseline realign — M4-a 회귀 fix** (#181, 2026-05-05) — M4-a (PR #172) 가 `McpTemplatesView` 카드에 transport label (STDIO/HTTP) + 카드 layout 변경을 추가하면서 K-5 baseline 4개 (mcp-servers × dark/light × desktop/mobile) 갱신을 누락한 회귀 fix. `npm run test:visual -- --update-snapshots --grep mcp-servers` 로 갱신, full visual 32/32 PASS 검증. 코드 변경 없음 (PNG only) — L5 룰 ("snapshot 단독 변경 PR 금지") 의 예외: 별도 phase 의 누락 회귀를 정렬하는 baseline-only PR 이라 본 phase 의 코드 변경과 묶을 수 없는 구조적 예외 (M4-a 머지 후 4 PR 검증 사이클 동안 누구도 visual run 을 안 돌려서 발견됨). 향후 visual fail 한 phase PR 머지 전에 baseline 갱신 의무화 운영 규율로 보완.

---

## 8. 참고

- 이전 phase: K-4 (PR #163) — axe a11y automation. K-5 의 직교 보완.
- K-4-followup-contrast 시리즈 (PR #164~#166) — token 정리 + contrast unit test guard.
- K-4-followup-card-markup (PR #167) — card markup 재설계, K-4 baseline 종결.
- K-2 launch brief: `docs/specs/light-theme-k2-brief-2026-04-28.md`.
- handoff: `docs/handoff-post-k2-launch-2026-04-29.md`.
- backlog: `docs/backlog.md`.
- Codex K-5 r1 권장: spec PR 분리 + 7항목 lock-in + 추가 4 결정 (font / scrollbar / dynamic mask / animation disable).
