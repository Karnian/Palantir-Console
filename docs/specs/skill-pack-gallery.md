# Skill Pack Gallery & Registry — 마켓플레이스 경험 설계

> Version 1.0-rc1 | 2026-04-14
> Status: **Approved — Codex 3차 리뷰 APPROVE (P0/P1 0건)**
> 관련 문서: [skill-packs.md](./skill-packs.md), [../../CLAUDE.md](../../CLAUDE.md)
>
> v0.3 변경: Codex 2차 리뷰 P1 2건 + P2 3건 반영.
> (1) Remote preview gate: §6.2에 server-side enforcement 추가 — install 시 `source` 필드 체크 + 실질 보호는 보안 파이프라인 [P1-N1].
> (2) update route의 registry_id → localPackId lookup + 404 경로 명시 [P1-N2].
> (3) per-pack source tagging: merge 시 각 팩에 `_source` 필드 부착 [P2-N2].
> (4) OQ-1을 "Stage 2 시작 전 해결" 조건부 Resolved로 변경 [P2-N3].
> (5) query param URL encoding 주의사항 명시 [P2-N1].
>
> v0.2 변경: Codex 1차 리뷰 P0 4건 + P1 8건 + P2 주요 4건 반영.
> (1) MCP alias/env 검증을 install/update 양쪽에서 강제 [P0-1, P1-5].
> (2) prompt_full 32KB / prompt_compact 8KB 바이트 제한 + remote 팩 설치 시 preview 필수 확인 [P0-2].
> (3) Remote URL HTTPS-only 강제 [P0-3].
> (4) Route 충돌 해소: POST/PATCH는 body로 registryId 전달 [P0-4, P1-7].
> (5) Migration 번호를 실제 다음 번호로 조정 (015 존재 확인 후 결정) [P1-1].
> (6) inject_checklist를 content 필드로 명시 (업데이트 시 갱신) [P1-2].
> (7) requires_capabilities는 v1에서 informational-only 명시 [P1-3].
> (8) Name collision 시 409 구조화 응답 + scope='global' 명시 [P1-4].
> (9) stale-while-revalidate 에러 핸들링 상세화 [P1-6].
> (10) install status는 registry_id IS NOT NULL 인덱스 활용 [P1-8].
> (11) author 필드 untrusted 명시, color hex 검증, icon text-only 렌더 [P2-1,4,5].
> (12) Gallery UI 상태 (loading/error/empty) 추가 [P2-8].
> (13) merge 키 = registry_id 명시 [P2-9].

---

## TL;DR

Palantir Console의 Skill Packs에 **마켓플레이스 경험**을 추가한다. Bundled registry(오프라인) + Remote registry(GitHub raw JSON, HTTPS-only)를 통해 사용자가 카테고리 브라우징 → 미리보기 → 원클릭 설치로 Skill Pack을 획득할 수 있게 한다. 외부 서버 인프라 의존 없음.

---

## 1. Lock-in (변경하지 않는 원칙)

1. **기존 Skill Pack 워크플로 비파괴**: 수동 생성, JSON import, project/task binding 동작은 변경하지 않는다.
2. **Bundled registry는 항상 존재한다**: 네트워크 없이도 Gallery가 동작해야 한다. Remote fetch 실패 시 bundled fallback.
3. **사용자 커스터마이징 보존**: Registry에서 설치 후 사용자가 편집한 name, scope, project_id, priority, conflict_policy, bindings는 업데이트 시에도 덮어쓰지 않는다. Content 필드(prompt_full, prompt_compact, mcp_servers, checklist, inject_checklist, estimated_tokens, estimated_tokens_compact)만 갱신.
4. **Registry JSON은 flat file이다**: 단일 파일에 모든 팩의 full content 포함. v1 규모(수십 KB)에서 분할 불필요.
5. **자동 업데이트 금지**: 에이전트 프롬프트가 자동 변경되면 예측 불가. 사용자가 명시적으로 "Update" 클릭해야 한다.
6. **Registry 팩은 기존 보안 파이프라인을 통과한다**: `mcp_servers`의 alias 존재 검증, `allowed_env_keys` 검증, `ENV_HARD_DENYLIST` 검증을 install/update 양쪽에서 강제. Registry 출처라고 해서 검증을 건너뛰지 않는다.
7. **Remote registry는 HTTPS-only**: `http://` URL은 거부. MITM 방지.

