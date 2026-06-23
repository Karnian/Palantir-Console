# Operator P-B2c-3 — specialist entry route (계획 v0.2, Codex R2 반영)

> **v0.2 (Codex R2 impl = REVISE→GO 반영)**: 1 SERIOUS + 3 MINOR 수용:
> - **SERIOUS**: originConversationId 가 run.conversation_id 와 충돌 시 service 가 plain Error throw → errorHandler 500 내부메시지 노출 → **라우트에서 originRun.conversation_id 와 비교해 clean 400**(service 체크는 defense-in-depth 잔존). + 테스트.
> - **MINOR**: `!originRun.is_manager` → `originRun.is_manager !== 1`(strict SQLite 0/1) / profileId·originRunId 길이 cap 256(trace payload 도달) / **auth-aware 테스트**(authToken 설정 시 무토큰 401/403·valid bearer 200 — 라우트가 global auth guard 뒤임을 확인).
> - **NOTE(무조치)**: cross-tenant=single-tenant forward-only(문서화), persona/userText injection=length-cap 이 MVP 통제(tool 실행/획득 불가, 3-layer gate), DoS=backend maxIter+timeout 상속(rate-limit 추적), error shape `{error}` 테스트 permissive.

# Operator P-B2c-3 — specialist entry route (계획 v0.1, Codex+athena 수렴)

> 상위: `operator-p-b2c-plan.md` §0. 선행: P-B2c-1 #256 (backend) + P-B2c-2 #257 (service) merged.
> 설계: Codex(ask) + athena 병렬 독립검토 수렴.

## 0. 핵심 scope 재정의 (Tier2 OBVIATED)
원안 B2c-3 = "REST actor-identity + Tier2 라우트 enforceCapability". **둘 다 수렴: OBVIATE.** specialist backend 는 model 에게 텍스트 + `registry_metadata_search`(server-executed) 만 노출 — **network/http/shell tool 0개** → 실행 중 specialist 는 **REST 라우트에 물리적으로 도달 불가**. 따라서 라우트별 capability deny 는 **dead code**(미래에 specialist 에 network tool 을 줄 때만 의미). **dead code 안 만듦.** → B2c-3 = **specialist 호출 entry 라우트** 하나로 collapse. 이게 feature 의 **MVP 완성점**.

## 1. 변경
### (a) `server/routes/operatorSpecialist.js` (신규)
`POST /api/operator/specialist` — `invokeSpecialist` 에 도달하는 유일한 외부 표면.
- 입력 검증(clean 400): userText(필수, ≤8000) / profileId(필수) / originRunId(필수) / persona(≤2000) / capabilities(string[] + **known-cap 체크** isCapability → unknown 400, createGrant 500 회피) / originConversationId(string).
- **origin-run gate**: `runService.getRun(originRunId)`(미존재 NotFoundError→404) + `is_manager=1`(아니면 400 "manager run") + status ∈ {running, needs_input}(아니면 400 "active run"). single-tenant=존재+manager+active 가 올바른 gate(cross-user ownership 모델 없음, multi-tenant 는 forward-only).
- delegate `specialistService.invokeSpecialist(...)` → `{invocationId, text, toolCallCount, iterations}` sync 반환.
- **Tier2 enforceCapability 의도적 부재**(주석으로 obviation 명시).

### (b) `server/app.js`
- require + **조건부 mount**: `if (specialistService) app.use('/api/operator/specialist', createOperatorSpecialistRouter({specialistService, runService}))`. flag off → specialistService null → 라우트 미존재(404, behavior-preserving).

## 2. 보안 (entry = 첫 외부 표면)
- 고정 `SPECIALIST_SYSTEM_PREAMBLE` 항상 prepend, persona 는 그 **뒤** append → persona/userText 가 deny-by-default 약화 불가.
- userText/persona 길이 cap(토큰비용+injection 표면 bound). persona 는 caller(authenticated)의 system 콘텐츠 = 신뢰(단일테넌트), detectInjection 부적용(legit persona 오탐 방지). untrusted 경계 = memory/tool-result(composer 살균 + preamble 표시).
- capabilities unknown → 400(라우트) / createGrant fail-closed(서비스) 이중.
- auth: cookie(human)/bearer(PM/CLI) 양쪽 허용(단일테넌트=둘 다 신뢰, actor-hint). PALANTIR_PM_TOKEN 시 spoof-proof 분리.
- cost: backend maxIterations=10 + totalTimeoutMs=120s 상속. rate-limit=프로덕션 hardening(MVP non-blocker).

## 3. 미포함 (별도 follow-up)
- **UI (B2c-4)**: Codex/athena 둘 다 **MVP DoD 밖**. HTTP 라우트+테스트 = feature-complete MVP. UI(SpecialistView + nav + #specialist + a11y/visual fixture)=별도 PR 150~250줄.
- Tier2 enforceCapability(obviated), 내부 Top/PM mid-turn 위임(미검증 use case), multi-tenant ownership, rate-limit.

## 4. 수용 기준 (10 supertest)
valid→200 {invocationId,text,...} / 필수필드 누락 400 / userText·persona oversize 400 / capabilities 비배열·unknown 400 / known cap 200 / 미존재 run 404 / worker(non-manager) run 400 / non-active(queued/completed) run 400 / flag OFF 라우트 미존재 404 / origin run 에 specialist:invoked+result emit.

## 5. DoD (specialist feature MVP)
`PALANTIR_OPERATOR_SPECIALIST=1` + `ANTHROPIC_API_KEY` 시: `curl -XPOST /api/operator/specialist -d '{profileId,userText,originRunId}'` → 실 specialist 응답. **= backend(B2c-1) + service(B2c-2) + entry(B2c-3) 로 end-to-end 사용 가능.** UI 는 선택적 후속.

## 6. 검증
Codex+athena 병렬설계 수렴(Tier2 obviate + entry 라우트). 구현 후 **Codex R2 impl review** 게이트.
