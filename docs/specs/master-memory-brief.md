# Master Memory Layer (L2) — 사용자 스코프 거버넌스 메모리 brief

> **상태**: v0.1 **DRAFT** — deep-research(23소스·12 confirmed 인용) + Codex 적대 리뷰 R1(**GO-WITH-CHANGES**) 반영해 정식화. **아직 lock-in 전** — §0의 U3/U4는 "권장·확정 대기"(사용자 원안과 차이 있음, §0 주석). 다음: 사용자 U3/U4 확정 → (선택) Codex R2 → P0 착수.
> **작성**: 2026-06-17
> **연관 spec**: `memory-layer-brief.md`(L1 PM 메모리 — 패턴/거버넌스 재사용 원천), `manager-v3-multilayer.md`
> **목표 한 줄**: Master Manager가 **사용자의 명시 제약·선호·약속·프로젝트 사실을 근거 기반으로 인출**하고 **근거가 약하면 물어보는**(ask/act 게이트) 거버넌스 메모리. 기존 L1 메모리 레이어의 검증된 안전 기계(admission·decay·poisoning-gate·user-payload 주입)를 **재사용**하고, **claim-canonical + FTS-first**로 시작해 **kill test로 자격을 딴 질의 유형에만** temporal graph 로 성장한다.
> **북극성(endgame, 점진 도달)**: 사용자의 모든 이력을 내재화한 *Temporal Personal WikiGraph* — 단 "지금 전부 처리·신뢰"가 아니라 "언젠가 전부, 거버넌스가 익는 만큼".

---

## 0. 사용자 결정 (lock-in)

| # | 결정 | 선택 | 상태 |
|---|------|------|------|
| **U1** | 목표 | **delegation-grade** (완전 대체 ✕). capability 경계 §3 명시 | 확정 권장 |
| **U2** | substrate | 로컬 단일 `master_memory.db` + **sqlite-vec(벡터) + FTS5 + 엣지 테이블**. 외부 graph DB/호스티드 메모리 서비스 ✕ | 확정 |
| **U3** | capture 범위 | **넓은 append-only 이벤트 로그(싸고 가역) + 고신호 샘플링 처리(임베딩/distill/graph/주입) + 점진 확장** | ⚠️ **권장·확정 대기** — 사용자 원안("처음부터 최대 수집")과 차이. 북극성은 동일, 시퀀싱만 안전화 |
| **U4** | 아키텍처 | **기존 L1 메모리 레이어 패턴·코드 재사용**(sanitize/admission/decay/poisoning-gate/주입) **+ 별도 db**(palantir.db WAL 경합 회피) + `scope` 차원(project\|user\|cross_project) | ⚠️ **권장·확정 대기** — Codex 강력 추천(중복 재발명 회피) |
| **U5** | canonical 표면 | **claim-canonical** — source-linked claim/slot 이 단일 진실. **wiki 는 on-demand 렌더**(독립 distill/persist ✕; 캐시면 순수 파생) | 확정 (Codex B2) |
| **U6** | graph | **kill test 통과 후에만**(deferred behind gate). FTS/wiki 가 *증명상* 못 푸는 질의(시간 반전·cross-project 의존·관계)에만 | 확정 (Codex B5 + A-MEM ablation) |
| **U7** | 거버넌스 | **source-linked 삭제 + 재컴퓨트 + tombstone + audit/retrieval 로그**. crypto-shred/DEK/해시체인 영수증은 **P5**(다중소스/외부수집 규모 도달 시) | 확정 (Codex 과설계 cut) |
| **U8** | 외부 LLM | **default-off + candidate-only + redact-before**. 결정론 capture + 사람 확인이 primary 경로 | 확정 (κ=0.40) |

> **U3 reconcile 근거**: 사용자는 "이 서비스 쓰며 생기는 모든 정보 + 완전 대체 수준"을 원함. Codex/증거는 "무엇이 검색을 개선하는지 알기 전 전량 수집 = 공격면·churn 최대화"라 경고(mnemo 1개-포화·앵커, MemoryGraft 9%→47.9%). 해소: **raw 이벤트 로그는 넓게 다 담되**(미래 확장 substrate, 당신 비전), **임베딩·distill·graphify·신뢰·주입되는 것만 고신호 샘플링**으로 시작 → 거버넌스 성숙도에 비례해 확장. "언젠가 전부"는 살아 있음.