---

## 2. Problem Statement

Skill Pack의 획득 경로가 **"처음부터 수동 작성" 또는 "JSON 파일 import"뿐**이다. 일반 사용자는 JSON 스키마를 모르고, 좋은 프롬프트/MCP 조합을 어떻게 만들어야 할지 모른다. 결과적으로 대부분의 설치에서 Skill Pack이 0개이며, 기능의 핵심 가치(에이전트 역량 강화)가 실현되지 못하고 있다.

VS Code Extensions나 Claude Code의 `/install` 같은 탐색-설치 경험이 필요하다.

---

## 3. Target Users

| Persona | 설명 | 핵심 니즈 |
|---------|------|----------|
| **Console Operator** | Console을 설치/운영하는 엔지니어. Skill Pack 작성 능력 있으나 시간 부족. | 검증된 팩을 빠르게 설치, 업데이트 알림 |
| **Team Member** | Console을 공유 도구로 사용하는 팀원. JSON 스키마를 모름. | 카테고리 브라우징, 원클릭 설치, 미리보기로 판단 |
| **Pack Author** | 자체 Skill Pack을 만들어 팀/커뮤니티에 공유하고 싶은 엔지니어. | export-to-registry 워크플로, 버전 관리 |

---

## 4. Goals & Non-Goals

### Goals

| ID | 목표 | 측정 기준 |
|----|------|----------|
| G1 | Gallery에서 설치까지 2클릭 이내 | Browse → Install |
| G2 | 오프라인 환경에서 완전 동작 | Bundled registry 100% 접근 가능 |
| G3 | 기존 워크플로 비파괴 | 수동 생성, JSON import, binding 동작 변경 0건 |
| G4 | 기존 테스트 100% 통과 | `npm test` 회귀 0건 |

### Non-Goals

- 사용자 인증 기반 pack publishing (v1에서는 static JSON registry만)
- Pack 평점/리뷰 시스템
- 자동 업데이트 (silent install)
- MCP 서버 템플릿의 registry 통합 (별도 관리 체계)
- Pack dependency / composition (Pack A가 Pack B를 require)
- Pack 내 코드 실행 (hook/script) — 보안 범위 밖

---

## 5. User Stories

### US-001: Gallery 브라우징

**As a** Team Member, **I want to** 카테고리별로 사용 가능한 Skill Pack을 탐색하고 싶다, **so that** JSON을 직접 작성하지 않고도 적합한 팩을 찾을 수 있다.

**Acceptance Criteria:**

- GIVEN 사용자가 `#skills` 페이지에서 Gallery 탭을 클릭했을 때
- WHEN registry 데이터가 로드 중이면
- THEN 로딩 스피너가 표시된다

- GIVEN registry 데이터가 로드 완료되었을 때
- WHEN 팩 목록이 1개 이상이면
- THEN 모든 사용 가능한 팩이 카드 형태로 표시된다
- AND 각 카드에 name, icon (text content로 렌더, innerHTML 금지), description, category, estimated_tokens가 표시된다
- AND 이미 설치된 팩은 "Installed" 배지가 표시된다
- AND 업데이트 가능한 팩은 "Update Available" 배지가 표시된다

- GIVEN registry 로드가 실패했을 때
- THEN "Failed to load registry" 에러 메시지 + "Retry" 버튼이 표시된다

- GIVEN Gallery가 로드되었을 때
- WHEN 카테고리 필터를 선택하면
- THEN 해당 카테고리의 팩만 표시된다

- GIVEN Gallery가 로드되었을 때
- WHEN 검색 입력란에 텍스트를 입력하면
- THEN name 또는 description에 해당 문자열이 포함된 팩만 표시된다 (case-insensitive, 200ms debounce)

- GIVEN 검색/필터 결과가 0건일 때
- THEN "No packs found" empty state가 표시된다

