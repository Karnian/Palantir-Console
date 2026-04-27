# UI/UX Cleanup Follow-up Brief — 2026-04-27 세션용

이 문서는 **2026-04-26~27 세션의 후속 작업** 을 다음 세션이 단독으로 자율 진행할 수 있도록 정리한 브리프이다. 이전 세션에서 brief `docs/specs/ui-ux-cleanup-followup-2026-04-26.md` 의 5 phase (F/G/H/I/J) + Phase K 의 첫 분할 (K-1a) 까지 완료했고, 이 문서는 잔여 작업 (K-1b → K-low → 디자인 토큰/테스트/문서 cleanup) 의 **수행 순서·범위·검증 절차** 를 명시한다.

---

## 1. 컨텍스트 (이전 세션 산출물)

**완료된 6 PR (전부 main merge)** — 다음을 이미 처리했으므로 중복 작업 금지:

| PR | Phase | Codex 라운드 | 핵심 |
|----|-------|------------|----|
| #130 | F | 2 (BLOCK→PASS) | 잔여 5 모달 Modal primitive 마이그레이트 + ESC LIFO 일관화 (`useEscape` stack, palette `.command-palette-overlay { z-index: 1000 }` 분리) + RunInspector / DriftDrawer / CommandPalette 가 모두 stack 합류 + palette focus trap |
| #131 | G | 3 (BLOCK→BLOCK→PASS) | AgentModal 7 / SkillPackModal 8 / PresetModal 5 폼 라벨 연결 + Dropdown `id` prop 신규 + TaskCard 키보드 동선 (Open 버튼 + status `<select>`, nested interactive 회피) + BoardModeTabs 를 navigation 패턴으로 정정 (`role="group"` + `aria-current="page"`) |
| #132 | H | 3 (BLOCK→BLOCK→PASS) | `<main id="main-content" tabIndex="-1">` 랜드마크 + 스킵 링크 (hash router hijack 회피, onClick preventDefault + 직접 focus) + nav-item 44×44 + nav button `aria-label`/`aria-current` + tooltip 모바일 누출 수정 (hover/focus-visible 모두 `@media (min-width:961px)`) + MentionInput aria-multiline |
| #133 | I | 1 (PASS, NEEDS-VERIFICATION 보강) | worker-card border-left 4건 → `var(--status-*)` + `--radius-xs: 4px` 신규 (16건 일괄 교체) + Dropdown listbox aria-activedescendant + aria-labelledby/aria-label fallback |
| #134 | J | 2 (BLOCK→PASS) | `addToast` `TOAST_STACK_CAP=5` (oldest drop) + SSE 재연결 UX (단일 10s timer, healthy server 는 silent 클리어, 끊김 toast surfaced 일 때만 recovery toast) + ConversationPanel `marked.parse` 직접 호출 → `renderMarkdown` helper 통일 (gfm + fallback escape) |
| #135 | K-1a | 3 (BLOCK→BLOCK→PASS) | `app/lib/copy.js` semantic copy 모듈 신규 (`TASK_STATUS_LABELS`, `RUN_STATUS_LABELS`, `MANAGER_STATUS_LABELS`, `NAV_LABELS`, `COMMON_ACTIONS`, `FILTER_LABELS`, `MANAGER_LABELS`, `statusLabel(map, status)` helper) + nav.js / BoardView / SessionGrid / ManagerChat 한국어화 + PM row label 단일 source (`statusLabel(RUN_STATUS_LABELS, pmStatus)` 가 SessionGrid + ManagerChat 양쪽에서 동일 호출) + e2e + jsdom 테스트 한국어 갱신 + smoke regex 양 locale 수용 |

**Codex 교차검증 artifact**: `.ao/artifacts/ask/ask-codex-2026042{6,7}-*.jsonl`. 라운드별 BLOCK 사유 + 수정 fix 경로 보존.

