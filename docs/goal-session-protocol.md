# Goal Session Protocol — Palantir 후속작업 표준 진행 프로토콜

> **용도**: 사용자가 새 세션에서 `docs/goal-session-protocol.md 대로 진행해줘` 라고 지시하면, 이 문서의 작업 큐를 이 문서의 프로토콜대로 자율 진행한다.
> **lock-in 규약**: 사용자가 이 문서를 가리켜 진행을 지시한 것 = **아래 작업 큐 항목들의 spec lock-in 승인**으로 간주한다 (큐에 명시된 사용자-개입 지점은 예외).
> 작성: 2026-07-11 (F-1/G 트랙 설계 세션에서). 갱신: 작업 완료 시 큐 상태를 이 문서와 `docs/backlog.md` 양쪽에 반영.

## 1. 작업 큐 (우선순위 순)

| # | 작업 | spec | 상태 | 규모 |
|---|---|---|---|---|
| 1 | **F-1: Codex Fast Mode 토글** | `docs/specs/codex-fast-mode-brief.md` | ✅ **완료·merged** (migration 053 + codexAdapter tier emit + PATCH route + ⚡ UI + 테스트 12종). codex 계획 R1 NO-GO(3 BLOCKER) → 반영, 최종 diff 리뷰 PASS. | 단일 PR (파일럿 — 프로토콜 검증 완료) |
| 2 | **G1: goal 프롬프트 컴파일러 + goalReport 파서 + 최종 출력 전문 캡처** | `docs/specs/goal-delegation-brief.md` §5b/5c/5k-2 | ✅ **완료·merged** (migration 054 + goalPrompt/goalReport + spawnQueuedRun 주입 + file-backed tee 캡처 + 테스트 28종). codex 최종리뷰 R1 FAIL(1B+3S)→R2 FAIL(2S)→R3 PASS. | PR 1개 |
| 3 | **G2: verify_checks 스키마/CRUD + goal workspace(local) + deliverable 수확 + artifact 평가기** | 동 spec §5a/5f/5k-1~3 + §6 | ✅ **완료·merged** (migration 055 + verifyCheckService/artifactCheck/goalMode(§6 env scrub)/goalAcceptance + verifyChecks 라우트 + goal workspace(fail-closed) + Gate 1 acceptance/deliverable 수확 + 테스트 24종). codex 계획 R1 NO-GO(2B+3S) + 최종 diff R1/R2/R3(2B→1→PASS). goalFeatureActive() 단일 게이트. | PR 1개 (PM token 전제 gate 포함) |
| 4 | **G3: verdict 루프 본체** — stage-resume + 단일 tx 재시도 + boot sweeper + B-lite/webhook/checkTaskCompletion goal 분기 + attempt 연속성 + fingerprint | 동 spec §4/5d/5e/5g | 〃 | PR 1개, **최고 리스크** — codex 라운드 여유 있게 |
| 5 | **G4: Gate 2 리뷰 구조화 + TaskDetail goal UI + 산출물 전달** | 동 spec §5h/5j | 〃 | PR 1개 |
| 6 | **G5: 메모리 연계** (harvest:acceptance → R1b, project-less 캡처 검토) | 동 spec §5i | 〃 | PR 1개 |
| 7 | **G2b: goal workspace remote provider** | 동 spec §5k-1 | 〃 | ⚠️ **실 Pi 검증 필요 — 착수 전 사용자 확인** |
| 8 | **G3b: 원격 check runner** / **G3c: judge (Gate 1.5)** | 동 spec §5f/5k-4 | ✅ **완료·merged**. **G3c** (#363, migration 060 + goalJudgeService/harvest judge stage + decideGoalVerdict judge 분기, `PALANTIR_GOAL_JUDGE=1` 기본 off). **G3b Part A** (#364): 원격 deliverable ARTIFACT check 를 **클린 로컬 번들** 대상 평가(shell 0). rmrf 는 complete+durable+acceptance-persisted 만, 심볼릭 링크 chain 거부, promise-gate single-flight, fail-closed injectivity. codex 3R→PASS, 실 Pi 검증. **G3b Part B (원격 command runner) = DEFER** (unsandboxed pod shell 기밀 유출 = 별도 sandboxed-runner/fleet 보안 프로젝트). command check 원격 = skipped('runner_unavailable')→gate2 불변. | PR 2개 (G3c #363, G3b-A #364) |
| 9 | backlog Ready 섹션 잔여 항목 | `docs/backlog.md` | ⏳ **큐 소진 — 사용자 우선순위 협의 대기** | 큐 소진 시 사용자와 우선순위 협의 |

순서 근거: F-1 은 소형이라 이 프로토콜 자체의 파일럿. G 트랙은 페이즈 의존 순서 (G1+G2 만으로도 독립 가치, G3 가 본체). 원격/하드웨어가 필요한 것 (G2b/G3b) 은 뒤로.

## 2. 작업별 진행 프로토콜 (goal 방식)

각 큐 항목마다 아래 8단계를 반복한다. **한 항목이 merge 완료되기 전에 다음 항목을 시작하지 않는다.**

1. **[goal 계약]** spec 재독 후 이 작업의 goal 을 명문화: 목표 1문장 + 수락 기준 (spec 의 테스트 목록 + `npm test` 전체 그린 + codex 최종리뷰 PASS).
2. **[계획]** Claude 가 구현 계획 수립 — 작업 단위 분해, 파일별 변경 지점, 테스트 목록. spec 에서 벗어나는 결정이 필요해지면 **멈추고 사용자 보고**.
3. **[계획 교차검토]** 계획을 `codex exec` 적대 검토 — NO-GO 항목 반영을 PASS 까지 반복.
4. **[위임]** 각 작업 단위를 `/codex-goal` 로 codex 에 위임. 위임 프롬프트에 단위별 goal + 수락 기준 + 관련 파일 경로를 명시.
5. **[산출물 교차리뷰]** 각 codex 산출물을 Claude 가 리뷰 — blocker 는 구체적 수정 지시와 함께 재위임. 사소한 것은 Claude 가 직접 수정.
6. **[통합 검증]** `npm test` 전체 그린 (기존 회귀 0). UI 변경 시 `npm run test:a11y` / `test:visual` 도.
7. **[최종 리뷰]** 전체 diff 를 `codex exec` 로 최종 적대 리뷰 — PASS 까지.
8. **[마무리]** 표준 체인: branch → commit → PR → merge → main pull → **phase 종료 보고 1회** (한 일 / codex 라운드 결과 / 다음 항목) → 다음 큐 항목.

## 3. 사용자 확인이 필요한 지점 (자율 진행 예외)

- spec 이탈이 필요한 설계 결정 / 이전 feedback 과 충돌하는 방향 전환
- codex 가 ~5라운드 넘게 수렴 안 됨 (설계 전제 오류 가능성)
- **G2b**: 실 Raspberry Pi (karnian@100.64.17.115) 검증 필요 — 착수 전 확인
- **G3c judge 활성화** (`PALANTIR_GOAL_JUDGE=1`): LLM 호출 비용 발생 — 구현은 하되 켜는 것은 사용자
- **goal 모드 운영 활성화**: `PALANTIR_GOAL_MODE=1` 은 `PALANTIR_PM_TOKEN` 분리 운영이 전제 (spec §6) — 운영 flip 은 사용자
- 되돌리기 불가 git (force push, published amend 등) — CLAUDE.md 그대로

## 4. codex 호출 규율

- 백그라운드 `codex exec` 는 **`< /dev/null` 필수** (stdin hang).
- **tier**: 사용자 로컬 config 가 `service_tier="fast"` (2.5× 크레딧) 이므로, 사람이 기다리지 않는 검토/위임 호출에는 **`-c service_tier="default"` 를 붙여 standard 로** 돌린다. 사용자가 대화로 결과를 기다리는 짧은 질의만 fast 허용.
- 검토 라운드 효율: 깊은 적대 리뷰 = 기본 effort 유지, 반영 확인 라운드 = `-c model_reasoning_effort="medium"`.

## 5. 이 큐 작업들에 특히 걸리는 repo 계약 (CLAUDE.md 보충)

- **F-1**: 워커 codex 판별은 `resolveAdapterName(profile.command)` (profile.type 금지). fallback 재시도는 v1 범위 아님 (spec §6 기각 이력). migration 번호 053 부터.
- **G 트랙**: verdict 는 반드시 persist(CAS) 후 이벤트 emit — 구독자에서 정책 결정 금지 (설계 핵심 계약). harvest 는 annotate-only/never-throws/cleanup 무조건 유지. `run:harvested` exactly-once 계약 불변. B-lite/T5/webhook 의 goal 분기는 non-goal 경로 완전 불변으로.
- 새 run event 는 payload shape 고정, **새 SSE 채널 만들지 않기** (`run:event` 로 충분 — useSSE channels 하드코딩 회귀 이력).
- UI 는 디자인 토큰만 (인라인 색 금지) — a11y 36 + visual 36 가드 존재. 새 surface 의 contrast violation 은 waiver 불가.
- 테스트 `createApp` 호출 시 `authToken: null` 명시 (sibling flake 선례). `node --test` 는 spawnGuard 가 실 CLI spawn 차단 — mock binary 사용.
- 서버 재기동: kill 은 `lsof -sTCP:LISTEN` 결과만, 재기동 후 `/api/health` gitSha 확인 (skew 장애 선례).
- 문서 정합: 작업 완료 시 이 문서 §1 큐 상태 + `docs/backlog.md` + CLAUDE.md (구조 변경 시) 갱신.
