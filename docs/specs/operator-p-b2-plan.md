# Operator P-B2 — folder-less specialist (sub-slicing 계획 v0.2, Codex R1 반영)

> **v0.2 (Codex R1 = sub-slicing REVISE / B2a NO-GO→GO 반영)**: 2 BLOCKER + 5 SERIOUS 전부 수용. B2a 를 richer contract 로 재설계:
> - **B1 (ephemeral 관측 substrate)**: 모든 관측이 run-bound(`runService.addRunEvent`, conversation event 가 run 으로 resolve)인데 ephemeral specialist 는 durable run 이 없음 → **B2a 가 `SpecialistInvocation` trace 계약을 지금 정의**: `{invocationId, profileId, originRunId, originConversationId, operatorContext}`. specialist 출력/이벤트는 **origin run(=호출한 Top/PM, durable)의 이벤트 스트림에 invocationId 태깅**으로 흐름. ephemeral 유지(새 run kind/HARD 경계 미접촉) + 관측 가능.
> - **B2 (codex backend 부적합)**: codexAdapter 는 항상 `--dangerously-bypass-approvals-and-sandbox`(:298) + server cwd fallback(:207/spawnCwd:42) + process.env fallback(:368) → deny-by-default 못 태움. **B2c 는 전용 specialist backend 필요**(sandbox bypass 금지, tool=grant 로 제한). B2b assert 는 necessary-but-not-sufficient. (B2a 코드 영향 0, 계약/주석으로 기록.)
> - **S1 (Profile 축)**: OperatorContext 에 `profileId` 추가 (모델 = Profile×Workspace×ExecutionMode). legacy=run.agent_profile_id, specialist=명시.
> - **S2 (오파생)**: `deriveLegacyContext` 는 `workspaceDir` 를 **명시 입력**으로 받음(getRun 이 project.directory 미select). legacy 는 enforce 안 되므로 descriptive-only=무해, 그래도 정확성 위해 명시.
> - **S3/Q5 (불변식)**: `kind==='legacy' ⟺ grant.legacy===true` 불변식을 factory + `assertOperatorContext` 가 강제. **enforcement gate `isEnforced(ctx)` 는 `ctx.kind` 아니라 branded grant 의 `legacy` 비트에서 파생**(단일 진실 소스 = 위조불가 grant).
> - **S4 (send 경로)**: B2c 는 `sendToManagerSlot` 재사용 금지(Top/PM 바인딩·owner·ledger·parent-notice 하드와이어) → 별도 specialist send/inject 경로(memoryComposer.compose User-slot 만 재사용).
> - **S5 (lifecycle)**: ephemeral specialist 는 DB-run health-loop 밖 → B2c 가 자체 timeout/cancel/cleanup 계약.
> - **Q3 (trace identity)**: invocationId + originRunId/originConversationId 추가(parentRunId 는 parent-notice 모델링 시만).
> - **Q6 (MVP 유용성)**: zero CLI tool + registry_metadata_search 만으론 좁음 → MVP specialist = **caller 가 input bundle 제공**하는 reasoning(plan/review/research synthesis) 또는 B2c 가 read-only 내부 surface(task/run summary, **workspace content 아님**) 소수 추가. codebase-aware 작업은 불가(의도).
> - **NIT**: brief §3 slice5 "남음" 문구 stale(plan 은 done) / memory-arch §84 coder User+Profile+Workspace 가 brief §48 Workspace-only 와 불일치 / capability.js:35 OperatorContext 주석은 B2a 가 kind·profileId·trace 추가하면 갱신. (별도 doc 정리, 코드 무관.)

# Operator P-B2 — folder-less specialist (상세 — v0.2 반영본)

