# MCP Worker/PM 접근 방안 제안서

> 작성일: 2026-04-09
> 최종 수정: 2026-04-10
> 상태: Phase 1 완료 (feat/p3-mcp-access)

## 1. 현재 상황 분석

### 1.1 MCP 설정 구조

Claude Code CLI의 MCP 서버 설정은 다음 경로에서 관리된다:

| 위치 | 용도 | 현재 내용 |
|------|------|-----------|
| `~/.claude/.mcp.json` | 글로벌 MCP 서버 설정 | Slack, Notion (HTTP URL 기반) |
| 프로젝트 `.mcp.json` | 프로젝트별 MCP 설정 | (미사용) |
| `~/.claude/plugins/` | 플러그인 마켓 MCP 설정 | Context7, GitHub, Linear 등 |

글로벌 `.mcp.json` 예시:
```json
{
  "mcpServers": {
    "slack": { "url": "https://server.smithery.ai/slack/mcp" },
    "notion": { "url": "https://mcp.notion.com/mcp" }
  }
}
```

MCP 서버는 두 가지 유형:
- **HTTP 기반** (Slack, Notion): URL + OAuth 인증
- **Command 기반** (Context7): `npx -y @upstash/context7-mcp` 같은 로컬 프로세스

### 1.2 현재 코드 경로

#### Manager (Claude adapter) — `claudeAdapter.js`
```
startSession() → streamJsonEngine.spawnAgent()
```
- `streamJsonEngine.buildArgs()`에 `--mcp-config` 플래그 지원이 **이미 구현되어 있음** (streamJsonEngine.js:93-95)
- 하지만 `claudeAdapter.startSession()`은 `mcpConfig`를 전달하지 않음
- `routes/manager.js`의 `/api/manager/start`도 mcpConfig를 받지 않음

#### Worker (Claude) — `lifecycleService.js:executeTask()`
```
executeTask() → streamJsonEngine.spawnAgent() (Claude worker)
             → executionEngine.spawnAgent()   (기타 에이전트)
```
- streamJsonEngine 경로: `mcpConfig` 파라미터를 전달하지 않음
- executionEngine 경로: MCP 개념 자체가 없음 (tmux/subprocess에 CLI 명령 실행)

#### PM (Claude/Codex adapter) — `pmSpawnService.js`
- `claudeAdapter.startSession()`을 호출하므로 Manager와 동일한 제약

### 1.3 핵심 문제

1. **`--mcp-config` 파이프라인 끊김**: streamJsonEngine에 지원 코드가 있지만, adapter → route 체인에서 값이 전달되지 않음
2. **CLI 기본 동작 의존**: Claude Code CLI는 spawn 시 `~/.claude/.mcp.json`을 **자동 로드**함. 즉, Manager를 실행한 사용자의 홈 디렉토리에 .mcp.json이 있으면 Manager 프로세스는 이미 MCP에 접근 가능
3. **Worker/PM도 동일 사용자로 실행**: Palantir Console이 같은 머신에서 실행되므로, spawn된 Claude Code 프로세스도 `~/.claude/.mcp.json`을 읽음
4. **실제 차단 원인**: MCP 도구가 Worker의 `allowedTools` 목록에 없음

---

## 2. 검증: 실제로 무엇이 차단하는가?

### 가설 A: CLI가 .mcp.json을 로드하지 않는다 → **거짓**
Claude Code CLI는 `~/.claude/.mcp.json`을 자동 탐색. spawn된 자식 프로세스도 동일 HOME을 상속하므로 MCP 서버 연결 자체는 가능.

### 가설 B: MCP 도구가 allowedTools에 포함되지 않아 사용 불가 → **유력**
- Manager: `allowedTools` = `['Bash(curl:*)', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']` — MCP 도구 없음
- Worker: `permissionMode: 'bypassPermissions'`만 설정, `allowedTools` 미지정 (기본값 = 전부 허용)
- PM: Manager와 동일한 allowedTools 제약

