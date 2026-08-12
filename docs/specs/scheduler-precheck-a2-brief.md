# A2 — 스케줄러 precheck 설계 계약 (#524 종결안)

> **상태**: 설계 계약 확정 (2026-08-12). 착수 대상.
> **상위**: `docs/goal-session-protocol.md` 큐 #13 (OP 3단계 스케줄러 파리티) / `docs/specs/orca-parity-and-action-plane-brief.md` §4 3단계
> **선행**: A1 (#514, `grace_seconds` + `misfire_policy`, migration 088)
> **이슈**: #524 (codex NO-GO: BLOCKER 5 + SERIOUS 7 + MODERATE 3) — 이 문서가 그 항목들을 닫는다.

---

## 0. 한 줄 목표

**스케줄된 Operator 턴을, 발화 직전에 평가한 named verify check 가 통과할 때만 발화시킨다** — 턴(=LLM 비용)을 조건부로 만든다.

## 1. 착수 전 발견된 전제 오류 (이슈 #524 에 없던 사실)

`verify_checks` 라우터 **전체**가 `goalFeatureActive()` 게이트 뒤다 (`routes/verifyChecks.js:34-39` → 503).
실측: 로컬 `.env` 와 **운영 Pi (`karnian@100.64.17.115:~/sub_project/Palantir-Console/.env`) 둘 다 `PALANTIR_GOAL_MODE` / `PALANTIR_PM_TOKEN` 미설정** (goal 모드 OFF).

→ spec 원문("named verify check 참조") 그대로 구현하면 **어느 배포에서도 check 를 만들 수 없다**. #12 를 보류시킨 휴면 패턴(#522)의 반복이다.

**사용자 결정 (2026-08-12, 옵션 B)**: artifact check 만 goal 게이트 밖으로 분리한다.

### 1.1 §6 "단일 게이트" 재해석 (spec 이탈, 사용자 승인)

goal-delegation-brief §6 은 `goalFeatureActive()` 를 "모든 goal 표면의 단일 게이트"로 lock-in 했다. 그 근거는 코드 주석에 명시돼 있다 — **command check 의 cookie-only 게이트는 Operator 가 `PALANTIR_TOKEN` 을 더 이상 쥐지 않을 때만 스푸핑 불가**하기 때문에 라우터 전체를 같은 게이트에 묶었다.

이 근거는 **kind 별로 강도가 다르다**:

| kind | 실행면 | goal 모드 없이 개방 가능? |
|---|---|---|
| `command` | 셸 실행 | **불가**. goal 모드 OFF 에서 Operator 는 spawn env 로 `PALANTIR_TOKEN` 을 받으므로 cookie 를 위조해 command check 를 만들 수 있고, 스케줄 precheck 이 그걸 실행하면 **컨트롤 플레인 임의 셸**이다. 실제 권한 상승. |
| `artifact` | 없음 (선언적 파일 평가) | **가능**. 최악의 표현력이 "잘못된 파일 조건"이다. |

따라서 게이트를 **라우터 단위 → kind 단위**로 내린다:

**쓰기는 게이트를 알리고, 읽기는 은닉한다** (codex R7-2 — 초안은 command 조회도 503 이라 해놓고 동시에 "goal OFF 면 GET 에서 command 행을 필터"라고 적어 단건 조회 결과가 503 인지 404 인지 모순이었다. 혼합 목록에서 행별 503 은 애초에 성립하지 않는다):

- `command` **쓰기**(생성·수정·삭제·태스크 할당) = `goalFeatureActive()` AND cookie. 미충족 시 **503** (기존과 동일).
- `command` **읽기** = goal OFF 면 존재를 숨긴다 — 목록은 행 필터, 단건 GET 은 **404**. (command 문자열 노출 방지. 503 이면 "여기 command check 가 있다"는 사실 자체가 새는데, 이 표면은 goal OFF 에서 아무 의미가 없다.)
- `artifact` 생성·수정·삭제·조회 = goal 게이트 없음. actor 도출(`created_by`) 규칙은 기존 그대로.
- `POST /assign` (태스크 Gate 1 할당) 은 **goal 영역이므로 전면 goal 게이트 유지**. 스케줄 precheck 할당은 별도 경로(§4.3).

**명시적 한계**: goal 모드 OFF 에서 `req.auth.method` 는 보안 경계가 아니라 actor hint 다 (R4 remember / F-1 fast-mode 와 동일한 기존 caveat). artifact check 는 실행면이 0 이고 precheck 의 최대 영향이 "턴을 쏘느냐 마느냐"이므로 이 강도가 비례한다. **command precheck 은 이 hint 강도로 절대 열지 않는다.**

## 2. 범위

**포함**: 스케줄에 named verify check 1개를 precheck 으로 부착 → 발화 직전 평가 → 통과 시에만 invocation 생성.

**제외**:
- **action target — 영구 제외** (#522 로 대상 소멸).
- 프롬프트 외부화·버전관리 = **A3 별도 슬라이스**.
- RRULE = P3. `workspace_mode` / `reuse_session` = 비채택 (Operator 는 지속 identity).
- precheck 다중 부착(AND/OR 조합) = v1 제외. 스케줄당 최대 1개.

**kind 별 가용성 — v1 은 `artifact` 전용**:

| precheck kind | 노드 | 상태 |
|---|---|---|
| `artifact` | 로컬 | ✅ v1 |
| `artifact` | 원격(pod) | ✅ v1 (executor `listDirectoryEntries`/`readFileCapped` 경유) |
| `command` | 전부 | ❌ **v1 제외** (아래 근거) |

#### 2.1 command precheck 을 v1 에서 뺀 근거 (codex R3 BLOCKER-2 + 옵션 B 일관성)

초안은 "로컬 노드 command 는 harvest runner 로 실행 가능"을 근거로 v1 에 넣었다. 두 가지가 그걸 뒤집었다.

1. **at-least-once 실행 (codex R3-2)**. fencing 은 DB 커밋만 보호한다. A 가 command 를 실행한 뒤 lease 만료·크래시가 나면 sweep 후 B 가 **같은 command 를 다시 실행**한다. A 의 늦은 커밋이 no-op 이어도 외부 부작용은 이미 두 번 났다. 무부작용 sandbox 강제나 runner idempotency 없이는 못 닫는다. 자기선언형 "이 command 는 idempotent 하다"는 **#12 를 죽인 바로 그 계약 형태**(자기선언뿐인 capability)라 채택 불가.
2. **어차피 휴면이다**. command check 는 goal 모드 게이트 뒤에 남으므로(§1.1 — 이건 보안상 양보 불가) 운영 배포(goal OFF)에서 **실행될 수 없다**. 옵션 B 를 고른 이유가 휴면 코드 회피인데, command precheck 을 v1 에 넣으면 부작용·중복실행 리스크 표면만 만들고 동작은 안 하는 코드가 된다.

→ v1 은 `artifact` 전용. artifact 는 **순수 읽기**라 재실행이 무해하므로 R3-2 가 구조적으로 소멸한다.
→ command precheck 은 **goal 모드 flip 시점의 후속 슬라이스**로 명시 유보한다. 그때 at-most-once(attempts 1 고정, lease 만료 시 재시도 없이 `precheck_unavailable`) 또는 sandboxed runner 를 전제로 재설계한다.
→ 이로써 #524 BLOCKER-5(원격 runner 영구 부재)는 **v1 범위에서 소멸**한다.

## 3. #524 항목별 종결 (BLOCKER → 계약)

| # | 항목 | 종결 계약 |
|---|---|---|
| **B1** | 평가 시점이 delivery 면 늦음 | **3-phase**. materialize tx 는 `operator_schedule_occurrences` 행만 만들고 끝(§4.1). 평가는 **모든 tx 밖**(§4.2). 통과 커밋만 짧은 tx(§4.3). invocation 은 통과 후에만 생성. |
| **B2** | terminal 상태 미정의 | invocation 에 **새 status 를 추가하지 않는다**(OS-4 partial index 무손상). occurrence 가 자체 status enum 을 CHECK 로 갖는다: `pending / prechecking / passed / precheck_failed / precheck_unavailable / precheck_blocked / superseded`. |
| **B3** | active 단일성 충돌 | precheck 중인 occurrence 는 **active 집합에 없다**(invocation 행 자체가 없음). active 슬롯은 통과 커밋 tx 에서 invocation INSERT 로 **원자적으로** 확보되고, 경합은 기존 `idx_operator_invocations_active_operator` UNIQUE 가 그대로 판정한다. |
| **B4** | daily cap 오염 | cap 은 invocation 만 센다(`countRecent`, `status NOT IN ('cancelled')` — **waiting_reason 아님**, #524 의 전제는 코드와 다름). `countRecent` 무수정. **`precheck_failed` / `precheck_unavailable` / `precheck_blocked` 로 끝난 occurrence 는 invocation 을 전혀 만들지 않으므로 cap 을 소비하지 않는다** (`passed` 는 세 경로 모두 invocation 을 만든다 — §4.3 표). cap 판정 시점은 두 곳이며 §4.1 note 에 분리 고정. |
| **B5** | runner 영구 부재 | **v1 범위에서 소멸** — command precheck 을 v1 에서 제외했다(§2.1). artifact 는 로컬·원격 모두 executor 로 평가 가능하다. 일시적 불가(노드 unreachable 등)는 backoff 재시도 후 `deadline_at` 에서 `precheck_unavailable` 확정. |
| **S6** | 평가 불가 ≠ 조건 불충족 | `operator_schedules.consecutive_precheck_errors` 신설. **인프라·구성 결과만** 증가(`precheck_unavailable`/`precheck_blocked`). 평가가 실제로 끝나면(pass·fail 무관) 0 리셋. 임계 3 도달 시 `enabled=0` + `next_fire_at=NULL` + 이벤트 — 기존 `consecutive_failures>=3` 자동 비활성 선례와 동형, **카운터는 분리**. |
| **S7** | revision/snapshot 부재 | occurrence 가 `schedule_revision` + `precheck_verify_check_id` + `precheck_spec_hash`(정규화 spec 의 sha256) + `precheck_kind` + `precheck_node_id` 를 스냅샷. 커밋은 **2단계**(소유권 fencing → 유효성 CAS, §4.3) 로 전부 대조 → stale worker 결과는 커밋 불가. |
| **S8** | artifact→command kind 우회 | `kind`/`project_id` 는 **이미 서비스 레벨 immutable** (`updateCheck` 가 `existing.kind` 만 사용). **DB 트리거로 승격**(BEFORE UPDATE, `NEW.kind != OLD.kind OR NEW.project_id IS NOT OLD.project_id` → ABORT) — repo 의 "트리거 = 마지막 방어선" 패턴. |
| **S9** | schedule project 변경 우회 | `updateSchedule` 이 `codebase_project_id` 변경 시 **부착된 precheck 재검증**(kind×노드×project scope). 불합격이면 409 로 거부(조용한 무효화 금지). `precheck_verify_check_id` 자체는 일반 PATCH 필드에서 **제외** — 전용 경로만(`tasks.verify_check_id`/`assignVerifyCheck` 선례). |
| **S10** | TOCTOU 미정의 | **계약 선언: precheck 은 best-effort 발화 조건이지 보안 경계가 아니다.** "턴을 쓸지"를 정할 뿐 "턴이 무엇을 할 수 있는지"를 제약하지 않는다. 따라서 delivery 시점 재검증·digest 바인딩 없음. 코드 주석과 이 문서에 명시해 후대가 게이트로 오인하지 않게 한다. |
| **S11** | supersede 의미 부재 | 스케줄당 in-flight occurrence 는 **최대 1개** — `UNIQUE(schedule_id) WHERE status IN ('pending','prechecking')` partial index. 새 occurrence 생성 tx 가 이전 것을 `superseded` 로 마킹하고, 이전 worker 의 결과는 커밋 CAS 에서 탈락. |
| **M12** | 진단 부족 | occurrence 에 `evaluator` / `started_at` / `finished_at` / 구조화 `outcome_reason` / `detail_json`(≤2KB: `{check_id, spec_hash, kind, evaluator, node_id, duration_ms, reason_code, results:[{glob,matched,reason}] ≤20}`). **원문 출력은 저장하지 않는다** — goal acceptance 의 `output_tail` 과 의도적으로 다르다(무인 스케줄러 표면이라 비밀값 유출 창구가 된다). command 를 되살릴 때도 `exit_code`·`timed_out`·`duration_ms` 만 허용하고 stdout/stderr·command 문자열은 금지 (§2.1 재개 조건). |
| **M13** | 동시성 테스트 | §7 목록. |
| **M14** | migration 번호 | 착수 시점 head 기준. 현재 head = 088 → **089** 예정, 구현 직전 재확인. |

### 3.1 provenance 계약 (S7/S8 보강)

**스케줄 precheck 은 `created_by='human'` 이고 `project_id` 가 스케줄의 `codebase_project_id` 와 정확히 일치하는 check 만 참조할 수 있다.**

- 부착 시점 검증 + **평가 시점 재검증**.
- **project scope 는 엄격 동등** (codex R2-6). `project_id IS NULL`(global) check 는 **precheck 부적격** — 한 프로젝트에서 승인한 조건이 다른 workspace 로 재사용되는 것을 막는다. goal Gate 1 의 기존 느슨한 규칙(`check.project_id && check.project_id !== task.project_id`)은 그대로 두고, precheck 만 조인다.
- **평가 시점 provenance 재검증은 API 흐름이 아니라 backstop 이다** (codex R7-1). 아래 "부착된 check 는 non-cookie 에게 불변" 규칙과 §6 의 단일 tx CAS 가 결합하면, **정상 API 로는 부착 상태에서 Operator 의 spec 편집이 일어날 수 없다**. 그래도 재검증을 남기는 이유는 raw-SQL 오염·향후 신규 코드 경로 방어이며, 이는 repo 의 기존 패턴과 같다(`spawnQueuedRun` 의 claim-전 `validateStructuredModelEffort` backstop = raw-SQL 오염 profile 방어). 따라서 `precheck_blocked(provenance_lost)` 전이의 재현 테스트(11·39)는 **직접 SQL 로 행을 오염시켜** 검증한다 — API 로는 재현 불가가 정상이다.
- **부착된 check 는 non-cookie actor 에게 불변** (codex R2-5): 어떤 스케줄이든 precheck 으로 참조 중인 check 의 수정·삭제는 **cookie 전용**. bearer/none 시도는 403. 이게 없으면 하위 주체가 상위 주체의 승인을 상시 취소할 수 있는 availability 권한을 갖는다.
- **metadata-only 인간 편집은 provenance 를 승격시키지 않는다** (codex R2-3): 현행 `updateCheck` 은 `a === 'human'` 이면 spec 변경 여부와 무관하게 `created_by='human'` 으로 올린다 → Operator 가 만든 check 를 사람이 **이름만 바꿔도** human 으로 세탁된다. rename 은 spec 을 검토했다는 증거가 아니다. 규칙을 조인다:
  - 사람 편집 + spec 실제 변경 → `human`
  - 사람 편집 + spec 무변경(rename/`is_default`) → **기존 provenance 보존**
  - 승격은 명시적 `attest`(cookie + 검토한 canonical spec hash 동봉, 불일치 시 409)로만
  - Operator 편집 + spec 변경 → `operator` (기존 규칙 유지)
- 사람이 spec 을 수정하면 `human` 이 유지되므로 **named check 의 재사용성은 보존**된다.
- spec hash 는 **동시성**(evaluate↔commit 정합) 용도이지 인가 용도가 아니다.

#### 3.1.1 provenance 의 실제 강도 — 정직한 서술 (codex R2-1)

codex 는 "goal 모드 OFF 에서 Operator 가 `PALANTIR_TOKEN` 을 쥐므로 cookie 를 위조해 `created_by='human'` 을 만들 수 있다 → human-only 부착은 보안 경계가 아니다"를 BLOCKER 로 지적했다. **사실 판정: 서술은 맞고, 결론은 A2 에 대해 과대하다.**

`operatorSpawnService.js:669` — `scrubHumanToken: actorTokens.separated || goalFeatureActive()`. 운영 배포는 둘 다 거짓이므로 Operator spawn env 에 `PALANTIR_TOKEN` 이 그대로 들어간다. 즉 **그 Operator 는 이미 전체 human API** (태스크 생성, 워커 spawn, 프로젝트 편집, 스케줄 CRUD) **를 쓸 수 있다.** precheck 이 새로 여는 권한은 0 이다 — 오히려 precheck 이 없을 때 Operator 는 스케줄 자체를 만들거나 지울 수 있다.

따라서 A2 의 계약은 이렇게 적는다:

> **`created_by='human'` 은 보안 경계가 아니라 오작동 방지·감사 신호다.** goal 모드 OFF 배포에서 blast radius 는 **가용성뿐이며, 그것도 사람이 만든 스케줄의 자기 cadence 안으로 한정**된다 (precheck 은 발화를 막거나 통과시킬 뿐, 새 발화를 만들지 못한다). 이 강도는 R4 remember / F-1 fast-mode 의 기존 caveat 와 동일 등급이다. **보안 경계가 필요하면 goal 모드(PM 토큰 분리)를 켜야 하고, 그것이 command precheck 의 전제인 이유다.**

"부착(cookie)이 인가 지점"이라는 §3.1 초안의 표현은 이 강도를 과장했으므로 철회한다.

## 4. 제어 흐름

### 4.0 비회귀 계약 (최우선)

**precheck 이 부착되지 않은 스케줄은 occurrence 행을 만들지 않고, `materializeDue` 의 기존 경로를 그대로 탄다.** 이 슬라이스의 1급 수락 기준이며, 범위는 **정확히 그 경로**다.

범위를 좁혀 적는다 (codex R8): 부착 0개 배포라도 이 PR 은 스케줄러 **밖**을 바꾼다 — artifact CRUD 개방(§1.1), command 읽기 은닉, provenance 승격 규칙 조임(§3.1), `assertHumanSameOrigin` scheme/port 비교(§6). 따라서 "배포 전체가 byte-identical" 이라고 주장하지 않는다. 불변 계약은 **`materializeDue` 의 미부착 스케줄 분기 + invocation claim/deliver 전 경로**로 한정한다.

### 4.1 Phase 1 — materialize tx (I/O 없음, 기존 tx 그대로)

`materializeDue` 의 스케줄별 tx 안, **커서 전진·grace/misfire·daily cap 판정까지는 현행 순서 불변**. 그 다음:

```
precheck_verify_check_id IS NULL
  → 현행 경로 (supersede / operator_active_skipped / insertInvocation)   ← 완전 불변
precheck 부착됨
  → (schedule_id, scheduled_for) occurrence 가 이미 있으면 아무것도 하지 않는다 (R4)
  → check 행 SELECT (tx 내, 순수 조회)
     ├ check 행 **부재** → occurrence 를 만들지 않는다. health++ + 이벤트만.
     │   (스냅샷 컬럼이 NOT NULL 이라 만들 수도 없다 — codex R7-3. 스케줄 쪽 FK 가
     │    RESTRICT 이므로 정상 API 로는 도달 불가한 오염 상태이고, backstop 으로만 존재)
     ├ 행은 있으나 부적격(created_by != 'human' / kind != 'artifact' / project scope 불일치)
     │   → occurrence terminal 'precheck_blocked' + reason (스냅샷 채울 수 있다),
     │     consecutive_precheck_errors++, invocation 없음, cap 미소비
     └ 적격
         → 이 스케줄의 in-flight occurrence 를 'superseded' 로 마킹
         → occurrence 'pending' INSERT — 스냅샷 전부:
            schedule_revision,
            precheck_verify_check_id (FK) + precheck_check_id_snapshot (비-FK) + precheck_check_name,
            precheck_spec_hash, precheck_kind,
            precheck_node_id, precheck_workspace_generation,
            next_attempt_at = now,
            deadline_at = min(next_fire_at, grace 마감) ?? now + PRECHECK_DEADLINE_MS
```

커서(`next_fire_at`)는 **현행과 동일하게 정확히 한 번** 전진한다. grace/misfire/cap 판정이 precheck 보다 앞이므로 A1 의 의미는 불변이다.

> **cap 판정은 두 시점이고 결과가 다르다 (codex R6-3).** 혼동하면 안 된다.
>
> | 시점 | 조건 | occurrence | invocation |
> |---|---|---|---|
> | materialize (§4.1) | 이미 cap 초과 | **생성 안 함** (평가 자체를 안 한다) | `insertTerminalInvocationFromSchedule(daily_cap_reached)` — **현행 그대로, 불변** |
> | commit (§4.3) | 평가 중 다른 invocation 으로 cap 이 참 | `passed` + `outcome_reason='daily_cap_reached'` | 동일 terminal invocation + occurrence 에 링크 |
>
> 즉 cap 초과가 사전에 확정된 경우 precheck 평가는 **아예 수행되지 않는다** — precheck 이 cap 을 우회해 실행량을 늘리지 않는다는 보장이 여기서 나온다.

> **R4 (occurrence 중복 = 커서 영구 정지) — codex R1 BLOCKER-4.** `UNIQUE(schedule_id, scheduled_for)` 에 걸리는 INSERT 는 tx 를 롤백시키고, **같은 tx 안의 커서 전진까지 되돌린다** → 매 tick 동일 충돌 반복 = 스케줄 영구 정지. 규칙/타임존 변경으로 이미 소비된 `scheduled_for` 가 재산출되면 실제로 발생한다. 따라서 occurrence INSERT 는 **절대 throw 하지 않는다**: 선존재 조회 후 있으면 no-op (`insertTerminalInvocationFromSchedule` 의 `{inserted:false}` 와 동형). occurrence 정체성에 revision 을 넣지 않는 이유는, 같은 revision 재발화도 똑같이 막아야 하기 때문이다.

### 4.2 Phase 2 — 평가 (모든 tx 밖)

`operatorScheduler.runTick` 에 `drainPrechecks()` 를 **`drainAll()` 앞**에 추가.

- `claimNextOccurrence(now)` — `claimNext` 와 동형의 동기 CAS. **predicate 전부**: `status='pending' AND next_attempt_at <= now AND deadline_at > now`. 성공 시 `status='prechecking'`, 새 `claim_token`, `leased_until=now+LEASE`, `attempts++`.
- 평가는 tx 밖에서:
  - 노드 해석 → executor (로컬 `nodeExecutor` / 원격 `remoteSshExecutor`)
  - `artifact` → `artifactCheck` 의 경계(walk entries / depth / per-file byte cap)를 그대로 유지한 **executor 백엔드 평가**. 원격은 `listDirectoryEntries` + `readFileCapped`. **v1 의 유일한 평가 경로다** — command 분기는 구현하지 않는다(§2.1; 만들면 §2.1 이 배제 근거로 든 "휴면 실행 표면"을 그대로 만드는 자기모순이다).
  - 평가 루트 = 해당 codebase 프로젝트의 materialized 작업 디렉터리. git 프로젝트는 기존 `resolveMaterializedRepoCwd` 규약을 따르고, 미materialize 상태는 **일시적 unavailable** 로 취급(재시도 대상)한다.
- **평가자는 자기가 실제로 사용한 입력을 반환한다** — `evaluated_spec_hash`(R7) + `evaluated_node_id` + `evaluated_workspace_generation`(R3-3). 커밋은 **스냅샷 == 평가값 == 현재값** 3자 일치를 요구한다(NULL-safe 비교, §4.3). 이 3자 대조가 잡는 것과 못 잡는 것을 구분해 적는다:

- **잡는다** — spec 의 A→B→A 되돌림(hash 만 대조하면 B 로 평가한 결과가 승인된다), 그리고 같은 node id 를 유지한 채 materialized workspace 가 교체되는 경우(git 프로젝트는 `source_generation`).
- **못 잡는다** — node 바인딩 자체의 A→B→A 되돌림. 단조 `binding_generation` 이 없으면 세 값이 모두 A 로 일치할 수 있다. **v1 의 의도적 유보**이며 근거는 §8.
- 일시적 실패(노드 unreachable/cordoned, exec 오류, 미materialize) → `releaseOccurrence(id, token)` 로 `pending` 복귀. **fencing 필수**: `WHERE id=? AND status='prechecking' AND claim_token=?` (R5). 복귀 시 `next_attempt_at = now + retryDelayMs(attempts)` 를 **DB 에 기록**한다 — 메모리 타이머 금지(재시작 시 backoff 소실 + hot loop, R6). `deadline_at` 초과면 terminal `precheck_unavailable`.
- 평가 자체가 병렬 lane 을 먹지 않도록 precheck 동시성은 별도 소량 상한(기본 2)으로 둔다. `next_attempt_at` 이 DB 에 있으므로 `drainPrechecks()` 가 재시도로 `drainAll()` 을 굶기지 않는다.

> **평가 횟수 상한 (codex R3-6 부분 반영).** codex 는 "precheck 이 daily cap 을 우회해 무제한 실행된다"를 지적했는데, **cap 초과 시 occurrence 자체가 안 만들어진다** — §4.1 에서 cap 판정이 precheck 분기보다 **앞**이다. 남는 진짜 상한은 두 겹이다: ①occurrence 는 발화 cadence 당 1개(최소 간격 15분 → ≤96/일, `advancePastNow` 가 coalesce) ②occurrence 당 시도는 `next_attempt_at` backoff(60s→15분 cap)와 `deadline_at`(다음 발화 시각) 사이로 제한. artifact 는 순수 읽기이고 walk/byte 경계가 `artifactCheck` 상수로 이미 고정돼 있으므로 별도 quota 컬럼은 두지 않는다. **command 를 되살릴 때는 이 상한이 셸 실행 횟수가 되므로 전용 quota 를 반드시 재검토한다.**

### 4.3 Phase 3 — 커밋 (짧은 tx)

`commitPrecheck(occurrenceId, token, passed, { evaluatedSpecHash, evaluatedNodeId, evaluatedWorkspaceGeneration })` — **평가자가 실제로 쓴 입력 전부를 넘긴다** (codex R4-1: 초안은 §4.2 에서 3자 일치를 요구해놓고 시그니처·INSERT 에 신호를 배선하지 않아 계약이 성립하지 않았다):

**1단계 — 소유권 (fencing). 불일치면 완전 no-op, 어떤 write 도 하지 않는다.**
`status='prechecking' AND claim_token=?`. 이걸 어기고 `superseded` 를 쓰면, lease 만료 후 재claim 한 **새 claimant 를 늦게 도착한 옛 worker 가 파괴**한다 (R2). 소유권 없는 worker 는 아무 권한도 없다.

**2단계 — 유효성 (소유권 확인된 뒤에만 평가·전이).** 검사는 **아래 우선순위 순서대로** 하고, **처음 어긋난 항목이 종결 상태를 결정한다** (codex R3-4: 초안은 전부 `superseded` 로 뭉뚱그려 §3.1 의 "provenance 상실 → `precheck_blocked` + health++" 와 정면 충돌했다. Operator 의 spec 편집은 provenance 와 hash 를 **동시에** 깨므로 우선순위가 없으면 결과가 미정이다):

| 순위 | 조건 위반 | 종결 상태 | health |
|---|---|---|---|
| 1 | `deadline_at <= now` (R3) | `precheck_unavailable` | **+1** |
| 2 | 스케줄 현재 `precheck_verify_check_id` != `precheck_check_id_snapshot` (부착 해제·교체) | `superseded` | 0 |
| 3 | 스케줄 `revision` != 스냅샷 | `superseded` | 0 |
| 4 | check `created_by != 'human'` (§3.1) | `precheck_blocked(provenance_lost)` | **+1** |
| 5 | check 부재 / project scope 이탈 | `precheck_blocked(check_gone \| scope_mismatch)` | **+1** |
| 6 | spec hash 3자 불일치 (스냅샷/평가값/현재, R7) | `superseded` | 0 |
| 7 | node id 또는 workspace generation 3자 불일치 | `superseded` | 0 |

**부착 판정이 존재 판정보다 앞선다** (codex R4-2). 순서가 반대면, 평가 중 `detach → check 삭제` 가 일어났을 때 occurrence 의 FK 와 스케줄 필드가 **둘 다 NULL** 이 되어 "부착이 바뀌었다"를 판별하지 못하고 `precheck_blocked(check_gone)` + health++ 로 **오분류**된다. detach 는 사람이 한 정상 재설정이지 장애가 아니다. 그래서 비-FK `precheck_check_id_snapshot` 으로 순위 2 를 먼저 판정한다.

**모든 스냅샷 대조는 NULL-safe 여야 한다** (codex R5 — 이걸 놓치면 R4-2 수정이 무효다). detach 후 스케줄의 `precheck_verify_check_id` 는 NULL 인데 스냅샷은 정수이므로, SQLite 에서 `NULL != 123` 은 TRUE 가 아니라 **NULL** 이다. `WHERE` predicate 로 쓰면 위반이 **감지되지 않고** 순위 5 까지 내려가 다시 오분류된다. 따라서 SQL 은 `IS NOT` (`schedule.precheck_verify_check_id IS NOT occurrence.precheck_check_id_snapshot`), JS 비교는 NULL 을 값으로 포함한 동등성으로 한다. nullable 인 `precheck_workspace_generation` 대조도 같은 규칙을 따른다.

4~5 는 **구성 장애**(사람이 고쳐야 함)라 health 를 올리고, 2·3·6·7 은 **정상적인 경합·재설정**이라 올리지 않는다.

**3단계 — 결과 반영 (같은 tx).**

| 결과 | occurrence | invocation | health |
|---|---|---|---|
| `passed=false` | `precheck_failed` | 없음 | **0 리셋** (평가는 성공) |
| `passed=true`, cap 초과 | `passed` + `outcome_reason='daily_cap_reached'` + `invocation_id` 링크 | `insertTerminalInvocationFromSchedule(daily_cap_reached)` | 0 리셋 |
| `passed=true`, active 점유·supersede 불가 | `passed` + `outcome_reason='operator_active_skipped'` + `invocation_id` 링크 | `insertTerminalInvocationFromSchedule(operator_active_skipped)` | 0 리셋 |
| `passed=true`, 발화 | `passed` + `invocation_id` 링크 | `insertInvocationFromSchedule` | 0 리셋 |

> **R1**: cap·active-skip 분기도 **반드시 occurrence 를 종결**한다. 종결하지 않으면 occurrence 가 `prechecking` 으로 남아 lease 회수 → 재평가 → terminal invocation 중복 시도 → 결국 `precheck_unavailable` 이라는 모순 상태로 간다.

active invocation 검사는 현행 supersede 규칙(`source='scheduled'` + `pending|claimed` + 더 이른 `scheduled_for`)을 그대로 적용한다.

**4단계 — SSE** (codex R3-7 반영): 기존 `operator:schedule` 버스 이벤트의 payload 는 이미 `kind` 판별자를 갖는다(`invocation_status` / `schedule_changed`). occurrence 는 **새 `kind: 'occurrence_status'`** 로 보낸다 — 기존 두 kind 의 payload shape 는 **한 글자도 바꾸지 않는다**. 기존 키(`schedule_id`/`operator_instance_id`/`invocation_id`/`status`)를 그대로 채우되 invocation 이 없으면 `invocation_id=null`, 여기에 `occurrence_id`/`occurrence_status` 를 추가한다.

**새 SSE 채널 금지** (CLAUDE.md 계약) — `operator:schedule` 은 이미 `eventChannels.js:60,116` 과 `hooks/sse.js:67` 에 등록돼 있다. 현행 클라 소비자(`OperatorsView.js:1175`)는 payload 를 파싱하지 않고 `refresh` 만 하므로 새 kind 는 **추가 refresh 1회** 외에 영향이 없다. 구형 소비자 호환 테스트로 이걸 고정한다.

### 4.4 크래시 복구 · deadline 청소

`sweepStaleOccurrences(now)` — 세 경로 전부 **UPDATE 자체의 WHERE 로** 조건을 검사한다 (SELECT 후 UPDATE 하면 그 사이 재claim 을 덮어쓴다, R5):

1. `status='prechecking' AND leased_until <= now AND deadline_at > now` → `pending` 복귀, `next_attempt_at=now`, `claim_token=NULL` (attempts 유지).
2. `status='prechecking' AND deadline_at <= now` → terminal `precheck_unavailable`.
3. **`status='pending' AND deadline_at <= now` → terminal `precheck_unavailable`** (R3). 이 경로가 없으면 한 번도 claim 되지 못한 occurrence 가 영구 잔류한다 — 특히 `once` 스케줄은 다음 materialization 이 없어 청소 기회 자체가 없다.

`recoverAfterRestart` 도 같은 sweep 을 호출한다. 재부팅이 precheck 을 고착시키지 않는다.

### 4.5 health 카운터 전이표 (R9)

`consecutive_precheck_errors` 는 **"평가에 도달했는가"** 만 센다 — 조건 충족 여부가 아니다.

| 종결 상태 | 전이 |
|---|---|
| `passed` (발화·cap·active-skip 전부) | **0 리셋** |
| `precheck_failed` | **0 리셋** — 조건 불충족은 장애가 아니다 (#524 동의 방향) |
| `precheck_unavailable` | **+1** |
| `precheck_blocked` | **+1** |
| `superseded` | 변화 없음 |
| **check 행 부재** (occurrence 미생성, §4.1) | **+1** |

occurrence 없이 health 만 올리는 마지막 행도 **같은 임계를 적용**한다 — 그래야 오염된 스케줄이 조용히 매 tick 실패하지 않고 3회 만에 비활성화된다.

`+1` 결과가 3 에 도달하면 `enabled=0` + `next_fire_at=NULL` + 이벤트 (기존 `consecutive_failures>=3` 자동 비활성과 동형, **카운터는 분리**).

## 5. 스키마 (migration 089 예정)

```sql
ALTER TABLE operator_schedules ADD COLUMN precheck_verify_check_id INTEGER NULL
  REFERENCES verify_checks(id) ON DELETE RESTRICT;
ALTER TABLE operator_schedules ADD COLUMN consecutive_precheck_errors INTEGER NOT NULL DEFAULT 0
  CHECK(consecutive_precheck_errors >= 0);

CREATE TABLE operator_schedule_occurrences (
  id                       TEXT PRIMARY KEY CHECK(id GLOB 'osocc_*' AND length(id) > 6),
  schedule_id              TEXT NOT NULL REFERENCES operator_schedules(id) ON DELETE CASCADE,
  operator_instance_id     TEXT NOT NULL REFERENCES operator_instances(id) ON DELETE CASCADE,
  scheduled_for            TEXT NOT NULL,
  schedule_revision        INTEGER NOT NULL,
  -- R3-1: occurrence 는 SET NULL. RESTRICT 로 두면 과거 감사 행이 check 를 영원히
  -- 붙잡아 "스케줄에서 떼도 삭제 불가"가 된다. 삭제를 막는 라이브 게이트는
  -- operator_schedules 쪽 RESTRICT 이고, 감사 기록은 아래 비-FK 스냅샷이 보존한다.
  precheck_verify_check_id INTEGER NULL REFERENCES verify_checks(id) ON DELETE SET NULL,
  -- R4-2: FK 와 별개의 비-FK id 스냅샷. FK 가 SET NULL 로 비어도 "어느 check 였나"가
  -- 남아야 '부착 교체'(정상 경합)와 'check 삭제'(구성 장애)를 구분할 수 있다.
  -- occurrence 는 precheck 이 부착된 스케줄에서만 생기므로 NOT NULL — nullable 로 두면
  -- 배선 누락이 조용히 통과해 같은 오분류가 재발한다 (codex R5).
  precheck_check_id_snapshot INTEGER NOT NULL,
  precheck_check_name      TEXT NOT NULL,      -- 비-FK 스냅샷 (삭제돼도 감사 보존)
  precheck_kind            TEXT NOT NULL CHECK(precheck_kind IN ('command','artifact')),
  precheck_spec_hash       TEXT NOT NULL,
  precheck_node_id         TEXT NOT NULL,      -- 로컬은 'local'
  precheck_workspace_generation TEXT NULL,     -- legacy_directory 는 generation 없음 → NULL 정당
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
                             'pending','prechecking','passed','precheck_failed',
                             'precheck_unavailable','precheck_blocked','superseded')),
  outcome_reason           TEXT NULL,
  evaluator                TEXT NULL,
  attempts                 INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  claim_token              TEXT NULL,
  leased_until             TEXT NULL,
  next_attempt_at          TEXT NOT NULL,      -- R6: backoff 를 DB 에 (invocation.run_after 와 동형)
  deadline_at              TEXT NOT NULL,
  invocation_id            TEXT NULL REFERENCES operator_invocations(id) ON DELETE SET NULL,
  detail_json              TEXT NULL,
  started_at               TEXT NULL,
  finished_at              TEXT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(schedule_id, scheduled_for)
);

CREATE UNIQUE INDEX idx_osocc_inflight_schedule
  ON operator_schedule_occurrences(schedule_id)
  WHERE status IN ('pending','prechecking');

CREATE INDEX idx_osocc_claimable
  ON operator_schedule_occurrences(status, next_attempt_at, deadline_at)
  WHERE status IN ('pending','prechecking');

-- S8: verify_checks 의 실행 경계 컬럼은 생성 후 불변 (서비스 레벨 immutable 의 DB 승격)
CREATE TRIGGER verify_checks_kind_immutable
BEFORE UPDATE ON verify_checks
WHEN NEW.kind != OLD.kind OR NEW.project_id IS NOT OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'verify_check kind/project_id are immutable');
END;
```

> **FK 비대칭이 의도적이다** (codex R3-1). `operator_schedules.precheck_verify_check_id` = `RESTRICT` — 부착 중 삭제는 거부(라이브 게이트, #524 동의 방향). `operator_schedule_occurrences.precheck_verify_check_id` = `SET NULL` — 과거 감사 행이 삭제를 영구 차단하지 않게. 양쪽 다 RESTRICT 면 한 번이라도 쓰인 check 는 스케줄에서 떼도 삭제할 수 없다. 삭제 후에도 `precheck_check_name` + `precheck_spec_hash` 스냅샷으로 감사 기록은 읽을 수 있다.
>
> **`prechecking` 중 check 가 삭제되는 경합은 실제로 일어난다** (codex R6-2): detach 가 먼저면 스케줄 쪽 RESTRICT 가 풀리고 삭제가 통과한다. 그래서 §4.3 우선순위 2 와 테스트 42 가 정확히 그 순서(`detach → 삭제 → 늦은 commit`)를 필수 경합으로 고정하고, 비-FK 스냅샷이 그때 판정 근거가 된다. (초안에는 "이 경합은 발생하지 않는다"는 반대 서술이 있었다 — 철회.)
>
> disable 트리거 단독을 안 쓰는 이유는 재활성화 시 게이트를 잃기 때문(#524 동의 방향).

## 6. API

- `PUT /api/operator-schedules/:id/precheck` `{ check_id, expected_revision }` — **cookie + same-origin**. 검증 항목과 코드는 다음으로 **고정**한다 (codex R8 — 초안의 "goal 모드×…, 400/403/503" 은 goal OFF 에서 artifact 부착이 가능하다는 §1.1 과 command 부착은 항상 400 이라는 테스트 4·5 사이에서 해석이 갈렸다):

| 불합격 사유 | 코드 |
|---|---|
| `check.kind != 'artifact'` (v1 전 범위, goal 모드 무관 — §2.1) | **400** |
| `check.project_id != schedule.codebase_project_id` 또는 NULL(global) | **400** |
| `check.created_by != 'human'` | **403** |
| 미인증/비-cookie/cross-origin | **403** |
| `expected_revision` 불일치 | **409** |

**부착 경로에 goal 모드 게이트는 없다** — v1 부착 대상이 artifact 뿐이고 artifact 는 goal 게이트 밖이기 때문이다(§1.1). 따라서 이 라우트는 **503 을 반환하지 않는다**.
- `DELETE /api/operator-schedules/:id/precheck` — 동일 인증.
- `GET /api/operator-schedules/:id/occurrences?limit=` — 감사 목록.
- `PATCH /api/operator-schedules/:id` 은 `precheck_verify_check_id` 를 **받지 않는다**(전용 경로만). 단 `codebase_project_id` 변경 시 부착 precheck 재검증(§S9).
- `verify_checks` 라우터의 kind 단위 게이트 재배치 (§1.1) + 부착된 check 의 수정·삭제 cookie 전용 (§3.1) + `attest` 경로.
- **`deleteCheck` 의 FK 위반 매핑 (codex R2-2)**: `precheck_verify_check_id` 는 `ON DELETE RESTRICT` 이므로 참조 중 삭제는 DB 가 막는다. 그런데 현행 `verifyCheckService.deleteCheck` 은 평범한 `DELETE` 이고 `uniqueConflict` 이 UNIQUE/TRIGGER 만 매핑하므로 **`SQLITE_CONSTRAINT_FOREIGNKEY` 가 500 으로 샌다**. 409 + "스케줄에서 먼저 떼라" 메시지로 매핑한다. fail-closed 자체는 이미 성립하지만(삭제가 성공해 `precheck 없음`으로 fail-open 되는 경로는 존재하지 않는다), 진단이 500 이면 운영자가 원인을 못 찾는다.
- **모든 쓰기는 검증+쓰기가 단일 write tx 의 조건부 UPDATE 여야 한다 (codex R3-5)**. attach/detach/attest/update/delete 는 "읽어서 검사 → 쓰기" 사이에 경합이 있다: attach 가 human provenance 를 확인한 직후 bearer 가 (아직 미참조인) check 를 수정하거나, bearer 가 미참조를 확인한 직후 cookie 가 attach 하고 bearer 수정이 완료될 수 있다. `attest` 의 hash 비교도 같다. **참조 여부·spec hash·provenance 검증과 쓰기를 하나의 `db.transaction()` CAS 로 묶는다** (`modelPolicyService.putPolicy` 선례). 트리거는 kind/project_id 만 지키므로 이 경합을 못 막는다.
- **`assertHumanSameOrigin` 의 scheme/port 미비교 (codex R2-4)**: 현행은 `host` 만 비교해 `http://h` 와 `https://h` 를 같은 origin 으로 본다. **scheme+host+port 전체 비교로 조인다** (순수 강화, 클라이언트 파손 없음). `Origin` 부재 허용은 §8 의 알려진 격차로 남긴다.

## 7. 테스트 (수락 기준)

**비회귀 (최우선)**
1. precheck 미부착 스케줄: materialize → claim → deliver 전 경로가 현행과 동일, occurrence 행 0.
2. goal 모드 OFF + precheck 미사용: `verify_checks` command **쓰기** 경로 여전히 503(읽기는 은닉 — 테스트 3), 기존 스케줄러 테스트 전부 그린.

**게이트**
3. goal OFF: artifact CRUD 200 / command **쓰기** 503 / command **읽기** 은닉 — 목록에 command 행 미포함 + 단건 GET 404 (503 아님).
4. command precheck 부착 → **400** (goal 모드·노드 무관, v1 전 범위 — 37번과 같은 계약).
5. goal ON 으로 켜도 v1 은 command precheck 부착을 거부한다 (§2.1 유보).
6. `created_by='operator'` check 부착 → 거부.

**동시성·상태 전이 (#524 M13)**
7. precheck worker 중복 claim 불가 (CAS).
8. 평가 중 부착이 바뀜 → 결과 커밋 거부.
9. 평가 중 schedule revision 변경 → 커밋 거부.
10. 평가 중 check spec 변경(hash 불일치) → 커밋 거부.
11. provenance 강등 → `precheck_blocked` + health++. **직접 SQL 로 `created_by` 를 오염**시켜 재현한다(§3.1 — API 로는 부착 중 Operator 편집이 403 이라 재현 불가가 정상이며, 그 403 자체는 테스트 34가 고정).
12. 새 occurrence 가 이전 in-flight 를 supersede, 이전 결과 커밋 불가.
13. 수동 `run-now` 와의 경합 → active UNIQUE 가 판정, occurrence 는 `operator_active_skipped`.
14. runner 일시 불가 → backoff 재시도 → 복구 시 통과.
15. deadline 초과 → `precheck_unavailable` + health++ + 임계 3에서 자동 비활성.
16. `precheck_failed` 는 health 를 증가시키지 않고 0 으로 리셋.
17. cap 두 시점 분리(§4.1 note): ①materialize 시 이미 cap 초과 → occurrence **미생성** + `daily_cap_reached` terminal invocation(현행 불변) ②평가 중 cap 이 참 → occurrence `passed(daily_cap_reached)` + terminal invocation 링크. 그리고 `precheck_failed`/`unavailable`/`blocked` 종결분은 invocation 을 만들지 않아 cap 을 소비하지 않는다.
18. `prechecking` 중 크래시 → lease 회수 → 재평가.
19. 부착된 check 삭제 시도 → RESTRICT 로 거부.
20. verify_check kind/project_id UPDATE 시도 → 트리거 ABORT.
21. `detail_json` 이 2KB 이내이고 secret/경로 노출 없이 구조화 reason code 를 담는다.

**핵심 계약 (artifact 전용 v1 의 중심, codex R6-4)**
21a. artifact precheck **pass**: commit **전에는 invocation 이 존재하지 않고**, commit 후 정확히 1개 생성된다(발화 경로).
21b. artifact precheck **fail**: invocation 이 **0개**. 스케줄은 다음 cadence 로 넘어간다.
21c. **원격 노드** artifact 평가가 executor(`listDirectoryEntries`/`readFileCapped`) 경유로 동작한다 — pass/fail 양쪽.
21d. `artifactCheck` 의 walk entries / depth / per-file byte cap 이 **executor 백엔드에서도 동일하게** 강제된다(로컬 평가와 같은 상수).

**codex R1 반영분 (재현 테스트 필수)**
22. **R1**: cap 초과·active 점유로 발화 못 한 경우에도 occurrence 가 `passed` 로 종결되고 `invocation_id` 가 링크된다 (`prechecking` 잔류 0).
23. **R2**: lease 만료 → B 가 재claim → A 가 늦게 commit → **A 는 완전 no-op**, B 의 `prechecking` 이 그대로 살아 있다.
24. **R3**: deadline 전 claim → deadline 후 commit → invocation 미생성. 그리고 한 번도 claim 안 된 `pending` occurrence 가 deadline 후 sweep 으로 `precheck_unavailable` 종결(특히 `once` 스케줄).
25. **R4**: 규칙/타임존 변경으로 이미 소비된 `scheduled_for` 재산출 → occurrence INSERT 가 throw 하지 않고, **커서가 정상 전진**한다 (스케줄 영구 정지 0).
26. **R5**: token 없는 release/sweep 이 남의 `prechecking` 을 되돌리지 못한다.
27. **R6**: 일시 실패 후 즉시 재claim 되지 않는다(`next_attempt_at` 준수). 프로세스 재시작 후에도 backoff 가 유지된다.
28. **R7 (ABA)**: spec A → occurrence 생성 → spec B 로 편집 → evaluator 가 B 평가 → spec A 로 되돌림 → commit 거부.
29. **R8**: artifact 를 노드 A 에서 평가한 뒤 프로젝트가 노드 B 로 이동 → commit 거부(`superseded`). *(command 기반 원안은 §2.1 로 이관 — v1 에 command 평가 경로가 없다.)*
30. **R9**: health 전이표(§4.5) 전 항목 — `passed`/`precheck_failed` 리셋, `precheck_unavailable`/`precheck_blocked` 증가, 3 도달 시 자동 비활성.

**codex R2(보안) 반영분**
31. **R2-2**: 부착된 check 삭제 → **409**(500 아님) + 스케줄에서 떼면 삭제 성공.
32. **R2-3**: Operator 가 만든 check 를 사람이 **rename 만** 해도 `created_by` 가 `operator` 로 유지된다. spec 을 실제로 바꾼 사람 편집만 `human`. `attest`(spec hash 동봉) 경로로만 명시적 승격, hash 불일치 시 409.
33. **R2-4**: `assertHumanSameOrigin` 이 `http://h` vs `https://h` 를 거부한다(포트 상이도).
34. **R2-5**: 어떤 스케줄이든 precheck 으로 참조 중인 artifact check 를 bearer/none 이 수정·삭제 시도 → 403. 미참조 check 는 기존대로 허용.
35. **R2-6**: `project_id IS NULL`(global) check 부착 시도 → 거부. `check.project_id != schedule.codebase_project_id` 도 거부.

**codex R3 반영분**
36. **R3-1**: 스케줄에서 뗀 뒤에는 **과거 occurrence 가 있어도** check 삭제 성공. 삭제 후 occurrence 조회에 `precheck_check_name`/`spec_hash` 스냅샷이 남는다. 부착 중 삭제는 여전히 409.
37. **R3-2**: `kind='command'` check 부착 시도 → **거부**(v1 전 범위). goal 모드 ON 이어도 v1 은 거부한다.
38. **R3-3**: node id 가 바뀐 뒤 commit → 거부. node id 는 같은데 workspace generation 이 바뀐 뒤 commit → 거부. (**node A→B→A 동일-generation 되돌림은 v1 미탐지 — §8 유보 항목**, 테스트로 그 한계를 명시 고정한다.)
39. **R3-4**: provenance 와 spec hash 가 **동시에** 깨진 오염 행(직접 SQL) → 우선순위표대로 `precheck_blocked(provenance_lost)` + health++ (`superseded` 아님).
40. **R3-5**: attach 검증 직후 경합 수정 / 미참조 확인 직후 attach 경합 → 단일 tx CAS 로 직렬화됨. `attest` hash 경합 → 409.
41. **R3-7**: 기존 `operator:schedule` 소비자가 새 `kind:'occurrence_status'` 를 받아도 깨지지 않는다. `invocation_status`/`schedule_changed` payload shape 불변.
42. **R4-2**: 평가 중 `detach → check 삭제` → 늦은 commit 이 `superseded`(health 0)로 종결된다. `precheck_blocked(check_gone)` + health++ 로 **오분류되지 않는다**.
43. **R5 (NULL-safe)**: detach 로 스케줄 필드가 NULL 이 된 상태에서 순위 2 가 **위반으로 감지된다** (`IS NOT`). `!=` 로 구현하면 이 테스트가 RED — 42번 수정이 무효화되는 경로를 직접 고정한다.

**통합**: `npm test` 전체 그린. UI 추가 시 `test:a11y` / `test:visual`.

## 8. 미해결로 남기는 것 (의도적)

- **precheck 은 보안 경계가 아니다**(§S10, §3.1.1). 보안 경계가 필요하면 goal 모드(PM 토큰 분리)를 켜야 한다.
- **노드 fencing 은 A→B→A 되돌림(ABA)까지는 못 잡는다** (codex R4-1 후반, 의도적 유보). 노드 재바인딩마다 증가하는 단조 `binding_generation` 을 새로 도입하면 닫히지만, **v1 은 artifact 전용**이라 잘못 fencing 된 결과의 최대 피해가 "몇 초 전 다른 노드의 파일 상태로 발화 여부를 정했다"이다. 방어 논거는 **"기존 TOCTOU 보다 약하다"가 아니다** — 다른 workspace 의 상태를 본 오류는 provenance 관점에서 동일 workspace 의 시간차 오류보다 오히려 크다(codex R5 지적, 타당). 정확한 논거는 **허용되는 최대 결과가 같다**는 것이다: 둘 다 §S10 에서 비보안 게이트로 선언한 "잘못된 발화 또는 미발화"에서 멈추고, 실행 부작용이 없다. command precheck 을 되살릴 때는 "command=로컬 한정" 불변식이 걸리므로 **그때 단조 카운터를 반드시 도입한다** (§2.1 재개 조건에 포함).
- **`assertHumanSameOrigin` 의 `Origin` 부재 허용** (codex R2-4 후반): 상태 변경 요청에서 `Origin` 이 없으면 통과시킨다. 브라우저가 아닌 cookie 클라이언트(테스트·curl)를 깨지 않으려는 기존 선택이며, A2 는 scheme/port 비교만 조이고 이 정책은 **건드리지 않는다**. 조이려면 CSRF 토큰 도입이 선행돼야 하고, 이는 스케줄러뿐 아니라 모든 cookie 쓰기 라우트에 걸리는 별도 슬라이스다.
- **command precheck 전체 = v1 유보** (§2.1). 되살리는 조건: goal 모드 flip + at-most-once 실행 의미(attempts 1 고정) 또는 sandboxed runner + 셸 실행 전용 quota. 원격 command runner 는 G3b Part B DEFER 그대로.
- precheck 조합(AND/OR), RRULE, 프롬프트 외부화(A3) 는 이 슬라이스 밖.
- 운영 Pi 는 현재 `46945e7`(#450) 로 main 보다 뒤라 A1 조차 배포되지 않았다. 스케줄러 실사용 검증은 Pi 배포 갱신이 선행돼야 한다 — 이 슬라이스의 수락 기준에는 넣지 않는다.
