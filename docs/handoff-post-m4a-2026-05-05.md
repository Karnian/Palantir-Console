# Handoff: M4-a MCP Streamable HTTP transport + Bifrost 연동 검증 종결

> **상태**: 2026-04-30 ~ 2026-05-05 세션. M4-a phase + 검증 사이클 7 PR (#171~#178) 머지 완료. 본 handoff 와 함께 머지되는 문서 정합화 PR (#179) 까지 합치면 총 **8 PR** 시리즈. (#179 머지 후 본 줄의 "본 handoff 와 함께 머지되는" 표현은 retrospective 가 됨.)
> 직전 세션 handoff: [`handoff-post-k2-launch-2026-04-29.md`](./handoff-post-k2-launch-2026-04-29.md) (K-2~K-5 41 PR 시리즈 종결).

---

## 1. PR 시리즈 (8개)

### 1.1 M4-a phase (#171, #172)

| PR | hash | 내용 |
|---|---|---|
| **#171** | 881daec | docs(m4-spec): MCP Streamable HTTP transport phase spec brief — Codex 7회 cross-check 후 r7 READY lock-in |
| **#172** | cf96f9e | feat(m4a): impl — `mcp_server_templates.transport ∈ {stdio, http}` discriminated union, migration 022 (table rebuild + INSERT/UPDATE 정합성 trigger 2개), `ssrf.assertSafeUrl` async helper, `codexMcpFlatten` http 분기, `mcpPreflight` (HEAD only / 200·204·405·501 pass / 3s timeout / Authorization 첨부 / fail-closed `preset:mcp_unreachable`), `authResolver.resolveBearerForPreflight` 단일 entry point + `buildManagerSpawnEnv` bearerEnvKeys 자동 allowlist, `lifecycleService.executeTask` async 전환, `McpTemplatesView` transport selector, `diagnose-mcp-conflicts.mjs` 컬럼 출력 + 마스킹. 902 → 959 tests. Codex r1 cross-check 0 BLOCKER / 2 SERIOUS 모두 fix |

### 1.2 M4 phase 종료 stamp (#173, #174)

| PR | hash | 내용 |
|---|---|---|
| **#173** | 21f4dfb | docs(backlog): M4 phase 종료 stamp + Trigger-wait 갱신 (T2 M4-b / D1 M5 정합화) |
| **#174** | e279ee4 | docs(backlog): codex r1 SERIOUS fixes — 통계 블록 scoping (직전 세션 K-시리즈 한정 명시 + M4-a 후 누적 footer) + bearer token argv 정확화 (값/이름 분리) |

### 1.3 검증 사이클 (#175~#178)

| PR | hash | 내용 |
|---|---|---|
| **#175** | 4497d37 | fix(diagnose-mcp): default DB 경로를 `server/palantir.db` 로 정렬 — `server/app.js:81` 와 lock-step (`__dirname || PALANTIR_DB || ...`). 본 세션 발견된 false-negative 진단 fix (stale 루트 `palantir.db` 가 schema_version 19 reporting). Codex r1 PASS, NIT 1 (help text) 반영 |
| **#176** | 7dd7cf8 | docs(runbook): M4-a Bifrost 연동 셋업 / 검증 / 트러블슈팅 매트릭스 신규 (192줄). 6 섹션 (사전요구 / 셋업 5단계 / 검증명령 / 14행 트러블슈팅 매트릭스 / 운영패턴 / 참고링크). Codex r1 1 ERROR (namespacing 단언) / 2 SERIOUS (preflight reason 누락 / args formatting) / 5 NIT 모두 반영 |
| **#177** | 175aae6 | docs(m4-spec): post-impl L9.1 verification stamp — Bifrost end-to-end 검증 결과 (5 ✅ + 2 ⚠) inline 등록. Codex r1 PASS, NIT 1 & 7 반영 |
| **#178** | e2eb0e3 | docs(m4-spec): §L9.1 매트릭스 확장 — 외부 hosted MCP 6개 endpoint anon HEAD probe (Linear/Notion 공식/Sentry/GHCP/Atlassian/Cloudflare — 5/6 = 401, 1/6 = 404) + Bifrost listChanged emit 메커니즘 코드 분석 (`/mcp` 비동기 미지원, `/sse` 만 emit). M4-c entry + completion condition 정밀화 (§7 갱신). Codex r1 0 ERROR / 2 SERIOUS / 5 NIT 모두 반영 |

### 1.4 mcp-bifrost (외부 repo)

| Repo | issue/PR | 내용 |
|---|---|---|
| `Karnian/mcp-bifrost` | issue #3 / PR #4 | `HEAD /mcp` → `405 Method Not Allowed + Allow: POST` (RFC 7231 §6.5.5). Palantir M4-a preflight pass list 와 정합. Bifrost 측 fix 머지 후 Palantir 워커 spawn 정상 |

### 1.5 문서 status alignment (#179)

| PR | hash | 내용 |
|---|---|---|
| **#179** | TBD | docs(post-m4a): backlog Last updated → 2026-05-05 + #175~#178 stamp / `manager-v3-multilayer.md` Status (M3-UI / M4-a 추가) / `worker-preset-and-plugin-injection.md` Status (Phase 10 머지 완료) / `mcp-worker-access-proposal.md` Superseded 헤더 / `next-session-brief-2026-04-24.md` Superseded 헤더 / 본 handoff 신규 |

---

## 2. 검증 결과 — Bifrost end-to-end

spec §L9.1 의 verification 표 (5 ✅ + 7 ⚠/🔬):

```
✅ Bifrost initialize 의 capabilities.tools.listChanged: true advertise
✅ HEAD /mcp = 405 Allow: POST (mcp-bifrost issue #3 / PR #4)
✅ Palantir → codex effective MCP config 주입 (run_aaff2fbd 의 mcp_config_snapshot)
✅ codex CLI 0.125 의 startup 자동 tools/list (mcp_tool_call event 간접 증거)
✅ LLM 자율 mcp_tool_call → Notion 검색 결과 정상 반환
🔬 외부 hosted MCP 6개 anon HEAD probe — 5/6 = 401, 1/6 = 404
🔬 Bifrost /mcp (Streamable HTTP) 비동기 listChanged 미지원 (코드 분석)
🔬 Bifrost legacy /sse listChanged 정상 emit (코드 분석)
⚠ codex CLI 0.125 의 GET-SSE / legacy SSE listener — 미검증
⚠ Cloudflare 404 — 별도 path 확인 영역
⚠ 인증된 외부 hosted MCP HEAD (bearer 첨부) — 토큰 보유 환경 실측 영역
```

핵심 결론: **워커가 Bifrost 도구를 정적으로 호출 가능 — end-to-end 검증 완료**. 동적 listChanged 는 본 phase 범위 외 (M4-c 후보).

---

## 3. 운영 자료 (다음 세션 cold-start 시 진입점)

- **백로그**: [`backlog.md`](./backlog.md) — Ready / Data-wait / Trigger-wait / Draft-review 카테고리
- **M4-a 운영**: [`runbook-m4a-bifrost-setup.md`](./runbook-m4a-bifrost-setup.md) — 셋업 / 검증 명령 / 트러블슈팅 매트릭스 14행 / 운영 패턴
- **M4-a spec**: [`specs/m4-mcp-http-streamable-transport-brief.md`](./specs/m4-mcp-http-streamable-transport-brief.md) — r7 READY + post-impl L9.1 stamp
- **Manager V3 spec**: [`specs/manager-v3-multilayer.md`](./specs/manager-v3-multilayer.md) — Phase 0~10G + M-시리즈 + M4-a status 반영
- **Worker preset spec**: [`specs/worker-preset-and-plugin-injection.md`](./specs/worker-preset-and-plugin-injection.md) — Phase 10 시리즈 머지 완료 status

---

## 4. 잔여 — Deferred (Trigger-wait / Data-wait)

| 카테고리 | 항목 | 트리거 | 출처 |
|---|---|---|---|
| Trigger-wait (T1) | Phase 3b — Claude PM resume | 사용자 선언 (Claude PM use case 발생) | spec `manager-v3-multilayer.md` §9.6 |
| Trigger-wait (T2) | M4-b — clone-as-other-transport + bulk repoint | 첫 transport 전환 시나리오 (운영 preset ~10개 넘는 환경) | spec `m4-...brief.md` §7 |
| Trigger-wait | M4-c — dynamic `tools/list_changed` | (a) Bifrost GET `/mcp` SSE stream 추가 OR (b) `/sse` url 전환 + codex E2E 실측 | spec `m4-...brief.md` §7 + §L9.1 |
| **Data-wait (D1)** | **M5 (가칭) — file-based MCP config delivery** | argv leak 보안 정책 즉시 제거 결정 또는 D1 의 1-2주 관측 결과 (관측 시작 2026-04-22, 결정 포인트 ~2026-05-13) | issue #113 / backlog D1 |
| Trigger-wait | `'sse'` transport enum 값 | SSE-only 원격 MCP 등장 시 | spec `m4-...brief.md` §6 |
| Trigger-wait | OAuth-aware MCP template | Palantir 측 OAuth 토큰 직접 관리 use case | spec `m4-...brief.md` §7 |
| Trigger-wait | Egress proxy / host allowlist | end-to-end SSRF 보장 강화 결정 | spec `m4-...brief.md` §L4.1.1 |

---

## 5. 본 세션 통계 (2026-04-30 ~ 2026-05-05)

- **8 PR 머지**: #171~#178 (Palantir) + 1 (mcp-bifrost issue #3 / PR #4)
- **테스트**: node 902 → **959** (+57). 신규 `mcp-preflight.test.js` (22 cases). e2e a11y 32 + visual 32 = 1023 total.
- **신규 모듈**: `server/services/mcpPreflight.js` (HTTP MCP HEAD preflight), `docs/runbook-m4a-bifrost-setup.md` (운영 가이드)
- **신규 마이그레이션**: 022 (`mcp_server_templates` table rebuild + transport union + 2 trigger)
- **Codex 교차검증**: 모든 PR 머지 전 r1, BLOCK 0건, SERIOUS 6건 모두 fix, NIT 다수 즉시 적용

---

## 6. 다음 세션 재입장 prompt 후보

```
이전 세션 (2026-04-30~05-05) 에서 M4-a + 검증 사이클 8 PR 머지됨.
docs/handoff-post-m4a-2026-05-05.md 와 docs/backlog.md 부터 읽어줘.

진행 옵션:
- M4-c (Bifrost SSE upgrade 또는 /sse 전환 + codex E2E 실측) — Trigger-wait
- M5 (file-based MCP config delivery, D1 관측 결정 포인트 ~2026-05-13) — Data-wait
- M4-b (transport migration helper) — Trigger-wait
- Phase 3b (Claude PM use case 트리거 시) — Trigger-wait
- 그 외 backlog Ready / Trigger-wait / Data-wait 또는 사용자 신규 phase
```
