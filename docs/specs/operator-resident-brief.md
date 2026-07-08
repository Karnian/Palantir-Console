# Resident folder-less Operator — 설계 brief (draft, Codex 설계리뷰 대기)

> **상태**: v3 LOCKED (2026-07-08) — Codex R1→R2→R3 적대 설계리뷰, R3 조건부 GO(6 lock + R-P1 수용조건). R-P1(schema/registry inert) 착수 가능. 사용자 greenlight 대기.
> **모델 소스**: [`operator-generalization-brief.md`](./operator-generalization-brief.md) — Operator = Profile × WorkspaceBinding × ExecutionMode. 계층 Master→Operator→Worker.

## 0. Codex R1 min-GO 조건 (이 개정에서 반영)

Resident = **direct safe backend + resident 전용 capability allowlist + no ambient cwd/env + profile lifecycle guard + resident memory ledger/revision + explicit Top/standalone policy**. 아래 §3/§4 에 전부 반영. R1 SERIOUS 7건 매핑: (1)(2)(3) safe backend/allowlist → §3.C+§3.H, (4) profile lifecycle → §3.F, (5) Top/standalone → §3.D, (6) layer/prompt 분리 → §3.A+§3.C, (7) capability 교차검증 → §3.H.

## 1. 문제 / 동기

사용자 비전: **"폴더에 할당되지 않고도 동작하는 operator"**. 현재 folder-less operator 는 **one-shot specialist**(`invokeSpecialist`, stateless, ACTIVE MANAGER turn 안에서 단발) 뿐 — 대화·기억·재호출이 안 됨. operator-centric 로스터의 "Available Operators" 가 바로 이 one-shot(호출 시 단발). 사용자가 상상한 "동작하는 operator" 는 **상주하며 대화 가능한 folder-less operator** 일 수 있음.

Codex v2 판정: spec-level 백엔드 = 새 runtime actor. 그래서 이 brief.

## 2. 모델상 위치 (기존 매트릭스의 빈 셀)

| | WorkspaceBinding | ExecutionMode | 세션 | 현황 |
|---|---|---|---|---|
| coder (현 PM/Operator) | folder | dispatcher | **persistent**(thread) | 있음 |
| specialist | none | doer | one-shot(stateless) | 있음 |
| **Resident (신규)** | **none** | **doer** | **persistent** | ⬅ 이 brief |

Resident = **coder-PM 의 persistence/routing 골격 + specialist 의 folder-less/capability-gated 안전모델**. 즉 "폴더 없는 상주 doer".

**하드 안전규칙 (R1 SERIOUS 1~3·7 반영 — draft 의 "no shell/FS" 는 불충분)**: `workspace=none ⇒` **no shell · no 직접 FS · no CLI ambient authority · no MCP · no network · no env 상속 · no artifact**. 즉 Resident 는 **direct safe backend**(specialistBackend 계열 — CLI dispatcher 경로 재사용 금지) 위에서, **resident 전용 allowlist** 로 교차검증된 도구만(MVP = `registry_metadata_search` 만, specialist 와 동일). profile 의 capability vocabulary(shell/fs/network/mcp 포함 가능)를 **그대로 신뢰 금지** — 장수명 세션이라 권한확대 위험이 one-shot 보다 큼.

## 3. 설계 축 (lock-in 대상 — Codex 리뷰 + 사용자 결정)

### A. 슬롯 identity + layer/parse 분리 (R1 SERIOUS 6)
- `managerRegistry` 슬롯: `resident:<profileId>` (현 `top` | `operator:<projectId>` 와 평행). **profile 당 singleton**(MVP). profileId 는 immutable id 라 기본 OK(§3.F 의 lifecycle guard 전제).
- conversation id: `resident:<profileId>` — **`operator:` 와 별도 parse path**(operator: = project operator 로만 파싱). conversationService/router 신규 prefix.
- **`runs.manager_layer` 에 `resident` 값 추가**(migration 046 이 `top|operator` 로 조임 → CHECK 완화). `operator` layer/parse 재사용 금지 — 섞이면 Master/dispatcher 개념 혼입.

### B. persistence (migration) — R1 §6 필드 반영
- 신규 전용 테이블 **`resident_operators`** (operator_instances 일반화는 coder 회귀 범위 커서 MVP 과함 = Codex 조건부 GO). 컬럼: `profile_id PK`, `backend_kind`, `thread_id`, `run_id`, `status`, `profile_version`, **`persona_hash`**, **`capability_snapshot`**(spawn 시점 resident-allowlist 교차검증 결과), `created_at`, `last_active_at`. persona/capability 변경 감지(§3.F)에 persona_hash+snapshot 사용.

