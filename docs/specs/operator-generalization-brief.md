# Operator (전 PM) 일반화 — 구현 brief (초안)

> **상태**: **v1.0 LOCKED (2026-06-19)** — O1~O11 권장안으로 사용자 확정. Codex 적대검토 R1 반영 완료(§4 NO-GO 보완·O6~O11·NO-GO 2건·PR 내부 slice). 역할 모델 + 메모리 아키텍처 통합 실행 spec. **이제 §10 PR 순서로 구현 가능 (P-A0 부터, NO-GO §8 충족 전제).**
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

**🔴 injection ledger 재설계 (R1 NO-GO 추가)**: Composer 시대엔 단일 revision 불가 → **owner revision vector 또는 composition fingerprint**. `pm_memory_injection(pm_run_id)` 를 owner-key 만 바꾸면 User/Profile/Workspace 일부 변경이 **stale suppression** 또는 과다 재주입.

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

> **최대 위험**: 아카이브 "만능 백도어" → kill-test 가 죽인 흡수 부활. + **owner-boundary 실패**. 그 전까지 Profile = reserved/stateless.

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
| **O9** 🆕 | `workspace=none` capability matrix(dispatch/network/search/MCP/browser/archive/artifacts/env) | dispatch+검색만 허용 |
| **O10** 🆕 | specialist conversation/run identity namespace + resume 정책 | 비영속 namespace |
| **O11** 🆕 | `cross_project` = owner 아님 = route/provenance 확정? | ✅ route/provenance |

> **✅ LOCK-IN (2026-06-19) — O1~O11 전부 위 권장값으로 확정**:
> O1 MVP(coder 불변+specialist stateless) · O2 in-memory virtual workspace · O3 `adapter_config` 재명명은 owner-keying PR 과 함께 · O4 Raw archive 이번 scope 제외 · O5 단계 A=owner-keying migration 부터 · **O6 coder=Workspace-only(MVP, User 주입은 후속 별 PR)** · O7 최소분리 · **O8 Master=singleton 유지(루트 Operator 통합은 후속)** · O9 `workspace=none`=dispatch+검색만 허용 · O10 specialist=비영속 namespace · O11 `cross_project`=route/provenance.

---

## 10. PR breakdown (lock-in 후, 각 PR Codex 교차검증)

- **P-A0** — capability deny-by-default(전 목록) + virtual workspace 배제 가드 + **`process.cwd()` fallback 제거** + 테스트.
- **P-A1 (owner-keying — partial 금지, 내부 slice 명시, R1)**:
  1. schema/backfill/compat helper.
  2. L2 `scope` 제거 + service/route/test 갱신.
  3. L1 `project_id` owner 추상화 + **candidates/jobs/promote/cap/decay/correction** 갱신.
  4. **injection ledger(owner revision vector) + retrieve 시그니처** 전환.
  5. old API 제거 + invariant 테스트.
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

✅ **v1.0 LOCKED** (O1~O11 확정) → final Codex 확인 → 전 docs origin/main 통합(operator-memory-architecture + operator brief + memory-augmentation reconcile) → **P-A0 착수**. P-A0 = capability deny + virtual 배제 + `process.cwd()` fallback 제거 + 테스트(저위험 선행).