### 가설 C: OAuth 인증 세션이 프로세스간 공유 안 됨 → **부분 유력**
- HTTP MCP 서버 (Slack, Notion)는 OAuth 토큰이 필요
- 이 토큰은 `~/.claude/` 아래 저장되어 프로세스 간 공유 가능할 수 있음
- 하지만 인메모리 세션 쿠키 기반이면 프로세스마다 재인증 필요

---

## 3. 방안 비교

### 방안 A: allowedTools에 MCP 도구 추가 (최소 변경)

**개요**: 기존 파이프라인 그대로 활용. Agent profile 또는 Manager/PM의 allowedTools 목록에 MCP 도구명을 추가.

**구현**:
1. `agentProfileService`의 `capabilities_json`에 `mcp_tools: ["mcp__slack__*", "mcp__notion__*"]` 필드 추가
2. `claudeAdapter.startSession()`에서 allowedTools 빌드 시 MCP 도구 병합
3. Worker의 `lifecycleService.executeTask()`에서 profile의 MCP 도구를 allowedTools로 전달

**장점**:
- 변경량 최소 (~30줄)
- CLI가 이미 .mcp.json을 자동 로드하므로 별도 MCP 연결 불필요
- Agent profile 단위로 세밀한 제어 가능

**단점**:
- MCP 도구명이 CLI 버전에 따라 달라질 수 있음
- OAuth 재인증 문제가 남을 수 있음 (검증 필요)
- 프로젝트별 MCP 설정 분리 불가

**복잡도**: ★☆☆☆☆

---

### 방안 B: --mcp-config 파이프라인 완성

**개요**: 이미 streamJsonEngine에 구현된 `--mcp-config` 플래그를 adapter → route → DB까지 연결.

**구현**:
1. `projects` 테이블에 `mcp_config_path` 컬럼 추가 (마이그레이션 011)
2. `claudeAdapter.startSession()`에 `mcpConfig` 파라미터 전달
3. `codexAdapter`도 `--mcp-config` 대응 추가 (Codex CLI 지원 여부 확인 필요)
4. `lifecycleService.executeTask()`에서 project의 mcp_config_path를 spawn에 전달
5. UI: 프로젝트 설정에서 MCP config 파일 경로 입력

**장점**:
- 프로젝트별 MCP 설정 분리 가능
- 글로벌 .mcp.json과 독립적으로 운영 가능
- CLI의 공식 인터페이스 사용

**단점**:
- 변경량 중간 (~100줄 + 마이그레이션 + UI)
- MCP config 파일을 사용자가 별도로 관리해야 함
- Codex CLI의 --mcp-config 지원 미확인

**복잡도**: ★★☆☆☆

---

### 방안 C: Palantir Console을 MCP Proxy로 운영

**개요**: Palantir Console 서버가 MCP 클라이언트를 내장. Worker/PM은 Palantir API를 통해 간접적으로 MCP 도구 호출.

**구현**:
1. `server/services/mcpProxyService.js` 신규 — MCP 서버 연결 풀 관리
2. `server/routes/mcp.js` 신규 — `POST /api/mcp/:server/:tool` 프록시 엔드포인트
3. Worker의 system prompt에 MCP 대신 REST API 호출 지시
4. Manager/PM에 Bash(curl:*) 또는 WebFetch로 프록시 호출 허용

**장점**:
- 인증 토큰 중앙 관리 (프로세스마다 재인증 불필요)
- MCP 호출 감사 로그 가능
- CLI 종류(Claude/Codex/OpenCode)에 무관하게 동작
- Rate limiting, 캐싱 등 부가 기능 추가 가능

**단점**:
- 구현 복잡도 높음 (~500줄+)
- MCP SDK 의존성 추가 필요 (`@modelcontextprotocol/sdk`)
- Worker가 native MCP 도구 대신 REST API를 호출해야 함 (UX 저하)
- system prompt에 API 사용법을 주입해야 하므로 토큰 소비 증가

**복잡도**: ★★★★☆

---

### 방안 D: 동적 .mcp.json 생성 + 주입

**개요**: Worker/PM spawn 시 임시 .mcp.json을 생성하고 `--mcp-config`로 전달. spawn 종료 시 정리.

