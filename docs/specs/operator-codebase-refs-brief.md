# Operator ↔ Codebase Refs (watch-list) — 설계 brief

> **상태**: v3 LOCKED (2026-07-08) — Codex 적대 설계리뷰 R1 REVISE(5 BLOCKER+5 SERIOUS)→R2 **W-P1 GO**(문서조건 3건 반영: thread 상태 전체필드 instance 소유·resolver phase-safe 네이밍·retry_root 필터). W-P1 수용조건: id CHECK 'oi_%' + primary 이중 partial-unique + pm_enabled 백필(instance+primary ref) + pm_thread_id→instance thread 백필 + proj_ prefix 불변 테스트.

## 0. R1 LOCKED DECISIONS (5 BLOCKER + 5 SERIOUS 확정)

**BLOCKER 반영**:
1. **단일 resolver**: `parseProjectConversationId` 확장이 아니라 **`resolveOperatorConversationId(id) → { instanceId, legacyProjectId?, legacySlotId, instanceConversationId, primaryProjectId? }` 신규 단일 resolver**. `operator:oi_x` 를 현재 파서가 `projectId=oi_x` 로 오독하므로 — 서버 파서(utils/conversationId)·클라 파서(lib/conversationId)·run envelope(runService)·boot resume(manager.js) **전부 이 resolver 경유**로 교체(W-P2).
2. **spawn-instance attribution 은 `/execute` 계약부터**: 현재 `/api/tasks/:id/execute` 는 operator 정보를 안 받고 worker run 에 `parent_run_id` 미기록. W-P3 = `runs.operator_instance_id` + **`/execute` envelope(pm_run_id 로부터 서버 derive)** + **`parent_run_id=<operator run>` 기록** + **retry 시 lineage 복사**.
3. **retry lineage + suppress 키 재정의**: T5 suppress(`hasHigherRetryAttempt`)와 circuit breaker 가 task-wide(`projectId:taskId`)라 두 operator 동시 dispatch 시 A 의 retry 가 B 의 review 를 억제. → **`retry_root_run_id` lineage 컬럼** + suppress/breaker 키를 **`receiverInstanceId:taskId`** 로(W-P4).
4. **thread 소유자 즉시 이전(dual-write 금지)**: `project_briefs.pm_thread_id` 는 codebase 당 1개라 N:M dual-write 시 상호 덮어씀. → **`operator_instances.thread_id` 가 W-P3 전에 실소유자**, `pm_thread_id` 는 **legacy primary alias bridge(read-only)** 로만.
5. **primary 이중 unique**: `UNIQUE(project_id) WHERE role='primary'`(codebase 당 1) + **`UNIQUE(instance_id) WHERE role='primary'`**(instance 당 1 — cwd 결정론).

**SERIOUS 반영**: ⑥repo source-change 409 guard(projectService 가 `operator:<projectId>` 직접 셈)를 **primary ref 기반**으로(canonical flip 시 live instance 놓침 방지) ⑦reconciliation 은 `pm_run_id → instance` **서버 derive**(audit 의 instance_id 를 body 신뢰 금지) + claim 의 project/task/run ∈ instance refs 검사 ⑧메모리 주입은 **turn 의 codebase context explicit 인자**(generic turn 에 watched workspaces 미주입 — Composer owner 에 안 넣음) ⑨router "프로젝트명→primary instance" resolver + no-primary/ambiguous 처리(W-P6) ⑩**project delete/ref 제거 정책**: 모든 refs 제거 + primary reset/invalidate + live instance watch-list version bump(현재 delete 는 단일 operator dispose 만).

**NIT 반영**: `pm_run_id` 필드명 유지(라이브 프롬프트 호환) + 프롬프트에 `operator_instance_id`/watched list 추가. `oi_` prefix 에 DB `CHECK(id LIKE 'oi_%')` + projectId prefix 불변 테스트. W-P5(구 N:M enable) 3분할.
> **모델 소스**: [`operator-generalization-brief.md`](./operator-generalization-brief.md) L26 — `OperatorInstance = Profile × WorkspaceBinding(none|folder|후속 mapped) × ExecutionMode`. **이 brief = "mapped" 의 구체화 + 바인딩 방향 역전.**
> **선례**: PM→Operator rename #269~273 (dual-read-first 무중단 phasing), repo-defined #323~331 (project=리소스화).