---

## 1. 비전 & L1/L2 관계

L1(PM 메모리)은 **단일 프로젝트 flat tacit knowledge**(규칙 candidate→batch LLM→active, FTS5). L2(Master)는 **cross-project user-centric** — 사용자 자신의 제약·선호·약속·결정·관계가 대상. 구조가 다르다(flat vs 관계/시간).

기존 `memory-layer-brief.md` §9 가 스케치한 "L2 = 여러 PM→Master 승격"은 **이 Master 의 여러 입력 소스 중 하나**로 흡수된다 (Master ⊋ L2-승격). 즉 PM 메모리 승격은 capture 소스의 한 갈래일 뿐, Master 의 정의가 아니다.

---

## 2. 계층 모델 & substrate

```
L2 MASTER (user / cross_project) ★본 spec
  L2.d  WIKI RENDER (on-demand)     claim 을 page/slot 으로 그룹핑해 렌더. 독립 진실 ✕ (순수 파생/캐시)
  L2.c  CLAIM·ENTITY·EDGE (canonical) source-linked claim(scoped bi-temporal) ◀ 단일 진실
        └ EDGE/graph 는 U6 gate 통과 후 (P3+)
  L2.b  CHUNK + INDEX               redacted chunk + FTS5 + sqlite-vec  ◀ 검색 1차
  L2.a  EVENT LOG (append-only)     넓은 capture(U3). 고신호만 ↑ 승격
L1 PROJECT (PM)  ── 기존, 재사용 패턴 원천 ──
L0 EPISODIC (Worker) ── 기존 run_events/harvest/dispatch_audit (read-only) ──
```

**substrate = 별도 `master_memory.db`** (better-sqlite3, WAL). sqlite-vec 는 **선택적 확장 → 런타임 `load_extension` 명시 로드 필요**(P0 사전 통합 단계, Codex 리뷰어 플래그). 임베딩 기본값 **로컬 `all-MiniLM-L6-v2`(384-dim)**(A-MEM 검증 — 호스티드 서비스 0), P0 에서 벤치 후 확정. graph 순회 = **recursive CTE** — **스키마 lock-in 전 synthetic 데이터로 벤치**(Codex B4).

---

## 3. Capability 경계 (delegation-grade — Codex B1)

**할 수 있다**:
- 사람이 명시한 진술 기억 (`remember`)
- 검증된 사용자/프로젝트 제약·선호·약속·사실 인출
- 모순·staleness 탐지 (scoped supersede)
- **근거가 약하면 행동 대신 물어본다** (ask/act 게이트)

**하지 않는다 (확인 없이)**: 글로벌 성격 추론, 사생활 사실 추론, 의도 추정. → **추론된 것은 candidate(inactive)일 뿐, 사람 확인 전 active 아님.**

**ontology (좁게 시작 — Codex 과설계 cut)**:
- P1~P2 시작: **constraints · commitments · decisions · projects · corrections(수락/거부 패턴)** + repo/tool/env 사실(TTL)
- 확장(P3+, 증명 시): people/orgs · domain concepts · narrow 근거-기반 comms 선호 · 관계 엣지
- **영구 제외(과잉)**: 성격 프로파일링 · 건강/기분/생체 · 제3자 dossier · 관계 추측 · 상시 화면/음성 캡처 · raw secret · 글로벌 스타일 페르소나 응고(DITTO 44/48%≈chance)

문헌 Functions 축(factual/experiential/working, 3-0 검증)으로: factual=제약·사실·프로젝트맵 / experiential=결정·패턴·검증사례 / working=활성 목표·약속·현재 스레드.

---

## 4. 데이터 모델 (migration `mm_001`, 외부 의존 0)

> claim-canonical(U5). wiki 테이블 없음 — `mm_claims.page/slot_key` 로 그룹핑해 **렌더**. 캐시가 필요하면 `mm_wiki_cache`(순수 파생, never source of truth).

