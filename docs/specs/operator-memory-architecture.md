# Master · Operator · Worker 메모리 구조

> 사람이 한눈에 보는 메모리 아키텍처. PM→**Operator** 일반화 + **2-tier(Raw 아카이브 + Governed 주입)** 전면 개편.
> 상태: draft / for-review — Codex 적대 교차검토 반영("guarded GO"). 구현 전 §8 블로커 충족 필수.
> 상세 근거: 이 문서 + `master-memory-brief.md`(kill-test→governed top-K) + `memory-augmentation-brief.md`(직교).

---

## 1. 큰 그림 (한 장) — 두 평면

```
  ┌─ 사람(User): 대화 · 활동 ──────────────────────────────────┐
  │                                                           │
  ▼ (전부 그대로, append)                                      │ 온디맨드 검색(RAG)
  ┌───────────────────────────────────────────┐               │  → governed 요약으로만
  │  ▤ RAW 아카이브   "흡수 = 모든 것"            │ ◀─────────────┘  (untrusted 입력 취급)
  │   대화 이력 · 활동 로그 · 산출물              │
  └───────────────────┬───────────────────────┘
                      │ 선별 + acceptance 게이트 (자동 bulk 아님)
  ══ working 평면 ═════▼══════════════════════════════════════
  ╔══════════╗  읽기: ▣User
  ║  MASTER  ║  (governed: 선별된 사실·선호·제약)
  ╚════╤═════╝
       │ dispatch ▼
  ╔══════════╗  읽기: ▣User + ▣Profile + ▣Workspace   ← Composer가 합성
  ║ OPERATOR ║  (전 PM)
  ╚════╤═════╝
       │ dispatch ▼
  ╔══════════╗  읽기: 작업지시만 — 메모리 직접 읽지 않음
  ║  WORKER  ║  쓰기: harvest(diff·test) ──▶ ▣Workspace
  ╚══════════╝
```

**불변식:**
- **흡수는 아카이브, 주입은 governed.** 모든 건 Raw 아카이브에 쌓이고, 컨텍스트에 들어가는 건 거기서 *선별*된 것뿐.
- **아카이브는 통째로 주입되지 않는다** — 온디맨드 검색으로만, 결과도 governed 요약. (raw bulk 주입 = kill-test가 죽인 길.)
- **아카이브 내용은 untrusted 입력이다** — 검색해 온 텍스트엔 prompt-injection·낡은 지시가 섞일 수 있음 → 주입 전 살균.
- **주입은 아래로, 캡처는 위로.** Worker는 메모리 직접 안 읽음. 상위는 하위 메모리 raw 안 읽음(governed 요약만).
- **모든 주입(Master 포함)은 Composer 경유** + user-payload prepend (**system-prompt bake 금지**).
- **owner(저장 정체성) ≠ capture policy(누가·어떻게 쓰나)** — 별개.

---

## 2. 두 평면 — Raw 아카이브 + Governed working 메모리

핵심: **"다 기억해"(흡수)와 "잘 행동해"(주입)를 분리한다.** kill-test(`mm-spike`)는 모든 걸 흡수·정제·graph화해도
*답변 품질*이 "올바른 현재 사실 top-K"를 못 이긴다고 했다. 그래서 흡수는 하되, 주입은 governed로 유지.

| 평면 | 무엇 | 가치 | 어떻게 쓰나 |
|---|---|---|---|
| **▤ Raw 아카이브** | 대화·활동·산출물 *전부* (append-only) | **recall + 데이터관리** (답변품질 아님 — Codex) | **온디맨드 검색**(RAG). 기본 주입 ✕ |
| **▣ Governed working** | 선별된 사실/선호/제약 (User/Profile/Workspace) | **정밀한 행동** (좁고 신뢰 가능) | spawn/턴마다 **Composer** 주입 |

- 아카이브의 정당화는 **recall/데이터-관리**지 답변 개선이 아니다(명시). 무거운 distill/WikiGraph/temporal-supersede 머신 **재도입 금지**.
- 아카이브 1차 owner는 **User**(사용자 raw 스트림). Workspace는 자체 캡처(harvest), Profile은 curated.
- **모듈식 — 단, 아키텍처상 옵션이지 운영상 무료 분리가 아니다 (Codex):** 온디맨드 검색을 빼면 에이전트가 보는 건
  governed working뿐(= §3 형태 그대로), 아카이브는 수동 저장소로만 남는다. 하지만 *한번 켜지면* 아카이브는 캡처/소유권/
  삭제/감사/redaction/보존/인덱싱/provenance에 얽힌다. 모듈성을 지키려면 **명시적 flag/인터페이스 뒤에**:
  ① governed 메모리는 아카이브 ID/검색에 의존 ✕ ② Composer는 아카이브 꺼도 동일 동작 ③ 아카이브 캡처/인덱싱은
  governed 쓰기 막지 않고 **fail-closed** ④ 아카이브 파생 요약은 provenance + **삭제 lineage** 보유.
