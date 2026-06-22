# A2-④-a 정직성 패치 — 극성소실 reject **only** (계획 v0.3, Codex R1+R2 반영 = GO-ready)

> 상위: `memory-augmentation-brief.md` 보완④(Truth-laundering 방어, Codex `REVISE 범위축소`).
> owner-agnostic standalone — 사용자 "가볍게" 지시.
> **이름 강등(Codex R1 Q4)**: 본 slice는 `A2-④-a polarity-lost reject only`. brief의 "부정어 포함 claim 자동통과 금지"(human-review)는 **미구현 잔여 리스크**로 남긴다 — 충족 주장 금지.
> A2-④-b(human-flag) / A2-⑤(독립성) / A3(모순) = 별개 slice.

---

## 0. Codex R1 판정 = REVISE (반영 완료)
- **BLOCKER1** 한국어 substring 매칭 오탐(`안→보안/안내`, `없→관계없이`, `불→불러오기`, `미→미들웨어`, `비→비동기`) → §2.3 strong-negation regex + 오탐 회귀테스트 先lock.
- **BLOCKER2** "PR4 rejected 복구 가능" = **거짓**(검증: `memory.js`·`MemoryView` 전부 memory_items만, candidate review/requeue API 無) → §2.5 "lossy safety drop" 정직화.
- **SERIOUS1** gate reference ≠ distiller가 본 텍스트(`liveDistiller.summarizeRaw`는 R4를 `JSON.stringify(raw).slice(0,200)`만 노출) → §2.2 reference cap 일치 + §3 distiller R4 special-case.
- **SERIOUS2** 영어 distiller prompt → 한국어 R4가 영어 lesson 되면 언어가드로 핵심 위협 누락 → §2.4 "source language 유지" 보강 + language_mismatch 계측.
- **SERIOUS3** 새 이벤트는 `eventChannels.js` 등록 + commit 후 emit → §2.5.

## 0b. Codex R2 판정 = REVISE→조건부 GO (4 Δ 반영 완료, v0.3)
1. **shared reference 함수**: cap/normalize를 상수 공유가 아닌 **동일 함수** `summarizeR4ReferenceContent(content)`(memoryPolarity.js export, deps0=순환無)로 단일화 — liveDistiller·memoryService 둘 다 이걸로 reference 생성 (§2.2/§3). 상수만 공유하면 normalize 로직이 갈라져 비대칭 false-positive.
2. **한국어 패턴 축소**: `불가피`(inevitable=부정 아님) 제거, `없이`(관계없이/문제없이/차질없이=관용) 제거. `없` exclude는 lookbehind 대신 **"exclude 토큰 사전 replace 후 count"** 방식 (§2.3).
3. **R4 입력 타입 + 언어유지 prompt**: SYSTEM_PROMPT가 "failure→fix / verdict"만 설명 → R4 special-case 넣으면 "explicit remembered project-memory candidate" 입력 타입도 추가해야 모델 입력모델 정확 + 언어유지 (§3, 이 slice 포함).
4. **stale 주석 제거**: `memoryService.js:921`의 `Rejected rows are recoverable via PR4 UI` = 거짓 → 같이 수정 (§4).
- MINOR: `summarizeRaw` export 불필요(R4 일치 테스트는 `buildUserMessage`로). → 채택.

## 0c. 구현 완료·머지 (2026-06-22~23)
- **구현**: codex adapter hang → Claude sub-agent 구현. **Claude 독립 리뷰가 detectNegation 실버그 3건 발견·수정**: ① 영어 축약(don't/doesn't)이 EN_NEG_WORDS+`\w+n't` 중복카운트(=2)→이중부정가드로 영어 축약 단일부정 전부 무력화 ② `잘못 됐다`가 `못\s+`로 오탐(과탐=lossy) ③ `아니메`가 KO_ANIDA optional group 오탐.
- **Codex impl R1**: REVISE — 1 BLOCKER(조건부 `~않으면`/관용 `못지않다`/`아니면`이 잡혀 정상 메모리 lossy-reject = 계획 §2.3 설계 정반대) + 2 SERIOUS(distiller가 untrusted raw_json.rule 의존 / 테스트가 새 경계 미잠금) → 전부 수정(KO_AUX_NEG 조건·양보 lookahead, KO_ANIDA `면` 제거, 못지않 exclude, summarizeRaw(raw,rule) 신뢰컬럼, 테스트 보강).
- **Codex impl R2**: **GO** — 3건 닫힘 확인. 비차단 잔여 1(`지 않 으면` 변태공백)도 `(?!\s*(?:...))` 로 반영.
- 풀스위트 **1552 green**(node@22). 검증체인: 계획 Codex 2R + 구현 Codex 2R + Claude 독립리뷰(3 실버그).

---

