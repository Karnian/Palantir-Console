# I0a 세션 스냅샷 반출 runbook

보드 서버와 아래 CLI는 Mac의 Palantir checkout에서 실행한다. 원격 codev2에는 Node 18 이상과
SSH 접속만 필요하다. 매번 번들을 SSH stdin으로 보내 실행하고 살균 결과만 Mac으로 받는다.
원격 checkout, scp, 원본 transcript 반출, 중간 스냅샷 파일은 없다. 운영 codev1은 observe off를 유지한다.

## 준비

Mac 보드 서버 사용자로 전용 디렉터리를 만들고 아래 환경변수를 CLI와 서버에 함께 설정한다.
`PALANTIR_TOKEN`은 사람 로그인 토큰이며 PM 토큰으로 대체할 수 없다.

```sh
export PALANTIR_OBSERVE_SNAPSHOT_DIR="$HOME/.local/share/palantir/observe-snapshots"
mkdir -p "$PALANTIR_OBSERVE_SNAPSHOT_DIR"
chmod 700 "$PALANTIR_OBSERVE_SNAPSHOT_DIR"
export PALANTIR_TOKEN='<사람 로그인 토큰>'
ls -ld "$PALANTIR_OBSERVE_SNAPSHOT_DIR"
npm start
```

디렉터리는 서버 사용자 소유여야 한다. 설정 경로는 symlink를 포함하지 않는 실제 절대경로를 쓴다.
끝 슬래시나 `.`·`..`를 붙이지 않는다. 미설정 부팅은 무음이며 설정 후 검사 실패만 고정 코드로 경고한다.
활성 상태는 부팅 때 한 번 봉인한다. 토큰·경로·권한을 바꾼 뒤에는 서버를 재시작한다.
브라우저는 사람 토큰으로 로그인한다. endpoint는 cookie만 허용하고 bearer는 403이다.
파일은 `<machine_id>.json` 하나씩 원자적으로 덮어쓰며 권한은 0600이다.

## 생성

```sh
# Mac 로컬
node scripts/session-snapshot.mjs snapshot

# Mac에서 codev2 실행 후 같은 Mac 디렉터리에 기록
node scripts/session-snapshot.mjs remote --host codev@codev2 snapshot

# 비대화형 SSH PATH에 node가 없으면 실제 절대경로 지정
node scripts/session-snapshot.mjs remote --host codev@codev2 \
  --remote-node /home/codev/.local/bin/node snapshot
```

`--out-dir <실제 절대경로>`로 출력 디렉터리를 명시할 수도 있다. 실행 실패나 수신 검증 실패 시
기존 파일은 보존된다. 목록과 상세 응답에는 `Cache-Control: no-store`가 붙는다.

## 제외·삭제 등록

보드에서 `<INSTR_ID>#<ref>`를 복사한다. 지시가 나온 머신에 맞춰 Mac 터미널에서 실행한다.
조회 결과의 시각·살균 미리보기·동치 제외 개수를 확인한 뒤 Mac 터미널에서 확인한다(기본값 No).
id 없는 Codex 지시는 같은 세션의 같은 내용·블록 구조·첨부 개수 메시지가 모두 제외된다.
`target_changed`면 스냅샷을 새로 만들고 지정자를 다시 복사한다.

```sh
# Mac 지시
node scripts/session-snapshot.mjs exclude --instruction '<INSTR_ID>#<ref>'
node scripts/session-snapshot.mjs snapshot

# codev2 지시
node scripts/session-snapshot.mjs remote --host codev@codev2 \
  exclude --instruction '<INSTR_ID>#<ref>'
node scripts/session-snapshot.mjs remote --host codev@codev2 snapshot

# 세션 전체 제외: 지정자 대신 provider:session_id
node scripts/session-snapshot.mjs exclude --session 'claude:<session_id>'
```

등록 후 해당 머신의 스냅샷을 재생성하고 보드를 새로고침한다. 기록 단계는 원본·머신·대상·번들과
확인 토큰을 다시 대조한다. 원본이 바뀌면 `confirm_mismatch`로 거부하며 제외 규칙은 합집합으로 유지한다.

## 상태 코드와 잠금

공유 정책의 `STATUS_CODES` 의미는 아래와 같다. 상태 envelope와 endpoint 오류 코드는 별개다.