```sql
-- L2.a 넓은 이벤트 로그 (U3): capture 는 넓게, 처리는 고신호만
CREATE TABLE mm_events (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,             -- conversation|master_decision|run|task|correction|remember|brief|commit|test|...
  event_type    TEXT NOT NULL,
  actor         TEXT,                       -- human|master|pm|worker
  project_id    TEXT,                       -- cross_project 식별 (NULL = user-global)
  occurred_at   TEXT NOT NULL,
  content_redacted TEXT,                    -- secret redact 후 (원문 secret 금지)
  sensitivity   TEXT NOT NULL DEFAULT 'normal',  -- normal|sensitive|secret_masked
  content_hash  TEXT NOT NULL,
  ingested_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mm_events_proj_time ON mm_events(project_id, occurred_at);

-- L2.b 검색 인덱스 (redacted chunk)
CREATE TABLE mm_chunks (
  rowid_pk    INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  owner_type  TEXT NOT NULL,                -- event|claim
  owner_id    TEXT NOT NULL,
  text        TEXT NOT NULL,                -- 로컬 검색용: lexically 보존 (outbound/주입 시점에만 추가 redact — mnemo (f))
  project_id  TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE mm_chunks_fts USING fts5(text, content='mm_chunks', content_rowid='rowid_pk', tokenize='unicode61');
-- sqlite-vec (P0 load_extension 후): CREATE VIRTUAL TABLE mm_chunk_vec USING vec0(embedding float[384]);

-- L2.c CANONICAL claim (scoped bi-temporal — Codex SERIOUS4)
CREATE TABLE mm_claims (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,              -- entity ref 또는 'user'
  predicate     TEXT NOT NULL,
  object_json   TEXT NOT NULL,              -- 값/관계
  scope_project_id TEXT,                    -- NULL = user-global ; 값 = 프로젝트 한정
  context       TEXT,                       -- 맥락 한정 (모순≠맥락차이 구분, SERIOUS4)
  kind          TEXT NOT NULL,              -- constraint|preference|commitment|decision|fact|pattern
  page          TEXT,                       -- wiki 렌더 그룹 (UserConstraints|ActiveGoals|Decisions|Projects|...)
  slot_key      TEXT,                       -- 페이지 내 슬롯
  source_kind   TEXT NOT NULL,              -- human|deterministic|llm_candidate
  status        TEXT NOT NULL DEFAULT 'active',  -- active|candidate|superseded|archived
  confidence    REAL NOT NULL DEFAULT 0.5,
  importance    INTEGER NOT NULL DEFAULT 5,
  explicitness  INTEGER NOT NULL DEFAULT 5, -- 명시도 (supersede 판정에 사용)
  pinned        INTEGER NOT NULL DEFAULT 0,
  valid_from    TEXT, valid_to TEXT,        -- 사실이 말하는 유효구간
  tx_from       TEXT NOT NULL DEFAULT (datetime('now')), tx_to TEXT,  -- 관측 트랜잭션 시각 (bi-temporal)
  supersedes_id TEXT,                       -- 직접 근거 있을 때만 (SERIOUS4)
  evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT,
  CHECK (kind IN ('constraint','preference','commitment','decision','fact','pattern')),
  CHECK (status IN ('active','candidate','superseded','archived')),
  CHECK (source_kind IN ('human','deterministic','llm_candidate')),
  CHECK (confidence BETWEEN 0 AND 1),
  CHECK (importance BETWEEN 1 AND 10)
);
CREATE UNIQUE INDEX idx_mm_claims_hash ON mm_claims(scope_project_id, content_hash) WHERE status IN ('active','candidate');
CREATE INDEX idx_mm_claims_page ON mm_claims(page, slot_key, status);
CREATE INDEX idx_mm_claims_scope ON mm_claims(scope_project_id, status, importance DESC);

-- L2.c entities/edges — P2/P3 (U6 gate 통과 후 graph)
CREATE TABLE mm_entities (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]', pii_class TEXT, sensitivity TEXT NOT NULL DEFAULT 'normal',
  confidence REAL NOT NULL DEFAULT 0.5, first_seen TEXT, last_seen TEXT
);
CREATE TABLE mm_edges (
  id TEXT PRIMARY KEY, subject_entity TEXT NOT NULL, predicate TEXT NOT NULL, object_entity TEXT NOT NULL,
  claim_id TEXT REFERENCES mm_claims(id), confidence REAL NOT NULL DEFAULT 0.5,
  valid_from TEXT, valid_to TEXT, tx_from TEXT NOT NULL DEFAULT (datetime('now')), tx_to TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

-- 거버넌스 (U7)
CREATE TABLE mm_tombstones (             -- 삭제 증명 + 부활 차단
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_ref TEXT NOT NULL,
  reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE mm_retrieval_log (          -- 인출 감사 + kill test 데이터
  id TEXT PRIMARY KEY, request_id TEXT, query_hash TEXT,
  returned_claim_ids_json TEXT, scores_json TEXT, injected_at TEXT
);
CREATE TABLE mm_injection_ledger (       -- 캐싱 안전 1회/revision 주입 (pm_memory_injection 패턴)
  master_run_id TEXT PRIMARY KEY, injected_revision INTEGER NOT NULL DEFAULT 0, injected_at TEXT
);
CREATE TABLE mm_revision (               -- 단조 카운터 (project_memory_revision 패턴)
  scope TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
);
```

