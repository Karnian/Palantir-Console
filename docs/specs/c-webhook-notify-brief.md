# C: Webhook 알림 — 부재중 주의 신호 외부 통지

> 2026-06-14. Status: **draft r1** (Codex spec review 전)
> 작성: Claude (감독). 구현: Codex. branch: `feat/c-webhook`
> 배경: 컨셉 리뷰의 "관제 허브인데 자리 비우면 needs_input 놓침". 자율 루프(P0~B-lite)가 이제 도니
> 워커가 needs_input/failed 에 실제로 도달 → 부재중 통지가 진짜 가치. 현재 알림은 브라우저 notification
> + SSE (탭 열려있어야). webhook 으로 탭 무관 외부(Slack 등) 통지.

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

1. 통지 이벤트: `run:needs_input` + `run:completed`(to_status=**failed** 만). 성공 completed 는 noise → 제외.
2. payload 최소: `{ event, run_id, task_id, project_id, status, reason, agent, server_ts }` — **prompt/
   result/output 제외** (민감 + 비대).
3. fire-and-forget: 실패해도 run 동작 무관 (annotate-only, never throws).

## 3. Lock-in

1. **이벤트 2종만**: needs_input + failed completed. 성공/큐/harvest 이벤트는 비범위 (§5).
2. **payload 화이트리스트**: §2.2 필드만. prompt/output/result 절대 미포함 (외부 유출 방지).
3. **SSRF-safe**: webhook URL 은 `ssrf.assertSafeUrl` 로 검증 + pinned IP 로 POST (DNS rebinding 방어).
   내부 IP 는 기본 차단. 사내 webhook 은 `PALANTIR_WEBHOOK_ALLOW_PRIVATE=1` opt-out (명시).
4. **never throws**: webhook 전송/검증 실패는 `console.warn` + run event `webhook:error` (annotate-only).
   eventBus 핸들러를 절대 throw 시키지 않음 (다른 구독자 보호).
5. **fire-and-forget, 재시도 없음**: timeout 5s, 실패 시 1회 경고. 큐/재시도는 비범위.
6. **신규 SSE 채널 0**: webhook 은 outbound. run event `webhook:sent`/`webhook:error` 만 (run:event 로 전달).

## 4. 구현 지침

### 4.1 신규 `server/services/webhookService.js`
```
createWebhookService({ eventBus, runService, webhookUrl, allowPrivate, fetchImpl })
  → { stop() }   // eventBus 구독, stop 으로 해제
```
- `webhookUrl` 없으면 no-op (구독 안 함).
- 구독: `run:needs_input`, `run:completed`. completed 는 `to_status==='failed'` 만 전송.
- payload 빌드 (화이트리스트): `{ event: 'needs_input'|'failed', run_id, task_id, project_id, status,
  reason: reason||null, agent: run.agent_name||run.agent_profile_id||null, server_ts }`.
  (server_ts 는 전송 시점 — 단 테스트 결정성 위해 주입 가능하거나 생략. Date.now() 가 워크플로 제약이지만
  여기는 런타임 서비스라 `new Date().toISOString()` 사용 가능.)
- **전송 (SSRF-safe POST)**:
  - `const pinned = await ssrf.assertSafeUrl(webhookUrl)` (allowPrivate 면 내부 허용 분기 — assertSafeUrl
    에 옵션 없으면 webhookService 가 allowPrivate 시 assertSafeUrl 우회하고 직접 POST, 단 §3.3 명시).
  - POST: `Content-Type: application/json`, body JSON, timeout 5s. pinned IP 로 연결 + Host 헤더
    (기존 doHttpsGet 패턴 참고 — DNS rebinding 방어). http/https 모두 지원하되 http 는 경고.
  - 성공(2xx): `webhook:sent` run event. 실패/timeout/SSRF-block: `webhook:error` `{ reason }` + warn.
- **never throws**: 모든 경로 try/catch. eventBus 구독 콜백은 async fire-and-forget (await 안 함, .catch).

### 4.2 `app.js` 조립 + lifecycle
- `app.js` 서비스 조립부 (harvestService 근처): `const webhookService = createWebhookService({ eventBus,
  runService, webhookUrl: process.env.PALANTIR_WEBHOOK_URL, allowPrivate: process.env.
  PALANTIR_WEBHOOK_ALLOW_PRIVATE === '1' })`.
- `app.shutdown()` 에 `webhookService.stop()` 추가 (eventBus 구독 해제).
- 테스트 격리: webhookUrl 미설정 시 no-op 이라 기존 테스트 영향 0. 명시 테스트만 URL+fetchImpl 주입.

### 4.3 보안 (§3.3 상세)
- webhook URL 은 운영자가 설정하는 신뢰 입력 (agent command 수준). 그래도 **SSRF 기본 방어** 유지 —
  실수로 내부 메타데이터 endpoint(169.254.169.254 등) 를 가리키면 차단. allowPrivate opt-out 으로 사내.
- payload 에 secret 없음 (화이트리스트). reason 도 enum-ish (idle_timeout 등) 라 안전.

## 5. 비범위
| 항목 | 이유 |
|---|---|
| 성공 completed / 큐 / harvest 이벤트 통지 | noise. needs_input + failed 가 "주의 필요" 핵심 |
| 재시도 / 큐잉 / backoff | fire-and-forget. 놓친 통지는 콘솔에 남음 |
| Slack/Discord 포맷별 어댑터 | generic JSON POST. 포맷은 수신측 or 후속 |
| 다중 webhook URL / per-project | 단일 글로벌 URL 로 시작 |
| HMAC 서명 / 인증 헤더 | 후속 (필요 시 PALANTIR_WEBHOOK_SECRET) |

## 6. 수용 기준
1. `PALANTIR_WEBHOOK_URL` 설정 + run needs_input → 화이트리스트 payload 가 그 URL 로 POST 된다.
2. failed completed → POST. **성공 completed 는 POST 안 됨**.
3. payload 에 prompt/result/output 이 **없다** (화이트리스트 검증).
4. URL 미설정 → 완전 no-op (구독 0, 기존 동작 무변경).
5. webhook 전송 실패(타임아웃/4xx/5xx/SSRF-block) 가 run 동작이나 다른 eventBus 구독자를 안 막는다 (never throws).
6. 내부 IP URL → 기본 차단(SSRF) + `webhook:error`. allowPrivate=1 시 허용.
7. `app.shutdown()` 이 webhook 구독을 해제한다.
8. 전체 `node --test` 그린 + 신규 `webhook.test.js`.

## 7. 테스트 지침
- `fetchImpl` 주입 (실 네트워크 없이): POST 호출 capture (url/method/body/headers). 실 fetch/https 안 씀.
- SSRF 는 `assertSafeUrl` 를 통과/차단 시나리오로 (기존 ssrf.test 패턴, 또는 webhookService 에 ssrf 주입).
- 케이스: needs_input POST / failed POST / 성공 completed skip / payload 화이트리스트(민감 필드 부재) /
  URL 미설정 no-op / 전송 실패 never-throws(다른 구독자 정상) / 내부 IP 차단 + allowPrivate 허용 / stop 해제.
- never-throws: fetchImpl 이 throw 해도 eventBus.emit 이 정상 반환 + run 영향 0.

## 8. 구현 순서
1. webhookService (구독 + 화이트리스트 payload + SSRF-safe POST + never-throws)
2. app.js 조립 + shutdown stop
3. webhook.test.js (fetchImpl 주입, 케이스 전부)
4. 검증: webhook.test → 회귀(app/lifecycle) → 전체 --test-concurrency=2
