# Codex Fast Mode 토글 (F-1) — mini-brief

> **상태: Codex 사전 구현검토 완료 (R1 NO-GO → 수정 지시 전부 반영). 구현 착수 가능.**
> 작성: 2026-07-11. 배경 조사: codexAdapter.js (exec args 조립), lifecycleService (worker args), ~/.codex/config.toml, OpenAI Codex Speed docs. Codex 검증: resume 경로 -c 지원 확인 (codex-cli 0.142.5), worker 주입 지점 = lifecycleService extraArgs/baseArgs.

## 1. 배경 / 문제

- Codex CLI 의 **fast mode = Fast service tier**: 우선순위 인퍼런스 라우팅으로 토큰 생성 속도 ~1.5×, 크레딧 소모 2.5× (gpt-5.5 기준). 전제: **ChatGPT 인증** (API key 미지원), 모델 gpt-5.5/5.4, `features.fast_mode` + `service_tier = "fast"`.
- 2026-07-11 사용자 로컬 `~/.codex/config.toml` 이 `service_tier = "fast"` 로 설정됨. **Palantir 가 spawn 하는 모든 codex (Operator 턴, codex worker) 는 user config 를 base 로 읽으므로 fast 를 암묵 상속** — 2.5× 크레딧이 배치성 작업 (worker run, auto-review 턴) 에도 의도치 않게 적용된다. M2 (legacy alias conflict) 에서 확인된 "user config 가 Palantir spawn 으로 새는" 드리프트 패턴의 재현.

## 2. 목표

1. Palantir 가 codex service tier 를 **명시적으로 통제** — user config 상속에 의존하지 않고 spawn 시 항상 tier 를 emit.
2. 사용자가 **UI 에서 Operator 대화 단위로 fast on/off** — 대기가 아까운 대화형 순간에만 2.5× 를 지불.

## 3. 설계

### 정책 (tier 결정 우선순위)
```
operator_instances.fast_mode (per-instance 토글, null=미설정)
  → PALANTIR_CODEX_FAST env (글로벌 기본, 기본값 0=standard)
    → 배치 경로는 항상 standard 고정
```
- **대화형 Operator/Top codex 턴**: 위 우선순위로 결정된 tier 를 `-c service_tier="fast"|"default"` 로 **항상 명시 emit** (codexAdapter args 조립부, first-turn/resume 양 경로 — resume 의 `-c` 지원은 0.142.5 에서 확인됨). fast emit 시 **`-c features.fast_mode=true` 동시 emit** (feature 미활성 환경 안전). user config 값은 무시된다 — 드리프트 원천 차단.
- **plumbing 전 경로 (Codex 검토 반영)**: codexAdapter 턴뿐 아니라 **Top startSession (`routes/manager.js` L643 계열) + boot resume 의 startOpts (L352 계열)** 에도 tier 옵션 전달 — 셋 중 하나라도 빠지면 그 경로만 user config 상속.
- **배치 경로**:
  - **codex worker spawn**: 항상 `"default"` — 주입 지점은 `lifecycleService` 의 `extraArgs`/`baseArgs` 조립 (M1 MCP flatten 과 같은 자리). **codex 판별은 `resolveAdapterName(profile.command)` 기준** (profile.type 아님 — 비-codex 커맨드/wrapper 에 `-c` 를 붙이면 깨짐, Codex 검토 지적).
  - **auto-review 턴**: 항상 `"default"` — 출처 전달 plumbing 필요: `createPmAutoReview` 의 `sendMessage(..., { source: 'auto_review' })` → `conversationService` → `adapter.runTurn(runId, { text, images, source })` 1-hop 추가. 현재는 출처 전달 수단이 없음 (Codex 검토로 확인된 사실).
- 기각한 대안: ① "user config 상속 유지 + 경고만" — 비용 걸린 설정의 silent 상속은 관측 불가 드리프트 (M2 교훈). ② "auto-review 도 instance tier 따름" — worker harvest 마다 도는 auto-review 턴이 전부 2.5× 를 내게 되어 기획 목적 훼손.