- GIVEN 모든 registry 팩이 이미 설치되었을 때
- THEN "All packs installed" 메시지가 표시된다 (empty state와 구분)

### US-002: Pack 미리보기

**As a** Console Operator, **I want to** 팩의 상세 정보를 미리볼 수 있다, **so that** 프롬프트 내용, MCP 서버 구성, 체크리스트를 보고 설치 여부를 판단할 수 있다.

**Acceptance Criteria:**

- GIVEN Gallery에서 팩 카드를 클릭했을 때
- WHEN 상세 패널이 열리면
- THEN 다음 정보가 표시된다:
  - name, description, icon, color (hex 검증 통과한 값만 적용, 아니면 무시), category
  - author (untrusted display text — 접근 제어 의미 없음)
  - prompt_full (접기/펼치기, 기본 접힌 상태)
  - mcp_servers 목록 (alias + 설명)
  - checklist 항목 목록
  - estimated_tokens (full / compact)
  - registry_version
  - requires_capabilities (informational-only, v1에서 enforcement 없음)
- AND "Install" 버튼이 하단에 표시된다
- AND 이미 설치된 경우 "Installed (v1.0.0)" + "Uninstall" 표시

### US-003: 원클릭 설치

**As a** Team Member, **I want to** "Install" 버튼 하나로 로컬 DB에 저장하고 싶다, **so that** 즉시 프로젝트/태스크에 바인딩해서 사용할 수 있다.

**Acceptance Criteria:**

- GIVEN Gallery 상세 패널에서 미설치 팩을 보고 있을 때
- WHEN "Install" 버튼을 클릭하면
- THEN `POST /api/skill-packs/registry/install` (body에 `{ registry_id }` 전달)을 호출한다
- AND 서버에서 보안 검증 파이프라인(§6.2) 전체를 수행한다
- AND 검증 통과 시 skill_packs 테이블에 `scope='global'`로 삽입된다 (registry_id, registry_version 함께 저장)
- AND Gallery 카드 배지가 "Installed"로 변경
- AND toast 알림 표시

- GIVEN remote registry 출처의 팩(`_source: "remote"`)을 설치하려 할 때
- WHEN UI에서 Install을 시도하면
- THEN preview 모달이 먼저 열리고, 사용자가 prompt 내용을 확인 후 "Confirm Install"을 클릭해야 설치 진행
- AND API 호출 시 body에 `confirmed_preview: true` 플래그가 포함된다
- AND 서버에서 remote 출처 팩에 대해 `confirmed_preview: true`가 없으면 400 거부 (server-side enforcement)
- NOTE: 실질적 보호는 §6.2 보안 파이프라인(MCP 검증 + prompt 크기 제한)이 담당. `confirmed_preview`는 UI bypass 방지를 위한 추가 방어선

- GIVEN 동일 registry_id 팩이 이미 설치되어 있을 때
- WHEN "Install"을 다시 클릭하면
- THEN "Already installed" toast 표시 (중복 방지)

- GIVEN 동일 name의 팩이 이미 존재할 때 (수동 생성 등)
- WHEN "Install"을 클릭하면
- THEN 409 응답 + "A skill pack named 'X' already exists. Rename the existing pack before installing." toast 표시

- GIVEN MCP alias 검증 실패 시 (registry가 참조하는 alias가 로컬 mcp_server_templates에 없음)
- WHEN 설치를 시도하면
- THEN 400 응답 + "Unknown MCP server alias: 'X'. Install the MCP template first." toast 표시

### US-004: 설치된 팩 업데이트

**As a** Console Operator, **I want to** registry에 새 버전이 올라왔을 때 기존 설치를 갱신하고 싶다, **so that** 개선된 프롬프트/체크리스트를 적용할 수 있다.

**Acceptance Criteria:**

- GIVEN 설치된 팩의 registry_version이 registry 최신과 다를 때
- WHEN Gallery에서 해당 팩 카드를 보면
- THEN "Update Available (v1.0.0 → v1.1.0)" 배지 표시

