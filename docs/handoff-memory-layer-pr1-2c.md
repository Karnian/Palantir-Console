# Handoff — Memory Layer PR1~PR3b 완료 (candidate→active 루프 닫힘), 후속 재입장

> **작성**: 2026-06-16
> **상태**: PR1~PR2c (#197~#200) + PR3a (#202, batch-distill 뼈대) + **PR3b (live distiller + scheduler) merged**. 1169 tests.
> **비전 달성**: worker harvest/PM판정 → candidate → (PR3b live distiller) → active memory → 다음 PM 세션 주입. `PALANTIR_MEMORY_DISTILL=1` + `ANTHROPIC_API_KEY` 시 runtime 자동 작동.
> **spec**: `docs/specs/memory-layer-brief.md` (v1.x). **다음: remember(R4) / PR4(UI 사후교정) / PR5(안전·decay·graceful shutdown) / PR3c(fuzzy 병합·cross-run confidence, optional).**

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

### remember (R4) — auth.method 분리 [LLM 0, 단순]
- `POST /api/projects/:id/memory/remember`. **쿠키 인증=사람→즉시 active**(non-fact는 createMemoryItem origin='human', fact는 upsertFact). **bearer=PM/CLI→candidate(rule R4)**.
- Codex BLOCKER: 현재 shared `PALANTIR_TOKEN`이라 쿠키/bearer spoof 가능 → **middleware(`middleware/auth.js`)가 `req.auth.method='cookie'|'bearer'` 설정**, bearer 있으면 cookie 있어도 bearer 판정. 완전 spoof-proof는 별도 PM token 필요(미래).

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

### PR4 — UI 사후교정 [∥ PR3 후]
- `MemoryView.js` + `#memory` 라우트: 열람/편집/archive/supersede + provenance(evidence) 표시. (U1 자동누적+사후교정의 교정 surface.)

### PR5 — 안전·decay·관측
- valid_to TTL/decay/hard cap(project당 active 200), observability 이벤트, poisoning 통합 게이트.

## 4. 작업 방식 (이 시리즈에서 확립)

- **직접 구현 + Codex 독립 교차리뷰**(athena 위임은 PR1만 성공, PR2a부터 미완반환 실패 → 직접 전환). 각 PR: 구현 → `node@22 --test` → Codex 적대 리뷰(BLOCKER까지 반복) → commit → push(Karnian) → squash merge.
- **better-sqlite3 ABI 함정**: codex exec가 node 26으로 rebuild하면 node@22(NODE_MODULE_VERSION 127)에서 깨짐 → `npm rebuild better-sqlite3` 복원. **테스트는 `/opt/homebrew/opt/node@22/bin/node --test`** 또는 `npm test`(PATH node@22).
- **repo push**: repo-local credential helper가 Karnian 계정 강제(gh active=skcc 유지) — `git config --local credential.helper '!f() { test "$1" = get && { echo username=Karnian; echo "password=$(gh auth token --user Karnian)"; }; }; f'`. PR/merge는 `GH_TOKEN=$(gh auth token --user Karnian) gh ...`.
- 풀 테스트 race-y flake 1~2건(preset-file-drift 등) 알려진 패턴 — 메모리 단독 통과가 진실 신호.

## 5. 재입장 prompt (다음 세션)

> "Memory Layer 다음 단계를 진행하자. `docs/handoff-memory-layer-pr1-2c.md` + `docs/specs/memory-layer-brief.md` 참고. PR1~PR3b merged — candidate→active 루프 닫힘(`PALANTIR_MEMORY_DISTILL=1`+`ANTHROPIC_API_KEY` 시 runtime 작동). **remember(R4 쿠키-PM 분리) / PR4(UI 사후교정 MemoryView) / PR5(안전·decay·graceful shutdown=NIT3) / PR3c(fuzzy 병합, optional)** 중 택일. Codex 교차리뷰 + 직접 구현, node@22 테스트. 계속 자율 진행."
