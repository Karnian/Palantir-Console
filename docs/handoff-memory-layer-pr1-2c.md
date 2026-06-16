# Handoff — Memory Layer PR1~PR2c 완료, PR3~5 재입장

> **작성**: 2026-06-16
> **상태**: 4 PR merged (#197 PR1 / #198 PR2a / #199 PR2b / #200 PR2c). 1103 tests.
> **spec**: `docs/specs/memory-layer-brief.md` (v1.x). **다음 세션은 §10 PR3 부터.**

## 1. 완료된 것 (main)

3계층 누적 암묵지 메모리. Worker harvest/PM판정 → PM 프로젝트 메모리 자동 증강 → 다음 PM 세션 주입.

| PR | 규칙/기능 | 동작 | active? |
|----|----------|------|---------|
| #197 PR1 | read→inject 뼈대 | 메모리를 user-payload로 PM 주입(캐싱 안전, bake 금지). fresh+resume system prompt 불변 회귀. | — |
| #198 PR2a | R6 환경 사실 | harvest:test의 test_command/node 해석 → fact 메모리 **즉시 active 주입** (upsertFact supersede) | ✅ active |
| #199 PR2b | R1b 실패→수정 | test FAIL run 직후(직전 RUN) PASS = fix 쌍 → candidate. rowid(_seq) 생성순 | candidate |
| #200 PR2c | R3 PM 판정 | coherent task_complete(검증된 것만, hallucination 제외) → candidate | candidate |

**핵심**: R6는 즉시 active(주입됨). **R1b/R3 candidate는 PR3(batch LLM)가 active로 정제해야 주입된다** — 현재는 `memory_candidates`에 적재만.

## 2. 아키텍처 (구현 위치)

- `server/services/memoryService.js`: createMemoryItem / **upsertFact**(fact_key supersede tx) / **createCandidate·listCandidates**(ON CONFLICT DO NOTHING) / retrieveForProject(FTS5 BM25 escape+fallback) / revision(VALUES(?,1) 단조) / 주입 ledger(pm_memory_injection).
- `server/app.js`: createR6FactCapture / createR1bCapture / createR3Capture — **각각 eventBus 독립 구독(run:harvested / run:harvested / dispatch_audit:recorded), never-throws**. conversationService user-payload 주입(sendToManagerSlot, 세션당1/revision변경시 ledger).
- `server/routes/memory.js`: GET /api/projects/:id/memory (evidence whitelist).
- migration **025**(memory_items+FTS5+revision+pm_memory_injection) / **026**(memory_candidates: rule∈R1b/R3/R4, UNIQUE(rule,project,dedup_key), promoted_to FK).
- 테스트: memory.service / memory-injection / r6-fact-capture / r1b-fix-capture / r3-verdict-capture (57 memory tests).

## 3. 남은 작업 (PR3~5 + remember)

### remember (R4) — auth.method 분리 [LLM 0, 단순]
- `POST /api/projects/:id/memory/remember`. **쿠키 인증=사람→즉시 active**(non-fact는 createMemoryItem origin='human', fact는 upsertFact). **bearer=PM/CLI→candidate(rule R4)**.
- Codex BLOCKER: 현재 shared `PALANTIR_TOKEN`이라 쿠키/bearer spoof 가능 → **middleware(`middleware/auth.js`)가 `req.auth.method='cookie'|'bearer'` 설정**, bearer 있으면 cookie 있어도 bearer 판정. 완전 spoof-proof는 별도 PM token 필요(미래).

### PR3 — batch LLM 정제 (candidate→active) [핵심, LLM 비용]
- migration **027**: `memory_jobs`(CAS lease/claim: claim_token/locked_at/run_after/attempts). Codex 자문 불변식: `UPDATE memory_jobs SET status='running',claim_token=?,locked_at=now,attempts=attempts+1 WHERE id=(SELECT ... WHERE status='pending' AND (run_after IS NULL OR run_after<=now) ORDER BY created_at LIMIT 1) AND status='pending'` (changes()===1 확인). stale requeue(locked_at<now-Nmin), attempts>=MAX→failed, release는 `WHERE id=? AND claim_token=? AND status='running'` token-guarded.
- scheduler + **저비용 batch LLM 정제**: pending candidate(R1b/R3) → 일반화된 pitfall/heuristic content. **redaction**(candidate raw의 excerpt에 secret 패턴). **confidence ceiling**(단일 run ≤0.7, cross-run≥2만 상향). **FTS5로 유사 active 찾아 병합(source_count++) 또는 ADD**. candidate.status=promoted, promoted_to.
- **rate cap + on/off 플래그**(CLAUDE.md "LLM 상당량 호출"). 구현은 mock LLM 테스트, 실제 호출은 플래그.
- 성공 시 R1b/R3 candidate가 active → 주입(retrieveForProject) → PM이 실패에서 배운 교훈/판정을 다음 작업에 활용.

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

> "Memory Layer 다음 단계를 진행하자. `docs/handoff-memory-layer-pr1-2c.md` + `docs/specs/memory-layer-brief.md` §10 참고. PR1~PR2c(#197~#200) merged 상태. **PR3(batch LLM candidate→active 정제)** 또는 remember(R4) 부터. Codex 교차리뷰 + 직접 구현, node@22 테스트. 계속 자율 진행."