- GIVEN 업데이트 가능한 팩의 상세 패널에서
- WHEN "Update" 버튼을 클릭하면
- THEN 서버에서 MCP alias/env 검증 + prompt 바이트 제한 검증을 수행한다
- AND 검증 통과 시 기존 row의 **content 필드** 갱신: prompt_full, prompt_compact, mcp_servers, checklist, inject_checklist, estimated_tokens, estimated_tokens_compact
- AND registry_version 최신으로 갱신
- AND **사용자 설정 필드** 보존: name, scope, project_id, priority, conflict_policy
- AND 기존 project/task binding 영향 없음

### US-005: Bundled Registry (오프라인)

**As a** Console Operator (air-gapped 환경), **I want to** 서버 내장 curated 팩 목록을 Gallery에서 볼 수 있다, **so that** 네트워크 없이도 Skill Pack을 활용할 수 있다.

**Acceptance Criteria:**

- GIVEN 서버 시작 시
- WHEN `server/data/skill-pack-registry.json` 파일이 존재하면
- THEN registryService가 해당 파일을 메모리에 로드

- GIVEN 네트워크가 없을 때
- WHEN `GET /api/skill-packs/registry`를 호출하면
- THEN bundled registry의 팩 목록이 `source: "bundled"`와 함께 응답

### US-006: Remote Registry (GitHub)

**As a** Console Operator, **I want to** GitHub raw URL에서 registry를 가져오고 싶다, **so that** 서버 재배포 없이 새로운 팩을 받을 수 있다.

**Acceptance Criteria:**

- GIVEN `SKILL_PACK_REGISTRY_URL` 환경변수가 설정되어 있을 때
- WHEN URL이 `https://`로 시작하지 않으면
- THEN 서버 시작 시 `[registry] Rejected non-HTTPS registry URL` 경고 로그 + bundled fallback

- GIVEN 유효한 HTTPS URL이 설정되어 있을 때
- WHEN 서버가 시작되면
- THEN remote registry fetch 시도 (timeout: 5초)
- AND 성공 시 메모리 캐시 + `source: "remote"`
- AND 실패 시 bundled fallback + `[registry] Remote fetch failed, using bundled fallback` 로그

- GIVEN remote registry가 캐시되어 있을 때
- WHEN 캐시 TTL (기본 1시간) 만료 시
- THEN 다음 `GET /api/skill-packs/registry` 호출에서 stale 데이터를 즉시 반환하면서 백그라운드 re-fetch 시작
- AND `isFetching` 플래그로 동시 re-fetch 방지 (최대 1개)
- AND re-fetch 실패 시 stale 캐시 유지 + `lastFetchedAt`을 `now - (TTL - 60s)`로 설정 (60초 후 재시도)
- AND JSON.parse 실패 시 (truncated response 등) stale 캐시 유지 + 에러 로그

- GIVEN remote fetch 성공 시
- WHEN bundled에만 존재하는 팩이 있으면
- THEN 최종 목록에 merge (merge 키: `registry_id`. 동일 registry_id는 remote 우선, bundled-only 팩은 보존)
- AND 각 팩에 `_source` 필드를 부착: remote에서 온 팩은 `"remote"`, bundled에서만 존재하는 팩은 `"bundled"`
- AND `_source` 필드는 preview gate (US-003) 및 install route의 `confirmed_preview` 판단에 사용

### US-007: 기존 Import 보존

**As a** Pack Author, **I want to** 기존 파일 picker import가 그대로 동작하기를 원한다, **so that** 기존 워크플로가 깨지지 않는다.

**Acceptance Criteria:**

- GIVEN `#skills` 페이지에서 "Import" 버튼 클릭 시
- THEN 기존과 동일한 파일 picker 열림
- AND JSON 파일 선택 시 `POST /api/skill-packs/import` 전송
- AND registry 필드(registry_id, registry_version)는 null로 저장 (수동 import 구분)

---

## 6. Technical Architecture

### 6.1 Registry Index Schema (`skill-pack-registry.json`)