## 1. 문제 / 비전 (사용자, 2026-07-08)

> "프로젝트 폴더(코드베이스)는 하나의 오퍼레이터만 보는 게 아니라 **여러 오퍼레이터가 같이 볼 수 있어야** 한다. 폴더별로 오퍼레이터가 할당된다기보다 **오퍼레이터별로 어떤 폴더들을 보고 있는지**. 코드베이스 = **오퍼레이터에게 참조로 주기 위한 디렉토리 목록**."

현재는 정반대: 오퍼레이터 identity 자체가 `operator:<projectId>` — **코드베이스가 오퍼레이터를 소유**(1:1, 슬롯 키). 여러 오퍼레이터가 같은 코드베이스를 볼 수 없고, 한 오퍼레이터가 여러 코드베이스를 볼 수도 없다.

**Target**: 바인딩 역전 — `operator_instance` 가 1급(자기 identity), 코드베이스는 수동 리소스 풀, 관계는 N:M `operator_codebase_refs`(watch-list).

## 2. Target 모델

```
codebase (기존 projects 테이블 — 리네임 없음, 개념만)
  = 수동 리소스: 디렉토리/repo(source_type) + node 바인딩 + test_command + mcp 설정
  = 오퍼레이터 설정 없음 (pm_enabled/preferred_pm_adapter 는 §7 cleanup 에서 이전)

operator_instance (신규 1급)
  = identity: oi_<nanoid>  (⚠ projectId 네임스페이스와 충돌 방지 위해 prefix 필수)
  = profile(operator_profiles FK, nullable=무프로필 legacy) × adapter × thread_id × status

operator_codebase_refs (N:M watch-list)
  = (instance_id, project_id, role, created_at)
  = role ∈ { primary | reference }  — §3.C
```

- **tasks/워커/materialization 불변**: 태스크는 여전히 codebase 소속(보드 불변), 워커는 per(codebase,node) workspace 에서 실행, materialization lease 도 그대로(공유 클론 캐시는 다중 operator 에 오히려 유리).
- **"보고 있다" = 직접 FS 아님**: 참조(브리프/컨텍스트 주입) + dispatch 권한. 다중 codebase 는 서로 다른 node 에 바인딩될 수 있어 operator 가 한 폴더 "안에" 있을 수 없음 → cwd 의미는 §3.C.

## 3. 설계 축

### A. Identity & dual-read (가장 깊은 변경)
- canonical conversation/slot id: **`operator:<instanceId>`** (`oi_` prefix 로 projectId 와 구분 가능).
- **dual-read alias**: legacy `operator:<projectId>` 수신 시 → 그 project 를 **primary ref 로 가진 instance** 로 해석(resolver 단일 지점). rename #269~273 의 canonical-form 슬롯 키잉 선례 재사용.
- 백필: 기존 pm_enabled project 마다 instance 1개 생성(watch-list = [해당 project, role=primary]). 기존 스레드/brief 연속성 유지.
- router(프로젝트명 매칭): 이름→codebase→**그 codebase 의 primary instance** 로 resolve. 다중 매칭(여러 instance 가 같은 codebase primary) 은 §3.C 로 차단.

### B. Attribution & auto-review 수신자 (사전검토 최중요 파손점)
- `runs.operator_instance_id`(nullable, additive) + `dispatch_audit_log.operator_instance_id` 추가 — worker run 이 **어느 instance 가 dispatch 했는지** 기록.
- **auto-review(run:harvested) 수신자 정책 (LOCK 대상)**: ① 그 worker 를 **spawn 한 instance** → ② 없으면 codebase 의 **primary instance** → ③ 없으면 Top. **broadcast 절대 금지**(중복 retry·중복 판정·T5 suppress 무력화).
- parent-notice: watcher 전체가 아니라 **그 worker 의 parent operator run 에만**(기존 resolveParentSlot 의미 유지).

