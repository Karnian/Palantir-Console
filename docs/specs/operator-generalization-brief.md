# Operator (전 PM) 일반화 — 구현 brief (초안)

> **상태**: **v1.1 (2026-06-19) — Codex R1+R2 적대검토 반영** (두 세션 병렬작성 → R2 델타 addendum 병합으로 통합). 역할 모델 + 메모리 아키텍처 통합 실행 spec. R2 가 NO-GO 5건 추가(§8 블로커 8~10 · §4 ledger 3중계약 · §13 A1~A8 흡수 matrix) + lock-in O12~O15. **O1~O11 확정 / O12~O15 lock-in 대기** → O12~O15 확정 후 **P-A1**(owner-keying); **P-A0**(저위험 선행)은 지금 착수 가능 (NO-GO §8 충족 전제).
> **작성**: 2026-06-18
> **설계 원천 (이미 Codex 다라운드 수렴, 본 brief 가 통합)**:
> - 역할 모델: `project-operator-role-redesign` 메모리 (3R) — Operator = Profile × WorkspaceBinding × ExecutionMode.
> - 메모리 모델: `docs/specs/operator-memory-architecture.md` (Codex 5R CONDITIONAL GO) — governed 3-owner + Raw archive + Composer.
> - 보완(직교): `docs/specs/memory-augmentation-brief.md` (A1 한국어 FTS merged #222; 나머지 본 brief 로 흡수).

---

## 0. 한 줄 목표

PM(repo-bound project manager)을 **다형적 Operator** 로 일반화: 같은 역할을 ① folder-less **specialist**(doer) ② folder-mapped **coder**(현 PM, dispatcher) 로 쓰고, 메모리를 **owner-keyed governed 3-owner + Raw archive + Composer** 로 재편. **계층: Master → Operator → Worker.**

---

## 1. 왜

hermes-agent 가 **profile(정체성) · workspace(cwd) · sandbox(backend)** 를 3축 분리 — profile 은 폴더를 안 묶음. 우리 PM 은 `PM=project=폴더=정체성` 융합 → L1 이 "repo 사실" + "에이전트 지식" 겸함. 정체성을 폴더에서 떼면 folder-less 전문 에이전트 가능 + 메모리에 **세 번째 owner(Profile)** 강제(L2 user 로 대체 불가). honcho per-agent+shared 가 외부 검증.

---

## 2. 역할 모델 (네이밍 LOCK)

`OperatorInstance = Profile × WorkspaceBinding(none|folder|후속 mapped) × ExecutionMode(dispatcher|doer)`

매핑: specialist = (profile × `none` × **doer**) / coder = (profile × `folder` × **dispatcher**) = **오늘 PM**.

**네이밍 LOCK (2026-06-18)**: 계층 Master→Operator→Worker / 정체성번들 = **Profile** / 기존 `agent_profiles`(CLI 어댑터) → **`adapter_config`** 재명명(⚠️ 단순 rename 아님 = O7).

**통일 모델 (R1 누락 보완)**: **Master = 루트 Operator** (coordinator × folder-less × dispatcher) 로 볼 수 있다 — 별도 계층 아님. **✅ O8 lock-in: MVP 는 Master singleton 유지** (루트 Operator 통합은 후속).

**안전 역전 (Codex)**: folder-less 가 `process.cwd()`+shell 상속하면 *오히려 더 위험*. 하드 규칙 = **`workspace=none ⇒ shell·직접 FS 없음`**.
**⚠️ R1 정정 — `workspace=none` 은 "워크스페이스 *메모리·shell·FS* 차단"이지 권한 박탈 아님**: dispatch(생성·라우팅)·메타데이터·아카이브 검색은 **유지**. 정확한 capability matrix = lock-in(O9).

---

## 3. 메모리 모델 (요약 — 상세 `operator-memory-architecture.md`)

**두 평면**: ▤ Raw 아카이브(흡수=전부+온디맨드 RAG, **권한적 데이터 접근**, recall/데이터관리 정당화·답변품질 아님) / ▣ Governed working(선별, Composer 주입).

**governed 3-owner**: **User**(옛 L2 scope=user) / **Profile** ⭐신규(전이성 전문성) / **Workspace**(옛 L1 project 재명명).

| 계층 | 읽기(주입) | 쓰기 |
|---|---|---|
| Master(=루트 Operator) | User | `/remember`→User |
| Operator·coder | **Workspace (MVP, ✅O6)** / +User+Profile 후속 | Workspace ← harvest(R6/R1b)+판정(R3) |
| Operator·specialist | User+Profile *(MVP: User만)* | *(MVP 없음)* |
| Worker | 작업지시만 | harvest→Workspace |

> **✅ O6 lock-in**: MVP 에서 coder = **Workspace-only**(현 PM 동작 불변 — L2 user 미주입 유지). User+Profile 주입 전환은 **후속 별 PR**(Composer 도입 후).

**불변식**: 주입 아래로·캡처 위로 / Worker 메모리 직접 안 읽음 / 상위는 하위 raw 금지(governed 요약만) / **모든 주입 Composer 경유 + user-payload prepend (bake 금지)** / owner ≠ capture policy / 자기 출력은 증거 아님.

**A1(한국어 FTS) 통합**: two-pass exact-first retrieve 는 owner-agnostic → 3-owner+Composer 재사용. owner-keying 때 `retrieve(scope)`→`retrieve(owner_type,owner_id)` + 공유 helper.

---

## 4. 데이터 모델 변경 (🔴 NO-GO #1 = owner-keying)

**`scope`/`project_id` 키를 쓰는 *모든* 불변식·writer 경로 → `(owner_type, owner_id)`.** owner: `('user','user')` · `('profile',<profileId>)` · `('workspace',<projectId>)`.

**이전 대상 (R1 보완 — unique index 만 바꾸면 writer 오염):**
- L2(`master_memory_items`): dedup unique index(content_hash·fact_key) · cap admission · decay · revision · injection ledger.
- L1(`memory_items`, mig 025): `project_id` → workspace owner 추상화 + **promoteCandidatesBatchTx · cap admission · decay · restore · correction CRUD** 전부(project_id 기반).
- **`memory_candidates`(rule,project_id,dedup_key) (mig 026) + `memory_jobs`(kind,project_id) (mig 027, single-flight CAS lease)** ← R1 누락. CAS lease 불변식이라 필수.
- `master_memory_candidates`(mig 031) · XPROJECT scan index(mig 032).
- router · dispatch-audit envelope(`conversation_id='pm:<projectId>'`) · parent-notice route.

**⚠️ R1 정정 — `cross_project` 는 owner 아님**: route/candidate **상태**다. 최종 active owner = `user`, cross-project 성은 **provenance/rule** 로 남김(O11 확정).

**🔴 injection ledger 재설계 (R1→R2 구체화, NO-GO)**: "vector 또는 fingerprint" 는 **OR 아님 — 셋 다 필요** (R2 normative 계약): ① **composition 이벤트**(run/conv/task identity · Composer/policy 버전 · prompt payload hash · retrieval query hash · token budget · ts) ② **per-owner 상태**(owner_type/id · 합성시점 owner revision/epoch · selected/suppressed item-set hash · counts · budget used) ③ **per-item edge**(item id · revision · content hash · fact_key · source owner · included/suppressed/truncated/conflicted **reason** · rank · token cost). 실패 시나리오(왜 셋 다): vector-only=동일 rev라도 task intent/budget 로 selection 달라져야 하는데 필요사실 억제 / fingerprint-only=텍스트 동일이나 source owner 변경(provenance) 은폐→무효화·추적 오류 / vector-over=무관 owner rev 증가로 selected set 동일한데 과다 재주입.

**virtual identity (blast radius)**: project-less 전면전환 ✕ → **virtual workspace**(가능하면 in-memory slot; 불가피시 `projects.kind` 컬럼). ⚠️ **`projects.kind` 쓰면 XPROJECT scan + L1 capture 가 virtual rows 를 real-workspace-only 로 반드시 필터**(R1: 현재 미명시) — O2.

| 항목 | 오늘 | 목표 |
|---|---|---|
| 저장 키 | `scope` / `project_id` | `(owner_type, owner_id)` |
| 중간 계층 | PM(repo 1:1) | Operator(Profile×폴더×mode) |
| adapter 설정 | `agent_profiles` | `adapter_config`(의미분리=O7) |
| 주입 | Top/PM 직접 prepend | **Composer** 1곳 |

---

## 5. Memory Composer (owner-keying 직후)

- 단일 진입점(Master 포함). 우선순위 mode·kind별: coder `요청>User제약>Workspace사실>Profile휴리스틱` / specialist `요청>User제약>Profile`. kind `제약>사실>휴리스틱`.
- **MVP 주의 (O6, Codex)**: coder Composer 의 **User/Profile slot 은 비활성 → 빈 입력으로 처리**. 위 우선순위 규칙은 후속 User/Profile 주입 활성화 시 적용.
- owner별 토큰예산+충돌+dedup. retrieve rows 받아 **중앙에서** owner캡·전체 hard budget·governed 요약(`buildInjectionBlock` 직접호출 금지 — owner 단순 concat 시 예산초과, Codex).
- **추적성(필수)**: 주입/억제 plan + 테스트.
- ⚠️ **parent-notice prepend 는 memory 아님 (R1)**: Composer 가 conversationService 직접 prepend 흡수 시 계약 분리 또는 "synthetic user-payload composer" 로 확장해 기존 **peek→accept→commit-drain** discipline 보존.

---

## 6. MVP 범위

- **coder PM 불변(단 O6)** + 제한 **specialist stateless**(정적 persona + 선별 User만, Workspace 쓰기0, auto-capture0, virtual 에 저장0). 영속=human R4만.
- Profile 메모리 = owner-keyed **예약만**.
- **의도적 제외**: mapped workspace / mega-profile 통합 / auto-capture / Agent peer 레이어 / dispatcher-doer 하이브리드 / Raw archive 활성(§8 선행 전).

---

## 7. 단계화 (additive)

- **A0 (하드 선행)** — folder-less 가 `projects`행/cwd/shell·FS/XPROJECT/L1 capture/project-route 에 안 닿게 + **capability deny-by-default**: shell·FS·**network·MCP·browser·env/credential·artifact·상속 run context** (R1 보완 — shell/FS 만 아님). **`process.cwd()` fallback(lifecycleService·pmSpawnService) 제거 포함**(§8).
- **A** — ① **owner-keying migration 먼저** → ② **Composer**(순서 R1 명시). retrieve 시그니처 전환 + A1 공유 helper. **A2-④(극성 게이트)는 promote tx/owner-aware write 에 부착**(R1: Composer PR 아님). **Profile owner schema 결정**(A 에서 `owner_type='profile'` 허용 vs B 에서 재오픈) = O 결정.
- **B** — specialist stateless 주입(User만) + Profile owner 스키마 예약.
> **virtual namespace (O2/O10, Codex)**: virtual workspace 기반 specialist run 은 in-memory namespace 라 **서버 재시작 후 resume 보장 ✕** (MVP 설계 전제).
- **C** — Profile 메모리 읽기 + human 쓰기 + 모순해소(owner-aware, memory-augmentation A3/A4 흡수).
- **Archive 트랙(병행, §8 충족 후)** / **D(deferred)** — Profile 자동학습·mapped·archive→working distill.

---

## 8. 🔴 구현 전 NO-GO 블로커

1. **owner-keyed 저장** — §4 전 불변식+writer 경로(candidates/jobs/promote/cap/decay/correction 포함). partial = profile 교차오염.
2. **virtual 배제 + capability deny** — A0(network/MCP/browser/env/artifact 포함), specialist 이전.
3. **추적성** — 주입/억제·검색 추적+테스트.
4. **자동 학습 OFF** — Workspace→Profile 누수 분류+trust 기준 전까지.
5. **아카이브 프라이버시 게이트** — redaction·보존·**삭제권+파생데이터(chunk/embedding/summary/promoted fact/cache/backup) 무효화 전파**·암호화·테넌트격리·secret 격리·검색결과 untrusted·retrieval 하드예산 없이 raw 활성 금지.
6. **🆕 multi-owner injection ledger (R1)** — owner revision vector/fingerprint 없이 Composer 붙이면 stale suppression/과다 재주입.
7. **🆕 `process.cwd()` fallback 제거 (R1)** — `lifecycleService.js`·`pmSpawnService.js` 에 현존. folder-less specialist 추가 전 필수 차단.
8. **🆕 injection ledger 계약 (R2)** — composition fingerprint + owner revision vector + per-item edge 스키마(§4 Δ1) 없이 Composer 붙이면 stale suppression / 과다 재주입 / provenance 은폐.
9. **🆕 owner-keying writer-path inventory + dual-write (R2)** — 전 write surface 열거 + nullable owner_type/id dual-read/write · 배치 backfill+parity · parity 통과 후에만 owner-unique 강제 · rollback 가능. `memory_jobs` CAS = `kind+owner_type+owner_id+dedup_key` partial index (project_id 조기 제거 ✕ — owner 가로질러 collapse/중복). writer 카테고리 = §10 P-A1 inventory.
10. **🆕 memory-augmentation A1~A8 흡수 matrix (R2)** — §13(아래). 병행 트랙과 retrieval/ranking/FTS 이중구현 · 인덱스 충돌 · ledger/promote 분기 차단.

> **최대 위험 (R2)**: Profile 메모리 자체가 아니라 **migration 중 불완전 ownership 격리** — 한 writer/job/index/ledger/suppression 경로라도 `project_id`/`scope` 가정이 남으면 동작하는 듯 보이며 User/Profile/Workspace 를 silent 혼합. + 아카이브 "만능 백도어". 그 전까지 Profile = reserved/stateless. **owner-keying 은 partial 금지(§10 P-A1 전 writer 동시 이전).**

---

## 9. 사용자 lock-in 결정 (확정 필요)

| # | 결정 | 권장 |
|---|------|------|
| O1 | MVP = coder 불변 + specialist stateless? | ✅ |
| O2 | virtual workspace = in-memory slot vs `projects.kind`(+real-only 필터)? | in-memory 우선 |
| O3 | `adapter_config` 재명명 시점 | owner-keying PR 과 함께 |
| O4 | Raw archive = 이번 scope 제외? | ✅ 제외 |
| O5 | 단계 A = owner-keying migration 부터? | ✅ |
| **O6** 🆕 | **coder PM 이 MVP 에서 User memory 읽나?** (현 미주입, "PM 불변"과 충돌) | Workspace-only 유지(보수) or User 추가(별 PR) |
| **O7** 🆕 | `agent_profiles→adapter_config` = 의미분리(capabilities/env_allowlist/max_concurrent/queue/worker UI 분리 범위) | 최소분리 |
| **O8** 🆕 | Master = 루트 Operator 통합 vs singleton 유지? | singleton 유지(MVP) |
| **O9** 🆕 | `workspace=none` capability matrix — **"search" 분해 필수(R2)**: 내부 registry/profile metadata 검색 vs 외부/network/workspace-content 검색 | **default: shell·FS·network·MCP·browser·env·artifact 전부 ✕; 내부 registry/profile metadata 검색만(allowlist)·raw workspace 내용 ✕·결과 비영속** |
| **O10** 🆕 | specialist conversation/run identity namespace + resume 정책 | 비영속 namespace (prior state resume ✕·durable write ✕·artifact 재사용 ✕·conv id 가 `pm:<projectId>` 충돌 ✕) |
| **O11** 🆕 | `cross_project` = owner 아님 = route/provenance 확정? | ✅ route/provenance |
| **O12** 🆕 (R2) | owner_id 정규화 규칙 (Profile id vs Workspace projectId namespace 충돌 방지) | 확정 필요 |
| **O13** 🆕 (R2) | User/Profile/Workspace **precedence·충돌 정책**(모순 시 표시/억제) | constraint>fact>heuristic + mode-aware |
| **O14** 🆕 (R2) | 삭제·무효화 시맨틱(composed 요약·ledger 가로질러) + Composer **freshness**(무엇이 재주입/억제/재합성) | 확정 필요 |
| **O15** 🆕 (R2) | migration rollout mode(dual-write·flag·rollback·parity) + Profile **write-authority gate**(deferred여도 예약) + audit/privacy 경계(workspace run 이 Profile/User raw inspect 가능?) | dual-write+flag · write-authority 예약 · cross-owner raw inspect ✕(governed 요약만) |

> **✅ LOCK-IN 현황 (2026-06-19)**: **O1~O11 확정** — O1 MVP(coder 불변+specialist stateless) · O2 in-memory virtual · O3 `adapter_config`=owner-keying PR 과 함께 · O4 archive 제외 · O5 A=owner-keying 부터 · **O6 coder=Workspace-only**(User 후속) · O7 최소분리 · **O8 Master=singleton** · O9 `workspace=none`=**내부 metadata 검색만**(R2 정정) · O10 비영속 · O11 route/provenance.
> **⏳ O12~O15 = lock-in 대기** (R2 신규; O13/O15 권장값 有, O12/O14 "확정 필요"). 이들 확정 전 **P-A1(owner-keying) 착수 ✕** — schema·ledger·Composer 설계가 이 결정에 의존. (P-A0 는 O12~O15 무관, O1~O11 로 착수 가능.)

---

## 10. PR breakdown (lock-in 후, 각 PR Codex 교차검증)

- **P-A0** — capability deny-by-default(전 목록) + virtual workspace 배제 가드 + **`process.cwd()` fallback 제거** + 테스트.
- **P-A1 (owner-keying — partial 금지, 내부 slice 명시, R1→R2)**: 선행 = **전 writer-path inventory + dual-read/write rollout plan**(§8 #9). writer 카테고리(누락 금지) = manual CRUD/edit/delete · restore/undelete · capture/classification candidate 생성 · promote/demote · decay/relevance/maintenance job · dedup/upsert conflict 핸들러 · FTS/search index refresh · audit/export/delete/privacy · tests/factory/seed/admin. `memory_jobs` CAS 키 = `kind+owner_type+owner_id+dedup_key`.
  1. schema = **nullable `owner_type`/`owner_id`** + 배치 backfill + dual-write compat helper + **parity 검증**(old 컬럼 유지, parity 통과 후에만 owner-unique 강제·rollback 가능).
  2. L2 `scope` 제거 + service/route/test 갱신.
  3. L1 `project_id` owner 추상화 + **promote/demote·cap·decay·restore·correction·dedup·FTS refresh·audit/delete** 전 writer 갱신.
  4. **injection ledger(§4 3-part: composition fingerprint + owner revision vector + per-item edge) + retrieve 시그니처** `retrieve(scope)`→`retrieve(owner_type,owner_id)` 전환.
  5. old API/컬럼 제거(parity 후) + invariant 테스트(교차오염 음성).
- **P-A2** — Memory Composer(단일주입+owner예산+추적성) + conversationService 직접 prepend 흡수(**parent-notice 계약 분리**). memory-augmentation A2-④(극성 게이트)는 P-A1 write 경로에.
- **P-B** — specialist(stateless, User만) + Profile owner 스키마 예약.
- **P-C** — Profile 읽기+human 쓰기 + 모순해소(owner-aware, A3/A4).
- (defer) Archive 트랙 / Profile auto-capture / mapped workspace.

---

## 11. Open Questions / 위험 (Codex)

- 파생데이터 삭제·무효화 전파(raw→chunk→embedding→summary→promoted fact→cache→backup).
- **`agent_profiles` rename blast radius** — capabilities/env_allowlist/max_concurrent/queue/worker 필드 분리 범위(O7).
- **virtual project 가 XPROJECT scan 오염** — real-workspace-only 필터 강제.
- **Profile lifecycle**(clone/rename/delete/version) + 동일 Profile 다중 인스턴스 동시 쓰기.
- **Raw archive prototype 이 governed write 경로로 우회 승격** 위험.
- 다중-사용자/공유 workspace 소유권·authorship / secret 격리·로테이션 / 검색결과 prompt-injection 방어.
- raw 검색 / governed 요약 / Composer 주입 강제 경계 구체화 / 아카이브 볼륨 비용·인덱스 생애주기.

---

## 12. 다음

✅ **v1.1** (R1+R2 반영, O1~O11 확정 / O12~O15 lock-in 대기) → **사용자 O12~O15 lock-in** + (선택) Codex R3(R2 5건 닫힘 좁은 확인) → **P-A1**(owner-keying, O12~O15 확정 후). **P-A0**(capability deny + virtual 배제 + `process.cwd()` fallback 제거 + 테스트)은 O12~O15 무관·저위험이라 **지금도 착수 가능**.

---

## 13. memory-augmentation A1~A8 흡수 matrix (R2, NO-GO #10 해소)

`memory-augmentation-brief.md` §5 로드맵을 owner-keyed Operator 모델로 매핑 (owner-after-rewrite · target PR · conflict).

| A# | 보완 | owner (rewrite 후) | target PR | conflict |
|----|------|--------------------|-----------|----------|
| **A1** ✅ | 한국어 FTS two-pass | **owner-agnostic**(3 owner 공유 retrieve helper) | merged #222 → P-A1 이 helper 로 감쌈 | 🟡 retrieve 시그니처 전환 시 two-pass 보존 必 |
| **A2-④** | 극성소실 reject·부정어 flag | owner-agnostic(promote/write) | **P-A1** | 🟢 |
| **A2-⑤** | correlated-evidence independence | **Workspace**(run/task distinct)+**User**(XPROJECT project distinct) | **P-A1** | 🟡 independence owner-aware화 |
| **A3** | L1 모순 write-time supersede | **Workspace** | **P-C** | 🔴 merge↔supersede 배타(PR3c-1)+self/kind/expired 가드 |
| **A4.0** | L2 ask/act 게이트 구현 | **User**(+Profile constraint) | **P-C 선행** | 🟡 미구현 |
| **A4** | L2 모순 surface-and-ask | **User**/Profile | **P-C**(A4.0 의존) | 🟡 |
| **A5.0** | 절차적 기억 선행(trigger·manifest·R5) | — | **defer(D)** | 🟢 |
| **A5** | 절차적 기억 | **Profile**(전이성)+Workspace(고유) | **defer(D)** | 🔴 BLOCKED(A5.0 후) — owner=Profile 정렬은 본 brief 와 일치 |
| **A6** | preference 저마찰 | **User** | **P-C+/defer**(A4.0) | 🟡 |
| **A7** | on-demand 일화검색 | **Raw archive tier** | **defer(Archive)** | 🟢 거버넌스 선행 |
| **A8** | 구조정책(dangling·post-delete·scope revision) | cross-cutting(User/Workspace provenance) | **P-A1** | 🔴 scope revision ↔ §4 ledger owner-vector 같은 영역 — P-A1 에서 통합(이중구현 금지) |

**핵심 정렬**: A5(절차)→Profile = "전이성 전문성" 정의와 일치(검증 신호) / **A8 scope-revision ↔ §4 owner revision vector = 동일 영역, 반드시 P-A1 에서 한 번에** 설계 / A1 two-pass 는 owner-agnostic 라 P-A1 retrieve 전환 시 회귀테스트로 보존 / A5~A8 부재 아님 — 전부 매핑(R2 "A5~A8 unknown" 블로커 해소).
