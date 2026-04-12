# Skill Packs — Agent-Agnostic Capability Injection

> Version 0.2 | 2026-04-13
> Status: **Draft — 2차 cross-review 피드백 반영.**
> 관련 문서: [manager-v3-multilayer.md](./manager-v3-multilayer.md), [../../CLAUDE.md](../../CLAUDE.md)
>
> v0.2 변경: Codex/Gemini 2차 리뷰 반영. P0: run_skill_packs 스키마 수정 (비정규화 스냅샷), MCP command allowlist 도입, excluded 최종 우선 원칙. P1: priority 우선순위 규칙, 프로젝트 MCP merge 알고리즘, 어댑터별 injection 경로 현실화, 보안 강화 (path traversal, env allowlist, 소유권 검증), Phase 1 분할.

---

## TL;DR

Palantir Console이 **에이전트 종속 없이** 스킬/플러그인을 중앙 관리하고, 워커 spawn 시 해당 에이전트의 주입 경로에 맞게 자동 적용하는 시스템.

핵심 가치:
- **벤더 중립**: 동일한 스킬 팩이 Claude, Codex, Gemini 워커에 모두 적용됨 (prompt overlay는 모든 에이전트, MCP는 Claude 워커 전용 — v1 기준)
- **설치 불필요**: 스킬이 Palantir Console DB에 저장되어 로컬 설치 의존 없음
- **3계층 활용**: PM이 태스크 성격에 맞는 스킬을 자율 선택해서 워커에 장착

---

## 1. Lock-in (변경하지 않는 원칙)

1. **스킬 팩은 3개의 독립 plane으로 분해된다**: prompt overlay / tooling overlay / acceptance overlay. 각 plane은 별도 병합 규칙을 가진다.
2. **적용된 스킬은 run 시작 시 비정규화 스냅샷으로 고정된다**: prompt 원문, MCP config, 체크리스트를 스냅샷 행에 직접 저장. 스킬 팩이 수정/삭제되어도 run 기록은 완전히 재현 가능.
3. **어댑터 호환성은 명시적이다**: 각 스킬 팩의 어떤 plane이 어떤 에이전트에서 유효한지 UI에서 표시. silent ignore 금지 — non-Claude 워커에 MCP가 포함된 스킬 팩이 적용되면 run 이벤트에 `skill_pack:mcp_skipped` 경고를 기록.
4. **사용자 excluded는 최종 우선이다**: 사용자가 태스크에서 제외한 스킬 팩은 PM의 `explicitPackIds`로도 재포함할 수 없다. PM은 `pinned_by='pm'`으로 새 바인딩을 만들 수 있지만, `excluded` + `pinned_by='user'`인 기존 제외를 덮어쓸 수 없다.

---

## 2. 3-Plane 분해

스킬 팩은 하나의 엔티티이지만, 내부적으로 3개의 plane으로 분리 처리된다.

### 2.1 Prompt Overlay

에이전트 시스템 프롬프트에 주입되는 텍스트. 페르소나, 행동 규범, 전문 지식을 포함.

```
"너는 접근성 전문가다. 모든 UI 변경에 WCAG 2.2 AA 기준을 적용하고,
 스크린리더 호환성을 반드시 확인해라..."
```

- `prompt_full`: 전체 프롬프트 텍스트
- `prompt_compact`: 축약 버전 (다중 스킬 적용 시 토큰 절약용)
- `estimated_tokens`: 저장 시 자동 계산 (`prompt_full` 기준 `chars / 4`). `prompt_compact`에 대해서는 `estimated_tokens_compact`를 별도 저장.
- **`injection_position`은 제거** (v0.2): `--append-system-prompt`가 에이전트 빌트인 프롬프트 뒤에 붙는 구조이므로, `prepend`/`append`를 지원할 수 없음. 모든 스킬 팩 프롬프트는 project_brief 뒤, 태스크 프롬프트 앞에 priority 순으로 배치.

### 2.2 Tooling Overlay

MCP 서버 설정. 에이전트에게 외부 도구 접근 권한을 부여.

**v0.2: MCP command allowlist 도입 (P0 보안)**

자유 입력 `command`/`args`는 RCE 벡터이므로, v1에서는 **등록된 MCP 서버 템플릿만 선택 가능**:

