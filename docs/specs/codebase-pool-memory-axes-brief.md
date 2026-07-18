# 공용 프로젝트 폴더 풀 + 직교 3축 메모리 — 후속 설계 brief

> **상태**: v2 DRAFT (Codex R1 **NO-GO**(6 BLOCKER/7 SERIOUS/2 NIT) 반영. Codex R2 재게이트 대기 → 사용자 lock-in 전).
> **권한 모델 LOCKED** (사용자, 2026-07-19): **공용 풀(favorite) 모델** — refs 는 dispatch 권한이 아니라 기본값/라우팅/watch-요약. 부모 brief §3.D(reference=dispatch권한) **하향 수정**. (§4)
> **부모 brief**: [`operator-codebase-refs-brief.md`](./operator-codebase-refs-brief.md), [`memory-layer-brief.md`](./memory-layer-brief.md), [`operator-generalization-brief.md`](./operator-generalization-brief.md).
> **성격**: 새 아키텍처가 아니라 **(A) LOCKED 계약을 구현이 못 따라간 갭 마감 + (B) defer 됐던 오퍼레이터 페르소나 메모리 축(P-B2) 완성 + (C) 공용 풀 권한 의미 재잠금.**

## 0. 용어

- **프로젝트 폴더** = 코드베이스 = `projects` 테이블 (사용자 호칭. 코드/DB 엔티티 리네임 없음 — 개념 명칭만).
- **오퍼레이터** = `operator_instances` (identity `oi_<nanoid>`). **매니저** = Master/Top (메모리 owner `user`).
- 3계층: Master(Top) → Operator → Worker.

## 1. 사용자 요구 (2026-07-19)

1. **Q1 — 폴더 자유 참조**: "폴더를 특정 오퍼레이터에 **할당하지 않더라도** 다른 오퍼레이터가 자유롭게 참조할 수 있는 형태" = 폴더 = 어떤 오퍼레이터든 참조·작업 가능한 **공용 풀**.
2. **Q2 — 메모리 재스코핑**: "메모리도 폴더 별이 아니라 **매니저·오퍼레이터 별**로 되어야 하는 것 아닌가?"

## 2. 검증된 현황 (Explore ×2 + Codex 독립조사 + Codex 게이트 3자 → 코드 확정)

부모 brief 는 W-P0~W-P7 을 "전 구현 완결", §3.D/§3.F 를 "반영 완료"로 기재하나 **코드는 두 LOCKED 계약을 안 지킨다** (file:line 직접 확인, Codex R1 재검증 CONFIRMED).

### 2.1 Q1 관련 — 현재는 "폴더 = 오퍼레이터 1:1 소유" (공용 풀 아님)

| 사실 | 근거 | R1 |
|---|---|---|
| `operator_codebase_refs.role ∈ {primary, reference}`. primary = 폴더당 1 + 인스턴스당 1(이중 partial-unique). reference = 무제한 | `051_operator_instances.sql:21-37` | — |
| 첫 메시지 → `oi_<projectId>` lazy 생성 + 자기 폴더 primary → **기본값 = 폴더 1개가 오퍼레이터 1명 소유** | `runService.js:781`, `051…sql:63-76` | — |
| `reference` ref 는 cwd/파일 접근 **미확장** — cwd 항상 primary 폴더 고정 | `operatorSpawnService.js:636-655` | — |
| ref 없이 dispatch 해도 실행되나 `operator_instance_id/parent_run_id=null` "unwatched" → **harvest/auto-review 가 dispatch 오퍼레이터가 아니라 폴더 primary 로 귀환** | `lifecycleService.js:686,691,724`, `app.js:348` | CONFIRMED |
| **[§3.D 미준수]** reconciliation 이 claim 프로젝트를 `primaryProjectId ‖ legacyProjectId` 와만 비교 → reference 폴더 claim 은 400 | `reconciliationService.js:335,342-351` | CONFIRMED (a) |
| audit attribution 도 primary/legacy 일치 요구 → reference claim 허용해도 audit instance NULL | `reconciliationService.js:435,451` | CONFIRMED |