**구현**:
1. `server/services/mcpConfigService.js` 신규 — 프로젝트/에이전트별 MCP config 빌드
2. DB에 `project_mcp_servers` 테이블 (프로젝트 × MCP 서버 매핑)
3. spawn 시 temp file 생성 → `--mcp-config /tmp/palantir-mcp-<runId>.json`
4. `disposeSession()` 또는 run 종료 시 temp file 삭제

**장점**:
- 프로젝트 × 에이전트 단위 세밀한 MCP 설정
- CLI native MCP 통합 유지 (도구가 자연스럽게 노출)
- Codex adapter의 `instructionsPath` 패턴과 동일한 lifecycle 관리

**단점**:
- DB 스키마 확장 필요
- OAuth 토큰은 여전히 .claude/ 기반 → 별도 관리 필요
- temp file 누수 방지 로직 필요

**복잡도**: ★★★☆☆

---

## 4. 비교 요약표

| 기준 | A: allowedTools | B: --mcp-config 파이프라인 | C: MCP Proxy | D: 동적 config 생성 |
|------|:-:|:-:|:-:|:-:|
| 구현 복잡도 | **★** | ★★ | ★★★★ | ★★★ |
| 변경 파일 수 | 2-3 | 5-6 | 8-10+ | 6-7 |
| 프로젝트별 MCP 분리 | ✗ | ✓ | ✓ | ✓ |
| 에이전트별 MCP 제어 | ✓ | △ | ✓ | ✓ |
| CLI 종류 무관 | ✗ (Claude only) | △ (CLI 지원 의존) | **✓** | △ (CLI 지원 의존) |
| 인증 중앙 관리 | ✗ | ✗ | **✓** | ✗ |
| 감사 로그 | ✗ | ✗ | **✓** | ✗ |
| Native 도구 UX | **✓** | **✓** | ✗ (REST fallback) | **✓** |
| 보안 (최소 권한) | ✓ | ✓ | **✓** | ✓ |
| OAuth 재인증 불필요 | △ (검증 필요) | △ | **✓** | △ |

---

## 5. 권장안: A → B 단계적 적용

### Phase 1: 방안 A (즉시 적용 가능)

**근거**:
- 현재 가장 유력한 차단 원인은 allowedTools 제약
- Claude Code CLI가 `~/.claude/.mcp.json`을 자동 로드하므로, allowedTools만 열면 MCP 도구 접근 가능
- 변경량 최소, 리스크 최소

**구현 계획**:
```
1. agentProfileService — capabilities_json에 mcp_tools 배열 지원 추가
2. claudeAdapter.startSession() — PM의 allowedTools에 MCP 도구 병합
3. lifecycleService.executeTask() — Worker spawn 시 profile의 MCP 도구 전달
4. UI — Agent profile 편집에서 MCP 도구 선택 (또는 텍스트 입력)
```

**구현 완료** (P3-4 + P3-5, feat/p3-mcp-access):
- [x] `agentProfileService` — `capabilities_json.mcp_tools` 배열 지원 (스키마 변경 없음, TEXT 컬럼 그대로)
- [x] `claudeAdapter.startSession()` — `mcpTools` 파라미터로 base allowedTools에 MCP 도구 병합
- [x] `lifecycleService.executeTask()` — `parseMcpTools()` 헬퍼로 Worker spawn 시 profile MCP 도구 allowedTools 전달
- [x] `routes/manager.js` — Top manager /start 시 resolved profile의 mcp_tools를 startSession에 전달
- [x] `pmSpawnService.js` — PM spawn 시 codex profile의 mcp_tools를 adapter.startSession에 전달
- [x] UI — Agent profile 편집 모달에 MCP Tools 텍스트에어리어 추가 + detail modal에 표시

**미결 검증 항목**:
- [ ] Worker(Claude)에서 Notion 검색 도구 호출 성공 여부
- [ ] PM에서 Slack 메시지 전송 도구 호출 성공 여부
- [ ] OAuth 토큰이 자식 프로세스에 자동 전달되는지 확인
- [ ] Codex worker에서 MCP 도구 접근 가능 여부

