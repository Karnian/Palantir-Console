# Codex Fast Mode 토글 (F-1) — mini-brief

> **상태: DRAFT — 사용자 lock-in 전. 소형 단일-PR 트랙.**
> 작성: 2026-07-11. 배경 조사: codexAdapter.js L361~425 (exec args 조립), ~/.codex/config.toml, OpenAI Codex Speed docs.

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
- **대화형 Operator/Top codex 턴**: 위 우선순위로 결정된 tier 를 `-c service_tier="fast"|"default"` 로 **항상 명시 emit** (codexAdapter args 조립부, first-turn L368~/resume L371~ 양 경로). user config 값은 무시된다 — 드리프트 원천 차단.
- **배치 경로 (codex worker spawn, harvest 후 auto-review 턴)**: 항상 `"default"` — 사람이 기다리지 않는 작업에 2.5× 는 무익.
- 기각한 대안: "user config 상속 유지 + 경고만" — M2 교훈상 비용이 걸린 설정의 silent 상속은 관측 불가 드리프트가 됨. 명시 emit 이 repo 원칙 (deterministic-first) 에 부합.

### 스키마 / API
- migration: `ALTER TABLE operator_instances ADD COLUMN fast_mode INTEGER` (NULL=글로벌 따름).
- `PATCH /api/operator-instances/:id/fast-mode` — **cookie(human) 전용** (비용 결정이므로 Operator 자기 승격 차단; R4 actor split 선례).

### UI
- ManagerChat 헤더에 ⚡ 토글 — **codex 어댑터 대화에서만 노출**. tooltip: "빠른 응답 (~1.5×) / 크레딧 2.5× / ChatGPT 인증 필요". 디자인 토큰 준수 (인라인 색 금지).

### 가드 / 관측
- **인증 비호환 fallback**: fast 턴이 tier 관련 오류로 실패하면 standard 로 1회 재시도 + `codex:fast_unavailable` run event (annotate-only). 토글 자동 off 는 하지 않음 (사용자 설정 존중).
- 턴 이벤트 payload 에 사용 tier 기록 → RunInspector 에서 확인 가능. usage/비용 집계 연계 (U 트랙) 는 v2.

### 비변경
- Claude 어댑터 무관. thread resume 계약 무관 (`-c` 는 per-invocation, thread state 에 안 박힘). worker preset 별 fast 옵션은 v2 후보.

## 4. 페이즈

단일 PR: migration + codexAdapter tier emit (양 경로) + PATCH route + ManagerChat 토글 + 테스트.
테스트 필수: ① first-turn/resume 양 경로 tier 명시 emit, ② 배치 경로 standard 고정, ③ per-instance > env 우선순위, ④ fallback 재시도 + 이벤트, ⑤ PATCH cookie-only.

## 5. Open Question (lock-in 시 결정)

- 배치 standard 고정이 맞는가, 아니면 env 로 배치도 열어둘 것인가 (`PALANTIR_CODEX_FAST_BATCH`)? — 권장: v1 고정, 필요 시 v2.
