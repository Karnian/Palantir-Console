# Phase M4 — MCP Streamable HTTP Transport Brief

> **상태 (2026-05-04): READY r7; post-impl L9.1 verification stamp (확장 — 외부 MCP HEAD 매트릭스 + Bifrost listChanged 코드 분석). M4-a 머지 (PR #172) + 운영 가이드 (PR #176) + diagnose-mcp fix (PR #175) + L9.1 stamp (PR #177) + L9.1 확장 (PR #178) 후 §L9 R2 의 정적 도구 사용 핵심 가치 end-to-end 검증 완료. 동적 listChanged 전파는 코드 분석상 Bifrost `/mcp` 미지원 / `/sse` 지원 (codex SSE 실측 미진행) — M4-c entry condition 정밀화. 이전: DRAFT r4 — Claude+Codex(gpt-5.5) cross-check 5회 정렬, r1→r7 까지의 변경 매트릭스는 §8 결정 출처 참고.**
>
> M-시리즈 후속 (M1 fail-closed flatten / M2 legacy alias scan / M3-UI CRUD) — `mcp_server_templates` 가 stdio 만 모델링하던 가정을 깨고 Streamable HTTP MCP 를 1급 transport 로 추가. mcp-bifrost 같은 HTTP/SSE 원격 MCP 허브가 워커 spawn 경로에 직접 등록 가능해짐.

---

## 1. 컨텍스트

### 1.1 motivation — Bifrost & 일반 원격 MCP

mcp-bifrost (`http://localhost:3100/mcp` + `/sse`) 같은 멀티 워크스페이스 MCP 브릿지를 Palantir 워커가 쓰려면 stdio template 모델로는 직접 등록이 불가능. 우회로는 `mcp-remote` stdio bridge 가 있으나 (a) 워커마다 `npx → mcp-remote → bifrost` 추가 hop, (b) 토큰을 `--header "Authorization: Bearer …"` argv 노출, (c) SSE notifications 전파가 mcp-remote 버전 의존 — 운영 모드 부적합.

Linear (`https://mcp.linear.app/mcp`), Notion 공식 hosted (`https://mcp.notion.com/mcp`), Sentry 등 원격 MCP 들도 같은 길로 들어온다.

### 1.2 결정적 인풋 — Codex CLI 0.125 native HTTP 지원

```
codex mcp add --url <URL> --bearer-token-env-var <ENV>
```

config 측은 dotted-path:
```
-c mcp_servers.<alias>.url="https://example.com/mcp"
-c mcp_servers.<alias>.bearer_token_env_var="SOME_ENV"
```

즉 spawn 경로의 받침대는 이미 native 로 깔려있고, Palantir 의 stdio 가정만 깨면 됨. `codexMcpFlatten.js:152-156` 가 이미 직접 `bearer_token` 거부 + `bearer_token_env_var` 키 인지 — HTTP 케이스 절반쯤 인프라 ready. **Codex CLI 가 dotted config 에서 `url` 키 존재로 HTTP transport 자동 추론** — Palantir 측은 별도 `transport` 키를 codex args 로 emit 하지 않는다 (L5 참조).

### 1.3 Bifrost 변경 0 / 책임 경계

코덱스 cross-check (gpt-5.5, 2026-04-29) verdict: "바꿔야 할 곳은 집계 서버가 아니라 워커 설정 생성기". Bifrost 는 인증/네임스페이스/프로필/OAuth 묶어서 HTTP/SSE 로 노출하는 브릿지로 그대로 두고, Palantir 만 stdio 가정을 깬다. Bifrost 에 stdio export 를 붙이는 옵션 (Option C) 은 OAuth state 가 워커마다 분산 + SDK 미사용으로 직접 JSON-RPC pump 구현 부담 → 비채택.

---

## 2. Lock-in (Codex M4 r1+r2+r3 권장 + 가드레일)

### L1. B-lite — discriminated transport, **만능 추상화 금지**

`mcp_server_templates` 한 테이블 안에서 `transport` 컬럼 분기로 처리. 별도 `remote_mcp_servers` 테이블도, transport-strategy 인터페이스도, transport 추상화 레이어도 만들지 않는다.

- **허용**: `mcpTemplateService.create/update`, `flattenMcpToCodexArgs`, UI 폼에서 `if (transport === 'stdio') … else if (transport === 'http') …` 두 줄 분기.
- **금지**: `TransportStrategy` 인터페이스, `StdioTransport` / `HttpTransport` 클래스 분리, `presetService` / `routes/*` 에 transport 어휘 누출 (preset 은 여전히 alias id 만 참조).

근거: 단일 PR 사이즈 유지 + 회귀면 최소화 + 추상화는 3rd transport 등장 시점에 다시 고민.

### L2. transport 값 — `'stdio'` 와 `'http'` 두 가지만

- `'http'` 가 Streamable HTTP 를 의미 (Codex CLI 0.125 가 `--url` 로 받는 transport).
- `'sse'` 는 별도 enum 값으로 추가하지 않는다.
- **URL path 처리**: Bifrost 의 `/mcp` (Streamable HTTP) 와 `/sse` (legacy SSE) **둘 다 `transport='http'` 로 등록**. Codex CLI 0.125 가 endpoint 응답 헤더로 transport 자동 negotiation 하므로 spec 측면에선 path 차이 무시. 향후 SSE-only 원격 MCP 가 나타나면 그때 `'sse'` enum 값 추가 — phase 분리.

### L3. DB 스키마 (migration 022)

> **r4 finding**: 기존 `013_skill_packs.sql:7` 의 `command TEXT NOT NULL` 제약 때문에 단순 `ALTER TABLE … ADD COLUMN` 으론 http row INSERT 가 불가능. SQLite 가 `ALTER COLUMN` 으로 NOT NULL 제거를 지원하지 않으므로 **table rebuild 패턴**으로 처리.

```sql
-- migration 022_mcp_template_http_transport.sql
-- transactional (db/migrations runner 가 BEGIN/COMMIT 으로 감쌈).

-- 1) 새 스키마 (command nullable, 신규 컬럼 포함)
CREATE TABLE mcp_server_templates_new (
  id                   TEXT PRIMARY KEY,
  alias                TEXT NOT NULL UNIQUE,
  transport            TEXT NOT NULL DEFAULT 'stdio'
                       CHECK (transport IN ('stdio', 'http')),
  command              TEXT,                 -- stdio 전용, http 면 NULL
  args                 TEXT,                 -- stdio 전용 JSON array, http 면 NULL
  allowed_env_keys     TEXT,                 -- stdio 전용 JSON array, http 면 NULL
  url                  TEXT,                 -- http 전용, stdio 면 NULL
  bearer_token_env_var TEXT,                 -- http 전용 (옵션), stdio 면 NULL
  description          TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT                  -- migration 020 이 도입 (drift 감지)
);

-- 2) 데이터 이전 — 기존 row 는 모두 stdio (transport default)
INSERT INTO mcp_server_templates_new
  (id, alias, transport, command, args, allowed_env_keys, description, created_at, updated_at)
SELECT
  id, alias, 'stdio', command, args, allowed_env_keys, description, created_at, updated_at
FROM mcp_server_templates;

-- 3) drop + rename
DROP TABLE mcp_server_templates;
ALTER TABLE mcp_server_templates_new RENAME TO mcp_server_templates;

-- 4) index 재생성 (013 에서 만든 게 있다면 동일 이름으로)
-- (013 은 alias UNIQUE 만 — PRIMARY KEY + UNIQUE 가 자동 인덱스 제공.
--  추가 인덱스가 없으면 step 4 생략.)

-- 5) 정합성 trigger — BEFORE INSERT
CREATE TRIGGER mcp_template_transport_consistency_insert
BEFORE INSERT ON mcp_server_templates
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.transport = 'stdio' AND (NEW.command IS NULL OR trim(NEW.command) = '')
      THEN RAISE(ABORT, 'stdio template requires non-empty command')
    WHEN NEW.transport = 'stdio' AND NEW.url IS NOT NULL
      THEN RAISE(ABORT, 'stdio template must not have url')
    WHEN NEW.transport = 'stdio' AND NEW.bearer_token_env_var IS NOT NULL
      THEN RAISE(ABORT, 'stdio template must not have bearer_token_env_var')
    WHEN NEW.transport = 'http' AND (NEW.url IS NULL OR trim(NEW.url) = '')
      THEN RAISE(ABORT, 'http template requires non-empty url')
    WHEN NEW.transport = 'http' AND NEW.command IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have command')
    WHEN NEW.transport = 'http' AND NEW.args IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have args')
    WHEN NEW.transport = 'http' AND NEW.allowed_env_keys IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have allowed_env_keys')
  END;
END;

-- 6) 정합성 + immutability trigger — BEFORE UPDATE
-- (transport/alias immutable + column-shape 검증 모두 포함)
CREATE TRIGGER mcp_template_transport_consistency_update
BEFORE UPDATE ON mcp_server_templates
FOR EACH ROW
BEGIN
  SELECT CASE
    -- immutability
    WHEN OLD.transport != NEW.transport
      THEN RAISE(ABORT, 'transport is immutable — create a new template instead')
    WHEN OLD.alias != NEW.alias
      THEN RAISE(ABORT, 'alias is immutable — create a new template instead')
    -- column-shape (insert trigger 와 동일)
    WHEN NEW.transport = 'stdio' AND (NEW.command IS NULL OR trim(NEW.command) = '')
      THEN RAISE(ABORT, 'stdio template requires non-empty command')
    WHEN NEW.transport = 'stdio' AND NEW.url IS NOT NULL
      THEN RAISE(ABORT, 'stdio template must not have url')
    WHEN NEW.transport = 'stdio' AND NEW.bearer_token_env_var IS NOT NULL
      THEN RAISE(ABORT, 'stdio template must not have bearer_token_env_var')
    WHEN NEW.transport = 'http' AND (NEW.url IS NULL OR trim(NEW.url) = '')
      THEN RAISE(ABORT, 'http template requires non-empty url')
    WHEN NEW.transport = 'http' AND NEW.command IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have command')
    WHEN NEW.transport = 'http' AND NEW.args IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have args')
    WHEN NEW.transport = 'http' AND NEW.allowed_env_keys IS NOT NULL
      THEN RAISE(ABORT, 'http template must not have allowed_env_keys')
  END;
END;
```

**Migration 안전성**: 전체 SQL 이 `db/migrations` runner 의 단일 transaction 안에서 실행 — partial state 노출 없음 (실패 시 BEGIN 으로 rollback). 기존 row 들은 transport='stdio' 로 자동 채워지고 신규 컬럼은 NULL. command 가 nullable 로 바뀌어도 stdio row 들은 trigger 가 command 필수 강제하므로 invariant 유지.

#### L3.1 Truth table (compound 가드 — service validator 가 canonical, trigger 는 마지막 방어선)

| `transport` | `command` | `args` | `allowed_env_keys` | `url` | `bearer_token_env_var` |
|---|---|---|---|---|---|
| `stdio` (기존 row + 신규 row) | NOT NULL, non-empty | nullable JSON array | nullable JSON array | **MUST be NULL** | **MUST be NULL** |
| `http` | **MUST be NULL** | **MUST be NULL** | **MUST be NULL** | NOT NULL, non-empty | nullable string |

기존 row 들은 migration 022 적용 시 `transport='stdio'` default 채워지고 컬럼 정합성 자동 만족. **alias 와 transport 둘 다 immutable** — 변경은 새 alias 로 새 template 만들기 (M4-a §3.3 manual path 참조).

### L4. mcpTemplateService validator 분기

```js
// validateCreateInput / validateUpdateInput 에서
if (transport === 'stdio') {
  // command 필수, args / allowed_env_keys 기존 그대로
  // url / bearer_token_env_var 받으면 BadRequest
} else if (transport === 'http') {
  // url 필수 + ssrfPolicy.assertSafeUrl(url) 호출
  // bearer_token_env_var 옵션 — ENV_HARD_DENYLIST 통과 검사 (validateAllowedEnvKeys 와 동일)
  // command / args / allowed_env_keys 받으면 BadRequest
}
```

#### L4.1 SSRF 정책 (validator + preflight 공유 단일 source)

`services/ssrf.js` 에 `ssrfPolicy` 객체 (또는 `assertSafeUrl(url)` 단일 helper) 만들어서 validator 와 preflight 가 같은 resolver/규칙 사용. 별도 케이스마다 분기 금지.

- **프로토콜**: `http://` 또는 `https://` 만. 기타 (file://, ws://, …) 거부.
- **URL 형식**: max 2KB, query string 허용 (`?profile=read-only`), fragment (`#…`) 거부.
- **호스트 정규화** (단계 분리):
  1. URL hostname 추출 (`new URL(url).hostname`).
  2. mixed-case → lowercase 정규화.
  3. IDN hostname 의 경우 punycode `xn--…` 와 Unicode form 둘 다 동일하게 다루기 위해 url.hostname (자동 punycode encode 결과) 을 canonical form 으로 사용.
  4. literal IP 면 그대로 IP, 호스트명이면 DNS resolve (다음 step).
  5. IPv6 literal `[::1]:port` 형식 인식 — bracket 떼고 IP 부분 추출.
- **DNS resolve 검사**: hostname 을 실제 resolve 후 결과 IP(들) 를 다음 차단 목록과 교차 검사:
  - IPv4 private: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`
  - IPv4 link-local: `169.254.0.0/16` (AWS metadata `169.254.169.254` 포함)
  - IPv6 ULA: `fc00::/7`, link-local `fe80::/10`, loopback `::1`
  - IPv4-mapped IPv6 (`::ffff:10.0.0.1` 등)
  - 한 hostname 의 multi-A 응답 중 **하나라도** 위에 해당하면 차단 (DNS rebinding 방어).
- **localhost 예외**: hostname 이 정확히 `localhost` / `127.0.0.1` / `::1` (정확 매치, suffix 매치 X) 일 때만 통과. envvar `PALANTIR_MCP_ALLOW_LOCALHOST` 가 unset 또는 `1` 이면 허용 (default), `0` 이면 차단 (외부 노출 운영자가 잠금).
- **redirect 정책**: preflight 의 fetch 는 `redirect: 'manual'`. 3xx 응답을 받으면 fail-closed (`preset:mcp_unreachable` reason="redirect_blocked") — redirect-to-private 우회 방지.
- **validator 와 preflight 가 같은 helper 사용** — `assertSafeUrl(url)` 가 양쪽 entry point. 다르게 구현되면 validator 통과 후 preflight 가 내부망 때리는 PR 가능.
- **async 계약** — `assertSafeUrl(url)` 는 DNS resolve 가 포함되므로 **async (returns Promise<{ ip, family, hostname }>)**. caller (mcpTemplateService validator, preflight, 향후 다른 호출자) 는 반드시 `await`. helper 이름이 sync 처럼 보이지만 sync 가 아님 — 내부적으로 `dns.promises.lookup` 사용. 구현자가 Promise 를 그대로 통과시키면 validator fail-open 가능 → 함수 시그니처 명시 + 테스트가 sync 호출 (await 누락 시 throws/regression detect).
- **DNS rebinding TOCTOU 가드** (r5 BLOCKER fix) — `assertSafeUrl` 이 DNS resolve 후 fetch 가 다시 resolve 하면 rebinding 가능. preflight 의 `fetch(url)` 호출은 **`assertSafeUrl` 이 반환한 IP 에 connection pin** — Node `undici.Agent` 의 `connect.lookup` 옵션 또는 custom Dispatcher 로 hostname 을 위 검증 단계의 `{ ip, family }` 결과로 강제 override. 즉 fetch 가 별도 DNS lookup 안 함. Host header 는 원본 hostname 유지 (TLS SNI / virtual host 호환). 한 번 resolve → 한 번 connect — middle race 무.

#### L4.1.1 SSRF 보장 범위 (residual risk 명시)

**Palantir 의 SSRF 가드 범위는 validator (CRUD 시) + preflight (spawn 직전) 까지**. spawn 후 codex CLI 가 `mcp_servers.<alias>.url` 로 실제 HTTP 연결을 맺을 때의 DNS resolve / redirect / connection 단계는 **codex CLI 자체 책임** — Palantir 이 강제할 수 없음. 즉 다음 시나리오는 본 phase 의 보장 범위 외:

- DNS rebinding 공격 (preflight 에서 public IP 받았으나 재호출 시 private IP) — codex 가 매 요청마다 resolve 하면 본인 책임.
- redirect-follow 시 codex 가 redirect 따라가서 내부망 요청 — codex 의 redirect 정책에 의존.
- IP literal 직접 통과 후 codex 가 그 IP 그대로 사용 — preflight 에서 차단됐으면 spawn 안 됨, 통과했다면 그 IP 자체가 안전한 IP.

강한 end-to-end 보장이 필요하면 후속 phase 로 **egress proxy / host allowlist** (운영자가 명시한 외부 호스트만 워커가 접근 가능) 도입 — 본 phase 의 백로그 (§7) 에 명시.

본 spec 의 보장: "preflight 단계까지 안전한 URL 만 codex 에 넘긴다" — codex 의 추가 round-trip 위협은 codex CLI 의 보안 모델에 위임.

#### L4.2 에러 표면 우선순위

`mcpTemplateService` validator 가 **canonical** — UI / API 가 보는 메시지는 service 메시지. DB trigger 는 **마지막 방어선** (raw SQL / 다른 migration / future code path 가 service 우회 시에만 발화). 두 메시지가 형태 일치할 필요 없음 — service 메시지만 운영자/UI 친화적이면 충분.

### L5. codexMcpFlatten 분기

```js
// alias cfg validation 안에서 (transport 키는 cfg 에 있어도 무시; url 존재로 분기)
if (cfg.url !== undefined) {
  // http 케이스: url 필수, bearer_token_env_var 옵션
  // command / args / env / transport 키 거부
  // url 은 string 으로 TOML 직렬화 (encodeString 재사용)
} else {
  // 기존 stdio 경로 — command / args / env
}
```

emit 결과 (`bifrost-default` alias 예시):
```
-c mcp_servers.bifrost-default.url="http://localhost:3100/mcp?profile=default"
-c mcp_servers.bifrost-default.bearer_token_env_var="BIFROST_MCP_TOKEN"
```

**`transport` 키는 codex args 로 emit 하지 않는다** — Codex CLI 가 url 존재로 HTTP transport 자동 추론. flatten 테스트가 이를 명시 검증 (no `transport` arg, no `command` arg, url-only cfg accepted, bearer_token_env_var 옵션이면 emit 안 함).

**TOML 직렬화 가드 (R1)**: url 값에 `?`/`&`/`=`/`"` 등이 들어가도 `encodeString` 의 `JSON.stringify` 가 모두 안전하게 quote. `codex-mcp-flatten.test.js` 에 url 전용 케이스 추가 (쿼리스트링, 인코딩된 문자, 한국어 path 등).

### L6. preflight healthcheck (R3 — stdio 와 다른 신규 가드)

stdio 는 프로세스 spawn 자체가 healthcheck. HTTP 는 endpoint 가 죽어도 워커가 모름 → spawn 직전 preflight 한 번:

- **언제**: `lifecycleService` (worker spawn) 와 `pmSpawnService` / `codexAdapter.spawnOneTurn` (PM spawn) 이 flatten 호출 직전.
- **method 순서 (고정)**:
  1. `HEAD` 첫 시도 — 가장 universal.
  2. HEAD 가 405 (Method Not Allowed) 또는 501 (Not Implemented) 면 endpoint 살아있다는 신호 → pass.
  3. HEAD 가 그 외 응답이면 그 응답으로 결정. **OPTIONS fallback 안 함** (어느 method 가 통할지 endpoint 마다 다르면 구현별 갈림 — codex r4 SERIOUS 3 fix).
- **pass 조건**: HTTP status `200`, `204`, `405`, `501` 중 하나 (테스트 plan §5.1 의 preflight pass 목록과 lock-step).
- **timeout**: 3s. 초과 시 fail-closed reason="preflight_timeout".
- **MCP `initialize` JSON-RPC ping 까지 가지 않음** — preflight 비용 최소화 + SDK 호환성 회피.
- **redirect**: `redirect: 'manual'` (L4.1). 3xx 받으면 fail-closed reason="redirect_blocked".
- **실패 시**: M1 fail-closed 정책과 동일 — `preset:mcp_unreachable` SSE 이벤트 + run failed. 워커는 spawn 안 됨. payload `{ alias, url, reason, status? }` (env 값 절대 emit 안 함).
- **비활성 옵션**: env var `PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP=1` (debug 용, 서버 시작 시점 평가). 기본 unset = preflight 항상 on.

#### L6.1 Authorization 정책 (BLOCKER 1 fix)

bearer-protected MCP endpoint 가 preflight 를 401/403 으로 막으면 preflight 가 항상 fail-closed 됨 → 다음 정책:

- cfg 에 `bearer_token_env_var` 가 있으면 **preflight 도 동일 env var 의 값을 읽어 `Authorization: Bearer <value>` 헤더로 첨부**.
- env var 값이 missing 또는 empty 면 preflight 안 보내고 즉시 fail-closed (`preset:mcp_unreachable` reason="bearer_env_missing", payload 에 *키 이름* 만 포함).
- 헤더 값은 절대 로그 / SSE 페이로드 / `diagnose:mcp` 출력 / RunInspector 에 emit 안 함 — *키 이름* (`BIFROST_MCP_TOKEN`) 만 노출.
- bearer-protected 가 아닌 endpoint (cfg 에 `bearer_token_env_var` 없음) 는 Authorization 없이 preflight. 200/204/405 가 정상.

#### L6.2 Auth lookup 단일 entry point (SERIOUS 4 fix)

preflight 의 bearer 값 lookup 위치는 **`authResolver.resolveBearerForPreflight(envVarName)` 단일 진입점**. lifecycleService / pmSpawnService / codexAdapter 어디서도 직접 `process.env[…]` 안 읽음. ENV_HARD_DENYLIST 검사 + missing/empty 처리 + 마스킹 정책 모두 이 helper 안에서. 워커 spawn 의 `buildManagerSpawnEnv` 와 같은 source.

### L7. env hygiene (R4 — 코덱스 underestimated risk)

`bearer_token_env_var` 자체는 안전한 형태지만, 운영 표면 (`diagnose:mcp` / SSE 이벤트 / RunInspector / 로그) 에서 env 키 *이름* 만 노출하고 *값* 은 절대 안 보이게:

- **`buildManagerSpawnEnv` (`authResolver`)**: `bearer_token_env_var` 가 가리키는 키를 spawn env allowlist 에 자동 포함. ENV_HARD_DENYLIST 와 교집합 검사 (이미 `validateAllowedEnvKeys` 에 있음 — 재사용).
- **`mcp:legacy_alias_conflict` SSE payload**: 키 *이름* 만, 값 절대 emit 안 함. payload shape `{ alias, source, message }` 유지 (CLAUDE.md 의 "M2 cardinality 규율" 준수).
- **`npm run diagnose:mcp` 출력**: env 키 *이름* 만, 값은 `***` 마스킹. 새 컬럼 출력 시 `transport` / `url` 노출 OK (URL 자체는 secret 아님). `bearer_token_env_var` 키 이름 노출 OK.
- **RunInspector preset snapshot**: env 값 절대 캡처 안 함. transport / url / bearer_token_env_var **이름** 만 snapshot 에 포함.
- **drift detection**: `mcp_server_templates.updated_at` 의 기존 logic (migration 020) 에 url / bearer_token_env_var 도 내용 비교 대상으로 추가. 빈 값 ↔ null 의 false-drift 방지를 위해 `COALESCE(…, '')` 패턴 유지.

### L8. UI — McpTemplatesView transport selector

`TemplateModal` 에 transport selector (radio 또는 segmented) 추가:

- **transport: stdio** (default) → 기존 폼 (command / args / allowed_env_keys / description).
- **transport: http** → url + bearer_token_env_var (옵션) + description. (command / args / allowed_env_keys 필드 숨김.)
- **edit 시 transport disabled** (immutable). 변경하려면 새 alias 만들기 안내.
- **카드 뷰 (list)**:
  - stdio → `<code>${command}</code> ${argsPreview}`
  - http → `<code>${url}</code>` + (bearer_token_env_var 있으면) ` <span>(bearer: ${env키이름})</span>` — env *키 이름* 만, 값은 노출 안 함 (L7 정책)
- M3-UI 의 alias-immutable hint 패턴 그대로.

### L9. SSE notifications 전파 검증 (R2)

Codex CLI 0.125 가 HTTP MCP 로 연결됐을 때 Bifrost 의 `tools/list_changed` notification 을 워커 세션이 받는지 **실측 시나리오** 으로 검증:

- 시나리오: Bifrost 에 워크스페이스 1개 추가된 상태에서 워커 spawn → 워크스페이스 1개 더 추가 → 워커 codex 가 `tools/list` 를 다시 호출하거나 자동 invalidate 하는지 관찰.
- 결과를 spec 결정 노트에 추가 — Bifrost 의 자체 JSON-RPC handler 가 SDK 표준과 다른 부분 있으면 그 차이 기록.
- 이 검증이 실패해도 M4 진행은 OK (Bifrost 측 follow-up 으로 분리). M4 의 핵심 가치는 "워커가 Bifrost 도구를 호출 가능" 이고 dynamic tool discovery 는 추가 가치.

#### L9.1 Verification status (post-impl, 2026-05-04)

R2 의 부분 검증 결과 — 추가 시나리오는 사용자 환경 액션 (워크스페이스 추가/제거) 대기.

| 검증 포인트 | 상태 | 근거 |
|---|---|---|
| Bifrost 가 `capabilities.tools.listChanged: true` 선언 | ✅ 확인 | `POST /mcp` initialize 응답: `{"capabilities":{"tools":{"listChanged":true},...}}`. Bifrost 측 self-advertise. |
| Bifrost 가 HEAD `/mcp` 에 RFC 호환 응답 | ✅ 확인 | mcp-bifrost issue #3 / PR #4 머지 후 `HEAD /mcp` 가 `405 Method Not Allowed` + `Allow: POST`. spec §L6 의 preflight pass list `{200, 204, 405, 501}` 와 정합. |
| Palantir → codex effective MCP config 주입 (`-c mcp_servers.<alias>.url=...`) | ✅ 확인 | run_aaff2fbd 의 `mcp_config_snapshot` (DB persisted): `{"mcpServers":{"Bifrost":{"url":"http://localhost:3100/mcp"}}}`. argv 자체는 spawn-time transient 라 직접 capture 안 했으나 effective config 가 codex 까지 전달됐음을 DB 스냅샷이 입증. preflight 통과 후 spawn 정상. |
| codex CLI 0.125 가 startup 시 자동 `tools/list` 호출 | ✅ 확인 | 직접 `codex exec --json` 호출 시 normalized event stream 에 `mcp_tool_call` (server=`Bifrost`, tool=`http_notion-aiproduct1__notion-search`) 까지 발생. tools/list 가 model context 에 주입됐다는 간접 증거 (LLM 이 도구 이름 / 인자 schema 인지 후 호출). |
| LLM 이 prompt 매치 시 자율적 `mcp_tool_call` | ✅ 확인 | "use the search tool with query='test'" prompt → codex 가 `arguments={"query":"test","filters":{}}` 로 직접 호출 → Bifrost 가 Notion 결과 (`MPP test`, `UI Test`, `API TEST` 등) 정상 반환. |
| 🔬 Bifrost `/mcp` (Streamable HTTP) 가 비동기 listChanged 전파 가능 | ❌ 미지원 (코드 분석) | MCP Streamable HTTP 2025-03-26 spec 상 `POST /mcp` 가 `Accept: text/event-stream` 시 SSE 응답 가능 (해당 POST 의 응답 범위 내 notification). 단 워크스페이스 변경 같은 *비동기 / 무관한* `tools/list_changed` 는 별도 `GET /mcp` SSE listening stream 이 정석. `mcp-bifrost/server/index.js:265` 의 POST 핸들러는 `jsonResponse(res, 200, ...)` 로 단발 응답하고 GET `/mcp` SSE stream / session routing 자체가 없음 (`sse-manager.js` 의 `broadcastNotification` 은 legacy `/sse` 세션에만 emit). **Streamable HTTP 채널로 연결한 client 는 비동기 listChanged 못 받음**. (Palantir 등록 레벨에서는 §3.1 의 path 무시 정책이 유효하지만, notification 전달 능력은 Bifrost 구현에 의존.) |
| 🔬 Bifrost legacy `/sse` 가 listChanged 전파 가능 | ✅ 코드 분석 | `mcp-bifrost/server/index.js:110, :210` 의 `wm.onWorkspaceChange()` + OAuth 콜백이 `sse.broadcastNotification('notifications/tools/list_changed')` 호출. workspace-manager.js 의 8개 mutation path (`_notifyChange()`) 가 모두 emit. SSE 세션이 받음. (역시 Palantir 등록 레벨과 별개로 Bifrost 구현 capability.) |
| ⚠ codex CLI 0.125 의 Streamable HTTP GET-SSE listener / legacy SSE transport 지원 | 미검증 | (a) Bifrost 측에 GET `/mcp` SSE stream 추가 후 codex 가 그 stream 을 listen 하는지, 또는 (b) Palantir url 을 `http://localhost:3100/sse` 로 변경 후 codex 가 legacy SSE transport 로 연결되는지 — 둘 다 codex 의 transport 매트릭스 + Bifrost 측 capability 의 함수. 사용자 환경 액션 + 별도 실측 영역. |
| 🔬 외부 hosted MCP 의 anon HEAD 응답 매트릭스 (Linear / Notion 공식 / Sentry / GitHub Copilot / Atlassian / Cloudflare) | ✅ 수집 완료 | 6개 endpoint 직접 probe — 본 6개 케이스 중 5개 (Linear / Notion / Sentry / GHCP / Atlassian) 가 `401 Unauthorized`. 이는 RFC 7235 패턴 (인증 layer 가 method check 보다 먼저 결정) 의 일반적 구현 선택과 일관 — 단 규범은 아니므로 다른 endpoint 가 다른 패턴 줄 가능성. 5개 케이스에서는 spec §L6.1 의 Authorization 헤더 첨부로 cover (인증된 HEAD 는 endpoint 마다 200/204/405 등 다를 수 있음 — 토큰 보유 시 별도 검증). |
| ⚠ Cloudflare MCP `/sse` 의 anon HEAD = 404 (별도 분리) | 미해결 | 401 케이스와 다른 표면. Authorization 첨부로 안 풀림. 가능성: (a) endpoint URL 자체가 변경됐거나 (b) 본 path `/sse` 가 잘못됐거나 (c) Cloudflare 가 unauthorized 에 404 를 주는 의도적 패턴. 별도 확인 필요 — Cloudflare 측 실 docs 매핑 영역. |
| ⚠ 인증된 외부 hosted MCP 의 HEAD 응답 (bearer 첨부) | 미검증 | 각 provider 의 토큰 보유 환경에서 별도 실측 영역. anon 401 통과 후 endpoint 가 200/204/405 줄지 endpoint 마다 다름. M4-c 진입 시점에 토큰 가능한 provider 부터 매트릭스 채우는 게 합리적. |

핵심 결론: **M4-a 의 `워커가 Bifrost 도구를 정적으로 호출 가능` 이라는 핵심 가치는 end-to-end 검증 완료**. 동적 `tools/list_changed` 전파는 본 phase 범위 외 (R2 의 "추가 가치" 라고 spec 이 명시) 이며, 코드 분석상 *Bifrost 측 추가 작업* (GET `/mcp` SSE stream 지원 추가) 또는 *transport 변경* (legacy `/sse` url 사용) 둘 중 하나가 선결 + **어느 경로든 진입 후 codex 가 실제 그 stream 을 listen 하는지 E2E 실측 별도 필요** — M4-c 가칭 후속 phase 의 entry + completion condition. 외부 hosted MCP 의 6개 probe 중 5개 anon-401 케이스는 spec §L6.1 Authorization 첨부로 cover, 1개 Cloudflare 404 케이스는 별도 path 검증 필요 (endpoint 변경 가능성). spec §L6 pass list 확장 트리거는 약함.

---

## 3. 운영 패턴

### 3.1 Bifrost 등록 — profile별 alias 1~2개 (SHOULD, enforce 아님)

**나쁜 패턴**: Bifrost upstream 5~10개 (`notion_personal`, `slack_work`, …) 를 Palantir 에 alias 5~10개 로 펼치기. → alias 폭발, M2 legacy scan 충돌면, drift 관측 부담.

**좋은 패턴**: Bifrost 의 `?profile=` 쿼리로 도구셋 슬라이스 만들고, **Palantir 에 alias 1~2개만**:
- `bifrost-default` → `http://localhost:3100/mcp`
- `bifrost-readonly` → `http://localhost:3100/mcp?profile=read-only`

워커는 Bifrost 가 이미 만들어준 namespaced 도구를 호출 (`bifrost-default__notion_personal__search_pages`). Bifrost 의 namespacing 가치가 살아남고 Palantir 카디널리티 1~2 유지.

**SHOULD vs MUST 구분**: 코드는 alias 5개 만들어도 막지 않음 (= recommendation 수준). 운영자가 그럴 경우 alias 폭발 / 카디널리티 부담 / drift 관측 부담을 직접 짊어진다는 의미.

### 3.2 토큰 운영

- `BIFROST_MCP_TOKEN` 같은 env 키 이름을 `bearer_token_env_var` 에 등록.
- 실제 값은 운영자가 shell profile (`~/.zshrc`) 또는 `.claude-auth.json` 인접 secrets store 에 둠. Palantir 코드는 값을 다루지 않음.
- 토큰 회전 시: env 값만 갱신 후 워커 재시작. template 자체 변경 없음 → drift 도 발생 안 함.

### 3.3 M4-a 의 supported migration path (BLOCKER 3 fix)

운영자가 기존 stdio template 을 http 로 "옮기는" 시나리오는 M4-a 만으로 다음 manual path 가능:

1. `#mcp-servers` 탭에서 **새 alias** (예: `notion-via-bifrost`) 로 http template 추가.
2. 영향받는 worker_preset 들의 edit modal → `mcp_server_ids` 에서 기존 stdio template id 제거 + 새 http template id 추가 → 저장.
3. 영향받는 skill_pack 들은 `mcp_servers` map 의 alias 키를 수정 (skill pack edit 또는 reinstall).
4. 기존 stdio template 카드의 references 가 0 이 되면 delete (M3-UI 에서 already-supported).

M4-a 는 자동 bulk repoint 도구 미제공 — 1~2개 preset 수동 처리 가능한 사이즈. 운영 preset 이 ~10개 넘는 환경에서 transport 전환이 빈번해지면 **M4-b** (clone-as-other-transport + bulk repoint) 진입 (§7 참조). 즉 M4-a ship 시점에는 "신규 http template 등록" + "manual preset edit 으로 교체" 가 supported, M4-b 가 "1번에 전환" 을 자동화.

---

## 4. 변경 범위 (PR 1개 / 약 8~12 파일 / ~200 LOC + 테스트)

| 영역 | 파일 | 변경 |
|---|---|---|
| migration | `server/db/migrations/022_mcp_template_http_transport.sql` (신규) | transport / url / bearer_token_env_var 컬럼 + 정합성 trigger 2개 (insert / update) |
| service | `server/services/mcpTemplateService.js` | transport 분기 validator (canonical), url ssrf 검사, updated_at 비교 컬럼 추가 |
| flatten | `server/services/managerAdapters/codexMcpFlatten.js` | http 케이스 분기, url 직렬화, transport 키 emit 안 함 |
| **resolver 분기 (r5 SERIOUS)** | `server/services/presetService.js` 의 `buildMcpConfigFromTemplates`, `server/services/skillPackService.js` 의 `resolveMcpServers` (또는 동등 함수) | template row 의 `transport` 별 분기 — `stdio` row → `{ command, args, env? }`, `http` row → `{ url, bearer_token_env_var? }`. 누락 시 HTTP template 이 flatten 까지 도달 못해 silent stdio fallback 발생 |
| ssrf | `server/services/ssrf.js` | `assertSafeUrl(url)` async helper (validator+preflight 공유), localhost allowlist envvar, DNS resolve 결과 반환 (preflight 의 connection pinning 용) |
| auth helper | `server/services/authResolver.js` | `resolveBearerForPreflight(envVarName)` 신규 helper |
| route | `server/routes/mcpTemplates.js` | (변경 없음 — service layer 가 분기 흡수; validator 가 async 가 됐으므로 route 의 `await` 확인) |
| boot seed | `server/services/skillPackService.js` 의 `DEFAULT_MCP_TEMPLATES` upsert | http 케이스 인지 (현재 stdio 만; 추가 default 0 개여도 케이스 처리는 코드에 있어야 함) |
| preflight | `server/services/lifecycleService.js`, `server/services/pmSpawnService.js` (또는 `codexAdapter.js`) | spawn 직전 HEAD preflight + redirect manual + Authorization 첨부 + connection IP pinning (DNS rebinding 방지) |
| UI | `server/public/app/components/McpTemplatesView.js`, `app/lib/copy.js` (MCP_TEMPLATES_LABELS) | transport selector + 동적 필드 + 카드 list 분기 |
| diagnose | `scripts/diagnose-mcp-conflicts.mjs` (`npm run diagnose:mcp` 의 실제 entry, M2-B3) | transport / url / bearer_token_env_var 컬럼 출력 + 값 마스킹 |
| 테스트 | `server/tests/mcp-template-service.test.js` (확장) | http validator, immutable transport/alias, ssrf, trigger ABORT |
|  | `server/tests/codex-mcp-flatten.test.js` (확장) | http emit 검증 (no transport/command, url-only), url 직렬화 |
|  | `server/tests/preset-spawn.test.js` 또는 신규 | http transport preset spawn → flatten args 확인 |
|  | `server/tests/mcp-preflight.test.js` (신규) | preflight 200/4xx/5xx/timeout/redirect/bearer-missing 시나리오 |
|  | `server/tests/ssrf.test.js` (확장) | DNS rebinding, IPv6 literal, punycode, localhost allowlist |

---

## 5. 테스트 plan

### 5.1 unit / integration

- **mcpTemplateService validator**:
  - http 케이스 — url 필수, command/args/allowed_env_keys 거부, bearer_token_env_var ENV_HARD_DENYLIST 검사.
  - stdio 케이스 — url/bearer_token_env_var 거부.
  - **immutable**: alias UPDATE 거부, transport UPDATE 거부 (BadRequest at service, ABORT at trigger 둘 다 검증).
  - migration 022 적용 후 기존 row 들 `transport='stdio'` default 채워졌는지 확인.
- **codexMcpFlatten http 케이스**:
  - url-only cfg → `mcp_servers.<alias>.url=...` 만 emit.
  - url + bearer_token_env_var → 두 args emit, **`transport` arg 없음, `command`/`args`/`env` arg 없음**.
  - http cfg 에 command 있으면 throw (silent vanish 방지).
  - url 직렬화 — 쿼리스트링 (`?profile=read-only`), 인코딩 문자, 한국어 path quoted 정상.
- **ssrf**:
  - DNS resolve 후 private IP 차단 (10.x, 172.16-31, 192.168, 127, 169.254 each).
  - IPv6 literal `[::1]:port`, IPv4-mapped (`::ffff:10.0.0.1`).
  - punycode 호스트, mixed-case → lowercase.
  - localhost allowlist (envvar=1 통과 / unset 통과 / 0 차단).
  - DNS rebinding 시뮬레이션 — multi-A 응답 중 하나 private 이면 차단.
- **preflight**:
  - pass: 200 / 204 / 405 / 501.
  - 4xx (auth 외) / 5xx / timeout / connection refused → fail-closed `preset:mcp_unreachable` (각 reason: "preflight_4xx" / "preflight_5xx" / "preflight_timeout" / "preflight_connect_refused").
  - 3xx redirect → fail-closed reason="redirect_blocked".
  - bearer-protected: env var 있으면 Authorization 첨부 후 200 → pass; env var missing → fail-closed reason="bearer_env_missing".
  - DNS rebinding 시뮬레이션: `assertSafeUrl` 이 public IP 받았으나 fetch 시 다른 lookup 이 private IP 반환 — connection IP pinning 으로 실제 connect 가 검증된 IP 로 가는지 verify (test 가 다른 IP 로 갔으면 regression).
  - `PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP=1` 일 때 preflight skip.
- **env hygiene**:
  - `bearer_token_env_var` 가 spawn env allowlist 에 통과되는지.
  - denylist 와 교집합 시 거부.
  - SSE / diagnose / RunInspector 출력에 env *값* 절대 안 보임 (assertion).

### 5.2 e2e (수동 검증, Bifrost 실제 띄움)

1. Bifrost 띄움 (`http://localhost:3100/mcp`).
2. Palantir UI `#mcp-servers` 에서 `bifrost-default` 등록 (transport=http, url=...).
3. Worker Preset 에 묶음.
4. Task 한 건 실행 → run inspector 에서 `mcp_servers.bifrost-default.url=...` args 확인.
5. 워커가 Bifrost 도구 (`bifrost-default__some_workspace__some_tool`) 호출 성공 확인.
6. (R2) Bifrost 워크스페이스 동적 추가 → 워커가 새 도구 인지하는지 관찰. 결과를 결정 노트에 기록.
7. (R3) Bifrost 종료 → 새 워커 spawn 시 preflight 가 막아주는지 확인.
8. **(L6.1) bearer-protected 시나리오**: Bifrost 에 `BIFROST_MCP_TOKEN` 설정 → Palantir env 에 같은 키 set → preflight + spawn 정상; env unset 시 fail-closed reason="bearer_env_missing" 로그.

### 5.3 회귀

- 기존 stdio template 들 — migration 후 `transport='stdio'` 로 자동 채워지고 모든 기존 테스트 (`codex-mcp-flatten.test.js`, `preset-spawn.test.js`, `mcp-template-service.test.js` 등) PASS.
- 기존 stdio preset spawn 경로에 preflight 가 끼어들지 않는지 (= preflight 는 transport='http' 케이스만).

---

## 6. Non-goals (M4 범위 외)

- **transport 추상화 레이어 / Strategy 패턴** — L1 lock-in 으로 명시 금지.
- **`'sse'` transport enum 값** — `/sse` URL 도 `'http'` 로 처리. 진짜 SSE-only 가 등장하면 후속 phase.
- **MCP `initialize` JSON-RPC preflight** — HEAD only (L6 의 "HEAD only, no OPTIONS fallback" 정책과 lock-step), SDK 호환성 회피.
- **Bifrost 측 변경** — 0건. Bifrost 는 그대로 둠.
- **OAuth / DCR 흐름 Palantir 측 처리** — Bifrost 가 다 흡수. Palantir 은 `bearer_token_env_var` 만 봄.
- **Cloudflare Tunnel / 원격 endpoint 등록** — `url` 이 https://… 인 일반 케이스로 자동 흡수 (ssrf allowlist 가 막지 않으므로 OK). 별도 코드 변경 없음.
- **migration 022 rollback SQL 미제공** — DB migration 022 는 forward-only, rollback SQL 별도 작성 안 함. (단 migration 의 transactional safety / 실패 시 partial state 처리는 in-scope — 기존 `db/migrations` runner 가 각 migration 을 transaction 으로 감싸므로 그 동작에 의존.)
- **M4-b 가 닫을 partial migration risk** — bulk repoint / clone-as-other-transport 자동화는 §7 의 후속.

---

## 7. 후속 / 백로그

- **M4-b — transport migration helper**: M4-a 의 immutable lock 정책을 운영 친화적으로 만드는 후속 phase. Codex M4 r2 cross-check (2026-04-29) 가 짚은 *partial migration risk* (긴급 transport 전환 시 일부 preset 만 이전되는 사고면) 를 닫음. 범위: (a) **clone-as-other-transport** — 카드/edit 모달에 "복제" 액션 추가, 기존 template 옆에 다른 transport 의 새 template 생성 (alias 자동 suffix 또는 운영자 입력), (b) **impacted references 표시** — 새 template 만들 때 원본을 참조하는 worker_presets / skill_packs / 활성 run preset snapshot 목록을 modal 에 노출, (c) **bulk repoint** — 선택한 참조들의 `mcp_server_ids` (preset) / `mcp_servers` (skill pack) 를 한 번에 새 id/alias 로 갈아끼움 + audit event emit, (d) 이전 template 은 delete 가능 상태가 됐을 때 카드에 "참조 0개" 표시. M4-a 만으로도 §3.3 manual path 흐름은 가능하므로 M4-b 는 첫 transport 전환 시나리오 마주칠 때까지 deferred. 예상 PR 사이즈 ~100 LOC.
- **stdio MCP env file transport ✅ 해결 (issue #113)**: env-bearing stdio alias만 실행 노드의 mode-0600 wrapper로 치환하고, Codex argv에는 비밀 없는 leaf와 Node wrapper boot hardening override만 전달. HTTP 경로는 무변경.
- **`'sse'` transport** — SSE-only 원격 MCP 가 등장하거나 Bifrost 가 `/sse` 만 노출하는 운영 모드가 생길 때.
- **dynamic `tools/list_changed` 전파 (M4-c 가칭)** — §L9.1 (post-impl 2026-05-04) 코드 분석 결과 Bifrost `/mcp` 는 *비동기* listChanged 미지원 (POST 응답 범위의 SSE 분기는 가능하지만 GET `/mcp` SSE listening stream / session routing 자체가 없음). Bifrost legacy `/sse` 는 emit 하지만 codex CLI 0.125 의 listener 동작이 미검증. Entry condition: (a) Bifrost 에 GET `/mcp` SSE stream 지원 추가 또는 (b) `/sse` url 으로 등록 — 둘 중 하나가 선결. Completion condition: 어느 경로든 진입 후 codex 가 실제 그 stream 을 listen + LLM 이 새 도구 인지하는지 **E2E 실측 별도 필요**.
- **OAuth-aware MCP template** — Bifrost 가 OAuth 흐름을 흡수하므로 Palantir 은 bearer-only 로 충분. 미래에 Palantir 이 OAuth 토큰 직접 관리할 일이 생기면 별도 phase (지금은 비추 — 책임 경계 어김).
- **Egress proxy / host allowlist** — codex CLI 가 spawn 후 자체 round-trip 시 DNS rebinding / redirect-follow 로 내부망 접근하는 시나리오 (§L4.1.1 의 residual risk) 를 닫는 후속. 강한 end-to-end SSRF 보장이 필요해질 때 별도 phase.

---

## 8. 결정 / lock-in 출처

- **2026-04-29 r1**: Claude (opus-4.7) 1차 분석 + Claude self-review (외부 어댑터 접근 불가) + Codex CLI (gpt-5.5, codex-cli 0.125.0) cross-check → A/B/C 옵션에 대해 **B 정렬**, B-lite 가드레일 + profile 기반 운영 패턴 + env hygiene risk 추가 lock-in.
- **2026-04-29 r2**: Codex CLI (gpt-5.5) cross-check on transport-immutable 결정 → **lock 유지**, partial migration risk 인지 + M4-b deferred 결정.
- **2026-04-30 r3**: Codex CLI (gpt-5.5) third-pass spec review → BLOCKER 3 (preflight auth / SSRF 정책 / M4-a migration path) + SERIOUS 5 + NIT 5 식별. r2 spec 이 13개 항목 반영.
- **2026-04-30 r4**: Codex CLI (gpt-5.5) fourth-pass review on r2 → r2 의 13개 ✓ 확인 + 신규 BLOCKER 1 (`command NOT NULL` 충돌 — table rebuild 필요) + 신규 SERIOUS 3 (UPDATE trigger column-shape, SSRF residual risk, preflight method 순서) + 신규 NIT 3 (header version, "neue" 오타, hostname 정규화 단계 분리). r3 spec 이 모든 항목 반영.
- **2026-04-30 r5**: Codex CLI (gpt-5.5) fifth-pass review on r3 → r3 의 7개 ✓ 6 + 부분 1 (HEAD/OPTIONS 잔존 표현) + 신규 BLOCKER 1 (preflight DNS TOCTOU — connection IP pinning 필요) + 신규 SERIOUS 2 (resolver 분기 누락 / `assertSafeUrl` async 계약) + 신규 NIT 3 (whitespace-only check, 501 누락, diagnose 파일명). r4 spec 이 모든 항목 반영.
- **2026-04-30 r6**: Codex CLI (gpt-5.5) sixth-pass review on r4 → 7개 ✓ 6 + 부분 1 (Non-goals HEAD/OPTIONS 잔존 표현) + 신규 BLOCKER 0 + 신규 SERIOUS 0. 본 r4 spec final 한 줄 wording 수정 (Non-goals → "HEAD only" lock-step) 후 r7 PASS 확인.
- **2026-04-30 r7**: Codex CLI (gpt-5.5) seventh-pass — final READY verdict. spec lock-in 종결.
- **2026-05-04 post-impl**: M4-a 머지 (PR #172) 후 첫 실 use case (mcp-bifrost) 로 §L9 R2 부분 검증. ① Bifrost initialize 응답에 `capabilities.tools.listChanged: true` 정상 advertise. ② mcp-bifrost issue #3 / PR #4 (HEAD `/mcp` → `405 Allow: POST`) 머지 후 spec §L6 preflight pass list 와 정합. ③ codex CLI 0.125 가 startup 시 자동 `tools/list` 호출 + model context 주입 + LLM 자율 `mcp_tool_call` 까지 직접 검증 — 본 phase 핵심 가치 충족. ④ 동적 워크스페이스 추가 시 listChanged notification 인지는 미검증 (M4-c 후보). ⑤ 운영 가이드 신규: `docs/runbook-m4a-bifrost-setup.md` (PR #176). 부수 fix: `diagnose-mcp` default DB path → `server/palantir.db` (PR #175). 본 verification 결과 §L9.1 에 inline 등록.
- **2026-05-04 post-impl (extended, PR #178)**: §L9.1 매트릭스 확장. (a) 외부 hosted MCP 6개 endpoint (Linear / Notion 공식 / Sentry / GitHub Copilot / Atlassian / Cloudflare) anon HEAD 응답 직접 probe — 본 6개 케이스 중 5개가 401 (RFC 7235 패턴의 일반적 구현 선택), 1개 (Cloudflare) 가 404 (Authorization 첨부 비해당, 별도 path 확인 필요로 분리). spec §L6.1 의 Authorization 헤더 첨부 정책으로 5/6 케이스 cover, pass list 확장 트리거 약함. (b) Bifrost listChanged emit 메커니즘 코드 분석 — `/mcp` 는 GET SSE stream / session routing 부재로 *비동기* listChanged 미지원, legacy `/sse` 는 `broadcastNotification` 으로 emit 정상 (코드 검증). codex CLI 의 GET-SSE / legacy SSE listener 실측은 사용자 환경 액션 대기. M4-c entry + completion condition 정밀화 (§7 갱신).
- 본 brief 가 spec 단일 출처. 변경 시 brief 갱신 → 사용자 OK → 구현 PR.
