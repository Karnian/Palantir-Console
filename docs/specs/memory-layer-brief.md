# Memory Layer (ML) — 3계층 누적 암묵지 아키텍처 brief

> **상태**: v1.0 — **PR1 LOCK-IN** (Codex r1~r4 적대 리뷰 수렴 + SQLite 실측 검증, r4 revision semantics 반영). PR2~5 방향 확정, 각 착수 시 정밀화.
> **작성**: 2026-06-15 (v0.1→v0.2→v0.3→v0.4)
> **연관 spec**: `manager-v3-multilayer.md`, `h1-run-harvest-brief.md`, `h1-5-harvest-pm-review-brief.md`, `b-lite-queue-retry-brief.md`
> **목표 한 줄**: 시스템이 **이미 결정론적으로 관측 중인 고신호 이벤트**에만 올라타 **규칙으로 후보를 포착**하고 **batch LLM으로 가끔 정제**해 **작은 승인 메모리 인덱스**를 자동 누적한다. 주입은 Codex 캐싱을 깨지 않는 **user-payload 경로로만**. evidence 스냅샷·confidence ceiling·decay·project 스코핑으로 poisoning·무한성장·드리프트·누출을 막는다.

---

## 0. 사용자 결정 (lock-in)

| # | 결정 | 선택 |
|---|------|------|
| U1 | 자동화 | **자동 누적 + 사후 교정** (자동 active + confidence/decay/cap + UI 교정) |
| U2 | 비용 | **규칙 + batch LLM 혼합** (규칙 근거 명확 필수, §5) |
| U3 | 범위 | **L1 (PM 프로젝트 메모리)만** |

---

## 1. 비전
작업이 쌓일수록 각 PM이 프로젝트 암묵지를 **자동 축적**해 똑똑해지는 개인 비서. 현재는 `project_briefs`(사람 작성 정적)뿐, harvest/PM판정 미누적. L2(여러 PM→Master)는 후속.

---

## 2. 리뷰 대응 추적

**r1 BLOCKER**: 동적bake→user-payload / L0불변아님→evidence스냅샷 / harvested엔PM판정없음→규칙결정론만 / 멱등durability→UNIQUE+jobs / scope문자열→FK. **전부 CLOSED**.

**r2 BLOCKER**: R1구현불가→R1a/R1b분리(CLOSED) / R4 PM injection→§5(아래 r3 추가대응) / job lease→§4(PR3). **r2 SERIOUS** 다수: project_id NOT NULL, evidence CHECK, confidence정의, fact_key, FTS=narrow만, 전체PM프롬프트 테스트 — 반영.

**r3 BLOCKER → v0.4 해소**:
| r3 지적 | v0.4 해소 |
|---------|----------|
| R4 human/PM 인증 경계 없음(spoof) | **PR1에서 외부 remember 제거.** PR1 writer=memoryService 내부/seed(테스트). 실 writer=PR2 R6(서버 내부 규칙, actor 무관). **human remember는 PR2+에서 쿠키-인증 전용**(bearer=PM/CLI 거부 — auth.js 쿠키/bearer 분기 활용). PM-origin은 candidate only |
| PR1 revision counter 미구현체 | **`project_memory_revision(project_id,revision)` 단조 카운터 테이블**, active 변경 트랜잭션서 +1(§4) |
| memory_jobs CAS/recovery 미명시 | §4에 CAS claim SQL·stale requeue·attempts 한도 불변식 명시(PR3, PR1 비범위) |
| fact_key NULL 허용 / FK 누락 / content_hash UNIQUE 없음 / partial upsert 문법 | §4 스키마 전면 수정 |

---

## 3. 계층 모델 (v1 = L0 소비 + L1 신규)
```
L2 GLOBAL (Master)   ── v1 비범위 ──
L1 PROJECT (PM) ★신규  memory_items(승인 인덱스) ◀ 규칙 candidate → batch LLM 정제 → active
L0 EPISODIC (Worker)★기존 run_events+harvest+dispatch_audit_log  ⚠ON DELETE CASCADE→evidence는 L1 스냅샷
```
```
worker terminal→harvest→run:harvested ─┬─>sendPmReview()(기존)
                                       └─>ruleEngine.capture()(PR2+,결정론,LLM0)→candidate
task→'done'(PATCH=PM/user)             ──>R3 candidate(PR2+)
[주기]memory_jobs(distill)→batch LLM   ──>정제/병합(PR3+)
PM세션/리뷰→retrieveForProject→capped block→sendToManagerSlot user-payload prepend(PR1)
```

