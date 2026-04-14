# Phase 10 Worker Preset — Continuation Brief (10B → 10G)

> **목적**: 새 Claude Code 세션이 이 브리프만 읽고 Phase 10B ~ 10G 를 자율적으로 **끝까지** 진행하도록.
> **생성**: 2026-04-14 | **Phase 10A 상태**: CONDITIONAL PASS (PR #87 merged)
> **스펙 author**: Claude Opus 4.6 | **Codex round 6 review**: PASS

---

## 0. 지금까지 (Phase 10A 결과)

- Branch `spike/phase-10a-bare-auth` → PR #87 squash merged
- `scripts/spike-bare-auth.mjs` 4-variant matrix PoC 결과:
  - A) `--bare` + `CLAUDE_CODE_OAUTH_TOKEN` env → **FAIL** (CLI 가 env 무시)
  - B) `--bare` + `ANTHROPIC_API_KEY=<oauth-token>` env → **PASS**
  - C) `--bare` + `apiKeyHelper` via `--settings` → **PASS**
  - D) negative control → FAIL (expected)
- Spec §11 Round 6 에 결과 기록 + §6.9 amendment 요건 명시.
- Codex P1: 지속 경로는 `apiKeyHelper + --settings` 를 **기본**으로 (env materialize 는 fallback). Phase 10D 구현 시 반영.

## 1. 읽어야 할 문서 (이미 한 번 읽었으면 skip 가능)

1. `docs/specs/worker-preset-and-plugin-injection.md` — 전체 스펙 (특히 §6, §7, §11)
2. `docs/specs/manager-v3-multilayer.md` — 3계층 컨텍스트
3. `docs/specs/skill-packs.md` — 직교 유지 대상
4. `CLAUDE.md` — repo 규약 + 자율 모드 범위

## 2. 진행 규칙 (CLAUDE.md 의 자율 모드)

- **승인 없이 진행**: 브랜치 생성 / 구현 / `npm test` / Codex 교차리뷰 PASS 후 commit / PR / merge / main pull / 다음 phase 진입
- **승인 필요**: 되돌리기 불가 git / 스펙 재해석 / 이전 결정과 충돌 / Codex 5 라운드 넘게 미수렴

### Codex 교차리뷰 루틴 (각 phase 필수)

```
branch → 구현 → npm test → codex 교차검증 (PASS까지 반복) → commit → PR → merge → main pull → 다음 phase
```

Codex 호출:

```bash
cat <<'EOF' | node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.0.10/scripts/ask.mjs async codex
<리뷰 prompt>
EOF
# → jobId
node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.0.10/scripts/ask.mjs collect <jobId> --wait --timeout 1500
```

Codex 불가 시 `gemini` 로 fallback. 둘 다 auth 실패면 사용자 보고.

### 의사결정

- spec 명확 → 자율 진행
- 모호/복수 옵션 → Codex 에 옵션+권장안 요청 → 추천안으로 진행 + 사후 보고
- spec 재해석 / 이전 결정 충돌 → **사용자 확인**
- Codex 5 라운드 넘게 수렴 안 됨 → 사용자 보고 (설계 전제 오류 가능성)

### 팀 꾸리기 (Athena) — 필요 판단 시 자율 사용

```
Skill(skill="agent-olympus:athena", args="<task>")
```

특히:
- 독립 작업 병렬 분해 가능할 때 (DB + service + route)
- 3-모델 관점 필요한 설계 결정
- Codex 혼자 수렴 못 할 때 Gemini 제3자 관점

---

## 3. Phase 실행 계획 (10B → 10G)

### Phase 10B — DB + Service (예상 3~5일)

**목표**: preset 스키마 확정 + CRUD + snapshot builder + spawn resolver (내부 API).

작업:
1. Branch `phase-10b-preset-service`
2. `server/db/migrations/018_worker_presets.sql`
   - `worker_presets` (id, name, description, base_system_prompt, mcp_config_json, plugin_refs_json, isolated, min_claude_version, created_at, updated_at)
   - `run_preset_snapshots` (id, run_id, preset_id, snapshot_json, manifest_json, created_at) — FK to runs; preset_id 는 plain text (preset 삭제가 snapshot 에 영향 X)
   - `tasks.preferred_preset_id` 컬럼 추가 (ALTER TABLE — app-level cascade 대상)