**현재 main 상태 (2026-04-27 세션 시작 시점)**:
- 882/882 tests pass (race-y 3개: `engine: sendInput …`, `engine: worker spawn args …`, `boot.smoke port:null` — 단독 실행 시 모두 PASS, 동시 실행 시 occasional flake)
- e2e (Playwright) 는 `webServer` timeout 환경 이슈로 codex 재현 불가. 수동 smoke 권장
- Phase A~K-1a 의 코어 변경은 모두 `server/public/app/` 안에서 일어났음. server-side 변경 0건

**현재 Phase K-1a 후 잔여 영문 카피가 남은 surface** — 다음 phase 들의 대상:
- `RunInspector` 6 탭 (Live Output / Events / Diff / Costs / Skills / Preset) + Cancel + Send hint
- `DriftDrawer` 헤더 + Restore dismissed + Close + 상태별 라벨
- `TaskDetailPanel` 헤더 + status dropdown options + due date + runs 섹션 + Cancel/Save
- `TaskModals` (NewTaskModal / ExecuteModal) — Skill Pack 섹션 / Excluded / auto-apply 등
- `ProjectsView` / `AgentsView` / `PresetsView` / `SkillPacksView` / `McpTemplatesView` 헤더 + 모든 form labels + empty states
- `ManagerChat` 의 picker error / "No Claude Code or Codex agents registered" / "Authenticated …" / "Loading agent profiles" 보조 메시지
- `DashboardView` 통계 라벨 + 범례

---

## 2. 잔여 작업 — Phase K-1b ~ K-Z (자율 진행 가능)

각 Phase 는 CLAUDE.md "Phase 기반 작업 표준 체인" 을 따라 진행:
`branch → 구현 → npm test → codex 교차검증 (PASS까지 반복) → commit → PR → squash merge → main pull → 다음 phase 진입 여부 보고`.

**중요 원칙 (이전 세션에서 codex 가 강조)**:
- 카피는 `app/lib/copy.js` 의 **semantic key lookup** 으로 추가. `'Open' → '열기'` phrase-key map 금지. 새 그룹은 모듈 상단에 export 추가 후 component 가 import.
- 같은 status enum 이 두 컴포넌트에서 다르게 한국어화되면 BLOCK. 무조건 `statusLabel(MAP, value)` 단일 helper 경유.
- e2e 카피 의존 assertion 은 한국어로 string-replace OK. selector 마이그레이션 (`data-testid` 도입) 은 별도 phase (`PostK-test-migrate`) 로 미뤄도 됨.

### Phase K-1b — RunInspector + 고접점 overlay 한국어화 (P1, 다음 세션 첫 작업)

**대상**:
- `server/public/app/components/RunInspector.js`
  - 탭 라벨 6개 (Live Output / Events / Diff / Costs / Skills / Preset)
  - "Run inspector" aria-label, "Close" 버튼, "Cancel" 버튼, "Send input to agent..." placeholder, "Send" 버튼
  - "Loading diff..." / "No uncommitted changes in the worktree." / "Could not compute diff." / "Cost data not available for this adapter." 등 empty/error 텍스트
  - "Worker cost" / "Manager usage (N turns)" / "Input tokens" / "Output tokens" / "Cached input" / "Reset focus" 등 cost 카드 라벨
  - hint: "Top Manager will be notified of this direct message on its next turn."
- `server/public/app/components/DriftDrawer.js`
  - "⚠ Drift" 헤더 (한국어 보존), "모든 PM 주장과 DB 상태가 일치합니다." (이미 한국어 — 보존), "Restore N dismissed" 버튼, "Close" 버튼, "Hide from this client …" tooltip
  - "PM claimed" / "DB truth" 라벨, "pm_run_id:" / "rationale:" prefix
- `server/public/app/components/TaskModals.js`
  - `TaskDetailPanel` 헤더 / status dropdown / due date placeholder / runs 섹션 라벨 ("Active runs" / "Latest results")
  - `NewTaskModal` 7필드 — 라벨은 phase G 에서 이미 처리됨, **placeholder + button 만** 추가 검토
  - `ExecuteModal` Skill Pack 섹션 ("Skill Packs" 헤더, "auto-apply" / "task-bound" / "(excluded)" 라벨, `${tok} tok` 포맷, "MCP "${alias}" conflict:" 메시지)