---

## 4. 데이터 모델 (migration 025, 외부 의존 0)

```sql
CREATE TABLE memory_items (
  rowid_pk      INTEGER PRIMARY KEY AUTOINCREMENT,   -- FTS5 external-content 매핑
  id            TEXT NOT NULL UNIQUE,                -- uuid
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  fact_key      TEXT,                                -- fact 전용 upsert 키
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,                       -- dedup 1차
  evidence_json TEXT NOT NULL DEFAULT '{}',          -- 서비스가 {schema_version,redaction_version,run_ids[],task_id,diff_stat,test,excerpt,hashes[]} 보장(아래 CHECK는 json_valid만)
  origin        TEXT NOT NULL,                       -- human|rule:R1b|rule:R3|rule:R6|batch_llm
  source_count  INTEGER NOT NULL DEFAULT 1,
  confidence    REAL NOT NULL DEFAULT 0.5,
  importance    INTEGER NOT NULL DEFAULT 5,          -- create 1회 IMMUTABLE
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  valid_to      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT,
  CHECK (kind IN ('convention','pitfall','heuristic','constraint','fact')),
  CHECK (status IN ('active','superseded','archived')),
  CHECK (origin IN ('human','rule:R1a','rule:R1b','rule:R3','rule:R6','batch_llm')),
  CHECK (confidence BETWEEN 0 AND 1),
  CHECK (importance BETWEEN 1 AND 10),
  CHECK (json_valid(evidence_json)),
  CHECK ((kind='fact') = (fact_key IS NOT NULL))     -- r3: fact ⇔ fact_key 존재 (양방향 강제)
);
CREATE UNIQUE INDEX idx_memory_factkey ON memory_items(project_id, fact_key)
  WHERE fact_key IS NOT NULL AND status='active';
CREATE UNIQUE INDEX idx_memory_content_hash ON memory_items(project_id, content_hash)
  WHERE status='active';                             -- r3: 동시 write active 중복 차단
CREATE INDEX idx_memory_project_status ON memory_items(project_id, status, importance DESC);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  content, content='memory_items', content_rowid='rowid_pk', tokenize='unicode61'
);
-- 트리거 3개(ai/ad/au) + 초기 INSERT INTO memory_fts(memory_fts) VALUES('rebuild')

-- PR1: 단조 revision 카운터 (r3 — max(updated_at) 해시 금지)
CREATE TABLE project_memory_revision (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL DEFAULT 0
);
-- memoryService가 active 변경(insert active / status↔active / content update) 트랜잭션 내에서 단일 경로 bump:
--   INSERT INTO project_memory_revision(project_id,revision) VALUES (?,1)
--     ON CONFLICT(project_id) DO UPDATE SET revision=revision+1;
-- r4: VALUES(...,1)로 첫 변경=1 보장 (default 0 insert면 injected_revision=0 세션이 첫 메모리 미감지).

-- PR1: 주입 ledger (resume 중복/매턴 재주입 방지)
CREATE TABLE pm_memory_injection (
  pm_run_id         TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- r3: FK
  injected_revision INTEGER NOT NULL DEFAULT 0,
  injected_at       TEXT
);

-- PR2+: 규칙 후보
CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule TEXT NOT NULL, raw_json TEXT NOT NULL, dedup_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', promoted_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rule, project_id, dedup_key),
  CHECK (status IN ('pending','promoted','rejected','merged')),
  CHECK (json_valid(raw_json))
);

-- PR3+: batch job (CAS lease/claim/recovery)
CREATE TABLE memory_jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- r3: FK
  status TEXT NOT NULL DEFAULT 'pending',
  claim_token TEXT, locked_at TEXT, run_after TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending','running','done','failed'))
);
CREATE UNIQUE INDEX idx_jobs_active ON memory_jobs(kind, project_id) WHERE status IN ('pending','running');
-- CAS claim(불변식, PR3): UPDATE memory_jobs SET status='running',claim_token=?,locked_at=now,attempts=attempts+1
--   WHERE id=(SELECT id ... WHERE status='pending' AND (run_after IS NULL OR run_after<=now) ORDER BY created_at LIMIT 1)
--   AND status='pending';  획득은 changes()===1 로 확인.
-- stale requeue: status='running' AND locked_at<now-Nmin → status='pending',claim_token=NULL.
-- attempts>=MAX → status='failed'. release: done/failed.
```
`project_briefs`(사람 정적) 분리 유지. 주입 precedence: **human brief > human memory > rule/batch active > candidate(주입 안 함)**.

