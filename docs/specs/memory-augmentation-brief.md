# Memory Augmentation (L1 PM / L2 Master) — Hermes 벤치마크 기반 보완 설계 brief

> **상태**: v0.3 DRAFT — reconciled (2026-06-18). **⚠️ 최종 메모리 아키텍처 `operator-memory-architecture.md` 확정으로 본 brief 의 L1/L2 프레이밍은 superseded.** **A1**(한국어 FTS, #222 merged)은 owner-agnostic 라 유지. 나머지 보완안은 Operator 리팩터로 **흡수**(§5). 매핑: **L1→Workspace · L2→User · +Profile · +Raw archive · +Composer**. 본 brief 는 A1 근거 + 보완 카탈로그로 보존.
> (이력) v0.2 — Hermes Agent 지식증강 비교 + Codex 적대 교차리뷰 R1(실측) + 2024~26 SOTA 웹검증 + A1 경험 검증. 각 보완안을 L1(PM)/L2(Master) per-layer 명세.
> **연관 spec**: `memory-layer-brief.md`(L1 PM 메모리), `master-memory-brief.md`(L2 Master, governed top-K de-scope), `manager-v3-multilayer.md`
> **외부 리서치 원천**: `/Volumes/HH/Work/SK/ContextualAI/Hermes_Benchmark/` — `Hermes_학습·진화_메커니즘.md`(코드 file:line + 웹 + 적대검증 + Codex 교차), `02_c2_vs_hermes_차별점.md`. 본 문서는 그 리서치를 **우리 시스템에 적용**하는 내부 설계.
> **목표 한 줄**: Hermes 의 좋은 패턴(절차적 기억·일화 검색)을 **우리 review-gate 원칙 위에서** 흡수하고, 우리 약점(memory blind spot·correlated evidence·truth laundering·한국어 recall·능동 모순해소 부재)을 닫되, **L1 과 L2 의 구조 차이를 존중해 각각 다르게** 설계한다.

---

## 0. 왜 이 문서 — Hermes 벤치마크 요지

Hermes Agent("쓸수록 똑똑해지는" self-improving 에이전트)를 코드까지 분해한 결과(외부 리서치):

- Hermes "학습"의 실체 = **LLM 자기큐레이션 + in-context 파일 누적**(가중치 진화는 별도 수동 오프라인 RL, 런타임 자동환류 없음). "쓸수록 가중치가 똑똑해진다"는 과장.
- Hermes 메모리 4종: 절차적(SKILL.md) / 의미(MEMORY.md·USER.md) / 일화(state.db FTS5) / 사용자모델(Honcho, default OFF).
- **Hermes 약점**: review-gate 부재, 거짓신념 영구화, 메타데이터 없는 퇴거, 분할 인젝션 우회, 근중복 공존, 1인 디렉토리.

**우리 차별 = 그 약점을 닫는 거버넌스.** 단 Codex 가 "구조적으로 닫는다"를 깎음: **promote tx 가 강제하는 건 스키마·권한·상태이지 사실성·최신성·의미충돌이 아니다.** 잘못된 고신호 이벤트·오염 evidence·낡은 pinned 는 우리도 거짓신념을 영구화할 수 있다. 이 문서의 보완안은 그 잔여 표면을 겨냥한다.

**문헌 검증(웹)**: 절차적 기억 자동축적 효과는 정량 검증(AWM 23.5→35.5%, ReasoningBank SWE 34.2→38.8%·스텝 -16%, EvoSkill +7.3~12.1pt). 단 **무게이트 add-all 은 정량적으로 퇴화**(experience-following 67.5→55.5%, 의료추론 13% vs 선별 39%). SSGM: *"메모리 업데이트는 Write Validation Gate 를 통과해야 한다."* → **효과는 게이트 품질에 종속.** 우리 아키텍처(결정론 캡처 → human-gated candidate → 단일 promote tx → decay/eviction/merge)는 이 권고와 거의 1:1.

---

## 1. L1 / L2 구조 차이 (보완안이 per-layer 로 갈리는 근거)

| 축 | **L1 (PM 프로젝트 메모리)** | **L2 (Master 사용자 메모리)** |
|---|---|---|
| 테이블 | `memory_items` (mig 025) | `master_memory_items` (mig 030) |
| 스코프 | `project_id` (**FK ON DELETE CASCADE**) | `scope ∈ {user, cross_project}`, `project_id`=provenance only(**FK 없음, nullable**) |
| kind | convention · pitfall · heuristic · constraint · fact | constraint · preference · commitment · decision · fact · **pattern** |
| origin | human · rule:R1b · rule:R3 · rule:R6 · batch_llm | human · deterministic · llm_candidate |
| candidate 규칙 | R1b · R3 · R4 | R4 · **XPROJECT**(L1 ≥2 프로젝트 스캔, mig 032 인덱스) |
| 포착원 | worker harvest + PM judgment (프로젝트 내부) | human remember + **cross-project L1 승격** |
| 인출 | FTS5(unicode61) + bm25 + importance + recency top-K(12) + 2000자 cap | **governed top-K FTS**(unicode61) — graph/distillation KILL |
| 게이트 | promote tx(`promoteCandidatesBatchTx`) 단일 안전강제 | promote tx **+ ask/act 게이트(⚠️ spec-only, 미구현 — §3.A)** |
| 주입 | PM slot user-payload prepend (revision: project 단위) | **Top slot** user-payload prepend (**revision: scope 단위 독립** — §3.D) |
| 위험도 | 프로젝트 사실(상대적 저위험) | **사용자 제약·약속(고위험 — 극성반전 치명적)** |

**핵심 명제**: L1 은 *flat 프로젝트 선언지식*이라 **자동 해소(auto-resolve)** 가 허용되지만, L2 는 *사용자 제약·약속*이라 **표면화-후-질문(surface-and-ask)** 이 기본이어야 한다. 단 **L2 의 그 게이트는 현재 스펙만 있고 코드 미구현**(§3.A) — 보완③의 L2 부분은 그 게이트 구현이 선행이다.

---

## 2. 보완안 (우선순위순) — 각 항목 L1/L2 per-layer 상세

각 항목: **판정(Codex/web/실측) → L1 설계 → L2 설계 → 가드.**

---

### 보완 ① 한국어 FTS recall — `GO (two-pass exact-first), 최우선·빌드0`

**판정**: trigram dual-table 원안은 Codex **NO-GO**(BM25 스케일 85만 배 차이로 union 정렬 깨짐, 2자 맹점). → **경험 검증으로 prefix-first 로 전환**(node@22 + better-sqlite3 실측).

**문제(실측)**: 양쪽 MATCH 빌더(`memoryService.buildMatchQuery:465`, `masterMemoryService.buildMatchQuery:772`)가 각 토큰을 **정확 인용**(`"메모리"`)하고 prefix 미사용. 한국어 조사는 어간 뒤 접미(`메모리`+`를`)라 어간이 inflected 형태의 **prefix**. 실측: `"메모리"` 는 `메모리를...` 을 **못 잡음**(현재 버그).

**해법 (two-pass, Codex A1-review R2 반영)**: pure-prefix 한 줄은 Codex 실측에서 REVISE — `"메모리"*` 가 match-set superset 이긴 하나 `ORDER BY bm25 LIMIT 12` 에서 짧은 prefix noise(`메모리지옥` 20개)가 exact 관련 항목을 top-K 밖으로 밀어냄. → **two-pass**:
- pass1 **exact** 토큰(`"메모리"`) — pre-A1 과 동일 랭킹.
- exact 가 K 를 못 채울 때만 pass2 **prefix**(`"메모리"*`) 로 남은 슬롯 채움(이미 잡힌 id 제외).
- ⇒ **exact 히트는 prefix-only 히트보다 항상 top-K 우선**(char-cap budget 내, strict set superset 아님) + 조사 inflected 형태는 prefix-fill 로 도달. NFC 정규화(한글 canonical 동치). 마이그레이션0·인덱스bloat0.
- **2자 단어 OK**(`"회의"*` unicode61 prefix, trigram ≥3자 맹점 없음).

**정직한 한계**: 역방향 미해결 — 질의가 inflected(`메모리를`)면 어간 content(`메모리`) 못 잡음(질의는 보통 어간이라 수용, 테스트로 문서화). NFD content 는 write-side NFC 필요(현 스코프 외, 주석화).

**L1 설계**: `memoryService.buildMatchQuery(taskContext,{prefix})` + `retrieveForProject` two-pass. `ftsRetrieveStmt`(bm25 ASC) 불변.
**L2 설계**: `masterMemoryService` 동일(빌더·retrieve 미러). 공유 helper 추출은 후속(중복 2곳 — Codex MINOR).

**trigram (defer, optional)**: 역방향 substring recall 이 *실측상* 필요하다고 입증되면 보조 테이블 추가. 단 채택 시 **BM25 직접 비교 금지**(Codex: 85만 배 스케일차) → rank-position 기반 **RRF** 또는 tiered-merge + 2자 `LIKE` fallback 명시. **현재는 불필요(prefix 로 충분 추정).**

**가드**: 회귀 테스트 — (a) 기존 unicode61 정확매칭 결과 불변(exact top-K 보존), (b) 한국어 조사 케이스 recall 개선, (c) 2자 단어 매칭. L1+L2 양쪽.

---

### 보완 ② 절차적 기억 자동축적 — `BLOCKED (선행 3건 미정의)`

**판정**: 방향은 web VERIFIED(최대 빈틈)이나 Codex **NO-GO/BLOCKED** — 선행 블로커 3건이 전부 열림. **로드맵에서 A5 = blocked, A5.0(선행) 먼저.**

**선행 블로커 (Codex 실측)**:
- **A. migration 021 trigger**: `skill_packs.origin_type` 은 `bundled|url|manual|import` 4종을 **BEFORE INSERT/UPDATE trigger 로 DB 강제**. `distilled` 추가 = trigger 교체 신규 migration 필요.
- **B. tool-permission manifest 부재**: `TmuxEngine`/`SubprocessEngine` 에 "이 skill 이 어떤 tool 을 쓰는가" 선언·검증 개념 없음. manifest 없이 설치하면 worktree 격리돼도 권한 범위 불명.
- **C. R5 인프라 전무**: R1b(실패→수정 쌍)와 "성공 N회 카운팅"은 관측모델이 다름. 성공 이벤트 정의·task fingerprint·동일절차 판정·false-success 배제(운 좋은 env 의존 성공 제외) 위한 테이블/이벤트/카운터 없음.

**설계 방향 (블로커 해소 후)**:
- **L1(주 무대)**: 반복성공 worker절차 → `origin_type='distilled'` skill-pack candidate(human-gated). web 근거 — 단순 N회 성공보다 **실패→수정 가드레일(R1b) 동반**이 강함(ReasoningBank 성공만 46.5 vs 실패포함 49.7). **자동 활성화 NO-GO, 후보화만 GO.**
- **L2(보수·후속)**: cross-project 절차 = skill-pack 이 ≥2 프로젝트 사람승인 사용 → user-scope 'pattern' 승격(XPROJECT 동형 빈도게이트). **P2+ defer.**

**A5.0 선행작업**: (a) origin_type CHECK trigger 확장 migration, (b) tool manifest schema, (c) R5 success-counter 인프라(이벤트·fingerprint·false-success 배제).

---

### 보완 ③ 능동적 모순/staleness 해소 — `L1=GO(write-time) / L2=BLOCKED(게이트 선행)`

**판정**: Codex GO(L1) / BLOCKED(L2 게이트 미구현). web — 1차 방어선 write-time(Mem0/Zep), batch 는 보조 GC. batch-only 안티패턴.

**현황**: 우리 decay/supersede/valid_to 는 "시간 경과 약화"이지 "모순 active set 발견"이 아님.

**L1 설계 (auto-resolve, GO)**:
- promote tx 에 **"유사 기존 active 비교 → 모순이면 supersede" 단계** 추가. **⚠️ Codex 충돌경고**: `promoteCandidatesBatchTx` 순서가 (1) exact hash, (2) `mergeTargetId` fuzzy merge, (3) insert. supersede 를 끼울 때 **merge 와 supersede 가 동일 후보를 경합하면 최신항목 삭제 역전 가능.** → **merge OR supersede 배타(절대 동시 불가)** + supersede 대상 **self-target·different-kind·expired 차단을 tx 안에서 검증.**
- 보조: 저빈도 batch sweep(같은 project+kind 클러스터, high-importance/pinned 우선 — 전량 pairwise ✕).

**L2 설계 (surface-and-ask — ⚠️ 게이트 선행)**:
- **현재 L2 ask/act 게이트는 코드 미구현**(§3.A). master-brief §3 매트릭스(constraint/commitment 모순→ask)는 **스펙만.** 지금 L2 에 constraint 써도 gate 없이 active.
- 따라서 L2 모순해소는 **A4.0(게이트 구현) 선행** 후: `fact`/`preference`→write-time auto-supersede(L1 동형), **`constraint`/`commitment`/`decision`→자동 supersede ✕, 충돌을 ask/act 게이트로 표면화**(자동선택 ✕).
- 이것이 사용자가 지적한 "각각 다르게"의 핵심: **L1=자동해소 / L2=고위험 claim 표면화-질문.** 단 L2 는 게이트부터.

**가드**: 모순판정 결정론 1차 필터(같은 subject/fact_key/kind) 후 의심쌍만. 삭제 ✕, invalidate(valid_to)·archive(merge-not-delete).

---

### 보완 ④ Truth-laundering 방어 — `REVISE (범위 축소)`

**판정**: Codex 발굴 + REVISE — *"'LLM 은 정제만'이 가장 위험. 정제도 권력."* 단 한국어 부정의 결정론 처리는 한계가 커 **"극성 보존 보장"은 거짓안전.**

**한국어 한계(Codex)**: 접미 활용형(`하지않다`)·이중부정(`빠뜨리지 않음`)·조건부(`~하지 않으면`)·양보(`~해도`)는 형태소 없이 정규식 불안정. 특히 **이중부정은 극성반전**이라 단순 부정어 존재 체크는 false-negative 양산.

**해법 (범위 축소)**:
- 목적을 **"명백한 극성 소실 reject"로 한정**(부정어가 완전히 사라지는 케이스: `사용하지 않는다`→`사용한다`). "극성 보존 보장" 표현 제거.
- 부정어(`안/못/않/없/아니/불/미/비`) 포함 claim 은 **자동통과 금지 → merge/promote 시 human review 트리거.**
- "결정론으로 잡는 케이스 / 포기하고 사람에게 넘기는 케이스" 경계를 코드 주석+테스트로 명시.

**L1 설계**: distiller 정제 결과 vs evidence excerpt 극성 비교(결정론 1차) — 소실 시 reject, 부정어 포함 시 human-review 플래그. promote tx 단계.

**L2 설계 (더 critical)**: 극성반전 치명(`X 원치 않음`→`X 원함`). **source_kind=human 은 verbatim**(LLM distill 미경유 — L2 human remember 는 cookie-only active 라 이미 미경유, 유지). `llm_candidate` 만 정제대상 → 극성체크 + (게이트 구현 후) ask 백스톱.

---

### 보완 ⑤ Correlated-evidence 위장안전 차단 — `GO (결정론)`

**판정**: Codex 발굴 — "독립 run ≥2 confidence 상향"이 독립성 정의 없으면 같은 원천 반복도 숫자만 안전.

**L1 설계**: 상향의 "독립 run" 을 코드 강제 — `memory-layer-brief §7`: *"다른 run.id + 다른 task_id 또는 다른 failure-signature."* 같은 task flaky 반복은 source_count 만, confidence 상향 ✕. evidence 에 run_id/task_id/failure-signature 기록 → SQL distinct 검사.

**L2 설계**: XPROJECT "≥2 프로젝트"가 **같은 프로젝트 fork/복제로 2가 안 되도록** project_id distinct 검사.

**가드**: "independent"=SQL distinct 환원(주관판정 ✕). web: correlated error propagation(experience-following r≈1) 직접 대응.

---

### 보완 ⑥ Manager용 on-demand 일화검색 — `REVISE / 실험·후순위`

**판정**: Codex REVISE — answer 보다 감사·원인분석 가치. raw episode 는 injection/secret/temporal noise 강함. 우리 L2 kill-test 가 answer 가치 의문.

**L1 설계**: PM 이 프로젝트 run 이력(L0, read-only) on-demand 조회. **source-label + excerpt-only + action-gate** 뒤. 행동 직접사용 ✕.
**L2 설계**: Master 가 cross-project 이력 조회(감사/복기). 같은 게이트. scope=user.
**가드**: kill-test 규율로 게이트(answer 가치 미입증 시 audit-only). **후순위.**

---

### 보완 ⑦ User-preference 저마찰 개인화 — `GO / L2 전용·게이트 후`

**판정**: Codex GO(don't overcorrect) — 모든 사용자특성에 human confirmation 요구하면 저마찰 개인화 상실.

**L1 설계**: N/A (프로젝트 스코프).
**L2 설계 (전용)**: ask/act 게이트(A4.0 구현 후) 세분화 — **저위험 반복 preference**(`한국어로 짧게`)는 `deterministic`+`preference` auto-act, **위임·민감·장기결정**은 human confirmation. Honcho식 깊은 변증법 사용자모델 복사 ✕(추론특성에 사람확인=delegation-grade 의도적 우위).

---

## 3. per-layer 구조 정책 (Codex 발굴 — 문서화 필수)

L2 의 `project_id` 가 **FK 없는 provenance** 라서 생기는 구조 이슈:

**A. L2 ask/act 게이트 = spec-only, 미구현.** `masterMemoryService`(sanitizeForStore/createMemoryItem/createCandidate) 어디에도 kind∈{constraint,commitment} 모순감지·confidence ask 분기 없음. master-brief §3 매트릭스는 스펙. → **A4.0 으로 구현 선행. 그 전까지 L2 보완③/⑦ 진행 불가.**

**B. dangling evidence (cross_project).** L1 `memory_items.project_id` 는 `FK ON DELETE CASCADE`. L2 `master_memory_items.project_id` 는 FK 없음 → L1 프로젝트 삭제 후에도 cross_project 아이템 생존, `evidence_json` 의 run_ids/task_id 가 dangling 포인터. → **정책 명시 필요**: "검증된 근거" vs "historical provenance" 분리, 또는 tombstone/redaction.

**C. XPROJECT post-delete promotion.** `master_memory_candidates` 는 scope 기반·L1 FK 없음. XPROJECT candidate 생성 후 L1 source 프로젝트 삭제돼도 candidate 잔존→promote 가능(`scanCrossProjectHashesStmt` 는 *생성 시점* 검사이지 promote 시점 아님). → **promote 시점에 원본 content_hash 의 L1 active 재검증** 추가(또는 수용 + 문서화).

**D. L2 revision = scope 단위 독립.** `master_memory_injection` PK=`(master_run_id, scope)` → `user` scope revision 변경이 `cross_project` injection 무효화 ✕(의도된 설계). → 구현자 오해 방지 위해 **"revision 은 scope 단위 독립" 명시.**

---

## 4. 횡단 안전 원칙

1. **게이트 품질이 ROI 의 전부**(web): candidate→active 판정 순수 LLM 일임 ✕. 결정론+사람검수 우선.
2. **merge-not-delete**(web 수렴): 삭제 ✕, invalidate·archive. 우리 설계와 일치.
3. **write-time 1차, batch 보조**: batch-only 안티패턴.
4. **극성/독립성은 결정론 환원**(④⑤): 단 한국어 부정의 한계 인정 — 모호하면 human review.
5. **L1 auto-resolve / L2 surface-and-ask**(L2 는 게이트 구현 후).

---

## 5. 구현 로드맵 (Codex R1 반영 — A4.0 삽입, A5 BLOCKED)

각 PR: branch → 구현 → npm test(node@22) → **Codex 교차검증(PASS까지)** → commit → PR → merge.

| PR | 보완 | 범위 | 위험 | 비고 |
|----|------|------|------|------|
| **A1** ✅ | ① 한국어 FTS | L1+L2 **two-pass exact-first + prefix-fill** + 회귀테스트 | 저(exact top-K 보존) | **merged #222**. trigram NO-GO 회피 |
| **A2** | ④+⑤ 정직성 패치 | L1 극성소실 reject·부정어 human-flag·독립성 distinct (promote tx) | 저 | ⚠️ A3 전까지 모순해소 불완전 |
| **A3** | ③ 모순해소 L1 | write-time supersede(**merge 와 배타** + self/kind/expired 가드) + 저빈도 sweep | 중 | PR3c-1 충돌주의 |
| **A4.0** | §3.A L2 게이트 | masterMemoryService 에 ask/act 게이트 **구현**(spec→code) | 중 | **A4 선행 필수** |
| **A4** | ③ 모순해소 L2 | L2 surface-and-ask(constraint/commitment) | 중 | A4.0 의존 |
| **A5.0** | ② 선행 | (a) origin_type trigger 확장 (b) tool manifest (c) R5 counter | 중 | A5 차단해소 |
| **A5** | ② 절차적 기억 | L1 distilled skill-pack candidate(human-gated) | 고 | **BLOCKED**(A5.0 후) |
| **A6** | ⑦ preference | L2 ask/act 세분화(저위험 auto-act) | 저 | A4.0 의존 |
| **A7** | ⑥ 일화검색 | L1/L2 on-demand audit(게이트 뒤) | 실험 | kill-test 게이트 |
| **A8** | §3.B/C/D | dangling evidence 정책 + post-delete 재검증 + scope revision 문서 | 저~중 | 구조 정합 |
| (defer) | ② L2 cross-project 절차 | A5 검증 후 | — | 보수영역 |

**권장 순서 (reconciled — Codex 호환성 리뷰 반영)**: **A1 ✅ merged.** 나머지는 `operator-memory-architecture.md` 의 owner-keying(`scope→(owner_type,owner_id)`) + Composer 리팩터로 **흡수**:
- **A2-④**(극성/부정어 게이트, promote tx 내부) = owner-agnostic → **standalone 가능**(원하면 지금).
- **A2-⑤**(correlated-evidence confidence·independence)·**A3**(L1 모순)·**A4.0/A4**(L2 게이트·모순)·**A8**(구조정책) = owner-coupled(project_id/scope) → **Operator 리팩터에서 owner-aware 재구현**.
- **⑥**→Raw archive tier(거버넌스 선행) / **②**→3-owner(일반절차=Profile·프로젝트고유=Workspace·사용자선호=User) 분배.
- ⚠️ 별건: `conversationService` L1/L2 직접 prepend 주입은 Composer 단일주입 불변식과 충돌 → 리팩터 때 흡수.
→ **standalone 로드맵 종료, Operator 일반화 brief 로 이관.**

---

## 6. 근거·출처

**외부 Hermes 리서치**: `/Volumes/HH/Work/SK/ContextualAI/Hermes_Benchmark/Hermes_학습·진화_메커니즘.md` §3·§4·§5·§17.5.

**웹 SOTA**(2024~26, 1차 수치): [AWM 2409.07429](https://arxiv.org/html/2409.07429v1)·[ReasoningBank 2509.25140](https://arxiv.org/html/2509.25140v1)·[EvoSkill 2603.02766](https://arxiv.org/abs/2603.02766)·[Voyager 2305.16291](https://arxiv.org/abs/2305.16291)·[Experience-Following 2505.16067](https://arxiv.org/html/2505.16067v2)·[SSGM 2603.11768](https://arxiv.org/html/2603.11768v1)·[Zep 2501.13956](https://arxiv.org/html/2501.13956v1)·[Mem0 2504.19413](https://arxiv.org/html/2504.19413v1)·[Consolidation](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation)·[SQLite FTS5](https://www.sqlite.org/fts5.html).

**A1 경험 검증(실측, node@22+better-sqlite3)**: `"메모리"`→`메모리를` miss / `"메모리"*`(prefix)→매칭 / trigram 2자(`회의`) miss·BM25 85만배 스케일차. → prefix-first 채택, trigram defer.

**Codex 적대 교차리뷰 R1 (실측 기반)**: ① trigram BM25 union NO-GO(→prefix 전환) ② L2 게이트 미구현(→A4.0) ③ 절차적 기억 BLOCKED(선행 3건) ④ 극성 결정론 한계(→범위축소) ⑤ 로드맵 A4.0 삽입·A5 재분류 ⑥ per-layer 구조 3건(dangling/post-delete/scope revision).

---

## 7. 다음 단계

본 brief v0.2 기준 **A1(prefix 한국어 FTS)부터 phase 체인.** 각 PR Codex 교차검증. L2 는 governed top-K de-scope·ask/act 게이트(A4.0) 전제. heavy graph 재도입 ✕.