## 1. 위협 모델 (좁지만 실재 — Codex "kill 아님")
distiller(LLM)가 candidate raw signal을 일반화해 active content를 만든다. **정제도 권력** — 부정 명제의 극성을 소실/반전(`X 쓰지 마`→`X 써라`)시키면 잘못된 신념이 active로 promote→PM 주입. 현 promote 게이트(kind/secret/injection/length/clamp)는 **극성을 보지 않는다**.

**실효 표면(좁음, 정직)**: R4 `bearer·none`(untrusted) candidate 中 → **같은 언어 단일부정 명제**가 → distiller에 의해 부정어 0개 content로 정제된 경우. (cookie=human R4는 active 직행=distill 미경유. R3 rationale=근거≠교훈 축. R1b=통계.) 좁지만 비용도 작아 살릴 가치 有(Codex). 이건 truth 검증이 아니라 **distiller faithfulness(source 극성 세탁 여부)** 검증이라 untrusted를 reference로 써도 논리 타당(Codex Q1).

---

## 2. 설계 lock (Codex R1 Δ 반영)

### 2.1 위치
`promoteCandidatesBatchTx` 내부, `sanitizeProposalContent` **직후 / exact·fuzzy merge 前**(memoryService.js:952~957). writer = 단일 안전강제(우회 불가). distiller/orchestrator 아님.

### 2.2 reference 추출 (Δ2 + R2-Δ1)
`extractPolarityReference(candidate)`:
- `candidate.rule === 'R4'` (신뢰 컬럼) AND `raw.content` is string 일 때만. 아니면 `null`(=비교 skip).
- reference 텍스트 = **`summarizeR4ReferenceContent(raw.content)`** — whitespace normalize + cap을 한 함수에 캡슐화. **distiller(§3)와 동일 함수를 호출**해 "distiller가 본 텍스트 = gate reference" 보장 (상수 공유로는 normalize 로직이 갈라질 수 있음 = R2-Δ1). 이 일치가 SERIOUS1의 핵심 — gate가 distiller 미관측 후반부로 reject하면 false-positive.

### 2.3 극성 detection (Δ1 — substring 금지)
신규 `server/services/memoryPolarity.js` (순수·deps 0): `detectNegation(text) → { count, hasHangul }`.
- **substring 매칭 절대 금지.** strong-negation 패턴만 (오탐 < 신호):
  - 한국어(고신뢰): 보조용언 `~지\s*않`(`하지 않/되지 않`), `~지\s*마(라|세요)?`/`~지\s*말`, `아니(다|라|며|었)|아닌|아님`, `못\s+\S`(못+동사), `안\s+\S`(안+동사), `금지|불가(능)?|불허|불필요|미지원|미구현|미사용|비권장|비허용|비활성`.
  - **R2-Δ2 축소**: `불가피`(inevitable=부정 아님) **제거**(`불가` 뒤 `피` 차단). `없`/`없이` 계열은 **이번 slice 제외**(`관계없이/상관없이/문제없이/차질없이` 관용 false-positive 과다). `없다` 단독도 신호 대비 위험 커 보류 → A2-④-b 재검토.
  - **exclude 구현(R2-Δ2)**: lookbehind 대신 **"exclude 토큰을 먼저 빈문자 replace → 그 후 negation count"** 방식 (예 `보안/안내/안전` 류는 `안` 매칭 전에 사라지게). 정규식 lookbehind 단독 의존 금지.
  - 영어: `\b(?:not|no|never|cannot|can'?t|won'?t|don'?t|doesn'?t|didn'?t|shouldn'?t|mustn'?t|avoid|without|disallow|prohibit|forbid)\b` + `\w+n't`.
- **한계 수용(brief)**: 접미활용 일부·조건부(`~않으면`)·양보(`~해도`)는 못 잡음 = false-negative(안전 방향). 주석+테스트로 경계 명시.
- **오탐 회귀테스트를 토큰셋과 함께 먼저 lock**(Codex Δ1): `보안/안내/안전/미들웨어/비동기/비교/불러오기/관계없이/상관없이/문제없이/불가피/업데이트` 등이 부정으로 안 잡히는지.

### 2.4 polarity-lost 판정 (보수적)
`polarityLost(reference, content)`:
1. `reference == null` → false (R3/R1b/비-R4).
2. **언어가드**: `ref.hasHangul !== content.hasHangul` → false + (선택) `polarity_unchecked` 계측. (distiller 한↔영 변환 시 카운트 비교 무의미 = 최대 false-positive 원인.)
3. **이중부정가드**: `refNeg.count >= 2` → false (이중부정=반전 가능, 결정론 신뢰 불가).
4. **단일·동일언어 소실만**: `refNeg.count === 1 && contentNeg.count === 0` → **true(reject)**. 그 외 전부 false.
- **output 측은 sanitized `s.content` 기준**(Δ5): truncate가 부정어를 잘랐으면 stored active가 부정어 0개이므로 reject가 옳다.

