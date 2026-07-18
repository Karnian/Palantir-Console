# 공용 프로젝트 폴더 풀 + 직교 3축 메모리 — 후속 설계 brief

> **상태**: DRAFT (검토 대기 — Codex 게이트 → 사용자 lock-in 전).
> **부모 brief**: [`operator-codebase-refs-brief.md`](./operator-codebase-refs-brief.md) (W-P0~W-P7 구현 완결), [`memory-layer-brief.md`](./memory-layer-brief.md), [`operator-generalization-brief.md`](./operator-generalization-brief.md).
> **성격**: 새 아키텍처가 아니라 **(A) 이미 LOCKED 된 계약을 구현이 못 따라간 갭 마감 + (B) 의도적으로 defer 됐던 오퍼레이터 페르소나 메모리 축(P-B2) 완성.**

## 0. 용어

- **프로젝트 폴더** = 코드베이스 = `projects` 테이블 (사용자 호칭. 코드/DB 엔티티 리네임 없음 — 개념 명칭만).
- **오퍼레이터** = `operator_instances` (identity: `oi_<nanoid>`). **매니저** = Master/Top (메모리 owner `user`).
- 3계층: Master(Top) → Operator → Worker.

## 1. 사용자 요구 (2026-07-19)

1. **Q1 — 프로젝트 폴더 자유 참조**: "폴더를 특정 오퍼레이터에 **할당하지 않더라도** 다른 오퍼레이터가 자유롭게 참조할 수 있는 형태였으면 좋겠다." = 폴더 = 어떤 오퍼레이터든 참조·작업 가능한 **공용 풀**.
2. **Q2 — 메모리 재스코핑**: "메모리도 프로젝트 폴더 별이 아니라 **매니저·오퍼레이터 별**로 되어야 하는 것 아닌가?"

## 2. 검증된 현황 (Explore ×2 + Codex 독립 조사 3자 수렴 → 코드 확정)

부모 brief 는 W-P0~W-P7 을 "전 구현 완결"로, `operator-codebase-refs-brief.md` §3.D/§3.F 를 "반영 완료"로 기재하나, **실제 코드는 두 LOCKED 계약을 지키지 않는다** (아래 file:line 은 이번 세션 직접 확인).

### 2.1 Q1 관련 — 현재는 "폴더 = 오퍼레이터 1:1 소유" (공용 풀 아님)

| 사실 | 근거 |
|---|---|
| `operator_codebase_refs.role ∈ {primary, reference}` (컬럼명 `ref_type` 아님). primary = 폴더당 1 + 인스턴스당 1 (이중 partial-unique). reference = 무제한. | `db/migrations/051_operator_instances.sql:21-37` |
| 오퍼레이터에 첫 메시지 → `oi_<projectId>` lazy 생성 + 자기 폴더 primary 물고 태어남 → **기본값 = 폴더 1개가 오퍼레이터 1명에 소유됨** | `runService.ensurePrimaryOperatorInstanceForProject`, `051…sql:63-76` |
| `reference` ref 는 오퍼레이터 cwd/파일 접근을 **확장하지 않음** — cwd 는 항상 primary 폴더 고정 | `operatorSpawnService.js:636-655` |
| ref 는 하드 접근 게이트도 아님 — ref 없이 dispatch 해도 실행되고 `operator_instance_id=null` "unwatched" 기록 | `lifecycleService.js:709-739` |
| **[LOCKED §3.D 미준수]** reconciliation 이 claim 의 프로젝트를 오퍼레이터의 `primaryProjectId ‖ legacyProjectId` 와만 비교 → **reference 폴더에 대한 claim 은 400.** brief §3.D 는 "claim ∈ instance refs(any role)" 를 명시했으나 코드는 primary-only. | `reconciliationService.js:335, 342-351` |

→ **판정**: 지금은 공용 풀이 아니다. `reference` 를 붙여도 (a) 실제 작업 접근이 안 열리고 (b) 그 폴더에 대한 dispatch 가 audit 에서 거부될 수 있다. brief 가 약속한 "reference = dispatch 권한"이 reconciliation 에서 미구현.

