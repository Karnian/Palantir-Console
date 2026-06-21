# A2-4 다중 owner 주입 — 계획 (v0.2, Codex R1 반영·설계 lock)

> 사용자 결정 (2026-06-21): **D1=YES**(coder PM이 User 읽기), **D2=YES**(cross_project→Top). O6 reversal + cross_project→Top 활성.
> Codex R1: REVISE — A2-4a plausible / A2-4b는 D2 모델 lock 전 NO-GO. R1이 전 설계 결정 lock(아래).
> 상위: `operator-generalization-brief.md` §5/O13, `memory-composer-completion-plan.md`.

---

## 1. owner 모델
- **D1 (PM+User)**: PM owners = `[{user,user,prov:user}, {workspace,projectId}]` (User 먼저=상위 precedence). **distinct owners** → owner_state PK 충돌 無.
- **D2 (Top+cross_project)**: Top = **1 composition event, 2 provenance entry** `[{user,user,prov:user}, {user,user,prov:cross_project}]`. same owner 2 provenance → **Option A 필요**.

## 2. 설계 lock (Codex R1)

### precedence (Q1)
- **중앙 comparator를 렌더 前 실행** (display 순서가 아니라 conflict 중재가 핵심): `kindRank > owner/provenance rank > origin/confidence/importance > retrieval rank`. **kind가 owner보다 먼저** — Workspace constraint > User fact (O13). 같은 kind면 owner tiebreak(User>Workspace).
- 표시 = **owner-grouped 블록**(헤더 보존), 블록 순서 = owner precedence.
- ⚠️ `kindRank` **확장 필수**: 현 `constraint/fact/heuristic`만 → L2의 `preference/commitment/decision/pattern` 추가. comparator에서 **실제 사용**(현재 정의-미적용).

### conflict (Q2)
- 같은 fact_key·다른 값 → **loser를 프롬프트에서 suppress + `conflicted` edge 기록**(`reason: winner_id=<id> owner=<owner> fact_key=<key>`, raw content 금지). **in-prompt 마커 금지**(모델에 모순 떠넘김). A2-④(극성)는 write/promote 경로 — A2-4(read-time 중재)와 별개, 메모리 mutate 금지.

### dedup 키 (Q4)
- fact_key non-null → fact_key 기준 / fact_key null → content_hash 기준 (글로벌 OR 아님).
- A(fact_key match, 값 상이)=CONFLICT / B(fact_key null, content_hash 동일)=DEDUP / C(동일)=DEDUP. **buildBlock에 넘길 rows 기준 dedup**(emitted string 아님).

### budget (Q6)
- 상위 precedence 보호, 하위부터 truncate. **owner-type별 명시 cap**(total/N 금지). cross_project cap 작게(예 total×0.25). conflict/dedup/precedence sort **後** prefix-trunc. suppression은 **ledger 기록**.

### D2 gate = **Option A** (Q3)
- `memory_composition_owner_state` PK에 `provenance_key` 추가(rebuild, **NOT NULL DEFAULT ''** — SQLite NULL!=NULL PK 함정). gate query(`stmtGetLastAcceptedOwnerStates`) provenance 선택. gate 키 = `owner_type:owner_id:provenance_key`. `currentOwnerRevisions` provenance 포함. `buildUserAdapter.getRevision` provenance-aware(현 항상 'user'). `owner_vector_hash`에 provenance 포함(현 `[owner_type,owner_id]`만 → fingerprint 불안정). **scope revision은 분리 유지** → BLOCKER 재발 無(cross_project rev는 cross_project 포함 Top composition에만 전달).

### Q7 위험
- **D2 storm**: cross_project active-set 변경마다 Top 재주입 → cross_project 별도 작은 limit/budget + **selection-hash skip**(같은 id-set이면 rev 올라도 재주입 skip).
- **중복 헤더**: `masterMemoryService.buildInjectionBlock`이 `## User Memory` 하드코딩 → cross_project 별도 헤더/provenance-aware block builder.
- **removed-owner 사각**: gate가 new owner는 감지하나 removed는 못 함 → gate에 owner-set equality 또는 policy-version 포함.
- **single-owner byte-equiv**: 플래그 OFF 시 kind sort/budget/dedup 전부 미적용(현 단일-owner 경로 분리 유지).

## 3. 슬라이싱
### A2-4a (D1, PM+User) — 먼저
- PM-only(Top 불변). **중앙 arbitration(comparator+dedup+conflict+budget+kindRank 확장)을 플래그 활성 前 구현.**
- PM owners 와이어: User(상위)+Workspace, arbitration 後. gate `currentOwnerRevisions=[{workspace,projectId,rev}, {user,user,prov:user,rev}]`, `provenanceKey`는 projectId 유지.
- 플래그 `PALANTIR_MEMORY_MULTI_OWNER`(PM scope). owner_state PK/gate 키 포맷 **불변**(distinct owner라 충돌無). 단 A2-4a 테스트가 `owner:owner_id`-only 키를 단언하지 말 것(A2-4b Option A 대비).
- single-owner(flag OFF) byte-equiv.

### A2-4b (D2, Top+cross_project) — 후속
- 선행: **Option A 마이그레이션**(owner_state PK rebuild w/ provenance_key NOT NULL). gate/currentOwnerRevisions/owner_vector_hash/adapter 전부 provenance-aware.
- Top = 1 event 2 provenance entry. cross_project 별도 헤더. cross_project cap + selection-hash skip. removed-owner gate.
- 회귀: same-owner-2-provenance insert(PK 충돌 없음), cross_project rev→Top 재주입, **user rev는 cross_project write에 안 오름**(slice2b kill-test 유지), 중복헤더 방지.

## 4. 다음
A2-4a 구현(Codex) → Claude 리뷰 → Codex GO → merge. 그 후 A2-4b. 감독 루프.