- ⚠️ 도입 순서 = **governed-only → +아카이브(수동) → +온디맨드 검색**, 각 단계 additive. 온디맨드가 빠지면 에이전트는
  런타임에 전체 아카이브를 *못 꺼낸다*(distill된 것만) — 온디맨드가 "흡수"를 에이전트가 실제로 활용하게 만드는 조각.

---

## 3. Governed 저장소 3개 (working 평면)

| 저장소 | 한 줄 | 예시 | owner 키 | = 오늘 |
|---|---|---|---|---|
| **▣ User** | 사용자 그 자체 | "한국어로 답해", "PR은 작게" | 싱글턴(user) | L2 `scope=user` |
| **▣ Profile** ⭐ | 에이전트의 *전이성* 전문성 | "보안리뷰는 OWASP Top10 우선" | `(profile, owner_id)` | **신규** |
| **▣ Workspace** | *이 코드베이스* 사실 | "이 repo는 node@22" | `project_id` | L1 |

> **Workspace = 오늘 project-scoped L1 그대로**(`project_id NOT NULL`) 재명명 — 새 owner 아님. 신규 working owner는 **Profile 하나**.
> **왜 Profile 분리**: 옛 PM은 `PM=project=폴더=정체성` 융합 → L1이 "repo 사실"+"에이전트 지식" 겸함. Operator가 정체성을 폴더에서 떼면 분리 필요.

---

## 4. 계층별 메모리 (누가 무엇을 읽고/쓰나)

| 계층 | 정체성 | 읽기(주입) | 쓰기 | 아카이브 |
|---|---|---|---|---|
| **Master** | 사용자 총괄 1명 | **User** | `/remember`→User | 온디맨드 검색(governed 요약) |
| **Operator · coder** | Profile+폴더+dispatcher | **User+Profile+Workspace** | Workspace ← harvest(R6/R1b)+판정(R3) | 검색(governed 요약) |
| **Operator · specialist** | Profile+폴더없음+doer | **User+Profile** *(MVP: User만)* | *(MVP 없음)* | 검색(governed 요약) |
| **Worker** | 일회성 실행자(worktree) | 작업지시만 | harvest→Workspace | ✕ |

> **Master는 바뀌나? — 내용 거의 그대로, 배관은 개편 포함.** User 읽기(불변). 사용자당 1명이라 "Master 정체성=User" 수렴
> → Master 전용 Profile 불필요(단 *저장 단순화*지 행동 동일성 아님; owner ≠ capture policy). 배관: Composer 경유 + User가
> `owner_type='user'` 재키잉 + User 캡처 지점 유지. 통일 모델 = 루트 Operator(coordinator × 폴더없음 × dispatcher);
> `workspace=none` 안전규칙은 "워크스페이스 *메모리* 차단"이지 dispatch 권한 박탈 아님(생성·라우팅·메타데이터·아카이브 검색 보유).

---

## 5. 흐름

**⬆ 캡처:** 모든 대화·활동 ─append─▶ ▤아카이브 / Worker harvest ─R6·R1b─▶ ▣Workspace / Operator 판정 ─R3─▶ ▣Workspace /
Workspace(공통) ─XPROJECT─▶ ▣User / 아카이브·사람 ─선별+게이트─▶ ▣User(또는 Profile, 후속).
**원칙 — 자기 출력은 증거가 아니다.** 신뢰 가능한 acceptance 신호가 있어야 governed가 된다(쓰기 경로 promote tx에서 강제).
**⬇ 주입:** Composer가 계층 owner governed 메모리 합성 → user-payload prepend. 아카이브는 필요시 검색→governed 요약(bulk ✕).

---

## 6. Memory Composer

- **단일 진입점**: 모든 주입(Master 포함) Composer 경유.
- **우선순위 = 모드·종류별**: coder `요청 > User제약 > Workspace사실 > Profile휴리스틱` / specialist `요청 > User제약 > Profile`. 종류: **제약 > 사실 > 휴리스틱**.
- **owner별 토큰 예산** + 충돌 정책 + dedup.
- **추적성(필수)**: "왜 주입/억제됐나" plan + 테스트.

---

## 7. 무엇이 바뀌나 (오늘 → 목표 · "싹 다 개편")

| 항목 | 오늘 | 목표 |
|---|---|---|
| 중간 계층 | **PM** (repo 1:1) | **Operator** (Profile × 폴더 × dispatcher/doer) |
| **흡수 평면** | **없음** | **▤ Raw 아카이브** 신설 (전부 보존 + 온디맨드 검색, 권한적 접근) |
| L1 메모리 | project 융합 | **Workspace scope** 분리(저장은 오늘 L1 그대로) |
| 정체성 메모리 | 없음 | **Profile scope 신설** (owner-keyed) |
| 주입 | Top=L2/PM=L1 분리 | **Composer** 1곳 합성 |
| specialist | 없음 | folder-less doer, 메모리 stateless + 안전차단 |
| 저장 키 | `scope` | **`(owner_type, owner_id)`** |