**전략**:
- `app/lib/copy.js` 에 신규 그룹 추가: `RUN_INSPECTOR_LABELS`, `DRIFT_LABELS`, `TASK_DETAIL_LABELS`. `COMMON_ACTIONS` 의 `cancel` / `close` / `send` 는 그대로 재활용.
- 탭 라벨은 component 로컬 const `INSPECTOR_TABS = [{ id: 'output', label: RUN_INSPECTOR_LABELS.output }, …]` 식으로.
- "Worker cost" / "Manager usage" 등 cost 카드 라벨 — 자주 겹치므로 `RUN_INSPECTOR_LABELS.workerCost` / `.managerUsage` 같이 별도 키.

**검증**:
- 882/882 tests pass (시작 시점 base)
- `e2e/manager.spec.js`, `e2e/smoke.spec.js` 재실행 (Playwright 가 환경에서 안 돌 수 있으면 manual 검증 명시)
- codex 교차검증: tab id ↔ tab label mapping 일치 / cost 카드 cardinality (worker / manager 둘 다 동시 노출 case)

### Phase PostK-e2e-migrate — Playwright e2e selector 마이그레이션 (P2, K-low 진입 전 먼저)

**목적**: K-low 가 5개 admin view 의 헤더 + form 라벨을 모두 뒤집기 때문에, e2e 가 string 의존이면 매 PR 마다 회귀 다발. selector 기반으로 한 번에 전환.

**대상**:
- `server/tests/e2e/manager.spec.js` — `hasText: '매니저 시작'` → `[data-action="start-manager"]`, `toHaveText('활성')` → `data-state="active"` 같은 attribute selector
- `server/tests/e2e/smoke.spec.js` — `/task|board|작업|보드/i` regex → `[data-view="board"]` 같은 명시적 마커
- 컴포넌트 쪽: 핵심 chrome (start manager 버튼 / status badge / 필터 dropdown / 사이드 헤더 / Manager session row) 에 `data-action` / `data-state` / `data-view` 부여. 시각 무관, AT 무관, e2e selector 만 사용.

**전략**:
- `data-action` — 액션 트리거 버튼 (예: `data-action="start-manager"` / `data-action="stop-top"` / `data-action="reset-pm"`)
- `data-state` — 상태 배지 (예: `data-state="active"` / `data-state="idle"` / `data-state="running"`)
- `data-view` — 라우트 wrapper (예: `data-view="manager"` / `data-view="board"`)
- selector 우선, 카피 매칭은 마지막 fallback
- 스펙 파일 1차 마이그레이션 → component 차 attribute 부여 → 다시 e2e 통과

**검증**:
- e2e 882/882 + 12/12 (Playwright) pass
- 테스트는 카피 변경에 무관해져야 함 (이후 K-low PR 들이 e2e 회귀 안 일으켜야 함)

### Phase K-low — admin/detail screens 한국어화 (P2, 분할 진행 권장)

각 view 가 독립적이라 별 PR 로 분할 가능. 권장 순서 (사용자 빈도 high→low):

#### K-low-1: ProjectsView + AgentsView
- ProjectsView 헤더 ("Projects" → "프로젝트"), New Project / Edit / Delete 버튼, form 라벨 + placeholder, empty state ("No projects yet"), ProjectDetailModal 헤더
- AgentsView 헤더 ("Agent Profiles" → "에이전트 프로필"), New Agent / Edit / Delete, AgentModal placeholder + form hints, AgentDetailModal "Configuration" / "Usage & Limits" 섹션 헤더
- ManagerChat 의 "No Claude Code or Codex agents registered" / "Loading agent profiles" / "Authenticated…" / "Auth status unavailable" 보조 메시지

#### K-low-2: PresetsView + SkillPacksView + McpTemplatesView
- PresetsView 헤더 + Tier 라벨 + Plugin Refs / MCP Server Templates 섹션 헤더 + Apply / Snapshot 등
- SkillPacksView 헤더 + Tabs (Prompt / MCP Servers / Checklist) + GalleryView 한국어
- McpTemplatesView 헤더 + form 라벨

