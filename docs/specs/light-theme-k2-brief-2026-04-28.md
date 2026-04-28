# Light Theme (Phase K-2) Brief — DEFERRED — 2026-04-28 세션 시작

> **Status (2026-04-28): DEFERRED — hybrid path 선택**
>
> Codex 2 라운드 사전검토
> (`.ao/artifacts/ask/ask-codex-20260428-20{1333,2053}-*.jsonl`) 결과
> "라이트 모드 launch 자체는 단일 사용자 / 야간 사용 / 라이트 요청
> 0 환경에서 14~21 review 비용 대비 ROI 낮음" 으로 판단. 대신 다음
> hybrid path 진행:
>
> 1. **Post-K Cleanup PR** — CommandPalette / hooks 토스트 한국어화 +
>    999px pill 통합 + `parseDate()` zone-less ISO + jsdom regex 안정화.
> 2. **Theme Contract α PR** — `--warning-bg-subtle` 등 의미 토큰
>    추가, 다크 값만 정의 (`[data-theme="light"]` 미추가).
> 3. **Theme Contract β PR** — styles.css hardcoded color → 의미
>    토큰 교체.
>
> 본 brief 는 향후 라이트 모드 진입 결정 시 재사용을 위한 reference 로
> 보존. 진입 전에는 본 문서를 다시 검토하고 brief 자체를 갱신 (Codex
> r1 review 의 BLOCK 사항: 순서 뒤집기 + selector 전략 + CSP-safe boot
> + WCAG gate + 의미 토큰 분리) 후 사용자 확인 받을 것.

---

이 문서는 brief `docs/specs/ui-ux-cleanup-followup-2026-04-27.md` §2 의
**Phase K-2 (라이트 모드)** 진입을 위한 별도 brief 다. 04-27 brief 가
"무기한 deferred — 다크 전제 hex/rgba 가 styles.css 광범위 + tokens.css
`color-scheme: dark` 단정 — 토큰만으로 끝날 작업 아님. 단일 PR 으로는
거의 불가능 (sub-phase 분할 필수)" 이라고 명시한 작업의 sub-phase 설계.

---

## 1. 컨텍스트

### 1.1 현재 다크 전제 분포 (2026-04-28 main 기준)

- `server/public/styles/tokens.css`:
  - `:root { color-scheme: dark; }` — OS 단정.
  - 22개 의미 토큰 (`--bg-base #09090b` ~ `--text-muted #63636e` ~
    `--border rgba(255,255,255,0.06)` ~ `--accent #7c5cfc`).
  - alias: `--bg / --fg / --muted / --surface-2 / --surface-3`.
- `server/public/styles.css` (6167 줄):
  - hex literal 100건 + `rgba()` 138건 = **238건 inline color**.
  - `color-mix()` 이미 광범위 사용 — 라이트 도입 시 blend 가 자동
    뒤따를 수 있는 좋은 발판.
  - `@media (prefers-color-scheme: light)` 0건.
- `server/public/app/components/*.js`:
  - 인라인 hex 31건 (DriftDrawer `kindColor`, TaskModals
    `statusColor`, RunInspector drift warning, 등).
  - 일부는 이미 `var(--status-*)` 경유 (Phase I 정리 후).

### 1.2 K-low / Token-Cleanup 후 잔여

