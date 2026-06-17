# Master Memory Layer (L2) — 사용자 스코프 거버넌스 메모리 brief

> **⚠️ v1.1 (2026-06-17): 검증 스파이크 → DE-SCOPE.** 무거운 distillation/WikiGraph 층은 answer-influence(더 나은 답) 근거 미입증 → **mainline = governed top-K retrieval** (§12 우선). 아래 v1.0 본문은 원안 보존.
>
> **상태**: v1.0 **LOCK-IN** (2026-06-17) — deep-research(23소스·12 confirmed) + Codex 적대 리뷰 4R(R1 GO-WITH-CHANGES → R2/R3 FAIL→수정[R3 live SQLite] → **R4 PASS, lock-in ready**). **LOCK-IN 완료(2026-06-17, U3/U4 = 권장안 확정)** — §0 U3 는 "권장·확정 대기"(R2 가 원안에서 *추가 narrowing*, §0 주석). 다음: **P0 착수 여부 사용자 결정.**
> **작성**: 2026-06-17
> **연관 spec**: `memory-layer-brief.md`(L1 PM 메모리 — 패턴/거버넌스 재사용 원천), `manager-v3-multilayer.md`
> **목표 한 줄**: Master Manager 가 **사용자의 명시 제약·선호·약속·프로젝트 사실을 근거 기반으로 인출**하고 **근거가 약하면 물어보는**(ask/act 게이트) 거버넌스 메모리. 기존 L1 안전 기계(admission·decay·poisoning-gate·user-payload 주입)를 **재사용**, **claim-canonical + FTS-first**로 시작해 **kill test 로 자격을 딴 질의 유형에만** temporal graph 로 성장.
> **북극성(endgame, 점진 도달)**: 사용자의 모든 이력을 내재화한 *Temporal Personal WikiGraph* — "지금 전부 처리·신뢰"가 아니라 "P5 에서, 거버넌스가 익는 만큼".

---

## 0. 사용자 결정 (lock-in)

| # | 결정 | 선택 | 상태 |
|---|------|------|------|
| **U1** | 목표 | **delegation-grade** (완전 대체 ✕). capability 경계 + ask/act 게이트 §3 | 확정 권장 |
| **U2** | substrate | 로컬 단일 `master_memory.db` + **sqlite-vec(벡터) + FTS5 + 엣지 테이블**. 외부 graph DB/호스티드 메모리 ✕ | 확정 |
| **U3** | capture 범위 | **P0-P1: 넓은 이벤트는 metadata-only + 고신호 content 만 allowlist·cap·TTL 저장. 광범위 *원문* content 수집은 P5**(거버넌스·삭제·poisoning 입증 후). 고신호만 임베딩/distill/graph/주입 | ✅ **확정(2026-06-17)** — R2 가 "넓은 원문 로그 = 무한성장 + 로컬 exfil 표적"이라 원안에서 *추가 narrowing*. 북극성("언젠가 전부")은 P5 로 유지 |
| **U4** | 아키텍처 | **기존 L1 코드 재사용**(sanitize/admission/decay/poisoning-gate/주입을 **db-handle 파라미터화 공유 코어 또는 `MasterMemoryService` 어댑터로 추출**) **+ 별도 db** + `scope` 차원(project\|user\|cross_project) | ✅ 확정(2026-06-17) (refactor 명시, §8 P0) |
| **U5** | canonical 표면 | **claim-canonical** — source-linked claim 이 단일 진실. **wiki·edge 는 claim 의 파생/투영**(독립 진실 ✕). wiki = on-demand 렌더(무손실·claim-id 인용) | 확정 (R1 B2, R2 강화) |
| **U6** | graph | **kill test + 벤치 통과 후에만**(deferred behind gate). FTS/wiki 가 *증명상* 못 푸는 질의(시간 반전·cross-project 의존·관계)에만 | 확정 → **§12 스파이크가 answer-influence 근거 KILL → 데이터-관리 근거 입증 전까지 추가 defer** |
| **U7** | 거버넌스 | **source-linked 삭제 + 재컴퓨트 + tombstone + audit/retrieval 로그**. crypto-shred/DEK/해시체인 영수증은 **P5** | 확정 (R1 과설계 cut) |
| **U8** | 외부 LLM | **default-off + candidate-only + redact-before**. 결정론 capture + 사람 확인이 primary | 확정 (κ=0.40) |

