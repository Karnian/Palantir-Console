# Master Memory L2 — P1c & P2 실행 계획 (Codex 검토 대상)

> v0.1 DRAFT (2026-06-18). P1a/P1b merged (spec §13). 워크플로우: 계획→Codex 검토→Codex 구현+Claude 교차리뷰→병렬은 athena.
> 원칙(불변): de-scope(§12) — 무거운 graph/WikiGraph는 여전히 별도 bar 뒤. P1c=거버넌스·capture, P2=시맨틱 검색. 둘 다 **lean retrieval** 강화이지 graph 부활 아님.

---

## P1c — capture 규칙 + candidate 경로 + 거버넌스(cap·decay)

L1의 검증된 패턴(026 candidates / PR5 cap·decay / PR4 correction)을 user-scope로 미러링. **단 master엔 LLM distiller 없음** — candidate는 사람이 승인(human-review), LLM 정제 ✕ (de-scope: lean).

### 마이그레이션 `031_master_memory_candidates.sql`
- `master_memory_candidates`(id, scope, rule, raw_json, dedup_key, status[pending|promoted|rejected|merged], promoted_to, created_at, updated_at; UNIQUE(rule,scope,dedup_key); CHECK json_valid). L1 026 미러.

### masterMemoryService 추가
1. **cap-admission** (L1 PR5a 미러): `createMemoryItem`에서 active count ≥ `MASTER_ACTIVE_CAP`(예 500/scope) 시 lowest-score(confidence×importance, **human/pinned 보호**) eviction — 단 새 항목이 victim score 초과 시에만; 미달이면 reject. 단일 tx.
2. **decay** (L1 PR5d 미러): `expireStaleMemories()`(valid_to TTL→archive, revision bump) + `markReviewed(id)`(재관측 시 valid_to refresh). **human remember = valid_to NULL(영구); candidate-promoted/cross-project = TTL(예 180일)**.
3. **candidate**: `createCandidate({scope,rule,rawJson,dedupKey})` / `listCandidates(scope,status)` / `promoteCandidate({candidateId})` (사람 승인: candidate→active, sanitize+cap-admission, 단일 tx). LLM 없음.
4. **correction CRUD** (L1 PR4 미러): `updateContent`/`archiveMemory`(이미 있음)/`restoreMemory`(cap 재검사)/`setPinned`. active-set 변경만 revision bump.

### capture 규칙 (app.js, eventBus 구독, never-throws)
- **bearer/none remember → candidate** (route): 현재 403 → R4 candidate 생성(untrusted, 사람 승인 전 비active).
- **cross-project 승격(결정론)**: L1 active memory가 **같은 content_hash로 ≥2 프로젝트**에 존재 → master `cross_project` candidate (빈도 기반, 결정론, LLM 0). `memory:promoted` 구독 또는 주기 스캔. (κ=0.40 위험 회피 — 대화 마이닝 ✕, 구조적 빈도 신호만)

### 라우트 (masterMemory.js)
- POST /remember bearer/none → `createCandidate`(403 대체).
- GET /candidates (cookie, pending 목록) + POST /candidates/:id/promote (cookie 사람 승인→active).
- PATCH /:id (correction: update/archive/restore/pin, **cookie-only**).

### 테스트
cap-admission(human/pinned 보호·score eviction) / decay(TTL expire·markReviewed refresh) / candidate(bearer→candidate, promote→active) / cross-project 승격 / correction CRUD / 라우트 actor split.

### 파일 영향
`db/migrations/031_*.sql`(신규), `services/masterMemoryService.js`(추가), `app.js`(capture wiring), `routes/masterMemory.js`(candidate/correction), tests(신규).

---

## P2 — sqlite-vec 하이브리드(벡터+FTS) 검색

retrieve를 FTS-only → **hybrid(FTS bm25 + vec cosine, RRF 융합)**로. heavy graph는 여전히 미포함.

### ★ 결정 포인트 — 로컬 임베딩 런타임 (Codex 의견 필수)
zero-external-dep / local-first 제약에서 384-dim 임베딩을 어디서?
- **(A) transformers.js + onnxruntime-node** — 진짜 로컬 MiniLM-384. 단 무거운 npm 의존(+ONNX 바이너리). "외부 CDN 0" 위반은 아니나 의존성 대형화.
- **(B) 외부 임베딩 API** — local-first 위반(사용자 전체 이력 외부 전송). ✕.
- **(C) ⭐ pluggable embedder + plumbing-first** — vec 마이그레이션 + 하이브리드 retrieve 배선 + `embed()` 주입형(기본 null→FTS-only degrade). 실제 모델(A)은 플래그/후속 결정. **아키텍처는 준비, 무거운 의존은 강제 안 함.** PALANTIR_MEMORY_EMBED=1 + 주입 시에만 활성.

→ **권장 (C)**: P1b가 이미 top-K FTS로 작동하므로, P2는 "벡터를 *얹을 수 있는* 구조"를 안전히 추가하고 실제 모델 채택은 별도 결정. (mnemo: 검색 가치 상당부분이 lexical이었음 → 벡터 ROI 미확정, plumbing-first가 합리적)

### P0 사전 통합
- `db/database.js`: sqlite-vec `load_extension` 시도 → 실패 시 graceful(`vecAvailable=false`, FTS-only). better-sqlite3 `loadExtension`.

### 마이그레이션 `032_master_memory_vec.sql` (확장 가용 시에만 적용)
- `master_memory_vec` vec0(embedding float[384]) — rowid = master_memory_items.rowid_pk 매핑.

