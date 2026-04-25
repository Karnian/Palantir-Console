# UI/UX Cleanup Follow-up Brief — 2026-04-26 세션용

이 문서는 **2026-04-24 세션의 후속 작업**을 다음 세션이 단독으로 자율 진행할 수 있도록 정리한 브리프이다. 이전 세션에서 종합 검수(Aphrodite) + 크로스리뷰(Codex)를 거쳐 5-phase(A~E)를 끝냈고, 이 문서는 거기서 처리하지 못한 **잔여 P0/P1/P2/P3 항목**과 **수행 순서·검증 절차**를 명시한다.

---

## 1. 컨텍스트 (이전 세션 산출물)

**검수 리포트** — 다음 두 파일을 먼저 읽어 컨텍스트 확보:
- `.ao/artifacts/ui-review-2026-04-24-aphrodite.md` — 24건 (P0×3, P1×8, P2×8, P3×5), CONDITIONAL
- `.ao/artifacts/ui-review-2026-04-24-codex.md` — 10 주장 중 agree 7 / needs-verification 2 / disagree 1, 추가 5건 발견

**Phase 별 codex 리뷰**:
- `.ao/artifacts/ui-review-2026-04-24-codex-phase-b.md`
- `.ao/artifacts/ui-review-2026-04-24-codex-phase-cde.md`

**완료된 5 phase (A~E)** — 다음을 이미 처리했으므로 중복 작업 금지:
- A. EmptyState API 통일 + 3곳 수정 (icon 도 nav 와 일치화)
- B. 공통 `Modal` primitive 도입 + 14개 모달 마이그레이트 (TaskModals×3, McpTemplatesView×2, SkillPacksView×2, PresetsView×2, UrlInstall, PackPreview, AgentsView×2, ProjectsView×3) + ProjectDetailModal rules-of-hooks 수정 + Modal focus trap 을 panel-local 로 한정
- C. NewTaskModal 7필드 / SkillPackModal name·priority·desc / TemplateModal 5필드 / ExecuteModal 3필드 / ProjectsView New·Edit 3필드씩 `<label for>`/`<input id>` 연결
- D. 모바일 (≤640px) 하단 탭바 전환 + `.nav-status` SSE chip top-right floating + `.manager-view` 1열 스택 + safe-area-inset-* + `--mobile-nav-height: 56px` 토큰 + modal-overlay z-index 30→200 (탭바 100 위)
- E. tokens.css alias 추가 (`--bg/--fg/--muted/--surface-2/-3/--status-warning`) + SessionGrid 28건 하드코딩 → `var(--status-*)` + `.command-palette-input:focus` 2px accent + form-input forced-colors `Highlight` fallback

**현재 브랜치 상태 (2026-04-26 세션 시작 시점)**:
- 작업이 누적된 마지막 브랜치: `ui/phase-e-tokens-focus`
- 누적 커밋은 `ao-wip(manual): ...` 형태로 자동 wip 커밋됨
- 882/882 tests pass

---

## 2. 잔여 작업 — Phase F~K

각 Phase 는 CLAUDE.md "Phase 기반 작업 표준 체인"을 따라 진행:
`branch → 구현 → npm test → codex 교차검증 (PASS까지 반복) → commit → 다음 phase 진입 여부 보고`.

### Phase F — 잔여 5개 Modal 마이그레이트 (P0/P1)

목적: focus trap·aria-modal·labelledby 를 Modal primitive 로 일괄 적용.

**대상**:
- `server/public/app/components/ConversationPanel.js` — `class="trash-panel" role="dialog"` 단독, focus trap 없음 (line ~358)
- `server/public/app/components/DriftDrawer.js` — overlay 직접
- `server/public/app/components/SessionsView.js` — UsageModal(line 86), TrashModal(line 194), ProjectDetailModal(line 262) — 이미 `role="dialog"` 만 있음, `aria-modal`/`aria-labelledby`/focus trap 누락
- `server/public/app/components/CommandPalette.js` — Cmd+K 팔레트, 특수 UI (Modal 으로 감싸되 `escapeClose`/`backdropClose` 동작 검증 필수)
- `server/public/app/components/RunInspector.js` — side panel 형태 (Modal 로 감쌀지 별도 panel 컴포넌트 만들지 판단 필요)