### 2.2 Q2 관련 — 메모리는 이미 owner-key, 단 오퍼레이터 축 미완

| 사실 | 근거 | R1 |
|---|---|---|
| `owner_type ∈ {workspace(=project_id), user(=Master 전역), profile(=폴더없는 오퍼레이터)}` | `ownerKey.js:37-84`, `044_profile_memory_items.sql:30-66` | — |
| 매니저 메모리(user, `master_memory_items`)·폴더없는 오퍼레이터 메모리(profile) 이미 존재 | `030_master_memory.sql`, `specialistService.js:101-125` | — |
| **[§3.F 미준수]** 상주 오퍼레이터 turn 주입 owner = `workspace`(+조건부 user)뿐. profile·watch-list 요약 없음 | `conversationService.js:440,468-474` | CONFIRMED (b) |
| **generic turn 자체가 사실상 없음** — explicit 없으면 항상 primary workspace, primary 없을 때만 generic(=비범위 refs-only) | `conversationService.js:52` | CONFIRMED |
| profile distillation 미배선 — scheduler 가 non-workspace owner skip | `memoryDistillService.js:165,173-176` | CONFIRMED (c) |
| **profile revision 사실상 0** — adapter 가 `getRevision(ownerId)` 호출하나 그 함수는 인자를 **workspace project_id 로 조회**하고 profile write 는 revision bump 를 생략 → 정상 profile id 는 0 반환(ID 충돌 시 엉뚱한 non-zero 위험). ⚠ "상수 0"이 아니라 **잘못된 workspace 조회**(R1 NIT 정정) | `memoryComposer.js:640,646`, `memoryService.js:273,300` | REFUTED-문언 / 효과 CONFIRMED (d) |
| HTTP 라우트가 turn 폴더 컨텍스트(`codebaseProjectId`) 유실 — 서비스는 받으나 라우트가 `{text,images}`만 | `conversations.js:48` vs `conversationService.js:244` | CONFIRMED (e) |

## 3. 핵심 통찰 — 직교 메모리 축 (3축 + episodic L0)

3자 만장일치: 폴더 공용화(Q1) + 폴더 지식까지 오퍼레이터 이동(Q2 직역) = **충돌**(A가 배운 함정을 B가 못 봄 ‖ 페르소나 섞임). 해소 = 지식을 종류별 직교 축으로.

| 지식 종류 | 축 | 스코프 | 근거 |
|---|---|---|---|
| **폴더 지식** (안정적 convention/함정/빌드·테스트법) | `workspace` (장기) | 폴더=공유 | 폴더 쓰는 모두 공유 → Q1 뒷받침 |
| **오퍼레이터 페르소나** (선호 접근법·보고 스타일) | `profile` (장기) | 오퍼레이터 | Q2 핵심. 배선 미완 |
| **매니저/사용자 정책** | `user` (장기) | 전역 | 이미 있음 |
| **task/run/branch/node-specific 관측·가설** | **`episodic` (L0)** | 단명 | R1 SERIOUS 7 — workspace 오염 방지 |

- **왜 episodic(L0) 축을 명시하나**: 현재 실행 관측(예: Node 환경)을 프로젝트 단일 `env.node_resolution` fact 로 **덮어씀**(`app.js:637,651`). branch/worktree/source-generation 별 사실이나 작업 중 가설을 workspace 장기기억으로 올리면 다른 오퍼레이터를 오염시킨다. → **workspace 승격 admission 강화**: operator·task·branch 무관한 안정 사실만 workspace 승격, 나머지는 episodic 유지(부모 메모리 모델 L0 유지).
- 사용자 Q2 직관은 **페르소나엔 맞고 폴더 지식엔 폴더 공유가 맞다** → Q2 = "폴더 메모리 이동"이 아니라 **"폴더 지식 공유 유지 + 오퍼레이터 페르소나 축 완성 + episodic 분리"**.