> **U3 reconcile 근거 (R2 갱신 → 2026-06-17 사용자 확정)**: 사용자는 "모든 정보 + 완전 대체"를 원함. R1 은 "처리는 고신호만"으로 좁혔고, **R2 는 한 단계 더** — *넓은 원문 로그 자체*가 무한성장 + 로컬 exfil 표적(단일 사용자 DB 가 전체 미수정 이력 보유). 해소: **P0-P1 은 넓은 이벤트의 metadata 만 + content 는 allowlist·cap·TTL 된 고신호만**; 광범위 원문 수집 = **P5**(삭제·audit·poisoning 방어 입증 후). 북극성은 폐기 아니라 **P5 로 시퀀싱**. **사용자 확정(2026-06-17): 이 narrowing 수용, 북극성=P5.**

---

## 1. 비전 & L1/L2 관계

L1(PM 메모리)은 **단일 프로젝트 flat tacit knowledge**(규칙 candidate→batch LLM→active, FTS5). L2(Master)는 **cross-project user-centric** — 사용자 자신의 제약·선호·약속·결정·관계가 대상. 구조가 다르다(flat vs 관계/시간).

기존 `memory-layer-brief.md` §9 의 "L2 = 여러 PM→Master 승격"은 **이 Master 의 여러 입력 소스 중 하나**로 흡수(Master ⊋ L2-승격). PM 승격은 capture 소스의 한 갈래일 뿐, Master 의 정의가 아니다.

---

## 2. 계층 모델 & substrate

```
L2 MASTER (user / cross_project) ★본 spec
  L2.d  WIKI RENDER (on-demand)     claim 을 page/slot 으로 그룹핑·렌더. 무손실 + 줄마다 claim-id 인용. 독립 진실 ✕ (검색 truth surface 재기입 ✕)
  L2.c  CLAIM (canonical)           source-linked claim(scoped bi-temporal) ◀ 단일 진실
        ENTITY·EDGE                 claim 의 *투영*(claim_id NOT NULL, status/conf 미러). DDL 은 P2/P3 (벤치+gate 후, mm_001 미포함)
  L2.b  CHUNK + INDEX               redacted chunk + FTS5(트리거 3종) + sqlite-vec  ◀ 검색 1차
  L2.a  EVENT LOG (append-only)     metadata-first(U3). 고신호 content 만 allowlist·cap·TTL → 승격
L1 PROJECT (PM)  ── 기존, 재사용 패턴 원천 ──
L0 EPISODIC (Worker) ── 기존 run_events/harvest/dispatch_audit (read-only) ──
```

**substrate = 별도 `master_memory.db`** (better-sqlite3, WAL). sqlite-vec = **선택적 확장 → 런타임 `load_extension` 필요**(P0 사전 단계). 임베딩 기본값 **로컬 `all-MiniLM-L6-v2`(384-dim)**(A-MEM 검증), P0 벤치 후 확정. graph 순회 = **recursive CTE** — **스키마 lock-in 전 synthetic 벤치 + pass 임계 사전설정 + size cap**(§8 P0, R1 B4 / R2).

---

## 3. Capability 경계 + ask/act 게이트 (delegation-grade — R1 B1)

**할 수 있다**: 사람 명시 진술 기억(`remember`) / 검증된 제약·선호·약속·사실 인출 / 모순·staleness 탐지 / **근거 약하면 행동 대신 물어본다**.
**하지 않는다 (확인 없이)**: 글로벌 성격 추론 / 사생활 추론 / 의도 추정. → **추론된 것은 candidate(inactive), 사람 확인 전 active ✕.**

**ask/act 게이트 (구체 규칙 — 주입/행동 시점 claim 별, R2 B1):**

| 조건 | 동작 |
|------|------|
| `status=active` ∧ `source_kind=human` ∧ not-stale(`valid_to` 미경과) | **act** |
| `status=active` ∧ `source_kind=deterministic` ∧ `confidence≥0.7` ∧ not-stale | **act** |
| `status=candidate` ∨ `confidence<0.7` ∨ stale ∨ scope/context 불일치 | **ask** (확인 요청 또는 미주입) |
| `kind∈{constraint,commitment}` 인데 모순 claim 존재 | **ask** (충돌 노출, 자동 선택 ✕) |

**행 우선순위(R3)**: 위→아래 **첫 매칭**. `source_kind=human` active 는 confidence<0.7 규칙 **면제**(명시 진술은 default confidence 라도 act) → active+human 행과 confidence<0.7 행의 중복 해소.