```json
{
  "version": "1",
  "updated_at": "2026-04-14T00:00:00Z",
  "categories": [
    { "id": "code-quality", "name": "Code Quality", "icon": "✦" },
    { "id": "testing", "name": "Testing", "icon": "✓" },
    { "id": "security", "name": "Security", "icon": "🛡" },
    { "id": "devops", "name": "DevOps", "icon": "⚙" },
    { "id": "documentation", "name": "Documentation", "icon": "📝" },
    { "id": "frontend", "name": "Frontend", "icon": "◧" },
    { "id": "backend", "name": "Backend", "icon": "◨" },
    { "id": "general", "name": "General", "icon": "◉" }
  ],
  "packs": [
    {
      "registry_id": "core/accessibility-expert",
      "registry_version": "1.0.0",
      "name": "Accessibility Expert",
      "description": "WCAG 2.2 AA compliance checks for all UI changes",
      "category": "frontend",
      "author": "palantir-console",
      "icon": "♿",
      "color": "#6fd4a0",
      "prompt_full": "...",
      "prompt_compact": "...",
      "mcp_servers": {},
      "checklist": ["Screen reader tested", "Color contrast >= 4.5:1"],
      "inject_checklist": true,
      "conflict_policy": "warn",
      "requires_capabilities": [],
      "priority": 100
    }
  ]
}
```

핵심 설계 결정:
- `registry_id`: `namespace/slug` 형태. Registry 내 primary key. namespace는 `core/` (official) 또는 `community/` (커뮤니티).
- `registry_version`: semver string. v1에서는 단순 string `!==` 비교 (같은지 다른지만 판별). v2에서 semver 파싱 도입 검토.
- `author`: **untrusted display text**. 접근 제어 의미 없음. UI에서 그대로 표시.
- `color`: 설치 시 `/^#[0-9a-fA-F]{3,8}$/` 검증. 실패 시 무시 (null 저장).
- `icon`: UI에서 반드시 **text content로 렌더** (innerHTML 금지). XSS 방지.
- `requires_capabilities`: v1에서 **informational-only**. UI에 표시만 하고 enforcement 없음. 유효 값 vocabulary와 enforcement는 Phase 5+ 에서 정의.
- Flat file. 단일 파일에 모든 팩의 full content 포함.

### 6.2 보안 검증 파이프라인 (install/update 공통)

Registry에서 팩을 설치하거나 업데이트할 때 **기존 skill-packs.md의 보안 파이프라인을 동일하게 적용**:

```
1. prompt_full 바이트 크기 ≤ 32KB (Buffer.byteLength)
2. prompt_compact 바이트 크기 ≤ 8KB
3. mcp_servers의 각 alias → mcp_server_templates 테이블에 존재 확인
4. mcp_servers의 env_overrides 각 키 →
   a. 해당 alias의 allowed_env_keys 목록에 포함 확인 (Tier 1)
   b. ENV_HARD_DENYLIST_PATTERNS 매칭 시 거부 (Tier 2)
5. checklist JSON 배열 검증 (기존 validateChecklist)
6. color hex 패턴 검증 (/^#[0-9a-fA-F]{3,8}$/)
```

검증 실패 시 400 응답 + 구체적 에러 메시지. **Registry 출처라고 해서 검증을 건너뛰지 않는다.**

### 6.3 DB 스키마 변경

**Migration 번호**: 현재 디스크에 존재하는 마지막 migration 번호 + 1로 결정. 015가 이미 존재하면 016, 아니면 적절한 번호 사용. (구현 시점에 확인)

```sql
ALTER TABLE skill_packs ADD COLUMN registry_id TEXT;
ALTER TABLE skill_packs ADD COLUMN registry_version TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_pack_registry_id
  ON skill_packs(registry_id) WHERE registry_id IS NOT NULL;
```

### 6.4 서비스 계층

#### `registryService.js` (신규)