```sql
-- 관리자가 사전 등록하는 MCP 서버 템플릿
CREATE TABLE mcp_server_templates (
  id          TEXT PRIMARY KEY,
  alias       TEXT NOT NULL UNIQUE,    -- e.g. "playwright", "filesystem"
  command     TEXT NOT NULL,
  args        TEXT,                     -- JSON array
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

스킬 팩의 `mcp_servers` 필드는 alias 참조 + 선택적 env override만 허용:

```json
{
  "playwright": { "env_overrides": { "BROWSER": "chromium" } }
}
```

- `command`/`args`는 `mcp_server_templates`에서만 제공 — 스킬 팩 작성자가 임의 명령을 지정할 수 없음
- `env_overrides`의 키는 env allowlist로 검증 (§2.2.1)
- 템플릿 CRUD는 admin-only API (`/api/mcp-templates`)

#### 2.2.1 MCP env allowlist

`env_overrides`에 허용되는 키를 제한:
- **금지 패턴**: `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_CREDENTIAL`
- 서비스 레이어에서 regex 검증 후 거부 시 400 에러
- 기존 `authResolver.buildManagerSpawnEnv`의 credential-leak 필터링 패턴과 동일한 접근

#### 2.2.2 어댑터별 호환성

- Claude 워커: `--mcp-config` ✅
- Codex/Gemini 워커: MCP 미지원 → run 이벤트에 `skill_pack:mcp_skipped` 경고 기록 (Lock-in #3 준수)
- MCP config 파일은 `path.join(process.cwd(), 'runtime', 'mcp', runId + '.json')`에 **절대 경로**로 생성
- `runId`는 파일명으로 사용 전 `/^[a-zA-Z0-9_-]+$/` 검증 (path traversal 방어)
- 파일 권한: `0o600` (`.claude-auth.json`과 동일)
- run 종료 시 삭제. 서버 부팅 시 고아 파일 정리.

#### 2.2.3 runtime 디렉토리 관리

- 서버 시작 시 `fs.mkdirSync(path.join(process.cwd(), 'runtime', 'mcp'), { recursive: true })` 실행 (`app.js` 또는 `index.js`)
- `runtime/` 디렉토리는 `.gitignore`에 추가
- MCP config 파일 write 실패 시: run을 `failed`로 마킹하고 에러 반환 (기존 `executeTask` catch 블록과 동일 패턴)

### 2.3 Acceptance Overlay

완료 기준 체크리스트. 에이전트 프롬프트에는 주입되지 않고, Console UI에서 PM/사용자가 결과 검증 시 사용.

```json
["접근성 검사 통과", "스크린리더 테스트 완료", "색상 대비 4.5:1 이상"]
```

- 프롬프트 비대화 방지: 체크리스트는 기본적으로 프롬프트에 포함하지 않음
- `inject_checklist`: `true`로 설정하면 프롬프트 끝에 "완료 전 다음을 확인해라:" 형태로 주입 가능
- v1에서는 **읽기 전용 표시만** — 체크 상태 저장은 후속 (§16 참조)

---

## 3. 스코핑 & 접근 범위

```
글로벌 스킬 팩 라이브러리          ← 전체 스킬 풀 (모든 프로젝트에서 접근 가능)
 ├── 프로젝트 기본 스킬 팩         ← auto_apply: 이 프로젝트 워커에 자동 적용
 │    └── PM이 태스크별로 추가/제외
 └── PM이 글로벌 풀에서 추가 선택   ← 프로젝트에 바인딩 안 된 스킬도 가져다 쓸 수 있음
