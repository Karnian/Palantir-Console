# Skill Packs — Agent-Agnostic Capability Injection

> Version 0.1 | 2026-04-13
> Status: **Draft — cross-review pending.**
> 관련 문서: [manager-v3-multilayer.md](./manager-v3-multilayer.md), [../../CLAUDE.md](../../CLAUDE.md)

---

## TL;DR

Palantir Console이 **에이전트 종속 없이** 스킬/플러그인을 중앙 관리하고, 워커 spawn 시 해당 에이전트의 주입 경로에 맞게 자동 적용하는 시스템.

핵심 가치:
- **벤더 중립**: 동일한 스킬 팩이 Claude, Codex, Gemini 워커에 모두 적용됨
- **설치 불필요**: 스킬이 Palantir Console DB에 저장되어 로컬 설치 의존 없음
- **3계층 활용**: PM이 태스크 성격에 맞는 스킬을 자율 선택해서 워커에 장착

---

## 1. Lock-in (변경하지 않는 원칙)

1. **스킬 팩은 3개의 독립 plane으로 분해된다**: prompt overlay / tooling overlay / acceptance overlay. 각 plane은 별도 병합 규칙을 가진다.
2. **적용된 스킬은 run 시작 시 스냅샷으로 고정된다**: run 실행 중 스킬 팩이 변경되어도 진행 중인 run에는 영향 없음. 재현성과 디버깅을 보장.
3. **어댑터 호환성은 명시적이다**: 각 스킬 팩의 어떤 plane이 어떤 에이전트에서 유효한지 UI에서 표시. silent ignore 금지.

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
- `injection_position`: `prepend` | `append` (기본: `append`)
- `estimated_tokens`: 저장 시 자동 계산 (대략 word count × 1.3)

### 2.2 Tooling Overlay

MCP 서버 설정. 에이전트에게 외부 도구 접근 권한을 부여.

```json
{
  "playwright": {
    "command": "npx",
    "args": ["@anthropic-ai/mcp-playwright"],
    "lifecycle": "agent"
  }
}
```

- 어댑터별 호환성: Claude 워커만 `--mcp-config` 지원. Codex/Gemini는 이 plane 무시됨 → UI에 `"prompt-only on Codex"` 표시.
- MCP config 파일은 `runtime/mcp/<run_id>.json`에 생성, run 종료 시 삭제.
- 서버 부팅 시 고아 파일 정리: active run이 없는 `runtime/mcp/*.json` 삭제.

### 2.3 Acceptance Overlay

완료 기준 체크리스트. 에이전트 프롬프트에는 주입되지 않고, Console UI에서 PM/사용자가 결과 검증 시 사용.

```json
["접근성 검사 통과", "스크린리더 테스트 완료", "색상 대비 4.5:1 이상"]
```

- 프롬프트 비대화 방지: 체크리스트는 기본적으로 프롬프트에 포함하지 않음
- `inject_checklist`: `true`로 설정하면 프롬프트 끝에 "완료 전 다음을 확인해라:" 형태로 주입 가능

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
| `project` | FK | 해당 프로젝트 전용. 같은 name의 global 팩을 shadow |

### 3.2 바인딩 계층

**프로젝트 바인딩** (`project_skill_packs`):
- `auto_apply = true`: 해당 프로젝트의 모든 워커에 자동 적용
- `auto_apply = false`: 프로젝트 기본 목록에 노출되지만 수동 선택 필요

**태스크 바인딩** (`task_skill_packs`):
- PM 또는 사용자가 태스크에 명시적으로 스킬 팩을 핀/제외
- `pinned_by`: `pm` | `user` — 누가 바인딩했는지 추적
- `excluded`: `true`면 auto_apply 스킬이라도 이 태스크에서 제외

### 3.3 PM의 스킬 팩 접근

PM 시스템 프롬프트에는:
- 프로젝트에 바인딩된 기본 스킬 팩 목록 (이름 + 한 줄 설명)
- "글로벌 스킬 팩은 `GET /api/skill-packs` 로 조회 가능" 안내

PM은 `/execute` 호출 시 `skill_pack_ids` 배열을 포함해 워커에 장착할 스킬을 지정.
생략 시 프로젝트 auto_apply 스킬만 적용.

---

## 4. 병합 규칙 (다중 스킬 팩 합성)

워커에 여러 스킬 팩이 적용될 때의 병합 순서:

```
1. Agent Profile 기본 설정 (baseline)
2. 프로젝트 auto_apply 스킬 팩 (priority 순)
3. 태스크에 핀된 스킬 팩 (priority 순)
4. 태스크 실행 프롬프트 (사용자/PM 지시)
```

