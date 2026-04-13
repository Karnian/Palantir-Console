# Skill Packs — Phase 3~5 구현 프롬프트

## 현재 상태

`feature/skill-packs` 브랜치. Phase 1a+1b+2 완료, 588 tests 0 failures.

### 완료된 것 (Phase 1a/1b/2)
- DB 마이그레이션 013 (6 테이블 `skill_packs`, `project_skill_packs`, `task_skill_packs`, `run_skill_packs`, `mcp_server_templates` + 6 트리거)
- `skillPackService.js` — CRUD, 바인딩, MCP 해소, env 검증, `resolveForRun` (5단계 파이프라인: input validation → collection → effective set validation → adapter gating → synthesis)
- REST API 전체 (`/api/skill-packs` CRUD, 프로젝트/태스크 바인딩, run 스냅샷, `/execute` skill_pack_ids)
- `lifecycleService` 통합 — prompt overlay, MCP config 생성/cleanup, orphan cleanup
- `run_skill_packs` 비정규화 스냅샷, `runs.mcp_config_path/snapshot`
- PM 시스템 프롬프트 스킬 팩 섹션 (spawn + resume 양쪽)
- `managerSystemPrompt.js` PM layer에 Skill Packs API docs, skill_pack_ids, lazy 조회 안내

## Phase 3: UI

스펙 `docs/specs/skill-packs.md` §13 참조.

### 3-1: 스킬 팩 관리 페이지

**NavSidebar 추가**:
- `server/public/app/lib/nav.js`의 `NAV_ITEMS` 배열에 항목 추가
- 형식: `{ hash: 'skills', icon: '...', label: 'Skill Packs' }`
- `server/public/app.js`의 `renderView()`에 `case 'skills'` 추가

**SkillPacksView 컴포넌트** (`server/public/app/components/SkillPacksView.js`):
- 목록: `GET /api/skill-packs` (scope 필터: global / project별)
- 생성/편집 폼: name, description, scope, project_id(project scope일 때), icon, color, priority
  - prompt_full (textarea, 여러 줄), prompt_compact (optional)
  - MCP servers: `GET /api/skill-packs/templates` 목록에서 alias 선택 + env_overrides 입력
  - checklist: 문자열 배열 편집 (항목 추가/삭제)
  - conflict_policy: fail/warn 선택
  - inject_checklist: 체크박스
- 삭제: 확인 모달
- 어댑터 호환성 배지 (v1은 Claude만 Full, 나머지 Not yet supported)
- estimated_tokens 표시 (자동 계산: chars/4)

**MCP 템플릿 목록** (읽기 전용):
- `GET /api/skill-packs/templates`로 seed된 템플릿 확인
- 테이블: alias, command, description, allowed_env_keys

### 3-2: 프로젝트 상세 페이지 확장

기존 프로젝트 상세 패널에 "Skill Packs" 섹션 추가:
- 프로젝트에 바인딩된 스킬 팩 목록: `GET /api/projects/:id/skill-packs`
- 바인딩 추가: 글로벌/프로젝트 스킬 팩 검색 + 선택 → `POST /api/projects/:id/skill-packs`
- 바인딩 제거: `DELETE /api/projects/:id/skill-packs/:packId`
- 바인딩 수정: `PATCH /api/projects/:id/skill-packs/:packId` (priority, auto_apply)
- auto_apply 토글 시 PM reset 경고 표시 (active PM이 있을 때만)
- priority 변경은 PM reset 경고 불필요

### 3-3: 실행 모달 스킬 선택 UI

`TaskModals.js`의 `ExecuteModal` 확장:
- 현재: agent 선택 + prompt
- 추가: 스킬 팩 선택 UI
  - 프로젝트 auto_apply 스킬 (체크됨, 해제하면 excluded 경고)
  - 태스크에 이미 바인딩된 스킬 (체크됨)
  - 글로벌 스킬 추가 검색/선택
  - 토큰 예산 표시: 현재 합산 / `SKILL_PACK_TOKEN_BUDGET` 캡 (기본 4000)
  - 어댑터 호환성 경고 (선택 에이전트가 claude-code가 아니면 "Skill packs will be skipped")
- `onExecute` 호출 시 `skill_pack_ids` 배열 포함 → `POST /api/tasks/:id/execute` body에 추가