```

### 3.1 스코프

| scope | project_id | 의미 |
|-------|-----------|------|
| `global` | NULL | 모든 프로젝트에서 사용 가능 |
| `project` | FK | 해당 프로젝트 전용 |

**이름 유일성 제약**:
- global 스코프: `UNIQUE(name) WHERE scope='global'`
- project 스코프: `UNIQUE(name, project_id) WHERE scope='project'`
- 같은 이름의 project-scope 팩이 있으면 `GET /api/skill-packs?project_id=X`에서 해당 project 팩이 같은 이름의 global 팩을 **대체**하여 반환 (shadow). 양쪽 다 DB에 공존하지만 API 응답에서는 effective 버전만 노출.

### 3.2 바인딩 계층

**프로젝트 바인딩** (`project_skill_packs`):
- `auto_apply = true`: 해당 프로젝트의 모든 워커에 자동 적용
- `auto_apply = false`: 프로젝트 기본 목록에 노출되지만 수동 선택 필요
- **cross-project 바인딩 방지**: `scope='project'`인 스킬 팩은 `project_skill_packs.project_id`가 `skill_packs.project_id`와 일치해야 함. 서비스 레이어에서 검증 (`bindToProject`), 불일치 시 400.

**태스크 바인딩** (`task_skill_packs`):
- PM 또는 사용자가 태스크에 명시적으로 스킬 팩을 핀/제외
- `pinned_by`: `pm` | `user` — 누가 바인딩했는지 추적 (v1에서는 audit-only, 행동 차이 없음)
- `excluded`: `true`면 auto_apply 스킬이라도 이 태스크에서 제외. **excluded + pinned_by='user'는 PM explicitPackIds로도 override 불가** (Lock-in #4)

### 3.3 PM의 스킬 팩 접근

PM 시스템 프롬프트에는:
- 프로젝트에 바인딩된 기본 스킬 팩 목록 (이름 + 한 줄 설명)
- "글로벌 스킬 팩은 `GET /api/skill-packs` 로 조회 가능 (필요시 lazy 조회, 매 턴 호출 금지)" 안내

PM은 `/execute` 호출 시 `skill_pack_ids` 배열을 포함해 워커에 장착할 스킬을 지정.
생략 시 프로젝트 auto_apply 스킬만 적용.

---

## 4. 병합 규칙 (다중 스킬 팩 합성)

워커에 여러 스킬 팩이 적용될 때의 병합 순서:

```
1. Agent Profile 기본 설정 (baseline)
2. 프로젝트 auto_apply 스킬 팩 (priority 순)
3. 태스크에 핀된 스킬 팩 (priority 순)
4. explicitPackIds (PM/사용자가 /execute 시 지정)
5. 태스크 실행 프롬프트 (사용자/PM 지시)
```

### 4.0 Priority 우선순위 규칙 (v0.2 추가)

priority 필드가 3곳에 존재할 수 있다:

| 소스 | 필드 | 의미 |
|------|------|------|
| `skill_packs.priority` | 팩의 기본 우선순위 | 바인딩이 없을 때 사용 |
| `project_skill_packs.priority` | 프로젝트 바인딩 우선순위 | auto_apply 시 사용 |
| `task_skill_packs.priority` | 태스크 바인딩 우선순위 | 핀 시 사용 |

**규칙: 가장 구체적인 바인딩의 priority가 이긴다.**
`task binding > project binding > pack default`. 같은 팩이 project(priority=50)과 task(priority=200)에 모두 바인딩되어 있으면 task의 200을 사용.

### 4.1 Prompt Overlay 병합

- effective priority 오름차순으로 연결 (priority 1이 먼저, 가장 높은 priority가 태스크 지시에 가장 가까움)
- 각 팩 사이에 `--- Skill: {name} ---` 구분자 삽입
- 중복 제거: 같은 `skill_pack_id`가 여러 소스(auto_apply + explicit)에서 등장하면 한 번만 포함

최종 프롬프트 구성:
```
[에이전트 빌트인 시스템 프롬프트]
  ↓ (--append-system-prompt 또는 model_instructions_file로 주입)
[project_brief: conventions + pitfalls]
[스킬 팩 프롬프트들, effective priority 오름차순]
[태스크 실행 프롬프트]
```

### 4.2 Tooling Overlay 병합

**프로젝트 MCP와의 merge 알고리즘** (v0.2 추가):

```
1. base = projects.mcp_config_path 파일 내용 파싱 (없으면 {})
2. 스킬 팩 MCP = 각 팩의 mcp_servers alias를 mcp_server_templates에서 해소
3. 팩 간 충돌: 같은 alias가 2개 이상 팩에서 등장
   → 높은 priority 팩의 conflict_policy 적용
   → fail: spawn 차단 + 에러
   → warn: 높은 priority 팩 config 사용 + run 이벤트에 경고
4. 프로젝트 MCP vs 스킬 팩 충돌: 프로젝트 MCP가 항상 이김 (base 우선)
   → 스킬 팩의 같은 alias는 무시 + run 이벤트에 경고
