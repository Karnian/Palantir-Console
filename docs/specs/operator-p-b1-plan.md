# Operator P-B1 — Profile owner 스키마 예약 (계획 v0.2, Codex R1 반영)

> **v0.2 (Codex R1 = REVISE→GO 반영)**: 슬라이싱(staging-only, items→P-B2) 확인. 1 BLOCKER + 3 SERIOUS + 2 NIT 전부 수용 → §2 에 반영:
> - **B1 (claim guard)**: drain 의 unfiltered `runOnce({})` → `claimDistillJob({projectId:null})` → `claimStmt:756` 의 `@ownerType IS NULL` 가 owner 필터를 꺼서 profile job 까지 claim → `listCandidates(NULL project_id)` → `normalizeOwner` throw → retry 루프. **수정: claim scan 을 "ownerType NULL → `owner_type='workspace'` only" 로 가드** (enqueue skip + claim guard 쌍으로 profile job 을 P-B1 에서 inert 화). 오늘 전 job 이 workspace 라 byte-동치.
> - **S1 (CHECK 강화)**: coherence CHECK 가 `owner_type↔project_id-nullness` 만 묶고 `owner_id=project_id`(workspace) 불변식 누락 → owner_id='garbage' workspace row 통과. **수정: workspace 분기에 `AND owner_id=project_id`, profile 분기에 `AND owner_id IS NOT NULL AND length(owner_id)>0`.**
> - **S2 (parity 범위)**: profile-aware parity 를 **{memory_jobs, memory_candidates} 로만 스코프**. `memory_items`·`project_memory_revision` 는 workspace-expected 유지 (그 테이블의 profile row 는 P-B1 에서 incoherent → parity 가 flag = 올바른 fail-closed).
> - **S3 (null leak)**: `listProjectsWithPendingCandidates`(legacy, 런타임 미사용·테스트만) 에 **`WHERE project_id IS NOT NULL`** 가드 → profile candidate(project_id NULL)가 project 목록에 NULL 로 새지 않게.
> - **N1**: `memoryService.js:792` 의 `idx_memory_jobs_active` 명명 stale 주석 정정(드롭 반영) + 042 헤더에 "027 project-key 단일비행 supersede" 명시.
> - **N2**: normalizeOwner ambiguity 테스트에 profile+project_id, profile+scope 2-key 케이스 추가.

# Operator P-B1 — Profile owner 스키마 예약 (계획 v0.1)