**재사용(U4)**: `memorySanitize`(secret redact·injection reject), cap admission(score eviction·human/pinned 보호), decay(`valid_to`·expire·markReviewed refresh), poisoning gate(injection-time re-sanitize), candidate→promote 단일 안전강제 tx — 전부 L1 에서 이식. **재발명 금지.**

---

## 5. 후가공 파이프라인 (capture-broad, promote-high-signal)

| 단계 | 주기 | 내용 | LLM |
|------|------|------|-----|
| redact/classify/chunk/FTS/메타 | 동기 | secret redact + sensitivity 분류 + chunk + FTS index | 0 |
| 결정론 capture | 근실시간 | corrections/constraints/commitments/decisions + repo/tool/env 사실(TTL). alias exact | 0 |
| 명시 remember | 즉시 | human 진술 → **active** (cookie 인증), bearer/PM → candidate | 0 |
| LLM 추출/graphify | **배치, default-off** | claim 추출·graph 병합 → **candidate only**, source-linked 리뷰 | gated |
| 모순/stale 리뷰 | 주간/수동 | scoped supersede (직접 근거 시만), decay | gated |

- **모순 ≠ 덮어쓰기**: 새 claim + 옛것 `valid_to` 무효화. **단 맥락차이(context)는 supersede 아님**(SERIOUS4) — `subject+scope+context` 동일 + 직접 근거일 때만 supersede.
- **monolithic 재요약 금지** (ACE context-collapse, 3-0). slot-level append-only delta 만.
- **graph 병합 LLM 최소화** (ATOM binary-merge, 3-0) — graphify default-off 제약과 정합.
- **Mem0 ADD/UPDATE/DELETE/NOOP**(3-0) 패턴을 candidate distiller 의 op 결정에 차용 — 단 출력은 candidate, active 강제는 promote tx 가.

---

## 6. 인출 & 주입 (캐싱 안전)

**인출(hybrid, 보수적)**: FTS5 BM25 + sqlite-vec 최근접 + alias exact + (P3+) 1-2홉 graph + **pinned**(프라이버시 규칙·하드 제약·활성 약속 항상). RRF 융합(적응형 per-query IDF 는 *미검증 단서* → 실험 플래그). **recency/importance 가중은 기본 랭킹에 넣지 않고 실험으로**(미검증 반증: RRF 뒤 recency/decay 무효). 코딩 작업은 lexical 가중↑(mnemo +21pp).

**주입(3중, 동적 system prompt ✕ — L1 동일)**:
1. system prompt 고정 안내 1줄 (캐싱 안전)
2. **user-payload prepend(주)**: `## User Memory Context`(하드 제약 / 활성 약속 / 관련 결정 / 검증 사례 1-2 / 모순·stale / **"가정 전 물어볼 경계"**). `mm_injection_ledger` 로 세션당 1회/revision 변경 시. **1.5~3k 토큰**, 주입 claim_id 전부 `mm_retrieval_log`.
3. GET API (보조)