5. 결과를 단일 JSON으로 합성 → runtime/mcp/<run_id>.json에 기록 (절대 경로)
```

**`conflict_policy` 소속 (v0.2 정정)**: `conflict_policy`는 `skill_packs` 테이블에 남지만, 팩 간 충돌 시 **높은 priority(더 구체적 바인딩) 팩의 policy가 적용**된다. 두 팩의 priority가 동일하면 `fail`이 이김 (가장 제한적 정책 우선).

### 4.3 Acceptance Overlay 병합

- 모든 팩의 체크리스트를 연결
- 중복 제거: trim + 대소문자 무시 정규화 후 비교
- 순서: effective priority 오름차순

---

## 5. 토큰 예산 관리

프롬프트 비대화 방지를 위한 가드레일.

- 각 스킬 팩 저장 시 `estimated_tokens` 자동 계산 (`prompt_full`의 `chars / 4`)
- `estimated_tokens_compact`도 별도 계산 (`prompt_compact`의 `chars / 4`)
- **런타임 재계산** (v0.2): `resolveForRun`에서 실제 사용할 텍스트(full 또는 compact)의 길이를 기준으로 토큰을 재계산. DB의 `estimated_tokens`는 UI 표시용, 실제 예산 검사는 resolve 시점의 텍스트 기반.
- 런타임 캡: `SKILL_PACK_TOKEN_BUDGET` 환경변수 (기본: 4000)
- 총합이 캡 초과 시:
  1. `prompt_compact`가 있는 팩은 compact 버전으로 교체
  2. 여전히 초과 시 spawn 차단 + 에러: "Skill pack token budget exceeded (N/4000). Remove packs or use compact mode."
- PM 시스템 프롬프트에는 프로젝트 스킬 팩의 compact 요약만 포함 (Codex 캐싱 보호)

---

## 6. 어댑터별 호환성

### 6.1 v1 injection 경로 (현실)

| Plane | Claude 워커 (stream-json) | Codex 워커 | Gemini / 기타 워커 |
|-------|--------------------------|------------|-------------------|
| Prompt Overlay | `--append-system-prompt` ✅ | v1 미지원 ❌ (워커 전용 adapter 없음) | v1 미지원 ❌ (generic `args_template` 경로) |
| Tooling Overlay (MCP) | `--mcp-config` ✅ | 미지원 ❌ | 미지원 ❌ |
| Acceptance Overlay | Console UI only | Console UI only | Console UI only |

**v0.2 현실화**: v1에서 prompt overlay + MCP 모두 지원하는 것은 **Claude 워커뿐**이다. Codex/Gemini 워커는 현재 `executionEngine` (tmux/subprocess)을 통해 `args_template` + prompt 문자열만 전달하므로, 시스템 프롬프트 주입 경로가 없다.

**v1 범위**: Claude 워커에 대해서만 full skill pack 적용. 다른 에이전트는 후속 phase에서 injection 인터페이스를 정의한 후 지원.

**후속 확장 경로** (Phase 5+):
- Codex 워커: `model_instructions_file` 경로를 `args_template`에 `{system_prompt_file}` placeholder로 추가
- Gemini 워커: 유사 placeholder 또는 dedicated adapter
- 각 어댑터가 MCP를 지원하면 tooling overlay도 활성화

### 6.2 호환성 표시

스킬 팩 UI에 어댑터별 지원 배지 표시:
- `✅ Full` — prompt + MCP 모두 적용 (Claude 워커)
- `📝 Prompt-only` — prompt만 적용, MCP 무시됨 (향후 Codex/Gemini)
- `⏳ Not yet supported` — v1에서 미지원 (Codex/Gemini 워커)
- 비호환 에이전트로 실행 시 run 이벤트에 `skill_pack:adapter_unsupported` 경고 기록

---

## 7. Run 스냅샷 (v0.2 비정규화)

워커 spawn 시점에 적용된 스킬 팩 상태를 `run_skill_packs` 테이블에 **비정규화하여** 기록.

| 필드 | 용도 |
|------|------|
| `id` | 서로게이트 PK (INTEGER AUTOINCREMENT) |
| `run_id` | FK → runs (ON DELETE CASCADE) |
| `skill_pack_id` | nullable FK → skill_packs (ON DELETE SET NULL). 팩 삭제 시 NULL이 되지만 스냅샷 데이터는 유지 |
| `skill_pack_name` | 적용 시점의 팩 이름 (비정규화) |
| `prompt_text` | 실제 주입된 프롬프트 원문 (full 또는 compact) |
| `prompt_hash` | `prompt_text`의 SHA-256 |
| `mcp_config_snapshot` | 해소된 MCP config JSON (env_overrides 적용 후) |
| `mcp_config_path` | 생성된 MCP config 파일 절대 경로 (cleanup 용) |
| `checklist_snapshot` | 체크리스트 JSON 배열 |
| `applied_mode` | `full` \| `compact` |
| `applied_at` | 적용 시각 |

이 스냅샷으로:
- run 시점에 **정확히 무엇이** 적용되었는지 완전히 재현 가능
- 스킬 팩이 수정/삭제되어도 기록 유지 (비정규화 데이터 독립)
- Run Inspector는 **이 스냅샷 테이블만** 읽음 (live `skill_packs` 아님)
- MCP config 파일의 orphan cleanup 가능

---

## 8. PM 프롬프트 캐싱과의 상호작용

Codex PM의 `model_instructions_file`은 안정적 내용 → `cached_input_tokens` 히트가 핵심.

**원칙**: 프로젝트 기본 스킬 팩 변경 시 PM reset 필수.

- PM 시스템 프롬프트에는 프로젝트 auto_apply 스킬의 **이름 + 한 줄 설명 목록**만 포함 (full prompt 아님)
- PM이 워커를 spawn할 때 스킬 팩의 full prompt를 워커에 주입하는 것이지, PM 자신이 읽는 게 아님
- 프로젝트 기본 스킬 목록이 바뀌면 → PM system prompt가 바뀜 → 캐싱 무효화 → PM reset 경고 UI 표시
- `auto_apply` 변경 시에만 PM reset 경고. 바인딩 priority 변경은 PM 지식에 영향 없으므로 경고 불필요.

---

## 9. 기존 시스템과의 경계

| 시스템 | 역할 | 스킬 팩과의 관계 |
|--------|------|-----------------|
| `agent_profiles.capabilities_json` | 에이전트가 **할 수 있는 것** (supply-side) | 읽기 전용. 스킬 팩이 수정하지 않음 |
| `tasks.requires_capabilities` | 태스크가 **필요로 하는 것** (demand-side) | v1에서는 연동 없음. 후속 phase에서 스킬 팩이 capability 요구사항을 추가하는 것 고려 |
| `project_briefs` (conventions/pitfalls) | 프로젝트 컨벤션과 알려진 함정 | 유지. 스킬 팩과 별도 layer. 프롬프트에서 스킬 팩 앞에 위치 |
| `projects.mcp_config_path` | 프로젝트 전역 MCP 설정 | 유지. 스킬 팩 MCP와 merge됨 — §4.2 알고리즘 참조 (프로젝트 MCP가 base, 충돌 시 프로젝트 우선) |

---

## 10. 데이터 모델

### 10.1 신규 테이블

```sql
-- MCP 서버 템플릿 (admin-only 등록)
CREATE TABLE mcp_server_templates (
  id          TEXT PRIMARY KEY,
  alias       TEXT NOT NULL UNIQUE,
  command     TEXT NOT NULL,
  args        TEXT,              -- JSON array
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 스킬 팩 정의
CREATE TABLE skill_packs (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT,
  scope                    TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','project')),
  project_id               TEXT REFERENCES projects(id) ON DELETE CASCADE,
  icon                     TEXT,
  color                    TEXT,
  -- Prompt Overlay
  prompt_full              TEXT,
  prompt_compact           TEXT,
  estimated_tokens         INTEGER DEFAULT 0,
  estimated_tokens_compact INTEGER DEFAULT 0,
  -- Tooling Overlay (alias 참조 + env override만)
  mcp_servers              TEXT,          -- JSON: { "alias": { "env_overrides"?: {...} } }
  conflict_policy          TEXT NOT NULL DEFAULT 'fail' CHECK(conflict_policy IN ('fail','warn')),
  -- Acceptance Overlay
  checklist                TEXT,          -- JSON array of strings
  inject_checklist         INTEGER NOT NULL DEFAULT 0,
  -- Meta
  priority                 INTEGER NOT NULL DEFAULT 100,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  -- Constraints
  CHECK (scope = 'global' OR project_id IS NOT NULL),
  CHECK (scope = 'project' OR project_id IS NULL)
);

-- 이름 유일성 (partial unique index)
CREATE UNIQUE INDEX uq_skill_pack_name_global
  ON skill_packs(name) WHERE scope = 'global';
CREATE UNIQUE INDEX uq_skill_pack_name_project
  ON skill_packs(name, project_id) WHERE scope = 'project';

-- 프로젝트-스킬 팩 바인딩
CREATE TABLE project_skill_packs (
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_pack_id        TEXT NOT NULL REFERENCES skill_packs(id) ON DELETE CASCADE,
  priority             INTEGER NOT NULL DEFAULT 100,
  auto_apply           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, skill_pack_id)
);