---

## 5. 규칙 (candidate 포착) — 규칙별 선별 근거 [PR2+]

**선별 원칙**: ① 이미 결정론적으로 관측 중인 신호만(새 관측 0) ② 임의 worker 텍스트 직접 메모리화 ✕(injection 방어 — 규칙이 구조화 신호에서 생성) ③ provenance 명확.

| 규칙 | 결정론 신호 (코드 근거) | kind | 선별 근거 | 처리 |
|------|----------------------|------|----------|------|
| **R1b 수정학습**★ | run X=completed+`harvest:test`FAIL → 같은 task_id 이후 run Y=completed+PASS(또는 done). X→Y diff. (`harvestService.js:403`) | pitfall+heuristic | 실패-수정 쌍=정보량 최고(Reflexion/ReasoningBank). harvest+task 공짜 생산 | candidate→batch |
| **R6 환경사실** | harvest 결정론 산출: `test_command`, node major/source(T4). build/run결과·디렉토리는 제외(run-specific) | fact | 100% 결정론·오염0·즉시유용. `fact_key` upsert로 race 차단 | **즉시 active**(PR2) |
| **R3 PM판정** | task `'done'` PATCH(=PM/user; lifecycle 자동은 `'review'`까지 `checkTaskCompletion:1079`) + `dispatch_audit_log`(pm_run_id+task_complete) | heuristic/constraint | PM 실제 결정. 'done' PATCH+audit claim으로 actor 결정론(Explore 검증) | candidate→batch |
| **R4 명시capture** | `remember`. **PR1 비범위**(r3 actor). PR2+: human=쿠키전용 즉시active / PM=candidate | any | human/PM 분리 필수 | PR2+ |
| **R1a 재시도** | failed→`queue:retry`(retry_count+1)→PASS. 동일 prompt=flaky | (flaky) | 학습약함 → **deferred** | deferred |
| **R5 반복성공** | (batch) 여러 PASS 공통 | heuristic | AWM/Voyager, 단발불가 | deferred(PR3+) |
| **R2 audit반복** | 동일 incoherence 반복 | pitfall(meta) | self-correction, 후속 | deferred |

**분업**: 규칙=신호포착(결정론 LLM0). R6/human-R4=즉시active. R1b/R3/PM-R4=candidate→**batch LLM 정제·redaction·FTS병합/ADD**(rate cap, durable job).

---

## 6. 인출 & 주입 (Codex 캐싱 안전) [PR1]
**인출** `retrieveForProject`: project_id+active+valid_to → taskContext로 **FTS5 narrow**(MATCH escape/빈쿼리 fallback 필수, 없으면 500) → BM25(낮을수록 관련, 정렬방향 명시)+importance+recency → top-K(12)+글자cap(2000). access는 inline UPDATE ✕(batch 집계).

**주입(3중, system prompt 동적변경 ✕)**:
1. **system prompt 고정 안내**(캐싱 안전): pm 템플릿에 *"학습 메모리는 작업 통지에 첨부+`GET /api/projects/:id/memory`"* 한 줄.
2. **user-payload prepend(주)**: `sendToManagerSlot` parent-notice prepend 직전 `## Learned Memory` capped block. **영속 `pm_memory_injection` ledger로 세션당 1회/revision 변경 시만**. auto-review도 이 경로.
3. **GET API(보조)**.

> bake 폐기: PM `pm_thread_id` resume(`pmSpawnService:224`), live=fast-path(`:148`) 미주입, scope 섹션 `manager.js:184-203` 중복 → bake면 양쪽. **user-payload=단일점**.

---

## 7. 안전장치
| 위협 | 대응 |
|------|------|
| Poisoning | evidence 스냅샷+origin, worker텍스트 직접메모리화✕, batch redaction, **PM-origin=candidate**, human remember=쿠키전용(bearer 거부) |
| Over-generalization | confidence ceiling: 단일run≤0.7. **"독립run"=다른 run.id+다른 task_id 또는 다른 failure-signature**. ≥2만 상향. core모순=flag |
| Secret leak | candidate raw·LLM입력 전 redaction, redaction_version 기록 |
| Injection | 규칙은 구조화신호만, worker자유텍스트=evidence excerpt(untrusted)만 |
| Stale | valid_to TTL, fact는 fact_key upsert supersede, decay→archived |
| 무한성장 | active hard cap(200/project), 초과시 최저score archive |
| job 유실 | memory_jobs CAS claim + stale requeue + attempts 한도(§4) |