**패턴** — Phase B 와 동일:
```js
import { Modal } from './Modal.js';
// useEscape 호출 제거
// if (!open) return null; 같은 가드 제거 (Modal 이 처리)
return html`
  <${Modal} open=${...} onClose=${...} labelledBy="X-title" wide?>
    <div class="modal-header"><h2 id="X-title">...</h2></div>
    ...
  </Modal>
`;
```

**RunInspector 주의**: side panel(우측 슬라이드)이라 .modal-overlay 와는 다른 chrome. Modal primitive 에 `panelClass="run-inspector-side"` 같은 옵션 + 별도 layout CSS 가 필요할 수 있음. 만약 Modal 로 강제 매핑이 어색하면 side-panel 전용 a11y 개선만 하고(role=dialog/aria-modal/labelledby/focus trap) 마이그레이트는 보류.

**검증**:
- 882/882 tests pass
- 기존 `frontend-a11y-envelope.test.js` SessionsView/ConversationPanel 관련 assertion 갱신 필요 가능성 — Phase B 의 ExecuteModal 테스트 갱신 사례 참고
- codex 교차검증: focus trap 중첩 동작 (Cmd+K 가 다른 모달 위에 떠도 ESC 처리 정확한지)

### Phase G — 폼 라벨 잔여 + 드래그 앤 드롭 키보드 대안 (P0/P1)

**G-1. label-control 잔여**:
- `AgentModal` (AgentsView.js) — type/command/args_template/icon/color/max_concurrent/mcp_tools
- `SkillPackModal` (SkillPacksView.js) — Scope/Project/Icon/Color + Tabs(`prompt`/`mcp`/`checklist`) 안의 모든 입력
- `PresetModal` (PresetsView.js) — Plugin Refs(체크박스 wrapping label 은 OK), MCP Server Templates(동일), Base System Prompt(textarea), Setting Sources, Min Claude Version
- `ExecuteModal` (TaskModals.js) — Skill Pack 체크박스 리스트 (각 체크박스에 `<label>` wrapping 또는 `aria-label`)

**G-2. 드래그 앤 드롭 키보드 대안 (BoardView, WCAG 2.1.1)**:
- 옵션 A: TaskCard 에 "..." 컨텍스트 메뉴 → "Move to → Backlog/Todo/In Progress/Failed/Review/Done"
- 옵션 B: TaskCard 에 status Dropdown 직접 노출 (compact)
- 권장: 옵션 A — 카드 시각 밀도 유지

**G-3. BoardModeTabs `aria-controls` + `role="tabpanel"` 페어링** (WCAG 4.1.2):
- BoardView.js line 76~92 의 `<button role="tab">` 에 `id="tab-board"` + `aria-controls="panel-board"`
- Board/Calendar 영역 래퍼에 `id="panel-board"` + `role="tabpanel"` + `aria-labelledby="tab-board"`

**검증**: 882/882, codex 교차검증.

### Phase H — 랜드마크 + 키보드/터치 개선 (P2)

- `<main>` 랜드마크: `app.js` 의 `.main-area` div 를 `<main id="main-content">` 로 변경
- 스킵 링크: `index.html` 또는 app.js 최상단에 `<a href="#main-content" class="skip-link">본문으로 건너뛰기</a>` + 시각 hide-on-blur CSS
- `nav-item` 42×42 → 44×44 (WCAG 2.5.8 권고)
- `.nav-item:focus-visible .nav-tooltip { display: block }` (현재 hover only)
- `MentionInput` `aria-multiline="true"` (Shift+Enter 줄바꿈 지원)

### Phase I — 디자인 토큰 정리 잔여 (P2/P3)

- `worker-card` border-left 하드코딩 4건 (styles.css 3863~3876) → `var(--status-*)` 교체
- `border-radius: 8px/4px` 등 비표준 → `--radius-sm/-md/-lg` 통일 또는 `--radius-xs: 4px` 신규 토큰 추가
- `Dropdown.js` listbox 패턴 완성: `aria-activedescendant` 또는 roving tabindex (codex P3-5 지적 — `<button role="option">` 자체는 OK 지만 패턴 미완성)

### Phase J — Toast 스택 cap + SSE 재연결 UX (P2)

