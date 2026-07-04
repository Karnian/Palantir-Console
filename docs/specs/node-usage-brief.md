# Node Usage — 노드별 CLI 사용량 브리프 (U 트랙)

> 상태: **v1.1** (2026-07-04, Codex 적대 리뷰 REVISE 반영 — BLOCKER 2 + SERIOUS 6 + NIT 1 전부 수용).
> 사용자 방향: "에이전트 사용량은 각 노드 페이지로 넘겨서, 노드 안에 설치된
> CLI 들의 사용량을 보는 식으로". 의미/기존표면 결정은 권장안 자동 채택 (자율 모드):
> ①사용량 = **한도/쿼터 스냅샷** (토큰 소비 히스토리는 비범위·후속) ②기존 usage 표면(Sessions
> Codex Status 모달, AgentsView usage 바)은 **유지 후 후속 정리**.

## 1. 문제

현재 usage 는 전부 컨트롤 플레인(Mac) 로컬 전용이다:

- `codexService.getStatus()` — **로컬** `codex app-server` spawn + JSON-RPC (`account/read`,
  `account/rateLimits/read`)
- `providers/claude-code.js` — **로컬** keychain/env 토큰 + `claude auth status` + Anthropic OAuth
  usage 엔드포인트 curl
- `providers/gemini.js`, `anthropic.js` — 동일하게 로컬 자원만 참조
- 표면: `/api/usage/providers` (Sessions 의 UsageModal), `/api/agents/:id/usage` (AgentsView)

Fleet (P1~P5) 이후 실체가 바뀌었다: **pod 마다 `~/.codex` / `~/.claude` 인증이 따로** 있고
(runbook 선로그인), 쿼터·플랜·잔여 한도는 노드×CLI 단위로 다르다. 지금 UI 는 이 실체를 표현하지
못한다 — Mac 의 쿼터만 보인다.

## 2. 목표 (v1)

`#resources/nodes/<id>` 노드 상세 페이지에서, 해당 노드에 설치된 에이전트 CLI 별
**한도/쿼터 스냅샷**을 카드로 조회.

- 데이터 의미는 기존 provider envelope 그대로: `{ limits: [{label, remainingPct, resetAt,
  errorMessage?}], account, updatedAt }`. 새 의미 발명 금지.
- local 노드 = 기존 로컬 경로와 **동일 데이터** (byte-equivalent 소스: providerRegistry +
  codexService).
- ssh 노드 = **pod 가 authoritative** — 인증/CLI/쿼터 전부 pod 자원으로 판정. 토큰을 컨트롤
  플레인으로 가져오지 않는다.

## 3. 설계

### 3.1 Backend (U-1) — `nodeUsageService` + `GET /api/nodes/:id/usage`

응답 shape (**wire-lock** — Codex 리뷰 S5 반영, 테스트가 이 shape 를 고정):

```json
{
  "node": { "id": "pi", "name": "Raspberry Pi", "kind": "ssh", "reachable": 1 },
  "clis": [
    {
      "id": "codex",
      "installed": true,
      "version": "codex-cli 0.140.0",
      "usage": { "limits": [...], "account": {...}, "updatedAt": "..." },
      "authStatus": null,
      "error": null,
      "updatedAt": "..."
    },
    {
      "id": "claude",
      "installed": true,
      "version": "2.1.179",
      "usage": null,
      "authStatus": { "loggedIn": true, "email": "...", "planType": "..." },
      "error": { "code": "quota_unsupported", "message": "claude 쿼터 조회는 후속 (v2)" },
      "updatedAt": "..."
    }
  ],
  "updatedAt": "..."
}
```

- **`error` 는 항상 `null` 또는 `{ code, message }`** (string 금지). code enum 고정:
  `not_installed` | `probe_failed` | `timeout` | `transport_lost` | `no_data` |
  `not_logged_in` | `quota_unsupported`. message 는 sanitized — 원격 stderr 원문 금지
  (cap 후 요약), secret/토큰 절대 미포함. `installed=false` shape 고정:
  `{ id, installed:false, version:null, usage:null, authStatus:null,
  error:{code:'not_installed',…}, updatedAt }`. `usage:null` = "한도 데이터 없음, 이유는
  error 가 설명". `authStatus` 필드는 모든 카드에 존재 (codex 는 null). 카드마다
  per-card `updatedAt`.
