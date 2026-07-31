# Worker owner-exit — 재설계 brief (v6)

**상태**: S0 착수 가능 / S1~S3 계약 미확정
**참고 자산**: `fix/465`(PR #478) · `fix/466`(PR #482) 의 미머지 잔여분
**선행 완료**: #486(idle timeout + terminal_reason) · #487(terminal CAS + retry 유일성)

> **개정 이력**
> - **v1** — "두 브랜치가 같은 근본 문제(owner 추적)에 도달했다"를 전제로 4단계 제안.
>   codex 1라운드가 그 전제를 무너뜨림(§1).
> - **v2** — S0 관측을 최우선으로 신설, D2+D3 을 한 단계로 묶음, S4 를 필수로 승격.
>   codex 2라운드 **NO-GO**: S0 데이터 계약 부재, generation fencing 부재,
>   `draining` 상태 미명시, released/abandoned 부수효과 행렬 부재, S4 필수화가 규모를
>   `fix/466` 수준으로 되돌림.
> - **v3** — 위를 반영. S4 를 S0 조건부로 환원. codex R3 **NO-GO** — 착수 전 필수 4건.
> - **v4** — lease 를 S1 으로, 부수효과 2차원 행렬, admission gate, S0 allowlist.
>   codex R4 **NO-GO** — 착수 전 필수 4건(전부 "배선을 명시하라"이지 방향 부정 아님).
> - **v5** — S0 자유 문자열, lease 원자성, admission 경계, 행렬 보강. codex R5 **NO-GO**.
> - **v6 (현재)** — R5 의 **S0 관련 3건만** 반영해 S0 을 착수 가능 상태로 만들고,
>   S1~S3 의 미확정 계약을 §8 에 **명시적으로 남겼다**. 5라운드에 걸쳐 지적의 성격은
>   좁아졌으나 개수가 줄지 않았다 — 설계 문서로 모든 구현 세부를 선확정하려는 시도가
>   수렴하지 않는다고 판단하고, **관측 단계부터 착수하며 확정**하는 쪽으로 전환한다.
>
> 관통 원칙: **원인이 확정된 것만 고치고, 미확정인 것은 먼저 관측한다.**

---

## 1. v1 의 전제가 틀린 부분 (검증됨)

| v1 주장 | 실제 | 근거 |
|---|---|---|
| #465 와 #466 이 같은 근본 문제(owner 추적)에 도달했다 | **#465 의 문서화된 결함은 owner-exit 이 아니라 repeated terminal write 의 CAS/멱등성이었고 #487 로 해결됐다.** 그 브랜치가 이후 owner 추적으로 번진 것은 사실이나, 이슈 자체가 owner 문제였다는 근거는 없다 | `docs/audit-run-status-cas.md:3` |
| #466 의 9시간 idle 은 프로세스가 안 죽어서다 | **"9시간"이라는 수치는 timezone 파싱 버그의 산물이다**(zone 없는 SQLite 문자열을 로컬 시각으로 파싱 → Asia/Seoul 에서 방금 기록한 이벤트가 ~9시간 전으로 계산). 그 버그는 수정됐다. 다만 **"프로세스가 결론 후에도 살아 있었다"는 관측 자체는 남는다** — 부정된 것은 지속 시간의 크기이지 현상이 아니다 | `docs/worker-idle-timeout-investigation-2026-07-29.md:8-14` |
| "결론 후 프로세스가 안 죽는다"가 확립된 결함이다 | **원인 미확정.** 조사 문서가 명시한다 — "실측 3건의 profile row, 실제 argv, process tree가 없어 어느 분기를 탔는지 입증할 수 없다 … 미해결" | 같은 문서 `:70-76` |
| `lifecycleService.js:2869` 가 persisted result 를 재파싱한다 | 그 코드는 **`fix/466` 브랜치에만** 있다. 현재 main 의 2869 는 `channel.ownerOf(run.id)` 호출 | `server/services/lifecycleService.js:2869` |
| tmux kill-session 이 pane 프로세스 그룹을 정리한다 | 코드와 `fix/466` 테스트가 이를 뒷받침하지 않는다. 검증되지 않은 주장이었다 | — |

**따라서 이 트랙의 정당한 범위는 #466 의 미해결 부분뿐이고, 그 원인은 아직 모른다.**

두 브랜치가 수렴하지 못한 진짜 이유도 여기 있을 가능성이 크다: **원인을 모르는 채 방어
인프라를 지었고**, 그래서 경계 사례 목록이 닫히지 않았다. 커밋 메시지가 `close remaining`
→ `close final` → `close residual` → 다시 `close remaining` 으로 순환한 것이 그 흔적이다.

v2 의 첫 번째 규칙: **원인 미확정인 문제를 위해 인프라를 먼저 짓지 않는다.**

---

## 2. 원인과 무관하게 확실한 결함 3개

관측 결과가 무엇이든 이것들은 틀렸다. 근거는 현재 main 코드다.

### D1. `ownerOf` 가 소유를 증명하지 않는다

```js
// server/services/nodeExecutor.js:85 (executionOwns)
if (typeof executionEngine.isAlive === 'function' && executionEngine.isAlive(runId)) return true;
if (executionSessionOwns(runId)) return true;
if (executionEngine.type) return true;   // ← 이 run 과 무관
```

세 번째 분기는 **엔진 인스턴스가 존재하기만 하면** 'cli' 소유로 판정한다. `ownerOf` 가
"누가 이 run 의 프로세스를 들고 있나"가 아니라 "어떤 엔진이 설정돼 있나"를 답한다.
`checkHealth` 가 이 값으로 분기한다(`lifecycleService.js:2869`).

또한 현재 계약은 **alive/dead 이분법**이라 "모른다"를 표현할 수 없다. 원격에서 SSH 가
실패하면 `dead` 로 오판될 수 있다(`remoteSshExecutor.js:1930`).

### D2. kill 이 직접 자식에게만 간다

```js
// server/services/executionEngine.js:809 (SubprocessEngine)
proc.child.kill('SIGTERM');
```

spawn 은 `detached: false`(`executionEngine.js:719`). 그룹 시그널을 쓰지 않으므로 워커가
띄운 손자(빌드·테스트 러너·언어 서버·MCP 서버)는 SIGTERM 을 받지 않는다.

### D3. graceful shutdown 이 worker 를 정리하지 않는다

`app.shutdown` 은 manager 슬롯만 순회해 `disposeSession` 한다(`server/app.js:2097` 이하,
주석도 "manager subprocesses" 라고 명시). **worker 는 sweep 대상이 아니다.**

D2 를 `detached: true` 로 고치면 D3 이 악화된다 — 지금은 같은 프로세스 그룹이라 터미널
SIGINT 가 워커에 전파될 여지라도 있지만, 그룹을 분리하면 그마저 사라진다. **D2 와 D3 은
반드시 함께 간다.**

---

## 3. 단계

### S0 — 관측 (선행 필수)

"결론 후 프로세스가 종료하지 않는다"의 **원인을 잡는다.** 조사 문서가 없다고 한 바로 그
데이터를 남긴다.

- idle 임계값 초과가 관측될 때, kill 하기 **전에** 스냅샷을 남긴다.
- 이벤트 `worker:idle_snapshot`, annotate-only, never-throws.
- 원격 노드는 executor 를 통해 같은 스냅샷을 수집한다. 실패는 조용히 넘긴다.

#### 직렬화 allowlist (확정 — 이 표에 없는 것은 저장하지 않는다)

`memorySanitize` 는 memory content 용 패턴 redactor 이므로
(`server/services/memorySanitize.js:1-18`) argv 에 재사용하지 않는다. 아래가 **완전한
목록**이다.

| 필드 | 규칙 |
|---|---|
| `run_id`, `profile_id` | 서버 생성 id. `^[A-Za-z0-9_-]{1,64}$` 아니면 `<invalid-id>` |
| `node_id` | 위와 동일 검증. 자유 문자열이 될 수 있으므로 형식 미달이면 `<invalid-id>` |
| `profile.command` | `ALLOWED_COMMANDS` 의 **빌트인 집합**에 속하면 그대로. `PALANTIR_ALLOWED_COMMANDS` 로 추가된 값은 경로·사용자값일 수 있으므로 **`custom:<sha256 앞 8자>`** |
| `profile.type` | 알려진 enum(`codex`·`claude-code`·`gemini`) 밖이면 `other`. **DB 에 enum 제약이 없다** |
| `profile.args_template_keys` | **알려진 플래그 이름 enum** 밖이면 `<unknown-flag>`. 값은 전부 제거 |
| `argv[0]` | 실행파일. basename 규칙(아래) 적용 |
| `argv[1..]` | **알려진 플래그 이름**이면 그대로, 그 외 전부 `<redacted:N>`(N=바이트 길이). **basename 허용은 `argv[0]` 에만** — 영숫자 비밀값이 basename 규칙을 통과할 수 있다 |
| `tree[].exe_basename` | `path.basename` 적용 후 `^[A-Za-z0-9._-]{1,64}$` 검증. 미달이면 `<invalid>` |
| `tree[].state` | 고정 enum `R`·`S`·`D`·`T`·`Z`·`I` 로 정규화. 그 외 전부 `?` |
| `tree[]` 나머지 | `pid`·`ppid`·`pgid`·`cputime_s` **만**(정수/실수) |
| `fd_summary` | 종류별 **개수만** `{file,socket,pipe,other}`. 경로 금지 |
| `last_output_at` | ISO-8601 또는 SQLite datetime 형식 검증. 미달이면 `null` |
| `collect_errors[]` | **고정 코드만** (`ps_failed`·`proc_unreadable`·`remote_timeout`·`unsupported_platform`). 원문 메시지 금지 |
| `truncated` | 상한 초과 시 true |

- **env 는 수집하지 않는다.** 키 목록도 남기지 않는다.
- **자유 문자열이 흘러들 수 있는 지점은 위 표에서 전부 닫혀 있다.** id 는 형식 검증,
  command 는 빌트인 집합 밖이면 해시, type/플래그는 enum, basename 은 문자 클래스 검증,
  argv 는 allowlist, 수집 오류는 고정 코드 집합.
- 상한: 이벤트당 **16KB**, `tree` **64 노드**. 초과 시 절단 + `truncated:true`.
- 보존: 기존 `run_events` 정책. 별도 저장소를 만들지 않는다.
- allowlist 를 통과하지 못한 토큰은 **기본 제거**(fail-closed).

**독립 가치**: 이 트랙 전체가 취소돼도 관측은 남는다. 그리고 S3 이하의 정당성이
여기서 나온다.

**완료 기준**: 실제 사례 1건 이상에서 "어느 프로세스가 왜 남았나"를 지목할 수 있다.

### S1 — ownership 계약 정정 (D1)

- `ownerOf` 를 두 개로 쪼갠다.
  - `engineFor(runId)` — 이 run 을 어느 엔진으로 다뤄야 하는가(라우팅).
  - `ownerState(runId)` → `'alive' | 'dead' | 'unknown'` — 실제 프로세스 상태.
- `if (executionEngine.type) return true` 를 제거한다. 제거 **전에**, dead/unknown run 도
  여전히 terminal 화된다는 것을 기존 fall-through(`lifecycleService.js:2886`)로 테스트에
  고정한다.
- `unknown` 은 **dead 로 취급하지 않는다.** 원격 SSH 실패를 종료로 오판하면 살아있는
  워커 위에 새 워커가 뜬다.
- **release 권한을 한 곳으로.** `runService.releaseOwner(runId, leaseId, evidence)` 단일
  CAS 만 owner 종료를 기록한다. exit handler 와 health loop 는 **관측자**일 뿐이고, 둘 다
  이 함수를 호출한다. CAS 승자만 이벤트를 발행한다.
#### lease 저장소 (v3 의 S3 에서 앞당김)

R3 지적: `releaseOwner` 가 쓸 저장소가 lease 이므로 S1 에 있어야 한다. S3 에 두면 S1 이
임시 저장소를 만들었다 버리게 된다.

```
run_owner_leases
  run_id, lease_id, state(held|released|abandoned),
  acquired_at, terminal_observed_at, closed_at
```

| 파생 상태 | 조건 |
|---|---|
| reserved | `held` + `acquired_at IS NULL` |
| acquired | `held` + `acquired_at` + `terminal_observed_at IS NULL` |
| **draining** | `held` + `terminal_observed_at NOT NULL` — terminal 은 기록됐고 owner 는 아직 살아 있다 |

`draining` 이 핵심이다. `fix/466` 은 같은 구간을 `running` **status** 로 표현해
UI·retry·harvest·SSE·dispatch audit 을 전부 끌어들였다. 여기서는 **status 가 아니라
lease** 가 그 구간을 표현하므로 status 소비자는 영향을 받지 않는다.

**lease_id 생명주기**

- **발급**: worker claim 성공 직후, spawn 시도 **전에** `held/reserved` 행 생성.
- **전달**: spawn 시 engine handle 에 실어 보낸다(로컬=프로세스 맵 엔트리, 원격=spawn
  payload). 관측자는 자기가 든 `lease_id` 로만 release 를 시도한다.
- **세대교체**: 재spawn·retry 는 **새 `lease_id`**. 이전 세대 행은 그대로 닫힌다.
- **CAS**: `WHERE run_id=? AND lease_id=? AND state='held'` 로만 이긴다.

**원자성·불변식 (R4)**

- **claim + reserved lease 생성은 단일 트랜잭션**이다. 둘 사이에 창이 있으면 claim 은
  성공했는데 lease 가 없는 run 이 생겨 capacity 가 과소 계산된다.
- **run 당 `held` lease 는 최대 1개.** partial unique index
  (`UNIQUE(run_id) WHERE state='held'`) 로 강제한다.
- **`acquired_at` 은 spawn 성공 시점에** 스탬프한다(reserved → acquired).
- **pre-spawn 실패는 즉시 release** 한다(`evidence='spawn_failed'`). 그렇지 않으면
  프로세스가 존재한 적 없는 reserved lease 가 capacity 를 영구 점유한다.
- **재시작 복구**: boot 시 `held` + `acquired_at IS NULL`(고착 reserved)은 정리 대상이다.
  `acquired_at` 이 있는 held 는 owner 를 재확인해야 하며, 확인 전에는 점유로 센다.
- **기존 run 이관**: 마이그레이션이 현재 `status='running'` 인 worker run 에 대해
  `held/acquired` lease 를 생성한다. 없으면 배포 직후 capacity 가 0 으로 보인다.
- **lease 없는 run**: `queued`·`materializing`·manager run(`is_manager=1`)은 lease 를 갖지
  않으며 capacity 계산에서 제외된다. goal retry child 는 **자기 lease** 부터 센다.

**capacity 기준 변경**: 현재 `status='running'` 만 센다(`runService.js:211`). 이를
**`lease.state='held'`** 로 바꾼다. 그래야 `needs_input`·`paused` 처럼 terminal 이 아닌 채
owner 가 살아있는 구간도 점유로 계산된다.

**독립 가치**: health 분기가 실제 상태를 보고 판단하고, capacity 가 실제 점유를 반영한다.

### S2 — 프로세스 그룹 + shutdown sweep (D2 + D3, 하나의 단계)

- 로컬 subprocess spawn 을 `detached: true` 로 → 워커가 자기 프로세스 그룹의 리더.
- kill 은 `process.kill(-pgid, ...)`: `SIGTERM` → 유예(설정 가능) → 잔존 시 `SIGKILL`.
- `child.unref()` 는 **호출하지 않는다**(컨트롤 플레인이 exit 을 계속 관측해야 한다).
- `app.shutdown` 에 **worker sweep** 을 추가한다. manager dispose 와 같은 규칙:
  best-effort, 실패는 로그, closeDb 이전.
- `streamJsonEngine` 도 같은 계약을 받는다. 두 엔진이 다르면 `ownerState` 가 엔진마다
  다른 의미가 된다.
**단일 admission gate**. "새 워커가 뜨는 모든 경로"를 한 곳에서 닫지 않으면 sweep 이 방금
뜬 워커를 놓친다.

R4 지적: 진입 경로를 열거하는 방식은 빠뜨린다. 실제로 확인된 것만 해도

- `drainAllQueues` — boot drain, **현재 fire-and-forget**(`server/app.js:1920`)
- `scheduleDrainForNode` — node recovery(`server/app.js:1679`), uncordon(`server/routes/nodes.js:48`),
  project 이동(`server/routes/projects.js:226`)
- `drainQueue` — 내부(`server/services/lifecycleService.js:944`) + 공개 API
- goal retry drain, materialization 완료 후 drain, 직접 호출

**따라서 경계는 호출자 목록이 아니라 `spawnQueuedRun` 의 claim→handle 구간 자체다.**
admission 은 그 함수 안, claim **이전**에 위치한다. 새 호출자가 추가돼도 자동으로 닫힌다.

- 반환 계약: admission 거절 시 run 은 `queued` 로 남는다(실패 처리하지 않는다).
- shutdown 은 이 순서를 지킨다.

```
1. admission 차단(이후 모든 경로 즉시 거절)
2. 이미 admission 을 통과한 spawn Promise 전부 대기
3. worker sweep (그룹 SIGTERM → 유예 → SIGKILL)
4. manager dispose
5. closeDb
```

4·5 는 현재 순서 그대로다(`server/app.js:2082` 이하). 3 을 그 앞에 끼운다.

**왜 한 단계인가**: D2 만 고치면 shutdown orphan 이 확정적으로 악화된다.

### S3 — owner-dependent side effects 를 release 뒤로 (관측이 정당화할 때)

`fix/466` 은 이 문제를 "owner 가 죽을 때까지 `running` 유지"로 풀었다. status 의미가
바뀌어 UI·retry·harvest·SSE·dispatch audit 이 전부 영향을 받았고, 그것이 25커밋의
상당 부분이다.

v2 의 분리: **terminal status 는 UI/이력용으로 지금처럼 즉시 쓴다. 다만 owner 생존에
의존하는 부수효과는 release 이후로 미룬다.**

- 대상: 자동 retry 생성, harvest(diff 캡처·테스트 실행·worktree 제거), worktree cleanup,
  그리고 capacity 회계.
- **왜 필요한가**: 살아있는 프로세스가 계속 파일을 쓰는 상태에서 diff 를 캡처하면 그
  diff 는 사후에 바뀐다. worktree 제거는 실패한다. 새 retry 는 아직 살아있는 형제와
  경쟁한다. 이건 slot 숫자만의 문제가 아니다 — v1 이 놓친 지점이다.
> R3 지적: `released` **하나**로 부수효과를 판단하면, 정상 종료한 `needs_input` run 의
> **resumable worktree 를 제거**한다. 조건은 반드시 2차원이다.

```
capacity 반환  = state ∈ {released, abandoned}
terminal 효과  = state == released  AND  run.status 가 그 효과에 적합한 terminal
```

| 부수효과 | released + terminal status | released + `needs_input`/`paused` | abandoned |
|---|---|---|---|
| capacity 반환 | ✅ | ✅ | ✅ (유일한 허용) |
| queue drain 재호출 | ✅ | ✅ | ✅ |
| 자동 retry 생성 | ✅ (`failed`) | ❌ | ❌ |
| harvest (diff·test) | ✅ (`completed`/`failed`) | ❌ | ❌ |
| worktree 제거 | ✅ | ❌ **resumable** | ❌ |
| `captureGoalOutput` | ✅ | ❌ | ❌ |
| `cleanupRunRuntimeFiles` (MCP secret dir·config·workspace ref·goal output log) | ✅ | ❌ | ❌ |
| task status sync (`checkTaskCompletion`, listener 밖 직접 호출 포함) | ✅ | ❌ | ❌ |
| `run:ended(failed)` webhook | ✅ | ❌ | ❌ |
| `run:harvested` fan-out 전체 — R6 fact / R1b memory capture / Operator review | harvest 와 동일 조건 | ❌ | ❌ |
| goal verdict / goal retry / outbox | harvest 뒤 연쇄 — harvest 와 동일 조건 | ❌ | ❌ |
| 이벤트 | `worker:owner_released` | `worker:owner_released` | `worker:owner_abandoned` |

`cleanupRunRuntimeFiles`(`lifecycleService.js:753`)는 worktree 밖의 자원(MCP secret dir 등)도
지우므로 **반드시 release fence 안에** 있어야 한다.

#### abandonment fence

`abandoned` 는 "owner 생사 미확인"이다. capacity 만 풀고 나머지를 금지하는 것으로는 부족하다.

- **원격**: cordon 을 **durable 하게 확정한 뒤** lease 를 `abandoned` 로 바꾼다. outstanding
  abandoned owner 가 있는 동안 일반 uncordon 을 금지하고 명시적 복구 승인을 요구한다.
- **로컬**: 동등한 dispatch fence 가 필요하다. 없으면 abandonment 직후 대체 워커가 미확인
  owner 와 겹친다. **구현하지 못하면 로컬 `abandoned` 자체를 금지한다**(상한 없이 `held`
  유지 + 경보).
- 상한 기본값은 **S0 데이터로 정한다.** `max_concurrent=1` 프로필에서 상한 대기가 큐를
  통째로 막는다는 점을 계산에 넣는다.

**착수 조건**: S0 이 "살아남은 프로세스가 실제로 부수효과를 오염시킨다"를 보여줄 것.

### S4 — 그룹을 벗어난 프로세스 / tmux / 원격

`setsid` 로 그룹을 떠난 손자는 S2 가 못 잡는다. tmux·원격 경로도 같은 계약이 필요하다.

- 두 브랜치의 구현을 자산으로 쓴다: `fix/465:server/utils/processTreeOwnership.js`,
  `fix/466:server/services/localProcessOwnership.js`. 둘은 env 마커 + `NODE_OPTIONS`
  preload + `PYTHONPATH` sitecustomize + 프로세스 스캔이라는 **구조는 수렴했으나 identity
  방식과 코드는 다르다.** 하나를 고르는 것이 아니라 하나의 계약으로 다시 쓴다.
**이 단계는 S0 조건부다 — 그리고 그 대가를 명시한다.**

v2 는 codex 1라운드 지적("선택으로 두면 #466 종결을 주장할 수 없다")을 받아 S4 를 필수로
올렸다. 2라운드는 그 결과 총 규모가 `fix/466` 수준(+7,900줄)으로 돌아간다고 지적했고,
근거로 실제 브랜치가 필요로 한 범위를 들었다.

- Node `child_process` seam 전체 wrapping — `fix/465:server/utils/processTreeOwnership.js:112-226`
- Linux `/proc` · Darwin `ps eww` owner 검색 — `fix/466:server/services/localProcessOwnership.js:124-182`
- tmux kill target identity 저장 + PID/PGID 재사용 방어 — `fix/466:server/services/executionEngine.js:517-650`
- detached Node/Python/`setsid` descendant 회귀 — `fix/466:server/tests/execution-engine-exit.test.js:1041-1365`

**선택한 트레이드오프**: S4 를 조건부로 되돌리고, **"#466 완전 종결"과 "모든 detached
descendant 정리"를 주장하지 않는다.** 근거는 §1 이다 — `fix/466` 의 적대 테스트는 그런
실패가 *가능함*을 증명하지만, 그것이 **실측 #466 의 원인이었다는 증거는 없다**
(`docs/worker-idle-timeout-investigation-2026-07-29.md:74-78`). 원인 미확정 상태에서
가장 큰 단계를 필수로 삼는 것은 v1 이 저지른 실수의 반복이다.

S0 이 detached descendant 를 실제 원인으로 지목하면, 그때 이 단계를 **별도 epic** 으로
착수한다. 지목하지 않으면 착수하지 않는다.

---

## 4. 범위 밖 (명시)

- worker 가 "더 진행 불가"를 판단했을 때 조기 종료하는 프롬프트 규약(#466 제안 3).
- Claude `stream-json` 워커의 idle timeout. `checkHealth` 의 stream-json 분기가 idle 계산
  전에 `continue` 하는 것은 main 과 동일한 기존 구조다.
- `fix/465`/`fix/466` 의 나머지 커밋 되살리기. 참고 자산이지 병합 대상이 아니다.

---

## 5. 검증

각 단계 공통:

1. **역회귀** — 수정을 되돌리면 새 테스트가 실패한다(뮤테이션으로 확인).
2. **기존 계약 불변** — status 전이·SSE envelope·retry 판정·harvest 트리거가 기존
   스위트로 증명된다. S3 은 이 중 harvest/retry **타이밍**을 의도적으로 바꾸므로, 무엇이
   바뀌고 무엇이 안 바뀌는지 테스트로 명시한다.
3. **codex 적대리뷰** — "이 변경을 깨뜨려라". 지적은 코드로 재현한 뒤에만 반영한다.

단계별 최소 회귀:

- **S0**: 스냅샷이 남는다 / 수집 실패가 run 을 실패시키지 않는다 / **allowlist 밖 토큰이
  직렬화되지 않는다**(값-형태 argv, 수집 오류 원문 포함).
- **S1**: 엔진은 있으나 이 run 의 핸들이 없으면 `ownerState !== 'alive'` / `unknown` 이
  `dead` 로 처리되지 않는다 / `releaseOwner` CAS 는 한 세대에 한 번만 이긴다 / **옛
  `lease_id` 로는 새 세대를 release 하지 못한다** / capacity 가 `needs_input` 의 live
  owner 를 계속 센다 / **claim 은 성공했는데 lease 가 없는 상태가 만들어지지 않는다**
  (트랜잭션) / **run 당 held lease 는 1개**(제약 위반 시 두 번째 claim 실패) /
  pre-spawn 실패가 lease 를 남기지 않는다 / **마이그레이션이 기존 running run 에 lease 를
  만들어 배포 직후 capacity 가 0 이 되지 않는다**.
- **S2**: 손자를 띄운 워커를 kill 하면 손자도 죽는다 / 유예 안에 스스로 정리하면 SIGKILL
  이 오지 않는다 / **shutdown 중 `spawnQueuedRun` 이 어느 호출자를 통해 들어와도 거절되고
  run 은 `queued` 로 남는다** / 통과한 spawn 을 기다린 뒤 sweep 한다.
- **S3**: owner 생존 중 harvest·retry·worktree 제거·runtime cleanup 이 실행되지 않는다 /
  release 후 실행된다 / **`needs_input` 로 release 된 run 의 worktree 는 보존된다** /
  `abandoned` 는 capacity 만 풀고 나머지를 실행하지 않는다 / abandonment 전에 fence 가 선다.

## 6. 이 설계로도 안 풀리는 것

- tmux/원격의 detached descendant (S4 범위, 계약 미정의).
- 컨트롤 플레인 재시작 중 종료된 워커의 boot recovery **순서** — recovery 완료 전에 drain 을
  시작하면 오판한다. S2 admission gate 가 boot drain 을 포함하지만 recovery↔drain 순서
  자체는 별도로 확정해야 한다.
- "결론 후 프로세스가 안 죽는" **근본 원인** — S0 이 답할 문제이지 이 설계가 답하지 않는다.

---

## 7. 검토에서 답할 것 (5라운드)

1. S0 의 자유 문자열이 이제 **전부** 닫혔는가? (id 형식검증 / command 빌트인-외 해시 /
   type·플래그 enum / basename 문자클래스 / argv allowlist / 오류 고정코드)
2. lease 원자성·단일 held·재시작 복구·기존 run 이관 정의에 남은 구멍이 있는가?
3. admission 경계를 `spawnQueuedRun` claim→handle 구간으로 옮긴 것이 충분한가?
4. 부수효과 행렬이 이제 완전한가?
5. **S0 → S1 → S2 착수 가능한가?** GO / NO-GO. NO-GO 면 착수 전 반드시 고칠 것만.

---

## 8. S1~S3 의 미확정 계약 (착수 전 확정 필요)

codex 5라운드가 지적한, **문서에서 아직 못 박지 않은** 것들이다. S0 은 이것들과 독립이므로
먼저 착수할 수 있으나, **S1 이상은 여기를 확정한 뒤에 시작한다.**

### S1 — lease

- **spawn 성공 → `acquired_at` 기록 사이 crash.** 이 창에서 죽으면 살아 있는 owner 를
  "고착 reserved"로 오인해 정리할 수 있다. spawn 성공을 `acquired_at` 과 원자적으로
  묶거나(핸들 등록과 같은 트랜잭션), 정리 전에 `ownerState` 를 반드시 확인해야 한다.
- **마이그레이션 대상**은 `running` 뿐 아니라 owner 가 존재할 수 있는 `paused`·`needs_input`
  까지 포함해야 한다.
- **복구된 핸들에 `lease_id` 를 결속**하는 방법(재시작 후 관측자가 어느 세대인지 아는 법).

### S2 — admission

- gate 진입 + in-flight 등록, shutdown 의 gate 폐쇄 + 대기 목록 확정이 각각 **원자적**이어야
  한다. 아니면 등록 직전에 폐쇄된 spawn 을 아무도 기다리지 않는다.
- **boot recovery 완료 전 boot drain 금지**를 계약으로 확정한다(§6 에 문제로만 적어둔 것).

### S3 — fence 범위와 순서

- 이벤트 listener 외에 **boot/direct 경로**도 같은 fence 가 필요하다:
  `cleanupStaleTerminalWorktrees`, `cleanupOrphanMcpConfigs`, goal verdict/outbox sweep.
- **terminal 기록과 lease release 의 순서가 뒤바뀌어도 효과가 유실되지 않는 양방향
  idempotent reconciler** 가 필요하다. 지금 행렬은 "release 시점에 status 를 본다"만
  정의하고, 반대 순서(release 가 먼저, terminal 이 나중)를 정의하지 않는다.

### 이 목록을 이렇게 남기는 이유

5라운드 동안 지적의 성격은 좁아졌으나(전제 → 구조 → 배선 → 계약 세부) 개수는 줄지 않았다.
시스템이 크므로 새 세부는 계속 나온다. **문서로 전부 선확정하려는 시도 자체가 수렴하지
않는다**고 판단한다 — 이는 두 브랜치가 "구현으로" 겪은 것과 같은 실패를 "문서로" 반복하는
형태다.

따라서 S0(관측, annotate-only, 되돌리기 쉬움)부터 착수하고, S1 이상은 **S0 이 원인을 지목한
뒤** 그 원인에 필요한 범위만 확정해 진행한다.