게이트 결정은 `mm_retrieval_log` 에 기록 → kill test correction-rate 측정 기반.

**ontology (좁게 시작)**: P1~P2 = constraints·commitments·decisions·projects·corrections + repo/tool/env 사실(TTL). 확장(P3+, 증명 시) = people/orgs·domain concepts·narrow comms 선호·관계 엣지. **영구 제외**: 성격 프로파일링·건강/생체·제3자 dossier·관계 추측·상시 캡처·raw secret·글로벌 스타일 페르소나(DITTO 44/48%≈chance). Functions 축(3-0): factual/experiential/working.

---

## 4. 데이터 모델 (migration `mm_001`, 외부 의존 0)

> claim-canonical(U5). wiki 테이블 없음 — `mm_claims.page/slot_key` 그룹핑 렌더. **edge/entity/vec DDL 은 P2/P3**(벤치+gate 후), `mm_001` 미포함(R2 B4).

```sql
-- L2.a 이벤트 로그 (U3 metadata-first): 넓은 이벤트는 content NULL, allowlist 고신호만 content
CREATE TABLE mm_events (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,             -- conversation|master_decision|run|task|correction|remember|brief|commit|test|...
  event_type    TEXT NOT NULL,
  actor         TEXT,                       -- human|master|pm|worker
  project_id    TEXT,                       -- cross_project 식별 (NULL = user-global)
  occurred_at   TEXT NOT NULL,
  content_redacted TEXT,                    -- R2 B3: 넓은 이벤트=NULL(metadata-only). allowlist 고신호만 redacted content(cap+TTL). 광범위 원문=P5
  sensitivity   TEXT NOT NULL DEFAULT 'normal',  -- normal|sensitive|secret_masked
  ttl_at        TEXT,                       -- content 보존 만료 (고신호 content 에 부여)
  metadata_hash TEXT NOT NULL,              -- R3: source+type+actor+project+occurred_at 해시 (항상)
  content_hash  TEXT,                        -- R3: 저장된 redacted content 해시만 (metadata-only=NULL; 폐기 원문 해시 ✕)
  ingested_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mm_events_proj_time ON mm_events(project_id, occurred_at);
-- R3 보존 정책(lock 제안): content allowlist={remember,correction,decision,constraint,commitment}; content byte cap=8KB/event(초과 truncate+flag);
--   content TTL=미승격 30d; metadata TTL=365d + 월 compaction(count cap 1e6/scope); 일배치 purge job(L1 expireStale 재사용).

-- L2.b 검색 인덱스 (redacted chunk) + FTS 트리거 (R2 B6: 없으면 P1a FTS-only silently empty)
CREATE TABLE mm_chunks (
  rowid_pk    INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  owner_type  TEXT NOT NULL,                -- event|claim (polymorphic → FK 불가; forget 은 서비스 recompute+tombstone)
  owner_id    TEXT NOT NULL,
  text        TEXT NOT NULL,                -- 로컬 검색용 lexically 보존. outbound/주입 시점에만 추가 redact (mnemo (f))
  project_id  TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE mm_chunks_fts USING fts5(text, content='mm_chunks', content_rowid='rowid_pk', tokenize='unicode61');
CREATE TRIGGER mm_chunks_ai AFTER INSERT ON mm_chunks BEGIN
  INSERT INTO mm_chunks_fts(rowid, text) VALUES (new.rowid_pk, new.text); END;
CREATE TRIGGER mm_chunks_ad AFTER DELETE ON mm_chunks BEGIN
  INSERT INTO mm_chunks_fts(mm_chunks_fts, rowid, text) VALUES('delete', old.rowid_pk, old.text); END;
CREATE TRIGGER mm_chunks_au AFTER UPDATE ON mm_chunks BEGIN
  INSERT INTO mm_chunks_fts(mm_chunks_fts, rowid, text) VALUES('delete', old.rowid_pk, old.text);
  INSERT INTO mm_chunks_fts(rowid, text) VALUES (new.rowid_pk, new.text); END;
-- 초기 1회: INSERT INTO mm_chunks_fts(mm_chunks_fts) VALUES('rebuild');
-- sqlite-vec (P0 load_extension + 벤치 PASS 후 DDL, R2 B4): CREATE VIRTUAL TABLE mm_chunk_vec USING vec0(embedding float[384]);

-- L2.c CANONICAL claim (scoped bi-temporal — R1 S4)
CREATE TABLE mm_claims (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,              -- entity ref 또는 'user'
  predicate     TEXT NOT NULL,
  object_json   TEXT NOT NULL,
  scope_project_id TEXT,                    -- NULL = user-global ; 값 = 프로젝트 한정
  context       TEXT,                       -- 맥락 한정 (모순≠맥락차이, S4)
  kind          TEXT NOT NULL,              -- constraint|preference|commitment|decision|fact|pattern
  page          TEXT, slot_key TEXT,        -- wiki 렌더 그룹핑 (UserConstraints|ActiveGoals|Decisions|Projects|...)
  source_kind   TEXT NOT NULL,              -- human|deterministic|llm_candidate
  status        TEXT NOT NULL DEFAULT 'active',  -- active|candidate|superseded|archived
  confidence    REAL NOT NULL DEFAULT 0.5,
  importance    INTEGER NOT NULL DEFAULT 5,
  explicitness  INTEGER NOT NULL DEFAULT 5,
  pinned        INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT, valid_to TEXT,           -- 사실 유효구간
  tx_from TEXT NOT NULL DEFAULT (datetime('now')), tx_to TEXT,  -- 관측 트랜잭션 시각 (bi-temporal)
  supersedes_id TEXT,                        -- 직접 근거 + 동일 subject+scope+context 일 때만 (S4)
  content_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT,
  CHECK (kind IN ('constraint','preference','commitment','decision','fact','pattern')),
  CHECK (status IN ('active','candidate','superseded','archived')),
  CHECK (source_kind IN ('human','deterministic','llm_candidate')),
  CHECK (confidence BETWEEN 0 AND 1), CHECK (importance BETWEEN 1 AND 10)
);
-- R2 blocker1: SQLite 는 UNIQUE 에서 NULL 을 distinct 취급 → user-global(scope NULL) dedup 위해 분리
CREATE UNIQUE INDEX idx_mm_claims_hash_global ON mm_claims(content_hash)
  WHERE scope_project_id IS NULL AND status IN ('active','candidate');
CREATE UNIQUE INDEX idx_mm_claims_hash_scoped ON mm_claims(scope_project_id, content_hash)
  WHERE scope_project_id IS NOT NULL AND status IN ('active','candidate');
CREATE INDEX idx_mm_claims_page ON mm_claims(page, slot_key, status);
CREATE INDEX idx_mm_claims_scope ON mm_claims(scope_project_id, status, importance DESC);

-- R2 blocker5: 근거 링크 관계형 (JSON ✕ — forget cascade/recompute 가능)
CREATE TABLE mm_claim_evidence (
  claim_id TEXT NOT NULL REFERENCES mm_claims(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES mm_events(id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, event_id)
);

-- L2.c entities/edges — DDL 은 P2/P3 (벤치 PASS + U6 gate 후, mm_001 미포함). edge = claim 투영 (R2 B2)
-- CREATE TABLE mm_entities (id TEXT PK, type, label, aliases_json, pii_class, sensitivity, confidence, first_seen, last_seen);
-- CREATE TABLE mm_edges (id TEXT PK, subject_entity, predicate, object_entity,
--   claim_id TEXT NOT NULL REFERENCES mm_claims(id) ON DELETE CASCADE,  -- 투영: status/confidence/valid_* 는 source claim 미러(독립 설정 ✕)
--   confidence, valid_from, valid_to, tx_from, tx_to, status);

-- 거버넌스 (U7)
CREATE TABLE mm_tombstones (             -- 삭제 증명 + 부활 차단 (promote 시 tombstone 검사)
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_ref TEXT NOT NULL,
  reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE mm_retrieval_log (          -- 인출/게이트 감사 + kill test 데이터
  id TEXT PRIMARY KEY, request_id TEXT, query_hash TEXT,
  returned_claim_ids_json TEXT, gate_decisions_json TEXT, scores_json TEXT, injected_at TEXT
);
CREATE TABLE mm_injection_ledger (       -- 캐싱 안전 1회/revision 주입 (pm_memory_injection 패턴)
  master_run_id TEXT PRIMARY KEY, injected_revision INTEGER NOT NULL DEFAULT 0, injected_at TEXT
);
CREATE TABLE mm_revision (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
```