### masterMemoryService
- 주입형 `embedder`(default null). `createMemoryItem`: embedder 있으면 임베딩 계산+vec insert (트리거 아닌 서비스 경로 — vec0는 external-content 트리거 부적합).
- `retrieve`: hybrid — FTS 후보 + vec 최근접 → **RRF 융합**(per-query, mnemo 미검증이나 adaptive는 후속) → top-K. embedder/확장 없으면 **기존 FTS-only 경로 그대로**(회귀 0).

### 테스트
mock 결정론 embedder로 hybrid 융합·FTS-only degrade·vec insert/검색. 실제 모델 미요구.

### 파일 영향
`db/database.js`(load_extension), `db/migrations/032_*.sql`(신규), `services/masterMemoryService.js`(retrieve hybrid + embed-on-write), tests.

---

## 병렬화 (athena) 평가

- **충돌점**: 둘 다 `masterMemoryService.js` + `createMemoryItem`을 건드림 (P1c: cap-admission, P2: embed-on-write) + export 목록. 마이그레이션은 분리(031 vs 032)라 무충돌.
- **권장**: **계획·검토는 병렬**(지금). **구현은 athena 2 워크트리 병렬 가능하되 `masterMemoryService.js` 머지 충돌 1지점** — 작고 국소적(createMemoryItem 끝/ export)이라 athena 완료 후 Claude가 머지 resolve. 또는 P1c→P2 순차(무충돌, 단순). Codex가 병렬 vs 순차 권고.
- **불변**: 각 구현 슬라이스는 Codex 구현 → Claude 교차리뷰 → npm test green → Codex 적대리뷰 PASS → merge.

---

## LOCKED — Codex 2R 검토 반영 (2026-06-18)

**둘 다 GO-WITH-CHANGES. 순차 P1c→P2 확정 (병렬 ✕ — `createMemoryItem` 의미적 결합). P2 DEFER (P1c 후 + 실모델 결정 시 option C).**

### P1c 확정 결정
- **cross_project 승격 → USER scope 로 승격** (BLOCKER 해소: 기존 user 주입이 자동으로 실음, dual-scope 주입 회피). cross_project *scope* 의 명시적 주입은 후속.
- **cross-project 신호 = 주기 SQL 스캔이 authoritative** (eventBus 는 hint/debounce 만). 스캔: L1 `memory_items` active, **동일 content_hash 가 ≥2 distinct project**, **kind=fact·`env.*` 제외**, → master XPROJECT candidate. 승인 시 ≥2 재확인.
- **candidate raw_json**: 저장 전 + GET 응답 전 sanitize/whitelist (L1 `routes/memory.js` 미러). raw blob 노출 ✕.
- **promote = 사람 큐레이션**: L1 kind(convention|pitfall|heuristic)→master **`pattern`** 매핑, 원본 kind 는 evidence 보존. sanitize + cap-admission + 단일 tx. **승인된 candidate origin ≠ 'human'**(='deterministic').
- **cap/TTL**: cap **500/scope**, TTL **180d**(candidate-promoted/auto), **human=permanent(valid_to NULL)**. **human remember 는 cap 가득해도 거부 ✕**(항상 admit). auto/candidate 만 cap-reject 대상.
- **decay 전용 maintenance 스케줄러** (distiller 없음): app.js 에 boot tick + setInterval(unref) — `expireStaleMemories` 주기 호출, graceful/never-throw.
- **actor (fail-closed)**: bearer/none remember→candidate; **promote·PATCH·GET /candidates 는 cookie 전용**. `PALANTIR_TOKEN` 은 spoof-proof 아님(문서화), `PALANTIR_PM_TOKEN` 별도.
- **migration 031 방어 체크**(L1 026 미러): `json_type(raw_json)='object'`, dedup_key length bound, index(scope,status), rule enum(`R4`|`XPROJECT`). 스캔 metrics 이벤트.

### Slice 순서 (codex)
1. **candidate 테이블(031) + service createCandidate/listCandidates/promoteCandidate(단일 tx) + route actor split** ← 지금
2. cap-admission + TTL decay + correction CRUD(update/restore/pin) + maintenance 스케줄러
3. cross-project 주기 스캔 (eventBus hint)
4. cross-project(→user) 주입 정책 + 테스트
각 슬라이스: codex 구현 → Claude 교차리뷰 → npm test green → codex 적대리뷰 PASS → merge.

### P2 확정 (DEFER)
P1c 머지 후. option **C plumbing-first**: **sqlite-vec 는 optional initializer(정규 migration 경로 ✕ — 부팅 abort 위험)**, RRF+lexical guard, FTS-only degrade 테스트 증명, archive/delete 시 best-effort vec 삭제 + backfill/reconcile, 실모델(transformers.js)은 벤치 정당화 후.

---

## Codex 검토 질문
1. P1c: master에 LLM distiller 없이 **human-approve candidate**만으로 충분한가? cross-project 결정론 승격(≥2 프로젝트 동일 content)이 안전·유용한가, 아니면 과한가?
2. P1c: cap/decay 수치(cap 500/scope, TTL 180일, human 영구) 적절? L1과 일관?
3. P2: 임베딩 런타임 (A)/(B)/(C) 중? (C plumbing-first)가 mnemo의 "lexical이 주효" 발견과 정합하는 합리적 선택인가, 아니면 벡터 없는 P2는 무의미인가?
4. P2: RRF 융합 vs 가중합 — mnemo의 "recency 스코어링 무효" 단서 고려 시?
5. 병렬: athena 2-worktree 병렬(머지 1충돌) vs 순차 — 어느 쪽?
6. 슬라이스 분할/순서 + 빠뜨린 위험?
