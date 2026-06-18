# Memory Augmentation (L1 PM / L2 Master) — Hermes 벤치마크 기반 보완 설계 brief

> **상태**: v0.1 DRAFT (2026-06-18) — Hermes Agent 지식증강 비교 + Codex 적대 교차리뷰 + 2024~26 SOTA 웹검증을 거친 보완 설계. **각 보완안을 L1(PM)/L2(Master) 구조 차이에 맞춰 per-layer 상세 명세.**
> **연관 spec**: `memory-layer-brief.md`(L1 PM 메모리), `master-memory-brief.md`(L2 Master, governed top-K de-scope), `manager-v3-multilayer.md`
> **외부 리서치 원천**: `/Volumes/HH/Work/SK/ContextualAI/Hermes_Benchmark/` — `Hermes_학습·진화_메커니즘.md`(코드 file:line + 웹 + 적대검증 + Codex 교차), `02_c2_vs_hermes_차별점.md`. 본 문서는 그 리서치를 **우리 시스템에 적용**하는 내부 설계.
> **목표 한 줄**: Hermes 가 가진 좋은 패턴(절차적 기억 자동축적·일화 검색)을 **우리 review-gate 원칙 위에서** 흡수하고, 우리 약점(memory blind spot·correlated evidence·truth laundering·한국어 recall·능동 모순해소 부재)을 닫되, **L1 과 L2 의 구조 차이를 존중해 각각 다르게** 설계한다.

---

## 0. 왜 이 문서 — Hermes 벤치마크 요지

Hermes Agent("쓸수록 똑똑해지는" self-improving 에이전트)의 지식증강을 코드까지 분해한 결과(외부 리서치):

- Hermes "학습"의 실체 = **LLM 자기큐레이션 + in-context 파일 누적**(가중치 진화는 별도 수동 오프라인 RL, 런타임 자동환류 없음). "쓸수록 가중치가 똑똑해진다"는 과장.
- Hermes 메모리 4종: 절차적(SKILL.md) / 의미(MEMORY.md·USER.md) / 일화(state.db FTS5) / 사용자모델(Honcho, default OFF).
- **Hermes 의 문서화된 약점**: review-gate 부재, 거짓신념 영구화(기존 메모리 노후/모순 미검토), 메타데이터 없는 퇴거, 분할 인젝션 우회, 근중복 공존, 1인 디렉토리(멀티테넌트 없음).

**우리(Palantir Console)의 차별 = 그 약점들을 닫는 거버넌스다.** 단, Codex 적대 교차리뷰가 "구조적으로 닫는다"는 표현을 깎았다: **promote tx 가 강제하는 건 스키마·권한·상태이지 사실성·최신성·의미충돌이 아니다.** 잘못된 고신호 이벤트·오염 evidence·낡은 pinned 는 우리도 거짓신념을 영구화할 수 있다. 이 문서의 보완안들은 그 잔여 표면을 겨냥한다.

**문헌 검증(웹)**: 절차적 기억 자동축적은 효과가 정량 검증됨(AWM 23.5→35.5%, ReasoningBank SWE 34.2→38.8%·스텝 -16%, EvoSkill +7.3~12.1pt). 단 **무게이트 add-all 은 정량적으로 퇴화**(experience-following 67.5→55.5%, 의료추론 13% vs 선별 39%). SSGM: *"메모리 업데이트는 Write Validation Gate 를 통과해야 한다."* → **효과는 게이트 품질에 종속**. 우리 아키텍처(결정론 캡처 → human-gated candidate → 단일 promote tx → decay/eviction/merge)는 이 문헌 권고와 거의 1:1 매핑.

---

## 1. L1 / L2 구조 차이 (보완안이 per-layer 로 갈리는 근거)

| 축 | **L1 (PM 프로젝트 메모리)** | **L2 (Master 사용자 메모리)** |
|---|---|---|
| 테이블 | `memory_items` (mig 025) | `master_memory_items` (mig 030) |
| 스코프 | `project_id` (FK) | `scope ∈ {user, cross_project}`, `project_id`=provenance only(nullable) |
| kind | convention · pitfall · heuristic · constraint · fact | constraint · preference · commitment · decision · fact · **pattern** |
| origin | human · rule:R1b · rule:R3 · rule:R6 · batch_llm | human · deterministic · llm_candidate |
| candidate 규칙 | R1b(실패→수정) · R3(PM판정) · R4(remember) | R4(remember) · **XPROJECT**(L1 ≥2 프로젝트 스캔, mig 032 인덱스) |
| 포착원 | worker harvest + PM judgment (프로젝트 내부) | human remember + **cross-project L1 승격** |
| 인출 | FTS5 + importance + recency top-K(12) + 2000자 cap | **governed top-K FTS** (de-scope: graph/distillation KILL) |
| 게이트 | promote tx (단일 안전강제) | promote tx **+ ask/act 게이트**(delegation-grade) |
| 주입 | PM slot user-payload prepend | **Top slot** user-payload prepend |
| 위험도 | 프로젝트 사실(상대적 저위험) | **사용자 제약·약속(고위험 — 극성반전 치명적)** |

