# Operator P-B2b — enforcement 와이어 (계획 v0.1, Codex+athena 병렬설계 수렴)

> 상위: `operator-p-b2-plan.md` v0.2 §3 P-B2b. 선행: P-B2a #254 (OperatorContext 계약) merged.
> 설계: Codex(ask) + athena 병렬 독립검토가 **Option A (narrowly scoped)** 로 수렴.

## 0. 설계 수렴 (Codex + athena, read-only 병렬)
- **B2b = Option A, narrowly scoped**: `deriveLegacyContext` 를 **project-bound spawn 경로(worker `lifecycleService.spawnQueuedRun` + PM `pmSpawnService.ensureLivePm`)** 에 thread + resolveSpawnCwd 직전에 gate-wrapped `enforceWorkspace(ctx,'spawn_cwd')` 삽입. 모든 기존 run 은 legacy → `isEnforced=false` → **삽입 전부 inert = byte-동치**. 가치 = seam 이 실제 spawn 객체(run/workspaceDir)와 합쳐지는지 증명 + legacy 회귀 lock + B2c 의 workspaceDir 오파생 함정(operatorContext §104-111) 선제 차단.
  - **B 기각**(순수 helper-only): 이미 테스트된 순수함수(assert*) 재검증뿐, "seam 이 prod spawn 과 합쳐지나"=유일한 질문 미답.
  - **C 기각**(B2c 와 fold): 최고위험 legacy threading + 최고난도 신규 backend 혼합 → blast radius 최대.
- **Top = descriptive-only**: project-derived workspaceDir 없음(safeCwd 만). project lookup 추가 **금지**. legacy 라 never enforced → B2b 에서 Top 미와이어(B2c/후속).
- **Tier 1(spawn surface) = B2b wire / Tier 2(REST 라우트) = 매핑만 문서화**(actor-identity retrofit 은 B2c specialist-identity 작업).
- **athena 핵심**: spawn-path assert 는 specialist 엔 "defense-in-depth tripwire"(specialist 는 CLI spawn 경로 자체를 안 탐 — primary 통제는 B2c backend). B2b 가치 = seam 증명 + legacy lock + tripwire.

## 1. 변경 (additive·behavior-preserving)
### (a) `server/utils/operatorContext.js` — gate-wrapped enforcement primitives
- `enforceWorkspace(ctx, surface)` = `if (isEnforced(ctx)) assertWorkspaceBound(ctx.workspaceBinding, surface)`.
- `enforceCapability(ctx, cap)` = `if (isEnforced(ctx)) assertCapability(ctx.capabilityGrant, cap)`.
- 둘 다 `isEnforced` 가 `assertOperatorContext`(+isRealGrant 위조검증) 경유 → forged context fail-closed. legacy → no-op, specialist → enforce.

### (b) `server/services/lifecycleService.js` (spawnQueuedRun) — worker spawn
- `:558 const cwd = resolveSpawnCwd({ workspaceDir: worktreePath || projectDir })` **직전**에:
  `const operatorContext = deriveLegacyContext({ run, workspaceDir: worktreePath || projectDir }); enforceWorkspace(operatorContext, 'spawn_cwd');`
- legacy worker → inert. (specialist 는 이 경로 안 탐 = B2c 별도 backend; 만약 도달하면 WORKSPACE_UNBOUND tripwire.)

### (c) `server/services/pmSpawnService.js` (ensureLivePm) — PM spawn
- `:310 const cwd = resolveSpawnCwd({ workspaceDir: project.directory })` **직전**에:
  `const operatorContext = deriveLegacyContext({ run, workspaceDir: project.directory }); enforceWorkspace(operatorContext, 'spawn_cwd');`
- legacy coder PM → inert.

### 변경 안 함 (B2c 로 이연)
- adapter tool diet(claudeAdapter baseTools / codexAdapter sandbox) enforce, REST 라우트 actor-identity gating, `enforceCapability` 와이어, specialist spawn/backend. (전부 specialist 소비자 필요 = B2c.)

## 2. Tier 2 surface→capability 매핑 (B2c 참조용 문서, 본 PR 미와이어)
| REST 라우트 | capability | specialist verdict |
|---|---|---|
| POST /tasks/:id/execute | DISPATCH_EXECUTE | DENY |
| POST/PATCH/DELETE /tasks | TASK_WRITE | DENY |
| POST/PATCH/cancel/DELETE /runs | RUN_CONTROL | DENY |
| POST /runs/:id/input, /conversations/:id/message | CONVERSATION_SEND | DENY |
| POST/PATCH /projects/:id/memory | MEMORY_WRITE | DENY |
| GET /fs?path | FS_BROWSE (+workspace fs) | DENY |
| POST/PATCH /projects, /brief | PROJECT_WRITE (+project_scope) | DENY |
| skill-packs/mcp-templates install·CRUD | REGISTRY_WRITE | DENY |
| registry/profile metadata GET | REGISTRY_METADATA_SEARCH | **ALLOW (유일)** |

## 3. B2c backend 방향 (Codex+athena 수렴, 본 PR 아님)
codexAdapter 는 항상 `--dangerously-bypass-approvals-and-sandbox`(:302) + server cwd + `state.env||process.env`(:373) fallback → deny-by-default 불가. **B2c = Anthropic Messages API + server-executed tool-use** (liveDistiller text-only client `:149-179` 재사용 + `tools:[registry_metadata_search]` function-calling 추가, additive allowlist; 보안경계는 그 server 함수=GET-only/parameterized SQL, model tool-input untrusted). codex/claude CLI 는 subtractive(escape-hatch 입증됨: `Bash(curl:*)` 제거 사례) → specialist 부적합.

## 4. 수용 기준 (회귀 = byte-동치)
1. `isEnforced(deriveLegacyContext(...))===false` (is_manager T/F, workspaceDir null/path).
2. `enforceWorkspace`/`enforceCapability`: legacy ctx → no-op(반환), specialist ctx → throw(surface/cap별).
3. worker spawn(lifecycleService) 출력 불변: cwd/env/args/mcp → `streamJsonEngine`/`executionEngine.spawnAgent` 인자 동일. 기존 lifecycle/preset-spawn 테스트 green.
4. PM spawn(pmSpawnService) 출력 불변: `adapter.startSession` 인자 동일, seed runTurn 없음, status timing 동일. pm-phase3a green.
5. Codex PM sandbox bypass·Claude manager tool diet 보존(manager-codex/manager green).
6. forged context → enforce* fail-closed(throw).
7. 풀스위트 green(node@22). operatorContext 미leak(spawn 인자/이벤트에 context/grant/invocation 안 나감).

## 5. 검증
설계는 Codex(ask)+athena 병렬 독립검토 수렴(Option A). 구현 후 **Codex R2 impl review**(spawn 인자 byte-동치·forged 가드·미leak·specialist tripwire) 가 게이트.
