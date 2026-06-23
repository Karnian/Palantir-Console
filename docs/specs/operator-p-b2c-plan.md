# Operator P-B2c — specialist spawn (sub-slicing 계획 v0.2, B2c-1 R2 반영)

> **v0.2 (Codex R2 impl review = REVISE→GO 반영, B2c-1)**: 3 Medium + 2 Low 수용:
> - **M2**: projection 의 `id` 도 `capField`(redact+cap) 적용; `source`('registry'|'profile' 고정 enum, 안전)를 계약에 명시 = **id/name/description/source**.
> - **M3**: terminal text 는 `stop_reason==='end_turn'` 일 때만 반환; present-but-non-end_turn(max_tokens/pause_turn) → `specialist:unexpected_stop` throw(partial 차단).
> - **L1**: tool_use 가 유효 `id` 없으면 `specialist:invalid_tool_use` fail-closed(malformed tool_result 방지).
> - **M1**: `toolExecutors` = TRUSTED 구성 파라미터(allowlist 는 name 만 검증, 함수 안전성 아님) → B2c-2 가 untrusted caller 에 노출 금지(주석 명시).
> - **L2**: gate3(enforceCapability)=redundant-by-construction(allowed 가 grant.caps 에서 파생) defense-in-depth=frozen context 재검증, 주석 명시.
> - **clean 확인**: apiKey 미leak, AbortSignal node@22 정상, 미와이어 additive, legacy entry 거부, injection tool_result 봉쇄. 18 테스트.

# Operator P-B2c — specialist spawn (sub-slicing 계획 v0.1)

> 상위: `operator-p-b2-plan.md` v0.2 §3 P-B2c. 선행: P-B2a #254 (context) + P-B2b #255 (enforcement wire) merged.
> 설계: Codex(ask) + athena 병렬 독립검토 수렴 (backend = Anthropic Messages API + server tool-use).

## 0. P-B2c sub-slicing (specialist 본체 = P-B 의 feature)
지금까지(B0/B1/B2a/B2b)는 전부 계약 + 미와이어 enforcement(behavior-preserving). B2c 는 **실제 동작하는 folder-less specialist**. 한 PR 로 안전 불가 → 4 sub-slice:
- **B2c-1 (본 PR) — 전용 backend** (deny-by-default Messages API + function-calling 엔진 + `registry_metadata_search` 1개 tool). 순수·미와이어·완전 unit-testable.
- **B2c-2 — specialist spawn 경로** (`createSpecialistContext` + `createSpecialistInvocation` + backend 호출 + Composer User-slot 주입, ephemeral=durable runs/conv/registry/ledger 미접촉, flag-gated).
- **B2c-3 — REST actor-identity + `enforceCapability` wire** (Tier2 라우트: who=human cookie / PM bearer / specialist → deny-by-default. `operator-p-b2b-plan.md §2` 매핑표).
- **B2c-4 — entry/UI** (specialist 호출 진입점).

## 1. B2c-1 = 전용 backend (왜 CLI 어댑터가 아닌가)
Codex+athena 수렴: codexAdapter 는 항상 `--dangerously-bypass-approvals-and-sandbox`(:302) + server cwd + `state.env||process.env`(:373) fallback, claudeAdapter 는 broad tool diet + `bypassPermissions`, **CLI tool-gating 은 escape-hatch 입증됨**(`Bash(curl:*)` 제거 사례). → subtractive(권한 뺏기) 불가. **Additive allowlist 만 안전**: model 의 affordance = 텍스트 emit 또는 *우리가 등록한* tool 호출. grant.caps 에서 tool 을 *추가 구성* → "체크 깜빡 ⇒ ambient authority" 실패모드 없음.

## 2. B2c-1 변경 (`server/services/specialistBackend.js` 신규, 순수·미와이어)
- **`createSpecialistBackend({ apiKey|callModel, model, fetchImpl, timeoutMs, totalTimeoutMs, maxTokens, maxIterations, toolExecutors, registryService, agentProfileService })`** → `{ runSpecialistTurn({ operatorContext, systemPrompt, userText }) }` → `{ text, toolCallCount, iterations }`.
- **function-calling 루프**: `tools` 를 `grant.caps ∩ CAP_TO_TOOL` 에서 additive 구성(없으면 tools 생략=pure text). `stop_reason` tool_use → executor → `tool_result` append(assistant content 전체 보존, tool_result 가 즉시 뒤따름) → 재호출. `maxIterations` 초과 → throw `specialist:max_iterations`. per-call(`timeoutMs`)+total(`totalTimeoutMs`) abort(AbortSignal.any). 비배열 `data.content` 가드.
- **🔒 3-layer gate** (모든 tool_use):
  1. **entry**: non-specialist(legacy) context 거부(`isEnforced` 가 `assertOperatorContext`+`isRealGrant` 위조검증 경유). specialist backend 는 safe fallback 아님.
  2. **allowlist**: tool name 이 cap-derived 허용셋(`grant.caps ∩ CAP_TO_TOOL`)에 있어야. injected `toolExecutors.shell` 도 name 미허용이면 lookup 前 거부=surface 확장 불가.
  3. **defense-in-depth**: executor 가 `enforceCapability(ctx, cap)` 재확인.
- **`registry_metadata_search` tool**: schema `additionalProperties:false` + `query maxLength 500`. executor=GET-only, query untrusted(coerce+500 slice, 빈쿼리→[] 무열거), source=`registryService.getRegistry().packs` + `agentProfileService.listProfiles()`, **투영 id/name/description/source 만**(command/args/env_allowlist/capabilities_json/url/bearer **절대 금지**), `redactSecrets`+공백정규화+240자 cap, max 20.
- **callModel/toolExecutors 주입** → zero-network/zero-LLM unit test. process.env 미접근(caller 주입).

## 3. 보안 불변식
- deny-by-default = additive allowlist(등록한 tool 만 실행). shell/fs/network(Anthropic 외)/MCP/env/artifact = tool 자체가 없음.
- tool result = untrusted: redact+cap 후 model 컨텍스트 재진입. system prompt(B2c-2)가 "metadata=데이터지 지시 아님" 명시 예정.
- Anthropic URL = 하드코딩 상수 → SSRF helper 불필요(user URL 아님).

## 4. 수용 기준 (16 테스트, `specialist-backend.test.js`)
constructor(apiKey|callModel) / legacy 거부 / unknown tool(shell) 거부 / cap 없는데 executor 있어도 거부(cap gate 권위) / known tool 실행+terminal text / multi tool_use / max_iterations / no-tool pure text / 비배열 content 무crash / malformed tool_use fail-closed / executor 투영 secret-free / secret redact / 빈·거대·non-string query / injection 봉쇄(tool_result=string) / tool schema 고정 / object result 직렬화.

## 5. B2c-1 미포함 (B2c-2/3/4 이연)
spawn 경로·OperatorContext call-site 구성·REST actor-identity·Composer 주입·UI·durable runs·flag. backend 는 항상 존재하되 미와이어(B2c-2 가 flag 뒤에서 호출).

## 6. 검증
설계 Codex+athena 수렴. 구현 후 **Codex R2 impl review**(3-layer gate·투영 secret-free·loop 정확·미leak·deny-by-default 증명) 게이트.
