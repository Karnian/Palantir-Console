# Skill Pack Gallery v1.1 — Install from URL

> Version 1.1 | Draft 2026-04-14 → **Final (locked in 2026-04-24)**
> Status: **Final — locked in 2026-04-24 (R1 spec ↔ implementation lock-in PR)**
> Supersedes: [skill-pack-gallery.md](./skill-pack-gallery.md) §Stage 2 only. Stage 1 (Bundled Registry + Gallery UI) remains unchanged.
> 관련 문서: [skill-packs.md](./skill-packs.md), [../../CLAUDE.md](../../CLAUDE.md)

> **Lock-in 이후 변경 규칙**: 이 문서는 R1 lock-in 시점의 실구현을 정규 명세로 고정한다. 이후 spec 변경은 반드시 (1) 새 PR 에서 code + spec + test 를 함께 변경, (2) Review Log 에 새 Round 를 추가, (3) PR 리뷰에서 이 문서를 참조하는 방식으로만 수행한다. `source_url` / 보안 파이프라인 / preview token / origin_type 을 건드리는 변경은 보안 리뷰어 승인 필수.

---

## TL;DR

v1.0-rc1 Stage 2는 **중앙 URL 기반 remote registry** (서버 운영자가 `SKILL_PACK_REGISTRY_URL` env로 한 개의 큐레이션 URL 지정)로 설계됐다. 이 문서는 이를 **per-pack URL install** (사용자가 웹에서 찾은 팩 JSON의 URL을 UI에 붙여넣어 즉시 설치) 방식으로 대체한다. Claude Code의 `/install <url>`, VS Code `Install from VSIX` 와 같은 패턴.

**핵심 동기**: Palantir Console은 1인/팀-단위 localhost 운영이 주 use case. 중앙 큐레이션 registry는 overkill이고, 사용자가 ad-hoc으로 여러 출처의 팩을 쓰는 편이 실용적. 동시에 per-pack URL은 **SSRF 벡터**가 되므로 중앙 registry보다 **더 강한 서버측 방어**가 필요하다.

---

## 1. Lock-in (변경하지 않는 원칙)

v1.0-rc1 §1의 Lock-in 중 유지되는 것과 변경되는 것을 분리 명시한다.

### 유지 (v1.0 → v1.1)

1. **기존 Skill Pack 워크플로 비파괴**: 수동 생성, JSON import, project/task binding 동작은 변경하지 않는다.
2. **Bundled registry는 항상 존재한다**: 네트워크 없이도 Gallery가 동작해야 한다. Bundled 8개 팩이 default discovery surface.
3. **사용자 커스터마이징 보존**: URL에서 설치 후 사용자가 편집한 name, scope, project_id, priority, conflict_policy, bindings는 업데이트 시에도 덮어쓰지 않는다. Content 필드만 갱신.
4. **Registry JSON은 flat file이다**: 단일 JSON 파일에 팩 내용 포함 (bundled의 `packs[]` 배열 한 개 팩과 같은 스키마).
5. **자동 업데이트 금지**: 에이전트 프롬프트가 자동 변경되면 예측 불가. 사용자가 명시적으로 "Check for update" → "Update" 클릭해야 한다.
6. **보안 파이프라인은 install/update 양쪽에 적용**: §6.2의 모든 단계는 bundled/URL 무관하게 일관 적용.

### 신설 (v1.1)

7. **URL install은 SSRF-safe**: HTTPS-only + redirect 후 재검증 + private/loopback/link-local/metadata 차단 + 응답 크기 캡 + **연결 시 validated IP 로 직접 pin** (in-process `lookup` hook 으로 hostname 재-resolve 차단). Preview 확인은 UX 방어선일 뿐 보안 boundary가 아니다.
8. **URL install 팩은 출처를 기록한다**: 설치된 팩에 canonicalized `source_url`, `source_hash`, `source_fetched_at`, `origin_type` 을 함께 persist. "Check for update"는 이 필드를 기준으로 동작.
9. **Origin type 은 명시적이다**: 신규 `origin_type` 컬럼 (`'bundled' | 'url' | 'manual' | 'import'`) 으로 출처를 구분한다. `source_url IS NULL` 을 "bundled" 로 추론하지 않는다.
10. **Server-authoritative fetch**: 서버는 클라이언트가 전송한 pack content/hash 를 **절대 신뢰하지 않는다**. 모든 install/update 경로에서 서버가 직접 URL 을 fetch + hash + validate 한다. `expected_hash` 는 오직 preview → confirm 사이의 TOCTOU 방어 용도로만 비교된다.

### 폐기 (v1.0 → v1.1)

- ~~Lock-in #2 (v1.0): Remote fetch 실패 시 bundled fallback~~ — 더 이상 central remote fetch가 없음
- ~~Lock-in #7 (v1.0): Remote registry는 HTTPS-only~~ — per-URL HTTPS 강제로 흡수됨 (Lock-in #7 신설)

---

## 2. Problem Statement

v1.0-rc1 Stage 2의 문제:

1. **Over-engineering for solo deployment**: 중앙 URL, TTL 캐시, stale-while-revalidate, merge 로직은 멀티 사용자/팀 동기화 문제를 푸는 도구. 1인 localhost 운영에서는 bundled + JSON import 로 커버 가능한 scope.
2. **OQ-1 (default URL 확정)이 blocker**: 무엇을 default로 할지 합의가 없음. 고정 URL 없이 설치하려면 결국 per-URL install이 필요.
3. **Ad-hoc 출처 접근성 부족**: 사용자가 GitHub gist, blog 첨부, 팀 위키에 있는 팩을 쓰려면 다운로드 → Import 파일 pick의 2-step 과정 필요.

---

## 3. Target Users

v1.0 §3 동일. Pack Author persona의 **"export-to-registry"** 표현을 **"publish JSON to any HTTPS URL (GitHub raw, gist, self-hosted)"**로 바꿔 해석한다.

---

## 4. Goals & Non-Goals

### Goals (v1.0 대비 변경점)

| ID | 목표 | 측정 기준 |
|----|------|----------|
| G1 | URL 입력 → 설치까지 3클릭 이내 | Install from URL → Preview → Install |
| G2 | 오프라인 환경에서 완전 동작 | Bundled registry 100% 접근 (URL install은 network 필요) |
| G3 | 기존 워크플로 비파괴 | 수동 생성, JSON import, binding, Stage 1 Gallery 동작 변경 0건 |
| G4 | 기존 테스트 100% 통과 | `npm test` 회귀 0건 |
| G5 (신규) | SSRF 차단 | 서버가 loopback/private IP fetch 시도 시 무조건 거부 |
| G6 (신규) | 출처 추적 | URL-installed 팩에 source_url + content hash 저장 |

### Non-Goals