**핵심 명제**: L1 은 *flat 프로젝트 선언지식*이라 **자동 해소(auto-resolve)** 가 허용되지만, L2 는 *사용자 제약·약속*이라 **표면화-후-질문(surface-and-ask)** 이 기본이다. 같은 보완안도 이 차이로 갈린다.

---

## 2. 보완안 (우선순위순) — 각 항목 L1/L2 per-layer 상세

각 항목: **판정(Codex/web) → L1 설계 → L2 설계 → 공통 가드.**

---

### 보완 ① 한국어/CJK FTS recall (trigram) — `GO, 최우선·빌드0·저위험`

**판정**: Codex GO(measured), web VERIFIED. **첫 PR 추천** — 빌드 0, 즉효, L1+L2 공유.

**문제**: 양쪽 FTS 모두 `tokenize='unicode61'`. unicode61 은 한국어를 **어절(공백) 단위**로 토큰화 → 조사 결합 때문에 `메모리` 질의가 `메모리를` 든 행을 못 잡음(`메모리` ≠ `메모리를`). 우리 메모리는 한국어 문장이라 recall 직접 손실.

**해법(공유)**: `unicode61` 단일 → **trigram 보조 FTS 테이블 추가(dual-table)**:
- `unicode61` 메인 = BM25 랭킹 품질 유지(기존 경로 불변).
- `trigram` 보조 = 연속 3문자 n-gram 으로 조사·부분일치 recall(`메모리를` 색인이 `메모리` 질의에 매칭).
- 2글자 단어(`회의`·`토큰`)는 trigram 미매칭(≥3자 제약) → `LIKE` fallback.
- `better-sqlite3` 는 trigram **built-in**(추가 빌드/확장 0). ICU/Lindera 형태소는 컴파일 확장 필요 → **무빌드·외부의존0 원칙 위배라 제외.**
- 트레이드오프: 인덱스 수배 증가(우리 데이터 절대량 작아 부담 낮음). `detail='none'` 으로 ~37% 절감 가능하나 질의 제약 추가 — 보류.

**L1 설계**: `memory_fts`(025) 옆에 `memory_fts_tri`(trigram) + ai/ad/au 트리거 3종. `memoryService.retrieveForProject` 의 FTS 단계를 `unicode61 결과 ∪ trigram 결과` 융합(중복 rowid 제거, BM25 우선 정렬 유지). 빈쿼리/이스케이프 fallback 기존 로직 재사용.

**L2 설계**: `master_memory_fts`(030) 옆에 `master_memory_fts_tri`. **L1 과 FTS 형태가 동일**(external-content, content_rowid, 트리거 shape) → **U4 공유코어의 첫 실증**: trigram FTS helper 를 db-handle 파라미터화로 추출해 L1/L2 둘 다 호출.

**공통 가드**: 마이그레이션은 신규 보조 테이블 추가 + `rebuild`(기존 데이터 재색인). 회귀 테스트 — 기존 unicode61 검색 결과 불변 + 한국어 조사 케이스 recall 개선 동시 검증.

---

### 보완 ② 절차적 기억 자동축적 (human-gated skill-pack candidate) — `candidate=GO / auto-activation=NO-GO`

**판정**: Codex REVISE/high, web VERIFIED(게이트 전제). 우리 **최대 빈틈** — declarative 만 쌓고 "어떻게 행동하는가"(절차)는 안 쌓음. 단 injection 표면이라 가드가 무겁다.

**핵심 원칙**: 후보 생성은 GO, **자동 활성화는 NO-GO.** Codex 요구 가드 전부: 결정론 eligibility + provenance(run_ids) + 기존 skill diff + secret scan + **tool-permission manifest**(어떤 툴 쓰는 skill 인지) + sandbox replay/test + rollback/versioning.

