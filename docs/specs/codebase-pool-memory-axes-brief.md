# 공용 프로젝트 폴더 풀 + 직교 3축 메모리 — 후속 설계 brief

> **상태**: v4 **LOCKED** (사용자 2026-07-19 lock-in + 구현 착수). Codex R1 NO-GO→v2, R2 NO-GO→v3, **R3 REVISE→조건부 GO 충족**(6 RESOLVED/1 PARTIAL, profile PATCH invalidation 문장 §5 B0 반영). 구현: A0→P0→A1→A2a→A2b→B0→B2a→B1→B2b→B-adm→flip, phase 별 codex 교차검증.
> **권한 모델 LOCKED** (사용자, 2026-07-19): **공용 풀(favorite)** — refs 는 dispatch 권한이 아니라 기본값/라우팅/watch-요약. 부모 §3.D(reference=dispatch권한) 하향. (§4)
> **부모 brief**: [`operator-codebase-refs-brief.md`](./operator-codebase-refs-brief.md), [`memory-layer-brief.md`](./memory-layer-brief.md).
> **성격**: 새 아키텍처 아님 — (A) LOCKED 계약을 구현이 못 따라간 갭 마감 + (B) defer 됐던 페르소나 메모리 축(P-B2) 완성 + (C) 공용 풀 권한 재잠금 + (D) Codex 가 발견한 pre-existing 결함 2건(canonical boot-resume / fresh·resume prompt 이중 assembly) 수정.

## 0. 용어
- **프로젝트 폴더** = 코드베이스 = `projects` (사용자 호칭. 엔티티 리네임 없음).
- **오퍼레이터** = `operator_instances`(`oi_<nanoid>`). **매니저** = Master/Top(메모리 owner `user`). 3계층 Master→Operator→Worker.

## 1. 사용자 요구 (2026-07-19)
1. **Q1**: 폴더를 특정 오퍼레이터에 **할당 안 해도** 다른 오퍼레이터가 자유롭게 참조·작업 = **공용 풀**.
2. **Q2**: 메모리도 폴더 별이 아니라 **매니저·오퍼레이터 별**로.

## 2. 검증된 현황 (Explore ×2 + Codex 독립조사 + Codex 게이트 R1/R2 → 코드 확정)
부모 brief 는 §3.D/§3.F 를 "반영 완료"로 기재하나 **코드는 미준수**(Codex R1 CONFIRMED). 요지만:
- **Q1**: 폴더당 primary 1 강제(`051…sql:21-37`), 첫 메시지 시 `oi_<projectId>` lazy+primary(`runService.js:781`) → 기본이 1:1 소유. reference 는 cwd 미확장(`operatorSpawnService.js:636-655`). reconciliation 이 primary/legacy 와만 비교(`reconciliationService.js:335,342-351`), audit attribution 도 동일(`:435,451`) → reference claim 400.
- **Q2**: `owner_type ∈ {workspace,user,profile}`(`ownerKey.js:37-84`, `044…sql:30-66`). 매니저(user)·폴더없는 오퍼레이터(profile) 메모리 존재하나 — 상주 오퍼레이터 turn 주입에 profile·watch-list 없음(`conversationService.js:468-474`), generic turn 사실상 부재(`:52`), profile distill skip(`memoryDistillService.js:173-176`), profile revision 잘못된 workspace 조회로 0(`memoryComposer.js:640,646` + `memoryService.js:273,300`), 라우트가 `codebaseProjectId` 유실(`conversations.js:48`).
- **Codex R2 신규 발견 (pre-existing, 브리프 무관)**: canonical `operator:oi_*` run 이 boot-resume 안 됨 — `manager.js:188` 이 `parseProjectConversationId`(oi_* → null, `conversationId.js:47`) 직접 호출 → `projectId=null` → resume 분기 skip → stopped. (§5 A0)

## 3. 핵심 통찰 — 직교 메모리 축 (3 장기축 + episodic L0)
폴더 공용화 + 폴더 지식까지 오퍼레이터 이동 = 충돌(A 함정을 B 못 봄 ‖ 페르소나 섞임). 해소 = 지식 종류별 직교 축:

| 지식 | 축 | 스코프 |
|---|---|---|
| 폴더 지식(안정 convention/함정/빌드법) | `workspace` 장기 | 폴더=공유 (Q1 뒷받침) |
| 오퍼레이터 페르소나(선호/스타일) | `profile` 장기 | 오퍼레이터 (Q2 핵심, 배선 미완) |
| 매니저/사용자 정책 | `user` 장기 | 전역 (있음) |
| task/run/branch/node-specific 관측·가설 | **`episodic` L0** | 단명 (승격 안 함) |

