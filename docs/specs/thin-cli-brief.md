# 얇은 `palantir` CLI — 설계 계약

> **상태**: 설계 계약 확정 (2026-08-14). codex 적대검토 **7라운드** 반영 후 GO (BLOCKER 7 + SERIOUS 17 + MODERATE 6 + MINOR 1).
> **상위**: `docs/goal-session-protocol.md` 큐 #13 / `docs/specs/orca-parity-and-action-plane-brief.md` §4 4단계
> **spec 원문**: "spawn / follow / input / cancel 만. **Orca 터미널 UI 전체를 복제하지 않는다.** 웹 UI 만으로는 대체 선언에 부족하다는 판정."

---

## 0. 한 줄 목표

**터미널에서 워커를 띄우고, 출력을 따라가고, 입력을 넣고, 취소한다.** 그 넷뿐이다.

## 1. 착수 전 실측 (코드로 확인한 사실)

A2 에서 "spec 대로 만들면 어느 배포에서도 쓸 수 없었다"를 착수 직전에 발견한 선례가 있으므로, 전제를 먼저 코드로 확인했다. **초안은 이 확인 없이 썼고 codex 가 그 위에서 BLOCKER 4 건을 잡았다** — 아래는 정정본이다.

| 사실 | 근거 |
|---|---|
| 네 동사 모두 `Bearer` 로 **라우트 도달 가능** | cookie-only 가드는 `/tasks/:id/goal/deliver` 뿐(`routes/tasks.js:196`). manifest 상 넷 다 `availability: 'always'` |
| `GET /runs/:id/output` 은 **`{ output }` 만** 준다 — status 없음 | `routes/runs.js:507` |
| 그 엔드포인트는 **마지막 N 줄 tail** 이다. `lines` 기본 100, **상한 2000** | `routes/runs.js:466` |
| run status 는 `GET /runs/:id` → `{ run }` | `routes/runs.js:208` |
| **canonical terminal 집합 = `completed / failed / cancelled / stopped`** | `runService.js:13` (`stopped` 는 초안이 누락했다) |
| 전체 status 집합 = `queued / running / paused / needs_input / completed / failed / cancelled` | migration 001:48 |
| `engines.node = "^22"` → 전역 `fetch`·`node:util.parseArgs` 사용 가능 | `package.json:24` |
| **원격 노드 `sendInput` 은 스텁, 항상 `false`** | `remoteSshExecutor.js:1973` |
| 그 실패는 삼켜지지 않고 **502** 로 올라온다 | `routes/runs.js:433` |

### 1.1 `input` 은 "네 동사 parity" 를 아직 충족하지 못한다 (정직한 서술)

초안은 "네 동사 모두 도달 가능"이라고 적었는데, 이는 **HTTP 라우트 도달성과 기능 제공을 혼동**한 것이다(codex BLOCKER-2). 정정:

> **`input` 은 로컬 노드 run 에서만 동작한다.** 원격(pod) run 에서는 `remoteSshExecutor.sendInput` 이 스텁이라 **항상 502** 다. CLI 는 이걸 고치지 않고 정직하게 노출한다. 원격 대화형 입력이 붙기 전까지 4단계 parity 는 **부분 충족**이며, 그렇게 보고한다.

CLAUDE.md 의 T1 경고("`POST /runs/:id/input` 기반 설계 금지")는 *durable 질문 mailbox* 를 이 위에 세우지 말라는 뜻이다. 사람이 직접 치는 일회성 입력은 그 범위가 아니다.

### 1.2 A3 를 이 슬라이스보다 뒤로 미루는 근거

큐 #13 의 나머지 축인 **A3(프롬프트 외부화·버전관리)** 는 **대상이 0개**다. 실측: 로컬 dev DB `operator_schedules` 0행(한쪽은 테이블 자체 없음), 운영 Pi 는 측정 시점 `46945e7`(#450) 로 **migration 067 이전**. 인스턴스가 0인 엔티티에 버전관리를 붙이는 일이고, #12 를 보류시킨 휴면 패턴(#522)의 반복이다. **스케줄이 실제로 돌기 시작한 뒤 재평가한다.** CLI 는 반대로 대상(run/task)이 이미 존재한다.

## 2. 범위

**포함**: `spawn` / `follow` / `input` / `cancel` 4개 서브커맨드.

**제외**: Orca 터미널 UI 복제(패널·키바인딩·멀티뷰) / 태스크·프로젝트·에이전트 CRUD / 스케줄 조작 / 대화형 REPL / **`config` 서브커맨드**(초안에 있었으나 "넷뿐"과 모순이고 토큰 표시 위험만 만든다 — 삭제).

## 3. `follow` 의 전송 — 이 설계의 핵심 결정

## 3.0 착수 전 실측 정정 — substrate 는 경로마다 다르다 (슬라이스 2 개정 rev2, 2026-08-18)

§3.1 은 "서버가 offset 을 소유한다"고만 적고 **어떤 저장 substrate 가 그 offset 을 지탱하는지**를
적지 않았다. 실측 결과 경로마다 다르고, 일부는 **오프셋을 원리적으로 지탱하지 못한다.**

| 경로 | 출력 소스 | 안정적 바이트 오프셋 |
|---|---|---|
| **원격 워커** | `<exposed_root>/.palantir-runs/<runId>/stdout.log` — append-only 파일 (`remoteSshExecutor.js:1637`) | ✅ |
| 로컬 goal run | `runtime/goal-output/<runId>.log` tee (`lifecycleService.js:2042`) | ✅ 단 `goal_enabled` 게이트 |
| **로컬 일반 run** | SubprocessEngine 인메모리 **500줄 ring** / TmuxEngine `capture-pane` **스크린 버퍼** | ❌ **불가** |

`capture-pane` 은 append-only 스트림이 아니라 화면 버퍼라 ANSI clear·커서 이동이 이미 쓴 영역을 덮어쓴다 —
"이미 쓴 바이트를 다시 쓰지 않는다"(§9 테스트 4)를 만족시킬 offset 이 **존재하지 않는다**.
프로세스 레코드는 종료 10분 뒤 삭제되고(`PROCESS_TTL_MS`), terminal 시 `final_output` run event 로
**마지막 2000자만** 남는다.

### 3.0.1 결정: **v1 은 원격 run 전용** (사용자 결정, 2026-08-18)