---

## 8. 통합 지점
| 지점 | 파일:심볼 | PR |
|------|----------|-----|
| 주입(주) | `conversationService.sendToManagerSlot` user-payload prepend + ledger | PR1 |
| 주입(안내) | `managerSystemPrompt._buildCommonBaseInner`(pm) 고정 한 줄 | PR1 |
| 서비스 | `services/memoryService.js`(신규) CRUD/retrieve(FTS5)/revision | PR1 |
| 스키마 | `db/migrations/025_memory_layer.sql` items+fts+triggers+revision+ledger | PR1 |
| GET API | `routes/memory.js`(신규) | PR1 |
| 규칙 R6/R1b/R3 | ruleEngine + `app.js` run:harvested 구독 + task-status hook | PR2 |
| human remember(쿠키전용)/PM candidate | `routes/memory.js` + auth 분기 | PR2 |
| batch LLM | memory_jobs CAS + scheduler + redaction | PR3 |
| UI | `MemoryView.js`+`#memory` | PR4 |

**불변(read-only)**: L0 = run_events/harvest/dispatch_audit_log.

---

## 9. L2 (후속) — 승격=빈도(≥2 프로젝트)+재추상화(단순summary✕), source_project_ids+역인출제외+pending격리+수동승인, fact승격✕.

---

## 10. 개발 계획

**PR1 (뼈대·선행, LOCK-IN 후보)** — "수동/seed 메모리가 캐싱 안 깨고 PM에 주입되는 검증된 read→inject 파이프라인":
- migration 025: memory_items + FTS5(트리거3 + rebuild) + project_memory_revision + pm_memory_injection
- memoryService: CRUD(내부), retrieve(FTS5 narrow + escape/fallback), revision 단조 증가(단일 트랜잭션 경로). content_hash 중복은 partial-unique(WHERE status='active') constraint error catch→merge 경로(ON CONFLICT 타겟에 partial 조건 매칭 필요, r4)
- sendToManagerSlot user-payload 주입 + ledger(세션당1/revision변경시)
- GET /api/projects/:id/memory (읽기)
- **회귀 테스트**: 전체 PM system prompt(brief+skillpacks+pm_run_id) 불변 — **fresh spawn + boot resume 양쪽**(`manager.js:184` 중복 경로 포함)
- **비범위**: 외부 remember 쓰기 API(R4), 규칙, batch, UI

이후(PR1 후 일부 ∥):
- **PR2(결정론 규칙)** ∥: R6 fact(fact_key 즉시active) + R1b candidate + R3 candidate + human remember(쿠키전용)/PM candidate
- **PR3(batch LLM)**: memory_jobs CAS + scheduler + rate cap + redaction + FTS병합/ADD + confidence ceiling
- **PR4(UI)** ∥: MemoryView 열람/편집/archive/supersede + provenance
- **PR5(안전·decay·관측)**: TTL/decay/cap/observability + poisoning 통합검증

각 PR: branch→구현→npm test→**Codex 교차검증(PASS까지)**→commit→PR→merge.

---

## 11. 성공 기준
정량: PM review 라운드↓ / harvest test 첫-PASS율↑ / 반복 pitfall 재발↓. 정성: PM이 주입 메모리 인용(run event). 안전: scope 누출0 / secret leak0 / **Codex cache hit율 유지** / 사후교정 복구.

---

## 12. 상태: PR1 LOCK-IN ✓ (적대 리뷰 종료)
Codex r1~r4 적대 리뷰로 수렴. r4 최종: SQLite 스키마 실측(3.51 CLI) 통과, R4 제거 정당, revision-semantics(VALUES(?,1)) 반영. **남은 OPEN BLOCKER 0 — PR1 개발 착수 가능.**

라운드 요약: r1(동적 bake/L0불변/멱등/scope BLOCKER 5) → r2(R1 구현불가/R4 injection/job lease + "approved evidence index" 전환) → r3(R4 actor분리/revision/CAS) → r4(revision 첫변경 semantics). 각 라운드 실질 수렴. PR2~5는 각 착수 시 동일 절차로 정밀화.