**재사용(U4, refactor 명시)**: `memorySanitize`·cap admission(score eviction·human/pinned 보호)·decay(`valid_to`·expire·markReviewed)·poisoning gate·candidate→promote 단일 안전강제 tx 를 **db-handle 파라미터화 공유 코어 또는 `MasterMemoryService` 어댑터로 추출** (현 `memoryService` 는 L1 테이블·project 시맨틱 하드코딩 → P0 리팩터, R2 blocker4).

**forget cascade(R2 blocker5)**: event 삭제 → `mm_claim_evidence` ON DELETE CASCADE → 근거 0 된 claim 은 서비스가 recompute/archive + chunk(owner_id 매칭) purge + `mm_tombstones` 기록 + 이후 promote 가 tombstone 검사. **불변(R3)**: 모든 claim 생성(human `remember` 포함)은 backing `mm_events` 행을 먼저 생성/링크 → `mm_claim_evidence(event_id)` FK 항상 충족.

---

## 5. 후가공 파이프라인 (capture-metadata-broad, process-high-signal)

| 단계 | 주기 | 내용 | LLM |
|------|------|------|-----|
| metadata capture | 동기 | 넓은 이벤트 metadata (content 는 allowlist 고신호만, cap+TTL) | 0 |
| redact/classify/chunk/FTS | 동기 | 고신호 content → secret redact + sensitivity + chunk + FTS | 0 |
| 결정론 capture | 근실시간 | corrections/constraints/commitments/decisions + repo/tool/env(TTL) + alias exact | 0 |
| 명시 remember | 즉시 | human → **active**(cookie 인증), bearer/PM → candidate | 0 |
| LLM 추출/graphify | **배치 default-off** | claim 추출·graph 병합 → **candidate only**, source-linked 리뷰 | gated |
| 모순/stale 리뷰 | 주간/수동 | scoped supersede(직접 근거+동일 context 만) + decay | gated |

