# Runbook: Fleet 원격 실행 노드 배포

> Fleet = 컨트롤 플레인(항상 켜진 호스트) + 여러 원격 실행 `pod`(ssh). 3계층 Master(Top)→Operator→Worker 중
> **Operator + Worker 를 원격 pod 에서 실행**한다. spec: [`specs/fleet-remote-nodes-brief.md`](./specs/fleet-remote-nodes-brief.md),
> [`specs/p5-claude-persistent-remote-brief.md`](./specs/p5-claude-persistent-remote-brief.md).
>
> 이 문서는 **실제 배포 절차 + 실 Raspberry Pi 검증 결과**를 정리한다. 마지막 업데이트: 2026-07-03 (P4+P5 완료, F1 풀 루프 검증).

---

## 0. 한눈에

```
┌─────────────────────────── 컨트롤 플레인 (항상 켜짐: Pi / Mac / 서버) ──────────────────────────┐
│  Palantir Console (npm start)                                                                     │
│    - Top 매니저 = 여기 로컬 상주 (v1 = Claude Top; Codex Top 은 bypass sandbox 라 금지)             │
│    - SQLite DB / 이벤트 버스 / REST API (기본 :4177)                                               │
└───────────────┬───────────────────────────────────────────────────────────────────────────────┘
                │ ssh (key auth, agentless — pod 에 서비스 설치 불필요)
        ┌───────┴─────────┬─────────────────┐
   ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
   │  pod A  │       │  pod B  │  ...  │  pod N  │   각 pod: ssh + codex/claude CLI 설치 + 선로그인
   │ Operator│       │ Operator│       │ Worker  │   Operator(프로젝트당) + Worker(태스크당)
   │ + Worker│       │ + Worker│       │         │
   └─────────┘       └─────────┘       └─────────┘
```

**핵심 원리**: pod 에는 아무 서비스도 설치하지 않는다. 컨트롤 플레인이 ssh 로 `codex`/`claude` CLI 를
pod 에서 직접 spawn 한다. 원격 Operator 는 컨트롤 플레인 REST API 로 **되-curl** 하여 워커를 dispatch 한다.

---

## 1. 사전 준비

### 1.1 컨트롤 플레인 호스트
- Node **22** (better-sqlite3 ABI; brew node 26 이면 `PATH=/opt/homebrew/opt/node@22/bin:$PATH` 또는 `.nvmrc`).
- 항상 켜져 있고 pod 들과 같은 네트워크(예: **Tailscale**)에 있어야 한다.
- `codex` / `claude` CLI 설치 + 로그인 (Top 이 여기서 로컬 spawn 되므로).

### 1.2 각 pod
- ssh 접속 가능 (키 기반 인증 권장 — `~/.ssh/authorized_keys` 에 컨트롤 플레인 공개키).
- `codex` 그리고/또는 `claude` CLI 설치 + **선로그인**:
  - Codex Operator/Worker → pod 의 `~/.codex/auth.json` (`codex login`).
  - Claude Operator/Worker → pod 의 `~/.claude/.credentials.json` (`claude` 로그인).
- **secret 을 env 로 넣지 않는다** — pod CLI 선로그인이 인증 소스(원격 spawn env 는 `{}` 로 나가 pod 의 `~/.codex`/`~/.claude` 를 씀).
- CLI 가 `PATH` 에 있어야 한다 (없으면 노드의 **node_prefix** 로 지정, 예: `/home/user/.npm-global/bin`).