### 2.5 disposition (Δ6 + BLOCKER2 정직화)
- polarity-lost → 기존 `rejectCandidate` + `skipped.push({reason:'polarity_lost'})`. status='rejected'(기존 enum, **migration 0**).
- **정직한 한계**: 이건 **lossy safety drop**이다. candidate는 DB에 `rejected`로 보존되나 **현재 복구 UI/API 없음**(L1 candidate review 경로 부재) → 잔여 리스크로 명시. 오탐을 §2.3로 극단적으로 낮추는 게 lossy 채택의 전제.
- **이벤트**: `memory:polarity_rejected` — tx 결과에 누적 후 **commit 이후 `emitMemoryEvents`에서 emit**(tx 내부 금지) + **`eventChannels.js` 등록**. payload `{ projectId, candidateId, rule }`(content 미포함).

### 2.6 의도적 제외 (scope 보호)
- **human-flag(부정어 포함→review) 제외.** pitfall은 본질적 부정형 多 → 전부 flag=시스템 파괴. needs_review status+candidate review UI는 migration/API/UI = 무거움 → A2-④-b 분리. **brief "부정어 포함 자동통과 금지"는 미충족(잔여).**
- A2-⑤·A3·L2 동형 = 별개.

---

## 3. distiller 일치 (Δ3, SERIOUS1 + R2-Δ1/Δ3)
`liveDistiller.summarizeRaw`에 R4 special-case 추가: 현 `JSON.stringify(raw).slice(0,200)` → `remembered ${raw.kind}: ${summarizeR4ReferenceContent(raw.content)}`. **gate(§2.2)와 동일 함수** `summarizeR4ReferenceContent`(memoryPolarity.js export, deps0=순환無) 호출 → "distiller가 본 텍스트 = gate reference" 보장(상수 공유 아님, R2-Δ1). `summarizeRaw` 자체 export는 불필요 — R4 일치 테스트는 `buildUserMessage` 출력으로 검증(R2-MINOR).
- **SYSTEM_PROMPT 보정(R2-Δ3, 이 slice 포함)**: 현 프롬프트는 입력을 "failure→fix / verdict"로만 설명 → R4 분기 추가 시 **"explicit remembered project-memory candidate"** 입력 타입을 명시(안 하면 모델 입력모델이 틀림) + **"source 명제의 언어를 유지하라(번역 금지)"** 한 줄(언어가드 통과율↑ → gate 실효↑). distiller 동작 변경이므로 mock callModel 테스트로 system/user prompt 고정.

## 4. 변경 파일
- **신규** `server/services/memoryPolarity.js` (~60줄, deps0): `detectNegation(text)→{count,hasHangul}` + `polarityLost(reference,content)` + **`summarizeR4ReferenceContent(content)`**(cap+normalize 단일 진실, §2.2/§3 공유).
- `server/services/memoryService.js`: promote tx에 reference 추출(R4만)+게이트+reject(~12줄), `emitMemoryEvents`에 polarity_rejected(~3줄), **`:921` stale 주석 `Rejected rows are recoverable via PR4 UI` 수정**(R2-Δ4 — 거짓 주장 제거, lossy-drop 현실 반영).
- `server/services/distillers/liveDistiller.js`: summarizeRaw R4 special-case(`summarizeR4ReferenceContent` 호출) + SYSTEM_PROMPT R4 입력타입+언어유지(R2-Δ3).
- `server/services/eventChannels.js`: `memory:polarity_rejected` 1줄.
- **신규** `server/tests/memory-polarity.test.js`: 단위(detectNegation 한/영/이중부정/**오탐셋 §2.3**, polarityLost 언어가드, `summarizeR4ReferenceContent` cap) + promote tx 통합(R4 극성소실→reject / 극성보존→통과 / 영어정제→언어가드skip / R3·R1b→통과 / 정상→byte-equiv) + distiller R4 `buildUserMessage` 일치(gate reference == distiller 노출).

## 5. 검증
- node@22 풀스위트 green. byte-equiv: 부정어 없는 candidate·R1b·R3 → 현 promote 결과 불변(detectNegation 호출만 추가, 판정 false).
- 오탐 회귀(§2.3 셋) 통과 = lossy reject 안전 전제.

## 6. 남은 Codex R2 확인
- §2.3 strong-negation 패턴이 오탐셋을 전부 통과하면서 핵심 부정(`하지 않`/`쓰지 마`/`아님`/`없다`)을 잡나? `없` 활용 exclude 목록이 충분/과한가?
- §3 distiller prompt "언어 유지" 보강을 이 slice에 포함할지(실효↑) vs 분리할지(behavior change 최소화).
- lossy drop 채택이 "가볍게"와 "복구불가 리스크" 사이에서 수용 가능한가, 아니면 needs_review까지 가야 하나(무거워짐).