#### K-low-3: DashboardView
- 통계 카드 라벨 + 차트 범례 + Activity feed
- AttentionStrip — 이미 dispatch 차원에서 처리됐는지 확인 후 잔여 영문만

**전략**:
- 각 K-low PR 마다 copy.js 에 그 view 전용 const group 추가 (`PROJECTS_LABELS`, `AGENTS_LABELS`, `PRESETS_LABELS`, `SKILL_PACKS_LABELS`, `MCP_LABELS`, `DASHBOARD_LABELS`)
- form 라벨은 phase G 에서 `<label for>` / `<input id>` 매칭이 이미 끝났으므로 단순 string replace 만
- e2e 회귀 위험은 **PostK-e2e-migrate 가 끝났다면 0** — selector 기반으로 마이그레이션됐을 것

**검증**: 매 PR 마다 882+/882+ pass + codex 교차검증 + Playwright (가능하면)

### Phase Token-Cleanup — 디자인 토큰 잔여 (P3, K 끝나고)

**대상**:
- `border-radius: 8px` (다수, 약 30곳) — 검토:
  - `--radius-sm: 6px` 와의 차이가 미세 — 흡수 vs 신규 토큰
  - 권장: 시각 회귀 위험 보호 위해 `--radius-sm-plus: 8px` 같이 별도 토큰 추가 OR 사용처 case-by-case 검토 후 sm/md 로 통일
- `border-radius: 11px` (1건) — ad-hoc, 토큰 통합 또는 제거
- `border-radius: 3px` (scrollbar 등) — 매우 작은 값, 토큰화 의미 적음. `--radius-2xs: 3px` 신규 또는 그대로 두기.
- `MANAGER_STATUS_LABELS` ↔ `MANAGER_LABELS.active/idle` 중복 정리 (Codex K-1a rev1 권장) — 한 쪽으로 통합 후 callsite 일괄 변경

**검증**: 882/882 + 시각 회귀 자체검사 (boot.smoke + token validation 테스트)

### Phase Test-Stabilize — Flaky 테스트 안정화 (P3, 시간 날 때)

**대상**:
- `server/tests/stream-json-engine.test.js`
  - `engine: sendInput for worker returns false after process exits (single-shot)` — process exit 타이밍 race
  - `engine: worker spawn args contain --print --output-format stream-json --no-session-persistence` — race 또는 env 의존
- `server/tests/boot.smoke.test.js`
  - `Cannot read properties of null (reading 'port')` — Supertest server setup race
- `server/tests/v2-api.test.js`
  - `Tasks CRUD lifecycle` / `PATCH …` — occasional disk i/o race

**전략**:
- 단독 실행은 PASS, 동시 실행 시 flake — test 간 isolation 부족 의심
- 각 테스트의 setup/teardown 검토 + supertest server lifecycle 확인 + tmp dir cleanup race
- 우선순위: BOOT smoke port:null > engine race > task race

**검증**: `npm test` 5회 연속 실행 후 882/882 매번 통과

### Phase Docs-Stamp — 문서 업데이트 (P3, K 끝난 후)

**대상**:
- `docs/backlog.md` — F~J + K-1a + K-1b + K-low 완료 stamp 추가
- `docs/specs/ui-ux-cleanup-followup-2026-04-26.md` — Phase F~K-1a 완료 표기 (이 brief 와 cross-link)
- `docs/specs/ui-ux-cleanup-followup-2026-04-27.md` (이 문서) — 후속 phase 진행 시 stamp 갱신

**검증**: docs 변경만이라 npm test 영향 없음. PR 검토는 codex 교차검증 1회.

### Phase K-2 — 라이트 모드 (무기한 deferred)

**현재 상태**: brief `2026-04-26` 의 권고 + Codex 사전검토 의견 모두 "다크 전제 hex/rgba 가 styles.css 광범위 + tokens.css `color-scheme: dark` 단정 — 토큰만으로 끝날 작업 아님. K-1 / cleanup 우선" 으로 무기한 미룸.

진행 결정 시 별도 brief 작성 + Codex 1회 사전검토 후 시작 권장. 단일 PR 으로는 거의 불가능 (sub-phase 분할 필수).

---

## 3. 진행 순서 — 권장 (자율 모드)

