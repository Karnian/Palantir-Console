# Operator P-B — folder-less specialist 도입 (슬라이싱 계획 v0.2, Codex R1 반영)

> 상위: `operator-generalization-brief.md` v1.2 §6/§7/§10/§8(NO-GO) + `operator-memory-architecture.md`.
> 선행: P-A0a(#225 resolveSpawnCwd) + P-A1 owner-keying STORAGE(#227~#231) + P-A2 Composer(#233~#246) **전부 merged·prod LIVE**.
> 감독모드: Claude 계획 → Codex 검토(반복) → 구현 → Claude 리뷰.

## 0c. Codex R1 판정 = REVISE→GO (슬라이싱 GO, P-B0 조건부 GO). v0.2 가 6 Δ 반영.
1. **Q1 정합**: P-B 정의 + 네이밍 제외 ✅(brief §10 일치, rename 은 blast-radius 별도 후속).
2. **P-B0 requireExplicit 전역 와이어 ✗ (내 v0.1 오류)**: no-dir 호출 실재 — `manager.js:131/317`(Top resume/start), `messageService.js:124`, `lifecycleService.js:558`(projectless worker→server cwd fallback). → requireExplicit 는 **신규 workspace:none context 전용**, 기존 no-dir 는 **legacy passthrough 보존**(회귀테스트). §2 P-B0 수정.
3. **NO-GO #7 = "중앙화 완료·정책 미집행"**(완전 해소 아님): fallback 은 `spawnCwd.js:42` 잔존. runtime/mcp `process.cwd()`는 파일경로(저위험) — **단 specialist 가 MCP/artifact 못 쓸 때만 유지**.
4. **capability set 부족**(CLI tool 만으론 권한표면 못 덮음): PM 권한핵심=**REST 호출** → `dispatch_execute`/`task_write`/`run_control`/`dispatch_audit_write`/`memory_write`/`project_read`/`workspace_content_read`/`registry_metadata_search` 추가. **"allow all" ✗ → legacy passthrough**(Claude PM=제한 tool set `claudeAdapter.js:224`, Codex PM=sandbox bypass `codexAdapter.js:298`, 완화 위험). §2 P-B0 수정.
5. **virtual isolation 표면 더 많음**: `pm:<projectId>` 외 `runs.manager_layer CHECK(top|pm)`(mig 009), conv parser(top|pm|worker), composition ledger `slot_kind IN(top,pm)`(mig 038). → **specialist durable vs ephemeral 먼저 고정**(O10 비영속이면 durable runs/conv/ledger 에 안 태움이 일관). §2 P-B2 수정.
6. **slice5 이미 됨**: resolveOwnerFromProject 0, migration 039(old unique drop + 음성테스트 `owner-keying-slice5-storage.test.js`) 존재. → **brief/메모리 "slice5 남음" 문구 정정 필요**(현황 문서부터). P-B1 선행 불필요.
- **P-B2 최대 리스크(Codex)**: folder-less specialist 를 CLI/REST/run 중심 런타임 위에서 cwd·FS·network·MCP·env·**internal API** 권한을 실제로 fail-closed 로 묶는 방법.

---

## 0. P-B 정의 (brief §10 — 메모리 오인 정정)
**P-B = folder-less `specialist`(stateless, User memory만 주입) 도입 + Profile owner 스키마 예약 + (폴드된) A0b 안전장치.**
- ⚠️ **PM→Operator 런타임 네이밍 리팩터는 P-B 아님** — brief 어디에도 P-B PR 로 없음. 런타임은 PM 유지(`manager_layer='pm'`/conv `pm:<projectId>`). 네이밍은 별개 후속(blast-radius 큼, 본 계획 제외).
- specialist = `Profile × workspace:none × ExecutionMode:doer`. coder PM(=`profile × folder × dispatcher`)은 **불변**(O1/O6).

## 1. 선행 현황 (코드 조사 2026-06-23)
- **NO-GO #7 (process.cwd spawn fallback)**: ✅ 사실상 해소 — `resolveSpawnCwd`(utils/spawnCwd)가 pmSpawn/lifecycle/messageService/streamJsonEngine 5경로 중앙화(#225). 잔여 `process.cwd()`는 `runtime/mcp/*` **파일 경로**(spawn cwd 아님, 무관). `requireExplicit` seam 미와이어(brief: no-dir 정책 보존).
- **slice5 cleanup**: `resolveOwnerFromProject` 사용처 0(정리됨), migration 039(slice5 STORAGE owner-unique candidate 인덱스) 존재(#240). **owner-keying STORAGE 완료.**
- **NO-GO #2 (capability deny-by-default)**: ❌ 미구현 — capability matrix/enforcement 개념 없음(TmuxEngine/SubprocessEngine). A0b 신규.
- **virtual workspace 배제 가드**: ❌ 미구현. A0b 신규.
- **Profile owner**: owner-keying 은 `owner_type ∈ {user,workspace}` 만 실사용. `'profile'` 은 normalizeOwner 예약어 수준. `memory_jobs.project_id NOT NULL FK`(mig 027) 가 Profile job 막음.

## 2. 슬라이싱 (각 PR Codex 교차검증, additive·flag-gated)

### P-B0 — 선행 안전장치 (specialist 소비처 前, behavior-preserving) ⟵ Codex Δ 반영
NO-GO #2 + virtual 가드 + requireExplicit. **specialist 없이도 무해**, 신규 enum/계약만 추가 = 기존 경로 unchanged. **핵심: "allow all"이 아니라 `legacy passthrough`** — 기존 coder/worker 는 capability/cwd 정책을 **우회(통과)**, 신규 `workspace:none` 만 fail-closed.
- **capability deny-by-default scaffold** (Codex Δ4): capability vocabulary 정의 = CLI(`shell/fs/network/mcp/browser/env/artifact/inherit_run_context`) **+ 내부 REST 권한**(`dispatch_execute`/`task_write`/`run_control`/`dispatch_audit_write`/`memory_write`/`project_read`/`workspace_content_read`) + allowlist(`registry_metadata_search`, O9). enforcement seam = **기존 runtime 은 `legacy` 마커로 무검사 통과**(Claude PM 제한 tool set `claudeAdapter.js:224`·Codex PM sandbox bypass `codexAdapter.js:298` **완화 금지**). specialist 만 deny-by-default. **false-positive deny 0 회귀테스트 필수.**
- **virtual workspace 배제 가드** (Codex Δ5): `assertWorkspaceBound(ctx, surface)` — 작고 테스트가능한 계약(미사용 enum ✗). `workspace:none` 이 `projects`행/cwd/shell/FS/XPROJECT scan/L1 capture/project-route 에 닿으면 throw. P-B0 은 계약+테스트만(호출처 0=specialist 때 와이어).
- **requireExplicit seam** (Codex Δ2): `resolveSpawnCwd({ requireExplicit })` 추가하되 **신규 workspace:none 전용**. 기존 no-dir 호출(`manager.js:131/317`·`messageService.js:124`·projectless worker `lifecycleService.js:558`)은 **legacy passthrough 보존**(server cwd fallback 유지) + 회귀테스트로 고정. 전역 와이어 ✗.

### P-B1 — Profile owner 스키마 예약 (저장만, 읽기/쓰기 0)
- `owner_type='profile'` 정식 허용(normalizeOwner/parity/owner-unique). `memory_jobs.project_id NOT NULL FK` 완화(Profile job 가능, migration) + Profile candidate 생성경로 예약(미와이어).
- ⚠️ **virtual/XPROJECT/distill 스케줄러가 profile owner 를 workspace 로 오인 안 하게** — non-workspace skip 보존(#231 패턴).

### P-B2 — specialist 인스턴스 (핵심, flag-gated) ⟵ Codex Δ5: durable/ephemeral 先결정
- **선결정 (Codex Δ5)**: specialist 를 durable `runs`/conversation/composition-ledger 에 태울지 vs 완전 ephemeral. **O10 비영속이면 durable 스키마에 안 태움이 일관** — `runs.manager_layer CHECK(top|pm)`(mig 009)·conv parser(top|pm|worker)·ledger `slot_kind IN(top,pm)`(mig 038) 을 **건드리지 않음**(specialist=in-memory namespace + in-memory composition trace). durable 기록을 택하면 `manager_layer`/`slot_kind` CHECK 확장 migration + 격리 표면 전부 처리 필요(무거움) → **MVP=ephemeral 권장**.
- `Profile × none × doer` operator spawn 경로. coder PM 경로(pmSpawnService) 와 **분기**(folder 없음, worker 안 띄움=doer 직접).
- 주입 = **Composer User slot 만**(stateless, Workspace/Profile 미주입). conv/run identity = 비영속 namespace(O10, `pm:<projectId>` 충돌 ✕, resume ✕, durable write ✕). lifecycle health-loop·eventBus·SSE 격리 표면 명시.
- capability = deny-by-default(P-B0) + 내부 metadata 검색만. shell/FS/network/MCP/artifact 차단(Codex Δ3: runtime/mcp process.cwd() 안전 전제).
- **MVP: auto-capture 0, virtual 저장 0, 영속=human R4 만.**

## 3. 첫 타겟 = P-B0 (가장 안전·작은 선행)
specialist(P-B2) 본체 전 안전장치. flag/seam 미와이어라 behavior-preserving. 잘못돼도 prod 무영향. capability/virtual guard 가 specialist 의 NO-GO 선행(#2)이므로 먼저 lock.

## 4. Codex 검토 질문
- **Q1**: P-B 정의(specialist + Profile owner 예약 + A0b, **네이밍 제외**)가 brief §10 과 정합하나? 네이밍 리팩터를 P-B 에서 빼는 게 맞나(별개 후속)?
- **Q2**: P-B0/B1/B2 슬라이싱이 additive·behavior-preserving 한가? P-B0(scaffold 미와이어)가 정말 현 동작 불변인가? 선행 순서(B0 안전 → B1 스키마 → B2 specialist) 맞나?
- **Q3**: NO-GO #7(cwd fallback)이 resolveSpawnCwd(#225)로 해소됐다는 판단 맞나? requireExplicit seam 와이어만 남았나? runtime/mcp `process.cwd()` 가 specialist 에 위험한가?
- **Q4**: capability deny-by-default scaffold 를 specialist 없이 먼저 넣을 때, 현 coder/worker 가 "전부 allow"로 정확히 보존되나(enforcement seam 이 false-positive deny 안 내나)? O9 capability set 이 충분/과한가?
- **Q5**: virtual workspace = in-memory(O2) + 비영속 namespace(O10)인데, specialist run 이 기존 run/conversation/eventBus/SSE/lifecycle health-loop 와 어떻게 격리되나? `pm:<projectId>` conv 충돌 외 빠진 격리 표면은? (이건 P-B2 상세지만 P-B0 가드 설계에 영향)
- **Q6**: slice5 cleanup(old unique index drop + 교차오염 음성 테스트)이 P-B1(Profile owner) 前 선행이어야 하나, 아니면 P-B1 과 병합 가능한가?
