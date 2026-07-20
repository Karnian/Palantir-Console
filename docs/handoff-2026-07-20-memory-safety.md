# Handoff — 2026-07-20 favorite 트랙 마무리 + memory-safety hardening

> 다른 기기/새 세션 재입장용 durable 기록. 로컬 `~/.claude/.../memory/` 는 기기 간 동기화되지 않으므로 **이 repo 문서 + 커밋 메시지가 authoritative** 하다.

## 이번 세션 완료 작업 (전부 origin/main 에 push 됨)

| 항목 | 커밋 | 요약 |
|------|------|------|
| B-adm staleness 근본해결 | `ccfa153` (+ 문서 `fec10e8`) | harvest payload `declared_node_major` 3-way 관측으로 R6 env.node_resolution fact 의 project→server 오철회 제거 |
| 공유 detectInjection/redactSecrets hardening | `d14d188` (+ 문서 `3df7b5b`) | 9개 모듈이 공유하는 `memorySanitize.js` 강화 (한국어 인젝션 + Unicode 회피 + provider/Basic secret) |

메인 HEAD = `3df7b5b`. `git pull origin main` 으로 다른 기기에서 그대로 받는다.

### 1) B-adm staleness 근본해결 (`ccfa153`)
- **문제**: B-adm 은 `node_source==='project'` 만 R6 fact 승격 → `node_source='server'` 가 **무선언 vs 동일-major 선언**을 혼동, `.nvmrc` 제거 후에도 stale "requires N" 잔존. 안전한 runtime 철회 불가였음.
- **해결**: harvest payload 에 `declared_node_major` 를 3-way 관측(`harvestService.classifyDeclaredNode`: `exact`/`none`/`indeterminate`).
  - **오직 "유효 dir + 선언 파일/필드 부재"만 `none`(철회)**. malformed root/engines(비-plain-object)·빈 선언·비정상/소멸 루트(초기 `statSync` + dev/ino 재검증)·range·remote executor 는 `indeterminate` → 필드 생략 no-op(오철회 0).
  - `memoryService.retractR6Fact` (한 tx: archive + revision bump, `origin='rule:R6' AND pinned=0` guard).
  - `app.js createR6FactCapture`: declared 기반 admission (none→retract / exact→promote[동일-major·미설치 포함] / legacy 부재→기존 node_source gate byte-identical, 두 upsertFact never-throws).
- **검증**: codex 적대검토 4R 수렴(계획 NO-GO → diff R1 malformed → R2 비정상 루트 → R3 TOCTOU → **R4 GO**). npm test 2437 그린.

### 2) 공유 detectInjection/redactSecrets hardening (`d14d188`)
- **대상**: `server/services/memorySanitize.js` — memory promote/distill, B1 watchlist, A2b-2 turn-codebase, remember 라우트 등 **9개 모듈 공유 초크포인트**.
- **강화 5축**:
  1. `normalizeForScan` (NFKC + zero-width/bidi/제어 strip, **개행 보존**) → `detectInjection` 이 raw ∪ normalized 양쪽 스캔 (순수 additive, fullwidth/zero-width 회피 차단, 출력 불변).
  2. 한국어 인젝션 패턴 (지시무시=ignore+action 2-branch[하다-verb/보조용언], 역할주입=identity+copula, role marker) — 명사 anchored·인용/부정/회고 배제로 **human-remember 400 오탐 0**.
  3. provider secret 추가 (Google AIza/ya29, Stripe, npm_, glpat-, conn-string user:pass@; 고정길이 suffix-agnostic·가변길이 negative-lookahead 경계).
  4. **`Basic` auth = 바이트레벨 charset-agnostic 검증** (정규식 아님 — 미선언 charset 검증은 decidable 하지 않음). C0/DEL 거부(RFC 7617 control 금지) + colon 0x3A 요구, 高바이트 허용 → UTF-8/ISO-8859-1/Windows-1252/Shift-JIS/EUC-* 커버. **stateful ESC charset(ISO-2022-*/HZ) 은 명시적 accepted-debt** (코드 주석). + obfuscation backstop(normalizeForScan 후 재검사 fail-closed).
  5. `REDACTION_VERSION` 1→2.
- **검증**: codex 적대검토 **13R**(계획 GO-WITH-FIXES → diff R1 NO-GO[혼합 obfuscated 누출·human-400 오탐 2 BLOCKER] → R2~R12 Basic 경로 순차 폐색[디코딩·padding·floor{2,}·빈필드·charset] → **R13 GO**[accepted-debt scope 인정]). 직렬 npm test 2451 그린.
- **한국어 recall 완전성**은 accepted-debt NIT (regex 는 보조 방어).

## favorite / codebase-pool 트랙 = 전부 완료
`docs/specs/codebase-pool-memory-axes-brief.md` §0 에 전 phase 완료 스탬프. A0/P0/A1/A2a/A2b(1/2/3) + B0/B2a/B1/B2b/B-adm/flip + declared_node_major + detectInjection hardening 전부 merged/pushed. 남은 필수 follow-up 없음(선택 후속만: PR3c-2 cross-run confidence / L2 등, brief/backlog 참고).

## 교훈 (durable)
- **미선언-charset credential 검증은 undecidable** — codex 가 utf8/latin1/byte-level 각 접근의 charset gap 을 순차 입증. 명시적 scope-out 이 수렴점. Basic 은 Bearer 있음에도 9라운드 소모한 footgun, 바이트레벨이 근본해.
- **narrow-guard 원칙**: "무엇이 (철회/redact 를) 정당화하나"를 극도로 좁게 정의. 비정상/모호 입력은 no-op(오작동 0).
- **테스트 flake 원인 = 사용자 dev 서버(포트 4177)의 `palantir.db` 파일 공유** + 내 타임아웃 백그라운드 프로세스 잔존. `node --test --test-concurrency=1` 직렬 실행으로 배제(사용자 dev 서버는 kill 금지). memory-sanitize 단독은 항상 그린.
- **codex-goal 세션훅 auto-commit 함정**: 워크트리 patch 는 base 커밋 기준 diff(HEAD 아님) 또는 dangling commit 복구.
- **로컬 memory 디렉토리 소실 주의**: 이번 세션 도중 `~/.claude/.../memory/` 가 통째로 사라짐(원인 불명). 복구는 세션 transcript(`.jsonl`)의 Read tool_result 에서만 가능 → **Read 안 된 파일은 복구 불가**. **중요 결정/교훈은 반드시 repo(커밋 메시지·`docs/specs`·이 handoff)에도 남길 것.** (로컬 memory 24개는 인덱스 요약 stub 로만 복구됨.)

## 다른 기기 재입장 방법
1. `git pull origin main` (HEAD `3df7b5b` 이상).
2. 상태 파악: 이 문서 + `docs/specs/codebase-pool-memory-axes-brief.md` §0 + `docs/backlog.md`.
3. node@22 환경(better-sqlite3 ABI). `npm ci` 후 `npm test --test-concurrency=1`.
4. 로컬 memory 는 기기별로 재구축됨(동기화 안 됨) — repo docs 가 authoritative.