3. `server/services/presetService.js`:
   - `createPreset / getPreset / listPresets / updatePreset / deletePreset` (같은 트랜잭션에서 `UPDATE tasks SET preferred_preset_id = NULL WHERE preferred_preset_id = ?` cascade)
   - `resolveForSpawn({ presetId, projectId, skillPackIds, adapter })` → `{ systemPrompt, mcpConfig, pluginDirs, isolated, snapshot }`
   - `buildSnapshot({ preset, manifestCache })` — plugin 파일 hash/size/mtime 저장. Path namespace `<pluginRef>/<relpath>` (§6.5)
   - `mergeMcp3(presetMcp, projectMcp, skillPackMcp)` — preset > project > skillPack precedence, collision warning (§6.8)
   - `resolvePromptChain({ presetPrompt, skillPackSections, adapterFooter })` — separator `\n\n---\n\n`
4. `server/routes/workerPresets.js` — REST CRUD + `app.js` 라우터 등록
5. 단위 테스트 `server/tests/preset.service.test.js`, `server/tests/preset-route.test.js`
6. **하지 말 것**: 아직 lifecycleService spawn wiring 건드리지 않음. Tier 2 `--bare` 도 dormant (isolated 필드만 저장).

Codex 리뷰 prompt 핵심 항목:
- Migration reversibility / 기존 테스트 회귀
- Snapshot namespace 정확성 (§6.5)
- Delete cascade (app-level) 트랜잭션 안전성
- `resolveForSpawn` 반환 구조 vs 10C 의 consumer 계약

Acceptance:
- [ ] 018 migration 통과, 기존 672+ tests 회귀 0
- [ ] preset CRUD + snapshot builder unit test PASS
- [ ] Codex PASS

### Phase 10C — Spawn Wiring (Tier 1 + snapshot persistence) (3~5일)

**목표**: Claude/Codex/OpenCode **worker** spawn 경로에 preset MCP + prompt 주입. **Worker API 만 — manager 경로 절대 건드리지 않음.**

작업:
1. Branch `phase-10c-tier1-spawn`
2. `server/services/lifecycleService.executeTask`:
   - `runs.preset_id` 가져와 `presetService.resolveForSpawn(...)` 호출
   - 반환된 snapshot 을 `run_preset_snapshots` 에 INSERT (R1-P1-5: 즉시 persist)
   - `min_claude_version` 체크 — `claude --version` parse. 불일치 시 `run_events` warning
3. Adapter-specific wiring:
   - **Claude worker**: `streamJsonEngine.spawnAgent({ systemPrompt, mcpConfig })` — **manager 의 `startSession` 이 아님** (R4-P1-2). `spawnAgent` 가 `--mcp-config <temp.json>` + system prompt 를 넘기도록.
   - **Codex worker**: spawn args 에 `codex exec -c 'mcp_servers=<json>'` 추가. system prompt 는 `{system_prompt_file}` placeholder 치환.
   - **OpenCode worker**: `opencode` CLI 실측 — MCP flag 존재 여부 확인. 없으면 prompt-only + `run_events` 에 `preset:mcp_unsupported` warning.
4. Prompt + MCP precedence chain (§6.8) 구현 — `presetService.resolvePromptChain` / `mergeMcp3` 호출.
5. Tier 2 (`--bare`, `--plugin-dir`) 는 여전히 dormant — isolated preset 이 요청되어도 이번 phase 에서는 경고만 찍고 Tier 1 만 적용 (10D 에서 enable).
6. 통합 테스트:
   - `server/tests/preset-spawn-claude.test.js` — mock spawn, args 검증
   - `server/tests/preset-spawn-codex.test.js`
   - `server/tests/preset-snapshot-persist.test.js`
   - US-001 ~ US-005 중 spawn 관련 항목

Codex 리뷰 핵심:
- Manager API 미건드림 확인
- 3-source MCP merge 정확성 + collision event emission
- Snapshot persistence 시점 (resolveForSpawn 직후 vs spawn 완료 후) — R1-P1-5 에 맞게 즉시
- `min_claude_version` 실패 경로가 fail-closed 인지 (해당 run 실패 / abort)

### Phase 10D — Tier 2 (Claude isolated) + Auth env (2~3일)

**목표**: `--bare --strict-mcp-config --setting-sources '' --plugin-dir` enable + §6.9 amendment 구현 + canary isolation test.

작업:
1. Branch `phase-10d-tier2-isolated`
2. `authResolver.js`:
   - **신 메서드** `resolveClaudeAuthForIsolated({ envAllowlist })` 추가 (기존 `resolveClaudeAuth` 는 안 건드림).
   - 반환 계약: `{ canAuth, env: { ANTHROPIC_API_KEY }, sources, diagnostics, apiKeyHelperSettings? }`.
   - **우선순위** (Codex P1 반영):
     1. `apiKeyHelper` path — token 을 임시 쉘 스크립트로 materialize, `{ settingsPath }` 반환 (env 노출 없음) — **기본**
     2. env fallback — `{ ANTHROPIC_API_KEY: token }` (ps/proc 노출 surface 있음, 단기용)
   - Source order: env `ANTHROPIC_API_KEY` → `.claude-auth.json` OAuth token → keychain 의 `claudeAiOauth.accessToken` (JSON parse, `security -w`)
   - Fail-closed: 400 with diagnostic