### 1.3 네트워크 (원격 Operator dispatch 의 전제)
원격 pod 의 Operator 가 워커를 dispatch 하려면 **컨트롤 플레인 REST API 로 curl** 해야 한다. 그래서
pod → 컨트롤 플레인 **역방향 도달**이 필요하다. Tailscale 이면 pod 가 컨트롤 플레인의 tailnet IP(`100.x`)로
직접 접속 가능하다. 배포 전 확인:
```bash
# 컨트롤 플레인에서 임시 리스너
node -e "require('http').createServer((q,s)=>s.end('OK')).listen(4199,'0.0.0.0')" &
# pod 에서
ssh <pod> 'curl -s --max-time 8 http://<컨트롤플레인-tailscale-IP>:4199'   # → OK 나와야 함
```
(실 Pi 검증: Pi → Mac `100.120.25.112:4199` → `MAC_REACHED` 확인됨.)

---

## 2. 컨트롤 플레인 기동

```bash
cd palantir_console
npm install    # 최초 1회
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
PALANTIR_TOKEN='<강한-랜덤-시크릿>' \
PALANTIR_BASE_URL='http://<컨트롤플레인-tailscale-IP>:4177' \
HOST=0.0.0.0 \
npm start
```

| env | 역할 | 필수? |
|---|---|---|
| `PALANTIR_TOKEN` | auth 활성 + 자동으로 `0.0.0.0` 바인딩. 미설정 시 auth 비활성(개발만). | 운영 **필수** |
| **`PALANTIR_BASE_URL`** | **원격 Operator dispatch 의 핵심.** 원격 Operator 의 시스템 프롬프트에 이 주소가 curl 대상으로 박힌다. **pod 에서 도달 가능한 주소**여야 함(컨트롤 플레인의 tailnet IP). 미설정 시 원격 Operator 가 자기 `localhost` 를 curl → dispatch 실패 + `operator:remote_base_url_localhost` 경고. | 원격 Operator 사용 시 **필수** |
| `HOST` | 바인딩 주소. 토큰 있으면 자동 `0.0.0.0`. 명시 가능. | 선택 |
| `PALANTIR_FLEET_HEARTBEAT` | `=1` 이면 ssh 노드 reachable heartbeat probe(기본 off). `PALANTIR_FLEET_HEARTBEAT_INTERVAL_MS`(기본 30000). | 선택 |

브라우저: `http://<IP>:4177/login.html` 에서 토큰 입력(쿠키 인증).

---

## 3. pod(노드) 등록

### 3.1 UI (`#resources`)
`#resources` 탭 → 노드 추가:
- **id**: 짧은 식별자 (예: `pi`, `mac-mini`).
- **kind**: `ssh`.
- **ssh_host / ssh_user**: pod 접속 정보 (예: `100.64.17.115` / `karnian`).
- **exposed_roots**: pod 에서 실행 허용 루트(들) (예: `/home/karnian/fleet-workspaces`). **경로 탈출 방어의 앵커** — 이 밖은 실행 거부.
- **node_prefix**: pod 의 CLI bin 디렉터리 (`PATH` 앞에 붙음, 예: `/home/karnian/.npm-global/bin`).
- **can_execute**: 실행 노드면 true (false = 파일 전용).

### 3.2 API
```bash
curl -s -X POST http://<IP>:4177/api/nodes -H "Authorization: Bearer $PALANTIR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"pi","name":"Raspberry Pi","kind":"ssh","ssh_host":"100.64.17.115","ssh_user":"karnian",
       "exposed_roots":["/home/karnian/fleet-workspaces"],"node_prefix":"/home/karnian/.npm-global/bin",
       "can_execute":true,"reachable":true}'
```

---

## 4. 프로젝트를 노드에 바인딩

- 프로젝트의 `node_id` = pod id → 그 프로젝트의 **Operator + Worker 가 그 pod 에서** 실행된다.
- `directory` = **pod 안의 경로** (exposed_roots 밑, 예: `/home/karnian/fleet-workspaces/myproj`). pod 에 미리 만들어 둔다(`git init`).
- `preferred_pm_adapter`:
  - `'codex'` (기본) → per-turn Codex Operator (가벼움).
  - `'claude'` → persistent Claude Operator (제약 가능한 tool diet + curl; stdin 세션 유지).