```
책임:
- bundled registry JSON 로드 (서버 시작 시 1회)
- remote registry fetch + 메모리 캐시 (HTTPS-only, TTL 기반)
- bundled + remote merge (merge 키: registry_id, remote 우선, bundled-only 보존)
- 설치 상태 비교

메서드:
- getRegistry()                    → { source, categories, packs }
- getRegistryPack(registryId)      → pack | null
- refreshRemoteRegistry()          → Promise<void>

캐시 전략:
- 메모리 내 object + lastFetchedAt timestamp
- TTL 만료 시 stale-while-revalidate (stale 즉시 반환 + 백그라운드 re-fetch)
- isFetching boolean으로 동시 re-fetch 방지
- re-fetch 실패 시 stale 유지 + lastFetchedAt = now - (TTL - 60s)
- JSON.parse 실패 시 stale 유지 + 에러 로그
- URL 검증: https:// 아니면 거부 + bundled fallback

merge 결과 후처리:
- 각 팩에 `_source` 필드를 동적으로 부착 (static JSON 파일에는 없음)
- remote에서 온 팩 → `_source: "remote"`, bundled에서만 존재하는 팩 → `_source: "bundled"`
```

#### `skillPackService.js` 추가 메서드

```
- installFromRegistry(registryPack) → skill_pack row
  - 보안 검증 파이프라인 (§6.2) 전체 적용
  - scope='global'로 삽입
  - name collision 시 409 + 구조화 에러 메시지
  - registry_id collision 시 409 + "Already installed"

- updateFromRegistry(localPackId, registryPack) → skill_pack row
  - 보안 검증 파이프라인 (§6.2) 전체 적용
  - content 필드만 갱신, 사용자 설정 보존 (§1 Lock-in #3)

- findByRegistryId(registryId) → skill_pack | null
```

### 6.5 API 라우트

| Method | Path | Body | 설명 |
|--------|------|------|------|
| `GET` | `/api/skill-packs/registry` | — | Registry 목록 + install status |
| `GET` | `/api/skill-packs/registry/pack?id=<registryId>` | — | 단일 registry 팩 상세 |
| `POST` | `/api/skill-packs/registry/install` | `{ registry_id, confirmed_preview? }` | Registry에서 설치 |
| `POST` | `/api/skill-packs/registry/update` | `{ registry_id }` | 설치된 팩을 최신으로 갱신 |
| `POST` | `/api/skill-packs/registry/refresh` | — | Remote registry 수동 새로고침 |

**변경 사항 (v0.2)**: POST/PATCH에서 URL wildcard param `/:registryId(*)` 사용을 폐기. `registry_id`에 `/`가 포함되므로 Express 5 wildcard 호환성 이슈를 회피하기 위해 **body로 전달**. GET 단건 조회는 query parameter (`?id=`) 사용. Route 충돌 문제 (refresh vs :registryId) 완전 해소.

**주의**: `registry_id`에 `/`가 포함되므로 GET query param 사용 시 클라이언트에서 `encodeURIComponent(registryId)` 필수. 예: `?id=core%2Faccessibility-expert`.

**install route 상세**:
- `confirmed_preview` 필드: remote 출처 팩(`_source: "remote"`)에 대해 필수. 누락 시 400 거부.
- bundled 출처 팩에는 불필요 (신뢰할 수 있는 source).

**update route 상세**:
- route handler가 `findByRegistryId(registry_id)` 호출
- 결과 없으면 404 + `"No installed pack found for registry_id: 'X'"`
- 결과 있으면 `updateFromRegistry(localPack.id, registryPack)` 호출

**install status 조회** (GET /api/skill-packs/registry 응답 시):
- route handler가 `skill_packs WHERE registry_id IS NOT NULL` 쿼리 (partial unique index 활용, 소량)
- 결과를 `Map<registry_id, { localVersion, localId }>` 로 구성
- registry 팩 목록과 대조하여 `installed` / `updateAvailable` 플래그 부착

### 6.6 프론트엔드 구조

`#skills` 페이지 내부에 **탭 기반** 추가:

```
[My Packs] [Gallery]
```

- **My Packs 탭**: 현재 SkillPacksView.js 그대로
- **Gallery 탭**: 신규 `GalleryView.js` + `PackPreviewModal.js`

#### Gallery UI 상태

