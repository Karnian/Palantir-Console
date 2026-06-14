# C: Webhook 알림 — 부재중 주의 신호 외부 통지

> 2026-06-14. Status: **r2 READY** (Codex r1 spec review 반영 — BLOCKER 2 + SERIOUS 2 해소)
> 작성: Claude (감독). 구현: Codex. branch: `feat/c-webhook`
> 배경: 컨셉 리뷰의 "관제 허브인데 자리 비우면 needs_input 놓침". 자율 루프(P0~B-lite)가 이제 도니
> 워커가 needs_input/failed 에 실제로 도달 → 부재중 통지가 진짜 가치. 현재 알림은 브라우저 notification
> + SSE (탭 열려있어야). webhook 으로 탭 무관 외부(Slack 등) 통지.
>
> **r2 핵심 변경 (Codex r1)**:
> - **failed 소스 = `run:ended`** (BLOCKER Q1): `run:completed` 는 tmux 경로만 emit, streamJson 실패는
>   놓침. terminal 표준 채널은 `run:ended` (runService.updateRunStatus, `runService.js:326`) — H-1.5 에서
>   PM review 를 run:ended 로 통일한 것과 동일 교훈. webhook 도 `run:ended` + `to_status==='failed'`.
> - **allowPrivate 는 pinning 유지** (BLOCKER Q6): assertSafeUrl 우회 = DNS pinning 포기 = SSRF 취약.
>   `assertSafeUrl(url, { allowPrivate })` 옵션화 (기본 false → M4-a 호출자 무영향) — allowPrivate 는
>   isBlockedIP 만 skip, **pinned IP 반환은 유지**.
> - **eventBus subscriber isolation 없음** (SERIOUS Q3): emit 은 raw EventEmitter — 구독 콜백이 자체
>   sync try/catch + `void send().catch()` 로 격리 (다른 구독자 보호).
> - **createApp options 주입** (SERIOUS Q4): `options.webhookUrl || process.env.PALANTIR_WEBHOOK_URL`
>   (PALANTIR_TOKEN 패턴) — 테스트 env 영향 차단.
> - SSRF-safe POST 는 `mcpPreflight.issueHeadRequest` 패턴 (lookup hook pinning + Host + servername) 의
>   method=POST + body 버전.

---

## 1. 현재 코드 사실

- 알림 이벤트는 `eventBus` 로 emit: `run:needs_input` (payload `{ runId, run, from_status, to_status,
  reason, task_id, project_id, priority:'alert' }`, `lifecycleService.js:1024`), `run:completed`
  (payload `{ run, from_status, to_status, reason, task_id, project_id }`, to_status ∈ {completed,
  failed}, `lifecycleService.js:968`).
- eventBus 구독 패턴: `app.js:191` (PM auto-review 가 `eventBus.subscribe`). webhook 도 동일 위치/패턴.
- SSRF: `ssrf.assertSafeUrl(rawUrl)` async (M4-a) — DNS resolve + 내부 IP 차단 + pinned IP 반환.
  `ssrf.js:370`. 기존 GET 은 `fetchUrlSafe`/`doHttpsGet` (pinned IP + Host 헤더). POST 는 없음.
- 환경변수 패턴: `process.env.PALANTIR_*`.

## 2. 목표 (B-lite, Small)

`PALANTIR_WEBHOOK_URL` 설정 시, **주의가 필요한 run 이벤트**를 외부 URL 로 POST 통지.

1. 통지 이벤트: `run:needs_input` + `run:ended`(to_status=**failed** 만). 성공/cancelled/stopped 는 noise → 제외.
2. payload 최소: `{ event, run_id, task_id, project_id, status, reason, agent, server_ts }` — **prompt/
   result/output 제외** (민감 + 비대). agent/reason 은 String 강제 + 길이 cap(≤200).
3. fire-and-forget: 실패해도 run 동작 무관 (annotate-only, never throws).

## 3. Lock-in

1. **이벤트 2종만**: `run:needs_input` + `run:ended`(failed). 성공/cancelled/stopped/큐/harvest 는 비범위 (§5).
2. **payload 화이트리스트**: §2.2 필드만. prompt/output/result 절대 미포함. agent/reason String+cap.
3. **SSRF-safe + pinning 불변**: `assertSafeUrl(url, { allowPrivate })` 로 검증 → **pinned IP 로 POST**
   (DNS rebinding 방어). `allowPrivate` 는 isBlockedIP 만 skip하고 **pinned IP 반환은 유지** (우회 금지).
   사내 webhook 은 `PALANTIR_WEBHOOK_ALLOW_PRIVATE=1`.
