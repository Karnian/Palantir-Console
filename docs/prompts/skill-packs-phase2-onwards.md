# Skill Packs — Phase 2 이후 구현 프롬프트

## 현재 상태

`feature/skill-packs` 브랜치. Phase 1a+1b 완료, Codex 교차검증 2라운드 통과.
575 tests, 0 failures. 커밋 히스토리 깨끗함.

### 완료된 것
- DB 마이그레이션 013 (6 테이블, 6 트리거)
- `skillPackService.js` — CRUD, 바인딩, MCP 해소, env 검증, `resolveForRun` (5단계 파이프라인)
- REST API — `/api/skill-packs` CRUD, 프로젝트/태스크 바인딩, run 스냅샷, `/execute` skill_pack_ids
- `lifecycleService` 통합 — prompt overlay, MCP config 생성/cleanup, orphan cleanup
- `run_skill_packs` 비정규화 스냅샷, `runs.mcp_config_path/snapshot`
- **Phase 2 완료**: PM 시스템 프롬프트에 스킬 팩 섹션 추가 (API 문서, skill_pack_ids 사용법, lazy 조회 안내)
  - `pmSpawnService` — auto_apply 스킬 목록 주입 (spawn + resume 양쪽)
  - `managerSystemPrompt.js` — PM layer에 Skill Packs 섹션 (Top layer 미포함)
  - 588 tests, 0 failures

## 남은 Phase

### Phase 2: PM 통합 ✅ (a33c797)
- ✅ `managerSystemPrompt.js` PM layer에 Skill Packs 섹션 추가
- ✅ `pmSpawnService` auto_apply 스킬 목록 PM 프롬프트 주입 (spawn + resume)
- ✅ `/execute` skill_pack_ids 문서화 (PM layer only)
- ✅ excluded 최종 우선 규칙 통합 테스트
- ✅ Codex 교차검증 1라운드 PASS (P0=0, P1=2 fixed, P2=4 fixed)

### Phase 3: UI
- 스킬 팩 관리 페이지 (NavSidebar 신규 항목, 목록/생성/편집/삭제)
- MCP 템플릿 읽기 전용 목록
- 프로젝트 상세 페이지에 "Skill Packs" 섹션 (바인딩 추가/제거, auto_apply, PM reset 경고)
- 실행 모달 스킬 선택 UI (토큰 예산 표시, 어댑터 호환성 경고)
- Run Inspector에 "Applied Skills" 섹션 (run_skill_packs 스냅샷)

### Phase 4: 고급 기능
- 토큰 예산 UI (사용량 시각화, 팩별 기여도)
- MCP 충돌 감지 UI
- 스킬 팩 import/export (JSON/Markdown)
- Acceptance checklist 체크 상태 저장 (`run_acceptance_checks` 테이블)

### Phase 5: 멀티 어댑터 확장
- Codex 워커 injection 인터페이스
- Gemini 워커 injection 인터페이스
- `requires_capabilities` 연동

## 핵심 참조
- 스펙: `docs/specs/skill-packs.md` (v1.0-rc1)
- 서비스: `server/services/skillPackService.js`
- 라우트: `server/routes/skillPacks.js`
- 테스트: `server/tests/skill-packs.test.js`, `server/tests/skill-packs-resolve.test.js`
- PM 프롬프트: `server/services/managerSystemPrompt.js`
- UI 진입점: `server/public/app.js`, 컴포넌트: `server/public/app/components/`

## 작업 방식
`feature/skill-packs` 브랜치에서 작업. 각 phase 완료 시 codex 교차검증.