### 3-4: Run Inspector 확장

Run 상세 패널에 "Applied Skills" 섹션:
- `GET /api/runs/:id/skill-packs` → `run_skill_packs` 스냅샷
- 각 팩: name, applied_mode (full/compact), effective_priority, applied_order
- 체크리스트 표시 (checklist_snapshot, 읽기 전용 체크박스)
- MCP config 스냅샷 (접기/펼치기)

### UI 패턴 참조
- **라우팅**: `useRoute()` hook으로 hash 파싱, `renderView()`에서 switch
- **컴포넌트 구조**: Preact + HTM (ESM), vendor/에서 직접 import
- **스타일**: `styles.css`에 BEM-lite 패턴 (`.skill-packs-*`), CSS 변수 사용
- **모달**: 상태 기반 visibility, `null` 반환으로 숨김
- **API 호출**: `apiFetch()` 유틸 (401 → login 리다이렉트)
- **SSE**: `useSSE` hook, channels 배열 hard-coded (`app/lib/hooks/sse.js`)

## Phase 4: 고급 기능

### 4-1: 토큰 예산 UI
- 스킬 팩 관리 페이지에 토큰 예산 시각화 (바 차트)
- 실행 모달에서 팩별 기여도 표시 (full vs compact 모드 전환 효과)

### 4-2: MCP 충돌 감지 UI
- 실행 모달에서 선택된 스킬 팩 간 MCP alias 충돌 사전 감지
- 충돌 시 conflict_policy별 행동 안내 (fail → 실행 불가, warn → 높은 priority 우선)

### 4-3: 스킬 팩 import/export
- JSON export: 단일 팩 또는 프로젝트 바인딩 포함 export
- JSON import: 파일 업로드 → 유효성 검증 → 생성
- 서버 API 추가 필요: `GET /api/skill-packs/:id/export`, `POST /api/skill-packs/import`

### 4-4: Acceptance checklist 체크 상태 저장
- 신규 테이블: `run_acceptance_checks` (run_id, check_index, checked, checked_by, checked_at)
- 마이그레이션 014
- API: `PATCH /api/runs/:id/skill-packs/checks` (체크 상태 업데이트)
- Run Inspector에서 체크리스트 항목 클릭 가능하게 변경

## Phase 5: 멀티 어댑터 확장

### 5-1: Codex 워커 injection
- `executionEngine.js`의 Codex 워커에 `{system_prompt_file}` placeholder 추가
- `args_template`에 시스템 프롬프트 파일 경로 주입
- `resolveForRun` adapter gating 수정: Codex 워커도 prompt plane 활성화

### 5-2: Gemini 워커 injection
- 유사한 placeholder 또는 dedicated adapter

### 5-3: `requires_capabilities` 연동
- 스킬 팩이 capability 요구사항 추가하는 메커니즘
- 태스크 실행 시 에이전트 capabilities와 매칭 검증

## 핵심 참조 파일
- 스펙: `docs/specs/skill-packs.md` (v1.0-rc1)
- 서비스: `server/services/skillPackService.js`
- 라우트: `server/routes/skillPacks.js`
- 테스트: `server/tests/skill-packs.test.js`, `server/tests/skill-packs-resolve.test.js`, `server/tests/skill-packs-pm.test.js`
- PM 프롬프트: `server/services/managerSystemPrompt.js`, `server/services/pmSpawnService.js`
- UI 진입점: `server/public/app.js`
- Nav: `server/public/app/lib/nav.js`
- 컴포넌트: `server/public/app/components/`
- 실행 모달: `server/public/app/components/TaskModals.js`
- 스타일: `server/public/styles.css`
- hooks: `server/public/app/lib/hooks/` (routing, utils, sse, data, conversation, dispatch, manager)

## 작업 방식
- `feature/skill-packs` 브랜치에서 작업
- 각 phase 완료 시 codex 교차검증 (PASS까지 반복)
- phase 체인: 구현 → npm test → codex 교차검증 → commit → 다음 phase
- Phase 3은 서브페이즈 (3-1 → 3-2 → 3-3 → 3-4) 순서로 진행, 각각 commit
- 기존 테스트 회귀 없음 확인 필수
