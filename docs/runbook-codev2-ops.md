# codev2 운영 runbook (Palantir Console)

2026-10-14 사용자 결정으로 운영 위치를 codev2 로 옮겼다(codev1 반납). 범위는 **세션 관측(observe) + 지시별 답변 + 세션 비서**다. Agent API capability(매니저·워커)는 꺼져 있다(`[security] Agent API capabilities disabled` — OS 사용자/컨테이너 격리 미선언).

## 접속
- 주소: `http://codev2:4177/#manager` (tailnet MagicDNS 호스트명). 서버는 tailnet IP `100.83.124.113` 에만 바인딩한다 — LAN 에는 열지 않는다.
- 로그인 토큰: 사용자가 정한 값(`~/.config/palantir/server.env` 의 `PALANTIR_TOKEN`). 추측 가능한 값이면 tailnet 바인딩이 유일한 경계다. 로그인 cookie 는 `Path=/`·Secure 없음이라 같은 호스트의 다른 http 포트 서비스에도 전송될 수 있다.
- 확인 요청은 반드시 `http://codev2:4177` 로 한다(`localhost:4177` 은 바인딩 밖).

## 구성 (codev 사용자)
| 항목 | 위치 |
|---|---|
| 코드 | `/home/codev/palantir-console` (git checkout, 검토된 SHA) |
| 환경 파일 | `/home/codev/.config/palantir/server.env` (0600) |
| systemd user unit | `/home/codev/.config/systemd/user/palantir-console.service` (`enable` — linger 로 부팅 시 자동 기동) |
| 데이터 | `/home/codev/.local/share/palantir/` (0700): `palantir.db`, `observe-snapshots/`, `session-hub/`, `tmp/`(TMPDIR·TMUX_TMPDIR 격리) |
| 머신 설정 | `/home/codev/.config/palantir/observe.json` — machine_id `26de0b2b4038dfff`. **지우지 말 것**(지우면 새 ID → `machine_mismatch`). Mac 미리보기의 codev2 ssh 수집도 같은 파일을 쓴다. |

환경 파일 주요 값: `PORT=4177`, `HOST=100.83.124.113`, `PALANTIR_SESSION_HUB=1`, `PALANTIR_SNAPSHOT_TARGETS`(codev2 local 하나, `orcaBin=/home/codev/.local/bin/orca` — 이 값이 있어서 Orca 연동이 켜져 있다. 빼면 꺼진다), `PALANTIR_MEMORY_DISTILL=0`, `PALANTIR_SHUTDOWN_WATCHDOG_MS=20000`, `PATH=/home/codev/.local/bin:...`. 경로는 모두 실제 절대경로(`~`·`$HOME` 확장 없음). JSON 값은 작은따옴표로 감싼다.

unit 요점: `KillMode=mixed`(앱이 먼저 graceful shutdown, 남은 자식은 cgroup 으로 회수), `TimeoutStopSec=30`, `Restart=on-failure`(tailnet IP 가 아직 없어 listen 실패하면 10초 뒤 재시도), `UMask=0077`.

## 상태 확인
```sh
systemctl --user status palantir-console
journalctl --user -u palantir-console -n 50 --no-pager
curl -s http://codev2:4177/api/health    # gitSha, sessionHubActive
```
수집 확인은 202(접수)가 아니라 결과로 본다: 로그인 → `POST /api/session-hub/snapshots/refresh`(Origin `http://codev2:4177`) → `GET /api/session-hub/snapshots/status` 에서 `running=false`, `last_result.code=ok`, 새 `last_success_at` → `GET /api/observe/snapshots` 에 machine `26de0b2b4038dfff` 와 최신 `generated_at`. 자동 수집은 부팅 5분 뒤부터 5분마다.