- **local 노드**: `codexService.getStatus()` + providerRegistry 의 claude-code/gemini fetch 재사용.
  기존 `/api/usage/providers` 와 같은 소스 — 포장만 CLI-per-card 로.
  **로컬 서비스가 던지는 AppError(404 'No rate limit data' 등)는 라우트로 새면 안 됨** —
  per-CLI catch 에서 `error:{code:'no_data'}` 로 변환 (S6). HTTP 404 는 오직 node 미존재.
- **ssh 노드 · codex**: `executor.spawnInteractive('codex', ['app-server'], { env: {},
  pathPrefix: node.node_prefix })` 로 pod 에 app-server 를 띄우고 JSON-RPC **3콜**
  (`initialize` → `account/read` → `account/rateLimits/read` — 로컬 경로와 동일 시퀀스,
  S2) 후 종료. limits 파싱은 codexService 의 `formatLimits` 를 export 해 공유 (재구현 금지),
  로컬 경로는 byte-equivalent 유지.
- **단발 probe primitive (BLOCKER 1 해소)**: spawnInteractive 의 raw child 를 호출부가
  직접 다루지 않는다. `nodeUsageService` 내부 one-shot 헬퍼가 보장:
  timeout(기본 15s) → SIGTERM → grace 후 SIGKILL escalation, stdout/stderr cap
  (256KB, 초과 시 kill + `probe_failed`), settle-once, exit 시 pending RPC reject,
  stdin graceful close 후 close 대기, ssh exit 255 = `transport_lost`.
  child cleanup 은 항상 finally (HTTP 요청 abort 포함 어떤 경로에서도 orphan ssh 금지).
  원격 스크립트가 `exec` 치환이라 ssh 종료 시 pod 프로세스는 SIGHUP 으로 정리되지만,
  이에 의존하지 않고 클라이언트 쪽 kill 을 항상 수행.
- **원격 env 계약 (BLOCKER 2 해소)**: 원격 probe env 는 **기본 `{}`** — `process.env`
  spread 절대 금지 (컨트롤 플레인 secret/PATH 유출, P4 실증 버그 클래스). 필요 시
  `LC_ALL=C` 같은 비밀 아님 키만 명시.
- **신규 원격 실행 표면 인지 (S1)**: public exec allowlist `['git']` 불변이지만, 이 기능은
  `spawnInteractive` 표면의 **신규 호출자**다 — "표면 변경 0" 이라고 안심하지 않는다.
  `nodeUsageService` 는 CLI 별 **고정 command+args 상수만** 실행
  (`codex app-server` / `codex --version` / `claude --version` / `claude auth status`).
  사용자 입력은 command/args 에 절대 불류입 (nodeId 는 DB lookup 전용).
- **CLI 설치/버전 감지 (ssh, S3)**: `--version` 한 턴도 단발 probe primitive 경유
  (timeout/cap/exit-code 해석 동일 규율). **exit 127 만** `not_installed` — spawn/전송측
  throw 는 CLI 부재의 증거가 아니므로 `probe_failed` (R2 수정: 오분류 방지).
  timeout = `timeout`, 그 외 nonzero = `probe_failed`. `pathPrefix: node.node_prefix`
  전달 필수 — pod 의 codex/claude 는 login PATH 밖 (false negative 방지).
- **구현 R2 반영 명시 사항**: ①output cap 256KB 는 **stdout+stderr 합산** ②`node_prefix` 는
  고정 command+args 원칙의 유일한 가변 인자 예외 — executor 의 spawnInteractive 가
  절대 POSIX 경로 + control-char 거부 검증(P4-S1) + shq 인용을 보장하므로 수용
  ③진짜 not-logged-in pod 는 v1 에서 `probe_failed` 로 표면화 (codex JSON-RPC 에
  안정적 auth error code 가 없고 `requiresOpenaiAuth` 단독 매핑은 false positive —
  실 Pi 실증: ChatGPT 로그인 pod 가 true + 정상 limits. 코드 `not_logged_in` 은
  claude 경로 전용) ④원격 probe 의 `accountError` 는 sanitized message 만 통과
  (로컬 provider 경로는 기존 표면 동일 수위 유지) ⑤`pickExecutor` throw 도 카드
  error (HTTP 500 금지) ⑥동시 ssh 는 요청당 최대 2 (카드 병렬 × 카드 내 순차) —
  수동 새로고침 전용이라 per-node semaphore 는 v2.
