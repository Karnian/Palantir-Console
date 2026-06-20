# 메모리 Composer 완성 — 실행 계획 (v1.0 APPROVED, Codex R3 GO)

> 목표(사용자 골): **burn-in → COMPOSER=1 → 다중 owner 주입 → old ledger 제거**.
> 워크플로우: 계획 → Codex 교차검증 반복 → 최종 확정 → Codex 구현 + Claude 실시간 교차검증.
> **수렴: R1 NO-GO(4B+5S) → R2 REVISE(closed 6) → R3 GO(4 NIT).** B4/S5/S9/B3 전부 closed.
> v0.2 → v0.3: Codex R2 반영. v0.3 → v1.0: Codex R3 GO + NIT 1~4 반영. 작성 2026-06-20.
> 상위 spec: `operator-generalization-brief.md` v1.2 (§4 ledger 3중계약, §9 O6/O13 lock).

---

## 0. 발견 처리 현황 (R1 + R2)

| # | 내용 | R2 상태 | v0.3 처리 |
|---|---|---|---|
| B1 | L1 owner-unique 부재 | resolved | §S5-STORAGE (items=index drop / candidates=table rebuild) |
| B2 | A2-4→slice5 순서역전 | resolved | S5-LEDGER를 A2-4 前 |
| B3 | 1:1 binding 미강제 | **overclaim 정정** | "NEW 안전" 철회 — NEW는 위반 시 **교차오염**. fail-closed assert를 memory read **前** (§Phase 0c) |
| B4 | commit 비원자 | **still-open→fix** | ledger `commitAccepted(comp,opts,legacyFn)` 단일 tx (§Phase 0a) |
| S5 | flip 재주입 | **still-open→fix** | event+owner_state **완전** seeding (§Phase 2) |
| S6 | shadow gate 사각 | resolved | 런타임 gate 비교기 (§Phase 1b) |
| S7 | A2-4 precedence 미구현 | resolved | conflict/dedup/budget+edge 구현 후 활성 (§Phase 3) |
| S8 | taskId=null 계약 | resolved | manager slot=(run,conv) identity 명문화 (§Phase 1d) |
| S9 | 무한 무신호 재시도 | **still-open→fix** | 관측(event+counter+log) 우선, backoff deferred (§Phase 0b, 근거) |
| N10 | revision=0 테스트 | resolved | §Phase 1c |
| R2-5 | S5-STORAGE L2 누락+table-rebuild | new | §S5-STORAGE |
| R2-6 | caller blast (routes/distill) | new | §S5-STORAGE (public shim 유지) |
| R2-7 | A2-4 conflict 최소범위 느슨 | new | §Phase 3 (deterministic dedup/conflict/budget) |

---

## 1. 현재 상태 (코드 검증됨)

- `memoryComposer.compose()` — owner 리스트, 단일 byte-equivalent, 다중은 plain `join('\n\n')` (cross-owner precedence 미적용). never-throws.
- `compositionLedger` — 3-part(038) + shouldCompose(revision-only) + record(tx)/accept(별 UPDATE). never-throws.
- `conversationService` — PM/Top flag-gated. **commit 비원자**: `record()`(tx) → `accept()`(별 UPDATE, 반환 무시) → `recordInjection()`(old, 별 write), 한 try/catch. `createConversationService`는 `db` 미주입(`compositionLedger`만).
- `composerParityCounter` — app 객체만, route 미노출.
- owner 와이어링: PM=`[workspace]` / Top=`[user]` 단일 (O6 lock).

**검증 사실(R1+R2)**: L1 `memory_items` unique=`(project_id,*)` only(025), owner-unique 부재; L2 items owner-unique 有(034). L1 candidate `ON CONFLICT(rule,project_id,dedup_key)`(669)·L2 `(rule,scope,dedup_key)`(177) — **candidate unique는 table-level 제약**(026:21/031:19) → drop은 **table rebuild** 필요. memory_items unique는 별 INDEX(025:42,44) → index drop. `resolveOwnerFromProject` 9 callsite + 외부 caller(`routes/memory.js:79,176`, `memoryDistillService.js:41`). revision/injection ON CONFLICT(`project_id`/`scope`/run) = **provenance-keyed by design → 불변**.

---

## 2. Gate cadence 등가성 (단일-owner)

`shouldCompose ≡ shouldInject`: prior 없음 || prior rev < cur rev → 주입. B4 수정 후 양 ledger lockstep 보장.
- **flip 경계(S5)**: OFF→ON 시 NEW에 prior accepted 없음 → run마다 재주입. **완전 seeding으로 제거**(§Phase 2).
- **B3(정정)**: 1:1 위반 시 NEW는 **틀린 project 메모리를 live run에 주입**(교차오염) — OLD(누락)보다 **나쁨**. → flip 무관하게 **memory read 前 fail-closed binding assert** 필수(§Phase 0c).