### 2.2 Q2 관련 — 메모리는 이미 owner-key (workspace/user/profile), 단 오퍼레이터 축 미완

| 사실 | 근거 |
|---|---|
| 메모리는 `project_id` 단일 스코프 → `(owner_type, owner_id)` 로 리팩터링 완료. `owner_type ∈ {workspace(=project_id), user(=Master 전역), profile(=폴더 없는 오퍼레이터)}` | `services/ownerKey.js:37-84`, `db/migrations/044_profile_memory_items.sql:30-66` |
| 매니저 메모리(user, `master_memory_items`)·폴더-없는 오퍼레이터 메모리(profile) 는 **이미 존재** | `db/migrations/030_master_memory.sql`, `044…sql`, `specialistService.js:101-125` |
| **[LOCKED §3.F 미준수]** 상주(폴더-bound) 오퍼레이터 generic turn 주입 owner = `workspace`(+조건부 `user`)뿐. **profile 도 watch-list 요약도 주입 안 함.** brief §3.F 는 "generic turn = User/Profile + watch-list 요약"을 명시. | `conversationService.js:468-474` |
| `user`+`workspace` 동시 주입은 `PALANTIR_MEMORY_MULTI_OWNER=1`(기본 off) 일 때만. 기본은 workspace 있으면 workspace-only. | `conversationService.js:440`, `app.js` options |
| profile candidate distillation 미배선 — scheduler 가 non-workspace owner skip → 오퍼레이터가 remember 해도 candidate 영구 pending | `memoryDistillService.js:173-176` ("deferred to P-B2") |
| profile revision = 항상 0 (project_memory_revision 은 workspace 전용). specialist 는 ephemeral 이라 무해하나, **상주 오퍼레이터에 붙이면 ledger 캐시 무효화가 깨짐** | `memoryComposer.js:646-651` |
| HTTP 메시지 라우트가 turn 의 명시적 폴더 컨텍스트(`codebaseProjectId`)를 유실 — 서비스는 인자를 받으나 라우트가 `{text, images}` 만 추출 | `routes/conversations.js:48` vs `conversationService.js:421` |

→ **판정**: "매니저/오퍼레이터 별 메모리" 축은 **개념·스키마상 이미 있으나**, 폴더-bound 오퍼레이터의 **페르소나 축이 배선 미완**(distillation/revision/generic-turn 주입 전부 defer 상태).

## 3. 핵심 통찰 — 두 요구는 그대로 합치면 **충돌**, 직교 3축이 해소책

3자(Explore ×2 + Codex) 만장일치:

> 폴더를 공용화(Q1)하면서 **폴더 지식**까지 오퍼레이터별로 옮기면(Q2 직역) → 오퍼레이터 A 가 그 폴더에서 배운 함정/빌드법을 오퍼레이터 B 가 못 본다. 반대로 전부 폴더에 묶으면 오퍼레이터 페르소나가 섞인다.

**해소 = 메모리를 한 축이 아니라 직교 3축으로** (지금 owner-key 설계가 이미 의도한 구조):

| 지식 종류 | owner_type | 스코프 | 근거 |
|---|---|---|---|
| **폴더 지식** (convention/함정/빌드·테스트법/env fact) | `workspace` | 폴더 = 공유 | 같은 폴더 쓰는 **모든** 오퍼레이터가 공유해야 함 → Q1(공용화)을 **뒷받침** |
| **오퍼레이터 페르소나** (선호 접근법·보고 스타일·장기 판단) | `profile` | 오퍼레이터 | Q2 의 핵심. **배선 미완** |
| **매니저/사용자 정책** (교차 프로젝트 선호) | `user` | 전역 | 이미 있음 |

