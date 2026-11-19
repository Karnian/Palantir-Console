# ocr2 운영 runbook (Palantir Console)

2026-11-18 운영 위치를 codev2 에서 **ocr2** 로 옮겼다(codev2 는 팀 공용 서버로 남음). 범위는 그대로 **세션 관측(observe) + 지시별 답변 + 세션 비서**이고 Agent API capability(매니저·워커)는 꺼져 있다. 이전 전 기록은 [runbook-codev2-ops.md](runbook-codev2-ops.md).

## 접속
- 주소: `http://ocr2:4177/#manager` (tailnet MagicDNS 호스트명). 서버는 ocr2 의 tailnet IP 에만 바인딩한다 — LAN 에는 열지 않는다.
- 로그인 토큰: `~/.config/palantir/server.env` 의 `PALANTIR_TOKEN`(codev2 때 값 그대로). tailnet 바인딩이 경계다.
- ocr2 안에서는 `ocr2` 가 `127.0.1.1` 로 풀려 바인딩 밖이다. 서버 안에서 확인할 때는 `curl --resolve ocr2:4177:<ocr2 tailnet IP> http://ocr2:4177/...` 처럼 tailnet IP 로 붙인다(Origin 은 `http://ocr2:4177`).

## 구성 (ocrusr 사용자)
| 항목 | 위치 |
|---|---|
| 코드 | `/home/ocrusr/palantir-console` (git checkout, 검토된 SHA) |
| 환경 파일 | `/home/ocrusr/.config/palantir/server.env` (0600) |
| systemd user unit | `/home/ocrusr/.config/systemd/user/palantir-console.service` (`enable`, linger 로 부팅 시 자동 기동) |
| Node | `/home/ocrusr/.local/opt/node/v22.23.4` (unit 의 `ExecStart` 가 이 절대경로를 쓴다. 기본 `~/.local/bin/node` 는 v26) |
| 데이터 | `/home/ocrusr/.local/share/palantir/` (0700): `palantir.db`, `observe-snapshots/`, `session-hub/`, `tmp/`(TMPDIR·TMUX_TMPDIR 격리) |
| 머신 설정 | **관측 대상 각 서버의** `~/.config/palantir/observe.json`(ocr2 자신, ocr1). 파일이 machine id 를 정한다 — **지우지 말 것**(지우면 새 ID → `machine_mismatch`). |

환경 파일 주요 값: `PORT=4177`, `HOST=<ocr2 tailnet IP>`, `PALANTIR_SKIP_DOTENV=1`, `PALANTIR_SESSION_HUB=1`, `PALANTIR_MEMORY_DISTILL=0`, `PALANTIR_SHUTDOWN_WATCHDOG_MS=20000`, `PATH=/home/ocrusr/.local/opt/node/v22.23.4/bin:/home/ocrusr/.local/bin:/usr/local/bin:/usr/bin:/bin`, 데이터 경로는 모두 `/home/ocrusr/.local/share/palantir/...` 절대경로(`~`·`$HOME` 확장 없음). JSON 값은 작은따옴표로 감싼다.

`PALANTIR_SNAPSHOT_TARGETS` 는 두 대상이다:
- `ocr1` — `kind:"ssh"`, `host:"ocrusr@ocr1"`, `remoteNode`(ocr1 의 Node 22+ 절대경로), `orcaBin`(ocr1 Orca 절대경로). ocr2 의 전용 키로 접속하며 ocr1 `authorized_keys` 에는 ocr2 에서만 쓰도록 출발지를 제한해 두었다. 개발 세션이 도는 곳이 ocr1 이다.
- `ocr2` — `kind:"local"`, `orcaBin`(ocr2 Orca 절대경로).

unit 요점: `KillMode=mixed`, `TimeoutStopSec=30`, `Restart=on-failure`(tailnet IP 가 아직 없어 listen 실패하면 10초 뒤 재시도), `UMask=0077`, `EnvironmentFile` 로 위 환경 파일을 읽는다.

## 상태 확인
```sh
systemctl --user status palantir-console
journalctl --user -u palantir-console -n 50 --no-pager
curl -s http://ocr2:4177/api/health    # 맥 등 tailnet 클라이언트에서. gitSha, sessionHubActive
```
수집 확인은 202(접수)가 아니라 결과로 본다: 로그인 → `POST /api/session-hub/snapshots/refresh`(Origin `http://ocr2:4177`) → `GET /api/session-hub/snapshots/status` 에서 대상마다 `running=false`, `last_result.code=ok`, 새 `last_success_at` → `GET /api/observe/snapshots` 에 두 machine 의 최신 `generated_at`. 자동 수집은 부팅 5분 뒤부터 5분마다.

## 갱신
개발 저장소는 맥에 있고 GitHub 를 거쳐 받는다.
```sh
cd /home/ocrusr/palantir-console
git fetch -q origin
git log --oneline -1 <검토한 SHA>
systemctl --user stop palantir-console
cp -p /home/ocrusr/.local/share/palantir/palantir.db \
  /home/ocrusr/.local/share/palantir/palantir.db.bak-$(date +%Y%m%d-%H%M%S)
git checkout -q <검토한 SHA>
PATH=/home/ocrusr/.local/opt/node/v22.23.4/bin:$PATH \
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
  npm ci --omit=dev --no-audit --no-fund
systemctl --user start palantir-console
curl -s http://ocr2:4177/api/health    # gitSha 가 검토한 SHA 인지(맥에서)
```
- 사내 TLS 가로채기 때문에 `npm ci` 는 시스템 CA 묶음(사내 CA 포함)을 **그 명령에만** 넘긴다. 없으면 better-sqlite3 네이티브 빌드가 `self-signed certificate in certificate chain` 으로 실패한다.
- `npm ci` 는 unit 과 같은 Node(v22)로 돌린다. 다른 메이저로 빌드하면 네이티브 모듈 ABI 가 맞지 않는다.
- 갱신 롤백: 서비스 중지 → 이전 SHA checkout → `npm ci` → 백업 DB 복원(migration 이 돌았을 수 있으므로) → 시작.

## 다른 서버 추가
절차는 codev2 때와 같다([runbook-codev2-ops.md](runbook-codev2-ops.md) "다른 서버 추가") — 경로만 ocr2 기준(`cd /home/ocrusr/palantir-console`)으로 바꾸고, ssh 는 ocr2 에서 대상 서버로 비대화형 키 인증이 되어야 한다. 대상 서버에는 Node 22 이상만 있으면 되고 Palantir 체크아웃은 필요 없다.

## 철수
`systemctl --user disable --now palantir-console` (데이터는 남는다).

## 알려진 한계
- **Mac 세션은 수집하지 않는다**(2026-10-14 사용자 결정).
- 세션 비서는 ocr2 의 Claude CLI 로그인으로 돈다(Palantir 는 자격 값을 읽지 않는다 — S1-pre 이후).
- **"내 세션"(SH1 세션 호스트)은 아직 macOS 전용이다** — ocr2(Linux x86_64)에서는 `host: not_running, reason: never_started`. 자세한 이유는 codev2 runbook 의 같은 항목.

## 배포 기록
- 2026-11-18 codev2 → ocr2 이전, 운영 rev `d099635`(codev2 와 같음). DB·관측 스냅샷·세션 허브 기록을 함께 옮겼고 관측 대상은 codev2 local 하나 → ocr1(ssh)·ocr2(local). 확인: `/api/health` 가 `gitSha d099635`·`sessionHubActive true`.