### Phase 2: 방안 B (프로젝트별 분리 필요 시)

Phase 1 검증 후, 프로젝트별 MCP 설정 분리가 필요하면 B로 확장:
- `projects.mcp_config_path` 컬럼 추가
- spawn 체인에 mcpConfig 전달 완성
- UI에서 프로젝트별 MCP config 경로 설정

### Phase 3: 방안 C (장기 — 멀티 테넌트 / 감사 필요 시)

MCP 호출 감사, rate limiting, 멀티 사용자 환경이 필요해지면 Proxy 방식으로 전환.

---

## 6. Phase 1 상세 구현 가이드

### 6.1 Agent Profile에 MCP 도구 필드 추가

`agentProfileService.js` — `capabilities_json` 활용:
```json
{
  "capabilities_json": "{\"mcp_tools\": [\"mcp__claude_ai_Notion__*\", \"mcp__claude_ai_Slack__*\"]}"
}
```

### 6.2 Worker spawn 시 MCP 도구 주입

`lifecycleService.js:executeTask()` (약 149행):
```js
// 현재
result = streamJsonEngine.spawnAgent(run.id, {
  prompt,
  cwd,
  env: parseEnvAllowlist(profile.env_allowlist),
  permissionMode: 'bypassPermissions',
  isManager: false,
});

// 변경 — allowedTools에 MCP 도구 추가
const mcpTools = parseMcpTools(profile.capabilities_json);
result = streamJsonEngine.spawnAgent(run.id, {
  prompt,
  cwd,
  env: parseEnvAllowlist(profile.env_allowlist),
  permissionMode: 'bypassPermissions',
  allowedTools: mcpTools.length > 0 ? mcpTools : undefined,
  isManager: false,
});
```

### 6.3 Manager/PM allowedTools 확장

`claudeAdapter.startSession()` (약 230행):
```js
allowedTools: allowedTools || [
  'Bash(curl:*)', 'Bash(jq:*)', 'Bash(ls:*)', 'Bash(pwd:*)',
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  // MCP 도구 — 필요 시 여기에 추가하거나 파라미터로 주입
],
```

### 6.4 주의사항

1. **MCP 도구명 규칙**: Claude Code에서 MCP 도구명은 `mcp__<server>__<tool>` 형식. allowedTools에 와일드카드 지원 여부 확인 필요.
2. **보안**: Manager의 capability diet (파일 수정 금지) 원칙은 유지. MCP 도구 중 파일 쓰기 기능이 있는 것은 별도 검토.
3. **Codex 호환**: Codex CLI의 MCP 지원 여부를 별도 확인해야 함. Codex는 `--mcp-config`가 아닌 다른 메커니즘일 수 있음.

---

## 7. 미결 사항 (추가 조사 필요)

| 항목 | 상태 | 비고 |
|------|------|------|
| Claude CLI --mcp-config의 allowedTools 와일드카드 지원 | ✅ 확인됨 | `--allowed-tools "mcp__claude_ai_Slack__*"` 와일드카드 동작 확인 (2026-04-10). 13개 Slack 도구 전부 노출 |
| OAuth 토큰 자식 프로세스 자동 전달 | 미확인 | HTTP MCP는 OAuth — spawn 프로세스가 자동 인증되는지 |
| Codex CLI의 MCP 지원 여부 | 미확인 | Codex exec에서 MCP 도구가 노출되는지 |
| MCP command 기반 서버의 자식 프로세스 전파 | 미확인 | npx 기반 서버가 spawn마다 새로 뜨는지 |
| Worker에서 allowedTools 미지정 시 MCP 도구 자동 노출 여부 | 미확인 | bypassPermissions + 미지정 = 전부 허용이면 이미 동작할 수 있음 |

> **최우선 검증**: Worker를 `permissionMode: 'bypassPermissions'` + `allowedTools` 미지정으로 spawn하고, Worker가 MCP 도구를 인식하는지 확인. 인식한다면 방안 A의 대부분은 이미 동작 중이며, Manager/PM의 allowedTools 화이트리스트에 추가하는 것만 남음.
