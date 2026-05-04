# M4-a Bifrost 연동 Runbook

> Last updated: 2026-05-04 (post PR #175 — diagnose-mcp default DB path fix)
>
> 본 문서는 Palantir Console 의 M4-a (MCP Streamable HTTP transport, PR #172) 가 실 endpoint (mcp-bifrost) 와 연동되는 셋업·검증·트러블슈팅 흐름을 정리한다. 참조 spec: [`docs/specs/m4-mcp-http-streamable-transport-brief.md`](./specs/m4-mcp-http-streamable-transport-brief.md). 본 runbook 은 spec 의 추상적 운영 패턴 (§3) 을 실 케이스 (Bifrost) 에 매핑한다.

---

## 1. 사전 요구사항

| 요소 | 확인 방법 | 비고 |
|---|---|---|
| Palantir Console main 코드 | `git log -1 --oneline` 가 PR #172 (`cf96f9e`) 이후인지 | M4-a 머지 후 |
| schema_version | `sqlite3 server/palantir.db "SELECT COALESCE(MAX(version),0) FROM schema_version;"` 가 22 | migration 022 적용 후. 빈 DB 면 `MAX` 가 NULL 이라 `COALESCE` 권장 |
| Bifrost 서버 떠있음 | `lsof -i :3100 \| grep LISTEN` | 기본 포트 3100 |
| Bifrost HEAD 핸들러 | `curl -sS -o /dev/null -w "%{http_code}\n" -I http://localhost:3100/mcp` 가 `405` | mcp-bifrost issue #3 / PR #4 머지 이후. **404 이면 Palantir preflight 가 fail-closed 시키므로 Bifrost 측 fix 가 선결**. |
| codex CLI 인증 | `~/.codex/auth.json` 존재 또는 `CODEX_API_KEY` env | 워커 spawn 시 codex 인증 필요 |

---

## 2. 셋업 단계

### 2.1 Bifrost endpoint 검증 (셋업 전 0순위)

```bash
# 살아있고, MCP handshake 정상 응답하는지
curl -sS -X POST -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  http://localhost:3100/mcp
# → result.protocolVersion + capabilities.tools.listChanged=true 가 보여야 정상

# preflight 정합 (HEAD 가 405 또는 200/204/501 중 하나여야 함)
curl -sS -o /dev/null -w "HEAD → %{http_code}\n" -I http://localhost:3100/mcp
```

### 2.2 Palantir 에 MCP 템플릿 등록

UI: `http://localhost:4177/#mcp-servers` → "+ 새 MCP 서버"
- **Alias**: 한 단어 (예: `Bifrost`). 영문/숫자/`_`/`-` 만, 변경 불가.
- **Transport**: **`http (원격 Streamable HTTP)`** 라디오 선택.
- **URL**: 예) `http://localhost:3100/mcp`. **`?profile=...` query 는 Bifrost 쪽에 해당 profile 이 *실제로 정의*되어야만 사용**. 정의 안 된 이름이면 `tools/list` 시점에 `unknown profile` 에러로 spawn 후 도구 0개 — Bifrost 의 profile 셋업과 lock-step 으로만 query 추가.
- **Bearer 토큰 env 변수 이름** (선택): bearer 인증을 요구하는 endpoint 면 env var **이름** (예: `BIFROST_MCP_TOKEN`). 값 아님. 익명 endpoint 면 비워둠.
- **설명**: 자유 텍스트.

저장 후 카드에 `transport=http` chip + URL 정상 표시.

### 2.3 환경 변수 (bearer 사용 시만)

```bash
# 셸 profile 에 토큰 넣기
echo 'export BIFROST_MCP_TOKEN="<실제 토큰>"' >> ~/.zshrc
source ~/.zshrc

# Palantir 서버를 토큰이 보이는 셸에서 (재)시작
kill $(lsof -ti :4177)   # 이미 떠있으면 정리
npm start                # 부팅 시 마이그레이션 자동 적용
```

`buildManagerSpawnEnv` 가 `bearer_token_env_var` 키를 자동으로 워커 spawn env 에 forward (M4-a spec §L7 의 `buildManagerSpawnEnv` 항목 — env hygiene). 즉 agent 프로필의 `env_allowlist` 에 따로 추가 안 해도 됨.

### 2.4 Worker Preset 에 묶기

UI: `#presets` → 새 preset 또는 기존 편집 → "MCP 서버 템플릿" 에서 등록한 alias 체크 → 저장.

API 로 만들 수도:
```bash
curl -sS -X POST http://localhost:4177/api/worker-presets \
  -H "Content-Type: application/json" \
  -d '{"name":"Bifrost-Test","mcp_server_ids":["<tpl_id>"]}'
```

`<tpl_id>` 는 `sqlite3 server/palantir.db "SELECT id FROM mcp_server_templates WHERE alias='Bifrost';"`.

### 2.5 Task 실행

UI `#board` 또는 `#manager` 에서 task 실행 시 위 preset 선택. 또는 API:
```bash
curl -sS -X POST "http://localhost:4177/api/tasks/<task_id>/execute" \
  -H "Content-Type: application/json" \
  -d '{"agent_profile_id":"codex","prompt":"<your prompt>","preset_id":"<wp_id>"}'
```

워커 spawn 직전 흐름:
1. `assertSafeUrl(url)` 통과 (DNS resolve + SSRF 차단 검사)
2. `mcpPreflight.preflightHttpMcpConfig` (HEAD, IP-pinned, optional Authorization 헤더)
3. preflight pass 면 `mergedMcp` 를 `<repoRoot>/runtime/mcp/<run_id>.json` (서버 cwd 기준, 통상 repo 루트) 에 기록
4. codex spawn args 에 `-c mcp_servers.<alias>.url="..."` 주입. bearer 가 있으면 **별도 `-c mcp_servers.<alias>.bearer_token_env_var="<env_var_name>"` 인수가 추가로 emit** (실제 출력 예: `-c 'mcp_servers.Bifrost.url="http://..."'  -c 'mcp_servers.Bifrost.bearer_token_env_var="BIFROST_MCP_TOKEN"'`)
5. codex CLI 가 startup 시 자동으로 `tools/list` 호출 → 도구 description 을 model context 에 주입 (Codex CLI 0.125 이상에서 실측 확인된 동작 — spec §L9 R2)
6. LLM 이 prompt 의도와 매치 시 `mcp_tool_call` 자동 발생

---

## 3. 검증 명령어 모음

```bash
# Palantir 측 schema / 행 상태
sqlite3 server/palantir.db "SELECT MAX(version) FROM schema_version;"     # 22
sqlite3 server/palantir.db "SELECT alias, transport, url, COALESCE(bearer_token_env_var,'<NULL>') FROM mcp_server_templates WHERE transport='http';"

# 사용자 ~/.codex/config.toml 의 alias 들과 충돌 진단
npm run diagnose:mcp                          # PR #175 이후 default 가 server/palantir.db
npm run diagnose:mcp -- --json                # 자동화용
npm run diagnose:mcp -- --fail-on-conflict    # CI gate

# 직접 endpoint health
curl -sS -o /dev/null -w "HEAD → %{http_code}\n" -I http://localhost:3100/mcp
curl -sS -X POST -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://localhost:3100/mcp | python3 -c "import sys,json; r=json.loads(sys.stdin.read()).get('result',{}); print(f'tools={len(r.get(\"tools\",[]))}')"

# 디버그: preflight 강제 우회 (운영 권장 X)
PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP=1 npm start
```

---

## 4. 트러블슈팅 매트릭스

| 증상 | 의미 | 해결 |
|---|---|---|
| `preset:mcp_unreachable` reason=`preflight_4xx` status=404 | endpoint 가 HEAD 에 404 (RFC 비준수) | 서버 측에서 `HEAD` 핸들러 추가 (mcp-bifrost issue #3 처럼). 미해결이면 임시로 `PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP=1`. |
| `preset:mcp_unreachable` reason=`preflight_4xx` status=401/403 | bearer-protected endpoint, 토큰 잘못됐거나 헤더 형식 다름 | env var 의 토큰 값 확인. 또는 endpoint 의 인증 요구 (Bearer vs API-Key 헤더) 확인 |
| `preset:mcp_unreachable` reason=`preflight_5xx` | endpoint 가 5xx (Bifrost 자체 버그) | 서버 측 로그 확인. 임시로 `PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP=1` 으로 우회 가능 |
| `preset:mcp_unreachable` reason=`preflight_timeout` | HEAD 가 3s 안에 응답 없음 (`ETIMEDOUT`/`ESOCKETTIMEDOUT`) | endpoint 살아있어도 hang. 서버 쪽 health 점검 |
| `preset:mcp_unreachable` reason=`preflight_connect_refused` | endpoint 자체가 안 떠있음 | 대상 서버 (Bifrost) 띄우기 |
| `preset:mcp_unreachable` reason=`preflight_network_error` | 기타 네트워크 에러 (`ENETUNREACH`, DNS resolve 후 connect 실패 등) | 네트워크 / 호스트 routing 점검 |
| `preset:mcp_unreachable` reason=`bearer_env_missing` payload.bearer_env=`X` | env var `X` 가 워커 spawn env 에 없음 | 셸에서 `export X=...` 후 Palantir 서버 재시작 (워커는 Palantir 서버의 env 를 상속) |
| `preset:mcp_unreachable` reason=`bearer_env_invalid_name` | bearer_token_env_var 이름 자체가 invalid (특수문자 / denylist 패턴) | 템플릿 등록 시 검증 통과해야 정상. 이론상 raw SQL 우회 시에만 표면화 |
| `preset:mcp_unreachable` reason=`ssrf_blocked` | 사설 IP / 메타데이터 / 차단 호스트 | URL 다른 host 로 변경. 로컬 endpoint 쓰는데 차단된다면 `PALANTIR_MCP_ALLOW_LOCALHOST=1` 확인 (default 허용) |
| `preset:mcp_unreachable` reason=`redirect_blocked` status=302 | endpoint 가 redirect 응답 | redirect 따라가면 SSRF 우회 가능. 진짜 endpoint URL 직접 등록 |
| `preset:mcp_unreachable` reason=`preflight_unknown` | HTTP status 0 또는 분류 불가 응답 | 매우 드뭄. 네트워크 stack 또는 endpoint 변종 응답 — 직접 curl 로 재현해 분석 |
| `mcp:legacy_alias_conflict` event 발생 | user `~/.codex/config.toml` 에 동일 alias 가 이미 정의 → leaf-merge 발생 | `npm run diagnose:mcp` 로 어떤 alias 충돌인지 확인. 충돌 alias 를 user config 에서 제거하거나 Palantir 측 alias 이름 변경 |
| codex 응답에 도구 이름이 등장하지만 호출 안 함 | LLM 이 prompt 와 매치 안 됨 | prompt 를 더 명시적으로 (예: "use the search tool") 또는 prompt 의 의도가 도구를 필요로 하는지 점검 |
| codex 가 `unknown profile: <name>` 에러 | URL 의 `?profile=` 값이 Bifrost 측에 정의 안 됨 | URL 에서 profile query 제거 또는 Bifrost 에 valid profile 정의 |
| `POST /api/tasks/:id/execute` 가 400 + `Unknown agent profile` | agent_profile_id 가 DB 에 없음 (preset 문제와 별개 경로) | `GET /api/agents` 로 valid id 확인. 본 케이스는 `preset:mcp_unreachable` 이 아닌 즉시 400 — run 자체가 생성 안 됨 |
| schema_version 19 / no transport column | 서버 프로세스가 머지 전 코드, 또는 좀비 락으로 마이그레이션 안 돔 | 모든 좀비 node server 프로세스 정리 (`ps`/`lsof`) 후 깨끗하게 재시작. PR #172 이후 코드면 부팅 시 020/021/022 자동 적용 |
| `npm run diagnose:mcp` 가 "no such column: transport" | 진단 스크립트가 stale 루트 `palantir.db` 를 보고 있음 | PR #175 이후 default 가 `server/palantir.db`. 이전 코드면 `--db server/palantir.db` 명시 |

---

## 5. 운영 패턴

### 5.1 alias 카디널리티 — profile 별 1~2개 (spec §3.1)

Bifrost 에 N 개 워크스페이스가 있어도 Palantir alias 는 1~2개 (`bifrost-default` / `bifrost-readonly`) 가 권장. 각 alias 의 URL 은 `?profile=<bifrost-profile-name>` 으로 Bifrost 측 슬라이스를 가리킴. Bifrost 가 도구 이름을 namespacing 처리하므로 워커는 같은 alias 를 통해 여러 워크스페이스의 도구를 호출 가능. spec §3.1 의 예시 도구명: `bifrost-default__notion_personal__search_pages` (`<alias>__<workspace>__<tool>` 형태). **실제 namespacing 패턴은 Bifrost 구현 영역**이며 Palantir 코드는 도구명 포맷을 강제·검증하지 않음 — 정확한 prefix 규칙은 mcp-bifrost repo 문서 / Bifrost initialize 응답의 `tools/list` 결과 참조.

```
[Palantir alias]   → [Bifrost 측 profile]    → [노출되는 도구]
bifrost-default    → all (default)            → 모든 워크스페이스
bifrost-readonly   → ?profile=read-only       → 읽기 전용 도구만
```

**나쁜 패턴**: Bifrost upstream 5개 (`notion_personal`, `slack_work`, …) 를 Palantir alias 5개로 펼치기 → alias 폭발, M2 legacy scan 충돌면 증가, drift 관측 부담.

### 5.2 토큰 회전

bearer-protected 환경에서 토큰 회전 시:
1. 셸 / secrets store 의 env var 값만 갱신
2. Palantir 서버 재시작 (또는 워커가 재시작될 때 새 값 forward)
3. **template 자체는 변경 없음** → drift event 발생 안 함, RunInspector 의 mcp_template_drift chip 도 안 뜸

### 5.3 워크스페이스 추가/제거 (Bifrost 측)

Bifrost 에 새 워크스페이스 추가 시:
- **다음 신규 워커 spawn 부터** 도구 자동 인지 (codex 가 startup 시 `tools/list` 호출하므로 새로 인지)
- **이미 떠있는 워커**가 자동으로 추가 도구 인지하는지 (= MCP `tools/list_changed` notification) 는 Bifrost 의 SSE/streaming 구현 + codex 의 listener 구현 매트릭스에 의존. spec §L9 의 R2 검증 영역 — 후속 phase 에서 별도 검증 노트 예정.

### 5.4 운영 진단

매일 / 의심 정황 시:
```bash
npm run diagnose:mcp                                    # 충돌 0 인지
sqlite3 server/palantir.db "SELECT alias, transport, updated_at FROM mcp_server_templates ORDER BY updated_at DESC LIMIT 5;"
```

CI / 자동화에서:
```bash
npm run diagnose:mcp -- --json --fail-on-conflict      # 충돌 시 exit 2
```

---

## 6. 참고

- Spec: `docs/specs/m4-mcp-http-streamable-transport-brief.md` (r7 READY, locked-in)
- Impl PR: [#172](https://github.com/Karnian/Palantir-Console/pull/172) (cf96f9e)
- Stamp PR: [#173](https://github.com/Karnian/Palantir-Console/pull/173), r1 fixups [#174](https://github.com/Karnian/Palantir-Console/pull/174)
- diagnose-mcp default path fix: [#175](https://github.com/Karnian/Palantir-Console/pull/175)
- mcp-bifrost HEAD 핸들러: [Karnian/mcp-bifrost#3](https://github.com/Karnian/mcp-bifrost/issues/3) (closed by [PR #4](https://github.com/Karnian/mcp-bifrost/pull/4))
- RFC 7231 §6.5.5 — 405 Method Not Allowed (Allow header 필수)

본 runbook 은 첫 실 use case (Bifrost) 를 기준으로 작성. Linear / Notion 공식 hosted MCP / Sentry 등 외부 서드파티 endpoint 도 동일 흐름 적용 가능 — 다만 그쪽이 RFC 비준수 (HEAD → 404) 인 경우는 §L9 / preflight policy 의 후속 phase (M4-c 가칭) 에서 별도 정책 결정 영역.