**프라이버시 vs 효용(SERIOUS5)**: 로컬 검색 텍스트(`mm_chunks.text`)는 lexically 보존, **outbound(외부 LLM)·주입 시점에만 sensitive 추가 redact** — 전체 익명화는 −44~53pp(mnemo f).

---

## 7. Kill test (반증 — 핵심 artifact, P1b 후 실행)

> mnemo 가 끝내 못 가른 "관련 *내용*이 도왔나 vs *자신만만한 앵커*가 도왔나"를 **masked-anchor arm 으로 분리**(mnemo (f) 식별자-그래디언트 마스킹을 평가에 차용). LLM judge 회피·결정론 우선·검정력 선계산(mnemo 방법론 규칙).

**Arms**:
| arm | 설명 |
|-----|------|
| A0 | 무메모리 |
| A1 | last-N relevant snippets (recency only) |
| A2 | 마지막 수락 correction 만 |
| A3 | explicit-pinned 제약만 |
| A4 | raw FTS top-1 |
| A5 | FTS top-1 **content-mask · title/source 보존** (앵커-only) |
| A6 | FTS top-1 **title/source-mask · content 보존** (내용-only) |
| A7 | **claim/slot 구조화 메모리** (본 설계) |
| A8 | A7 + graph (P3+, U6 gate) |

**지표**: user-visible task 품질 + **correction rate**(재정정 필요?). placebo(같은 형태 무관 vs 관련-검증).

**KILL CONDITION**: **A7 이 {A1 last-N, A5/A6 masked-anchor} 의 최선을 품질·correction rate 둘 다에서 못 이기면 → governed retrieval(A4 수준)에서 멈춤.** 구조화 메모리가 앵커 효과의 재포장이면 짓지 않는다.

**GRAPH GATE(U6)**: A8 이 **cross-project/시간-반전/관계 질의 부분집합**에서 A7 과 masked-anchor 를 둘 다 이길 때만 persistent graph API 착수. (A-MEM ablation 3-0 이 "제대로면 graph 가 multi-hop/temporal 에 load-bearing"을 입증 — 이 gate 는 graph 를 죽이는 게 아니라 *필요한 질의 유형을 식별*.)

**불변 테스트**: poison(관련 but 틀림/stale 주입 → 오염률) / staleness(선호 반전 → 현재가 이김) / forget(source 삭제 → chunk/claim/edge/vec/렌더 어디에도 생존 0) / privacy(가짜 secret seed → 외부 호출 0·주입 0).

---

## 8. 개발 계획 (PR breakdown — de-risk 우선)

각 PR: branch→구현→npm test→**Codex 교차검증(PASS까지)**→commit→PR→merge.

- **P0** — 별도 `master_memory.db` 부트 + 마이그레이션 러너 + **sqlite-vec `load_extension` 통합**(없으면 FTS-only degrade) + `mm_events` 스키마 + **recursive-CTE/sqlite-vec synthetic 벤치**(스키마 lock-in 전, Codex B4). 임베딩 모델/차원 확정.
- **P1a** (최소 가치 — 핵심 thesis 증명/기각) — 명시 `remember`/`delete`/retrieve/inject/log, **FTS5-only**, caching-safe user-payload 주입, `mm_retrieval_log`. **삭제·tombstone 경로 포함**(나중 retrofit 회피 — Codex P7 위험).
- **P1b** — 결정론 capture(corrections/constraints/commitments/decisions + repo/tool/env TTL).
- **★ KILL TEST**(§7) — A0~A7 + 불변 테스트. **여기서 GO/STOP 판정.**
- **P1c** — claim page/slot 태그 + **wiki on-demand 렌더**(독립 persist ✕) — *명시 메모리가 베이스라인 이길 때만*.
- **P2** — scoped bi-temporal claim 정밀화(supersede=직접근거만) + sqlite-vec 시맨틱 인출 합류.
- **P3** — default-off LLM 추출/graphify → **candidate-only** + source-linked 리뷰(κ=0.40) + entities/edges. **GRAPH GATE 통과 시** graph 순회/PPR-lite.
- **P5** — 광범위 개인 컨텍스트 수집 + crypto-shred/DEK/해시체인 영수증 — **삭제·audit·poisoning 방어 입증 후 + 규모/다중소스 강제 시.**

