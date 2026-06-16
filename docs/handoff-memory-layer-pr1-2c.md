# Handoff — Memory Layer PR1~PR3b 완료 (candidate→active 루프 닫힘), 후속 재입장

> **작성**: 2026-06-16
> **상태**: PR1~PR2c (#197~#200) + PR3a/3b + R4 + PR4 + **PR5 (안전·decay·graceful shutdown, #208~#210+) merged**. 1235 tests. **ML 레이어 안전·decay 완비.**
> **비전 달성**: worker harvest/PM판정 → candidate → (PR3b live distiller) → active memory → 다음 PM 세션 주입. `PALANTIR_MEMORY_DISTILL=1` + `ANTHROPIC_API_KEY` 시 runtime 자동 작동.
> **spec**: `docs/specs/memory-layer-brief.md` (v1.x). **다음(선택): PR3c(fuzzy 병합·cross-run confidence, optional) / a11y·visual route 배열에 #memory 추가 / L2(여러 PM→Master 승격).**

## 1. 완료된 것 (main)

3계층 누적 암묵지 메모리. Worker harvest/PM판정 → PM 프로젝트 메모리 자동 증강 → 다음 PM 세션 주입.

| PR | 규칙/기능 | 동작 | active? |
|----|----------|------|---------|
| #197 PR1 | read→inject 뼈대 | 메모리를 user-payload로 PM 주입(캐싱 안전, bake 금지). fresh+resume system prompt 불변 회귀. | — |
| #198 PR2a | R6 환경 사실 | harvest:test의 test_command/node 해석 → fact 메모리 **즉시 active 주입** (upsertFact supersede) | ✅ active |
| #199 PR2b | R1b 실패→수정 | test FAIL run 직후(직전 RUN) PASS = fix 쌍 → candidate. rowid(_seq) 생성순 | candidate |
| #200 PR2c | R3 PM 판정 | coherent task_complete(검증된 것만, hallucination 제외) → candidate | candidate |
| PR3a | batch-distill 뼈대 | candidate→active 정제 파이프라인: `memory_jobs` CAS lease + `promoteCandidatesBatchTx`(단일 안전강제 tx) + `runOnce`(주입형 distiller). **fake distiller로 동작, 런타임 미wiring** | candidate→active (경로 완성) |
| PR3b | live distiller + scheduler | `liveDistiller`(Anthropic Messages API, 주입형 callModel) + `drainAll`/`startScheduler` + app.js wiring(`PALANTIR_MEMORY_DISTILL` 플래그, 기본 off). NIT 1·2(parse cap/balanced, data.content 가드) 반영 | **runtime active** (플래그+key 시) |

**핵심**: R6는 즉시 active. **R1b/R3 candidate는 PR3b로 루프가 닫혔다** — `PALANTIR_MEMORY_DISTILL=1` + `ANTHROPIC_API_KEY` 면 scheduler가 주기적으로 pending candidate를 live distiller로 정제→promote→active, 다음 PM 세션에 주입. 플래그 off(기본)면 PR3a와 동일(미작동, 회귀 0).

## 2. 아키텍처 (구현 위치)

- `server/services/memoryService.js`: createMemoryItem / **upsertFact**(fact_key supersede tx) / **createCandidate·listCandidates** / retrieveForProject(FTS5 BM25 escape+fallback) / revision(VALUES(?,1) 단조) / 주입 ledger. **PR3a**: enqueue/claim/requeueStale/release(CAS lease, token-guarded) + **promoteCandidatesBatchTx**(lease 재확인 + sanitize + kind/importance/confidence clamp + evidence + createMemoryItem + candidate status = 한 tx, **모든 안전장치의 단일 강제 지점**) + 모듈 헬퍼 clampConfidence/clampImportance/buildPromotionEvidence/shortId.
- **PR3a 신규**: `server/services/memorySanitize.js`(출력 게이트: secret redact + injection reject + length clamp), `server/services/memoryDistillService.js`(`runOnce`: claim→list→distill(주입형)→promote→release→successor drain, **never-throws**), `server/services/distillers/fakeDistiller.js`(주입형 distiller 인터페이스).
- **PR3b 신규**: `server/services/distillers/liveDistiller.js`(Anthropic Messages API `claude-haiku-4-5`, 주입형 `callModel`, `parseProposals` = string-aware balanced-array 추출 + output cap, `data.content` 비배열 가드). `memoryDistillService`에 `drainAll`(pending-project 스캔→enqueue→runOnce 루프, maxJobs guard) + `startScheduler`(setInterval unref + busy guard, `{stop,tick}`). `memoryService.listProjectsWithPendingCandidates`.
- `server/app.js`: createR6/R1b/R3Capture — eventBus 독립 구독, never-throws. **PR3b: `PALANTIR_MEMORY_DISTILL=1` + (`ANTHROPIC_API_KEY` or `options.distiller`) 시 liveDistiller + scheduler 시작, `app.shutdown`이 `scheduler.stop()` 호출. 기본 off → 회귀 0.**
- migration **025**(memory_items+FTS5+revision+pm_memory_injection) / **026**(memory_candidates) / **027**(memory_jobs: CAS lease, single-flight partial unique idx).
- 테스트: memory.service / memory-injection / r6/r1b/r3 capture / **memory-sanitize / memory-distill** (105 memory tests).

## 3. 남은 작업 (PR3~5 + remember)

### remember (R4) ✅ merged — actor split
- `POST /api/projects/:id/memory/remember`. **cookie=human→active** (non-fact createMemoryItem origin='human', fact upsertFact origin='human'). **bearer/none=R4 candidate** (distiller 정제, never directly active). **fact는 cookie-only** (promoter가 fact candidate 거부).
- 모든 content sanitize (secret redact / injection reject / cap 2000); fact는 prose length floor만 skip (injection·redact·whitespace-collapse·cap은 적용). fact_key ASCII allowlist regex(`^[a-z0-9_]+(\.[a-z0-9_]+)*$`, Unicode dot 우회 차단) + `env.*` 예약(R6 namespace 보호).
- `req.auth.method` (auth.js, 성공 검증 후만 set, route는 fail-closed). **`PALANTIR_PM_TOKEN` opt-in** = spoof-proof bearer(cookie는 PALANTIR_TOKEN만 매칭, PM token cookie 거부). 미설정 시 shared-token best-effort(hint, not boundary — Codex 수용). 완전 분리(PM spawn env)는 "PM이 remember 호출" 기능 후속.
- Codex 3라운드 적대리뷰 PASS (R1 shared-token BLOCKER→PM token opt-in 수용 / R2 fact injection BLOCKER→detectInjection / R3 PASS).

### PR3a — batch-distill 뼈대 ✅ (이번, merged)
- migration 027 `memory_jobs`(CAS lease, single-flight partial unique) + memoryService CAS(enqueue/claim/requeueStale/release, token-guarded) + `promoteCandidatesBatchTx` + memorySanitize + `memoryDistillService.runOnce` + fakeDistiller.
- CAS claim 불변식: `UPDATE ... SET status='running',claim_token=?,locked_at=now,attempts=attempts+1 WHERE id=(SELECT ... WHERE status='pending' AND (run_after IS NULL OR run_after<=now) ORDER BY created_at,id LIMIT 1) AND status='pending'` (changes()===1). stale requeue(locked_at<now-Nsec, attempts<MAX) / park(attempts≥MAX→failed) / release token-guarded(`WHERE id=? AND claim_token=? AND status='running'`).
- **단일 안전강제 지점**: promote tx 안에서 lease 재확인 / sanitize(secret redact·injection reject·length) / kind·importance·confidence clamp / evidence(trusted `candidate.rule`+capped) / createMemoryItem + candidate status 한 tx. **public `promoteCandidates` 직접 호출자도 우회 불가**.
- terminal-bad(bad_kind/sanitize) candidate는 rejected 마킹(starvation 방지). exact content_hash 병합(source_count++). successor drain(진전 시만, livelock 가드). never-throws.
- **fake distiller로 전 경로 검증, LLM 0 호출.** Codex 3라운드 적대리뷰 수렴.

### PR3b — live distiller + scheduler ✅ (이번, merged)
- `distillers/liveDistiller.js`: Anthropic Messages API(`claude-haiku-4-5`) batch 호출, fakeDistiller와 동일 인터페이스. **주입형 callModel로 mock 테스트(LLM 0 호출).** secret·injection·clamp·evidence는 promote(writer)가 강제 — distiller는 content 생성만. `parseProposals` = string-aware balanced-array 추출 + output cap + `data.content` 비배열 가드(Codex NIT 1·2).
- `drainAll`(pending-project 스캔→enqueue→runOnce drain, maxJobs guard) + `startScheduler`(setInterval unref + busy guard) + app.js wiring(`PALANTIR_MEMORY_DISTILL=1` 기본 off, `ANTHROPIC_API_KEY` or `options.distiller`). `app.shutdown`이 `scheduler.stop()`.
- **루프 닫힘**: 플래그 on 시 scheduler가 주기적으로 R1b/R3 candidate → live distiller → promote → active → `retrieveForProject` 주입 → PM이 실패에서 배운 교훈/판정을 다음 작업에 활용 = **비전 완성**. Codex 적대리뷰 PASS(no blockers; NIT 5건 중 1·2 반영, 3 graceful shutdown은 PR5).

### PR3c — fuzzy 병합·cross-run confidence [optional, 다음]
- exact content_hash 병합은 PR3a 완료. 남은 정교화: fuzzy/semantic 병합(FTS top-N Jaccard) + confidence cross-run 상향(독립 source≥2) + threshold(pending≥3 or oldest≥10min) + rate cap.

### PR4 ✅ merged — 사후교정 (backend CRUD + MemoryView)
- **PR4a (#206)** backend: migration 028(archived_at, pinned) + memoryService CRUD(update/archive/restore/review/pin — **active-set 변경만 revision bump**) + PATCH(**cookie-only** actor split, R4 와 일관) + GET ?status(active/archived/superseded/all) + GET/provenance(evidence 재귀 redact 값+키, null-proto).
- **PR4b** UI: `MemoryView`(#memory) — project selector + status tabs + 카드(kind/origin/confidence/pinned) + 액션(edit/archive/restore/review/pin + provenance modal). XSS-safe(HTM text node), 디자인 토큰만(K-2 light/dark), stale-fetch guard + 성공 시만 modal close.
- Codex 적대리뷰 PASS (PR4a SERIOUS evidence-key redact + PATCH cookie-only / PR4b SERIOUS A2 stale-fetch + A5 modal-close 반영). 남은 NIT: a11y/visual route 배열에 `#memory` 추가(후속).

### PR5 ✅ merged — 안전·decay·관측 (5a~5d)
- **PR5a (#208)** hard-cap admission control: cap 초과 시 **score(confidence×importance) 기반 eviction**(blind 아님), human/pinned 절대 보호, restore 도 admission, observability(memory:promoted/evicted, >5 batch), migration 029 archive_reason.
- **PR5b (#209)** graceful shutdown: scheduler `awaitDrain` + `app.shutdown` 멱등(in-flight drain settle 후 closeDb), index watchdog-first + server.close-first.
- **PR5c (#210)** poisoning gate: 12 안전 불변식 통합 테스트 + `buildInjectionBlock` **injection-time re-sanitize**(write-time + 주입시점 이중 방어).
- **PR5d** decay: `valid_to` 정규화(`datetime()` wrap, ISO/SQLite 혼용 방어) + TTL(90일, batch_llm 만; human/pinned/fact 영구) + `expireStaleMemories` maintenance(scheduler tick) + `markReviewed` re-observation refresh(valid_to 연장) + memory:decayed.
- Codex 적대리뷰: PR5a/b/c 각 PASS(R1 BLOCKER→fix→R2 PASS 패턴). PR5d 는 Codex 2회 응답 불안정(무거운 리뷰 timeout)→Claude 직접 상세 리뷰가 SERIOUS(markReviewed valid_to 미연장) 발견→fix, 테스트 1235 green 으로 검증.

## 4. 작업 방식 (이 시리즈에서 확립)

- **직접 구현 + Codex 독립 교차리뷰**(athena 위임은 PR1만 성공, PR2a부터 미완반환 실패 → 직접 전환). 각 PR: 구현 → `node@22 --test` → Codex 적대 리뷰(BLOCKER까지 반복) → commit → push(Karnian) → squash merge.
- **better-sqlite3 ABI 함정**: codex exec가 node 26으로 rebuild하면 node@22(NODE_MODULE_VERSION 127)에서 깨짐 → `npm rebuild better-sqlite3` 복원. **테스트는 `/opt/homebrew/opt/node@22/bin/node --test`** 또는 `npm test`(PATH node@22).
- **repo push**: repo-local credential helper가 Karnian 계정 강제(gh active=skcc 유지) — `git config --local credential.helper '!f() { test "$1" = get && { echo username=Karnian; echo "password=$(gh auth token --user Karnian)"; }; }; f'`. PR/merge는 `GH_TOKEN=$(gh auth token --user Karnian) gh ...`.
- 풀 테스트 race-y flake 1~2건(preset-file-drift 등) 알려진 패턴 — 메모리 단독 통과가 진실 신호.

## 5. 재입장 prompt (다음 세션)

> "Memory Layer 는 PR1~PR5 + R4 merged — candidate→active 루프 + remember + 사후교정 UI + 안전(cap admission)·decay(TTL)·graceful shutdown·poisoning gate 완비. 남은 건 선택: **PR3c(fuzzy 병합·cross-run confidence) / a11y·visual route 배열 #memory / L2(여러 PM→Master 승격)**. `docs/handoff-memory-layer-pr1-2c.md` + spec 참고. Codex 교차리뷰 + 직접 구현, node@22 테스트."