→ 사용자 직관("메모리를 오퍼레이터별로")은 **페르소나에 대해선 맞고, 폴더 지식에 대해선 폴더 공유가 맞다.** 따라서 Q2 는 "폴더 메모리를 오퍼레이터로 이동"이 아니라 **"폴더 지식은 공유 유지 + 오퍼레이터 페르소나 축 완성"** 으로 재정의한다.

## 4. 설계

리네임/파괴 없음. 전 변경 additive + 부모 brief 계약 위에서.

### Track A — 공용 프로젝트 폴더 풀 완성 (Q1)

- **A1 (reconciliation §3.D 정합)**: claim 의 `project_id/task_id/run_id` 검증을 primary-only → **오퍼레이터 instance refs(any role) 멤버십**으로. reference 폴더에 대한 정당한 claim 이 400 안 나게. **단 task/run→project 결합 무결성 검사는 유지**(권한과 별개인 데이터 경계 — 잘못된 프로젝트에 audit data 기록 방지). annotate-only 불변.
- **A2 (turn-context 폴더 선택)**: `POST /api/conversations/:id/message` 가 `codebaseProjectId`(오퍼레이터의 watch-list ∈ 검증) 를 받아 `sendMessage` 에 전달. 오퍼레이터가 watch 중인 **N 폴더 중 이번 턴 대상 1개**를 명시. no-selection = 기존 동작(primary). router 다중 매칭 disambiguation 포함.
- **A3 (의미 확정, 스키마 무변경)**: `primary` = 기본 라우팅 수신자 + 기본 cwd + auto-review fallback **만**. `reference` = watch/favorite + dispatch 권한. **ref 를 "작업 가능 여부"의 하드 게이트로 쓰지 않는다**(폴더 row 존재 = 참조 가능). 실제 파일 작업은 대상 폴더의 **워커**가 그 폴더 workspace 에서 수행(오퍼레이터는 오케스트레이션). = "공용성 = 언제든 선택 가능"이지 "항상 전부 주입/접근"이 아님.

### Track B — 직교 메모리 3축 완성 (Q2)

- **B1 (generic-turn 주입 §3.F 정합)**: 상주 오퍼레이터 generic turn 에 (a) 오퍼레이터 profile 메모리 + (b) watch-list 요약을 owner 로 합성. A2 의 turn-context 와 연동: **codebase-specific turn** = 선택된 폴더 workspace 강주입(+profile+user), **generic turn** = profile+user + watch-list 요약(N workspace raw 전체 주입 금지), **auto-review turn** = 해당 워커 폴더 workspace 만. ledger vector 는 선택 주입 owner 만.
- **B2 (profile 파이프라인 완성 = 구 deferred P-B2)**: `memoryDistillService` 의 non-workspace skip 해제 → profile candidate→distill→promote 전 경로 배선 + **profile revision 실체화**(profile 전용 revision 카운터 — `memoryComposer.buildProfileAdapter` 의 revision-0 가 상주 오퍼레이터에선 ledger 캐시 무효화를 깸). permanent-pending 처리 포함.
- **B3 (열린 결정 — §8)**: 폴더-bound 오퍼레이터 인스턴스의 페르소나를 **profile 로 키잉**(codex 권장: 안정적 `operator_profiles.id`) vs **신규 `owner_type='operator_instance'`** 추가. 기본안 = profile 재사용, instance-owner 는 정말 instance별 자서전 상태가 필요할 때만.

### 문서 정합 (Track A/B 에 동반)

- 부모 `operator-codebase-refs-brief.md` 상태줄("§3.D/§3.F 반영 완료")과 CLAUDE.md 의 해당 서술을 **실제 코드 상태에 맞게 정정**(정합 완료 시점에 갱신). = codex 가 짚은 doc-drift 2건 종결.

## 5. Phasing (각 phase 독립 배포 + Codex 교차검증, additive)