### C. spawn / execution — direct safe backend (R1 SERIOUS 1~3·6)
- `ensureResidentOperator({ profileId })` 신규 경로(operatorSpawnService 의 PM dispatcher 경로 **재사용 금지**). 
- **backend = direct safe backend**(specialistBackend 계열): CLI adapter dispatcher spawn 이 아니라 API-level 호출. **cwd/env ambient 없음**(process.cwd/env 상속 0). 
- system prompt = **doer prompt**(profile persona) — `buildManagerSystemPrompt(layer:'operator')` 의 PM/dispatcher role section(project API·worker dispatch) **재사용 금지**. 신규 resident doer prompt 빌더.
- **seed runTurn 금지**(bake). 실행 위치 = 로컬 controller(MVP). 원격 상주 후속.
- doer only — worker dispatch 없음(project 없음). dispatcher 화 후속.

### D. 대화 routing / 계층 — standalone (R1 SERIOUS 5)
- **Resident = standalone (Top 하위 아님)**. 근거: resident 는 doer(worker 없음) → parent-notice(worker→parent staleness) 라우팅 대상이 아님. coder-PM 처럼 active Top 을 요구하면 boot resume 시 Top 부재/교체로 parent notice 가 조용히 drop(conversationService). standalone 이면 `parent_run_id = null`, Top 무관하게 resume/동작. 
- Master(=root operator, dispatcher) 와 개념 충돌 없음: Resident=doer, mode 로 구분.

### E. 메모리 (owner) — resident ledger/revision (R1 §6)
- owner = **User+Profile**(specialist 와 동일 — specialist 도 이미 Profile memory 주입하므로 "stateless" 아님; 차이는 **비영속 one-shot run vs 영속 conversation/thread**). Resident 는 영속이라 Profile 메모리 누적이 핵심 가치. **ledger 는 §3.5 #2 대로 기존 `memory_composition_events` 재사용 + `slot_kind='resident'`, 기존 Profile-owner revision 사용**(전용 ledger/revision fork 금지 — Composer 단일화). system prompt bake 금지(주입형, coder 와 동일 계약).

### F. profile lifecycle guard (R1 SERIOUS 4)
- **profile delete**: active resident 있으면 **거부**(409) 또는 dispose+tombstone. 그냥 row 삭제 금지(현 operatorProfileService.delete 는 무가드).
- **persona/capability 변경**: persona_hash/capability_snapshot mismatch 감지 → resident **reset/resnapshot**(옛 스냅샷으로 계속 동작 방지). 
- cleanup: `operatorCleanupService` 일반화(fail-closed 유지) — `resident:<profileId>` reset/dispose. **수동 dispose + boot resume**(standalone resume). idle GC 후속.

### H. resident 전용 capability allowlist (R1 SERIOUS 7 — 신규 축)
- profile capabilities(vocabulary 에 shell/fs/network/mcp 포함 가능)를 **그대로 신뢰 금지**. **resident 전용 allowlist** 로 교차검증 → 허용된 것만 tool mapping. **MVP allowlist = `registry_metadata_search` 만**(one-shot specialist 의 실제 매핑과 동일). shell/fs/network/mcp 는 resident 에서 매핑 안 함(vocabulary 에 있어도 무시). spawn 시 교차검증 결과를 `capability_snapshot` 에 기록.

### G. UI (로스터 신규 구역)
- 로스터에 **"Resident Operators"** 구역 신설 (현 Master / Live[project-bound] / Available[one-shot] 3구역 → 4구역). 
- **UX 계약**: Resident 는 **"Running/Live/Online" 표기 허용**(Available one-shot 과 반대 — Resident 는 실제 상주). Available='Ready to invoke', Resident='Running'/'Idle'/'상주'. 이 구분이 folder-less UX 의 핵심.
- Available 카드 → "상주로 승격"(spawn resident) 액션? 또는 별도 생성. **열림 질문**: Available(one-shot 프로필) 과 Resident(같은 프로필의 상주 인스턴스)의 관계 — 같은 profile 을 one-shot 도 resident 도? MVP: 프로필에서 "상주 시작" → resident 슬롯 생성, one-shot 은 그대로 병존.

## 3.5 R-P0 LOCKED DECISIONS (Codex R2 BLOCKER/SERIOUS 확정 — 옵션 제거)

Codex R2 가 "옵션으로 남기지 말고 lock" 요구한 항목을 **권장안으로 확정**(구현계약):