원격은 이미 파일이라 substrate 신규 작업이 0 이고 실사용처(Pi fleet 무인 run 관찰)를 덮는다.
**전역 tee**(로컬까지 파일화)는 모든 워커 stdout 을 디스크에 영속시켜 크레덴셜 잔존 범위를 넓히고
보존창·용량 정책을 새로 요구하므로 **v1 범위 밖**이다.

### 3.0.2 **서버는 파싱하지 않는다 — 원시 바이트만 준다** (rev2 의 핵심 정정)

rev1 은 서버가 줄 경계로 자르고 NDJSON 을 텍스트 델타로 변환하게 했다. **틀렸다.** codex 지적대로
그 변환은 **상태 의존**이라 무상태 요청으로 재현할 수 없다 — `claudeStreamJson.js:48` 의
`if (resultText && !text.includes(resultText))` 는 **이전 assistant 텍스트 전체**를 봐야 결정되고,
비-JSON 줄은 `:16` 에서 **버려진다**(원문 보존 안 됨). 델타마다 부르면 스냅샷 뷰와 어긋난다.

**정정**: 상태는 **연속성이 있는 쪽**에 둔다.

- **서버**: `stdout.log` 의 `[after, after+max_bytes)` **원시 바이트**를 그대로 반환. 파싱 0, 줄 로직 0,
  UTF-8 경계 로직 0. `next_offset` = 실제 반환한 마지막 바이트의 다음.
- **CLI**: 장수 프로세스라 상태를 자연히 갖는다. `StringDecoder` 가 **멀티바이트 carry 를 기본 제공**하고,
  줄 재조립도 클라이언트 버퍼로 한다.

이 한 번의 이동으로 rev1 이 열었던 구멍이 함께 닫힌다:
- **UTF-8 분할** — `StringDecoder` 가 처리. 서버 경계 규칙 불필요.
- **`line_split` 예외** — 서버가 줄 경계를 약속하지 않으므로 예외 자체가 없다(rev1 은 이 예외가
  다시 부분 NDJSON 레코드를 만들어 자기모순이었다).
- **부분 레코드 재조립** — CLI 버퍼가 담당. 서버에 carry 토큰이 필요 없다.

**렌더링**: 응답에 `format` 을 싣는다 — detached Claude run 은 `'claude_ndjson'`, 그 외 `'text'`.
CLI 는 `claude_ndjson` 이면 완결된 줄을 파싱해 사람이 읽을 텍스트로 렌더하고, 불완전한 꼬리는 버퍼에 남긴다.
인식 불가한 줄은 **원문 그대로 통과**시킨다 — 스냅샷 파서가 버리는 줄까지 CLI 는 보여주므로
`after` 뷰가 스냅샷 뷰보다 **정보를 덜 주지 않는다**.

> `result.jsonl` 은 `after` 경로에서 읽지 않는다. 코드상 그것은 별개 원천이 아니라 워커 종료 후
> `awk` 가 `stdout.log` 에서 마지막 `type:"result"` 줄을 골라 복사한 **파생물**이다
> (`remoteSshExecutor.js:1954`). 원본이 이미 스트림 안에 있다.

### 3.0.3 capability — 로컬/미지원 run 의 응답

`after` 지정 + 증분 소스 없음 → **HTTP 409** + `{ error, reason: 'incremental_unsupported' }`.
**404 아님**(run 은 존재) **501 아님**(서버 기능이 아니라 이 run 의 substrate 문제).
CLI 는 이 `reason` 으로 "원격 run 만 follow 가능"을 stderr 에 적고 **코드 4**. 조용한 degrade 0.
`reason` 이 판별자인 것은 `/api/fs` 403 선례(`apiFetch({ allowAppForbidden })`)와 같은 규율이다.

**읽기·stat·전송 실패도 조용히 legacy 응답으로 fallback 하지 않는다** — 실패는 실패로 보고한다.

### 3.0.4 봉인(`finalized`) = **durable producer seal**, 두 번의 stat 이 아니다

rev1 은 "크기 → status → 크기" 로 봉인을 판정했다. **불충분하다** — 두 stat 사이가 조용해도 그 뒤
append 가 올 수 있고, stdout FD 를 상속한 background descendant 가 있으면 특히 그렇다.