**L1 설계 (주 무대)**:
- 기존 `skill_packs` 인프라(Phase 10G, origin_type ∈ bundled/url/manual/import) 재사용 — **`origin_type='distilled'` 추가**. 절차는 `memory_items` 가 아니라 **skill_pack candidate** 로 (kind 오염 방지).
- 포착: **R5(반복성공, 현재 deferred) + R1b(실패→수정) 결합.** web 근거 — 단순 N회 성공보다 실패→수정 가드레일이 강함(ReasoningBank 성공만 46.5 vs 실패포함 49.7). 즉 "성공 절차 + 그 절차의 실패→수정 교훈"을 한 쌍으로 distill.
- 트리거: 같은 task-shape(preset/agent/명령 패턴) 가 ≥N회 harvest PASS → distilled skill-pack candidate (pending). 절대 자동 install 안 함.
- 게이트: **사람 검수 후 install**(우리 review-gate 철학 = Hermes review-gate 부재 약점 동시해결). 승격 시 dedup(기존 skill-pack 과 diff)·secret scan·tool manifest 검증.

**L2 설계 (보수적·후속)**:
- cross-project 절차 = 한 skill-pack 이 **≥2 프로젝트에서 사람승인되어 사용** → user-scope 'pattern' 으로 승격 후보(XPROJECT 와 동형의 빈도 게이트).
- 단 L2 는 governed top-K 로 de-scope 된 보수 영역 → **P2+ 로 defer.** 우선 L1 절차축적만 검증하고, cross-project 승격은 L1 이 익은 뒤.

**공통 가드**: distilled skill 은 **항상 candidate→사람검수→active.** auto-activation 경로 코드상 부재(Hermes 처럼 daemon 이 바로 쓰지 않음). dedup/GC/decay 필수(web: AWM 도 dedup 미구현으로 자연저중복에 의존 — 규모 커지면 index bloat 퇴화) — 우리 PR3c-1 semantic merge + PR5 admission 재사용.

---

### 보완 ③ 능동적 모순/staleness 해소 — `GO (write-time 우선, batch 보조)`

**판정**: Codex GO, web — **1차 방어선은 write-time**(Mem0 ADD/UPDATE/DELETE/NOOP, Zep temporal invalidation), batch sweep 은 보조 GC. **batch-only 는 명시적 안티패턴.**

**현황**: 우리 decay/supersede/valid_to 는 "시간이 지나면 약해짐"이지 "서로 모순되는 active set 발견"이 아님. 새로 저장할 것만 보고 기존은 안 봄(Hermes 와 같은 약점).

**L1 설계 (auto-resolve 허용)**:
- promote tx 에 **"유사 기존 active 비교 → 모순이면 supersede" 단계** 추가 — PR3c-1 의 `mergeTargetId` 메커니즘을 **병합 방향뿐 아니라 모순(supersede) 방향까지** 확장. 같은 project+kind 내.
- L1 fact 는 이미 fact_key upsert supersede(R6). convention/pitfall/heuristic 도 모순 시 자동 supersede 허용(프로젝트 사실 = 저위험).
- 보조: 저빈도 batch contradiction-sweep(같은 project+kind 클러스터부터 — 전량 pairwise 는 비용/오탐, Codex). high-importance/pinned/recently-used 우선.

**L2 설계 (surface-and-ask — 구조적 차이)**:
- L2 는 **kind 별로 갈린다**:
  - `fact`/`preference` → L1 처럼 write-time auto-supersede 허용(저위험).
  - **`constraint`/`commitment`/`decision` → 자동 supersede ✕.** 모순 claim 존재 시 **ask/act 게이트가 충돌을 표면화**(사용자에게 노출, 자동 선택 ✕). master-memory-brief §3 게이트 매트릭스의 *"kind∈{constraint,commitment} 모순 → ask"* 를 이 단계가 강제.
- 즉 **L1=자동해소, L2=고위험 claim 표면화-질문.** 이것이 사용자가 지적한 "각각 다르게"의 핵심 사례.
- bi-temporal(valid_from/valid_to + tx_from/tx_to)은 master-brief 설계엔 있으나 현재 lean 구현은 valid_to 만 — 모순해소를 위해 P2 에서 정밀화.

**공통 가드**: 모순 판정에 LLM 쓰면 오탐/비용 → 결정론 1차 필터(같은 subject/fact_key/kind) 후 의심쌍만 판정. 삭제 ✕, invalidate(valid_to)·archive 만(web 수렴: merge-not-delete).

---

### 보완 ④ Truth-laundering 방어 — `신규 (Codex 발굴, 아무도 안 다룸)`

**판정**: Codex 최신 지적 — *"'LLM 은 content 정제만'이 가장 위험한 표현. 정제도 권력."* LLM 이 qualifier 를 지우거나 오염 evidence 를 그럴듯한 claim 으로 정상화하면 **write 권한 없이도 사실 세탁.** promote tx 가 완전히 못 막음.