## 갱신
```sh
cd /home/codev/palantir-console
git fetch -q origin
git log --oneline -1 <검토한 SHA>
systemctl --user stop palantir-console
cp -p /home/codev/.local/share/palantir/palantir.db \
  /home/codev/.local/share/palantir/palantir.db.bak-$(date +%Y%m%d-%H%M%S)
git checkout -q <검토한 SHA>
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/sk-holdings-cc.crt \
  npm ci --omit=dev --no-audit --no-fund
systemctl --user start palantir-console
curl -s http://codev2:4177/api/health    # gitSha 가 검토한 SHA 인지
```
- 사내 TLS 가로채기 때문에 `npm ci` 는 사내 CA 를 **그 명령에만** 넘긴다(전역 npm 설정은 바꾸지 않았다). 없으면 better-sqlite3 네이티브 빌드가 `self-signed certificate in certificate chain` 으로 실패한다.
- 갱신 롤백: 서비스 중지 → 이전 SHA checkout → `npm ci` → 백업 DB 복원(migration 이 돌았을 수 있으므로) → 시작.

## 다른 서버 추가
서버가 늘면 같은 화면에서 함께 본다. 코드 변경 없이 수집 대상 한 줄을 더한다. codev2 가 그 서버에 ssh 로 접속해 수집 코드를 표준입력으로 넘겨 `node -` 로 실행하므로, 대상 서버에는 Palantir 체크아웃이 필요 없다. 지시별 답변 조회도 같은 ssh 경로로 동작한다.

대상 서버 요건: codev2 의 codev 사용자로 비대화형 ssh 접속(키 인증), Node 22 이상. **Orca 는 선택이고 기본 꺼짐이다** — 세션·지시·답변은 그 서버의 Claude Code·Codex 기록(`~/.claude`, `~/.codex`)에서 읽으므로 Orca 없이도 보이고, Orca 연동을 켜지 않으면 Orca 를 실행하지 않고 Orca 연결 정보(어느 워크스페이스·터미널인지, Orca 상태)만 `off` 로 빠진다. 켰는데 Orca 를 쓸 수 없으면 `orca_unavailable` 로 빠지고 수집은 계속된다(2026-10-14 실측: Orca 없이 수집 성공, 세션 102·지시 965). 비대화형 ssh 의 PATH 에 node·orca 가 없으면 절대경로를 대상 설정에 넣는다.

1. codev2 에 ssh 키 만들기(최초 1회 — 2026-10-14 현재 codev2 에는 개인키가 없다):
   `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''` → 공개키를 대상 서버의 `~/.ssh/authorized_keys` 에 등록.
2. 접속 확인: `ssh -o BatchMode=yes <user>@<host> 'node --version; command -v orca'`
3. 첫 수집으로 machine id 만들기(대상 서버에 `~/.config/palantir/observe.json` 이 생긴다. 이 파일은 지우지 말 것):
   ```sh
   cd /home/codev/palantir-console
   d=$(mktemp -d)
   node scripts/session-snapshot.mjs remote --host <user>@<host> snapshot --out-dir "$d" --label <이름> \
     [--remote-node /절대경로/node] [--orca | --orca-bin /절대경로/orca]
   ls "$d"     # <machine_id>.json — 파일 이름이 machine id
   rm -rf "$d"
   ```
4. `~/.config/palantir/server.env` 의 `PALANTIR_SNAPSHOT_TARGETS` 배열에 대상 추가:
   `{"name":"<이름>","kind":"ssh","host":"<user>@<host>","machineId":"<machine_id>","label":"<이름>"}`
   (필요하면 `"remoteNode"` 절대경로. Orca 를 켜려면 `"orcaBin"` 절대경로 또는 `"orca":true`). 이름·machine id 가 겹치거나 형식이 틀리면 수집 전체가 꺼진다.
5. `systemctl --user restart palantir-console` → "상태 확인"의 수집 확인 절차로 새 machine 의 `last_result.code=ok` 를 본다.

## 철수
`systemctl --user disable --now palantir-console` (데이터는 남는다).

## 알려진 한계
- **Mac 세션은 수집하지 않는다**(2026-10-14 사용자 결정 — 운영 대상에서 제외). 다른 서버가 생기면 "다른 서버 추가" 절차로 함께 본다.
- 세션 비서는 codev2 의 Claude 자격(`~/.claude/.credentials.json`)으로 돈다.
- tmux 가 없어 워커 실행 엔진은 SubprocessEngine 이다(현재 워커 기능은 꺼져 있음).

## 배포 기록
- 2026-10-14 최초 배포 `e4cf619`. 검증: health ok·sessionHubActive, 로그인 204, 수동 수집 ok, 답변 조회 4건 final(각 약 0.3초), 세션 비서 1턴(`list_sessions` 호출) 후 stop.