- **모순 ≠ 덮어쓰기**: 새 claim + 옛것 `valid_to` 무효화. **맥락차이(context)는 supersede 아님**(S4).
- **monolithic 재요약 금지**(ACE context-collapse 3-0) — slot-level append-only delta 만.
- **graph 병합 LLM 최소화**(ATOM binary-merge 3-0).
- **Mem0 ADD/UPDATE/DELETE/NOOP**(3-0) 패턴을 candidate op 결정에 차용 — 출력은 candidate, active 강제는 promote tx.

---

## 6. 인출 & 주입 (캐싱 안전)

**인출(hybrid, 보수적)**: FTS5 BM25 + sqlite-vec 최근접 + alias exact + (P3+) 1-2홉 graph + **pinned**(프라이버시 규칙·하드 제약·활성 약속 항상). RRF 융합(적응형 per-query IDF = 미검증 단서 → 실험 플래그). **recency/importance 가중은 기본 랭킹 ✕, 실험으로**(미검증 반증: RRF 뒤 recency/decay 무효). 코딩 작업은 lexical 가중↑(mnemo +21pp).

**주입(3중, 동적 system prompt ✕)**: ① system prompt 고정 안내 1줄 ② **user-payload prepend(주)** `## User Memory Context`(하드 제약 / 활성 약속 / 관련 결정 / 검증 사례 1-2 / 모순·stale / **가정 전 물어볼 경계**), `mm_injection_ledger` 세션당 1회/revision, **1.5~3k 토큰**, 주입 claim_id 전부 로깅 ③ GET API.

**wiki 렌더(L2.d, R2 B2)**: claim 을 page/slot 으로 그룹핑만 — **무손실 + 각 줄 claim-id 인용 + 검색 truth surface 로 재기입 ✕**. 캐시면 순수 파생(`mm_revision` 변경 시 무효화).

**프라이버시 vs 효용(S5)**: 로컬 검색 텍스트는 lexically 보존, **outbound·주입 시점에만** sensitive redact (전체 익명화 −44~53pp, mnemo f).

---

## 7. Kill test (반증 — 핵심 artifact, P1b 후 실행)

> mnemo 가 못 가른 "관련 *내용* vs *자신만만한 앵커*"를 **claim-컴포넌트 마스크로 분리**. **R2 B5: 마스크를 코드 식별자가 아닌 claim 컴포넌트로 재설계. 임계값 사전등록.** **predicate 는 정규화 vocabulary 로 제약 + object 텍스트가 subject/predicate 에 중복 인코딩 안 됨을 assert(A5 누수 방지, R3).** LLM judge 회피·결정론 우선·검정력 선계산(mnemo 방법론).