---

## 8. 안전 · 단계 · 블로커

> **아카이브 = "권한적 데이터 접근"으로 다룬다, 일반 메모리가 아니다 (Codex).** 최대 위험 = 아카이브가 **만능 메모리 백도어**가 되어
> "더 검색·더 요약·더 승격·더 주입" 압력으로 *제품 드리프트*가 kill된 흡수 시스템을 되살리는 것. default-safe로 막아야 함.

**8a. 아카이브 프라이버시/거버넌스 (활성화 전 하드 선행):**
redaction · 보존정책 · **삭제권(+파생데이터 무효화)** · 접근통제 · 감사 — 시작 surface. 여기에 Codex 추가:
- **파생데이터 삭제 생애주기(최대 공백)**: raw 삭제 시 chunk·embedding·요약·trace·승격된 governed 사실·캐시·백업까지 삭제/무효화.
- 동의·데이터 최소화 / 저장·전송 암호화 / **테넌트·user·workspace 격리** / ACL 상속(raw→chunk→embedding→summary).
- DSAR 식 내보내기 / legal-hold vs 삭제 충돌 정책 / **secret 탐지·격리·로테이션** / 모델-프로바이더 prompt-retention 경계 /
  break-glass 관리자 접근 / 다중-사용자 authorship 규칙.

**8b. 검색 규율 ("governed 요약만"은 필요조건일 뿐):**
- **하드 예산**: top-K · 토큰 캡 · owner별 캡 · 재귀확장 ✕ · bulk recall ✕ · Composer 가시 trace.
- **요약 전후 정책**: 사용 전 chunk 분류 → secret/PII redact → 요약. raw 발췌는 명시 승인 없이 prompt 금지. 요약에 민감도 라벨.
- **민감도 > 대상 에이전트 capability면 주입 차단.** 모든 검색 감사(actor·목적·owner·source·주입 토큰). **검색 결과 = untrusted**(injection 처리).

**8c. specialist 안전 (folder-less):** `workspace=none ⇒ shell·직접 FS 없음` + **deny-by-default 툴**(MCP/browser/network/env/artifacts/상속 run context). Workspace 메모리 읽기·쓰기 차단 + real `projects`행 생성 금지. (dispatch 권한은 별개.)

**단계화:**
- **A0 (하드 선행)** — folder-less가 projects행/cwd/shell·FS/XPROJECT/L1 capture/project-route에 안 닿게 + capability deny.
- **A** — Composer + **owner-keyed governed 저장** (아카이브 검색보다 *먼저* — 요약이 내려앉을 규율된 자리 필요, Codex).
- **B** — specialist stateless 주입(User만) + Profile owner 스키마 예약.
- **C** — Profile 메모리 읽기 + human 쓰기.
- **Archive 트랙 (병행)** — 8a 충족 *후* 활성. 그 전엔 **"전부 →아카이브" 금지**, manual/opt-in/local-only 프로토타입만(Codex).
- **D (deferred)** — Profile 자동 학습, mapped workspace, 아카이브→working 자동 distill(데이터-관리 정당화 시).

**🔴 구현 전 NO-GO 블로커:**
1. **owner-keyed 저장** — `scope` 키 *모든* L2 불변식(unique index·fact_key·dedup·cap·revision·injection ledger·candidate·route) → `(owner_type, owner_id)`. partial = profile 교차오염.
2. **virtual 배제 + capability deny** — A0, specialist 이전.
3. **추적성** — 주입/억제·검색 추적 + 테스트.
4. **자동 학습 OFF** — Workspace→Profile 누수 분류규칙 + trust 기준 전까지(쓰기 게이트 강제).
5. **아카이브 프라이버시 게이트** — 8a(특히 파생데이터 삭제) + 8b 없이 raw 아카이브 활성 금지. 검색은 governed 요약만, 예산 강제.

---

## 9. Open Questions / 잔존 블라인드스팟 (Codex)

- **파생데이터 삭제·무효화** 전파(raw→chunk→embedding→summary→promoted fact→cache→backup).
- 다중-사용자/공유 workspace 소유권·authorship 시맨틱.
- secret 처리(redaction 너머 격리/로테이션) + 검색 결과 prompt-injection 방어.
- raw 검색 / governed 요약 / Composer 주입 사이 **강제 경계**의 구체화.
- 아카이브 볼륨 증가 시 비용·지연·인덱스 생애주기 + retrieval 엔진(FTS/벡터/그래프 — P2 sqlite-vec 후보, 별도 검증).
- 아카이브 → working 선별 정책(무엇이 acceptance 신호인가; trust 모델).
- Profile lifecycle(clone/rename/delete/version) 시 메모리 처리 / 동일 Profile 다중 인스턴스 동시 쓰기.
- Composer 우선순위·예산 실측 튜닝.