### 스키마 / API
- migration **053**: `ALTER TABLE operator_instances ADD COLUMN fast_mode INTEGER` (NULL=글로벌 따름). `SELECT *` 경로 (operatorInstanceService, runService.getOperatorInstance) 라 컬럼 추가만으로 spawn/resume 에서 자연히 읽힘 (Codex 확인).
- `PATCH /api/operator-instances/:id/fast-mode` — **cookie(human) 전용** (비용 결정이므로 Operator 자기 승격 차단; R4 actor split 선례). **한계 명시**: `PALANTIR_PM_TOKEN` 미분리 환경에서 `req.auth.method` 는 보안 경계가 아니라 actor hint (R4 caveat 동일) — 비용 오남용 방지 수준이지 보안 게이트가 아님.

### UI
- ManagerChat 헤더에 ⚡ 토글 — **codex 어댑터 대화에서만 노출**. tooltip: "빠른 응답 (~1.5×) / 크레딧 2.5× / ChatGPT 인증 필요". 디자인 토큰 준수 (인라인 색 금지).

### 가드 / 관측
- **fallback 재시도는 v1 제외 (Codex 검토로 기각)**: `runTurn` 은 동기 `accepted:true` 반환 후 비동기 child exit/vendor error 로 실패를 기록하는 구조 — 같은 턴 standard 재시도는 notice/memory ledger 커밋 이후라 불안전. v1 은 **관측만**: fast 턴 실패 시 `codex:fast_unavailable` run event (annotate-only) + UI 에서 토글 안내. 턴 실패 자체는 기존 TURN_FAILED 경로 그대로.
- 턴 이벤트 payload 에 사용 tier 기록 → RunInspector 에서 확인 가능. usage/비용 집계 연계 (U 트랙) 는 v2.

### 비변경
- Claude 어댑터 무관. thread resume 계약 무관 (`-c` 는 per-invocation, thread state 에 안 박힘). worker preset 별 fast 옵션은 v2 후보.

## 4. 페이즈

단일 PR: migration 053 + codexAdapter tier emit (first/resume) + Top startSession/boot resume plumbing + worker extraArgs 주입 + auto-review source plumbing + PATCH route + ManagerChat 토글 + 테스트.
테스트 필수 (Codex 검토 목록): ① Top startSession tier emit, ② Operator fresh/resume 양 경로 emit, ③ boot resume 경로 emit, ④ worker codex `"default"` 고정, ⑤ 비-codex custom command 에 미주입 (`resolveAdapterName` 판별), ⑥ auto-review source → `"default"`, ⑦ per-instance > env 우선순위, ⑧ PATCH cookie-only, ⑨ fast emit 시 features.fast_mode 동시 emit.

## 5. Open Question (lock-in 시 결정)

- 배치 standard 고정이 맞는가, 아니면 env 로 배치도 열어둘 것인가 (`PALANTIR_CODEX_FAST_BATCH`)? — 권장: v1 고정, 필요 시 v2.

## 6. Codex 사전 구현검토 반영 이력 (2026-07-11)

| 지적 | 반영 |
|---|---|
| fallback 재시도 구현 불가 (accepted:true 동기 반환 구조) | v1 제거 — 관측만 (`codex:fast_unavailable`) |
| auto-review 출처 전달 수단 부재 | `sendMessage → runTurn` source plumbing 채택 (대안 "instance tier 따름" 은 목적 훼손으로 기각) |
| worker codex 판별 | `resolveAdapterName(profile.command)` 기준 명시 |
| Top startSession / boot resume plumbing 누락 | §3 에 경로 추가 |
| migration 번호 | 053 |
| cookie-only 한계 | PM token 미분리 시 actor hint 명시 |
| fast_mode feature 전제 | fast emit 시 `-c features.fast_mode=true` 동시 emit |