v1.0 §4 동일 + 추가:

- **중앙 큐레이션 registry**: v1.1 스코프 밖. v2+ 에서 "Featured Packs" surface로 재검토 가능.
- **TLS pinning / cert chain custom validation**: Node fetch 기본값 사용. 사내 CA는 별도 환경변수로만 노출 (Non-Goal in v1.1).
- **Pack signing / author verification**: 출처 URL과 content hash만 기록. Cryptographic signing은 v2+.
- **자동 refresh / polling**: 사용자가 명시 클릭해야 update check.

---

## 5. User Stories

### US-001~005 (Browse / Preview / Install from Bundled / Uninstall / Offline)
**v1.0-rc1 §5 US-001~005 및 US-007 전부 변경 없이 유지.** Stage 1 Gallery + Bundled registry 동작 그대로.

### US-006 (대체됨): 중앙 Remote Registry
**v1.0 정의 폐기.** 대체 스토리 US-008.

### US-008 (신규): URL로 팩 설치

**As a** Console Operator, **I want to** 웹에서 찾은 팩 JSON의 URL을 UI에 붙여넣어 설치하고 싶다, **so that** GitHub raw JSON, gist, 팀 위키 첨부 등 어떤 출처든 즉시 쓸 수 있다.

**Acceptance Criteria:**

