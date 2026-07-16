# Model/Effort 정책 레이어 (설정 페이지) — brief

> **상태: Codex 사전 설계검토 1회 완료 (GO-WITH-CHANGES — 지적 전부 본 문서에 반영). 최종 게이트 대기 → lock-in 후 구현 착수.**
> 작성: 2026-07-16. 배경 조사: codexAdapter.js(exec args 조립), streamJsonEngine.js(--model), lifecycleService(worker args), routes/manager.js(Top startSession), operatorSpawnService(Operator startSession), agent_profiles / operator_profiles / operator_instances / nodes 스키마. Codex 검증: 축 선택·우선순위·저장형태·resume/cache·보안 리뷰.

## 1. 배경 / 문제

Palantir 는 3계층 에이전트(Top → Operator → Worker)를 CLI(`claude`/`codex`/`gemini`)로 spawn 한다. 현재 **모델·effort 는 어디서도 코드로 통제되지 않고 전부 위임 상태**다 (검증 완료):

- **Top 매니저**: `model` 은 요청 body 옵션 → 없으면 CLI 자체 기본값. effort knob 없음.
- **Operator**: `operatorSpawnService` 의 startOpts 에 **`model` 키 자체가 없음** → 항상 CLI 기본 모델. reasoning_effort 미emit → user `~/.codex/config.toml` 상속.
- **Worker**: 100% `agent_profiles.command` + `args_template`(자유문자열). 기본 codex 워커 템플릿에 `-c 'model_reasoning_effort="high"'` 가 문자열로 박혀 있음.
- **유일하게 코드가 항상 강제하는 것**: codex `service_tier`(`fast`|`default`) — F-1 에서 도입, user config 상속 차단 목적.

**문제**: 사용자가 모델·effort 를 조정할 UI 가 없다. 특히 Top/Operator 레이어는 UI 제어가 0이고, Worker 는 자유문자열 편집뿐이다. 설정 페이지가 필요하며, 키잉 축("노드 내 연결 CLI별" vs "역할별")을 정해야 한다.

## 2. 목표

1. Palantir UI 에서 model / effort / tier 를 **구조적으로 설정** — CLI 자체 config 나 자유문자열에 의존하지 않고.
2. **레이어별 + 개별 오퍼레이터별**로 지정 가능 (사용자 요구: "오퍼레이터 별로도 지정").
3. **전부 additive** — 빈 설정 = 오늘과 byte-identical 동작. 기존 fast_mode/service_tier 가드 불변.

## 3. 설계

### 3.1 세 관심사 분리 (Codex 핵심 교정)

단일 축이 아니라 **3개의 독립 관심사**로 분리한다. 사용자의 "Node별 vs Role별" 질문의 답 = **둘 다 필요하되 역할이 다르다**.

| 관심사 | 축 | 성격 |
|--------|-----|------|
| **선호(preference)** | Role×Vendor **+ per-Profile** | "이 오퍼레이터/레이어는 이 모델·effort로" — 본 brief 의 주 대상 |
| **실행 가능성(feasibility)** | Node×CLI×auth-context | 노드마다 인증계정·조직 entitlement·CLI 버전·리전이 달라 모델 가용성이 노드 독립적이지 않음. spawn 시 검증, 불가 시 **actionable error (자동 downgrade 금지, fallback 은 opt-in)**. → Phase 3 |
| **비용(cost)** | per-node / per-vendor cap | override 가 아니라 **constraint** — 선호 해석 후 clamp/reject (조용한 downgrade 금지). → Phase 3 |

- **Node 를 선호의 주축으로 삼지 않는 이유**: 같은 벤더 계정이면 어느 노드의 CLI 든 같은 모델 가용. Node×CLI 를 선호 기본축으로 하면 N× 중복 + drift + 의미 희박.
- **Worker 를 role 로 묶지 않는 이유 (Codex 지적)**: 같은 Worker 라도 저비용 대량 작업 vs 고난도 작업이 프로필별로 다름. Worker 선호는 `agent_profile × vendor` 축이 자연스럽다. → 이는 사용자의 per-Operator(=per-`operator_profile`) 직관과 동일한 "설정은 프로필 엔티티에 붙는다" 원칙으로 수렴.

### 3.2 필드 단위 tri-state 해석 (Codex 핵심 교정)

**row 단위가 아니라 필드 단위**로 해석한다. 각 필드(model / effort / tier / …)가 독립적으로 `inherit / explicit / cli-default` 를 가진다. Role 정책에 effort 만 있으면 model 은 global 에서 상속되어야 하고, 특정 role 에서 global 값을 명시적으로 해제할 수 있어야 한다.

**우선순위 (레이어별, 필드별로 가장 구체적인 explicit 이 이김):**

- **Operator**:
  `operator_instances` live override(3-state) → **`operator_profile:<id>` 정책** ← 사용자 요구 → `layer:operator` → `global` → CLI 기본
- **Top**:
  요청 body `model` → `layer:top` → `global` → CLI 기본
- **Worker (Phase 1)**:
  **오직 `args_template`** → CLI 기본. **정책 테이블 미적용.**
  (Codex 지적: 정책이 authoritative 이면서 args_template 도 authoritative 는 모순. Phase 1 은 `role:worker`/`agent_profile:*` 정책 생성 금지, global 은 매니저 레이어에만 적용.)

### 3.3 저장: 단일 structured 테이블

필드 단위 상속을 **균일 리졸버**로 돌리려면 모든 scope 가 row 인 편이 낫다(엔티티 컬럼 혼재안 폐기). Codex 권장(공통 컬럼 + vendor별 params_json) 채택.