- `node_id` 미설정 = 로컬(컨트롤 플레인) 실행.

---

## 5. 검증된 토폴로지 (실 Raspberry Pi)

| 토폴로지 | 상태 | 근거 |
|---|---|---|
| Top(Claude, 컨트롤 플레인) + 워커 pod dispatch | ✅ | P3 — 콘솔 codex 태스크 → Pi 워커 → completed 복귀 |
| 로컬 Operator + 워커 pod dispatch | ✅ | P3 |
| **Codex Operator 가 pod 에서** | ✅ | P4-S3b — Pi 바인딩 → Codex Operator turn on pod |
| **Claude Operator 가 pod 에서 (spawn+대화+resume)** | ✅ | P5-S4b/S4c — Pi 에서 persistent + 재시작 넘어 세션 resume("42" 기억) |
| **원격 Operator(pod) → 컨트롤 플레인 curl → 워커 dispatch (풀 루프)** | ✅ | **F1** — Mac 컨트롤 플레인 → Pi Claude Operator → curl → codex 워커 Pi dispatch(running@pi) |

> **v1 비범위**: 단일 프로젝트 cross-node 로드밸런싱, pod pool 스케줄링 (1:1 바인딩으로 시작).

---

## 6. 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `operator:remote_base_url_localhost` 이벤트 + 원격 Operator 가 dispatch 못 함 | `PALANTIR_BASE_URL` 미설정 → Operator 가 자기 localhost curl | `PALANTIR_BASE_URL` 을 pod-도달 tailnet IP 로 설정 후 재시작 |
| 원격 spawn `codex/claude exited 127 (No such file or directory)` | pod 에서 CLI 를 PATH 로 못 찾음 | 노드 `node_prefix` 를 pod 의 CLI bin 디렉터리로 |
| 원격 run 이 `queued` 에 갇힘 | (과거 버그 — P5-S4b 에서 수정됨) async spawn 첫 메시지 레이스 | 최신 main 사용 (pendingInput 버퍼) |
| 원격 Operator 가 auth 실패로 안 뜸 | pod CLI 미로그인 | pod 에서 `codex login` / `claude` 로그인. (컨트롤 플레인 auth 는 원격이면 skip) |
| ssh `exit 255` | transport/연결 실패(호스트 unreachable, 키 문제) | ssh 키/네트워크 확인. (P5-S2: transport 단절은 `unreachable` 로 구분되어 resumable) |
| 노드가 계속 offline | heartbeat off 또는 reachable false | `PALANTIR_FLEET_HEARTBEAT=1`, ssh 도달성 확인 |
| better-sqlite3 ABI 오류 | node 26(brew) vs 22 불일치 | node@22 사용 또는 `npm rebuild better-sqlite3` |

### 진단 도구
- `npm run diagnose:mcp` — preset ↔ user `~/.codex/config.toml` alias 충돌.
- `#resources` UI — 노드 health / reachable 상태.
- run 이벤트 — `transport_lost`(단절), `operator:thread_rebind_reset`(노드 재바인딩), `operator:remote_base_url_localhost`(base URL 미설정).

---

## 7. 보안 요약

- **secret 은 pod CLI 선로그인**으로만 (env/argv 로 안 나감). 원격 spawn env = `{}` → pod 의 `~/.codex`/`~/.claude` 사용.
- `exposed_roots` = 원격 실행 경로 앵커 (realpath 검증, 밖은 거부).
- **Codex Top on Pi 금지** (bypass sandbox). v1 Top-on-Pi 는 **Claude Top** 만(tool diet 로 제약 가능).
- Claude Operator 의 dispatch 는 `Bash(curl)` — read-only diet + curl 만이라 Codex Operator 의 full bypass sandbox 보다 **엄격히 제약적**.
- `PALANTIR_TOKEN` 설정 필수(auth). 미설정 = auth 비활성 경고.