### 4.1 Prompt Overlay 병합

- priority 오름차순으로 연결 (priority 1이 먼저, 가장 높은 priority가 태스크 지시에 가장 가까움)
- 각 팩 사이에 `--- Skill: {name} ---` 구분자 삽입
- `injection_position`별 분리: `prepend` 팩들은 프로젝트 brief 앞에, `append` 팩들은 뒤에

최종 프롬프트 구성:
```
[에이전트 빌트인 시스템 프롬프트]
[prepend 스킬 팩들, priority 순]
[project_brief: conventions + pitfalls]
[append 스킬 팩들, priority 순]
[태스크 실행 프롬프트]
```

### 4.2 Tooling Overlay 병합

- MCP 서버는 alias(key)로 union
- 같은 alias에 다른 config → `conflict_policy` 적용:
  - `fail` (기본): 워커 spawn 차단 + 에러 메시지
  - `warn`: 높은 priority 팩의 config 사용 + 경고 로그
- 결과물을 단일 MCP config JSON으로 합성 → `runtime/mcp/<run_id>.json`에 기록

### 4.3 Acceptance Overlay 병합

- 모든 팩의 체크리스트를 연결
- 정확한 문자열 중복 제거
- 순서: priority 오름차순

---

## 5. 토큰 예산 관리

프롬프트 비대화 방지를 위한 가드레일.

- 각 스킬 팩 저장 시 `estimated_tokens` 자동 계산
- 런타임 캡: `SKILL_PACK_TOKEN_BUDGET` 환경변수 (기본: 4000)
- 총합이 캡 초과 시:
  1. `prompt_compact`가 있는 팩은 compact 버전으로 교체
  2. 여전히 초과 시 spawn 차단 + 에러: "Skill pack token budget exceeded (N/4000). Remove packs or use compact mode."
- PM 시스템 프롬프트에는 프로젝트 스킬 팩의 compact 요약만 포함 (Codex 캐싱 보호)

---

## 6. 어댑터별 호환성

| Plane | Claude (stream-json) | Codex (`codex exec`) | Gemini / 기타 |
|-------|---------------------|---------------------|---------------|
| Prompt Overlay | `--append-system-prompt` | `model_instructions_file`에 합성 | `args_template`의 시스템 프롬프트 경로 |
| Tooling Overlay (MCP) | `--mcp-config` ✅ | 미지원 ❌ (silent ignore) | 미지원 ❌ |
| Acceptance Overlay | Console UI only | Console UI only | Console UI only |

### 6.1 호환성 표시

스킬 팩 UI에 어댑터별 지원 배지 표시:
- `✅ Full` — prompt + MCP 모두 적용
- `📝 Prompt-only` — prompt만 적용, MCP 무시됨
- UI 색상: full = green, prompt-only = yellow

### 6.2 Codex/Gemini MCP 지원 시 확장

`codexAdapter.js`에 `mcpConfig` 무시 주석이 이미 있음 (line 165-167).
Codex CLI가 MCP를 지원하면 해당 분기만 열면 됨 — 스킬 팩 스키마 변경 없음.

---

## 7. Run 스냅샷

워커 spawn 시점에 적용된 스킬 팩 상태를 `run_skill_packs` 테이블에 기록.

| 필드 | 용도 |
|------|------|
| `run_id` | FK → runs |
| `skill_pack_id` | 적용된 스킬 팩 |
| `prompt_hash` | 실제 주입된 프롬프트의 SHA-256 (변경 감지) |
| `mcp_config_path` | 생성된 MCP config 파일 경로 (cleanup 용) |
| `applied_mode` | `full` \| `compact` |
| `applied_at` | 적용 시각 |

이 스냅샷으로:
- run 시점에 어떤 스킬이 적용되었는지 추적 가능
- 스킬 팩이 나중에 수정/삭제되어도 기록 유지
- MCP config 파일의 orphan cleanup 가능

---

## 8. PM 프롬프트 캐싱과의 상호작용

Codex PM의 `model_instructions_file`은 안정적 내용 → `cached_input_tokens` 히트가 핵심.

**원칙**: 프로젝트 기본 스킬 팩 변경 시 PM reset 필수.

- PM 시스템 프롬프트에는 프로젝트 auto_apply 스킬의 **이름 + 한 줄 설명 목록**만 포함 (full prompt 아님)
- PM이 워커를 spawn할 때 스킬 팩의 full prompt를 워커에 주입하는 것이지, PM 자신이 읽는 게 아님
- 프로젝트 기본 스킬 목록이 바뀌면 → PM system prompt가 바뀜 → 캐싱 무효화 → PM reset 경고 UI 표시

---

## 9. 기존 시스템과의 경계