-- 태스크-스킬 팩 바인딩
CREATE TABLE task_skill_packs (
  task_id              TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  skill_pack_id        TEXT NOT NULL REFERENCES skill_packs(id) ON DELETE CASCADE,
  priority             INTEGER NOT NULL DEFAULT 100,
  pinned_by            TEXT NOT NULL CHECK(pinned_by IN ('pm','user')),
  excluded             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, skill_pack_id)
);

-- Run 스냅샷 (비정규화)
CREATE TABLE run_skill_packs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id               TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  skill_pack_id        TEXT REFERENCES skill_packs(id) ON DELETE SET NULL,
  skill_pack_name      TEXT NOT NULL,
  prompt_text          TEXT,
  prompt_hash          TEXT,
  mcp_config_snapshot  TEXT,
  mcp_config_path      TEXT,
  checklist_snapshot   TEXT,
  applied_mode         TEXT CHECK(applied_mode IN ('full','compact')),
  applied_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, skill_pack_id)
);
```

### 10.2 마이그레이션

`server/db/migrations/013_skill_packs.sql` (012 다음 번호)

---

## 11. API

### MCP 서버 템플릿 (admin-only)
```
GET    /api/mcp-templates              — 목록
POST   /api/mcp-templates              — 등록 { alias, command, args?, description? }
DELETE /api/mcp-templates/:id          — 삭제
```

### Skill Packs CRUD
```
GET    /api/skill-packs                — 목록 (?scope=global|project&project_id=)
                                         project_id 지정 시 shadow 적용: project-scope 팩이 같은 이름의 global 팩 대체