## 4. LOCKED — 공용 풀 권한 모델 (favorite) — 사용자 2026-07-19

부모 §3.D(reference=dispatch권한)를 **하향 수정**. (R1 BLOCKER 1 해소)

- **`projects` = 공용 리소스 풀.** 폴더 row 가 존재하면 어떤 오퍼레이터든 참조·dispatch 대상으로 삼을 수 있다. ref 는 **작업 가능 여부의 하드 게이트가 아니다.**
- **refs 의미**: `primary` = 기본 라우팅 수신자 + 기본 cwd + auto-review fallback. `reference` = favorite/watch + 컨텍스트 요약 대상. **둘 다 dispatch "권한"이 아니다.**
- **attribution 은 refs 가 아니라 `pm_run_id` 로부터 파생**: 유효한 오퍼레이터 `pm_run_id` 가 dispatch 하면 대상 폴더에 ref 가 없어도 `runs.operator_instance_id`/`parent_run_id` 를 **유지**하고 `dispatch:unwatched_codebase` 관측 이벤트만 남긴다(하드 차단 아님). → auto-review 가 dispatch 한 오퍼레이터로 정확히 귀환.
- **audit 은 current refs 가 아니라**: ① 서버-derive instance(`pm_run_id`→instance) + ② entity project binding(task/run→project 결합 무결성, **제거 금지**) + ③ worker 의 durable `run.operator_instance_id` 로 검증. **current-ref membership 검사 금지**(TOCTOU — dispatch 후 ref 제거 시 오귀속, R1 SERIOUS 2).
- **refs mutation 은 favorite 편집**이라 human/operator 모두 허용(하드 게이트 모델이었다면 human-only 여야 했으나 favorite 이므로 불필요).

## 5. 설계

리네임/파괴 없음. 전 변경 additive.

### 5.0 turnMode 계약 (R1 BLOCKER 2 해소 — 선행)
- 오퍼레이터 send 경로에 명시적 **`turnMode ∈ {codebase, generic, auto_review}`** 도입:
  - `codebase`: 특정 폴더 문맥(explicit `codebaseProjectId` 또는 primary). 그 폴더 workspace 강주입.
  - `generic`: 폴더 비특정(오케스트레이션/상담). watch-list 요약 + profile + user 주입, **N workspace raw 미주입**.
  - `auto_review`: harvest 리뷰. 해당 워커 폴더 workspace 만.
- `resolveTurnCodebaseContext` 를 turnMode 인지로 확장(현재 "explicit 없으면 무조건 primary" 를 대체). generic 이 도달 가능해짐.

