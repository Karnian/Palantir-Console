# Skill Packs 구현 프롬프트

## 배경

`feature/skill-packs` 브랜치에 스펙 문서와 프로젝트 설명 업데이트가 커밋되어 있다.
스펙은 v1.0-rc1로 Claude+Codex 교차 리뷰 8회를 거쳐 P0/P1 모두 해결된 상태.

## 브랜치 상태

```
main (현재)
feature/skill-packs (스펙 + 문서 업데이트 커밋 4개)
```

## 스펙 위치

`docs/specs/skill-packs.md` (feature/skill-packs 브랜치)

## 구현할 Phase

### Phase 1a: DB + CRUD + API (기반)
- 마이그레이션 013 (`mcp_server_templates`, `skill_packs`, 바인딩 테이블, `run_skill_packs`)
- `runtime/mcp/` 디렉토리 생성 (서버 부팅 시) + `.gitignore` 추가
- `skillPackService.js` CRUD + 바인딩 + MCP alias 해소 + env allowlist 검증
- REST API 라우트 (CRUD + 바인딩 + 소유권 검증)
- 테스트: 스키마, CRUD, 바인딩 제약, MCP 해소, env 검증

### Phase 1b: 실행 통합
- `skillPackService.resolveForRun` 구현 + 테스트
- `lifecycleService.executeTask` 통합 (Claude 워커 전용, `is_manager` 가드)
- MCP config 파일 생성/cleanup 라이프사이클
- `run_skill_packs` 비정규화 스냅샷 기록
- run 이벤트 경고 (`skill_pack:mcp_skipped`, `skill_pack:adapter_unsupported`)
- 부팅 시 orphan MCP config cleanup
- 통합 테스트: 기존 테스트 회귀 없음 확인

## 핵심 주의사항

1. MCP server templates는 v1에서 API 없이 seed-only (코드/config에서 등록)
2. v1은 Claude 워커 전용 — Codex/Gemini는 Phase 5
3. `bindToTask`에서 user exclusion (`excluded=1, pinned_by='user'`) 보호 필수 (Lock-in #4)
4. `run_skill_packs`는 비정규화 스냅샷 — prompt 원문, MCP config, 체크리스트 저장
5. MCP config 파일: `path.resolve(process.cwd(), 'runtime', 'mcp', runId + '.json')`, 0o600
6. runId 검증: `/^[a-zA-Z0-9_-]+$/`
7. conflict_policy: fail이 항상 이김 (어떤 팩이든 fail이면 spawn 차단)
8. token compact 순서: 낮은 priority부터, tie-break는 큰 토큰 먼저
9. shadow 규칙: resolveForRun 내부에서 적용

## 작업 방식

`feature/skill-packs` 브랜치에서 작업. Phase 1a 완료 후 테스트 통과 확인, 그 다음 Phase 1b 진행.
각 phase 완료 시 codex 교차검증 진행.