---

## 3. Phase 분해

### Phase 0 — 사전 정합성 수정 【자율, 최우선 — flip 전제, conversationService 단독 점유】
- **0a (B4) 원자 commit**: `compositionLedger.commitAccepted(composition, opts, legacyWriteFn)` 추가 — **단일 `db.transaction`** 내에서 event(status='accepted', accepted_at=now; record+accept 병합) + owner_state + edges 삽입 후 **`legacyWriteFn()` 호출**(같은 db 핸들 → tx 합류). 실패 시 throw(전체 rollback = 양 ledger 불발산). conversationService는 `legacyWriteFn = () => memoryService.recordInjection(...)` 전달, 바깥 try/catch가 annotate-only 처리. **nested-tx 회피**(기존 record()/accept() 미사용). PM·Top 양쪽. 실패주입 테스트(legacyFn throw → composition row도 rollback 단언).
  > R2 Q1 응답: legacy write를 ledger tx 콜백으로 **內부화** → "old write가 boundary 밖" 우려 해소. ledger가 db 핸들 보유(closure)라 conversationService에 db 주입 불요.
- **0b (S9) 실패 관측**: gate가 compose:true였는데 `compose()`가 `composition===null`(outer catch) 반환 시 → `memory:composer_failed` 이벤트 + counter + per-occurrence log. **backoff/rejected-marker는 deferred**(근거: 실패 경로는 adapter 자체 try/catch 밑의 rare orchestration bug; 재시도는 read-only·cheap·무주입. 관측이 본질, 억제는 YAGNI). NIT#3: systematic 버그 시 turn당 1 log → prod 관측 위생용 rate-limit은 향후 과제(deferred).
- **0c (B3) binding assert**: send 경계에서 run fetch 직후, **`getRevision()` 호출 前**, `run.conversation_id===conversationId` && `run.manager_layer` 일치 + **`run.is_manager`(NIT#4 defense-in-depth)** fail-closed 검사(불일치 시 502, memory read 안 함). 교차오염 방지.

### Phase 1 — Burn-in hardening 【자율, Phase 0 後 (conversationService 공유)】
- **1a (R2)**: `GET /api/memory/composer-parity` read-only → counter 스냅샷. auth 보호.
- **1b (S6)**: 런타임 **gate 비교기** — 매 turn(old-skip 포함) OLD `shouldInject` vs NEW `shouldCompose` 가상결정(read-only) 비교 → `memory:gate_parity` emit. old-skip/new-inject 사각 가시화.
- **1c (S6/N10)**: synthetic 하니스(test) — 매트릭스: 빈/단일/다수/budget-trunc/특수문자·한글/multi-rev/**rev=0**/prior-NULL/empty-block/ledger-실패. 단언: block byte-parity, gate cadence parity, old-skip↔new-inject 발산 0, seeding 후 flip 재주입 0.
- **1d (S8)**: ledger 계약에 "manager slot = (run, conversation) identity, taskId=null by-design" 명문화 + brief §4 각주.

### Phase 2 — COMPOSER=1 활성화 【결정: prod flip + 완전 seeding】
- **flip seeding (S5)**: flip 시 각 active manager run(top + 각 pm)에 대해 old ledger의 last injected_revision 읽어 **synthetic accepted `memory_composition_events` row + 각 owner의 `memory_composition_owner_state` row**(revision=old값, edges 빈=mode 'seed') 작성. 멱등(이미 composition 있으면 skip). → shouldCompose가 prior 인식 → 재주입 0(rev 미변).
  > R2 Q2: owner_state까지 써야 priorMap 비지 않음(`compositionLedger.js:293/305`). revision-only seeding은 불충분. 대안=shouldCompose가 old ledger lazy-fallback(transition 한정, S5-LEDGER서 제거) — Codex 선호 확인.
- 코드 default OFF 유지, rollback 가능. flip/rollback 런북. **NIT#1: 런북이 COMPOSER=1 전에 모든 active manager run이 seed됐는지 명시 검증**(미seed run은 첫 turn 1회 재주입 후 정상화 — catastrophic 아니나 검증 권장).

### S5-STORAGE — P-A1 owner-keying cleanup 【자율, 독립 병렬 (memoryService/masterMemoryService/routes 점유, conversationService 무관)】
1. L1 `memory_items` owner-unique **INDEX** 추가 `(owner_type,owner_id,content_hash)`·`(owner_type,owner_id,fact_key)` partial active.
2. L1·L2 candidate `ON CONFLICT` → owner-keyed. **candidate unique=table-level 제약(026:21/031:19) → table rebuild migration**(022 mcp 패턴 — **NIT#2: 명시 DDL `CREATE TABLE`/`INSERT SELECT`/`DROP`/`RENAME`+인덱스 재생성; CTAS 금지**(제약/CHECK/인덱스 silent drop). startup migration 경로라 hot-lock 위험 無). L2 insert에 owner-key preflight + UNIQUE-race catch(`masterMemoryService.js:586`).
3. resolveOwnerFromProject: **storage-internal 9 callsite는 owner 직접 전달**. **public 경계(routes/memory.js, masterMemory.js, memoryDistillService.js)는 project/scope-keyed shim 유지**(boundary 1곳서 normalize) — 전면 제거 아님(R2-6).
4. old `(project_id,*)`·`(scope,*)` STORAGE unique drop(items=DROP INDEX / candidates=rebuild로 자연 제거).
5. 교차오염 음성 테스트(owner 간 dedup 누수 0).
⚠️ revision/injection ON CONFLICT(provenance-keyed) **불변**.

### S5-LEDGER — old injection ledger retire 【자율, COMPOSER=1 soak 後 · A2-4 前(B2)】
- `pm_memory_injection`/`master_memory_injection` dual-write 제거 + OLD 인라인 주입 `else` 브랜치 제거 + (1b gate 비교기의 OLD 의존 제거) + 구 테이블 drop. point of no return.

### Phase 3 — A2-4 다중 owner 주입 【결정 D1/D2 + 자율, S5-LEDGER 後】
**선행 결정**: D1 coder PM이 User 읽나(O6=NO) / D2 Top이 cross_project(deferred=NO) / D3 precedence(O13 lock).
**구현(S7+R2-7)**: composer cross-owner **deterministic dedup**(같은 fact_key 다owner) + **conflict 처리**(precedence 낮은 중복 suppress + `conflicted` edge+reason 기록, 모순 active claim surface) + **budget arbitration**(owner cap+전체 hard budget) + precedence(constraint>fact>heuristic+mode-aware). plain join 대체. 신규 sub-flag `PALANTIR_MEMORY_MULTI_OWNER`. 테스트: 동일 fact_key 모순값/budget 중재/polarity-flag. **precedence·conflict 미구현 상태 활성 금지.** polarity 자체는 write/promote gate(A2-④) 영역.

---

## 4. 실행 순서 + 병렬성 (R2 Q6)

Phase 0·1b 모두 conversationService 점유 → **순차**. S5-STORAGE는 다른 파일 → **병렬 가능**. migration 번호 사전 조율.
1. **Phase 0** (0a/0b/0c) — 자율, 최우선. 【지금】
2. **Phase 1** (1a/1b/1c/1d) — Phase 0 後. 【지금】
3. **S5-STORAGE** — 병렬 트랙(migration 039~). 【지금】
4. (사용자) **Phase 2 flip + seeding**.
5. **S5-LEDGER** — soak 後, A2-4 前.
6. (사용자 D1/D2) **Phase 3 A2-4**.

> **자율 즉시 = Phase 0 → Phase 1 (순차) ∥ S5-STORAGE (병렬).** athena team monitor flaky 이력 → 구현은 agent-olympus:ask codex(안정), 병렬은 PR 단위로.

---

## 5. Codex R3 질문

1. **0a commitAccepted**: legacy write를 ledger db.transaction 콜백으로 내부화하는 패턴이 atomicity 만족 + nested-tx 회피로 정확한가? record+accept 병합(직접 status='accepted' insert)이 peek-then-commit discipline을 깨나? (commit 단계는 send 성공 後라 항상 accept 의도)
2. **S5 seeding vs lazy-fallback**: 완전 seeding(event+owner_state) vs shouldCompose의 old-ledger lazy-fallback(transition 한정) 중 어느 게 더 안전/단순한가?
3. **0b S9 범위**: 관측-우선(event+counter+log) + backoff deferred가 수용 가능한가, 아니면 rare bug-path여도 DB-backed 억제가 필수인가?
4. **S5-STORAGE rebuild 안전**: candidate table rebuild migration 중 동시 쓰기 차단(tx 내 rebuild)이 충분한가? L1 owner_id=project_id라 backfill 무손실 확인?
5. **0c assert 위치**: getRevision 前 fail-closed가 교차오염 완전 차단인가? worker run(is_manager=0) 경로엔 영향 없나?
6. 남은 still-open(B4/S5/S9/B3)이 v0.3서 진짜 닫혔나? 신규 위험?