**정정**: 원격 워커 스크립트는 이미 **durable seal 을 쓴다**:
```sh
; agent_exit_code=$?<captureStructuredResult>; echo "$agent_exit_code" > <statusDir>/exit.code
```
(`remoteSshExecutor.js:1962`, `:1640`. 주석 `:1806` — "The pane writes exit.code only after the worker
and its result capture")

`exit.code` 는 **워커와 result 캡처가 모두 끝난 뒤에만** 존재한다. 따라서
**`finalized` = `exit.code` 존재 ∧ 그 시점 파일 크기까지 전부 반환됨**. DB status 가 아니라
**producer 가 남긴 증거**를 기준으로 한다.

> `exit.code` 가 끝내 안 생기는 경우(노드 리부트 등)는 §3.2 의 drain deadline 이 덮는다 — 코드 5.

### 3.0.5 로그 세대 식별 — `ctime` 금지

rev1 의 `st_dev:st_ino:st_ctime` 은 **틀렸다**. `ctime` 은 **append 마다 갱신**되므로 정상 출력이
전부 "세대 변경"으로 오인된다.

**정정**: `source_id` = `st_dev:st_ino` 만. run id 는 재사용되지 않고 `statusDir` 는 spawn 시 1회 생성·
`cleanupRun` 이 1회 삭제하므로(`:2181`), 한 run 안에서 세대는 사실상 바뀌지 않는다. 바뀌었거나
사라졌으면 §3.0.6.

### 3.0.6 보존 만료 — `cleanupRun` 과의 경합

`cleanupRun` 이 `statusDir` 를 통째 지운다. `follow` 중이면 출력이 부분이 아니라 **전부** 사라진다 —
§3.1 의 `truncated`("앞부분을 버림")로는 못 덮는다.

- `after` 지정인데 `stdout.log` **부재** → **HTTP 410 Gone** + `{ reason: 'output_expired' }`.
  단 run 이 아직 running 이면 410 이 아니라 **빈 델타**로 답한다(spawn 직후 경합).
- `source_id` 변경 → `truncated: true` 와 동일 취급(경고 + 현재 tail 재개 + **sticky 코드 5**).
- CLI 는 410 → 경고 + **코드 5**. 단 **봉인을 이미 받은 뒤의 410 은 무시**한다(관측이 이미 완결).

### 3.0.7 왕복 비용 — 한 SSH 스크립트로 묶는다

폴링마다 stat·sentinel·read 를 따로 하면 왕복이 3배가 된다. **한 스크립트에서 순서대로 수행**하고
프레이밍된 한 응답으로 받는다: `stat` → `exit.code` 존재 → `dd`/`tail -c` 로 바이트 구간 → 다시 `stat`.
**마지막 stat 은 읽는 도중 파일이 지워지거나 바뀐 경합을 검출**한다(generation-before/after 비교).

### 3.0.8 §9 수락 기준 추가

- **14. 로컬 capability**: 로컬 run 에 `after` → 409 `incremental_unsupported`, CLI 코드 4. 조용한 legacy 응답 0.
- **15. 서버 무파싱**: 서버 응답이 `stdout.log` 의 바이트 구간과 **정확히 일치**한다(파싱·줄 조작 0).
  멀티바이트 문자가 응답 경계에 걸쳐도 CLI 출력이 깨지지 않는다(`StringDecoder` carry).
- **16. NDJSON 렌더는 CLI 쪽**: 응답 경계가 레코드 중간이어도 CLI 가 버퍼로 재조립한다.
  인식 불가한 줄은 원문 그대로 나온다(스냅샷 파서보다 정보를 덜 주지 않는다).
- **17. 봉인 = sentinel**: `exit.code` 부재면 크기가 안정돼도 `finalized:false`. 생기면 그 시점 크기까지
  전달 후 `finalized:true`. **sentinel 판정을 DB status 로 되돌리면 실패**하는 역회귀가 있어야 한다.
- **18. 세대/만료**: `st_dev:st_ino` 변경 → sticky 5. terminal run 의 `stdout.log` 부재 → 410 → 코드 5.
  **`ctime` 을 식별자에 넣으면 정상 append 가 세대 변경으로 오인**되는 재현 테스트가 실패한다.
- **19. 왕복**: 폴링 1회당 SSH 왕복이 1회다.
### 3.0.9 rev4 — 전송·봉인·재시작 (codex R2/R3 반영)

#### (a) 전송 프레이밍 — 원시 바이트 보존

`remoteSshExecutor.js:731` 이 `Buffer.concat(...).toString('utf8')` 로 **문자열 디코드**한다.
바이트 구간을 그대로 나를 수 없다(잘못된 UTF-8 → replacement 문자, 코드포인트 중간 절단 → 손상).

**결정**: 원격 스크립트가 **base64 로 인코딩**해 내보내고 서버가 디코드한다. base64 는 ASCII 라
기존 문자열 경로가 무손실이다.

- 원격 요구사항에 **`base64` 추가**(헤더 주석 `:644` 갱신). coreutils·busybox 모두 제공.
- **서버는 요청된 바이트 구간을 정확히 복원하되, 응답에는 §3.0.10 결정 3 대로 `data_base64` 로 싣는다**
  (디코드는 CLI). 줄·UTF-8 경계를 **정렬하지 않는다** —
  §3.0.2 의 "서버 무파싱"이 유지된다. base64 는 **전송 프레이밍 해제**이지 내용 파싱이 아니다.
  (rev3 의 "서버가 경계를 정렬한다"는 문장은 §3.0.2 와 정면 충돌하는 오류였다. 철회.)
- 명세할 것: 개행 없는 단일 base64 프레임 / decode 실패 시 응답 처리 / 프레임 길이 상한.

#### (b) 봉인 = 셸·result 캡처 완료. **그 이상을 주장하지 않는다**

반례(codex): 워커가 `cmd &` descendant 를 남기고 그것이 **상속된 stdout** 을 계속 쓰면,
foreground 종료 → result 캡처 → `exit.code` 기록 **이후에도** `stdout.log` 가 자란다.

**결정**: `finalized` 는 **"셸과 result 캡처가 끝났다"**로 좁힌다. `follow` 는 **봉인에서 종료한다.**

- **rev3 의 "봉인 후 append 를 다음 폴링에서 회수한다"는 철회한다.** 종료하면서 계속 관측하겠다는
  것은 구현 불가한 자기모순이었다(수락 기준 20 삭제).
- 대신 **한계를 문서화**한다: 봉인 이후 detached descendant 가 쓴 출력은 **관측되지 않는다.**
  이건 `follow` 만의 문제가 아니라 **워커 owner-exit 트랙의 미해결 항목**이며(#483, S2b·S3 보류),
  거기서 프로세스 그룹 종료·FD 격리가 해결되면 이 계약이 자동으로 강해진다.
- **정직성 정정**: rev3 의 "harvest·final_output 이 **전부** 같은 표식을 쓴다"는 **과장이었다.**
  코드상 `detectExitCode` 가 `exit.code` 를 읽고 원격 terminal 판정이 그 위에 서지만,
  `final_output` 은 `getOutput`/`result.jsonl` 을 **best-effort** 로 읽는다. 정확히는
  **"원격 terminal 판정이 이 sentinel 위에 선다"** 이고, `follow` 는 그 판정을 따를 뿐이다.

#### (c) CLI 재시작 — durable checkpoint

CLI 가 미완성 줄/UTF-8 조각을 버퍼에 든 채 죽으면 서버 offset 만으로 복원할 수 없다.

**결정**: CLI 가 **`committed_offset` 을 durable 하게 기록**한다.
- `fetched_offset`(메모리) 와 `committed_offset`(디스크) 를 구분한다.
- `committed_offset` = **stdout 에 써서 flush 된** 마지막 **줄 경계**의 위치.
- 재개는 항상 `committed_offset` 에서. 최악의 경우 마지막 부분 줄을 다시 받는다.
- **EOF 꼬리 규칙**: 개행으로 끝나지 않는 마지막 조각은 **`finalized` 를 받은 뒤에만** commit 한다.
  그 전에는 미완성으로 보고 commit 하지 않는다.
- **`follow` 는 at-least-once 다** — exactly-once 가 아니다. stdout write 와 checkpoint 는
  원자적일 수 없으므로 **write 후 checkpoint 전 crash 는 중복을 낸다.**
  rev3 의 "중복은 항상 깨끗한 줄 경계에서만" 은 **과한 주장이라 철회**한다 —
  부분 write 가 가능하므로 **줄 중간 중복도 가능**하다고 계약에 명시한다.
- checkpoint 파일 위치·형식·손상 시 처리(=`after=0` 재시작 + `truncated` 취급)를 명세한다.

#### §9 수락 기준 (rev4 확정)

- **20. (삭제)** — 봉인 후 append 관측은 계약에서 뺀다. 대신 **한계가 문서에 적혀 있는지**만 확인한다.
- **21. 재시작 유실 0**: 부분 줄 보유 상태에서 CLI 를 죽였다 재시작하면 그 줄이 온전히 나온다.
- **22. at-least-once 명시**: 재시작이 중복을 낼 수 있고 **줄 중간일 수도 있음**을 계약이 명시한다.
- **23. EOF 꼬리**: 개행 없는 마지막 조각은 `finalized` 이후에만 commit 된다.
- **24. base64 무손실**: 임의 바이트(무효 UTF-8 포함)가 손상 없이 왕복한다. decode 실패는 조용히
  넘어가지 않는다.
### 3.0.10 rev5 — 확정 결정 (codex R4 처방 반영)

R4 가 남긴 7개 결정 항목과 2개 모순을 전부 확정한다. **아래가 §3.0.4/§3.0.7 을 덮어쓴다.**

#### 모순 해소 1 — `exit.code` 의 의미 통일

§3.0.4 의 **"durable producer seal"** 표현을 **철회**한다. 전 문서에서 `exit.code` 는
**"셸·result 캡처 완료 표식(completion marker)"** 이다. descendant 가 상속 stdout 에 계속 쓸 수
있으므로 "모든 producer 가 닫혔다"를 뜻하지 않는다(§3.0.9(b), 한계는 #483 트랙).

#### 모순 해소 2 — 봉인 폴링의 cut-off 확정

한 응답 안에서 **첫 `stat` 의 크기를 이번 응답의 고정 `end_offset`** 으로 삼는다.

- `exit.code` 가 존재하고 **그 `end_offset` 까지 전부 반환했을 때** `finalized: true`.
- **마지막 `stat` 은 삭제·inode 변경 검출에만** 쓴다(크기 판정에 쓰지 않는다).
- 이러면 "그 시점 파일 크기"가 어느 stat 인지 모호하지 않다.

#### 결정 3 — wire format

응답은 **JSON 유지**, 바이트는 **`data_base64`** 필드로 싣는다. CLI 가 디코드한다.
octet-stream + 헤더 메타데이터는 채택하지 않는다(기존 `apiFetch`/JSON 오류 규율과 어긋난다).

#### 결정 4 — base64 프레임 계약

- **개행 없는 단일 프레임**. 공백·줄바꿈 불허.
- 최대 원시 바이트 = `max_bytes`(256KB). 인코딩 길이 상한은 그 4/3 + padding.
- **빈 델타는 `data_base64: ""`** (필드 생략 아님).
- 비정상 문자·padding·길이 오류 → 서버는 **500** + `reason: 'output_frame_invalid'`,
  CLI 는 **코드 5**(재시도 예산 안에서 재시도하되 반복되면 5). 조용히 넘어가지 않는다.

#### 결정 5 — checkpoint 파일

- 경로: `~/.palantir/follow/<runId>.json` (mode 0600)
- 형식: `{ v: 1, run_id, source_id, format, committed_offset }`
- **원자적 교체**: temp 파일 write → `fsync` → `rename`.
- **복수 `follow` 프로세스**: 같은 runId 를 동시에 따라가는 것은 **지원하지 않는다**.
  마지막 writer 가 이긴다(잠금 없음). 이 사실을 `--help` 에 적는다.

#### 결정 6 — checkpoint 손상 / `source_id` 불일치

- 손상(파싱 실패·`v` 불일치) 또는 `source_id` 불일치 → **경고 + `after=0` 재개 + `truncated` 취급**
  (= **sticky 코드 5**). 관측이 완결이 아님을 숨기지 않는다.
- 재개 후 checkpoint 는 **첫 commit 시점에 재작성**한다(재개 직후가 아니라).

#### 결정 7 — `finalized` 시 EOF 꼬리 처리

봉인 응답까지 소비한 뒤, CLI 버퍼에 남은 개행 없는 꼬리를:
- **`format: 'text'`** → 그대로 stdout 에 쓰고 commit.
- **`format: 'claude_ndjson'`** → 완결된 JSON 이면 파싱해 렌더, **잘린 JSON 이면 원문 그대로** 출력하고
  **stderr 에 한 줄 경고**(불완전 레코드). 어느 쪽이든 **버리지 않는다.**
- 순서: **렌더 → stdout flush → commit**. 그 뒤 종료 코드 판정.

#### §9 수락 기준 (rev5 확정 추가)

- **25. cut-off**: 봉인 폴링에서 첫 stat 크기까지만 반환하고 그때 `finalized:true`.
  마지막 stat 을 크기 판정에 쓰도록 바꾸면 실패하는 역회귀가 있어야 한다.
- **26. 프레임 오류**: 손상된 base64 → 500 `output_frame_invalid` → CLI 코드 5. 조용한 통과 0.
- **27. checkpoint 손상**: 손상 파일 → `after=0` 재개 + sticky 5.
- **28. EOF 꼬리**: 잘린 JSON 이 원문으로 출력되고 경고가 뜬다(유실 0).

### 3.0.11 미해결 — 구현 착수 전 확정 필요 (codex R5)

방향(원격 전용 / 서버 무파싱 / CLI 상태 / base64 프레이밍 / `exit.code` 완료표식 / `committed_offset`
재개)은 **적대검토 5라운드로 굳었다.** 아래는 남은 **세부 결정**이며, 이게 닫히기 전에는 구현을
시작하지 않는다 — 서로 다른 구현이 모두 "명세 준수"를 주장할 수 있는 상태이기 때문이다.

1. **원격 프레임 검증 위치** — 서버가 원격 base64 를 엄격 검증한 뒤 **같은 문자열을** `data_base64` 로
   전달하는가, **디코드 후 재인코딩**하는가. `output_frame_invalid` 검출 지점과 canonical padding
   검증이 여기에 달렸다.
2. **마지막 stat 이 삭제·inode 변경을 발견했을 때** 이미 읽은 `data_base64` 를 폐기하는가,
   `truncated` 와 함께 전달하는가. 새 inode 의 어느 offset 에서 재개하는가.
3. **checkpoint 의 `format` 이 현재 응답 `format` 과 불일치**할 때. `source_id` 가 같아도
   렌더러 상태와 commit 경계의 의미가 달라진다.
4. **stdout flush 완료 기준** — write 반환 / drain / callback 중 무엇을 commit 의 선행조건으로 삼는가.
5. **checkpoint durability 범위** — temp 파일 mode 0600 적용 시점, rename 이후 **부모 디렉터리 fsync**
   여부. 전원 장애까지 보장할 것인가(파일 fsync+rename 만으로는 부족).
6. **`stdout.log` 가 아직 없는 running 응답의 `source_id` 표현**과, 기존 checkpoint 의 `source_id` 를
   언제 검증하는가.

> **왜 여기서 멈추는가**: 이 트랙에서 "전제를 확인하지 않고 착수"가 반복해서 비쌌다.
> A2 는 착수 직전에 `verify_checks` 라우터 전체가 goal 게이트 뒤라는 것을 발견해 설계를 바꿨고,
> #12 는 계약 문서의 벤더 결합을 코드 줄 수로 오판해 보류로 끝났다. 이 슬라이스도 §3.1 이
> substrate 를 적지 않아 **로컬 일반 run 에서 구현 불가**라는 것을 착수 전에 발견했다.

---

> **아래 §3.1~ 는 개정 전 원문이다.** 위 §3.0 계열이 우선한다.


초안은 `/output` 폴링만으로 충분하다고 가정했다. **틀렸다.** 확인된 제약:

1. `/output` 에 **run status 가 없다** → 종료 판정 불가(codex BLOCKER-1).
2. `/output` 은 **최대 2000줄 tail** 이다 → 긴 run 은 앞부분을 영영 못 본다. 증분 커서가 아니다.
3. 매 폴링마다 누적 tail 을 통째로 다시 받으면 대역폭이 **출력 길이에 제곱 비례**한다(codex SERIOUS).

### 3.1 결정: `/output` 에 **증분 커서를 추가**한다 (서버 변경 최소)

초안의 "서버 코드 변경 0" 제약은 **내가 스스로 건 것**이고, 위 사실 위에서는 올바른 `follow` 를 만들 수 없음이 증명됐다. 제약을 푼다. 사용자 spec("넷만, Orca UI 복제 금지")은 서버 파라미터 추가를 금지하지 않는다.

- `GET /runs/:id/output?after=<offset>` — **추가 파라미터**. **응답 형태는 `after` 유무로 분기한다**(초안은 "확장"과 "byte-identical"을 동시에 주장해 모순이었다):
  - `after` **미지정** → 기존 `{ output }` **그대로**. 키 추가도 없다. 웹 UI 경로 byte-identical.
  - `after` **지정** → `{ output, next_offset, truncated, has_more, finalized, run_status }`. `finalized: true` 이면 `run_status` 는 **그 봉인 시점의 terminal status**(`completed`/`failed`/`cancelled`/`stopped`)다.
- **`next_offset` 은 안정적인 절대 바이트 좌표**이고, 정상 응답에서 **단조 증가**한다. `has_more: true` 면 **반드시 진전**해야 한다(codex R12). CLI 는 이를 방어한다 — `has_more:true` 인데 `next_offset` 이 그대로면 즉시 재요청하는 hot loop 가 되므로, **진전 없는 응답을 받으면 계약 위반으로 보고 코드 5** 로 끝낸다(무한 루프 0).
- **응답 크기 상한**: 서버가 한 응답에 `max_bytes`(고정, 예 256KB)까지만 싣고 더 있으면 `has_more: true`. `after=0` 재접속이 전체 로그를 한 JSON 으로 만들어 서버·CLI 메모리를 출력 크기에 비례시키는 것을 막는다. `next_offset` 은 **"실제로 반환한 마지막 바이트의 다음"** 으로 정의한다(요청한 범위의 끝이 아니다). CLI 는 `has_more` 면 대기 없이 즉시 다음 페이지를 당긴다.
- `offset` 단위는 **바이트**로 고정하고 서버가 UTF-8 경계에서 자른다. 문자 수·코드유닛은 쓰지 않는다(멀티바이트 손상, codex SERIOUS).
- 서버가 보존 한도로 앞부분을 버려 `after` 가 더 이상 유효하지 않으면 **`truncated: true`** 로 알린다. CLI 는 그 사실을 stderr 에 한 줄 경고하고 현재 tail 부터 재개한다 — 조용히 건너뛰지 않는다.
- **`truncated` 는 sticky 하다**(codex R5 SERIOUS). 한 번이라도 받으면 그 run 의 관측은 **완결이 아님이 확정**됐으므로, 이후 `finalized` 를 정상 수신해도 **코드 5** 로 끝난다. "완결 관측이 아니면 5" 정책과 일관되게 유지하기 위해서다. terminal 이 `failed`/`cancelled`/`stopped` 여도 **truncation 의 5 가 6 보다 우선**한다 — 관측을 신뢰할 수 없다는 사실이 run 결과보다 먼저 알려져야 한다.

**"출력이 항상 이전 응답의 prefix"라는 가정을 하지 않는다**(codex SERIOUS). 서버가 offset 을 소유하고, 클라는 길이 비교로 증분을 추측하지 않는다.

### 3.2 종료 판정

`follow` 는 매 tick 에 **`GET /runs/:id` (status) 와 `/output?after=` 를 함께** 읽는다.

**종료는 서버의 봉인 신호로만 판정한다** — `finalized: true` 이고 `has_more: false` 일 때 그 지점까지 소비한 뒤 종료한다.

> **종료 판정에 필요한 세 값(`finalized`·`has_more`·`run_status`)이 전부 `/output` **한 응답**에 있다 — 같은 스냅샷이다.** `finalized` 를 status 응답에 두면 "output 은 flush 전 `has_more:false`, status 는 그 뒤 `finalized:true`" 를 서로 다른 시점에서 읽어 결합하는 교차 경쟁이 생긴다(codex R7). 그래서 `finalized` 는 **status 가 아니라 output 응답의 필드**이고, 서버는 이 응답 하나를 만들 때 봉인 여부와 잔여 여부를 **원자적으로** 결정한다. **`run_status` 도 같은 응답에 싣는 이유**(codex R8): status 와 output 은 서로 다른 요청이라 교차 스냅샷이다. status 가 `running` 을 반환한 직후 run 이 `failed` 로 전이하고 output 이 `finalized:true` 를 반환하면, 종료 코드 0/6 을 판정할 terminal status 가 없다. 봉인 응답이 결과까지 함께 실으면 **재조회도, 그 재조회의 timeout·예산·실패 처리도 필요 없다.**

따라서 status 폴링은 **drain deadline 시작 판단(진행 중 요청 abort)** 에만 쓰고, **종료도 종료 코드도 결정하지 않는다.**

**봉인이 모든 것에 우선한다** (codex R9): `finalized:true, has_more:false` 를 받은 tick 에서는
- 진행 중인 status 요청을 **즉시 취소·무시**한다(`Promise.all` 로 그 timeout 까지 기다리지 않는다),
- 그때까지의 **status 실패·예산 소진은 종료 사유가 아니다** — 봉인된 `run_status` 로 0/6 을 낸다.

즉 **status 실패는 독립적인 종료 사유가 아니다.** 관측의 완결성은 output 이 혼자 책임진다.

> **정지는 종결이 아니다 (codex R4 BLOCKER).** 초안은 "`next_offset` 이 더 이상 자라지 않으면 끝"으로 판정했는데, 서버는 terminal 기록 이후에도 flush 를 허용하므로 `offset=100/has_more:false` 를 두 번 관측한 직후 늦은 flush 로 120 이 될 수 있다. 5초간 조용했다는 사실은 완결성의 증거가 아니다. 따라서 **`finalized` 는 서버가 준다**: run 이 terminal 이고 **출력 소스가 닫혀 더 붙을 것이 없을 때** true. 클라가 관측으로 추측하지 않는다.

**drain deadline 은 어느 쪽이든 terminal 을 처음 관측한 순간 시작한다** (codex R11). `run_status` 는 output 응답에도 있으므로, status 폴링이 4xx 로 중단됐더라도 output 이 `run_status:'completed', finalized:false` 를 주면 **그 순간 deadline 이 시작**된다. 그렇지 않으면 봉인되지 않는 서버에서 output 은 계속 성공하고 예산도 소진되지 않아 무기한 대기한다. **status 는 deadline 을 더 일찍 시작시키는 최적화일 뿐, 필수가 아니다.**

**deadline 은 첫 `finalized:true` 를 받는 순간 해제된다** (codex R12). 그 뒤 남은 봉인 페이지(`has_more:true`)는 **일반 output 재시도 예산**으로 마저 당긴다. 해제하지 않으면 이미 봉인된 대용량 로그가 5s 안에 전송·기록을 못 끝내 코드 5 가 되고, 재실행해도 `after=0` 부터 같은 일이 반복돼 **영원히 완주하지 못한다**. deadline 의 목적은 "봉인이 오지 않는 서버"를 끊는 것이지 전송량을 제한하는 게 아니다.

**deadline 이 살아 있는 동안은 절대 시한** 이다(기본 5s, 위 최초 terminal 관측 시점부터). 그 안의 **모든 대기가 이 deadline 에 종속**된다 — 각 요청 timeout 은 `min(10s, 남은 drain 시간)`, 백오프 대기와 stdout 완료 대기도 남은 시간으로 잘린다. 그렇지 않으면 멈춘 요청 하나가 10s 요청 timeout 까지 붙잡아 5s 상한을 지킬 수 없다(codex R3 SERIOUS).

**deadline 안에 `finalized` 를 못 받으면 "유실 0"을 주장하지 않는다**(codex R2 BLOCKER + R4 BLOCKER). 봉인 신호 없이 조용하기만 한 run 에 코드 0/6 을 주지 않는다. 서버는 terminal 기록이 출력 flush 이후임을 보장하지 않으므로, 상한 만료는 **불완전 drain** 이다: stderr 에 경고하고 **종료 코드 5** 를 반환한다. run 이 `completed` 였더라도 0 을 주지 않는다 — "관측이 완결됐다"를 거짓으로 말하지 않기 위해서다.

**terminal 을 처음 관측하면 status 폴링을 영구히 멈춘다** (codex R13). status 의 역할은 deadline 을 일찍 시작시키는 것뿐이고 그건 끝났다 — 그 뒤로는 종료도 종료 코드도 output 이 혼자 결정한다(§3.2). 진행 중인 status 요청은 **즉시 취소·무시**한다. 이게 없으면 output 이 먼저 `run_status:completed, finalized:false` 를 알린 tick 에서 멈춰 있는 status 가 single-flight tick 을 5s 내내 붙잡아, 서버가 곧 봉인할 수 있는데도 CLI 가 재조회 기회를 잃고 코드 5 가 된다.

**terminal 관측 시 진행 중인 output sibling 은 drain deadline 에 묶는다**(codex R6 SERIOUS). 같은 tick 에서 status/output 을 함께 띄우면 output 은 drain 전이라 10s timeout 을 갖는데, status 가 즉시 terminal 을 반환해 5s deadline 이 시작돼도 그 요청의 timeout 은 저절로 줄지 않는다. 따라서 terminal 관측 시 in-flight 요청에 **deadline 기반 abort 를 즉시 연결**한다(남은 시간이 0이면 취소하고 그 결과를 미완으로 취급).

**tick 은 single-flight** 다(겹치지 않는다). status 조회 실패는 output 처리와 독립이며, **stdout 쓰기에 성공한 뒤에만 로컬 offset 을 전진**시킨다 — 그래야 중복도 유실도 구현에 좌우되지 않는다.

## 4. 출력 채널 계약 (codex BLOCKER-3/4)

**stdout = 워커 출력만. CLI 메타데이터는 전부 stderr.**

- `follow` 의 워커 출력은 stdout 에 **가공 없이** 쓴다. 최종 status·경고·진단은 stderr.
- 따라서 `palantir follow r_x > out.log` 는 워커 출력만 담는다. 파이프 소비자가 CLI 문구와 데이터를 구분 못 하는 문제가 사라진다.
- **`--json` 은 NDJSON** 이다(한 줄 JSON 아님 — 스트리밍과 양립 불가). 한 줄에 하나씩 `{"type":"output","data":"…"}` / `{"type":"status","status":"completed"}` / `{"type":"error",…}`. 단발 명령(`spawn`/`input`/`cancel`)은 결과 객체 1줄.
- `--json` 이면 **모든 것이 stdout NDJSON** 으로 간다(기계 소비 모드에서는 채널 분리가 오히려 방해).

## 5. 배치·인증

- 진입점 `bin/palantir.mjs`, `package.json` 의 `bin: { palantir: "bin/palantir.mjs" }`. **런타임 의존 0**(Node 내장만). `engines.node ^22` 를 그대로 상속한다.
- 대상 서버 `PALANTIR_BASE_URL`(기본 `http://127.0.0.1:4177`). **URL 조합 규칙 고정**: base 는 origin 만 받고 CLI 가 `/api/...` 를 붙인다. base 에 경로가 있으면 사용법 오류(코드 1)로 거절한다 — 초안의 `/api` 표기 불일치(codex MODERATE) 제거.
- 인증 `PALANTIR_TOKEN` → `Authorization: Bearer`. **토큰을 argv 로 받지 않는다**(ps 노출·셸 히스토리). env 만. 어떤 출력·에러에도 토큰을 찍지 않는다.

## 6. 서브커맨드

| 명령 | 동작 |
|---|---|
| `palantir spawn <task_id> [--agent <profile_id>] [--follow]` | `POST /api/tasks/:id/execute` |
| `palantir follow <run_id>` | §3 |
| `palantir input <run_id> <text...>` | `POST /api/runs/:id/input` |
| `palantir cancel <run_id>` | `POST /api/runs/:id/cancel` |

`--since` 는 삭제한다(초안의 단위 미정의, codex SERIOUS). 재개는 §3.1 의 서버 offset 이 담당한다.

**`spawn --follow` 복합 계약**: run id 를 **stderr 에 먼저** 한 줄(`--json` 이면 stdout NDJSON `{"type":"spawned","run_id":…}`), 그 다음 follow 로 진입. spawn 은 성공했는데 follow 가 전송 실패하면 **run 은 이미 떠 있다** — 그 사실을 stderr 에 명시하고 종료 코드는 follow 의 것(5)을 쓴다. 사용자가 run id 를 알므로 재개 가능하다.

## 7. 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 성공. `follow` 는 run 이 `completed` 로 끝남 |
| 1 | 사용법 오류 |
| 2 | **인증 실패 (401)** |
| 3 | 대상 없음 (404) |
| 4 | 서버 거절 (그 외 4xx). **권한 부족 403 포함** — 401 과 분리(codex MODERATE: 토큰 갱신 vs 권한 요청은 다른 조치) |
| 5 | 서버·전송 오류(5xx·접속 불가) **또는 출력 완결성 미확인·유실**(truncation, 불완전 drain) |
| 6 | `follow` 대상 run 이 `failed`/`cancelled`/`stopped` 로 끝남 |
| 130 | `SIGINT`. **run 을 취소하지 않는다** — follow 를 그만둘 뿐 |

**§7 의 HTTP→코드 매핑은 ①단발 명령(`spawn`/`input`/`cancel`)과 ②`follow` 의 **output** 요청에만 적용된다** (codex R10). `follow` 의 **status 요청 오류는 어떤 코드로도 매핑되지 않는다** — status 는 종료를 결정하지 않으므로(§3.2) output 을 선점할 수 없다. 재시도 불가한 status 4xx(401/403/404)를 받으면 **status 폴링을 중단**하고 drain deadline 판단을 포기한 채 output 만으로 계속한다(그 사실은 stderr 에 한 줄). 이렇게 하지 않으면 "status 가 401 을 먼저 반환하고 output 은 곧 봉인" 상황에서 결과가 미정이 된다.

**종료 코드 우선순위 (위가 이긴다)** — 여러 조건이 동시에 성립할 때 결과가 구현에 좌우되지 않게 고정한다(codex R6 MODERATE):

1. `SIGINT` → **130**
2. `EPIPE` → **0** — 소비자가 먼저 닫은 것은 우리 실패가 아니다. 이 시점 이후의 완결성은 애초에 관측 대상이 아니므로 sticky truncation 보다 앞선다.
3. 사용법 오류 → 1
4. 인증/대상/거절 → 2 / 3 / 4
5. **truncation 또는 불완전 drain 또는 전송·서버 오류 → 5**
6. run terminal 이 `failed`/`cancelled`/`stopped` → 6
7. 그 외 → 0

- `EPIPE`(`follow | head`)는 **정상 종료(0)**. 스택 트레이스나 미정의 코드가 §7 계약을 깨면 안 된다(codex SERIOUS).
- `input` 의 원격 502 는 코드 5 이되, `--json` 에서는 `{"type":"error","kind":"remote_input_unsupported"}` 로 **기계 판독 가능한 종류**를 준다(codex MODERATE). 사람 대상 stderr 문구는 원격 한계 해석을 덧붙이되, **502 전부를 원격 미지원으로 단정하지 않는다** — run 의 `node_id` 를 조회해 원격일 때만 그 해석을 붙인다.

## 8. 재시도 (초안 뒤집음)

초안은 "재시도 없음"이라고 했으나, `follow` 는 장시간 명령이라 1초 폴링 중 **일시적 연결 리셋 한 번으로 관측이 끝난다**(codex SERIOUS). 정정:

- 단발 명령(`spawn`/`input`/`cancel`) = **재시도 없음** 유지(멱등하지 않다).
- `follow` = 전송 오류·5xx 에 대해 **제한 재시도**(지수 백오프). 서버 offset 으로 재개하므로 중복·유실이 없다.
  - **요청마다 attempt timeout**(`AbortSignal.timeout`, 기본 10s). 이게 없으면 응답 없이 멈춘 `fetch` 는 전송 오류조차 내지 않아 무기한 대기한다(codex R2 SERIOUS).
  - 30s 예산은 **연속 장애 구간별**이고 누적 수명 예산이 아니다(몇 시간짜리 follow 가 산발적 실패만으로 죽으면 안 된다).
  - **예산은 엔드포인트별로 따로 센다**(status / output 각각). "tick 한 번 성공 시 초기화"는 모호했다 — status 만 계속 성공하고 output 이 계속 5xx 면 공용 예산이 영원히 초기화돼 `follow` 가 무기한 지속된다(codex R3 SERIOUS). 각 예산은 **그 엔드포인트가 성공했을 때만** 초기화한다.
  - **output 예산 초과 → 코드 5.** **status 예산 초과는 종료 사유가 아니다** — status 는 종료를 결정하지 않으므로(§3.2), 계속 실패하면 drain deadline 판단을 포기하고 **output 만으로 진행**한다. 이걸 5 로 만들면 §3.2 의 "봉인 우선"과 모순된다(codex R9 BLOCKER).

## 9. 테스트 (수락 기준)

1. 네 동사 happy path — mock 서버 대상, argv → 요청(메서드·경로·헤더) → 종료 코드.
2. **토큰이 argv·stdout·stderr 어디에도 나타나지 않음.**
3. 종료 코드 전수 — **단발 명령과 follow 의 output 요청에 한정**: 401→2, 403→4, 404→3, 400→4, 5xx→5, follow completed→0 / failed·cancelled·**stopped**→6, SIGINT→130, EPIPE→0.
3a. **status 오류는 매핑되지 않는다**: follow 중 status 가 401/403/404 를 반환해도 종료하지 않고, status 폴링만 중단한 뒤 output 으로 계속해 봉인에서 정상 종료한다.
4. `follow` 증분: 서버 offset 을 따라가며 **이미 쓴 바이트를 다시 쓰지 않는다**. `truncated: true` 면 경고 후 재개.
4a. **truncated sticky**: `truncated:true` → tail 소비 → 정상 `finalized:true + has_more:false` 를 받아도 경고 + **코드 5**.
4b. terminal 이 `failed`/`cancelled`/`stopped` 이면서 truncated 였으면 **5 가 6 보다 우선**.
4c. **우선순위 충돌 전수**: truncated + EPIPE → 0, truncated + SIGINT → 130, truncated + failed → 5.
5. `follow` 는 **`finalized:true` + `has_more:false`** 를 받은 뒤에야 **코드 0/6** 으로 종료한다. **deadline 안에 `finalized` 를 못 받으면 경고 + 코드 5**(불완전 drain).
5a. **정지≠종결 재현**: `has_more:false` 로 두 번 조용하다가 늦은 flush 가 오는 서버를 mock 해도, `finalized` 전에는 종료하지 않고 그 flush 를 stdout 에 쓴다.
5d. **교차 스냅샷 재현**: status 가 먼저 `terminal` 을 알려도 `/output` 이 아직 `finalized:false` 면 종료하지 않는다. 반대로 status 가 `running` 을 반환한 tick 에서 output 이 `finalized:true, run_status:'failed'` 를 주면 **그 응답만으로 코드 6** 으로 끝난다(재조회 없음).
5e. status 요청이 계속 실패해도 output 봉인이 오면 `follow` 는 정상 종료한다(종료가 status 에 의존하지 않는다).
5b. `has_more:true` 면 대기 없이 다음 페이지를 당기고, `next_offset` 은 실제 반환분 기준으로만 전진한다.
5f. **봉인 후 deadline 해제**: `finalized:true, has_more:true` 로 남은 페이지가 5s 를 넘겨도 끝까지 받아 **코드 0/6** 으로 끝난다(코드 5 아님).
5g. **무진행 방어**: `has_more:true` 인데 `next_offset` 이 그대로인 응답을 받으면 즉시 코드 5(hot loop 0).
5c. tick single-flight: 이전 tick 이 끝나기 전에 다음 tick 이 시작되지 않는다. stdout 쓰기 성공 후에만 offset 전진.
6. **stdout 에 워커 출력만** 있고 메타데이터는 stderr(파이프 오염 0).
7. `--json` NDJSON 이 줄 단위 파싱 가능하고 타입 태그가 계약대로.
8. `follow` 의 **output** 이 일시 5xx 를 백오프 재시도로 넘기고, 상한 초과 시 5. status 5xx 는 상한을 넘겨도 종료하지 않는다(12 참조).
9. `input` 502 + 원격 노드 → `remote_input_unsupported`, 502 + 로컬 노드 → 일반 서버 오류.
10. **서버 변경분 회귀 0**: `after` 미지정 시 `/output` 응답이 기존과 byte-identical — 키 추가조차 없다(웹 UI 경로 불변).
11. 요청이 응답 없이 멈추면 attempt timeout 이 끊고 재시도한다(무기한 대기 0).
12. status 만 성공하고 output 이 계속 실패하면 **output 예산이 소진되어 코드 5** 로 끝난다(무기한 지속 0). **역방향은 아니다** — status 만 계속 실패해도 output 봉인이 오면 정상 종료(5e).
12a. 봉인을 받은 tick 에 status 요청이 멈춰 있어도 **즉시 취소하고 종료**한다(그 timeout 까지 기다리지 않는다).
13. drain 중 멈춘 요청이 있어도 **5s 절대 deadline 안에 종료**한다(요청 timeout 이 deadline 을 넘겨 붙잡지 않는다).
13a. **terminal 직전 시작된 output 요청**(10s timeout)이 있어도 terminal 관측 시 deadline 에 묶여 5s 안에 종료한다.
13c. **output 이 먼저 terminal 을 알린 tick 에 status 가 멈춰 있으면**, status 를 즉시 취소하고 다음 output drain 으로 넘어간다(그 status 가 deadline 을 통째로 소비하지 않는다).
13b. **status 폴링이 4xx 로 중단된 뒤** output 이 `run_status` terminal + `finalized:false` 만 계속 주면, **그 첫 관측부터 5s** 뒤 불완전 drain 으로 코드 5(무기한 대기 0).

## 10. 미해결로 남기는 것

- 원격 노드 대화형 입력(`remoteSshExecutor.sendInput`) — P5 범위. CLI 는 502 를 정직하게 노출할 뿐 고치지 않는다. **따라서 4단계 parity 는 부분 충족으로 보고한다**(§1.1).
- A3(프롬프트 외부화·버전관리) — §1.2 근거로 스케줄 실사용 시 재평가.
- 스케줄 조작·태스크 생성·관측 대시보드 — 웹 UI 담당.