| 시스템 | 역할 | 스킬 팩과의 관계 |
|--------|------|-----------------|
| `agent_profiles.capabilities_json` | 에이전트가 **할 수 있는 것** (supply-side) | 읽기 전용. 스킬 팩이 수정하지 않음 |
| `tasks.requires_capabilities` | 태스크가 **필요로 하는 것** (demand-side) | 스킬 팩이 capability 요구사항을 추가할 수 있음 |
| `project_briefs` (conventions/pitfalls) | 프로젝트 컨벤션과 알려진 함정 | 유지. 스킬 팩과 별도 layer. 프롬프트 주입 순서에서 스킬 팩 사이에 위치 |
| `projects.mcp_config_path` | 프로젝트 전역 MCP 설정 | 유지. 스킬 팩 MCP와 merge됨 (프로젝트 MCP가 base, 스킬 팩이 additive) |

---

## 10. 데이터 모델

### 10.1 신규 테이블

```sql
-- 스킬 팩 정의
CREATE TABLE skill_packs (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  description          TEXT,
  scope                TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','project')),
  project_id           TEXT REFERENCES projects(id) ON DELETE CASCADE,
  icon                 TEXT,
  color                TEXT,
  -- Prompt Overlay
  prompt_full          TEXT,
  prompt_compact       TEXT,
  injection_position   TEXT NOT NULL DEFAULT 'append' CHECK(injection_position IN ('prepend','append')),
  estimated_tokens     INTEGER DEFAULT 0,
  -- Tooling Overlay
  mcp_servers          TEXT,          -- JSON: { "alias": { command, args, env?, lifecycle? } }
  conflict_policy      TEXT NOT NULL DEFAULT 'fail' CHECK(conflict_policy IN ('fail','warn')),
  -- Acceptance Overlay
  checklist            TEXT,          -- JSON array of strings
  inject_checklist     INTEGER NOT NULL DEFAULT 0,
  -- Meta
  priority             INTEGER NOT NULL DEFAULT 100,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  -- Constraints
  CHECK (scope = 'global' OR project_id IS NOT NULL),
  CHECK (scope = 'project' OR project_id IS NULL)
);

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
  pinned_by            TEXT CHECK(pinned_by IN ('pm','user')),
  excluded             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, skill_pack_id)
);

-- Run 스냅샷
CREATE TABLE run_skill_packs (
  run_id               TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  skill_pack_id        TEXT NOT NULL REFERENCES skill_packs(id) ON DELETE SET NULL,
  prompt_hash          TEXT,
  mcp_config_path      TEXT,
  applied_mode         TEXT CHECK(applied_mode IN ('full','compact')),
  applied_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, skill_pack_id)
);
```

### 10.2 마이그레이션

`server/db/migrations/013_skill_packs.sql` (012 다음 번호)

---

## 11. API

### Skill Packs CRUD
```
GET    /api/skill-packs                — 목록 (?scope=global|project&project_id=)
POST   /api/skill-packs                — 생성
GET    /api/skill-packs/:id            — 조회
PATCH  /api/skill-packs/:id            — 수정
DELETE /api/skill-packs/:id            — 삭제
```

### 프로젝트 바인딩
```
GET    /api/projects/:id/skill-packs           — 프로젝트에 바인딩된 스킬 팩 목록
POST   /api/projects/:id/skill-packs           — 바인딩 추가 { skill_pack_id, priority?, auto_apply? }
DELETE /api/projects/:id/skill-packs/:packId   — 바인딩 제거
```

### 태스크 바인딩
```
GET    /api/tasks/:id/skill-packs              — 태스크에 바인딩된 스킬 팩 목록
POST   /api/tasks/:id/skill-packs              — 바인딩 추가/제외 { skill_pack_id, priority?, excluded? }
DELETE /api/tasks/:id/skill-packs/:packId      — 바인딩 제거
```

### Run 스냅샷
```
GET    /api/runs/:id/skill-packs               — 이 run에 적용된 스킬 팩 스냅샷
```

### Execute 확장
```
POST   /api/tasks/:id/execute
  기존: { agent_profile_id, prompt? }
  확장: { agent_profile_id, prompt?, skill_pack_ids? }
```

`skill_pack_ids`가 명시되면 해당 스킬 팩 + 프로젝트 auto_apply 스킬을 합산.
생략 시 프로젝트 auto_apply 스킬만 적용.

---

## 12. 서비스 레이어

### 12.1 `skillPackService.js` (신규)