4. **never throws + subscriber isolation**: eventBus 는 raw EventEmitter (격리 안 해줌). 구독 콜백은
   **sync try/catch + `void send().catch()`** 로 자체 격리. 전송/검증 실패는 `webhook:error` run event +
   warn (annotate-only). 다른 구독자/emit 호출자를 절대 안 막음.
5. **fire-and-forget, 재시도 없음**: timeout 5s, 실패 시 1회 경고. 큐/재시도는 비범위.
6. **신규 SSE 채널 0**: outbound. run event `webhook:sent`/`webhook:error` 만 (run:event 로 전달).

## 4. 구현 지침

### 4.1 `ssrf.assertSafeUrl` 옵션화 (Q6)
- 시그니처: `assertSafeUrl(rawUrl, { allowPrivate = false } = {})`. `allowPrivate=true` 면 IP literal
  + DNS resolve 후의 `isBlockedIP` 차단을 skip — **단 pinned IP({ip,family,hostname,port,url}) 반환은 유지**.
- **기본값 false → M4-a 호출자(mcpTemplateService validator / mcpPreflight) 동작 불변**. ssrf.test 회귀 그린 유지.

### 4.2 신규 `server/services/webhookService.js`
```
createWebhookService({ eventBus, runService, webhookUrl, allowPrivate, postImpl, now })
  → { stop() }   // eventBus 구독 해제
```
- `webhookUrl` falsy → no-op (구독 0, return { stop: ()=>{} }).
- 구독: `run:needs_input`, `run:ended`. **run:ended 는 `to_status==='failed'` 만** 전송. needs_input 은 전부.
  (worker run 만 — is_manager 제외, 기존 가드 패턴.)
- payload (화이트리스트): `{ event: 'needs_input'|'failed', run_id, task_id, project_id, status,
  reason: cap(reason), agent: cap(run.agent_name||run.agent_profile_id), server_ts: now() }`.
  cap = String(x).slice(0,200). now() 주입 가능(테스트 결정성), 기본 `()=>new Date().toISOString()`.
- **구독 콜백 (isolation, Q3)**:
  ```
  eventBus.subscribe((event) => {
    try {
      if (event.channel !== 'run:needs_input' && event.channel !== 'run:ended') return;
      if (event.channel === 'run:ended' && event.data?.to_status !== 'failed') return;
      const run = event.data?.run; if (!run || run.is_manager) return;
      void send(buildPayload(event)).catch(() => {});   // fire-and-forget, never rejects out
    } catch { /* never throw into emit */ }
  });
  ```
- **send (SSRF-safe POST)** — `mcpPreflight.issueHeadRequest` 패턴의 POST 버전 (postImpl 주입 시 그걸로):
  - `const pinned = await assertSafeUrl(webhookUrl, { allowPrivate })` (실패 → webhook:error 'ssrf_blocked').
  - `transport.request({ method:'POST', host: pinned.hostname, port: pinned.port, path,
    headers:{ Host: pinned.hostname, 'Content-Type':'application/json', 'Content-Length' }, timeout:5000,
    lookup: (h,o,cb)=> cb(null, pinned.ip, pinned.family), servername: https면 pinned.hostname })`.
    body = JSON.stringify(payload). http/https 분기 (http 는 1회 경고).
  - 2xx → `webhook:sent` run event. 그 외/timeout/redirect → `webhook:error` `{ reason, status? }` + warn.
- **never throws**: send 전체 try/catch, reject 안 함. run event 기록 실패도 삼킴 (DELETE race).

### 4.3 `app.js` 조립 + shutdown (Q4)
- 조립부 (harvestService 근처): `const webhookService = createWebhookService({ eventBus, runService,
  webhookUrl: options.webhookUrl || process.env.PALANTIR_WEBHOOK_URL,
  allowPrivate: options.webhookAllowPrivate ?? (process.env.PALANTIR_WEBHOOK_ALLOW_PRIVATE === '1') })`.
  (options 우선 — PALANTIR_TOKEN 패턴. 테스트는 options 로 주입, env 영향 차단.)
- `app.shutdown()` 에 `webhookService.stop()` (stopMonitoring/closeDb 흐름 옆).
- webhookUrl 미설정 → no-op → 기존 테스트 영향 0.

### 4.4 보안
- webhook URL = 운영자 설정 (신뢰) 이나 SSRF 기본 방어 유지 — 내부 메타데이터(169.254.169.254) 오타 차단.
  allowPrivate 는 사내 webhook 용 (private IP 허용하되 pinning 유지 → rebinding 여전히 방어).