**Arms**:
| arm | 설명 |
|-----|------|
| A0 | 무메모리 |
| A1 | last-N relevant (recency only) |
| A2 | 마지막 수락 correction 만 |
| A3 | explicit-pinned 제약만 |
| A4 | raw FTS top-1 |
| A5 | **subject/predicate 만**(object 가림) — 관련성 앵커-only |
| A6 | **object 값만**(subject/predicate 가림) — 내용-only |
| A5b | page/slot 만 / evidence 만 (ablation) |
| A5c | **false same-slot placebo**: 같은 slot 의 무관/틀린 claim |
| A7 | **claim/slot 구조화 메모리**(본 설계) |
| A8 | A7 + graph (P3+, U6 gate) |

**지표**: user-visible task 품질 + **correction rate**(재정정 필요?). **임계값 사전등록**(예: A7−best(A1,A5,A6) ≥ δ, 검정력 0.8 n 선계산).

**KILL CONDITION**: **A7 이 best(A1, A4, A5, A5c, A6) 를 품질·correction rate 둘 다에서 사전등록 δ 만큼 못 이기면 → governed retrieval(A4)에서 멈춤.** (R3: raw FTS A4 + placebo A5c 포함 — 단순 FTS·placebo 도 못 이기면 무의미.)
**GRAPH GATE(U6)**: A8 이 cross-project/시간-반전/관계 질의 부분집합에서 A7·masked-anchor 를 둘 다 이길 때만 persistent graph API. (A-MEM ablation 3-0: 제대로면 graph 가 load-bearing → gate 는 graph 죽이기가 아니라 *필요 질의 유형 식별*.)
**불변 테스트**: poison(틀림/stale 주입→오염률) / staleness(선호 반전→현재 이김) / forget(source 삭제→어디에도 생존 0) / privacy(가짜 secret seed→외부 0·주입 0).

---

## 8. 개발 계획 (PR breakdown — de-risk 우선)

각 PR: branch→구현→npm test→**Codex 교차검증(PASS까지)**→commit→PR→merge.

- **P0** — 별도 `master_memory.db` 부트 + 마이그레이션 러너 + **sqlite-vec `load_extension`**(없으면 FTS-only degrade) + `mm_events`/`mm_chunks`(+FTS 트리거)/`mm_claims`/`mm_claim_evidence`/거버넌스 테이블. **U4 리팩터(R2 blocker4)**: L1 의 sanitize/admission/decay/injection 을 **db-handle 파라미터화 공유 코어 또는 `MasterMemoryService` 어댑터**로 추출(현 `memoryService` 는 L1 하드코딩). **벤치(R2 B4, R3 수치 lock)**: recursive-CTE(합성 10⁴·10⁵·10⁶ 엣지) + sqlite-vec ANN — **pass 임계(lock)**: 인출 p95 ≤ 80ms, 2홉 CTE ≤ 50ms @10⁶ 엣지, 임베딩 처리량 ≥ 200/s. 미달 시 graph DDL 미착수. **size cap(lock)**: active claim ≤ 50k/scope, edge ≤ 500k, chunk ≤ 200k; 초과 시 score-eviction(L1 cap admission 재사용). 임베딩 모델/차원 확정.
- **P1a** (최소 가치 — 핵심 thesis 증명/기각) — 명시 `remember`/`delete`/retrieve/inject/log, **FTS5-only**, caching-safe 주입, `mm_retrieval_log`. **삭제·tombstone 경로 포함**(event/chunk 대상; claim 도착 시 cascade 규칙 §4 이미 정의 → retrofit 최소).
- **P1b** — 결정론 capture(corrections/constraints/commitments/decisions + repo/tool/env TTL).
- **★ KILL TEST**(§7) — A0~A7 + 불변. **GO/STOP 판정.**
- **P1c** — claim page/slot 태그 + **wiki on-demand 렌더**(무손실·인용) — *명시 메모리가 베이스라인 이길 때만*.
- **P2** — scoped bi-temporal 정밀화(supersede=직접근거+동일 context) + sqlite-vec 시맨틱 합류.
- **P3** — default-off LLM 추출/graphify → **candidate-only** + source-linked 리뷰(κ=0.40) + entities/edges DDL. **GRAPH GATE 통과 시** graph 순회/PPR-lite.
- **P5** — 광범위 *원문* 개인 컨텍스트 수집 + crypto-shred/DEK/해시체인 영수증 — **삭제·audit·poisoning 입증 후 + 규모/다중소스 강제 시.**

