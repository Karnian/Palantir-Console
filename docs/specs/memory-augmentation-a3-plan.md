# A3 L1 모순해소 (write-time supersede) — ⛔ DEFER 확정 (Codex NO-GO, 2026-06-23)

> 상위: `memory-augmentation-brief.md` 보완③(능동적 모순/staleness 해소) + `memory-layer-brief.md` §3.
> owner-agnostic standalone. A2-④-a(#247) 후속, A2-⑤ DEFER 다음.

## ⛔ 결론: DEFER (구현 안 함). Codex NO-GO(Option A) — 모순처리는 Composer 로 이관.
**Codex 적대 plan-review = Option A auto-supersede NO-GO, Option C(DEFER) 채택.** 근거:
1. **BLOCKER**: Option A 는 방어가능한 writer 검증이 없음. Jaccard 는 sanity floor 지 semantic 증명 아님(정반대 near-dup 도 통과 — `memory-fuzzy.test.js` 가 이미 계약으로 박음). merge 가 허용된 유일 이유 = **비파괴**. 같은 약한 LLM 신호를 `status='superseded'`(파괴적 archive)로 전환은 부당.
2. **BLOCKER**: fact supersede 는 keyed(같은 owner+fact_key+hash변경)라 정당. 일반 `convention|pitfall|heuristic|constraint` 은 subject/value schema 없어 "같은 주제·반대 결론" writer-checkable 아님.
3. **"최신 ≠ 옳음"**(Q4): brief 의 `L1=auto-resolve` 전제가 **too broad** — 유효 영역은 **structured fact(이미 `upsertFact` 로 완비)뿐**. 자유텍스트 lesson 은 non-destructive 여야. 모순 2개는 **둘 다 두고 PM/Composer 가 주입 시 맥락 해소**가 더 안전(잘못 supersede=지식 소실 >> 모순 미해소=가시·회복가능).
4. A2-④ polarity 는 모순 oracle 아님(R4 단일부정 소실만). Option B(flag-only)는 L1 review UI 부재로 소비처 없음.

### Codex Q5 전략 진단 (시리즈 방향 — 중요)
*"A2/A3 micro-slice 가 ROI 낮은 근본 이유 = old L1 writer 안에서 약한 semantics 로 truth 를 추론하려 하기 때문."* 더 높은 레버리지 순서:
1. **Operator/owner cleanup + Composer 작업 먼저.**
2. **conflict 처리를 Composer 의 traceable `conflicted/suppressed` 결정으로**(파괴적 write-time archive ✕) — 이미 A2-4a 가 read-time arbitration 으로 함.
3. A8 구조정책을 그 path 에 fold.
4. A4.0 ask/act 는 User/Profile constraint 가 실제 주입될 때만.
5. A5 절차적기억은 manifest/R5/human-gated 선행 전까지 blocked.

**→ 메모리 보완 A2/A3 micro-slice 트랙 종료. 모순/staleness 는 Composer(P-A2 연장) 또는 Operator(P-B)로 이관.**

> 아래는 검토 당시 분석 기록(보존). 구현 결정 아님.

---

## 0. 조사 결과 (코드 직접 확인)

**fact_key 모순해소는 이미 완비**: `upsertFact` + `supersedeFactStmt`(memoryService.js:388) — 같은 `fact_key`·다른 `content_hash` → 기존 active `status='superseded', superseded_by=newId, valid_to=now` + 새 active insert, **한 tx + revision bump**. R6(env fact) + R4 human fact(`origin='human'`) 둘 다 이 경로. `superseded_by` 컬럼·`valid_to`·`status='superseded'` 인프라 존재.

**→ A3가 추가할 건 `fact_key 없는 일반 메모리`(convention/pitfall/heuristic/constraint) 모순해소뿐.** 이게 A3의 실제 scope.

**promote tx 현 순서**(memoryService.js): (1) sanitize → (2) [A2-④-a R4 극성 gate] → (3) exact content_hash merge → (4) distiller `mergeTargetId` fuzzy merge(Jaccard floor 재검증) → (5) admission/insert. merge는 **누적**(source_count++, content/confidence/valid_to 불변, **비파괴**).

---

## 1. 근본 난점 (KILL 신호 — Codex가 판정)

1. **일반 메모리 "모순" 결정론 판정 불가.** fact_key 있으면 "같은 키·다른 값=모순"이 결정론(이미 됨). 일반 lesson은 **자유 텍스트** — "같은 주제·반대 결론"을 코드로 판정 불가. 결국 distiller(LLM)에 의존해야 함(PR3c-1 mergeTargetId처럼 supersedeTargetId 제안). 단 writer 재검증이 빈약: merge는 Jaccard floor로 "중복" sanity 가능하나, **"모순"은 writer가 재검증할 결정론 기준이 없음**(높은 overlap+극성반대? A2-④ polarity 재활용? 신뢰 빈약).
2. **"최신 ≠ 옳음"** (fact와 결정적 차이). fact 는 env 가 변하므로 최신이 옳다(supersede 정당). 일반 lesson 은 새 lesson 이 기존을 뒤집는다고 **기존이 틀린 게 아님** — 둘 다 맥락-의존적으로 옳을 수 있음. promote 시점에 "뭐가 옳은지" 모름. auto-supersede 가 옳은 지식을 archive 할 위험.
3. **supersede = 파괴적**(기존 active → archived/superseded = 주입에서 제거). merge(누적·UI 회복 가능)보다 위험. distiller 오판 시 멀쩡한 메모리 소실. PR3c-1 이 merge 조차 confidence 안 올리는 보수성을 지킨 이유와 정면 충돌.
4. **PR3c-1 mergeTargetId 와 경합**(brief 명시): merge 와 supersede 가 같은 후보를 경합하면 순서 역전으로 최신항목 삭제 가능 → **merge XOR supersede 배타** + self/kind/expired 가드 필요(복잡도↑).

---

## 2. 설계 옵션 (Codex 택1 또는 KILL)

### Option A — distiller supersedeTargetId + writer 재검증 (brief write-time)
distiller 가 "이 새 lesson 이 기존 active X 와 모순"이면 `supersedeTargetId` 제안 → promote 가 재검증(active/same project/same kind + **모순 재검증?**) → 기존 supersede + 새 insert. merge XOR supersede 배타. **치명 약점**: writer 의 "모순" 재검증 기준이 빈약(§1.1) + 파괴적(§1.3) + 최신≠옳음(§1.2).

### Option B — 모순 탐지 → flag(human review), supersede ✕ (비파괴)
distiller/batch 가 모순 의심쌍 발견 → **archive 안 하고** `memory:contradiction_detected` 이벤트 + (PR4 UI 있으면) 표면화. 둘 다 active 유지, human 이 판단. 비파괴=안전. 단 **L1 candidate/memory review UI 부재**(A2-④-a 에서 확인 — rejected 복구 경로 없음) → flag 소비처 없음 = 관측만.

### Option C — DEFER / KILL
fact_key 모순해소 이미 됨 + 일반 메모리는 "최신≠옳음"이라 auto-supersede 부적합 + 파괴적 + 결정론 판정 불가. **모순되는 두 lesson 은 supersede 보다 "둘 다 두고 PM 이 판단"이 더 안전**(주입 시 PM 이 맥락으로 해소). A2-⑤ 처럼 순비용 가능.

---

## 3. ROI / 위험 평가
- **ROI**: 일반 메모리 모순이 같은 프로젝트에서 실제 얼마나 자주? distiller 가 반대 lesson 생성 빈도 불명(A2-④/⑤ 처럼 좁을 수 있음). 모순 2개 동시 주입 시 PM 혼란은 실제 문제이나, **PM 이 맥락으로 해소 가능**(주입은 양쪽 다 보임).
- **위험**: supersede=파괴적 + distiller 오판 + 최신≠옳음 → **A2-⑤보다 위험 큼**(A2-⑤는 confidence 상향=2차효과, A3는 메모리 archive=1차 파괴).
- **비대칭**: 잘못 supersede(옳은 지식 소실) >> 모순 미해소(PM 이 맥락 해소). 보수적이면 안 하는 게 나을 수 있음.

## 4. Codex 검토 질문 (실현성·KILL 1순위)
- **Q1 (핵심)**: fact_key 모순해소가 이미 됐고, 일반 메모리는 "최신≠옳음"+파괴적 supersede+결정론 판정불가다. A3(일반 메모리 auto-supersede)가 **실현 가능하고 가치 있나, 아니면 Option C(DEFER/KILL)가 정직한가?** "모순되는 두 lesson 은 supersede 말고 둘 다 두고 PM 이 주입 시 해소"가 더 안전하지 않나?
- **Q2**: Option A 강행 시 writer 가 "모순"을 재검증할 결정론 기준이 있나(merge 의 Jaccard floor 같은)? 없으면 distiller 단독 신뢰 = 파괴적 오판 위험. A2-④ polarity 재활용이 모순 재검증에 쓸만한가?
- **Q3**: Option B(flag-only, 비파괴)가 절충인가, 아니면 소비처(L1 review UI) 없어 무의미한가? L1 candidate/memory review UI 부재가 A3/A2-④-b 공통 블로커 아닌가?
- **Q4**: brief 가 L1=auto-resolve / L2=surface-and-ask 로 갈랐는데, 위 분석상 **일반 메모리 L1 도 auto-resolve 부적합**(최신≠옳음)이면 brief 전제가 틀린 것 아닌가? fact_key 모순(이미 됨)만이 L1 auto-resolve 의 정당 영역 아닌가?
- **Q5**: A2-⑤ DEFER + A3 도 DEFER 라면, 메모리 보완 A2/A3 시리즈 자체가 ROI 낮은 패턴인가? 남은 것 중 실효적인 게 있나(A4.0 L2 게이트 / A8 구조정책), 아니면 [[Operator P-B]] 같은 다른 트랙이 나은가?
