# Worker Preset & Plugin Injection — v3 Phase 10

> Version 0.1-draft | 2026-04-14
> Status: **Draft — pending Codex cross-review**
> 관련 문서: [manager-v3-multilayer.md](./manager-v3-multilayer.md), [skill-packs.md](./skill-packs.md), [skill-pack-gallery-v1.1.md](./skill-pack-gallery-v1.1.md)
> Memory 기반: `project_plugin_skill_injection_idea.md` (2026-04-08 검증, 보류 상태 해제)

---

## TL;DR

Palantir Console에 **Worker Preset 시스템**을 도입한다. 프리셋은 "워커가 spawn 될 때 어떤 도구/플러그인/프롬프트를 주입받을지" 를 정의하는 **어댑터-중립 스키마 + 어댑터별 best-effort 주입** 계약이다. 2-tier 아키텍처:

- **Tier 1 (portable schema, adapter-specific wiring)**: MCP 서버 정의 + 시스템 프롬프트. 주입 경로는 어댑터별로 **정확히 지정됨**:
  - Claude worker: `lifecycleService.executeTask` → `streamJsonEngine.spawnAgent({ systemPrompt, mcpConfig, ... })`. (manager 는 `startSession`, worker 는 `spawnAgent` — 혼동 금지)
  - Codex worker: `lifecycleService.executeTask` → `executionEngine.spawnProcess(...)` args 에 `codex exec -c 'mcp_servers=<json>'` 추가 + `agent_profiles.args_template` 의 `{system_prompt_file}` placeholder 파일 치환. **단 codex manager adapter (`codexAdapter.runTurn`) 는 MCP 를 현재 무시** — worker 와 manager 는 다른 경로임. Phase 10C 에서 worker 쪽만 MCP 추가.
  - OpenCode worker: `opencode` CLI 의 MCP config flag 가 있는지 Phase 10C 에서 실측. 있으면 사용, 없으면 prompt-only + `preset:mcp_unsupported` warning (graceful degrade).
  - **즉 Tier 1 은 "같은 스키마"를 주지만 "같은 주입 경로"는 아니다. Worker/Manager 도 별개 경로.**
- **Tier 2 (Claude-only)**: `--bare` 호스트 격리 + `--plugin-dir` 로 내부 플러그인 주입 — Claude 워커만. Codex/OpenCode 에는 경고 + skip.

기존 Skill Pack (v1.0-rc1~v1.1) 은 **prompt overlay + MCP overlay + acceptance overlay** 의 논리적 콘텐츠. Worker Preset 은 **실행 환경 격리 + 플러그인 파일 주입**의 구조. 두 시스템은 **직교** 하며 공존한다 — 프리셋이 Skill Pack 을 대체하지 않는다.

가장 큰 가치는 **재현성** (`--bare` 로 호스트 `~/.claude/{plugins,skills,settings.json,CLAUDE.md}` 영향 차단) 과 **ecosystem 재사용** (agent-olympus 같은 Claude 플러그인을 프리셋 통해 워커에 주입).

---

## 1. Problem Statement

**WHO**: Palantir Console 을 사용해 워커를 spawn 하는 운영자 (본인 + 잠재적 팀).

**WHAT (Pain)**:
1. 워커는 호스트 `~/.claude/` 를 상속받아 실행 환경이 호스트 상태에 의존 → **재현성 없음**. 호스트에 설치된 플러그인/스킬/settings 가 워커 동작에 영향.
2. Ecosystem 에 존재하는 Claude 플러그인 (agent-olympus, claude-code-action 등) 을 워커에 쓰려면 호스트에 설치해야 하고, 그러면 호스트의 Claude Code 세션에도 섞임 → **역할 분리 실패**.
3. Skill Pack 은 prompt/MCP 를 DB 기반 JSON 으로 주입하지만 **Claude 플러그인 포맷과 호환되지 않음**. 시중 자산을 그대로 못 씀.
4. 워커마다 "이 태스크에는 이 도구만" 같은 능력 한정을 제공하는 수단이 없음 — Skill Pack 은 프롬프트/MCP 만 다루고, agents/commands/skills 같은 Claude Code 런타임 구성은 건드리지 않음.