- GIVEN Gallery 탭에서
- WHEN "Install from URL" 버튼을 클릭하면
- THEN URL 입력 다이얼로그가 열린다 (https:// 만 허용, http:// 입력은 클라이언트 단에서 경고)

- GIVEN URL 입력 후 "Fetch" 클릭 시
- WHEN 서버가 `POST /api/skill-packs/registry/install-url` 의 dry-run 모드를 호출 (body: `{ url, dry_run: true }`)
- THEN 서버가 §6.2 SSRF 방어 + fetch + schema validation 을 수행
- AND 성공 시 응답에 `{ pack, hash, preview_token }` 반환 (§6.5 와 동일 필드명)
- AND 클라가 `PackPreviewModal` 을 fetched 내용으로 연다

- GIVEN preview 에서 "Confirm Install" 클릭 시
- WHEN 클라가 `POST /api/skill-packs/registry/install-url` 를 `{ url, preview_token: <dry-run의 preview_token>, expected_hash: <dry-run의 hash> }` 로 호출
- THEN 서버가 preview_token 검증 (§6.5) + URL을 다시 fetch (TOCTOU 방어) 하고 hash 가 `expected_hash` 와 일치하는지 검증
- AND 불일치 시 409 + "Source content changed since preview" 에러
- AND 일치 시 §6.2 security pipeline 통과 후 `skill_packs` 테이블에 `scope='global'` + `source_url` + `source_hash` + `source_fetched_at` 과 함께 삽입
- AND Gallery 에 토스트 알림

- GIVEN SSRF 차단 대상 URL 입력 시 (loopback, private IP, link-local 등)
- WHEN 서버가 fetch 전 검증에서 거부
- THEN 400 + `"URL rejected by SSRF policy: <reason>"` 응답

- GIVEN 응답 크기가 256KB 를 초과할 때
- THEN 서버가 스트림을 중단하고 413 + `"Response exceeds 256KB limit"` 응답

- GIVEN 기존 `source_url` 이 동일한 팩이 이미 설치되어 있을 때
- WHEN URL install 을 다시 시도하면
- THEN 409 + `"Already installed from this URL"` 응답 (중복 방지)

### US-009 (신규): URL 팩 업데이트 확인 / 적용

**As a** Console Operator, **I want to** 이전에 URL 로 설치한 팩의 원본이 변경됐는지 확인하고 갱신하고 싶다.

**Acceptance Criteria:**

- GIVEN My Packs 에서 `source_url IS NOT NULL` 인 팩 카드 hover 시
- THEN "Check for update" 버튼이 노출된다

- GIVEN "Check for update" 클릭 시
- WHEN 클라가 `POST /api/skill-packs/registry/check-update-url` body `{ pack_id }` 호출
- THEN 서버가 팩의 `source_url` 을 fetch (SSRF 방어 동일 적용) → content hash 계산
- AND 현재 `source_hash` 와 비교
- AND 다르면 `{ update_available: true, new_hash, fetched_at }` 반환 + UI 에 "Update Available" 배지
- AND 같으면 `{ update_available: false }` 반환 + "Up to date" 토스트

- GIVEN "Update" 클릭 시
- WHEN 클라가 `POST /api/skill-packs/registry/update-url` body `{ pack_id, preview_token, expected_hash }` 호출
- THEN 서버가 preview_token 검증 + 재-fetch → hash 재검증 → §6.2 security pipeline → content 필드 갱신
- AND 사용자 편집 필드 (name/scope/project_id/priority/conflict_policy) 보존
- AND `source_hash`, `source_fetched_at` 갱신

- GIVEN 업데이트 검증 실패 시 (e.g. 새 content 가 prompt_full > 32KB)
- THEN 400 + 구체적 오류, 기존 설치 내용은 변경되지 않음 (fail-atomic)

### US-010 (신규): Origin Type 표시

**As a** Console Operator, **I want to** 설치된 팩의 출처를 명확히 알고 싶다 (bundled / URL-installed / 수동 생성 / JSON import).

**Acceptance Criteria:**

- My Packs 카드에 `origin_type` 기반 배지:
  - `origin_type='bundled'` → `Bundled` (+ `registry_id` tooltip)
  - `origin_type='url'` → `URL: <host>` (+ `source_url_display` (query/fragment 제거된 host+path) hover tooltip — full `source_url` 렌더 금지)
  - `origin_type='manual'` → `Manual` (기본 배지)
  - `origin_type='import'` → `Imported` (파일 import 경로)
- 팩 상세/Edit 모달에 URL 팩의 경우 `source_url_display`, `source_fetched_at`, `source_hash` (앞 8자 truncated) 표시. `source_url` (query string 포함) 은 API response 에도 포함하지 않음 (server-only).
- Bundled 와 Manual 은 서로 다른 배지 — `source_url IS NULL` 로 "bundled" 추론 금지 (Lock-in #9).

---

## 6. Technical Architecture

### 6.1 Registry Pack JSON Schema (unchanged from v1.0 §6.1)

URL로 호스팅되는 JSON은 **단일 팩 객체** (bundled registry 의 `packs[]` 원소와 동일 스키마):

```json
{
  "registry_id": "community/my-custom-pack",
  "registry_version": "1.0.0",
  "name": "My Custom Pack",
  "description": "...",
  "category": "general",
  "author": "alice@example.com",
  "icon": "◉",
  "color": "#6c8eef",
  "prompt_full": "...",
  "prompt_compact": "...",
  "mcp_servers": {},
  "checklist": [],
  "inject_checklist": true,
  "conflict_policy": "warn",
  "requires_capabilities": [],
  "priority": 100
}
```

**주의**: `registry_id` 는 URL 팩에서 optional. 있으면 fine, 없으면 서버가 `name` 을 기반으로 `url/<slug>` 형태로 synthesize 하지 않고 `registry_id IS NULL` 로 저장 (고유성은 `source_url` UNIQUE 인덱스로 강제).

**대안**: URL 팩이 `registry_id` 를 가지고 있고 그 값이 bundled 와 충돌하면 409 로 거부 (네임스페이스 오염 방지).

### 6.2 보안 검증 파이프라인 (강화)

**모든 팩 install/update 경로 (bundled + URL) 공통 단계 (v1.0 §6.2 유지)**:

1. `prompt_full` ≤ 32KB (Buffer.byteLength)
2. `prompt_compact` ≤ 8KB
3. `mcp_servers` 각 alias → `mcp_server_templates` 존재 확인
4. `mcp_servers` env_overrides → per-template allowlist + global hard denylist
5. `checklist` JSON 배열 검증
6. `color` hex 검증 — 실패 시 **reject** (v1.0-rc1 의 null 정상화는 이미 수정됨)

**URL install 추가 단계 (Stage 2 신설, fetch 이전 ~ parse 이전)**:

Step 0a (canonicalize URL — fetch 이전 필수 단계):
- `URL.canParse()` 통과
- scheme === `https:` 강제. `http:`/`file:`/`gopher:`/`ftp:`/`data:` 등 기타 거부.
- `url.username` / `url.password` 존재 시 거부 (`https://user:pass@host/...` 금지)
- hostname 소문자 + punycode/IDN → ASCII 정규화 (`URL` 객체가 자동 처리)
- **Trailing dot 제거**: `example.com.` → `example.com` (DNS root label normalization — 같은 리소스가 서로 다른 canonical URL 로 저장되는 것 방지)
- fragment (`#...`) 제거
- port 정책: **명시적 port 는 443 만 허용** (v1.1). 비표준 HTTPS 포트는 v2+ 에서 별도 OQ.
- **Default-port elision**: port 가 443 또는 명시 생략 시 canonical 형태에서 port 부분 제거 (`https://host:443/path` → `https://host/path`). Unique index / redirect 비교 / token 바인딩 모두 이 canonical 문자열 기준.
- query string 은 fetch 시에는 그대로 사용 (signed URL / access token 지원).

**Query string secret 처리 (R3-P1-2)**:
- Canonical URL 을 두 형태로 분리 저장:
  - `source_url` (internal, DB persist): query string 포함 **전체** canonical URL. Fetch 재시도 및 unique 제약 용도. **UI 로 절대 노출하지 않는다.**
  - `source_url_display` (derived, 비-persist 또는 별도 컬럼): `https://<host><pathname>` (query/fragment 제거). UI 툴팁, 카드 배지, 로그에 사용.
- DB 로그 / audit 에는 `source_url_display` 만 기록. 필요 시 `source_url_hash` (source_url 의 SHA-256) 로 상호 참조.
- Unique index 는 `source_url` (full) 에 걸되, UI 는 절대 full URL 을 렌더하지 않음.
- 민감 query 감지 heuristic (optional, v1.1 에는 포함): `token=`, `key=`, `secret=`, `sig=`, `access_token=` 등의 param name 발견 시 `source_url_display` 뿐 아니라 audit log 에서도 param value 를 `***` 로 마스킹.

Step 0b (pre-fetch IP validation):
- hostname resolve (DNS lookup, `family: 0` 로 A/AAAA 둘 다) → 모든 resolved IP 에 대해 차단 집합 체크:
  - IPv4: loopback (127.0.0.0/8), RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254.0.0/16), CGNAT (100.64.0.0/10), 0.0.0.0, broadcast (255.255.255.255)
  - IPv6: `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), `::` unspecified, IPv4-mapped private 범위 (`::ffff:10.x.x.x` 등)
  - 호스트명이 `.local` / `.internal` / `localhost` / 메타데이터 hostname (`metadata.google.internal`, `metadata` 등) → 거부
  - IP literal (`169.254.169.254` 등) 도 동일 차단 집합 재검사
- 여러 IP 반환 시 **모두** 통과해야 함 (한 개라도 차단 범위면 reject) — DNS rebinding 1차 방어.
- 통과 후 **선택된 한 개의 validated IP 를 pinned_ip 로 기록**.

Step 1 (fetch with pinned IP — normative, 구현 강제):
- HTTP client 가 hostname 재-resolve 를 하지 못하도록 **connection 레벨 pin**:
  - Node.js `https.Agent({ lookup: (hostname, opts, cb) => cb(null, pinned_ip, family) })` 또는
  - 직접 `tls.connect({ host: pinned_ip, servername: original_hostname })` (TLS SNI/cert validation 은 원래 hostname 기준).
  - `Host:` 헤더는 원래 hostname 유지.
- 구현이 위 pin 을 제공할 수 없으면 **Node fetch 사용 금지** → outbound proxy (smokescreen 등) 경유 필수. (OQ-v1.1-7 재오픈 조건).
- `timeout`: 5초
- `redirect: 'manual'` — 자동 redirect 절대 금지. 최대 3 hop 수동 처리, **매 hop 마다 Step 0a+0b 전체 재실행**.
- `maxResponseSize`: 256KB. Content-Length 헤더 우선 체크, 스트림 중 누적 크기 초과 시 abort.
- `Accept: application/json` 헤더 요청.

Step 2 (parse + schema sanity):
- Content-Type 이 `application/json` 또는 `text/plain` (gist 대비) 만 허용. 다른 타입은 400.
- `JSON.parse` 실패 → 400.
- 결과 객체의 필수 필드 (`name`, `prompt_full`) 검증.

Step 3: content hash (SHA-256) 계산 + 반환/저장.

**검증 실패 시**: 기존 설치 팩에 영향 없음 (fail-atomic). 구체적 오류 메시지 + HTTP 상태로 응답.

### 6.3 DB 스키마 변경

**Migration 017_skill_pack_source_url.sql** (shipped):

```sql
-- URL install provenance + explicit origin typing
ALTER TABLE skill_packs ADD COLUMN source_url TEXT;            -- full canonical URL (query included), server-only, never rendered in UI
ALTER TABLE skill_packs ADD COLUMN source_url_display TEXT;    -- query/fragment stripped canonical, safe to render in UI/logs
ALTER TABLE skill_packs ADD COLUMN source_hash TEXT;           -- SHA-256 hex of fetched bytes
ALTER TABLE skill_packs ADD COLUMN source_fetched_at TEXT;     -- ISO8601
ALTER TABLE skill_packs ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'manual';

-- Lossy reclassification: rows whose registry_id starts with 'core/' or 'community/'
-- are promoted to origin_type = 'bundled'. All other pre-existing rows remain 'manual'.
UPDATE skill_packs
SET origin_type = 'bundled'
WHERE (registry_id LIKE 'core/%' OR registry_id LIKE 'community/%')
  AND source_url IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_pack_source_url
  ON skill_packs(source_url) WHERE source_url IS NOT NULL;
```

**Migration 021_skill_pack_origin_type_check.sql** (R1 2026-04-24 lock-in followup):

Migration 017 cannot attach a `CHECK (origin_type IN (...))` to a column added via `ALTER TABLE` without a full table rebuild. 021 enforces the enum via BEFORE INSERT/UPDATE triggers that `RAISE(ABORT, ...)` on any value outside `{ bundled, url, manual, import }`. This is the DB-layer enforcement Lock-in #9 promises — the CHECK-via-trigger shape is an implementation detail; any rejection semantics (bad INSERT aborts with a clear error) match the CHECK spec exactly.

```sql
CREATE TRIGGER trg_skill_packs_origin_type_insert_check
  BEFORE INSERT ON skill_packs
  WHEN NEW.origin_type NOT IN ('bundled','url','manual','import')
BEGIN SELECT RAISE(ABORT, 'origin_type must be one of: bundled, url, manual, import'); END;
-- symmetric trigger for BEFORE UPDATE OF origin_type
```

**기존 row 마이그레이션 (lossy — 역사적 정확도 불가, shipped as migration 017 `UPDATE ...` above)**:
- v1.0 / pre-v1.1 에는 `origin_type` 컬럼이 없었고, bundled install 과 import 경로 모두 `registry_id` 를 가질 수 있어 **registry_id 만으로 두 출처를 구분할 수 없다**.
- 구현된 규칙 (migration 017 UPDATE): `registry_id LIKE 'core/%' OR registry_id LIKE 'community/%'` + `source_url IS NULL` 인 row 를 `'bundled'` 로 승격. 그 외 pre-existing row 는 `'manual'` (default) 로 남음.
- **lossy 구간**: v1.0 경로에서 `core/` / `community/` prefix 없이 bundled 로 들어간 row 가 있다면 `'manual'` 로 남아 오분류됨. 사용자는 편집 UI 에서 origin 을 재분류하거나, bundled registry 로부터 재-install 할 수 있다.
- JSON import 경로는 신규 팩 생성 시 `origin_type = 'import'` 로 저장 (routes/skillPacks.js 의 `POST /api/skill-packs/import` 에서 강제).
- 모든 origin_type 추론 로직은 이 lossy 전환을 가정해야 한다.

**server-only 컬럼** (security):
- `source_url` 은 query string 포함 전체 canonical URL 을 저장. API response / UI / 로그 어디에도 절대 렌더되지 않음 — `routes/skillPacks.js` 의 `sanitizePack()` 가 모든 응답에서 strip 한다. Unique index + server-side re-fetch 전용.
- `source_url_display` 는 `https://<host><pathname>` (query/fragment 제거) 만 저장 — UI 카드 배지, 툴팁, 로그, preview modal 의 provenance 섹션, install/check-update response 페이로드에 사용.

Partial unique index 로 URL 중복 방지 (비-URL 팩은 `source_url IS NULL` 이라 영향 없음).

### 6.4 서비스 계층 변경

**`registryService.js`**:

- 유지: `getRegistry`, `getRegistryPack` (bundled-only)
- 신규: `fetchPackFromUrl(rawUrl)` → `Promise<{ canonicalUrl, displayUrl, pack, hash }>`
  - Step 0~3 전체 수행 (SSRF 방어, fetch, parse, hash)
  - 예외 시 status+code 부착된 Error (`ssrf_blocked` / `timeout` / `too_large` / `invalid_json` / `invalid_scheme` / `invalid_port` / `userinfo_forbidden` / `dns_failed` / `too_many_redirects` / `upstream_error` / `invalid_content_type` / `invalid_redirect` / `fetch_failed` / `invalid_url` / `invalid_schema`)
- 신규: `issuePreviewToken(bindingKey, hash)` / `consumePreviewToken(token, expectedBindingKey, expectedHash)` — in-memory 24-byte hex, TTL 5분, LRU 1000, 1-shot consume. `bindingKey` 는 `"url:<canonicalUrl>"` 또는 `"pack:<packId>"`.
- 보존된 stub: `refreshRemoteRegistry()` — v1.0 중앙 registry API 의 deprecated no-op. `{ refreshed: false, reason: 'deprecated_in_v1_1' }` 반환. 신규 작성 금지, 기존 API back-compat 용. (§6.5 참조)

**`skillPackService.js` 확장**:

> **Server-authoritative 계약 (Lock-in #10)**: URL 경로 메서드는 클라이언트로부터 pack content/hash 를 **받지 않는다**. 클라 요청은 `{ url }` 또는 `{ pack_id, preview_token, expected_hash }` 만 포함한다. route 레이어가 `registryService.fetchPackFromUrl` 을 호출해서 server-authoritative 로 fetch + canonicalize + hash 하고, service 메서드는 이미 검증된 `{ canonicalUrl, displayUrl, pack, hash, expected_hash }` 를 받는다.

- 신규: `installFromUrl({ canonicalUrl, displayUrl, pack, hash, expected_hash, bundledRegistryIds })`
  - fetched hash 가 `expected_hash` 와 불일치 → 409 `"Source content changed since preview"`
  - `source_url` 중복 체크 → 409 `"Already installed from this URL"`
  - `registry_id` 가 bundled catalog 에 있거나 이미 설치된 등록 ID 와 충돌 → 409 (OQ-v1.1-4)
  - name collision (global scope) → 409
  - §6.2 content validation pipeline (`validateRegistryPack`) — prompt 크기, MCP alias/env allowlist, checklist 배열, color hex
  - `scope='global'` + `origin_type='url'` + `source_url` / `source_url_display` / `source_hash` / `source_fetched_at` 저장
- 신규: `updateFromUrl({ pack_id, pack, hash, expected_hash })`
  - 기존 row 조회 → `origin_type='url'` 검증 (아니면 400)
  - expected_hash 검증 → content 필드만 갱신 (`prompt_full`, `prompt_compact`, `estimated_tokens*`, `mcp_servers`, `checklist`, `inject_checklist`, `registry_version`, `requires_capabilities`)
  - 사용자 편집 필드 보존: `name`, `scope`, `project_id`, `priority`, `conflict_policy`, `icon`, `color`, `description`
  - 바인딩 보존: `project_skill_packs` / `task_skill_packs` 는 별도 테이블이라 영향 없음
  - `source_hash`, `source_fetched_at`, `updated_at` 갱신
- 신규: `findBySourceUrl(canonicalUrl)` → skill_pack | null
- 유지: v1.0 의 `installFromRegistry` / `updateFromRegistry` (bundled 용)

> **Check-update 동작**: service 에 `checkUpdateFromUrl` 전용 메서드는 두지 않는다. 대신 route 가 `registryService.fetchPackFromUrl(existing.source_url)` 을 직접 호출하여 hash 를 비교하고 preview_token 을 발급한다 (§6.5). 이는 service 가 persist 동작만 담당한다는 계층 분리 원칙 때문.

### 6.5 API 라우트 변경

**변경 없음**:
- `GET /api/skill-packs/registry` (bundled + install status)
- `GET /api/skill-packs/registry/pack?id=<registryId>`
- `POST /api/skill-packs/registry/install` (bundled 전용)
- `POST /api/skill-packs/registry/update` (bundled 전용)

**Deprecated stub (shipped, not removed)**:
- `POST /api/skill-packs/registry/refresh` — v1.0 중앙 registry refresh 를 위한 엔드포인트. v1.1 에서는 기능이 없어졌지만 back-compat 를 위해 no-op stub 로 보존됨. Response: `{ refreshed: false, reason: 'deprecated_in_v1_1' }`. 새로운 클라이언트는 호출하지 말 것. 미래 버전에서 제거 가능 (breaking change 로 명시 필요).

**신규**:

| Method | Path | Body | 설명 |
|--------|------|------|------|
| `POST` | `/api/skill-packs/registry/install-url` | `{ url, dry_run?, preview_token?, expected_hash? }` | URL로 팩 설치 (dry-run or confirm) |
| `POST` | `/api/skill-packs/registry/check-update-url` | `{ pack_id }` | 설치된 URL 팩의 원본 변경 여부 확인 (preview_token 발급) |
| `POST` | `/api/skill-packs/registry/update-url` | `{ pack_id, preview_token, expected_hash }` | URL 팩 갱신 (preview_token 필수) |

**Preview Token 계약** (shipped in `registryService.js`):
- dry-run (install-url) 또는 check-update-url 응답에 서버가 `preview_token` 을 포함한다.
- Token shape: `crypto.randomBytes(24).toString('hex')` (48 hex chars). Server-side ephemeral store (in-memory `Map`, TTL 5분, LRU cap 1000 entries, 만료 prune 은 발급/소비 시점에 lazy).
- Binding: `"url:<canonicalUrl>"` 또는 `"pack:<pack_id>"` + fetched hash. Confirm 시 caller 가 `expected_hash` 를 보내고 서버 `consumePreviewToken(token, expectedBindingKey, expectedHash)` 이 store 의 `(bindingKey, hash)` 와 완전 일치하는지 검증.
- **1-shot consume — validation-success only**: `consumePreviewToken` 은 (1) token 없거나 문자열 아님 → 400 w/o mutating store, (2) token 이 store 에 없음 (만료 / 재사용) → 400 w/o mutating store, (3) binding/hash 불일치 → 400 w/o mutating store, (4) 완전 일치 → `store.delete(token)` 후 리턴. 즉 오직 완전 일치한 검증 1회만 token 을 소비한다.
- 재사용 공격 표면은 binding 이 `(canonicalUrl, hash)` 또는 `(pack_id, hash)` 에 tied 되어 있다는 것으로 제한됨 — 공격자가 hash 를 맞게 건네주지 않으면 검증 실패 (그러나 token 은 살아남음). hash 를 맞게 건네려면 서버가 방금 fetch 한 실제 content 를 알아야 하므로 외부 공격자에겐 의미 없는 side-channel. 만료 / 1회용 / TTL 5분이 실용적 방어.
- **UI bypass 방지**: preview 를 건너뛰고 confirm 을 직접 호출하면 token 미발급 → 400.

> **관측**: 오늘 구현은 "검증 성공 시에만 consume" 이다. 미래에 "검증 실패도 consume (fail-closed) 으로 강화" 하려면 `consumePreviewToken` 의 step 3 분기에서 `previewTokens.delete(token)` 을 먼저 수행하고 throw 하도록 바꾸면 된다. 본 spec 은 shipped 동작을 정답으로 고정.

**`install-url` 동작** (shipped):

1. `dry_run: true` 모드:
   - §6.2 Step 0~3 전체 수행 (server-authoritative fetch → canonicalize → pin → fetch → parse → hash)
   - `preview_token` 발급 + store 에 기록 (키: `"url:<canonicalUrl>"`, hash 와 함께)
   - DB 저장 없음
   - 응답: `{ pack, hash, preview_token, source_url_display }`
2. 실제 install 모드 (`dry_run` false or omitted):
   - `preview_token` + `expected_hash` 필수 → 누락 시 400
   - §6.2 Step 0~3 재수행 (route 가 먼저 fetch — canonicalUrl 을 얻어야 token binding 키를 만들 수 있기 때문, 그리고 TOCTOU 재방어)
   - Token 검증 (`consumePreviewToken`): store 의 `("url:<canonicalUrl>", expected_hash)` 와 일치 → 토큰 소비 + 진행 / 불일치 → 400, 토큰 미소비
   - service `installFromUrl` 호출 → 재계산된 hash 가 `expected_hash` 와 불일치하면 409 `"Source content changed since preview"` (이 시점에 token 은 이미 소비된 상태)
   - §6.2 content validation (`validateRegistryPack`) → 409 collision 체크 (source_url / bundled registry_id / name) → DB insert

**`check-update-url` 동작** (shipped):

- `pack_id` 로 skill_pack row 조회 → `origin_type != 'url'` 또는 `source_url IS NULL` 이면 400 `"Not a URL-installed pack"`
- 저장된 `source_url` 로 `fetchPackFromUrl` 재호출 (§6.2 전체)
- `preview_token` 발급 (키: `"pack:<pack_id>"`, 새 hash 와 함께)
- 응답: `{ update_available, new_hash, new_pack_preview, fetched_at, source_url_display, preview_token }`
  - `update_available = (new_hash !== row.source_hash)`
  - `fetched_at` 는 ISO8601 현재 시각 (server-side)

**`update-url` 동작** (shipped):

- 필수: `{ pack_id, preview_token, expected_hash }` — 셋 중 하나라도 없으면 400
- `pack_id` 조회 → `origin_type='url'` 검증 → 저장된 `source_url` 재-fetch (§6.2 전체, TOCTOU 재방어)
- `preview_token` 검증 (`consumePreviewToken(preview_token, "pack:<pack_id>", expected_hash)`) → 완전 일치 시 토큰 소비 + 진행 / 불일치 시 400 (토큰 미소비)
- service `updateFromUrl` 호출 → 재계산된 hash 가 `expected_hash` 와 일치하는지 검증 (TOCTOU 2차) → 409 on mismatch → content 필드만 갱신, 사용자 편집 필드 (name/scope/project_id/priority/conflict_policy) 보존

**응답 sanitization**: 모든 skill_pack API response 는 `source_url` (query 포함 full URL) 을 strip 한다 (`sanitizePack()` in `routes/skillPacks.js`). 클라이언트에 노출되는 것은 `source_url_display` 뿐.

### 6.6 프론트엔드 구조 변경 (shipped)

`GalleryView.js`:

- 우상단에 **"Install from URL"** 버튼 추가 (existing bundled card grid 는 유지)
- 클릭 시 `UrlInstallDialog` 모달 open

`UrlInstallDialog.js` (신규, shipped):

- URL 입력창 + "Fetch & Preview" 버튼
- client-side https:// 강제 (toast warn on http://)
- Fetch 클릭 → `POST /api/skill-packs/registry/install-url` `{ url, dry_run: true }`
- 성공 시 자체 state 에 `{ pack, hash, preview_token, source_url_display }` 저장 → `PackPreviewModal` 을 `pack` 에 provenance 필드 + `_preview_context: 'url-dry-run'` 을 merge 해서 렌더
- `PackPreviewModal` 의 Install 클릭 → `POST /api/skill-packs/registry/install-url` `{ url, preview_token, expected_hash }` → 성공 토스트

`SkillPacksView.js` (My Packs 탭, shipped):

- 카드에 출처 배지: `origin_type` 기반으로 `Bundled` / `URL: <host>` / `Manual` / `Imported`. URL 팩은 `source_url_display` 의 host 를 배지에 렌더하고 full path 를 hover tooltip 에 표시.
- `origin_type === 'url'` 인 팩 카드에 **"Check for update"** 버튼 노출. 클릭 시 `POST /registry/check-update-url` → `update_available === true` 면 `window.confirm("Update available. Apply?")` → 확인 시 `POST /registry/update-url`. (Phase 1 UI: modal 기반 context 전환 대신 native confirm 사용 — 향후 PackPreviewModal 확장 여지 있음)

`PackPreviewModal.js` (shipped):

- `pack.source_url_display` 가 있으면 provenance 섹션 렌더: `URL`, `Fetched at`, `Hash` (앞 16자 truncated + `…`)
- **절대 full `source_url` 렌더 금지** — server 의 `sanitizePack()` 가 이미 strip 하지만 클라 측에서도 이 필드를 참조하지 않는다.
- `_preview_context` 마커는 UrlInstallDialog 가 전달하는 힌트일 뿐, 별도의 `context` prop 분기 로직은 shipped 버전에 없음. (context-aware 버튼 분기는 install/update 경로가 dialog 쪽에서 이미 분기되어 있어 불필요.)

> v1.1 shipped UI 는 install 경로만 PackPreviewModal 을 사용하고 update 경로는 native confirm 을 쓴다. Update 경로도 preview modal 로 통일하려면 후속 PR 이 필요하지만 v1.1 lock-in scope 밖.

### 6.7 파일 목록

| 파일 | 유형 |
|------|------|
| `server/db/migrations/017_skill_pack_source_url.sql` | Migration (source_url / source_url_display / source_hash / source_fetched_at / origin_type + lossy reclassification) |
| `server/db/migrations/021_skill_pack_origin_type_check.sql` | Migration (R1 lock-in followup: origin_type enum enforcement via triggers) |
| `server/services/ssrf.js` | SSRF 방어 모듈 (canonicalizeUrl / resolveAndValidate / fetchUrlSafe / maskSensitiveParams) |
| `server/services/registryService.js` | `fetchPackFromUrl` + preview token store. `refreshRemoteRegistry` 는 no-op stub 로 보존 |
| `server/services/skillPackService.js` | `installFromUrl` / `updateFromUrl` / `findBySourceUrl` |
| `server/routes/skillPacks.js` | `/registry/install-url` / `/registry/check-update-url` / `/registry/update-url` + `sanitizePack` 응답 필터 |
| `server/public/app/components/GalleryView.js` | Install from URL 버튼 + `UrlInstallDialog` 통합 |
| `server/public/app/components/UrlInstallDialog.js` | 신규 (Fetch → Preview → Install 플로우) |
| `server/public/app/components/PackPreviewModal.js` | provenance 섹션 (`source_url_display` / `source_fetched_at` / truncated `source_hash`) |
| `server/public/app/components/SkillPacksView.js` | 출처 배지 (origin_type 기반) + Check for update (native confirm 기반 update 경로) |
| `server/public/styles.css` | Install from URL 다이얼로그 + 배지 스타일 |
| `server/tests/install-from-url.test.js` | URL install route 통합 테스트 |
| `server/tests/ssrf.test.js` | SSRF 유닛 테스트 (canonicalize / IP CIDR / hostname block / maskSensitiveParams) |

### 6.8 SSRF 테스트 벡터 (최소 커버리지)

테스트에서 반드시 reject 확인할 URL 패턴:

- `http://example.com/pack.json` — 비 HTTPS
- `https://127.0.0.1/pack.json` / `https://localhost/pack.json` / `https://[::1]/pack.json`
- `https://10.0.0.1/pack.json`, `https://192.168.1.1/pack.json`, `https://172.16.0.1/pack.json`
- `https://169.254.169.254/latest/meta-data/` — AWS/GCP metadata
- `https://metadata.google.internal/`
- `https://foo.local/pack.json`
- DNS rebinding mock: 호스트명이 public IP 로 resolve 된 후 private IP 로 재-resolve 되는 시나리오 (resolve를 한 번 하고 그 IP로 직접 연결하는 방식 권장)
- Redirect chain: `https://public.example.com` → `302 https://127.0.0.1/pack.json` — 두 번째 hop 에서 reject

---

## 7. Stage 분할 (v1.1 재정의)

### Stage 1 (v1.0 완료 — 변경 없음)
Bundled Registry + Gallery UI. 이미 PR #82 로 merge 됨.

### Stage 2 (v1.1 재정의)
Install from URL + SSRF 방어 + URL 팩 업데이트

- Migration 017 (source_url, source_hash, source_fetched_at)
- `registryService.fetchPackFromUrl` + SSRF 방어 모듈
- `skillPackService.installFromUrl` / `updateFromUrl` / `findBySourceUrl`
- 3개 신규 API 엔드포인트
- `UrlInstallDialog` 컴포넌트 + Gallery 통합
- My Packs 에 출처 배지 + Check for update UI
- 테스트: install-from-url.test.js + ssrf.test.js

### Stage 3 (추후, Non-Goal now)
Featured Packs (v2+ curation surface — 중앙 registry 의 가벼운 재도입, admin-curated list)

---

## 8. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| SSRF via user-supplied URL | **CRITICAL** | §6.2 Step 0 (pre-fetch validation) + redirect manual + per-hop revalidate + size cap |
| DNS rebinding | High | Resolve DNS once, connect to that IP directly (not hostname); block any IP in private ranges |
| URL content silently mutates after preview | High | TOCTOU defense: `expected_hash` 파라미터로 install 시 재검증 |
| Malicious prompt injection | Medium | §6.2 prompt byte limit + MCP alias allowlist + preview 확인 |
| Large response DoS | Medium | Content-Length 체크 + 스트리밍 중 누적 크기 모니터 + 256KB cap |
| Pack author spoofs color/icon to mimic official pack | Low | author 필드는 untrusted display. UI 에서 "URL" 배지 강조. |
| Source URL 404 after install | Low | Update check 에서 graceful error, 기존 설치 유지 |
| User installs a pack, URL content later compromised | Medium | Update check 전까지 변경 미감지. UI 에 `source_fetched_at` 표시로 투명성 제공 |

---

## 9. Open Questions

| # | 질문 | 권장안 | 상태 |
|---|------|--------|------|
| OQ-v1.1-1 | Redirect 허용 여부 | 최대 3회, 매 hop 재검증 | **Resolved** (기본값) |
| OQ-v1.1-2 | 응답 크기 상한 | 256KB (prompt 32KB + 여유) | **Resolved** |
| OQ-v1.1-3 | DNS 리졸브 결과가 여러 IP 일 때 | 모두 통과해야 fetch | **Resolved** |
| OQ-v1.1-4 | URL 팩의 `registry_id` 가 bundled 와 충돌 시 | 409 reject (namespace 오염 방지) | **Resolved** |
| OQ-v1.1-5 | IPv6 차단 범위 | `::1`, `fc00::/7`, `fe80::/10`, unspecified, IPv4-mapped private | **Resolved** |
| OQ-v1.1-6 | Content-Type 허용 범위 | `application/json` + `text/plain` (gist 대응) | **Resolved** |
| OQ-v1.1-7 | Connection pinning vs outbound proxy | Node.js `https.Agent({ lookup })` 로 pinned IP 직접 연결. Proxy 는 v2+ 검토 | **Resolved** — Round 1 P0 |
| OQ-v1.1-8 | Preview 강제 vs UX-only | Server-side preview_token (TTL 5분, 1회용) 로 강제 | **Resolved** — Round 1 P1 |
| OQ-v1.1-9 | Origin type 분류 | `bundled / url / manual / import` enum 컬럼. migration 017 에서 컬럼 추가, migration 021 (R1) 에서 BEFORE INSERT/UPDATE 트리거로 enum enforcement (SQLite 제약상 ALTER TABLE 후 CHECK 추가 불가) | **Resolved** — Round 7 P0 (triggers-as-CHECK) |
| OQ-v1.1-10 | 비표준 HTTPS 포트 허용 | v1.1 은 443 only. 비표준 포트는 v2+ OQ | **Resolved** — Round 1 P1 |

---

## 10. v1.0 과의 호환성

- `registry_id` / `registry_version` 컬럼 유지 (bundled 팩 identifier)
- `source_url` / `source_url_display` / `source_hash` / `source_fetched_at` / `origin_type` 컬럼 신규 (migration 017 + 021)
- 기존 bundled install / update API 는 동작 유지
- `_source: "remote"` 필드 및 관련 로직은 v1.0 중앙 remote registry 제거 시 삭제됨 (해당 코드 path 없음). `_source: "bundled"` 태그는 여전히 `registryService.loadBundled()` 에서 bundled 팩 객체에 부착되지만 API response 에는 영향 없음 (bundled Gallery UI 는 `origin_type`/`installed` 플래그로 표시).
- v1.0 의 `confirmed_preview` 플래그는 v1.1 에서 **preview_token 으로 대체**. Bundled install 경로 (`POST /registry/install`) 는 여전히 `confirmed_preview` 를 받을 수 있음 (기존 동작, `installFromRegistry` 에서 `_source === 'remote'` 인 경우에만 강제 — 현재 `_source === 'bundled'` 이므로 실질 bypass).
- `POST /api/skill-packs/registry/refresh` 는 v1.0 중앙 registry 용이었으나 v1.1 에서 기능이 사라짐. back-compat 를 위해 no-op stub 로 보존 (§6.5 참조).

---

## 11. 구현 순서 (참고 — 실제 구현 PR 에서 재확인)

1. Migration 017 + 기존 migration 검증 (`npm test`)
2. `registryService.fetchPackFromUrl` + SSRF 모듈 (`ssrf.test.js` 선행 작성 — TDD)
3. `skillPackService` 신규 메서드 + unit test
4. 3개 API 엔드포인트 + integration test
5. `UrlInstallDialog` + `PackPreviewModal` context 확장
6. `MyPacksView` 출처 배지 + Check for update
7. CSS
8. E2E 수동 검증 (playwright MCP)
9. Codex 교차 리뷰 → 수렴
10. Commit → PR → merge

---

## 12. Review Log

### Round 0 — Draft (v1.1-rc1)
v1.0-rc1 의 중앙 registry → per-pack URL install 전환 초안. Codex pre-review 에서 P0 (SSRF) / P1 (provenance, URL mutability, UX) 반영 완료.

### Round 1 — Codex Review (ask-codex-20260414-165829-3f4e)

**P0 (1건) 반영**:
- [R1-P0-1] SSRF connection pinning을 normative로 명시. Step 1에서 pinned IP 로 직접 연결 (`https.Agent({ lookup })` 또는 `tls.connect`), TLS SNI 는 원래 hostname. 구현이 pin 불가면 outbound proxy 필수. OQ-v1.1-7 해결됨.

**P1 (4건) 반영**:
- [R1-P1-1] Service signature 를 server-authoritative 로 재정의 — `installFromUrl({ url, expected_hash })`, `updateFromUrl({ pack_id, expected_hash })`. 클라이언트 pack/hash 입력 금지. Lock-in #10 신설.
- [R1-P1-2] Preview 를 UX-only 에서 **server-side preview_token** 으로 강제. TTL 5분, 1회용, HMAC/random, URL/hash/pack_id 바인딩. check-update-url / dry-run 에서 발급, confirm/update 에서 필수. OQ-v1.1-8 해결됨.
- [R1-P1-3] Origin 추론 제거 — 명시적 `origin_type` 컬럼 (`bundled|url|manual|import`) 도입. Lock-in #9 갱신, Migration 017 업데이트. OQ-v1.1-9 해결됨.
- [R1-P1-4] URL canonicalization 단계 (Step 0a) 추가 — punycode/IDN 정규화, lowercase host, fragment 제거, userinfo 거부, port 443 only, canonical URL 을 persist/unique index 기준으로 사용. OQ-v1.1-10 해결됨.

### Round 2 — Codex Review (ask-codex-20260414-170409-bb73)

**VERDICT: PASS on #1 (SSRF pin), #2 (preview token). P1 remaining on #3 (origin migration), #4 (URL canonicalization).**

**P1 (2건) 반영**:
- [R2-P1-1] URL canonicalization 에 **default-port elision** (`:443` 생략) + **trailing dot 제거** 추가. Step 0a 업데이트.
- [R2-P1-2] Origin_type 마이그레이션을 **lossy** 로 선언. 기존 row 전체를 `'manual'` default 로 이전. v1.0 bundled install 의 `core/*` / `community/*` prefix 가 확인되면 선택적 'bundled' 재분류. §6.3 업데이트.

### Round 3 — Codex Review (ask-codex-20260414-170644-0888)

**VERDICT: ISSUES (P1: 2건)**

**P1 반영**:
- [R3-P1-1] API contract 일관화 — US-008/009 의 `confirmed_preview: true` body 를 **`preview_token` 으로 통일**. §6.5 와 일치.
- [R3-P1-2] Query string secret leak 방어 — `source_url` (full, server-only) 와 `source_url_display` (query/fragment 제거, UI/로그용) 분리. UI 는 후자만 렌더. 민감 param heuristic 마스킹.

### Round 4 — Codex Review (ask-codex-20260414-170849-8660)

**VERDICT: FAIL (P1: 2건, documentation consistency)**

**P1 반영**:
- [R4-P1-1] `PackPreviewModal` 의 출처 섹션을 `source_url_display` 로 통일 (full source_url 렌더 금지 재강조).
- [R4-P1-2] Hash 필드명 통일 — `fetched_hash` → `hash` (§6.5 dry-run response 와 일관). US-008 body/response 재정비.

### Round 5 — Codex Review (ask-codex-20260414-171007-9e81)

**VERDICT: ISSUES (P1: 1건, naming consistency)**

**P1 반영**:
- [R5-P1-1] Preview token binding description 에서 `fetched_hash` → `hash` 로 통일 (§6.5 와 일관).

### Round 6 — Codex Review (ask-codex-20260414-171100-d095)

**VERDICT: PASS**

> "I don't see any remaining blocking spec inconsistencies. ... The earlier P1 issues on origin typing, canonicalization, preview enforcement, and display-vs-internal URL handling also look closed."

Editorial nit `register_id` → `registry_id` 도 수정 완료. Spec v1.1-rc1 수렴.

**Status: Approved — 구현 진입 가능.**

### Round 7 — Codex Review (ask-codex-20260424-162828-bec3) — R1 lock-in

v1.1 구현이 이미 merged 된 상태에서 spec ↔ 실구현 정합성 검토. Verdict: ISSUES (1× P0, 3× P1, 3× NIT). 모두 R1 PR 에서 반영:

**P0 반영**:
- [R7-P0-1] migration 017 에 `CHECK (origin_type IN (...))` 가 실제로 없다. SQLite 는 ADD COLUMN 후 CHECK 추가가 table rebuild 없이 안 되므로, **migration 021** 을 추가해 BEFORE INSERT / BEFORE UPDATE 트리거로 enum enforcement 를 구현. §6.3 의 lock-in 의도를 DB layer 에서 유지.

**P1 반영**:
- [R7-P1-1] `source_url_display` 가 schema + API response 에 실제로 존재하는데 spec §6.3 ALTER TABLE 블록과 §6.5 dry-run/check-update 응답 shape 에서 빠져 있었다. §6.3, §6.5, §6.7 에 명시 추가.
- [R7-P1-2] Preview token lifecycle 이 spec 과 다르다. Spec 은 "token 검증 → re-fetch → install → consume on success"; 실구현은 "re-fetch → token consume only on validation-success → install". 실구현을 정답으로 고정. §6.5 install-url / update-url 순서 텍스트 업데이트.
- [R7-P1-3] spec 이 `/registry/refresh` 를 "removed" 라고 기술했지만 실제로는 v1.0 back-compat 를 위해 no-op stub 로 보존됨 (registry.test.js 가 여전히 검증). §6.5 "Deprecated stub" 섹션 추가.

**NIT 반영**:
- [R7-N1] §6.3 lossy-migration 서술을 conditional (".. 조건을 추가해 해당 row 만 'bundled' 로 설정할 수 있다") 에서 definitive (migration 017 의 shipped UPDATE 문 그대로 인용) 로 tighten.
- [R7-N2] §6.4 service signature 를 merged 계층에 맞춰 재작성 — router 가 fetch + canonicalize + hash 해서 service 메서드에 payload 를 넘기는 구조.
- [R7-N3] §6.6 UI 섹션을 shipped 구현에 맞춰 narrowing: `PackPreviewModal` 의 `context` prop 분기 로직 없음, update 경로는 native `window.confirm` 사용, provenance 는 install preview 에서만 렌더.

### Round 8 — Codex Re-review (ask-codex-20260424-164138-5798) — R1 post-fix

Round 7 fixes 이후 재검토. Verdict: ISSUES (1× P1, 1× P2, 1× NIT).

**추가 수정 (R1 PR 내)**:
- [R8-P1-1] §6.5 preview-token 섹션에서 "fail-closed: 검증 실패도 token 소비" 라고 잘못 기술했던 부분을 실제 `consumePreviewToken` 동작에 맞춰 "validation-success only consume" 으로 수정. 공격 표면 분석과 향후 hardening 옵션을 별도 관측 블록으로 추가.
- [R8-P2-1] Review Log 의 "Round 8 pending" / "Round 8 PASS 받으면 lock-in" 자기 모순 문구 제거. Round 8 fix 가 이 섹션 자체에서 이미 완결되므로 Status line 은 Final 을 유지.
- [R8-N1] §9 OQ-v1.1-9 의 "CHECK constraint" 문구를 "migration 021 트리거" 로 수정하여 §6.3 와 일관화.

### Round 9 — Codex Re-review (ask-codex-20260424-164809-512c) — R1 nit

**Verdict: ISSUES (1× nit)** — §6.5 update-url 설명에서 `consumePreviewToken` 호출 signature 에 첫 인자 `preview_token` 이 빠져 있었음. Round 10 에서 수정.

### Round 10 — Final (post-R9 nit fix)

§6.5 update-url 의 consumePreviewToken 호출을 `consumePreviewToken(preview_token, "pack:<pack_id>", expected_hash)` 로 수정하여 §6.4 signature 정의 + shipped 코드와 완전 일치시킴. 다른 drift 없음.

**Status: Final (locked in 2026-04-24).** R1 PR 머지 시점에 lock-in 완료.