> 상위: `operator-p-b-plan.md` v0.2 §2 P-B2 + `operator-generalization-brief.md` v1.2 §6/§7/§10 + `operator-memory-architecture.md`.
> 선행: P-B0 (#250 assertWorkspaceBound + #251/#252 capability) + P-B1 (#253 Profile owner storage) merged — 전부 미와이어 계약.
> 감독모드: Claude 계획 → Codex 검토(반복) → 구현 → Claude 리뷰 → Codex 최종 GO.

## 0. P-B2 가 한 PR 로 안전하지 않은 이유 → sub-slicing
P-B2 = "folder-less specialist 도입" = ① 3축 결합 컨텍스트 + ② enforcement 와이어(가장 위험: false-positive deny 가 기존 coder/worker 깨뜨림) + ③ ephemeral specialist spawn/execution. Codex 가 P-B2 를 P-B 최대 리스크로 지목. → **additive·flag-gated 3 sub-slice** (P-A/P-B 규율 유지).

## 1. 아키텍처 조사 (2026-06-23, Explore + 직접 read)
- **HARD 경계 (변경 시 migration + 파서 + 레지스트리 동시)**: `runs.manager_layer CHECK(top|pm)`(mig 009), `conversationService.parseConversationId`(top|pm:|worker: 하드코딩, 그 외 400), `managerRegistry` 슬롯(top / pm:<id>), composition ledger `slot_kind IN(top,pm)`(mig 038).
  - → **Codex Δ5 결정 확정: specialist = ephemeral.** durable runs/conv/ledger/registry 에 **안 태움**. 위 HARD 경계 **미접촉** (specialist = in-memory namespace, no run row in registry, no ledger entry).
- **SOFT 경계 (enforcement plug-in 지점)**: `claudeAdapter.startSession` baseTools allowlist(:224), `codexAdapter` sandbox bypass(:298), `lifecycleService` is_manager 가드(:915/1048/1195), `resolveSpawnCwd`(spawnCwd.js, requireExplicit seam 미와이어), 내부 REST 라우트(dispatch/task/run/memory/project).
- **주입 경로**: `conversationService.sendToManagerSlot` 가 PM/Top slot 에 `memoryComposer.compose({owners})` → User/Workspace slot 주입(flag `PALANTIR_MEMORY_COMPOSER`/`PALANTIR_MEMORY_MULTI_OWNER`). specialist 는 **Composer User slot 만** 받아야 함(Workspace/Profile 미주입, stateless).
- **legacy 보존 핵심**: coder PM = restricted tool diet(claudeAdapter baseTools) / Codex PM = sandbox bypass. **완화 금지.** specialist 만 deny-by-default.

## 2. 결정적 안전 모델 — "enforcement gate = legacy vs specialist"
P-B0 두 계약(`assertWorkspaceBound`, `assertCapability`)을 기존 경로에 그냥 끼우면 Top/coder-PM/worker 가 deny 될 위험(예: Top 은 project.directory 없음 → workspace 가 none 으로 보일 수 있음). → **enforcement 는 `kind==='specialist'` 컨텍스트에만 적용**, `kind==='legacy'`(기존 전부)는 assert 자체를 **건너뜀**.
- legacy 컨텍스트 = `capabilityGrant=legacy passthrough`(#251) + workspaceBinding/executionMode 는 **descriptive only**(절대 enforce 안 됨).
- specialist 컨텍스트 = explicit grant(deny-by-default) + workspace:none → **assertWorkspaceBound + assertCapability 둘 다 enforce.**
- 이게 "allow-all 아님(Codex)" + "기존 byte-동치" 를 동시에 만족하는 유일 모델. enforcement 와이어(B2b)가 behavior-preserving 인 이유 = 기존은 전부 legacy → assert no-op.

## 3. Sub-slicing

### P-B2a — OperatorContext 결합 계약 (순수·미와이어) ⟵ 본 PR
brief 핵심 모델 `OperatorInstance = Profile × WorkspaceBinding × ExecutionMode` 를 코드 1급 객체로. **#250/#251 선례대로 순수 contract + 테스트, 호출처 0.**
- **`server/utils/executionMode.js`** (신규, workspaceBinding.js 미러): `EXECUTION_MODE = {DISPATCHER:'dispatcher', DOER:'doer'}` + `isExecutionMode` / `assertExecutionMode`(typo guard). dispatcher=워커에 위임(Top/coder-PM), doer=직접 수행(worker/specialist).
- **`server/utils/operatorContext.js`** (신규, P-B0 두 계약 통합 지점). **(아래는 v0.2 stamp 의 최종 shape 반영 — profileId 축·trace 계약·branded-grant gate 포함):**
  - `deriveLegacyContext({ run, workspaceDir })` → `{ kind:'legacy', profileId: run.agent_profile_id||null, workspaceBinding: workspaceDir ? FOLDER : NONE, capabilityGrant: createLegacyGrant(), executionMode: run.is_manager ? DISPATCHER : DOER }`. `workspaceDir` 는 **명시 입력**(caller 가 project.directory/worktree 에서 resolve; getRun 미select, Codex S2). **기존 Top/coder-PM/worker 의 descriptive 컨텍스트** (enforce 안 됨 = legacy grant).
  - `createSpecialistContext({ profileId, capabilities = [REGISTRY_METADATA_SEARCH] })` → `{ kind:'specialist', profileId, workspaceBinding: NONE, capabilityGrant: createGrant(capabilities), executionMode: DOER }`. (folder-less doer, deny-by-default O9 allowlist.)
  - `assertOperatorContext(ctx)`: shape + **kind⟺grant.legacy 불변식** + **grant 가 factory-issued(WeakSet) 인지 검증(R2 BLOCKER)** + specialist coherence(none+doer, R2 SERIOUS).
  - `isEnforced(ctx)` → assertOperatorContext 후 **branded grant 의 `legacy` 비트에서 파생**(`grant.legacy === false`; `ctx.kind` 단독 신뢰 금지, R2). legacy=false / specialist=true.
  - `createSpecialistInvocation({ operatorContext, originRunId, originConversationId?, invocationId? })`: ephemeral trace(BLOCKER-1), originRunId 필수·nested context freeze(R2 MEDIUM).
  - frozen 반환, fail-closed(잘못된 run/profile/grant shape throw).
- **테스트(20)**: legacy 파생 / specialist(none+deny+doer) / isEnforced gate / **forged grant 거부(R2 BLOCKER)** / **incoherent specialist 거부(R2 SERIOUS)** / invocation freeze(R2 MEDIUM) / kind⟺grant 불변식 / executionMode typo guard.
- **미와이어**: 어떤 spawn/route 도 아직 이 컨텍스트를 만들지/쓰지 않음. B2b 가 와이어.

### P-B2b — enforcement 와이어 (behavior-preserving, legacy bypass)
- spawn/route 진입에서 `deriveLegacyContext` 로 컨텍스트 생성(기존 경로) + specialist 경로는 `createSpecialistContext`.
- SOFT 경계에 `if (isEnforced(ctx)) { assertWorkspaceBound(ctx.workspaceBinding, surface); assertCapability(ctx.capabilityGrant, cap); }` 삽입: adapter tool selection(baseTools), resolveSpawnCwd(requireExplicit for none), 내부 REST 라우트(dispatch_execute/task_write/...).
- **기존 전부 legacy → assert no-op = byte-동치.** specialist(B2c) 만 deny.
- **회귀테스트 필수**: coder PM tool diet / Codex PM sandbox bypass / worker spawn cwd / 각 REST 라우트가 legacy 로 정확히 통과 + synthetic specialist 컨텍스트는 각 surface 에서 deny.

### P-B2c — specialist spawn + execution (feature, flag-gated)
- ephemeral specialist spawn 경로(pmSpawnService 와 **분기**, registry/durable run/ledger 미사용): in-memory namespace + one-shot doer turn.
- 주입 = **Composer User slot 만**(stateless). conv/run identity 비영속. lifecycle health-loop·eventBus·SSE 격리.
- capability = deny-by-default(B2a/b) — shell/FS/network/MCP/artifact 차단, 내부 metadata 만.
- flag `PALANTIR_OPERATOR_SPECIALIST` default OFF.
- **MVP: auto-capture 0, virtual 저장 0, 영속 = human R4 candidate(P-B1 storage 이미 준비) 만.** profile R4→active promotion(memory_items relax) 은 **별도 후속**(MVP 는 candidate 생성까지).

## 4. 첫 타겟 = P-B2a (순수 계약, 최저 위험)
specialist 본체(B2c) 와 enforcement(B2b) 의 keystone. 미와이어라 prod 무영향. 잘못돼도 호출처 0이라 behavior-preserving. #250/#251 와 동일 패턴(계약 먼저 lock).

## 5. Codex 검토 질문
- **Q1 (sub-slicing)**: B2a(컨텍스트 계약)→B2b(enforcement 와이어, legacy bypass)→B2c(specialist spawn) 분할이 additive·behavior-preserving·올바른 순서인가? ephemeral 결정(durable HARD 경계 미접촉)이 §2 안전모델과 정합하나?
- **Q2 (enforcement gate)**: "enforce 는 kind==='specialist' 에만, legacy 는 assert 전면 bypass" 가 옳은가? 아니면 legacy 도 (passthrough 결과로) assert 를 통과시키되 호출은 해야 하나(관측/일관성)? Top 이 project.directory 없어 workspaceBinding=none 으로 파생되는데, legacy bypass 라 무해한 게 맞나, 아니면 Top 을 명시적으로 다뤄야 하나?
- **Q3 (executionMode 파생)**: `run.is_manager ? dispatcher : doer` 가 맞나? Top/coder-PM=dispatcher, worker=doer. (specialist=doer.) 빠진 경우는?
- **Q4 (B2a 미와이어)**: B2a 를 순수 계약+테스트로만 두고 와이어를 B2b 로 미루는 게 #250/#251 선례와 일관된가, 아니면 deriveLegacyContext 를 최소한 spawn 지점에 annotate-only 로 붙여 "threads through" 를 증명해야 하나?
- **Q5 (capabilityGrant.legacy vs kind)**: enforcement gate 를 `ctx.kind` 로 둘지 `ctx.capabilityGrant.legacy` 로 둘지 — 둘이 항상 일치하나(legacy context ⟺ legacy grant)? 단일 진실 소스는?
- **Q6 (specialist capabilities 기본값)**: `[registry_metadata_search]` 만으로 MVP specialist 가 의미있는 일(research/review/planning 추론)을 하나? CLI tool 0개(shell/FS/MCP 차단)인데 doer 가 뭘 하나 — 순수 LLM 추론 + 내부 metadata 검색이 MVP 로 충분한가, B2c 에서 read-only 내부 조회 몇 개를 더 줘야 하나?