### C. Role 의미 & cwd (LOCK 대상)
- `primary`: codebase 당 **최대 1 instance**(partial unique). 의미 = auto-review 기본 수신 + router 이름 매칭 대상 + (legacy 호환) 그 codebase 의 "담당". 백필 instance 가 primary.
- `reference`: 수 제한 없음. 의미 = 컨텍스트 참조(브리프/메모리 요약 주입) + **dispatch 권한**(그 codebase 에 태스크/워커 dispatch 가능). 여러 operator 가 같은 codebase 를 reference 로 보며 동시 작업하는 게 사용자 비전의 핵심.
- **cwd**: watch-list size=1(백필) instance = 기존 동작(materialized cwd) 불변. **multi-ref instance = cwd 는 primary codebase**(있으면), primary 없는 refs-only instance 는 후속(folder-less dispatcher 는 P5 curl-dispatch 선례 있으나 MVP 범위 밖 — §6).
- repoOperatorThread(source-change 409): primary codebase 의 source generation 만 thread invalidation 트리거(reference 변경은 컨텍스트만 갱신).

### D. Reconciliation envelope
- `pm_run_id` 검증: `conversation_id === operator:<instanceId>`(dual-read 로 legacy 형태도 해석) + claim 의 `project_id/task_id/run_id` 가 **그 instance 의 refs 안**인지(cross-codebase 차단이 cross-project 차단을 대체). annotate-only 원칙 불변.

### E. Thread affinity & brief
- thread 상태의 실소유자 이전(R2): `pm_thread_id` 만이 아니라 operator thread 를 구성하는 **전체 상태 필드 세트 — thread_id + pm_adapter + node + cwd + source_generation + source_hash + workspace_path — 를 `operator_instances` 소유로**(operatorSpawnService:519 / manager.js:188 가 쓰는 필드 전부). `project_briefs.pm_thread_id` 계열은 **read-only legacy bridge**(dual-write 금지 — N:M 상호 덮어씀). brief(conventions/pitfalls)는 codebase 소속 유지 — instance 는 spawn 시 **watch-list 의 brief 들을 컨텍스트로 주입**(primary 는 bake, reference 는 요약).
- thread invalidation = instance + watch-list version(refs 추가/제거) + primary source generation.
- (R2) resolver 반환 필드 네이밍은 phase-safe 로: W-P2(legacy emit 유지) 동안 반환 필드는 **`legacySlotId` + `instanceConversationId`** 분리(단일 'canonical' 필드 없음) — W-P5 flip 전까지 "canonical" 이 두 형태를 오가는 혼동 방지.
- (R2) W-P4 의 `hasHigherRetryAttempt` 는 suppress 키 변경(`receiverInstanceId:taskId`)에 **더해 `retry_root_run_id` lineage 필터 필수** — 같은 operator 가 동일 task 에 독립 worker 여러 개 낸 경우의 오억제 방지.

### F. 메모리 (Composer 정책 — 사전검토 반영, LOCK 대상)
- Workspace 메모리는 **codebase owner 유지**(harvest/판정 캡처 불변). 바뀌는 건 주입.
- 주입 정책: **codebase-specific turn**(태스크/리뷰 등 특정 codebase 문맥) = 그 codebase Workspace 강주입 + User/Profile / **generic turn** = User/Profile + watch-list 요약만(**N workspace raw 전체 주입 금지**) / **auto-review turn** = 해당 worker 의 codebase Workspace 만.
- **ledger vector 는 선택 주입된 owner 만**(전체 watched 넣으면 한 codebase 변화가 instance 전 turn 재주입).

### G. UI
- 로스터 Live = instance 카드(watch-list 뱃지 목록, primary 강조). 코드베이스 카드 = 역인덱스("이 코드베이스를 보는 오퍼레이터 N"). "오퍼레이터 준비"(P2 warm) = instance 생성/warm 으로 이전.
- refs 편집 UI(watch-list 추가/제거) = N:M enable phase.