POST   /api/skill-packs                — 생성 (scope='project' 시 해당 프로젝트 소유권 검증)
GET    /api/skill-packs/:id            — 조회
PATCH  /api/skill-packs/:id            — 수정 (scope='project' 시 소유권 검증)
DELETE /api/skill-packs/:id            — 삭제 (scope='project' 시 소유권 검증)
```

### 프로젝트 바인딩
```
GET    /api/projects/:id/skill-packs           — 프로젝트에 바인딩된 스킬 팩 목록
POST   /api/projects/:id/skill-packs           — 바인딩 추가 { skill_pack_id, priority?, auto_apply? }
PATCH  /api/projects/:id/skill-packs/:packId   — 바인딩 수정 { priority?, auto_apply? }
DELETE /api/projects/:id/skill-packs/:packId   — 바인딩 제거
```

### 태스크 바인딩
```
GET    /api/tasks/:id/skill-packs              — 태스크에 바인딩된 스킬 팩 목록
POST   /api/tasks/:id/skill-packs              — 바인딩 추가/제외 { skill_pack_id, priority?, excluded?, pinned_by }
DELETE /api/tasks/:id/skill-packs/:packId      — 바인딩 제거
```

### Run 스냅샷
```
GET    /api/runs/:id/skill-packs               — 이 run에 적용된 스킬 팩 스냅샷 (비정규화 데이터)
```

### Execute 확장
```
POST   /api/tasks/:id/execute
  기존: { agent_profile_id, prompt? }
  확장: { agent_profile_id, prompt?, skill_pack_ids? }
