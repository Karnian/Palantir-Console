# Model/Effort 정책 레이어 (설정 페이지) — brief

> **상태: 🔒 LOCKED — Codex 설계검토 5R GO + 사용자 lock-in (2026-07-16). R1 GO-WITH-CHANGES(축) → R2 8건 → R3 3건 → R4 3건(꼬리) → R5 GO(신규 모순 0). 구현 착수는 보류(Ready, 다른 작업 우선). 착수 방식 = codex-goal 위임(격리 worktree + Themis 외부검증).**
> 작성: 2026-07-16. 배경 조사: codexAdapter.js(exec args 조립), streamJsonEngine.js(--model), lifecycleService(worker args 순서), routes/manager.js(Top startSession), operatorSpawnService(Operator startSession — project 로드 확인), agent_profiles / operator_profiles / operator_instances(profile_id 대부분 NULL) / projects(preferred_pm_adapter) / nodes 스키마. Codex 검증: 축·필드단위 해석·저장·resume/cache·F-1 불변식·SQLite 유일성·보안 2라운드.

## 1. 배경 / 문제

Palantir 는 3계층 에이전트(Top → Operator → Worker)를 CLI(`claude`/`codex`/`gemini`)로 spawn 한다. 현재 **모델·effort 는 어디서도 코드로 통제되지 않고 전부 위임 상태**다 (검증 완료):

- **Top 매니저**: `model` 은 요청 body 옵션 → 없으면 CLI 자체 기본값. effort knob 없음.
- **Operator**: `operatorSpawnService` startOpts 에 **`model` 키 자체가 없음** → 항상 CLI 기본 모델. reasoning_effort 미emit → user `~/.codex/config.toml` 상속.
- **Worker**: 100% `agent_profiles.command` + `args_template`(자유문자열). 기본 codex 워커 템플릿에 `-c 'model_reasoning_effort="high"'` 가 박혀 있음.
- **유일하게 코드가 항상 강제하는 것**: codex `service_tier`(`fast`|`default`) — F-1 도입, user config 상속 차단.

**문제**: 모델·effort 를 조정할 UI 가 없다. Top/Operator 는 UI 제어 0, Worker 는 자유문자열 편집뿐. 설정 페이지가 필요하며 키잉 축("노드 내 연결 CLI별" vs "역할별")을 정해야 한다.

## 2. 목표

1. Palantir UI 에서 model / effort / tier 를 **구조적으로 설정** — CLI 자체 config·자유문자열 의존 제거.
2. **레이어별 + 개별 오퍼레이터(=codebase)별**로 지정 가능 (사용자 요구).
3. **전부 additive** — 빈 설정 = 오늘과 byte-identical. 기존 fast_mode/service_tier(F-1) 가드 불변.

## 3. 설계

### 3.1 세 관심사 분리 (Codex R1 교정)

| 관심사 | 축 | 성격 |
|--------|-----|------|
| **선호(preference)** | Role×Vendor **+ per-Codebase(operator)** | 본 brief 주 대상. Operator 는 codebase 당 primary instance 이므로 "오퍼레이터별" = codebase 스코프로 실현 |
| **실행 가능성(feasibility)** | Node×CLI×auth-context | 노드마다 계정·entitlement·CLI 버전·리전이 달라 모델 가용성이 노드 독립적이지 않음. spawn 시 검증, 불가 시 **actionable error (자동 downgrade 금지, fallback 은 opt-in)**. → Phase 3 |
| **비용(cost)** | per-node / per-vendor cap | override 아닌 **constraint** — 해석 후 clamp/reject (조용한 downgrade 금지). → Phase 3 |

- **Node 를 선호의 주축으로 안 삼는 이유**: 같은 벤더 계정이면 어느 노드든 같은 모델 가용. Node×CLI 를 선호 기본축으로 하면 N× 중복 + drift.
- **Worker 를 role 로 안 묶는 이유 (Codex)**: 같은 Worker 라도 저비용 대량 vs 고난도가 프로필별로 다름 → Worker 선호는 `agent_profile × vendor` 축(Phase 2). 이는 per-Codebase(operator) 와 동일한 "설정은 엔티티에 붙는다" 원칙.

### 3.2 필드 단위 tri-state 해석 (Codex R1+R2 핵심)

**row 단위가 아니라 필드 단위**로 해석한다. 각 필드는 세 상태:

- **inherit** = 해당 scope 의 params_json 에 그 키가 **부재** → 다음(덜 구체적) scope 로 계속.
- **explicit** = 키가 **존재**하고 값이 실제 모델명/effort → 그 값 채택, 탐색 종료.
- **cli-default** = 키가 존재하고 값이 sentinel `"__cli_default__"` → **CLI 자체 기본값 강제**(상속 차단), 탐색 종료. (상위 scope 의 explicit 을 특정 하위 scope 에서 "해제"하는 유일한 수단.)
- 어느 scope 에도 키가 없으면 → 자연 폴백 = CLI 기본값.