| 상태 | 표시 |
|------|------|
| Loading | 스피너 |
| Error | "Failed to load registry" + Retry 버튼 |
| Empty (검색/필터 결과 0건) | "No packs found" |
| All installed | "All packs installed" 메시지 |
| Normal | 카드 그리드 |

#### Remote 팩 설치 확인 흐름

Remote registry 출처 팩의 경우, Install 버튼 클릭 시 **반드시 preview 모달을 거쳐** prompt 내용을 확인한 후 "Confirm Install"을 클릭해야 설치가 진행된다. Bundled 팩은 신뢰할 수 있으므로 preview 없이 직접 설치 가능.

### 6.7 파일 목록

| 파일 | 유형 |
|------|------|
| `server/data/skill-pack-registry.json` | Bundled registry |
| `server/services/registryService.js` | Registry 서비스 |
| `server/routes/skillPacks.js` | 기존 + registry 엔드포인트 추가 |
| `server/db/migrations/NNN_skill_pack_registry.sql` | registry_id, registry_version |
| `server/public/app/components/GalleryView.js` | Gallery UI |
| `server/public/app/components/PackPreviewModal.js` | 미리보기 모달 |
| `server/public/app/components/SkillPacksView.js` | 탭 분기 추가 |
| `server/public/styles.css` | Gallery 스타일 |
| `server/tests/registry.test.js` | 테스트 |

### 6.8 Bundled Registry 초기 팩 (8개)

| registry_id | Category | 설명 |
|-------------|----------|------|
| `core/code-review` | Code Quality | 코드 리뷰 체크리스트 + 품질 기준 |
| `core/testing-expert` | Testing | TDD 가이드라인 + 테스트 커버리지 체크리스트 |
| `core/security-audit` | Security | OWASP Top 10 기반 보안 점검 |
| `core/accessibility` | Frontend | WCAG 2.2 AA 접근성 전문가 |
| `core/documentation` | Documentation | 문서화 기준 + JSDoc/README 체크리스트 |
| `core/performance` | Code Quality | 성능 최적화 관점 리뷰 |
| `core/playwright-testing` | Testing | Playwright MCP + E2E 테스트 가이드 |
| `core/git-discipline` | DevOps | 커밋 메시지 규칙 + 브랜치 전략 |

---

## 7. Stage 분할

### Stage 1: Bundled Registry + Gallery UI

- Migration NNN (registry_id, registry_version)
- `server/data/skill-pack-registry.json` (8+ curated 팩)
- `registryService.js` (bundled-only, remote 부분은 stub)
- 보안 검증 파이프라인 (§6.2)
- Registry API (GET, install, update)
- `GalleryView.js` + `PackPreviewModal.js`
- `SkillPacksView.js` 탭 분기
- `registry.test.js`

### Stage 2: Remote Registry + Polish

- Remote fetch + cache + merge 로직 (HTTPS-only)
- `SKILL_PACK_REGISTRY_URL` 환경변수
- `POST /api/skill-packs/registry/refresh` API
- Gallery에 source 표시 (bundled / remote)
- Stale-while-revalidate + isFetching guard
- Remote 팩 설치 시 preview 필수 확인 흐름
- Network failure / TTL / merge / HTTPS 검증 테스트

---

## 8. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Registry JSON 비대화 (100+ 팩) | Low | v1 수십 KB. 필요 시 페이지네이션 |
| Remote URL 변경/삭제 | Medium | Bundled fallback 항상 존재 |
| 설치 후 편집 → 업데이트 시 충돌 | Medium | Content만 갱신, 사용자 설정 보존 |
| Malicious remote registry (prompt injection) | High | HTTPS-only + 보안 파이프라인 + prompt 크기 제한 + remote 팩 preview 필수 |
| Name collision (수동 팩과 registry 팩) | Medium | 409 구조화 응답 + 사용자 안내 메시지 |
| MCP alias가 로컬에 없는 registry 팩 | Medium | Install 시 alias 존재 검증, 실패 시 400 + 안내 |

---

## 9. Open Questions

