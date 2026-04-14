---
description: Phase 10 Worker Preset 구현을 Phase 10A 종료 지점부터 10G 까지 자율 완주
argument-hint: "[시작 phase 지정 optional, e.g. 10B | 10C]"
---

# Phase 10 Worker Preset — 자율 완주 재개

`docs/briefs/phase-10-continuation.md` 를 **반드시 먼저 완독**한 뒤 다음 규칙으로 진행:

## 진행 방식

- 브리프에 명시된 자율 모드 (CLAUDE.md 기준). 승인 없이: 브랜치 / 구현 / npm test / Codex PASS 후 commit / PR / merge / main pull / 다음 phase 진입.
- 각 Phase 마다 Codex 교차리뷰 (async `/ask`) — PASS 까지 반복. Codex 불가 시 Gemini fallback.
- 문제 발생 시 Codex / Gemini / (필요 시) `agent-olympus:athena` 와 상호 보완.
- 의사결정 필요한 지점은 Codex 에 옵션 + 권장안 요청 → 추천안 자동 선택 + 사후 보고.
- Phase 10B → 10C → 10D → 10E → 10F → 10G 순서 (인수 `$ARGUMENTS` 로 특정 phase 지정 가능).
- Phase 10D 의 auth contract 는 Phase 10A spike 결과 (§6.9 amendment — `ANTHROPIC_API_KEY` + `apiKeyHelper` 기본) 반영 필수.
- Codex 5 라운드 넘게 수렴 안 되면 사용자 보고 (설계 전제 오류 가능성).

## 첫 작업

1. `git status` + `git log --oneline -5` + `npm test` baseline 확인 (Phase 10A 커밋 `2aa754a` 이 main 에 있는지).
2. `docs/briefs/phase-10-continuation.md` 완독.
3. `docs/specs/worker-preset-and-plugin-injection.md` §6 / §7 / §11 Round 6 재확인.
4. `TaskCreate` 로 Phase 10B ~ 10G 등록.
5. **Phase 10B 부터 실행** (또는 `$ARGUMENTS` 가 지정한 phase 부터).

## 완료 기준 (spec §12)

- Migration 018 + 기존 672+ tests 회귀 0
- US-001 ~ US-008 자동화 테스트 PASS
- US-007 canary isolation PASS
- Codex 각 phase P0/P1 0건
- `server/plugins/agent-olympus/` 배치 + smoke
- README 에 "Creating a Worker Preset" 섹션

## 마무리

Phase 10G 완료 시:
- `docs/briefs/phase-10-continuation.md` 삭제
- 본 슬래시 명령 파일 (`.claude/commands/phase10-resume.md`) 삭제
- 최종 보고: acceptance checklist 전부 녹색 + PR 목록 + 회귀 없음 확인

인수: $ARGUMENTS