1. **safe backend 계약 (R2 BLOCKER 1)**: Resident backend = `specialistBackend` 계열 **direct API 호출**(CLI adapter dispatcher spawn 아님). tool mapping = **resident allowlist 경유만**(§3.H). CLI/tmux/subprocess/worktree 경로 미사용.
2. **memory ledger (R2 BLOCKER 2)**: **기존 `memory_composition_events` 재사용 + `slot_kind` CHECK 에 `'resident'` 추가**(별도 ledger fork 금지 — Composer 단일화 유지). provenanceKey/owner revision 은 기존 Profile-owner 패턴 그대로(전용 revision vector 신설 안 함).
3. **profile lifecycle (R2 BLOCKER 3)**: **active resident 있는 profile delete = 409 거부**(dispose 후 재시도). **persona/capability 변경 = resident 를 `stale` 마킹 → 다음 turn 차단 + reset/resnapshot**(옛 스냅샷 계속 동작 금지). **profile "version" 기준 = `persona_hash` + capability-set hash**(operator_profiles 에 신규 version 컬럼 안 만듦 — hash 기반 drift 감지).
4. **boot resume 3분기 (R2 SERIOUS 4)**: `routes/manager.js` resume 를 **`top` / `operator` / `resident` 3-way 명시 분기**로(현 `tops = !isProjectLayer` 2분기가 `resident` 를 Top 으로 오분류). resident 는 **standalone resume**(`parent_run_id = null`, active Top 무관).
5. **run/profile FK 경계 (R2 SERIOUS 5)**: resident run 의 **`runs.agent_profile_id = null`**(agent_profiles FK 는 resident 프로필=operator_profiles.id 에 부적용). **`resident_operators.profile_id`(→operator_profiles.id) 가 authoritative**. runs 에 operator_profile_id 컬럼 신설 안 함(MVP).
6. **capability_snapshot 구조 (R2 min-GO)**: `{ profile_cap_hash, effective_caps, denied_caps, allowlist_version }` 구조화(단순 effective_caps 아님) — allowlist 버전·거부목록 감사 가능.

## 4. Phasing (GO 시) — R1: R-P0 spec-lock 선행 필수
- **R-P0 spec-lock (구현 0, 문서/스키마 설계 확정)**: safe backend 계약, resident capability matrix(allowlist), profile lifecycle 정책(delete/변경), Top/standalone 정책, resident memory ledger/revision 설계, route/schema identity(`resident:` prefix + manager_layer 값 + 테이블 컬럼) 를 lock. Codex R2 GO 지점.
- **R-P1** schema/registry inert: migration(resident_operators + manager_layer CHECK 완화) + `resident:` parse/router/conversationService prefix + registry 슬롯. **동작 없이 스키마·식별자만**(flag-gated, 런타임 무영향).
- **R-P2** safe backend + spawn: `ensureResidentOperator`(direct safe backend, no ambient cwd/env, resident allowlist 교차검증→capability_snapshot) + doer prompt 빌더. profile lifecycle guard(delete/변경).
- **R-P3** conversation/persistence: runTurn + thread persist + standalone resume-on-boot + cleanup(fail-closed).
- **R-P4** 메모리: Profile owner resident ledger/revision 주입(Composer 연계).
- **R-P5** UI: 로스터 Resident 구역(4번째) + 상주 시작/종료 + 실시간 SSE. Resident 는 'Running/Idle' 표기 허용(Available one-shot 과 반대).
- 각 phase = 별 PR + Codex/Claude 교차검증.

## 4.5 R-P1 수용조건 (Codex R3 조건부 GO — schema/registry inert)

Codex R3 = 6 lock 으로 R-P1 GO, 단 아래 명시:
- **migration 은 post-050 `runs` shape 기준 rebuild**(050 이 materializing/node_id/repo·workspace 컬럼 추가 — 046 형태 복사 시 컬럼 손실 위험).
- `memory_composition_events.slot_kind CHECK` 에 `resident` 추가.
- `resident_operators`: `profile_id → operator_profiles.id` authoritative, `run_id → runs.id`, `status` CHECK(min `running/idle/stale/stopped`), `capability_snapshot` JSON valid.
- `conversationId.js` 에 `resident:` parser **별도**(project parser·`operator:` 재사용 금지).
- `managerRegistry.snapshot()` 에 `residents` 배열 추가(현재 top/pms 만).
- `/api/manager/status` 는 **Top 부재 시에도 residents 반환**(현재 Top 없으면 즉시 반환 — standalone 이라 Top 무관).
- `conversationService` 는 `resident:` **parse/resolve 까지만**; send/runTurn/spawn 은 R-P1 에서 **404/501 or flag-off fail-closed**.
- `manager_layer='resident'` CHECK 허용과 동시에 boot resume **3-way stub** 필수(현 manager.js 는 operator 아니면 전부 Top 분류).
- **R-P1 에는 active resident row 를 생성하는 route 없음**(profile lifecycle guard 는 R-P2 로 이연 가능).

## 5. 비범위 (MVP)
- profile 당 다중 resident 인스턴스. 원격 노드 상주. dispatcher-mode resident(worker dispatch). idle GC. Master 통합.

## 6. Codex 설계리뷰 요청 관점
1. 이 모델 위치(profile×none×doer×persistent)가 operator-generalization 과 정합? 새 actor 가 맞나, 아니면 기존 일반화로 흡수?
2. 전용 테이블 vs operator_instances 일반화 — 회귀/복잡도 trade-off.
3. 하드 안전규칙(workspace=none⇒no shell/FS) 이 persistent 에서도 충분? 상주 folder-less 의 새 공격면(장수명 세션 + capability 도구)?
4. slot key=profileId 의 정합(삭제/변경), Top 하위 라우팅, Master 와의 개념 충돌.
5. one-shot specialist 와 resident 병존이 사용자·메모리·UX 에 혼란? 
6. phasing 순서 + flag 전략. NO-GO 요소.