```

`skill_pack_ids`가 명시되면 해당 스킬 팩 + 프로젝트 auto_apply 스킬을 합산 (단, 사용자 excluded 최종 적용).
생략 시 프로젝트 auto_apply 스킬만 적용.
`task.project_id`가 NULL이면 auto_apply 수집은 빈 배열. explicit `skill_pack_ids`는 여전히 적용.

---

## 12. 서비스 레이어

### 12.1 `skillPackService.js` (신규)

- CRUD: `createSkillPack`, `getSkillPack`, `listSkillPacks`, `updateSkillPack`, `deleteSkillPack`
- 바인딩: `bindToProject`, `unbindFromProject`, `bindToTask`, `unbindFromTask`
  - `bindToProject`: `scope='project'`인 팩은 `skill_packs.project_id === binding.project_id` 검증
- MCP alias 해소: `resolveMcpServers(mcpServersJson)` — alias를 `mcp_server_templates`에서 lookup + env_overrides 검증
- **`resolveForRun(taskId, explicitPackIds?)`**: 실행 시점의 effective 스킬 세트 계산
  1. `task.project_id`가 NULL이면 프로젝트 auto_apply = 빈 배열. 아니면 프로젝트 auto_apply 팩 수집
  2. explicitPackIds가 있으면 추가 (id 기준 중복 제거)
  3. 태스크 pinned 팩 추가 (id 기준 중복 제거)
  4. **최종 excluded 필터**: 태스크에서 `excluded=1`인 팩을 제거 (user excluded는 절대 override 불가 — Lock-in #4)
  5. effective priority 계산 (task binding > project binding > pack default)
  6. priority 정렬
  7. 토큰 예산 확인 → 실제 텍스트 기준 재계산 → 초과 시 compact 모드 전환 또는 에러
  8. MCP alias 해소 + 충돌 검사 (§4.2 알고리즘)
  9. 반환: `{ promptSections[], mcpConfig, checklist[], appliedPacks[], warnings[] }`

### 12.2 `lifecycleService.js` 수정

`executeTask` 경로에 스킬 팩 해소 추가:

**가드**: `is_manager=1` run은 스킬 팩 해소를 건너뜀. 스킬 팩은 워커 전용.

1. `skillPackService.resolveForRun(taskId, skill_pack_ids)` 호출
2. `warnings`에 내용이 있으면 run 이벤트로 기록 (`skill_pack:mcp_skipped`, `skill_pack:adapter_unsupported` 등)
3. prompt overlay를 에이전트 시스템 프롬프트에 합성
4. 프로젝트 MCP config 파싱 (없으면 `{}`) + 스킬 팩 MCP merge → `runtime/mcp/<run_id>.json`에 기록 (절대 경로, 0o600)
   - `runId` 검증: `/^[a-zA-Z0-9_-]+$/` 불일치 시 에러
   - 파일 write 실패 시: run을 `failed`로 마킹 + 에러 반환
5. `run_skill_packs`에 비정규화 스냅샷 기록
6. run 종료 시 MCP config 파일 cleanup (기존 worktree cleanup 패턴과 동일)

### 12.3 PM 시스템 프롬프트 수정

`managerSystemPrompt.js`에 스킬 팩 관련 추가:
- PM layer: 프로젝트 기본 스킬 목록 (이름 + 설명) + 글로벌 조회 API 안내
- `/execute` 호출 시 `skill_pack_ids` 배열 사용법 문서화
- "태스크 성격에 맞는 스킬을 선택해서 워커에 장착하라" 지시
- "글로벌 스킬 목록은 lazy 조회 — 매 턴마다 호출하지 말 것" 명시

---

## 13. UI

### 13.1 스킬 팩 관리 페이지 (새 뷰)

NavSidebar에 신규 항목 추가 (아이콘: `⚡` 또는 `🧩`).

- 스킬 팩 목록 (global / project별 필터)
- 생성/편집 폼: name, description, prompt (에디터), MCP servers (템플릿 선택 + env override), checklist, priority
- 어댑터 호환성 배지 표시
- MCP 서버 템플릿 관리 섹션 (admin)

### 13.2 프로젝트 페이지 확장

프로젝트 상세에 "Skill Packs" 섹션 추가:
- auto_apply 스킬 목록
- 바인딩 추가/제거/수정 (priority, auto_apply)
- PM reset 경고 (auto_apply 변경 시에만)

### 13.3 실행 모달 확장

Task 실행 모달에 스킬 팩 선택 UI 추가:
- 프로젝트 기본 스킬 (체크, 해제 가능)
- 글로벌 스킬 추가 검색/선택
- 토큰 예산 표시 (현재 / 캡)
- 어댑터 호환성 경고 (선택된 에이전트가 MCP 미지원이면 경고)

### 13.4 Run Inspector 확장

Run 상세 패널에 "Applied Skills" 섹션:
- 적용된 스킬 팩 목록 (**`run_skill_packs` 스냅샷에서** 읽음, live 데이터 아님)
- 체크리스트 (acceptance overlay) 읽기 전용 표시

---

## 14. Phase 계획

### Phase 1a: DB + CRUD + API (기반)
- 마이그레이션 013 (`mcp_server_templates`, `skill_packs`, 바인딩 테이블, `run_skill_packs`)
- `runtime/mcp/` 디렉토리 생성 (서버 부팅 시) + `.gitignore` 추가
- `skillPackService.js` CRUD + 바인딩 + MCP alias 해소 + env allowlist 검증
- REST API 라우트 (CRUD + 바인딩 + 소유권 검증)
- 테스트: 스키마, CRUD, 바인딩 제약, MCP 해소, env 검증

### Phase 1b: 실행 통합
- `skillPackService.resolveForRun` 구현 + 테스트
- `lifecycleService.executeTask` 통합 (Claude 워커 전용, `is_manager` 가드)
- MCP config 파일 생성/cleanup 라이프사이클
- `run_skill_packs` 비정규화 스냅샷 기록
- run 이벤트 경고 (`skill_pack:mcp_skipped`, `skill_pack:adapter_unsupported`)
- 부팅 시 orphan MCP config cleanup
- 통합 테스트: 기존 521 tests 회귀 없음 확인

### Phase 2: PM 통합 + /execute 확장
- PM 시스템 프롬프트에 스킬 팩 목록 주입
- `/execute` API에 `skill_pack_ids` 파라미터 추가
- PM이 자율적으로 스킬 선택하는 동작 검증
- excluded 최종 우선 규칙 통합 테스트

### Phase 3: UI
- 스킬 팩 관리 페이지 + MCP 템플릿 관리
- 프로젝트 바인딩 UI
- 실행 모달 스킬 선택
- Run Inspector 스킬 스냅샷 표시

### Phase 4: 고급 기능
- 토큰 예산 자동 관리 (compact 모드 자동 전환)
- MCP 충돌 감지 UI
- 스킬 팩 import/export (JSON/Markdown)
- Acceptance checklist 체크 상태 저장 (`run_acceptance_checks` 테이블)

### Phase 5: 멀티 어댑터 확장
- Codex 워커 injection 인터페이스 (`{system_prompt_file}` placeholder)
- Gemini 워커 injection 인터페이스
- `requires_capabilities` 연동

---

## 15. 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `SKILL_PACK_TOKEN_BUDGET` | `4000` | 스킬 팩 prompt overlay 총 토큰 캡 |

---

## 16. 주의사항 & 트레이드오프

1. **MCP command allowlist**: v1에서는 `mcp_server_templates`로 사전 등록된 명령만 허용. 자유 입력 MCP는 RCE 벡터이므로 의도적으로 제한. 사용자 편의 vs 보안 트레이드오프에서 보안 우선.
2. **v1 Claude 워커 전용**: 현실적으로 prompt overlay + MCP 모두 지원하는 건 Claude 워커뿐. Codex/Gemini 워커는 injection 인터페이스가 없어 Phase 5로 연기. 컨셉은 벤더 중립이지만 v1 구현은 Claude-first.
3. **PM reset 요구**: 프로젝트 기본 스킬 변경 시 PM reset이 필요한 건 UX 마찰이지만, Codex 캐싱 무효화를 방지하려면 불가피. `auto_apply` 변경 시에만 경고.
4. **Acceptance overlay v1 = 읽기 전용**: 체크 상태 저장 (`run_acceptance_checks`)은 Phase 4. v1에서는 스냅샷 표시만.
5. **skill_pack_ids가 없는 기존 /execute 호출**: 하위 호환 유지. skill_pack_ids 생략 시 프로젝트 auto_apply만 적용.
6. **pinned_by는 v1 audit-only**: PM과 user 바인딩의 행동 차이는 미정의. 단, excluded + pinned_by='user'는 PM override 불가 (Lock-in #4).
7. **prompt_hash 범위**: 각 스킬 팩별로 해당 팩의 실제 주입 텍스트(full 또는 compact)를 해시. 전체 합성 프롬프트 해시는 아님.
8. **스킬 팩 버전 관리**: v1에서는 미구현. `run_skill_packs`의 비정규화 스냅샷이 사실상 implicit version 역할. 명시적 버전 필드는 Phase 4+ 에서 스키마 변경 없이 추가 가능 (`skill_packs`에 `version INTEGER DEFAULT 1` 추가 + `run_skill_packs`에 `skill_pack_version` 추가).