**L1 설계**:
- distiller content 정제에 **qualifier/극성 보존 불변식** — distill 결과의 부정/조건/한정어가 evidence excerpt 와 극성 일치하는지 promote tx 가 assert.
- PR3c-1 이 병합 극성을 LLM 책임으로 뒀던 부분이 정확히 이 표면 → **promote 단계에 극성 일치 결정론 체크 추가**(evidence 와 claim 의 부정어/방향 토큰 비교).

**L2 설계 (더 critical)**:
- L2 는 사용자 제약/약속이라 극성반전이 치명("X 원치 않음" → "X 원함"). **source_kind=human 은 verbatim 저장**(LLM distill 경유 ✕ — L2 human remember 는 cookie-only active 라 이미 LLM 미경유, 유지).
- llm_candidate 만 정제 대상 → 극성보존 + ask/act 게이트(low confidence→ask)가 2중 백스톱.

**공통 가드**: 극성/qualifier 체크는 결정론(정규식·부정어 사전) 1차 + 의심 시 보류. 테스트로 극성반전 케이스 재현.

---

### 보완 ⑤ Correlated-evidence 위장안전 차단 — `신규 (Codex 발굴)`

**판정**: Codex — "독립 run ≥2 confidence 상향"이 **독립성 정의 없으면** 같은 원천 반복도 숫자만 안전해 보이는 위장안전.

**L1 설계**: confidence 상향의 "독립 run" 정의를 코드로 강제 — `memory-layer-brief §7`: *"다른 run.id + 다른 task_id 또는 다른 failure-signature"*. 같은 task 의 flaky 반복은 source_count 만 올리고 confidence 상향 ✕. evidence 에 run_id/task_id/failure-signature 기록 → 상향 판정 시 distinct 검사.

**L2 설계**: XPROJECT 승격이 "≥2 프로젝트"인데 **같은 프로젝트의 fork/복제가 2로 세지 않도록** project_id distinct + content 출처 검사. cross-project 독립성 = 진짜 다른 project_id.

**공통 가드**: "independent" 를 SQL distinct 로 환원(주관 판정 ✕). web: correlated evidence error propagation(experience-following r≈1) 직접 대응.

---

### 보완 ⑥ Manager용 on-demand 일화검색 — `REVISE / 실험·후순위`

**판정**: Codex REVISE — answer 품질보다 **감사·원인분석**("전에 왜 이렇게 결정했나")에 가치. raw episode 는 injection/secret/temporal noise 강함. **우리 L2 kill-test 가 answer 가치에 의문** 제기 → 게이트 뒤 실험.

**L1 설계**: PM 이 프로젝트 run 이력(L0 run_events/harvest, read-only)을 on-demand 조회 — "이 task 가 전에 왜 실패했나". **source-label + excerpt-only + action-gate** 뒤. 행동 결정 직접 사용 ✕.

**L2 설계**: Master 가 cross-project 이력 조회 — 감사/복기. 같은 게이트. scope=user.

**공통 가드**: 우리 kill-test 규율로 게이트(answer 가치 미입증 시 audit-only 유지). **후순위(다른 보완 검증 후).**

---

### 보완 ⑦ User-preference 저마찰 개인화 — `GO / L2 전용·미세조정`