- payload 화이트리스트 + agent/reason cap → secret/대용량 유출 0.

## 5. 비범위
| 항목 | 이유 |
|---|---|
| 성공 completed / 큐 / harvest 이벤트 통지 | noise. needs_input + failed 가 "주의 필요" 핵심 |
| 재시도 / 큐잉 / backoff | fire-and-forget. 놓친 통지는 콘솔에 남음 |
| Slack/Discord 포맷별 어댑터 | generic JSON POST. 포맷은 수신측 or 후속 |
| 다중 webhook URL / per-project | 단일 글로벌 URL 로 시작 |
| HMAC 서명 / 인증 헤더 | 후속 (필요 시 PALANTIR_WEBHOOK_SECRET) |

## 6. 수용 기준
1. `webhookUrl` 설정 + run:needs_input → 화이트리스트 payload 가 그 URL 로 POST.
2. **run:ended(to_status=failed) → POST**. completed/cancelled/stopped → POST 안 됨.
3. streamJson 워커 실패도 통지된다 (run:ended 기반 — run:completed 가 아니라). 
4. payload 에 prompt/result/output 이 **없다**. agent/reason 은 String + ≤200자.
5. URL 미설정 → 완전 no-op (구독 0, 기존 동작 무변경).
6. 전송 실패(타임아웃/4xx/5xx/SSRF-block)가 run 동작·다른 eventBus 구독자를 안 막는다 (never throws,
   구독 콜백 자체 격리).
7. 내부 IP URL → 기본 차단(SSRF) + `webhook:error`. allowPrivate=1 시 허용하되 **pinning 유지**.
8. `assertSafeUrl` 옵션화가 M4-a 호출자 동작을 안 바꾼다 (ssrf.test 회귀 그린).
9. `app.shutdown()` 이 webhook 구독 해제. manager run 은 통지 제외.
10. 전체 `node --test` 그린 + 신규 `webhook.test.js`.

## 7. 테스트 지침
- `postImpl` 주입 (실 네트워크 없이): POST 호출 capture (url/payload/headers). 실 https 안 씀.
- `now` 주입으로 server_ts 결정성.
- 케이스: needs_input POST / run:ended failed POST / completed·cancelled skip / streamJson failed 경로
  (run:ended) 통지 / payload 화이트리스트(prompt/output 부재 assert) / agent·reason cap / URL 미설정 no-op /
  postImpl throw → never-throws(다른 구독자 정상 + emit 반환) / manager run 제외 / stop 후 미구독.
- SSRF: assertSafeUrl 옵션화 단위 (allowPrivate 시 private 통과 + pinned 반환 / 기본 차단). ssrf.test 확장.
- never-throws: postImpl 이 sync throw + async reject 양쪽 → eventBus.emit 정상 반환, 이후 구독자 호출됨.

## 8. 구현 순서
1. `ssrf.assertSafeUrl(url, {allowPrivate})` 옵션화 + ssrf.test 확장 (M4-a 회귀 그린 먼저 확인)
2. webhookService (run:needs_input + run:ended-failed 구독, 화이트리스트 payload, SSRF-safe POST
   = issueHeadRequest 패턴 POST 버전, 구독 콜백 isolation, never-throws)
3. app.js 조립(options 우선) + shutdown stop
4. webhook.test.js (postImpl/now 주입, 케이스 전부)
5. 검증: ssrf.test → webhook.test → 회귀(app/lifecycle/mcp-preflight) → 전체 --test-concurrency=2

## 9. Codex r1 spec review 처리 기록
| 판정 | 내용 | r2 |
|---|---|---|
| Q1 BLOCKER | failed 소스 채널 잘못 (run:completed 는 tmux만, streamJson 놓침) | run:ended + to_status=failed |
| Q6 BLOCKER | allowPrivate 우회 = SSRF 취약 | assertSafeUrl({allowPrivate}) — isBlockedIP만 skip, pinning 유지 |
| Q3 SERIOUS | eventBus subscriber isolation 없음 | 구독 콜백 sync try/catch + void send().catch() |
| Q4 SERIOUS | app wiring env 직접 읽음 | options.webhookUrl 우선 (PALANTIR_TOKEN 패턴) |
| Q5 caveat | agent/reason 길이/타입 | String + ≤200 cap |
| NIT | doHttpsGet 보다 issueHeadRequest 참조 | §4.2 issueHeadRequest POST 버전 명시 |