사용자 Q2 직관은 **페르소나엔 맞고 폴더 지식엔 폴더 공유가 맞다** → Q2 = "폴더 메모리 이동" 아니라 "폴더 지식 공유 유지 + 페르소나 축 완성 + episodic 분리".

## 4. LOCKED — 공용 풀 권한 모델 (favorite) — 사용자 2026-07-19
부모 §3.D 하향(reference=dispatch권한 철회). (R1 BLOCKER 1)
- **`projects` = 공용 리소스 풀.** 폴더 row 존재 = 어떤 오퍼레이터든 참조·dispatch 대상. ref 는 작업 하드게이트 아님.
- **refs 의미**: `primary`=기본 라우팅 수신자+기본 cwd+auto-review fallback. `reference`=favorite/watch+컨텍스트 요약. **둘 다 dispatch 권한 아님.** refs mutation=favorite 편집(human/operator 허용).
- **attribution 은 refs 아니라 `pm_run_id` 파생**: 유효 pm_run_id 면 ref 없어도 `runs.operator_instance_id`/`parent_run_id` 유지, `dispatch:unwatched_codebase` 관측만.
- **"유효한 pm_run_id" 정의 (R2 audit-attribution 조임)**: ① DB 존재 + `is_manager=1` + `manager_layer='operator'` + ② `resolveOperatorConversationId(pm_run.conversation_id)` 가 **active operator run/registry 와 일치**(종료/dangling run 재사용 차단) + ③ worker claim 은 추가로 **`worker.run.operator_instance_id === derivedInstanceId`**. 
  - **신뢰 경계 LOCK**: 현 auth 는 bearer actor 종류만 주고 per-instance identity 를 안 준다(`auth.js:47`). 따라서 "어느 PM 이 이 요청을 보냈나"의 완전 인증은 불가 — MVP 는 "body pm_run_id 가 active operator run 이면 그 instance 로 귀속 + **entity binding 이 blast radius 를 그 프로젝트로 한정**"을 신뢰 경계로 수용. per-instance 토큰(`PALANTIR_PM_TOKEN` 확장)은 §9 후속.
- **entity binding = NULL-포함 exact (R2 BLOCKER 1 조임)**: audit 의 task/run→project 검사를 **`entity.project_id === envelope.project_id` (NULL 불포함)** 으로. 참조된 task/run 의 `project_id` 가 NULL 이면(`tasks.project_id` nullable, `001_initial.sql:15`) **거부**(현재 `reconciliationService.js:257,358,417` 는 NULL 이면 임의 envelope project 통과 → 구멍). 이 검사는 **제거 금지**(cross-project 데이터 경계 — refs 완화와 무관).

## 5. 설계 (additive)

### 5.0 turnMode 계약 (R1 BLOCKER 2 + R2 legacy 호환)
`turnMode ∈ {codebase, generic, auto_review}` 도입 + **legacy 호환 매핑 LOCK**:

| 진입 경로 | turnMode | 비고 |
|---|---|---|
| omitted legacy operator send | `codebase(primary)` | default |
| legacy `/manager/pm/:projectId/message`(`manager.js:813`) | `codebase(projectId)` | |
| auto-review | `auto_review` **+ 기존 `source:'auto_review'` 유지** | ⚠ codex 요금 tier 가 `source` 의존(`codexAdapter.js:367`) — 제거 금지 |
| parent notice | 독립 mode 아님 — **소비하는 외부 turn 의 mode 상속** | |
| Top/worker 에 전달된 turnMode | **ignore**(400 아님, additive 무해) | |

- 주입: `codebase`=선택 폴더 workspace 강주입(+profile+user) / `generic`=profile+user+watch-list 요약(N workspace raw 미주입) / `auto_review`=워커 폴더 workspace만. ledger vector=선택 주입 owner만.

