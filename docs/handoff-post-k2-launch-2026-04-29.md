# Handoff: UI/UX Cleanup Follow-up 시리즈 + K-2 라이트 모드 LAUNCHED

> **상태: 전체 완료** — 2026-04-26 ~ 2026-04-29 세션 (17 PR launch + 3 PR post-launch fixups = 총 20 PR / ~30 Codex async review).
>
> 이 파일은 새 세션 / 재입장 시 컨텍스트 복원을 위한 한 화면 요약이다.
> 자세한 phase 별 산출물은 각 brief 의 §7 진행 기록을 본다.
> Post-launch 후속 정리는 §9 참고.

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

## 4. 현재 기준선 (2026-04-29 세션 종료 시점)

- 브랜치: `main` HEAD = `58e48ce` (#156 — SkillPacksView MCP 템플릿 콜랩서블 제거; §9 post-launch fixups 참고)
- 테스트: **900 tests** (단독 실행 시 모두 PASS, 풀 런 시 알려진 race-y flake 1~2건)
  - 알려진 flake: `engine: system:init event sets sessionId` 등 — brief Test-Stabilize 에 명시된 패턴, 단독 실행 시 항상 PASS
- Open PR: 0 — 모든 작업 commit/push/squash-merge 완료
- Local working tree: clean
- Codex CLI: 0.120.0

## 5. 후속 후보 (모두 deferred / nice-to-have)

`docs/backlog.md` Ready 섹션에도 동일 목록 (canonical):

1. ~~**ManagerChat dotColor `'#22c55e'`**~~ — K-3α PR #158 에서 `--status-active-bright` 의미 토큰 신규로 종결 (option B: 의미 분리).

2. ~~**`--field-bg` / `--surface-hover` adoption**~~ — K-3α PR-B 에서 종결. `--field-bg` 는 alias 정정 (`var(--bg-base)`) + `.form-input/.form-textarea/.form-select` adopt. `--surface-hover` 는 ~6개 hover 사용처 의미 분화 (selection/row-highlight/interactive-affordance) 라 단일 alias 부적합 → 삭제. boot.smoke.test.js 의 토큰 가드 리스트도 동기 갱신. 단일 의미 consumer 와 함께 재도입.

3. **K-2 시각 회귀 자동화** — Playwright screenshot diff (다크/라이트 양쪽). 현재는 manual smoke. 별도 phase 권장.

4. **WCAG AA 자동 검증** — axe-core / pa11y CI 도입. 현재 contrast 는 Codex 측정으로 검증 (light 기준 status/priority/accent 모두 ≥4.5:1). 자동화는 별도 phase.

5. ~~**K-2 brief 업데이트**~~ — K-3β PR #160 에서 종결. `boot.smoke.test.js` 의 새 테스트 `tokens.css light blocks lock-step (explicit override === system @media)` 가 두 light 블록 (`[data-theme="light"]` + `@media prefers-color-scheme:light :root:not([data-theme])`) 의 token key set + value 일치를 자동 검증. 한 쪽에만 추가하면 빌드 fail. CLAUDE.md / AGENT.md 의 K-2 lock-step 항목도 "테스트가 막는 계약" 으로 stamp.

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