3. Spec `§6.9` normative 블록 업데이트 — `CLAUDE_CODE_OAUTH_TOKEN` 제거, `ANTHROPIC_API_KEY` + `apiKeyHelper` 로 교체. CLI help 인용 문구 추가.
4. `streamJsonEngine.spawnAgent` — isolated preset 경로:
   - args 에 `--bare --strict-mcp-config --setting-sources '' --plugin-dir <path>` 추가 (plugin_refs 각각)
   - auth: `resolveClaudeAuthForIsolated` 결과로 `--settings <path>` 또는 env 주입
5. 임시 settings/helper 파일 라이프사이클: spawn 시 `mkdtemp`, process exit 시 cleanup (on 'close' handler)
6. **US-007 canary test** (hard requirement):
   - setup: host `~/.claude/plugins/palantir-canary-<pid>/` 에 marker 파일 배치
   - isolated preset 으로 worker spawn
   - worker 가 canary 를 못 보는지 검증 (plugin list 명령 없으면 system prompt 에 "list loaded plugins" 로 inject + response parse)
   - teardown: canary 디렉토리 제거 (finally 블록)
7. Codex/OpenCode 는 Tier 2 요청 시 `adapter_unsupported` warning + Tier 1 만 적용 (기존 skillPack 패턴과 동일)

Codex 리뷰 핵심:
- `resolveClaudeAuthForIsolated` 의 token redaction / 로그 leak
- apiKeyHelper 쉘 스크립트의 quoting (token 에 특수문자 가정 금지 — base64-safe 이지만 escape 검증)
- 임시 파일 cleanup 실패 시 token leak 리스크
- canary test 의 isolation 검증 방법이 실제 `--bare` 동작과 맞는지

### Phase 10E — Task 연동 + UI (3~5일)

**목표**: 사용자가 웹 UI 에서 preset 을 만들고 task 에 연결할 수 있게.

작업:
1. Branch `phase-10e-ui`
2. `server/routes/tasks.js` — `preferred_preset_id` 주입 경로 확인 (이미 10B 에서 컬럼 추가됨)
3. `ExecuteModal` — preset 드롭다운 추가, task 의 `preferred_preset_id` 를 기본값으로 prefill. runs 생성 시 `preset_id` 바인딩.
4. `#presets` 페이지 (Preact, `app/components/PresetsView.js` 등):
   - 목록 / 상세 / 생성 / 편집 / 삭제
   - MCP config JSON editor + plugin_refs editor (simple textarea OK, validator 추가)
   - `isolated` toggle + 경고 문구 ("Claude 워커 전용. 다른 adapter 에서는 무시됨.")
   - `NAV_ITEMS` (`app/lib/nav.js`) 에 추가
5. Run Inspector 에 applied preset snapshot 표시 (작은 섹션, collapse)
6. **US-008**: preset 삭제 시 주행 중인 run 은 snapshot 이미 persist 되어 영향 없음 — UI 에서 "이 task 의 preferred preset 이 삭제되었습니다" 알림 표시 후 NULL 로
7. 통합 테스트: route test + client-side snapshot test (Preact 컴포넌트)

Codex 리뷰 핵심:
- UI security: preset editor 의 JSON 검증 (XSS 가능 필드 없음 확인)
- NAV_ITEMS / useSSE channels 업데이트 누락 여부 (CLAUDE.md 규칙)

### Phase 10F — Audit UI (1~2일)

**목표**: 과거 run 의 snapshot 과 현재 preset 차이 표시.

작업:
1. Branch `phase-10f-audit`
2. `server/routes/runs.js` — run 상세에 `preset_snapshot` 반환
3. Run Inspector 에 "Preset drift" 섹션:
   - snapshot 시점의 preset config vs 현재 preset config diff
   - 변경된 필드 (prompt, mcp, plugins) 하이라이트
4. Preset 편집 이력 있을 때 run 목록에 badge 표시

### Phase 10G — agent-olympus 실연동 + 문서 + Acceptance (1일)

**목표**: spec §12 의 acceptance checklist 전부 녹색.