### Track A — 공용 폴더 풀 (Q1)
- **A1 (attribution & audit)**: (i) dispatch 시 유효 pm_run_id 면 ref 무관 attribution 유지(§4). (ii) reconciliation/`deriveOperatorInstanceIdFromPmRun` 을 refs 일치 요구에서 **서버-derive instance + entity binding + durable run id** 로 전환. cross-project 오염 방어는 entity binding 이 담당(약화 없음). annotate-only 불변.
- **A2a (turn-context 배선)**: `POST /api/conversations/:id/message` + 클라 hook 이 `codebaseProjectId` + `turnMode` 전달. 서비스 소비.
- **A2b (컨텍스트 실제 전달 — R1 BLOCKER 3 핵심)**: 선택 폴더를 오퍼레이터에게 **실제 전달** — outbound payload 에 "이번 턴 대상 폴더" 구조화 블록(경로/브랜치/브리프 요약) + router 응답이 "현재 오퍼레이터 유지 + codebase context" 반환(현재는 explicit 프로젝트를 그 폴더 primary 로 **재라우팅** `routerService.js:91,110`) + UI 폴더 선택기. 시스템 프롬프트의 "이 프로젝트 범위에 머물라"(`operatorSpawnService.js:249`) 를 turn-context 인지로 완화. **실제 파일 작업은 대상 폴더 워커가 수행**(오퍼레이터=오케스트레이션, 다중폴더 직접편집은 비범위).
- **A2 out-of-watch-list 정책** (R1 rec #3): 존재하는 project row 면 허용(ref 자동생성 ✗ — hidden state mutation 금지), 없는/삭제된 project 만 fail-closed. primary fallback ✗(사용자 선택 조용히 변경 금지).

### Track B — 직교 메모리 축 (Q2)
- **B0 (profile 바인딩/백필/lifecycle — R1 BLOCKER 4 + SERIOUS 5, 신설 선행)**: `operator_instances.profile_id` 백필(legacy 인스턴스마다 private profile 생성) + assign/unassign API + profile delete **409 가드**(참조 instance 있으면) + orphan memory 정책 + persona 변경 시 thread invalidation. 최종 `profile_id` NOT NULL 지향. (B3 구 열린결정 = profile 재사용으로 확정, `operator_instance` owner 신설 ✗ — 042/044 CHECK+jobs/candidates/items/revision/Composer 전면 재migration 회피)
- **B2a (owner-keyed profile revision — R1 BLOCKER 5, B1 앞)**: profile 전용 revision 카운터 실체화(현 `getRevision` 의 workspace 조회 → owner-keyed). profile active write 가 revision bump. **B1 앞에 배치**(안 그러면 최초 주입 후 profile 수정 영구 stale).
- **B1 (generic-turn 주입 §3.F, flag-gated — R1 SERIOUS 3)**: turnMode 별 owner 합성 — codebase(선택 폴더 workspace + profile + user) / generic(profile + user + watch-list 요약) / auto_review(워커 폴더 workspace만). ledger vector 는 선택 주입 owner 만. **`PALANTIR_MEMORY_MULTI_OWNER` off 기본 byte-identical 유지** → 신규 주입은 flag/turn-context 게이트 하 rollout(기존 `memory-composer-multi-owner.test.js:309` 계약 불변).
- **B2b (profile distill 파이프라인 — R1 BLOCKER 6)**: `memoryDistillService` non-workspace skip 해제 + **job/candidate/item 전 단계 `(owner_type, owner_id)` exact binding**(현 promotion 의 `cand.project_id === job.project_id` 는 profile 이 둘 다 NULL 이라 붕괴 — owner 쌍 검사로 교체) + permanent-pending 처리. 기존 `PALANTIR_MEMORY_DISTILL` off 기본 하 rollout(specialist 에도 profile memory 주입되는 건 의도된 제품변화).
- **watch-list 요약 예산** (R1 rec #4): **metadata-only, 최대 8 ref 또는 800 tokens**. primary+explicit-selected 항상 포함, 나머지 결정론 정렬, 초과 `+N more`. 이름/id/role/node 정도만 — raw workspace memory·전체 brief 금지. selected codebase turn 에서만 그 폴더 brief 요약 + workspace memory 를 별도 capped block.

### 문서 정합 (P0, R1 NIT 2)
- 부모 `operator-codebase-refs-brief.md:3` 상태줄("§3.D/§3.F 반영 완료")·CLAUDE.md 해당 서술을 **P0 에서 즉시 정정**(중간 phase 동안 거짓 상태 유지 금지). §4 로 §3.D 는 하향 수정됨을 명기.

## 6. Phasing (Codex R1 재배열, 각 phase 독립배포 broken 0, additive)

| Phase | 내용 | 규모 |
|---|---|---|
| **P0** | 의미·문서 lock(§4 권한모델) + 부모 brief/CLAUDE.md 정정 → Codex R2 게이트 → 사용자 lock-in | — |
| **A1** | dispatch attribution ref-무관 유지 + reconciliation/audit 서버-derive+entity-binding+durable-id 전환 | 중 |
| **A2a** | service/HTTP `codebaseProjectId`+`turnMode` 배선 (§5.0) | 중 |
| **A2b** | router 응답(현오퍼레이터 유지+context) + UI 선택기 + payload context block + 프롬프트 완화 | 중~대 |
| **B0** | profile 바인딩/백필/assign API/delete 409/orphan/lifecycle | 중~대 |
| **B2a** | owner-keyed profile revision 실체화 | 중 |
| **B1** | flag-gated turnMode 주입(profile+watch-list) | 대 |
| **B2b** | profile candidate→distill→promote owner-keyed exact binding | 대 |
| **flip** | default rollout(flag on) | 소 |

- 각 phase 독립배포: A1 단독 = reference-dispatch attribution 정상화, B2a 없이 B1 배포 금지(stale), B0 없이 B1 금지(profile 부재).

## 7. 파손 방지 불변식
- attribution 은 **durable `run.operator_instance_id`** 권위(current-ref 재조회 금지 = TOCTOU 방어, R1 SERIOUS 2).
- auto-review/retry/T5 suppress 수신자 결정론 — **broadcast 0**(부모 §3.B).
- reconciliation **annotate-only** 불변. task/run→project entity binding **제거 금지**(cross-project 오염 방어 — refs 완화와 무관한 데이터 경계).
- 메모리 안전(secret redact·injection reject·clamp·admission·decay)은 promote(writer) 강제 — B2b distiller 우회 불가. **workspace 승격 admission**(operator/branch/run-무관 안정사실만, R1 SERIOUS 7).
- `PALANTIR_MEMORY_MULTI_OWNER`/`PALANTIR_MEMORY_DISTILL` off 기본 **byte-identical** — 신규 주입/distill 은 flag 하 rollout.
- harvest exactly-once `run:harvested` 불변. materialization lease/워커 슬롯 불변. conversationId `operator:` canonical 불변.

## 8. 비범위 (유지)
- 오퍼레이터가 여러 폴더 **직접 편집**(per-turn workspace materialization / cross-node 직접 FS). MVP = 오케스트레이션 + 워커 실행.
- refs-only(primary 없는) folder-less dispatcher. Resident 상주 — DE-SCOPE 유지. 폴더 권한 세분(rw/ro).
- `projects.pm_enabled`/`preferred_pm_adapter` instance 이전(부모 §8 후속).
- `owner_type='operator_instance'` 신설(profile 재사용으로 대체, §5 B0).

## 9. 남은 열린 결정 (권한모델 lock 이후 축소)
1. **B0 profile 백필 UX**: legacy 인스턴스에 자동 생성되는 private profile 을 UI 에 노출할지(공유 시 기억 공유 의미 명시 필요).
2. **watch-list 요약 freshness**: `watchlist_version`(`operatorInstanceService.js:184`) 를 composition gate(현재 memory owner revision 만 비교)에 synthetic owner 로 넣을지, 매턴 재생성할지.
3. **episodic(L0) 저장소 구체화**: 기존 run event/harvest 로 충분한지, 별도 단명 테이블이 필요한지(승격 admission 과 함께).

## 10. Codex R2 게이트 관점
1. §4 favorite 모델에서 cross-project 오염 방어가 entity-binding 만으로 충분한가(refs 완화 후 구멍)?
2. §5.0 turnMode 계약이 기존 send 경로(parent-notice/boot-resume/auto-review source) 와 충돌 없는가?
3. A2b payload context block + 프롬프트 완화가 codex/claude 어댑터 캐싱(model_instructions_file 안정성)·thread-resume 를 깨지 않는가?
4. B0 profile 백필/NOT NULL 전환이 기존 무프로필 legacy instance·specialist 경로 회귀 없는가?
5. B2a/B2b owner-keyed 전환이 workspace 경로 byte-identical 유지하는가?
6. 재배열 순서 broken 0 재검증. NO-GO 잔존 요소.