## 4. Phasing (dual-read 무중단, 각 phase 별 PR + Codex 교차검증)

(R1 phase 수정안 반영 — attribution/lineage 를 flip 앞에, N:M enable 3분할)

| Phase | 내용 | 성격 |
|---|---|---|
| **W-P0** | spec lock (이 brief → Codex GO) | 문서 |
| **W-P1** | inert schema + 제약: `operator_instances`(id CHECK 'oi_%', **thread 상태 전체 nullable 컬럼**: thread_id+pm_adapter+node_id+cwd+source_generation+source_hash+workspace_path — §3.E 소유 이전분, backfill 포함) + `operator_codebase_refs`(primary 이중 unique) + `runs.operator_instance_id`/`retry_root_run_id`(nullable) + 백필(기존 PM=size1 primary instance). **런타임 무영향** | migration |
| **W-P2** | `resolveOperatorConversationId` 단일 resolver 도입 + 전 파서(서버/클라/envelope/boot-resume) 경유 교체. **legacy emit 유지**(slot 은 legacySlotId 형태 유지, instanceConversationId 는 W-P5 flip 에서 활성) — 동작 불변 | dual-read |
| **W-P3** | attribution: `/execute` envelope 서버 derive + `parent_run_id` 기록 + retry lineage 복사 + audit `operator_instance_id` derive + **`operator_instances.thread_id` 실소유자 전환**(pm_thread_id=read-only bridge) | 배선 |
| **W-P4** | auto-review instance receiver 전환(①spawn instance ②primary ③Top, broadcast 0) + **T5/breaker lineage-aware**(`hasHigherRetryAttempt` = `receiverInstanceId:taskId` 키 + `retry_root_run_id` lineage 필터) | 수신자 |
| **W-P5** | canonical flip: registry/conversation 슬롯 instance 기준(`operator:oi_*`), legacy route 유지. repo 409 guard primary-ref 화 | flip |
| **W-P6a** | refs CRUD + router "이름→primary instance" + no-primary/ambiguous 처리 | feature |
| **W-P6b** | reference dispatch enable + 메모리 주입 정책(turn codebase-context explicit) | feature |
| **W-P6c** | UI roster/코드베이스 역인덱스 + refs 편집 | UI |
| **W-P7** | cleanup: pm_enabled/preferred_pm_adapter/pm_thread_id 이전 완료 + project delete/ref 제거 정책 + legacy alias 제거 여부 | 정리 |

## 5. 파손 방지 불변식
- auto-review/retry/T5 suppress: 수신자 정책 결정론(§3.B) — broadcast 0.
- harvest exactly-once run:harvested 불변. materialization lease/worker 슬롯 불변.
- reconciliation annotate-only 불변. conversationId `operator:` canonical(instance 형태로 확장, `pm:` 재도입 없음).
- 각 phase 는 독립 배포 가능(중간 broken 0) — additive/dual-read 만.

## 6. 비범위 (MVP)
- refs-only(primary 없는) folder-less dispatcher instance. cross-node 직접 FS. Profile 자동 학습. Resident(상주) — DE-SCOPE 확정(one-shot 유지). 코드베이스 권한 세분(rw/ro 등 role 2종 이상).

## 7. Codex 설계리뷰 요청 관점
1. §3.A dual-read alias 가 정말 무중단인가 — legacy id 로 오는 모든 경로(SSE/UI/parent-notice/reconciliation) 전수에서 구멍?
2. §3.B 수신자 정책 결정론이 T5(retry suppress)/B-lite(자동 retry)와 상호작용에서 hole 0 인가?
3. §3.C primary 최대 1 + reference dispatch 허용 — 동시 dispatch 시 태스크 상태 머신/큐/드리프트에서 깨지는 것?
4. §3.E thread 이전(dual-write) 함정. §3.F ledger 선택-owner 정책의 회귀.
5. W-P1~P6 순서/독립배포 검증. 각 phase 규모.
6. NO-GO 요소 / 대안.