- **ssh 노드 · claude (S4)**: v1 은 pod 에서 `claude auth status` 실행 → stdout cap +
  JSON parse + **allowlisted 필드만** 반환 (`loggedIn`, `email`, `planType`, `orgName` —
  그 외 필드 drop). 쿼터 조회는 pod 토큰 반출 금지 원칙상 v1 비범위 (open question §5)
  → `error:{code:'quota_unsupported'}`.
- **fail-soft 계약**: unreachable 노드 / CLI 미설치 / 미로그인 / RPC 실패 → 해당 CLI 카드의
  `error` 로 표현. 라우트는 200 + partial 데이터. HTTP 404 는 node 미존재만.
  probe 는 절대 서버를 죽이거나 다른 CLI 카드를 오염시키지 않는다 (per-CLI try/catch,
  카드 간 독립).
- **라우트 순서 (NIT)**: `GET /:id/usage` 는 `GET /:id` 보다 앞에 등록 (agents 라우트 관례).
- **캐시**: v1 없음 (수동 새로고침 버튼). 자동 폴링 금지 — spawn 비용이 실재.

### 3.2 UI (U-2) — NodesView 상세 전환

- 라우팅: `#resources/nodes/<id>` — `app.js` 의 resources 분기가 `route.split('/')[2]` 를
  `NodesView` 에 `detailId` 로 전달. 카드 클릭(또는 "상세" 버튼) → 해시 변경.
  뒤로 = `#resources/nodes`.
- 상세 페이지 구성: 노드 메타 헤더 (name/kind/reachable/last_heartbeat/ssh 정보) +
  CLI usage 카드 그리드 (SessionsView 의 UsageCard 마크업/토큰 재사용 또는 공용 추출) +
  새로고침 버튼.
- 디자인 토큰 준수 (인라인 색 하드코딩 금지 — K-2 계약), `data-role` selector 로 e2e 대응.
- a11y·visual e2e: 신규 route 시나리오 추가. **nav/전역 chrome 은 불변**이므로 기존 baseline
  churn 없음 — 신규 route baseline 만 추가 (PF-2 교훈 준수).
- 기존 UsageModal / AgentsView usage 는 이번 PR 에서 **불변**.

## 4. 슬라이스

- **U-1**: backend — nodeUsageService + 라우트 + 테스트 (fake executor 로 ssh 분기,
  로컬 분기는 기존 서비스 주입). 실 Pi 검증 필수 (fake 는 전송 의미를 못 잡는다 — P2 #283 교훈).
- **U-2**: UI — 상세 페이지 + e2e. U-1 머지 후.

## 5. Open questions (후속)

1. **claude 쿼터 on pod**: ✅ **v2 구현됨** — `remoteSshExecutor.readClaudeOAuthUsage()`:
   **고정 상수 스크립트**(caller 입력 불개입)가 pod 안에서 `~/.claude/.credentials.json` 을
   읽고 pod 안에서 OAuth usage 엔드포인트를 curl — **토큰은 pod 밖으로 절대 안 나옴**
   (usage JSON 만 회수, exit 3=`not_logged_in`). limits 파싱은 claude-code 어댑터의
   `parseOAuthUsageLimits` 공유 (utilization 신호 있는 항목만 — `limits`/`spend` 메타 키
   열거 버그도 동시 수정, 로컬/에이전트 표면 포함). reader 없는 executor(주입 fake 등)는
   v1 `quota_unsupported` 폴백. pod 요건: node + curl (기존 문서화 요건).
2. **토큰 소비 히스토리** (ccusage-식): pod 세션 로그 파싱 — 별도 트랙.
3. 기존 usage 표면 (Sessions 모달 / AgentsView) 의 노드 페이지 링크 대체/제거.
4. gemini: local 은 registry 에 이미 있음. pod 에 gemini 설치 시나리오가 생기면 동일 패턴.
