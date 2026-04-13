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

### Phase 1a: DB + CRUD + API (기반) — ✅ 완료
- 마이그레이션 013 (6 테이블, 6 DB 트리거)
- `runtime/mcp/` + `.gitignore`
- `skillPackService.js` CRUD + 바인딩 + MCP alias 해소 + 2-tier env 검증
- REST API 라우트 (CRUD + 바인딩 + run 스냅샷)
- MCP 템플릿 seed (playwright, filesystem)
- 42 tests, Codex 교차검증 P1-1 수정 (pinned_by 업데이트 누락)

### Phase 1b: 실행 통합 — ✅ 완료
- `resolveForRun` 5단계 파이프라인 (입력검증→수집→shadow→excluded→adapter gating→합성)
- `lifecycleService.executeTask` 통합 (prompt overlay, MCP config 생성/cleanup)
- `/execute` API `skill_pack_ids` 파라미터
- `run_skill_packs` 비정규화 스냅샷 + `runs.mcp_config_path/snapshot`
- 부팅 시 orphan MCP config cleanup
- 12 tests, Codex 교차검증 P0×2 + P1×2 + P2×2 수정
- 총 575 tests, 0 failures (기존 521 + 신규 54)

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