```sql
CREATE TABLE model_policies (
  scope_type  TEXT NOT NULL CHECK (scope_type IN
                ('global','layer:top','layer:operator','operator_profile')),
  scope_id    TEXT NOT NULL,          -- global/top/operator = 고정 sentinel '*' (NULL 금지)
                                       -- operator_profile = operator_profiles.id
  vendor      TEXT NOT NULL CHECK (vendor IN ('codex','claude','gemini')),
  model       TEXT,                    -- NULL = inherit. enum 잠금 X (모델 목록 빨리 변함)
  params_json TEXT NOT NULL DEFAULT '{}',  -- vendor별 옵션(effort/tier/thinking), discriminated
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision    INTEGER NOT NULL DEFAULT 0,
  changed_by  TEXT,                    -- 감사: 누가 바꿨나 (비용 영향 설정)
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- SQLite UNIQUE 는 NULL 을 중복 허용 → scope_id 를 non-null sentinel 로 강제 + 명시 unique
CREATE UNIQUE INDEX idx_model_policies_scope
  ON model_policies(scope_type, scope_id, vendor);
```

- **모델명 enum 잠금 금지 (Codex)**: 모델 목록은 빨리 변함. 알려진 값은 UI 추천으로만, custom 허용, 실제 검증은 실행 지점(feasibility, Phase 3).
- **params_json 은 app-level 로 vendor별 엄격 검증** — DB 질의 필요가 커지면 그때 vendor별 child table 로 분리(현재 불필요).
- **operator_profile scope 정합성**: `operator_profiles` 삭제 시 관련 policy row 정리(app-level 또는 trigger). scope_id 는 하드 FK 가 아님(scope_type 마다 참조 대상이 달라서) — 정합성은 서비스 계층이 강제.

### 3.4 vendor별 params (tier/effort 원자성)

- **codex**: `{ tier: 'inherit'|'fast'|'standard', reasoning_effort: 'inherit'|'low'|'medium'|'high' }`.
  **`service_tier=fast` 와 `features.fast_mode=true` 는 하나의 원자 개념 (Codex)** — raw `service_tier` 를 별도 노출하지 않는다. `tier` 단일 값이 두 argv 를 함께 결정.
- **claude**: `{ thinking: 'inherit'|... }` (model 은 공통 컬럼).
- **gemini**: model 만(공통 컬럼).

### 3.5 기존 fast_mode 통합 (3-state)

- Operator live 토글은 boolean 이 아니라 **`inherit / fast / standard` 3-state** (현재 `operator_instances.fast_mode` 의 `null/1/0` 의미 보존). UI 가 3-state 를 그대로 표현.
- `PALANTIR_CODEX_FAST` env **위치 확정**: **DB 정책이 있으면 DB 가 이김**, 정책이 없을 때만 env fallback → 없으면 standard. (F-1 의 `instance → env → standard` 를 `instance → profile-policy → layer/global-policy → env → standard` 로 확장.)

### 3.6 적용 시점

- **기본 = 새 session 부터** 적용. 실행 중 thread 즉시 반영은 **명시적 opt-in** (Codex: mid-thread 모델 변경은 CLI 버전 의존이라 무검증 전제 금지).
- `model_instructions_file` 경로 안정성은 프롬프트 입력 안정성만 보장하며 모델 변경 후 cache hit 를 보장하지 않음 — 문서에 명시.

## 4. 보안 / 관측 (Codex 지적)

- **쓰기 보호**: cookie 인증만으로 불충분. **Origin/CSRF 검증 추가** + 토큰 보유=admin (별도 role 시스템 없음). 비용 영향 설정이므로 Operator 자기 승격 차단(R4 actor split 선례 준용).
- **effective-value 관측**: UI 는 저장값뿐 아니라 **최종 effective 값 + 출처**(`request / instance / operator_profile / layer / global / env / cli`)를 필드별로 표시 — 디버깅 필수.
- **감사**: revision + changed_by + updated_at.

## 5. Phase 범위

- **Phase 1 (본 brief 구현 대상)**:
  `model_policies` 테이블(migration) + 필드단위 리졸버 + **Top / Operator / per-`operator_profile` / global** 정책 CRUD + 3-state fast 통합 + effective-source UI(설정 페이지). **Worker 는 손대지 않음.**
- **Phase 2**: Worker 구조화 — `agent_profiles` 에 structured model/effort 필드 추가, args_template 토큰을 **결정적 치환/합성**(free-string 파싱·뒤에 덧붙이기 금지 — arg 중복해석 위험). profile 필드 > (도입 시) role/global.
- **Phase 3 (선택)**: Node feasibility 검증(불가 모델 = actionable error, auto-fallback opt-in) + cost cap constraint 레이어(clamp/reject).

## 6. 불변식 / 회귀 가드

- **빈 테이블 = 오늘과 byte-identical**: **golden test 로 argv + env + resume + quoting 전부** 검증 (Codex: argv 만으론 부족).
- codex `service_tier` 는 **항상 명시 emit** 유지 — 정책은 값만 고르고, "항상 emit / user config 미상속" 가드는 그대로.
- `model_instructions_file` 경로 안정성 계약 유지.
- Worker 경로 Phase 1 완전 불변 (args_template authoritative).

## 7. 열린 질문 (lock-in 시 확정)

1. Phase 1 UI 위치: 새 `#settings` 탭 vs 기존 리소스/오퍼레이터 탭 내 서브뷰?
2. `layer:operator` 와 `operator_profile:<id>` 를 같은 설정 페이지에서 편집 vs 오퍼레이터 상세에서 per-profile 편집?
3. claude thinking budget 을 Phase 1 에 포함할지(현재 Palantir 가 claude effort 를 전혀 안 넘김) vs codex effort/tier 먼저.
4. Origin/CSRF 검증을 이 brief 에서 신규 도입 vs 기존 인증 미들웨어 확장 별도 트랙.