작업:
1. Branch `phase-10g-agent-olympus-wiring`
2. `server/plugins/agent-olympus/` (gitignored 디렉토리 — CI 용 mock fixture 는 `server/tests/fixtures/plugins/agent-olympus-mock/` 에)
3. 통합 smoke test: preset 을 `plugin_refs: ['agent-olympus']` 로 만들어 worker 를 돌려 실제 skill 이 로드되는지 확인
4. README 에 "Creating a Worker Preset" 섹션 추가 (사용법, isolated 모드, security 주의)
5. Acceptance checklist (spec §12) 각 항목 체크 표시 + 증거 링크 (PR, test file)
6. Final sweep: `npm test` 회귀 0, lint 0

---

## 4. 주의사항 (Phase 10A 에서 이미 확인한 것 포함)

1. **Worker API vs Manager API**: Claude worker 는 `streamJsonEngine.spawnAgent()`, manager 는 `streamJsonEngine.startSession()`. **Phase 10C/D 에서 변경 대상은 worker 만**.
2. **SQLite ALTER TABLE FK 약함**: `preferred_preset_id` 는 app-level cascade (presetService.deletePreset 트랜잭션 내 UPDATE).
3. **Snapshot path namespace**: `<pluginRef>/<relpath>` (§6.5). 두 plugin 에 `plugin.json` 이 있으면 네임스페이스로 구분.
4. **MCP precedence**: preset > project > skillPack. 충돌 시 `run_events` warning.
5. **Auth contract (Phase 10A 실측)**:
   - `--bare` 는 env `CLAUDE_CODE_OAUTH_TOKEN` / keychain 무시 (CLI help 명시대로).
   - OAuth access token 을 **`ANTHROPIC_API_KEY` 슬롯 또는 `apiKeyHelper`** 로 전달해야 함.
   - 신메서드 `resolveClaudeAuthForIsolated` 만 추가 — 기존 `resolveClaudeAuth` 는 안 건드림.
   - **기본 경로는 `apiKeyHelper + --settings`** (Codex P1), env materialize 는 fallback.
6. **Skill Pack 비파괴**: `skill_packs` / `project_skill_packs` / `task_skill_packs` / `run_skill_packs` 변경 0. `skillPackService.resolveForRun` signature 유지.
7. **`server/plugins/` 는 gitignored**: 실제 plugin 파일은 repo 외. CI 는 `server/tests/fixtures/plugins/` 의 mock 사용.
8. **`useSSE` channels hard-coded**: 새 SSE 채널 (예: `preset:snapshot_created`) 추가 시 반드시 `app/lib/hooks/sse.js` channels 배열에도 등록.
9. **NAV_ITEMS**: `#presets` 추가 시 `app/lib/nav.js` 수정.

## 5. 완료 기준 (spec §12)

- [ ] 018 migration + 기존 테스트 회귀 0
- [ ] US-001 ~ US-008 자동화 테스트로 증명
- [ ] Phase 10A spike PASS (이미 완료 — PR #87)
- [ ] Canary isolation test (US-007) PASS
- [ ] Codex 교차리뷰 각 phase P0/P1 0건
- [ ] `server/plugins/agent-olympus/` 배치 + smoke
- [ ] README 에 "Creating a Worker Preset" 섹션

## 6. 세션 시작 체크리스트

1. `git status` + `git log --oneline -5` — Phase 10A merge 확인 (커밋 `2aa754a spike(phase-10a)…`)
2. `npm test 2>&1 | tail -5` — baseline 672 PASS 확인 (1개 플레이크 허용: sendInput single-shot race)
3. 본 브리프 + spec 3개 완독
4. **Phase 10B 부터 시작**. TaskCreate 로 각 phase 등록.
5. 각 phase 완료 시 단계별 요약 보고 (승인 안 기다림 — 자율 모드).

## 7. 실패 시 복구

- 테스트 회귀: rollback + commit 단위 bisect
- Codex 5 라운드 미수렴: 사용자 보고 (설계 전제 오류 가능성)
- Merge conflict: 보수적 해결 (기존 로직 보존 우선), 불확실 시 사용자 확인
- 플레이크 테스트: 재실행 1회. 2회 연속 실패는 실제 회귀로 간주.

---

## 8. 마무리

Phase 10G 완료 시:
1. 본 브리프 파일 (`docs/briefs/phase-10-continuation.md`) 삭제
2. `.claude/commands/phase10-resume.md` slash command 도 삭제 (또는 "archive" 로 이동)
3. 사용자에게 최종 보고: 스펙 §12 acceptance checklist 전체 녹색 증거 + 총 PR 목록 + 회귀 없음 확인

**이 브리프만으로 Phase 10B ~ 10G 를 자율 실행 완주할 수 있어야 함. 모호한 부분은 Codex 상의 + 사용자 보고.**