- Token-Cleanup (#142) 가 radius / `MANAGER_LABELS` 만 처리.
- Phase I (#133) 가 `worker-card border-left` + `--radius-xs` 도입.
- Phase E (브리프 04-26 §1) 가 alias 도입 + SessionGrid 28건 정리.
- **다크 전제 색 자체는 손대지 않음** — 시각 회귀 위험.

### 1.3 K-2 의 어려움

1. 단순 토큰 swap 으로 안 됨: `rgba(255,255,255,0.06)` 같은 white-on-dark
   border 가 light 에서는 black-on-light 로 뒤집어야 자연스러움.
2. `color-scheme: dark` 단정 제거 시 native form 컨트롤
   (date picker / select / scrollbar) 가 OS 라이트로 즉시 swap —
   사용자가 다크 모드 유지 원할 때 강제 라이트 됨.
3. AAA 대비 (4.5:1 / 3:1) 가 라이트 팔레트에서도 만족해야 함.
4. `color-mix(in srgb, X 8%, transparent)` 류 alpha blend 가 light
   모드에서 너무 흐려지거나 (배경 #ffffff + 8% accent → 거의 안 보임)
   너무 진해질 수 있음 — 사례별 검증 필요.

---

## 2. 작업 분할 — 7 sub-phase

각 sub-phase 는 CLAUDE.md "Phase 기반 작업 표준 체인" 따름. 단일 PR.

### K-2a — Light token foundation
- `tokens.css` 에 light 팔레트 정의:
  - `[data-theme="light"]` 또는 `:root[data-theme="light"]` 블록.
  - 22 의미 토큰의 light counterpart (`--bg-base #fafafa`,
    `--text-primary #18181b`, `--border rgba(0,0,0,0.08)` 등).
  - light 에서도 의미 토큰 이름은 유지 — 다크/라이트 swap 은
    blok 레벨에서.
- `color-scheme: dark` → 그대로 유지 (이번 phase 는 토큰만 도입 +
  활성화 X).
- 검증: 다크 테마 변경 0건 — `<html data-theme="light">` 수동 토글
  시 token swap 만 확인.

### K-2b — `prefers-color-scheme` 자동 감지
- `@media (prefers-color-scheme: light)` block:
  - tokens.css 에 K-2a 의 light 팔레트를 inline.
  - `color-scheme: light dark` 로 변경 (user agent 가 OS 따라감).
- HTML `data-theme` 미설정 시 OS 환경 따라 자동 swap.
- 검증: `matchMedia` 시뮬레이션 + 다크 OS 사용자는 그대로 다크.

### K-2c — User override (theme toggle UI)
- `localStorage['palantir.theme']` ∈ `'system' | 'light' | 'dark'`
  (default `'system'`).
- 부팅 시 `<html data-theme="...">` 적용 (`'system'` → attribute 미설정).
- 토글 UI: NavSidebar 하단 (해/달 아이콘 3-state).
- 검증: 토글 후 새로고침해도 선택 유지, system 으로 리셋 시 OS 추종.

### K-2d — `styles.css` 하드코드 색 정리 (Pass 1: bg / text / border)
- 100 hex 중 색 "primitive" (bg / text / border) 약 60건을
  `var(--bg-* / --text-* / --border)` 로 흡수.
- `rgba(255,255,255, 0.X)` 138건의 다크 가정 — `color-mix()` +
  `var(--text-*)` 로 변환 (light 에서 black-on-light 가 되도록).
- 검증: 다크 모드 시각 회귀 0건 (Playwright 시각 비교 / manual smoke).

### K-2e — `styles.css` 하드코드 색 정리 (Pass 2: status / accent / warning)
- 잔여 hex (status / accent / warning / 차트 류) 약 40건을 토큰화.
- 일부는 이미 `var(--status-*)` 가 있어 alias 경유.
- 검증: 다크 회귀 0 + 라이트 모드 첫 시각 검토.

### K-2f — JS 컴포넌트 인라인 색 정리
- 31 인라인 hex (DriftDrawer / TaskModals / RunInspector 등).
- `style=${{color: '#xxx'}}` → `var(--token)` 또는 enum 매핑.
- 검증: jsdom + manual smoke.

### K-2g — Light 시각 회귀 + WCAG 검증 + Docs
- Playwright 시각 회귀 (다크 + 라이트 양쪽).
- WCAG AA contrast 검증 — `--text-primary` on `--bg-base` 최소 4.5:1.
- token validation 테스트 (`boot.smoke.test.js:106`) 라이트 토큰 추가.
- backlog stamp + 04-28 brief stamp.

---

## 3. 진행 순서 (권장)

```
K-2a  (foundation, 다크 회귀 0)
K-2b  (prefers-color-scheme)
K-2c  (toggle UI)
K-2d  (styles.css pass 1 — bg/text/border)
K-2e  (styles.css pass 2 — status/accent/warning)
K-2f  (JS 인라인 색)
K-2g  (시각 + WCAG + docs)
```

**의도**: K-2a/b/c 는 light 진입 path 만 만들고 시각 회귀 위험 0.
K-2d/e/f 가 실제 색 정리. K-2g 가 검증 + 문서.

각 sub-phase 종료 시 codex 교차검증 PASS 받고 다음 진입 여부 보고.
이전 시리즈와 동일.

---

## 4. 검증 체크리스트 (모든 sub-phase 공통)

- [ ] `npm test` 882/882 PASS
- [ ] 다크 모드 시각 회귀 0 (raster diff or manual smoke)
- [ ] codex 교차검증 PASS — BLOCK 시 즉시 fix 후 재검증 (3 라운드 이상
  안 수렴 시 사용자 확인)
- [ ] WCAG AA 대비 (text on bg ≥ 4.5:1 / large ≥ 3:1) — K-2g 에서 한
  번에 정량 측정.
- [ ] `git diff` phase 단일 주제 유지

---

## 5. 함정·금지사항

- **`color-scheme: light dark` 변경은 K-2b 부터** — K-2a 는 토큰만
  추가, OS scheme 단정은 유지. 사용자가 토글 UI 없이 native form
  컨트롤이 OS 따라가는 변화를 원하지 않을 수 있음.
- **`alpha-on-white` blend 함정**: `rgba(0,0,0,0.06)` 정도로 잘 보이는
  border 가 다크에서는 `rgba(255,255,255,0.06)` 으로 잘 보임. 의미
  토큰 (`--border` 등) 으로 이동하고 light/dark 블록에서 각자 정의.
- **`color-mix(in srgb, X 8%, transparent)` 검증**: light 모드에서
  배경이 `#ffffff` 면 8% blend 가 거의 invisible. 사례별 비율 조정
  (예: 12~16% 로 boost) 필요. K-2g 에서 정량.
- **`rgba(...)` literal 유지하되 토큰화**: literal 자체는 그대로 두되
  `var(--token-rgba-X-Y)` 같이 토큰화 — 향후 swap point 확보.
- **K-2a 실패 시 회귀 차단**: `<html data-theme="light">` 강제 후
  manual smoke 한 번. 깨지면 K-2a 자체 revert.
- **Codex async 호출**: 직전 시리즈와 동일.
  `cat /tmp/prompt.md | node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.3/scripts/ask.mjs async codex`.

---

## 6. 참고 파일

- `server/public/styles/tokens.css` — 22 의미 토큰 + alias.
- `server/public/styles.css` — 6167 줄, 238 inline color literal.
- `server/public/app/components/*.js` — 31 인라인 hex.
- `server/tests/boot.smoke.test.js:106` — token validation.
- 이전 brief: `docs/specs/ui-ux-cleanup-followup-2026-04-27.md` (K-2 deferred 명시).
- Codex artifact 디렉터리: `.ao/artifacts/ask/`.

---

## 7. Codex 사전검토 결과 stamp

K-2a 진입 전 본 brief 자체에 Codex async review 1회 — BLOCK / NIT 응답
받은 후 brief 보완 + 사용자 명시적 승인 후 K-2a 시작.

검토 요청 관점:
1. 7 sub-phase 분할이 적절한가? 더 작게 쪼개야 할지 / 더 묶어도 되는
   sub-phase 가 있는지.
2. K-2a (token-only) → K-2b (prefers media) → K-2c (toggle) 순서가
   회귀 위험 최소화 측면에서 맞는지.
3. `color-scheme: light dark` 변경이 K-2b 가 맞는지 (K-2a 시점 또는
   K-2c 토글 UI 도입 시점이 더 좋은지).
4. `color-mix` alpha blend 가 light 모드에서 invisible 되는 함정에
   대한 대응 (사례별 비율 조정 vs 의미 토큰 추가) 권장.
5. WCAG AA 자동화 — Playwright + `axe-core` 또는 `pa11y` 도입 후 정량
   측정. 단발성 manual 검증으로 충분한지.
6. 7 PR (K-2a~K-2g) 의 추정 작업량 대비 사용자 ROI — 다크-only 유지
   + 토글 미제공이 더 나은 product decision 일 수 있는지.