---

## 9. Codex 적대 리뷰 대응 추적

**R1 (GO-WITH-CHANGES)** → v0.1 반영: B1 capability·B2 claim-canonical·B3 reconcile·B4 별도db/gate·B5 masked-anchor / SERIOUS 1-5 / 과설계 cut.

**R2 (FAIL → v0.2 수정)** — Codex 가 §9 v0.1 자기보고가 B1/B2/B3/B4/B5/S2 를 과대 종결했다 지적(대부분 PARTIAL/OPEN) + 6 new blocker. v0.2 반영:

| R2 지적 | v0.2 해소 (§) |
|---------|--------------|
| blocker1 NULL-scope dedup 깨짐 | 분리 partial-unique 인덱스 2개 (§4) |
| blocker2 (=B3) 넓은 원문 로그 unsafe | metadata-first + content allowlist·cap·TTL, 원문=P5 (U3·§4·§5) ⚠️사용자확인 |
| blocker3 (=B5) kill test 마스크 부적합 | claim-컴포넌트 마스크 + placebo + 임계 사전등록 (§7) |
| blocker4 (=S2) U4 리팩터 은폐 | 공유코어/어댑터 추출 명시 (U4·§8 P0) |
| blocker5 forget/tombstone 비미래지향 | `mm_claim_evidence` 관계형+cascade, recompute 규칙 (§4) |
| blocker6 FTS 트리거 누락 | 트리거 3종 + rebuild (§4) |
| B1 PARTIAL (게이트 미규칙) | ask/act 게이트 매트릭스 (§3) |
| B2 PARTIAL (edge 독립 truth) | edge=claim 투영(cascade·미러) + 렌더 무손실·인용 (§2·§4·§6) |
| B4 PARTIAL (벤치 임계 부재) | pass 임계·size cap·DDL 지연 (§8 P0·§4) |

**R3 (FAIL — live SQLite 검증) → v0.3 수정**: CLOSED = blocker1(NULL dedup, 실측)·4(U4)·5(forget cascade)·6(FTS 트리거, 실측)·B2. v0.3 추가: metadata 보존 정책 수치 lock + `content_hash`/`metadata_hash` 분리(blocker2/B3) + ask/act 행 우선순위·human confidence 면제(B1 conflict) + kill 비교군 A4·A5c 추가·predicate 정규화(B5) + 벤치 수치/size cap lock(B4) + claim→backing event 불변. **R4 = PASS (lock-in ready)** — 6 정밀성 수정 전부 CLOSED, 새 blocker 0, 잔여 = implementation discipline(spec→code 전환의 당연, spec 결함 ✕). **U3/U4 사용자 확정(2026-06-17, 둘 다 권장안) → v1.0 LOCK-IN.**

미굽힌 2건: U3(북극성 P5 보존) / graph(A-MEM ablation 으로 gate 정당).

---

## 10. 성공 기준 & 리스크

**성공**: (정량) 제약 위반↓·재정정률↓·게이트 적중. (정성) Master 가 주입 메모리 인용. (안전) forget 잔존 0·secret leak 0·캐싱 hit 유지. **(게이트) A7 > masked-anchor 입증 — 못 하면 STOP.**

**단일 최대 리스크(Codex R2)**: *"거버넌스·삭제·kill test 가 충분히 강해지기 전에 넓은 민감 capture + 파생 스키마를 lock-in 해 — 유용한 메모리가 아니라 더 큰 공격면이 되는 것."* → U3(metadata-first) + U5(단일 진실) + U7(forget cascade) + §7(kill test)가 직접 방어.

---

## 11. 출처 (deep-research, 검증 등급)

**검증(3-0)**: Mem0 ADD/UPDATE/DELETE/NOOP·graph 2x 토큰(2504.19413) / Zep-Graphiti temporal KG 정의(2501.13956, **벤치 수치 killed**) / agent-memory 3축 taxonomy(2512.13564) / A-MEM note·로컬 retrieval·**ablation**(2502.12110) / ACE context-collapse·playbook(2510.04618) / ATOM no-LLM 병합(2510.22590).
**미검증(rate-limit abstain, 유망 단서)**: TG-RAG bi-level temporal graph·증분 요약·PPR(2510.13590) / sqlite-vec+FTS5 substrate·적응형 RRF·recency-스코어링 무효(2604.15484) / MemoryGraft 9%→47.9%(2512.16962, mnemo 확증).
**killed(불신)**: Zep DMR/LongMemEval 벤더 수치(2501.13956) / "graphify 무용"(2504.19413).
**내부**: mnemo `08-findings`·`09-retention`·`11-conclusion`·`notes/2026-06-15`.