| 상태 코드 | 의미·조치 |
|---|---|
| `ok` | 작업 완료(제외 등록 결과 등) |
| `node_unsupported` | 실행 머신의 Node 버전 미지원. Node 18 이상으로 실행 |
| `config_busy` | `observe.json.lock`이 이미 있음. 실행 중인 작업을 확인하고 완료 후 재시도 |
| `key_unavailable` | local_key 누락·읽기 실패·키 지문 불일치. 새 키를 만들지 말고 기존 설정 확인 |
| `target_changed` | 보드 지정자의 ref와 현재 원본이 다름. 재생성 후 다시 지정 |
| `confirm_mismatch` | 확인 토큰과 현재 대상·원본·머신·빌드가 다름. 조회부터 다시 실행 |
| `target_not_found` | 현재 원본에 대상이 없음. 지정자와 머신 확인 |
| `request_invalid` | 요청·설정·정책 검증 실패. 인자와 설정 확인 |
| `internal_error` | 고정 코드로 보고된 내부 실패. 기존 파일 보존 상태에서 원인 점검 |
| `orca_unavailable` | Orca 관측 실패. 스냅샷은 coverage에 실패를 표시하고 계속 생성할 수 있음 |

`config_busy`는 기다리지 않고 끝난다. 잠금에는 자동 만료가 없다. 오래된 잠금을 지우려면
**그 머신에서 실행 중인 snapshot/exclude 및 관련 번들 Node 프로세스가 없음을 확인한 뒤에만** 삭제한다.
아래 명령은 로컬에서 실행하며, 원격 잠금은 해당 머신 터미널에서 같은 절차로 처리한다.
프로세스가 남아 있으면 삭제하지 않는다.

```sh
ps -u "$(id -u)" -o pid,ppid,etime,args
# snapshot/exclude 및 node --no-warnings - 실행이 없음을 확인한 뒤에만:
rm -- "$HOME/.config/palantir/observe.json.lock"
node scripts/session-snapshot.mjs snapshot
```

endpoint 오류는 고정 코드만 돌려준다.

| HTTP | reason |
|---|---|
| 400 | `invalid_machine_id`, `request_invalid` |
| 401 | `authentication_required` (observe 무인증) |
| 403 | `cookie auth required`, `authentication_failed` |
| 404 | `observe_off`, `not_found`, `route_not_found` (GET 외 메서드 포함) |
| 413 | 상세의 `too_large` (단일 파일 16MB 초과), 목록 전체의 `total_limit` (대상 파일 256개 초과) |
| 422 | `symlink`, `not_regular`, `identity_mismatch`, `parse_error`, `policy_violation` |
| 503 | `observe_root_changed`, `read_error` |
| 500 | `internal_error` |

목록은 200 안에 실패 항목의 `{name_id, error_code}`를 포함할 수 있다.
목록 읽기 합계 64MB 초과는 전체 200을 유지하고 해당 항목에 `total_limit`을 표시한다.
목록의 단일 파일 16MB 초과도 항목의 `too_large`로 표시한다. 파일 수 256개 초과만 목록 전체 413이다.
루트 변경은 상태를 바꾸지 않고 503으로 거부한다. 원래 실제 디렉터리를 복원하거나 설정을 고쳐 재시작한다.

## 평가 종료

Mac 서버를 종료하고 보드 디렉터리만 지운다. 서버 환경에서 observe 경로를 해제한 뒤 재시작하면 off다.
운영 codev1에는 `PALANTIR_OBSERVE_SNAPSHOT_DIR`를 설정하지 않는다.

```sh
# 전용 평가 디렉터리인지 값을 확인한 뒤 실행
printf '%s\n' "$PALANTIR_OBSERVE_SNAPSHOT_DIR"
rm -r -- "$PALANTIR_OBSERVE_SNAPSHOT_DIR"
unset PALANTIR_OBSERVE_SNAPSHOT_DIR
```

각 머신의 `~/.config/palantir/observe.json`은 삭제 목록과 키를 보존하므로 유지한다.
원격에는 지울 스냅샷 파일이 없다. path_salt를 회전해 path_gen이 올라가도 삭제 신원·규칙은 유지한다.