| # | 질문 | 권장안 | 상태 |
|---|------|--------|------|
| OQ-1 | Remote registry default URL 하드코딩 여부 | 하드코딩 + `SKILL_PACK_REGISTRY_URL` override | **Conditionally Resolved** — Stage 2 시작 전 URL 확정 필요 |
| OQ-2 | Gallery를 `#skills` 내부 탭 vs 별도 `#gallery` | 내부 탭 권장 | **Resolved** (v0.2) |
| OQ-3 | 초기 bundled 팩 프롬프트 작성 주체 | Claude 초안 → 사용자 검수 | Open |
| OQ-4 | Stage 1/2 별도 PR 여부 | 별도 PR 권장 | Open |
| OQ-5 | 수동 편집 감지 v1 구현 여부 | v1 생략, version 불일치만 표시 | **Resolved** (v0.2, 생략) |
| OQ-6 | Semver 파싱 도입 시점 | v1 string !==, v2 semver 파싱 | **Resolved** (v0.2) |

---

## 10. Review Log

### Round 3 — Codex (v0.3 → v1.0-rc1) **APPROVED**

**P0/P1 Fix 검증**: Round 2의 P1-N1, P1-N2 모두 ✅ 확인. P0/P1 신규 0건.

**P3 반영 1건:**
- [P3-N1] `_source` 필드가 merge 시 동적 부착됨을 §6.4 registryService에 명시 (static JSON에는 없음)

**VERDICT: APPROVE** — 설계 수렴 완료. Stage 1 구현 진행 가능.

### Round 2 — Codex (v0.2 → v0.3)

**P0/P1 Fix 검증**: Round 1의 P0 4건 + P1 8건 모두 ✅ 확인.

**P1 신규 수정 2건:**
- [P1-N1] Remote preview gate server-side enforcement: install route에 `confirmed_preview` 필드 추가. remote 출처 팩에 대해 누락 시 400 거부. 실질 보호는 §6.2 파이프라인이 담당.
- [P1-N2] update route lookup 경로 명시: `findByRegistryId` → 없으면 404, 있으면 `updateFromRegistry(localPack.id, registryPack)`.

**P2 반영 3건:**
- [P2-N1] GET query param의 `registry_id` URL encoding (`encodeURIComponent`) 주의사항 명시
- [P2-N2] merge 시 per-pack `_source` 필드 부착 — preview gate 판단에 사용
- [P2-N3] OQ-1을 "Stage 2 시작 전 해결" 조건부 Resolved로 변경

### Round 1 — Codex (v0.1 → v0.2)

**P0 수정 4건:**
- [P0-1] MCP alias/env 검증을 install/update에서 강제 → §6.2 보안 검증 파이프라인 신설, Lock-in #6 추가
- [P0-2] prompt injection 방어: prompt_full 32KB / prompt_compact 8KB 제한 + remote 팩 preview 필수 확인
- [P0-3] Remote URL HTTPS-only 강제 → Lock-in #7 추가, US-006 수정
- [P0-4] Route 충돌: POST/PATCH를 body 기반으로 변경 → §6.5 전면 재설계

**P1 수정 8건:**
- [P1-1] Migration 번호를 구현 시점에 결정하도록 변경 (NNN placeholder)
- [P1-2] inject_checklist를 content 필드로 명시 → US-004, Lock-in #3 수정
- [P1-3] requires_capabilities를 informational-only로 명시
- [P1-4] Name collision 시 409 구조화 응답 + scope='global' 명시
- [P1-5] updateFromRegistry에서도 MCP 검증 강제 (P0-1과 통합)
- [P1-6] stale-while-revalidate 에러 핸들링 상세화 (isFetching, retry 타이밍)
- [P1-7] Express wildcard 회피: body/query param으로 전환 (P0-4와 통합)
- [P1-8] install status 조회를 registry_id IS NOT NULL partial index 활용으로 변경

**P2 반영 4건:**
- [P2-1] author untrusted display text 명시
- [P2-4] color hex 검증
- [P2-5] icon text-only 렌더 명시
- [P2-8] Gallery UI 상태 (loading/error/empty/all-installed) 추가
- [P2-9] merge 키 = registry_id 명시