```
1. K-1b              ← 다음 세션 첫 PR
2. PostK-e2e-migrate ← K-low 진입 전 e2e 안정화
3. K-low-1 (Projects + Agents)
4. K-low-2 (Presets + SkillPacks + McpTemplates)
5. K-low-3 (Dashboard)
6. Token-Cleanup
7. Test-Stabilize
8. Docs-Stamp
9. (옵션) K-2 라이트 모드 — 별도 brief 후 시작
```

각 phase 종료 시점에 codex 교차검증 PASS 받고 다음 진입 여부만 보고. 1~5 까지는 자율 진행, 6~8 은 사용자가 흥미 떨어지면 organic 으로 미뤄도 무방.

---

## 4. 검증 체크리스트 (모든 phase 공통)

- [ ] `node --test server/tests/` 882/882 (race-y flake 3건은 단독 재실행 시 PASS 면 OK)
- [ ] copy.js 의 semantic key lookup 패턴 유지 (phrase-key map 금지)
- [ ] 같은 status / 라벨이 두 surface 에서 다르게 한국어화되지 않음 (`statusLabel(MAP, value)` 단일 helper 경유)
- [ ] codex async 교차검증 PASS — BLOCK 시 즉시 수정 후 재검증 (3 라운드 이상 안 수렴 시 사용자 확인)
- [ ] Playwright 시각 확인 — 가능하면 desktop(1860×920) + mobile(375×920)
- [ ] git diff 가 phase 단일 주제 유지 + commit 메시지 한 줄 요약

---

## 5. 함정·금지사항

- **`app/lib/copy.js` 만 single source**. component 안에 inline 한국어 string 박지 말 것 (semantic-key 모듈 의도 깨짐).
- **status enum 매핑은 `statusLabel(MAP, value)` 만**. 세션그리드 / 매니저챗 / RunInspector 가 같은 enum 을 다르게 한국어화하면 BLOCK 재발.
- **e2e selector 마이그레이션 끝날 때까지** K-low 진행 시 매 PR 마다 e2e 회귀 검토. PostK-e2e-migrate 먼저 끝내는 이유.
- **`data-testid` 보다 `data-action` / `data-state` / `data-view`** — 의미 있는 attribute 선호 (testid 는 마지막 수단).
- **MCP / SSE / DB 서버 코드 변경 금지** — 모든 phase 가 `server/public/app/` 안. 서버 변경 필요하면 별도 phase (사용자 확인 필수).
- **codex async 호출**: `cat /tmp/prompt.md | node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.3/scripts/ask.mjs async codex`. sync 는 120s timeout 으로 brief review 못 받음.
- **`npm rebuild better-sqlite3`** 가 필요할 수 있음 (Node.js 버전 미스매치 시). 882/882 가 0/882 로 떨어지면 가장 먼저 의심.
- **ao-wip hook** 이 자동 wip commit 남기므로 `git diff HEAD` 가 비어있어도 변경은 직전 commit 에 들어있음. `git show HEAD` 로 확인.

---

## 6. 참고 파일

- 디자인 토큰: `server/public/styles/tokens.css`
- 전체 스타일: `server/public/styles.css` (~6100줄, Phase J 후)
- semantic copy 모듈: `server/public/app/lib/copy.js` (Phase K-1a 신규)
- nav: `server/public/app/lib/nav.js`
- Modal primitive: `server/public/app/components/Modal.js`
- 컴포넌트 디렉토리: `server/public/app/components/`
- a11y 테스트: `server/tests/frontend-a11y-envelope.test.js`
- e2e 테스트: `server/tests/e2e/{manager,smoke}.spec.js`
- 토큰 검증 테스트: `server/tests/boot.smoke.test.js:106`
- 워크플로우 가이드: `CLAUDE.md` "Working style (autonomous mode default ON)" 절
- 이전 brief: `docs/specs/ui-ux-cleanup-followup-2026-04-26.md` (Phase F~K-1a 정의)
- Codex artifact: `.ao/artifacts/ask/ask-codex-2026042{6,7}-*.jsonl` (라운드별 BLOCK 사유 + fix)