### Track A — 공용 폴더 풀 (Q1)
- **A0 (boot-resume 결함 수정 — R2 신규 BLOCKER, 독립 가치)**: `manager.js:188` boot-resume 를 `parseProjectConversationId` → **`resolveOperatorConversationId` 단일 resolver** 경유로. canonical `oi_*` run 도 재개 분기 진입. **선행 독립 검증**: 실제 operator run 의 `conversation_id` 저장 형태(oi_* vs legacy)를 확인해 라이브 결함 여부 확정 후 수정.
- **A1 (attribution & audit)**: (i) 유효 pm_run_id(§4) 면 ref 무관 attribution 유지. (ii) reconciliation/`deriveOperatorInstanceIdFromPmRun` 을 refs 일치 → 서버-derive instance + **NULL-포함 exact entity binding**(§4) + durable run id 로. annotate-only 불변.
- **A2a (turn-context 배선)**: HTTP route(`conversations.js:48`)+legacy PM route+클라 hook 이 `codebaseProjectId`+`turnMode` 전달. omitted-mode default(§5.0).
- **A2b (컨텍스트 실제 전달 + prompt 이중 assembly 수정 — R1 BLOCKER 3 + R2 조임)**: 선택 폴더를 outbound user-payload 구조화 블록(경로/브랜치/브리프 요약)으로 전달 + router 응답이 "현 오퍼레이터 유지 + codebase context"(현재는 그 폴더 primary 로 재라우팅, `routerService.js:91,110`) + UI 선택기. **"Stay within this project's scope" 완화를 fresh(`operatorSpawnService.js:249`)·boot-resume(`manager.js:337`) 양쪽에 — 공용 prompt builder 로 이중 assembly 통합**(한쪽만 완화 금지). 실제 파일작업=대상 폴더 워커.
- **A2 out-of-watch-list** (R1 rec #3): 존재하는 project row 면 허용(ref 자동생성 ✗), 없는/삭제 project 만 fail-closed. primary fallback ✗.

### Track B — 직교 메모리 축 (Q2)
- **B0 (profile 바인딩/생성/lifecycle — R1 BLOCKER 4 + R2 조임, 선행)**: 
  - **신규 instance + private profile 을 한 tx 로 원자 생성** — 현 생성 seam(`runService.js:136,781` `ensurePrimaryOperatorInstanceForProject`)이 profile 없이 instance 만 삽입하는 문제 종결. 원자 생성 배포 **후** `profile_id` NOT NULL rebuild(순서 lock).
  - legacy 무프로필 instance 백필(private profile). assign/unassign API. **unassign 의미 LOCK**: profile 은 identity 라 unassign=새 private profile 로 교체(무프로필 상태 금지 → NOT NULL 과 정합). 
  - **reassign(profile 교체) 시 그 profile 공유하는 모든 instance thread invalidation**(persona 변화). 
  - **(R3 SERIOUS 해소)** `operator_profiles` 의 **persona 또는 capabilities 변경(PATCH) 시** 그 `profile_id` 를 참조하는 **모든 instance** 의 persisted thread 를 clear + live canonical slot dispose/reset(`operatorInstanceService.js:102` thread-clear primitive 재사용). **name/description-only 변경은 invalidation 안 함**(불필요 재spawn 회피). 현 `operatorProfileService.js:147` PATCH 가 persona/capabilities 를 자유 변경하나 공유 instance 무효화 경로가 없어 stale identity 사용 — 이 경로 신설.
  - **orphan policy LOCK**: profile delete 는 참조 instance 있으면 **409**(현재 `operatorProfileService.js:174` 는 raw FK 오류) — 참조 0 일 때만 삭제.
  - B3 구 열린결정 = **profile 재사용 확정**(`operator_instance` owner 신설 ✗ — 042/044 CHECK+pipeline 전면 재migration 회피). specialist 는 profile ID 직접 수령(`specialistService.js:78`)이라 미영향.
- **B2a (owner-keyed profile revision — R1 BLOCKER 5, B1 앞)**: profile 전용 revision 카운터(현 `getRevision` 의 workspace 조회 → owner-keyed). profile active write 가 bump. **B1 선행조건**(안 그러면 최초 주입 후 profile 수정 영구 stale).
- **B1 (turnMode 주입 §3.F, flag-gated — R1 SERIOUS 3)**: §5.0 owner 합성. **`PALANTIR_MEMORY_MULTI_OWNER` off 기본 byte-identical**(신규 주입 flag/turn-context 게이트, `memory-composer-multi-owner.test.js:309` 불변).
- **B2b (profile distill 파이프라인 — R1 BLOCKER 6 + R2 owner-generic 조임)**: non-workspace skip 해제 + **job/candidate/item 전 단계 `(owner_type,owner_id)` exact binding**(현 promotion `cand.project_id === job.project_id` 는 profile 둘 다 NULL 이라 붕괴, `memoryService.js:998` → owner 쌍 비교). **내부 owner-generic core + 기존 workspace wrapper 분리 + workspace golden/parity 테스트**로 byte-identical 입증(`enqueueDistillJob`/`listCandidates`/`listActiveForDistill` 등 projectId 전용 API, `memoryService.js:843`, `memoryDistillService.js:50`). `PALANTIR_MEMORY_DISTILL` off 기본 rollout.
- **B-adm (workspace 승격 admission — R2 SERIOUS, 신규 phase)**: R6 fact upsert(`app.js:637,651` → `memoryService.js:408` `upsertFact` 즉시 active 덮어씀)에 admission gate — **operator/branch/run/source-무관 안정사실만 workspace 승격**. branch/run/node-specific 은 승격 거부(=episodic). **episodic 저장소 LOCK**: 별도 테이블 미신설 — 승격 거부 = 그냥 workspace 장기기억에 안 올림(사실은 run output/harvest 에 잔존 = 기존 episodic). 최소 변경.
- **watch-list 요약 freshness LOCK (R2 UNRESOLVED 해소)**: watch-list 요약을 **synthetic owner(`watchlist:<instanceId>`)로 ledger 에 기록** — `watchlist_version`(`operatorInstanceService.js:184`) 을 그 synthetic owner 의 revision 으로 composition gate(`compositionLedger.js:398`, 현재 memory owner revision 만 비교)에 포함 → **refs 변경 시에만 재합성**(매턴 재생성 ✗). 
- **요약 예산** (R1 rec #4): metadata-only, 최대 8 ref/800 tokens, primary+selected 항상, 결정론 정렬, 초과 `+N more`. raw workspace·전체 brief 금지.

### 문서 정합 (P0, R1 NIT 2): 부모 `operator-codebase-refs-brief.md:3`·CLAUDE.md 상태줄 즉시 정정.

## 6. Phasing (Codex R1/R2 반영, 각 phase 독립배포 broken 0, additive)
| Phase | 내용 | 규모 |
|---|---|---|
| **P0** | 의미·문서 lock(§4) + 부모/CLAUDE.md 정정 → Codex R3 → lock-in | — |
| **A0** | boot-resume resolver 수정(canonical resume, 독립 검증+fix) | 소 |
| **A1** | attribution ref-무관 + reconciliation/audit 서버-derive + NULL-exact entity binding + durable id | 중 |
| **A2a** | service/HTTP/legacy-route `codebaseProjectId`+`turnMode`+omitted default | 중 |
| **A2b** | 공용 prompt builder(fresh+resume) + router 응답 + UI + payload context block | 중~대 |
| **B0** | 원자 instance+private profile 생성 tx → NOT NULL rebuild + 백필 + assign/unassign + delete 409 + reassign invalidation | 중~대 |
| **B2a** | owner-keyed profile revision | 중 |
| **B1** | flag-gated turnMode 주입(profile+watch-list synthetic owner) | 대 |
| **B2b** | profile distill owner-generic core + workspace parity | 대 |
| **B-adm** | workspace 승격 admission(episodic 분리) | 중 |
| **flip** | default rollout | 소 |

- 의존: A0 독립 / A1 독립 / A2a→A2b / **B0→B2a→B1**(순서 강제) / B2b(B0 후) / B-adm 독립 / watch-freshness(B1 앞 lock). 각 phase 중간 broken 0.

## 7. 파손 방지 불변식
- attribution=durable `run.operator_instance_id` 권위(current-ref 재조회 금지=TOCTOU). NULL-exact entity binding 제거 금지.
- auto-review/retry/T5 수신자 결정론 broadcast 0. `source:'auto_review'` 보존(codex tier). reconciliation annotate-only.
- 메모리 안전(secret/injection/clamp/admission/decay) promote 강제. `MULTI_OWNER`/`DISTILL` off byte-identical.
- harvest exactly-once. materialization lease/워커 슬롯 불변. conversationId `operator:` canonical 불변. codex `model_instructions_file` 안정(동적 context=user payload).

## 8. 비범위 (유지)
오퍼레이터 다중폴더 직접편집(per-turn materialization/cross-node FS). refs-only dispatcher. Resident. 폴더 권한 세분(rw/ro). `projects.pm_enabled`/`preferred_pm_adapter` instance 이전. `owner_type='operator_instance'` 신설.

## 9. 남은 열린 결정 (대폭 축소)
1. **per-instance PM 토큰**(`PALANTIR_PM_TOKEN` 확장) 으로 caller-authenticity 완성 여부 — MVP 는 §4 신뢰경계 수용, 이건 후속 보안 강화.
2. **B0 private profile UI 노출**: legacy 백필 profile 을 UI 에 보일지(공유 시 기억 공유 의미 명시 필요).

## 10. Codex R3 게이트 관점
1. §4 NULL-exact entity binding + worker durable-id 매칭이 favorite 모델 cross-project 구멍을 실제로 닫는가?
2. §5.0 turnMode legacy 매핑 5규칙이 parent-notice/auto-review-source/boot-resume 전 경로 hole 0 인가?
3. A0 boot-resume 수정이 legacy `operator:<projectId>` 재개를 회귀시키지 않는가?
4. A2b 공용 prompt builder 통합이 fresh/resume 양경로 byte-identical(비-turn-context 시)인가?
5. B0 원자생성 tx→NOT NULL rebuild 순서 + unassign=교체 계약이 legacy/specialist 회귀 0 인가?
6. B2b owner-generic core 분리가 workspace parity 유지하는가? B-adm admission 이 기존 R6 fact 를 과도 차단(under-promote)하지 않는가?
7. 잔존 NO-GO 요소.
