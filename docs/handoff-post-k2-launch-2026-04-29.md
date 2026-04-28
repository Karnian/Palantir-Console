# Handoff: UI/UX Cleanup Follow-up 시리즈 + K-2 라이트 모드 LAUNCHED

> **상태: 전체 완료** — 2026-04-26 ~ 2026-04-28 세션 (총 17 PR / ~30 Codex async review).
>
> 이 파일은 새 세션 / 재입장 시 컨텍스트 복원을 위한 한 화면 요약이다.
> 자세한 phase 별 산출물은 각 brief 의 §7 진행 기록을 본다.

---

## 1. 한 줄 요약

다크-only Palantir Console 에 라이트 모드 (system 자동 감지 + 사용자 토글) 가 들어갔고, 그 사전 작업으로 UI 카피 한국어 통일 / e2e selector attribute 화 / 디자인 토큰 정리 / race-y 테스트 안정화 / semantic 토큰 인프라 도입 / JS 인라인 색 토큰화 가 모두 끝났다. 17 PR 모두 main merge 완료.

## 2. 전체 PR 시리즈 (17 PR)

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

## 4. 현재 기준선 (2026-04-29 세션 시작 시점)

- 브랜치: `main` HEAD = `cc0e010` (#153 K-2d)
- 테스트: **900/900 PASS** (단일 풀 런 기준)
  - race-y flake 1~2건은 brief Test-Stabilize 에 명시된 알려진 패턴 (단독 실행 시 항상 PASS)
- Open PR: 0 — 모든 작업 commit/push/squash-merge 완료
- Local working tree: clean
- Codex CLI: 0.120.0

## 5. 후속 후보 (모두 deferred / nice-to-have)

`docs/backlog.md` Ready 섹션에도 동일 목록 (canonical):

1. **ManagerChat dotColor `'#22c55e'`** — `--success #10b981` 와 다른 green hue. Theme γ 에서 mechanical swap 불가 (값 다름). 의미 토큰 추가 (`--status-active-bright`) 또는 `--success` 통합 결정 필요. 위치: `server/public/app/components/ManagerChat.js:652`.

2. **`--field-bg` / `--surface-hover` adoption** — α 매핑이 form input 실제 bg (`--bg-base`) 와 정합 X. 사례별 검토 필요. δ phase 가 의도적 cancel 됨 — 토큰 자체는 tokens.css 에 alias 로 남아 있음.

3. **K-2 시각 회귀 자동화** — Playwright screenshot diff (다크/라이트 양쪽). 현재는 manual smoke. 별도 phase 권장.

4. **WCAG AA 자동 검증** — axe-core / pa11y CI 도입. 현재 contrast 는 Codex 측정으로 검증 (light 기준 status/priority/accent 모두 ≥4.5:1). 자동화는 별도 phase.

5. **K-2 brief 업데이트** — 라이트 모드 launch 후 새 surface (예: 미래 새 컴포넌트) 가 라이트 토큰 미정의 시 회귀 위험. 새 surface 추가 시 양쪽 (`[data-theme="light"]` + `@media :root:not([data-theme])`) 모두 lock-step 갱신 가드 필요.

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
docs/handoff-post-k2-launch-2026-04-29.md 참고.

다음 중 하나 선택:

(1) 후속 후보 (§5) 중 하나 진행
   - ManagerChat green 토큰 통합
   - --field-bg / --surface-hover adoption
   - Playwright 시각 회귀 자동화 (다크/라이트)
   - axe-core / pa11y WCAG 자동화

(2) 새 기능 / 다른 백로그 (M3 / Phase 3b 등 — handoff-post-scenario-review.md 참고)

(3) 기타 — 사용자 지정
```

## 8. 참고

- 이전 세션 handoff: `docs/handoff-post-scenario-review.md` (M1/M2/B3 + R1/R3/R4)
- UI/UX cleanup brief 1: `docs/specs/ui-ux-cleanup-followup-2026-04-26.md` (Phase F~K-1a, 본 세션 진입 이전 완료)
- UI/UX cleanup brief 2: `docs/specs/ui-ux-cleanup-followup-2026-04-27.md` (Phase K-1b 이후)
- K-2 launch brief: `docs/specs/light-theme-k2-brief-2026-04-28.md` (LAUNCHED stamp + 사용자 동작 매트릭스)
- 백로그: `docs/backlog.md`
- Codex 교차검증 artifact: `.ao/artifacts/ask/ask-codex-2026042{6,7,8}-*.jsonl`
- 워크플로우 가이드: `CLAUDE.md` "Working style (autonomous mode default ON)"