| Phase | 내용 | 성격 | 규모 |
|---|---|---|---|
| **P0** | 이 brief → Codex 게이트 → 사용자 lock-in | 문서 | — |
| **A1** | reconciliation refs-membership 검증(§3.D) + 무결성 검사 유지 | 배선 | 소 |
| **A2** | 라우트 `codebaseProjectId` + router disambiguation + watch-list ∈ 검증 | 배선 | 소~중 |
| **B1** | generic-turn profile+watch-list 주입(§3.F) — A2 의 turn-context 소비 | 배선 | 중 |
| **B2** | profile candidate→distill→promote + profile revision 실체화 | 서브시스템 | 중~대 |
| **Cleanup** | 부모 brief/CLAUDE.md doc-drift 정정 + 회귀 테스트 | 정리 | 소 |

- 권장 순서: A1 → A2 → B1 → B2 (A2 가 B1 의 turn-context 선행). B3 결정은 P0 lock-in 시 확정.
- 각 phase 는 이전 phase 없이도 회귀 0(예: A1 단독 = reference-dispatch audit 만 정상화).

## 6. 파손 방지 불변식

- auto-review/retry/T5 suppress 수신자 정책 결정론 불변 — broadcast 0 (부모 §3.B).
- harvest exactly-once `run:harvested` 불변. materialization lease / 워커 슬롯 불변.
- reconciliation **annotate-only** 불변 (A1 은 검증 대상을 넓힐 뿐 block 아님). task/run→project 결합 무결성 검사 **제거 금지**.
- 메모리 안전(secret redact·injection reject·clamp·admission·decay)은 promote(writer)가 강제 — B2 가 distiller 우회 불가(기존 계약 유지).
- `PALANTIR_MEMORY_MULTI_OWNER` off 기본에서 byte-identical 회귀(주입 owner 추가는 flag/turn-context 게이트 하에서만).
- conversationId `operator:` canonical(instance 형태) 불변, `pm:` 재도입 없음.

## 7. 비범위 (이번에도 유지)

- 오퍼레이터가 **여러 폴더를 직접 편집**(per-turn workspace materialization / cross-node 직접 FS) — 큰 별도 설계. MVP 는 "오퍼레이터 오케스트레이션 + 워커가 대상 폴더서 실행".
- refs-only(primary 없는) folder-less dispatcher instance. Resident(상주) — DE-SCOPE 유지.
- 폴더 권한 세분(rw/ro role 2종 이상).
- `projects.pm_enabled`/`preferred_pm_adapter` 의 instance 이전(부모 §8 후속 후보).

## 8. 열린 결정 (Codex 게이트 질문)

1. **B3**: 폴더-bound 오퍼레이터 페르소나를 profile 재사용으로 할지, `owner_type='operator_instance'` 신설할지. 폴더-bound instance 는 profile_id nullable(무프로필 legacy)인데 — 무프로필 instance 에 페르소나를 어떻게 붙이나? (profile 자동 부여 vs instance-owner 신설)
2. **A1 정합 방향**: reconciliation 을 refs-membership 으로 넓히는 게 맞나, 아니면 부모 brief §3.D 를 primary-only 로 **하향 수정**(reference = dispatch 권한 철회)하는 게 맞나? = "reference 로 실제 dispatch 를 허용할 것인가"라는 제품 결정.
3. **A2 watch-list ∈ 검증**: turn 이 명시한 `codebaseProjectId` 가 오퍼레이터 watch-list 밖이면 거부(fail-closed) vs 자동 reference 추가 vs 무시-후-primary. 
4. B1 watch-list 요약 주입의 토큰 예산/오염 위험 — N 폴더 요약이 프롬프트를 오염시키지 않는 상한?
5. A1~B2 순서/독립배포 검증. 각 phase 규모. NO-GO 요소.

## 9. 참고 — 부모 brief 상태 정정 필요 (finding, 별개)

`operator-codebase-refs-brief.md` 헤더의 "W-P0~W-P7 전 구현 완결 / §3.D·§3.F 반영 완료"는 §2 의 코드 근거상 **부정확**하다(reconciliation refs 검증·generic-turn profile/watch-list 주입 미구현). 이 brief 채택 여부와 무관하게 부모 brief 상태줄은 정정 대상.