**WHY now**:
- Skill Pack Gallery v1.1 (#84) 이후 사용자가 "Install from URL" 로 GitHub 플러그인 repo 를 넣어봤더니 형식 불일치로 거부됨. Ecosystem 연동 요구가 실제 발생함.
- Palantir 의 가치 (orchestration + 3계층) 는 유지하되 ecosystem 을 tier 된 방식으로 수용할 여지가 명확해짐.

---

## 2. Target Users

| Persona | 설명 | 핵심 니즈 |
|---------|------|----------|
| **Solo Operator** (= 현재 주 사용자) | localhost 에서 Palantir Console 을 혼자 운영 | 호스트 오염 없이 워커 spawn, ecosystem 플러그인 활용 |
| **Team Admin** (잠재) | 팀 공유 Console. 운영 정책을 강제하고 싶음 | 중앙 집중 프리셋으로 팀 전체 워커 행동 통일 |
| **Pack Author** (잠재) | Palantir 전용 프리셋 작성자 | 프리셋 export/import, 버전 관리 |

---

## 3. Lock-in Principles (변경 금지)

1. **기존 Skill Pack 비파괴**: v1.0~v1.1 의 skill_packs 테이블 / resolveForRun / 바인딩은 변경 0. Preset 은 별도 테이블 + 별도 주입 경로.
2. **Preset 은 opt-in**: 프리셋을 지정하지 않은 워커는 기존과 동일하게 동작 (호스트 상속 포함). `--bare` 는 프리셋이 요청할 때만.
3. **Tier 2 (Claude-only)**: `--bare` 와 `--plugin-dir` 는 Claude stream-json 워커에만. Codex/OpenCode 는 Tier 1 만 받고 Tier 2 요청은 **경고 + skip** (`resolveForRun` 의 adapter_unsupported 와 동일 패턴).
4. **Plugin directory 는 서버 제어**: 사용자는 임의 호스트 경로를 프리셋에 지정할 수 없음. `server/plugins/<name>/` 하위에 사전 배치된 것만 참조 가능. 업로드 API 는 admin 토큰 필요 (또는 v1 에서는 로컬 파일 시스템 직접 배치만 허용, API 비노출).
5. **Worktree cwd 는 best-effort 경계**: 플러그인 프로세스는 `cwd` 가 worktree 로 강제되지만, OS 레벨 샌드박스 (seccomp/filesystem capabilities) 는 v1 에 없음. 플러그인 hooks/bin 이 절대경로 I/O, subprocess spawn, network 를 자유롭게 할 수 있음. **신뢰는 사용자 책임**. 심층 방어(샌드박스) 는 v2 로 미룸. 스펙이 주장하는 격리는 "호스트 `~/.claude/` 상속 차단 + cwd 경계" 까지이며, 커널 레벨 격리는 아니다.
6. **Snapshot 의무**: 워커 run 에 적용된 preset snapshot (내용 hash + 파일 목록) 을 `runs` 테이블에 기록. 재현성 + 포렌식.
7. **Auth 호환성 명시**: `--bare` 는 OAuth keychain 을 안 읽음. 프리셋이 isolated=true 를 선언하면 Palantir 가 `CLAUDE_CODE_OAUTH_TOKEN` env 를 명시 주입 (`.claude-auth.json` flow 유지). `--bare` + auth 호환성 검증은 Phase A spike 에서 필수.

---

## 4. Goals & Non-Goals

### Goals
| ID | 목표 | 측정 기준 |
|----|------|----------|
| G1 | 호스트 오염 없는 워커 실행 | Preset 의 `isolated: true` 로 spawn 시 `$HOME/.claude/` 의 plugins/skills/settings 가 워커에 주입되지 않음을 테스트로 증명 |
| G2 | Ecosystem 플러그인 재사용 | agent-olympus 를 `server/plugins/` 에 배치 + 프리셋 지정 → Claude 워커에서 `/ask codex` 같은 command 호출 가능 |
| G3 | 기존 Skill Pack 비파괴 | 기존 672+ 테스트 회귀 0건 (baseline: PR #85 merged, fix/ssrf-dns-lookup-all) |
| G4 | Codex/OpenCode 워커도 MCP 일관성 | Tier 1 MCP 레지스트리가 Claude/Codex/OpenCode 모두 동일 서버 주입 |
| G5 | 프리셋 snapshot | `runs.preset_snapshot_hash` 가 모든 is_manager=false 워커 run 에 기록 |
| G6 | Claude CLI 버전 호환성 | Preset 의 `min_claude_version` 이 spawn 전 체크. 불만족 시 400 with 메시지 (Tier 2 는 CLI 변경에 민감하므로 명시적 호환 정책 필요) |

### Non-Goals
- **Remote plugin marketplace** — v1 에서 사용자 UI 로 임의 plugin repo 설치 금지. `server/plugins/` 에 직접 배치만.
- **Plugin 내부 content audit** — 플러그인이 신뢰된 코드임을 가정. 콘텐츠 검증은 향후 Phase.
- **Claude plugin → Skill Pack 자동 변환** — 두 시스템 직교. 변환 시도 안 함.
- **Preset inheritance/composition** — 프리셋은 flat. v1 에서는 합쳐서 쓰는 로직 없음 (→ 복잡도 폭증).
- **동적 preset reload** — 프리셋 수정은 이후 새 워커 spawn 부터 반영. 실행 중 워커는 snapshot 고정.
- **호스트 `~/.claude/plugins/*` 를 자동 복사** — 호스트와의 격리가 목표이므로 의도적으로 금지.

---

## 5. User Stories

### US-001: 프리셋 생성 (Admin)
**As a** 운영자, **I want to** 재사용 가능한 Worker Preset 을 생성하고 싶다 (이름, 격리 모드, 참조할 `server/plugins/` 목록, MCP servers, base prompt).
**so that** 워커 spawn 시 특정 환경을 반복 가능하게 지정할 수 있다.

**Acceptance Criteria:**
- GIVEN Admin 이 POST `/api/worker-presets` 로 `{ name, isolated, plugin_refs, mcp_server_ids, base_system_prompt }` 를 전송
- WHEN 서버가 검증 (name unique, plugin_refs 가 `server/plugins/` 에 실존, mcp_server_ids 가 `mcp_server_templates` 에 존재, base_system_prompt byte ≤ 16KB)
- THEN `worker_presets` 테이블에 insert 되고 201 반환

- GIVEN plugin_refs 에 존재하지 않는 이름 (`nonexistent-plugin`) 포함
- WHEN POST 호출
- THEN 400 + "Unknown plugin ref: 'nonexistent-plugin'"

### US-002: 워커 spawn 에 프리셋 적용
**As a** 운영자, **I want to** Task 또는 Run 실행 시 preset 을 명시 지정하고 싶다.
**so that** 해당 워커가 정해진 환경으로 실행된다.

**Acceptance Criteria:**
- GIVEN Task 에 `preferred_preset_id` 가 설정되어 있거나 `/execute` body 에 `preset_id` 포함
- WHEN `lifecycleService.executeTask` 가 워커 spawn
- THEN preset 이 lookup 되고, Tier 1 (MCP config, system prompt) 이 적용됨
- AND isolated=true 면 Tier 2 (`--bare`, `--strict-mcp-config`, `--setting-sources ''`, `--plugin-dir <path>`) 가 Claude 어댑터에 한해 적용
- AND `runs.preset_id` + `runs.preset_snapshot_hash` 기록

- GIVEN preset_id 가 지정되지 않음
- WHEN 워커 spawn
- THEN 기존 동작 그대로 (호스트 상속, Skill Pack overlay 만 적용)

### US-003: Claude 플러그인 주입
**As a** 운영자, **I want to** agent-olympus 같은 Claude Code plugin 을 Palantir 워커에서 쓰고 싶다.
**so that** ecosystem 자산을 재사용할 수 있다.

**Acceptance Criteria:**
- GIVEN `server/plugins/agent-olympus/` 디렉토리에 agent-olympus 의 `plugin.json` + `skills/` + `commands/` 가 배치됨
- AND Preset P1 이 `plugin_refs: ["agent-olympus"]` + `isolated: true` 로 생성됨
- WHEN Claude 워커가 P1 으로 spawn
- THEN spawn args 에 `--plugin-dir /Users/.../palantir_console/server/plugins/agent-olympus --bare --strict-mcp-config --setting-sources ''` 포함
- AND 해당 세션에서 agent-olympus 의 slash command (예: `/ask codex`) 호출 가능

- GIVEN 같은 preset P1 이 Codex 어댑터로 spawn 될 때
- THEN Tier 2 (`--bare`, `--plugin-dir`) 는 skip
- AND warning 이 `run_events` 에 기록: `preset:tier2_skipped` (adapter 가 codex 이므로)
- AND Tier 1 (MCP config) 은 여전히 적용

### US-004: Auth 호환성 확보
**As a** Palantir 서버, **I want to** `--bare` 세션에서도 인증이 유지되길 원한다.
**so that** isolated 프리셋이 실제로 사용 가능하다.

**Acceptance Criteria:**
- GIVEN Preset 이 `isolated: true`
- WHEN Claude 워커 spawn
- THEN env 에 `CLAUDE_CODE_OAUTH_TOKEN=<from .claude-auth.json>` 명시 주입
- AND spawn args 에 `--bare` 추가되더라도 워커가 첫 turn 을 정상 실행 (`result` 이벤트 수신)

- GIVEN `.claude-auth.json` 이 없는 환경 (CI, 설치 직후)
- WHEN isolated preset 으로 spawn 시도
- THEN 400 + "Isolated preset requires valid Claude auth. Set ANTHROPIC_API_KEY or run from Claude Code session first."

### US-005: 프리셋 snapshot 기록
**As a** 운영자, **I want to** 과거 run 이 어떤 preset 으로 실행됐는지 정확히 알고 싶다.
**so that** 재현 / 포렌식이 가능하다.

**Acceptance Criteria:**
- GIVEN 워커 run 이 preset P1 으로 spawn
- THEN `runs.preset_snapshot_hash` = SHA-256(JSON.stringify(preset + 참조 plugin file hashes))
- AND `run_preset_snapshots` 테이블에 파일별 (path, hash) 튜플이 기록

- GIVEN preset P1 이 나중에 수정됨
- WHEN 과거 run 의 snapshot 조회
- THEN 수정 전 시점의 값 그대로 유지 (hash + file hashes 보존)

### US-006: Preset UI (Admin)
**As a** 운영자, **I want to** UI 로 Preset CRUD + plugin/MCP 선택을 하고 싶다.
**so that** 매번 REST 호출하지 않고 관리할 수 있다.

**Acceptance Criteria:**
- GIVEN `#presets` 페이지 (새 라우트)
- WHEN 사용자가 "New Preset" 클릭
- THEN 다이얼로그: name 입력 + isolated 토글 + `server/plugins/` 의 팩 목록에서 다중선택 + `mcp_server_templates` 다중선택 + system prompt editor (monaco 없이 textarea, 16KB 카운터)
- AND "Save" 클릭 시 서버 검증 후 목록에 추가

- GIVEN Task 생성/수정 모달
- WHEN `preferred_preset_id` 드롭다운
- THEN `worker_presets` 목록 + "None (default)" 옵션
- AND 선택 후 저장 시 `tasks.preferred_preset_id` 업데이트

### US-008: Invalidation / 삭제 시 실행-시 동작

**As a** 운영자, **I want to** 참조하는 preset 이 삭제됐거나 plugin_ref 가 무효화된 task 의 run 시도 시 명확한 실패를 받고 싶다.
**so that** 조용히 잘못된 환경으로 실행되지 않는다.

**Acceptance Criteria:**
- GIVEN Task T1 이 `preferred_preset_id=P1` 로 저장됨
- WHEN Preset P1 이 DELETE 됨
- THEN `tasks.preferred_preset_id` 는 NULL 로 cascade update
- AND T1 의 다음 /execute 는 preset 없이 legacy path 로 진행

- GIVEN Preset P1 의 `plugin_refs=["removed-plugin"]` 이고 `server/plugins/removed-plugin/` 이 삭제됨
- WHEN T1 을 P1 으로 /execute
- THEN 400 + `"Plugin ref no longer available: 'removed-plugin'. Update preset or restore the plugin directory."`

- GIVEN Preset P1 의 `min_claude_version` 이 `2.0.0` 이지만 spawn 시 `claude --version` 이 `1.8.5` 반환
- WHEN spawn 시도
- THEN 400 + `"Preset requires Claude CLI >= 2.0.0, found 1.8.5"`

### US-007: Preset 격리 검증 테스트 (Non-functional)
**As a** 시스템, **I want to** `--bare` 가 실제로 호스트 `~/.claude/plugins/` 를 안 읽음을 자동 검증하고 싶다.
**so that** G1 (호스트 오염 차단) 을 CI 에서 보장한다.

**Acceptance Criteria:**
- GIVEN 테스트 fixtures 에 호스트 `~/.claude/plugins/test-canary-plugin/` 을 임시 배치 (tmpdir 로 HOME override)
- AND Preset `isolated: true, plugin_refs: []` 으로 워커 spawn
- WHEN 워커가 첫 turn 실행 후 `claude plugin list` 같은 커맨드 결과 스캔
- THEN `test-canary-plugin` 이 listing 에 포함되지 않음

---

## 6. Technical Architecture

### 6.1 DB 스키마

**Migration 018_worker_presets.sql**:

```sql
CREATE TABLE worker_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  isolated INTEGER NOT NULL DEFAULT 0,              -- boolean
  plugin_refs TEXT NOT NULL DEFAULT '[]',           -- JSON array of plugin dir names
  mcp_server_ids TEXT NOT NULL DEFAULT '[]',        -- JSON array of mcp_server_templates.id
  base_system_prompt TEXT,                          -- optional base prompt (≤16KB)
  setting_sources TEXT DEFAULT '',                  -- for --setting-sources flag
  min_claude_version TEXT,                          -- semver string e.g. "1.8.0" (G6, US-008)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Snapshot table stores FROZEN preset at spawn time. No FK to worker_presets
-- so that deleting a preset does NOT destroy past run forensic data.
-- preset_id is stored as plain text; if the preset is later deleted, the
-- stored value becomes an orphaned historical reference.
CREATE TABLE run_preset_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,                           -- historical reference; no FK (see note above)
  preset_snapshot_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  file_hashes TEXT NOT NULL,                         -- JSON: [{path, sha256}] with <pluginRef>/ namespace
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_run_preset_snapshots_run_id ON run_preset_snapshots(run_id);

ALTER TABLE runs ADD COLUMN preset_id TEXT;          -- NULL = no preset (legacy path)
ALTER TABLE runs ADD COLUMN preset_snapshot_hash TEXT;

-- Task references a preset. SQLite ALTER TABLE cannot add enforced FK to an
-- existing table; the REFERENCES clause here is informational only. The
-- SET NULL cascade on preset deletion is enforced at the application layer
-- (presetService.deletePreset): `UPDATE tasks SET preferred_preset_id = NULL
-- WHERE preferred_preset_id = ?` inside the same transaction.
ALTER TABLE tasks ADD COLUMN preferred_preset_id TEXT;  -- app-level cascade
```

### 6.2 Filesystem layout

```
server/
  plugins/                     ← 서버 제어. 내부 plugin 배치 영역
    agent-olympus/              ← 예: ecosystem plugin 을 단순 copy/symlink
      plugin.json
      skills/
      commands/
      agents/
    palantir-internal/          ← Palantir 가 쓰는 내부 plugin (Phase F+)
  mcp/registry.json            ← Tier 1 portable MCP 정의 (mcp_server_templates 와 별도?
                                   현재 mcp_server_templates 재사용. 신규 테이블 아님)
```

`server/plugins/` 는 gitignored 또는 submodule 권장. **사용자가 local 파일시스템에 직접 배치**. v1 업로드 API 없음.

### 6.3 Spawn 로직 변경

`lifecycleService.executeTask` → 기존 Skill Pack resolveForRun 후 **preset 해소** 추가:

```js
// 1. Skill Pack 해소 (기존)
const skillPackResult = skillPackService.resolveForRun({ taskId, explicitPackIds, agentProfileId });

// 2. Preset 해소 (신규)
const preset = presetId ? presetService.getPreset(presetId) : null;
const adapterName = agentProfile.command.includes('claude') ? 'claude' : ...;
const presetResolution = presetService.resolveForSpawn({ preset, adapter: adapterName });
// presetResolution: { args: [...], env: {...}, mcpConfig: {...}, warnings: [...] }

// 3. 병합 — 3-source precedence chain per §6.8
const finalArgs = [...adapterBaseArgs, ...presetResolution.args];
const finalEnv = { ...baseEnv, ...presetResolution.env, ...authEnv };

// Project MCP base (from projects.mcp_config_path) — existing lifecycleService logic
const projectMcpConfig = projectService.getProjectMcpConfig(task.project_id);
//                                           ↓ normative precedence: preset > project > skill pack
const finalMcpConfig = mergeMcp3(
  presetResolution.mcpConfig,        // highest priority
  projectMcpConfig,                   // middle priority (existing project MCP)
  skillPackResult.mcpConfig,          // lowest priority (Skill Pack overlay)
  { emitWarnings: eventBus }
);

// 4. Snapshot 기록
if (preset) {
  const snapshot = presetService.buildSnapshot(preset);
  db.run('UPDATE runs SET preset_id = ?, preset_snapshot_hash = ? WHERE id = ?',
         preset.id, snapshot.hash, runId);
  db.run('INSERT INTO run_preset_snapshots (...) VALUES (...)', snapshot);
}

// 5. Spawn
executionEngine.spawn(finalArgs, finalEnv, ...);
```

### 6.4 Tier 2 활성화 규칙

Preset `isolated=true` + adapter=claude 인 경우에만:

```js
args.push('--bare');
args.push('--strict-mcp-config');
args.push('--setting-sources', preset.setting_sources || '');  // empty by default
for (const pluginName of preset.plugin_refs) {
  const pluginPath = path.join(__dirname, '..', 'plugins', pluginName);
  if (!fs.existsSync(path.join(pluginPath, 'plugin.json'))) {
    throw new Error(`Plugin not found: ${pluginName}`);
  }
  args.push('--plugin-dir', pluginPath);
}
// Required env for --bare auth flow (Lock-in #7)
env.CLAUDE_CODE_OAUTH_TOKEN = authEnv.CLAUDE_CODE_OAUTH_TOKEN;  // 주입 필수
// OR: ANTHROPIC_API_KEY 면 그대로 통과
```

Adapter=codex/opencode + isolated=true 인 경우:
- Tier 2 skip + warning 기록:
  ```js
  warnings.push({ type: 'preset:tier2_skipped', adapter: adapterName, reason: 'Tier 2 is Claude-only' });
  ```

### 6.5 Snapshot hash 계산

**Path namespacing (R1-P0-2 fix)**: 각 파일 entry 의 path 는 `<pluginRef>/<pathRelativeToPluginRoot>` 형태로 네임스페이스 붙임. 두 플러그인에 `plugin.json` 이 있어도 `agent-olympus/plugin.json` 과 `palantir-internal/plugin.json` 으로 구분됨.

**Manifest cache (R1-P1-4 fix)**: Plugin 당 별도 manifest (`server/plugins/<name>/.palantir-manifest.json`) 를 인메모리 + 디스크 캐시. 캐시 키: `(file mtimeNs, size)`. 파일이 변한 경우만 재해싱. Per-run snapshot 은 cached manifest 에서 읽어 조합만 함.

```js
// presetService.buildSnapshot(preset) 의사코드
const presetJson = JSON.stringify({
  name, isolated, plugin_refs, mcp_server_ids, base_system_prompt, setting_sources
});
const fileHashes = [];
for (const pluginName of plugin_refs) {
  const manifest = getOrBuildManifest(pluginName);   // cached, rebuilt only if any file mtime changed
  for (const entry of manifest.files) {
    fileHashes.push({
      path: `${pluginName}/${entry.path}`,           // namespaced
      sha256: entry.sha256,
    });
  }
}
fileHashes.sort((a, b) => a.path.localeCompare(b.path));
const combined = presetJson + JSON.stringify(fileHashes);
const snapshotHash = crypto.createHash('sha256').update(combined).digest('hex');
```

Manifest cache invalidation: plugin 디렉토리의 모든 파일 stat 를 한 번 스캔해서 manifest 에 저장된 (path, mtimeNs, size, sha256) 와 비교. 변경된 파일만 재해싱. 디렉토리 변경 감시는 구현 안 함 — spawn 시점 재검증.

### 6.6 API

| Method | Path | 설명 |
|--------|------|------|
| `GET` | `/api/worker-presets` | 리스트 |
| `POST` | `/api/worker-presets` | 생성 (admin only — Phase F 에서 role 도입 전까지는 non-destructive) |
| `GET` | `/api/worker-presets/:id` | 상세 |
| `PATCH` | `/api/worker-presets/:id` | 수정 (기존 run snapshot 은 불변) |
| `DELETE` | `/api/worker-presets/:id` | 삭제. 참조하는 task.preferred_preset_id 는 NULL 로 cascade update |
| `GET` | `/api/worker-presets/plugin-refs` | `server/plugins/` 에 존재하는 플러그인 목록 (for UI dropdown) |
| `GET` | `/api/runs/:id/preset-snapshot` | run 의 preset snapshot (monitor/forensic) |

### 6.7 Worktree 격리 강화

플러그인이 hooks/bin 경로로 worktree cwd 를 벗어나지 못하도록:

- Spawn env 에 `PALANTIR_WORKTREE_ROOT=<cwd>` 주입
- Plugin hook 스크립트는 해당 cwd 에서만 실행 (이미 executionEngine 이 그렇게 동작)
- `.claude/plugins/**/hooks/*` 실행 시 `cwd` 가 worktree 안인지 hook runner 가 체크 — Claude Code 측 책임이지만 cwd 만 제어하는 것으로 일단 충분 (심층 방어는 Phase F 연기).

### 6.8 Precedence chains (R1-P1-2/3 normative)

**MCP alias precedence** (3-source 충돌 해소 — lifecycleService 가 최종 merge):
```
1. Preset explicit override  (preset.mcp_server_ids)           ← highest priority
2. Project MCP base          (projects.mcp_config_path)         ← existing
3. Skill Pack overlay        (resolveForRun.mcpConfig)          ← lowest

Merge rule: higher-priority source wins on same alias.
Collisions emit warnings to run_events: { type: 'mcp:alias_conflict', alias, sources: [...] }.
```

**Prompt concatenation order** (normative, adapter-agnostic):
```
1. Preset base_system_prompt        (when preset present; can be empty)
2. Skill Pack promptSections[]      (sorted by effectivePriority ascending)
3. Adapter-specific footer          (e.g. Manager V3 task instructions)

Separator: '\n\n---\n\n' between sections.
Token budgeting (SKILL_PACK_TOKEN_BUDGET) applies to Skill Pack sections only.
Preset base prompt ≤ 16KB (enforced at save time, unbounded in token budget).
```

Claude adapter: 결합된 prompt 를 단일 `systemPrompt` 로 전달.
Non-Claude (agent_profiles.args_template 에 `{system_prompt_file}` 있는 경우): 결합된 prompt 를 파일로 저장 후 path 를 치환.

### 6.9 Auth decision rule (R1-P1-1 normative)

**Contract change note**: 현재 `authResolver.resolveClaudeAuth()` (`server/services/authResolver.js:157-231`) 는 **keychain 을 existence check 만** 수행하고 token 값을 env 로 materialize 하지 않는다 (manager 프로세스가 keychain 을 직접 읽도록 맡김). 그러나 `--bare` 는 keychain 을 안 읽으므로 isolated preset 에는 명시적 token materialization 이 필요하다. 따라서 이 스펙은 `authResolver` 를 확장한다 — isolated worker 경로에 한해 새 메서드 `resolveClaudeAuthForIsolated()` 추가. Manager / non-isolated worker 경로는 기존 동작 유지.

Isolated preset (`isolated: true`) spawn 시 Claude auth 결정 (Round 6 amendment — Phase 10A spike 결과 반영):

`--bare` 모드의 Claude CLI 는 OAuth / keychain / 일반 settings 를 전부 무시하고 **오직 `ANTHROPIC_API_KEY` env 또는 `apiKeyHelper` (via `--settings <path>`)** 만 인증 소스로 인정한다 (Phase 10A 검증, PR #87). 따라서 isolated 경로는 토큰 값을 **materialize** 해야 한다.

**Token source priority** (first hit wins):
```
1. env ANTHROPIC_API_KEY
2. .claude-auth.json
   - ANTHROPIC_API_KEY 필드가 있으면 그대로 사용
   - 없으면 CLAUDE_CODE_OAUTH_TOKEN 필드 사용 (OAuth access token 은 API-key 슬롯에서 정상 작동 — Phase 10A 검증)
3. macOS keychain "Claude Code-credentials" — JSON 의 `claudeAiOauth.accessToken`
   (`security find-generic-password -s <service> -w` → JSON.parse → .claudeAiOauth.accessToken)
4. fail-closed: 400 "Isolated preset requires Claude auth. Set ANTHROPIC_API_KEY,
   run Palantir from a Claude Code session to seed .claude-auth.json, or ensure the
   macOS keychain has a 'Claude Code-credentials' item."
```

**Materialization strategy** (Round 6 P1 — `apiKeyHelper` 가 기본):

- **Default: `apiKeyHelper` + `--settings <temp-path>`**
  - Temp 디렉토리에 쉘 스크립트 + settings.json 작성.
  - 스크립트: `#!/bin/sh\nprintf '%s' '<token>'\n` (single-quote, 이스케이프 적용).
  - settings.json: `{ "apiKeyHelper": "<helper-path>" }`.
  - spawn args: `--settings <settings-path>`.
  - 장점: 토큰이 child `ps`/`/proc` env 에 노출되지 않음.
  - Spawn 종료 시 temp 디렉토리 `rm -rf` (cleanup hook).

- **Fallback: env pass-through** (`prefer: 'env'` 로 명시적 opt-in)
  - spawn env 에 `ANTHROPIC_API_KEY=<token>` 추가.
  - 장점: 단순. 단점: 토큰이 child proc env 에 노출 (`ps auxe` / `/proc/<pid>/environ`).

구현: `authResolver.resolveClaudeAuthForIsolated({ envAllowlist?, hasKeychain?, readKeychainToken?, prefer?, tmpRoot? })` — 반환 `{ canAuth, env, sources, diagnostics, apiKeyHelperSettings? }`.

Non-isolated 워커 / manager 는 이 규칙 적용 대상 아님 — 기존 `resolveClaudeAuth` 경로 유지.

### 6.10 호환성

- 기존 `runs.preset_id = NULL` 인 row 는 legacy spawn path (호스트 상속, 현재 동작).
- 기존 Skill Pack 은 preset 과 **독립적**으로 계속 작동. Preset 이 prompt/MCP 를 얹으면 skill pack 과 병합. Conflict 는 "preset wins on explicit mcp_server override, skill pack wins on prompt order priority".
- `agent_profiles` 의 `args_template` 에서 Codex/OpenCode 용 `{system_prompt_file}` placeholder (Phase 5-3) 는 preset base prompt + skill pack prompt 를 합친 최종 파일을 가리키도록 lifecycleService 가 조립.

---

## 7. Phase 분할 (v3 Phase 10 sub-phases)

### Phase 10A: Auth Compatibility Spike (1~2일)
- PoC: Claude CLI 를 `--bare` + `CLAUDE_CODE_OAUTH_TOKEN` env 로 실행해 OAuth 갱신 / first turn 성공 확인
- 결과 문서화 in `docs/specs/worker-preset-and-plugin-injection.md` §10 Review Log
- **Gate**: 실패 시 전체 Phase 10 보류 (auth flow 재설계 선행)

### Phase 10B: DB + Service (3~5일)
- Migration 018
- `server/services/presetService.js` (CRUD, snapshot builder, resolveForSpawn)
- `server/routes/workerPresets.js`
- Unit tests

### Phase 10C: Spawn Wiring — Tier 1 + snapshot persistence (3~5일)
- `lifecycleService.executeTask` + `executionEngine.spawnProcess` 에 preset MCP config 주입:
  - Claude worker: `streamJsonEngine.spawnAgent({ systemPrompt, mcpConfig })` (manager 의 startSession 과 다름)
  - Codex worker: spawn args 에 `codex exec -c 'mcp_servers=<json>'` 추가 + prompt placeholder 파일 치환
  - OpenCode worker: `opencode` CLI 실측 — MCP config flag 존재 확인. 없으면 prompt-only + `preset:mcp_unsupported` warning
  - Note: codex / opencode **manager** adapter 는 변경 대상 아님 (worker 경로만)
- Prompt precedence chain (§6.8) 적용
- MCP precedence chain (§6.8) 적용
- **Snapshot persistence** (R1-P1-5 fix): preset 해소 즉시 `run_preset_snapshots` 기록. Phase 10F 에서 audit UI 만 추가.
- `min_claude_version` 호환성 체크 (R1 coverage)
- Tier 2 still dormant — isolated flag 저장만 하고 미사용

### Phase 10D: Tier 2 (Claude-only) + Auth env (2~3일)
- `--bare --strict-mcp-config --setting-sources '' --plugin-dir` 추가
- `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` 주입 규칙 (§6.9)
- 격리 canary 테스트 (US-007)

### Phase 10E: Task 연동 + UI (3~5일)
- `tasks.preferred_preset_id` 주입 + ExecuteModal 선택
- `#presets` 페이지 (Preact, 기존 스타일)
- Run Inspector 에 applied preset snapshot 표시
- US-008 (삭제/invalidation) 실행-시 handling

### Phase 10F: Audit UI (1~2일)
- Snapshot 불일치 감지 UI (preset 이 수정된 후 재실행 시 경고 배지)
- Past run 과 현재 preset diff view

### Phase 10G: `server/plugins/agent-olympus/` 실제 연동 (1일)
- agent-olympus 실제 배치 + 통합 smoke test
- 문서 업데이트 (README 에 "Installing ecosystem plugins")

**Total 스코프**: 13~21일 어림 (솔로 작업 기준). Phase 10A (auth spike) 가 전체 gate.

---

## 8. Security Considerations

| Risk | Severity | Mitigation |
|------|----------|------------|
| 공급망 공격: 악의적 플러그인이 `server/plugins/` 에 배치 | HIGH | v1 에서 업로드 API 비노출. 사용자가 직접 파일시스템 배치만 허용. 신뢰는 사용자 책임. |
| 플러그인 hook 이 worktree 밖 파일 조작 | MEDIUM | cwd 가 worktree 로 강제됨. 심층 방어는 v2 (sandbox / seccomp). |
| `--bare` 가 keychain 못 읽어 인증 실패 | HIGH | Phase 10A spike 에서 OAuth env 주입 PoC. 실패 시 전체 보류. |
| Plugin format 버전 드리프트 (Claude CLI 업데이트) | MEDIUM | Preset 에 `min_claude_version` 필드 추가 (Phase 10B optional). Spawn 시 CLI `--version` 체크. |
| Preset snapshot 이 거대해짐 (plugin 전체 파일 hash) | LOW | file_hashes JSON 을 snapshot row 에 전체 저장. 대용량 plugin 은 압축/제한 검토 (v2). |
| Skill Pack 과 Preset 의 MCP alias 충돌 | MEDIUM | Preset 우선 규칙 + warning. conflict_policy 재사용. |
| 삭제된 preset 을 참조하는 past run | LOW | `run_preset_snapshots.preset_id` 는 FK 없이 plain text. Preset 삭제가 snapshot 에 영향 없음. Task 의 `preferred_preset_id` 는 app-level cascade (presetService.deletePreset 트랜잭션 내 UPDATE) 로 NULL. |
| Plugin 파일 concurrent mutation (TOCTOU) — manifest snapshot 계산 중에 파일이 바뀜 | LOW | Manifest build 는 stat→read→hash 를 각 파일 당 atomic 시퀀스로 수행. Stat 기준 mtime 과 read 시점 mtime 이 다르면 해당 파일만 재해싱 (1회 재시도). 여전히 race 발생 시 spawn 은 진행 (best-effort), 기록된 snapshot 은 실제 spawn 시점 파일 내용과 일치함을 보장 못 함 — 운영자가 spawn 중 `server/plugins/` 를 수정하지 않는 것이 전제. |

---

## 9. Open Questions

| # | 질문 | 권장안 | 영향 |
|---|------|--------|------|
| OQ-1 | `--bare` + `CLAUDE_CODE_OAUTH_TOKEN` env 로 OAuth 세션이 정상인가? | Phase 10A spike 에서 결정. 실패 시 전체 보류. | Blocker |
| OQ-2 | `server/plugins/` 는 git submodule vs 직접 copy? | 초기는 gitignore + 문서로만 안내. v1 에서 submodule 지원 안 함. | Low |
| OQ-3 | Tier 1 MCP 를 `mcp_server_templates` 재사용 vs 신규 테이블? | 재사용. 기존 스키마 + allowed_env_keys 정책 그대로 적용. | Low |
| OQ-4 | Preset 에 기존 Skill Pack 참조도 허용? (preset.skill_pack_ids) | v1 에서는 NO. 직교 유지. v2 에서 convenience 로 검토. | Low |
| OQ-5 | `claude plugin install` CLI 로 설치한 호스트 plugin 을 import 하는 커맨드? | v1 non-goal. 수동 copy 만. | Low |
| OQ-6 | Preset 수정 시 기존 task.preferred_preset_id 연결은? | Preset 삭제 → task NULL. 수정 → task 연결 유지 (snapshot 은 run 별로 이미 고정). | Low |
| OQ-7 | 3-source MCP / prompt precedence 공식 규칙 | §6.8 에 normative 로 정의됨. **Resolved** in Round 1. | (Resolved) |
| OQ-8 | Isolated preset auth source 우선순위 | §6.9 에 normative 로 정의됨 (`.claude-auth.json` 은 후보 중 하나). **Resolved** in Round 1. | (Resolved) |

---

## 10. Migration Path from v1.0~v1.1 Skill Pack

- **Schema**: ADD only. 기존 `skill_packs` / `project_skill_packs` / `task_skill_packs` / `run_skill_packs` 변경 0.
- **Service**: `skillPackService.resolveForRun` 은 기존 signature 유지. 신규 `presetService.resolveForSpawn` 은 별도 호출 경로.
- **API**: 기존 엔드포인트 변경 0. 신규 `/api/worker-presets/*`.
- **UI**: 기존 `#skills` 페이지 변경 0. 신규 `#presets` 페이지.
- **Runtime**: `preset_id IS NULL` 인 워커 (현재 모든 워커) 는 기존 경로 그대로. 새 워커만 preset 적용.

**기존 Skill Pack 의 역할**: 계속 유효. Prompt/MCP/checklist 라는 "콘텐츠 계약" 레이어로 남음. Preset 은 "실행 환경 계약" 레이어.

---

## 11. Review Log

### Round 0 — Initial Draft (v0.1-draft, 2026-04-14)
- 2026-04-08 보류 결정 (`project_plugin_skill_injection_idea.md`) 을 해제하는 계기: Skill Pack Gallery v1.1 배포 이후 사용자가 ecosystem plugin 통합을 요청.
- MVP 우선순위는 메모리 기반: --bare → MCP registry (재사용) → --plugin-dir → UI.
- Phase 10A (auth spike) 를 gate 로 명시. 실패 시 전체 보류.

### Round 1 — Codex Cross-Review (ask-codex-20260414-203317-7757)

**P0 (3건) 반영:**
- [R1-P0-1] "Tier 1 portable" 정확화 — §TL;DR + §3 Lock-in 에 "portable schema, adapter-specific wiring" 로 수정. Codex manager adapter 가 mcpConfig 를 무시하는 현실 반영.
- [R1-P0-2] Snapshot path namespacing — §6.5 에 `<pluginRef>/<relpath>` 네임스페이스 + manifest cache 도입 명시.
- [R1-P0-3] 격리 주장 강등 — Lock-in #5 를 "best-effort" 로 downgrade. cwd 경계만 제공, 커널 샌드박스는 v2.

**P1 (5건) 반영:**
- [R1-P1-1] Auth decision rule §6.9 신설 — env ANTHROPIC_API_KEY → authResolver token sources → fail-closed 순서. `.claude-auth.json` 는 source 중 하나.
- [R1-P1-2] MCP precedence chain §6.8 신설 — preset > project > skill pack. Collision 시 warning 이벤트.
- [R1-P1-3] Prompt concatenation order §6.8 신설 — preset base → skill pack sections (priority order) → adapter footer. Separator 지정.
- [R1-P1-4] Manifest cache (§6.5) 도입 — (mtimeNs, size) 캐시 키로 재해싱 회피.
- [R1-P1-5] Snapshot persistence 를 Phase 10F → 10C 로 이동. 10F 는 audit UI 만 담당.

**Coverage gaps 반영:**
- US-008 추가 (삭제/invalidation/CLI version mismatch 실행-시 동작)
- G6 목표 추가 (min_claude_version 호환성 체크)
- OQ-7, OQ-8 신설 + Resolved 마킹

### Round 2 — Codex Cross-Review (ask-codex-20260414-203748-e42f)

**VERDICT: remaining P1 (2건)**

**P1 반영:**
- [R2-P1-1] §6.3 spawn wiring pseudo-code 에 project MCP source 를 3-source merge 에 명시적으로 포함 (`mergeMcp3(preset, project, skillPack)`). §6.8 의 precedence chain 과 구현 경로 일치.
- [R2-P1-2] §TL;DR 에 Codex/OpenCode Tier 1 MCP 주입 경로를 concrete 하게 명시 (Codex: `codex exec -c mcp_servers=...`, OpenCode: 실측 후 확정 + graceful degrade). Phase 10C 에도 동일 반영.

### Round 3 — Codex Cross-Review (ask-codex-20260414-203927-2ad6)

**VERDICT: PASS** (§6.3, §6.8, §Phase 10C 내부 일관성 확보)

### Round 4 — Codex Fresh Cold-Read (ask-codex-20260414-205928-4a96)

**VERDICT: not ready, P1 (5건)** — 이전 PASS 이후 fresh cold-read 에서 발견.

**P1 반영:**
- [R4-P1-1] `min_claude_version` 컬럼을 §6.1 schema 에 추가. US-008 + G6 normative 요구사항 충족.
- [R4-P1-2] Worker API naming 정정 — manager 의 `streamJsonEngine.startSession` 이 아닌 worker 의 `streamJsonEngine.spawnAgent` 가 실제 wiring 포인트. §TL;DR + Phase 10C 동기화. Codex/OpenCode 도 **manager 경로는 변경 없음, worker 경로만** 임을 명시.
- [R4-P1-3] Auth contract change 명시 — §6.9 에 "현재 `authResolver.resolveClaudeAuth` 는 keychain existence-only, isolated worker 용 `resolveClaudeAuthForIsolated` 신메서드 필요" 문구 추가. 호환성 보존을 주장하지 않고 명시적 확장 선언.
- [R4-P1-4] Delete/cascade 모델 정확화 — `run_preset_snapshots.preset_id` 는 FK 없음 (historical), `tasks.preferred_preset_id` 는 app-level cascade (SQLite ALTER TABLE FK 제약 한계). §6.1 + 위험표 동기화.
- [R4-P1-5] TOCTOU 위험 + baseline 테스트 수 (651→672) 수정.

### Round 5 — Codex Final Verification (ask-codex-20260414-210342-cad5)

**VERDICT: PASS**

> "I checked the Round 4 fixes ... they are reflected consistently in the normative sections and review log. I did not find a remaining P0/P1 inconsistency that blocks this spec."

Spec v0.1-rc1 최종 수렴. **Status: Approved — merge 가능, Phase 10A 착수 가능.**

### Round 6 — Phase 10A Spike Results (2026-04-14, branch `spike/phase-10a-bare-auth`)

**VERDICT: CONDITIONAL PASS — §6.9 를 amend 하면 gate 통과.**

PoC 스크립트: `scripts/spike-bare-auth.mjs`. 4 variant 매트릭스, macOS darwin + Claude CLI 2.1.107.

| # | Variant | Result | Notes |
|---|---------|--------|-------|
| A | `--bare` + `CLAUDE_CODE_OAUTH_TOKEN` env (spec §6.9 primary) | **FAIL** | stdout = "Not logged in · Please run /login" (exit 1). CLI help 의 "OAuth and keychain are never read" 가 env 에도 적용됨. |
| B | `--bare` + `ANTHROPIC_API_KEY=<oauth-token>` env | **PASS** | stdout = "HELLO" (exit 0, ~3.4s). OAuth access token (`sk-ant-oat01-...`) 을 API key 슬롯으로 전달하면 Anthropic API 가 그대로 수용. |
| C | `--bare` + `apiKeyHelper` via `--settings` | **PASS** | stdout = "HELLO" (exit 0, ~3.3s). 임시 shell 스크립트가 토큰을 stdout 으로 출력, settings.json 이 가리킴. 토큰이 env 에 남지 않는 정방어 이점. |
| D | `--bare` + no auth (negative control) | **FAIL** (예상대로) | negative control — 격리 유효. |

**핵심 인사이트:**

1. `--bare` 의 CLI help ("Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings — OAuth and keychain are never read") 는 env 까지 포함해서 엄격히 적용. `CLAUDE_CODE_OAUTH_TOKEN` 은 non-bare 모드 전용.
2. 동일한 OAuth access token 값을 `ANTHROPIC_API_KEY` 로 전달하면 API 쪽에서 수용하므로 **auth flow 자체는 구현 가능**.
3. 따라서 §6.9 를 다음과 같이 amend:
   - ~~`CLAUDE_CODE_OAUTH_TOKEN` env 주입~~ → **`ANTHROPIC_API_KEY` env 에 토큰 값 주입** (primary path)
   - 선택적 hardening: token 값을 env 대신 `apiKeyHelper` 쉘 스크립트로 materialize 하고 `--settings <temp-settings.json>` 로 가리키기 (token 이 `ps`/`/proc` 에 안 찍힘)
4. `authResolver.resolveClaudeAuthForIsolated()` 는 3 source (env `ANTHROPIC_API_KEY` → `.claude-auth.json` → keychain) 에서 materialize 가능한 token 을 찾아 최종적으로 **하나의 `ANTHROPIC_API_KEY` 값**을 반환. OAuth vs API key 구분은 isolated spawn 시점에서는 무의미.
5. Variant D 가 FAIL 한 점은 `--bare` 가 실제로 host keychain / `~/.claude/` 을 무시함을 확인 — isolation 자체는 원 스펙대로 동작.

**다음 단계:**

- Phase 10A gate: **PASS (conditional)** — Phase 10B 진입 가능.
- Phase 10D 구현 시 §6.9 의 환경변수 이름을 `CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` 로 교체. `authResolver.resolveClaudeAuthForIsolated()` 의 반환 계약도 그에 맞춰 `{ ANTHROPIC_API_KEY }` 를 생성.
- 스펙 §6.9 의 normative 블록은 Phase 10D 구현 PR 에서 같이 수정 (현재 round 6 로그만으로 구현 가이드 충분).
- 보안 메모: OAuth access token 은 수명이 유한 (Anthropic 회전) 이므로 materialize 시 refresh 전략은 v1 non-goal — 만료 시 `/login` 안내 에러만 surface.

**Round 6 Codex cross-review (ask-codex-20260414-212157-d40e) — PASS:**

- 방법론: 반례·대조군 포함으로 결론 근거 충분 (P0 이슈 없음).
- §6.9 amendment 타당. `resolveClaudeAuthForIsolated() → { ANTHROPIC_API_KEY }` 정합.
- **P1 security refinement**: env 주입은 동일 사용자 proc/env 열람으로 노출면이 남고, OAuth token 을 API key 슬롯에 두면 다운스트림 로거의 key-name redaction 이 100% 안전하다 가정 불가. 권고: **지속 경로는 `apiKeyHelper + --settings` 를 기본 (default)** 으로, env materialize 는 temporary/test fallback. Phase 10D 구현 시 이 우선순위 반영.
- Phase 10B 진입 OK — §6.9 문구를 "ANTHROPIC_API_KEY or apiKeyHelper only under `--bare`" 로 정정하는 선행 작업만 Phase 10D 에 같이 넣으면 됨.





- [ ] Migration 018 통과 + 기존 테스트 회귀 0건 (npm test)
- [ ] US-001~US-007 모두 자동화 테스트로 증명
- [ ] Phase 10A auth spike PASS (공식 PoC 문서 존재)
- [ ] G1 canary 테스트로 "호스트 `~/.claude/plugins/<canary>` 가 isolated 워커에 누출되지 않음" 증명
- [ ] Codex 교차리뷰 PASS (P0/P1 0건)
- [ ] `server/plugins/agent-olympus/` 실제 배치 + 통합 smoke test 통과
- [ ] 문서: 본 spec + README 에 "Creating a Worker Preset" 섹션 추가