---

## 12. 검증 스파이크 결과 (2026-06-17) — DE-SCOPE 결정 ★우선

`experiments/mm-spike/` 에서 P0/P1 최소 구현 + kill test 2회 실행 (API $0, codex CLI ~2.5h). 각 단계 Codex 교차검증(7라운드).

**구현물**: FTS-only store(4R-PASS 스키마, NULL-dedup 실측) + 12 easy + 10 hard 시나리오(pre-registered) + 결정론 leakage audit(LLM 0 선검증) + JSON-artifact scorer + arm builder(A0/A4/A4k/A4cur/A5/A5c/A7p/A7) + CLI runner. throwaway.

**결과**:
- ✅ **핵심 전제 강하게 지지**: 올바른 사실 주입이 행동을 바꾼다 — `A7p(틀린 내용)=0%` vs `A7(옳은 내용)=100%` (양 pilot). **앵커 효과 아님** (mnemo 가 못 가른 "앵커 vs 내용" 을 A7p wrong-content placebo 로 분리 달성).
- 🛑 **distillation/WikiGraph 의 answer-influence 가치 procedural KILL**:
  - easy-SEP: `A4(raw top-1) 83%` vs `A7 100%` (+17pp, 1 scn 노이즈)
  - hard-SEP(temporal conflict, TRAP-only, **A4k=raw top-3 steelman**): `A7 100%` vs `best-raw 87%` = **+13pp, net +2, 1 family** → 사전등록 규칙(≥20pp or net+3, family>1) **미달**
  - 메커니즘: `A4cur(현재 정보만 raw)=A4k=87%≈A7` → **가치는 "현재 정보가 컨텍스트에 있음"이지 정제/supersede 구조가 아님** (salience guard 발동)
- ⚠️ **보존 요구사항**: raw **top-1(53%)** 은 부적합(충돌 시 낡은 값 인출) → **"top-K 인출 또는 distill"**, 그리고 **top-K 가 더 싼 기본값**.

**결정 (Codex 7R 교차검증, lock)**:
- **Mainline = governed top-K retrieval** 메모리 (올바른 사실 top-K 인출·주입; 모델이 해소). 가치 ~87–100% 포착.
- **Defer (별도 bar)**: claim-distillation / temporal-supersede / entities·edges / WikiGraph. **answer-influence 근거 KILL**. 단 **데이터-관리 근거(컨텍스트 예산 초과 규모·dedup·privacy/provenance·대용량 충돌관리)는 미검증·열림** — 따로 입증되면 재도전. (procedural KILL = answer-influence 한정, A7 zero-value 증명 ✕, N=15)

**phasing 영향**: §8 P1(governed retrieval, **top-K 강제**)은 유효·우선. P2(bi-temporal claim)·P3(graph)은 데이터-관리 근거 입증 전까지 **보류**.

**scale/dedup 정당화 추가 검증 (Codex gatekeep, 2026-06-17)**: 큰-history regime도 테스트 시도 → **공정한 PASS 테스트 불가(스파이크 범위 밖)**. 이유: (a) 12~16 이벤트는 context 에 다 들어가 'scale' 아님 — `A4all`(전체 주입)이 현재 사실 항상 포함 → dedup 무의미; (b) 공정한 PASS 엔 **A7R**(claim 스토어서 retrieved, hand-fed ✕) + **cheap current-aware raw baseline**(raw+recency/authority rerank) + budget-초과 history + 20+/family·3+ family + bootstrap CI 필요 = codex-CLI 스파이크로 불가; (c) naive FTS top-5 만 이기면 "FTS 가 churn 에 약함"이지 "heavy 층이 값함"이 아님. **dedup/scale 정당화 = cheaply·fairly 미검증, 별도 대규모 실험 필요**(production 대용량 코퍼스 + 위 기준). **결론 불변: de-scope.** kill test 는 cheaply-testable 한 두 정당화(answer-influence KILL / 소규모-dedup moot)에서 모두 heavy 층을 정당화 못 함 → governed top-K retrieval 확정.