---

## 9. Codex 적대 리뷰 R1 대응 추적 (GO-WITH-CHANGES)

| 지적 | 해소 |
|------|------|
| **B1** delegation-grade 모호 | §3 capability 경계 구체화 + ask/act 게이트 |
| **B2** wiki+graph derived-state 함정 ★ | **U5 claim-canonical, wiki=렌더**(독립 persist ✕). 단일 진실 surface |
| **B3** "모든 걸" unsane ★ | **U3 reconcile** — 로그 넓게/처리 고신호. 광범위 수집=P5 |
| **B4** SQLite 규모 미검증 | **별도 db + P0 synthetic 벤치 + FTS-first + graph gate** |
| **B5** kill test 비결정적 | §7 **masked-anchor(A5/A6) + last-N(A1) 베이스라인** 추가 |
| SERIOUS1 P1 비최소 | P1a/b/c 분할 |
| SERIOUS2 PM 레이어 중복 | **U4 패턴·코드 재사용 + scope 차원** |
| SERIOUS3 default-off 전략 아님 | 결정론+사람확인 primary, LLM=candidate only |
| SERIOUS4 시간 무효화 underspec | scoped validity, supersede=직접근거+동일context만 |
| SERIOUS5 프라이버시 vs 효용 | 로컬 텍스트 보존, outbound/주입만 redact |
| 과설계 cut | crypto-shred/DEK/영수증→P5, PPR→gate후, ontology 좁게, 단일 derived layer |

> **재조정(굽히지 않은 2건)**: (1) U3 — 사용자 "언젠가 전부" 비전 보존(로그는 넓게). (2) graph — Codex "어쩌면 영영 불필요"에 A-MEM ablation(3-0)로 calibrate: **유력 endgame, 단 gate 로 증명**.

---

## 10. 성공 기준 & 리스크

**성공**: (정량) Master 응답의 사용자 제약 위반↓ · 재정정률↓ · ask/act 게이트 적중. (정성) Master 가 주입 메모리 인용. (안전) forget 잔존 0 · secret leak 0 · 캐싱 hit 유지. **(게이트) A7 > masked-anchor 입증 — 못 하면 STOP.**

**Top 리스크**(Codex): 앵커 지배 · 포이즈닝(dark mirror) · staleness · 추출 fiction(κ=0.40) · 프라이버시 누출 · creepiness · **graph theater** · 망각 실패. → 전부 §7 kill test/불변 테스트로 조기 노출.

**단일 최대 리스크(Codex verdict)**: *"신뢰할 사용자 이해를 만들기보다 앵커 효과·포이즈닝만 증폭하는 비싸고 일관성 없는 derived-state 기계."* → U5(단일 진실) + §7(kill test) + U3(고신호 샘플링)가 직접 방어.

---

## 11. 출처 (deep-research, 검증 등급)

**검증(3-0)**: Mem0 ADD/UPDATE/DELETE/NOOP·graph 2x 토큰(2504.19413) / Zep-Graphiti temporal KG 정의(2501.13956, **벤치 수치는 killed**) / agent-memory 3축 taxonomy(2512.13564) / A-MEM note·로컬 retrieval·**ablation(graph load-bearing)**(2502.12110) / ACE context-collapse·playbook(2510.04618) / ATOM no-LLM 병합(2510.22590).
**미검증(rate-limit abstain, 유망 단서)**: TG-RAG bi-level temporal graph·증분 요약·PPR(2510.13590) / sqlite-vec+FTS5 substrate·적응형 RRF·recency-스코어링-무효(2604.15484) / MemoryGraft 9%→47.9%(2512.16962, mnemo 확증).
**killed(불신)**: Zep DMR/LongMemEval 벤더 수치(2501.13956) / "graphify 무용"(2504.19413).
**내부**: mnemo `08-findings`·`09-retention`·`11-conclusion`·`notes/2026-06-15` (앵커효과·1개포화·κ=0.40·DITTO·poison dark-mirror·익명화 −44~53pp·crypto-shred·원본/파생 분리).