**판정**: Codex GO(don't overcorrect) — 모든 사용자특성에 human confirmation 요구하면 저마찰 개인화를 잃음.

**L1 설계**: N/A — L1 은 프로젝트 스코프, 사용자 모델 ✕.

**L2 설계 (전용)**: ask/act 게이트 세분화 —
- **저위험 반복 preference**("한국어로 짧게 답해")는 `source_kind=deterministic`, `kind=preference` 로 **auto-act**(human confirmation 불요).
- **위임·민감·장기 결정**(commitment/constraint, 또는 sensitive)은 human confirmation 유지.
- Honcho식 깊은 변증법 사용자모델은 **복사 ✕**(추론 사용자특성에 사람확인 = delegation-grade 의도적 우위). 저위험 preference 만 마찰 제거.

---

## 3. 횡단 안전 원칙 (모든 보완안에 적용)

1. **게이트 품질이 ROI 의 전부**(web): candidate→active 판정을 순수 LLM 에 일임 ✕. 결정론 규칙 + 사람검수 우선. coarse LLM evaluator 는 소량 수작업보다 해롭다(experience-following).
2. **merge-not-delete**(web 수렴): 삭제 ✕, invalidate(valid_to)·archive. 우리 설계와 이미 일치.
3. **write-time 1차, batch 보조**: 모순/dedup 은 promote tx 에서 1차 해소, batch 는 못 잡은 기존쌍 GC. batch-only 안티패턴.
4. **극성/독립성은 결정론으로 환원**: truth-laundering(④)·correlated-evidence(⑤)는 주관 LLM 판정이 아니라 SQL distinct·정규식 결정론 체크.
5. **L1 auto-resolve / L2 surface-and-ask**: 저위험 프로젝트 사실은 자동, 고위험 사용자 제약은 표면화-질문.

---

## 4. 구현 로드맵 (PR breakdown — de-risk 우선)

각 PR: branch → 구현 → npm test → **Codex 교차검증(PASS까지)** → commit → PR → merge.

| PR | 보완 | 범위 | 위험 | 근거 |
|----|------|------|------|------|
| **A1** | ① 한국어 FTS | L1+L2 trigram dual-table(공유 helper) | 저(빌드0) | 즉효·U4 공유코어 실증 |
| **A2** | ④+⑤ 정직성 패치 | L1 극성보존·독립성 결정론 체크 (promote tx) | 저 | 신규 표면, 코드 국소 |
| **A3** | ③ 모순해소 | L1 write-time supersede(PR3c-1 확장) + 저빈도 sweep | 중 | Mem0/Zep 동형 |
| **A4** | ③ 모순해소 L2 | L2 surface-and-ask(constraint/commitment 게이트 강화) | 중 | per-layer 차이 핵심 |
| **A5** | ② 절차적 기억 | L1 distilled skill-pack candidate(human-gated) + 가드 | 고 | 최대 빈틈, 가드 무거움 |
| **A6** | ⑦ preference | L2 ask/act 세분화(저위험 auto-act) | 저 | 미세조정 |
| **A7** | ⑥ 일화검색 | L1/L2 on-demand audit(게이트 뒤) | 실험 | kill-test 게이트 |
| (defer) | ② L2 cross-project 절차 | A5 검증 후 | — | 보수영역 |

**권장 시작 = A1**(한국어 FTS): 빌드 0, 저위험, L1+L2 동시 이득, U4 공유코어 첫 실증. 그 다음 A2(정직성 패치, 국소) → A3/A4(모순해소) → A5(절차적 기억, 무거운 가드).

---

## 5. 근거·출처

**외부 Hermes 리서치**(코드검증+적대+Codex): `/Volumes/HH/Work/SK/ContextualAI/Hermes_Benchmark/Hermes_학습·진화_메커니즘.md` §3(절차)·§4(의미)·§5(일화)·§17.5(약점).

**웹 SOTA**(2024~26, 1차 논문 수치 확인): 절차적 기억 효과 — [AWM 2409.07429](https://arxiv.org/html/2409.07429v1)(23.5→35.5%), [ReasoningBank 2509.25140](https://arxiv.org/html/2509.25140v1)(SWE 34.2→38.8%, 실패포함 46.5→49.7), [EvoSkill 2603.02766](https://arxiv.org/abs/2603.02766)(+7.3~12.1pt), [Voyager 2305.16291](https://arxiv.org/abs/2305.16291). 무게이트 퇴화 — [Experience-Following 2505.16067](https://arxiv.org/html/2505.16067v2)(67.5→55.5%, r≈1). 거버넌스 — [SSGM 2603.11768](https://arxiv.org/html/2603.11768v1)(Write Validation Gate). 모순해소 — [Zep/Graphiti 2501.13956](https://arxiv.org/html/2501.13956v1)(temporal invalidation), [Mem0 2504.19413](https://arxiv.org/html/2504.19413v1)(ADD/UPDATE/DELETE/NOOP), [Consolidation Problem](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation)(write-time 우선). FTS — [SQLite FTS5 trigram](https://www.sqlite.org/fts5.html), [dual FTS 패턴](https://andrewmara.com/blog/faster-sqlite-like-queries-using-fts5-trigram-indexes).

**Codex 적대 교차리뷰 요지**: 결론 정정 3건(구조적 closure 과장·캐싱수렴 철회·메타우위 완화) + 보완안 가드 강화(절차 auto-activation NO-GO) + **신규 약점 발굴**(memory blind spot·correlated evidence·truth laundering).

---

## 6. 다음 단계

본 brief lock-in 후 A1(한국어 FTS)부터 phase 체인. 각 PR Codex 교차검증. L2 는 master-memory-brief 의 governed top-K de-scope·ask/act 게이트 전제 유지(heavy graph 재도입 ✕).