> 상위: `operator-p-b-plan.md` v0.2 §2 P-B1 + `operator-generalization-brief.md` v1.2 §10.
> 선행: P-B0 (#250 assertWorkspaceBound + #251/#252 capability) merged — 전부 미와이어 계약.
> 감독모드: Claude 계획 → Codex 검토(반복) → 구현 → Claude 리뷰 → Codex 최종 GO.

## 0. 한 줄 정의
**P-B1 = 메모리 저장 계층이 `owner_type='profile'` 를 *표현*할 수 있게 만든다. 읽기/쓰기 경로는 0 (미와이어).** specialist(P-B2) 가 Profile candidate/job 을 실제로 만들기 전에, 스키마·정규화·정합성 검사를 먼저 lock 한다. behavior-preserving (오늘 profile row 가 0개라 모든 변경은 무해한 forward-enabling).

## 1. 코드 조사 결과 (2026-06-23)

### owner-keying 현황
- `ownerKey.js normalizeOwner` 는 `{project_id}` → `(workspace, project_id)` xor `{scope}` → `(user, user)` 만 지원. **profile 미지원.** "exactly one key" fail-closed.
- `owner_type` 에 **DB CHECK 제약 없음** (전부 `TEXT`). owner_type 검증은 순전히 코드(normalizeOwner)에만 존재 → 'profile' 값 추가에 CHECK 완화 migration 불필요.
- owner-unique 인덱스는 이미 `(owner_type, owner_id, ...)` 키 → **profile 값을 구조적으로 이미 수용**(스키마 변경 없이). (memory_items: 039 idx_memory_owner_content_hash/factkey; memory_candidates: 039 table UNIQUE(rule,owner_type,owner_id,dedup_key); memory_jobs: 036 idx_memory_jobs_owner_active.)

### profile owner 의 영속을 막는 실제 블로커 = `project_id NOT NULL` (2개 테이블)
- `memory_jobs.project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE` (027, 이후 rebuild 없음). owner 컬럼은 033 ALTER 로 추가(nullable).
- `memory_candidates.project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE` (039 rebuild 가 NOT NULL 유지). owner 컬럼 NOT NULL.
- 둘 다 profile owner = project 없음 → `project_id` 가 NULL 이어야 하는데 NOT NULL 이 막음. (FK 자체는 NULL 허용 — FK 는 non-NULL 만 검증하므로 NOT NULL 만 풀면 됨.)

### 의도적으로 P-B1 범위 밖 = `memory_items.project_id NOT NULL` (Codex Q2)
- `memory_items.project_id TEXT NOT NULL` (025) + **FTS5 가상테이블 + 트리거 3개(ai/ad/au) + rebuild** 가 얹혀 있음 → table rebuild 리스크가 가장 큼.
- memory_items 는 **promotion target** (candidate→active item). promotion 은 *쓰기 경로* = P-B2. P-B1(저장 예약, 쓰기 0) 은 **staging 테이블(jobs+candidates)만** 완화하고, items 완화는 promotion 와이어와 함께 P-B2 로 폴드 → 가장 위험한 FTS 테이블을 순수-예약 슬라이스에서 제외. (브리프/계획 문구도 "jobs + candidate 경로"만 명시.)

### distill 스케줄러 non-workspace skip (이미 존재, #231)
- `memoryDistillService.drainAll` 가 `listOwnersWithPendingCandidates()` 순회 중 `ownerType !== 'workspace'` 면 skip + warn (line 170). 주석이 "P-B(FK 완화) 에서 처리" 라 명시. **P-B1 은 이 skip 을 유지** — profile candidate 가 아직 0개라 무해(no-op). profile distill enqueue 와이어는 P-B2.

### 정합성 검사
- `checkOwnerParity()` 는 L1 테이블의 owner 를 **`normalizeOwner({project_id: row.project_id})` 로 재유도**해 stored owner 와 비교. profile row 는 project_id=NULL → `normalizeOwner` throw → `cannot_normalize_old_key` **false mismatch**. → **profile-aware 분기 필요.**
- `detectCrossScopeConflicts()` 는 L2(master_*) 전용(cross_project→user collapse 검출). profile(L1) 무관 → 변경 불필요.

### migration 러너
- `database.js`: `foreign_keys = ON` + 각 파일 `db.transaction()` wrap (실패 시 자동 full rollback). **inbound FK 없음** (`REFERENCES memory_candidates/memory_jobs` 0개) → DROP TABLE 안전. 039 가 memory_candidates 를 동일 패턴(FK ON·tx 안)으로 rebuild 한 선례 = 검증됨.

## 2. P-B1 변경 (additive·behavior-preserving)

### (a) `ownerKey.js normalizeOwner` — profile 입력 형태 추가
- `{profile_id}` → `{owner_type:'profile', owner_id: profile_id}`. profile_id 는 non-empty string 아니면 throw (project_id 와 동일 기준).
- "exactly one key" 를 **{project_id, scope, profile_id} 중 정확히 1개**로 확장 (2개 이상 present → throw, fail-closed).
- 모듈 doc 갱신.

### (b) migration `042_profile_owner_reservation.sql` — staging 2 테이블 rebuild
022/039 의 table-rebuild 패턴(`_new` 생성 → INSERT SELECT → DROP → RENAME, **`CREATE TABLE AS SELECT` 금지**). 대상 = `memory_jobs`, `memory_candidates`.
- **`project_id` nullable** (NOT NULL 제거), `REFERENCES projects(id) ON DELETE CASCADE` 유지.
- **coherence CHECK 추가** (fail-closed, **Codex R1 S1 강화 = owner_id=project_id 포함**): `CHECK ((owner_type='workspace' AND project_id IS NOT NULL AND owner_id = project_id) OR (owner_type='profile' AND project_id IS NULL AND owner_id IS NOT NULL AND length(owner_id) > 0))`. → workspace row 는 project_id 必 + owner_id=project_id 불변식(normalizeOwner/parity 가 의존), profile row 는 project_id NULL + owner_id non-empty 強制, owner_type ∈ {workspace,profile} 로 제약(L1 테이블엔 user 없음), NULL owner_type 차단.
- owner_type/owner_id **NOT NULL** (memory_jobs 는 033 에서 nullable 이었으나 backfill 됨 → rebuild 에서 NOT NULL 로 승격; memory_candidates 는 이미 NOT NULL).
- **bad-data fail-closed = INSERT SELECT 자체** (별도 PART 0 preflight 불필요): `_new` 테이블의 NOT NULL + coherence CHECK 가 기존 row 를 옮길 때 위반을 던져 러너 tx 가 full rollback (039 PART 0 는 *인덱스 교체* 후 NULL 이 dedup 을 silent bypass 하는 다른 시나리오라 명시 preflight 가 필요했음 — 여기선 rebuild 가 곧 가드).
- **모든 인덱스/UNIQUE/CHECK/DEFAULT 보존·재생성**:
  - memory_jobs: `idx_memory_jobs_owner_active` (036, owner 단일비행) 재생성, `idx_memory_jobs_claimable` (027) 재생성. **`idx_memory_jobs_active` (027, project_id 키) 는 재생성 안 함 = 드롭** (Codex Q4: project_id 가 nullable 이 되면 project_id 키 단일비행은 profile row 에 무의미; owner 인덱스가 canonical 단일비행. slice5 가 놓친 cleanup 완료).
  - memory_candidates: table UNIQUE `(rule, owner_type, owner_id, dedup_key)` (039), CHECK 4개(rule/status/json_valid/json_type/dedup_key len), `idx_memory_candidates_pending` (039), `idx_memory_candidates_owner` (039) 전부 보존.

### (c) `checkOwnerParity()` — profile-aware
- L1 row 가 `owner_type='profile'` 면: expected = `normalizeOwner({profile_id: row.owner_id})` 로 비교 + `project_id IS NULL` 도 단언(incoherent profile row 검출). workspace row 는 기존 로직(project_id 재유도) 유지. → workspace-only DB 에선 결과 불변([]).

### (d) `memoryDistillService` non-workspace skip 주석 갱신
- skip 로직 **유지**(profile distill 미와이어). 주석만 "FK 는 P-B1 에서 완화됨; profile candidate 생성·distill enqueue 와이어는 P-B2; 그 전까지 skip 유지" 로 정정.

### 변경 안 함 (미와이어 증거)
- `createCandidate` / `enqueueDistillJob` / `createMemoryItem` 시그니처 불변 (여전히 projectId 요구). profile 생성 경로는 **스키마+정규화 예약만**, 함수 와이어는 P-B2.
- `memory_items` 스키마 불변 (promotion = P-B2).
- conversationService 주입 경로, retrieve, composer, XPROJECT 불변.

## 3. 수용 기준
1. `normalizeOwner({profile_id:'p1'})` === `{owner_type:'profile', owner_id:'p1'}`. 빈/누락 profile_id throw. 2-key 입력 throw.
2. migration 042 후: `memory_jobs`·`memory_candidates` 에 `(owner_type='profile', project_id=NULL)` row INSERT **성공**; `(owner_type='workspace', project_id=NULL)` INSERT **CHECK 거부**; `(owner_type='profile', project_id='x')` INSERT **CHECK 거부**.
3. owner-unique 여전히 작동: 동일 (profile,owner_id,dedup_key) 2번째 INSERT 거부; 동일 dedup_key 라도 owner 다르면 공존.
4. `checkOwnerParity()` 는 workspace-only DB 에서 `[]`; profile row 가 coherent 면 `[]`, incoherent(project_id 동시 set) 면 mismatch.
5. 기존 동작 불변: 풀스위트 green, distill 스케줄러 workspace 경로 무영향, slice1/slice3/slice5 owner-keying 테스트 green.
6. profile distill 은 여전히 skip(스케줄러), profile candidate 생성 함수는 미와이어.

## 4. 건드릴 파일
- `server/services/ownerKey.js` (normalizeOwner + profile)
- `server/db/migrations/042_profile_owner_reservation.sql` (신규)
- `server/services/memoryService.js` (checkOwnerParity profile-aware)
- `server/services/memoryDistillService.js` (skip 주석 정정만)
- `server/tests/profile-owner-reservation.test.js` (신규 — 수용기준 1~6 계약)
- 기존 owner-keying 테스트 회귀 확인 (변경 예상: 없음; slice1 은 033 핀이라 무영향)

## 5. Codex 검토 질문
- **Q1 (범위)**: P-B1 을 "staging 2 테이블(jobs+candidates) project_id nullable + normalizeOwner profile + parity profile-aware" 로 한정하고 **memory_items(FTS) 완화는 P-B2(promotion)로 폴드** 하는 게 옳은 슬라이싱인가? 아니면 items 도 P-B1 에서 함께 완화해 P-B2 를 순수 런타임 와이어로 남겨야 하나? (트레이드오프: 마이그레이션 격리 vs 가장 위험한 FTS 테이블을 예약 슬라이스에 포함)
- **Q2 (coherence CHECK)**: `(workspace∧project_id NOT NULL) ∨ (profile∧project_id NULL)` CHECK 가 적절한 fail-closed 인가, 아니면 owner_type 을 {workspace,profile} 로 하드코딩하는 게 너무 경직(P-C 에서 또 migration)인가? CHECK 없이 코드(normalizeOwner)만으로 충분한가?
- **Q3 (parity)**: profile-aware parity 분기가 맞나? profile row 의 expected 를 `normalizeOwner({profile_id: owner_id})` 로 재유도 + `project_id IS NULL` 단언이 충분/과한가? `project_memory_revision`(L1, project_id PK) 도 profile 가능성 있나(없다 — revision 은 provenance-keyed 유지, profile revision 은 P-B2 이후) → parity 에서 revision 은 workspace-only 가정 유지해도 되나?
- **Q4 (idx_memory_jobs_active 드롭)**: project_id 키 단일비행 인덱스(027)를 rebuild 에서 재생성 안 함(=드롭)하고 owner 인덱스(036)에만 의존하는 게 안전한가? enqueue/claim 경로가 owner 인덱스로 단일비행을 완전 커버하나? (`getActiveJobStmt` = owner 키, insert race catch = SQLITE_CONSTRAINT_UNIQUE → owner UNIQUE.)
- **Q5 (behavior-preserving)**: profile row 가 0개인 현 prod 에서 042 rebuild + parity/normalizeOwner 변경이 정말 byte-동치 동작인가? table rebuild(FK ON·tx 안, inbound FK 0)가 039 선례대로 안전한가? FTS 와 무관한 jobs/candidates rebuild 가 FTS 재인덱스를 건드리지 않나(candidates 는 FTS 없음 — 맞나)?
- **Q6 (slice5 정합)**: 042 가 memory_candidates 를 다시 rebuild 하는데 slice5 테스트(owner-keyed UNIQUE 존재 + 구 project_id UNIQUE 부재)와 충돌 없나? 042 가 동일 UNIQUE 를 보존하면 slice5 계약 유지되나?