- CRUD: `createSkillPack`, `getSkillPack`, `listSkillPacks`, `updateSkillPack`, `deleteSkillPack`
- 바인딩: `bindToProject`, `unbindFromProject`, `bindToTask`, `unbindFromTask`
- **`resolveForRun(taskId, explicitPackIds?)`**: 실행 시점의 effective 스킬 세트 계산
  1. 프로젝트 auto_apply 팩 수집
  2. 태스크 excluded 팩 제거
  3. 태스크 pinned 팩 추가
  4. explicitPackIds가 있으면 추가
  5. priority 정렬
  6. 토큰 예산 확인 → 초과 시 compact 모드 전환 또는 에러
  7. MCP 충돌 검사
  8. 반환: `{ promptSections[], mcpConfig, checklist[], appliedPacks[] }`

### 12.2 `lifecycleService.js` 수정

`executeTask` 경로에 스킬 팩 해소 추가:
1. `skillPackService.resolveForRun(taskId, skill_pack_ids)` 호출
2. prompt overlay를 에이전트 시스템 프롬프트에 합성
3. MCP config를 `runtime/mcp/<run_id>.json`에 기록 (프로젝트 MCP와 merge)
4. `run_skill_packs`에 스냅샷 기록
5. run 종료 시 MCP config 파일 cleanup

### 12.3 PM 시스템 프롬프트 수정

`managerSystemPrompt.js`에 스킬 팩 관련 추가:
- PM layer: 프로젝트 기본 스킬 목록 (이름 + 설명) + 글로벌 조회 API 안내
- `/execute` 호출 시 `skill_pack_ids` 배열 사용법 문서화
- "태스크 성격에 맞는 스킬을 선택해서 워커에 장착하라" 지시

---

## 13. UI

### 13.1 스킬 팩 관리 페이지 (새 뷰)

NavSidebar에 신규 항목 추가 (아이콘: `⚡` 또는 `🧩`).

- 스킬 팩 목록 (global / project별 필터)
- 생성/편집 폼: name, description, prompt (에디터), MCP servers (JSON 에디터), checklist, priority
- 어댑터 호환성 배지 표시
- 프로젝트별 바인딩 관리

### 13.2 프로젝트 페이지 확장

프로젝트 상세에 "Skill Packs" 섹션 추가:
- auto_apply 스킬 목록
- 바인딩 추가/제거
- PM reset 경고 (auto_apply 변경 시)

### 13.3 실행 모달 확장

Task 실행 모달에 스킬 팩 선택 UI 추가:
- 프로젝트 기본 스킬 (체크, 해제 가능)
- 글로벌 스킬 추가 검색/선택
- 토큰 예산 표시 (현재 / 캡)
- 어댑터 호환성 경고

### 13.4 Run Inspector 확장

Run 상세 패널에 "Applied Skills" 섹션:
- 적용된 스킬 팩 목록
- 체크리스트 (acceptance overlay) 체크 UI

---

## 14. Phase 계획

### Phase 1: 기반 (DB + Service + API)
- 마이그레이션 013
- `skillPackService.js` CRUD + `resolveForRun`
- REST API 라우트
- `lifecycleService.executeTask` 통합
- 테스트

### Phase 2: PM 통합
- PM 시스템 프롬프트에 스킬 팩 목록 주입
- `/execute` API에 `skill_pack_ids` 파라미터 추가
- PM이 자율적으로 스킬 선택하는 동작 검증

### Phase 3: UI
- 스킬 팩 관리 페이지
- 프로젝트 바인딩 UI
- 실행 모달 스킬 선택
- Run Inspector 스킬 표시

### Phase 4: 고급 기능
- 토큰 예산 자동 관리 (compact 모드 자동 전환)
- MCP 충돌 감지 UI
- 스킬 팩 import/export (JSON/Markdown)
- 스킬 팩 버전 관리 (선택적)

---

## 15. 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `SKILL_PACK_TOKEN_BUDGET` | `4000` | 스킬 팩 prompt overlay 총 토큰 캡 |

---

## 16. 주의사항 & 트레이드오프

1. **MCP JSON blob vs 정규화 테이블**: v1은 JSON blob으로 시작. 충돌 감지는 서비스 레이어에서 JSON 파싱으로 처리. 운영 데이터가 쌓인 후 정규화 여부 결정.
2. **PM reset 요구**: 프로젝트 기본 스킬 변경 시 PM reset이 필요한 건 UX 마찰이지만, Codex 캐싱 무효화를 방지하려면 불가피. UI에서 명확히 경고.
3. **Acceptance overlay의 자동 검증**: v1에서는 수동 체크만. 자동 검증 (테스트 실행 등)은 후속 고려.
4. **skill_pack_ids가 없는 기존 /execute 호출**: 하위 호환 유지. skill_pack_ids 생략 시 프로젝트 auto_apply만 적용.