> tier 필드는 예외: `cli-default` 상태 **없음** (F-1). tier ∈ {inherit, fast, standard}. terminal 폴백 = env(`PALANTIR_CODEX_FAST`) → standard. **standard 는 반드시 `service_tier="default"` 를 명시 emit**(user config 미상속). "DB 정책 승리"는 **row 존재가 아니라 tier 필드가 fast/standard 로 resolve 된 경우에만** env 를 이긴다 — model-only 정책은 tier 해석에 무영향(필드 독립, Codex R2 #2).

**우선순위 (레이어별, 필드별로 가장 구체적인 explicit/cli-default 가 이김):**

- **[최상위 절대규칙 — F-1] Worker · auto_review 턴의 tier = 무조건 `standard`.** instance/codebase/layer/global/env 어떤 정책보다 먼저 short-circuit. model/effort 도 Worker 는 Phase 1 미적용(§3.7).
- **Operator (interactive)**:
  instance tier override(`fast_mode`, **live**) → **`codebase:<projectId>` 정책** ← 사용자 요구 → `layer:operator` → `global` → (tier 만) env → CLI 기본
- **Top**:
  요청 body `model` → `layer:top` → `global` → (tier 만) env → CLI 기본
- **Worker (Phase 1)**: **오직 `args_template`** → CLI 기본. **정책 테이블·env 미적용**(tier 는 위 절대규칙으로 강제 standard).

### 3.3 저장: 단일 structured 테이블 (Codex R2 하드닝 반영)

필드 단위 상속을 균일 리졸버로 돌리려면 모든 scope 가 row 인 편이 낫다. **모든 설정 필드(model 포함)를 params_json 에** 넣어 presence-기반 tri-state 를 표현(전용 model 컬럼은 NULL/sentinel 로 tri-state 를 못 담으므로 폐기 — Codex R2 #1).

```sql
CREATE TABLE model_policies (
  scope_type  TEXT NOT NULL CHECK (scope_type IN
                ('global','layer:top','layer:operator','codebase')),
  scope_id    TEXT NOT NULL,          -- global/layer:* = 고정 sentinel '*'; codebase = projects.id
  vendor      TEXT NOT NULL CHECK (vendor IN ('codex','claude')),  -- gemini=Phase2+
  params_json TEXT NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL DEFAULT 1,
  revision    INTEGER NOT NULL DEFAULT 0,
  changed_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Codex R2 #7: scope_type↔scope_id 정합 CHECK (복수 논리-global 방지)
  CHECK ( (scope_type IN ('global','layer:top','layer:operator') AND scope_id = '*')
       OR (scope_type = 'codebase' AND scope_id <> '*') ),
  -- params_json 은 반드시 JSON object
  CHECK ( json_valid(params_json) AND json_type(params_json,'$') = 'object' )
);
-- non-null sentinel + full UNIQUE = SQLite NULL-중복 함정 회피 (per-vendor 1 row/scope)
CREATE UNIQUE INDEX idx_model_policies_scope
  ON model_policies(scope_type, scope_id, vendor);
```

- **model 명 enum 잠금 금지 (Codex R1)**: 모델 목록은 빨리 변함. UI 추천만, custom 허용, 실검증은 실행지점(Phase 3).
- **params_json app-level 로 vendor별 엄격 검증** (허용 키/값·sentinel 형식). DB 질의 필요 커지면 vendor별 child table 로(현재 불필요).
- **쓰기 = 단일 tx 낙관적 CAS (Codex R2+R4 #B 확정)**: 모든 write 를 **하나의 better-sqlite3 동기 tx** 로 감싼다(단일 프로세스 동기 API → tx 내 원자적, TOCTOU 없음). tx 내부 순서:
  1. `scope_type='codebase'` 면 `SELECT 1 FROM projects WHERE id=?scope_id` — 없으면 **400/404**(존재 검증 + write 가 같은 tx 라 이후 삭제와 경합 없음).
  2. 기존 row `SELECT revision` — **없으면** `INSERT`(revision=1); UNIQUE 충돌(동시 신규 INSERT 경합) = `SQLITE_CONSTRAINT` → **409**. **있으면** 조건부 `UPDATE ... revision=revision+1 ... WHERE (scope,vendor)=? AND revision=?expected`.
  3. `UPDATE 0행` 분기: 재조회 → **row 존재 = 409**(revision mismatch, 동시편집) / **row 없음 = 404**(그 사이 삭제됨).
  4. 같은 tx 에서 audit 1행 append. `changed_by`/`updated_at` 은 last-writer 이지 이력 아님.
- **감사 이력 (Codex R2 #7)**: append-only `model_policy_audit(id, scope_type, scope_id, vendor, action, params_json_after, changed_by, created_at)` — 비용영향 설정 변경 이력. write/삭제(tombstone)마다 1행, 정책 write 와 동일 tx.
- **codebase orphan 원자화 (Codex R2 #7 확정)**: model_policies 마이그레이션 안에서 `CREATE TRIGGER AFTER DELETE ON projects → DELETE FROM model_policies WHERE scope_type='codebase' AND scope_id=OLD.id`. project 삭제와 **원자적**(trigger 이므로 app-code 무의존). Phase 1 은 codebase scope 만 orphan 대상.

### 3.4 vendor별 params (Phase 1 지원 매트릭스 = §3.7)

presence-기반. 키 부재=inherit, 값=explicit, `"__cli_default__"`=cli-default(tier 제외).

- **codex**: `{ "model": <str|sentinel>, "reasoning_effort": "low"|"medium"|"high"|sentinel, "tier": "fast"|"standard" }`.
  **`tier:"fast"` 는 `service_tier="fast"` + `features.fast_mode=true` 두 argv 를 함께 결정하는 원자 개념** — raw service_tier 별도 노출 금지(desync 방지, Codex R2 #3). tier 는 sentinel 없음.
- **claude**: `{ "model": <str|sentinel> }`. thinking budget 은 Phase 2(streamJsonEngine 은 현재 `--model` 만).

### 3.5 기존 fast_mode 통합 (3-state, 무재작성)

- `operator_instances.fast_mode` 는 이미 `NULL/1/0` tri-state. **기존 행 무재작성**: `1→fast`, `0→standard` 의미 **완전 보존**.
- **NULL 의미 확장 (Codex R2 #5)**: 오늘 `NULL = env-follow` → 개정 후 `NULL = codebase→layer:operator→global 정책 tier 를 따르고, 없으면 env→standard`. **정책 테이블이 비면 NULL 행은 오늘과 byte-identical**(env-follow) — 하위호환. 정책 row 가 생겨야만 NULL 해석이 바뀜.
- API: `PATCH /api/operator-instances/:id/fast-mode` 는 계속 `1/0/null` 기록. UI 3-state(standard/fast/inherit) ↔ `1/0/null` 매핑.
- **회귀 테스트 필수**: (a) 빈 model_policies + NULL fast_mode = 오늘의 env-follow argv 동일, (b) `layer:operator` tier 정책이 NULL-행 해석을 바꿈, (c) 1/0 행은 정책 무관 불변.

### 3.6 적용 시점 — tier=live, model/effort=session-frozen (Codex R2 #6 확정)

- **tier(fast_mode) = LIVE 유지**: 매 턴 재조회(F-1 의 ⚡ 즉시반영 계약 보존). tier 변경은 라우팅이라 mid-thread 안전.
- **model/effort = SESSION-SNAPSHOT**: `startSession` 시점에 1회 resolve → 세션 내 고정, 매턴 재조회 금지(mid-thread 모델 변경은 CLI 버전 의존이라 위험).
- **snapshot 저장 위치 = `runs` 컬럼으로 확정 (Codex R4 #A — Top+Operator 공통 분모)**: Top(Claude persistent)은 `operator_instances` 가 없으므로 instance 컬럼은 Operator 만 커버. 매니저 run(Top·Operator 모두 `runs` 에 `is_manager=1` row 존재)이 공통 분모이고 boot resume 이 매니저 run 을 순회하므로, migration 으로 `runs.session_model TEXT NULL`, `runs.session_effort TEXT NULL` 추가. Worker run 은 Phase 1 미사용(NULL 고정).
  - **저장 의미 (sentinel/NULL 통합)**: 스냅샷은 리졸버가 산출한 **"emit 할 실제 argv 값"** 을 담는다. explicit → 구체 모델명/effort 문자열. cli-default(`__cli_default__`) 및 자연폴백은 **둘 다 "아무것도 emit 안 함"** 으로 귀결하므로 **NULL 로 저장**(두 경우 argv 동일하여 하류 구분 불요). 즉 `session_model=NULL ⇒ -m/--model 미emit`, 구체값 ⇒ emit.
  - **생성**: 새 session 의 `startSession` 직후, 그 매니저 run 에 1회 write. **갱신**: 오직 새 session(새 thread/claude_session mint = resume 아닌 spawn, 또는 명시 reset → 새 run) 시 재resolve → 새 run 에 write. **세션 중 갱신 금지**.
  - **boot resume 복원 (Top·Operator 동일)**: resume 은 대상 매니저 run 의 `session_model/session_effort` 를 **그대로 읽어 emit**, 리졸버 **재실행 금지**(정책이 바뀌었어도 thread/session 은 시작 모델로 이어짐). NULL 이면 spawn 때와 동일하게 미emit.
- `model_instructions_file` 경로 안정성은 프롬프트 입력 안정성만 보장하며 모델 변경 후 cache hit 보장 아님 — 문서 명시.

### 3.7 Phase 1 지원 매트릭스 (Codex R2 #8 — lock-in 전 확정)

| vendor | model | reasoning_effort | tier | 비고 |
|--------|:---:|:---:|:---:|------|
| **codex** | ✅ | ✅ | ✅ | 통증 지점(effort/tier leak) + 유일하게 구조화 knob 존재 |
| **claude** | ✅ | ❌(Phase2) | — | startSession `model` 로 이미 주입 가능. thinking=Phase2 |
| **gemini** | ❌ | ❌ | — | Phase 1 소비자 없음 → **Phase 2+** |

`PALANTIR_CODEX_FAST` env 위치: **codebase/layer/global 정책이 tier 를 fast/standard 로 resolve 하면 그게 이김, tier 가 어디서도 explicit 이 아닐 때만 env → 없으면 standard**(§3.2 tier 규칙).

## 4. 보안 / 관측 (Codex 지적)

- **쓰기 보호**: cookie 인증만으로 불충분 → **Origin 헤더 검증(cross-origin 거부) 을 본 brief 에서 신규 도입** + 토큰 보유=admin(별도 role 없음). 비용 영향 설정이므로 Operator 자기 승격 차단(R4 actor split 선례: cookie=human 전용).
- **effective-value 관측**: UI 는 저장값뿐 아니라 **필드별 최종 effective 값 + 출처**(`request / instance / codebase / layer / global / env / cli`)를 표시 — 디버깅 필수.
- **감사**: revision + changed_by + updated_at.

## 5. Phase 범위

- **Phase 1 (본 brief 구현)**: `model_policies`(migration) + 필드단위 리졸버 + **Top / layer:operator / per-`codebase` / global** 정책 CRUD + fast_mode 3-state 통합 + model/effort session-snapshot+resume persist + effective-source 설정 UI + Origin 검증. **Worker 불변**(args_template authoritative), tier 는 Worker/auto_review 강제 standard.
- **Phase 2**: Worker 구조화(`agent_profiles` structured 필드 → args_template 토큰 **결정적 치환/합성**, free-string 파싱·후행 append 금지) + operator_profile(folder-less specialist) 스코프 + claude thinking + gemini.
- **Phase 3 (선택)**: Node feasibility 검증(불가 모델=actionable error, auto-fallback opt-in) + cost cap constraint.

## 6. 불변식 / 회귀 가드

- **빈 테이블 = 오늘과 byte-identical**: **golden test 로 argv + env + resume + quoting 전부** 검증(Codex: argv 만으론 부족). Top/Operator/Worker/auto_review 4경로. clean template 은 argv **바이트 동일**.
- **F-1 절대우선 + golden 모순 해소 (Codex R2 #4 + 재게이트)**: Worker·auto_review tier = 무조건 standard, 모든 정책 상위. **argv 순서는 오늘 그대로 유지**(강제 `-c service_tier="default"` 는 현행 extraArgs 선두 위치 불변 — "뒤에 append" 안 함, byte-identical 파괴 방지). last-wins 누수는 **args_template 내 `service_tier`/`features.fast_mode` 토큰을 거부(refuse)로 단일화 차단 (Codex R4 #C — strip 폐기)**: profile 저장 시 검증(reject) + spawn 시에도 동일하게 **refuse**(fail-closed run, strip 안 함 — golden "거부" 기준과 일치). 기본 codex 워커 템플릿엔 tier 토큰이 없으므로(effort 만) 정상 템플릿은 전부 무변경. golden test = (a) clean template argv 오늘과 동일, (b) tier 토큰 삽입 템플릿은 거부됨.
- codex `service_tier` 항상 명시 emit 유지(정책은 값만 고름).
- model/effort session-frozen + resume 스냅샷 재사용(정책 재읽기 금지).
- Worker 경로 Phase 1 완전 불변.

## 7. 확정 사항 / 열린 질문

**재게이트에서 확정 (전 열린질문 해소):**
- snapshot = `runs.session_model/session_effort` 컬럼(Top+Operator 매니저 run 공통), NULL=미emit, 새 session 시만 write, boot resume 은 매니저 run 스냅샷 재사용(§3.6).
- orphan = `AFTER DELETE ON projects` trigger 원자 삭제(§3.3).
- Top per-entity 스코프 불요(싱글턴) — `layer:top` + `global` 만.

**남은 열린 질문 (구현 착수엔 무영향, 착수 시 결정):**
1. Phase 1 UI 위치: 새 `#settings` 탭 vs 기존 리소스/오퍼레이터 서브뷰? (스펙 무관, UI 배치만.)
