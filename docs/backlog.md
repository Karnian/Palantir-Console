# Palantir Console Backlog

> Last updated: 2026-07-09 (Operator↔Codebase Refs watch-list W-P0~W-P7 완결 #342~#349 + W-P7 cleanup)
>
> 이 문서는 *현재 시점에서* 남은 작업들을 카테고리별로 정리한다.
> 완료된 작업의 한 화면 요약 + 새 세션 재입장 prompt 는 [`handoff-post-k2-launch-2026-04-29.md`](./handoff-post-k2-launch-2026-04-29.md) 를 본다 (§9 post-launch fixups + §10 K-3 cleanup + §11 K-4 launch + §12 K-5 launch). 그 이전 시리즈 (M1/M2/B3 + R1/R3/R4) 는 [`handoff-post-scenario-review.md`](./handoff-post-scenario-review.md) 에 있다.

## 카테고리 정의

| 카테고리 | 의미 |
|---------|------|
| **Ready** | 외부 트리거 없이 지금 당장 착수 가능. blocker 없음. |
| **Data-wait** | 기능적으로는 준비되었으나 착수 여부 결정에 운영 데이터 / 관측 기간이 필요한 항목. |
| **Trigger-wait** | 사용자 선언 (use case 발생) 이 필요한 항목. 기능 자체는 spec 에 정의되어 있음. |
| **Draft-review** | spec 은 있으나 Codex cross-review / lock-in 이 아직 안 끝난 항목. |

---

## Ready

### ~~W-P7. Operator↔Codebase Refs watch-list cleanup~~ ✅ 완료 (2026-07-09)
- `docs/specs/operator-codebase-refs-brief.md` v3 §4 W-P7: W-P0~W-P7 전 구현 완결(PR #342~#349 + 이번). 파괴적 제거 없이 legacy surface 판정 완료 — `operator:<projectId>` dual-read alias, `project_briefs.pm_thread_id` read-only bridge, `projects.pm_enabled` / `preferred_pm_adapter` spawn 정책 소스는 유지.
- 잔여는 선택 후속 후보로만 남김: pm_enabled/preferred_pm_adapter instance 이전, legacy alias 제거 여부, 역인덱스 실시간화, reference 요약 주입 고도화.

### ~~F1. Fleet 풀 루프 검증 — 원격 Operator 가 pod 에서 워커 dispatch~~ ✅ 완료 (2026-07-03, 실 Pi)
- **Mac 컨트롤 플레인(`PALANTIR_BASE_URL=http://100.120.25.112:4188`) → Pi 의 Claude Operator → Tailscale 너머 컨트롤 플레인으로 curl(POST /api/tasks + execute) → codex 워커가 Pi 에 dispatch(running@pi-f1)** 풀 루프 실증. pod → 컨트롤 플레인 역방향 도달성도 확인(Pi→Mac `MAC_REACHED`). 검증 하네스: `scratchpad/e2e-f1-full-loop.mjs`.

### ~~F2. Fleet 배포 runbook~~ ✅ 완료 (2026-07-03)
- [`docs/runbook-fleet-deploy.md`](./runbook-fleet-deploy.md) — 컨트롤 플레인 기동(PALANTIR_TOKEN/BASE_URL/HOST) / pod ssh+CLI 선로그인 / `#resources` 노드 등록 / 프로젝트 바인딩 / 검증된 토폴로지 매트릭스 / 트러블슈팅 / 보안 요약.

**나머지 Ready 비어 있음.** K-2~K-5 시리즈 + Fleet P4/P5(F1/F2 포함) 전부 종결.

진행 가능한 후속 nice-to-have (deferred — 사용자 트리거 시):
- **A11y-contrast-hardening** ✅ 완료(2026-07-08, fix/a11y-contrast-hardening). 통합 리뷰가 실 prod DB 렌더에서 노출한 5 위반 해소: (a) 공유 skill-badge-ok + manager .manager-session-badge/.manager-status-badge 하드코딩색→badge 전용 fg 토큰(--success-badge-fg/--running-badge-fg, priority-high-fg 선례, 3블록 lock-step), (b) .manager-msg-time opacity:0.7 제거(muted 를 4.5 아래로 blend), (c) .manager-messages tabindex/role=log(scrollable-region-focusable). a11y 56/56(실 DB) + 전체 2115. Codex GO. **잔여도 해소**: .manager-msg-user 타임스탬프는 버블 밖으로(A) + 다크 버블 --msg-user-bg 진하게(B) → assistant+user 타임스탬프·본문 전부 clean(별 커밋).
- **fleet-strip contrast** ✅ 완료(2026-07-12, #365). a11y gate 가 잡은 serious 위반: `.fleet-strip-warning` = `--status-needs-input`(amber-700 #b45309) on `--warning-bg-subtle`(8% amber tint) = 4.49:1 (light, <4.5). 신규 scoped 토큰 `--warning-badge-fg`(dark #f59e0b bright / light #92400e ≈6.3:1, `--priority-high-fg`/`--success-badge-fg` 선례, 3블록 lock-step). a11y 56/56, visual 56/56(pill 미렌더=baseline 무변).
- **K-4-card-markup NIT** ✅ 완료(2026-07-12, #366). `.agent-card`/`.project-card` 제목을 `<h2 class="card-heading">`(트리거 button 을 감싸 접근명=aria-label=카드명). `.card-heading { display:contents; font:inherit }` — display:contents 로 box 제거(zero layout, button 이 카드 flex item 유지) + font:inherit 필수(display:contents 가 box 만 제거, h2 UA font 1.5em/bold 는 trigger 의 font:inherit 로 카드 텍스트에 상속돼 agents 카드 시프트 → visual gate 가 포착). a11y 56/56, visual 56/56.
- **K-5-followup** — 모달/드로어 visual regression (K-5 spec §3 비범위 → 별도 phase)
- **K-4 NIT** — moderate severity gate 승격 (현재 report-only) — **K-4 spec L3 gate policy 변경 = 사용자 lock-in 필요**
- **interactive state visual** — hover/focus/pressed (Codex K-5 r1 권장 분리)
- **performance regression** (LCP/CLS) — 별도 phase

---

## 최근 완료된 phase 시리즈 (참고)

상세는 모두 `handoff-post-k2-launch-2026-04-29.md` 참고 (단 M4 시리즈는 spec brief 자체가 출처).

### 🚀 Fleet 원격 실행 노드 — P4 + P5 (LAUNCHED 2026-07-03, 실 Raspberry Pi 실증)

> spec `docs/specs/fleet-remote-nodes-brief.md` (r4 LOCKED) + `docs/specs/p5-claude-persistent-remote-brief.md`.
> **Master→Operator→Worker 3계층 중 하위 2계층(Operator + Worker)이 원격 pod 에서 spawn+dispatch+resume 하는 것을 실 Raspberry Pi 로 완전 실증.** 컨트롤 플레인(Mac/Pi) + ssh pod(agentless). 11 PR (#288~#298).

- **P0~P3 (원격 워커 dispatch, #275~#287)**: NodeExecutor seam(local/remoteSsh) + migration 047(nodes/projects.node_id/runs.node_id) + nodeService(pickExecutor/heartbeat) + 원격 워커 채널(tmux + 파일 status) + lifecycle 배선(pickExecutor 라우팅 + health async + dispatch gate). **실 Pi createApp e2e = 콘솔 codex 태스크→Pi 워커→completed 복귀(프로덕션 경로).**
- **P4 Codex Operator on pod (#288~#291)**: executor 프리미티브(spawnInteractive/putSecretFile) + brief thread affinity + **S3a codexAdapter node-capable**(executor-driven, runTurn=SYNC-returning + 원격 spawn fire-and-forget + detectExitCode 전수 안정화, Codex 6R/7findings) + **S3b operatorSpawnService 배선**(resolveNode→executor 주입 + resume affinity + fail-closed 502 + env:{} 원격 + auth remote-skip). **실 Pi: 프로젝트 Pi 바인딩→Codex Operator 가 Pi 에서 turn.**
- **P5 Claude persistent on pod (#292~#298)**: **S0 streamJsonEngine executor seam**(persistent Claude stream-json over ssh, spawnInteractive async→fire-and-forget attachChild) → **S1 keepalive**(ServerAliveInterval) → **S2 liveness tri-state**(transport 단절≠자연종료, unreachable+session 보존) → **S4a 로컬 Claude Operator**(resolveOperatorAdapterType claude→claude-code + onSessionStarted 콜백) → **dispatch 능력**(Bash(curl) 매니저 diet + curl 템플릿 — Claude Operator 가 실제 워커 dispatch, read-only+curl=codex full-bypass 보다 제약적) → **S4b 원격 Claude Operator on pod**(fail-closed 게이트 해제 + async-spawn 첫메시지 pendingInput 버퍼) → **S4c resume affinity**(claude_session_id↔node, project_briefs 재사용 no-migration, pm_adapter-aware). **실 Pi: preferred=claude+Pi 바인딩→Claude Operator 가 Pi 에서 persistent spawn+dispatch, app 재시작 넘어 같은 세션 resume→"42" 기억.**
- **방법론**: 매 슬라이스 codex-goal 구현 → 실 Pi 검증 → Claude 리뷰/수정 → Codex 적대 리뷰(PASS까지 R2~R6) → 병합. **실 Pi 가 fake 테스트·리뷰가 놓친 async 파급 버그를 반복 검출**(spawnInteractive async / env leak / auth preflight / 첫메시지 레이스 / boot-resume auth 하드코딩). 전 변경 byte-equivalent, 1868 tests.
- **Trigger-wait 였던 T1(Phase 3b — Claude PM resume) 은 P5-S4a~S4c 로 완료.**

### ML 메모리 레이어 PR1~PR3b — candidate→active 루프 닫힘 (LAUNCHED 2026-06-15~16)
- **PR #197~#200** PR1~PR2c / **#202** PR3a batch-distill 뼈대 / **PR3b** live distiller + scheduler. **1169 tests**. **비전 완성** — `PALANTIR_MEMORY_DISTILL=1`+`ANTHROPIC_API_KEY` 시 runtime 자동 작동.
- 3계층 누적 암묵지 — worker harvest/PM판정 → PM 프로젝트 메모리 자동 증강 → 주입. `memoryService`(upsertFact/createCandidate/retrieve FTS5/revision/주입 ledger) + `app.js` create{R6,R1b,R3}Capture(eventBus 독립구독 never-throws) + migration 025/026. **PR3a**: candidate→active 정제 파이프라인 — migration 027 `memory_jobs`(CAS lease) + `promoteCandidatesBatchTx`(lease 재확인+sanitize+clamp+evidence+createItem+status = 단일 안전강제 tx) + `memorySanitize`(출력 게이트) + `memoryDistillService.runOnce`(주입형 distiller, never-throws) + `fakeDistiller`. **fake distiller 로 전 경로 검증, LLM 0.** **PR3b**: `liveDistiller`(Anthropic Messages API `claude-haiku-4-5`, 주입형 callModel=mock 테스트) + `drainAll`/`startScheduler` + `listProjectsWithPendingCandidates` + app.js wiring(`PALANTIR_MEMORY_DISTILL=1` 기본 off + `ANTHROPIC_API_KEY`/`options.distiller`, shutdown stop). 플래그 on 시 R1b/R3 candidate→live distill→promote→active→PM 주입 = **비전 완성**. 안전(secret/injection/clamp)은 promote(writer) 강제. Codex 적대리뷰 PASS.
- **R4 remember** ✅ `POST /memory/remember` actor split (cookie=human active / bearer·none=candidate / fact cookie-only / 전 content sanitize / `fact_key` ASCII allowlist+env. 예약 / `PALANTIR_PM_TOKEN` opt-in spoof-proof). Codex 3R 적대리뷰 PASS.
- **PR4 사후교정** ✅ (#206 backend + UI): migration 028(archived_at/pinned) + memoryService CRUD(active-set 변경만 revision bump) + PATCH cookie-only + provenance redact(값+키) + GET ?status + `MemoryView`(#memory). Codex 적대리뷰 PASS.
- **PR5 안전·decay** ✅ (#208~#210+): hard-cap admission control(score eviction, human/pinned 보호, restore 도 admission) + graceful shutdown(scheduler awaitDrain·app.shutdown 멱등·watchdog-first) + poisoning gate(12 안전 불변식 + injection-time re-sanitize) + decay(`valid_to` datetime() 정규화 + TTL 90일 batch_llm-only + `expireStaleMemories` maintenance + `markReviewed` re-observation refresh + `memory:decayed`). migration 029(archive_reason). **ML 레이어 완비.**
- **a11y·visual #memory 가드** ✅ (#212): MemoryView 를 K-4 a11y + K-5 visual 매트릭스에 추가 (9 routes = 36 시나리오, `data-view="memory"` + baseline 4종, node@22/4189 fresh DB). a11y contrast 0, visual 안정.
- **PR3c-1 LLM semantic 병합** ✅ (#214): Codex 가 Jaccard 자동병합 원안 **NO-GO**(순서·극성 맹점→정반대 병합·run_id gaming) → distiller(LLM)가 existingItems 보고 중복이면 `mergeTargetId` 제안 → promote 재검증(active/project/NOT-expired/kind/Jaccard floor=sanity) → **누적만**(source_count/evidence, confidence 불변). existingItems 는 `listActiveForDistill` 로 LLM 프롬프트 전 살균. Codex 2R(1차 2 BLOCKER+4 SERIOUS+NIT→전부 수정·테스트재현, 2차 GO).
- **남음 (선택, handoff `docs/handoff-memory-layer-pr1-2c.md`)**: PR3c-2 cross-run confidence(독립 source 신뢰상향) / per-candidate FTS(cap-60 dedup 맹점) / L2(여러 PM→Master 승격). spec `docs/specs/memory-layer-brief.md` §10.
- 작업방식: 설계 Codex 4라운드 적대 리뷰 lock-in → athena 위임 PR1만 성공 → PR2a 부터 직접구현 + Codex 독립 교차리뷰(각 PR BLOCKER 까지 반복). node@22 테스트(ABI), repo-local Karnian push.

### P0 / H-1 / H-1.5 / harvest-fix / B-lite 큐 (LAUNCHED 2026-06-13~14)
- **PR #183** P0 — 테스트의 실제 CLI spawn fail-closed 차단 (`server/utils/spawnGuard.js`).
  2026-06-12 spawn storm 사고 (`docs/incident-2026-06-12-test-claude-spawn-storm.md`) 근본 수정.
  `NODE_TEST_CONTEXT` 감지 시 fixtures 밖 실행파일 차단, call site 6곳, npm test 복원,
  node 22 고정 (engines + .nvmrc). 968 tests (+9).
- **PR #184** H-1 — Run Harvest (spec `docs/specs/h1-run-harvest-brief.md` r2 READY).
  worker run terminal 시 autosave → diff 캡처 (`harvest:diff`) → opt-in `projects.test_command`
  실행 (`harvest:test`) → worktree 제거 (autosave off). migration 023, RunInspector Harvest 섹션,
  boot stale worktree 정리. 978 tests (+10).
- **PR #186** H-1.5 — Harvest → PM auto-review 연결 (자율 루프 폐쇄, spec
  `docs/specs/h1-5-harvest-pm-review-brief.md` r2 READY). worker 완료 → harvest(diff/test) →
  PM 이 검증된 요약으로 자율 판정. PM review 트리거를 `run:harvested` 단일 채널로 통일
  (run:ended 단일 신호 → harvestService exactly-once emit → app.js sendPmReview). 993 tests (+15).
  **진행방향 근거**: 운영 DB 조회 — 5주 정지(worker run 4월 43 → 5월 1), D1/needs_input/conflict
  실제 발생 0건 → speculative 기능 대신 자율 루프 폐쇄가 최대 레버리지로 판정 (Codex 자문 + 데이터 합의).
- **PR #188** harvest-fix — 도그푸딩 발견 버그: harvest test_command 가 시스템 node(v26, ABI147)로
  실행돼 프로젝트 node@22(ABI127) 와 불일치. `buildHarvestEnv` 가 서버 node 디렉터리를 PATH 앞에.
  통합 환경에서만 드러나는 버그 (단위 테스트는 testRunner 주입으로 PATH 우회). 994 tests.
- **도그푸딩 2회** (2026-06-13~14): 격리 서버(별도 포트/DB)로 실서버 실증. ① harvest 루프 실작동
  (harvest:diff files=1 + harvest:test) + node 버그 발견. ② PM review end-to-end — codex Top
  (`POST /api/manager/start {agent_profile_id:codex}` 우회, claude auth 불요) → PM(codex) → 워커 →
  harvest:test PASS(995/995) → run:harvested → PM 이 "테스트 PASS 995/995" 판정. 자율 루프 실증 완료.
- **PR #189** B-lite 큐 — `max_concurrent` throw → queued 유지 + FIFO 자동 spawn + failed 1회 자동
  재시도 (spec `docs/specs/b-lite-queue-retry-brief.md` r2). migration 024 (queued_args/retry_count),
  claimQueuedRun CAS, retry=새 attempt run(harvest 독립), countRunning worker-only(manager starvation fix),
  boot drain. 1007 tests (+12). Codex spec r1 (BLOCKER 1) + impl 교차리뷰 (SERIOUS 2: manager-count
  starvation / started_at 가드) 반영.
- **PR #191** 통합 교차리뷰 fix — 오늘 5 phase(P0~B-lite) 가 함께 작동할 때의 상호작용 결함 (개별 PR
  리뷰에서 안 보임). Codex 통합 리뷰 SERIOUS 4: boot drain × spawn guard 테스트 변질(NODE_TEST_CONTEXT
  skip + forceBootDrain), queued_args parse fail-closed(+ corrupt retry 차단 setRetryCount), PM breaker
  count race(reserve-then-send), 자동 retry × PM review 이중(advisory + T5). 1009 tests.
- **PR #192** C webhook 알림 — `PALANTIR_WEBHOOK_URL` 설정 시 run:needs_input + run:ended(failed) 외부
  POST 통지 (부재중, 탭 무관). SSRF-safe (assertSafeUrl {allowPrivate} 옵션화 + pinned IP POST),
  화이트리스트 payload, never-throws. **eventBus.emit 구독자별 격리** (Q4 — 앞 구독자 throw 시 webhook
  미발화 취약점 해소, 전 구독자 보호). 1027 tests (+18). spec `docs/specs/c-webhook-notify-brief.md` r2.
  Codex spec r1 (BLOCKER 2) + impl 교차리뷰 (Q4) + 최종 PASS.
- **PR #194** T4 harvest 프로젝트별 node — 멀티프로젝트에서 서버와 다른 node 요구 프로젝트의 test_command
  ABI 불일치 해소. **서버 node 우선 정책**: 프로젝트 선언(.nvmrc/engines major)을 서버 node 가 만족하면
  유지(퇴행 0), 명확히 다른 단일 major 만 homebrew node@N 전환. anchored 파싱(range/오염 → server),
  never-throws. spec `docs/specs/t4-harvest-per-project-node-brief.md` r2. Codex spec r1 (SERIOUS Q2/Q3) → impl PASS.
- **PR #195** T5 retry↔PM review de-dupe — 자동 retry(B-lite) + PM auto-review(H-1.5) 이중 재시도 차단.
  failed worker 의 PM review 를 자동 retry 진행 중이면 억제 (`hasHigherRetryAttempt` = task 에 더 높은
  retry_count active). retry rc 단조 증가로 정확 식별 → 최종 failed 발송(hole 0) + 동시실행 false-positive 0.
  spec `docs/specs/t5-retry-review-dedupe-brief.md` r2. Codex spec r1 (SERIOUS Q3) → impl PASS. **1046 tests**.
- **워크플로 전환**: 본 시리즈부터 Codex 가 구현, Claude 가 brief 작성·리뷰·보강 (감독 모드).
  spec r1 → Codex cross-review (BLOCKER 검출) → r2 lock-in → Codex 구현 → Claude 리뷰 → Codex 교차리뷰.
- **H-2 후보 (deferred, T3)**: PR 자동 생성/push, branch 자동 머지, diff patch body 표시 —
  harvest+PM review 운영 관측 후 트리거. (T4/T5 는 #194/#195 로 종결.)

### M4-a MCP Streamable HTTP transport + 검증 사이클 (LAUNCHED 2026-04-30, 검증 종결 2026-05-05)
- **PR #171** spec brief (`docs/specs/m4-mcp-http-streamable-transport-brief.md`, r7 READY, Claude opus-4.7 + Codex gpt-5.5 cross-check 7회), **#172** impl
- `mcp_server_templates.transport ∈ {stdio, http}` discriminated union (migration 022 — table rebuild + INSERT/UPDATE 정합성 trigger 2개: column-shape + transport/alias immutable). Bifrost / Linear / Notion / Sentry 같은 원격 Streamable HTTP MCP 를 워커 spawn 경로에 1급으로 등록 가능.
- **B-lite** — transport 추상화 레이어 / Strategy 패턴 도입 안 함, `if (transport === 'http')` 두 줄 분기로 처리.
- 신규 / 분기 모듈: `ssrf.assertSafeUrl` async helper (validator + preflight 공유, DNS resolve + IP pinning), `codexMcpFlatten` http 분기 (url + bearer_token_env_var leaf only, transport 키 미emit), `mcpPreflight` (HEAD only / 200·204·405·501 pass / 3s timeout / Authorization 첨부 / fail-closed `preset:mcp_unreachable`), `authResolver.resolveBearerForPreflight` 단일 entry point + `buildManagerSpawnEnv` bearerEnvKeys 자동 allowlist, `lifecycleService.executeTask` async 전환, `McpTemplatesView` transport selector + 동적 필드 + 카드 list 분기, `diagnose-mcp-conflicts.mjs` transport / url / bearer-env-key 출력 + `***` 마스킹.
- **테스트**: 902 → 959 (+57). `mcp-preflight.test.js` 신규 (시나리오 매트릭스 + real http server 통합 — lookup hook IP pinning / Authorization 헤더 / 302 redirect_blocked).
- **Codex r1 cross-check**: 0 BLOCKER, 2 SERIOUS (lookup hook 테스트 갭 / `buildManagerSpawnEnv` legacy 주석) 모두 fix 후 머지.
- **검증 사이클 (PR #173~#178, 2026-04-30~2026-05-05)**:
  - #173 backlog M4 phase 종료 stamp / #174 codex r1 fix
  - **#175** `diagnose-mcp` default DB path `palantir.db` → `server/palantir.db` (server/app.js:81 와 lock-step. 본 세션 발견된 false-negative 진단 fix)
  - **#176** `docs/runbook-m4a-bifrost-setup.md` 신규 — Bifrost 연동 셋업/검증/트러블슈팅 매트릭스 (192줄)
  - **#177** spec §L9.1 post-impl verification stamp — Bifrost end-to-end 검증 결과 (5 ✅ + 2 ⚠) inline 등록
  - **#178** spec §L9.1 확장 — 외부 hosted MCP HEAD 매트릭스 (Linear/Notion/Sentry/GHCP/Atlassian/Cloudflare 6개 직접 probe — 5/6 = 401, 1/6 = 404) + Bifrost listChanged 코드 분석 (`/mcp` 비동기 미지원, `/sse` 만 emit). M4-c entry + completion condition 정밀화
- **§7 deferred**: M4-b (clone-as-other-transport + bulk repoint), M5 (file-based MCP config delivery → issue #113), `'sse'` transport, dynamic `tools/list_changed`, OAuth-aware template, egress proxy. 모두 use case 발생 시.

### K-5 visual regression (LAUNCHED 2026-04-29)
- **PR #168** spec brief, **#169** impl
- Playwright screenshot diff 32 시나리오 (8 routes × 2 themes × 2 viewports), isolated webServer (:4189, fresh DB+HOME+OPENCODE+CODEX), threshold `maxDiffPixels: 100, threshold: 0.2`
- Codex 4 라운드 BLOCK→PASS (DB isolation / host state isolation / prestart bypass fix)

### K-4 WCAG AA a11y automation (LAUNCHED 2026-04-29)
- **PR #162** spec brief, **#163** impl + **#164~167** baseline cleanup (waiver 30 → **0**)
- axe-core 32 시나리오, transitional waiver 시스템, 5 라운드 fix 통해 baseline 완전 종결
- 신규 토큰: `--priority-high-fg`, `--button-primary-bg`, `--origin-url-fg`, `--info-light`. 카드 markup 재설계 (`<article>` + body-spanning trigger button).

### K-3α/β cleanup batch (LAUNCHED 2026-04-29)
- **PR #158** `--status-active-bright`, **#159** `--field-bg` adoption + `--surface-hover` 삭제, **#160** tokens.css light blocks lock-step 자동 가드, **#161** stamp
- K-2 launch 후속 후보 #1, #2, #5 종결

### K-2 라이트 모드 launch (LAUNCHED 2026-04-28)
- **PR #145~#153** Post-K cleanup + Theme Contract α/β/γ + K-2a/b/c/d
- `[data-theme="light"]` 22 의미 토큰 + system 자동 + 사용자 토글 + FOUC 방지 theme-init.js

### UI/UX cleanup follow-up (LAUNCHED 2026-04-26~27)
- **PR #129~#143** Phase F~K-1b (a11y / 한국어화 / 디자인 토큰 / Modal primitive / e2e selector attribute 화) + **#144** docs phase stamp = 16 PR

### Post-launch fixups (2026-04-29)
- **PR #154** handoff stamp, **#155** ExecuteModal task null deref BoardView 빈 화면 fix, **#156** SkillPacksView MCP 템플릿 콜랩서블 제거

---

## 직전 세션 통계 (2026-04-26~04-29 — K-2~K-5 41 PR 시리즈)

> 이 블록은 K-series 시리즈에 한정된 스냅샷이다. 본 세션 (M4 phase) 의 누적 카운트는 아래 footer 를 본다.

- **41 PR 시리즈 종료**: #129~#169
  - UI/UX cleanup follow-up 16 (#129~#144)
  - K-2 hybrid + launch 9 (#145~#153)
  - Post-launch fixups 3 (#154~#156)
  - 정합화 sync 1 (#157)
  - K-3α/β 4 (#158~#161)
  - K-4 spec+impl+followup 6 (#162~#167)
  - K-5 spec+impl 2 (#168~#169)
- **테스트** (직전 세션 종료 시점): node 902 + e2e a11y 32 + visual 32 = **966 tests**
- **3-layer K-2 token contract 방어 완성**:
  1. K-3β (build-time) — tokens.css light blocks lock-step
  2. K-4 (runtime axe) — WCAG rule 검증, baseline waiver 0
  3. K-5 (runtime visual) — Playwright screenshot diff
- **Codex 교차검증**: 모든 PR 머지 전 PASS, BLOCK 8건 모두 fix, NIT 다수 즉시 적용

**M4 phase 후 누적 (2026-04-30 시점)**: node 959 + e2e a11y 32 + visual 32 = **1023 tests** (M4-a 가 +57 node tests).

---

## Data-wait

### D1. M5 — Codex MCP `env` argv leak → file-based config transport
- **Tracked as**: [#113](https://github.com/Karnian/Palantir-Console/issues/113). spec 의 §7 후속 백로그명 = "M5 (가칭)".
- **Scope 추정**: Large. Codex 0.120 공식 `--config-file`급 진입점 부재 → upstream 기여 or Palantir-owned TOML fragment + 명시적 Codex 부팅 경로.
- **M4-a 후 잔여 범위**: HTTP MCP 의 token 노출 (argv) 문제는 M4-a 가 이미 우회 — `bearer_token_env_var` 의 **값** 은 워커 process.env 에서만 읽혀 argv 에 안 나오고, argv 에는 env var **이름** (예: `BIFROST_MCP_TOKEN`) 만 노출됨 (이름은 secret 아님). 본 항목의 잔여 표면은 **stdio MCP 의 env-via-argv** (skill pack 의 `env_overrides` 로 들어간 secret 이 `-c mcp_servers.<alias>.env={KEY="..."}` 로 *값까지* 노출). HTTP 로 마이그레이션 가능한 alias 는 그쪽으로 옮기는 것도 부분 해결책.
- **착수 기준** (Codex M2 권장):
  - 1-2주 실사용 관측
  - `runs` 테이블 `mcp:legacy_alias_conflict` event 빈도
  - alias 분포 (어떤 MCP 가 주로 충돌?)
  - 사용자 무시율 (event 발생했는데 run 이 의도대로 완료됐나?)
- **대체 지표 (관측 불충분 시)**:
  - 보안 정책상 argv leak 즉시 제거 필요 선언
  - 운영자가 `npm run diagnose:mcp` 경고를 해결 못 하는 패턴이 반복
- **관측 시작**: 2026-04-22 (PR #117 merge). 1-2주 후 = 2026-05-06 ~ 2026-05-13 사이 결정 포인트.

---

## Trigger-wait

### ~~T1. Phase 3b — Claude PM resume~~ ✅ 완료 (Fleet P5-S4a~S4c, #295~#298, 2026-07-03)
- Claude Operator 활성화(resolveOperatorAdapterType claude→claude-code) + onSessionStarted 생명주기 + resume affinity(claude_session_id↔node) + boot resume claude 분기 로 종결. adapter-generic 경로 완성. 실 Pi 재시작 연속성 증명.

### T3. H-2 — Harvest 수확 루프 완성 (PR 자동 생성 / 머지)
- **Spec**: `docs/specs/h1-run-harvest-brief.md` §4 (비범위 표)
- **Trigger**: H-1 운영 관측 후 — harvest:diff/test 이벤트가 실제로 리뷰→머지 결정에 쓰이기 시작하면.
- **착수 시 범위**: 프로젝트별 push/PR 정책 (remote 유무, gh auth, base branch 설정),
  RunInspector 에서 "PR 생성" 액션, diff patch body 표시 여부 결정.

### T2. M4-b — transport migration helper
- **Spec**: `docs/specs/m4-mcp-http-streamable-transport-brief.md` §7
- **Trigger**: 첫 transport 전환 시나리오 (운영 preset ~10개 넘는 환경) 또는 긴급 transport 전환 사고면.
- **Why deferred**: M4-a 의 `transport+alias immutable` 정책이 운영 preset 1~2개에서는 §3.3 manual path (새 alias 로 새 template + preset edit) 로 충분. ~10개 넘으면 partial-migration risk + 손-편집 부담.
- **착수 시 범위 (~100 LOC)**: (a) clone-as-other-transport 액션, (b) impacted references 표시 (worker_presets / skill_packs / 활성 run preset snapshot 목록), (c) bulk repoint (`mcp_server_ids` / `mcp_servers` 일괄 갱신 + audit event), (d) "참조 0개" 카드 표시.

---

## Draft-review

> **진행 프로토콜**: F-1 + G 트랙 등 후속작업 전체의 표준 진행 순서/규율은 [`docs/goal-session-protocol.md`](./goal-session-protocol.md) — 사용자가 해당 문서로 진행 지시 시 lock-in 간주 규약 포함.

### ~~F-1. Codex Fast Mode 토글~~ ✅ 완료·merged (2026-07-11, goal-session-protocol 파일럿)
- **Spec**: [`docs/specs/codex-fast-mode-brief.md`](./specs/codex-fast-mode-brief.md) (2026-07-11, mini-brief). **goal-session-protocol lock-in.**
- **요지**: user `~/.codex/config.toml` 의 `service_tier="fast"` 가 Palantir codex spawn 전체에 암묵 상속되는 드리프트 (M2 패턴) 를 명시 emit 으로 차단 — codexAdapter 가 `-c service_tier` 를 항상 명시. 대화형 Operator 턴은 per-instance ⚡ 토글 (cookie-only PATCH) + `PALANTIR_CODEX_FAST` env, 배치 (worker/auto-review) 는 standard 고정.
- **구현**: migration **053** (`operator_instances.fast_mode` INTEGER, NULL=env-follow) + `resolveCodexServiceTier` (per-instance>env 우선순위) + codexAdapter `serviceTier` (문자열|함수 오버로드 → 라이브 토글, 다음 턴 반영) fresh/resume 양 경로 `-c service_tier` (+fast 시 `features.fast_mode=true`) emit + `codex:fast_unavailable` annotate (fast 턴 실패 관측만, **v1 fallback 재시도 제거** — accepted:true 동기 반환 구조상 불안전, spec §6) + conversationService `source` plumbing → auto-review 만 `source:'auto_review'` 로 standard 강제 + lifecycleService codex worker standard 고정 + `PATCH /api/operator-instances/:id/fast-mode` (cookie-only) + ManagerChat ⚡ 토글 (디자인 토큰, aria-pressed). 테스트 12종 (spec 필수 9 + fast_unavailable dedupe + 마이그레이션). **codex 계획 R1 NO-GO(3 BLOCKER: resolveAdapterName(profile)/fast_unavailable per-turn dedupe/status wiring) → 반영, 최종 diff 리뷰 PASS(5 hotspot).** 전체 2163 tests, visual 56/56.

### G. Goal Delegation — 워커 완결 작업 위임 (전 업무)
- **Spec**: [`docs/specs/goal-delegation-brief.md`](./specs/goal-delegation-brief.md) (2026-07-10~11, v6). Codex 적대 리뷰 6라운드 수렴 (R1~R3 NO-GO → **R4 GO** [code core] → 워크로드 전제 교정[코딩→전 업무, Operator 단위] → R5 NO-GO 4B → **R6 GO** [일반화 레이어]). **goal-session-protocol lock-in.**
- **진행**: **✅ G1 완료·merged (#354)** (migration 054 + goalPrompt/goalReport + spawnQueuedRun 주입 + captureGoalOutput[file-backed tee §5k-2], 28테스트, codex R1→R2→R3 PASS). **✅ G2 완료·merged** (migration 055 verify_checks[표현식 unique index+trigger]/tasks·runs 컬럼 + `verifyCheckService`[server-derived provenance+downgrade] + `artifactCheck`[선언적 pure eval, symlink-safe, bounded walk] + `goalMode`[§6 goalFeatureActive fail-closed] + **§6 env scrub**[buildManagerSpawnEnv scrubHumanToken: goal 모드 시 Operator env 에서 PALANTIR_TOKEN 제거] + verifyChecks 라우트[actor-split, command cookie-only, cross-project guard] + goal workspace provider[deliverable 격리 cwd, fail-closed] + `goalAcceptance`+harvest 통합[Gate 1 command/artifact 실행→acceptance_json+harvest:acceptance, deliverable 수확 enumerate→acceptance→bundle, bounded I/O] + PM리뷰 Gate1 블록. **goalFeatureActive() 단일 게이트로 전 goal surface lock-step**[false=일반 태스크]. 24테스트. codex 계획 R1 NO-GO(2B §6+workspace) + 최종 diff R1(2B fail-closed 일관성+unbounded I/O)→R2(1 walk cap)→**R3 PASS**. Gate 1 은 관측만(verdict/전이 G3). **G3 다음**(verdict 루프 본체).
- **요지**: 워커 위임을 1회성 채팅에서 goal 계약(수락 기준 + verify check + 반복 예산)으로, **워크로드 불문** (code 모드=git workspace / deliverable 모드=격리 goal workspace + artifact bundle). 게이트: Gate 0 프로세스 종료 → Gate 1 기계 검증 (command=human-only + artifact=선언적·provenance 기반 gate/advisory 분리) → Gate 1.5 judge (구조화 LLM 판정, flag 별도, 보조 판정) → Gate 2 Operator 의미 판단(최종권). persisted verdict (race-free CAS) + 단일 tx 재시도 + attempt 연속성 (code=ref 계승 / deliverable=bundle seed) + node-aware workspace provider (local/remote pod) + copy-verify-delete 수확 + 산출물 전달 (branch 승격 / bundle manifest). 외부 액션 업무(메일/티켓)는 `action` goal kind 로 **v2 명시 유보**. `PALANTIR_GOAL_MODE` flag-gated, 전제조건 = `PALANTIR_PM_TOKEN` 분리. 페이즈 G1(프롬프트/파서/출력캡처)→G2(check+workspace local+deliverable 수확)→G2b(remote provider, 실 Pi)→G3(verdict 루프, 본체)→G3b(원격 runner)→G3c(judge)→G4(UI/전달)→G5(메모리).

### N. 노드 퍼스트 작업보드·프로젝트 재기획
- **Spec**: [`docs/specs/node-first-board-brief.md`](./specs/node-first-board-brief.md) (v1.2, PR #307). Codex 적대 리뷰 4라운드 수렴 (R1 3B+6S → R2 3B+3S → R3 1S → **R4 GO**), 사용자 lock-in 완료 (2026-07-05).
- **N0 정합 수리 ✅ 완료 (PR #309~#311, 2026-07-05)**: ① migration 048 tasks rebuild — status CHECK 'failed' (prod 복사본 실측 + prod v48 적용) + 폼 dead-field 정합 ② 노드 복구 자동 drain (`onNodeRecovered`→`scheduleDrainForNode`, **실 Pi e2e: unreachable queued → host 교정 → flip 4초 내 자동 drain → codex 완주**) + transport_lost 실제 node_id. 각각 codex-goal 구현 + Themis PASS + Codex 적대 리뷰 GO. 1908 tests. (#311 은 #310 브랜치 조작 실수 복원 — worktree 커밋에서 PR 브랜치 만들 때 base 불일치 `reset --soft` 금지 교훈.)
- **N1 관측 ✅ 완료 (PR #313~#315, 2026-07-05)**: envelope·webhook node_id hoist + `node:status` SSE(flip-only, 3-목록 lock-step) / explainDispatch 공용 정책(+`profile_missing`) + `GET /api/nodes/summary`(읽기 시점 사유) / 노드 배지 4표면 + 대기 사유 칩 + 대시보드 플릿 스트립(진짜 queued 칩, AC1 접힘) + AttentionStrip 노드다운 승격 + `useNodeSummary` 공용 훅. a11y·visual 52/52(dashboard baseline 4장 재생성), 라이브 실 Pi 스트립 시각 검증. 1937 tests.
- **N2 UX ✅ 완료 (PR #317, 2026-07-05)**: nodeBindingValidator(원격 directory bind-time 검증=로컬↔원격 mismatch 차단, PATCH effective 병합; mcp_config_path 는 UI 안내로 완화) + ProjectNodeSelect 헬스+rebind 409 guided flow(POST /:id/reset) + NodesView 상세 running/queued 역링크·Operator 링크·라이브화 + 보드 '배치 노드' 필터. 1961 tests, a11y·visual 52/52.
- **N3 제어 ✅ 완료 (PR #319 + #320, 2026-07-05)**: cordon(migration 049 `nodes.cordoned`, explainDispatch 차단, Operator spawn 409/boot resume skip, uncordon→drain, NodesView 토글, pickExecutor 미삽입=heartbeat 보호) + queued re-target(단일 tx all-or-nothing 409, POST /:id/retarget-queued, ProjectsView 배너) + stuck sweep(checkHealth 편승, unreachable/cordoned 15분+ queued→queue:stuck annotate-only, AttentionStrip cordoned 승격). 1988 tests.
- **🎉 N 트랙 전체 완료 (N0~N3, PR #309~#320)**: 노드 퍼스트 재기획 — 정합 수리 → 관측(envelope/SSE/summary/배지/사유칩/플릿스트립) → UX(바인딩 검증/헬스/역링크/보드 필터) → 제어(cordon/sweep/re-target). v2 후보(멀티노드/task override/soft affinity/글로벌 cap 등)는 brief §3 표 — 트리거 대기.

### ~~P. Project Repo-Defined 재정의 (C안)~~ ✅ 전 구현 완결 (2026-07-06, PR #323~#331)
- **Spec**: [`docs/specs/project-repo-defined-brief.md`](./specs/project-repo-defined-brief.md) (v1.0 LOCKED → 전 phase 완료 스탬프).
- **완결**: 프로젝트를 folder-bound → **코드베이스(git repo)** 로. 로컬(schema v050/API+preflight/UI/materialize+queue/MCP split/Operator+reset guard) + 원격(clone·auth/worker cwd/harvest, 실 Raspberry Pi spike 각 6/6) + cleanup/rollback. flag `PALANTIR_PROJECT_REPO` **기본 ON**(#333; `=0` 으로 rollback, legacy_directory 무손상). Codex 교차검증(PR3 동시성 5R·PR5a 보안 3R·PR5c 2R). 열린 결정 5개 lock: ref=per-run fetch / full clone / workspace root=exposed_roots[0]/.palantir-* / lease TTL 10min·max_materializing 2·global 4 / subdir=cwd.
- **남은 것(선택, Trigger-wait)**: PR5a-2 controller-token askpass 2순위 — 현재 git auth=node-local only(pod 자체 자격), 부재 시 fail-closed. private repo 에 pod deploy key/gh auth 가 없는 시나리오 발생 시 착수.

*(기존 항목: `skill-pack-gallery-v1.1.md` 는 PR #124 에서 Final / locked-in, `manager-session-ui.md` 는 PR #120 의 gap analysis + PR #121-123 R2-A/B/C 로 대부분 소화)*

---

## Non-backlog: 진행 방식 규율

(이 문서를 업데이트할 때 다음 세션이 일관된 출발점을 갖도록)

- **완료 항목 이동**: Ready/Data-wait/Trigger-wait 에서 완료되면 해당 섹션에서 제거하고 `handoff-post-scenario-review.md` 의 "완료된 작업 요약" 에 한 줄 추가. 이중 관리 금지.
- **새 항목 추가**: spec 또는 issue 가 먼저 생겨야 함. backlog 는 aggregator, source of truth 아님.
- **Last updated 날짜** 갱신: 편집 시마다 맨 위 timestamp.

---

## 참고 링크

- 전체 phase 구현 기록: `docs/specs/manager-v3-multilayer.md` §15 Implementation Log
- Worker preset 경로: `docs/specs/worker-preset-and-plugin-injection.md` (M1/M2/M3 known-limit 포함)
- Skill Pack v1.0: `docs/specs/skill-pack-gallery.md`
- Skill Pack v1.1 (draft): `docs/specs/skill-pack-gallery-v1.1.md`
- Manager UI Proposal: `docs/specs/manager-session-ui.md`
- M4-a Bifrost 연동 runbook: `docs/runbook-m4a-bifrost-setup.md` (셋업 / 검증 명령 / 트러블슈팅 매트릭스 / 운영 패턴)
- 본 세션 handoff: `docs/handoff-post-m4a-2026-05-05.md` (M4-a + Bifrost 연동 검증 8 PR 종료 stamp)
- 직전 세션 handoff: `docs/handoff-post-k2-launch-2026-04-29.md` (UI/UX cleanup + K-2 launch + K-3 + K-4 + K-5 시리즈 41 PR 종료 stamp)
- 이전 세션 handoff: `docs/handoff-post-scenario-review.md` (M1/M2/B3 + R1/R3/R4)
