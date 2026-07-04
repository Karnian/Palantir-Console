# Node Usage — 노드별 CLI 사용량 브리프 (U 트랙)

> 상태: v1 draft (2026-07-04). 사용자 방향: "에이전트 사용량은 각 노드 페이지로 넘겨서, 노드 안에 설치된
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

응답 shape (고정):

```json
{
  "node": { "id": "pi", "name": "Raspberry Pi", "kind": "ssh", "reachable": 1 },
  "clis": [
    {
      "id": "codex",
      "installed": true,
      "version": "codex-cli 0.140.0",
      "usage": { "limits": [...], "account": {...}, "updatedAt": "..." },
      "error": null
    },
    {
      "id": "claude",
      "installed": true,
      "version": "2.1.179",
      "usage": null,
      "error": null,
      "authStatus": { "loggedIn": true, "email": "...", "planType": "..." }
    }
  ],
  "updatedAt": "..."
}
```

- **local 노드**: `codexService.getStatus()` + providerRegistry 의 claude-code/gemini fetch 재사용.
  기존 `/api/usage/providers` 와 같은 소스 — 포장만 CLI-per-card 로.
- **ssh 노드 · codex**: `executor.spawnInteractive('codex', ['app-server'])` — **기존 manager
  allowlist `{codex, claude}` 안이라 executor 표면 변경 0**. JSON-RPC 두 콜
  (`account/read`, `account/rateLimits/read`) 후 stdin 닫고 kill. `codexService` 의
  AppServerSession 프로토콜 로직을 executor-주입 가능하게 추출(또는 최소 재구현) —
  로컬 경로는 byte-equivalent 유지.
- **ssh 노드 · claude**: v1 은 **presence + auth 상태만** (`installed`, `version`,
  `authStatus`). 쿼터 조회는 OAuth usage 엔드포인트 호출이 필요한데 pod 토큰
  (`~/.claude/.credentials.json`) 이 exposed_roots 밖이라 `executor.readFile` 로 못 읽고
  (의도된 가드), 토큰 반출 금지 원칙상 pod-side curl 이 필요 → **open question §5,
  v1 비범위**. fallback 카드: "쿼터 조회는 codex 만 지원 (claude 는 후속)".
- **CLI 설치/버전 감지 (ssh)**: `spawnInteractive` 로 `codex --version` / `claude --version`
  한 턴 실행 (allowlist 안). 127/spawn 실패 = not installed.
- **fail-soft 계약**: unreachable 노드 / CLI 미설치 / 미로그인 / RPC 실패 → 해당 CLI 카드의
  `error` 필드로 표현. 라우트는 200 + partial 데이터. 단, node 자체가 없으면 404.
  probe 는 절대 서버를 죽이거나 다른 CLI 카드를 오염시키지 않는다 (per-CLI try/catch).
- **보안 계약 (불변식)**: public exec allowlist `['git']` **불변**. 새 원격 실행은 기존
  `spawnInteractive` manager allowlist 안에서만. 응답에 토큰/secret 절대 미포함
  (account email/plan 은 허용 — 기존 로컬 표면과 동일 수위). timeout 필수 (probe 당 ≤15s).
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

1. **claude 쿼터 on pod**: 토큰 반출 없이 pod 에서 OAuth usage 엔드포인트를 때리려면
   executor-owned 내부 probe(스크립트) 신설이 필요 — public allowlist 확장 없이 가능하지만
   신규 원격 실행 표면이므로 Codex 보안 리뷰 필수. v2 후보.
2. **토큰 소비 히스토리** (ccusage-식): pod 세션 로그 파싱 — 별도 트랙.
3. 기존 usage 표면 (Sessions 모달 / AgentsView) 의 노드 페이지 링크 대체/제거.
4. gemini: local 은 registry 에 이미 있음. pod 에 gemini 설치 시나리오가 생기면 동일 패턴.