- `app/lib/toast.js`: `addToast` 가 무제한 push → 최대 5개 cap, 초과 시 oldest 제거
- `.toast-container` 에 `max-height` + `overflow-y: auto` (codex 추가 발견)
- SSE 끊김/재연결: 현재 sidebar 색 점만 (모바일은 floating chip). 끊김 ≥ 5초 시 toast 또는 상단 배너 (`SSE 연결 끊김 — 재시도 중...`), 재연결 시 success toast
- `ConversationPanel` 이 markdown 공용 helper 우회, 직접 `marked.parse` 호출 → `app/lib/markdown.js` 의 helper 통일 (drift 위험 제거)

### Phase K — UX 카피 한국어 통일 + 라이트 모드 (P3, 선택)

- 영/한 UI 카피 일관화 — CLAUDE.md 원칙 "한국어 사용 (코드 주석/변수명은 영어)" 적용
  - 영문: "Start Manager", "All Projects", "All Priorities", "New Task", "Failed", "Running", "Done" 등
  - 권장: UI 라벨 전부 한국어 (예: "매니저 시작", "전체 프로젝트", "전체 우선순위", "새 작업", "실패", "실행 중", "완료")
- 라이트 모드 (P3, 워크 budget 큼 — 시간 없으면 스킵): tokens.css 에 `prefers-color-scheme: light` 미디어 추가, `color-scheme: light dark` 로 변경

---

## 3. 진행 순서·우선순위

권장 순서 (영향 큰 것부터):
1. **F (필수)** — 잔여 모달 마이그레이트 = focus trap 일괄 완성
2. **G (필수)** — 폼 a11y 마무리 + 보드 키보드 동선 + 탭 ARIA
3. **H** — 랜드마크/스킵 링크/touch target
4. **I** — 토큰 잔여 정리
5. **J** — toast cap + SSE UX
6. **K (선택)** — 한/영 카피 통일 (큰 작업이라 사용자 결단 필요), 라이트 모드 (defer)

각 phase 종료 시점에 codex 교차검증 PASS 받고 다음 진입 여부만 보고. F~J 까지는 자율 진행, K 는 사용자 확인 후.

---

## 4. 검증 체크리스트 (모든 phase 공통)

- [ ] `node --test server/tests/` 882/882 pass (변경에 따라 +α 가능, 기존 fail 0 유지)
- [ ] `frontend-a11y-envelope.test.js` 의 assertion 이 새 구조와 정합 (필요 시 갱신)
- [ ] codex async 교차검증 PASS (BLOCK 시 즉시 수정 후 재검증)
- [ ] Playwright 시각 확인 — 가능하면 desktop(1860×920) + mobile(375×920) 양쪽
- [ ] git diff 가 phase 단일 주제 유지

---

## 5. 함정·금지사항

- `useEscape` 의 stack-safe 동작 절대 깨지 마. peek-then-drain 패턴 + onCloseRef 유지.
- Modal primitive 의 focus trap 은 **panel-local** 이어야 함 (window 가 아니라 `panel.addEventListener('keydown', onKey)`). Phase B-fix 회귀 조심.
- ProjectsView 의 useMemo 는 early return **앞**에 있어야 함 (rules-of-hooks). Phase B-fix 회귀 조심.
- modal-overlay z-index 200 보다 높은 chrome 만들지 말 것 (mobile nav 100 / SSE chip 101 이 모달 위로 올라오면 focus trap 깨짐).
- tokens.css 의 alias 추가 시 `var()` fallback-less 검증 테스트 (`boot.smoke.test.js:106`) 가 통과해야 함 — `--<name>: <value>;` 형태로 root 에 정의.
- Codex async 호출은 `node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.3/scripts/ask.mjs async codex` 사용. sync 는 120s timeout 으로 큰 리뷰 못 받음.
- `npm rebuild better-sqlite3` 가 필요할 수 있음 (Node.js 버전 미스매치 시). 882/882 가 0/882 로 떨어지면 가장 먼저 의심.
- ao-wip hook 이 자동 커밋 남기므로 `git diff HEAD` 가 비어있어도 변경은 직전 commit 에 들어있음. `git show HEAD` 로 확인.

---

## 6. 참고 파일

- 디자인 토큰: `server/public/styles/tokens.css`
- 전체 스타일: `server/public/styles.css` (~6000줄)
- Modal primitive: `server/public/app/components/Modal.js`
- 컴포넌트 디렉토리: `server/public/app/components/`
- a11y 테스트: `server/tests/frontend-a11y-envelope.test.js`
- 토큰 검증 테스트: `server/tests/boot.smoke.test.js:106`
- 워크플로우 가이드: `CLAUDE.md` "Working style (autonomous mode default ON)" 절
