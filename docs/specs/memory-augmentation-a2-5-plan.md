# A2-⑤ correlated-evidence 독립성 차단 — ⛔ DEFER 확정 (Codex NO-GO, 2026-06-23)

> 상위: `memory-augmentation-brief.md` 보완⑤(Correlated-evidence 위장안전, brief 판정 `GO 결정론`) + `memory-layer-brief.md` §7 + PR3c-2(cross-run confidence).
> owner-agnostic standalone. A2-④-a(#247) 후속.

## ⛔ 결론: DEFER (구현 안 함). 사용자 승인(2026-06-23) — 다음은 A3.
**Codex 적대 plan-review = Option A NO-GO / Option C(DEFER) 채택.** 근거:
1. **confidence가 1차 주입 랭킹에 안 쓰임**(retrieve ORDER BY = bm25/importance/recency). cross-run 상향의 효과는 cap eviction 보존 + composer arbitration tiebreak **2차 효과뿐** — 더 자주/먼저 주입되게 못 함. brief "GO"는 confidence 영향력 과대평가(retrieve 랭킹에 쓰인다고 가정).
2. **PR3c-1 안전가정 훼손**: merge confidence 불변 = fuzzy merge 오판이 UI 회복 가능하기 때문. 상향하면 안전판 약화 + composer selection 변경 → **revision bump 재설계 필요**(현 merge는 content 불변이라 revision 미상승).
3. **L2 ⑤는 이미 충족**: `scanCrossProjectHashesStmt` 가 이미 `HAVING COUNT(DISTINCT project_id) >= 2`. 추가 작업 0.
4. Codex: *"메모리 노출 품질 개선보다 잘못 병합된 기억을 더 오래 살아남게 하는 표면을 더 크게 연다."* = 순비용.
- **재개 조건**: confidence 가 retrieve 1차 랭킹에 쓰이게 되거나(랭킹 정책 변경), poisoning 관측상 correlated 위장상향이 실제 문제로 드러나면 Option A(보수: exact-only merge·ceiling 0.8·step 0.15·revision 재설계 동반) 재검토.

> 아래는 검토 당시 분석 기록(보존). 구현 결정 아님.

---

## 0. 조사 결과 (계획 전제 — 코드 직접 확인)

**A2-⑤의 본질**: "독립 run ≥2면 memory confidence 상향"을 도입하되, 그 "독립"을 SQL distinct로 강제해 같은 원천 반복(correlated)이 숫자만 안전해지는 걸 막는다. 즉 **cross-run confidence 상향 기능 도입 + gaming 방지**의 묶음. 상향을 안 하면 ⑤ 자체가 무의미(올라가는 게 없으면 위장상향도 없음).

**핵심 발견 — confidence의 실제 영향 표면 (좁음)**:
1. **retrieve 1차 랭킹(주입할 K개 선정) = confidence 안 씀.** `ftsRetrieveStmt` `ORDER BY bm25 ASC, importance DESC, updated_at DESC` / `fallbackRetrieveStmt` `ORDER BY importance DESC, updated_at DESC` (memoryService.js:237/253). → **confidence 올려도 더 자주/먼저 주입되지 않는다.**
2. confidence가 쓰이는 곳 = **(a) admission/eviction** `score = confidence*importance`(memoryService.js:865, masterMemoryService.js:81) — cap 꽉 찼을 때 보존 우선순위, **(b) composer multi-owner arbitration tiebreak** `confidenceDelta`(memoryComposer.js:93, kind>owner>origin>**confidence**>importance, prod `PALANTIR_MEMORY_MULTI_OWNER=1`) — 충돌/동급 시 winner.
3. 즉 cross-run 상향의 효과 = **2차 효과만**(cap eviction 보존 + 충돌 tiebreak). **1차 노출(주입 여부/순서)엔 영향 0.**

**L2 부분은 이미 구현됨**: brief ⑤-L2("같은 프로젝트 fork로 ≥2 안 되게 project_id distinct")는 `scanCrossProjectHashesStmt` 가 이미 `HAVING COUNT(DISTINCT project_id) >= 2`(masterMemoryService.js:213-220). **XPROJECT candidate 생성이 이미 distinct project_id 기준.** → A2-⑤의 L2 작업은 **사실상 완료**. 남은 미구현분 = **L1 cross-run confidence 상향**뿐.

**현재 merge는 confidence 불변**(PR3c-1 lock): promote tx 의 exact/fuzzy merge 가 `source_count++` + evidence append 만, `confidence` 안 올림(memoryService.js:101 "Never raises confidence", :1030 "cross-run confidence is a later slice"). A2-⑤ = 이 lock 을 **조건부로** 푸는 것.

---

## 1. 위협 모델
distiller 가 같은 lesson 을 여러 candidate 에서 생성 → exact/fuzzy merge 로 `source_count` 누적. 만약 "source_count ≥N → confidence 상향" 같은 순진한 규칙을 넣으면, **같은 task 의 flaky 재시도**(상관된 증거)가 source_count 를 부풀려 confidence 가 거짓 상향된다(experience-following correlated error r≈1). A2-⑤ = 상향을 **독립 run 에만** 허용(SQL distinct 환원, 주관판정 ✕).

---

## 2. 설계 옵션 (Codex 가 택1 또는 KILL)

### Option A — brief 대로 L1 cross-run 상향 도입 (보수적)
- **독립성 정의**(brief §7): `다른 run.id AND 다른 task_id`. **failure-signature 는 제외**(현 evidence/인프라에 없음, R1b 전용, 추가 = 무거움. task_id distinct 가 더 보수적=상향 덜 함=안전). brief 의 "OR failure-signature" 분기 미구현 잔여로 명시.
- **evidence 확장**: 현 `task_id`(단일) → `task_ids[]` 누적(migration 0, JSON 필드). 독립 판정 = 새 candidate 의 `run_id ∉ evidence.run_ids` AND `task_id ∉ evidence.task_ids`.
- **상향 공식**(보수): 독립 merge 일 때만 `confidence = min(CEIL, confidence + (CEIL - confidence) * STEP)` 점근. 단일 run ceiling 0.7(현 `DEFAULT_CONFIDENCE_CEILING`) 유지, **독립 재관측용 별도 상한 `INDEPENDENT_CEILING`(예 0.9)**. STEP 작게(예 0.34 → 0.7→0.77→0.81…). correlated(같은 run/task) merge = `source_count++` 만, confidence 불변(현 동작).
- **위치**: promote tx merge 분기(exact+fuzzy 공통). `mergeItemByIdStmt` 에 `confidence` update 추가(현 `source_count++`+evidence 만).
- **효과**: cap eviction 보존 + composer arbitration tiebreak. **1차 주입 무영향**(정직).

### Option B — 상향 없이 "독립 source 추적"만
evidence 에 `distinct_run_ids[]`/`distinct_task_ids[]` 만 누적(상향 ✕). 관측·향후 근거. 위험 0, 효과도 관측만.

### Option C — DEFER / KILL
confidence 가 1차 랭킹 무관(2차 효과만) + poisoning 표면 추가 + L2 는 이미 됨 → ROI 대비 비용. composer 안정화·다른 보완(A3/P-B) 우선. **brief 의 GO 는 confidence 영향력을 과대평가했을 수 있음**(retrieve 랭킹에 쓰인다고 가정).

---

## 3. 권장 + 근거
- **권장: Option A (보수적 도입)** 단, ROI 좁음을 인정. 근거: composer arbitration tiebreak(prod ON)에서 "독립 재관측으로 신뢰 높아진 메모리가 충돌 시 이김"은 실의미. 비용 작음(merge 분기 ~15줄 + evidence task_ids[]). 독립성 distinct 로 gaming 차단(brief 핵심).
- **단 Codex 가 C(DEFER) 판정하면 수용** — 1차 랭킹 무영향이 결정적이면 도입이 순(純)비용.

---

## 4. 변경 파일 (Option A 채택 시)
- `server/services/memoryService.js`: `buildPromotionEvidence`/`mergeEvidence` 에 `task_ids[]` 누적(현 단일 `task_id` 호환 유지) + promote tx merge 분기에 독립성 판정 + confidence 상향(`mergeItemByIdStmt` 에 confidence SET 추가 or 별도 stmt) + 상수(`INDEPENDENT_CEILING`/`STEP`).
- `server/tests/`: 독립 run merge→상향 / 같은 run·task merge→불변 / ceiling cap / exact+fuzzy 양 경로 / byte-equiv(단일 promote 불변) / evidence task_ids[] 누적·legacy 단일 task_id 호환.
- (L2 XPROJECT distinct = 이미 구현, 작업 없음. 문서만 명시.)

## 5. Codex 검토 질문 (1순위 = KILL 여부)
- **Q1 (핵심)**: confidence 가 **retrieve 1차 랭킹에 안 쓰이고**(bm25/importance/recency만) admission/eviction + composer tiebreak 2차 효과만이다. 이 상태에서 cross-run 상향 도입이 ROI 있나, 아니면 **Option C(DEFER/KILL)** 가 정직한가? brief 의 "GO"가 confidence 영향력 과대평가였나?
- **Q2**: Option A 채택 시 독립성 = `run.id distinct AND task_id distinct` (failure-signature 제외) 적절? task_id distinct 만으로 correlated flaky 를 충분히 거르나?
- **Q3**: 상향 공식(점근 + INDEPENDENT_CEILING 0.9 + 작은 STEP)이 poisoning 표면을 과하게 넓히나? 잘못된 메모리가 우연히 독립 2회 관측되면 끈질겨지는 위험 vs 정당한 신뢰. ceiling/STEP 권고치?
- **Q4**: evidence `task_id`(단일)→`task_ids[]` 확장이 기존 evidence 소비처(provenance UI, mergeEvidence, buildPromotionEvidence) 호환 깨나? migration 0 가정 맞나?
- **Q5**: L2 XPROJECT 가 이미 distinct project_id 인 게 brief ⑤-L2 를 충족한다는 판단 맞나? L2 에 추가로 할 게 있나?
