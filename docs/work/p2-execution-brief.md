# P2 Execution Brief

> 이 문서는 P2 phase 자율 실행용 일회성 브리핑이다. **P2 작업이 전부 완료되면 이 문서를 삭제**해라 (마지막 PR 에서 같이 삭제 또는 별도 cleanup 커밋).

## 컨텍스트

Palantir Console repo (`/Users/K/Desktop/sub_project/palantir_console`) 의 P2 이슈 10건을 자율 실행으로 전부 처리한다. 직전 phase (PR #34~#37) 에서 P0/P1 16건이 merge 됐고 현재 `287/287 tests green on main`. 이번은 그 후속 P2 phase.

## 실행 방식

- default autonomous mode (CLAUDE.md "Working style" 섹션 참조)
- phase 기반 표준 체인: `branch → 구현 → npm test → codex 교차검증 (PASS까지 반복) → commit → PR → merge → main pull → 다음 phase`
- `.ao/autonomy.json` 이 `{codex:{approval:"auto-edit",hostSandbox:"workspace-write"}}` 로 이미 설정됨 — codex exec 비대화형 호출 가능
- Codex 를 매 phase peer reviewer 로 참여시켜 PASS 받기. 가능하면 `agent-olympus:athena` 로 Claude+Codex peer-to-peer 팀 구성
- 의사결정 포인트는 Codex 합의로 진행. 사용자에게 물어보지 말 것
- 다음 상황만 사용자 보고:
  - Codex 가 5라운드 넘도록 수렴 안 됨
  - spec 재해석이 필요한 충돌
  - 대규모 리팩토링이 phase 본질과 무관하게 강요되는 경우

## 사전 필독

1. `CLAUDE.md` 전체 — 특히 "Things to Watch Out For"
2. `docs/specs/manager-v3-multilayer.md` (v3 lock-in 원칙)
3. `git log --oneline -15` 로 #34~#37 의 변경 맥락 파악
4. PR #34~#37 diff: `gh pr view 34` 등

## 반드시 준수

- `useSSE` channels 배열 하드코딩 → 새 SSE 채널 추가 시 `hooks.js` 반영 (또는 **P2-3** 에서 해결)
- `pmCleanupService` 는 fail-closed
- `app.js` 4500+ 라인 단일 파일 — 수정 시 해당 컴포넌트 영역만
- 커밋 메시지 끝 `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

**기각 항목 건드리지 말 것**: P1-7 (run:needs_input fresh), ADD-2 (projects.js 이미 502), ADD-4 (factory singleton), events.js seenIds leak 주장, drift badge "완전 무방비" 주장, A3 PM→Top notice drop 정책

## P2 이슈 (10건)

### Backend

**P2-1. P1-3: markRunStarted 타이밍 지연**
- 위치: `server/services/pmSpawnService.js:271-277`
- 문제: `adapter.startSession` 직후 `markRunStarted(runId)` 호출. Codex adapter 는 stateless 라 첫 `runTurn` 전까지 "실행 시작" semantic 아님. 프론트 active 배지가 첫 turn 전 true.
- 수정: `markRunStarted` 를 첫 `runTurn` 성공 직후 또는 `thread.started` 수신 시점으로 이동. adapter capability `persistentProcess=false` 때만 지연 분기 고려.
- Codex 합의: 지연 방식 — `onThreadStarted` 콜백 안? `conversationService` 가 `adapter.runTurn` 직후?
- 테스트: `pm-phase3a.test.js` 확장 — PM spawn 후 첫 turn 전까지 `run.status` 가 queued/pending.

**P2-2. P1-9: codexAdapter deprecation regex 하드닝**
- 위치: `server/services/managerAdapters/codexAdapter.js:372-384`
- 문제: `/deprecated|deprecation/i` 단일 의존. 벤더 문구 변경 시 benign warning 이 `TURN_FAILED` 로 escalate.
- 수정: `item.severity/code/type` 기준 가능 여부 벤더 JSON 재확인. 안 되면 fixture 테스트로 shape lock-in.
- 테스트: `server/tests/codex-adapter-vendor.test.js` 신규 — 2026-04 기준 벤더 샘플 fixture.

**P2-3. P1-10: useSSE channels 공유 상수화**
- 위치: `server/services/eventBus.js` (또는 `server/services/eventChannels.js` 신규), `server/public/app/lib/hooks.js:88-100`
- 문제: 서버 emit 채널 + 프론트 useSSE 배열 별도 하드코딩 → Phase 5/7 에서 2번 누락 회귀.
- 수정: `server/services/eventChannels.js` 신규 export. 클라는 `/api/event-channels` 페치 or embed. 더 간단: npm test 에 static assertion.
- Codex 합의: 런타임 페치 vs embed vs static assertion.
- 테스트: 누락 감지 테스트 필수.

**P2-4. derivePmProjectId mismatch 진단 로그** (Codex PR #36 제안, 당시 scope out)
- 위치: `server/services/runService.js`
- 문제: `derivePmProjectId` 가 conversation_id 파싱으로 도출. JOIN 경로(`tasks.project_id`) 와 불일치 시 silent.
- 수정: 양쪽 존재 + 다르면 warn + 선택적 `run_events` diagnostic. 수정 X, 관측만.
- 테스트: `runtime-round2.test.js` 확장.

**P2-5. orphan run 400 vs annotate 재검토**
- 위치: `server/services/reconciliationService.js:373-406`
- 문제: `bindEnvelopeToClaim` 에서 orphan run 참조 시 400 reject. annotate-only 원칙과 tension.
- 수정 방향: 400 대신 `incoherence_flag=1, kind='orphan_run_reference'` + 200. R5 blocker fix 테스트가 400 lock-in 할 수 있어 Codex 재확인.
- **주의**: spec 재해석 여지 있음. Codex 합의 안 되면 사용자 보고 후 skip.

### Frontend / UX

**P2-6. DriftDrawer jsdom a11y 테스트** (Codex PR #37 제안, scope out)
- 위치: `server/tests/frontend-a11y-envelope.test.js`
- 문제: 현재 source grep 수준. focus trap / Tab cycle / auto-focus 실제 동작 검증 필요.
- 수정: devDependency jsdom. preact 10.x render. focus trap 실동작.
- Codex 합의: jsdom 추가가 번들/테스트 시간에 주는 영향.

**P2-7. drift badge aria-label**
- 위치: `server/public/app.js:309-324`
- 문제: `role="button"` + `tabIndex=0` + `title` 은 있으나 `aria-label` 없음.
- 수정: `aria-label={`Drift warnings: ${count}`}` 추가. title 유지.

**P2-8. useConversation SSE 직접 구독 + poll 완화**
- 위치: `server/public/app/lib/hooks.js:242` (pollMs=2000 하드코딩)
- 문제: 2s poll + SSE 미구독. `run:event` 는 이미 발화 중.
- 수정: useConversation 내부에서 해당 conversation run.id 의 `run:event` 수신 시 즉시 `loadEvents`. poll 10s 로 완화.
- 주의: async fence 패턴 (myId fence, requestSeq) 유지. id-change 시 unsubscribe.

### UX 개선

**P2-9. Stop/Reset 라벨 일관화 + @mention 자동완성 + PM selector Dropdown**
- Stop (Top) vs Reset PM 헷갈림 → 툴팁 강화 또는 통일
- @mention: ManagerView input `@` 타이핑 시 프로젝트 dropdown (exact-insensitive)
- PM selector (`app.js:3839-3847`) native select + " · active" → 기존 `Dropdown` (app.js:541) 재사용. active 칩 + 상단 sticky.
- 3개 묶어서 UX PR 권장. Codex 합의 후 분할.

### 대형 리팩토링

**P2-10. app.js ESM 분해**
- 위치: `server/public/app.js` (~4500줄)
- 문제: window bridge + classic script → 회귀 누적 유발.
- 전략: phase 분할 필수. 1단계 DriftDrawer 만 ES module 추출 → 패턴 확립 → Codex 리뷰 → merge → 다음. **전체 이관 한 번에 금지**.
- 사용자 보고 조건: 1단계 후 회귀 많으면 거기서 중단.

## 권장 PR 분할 (Codex 합의 후 조정)

- **#38** backend lifecycle round 3: P2-1 + P2-2
- **#39** observability: P2-3 + P2-4
- **#40** annotate-only 재검토: P2-5 (spec 재해석 리스크)
- **#41** frontend a11y + badge: P2-6 + P2-7
- **#42** conversation SSE: P2-8
- **#43** UX consistency: P2-9
- **#44** ESM phase 1: P2-10 DriftDrawer 단독

## 완료 기준

- 10건 전부 PR 생성 + Codex PASS + merge
- `npm test` 그린 (현재 287 → 목표 300+)
- 각 PR 단독 롤백 가능
- **마지막 PR 에서 `docs/work/p2-execution-brief.md` 삭제** (또는 별도 cleanup 커밋)
- 최종 보고: PR URL 리스트 + Codex 피드백 + 잔여 P3 + 회귀 리스크
