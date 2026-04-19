# Handoff: Post-Scenario Review — 남은 개선사항 (완료됨)

> **상태: 전체 완료** — 2026-04-19 세션에서 #1~#6 전부 처리 (PR #105~#107).
> 2026-04-19 세션에서 docs/test-scenarios.md 전체 155개 시나리오 실행 + Codex 교차리뷰 완료 후 작성.

## 완료된 작업 요약

- **PR #99~#104**: Codex 교차리뷰로 발견된 Preset gap 3건 수정 + Phase D1 audit correctness + Phase D2 hardening + Phase D3 테스트 하드닝
- **docs/test-scenarios.md stale 수정**: AUTH-01/02, KBD-04, 헤더 (commit `6948b8a`)
- **시나리오 결과**: 154 PASS / 0 FAIL / 1 BLOCKED (INS-02, LLM 비결정적)
- **npm test**: 777/777 PASS (작성 시점 기준; 이후 PR #108~#111 에서 792 로 증가)

## 남은 항목 (우선순위순)

### 1. [HIGH] MGR-03 image metadata 이벤트 누락
- **위치**: `server/services/streamJsonEngine.js:492`
- **문제**: Manager 에게 이미지 첨부 메시지 전송 시 LLM 에는 정상 전달되지만, `user_input` 이벤트에 image metadata 가 기록되지 않음 (text 만 저장)
- **시나리오 기대**: `image` 타입 user_input 이벤트 기록 (docs/test-scenarios.md MGR-03)
- **수정 방향**: `user_input` 이벤트에 `{ type: 'image', mimeType, size }` 또는 content blocks 요약 필드 추가. base64 원본은 저장하지 않음 (DB 크기)
- **테스트**: `server/tests/manager.test.js` 에 image content block 이벤트 검증 케이스 추가

### 2. [HIGH] POST /api/tasks 생성 시 preferred_preset_id 미검증
- **위치**: `server/routes/tasks.js` POST 핸들러
- **문제**: PATCH 에는 PR #99 에서 검증 추가했지만 POST (태스크 생성) 경로에는 누락
- **수정**: PATCH 와 동일한 `presetService.getPreset()` 존재 검증 로직을 POST 에도 적용
- **테스트**: `server/tests/task-preferred-preset-id.test.js` 에 POST 케이스 추가

### 3. [MEDIUM] INS-02 시나리오 자동화 불가 → 재작성
- **문제**: `needs_input` 상태 진입이 LLM 비결정적이라 live 테스트 불가
- **선택지**:
  - A) 시나리오를 "unit test 로 커버" 로 재작성 (코드 경로: `lifecycleService` idle timeout → `needs_input` 전이)
  - B) mock adapter 기반 integration test 추가 (idle timeout 시뮬)
- **관련 테스트**: `server/tests/lifecycle.test.js` 에 이미 mock 기반 커버리지 있음

### 4. [LOW] RunInspector fetch 에러 시 stale data 유지
- **위치**: `server/public/app/components/RunInspector.js` D2a refetch 로직
- **현상**: fetch 실패 시 이전 presetData 를 reset 하지 않아 일시적으로 이전 run 의 drift 정보 표시
- **수정**: catch 에서 `setPresetData(null)` + 에러 배너

### 5. [LOW] install-from-url.test.js flaky
- **위치**: `server/tests/install-from-url.test.js`
- **현상**: 병렬 실행 시 간헐적 409 (name collision)
- **기존 이슈**, 이번 세션과 무관

### 6. [LOW] FS-02, CLS-02 시나리오 정밀 정비
- FS-02: 현재 "파일 읽기" → 실제는 디렉토리 브라우저. showHidden 토글 로 수정했으나 시나리오 이름과 약간 불일치
- CLS-02: 현재 "세션 상세" → 실제는 Dashboard count. detail endpoint 없음

## 실행 방법

새 세션에서 이 프롬프트를 사용하세요:

```
docs/handoff-post-scenario-review.md 에 정리된 남은 개선사항 #1~#6 을 순서대로 처리해줘.

- #1, #2 는 코드 수정 + 테스트 + PR (자율 모드 표준 체인)
- #3 은 시나리오 재작성 또는 mock test 추가 (선택지 B 권장)
- #4~#6 은 크기 작으므로 한 PR 로 묶어도 됨
- 모든 과정 Codex 교차리뷰 (ask.mjs async codex → jsonl 파싱. collect exit code 무시.)
- FAIL 나면 중단 말고 끝까지 진행 후 매트릭스 보고
```

## 참고
- Codex CLI: `/opt/homebrew/bin/codex` v0.120.0
- Claude CLI: `/Users/K/.local/bin/claude` v2.1.114
- ask.mjs: `node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.0/scripts/ask.mjs`
- Codex async 의 `collect` exit status 는 신뢰 불가 — jsonl 아티팩트 직접 파싱이 정답
- `npm rebuild better-sqlite3` 필요할 수 있음 (Node ABI mismatch)
