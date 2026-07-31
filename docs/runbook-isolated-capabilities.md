# `isolated` agent capability 달성 런북

이 문서의 `isolated`는 Worker Preset의 `isolated` 옵션이나 git worktree 분리를 뜻하지
않는다. `PALANTIR_MANAGER_TOKEN`·`PALANTIR_WORKER_TOKEN` 같은 run-bound capability를
받는 프로세스가 Console 및 다른 capability 보유 프로세스의 환경·임시 실행 자료를
읽을 수 없게 만드는 **OS 계정/컨테이너 프로세스 경계**를 뜻한다.

기본 로컬 tmux/subprocess 토폴로지는 같은 UID로 자식을 실행하므로 이 경계를 충족하지
않는다. 그 상태에서 `PALANTIR_AGENT_PROCESS_ISOLATION=verified`만 설정하면 선언과
현실이 어긋난다.

## 진단 명령

```bash
npm run diagnose:isolation
npm run --silent diagnose:isolation -- --json
```

종료 코드는 다음과 같다.

| 코드 | 의미 |
|---|---|
| `0` | `resolveActorTokenPolicy().capabilitiesEnabled`의 현재 조건을 모두 충족 |
| `1` | 잘못된 옵션 또는 진단 자체 실패 |
| `2` | 하나 이상의 필수 조건 누락 |

진단 항목과 코드 판정의 관계는 다음과 같다.

| 진단 ID | 통과 조건 | 코드 근거 | 의미 |
|---|---|---|---|
| `human_token` | policy 입력에 비어 있지 않은 `PALANTIR_TOKEN` | `resolveActorTokenPolicy`의 `humanToken` 및 `!!(humanToken && processIsolated)` | 인증이 켜져 capability 서명 서비스를 활성화할 수 있음 |
| `process_isolation_attestation` | `PALANTIR_AGENT_PROCESS_ISOLATION` 값이 정확히 `verified` | 같은 함수의 `env.PALANTIR_AGENT_PROCESS_ISOLATION === 'verified'` | 운영자가 실제 OS/container 경계를 확인했다고 선언 |

`PALANTIR_ACTOR_TOKEN_SOURCE=ephemeral_file|application_options`는 `boundary`를
`run_capabilities`로 표시하는 출처 보증이다. 현재 코드에서는
`capabilitiesEnabled`의 추가 필수 조건이 아니므로 진단도 이것을 차단 항목으로
거짓 추가하지 않고 advisory로만 표시한다.

standalone 진단 프로세스는 Console이 시작할 때 소비하여 application-owned state로
옮길 one-shot 파일의 토큰을 읽거나 삭제하지 않는다. 따라서 실제 배포가
`PALANTIR_ACTOR_TOKEN_FILE`을 사용한다면 다음처럼 **비밀이 아닌 자리표시자**로
정책 게이트만 사전 확인하고, 실제 파일 검증은 Console 시작 경로에 맡긴다.

```bash
PALANTIR_TOKEN=diagnostic-placeholder \
PALANTIR_ACTOR_TOKEN_SOURCE=ephemeral_file \
PALANTIR_AGENT_PROCESS_ISOLATION=verified \
npm run --silent diagnose:isolation -- --json
```

이 명령의 성공은 one-shot 파일 내용이나 OS 경계를 검증하지 않는다. 파일은 실제
시작 시 mode `0600` 이하, 단일 hard link, Console 사용자 소유, 일반 파일·비-symlink,
유효한 JSON과 비어 있지 않은 `PALANTIR_TOKEN` 조건으로 별도 검증·소비된다.

## `verified` 선언 전 공통 합격 조건

다음 조건은 전용 OS 계정 방식과 컨테이너 방식 모두에 적용한다.

1. Console과 모든 capability 보유 agent가 서로 다른 보안 주체여야 한다. 여러 agent가
   동시에 하나의 UID 또는 하나의 PID namespace를 공유하면 안 된다.
2. agent A가 Console 및 agent B의 process environment를 읽지 못해야 한다. Linux라면
   `/proc/<pid>/environ`, macOS라면 `ps eww -p <pid>` 같은 플랫폼별 관찰 경로를
   실제 agent 주체로 음성 검증한다.
3. Console의 one-shot actor token 파일, 저장소 `.env`, 임시 system prompt/capability
   파일을 agent가 열거하거나 읽지 못해야 한다.
4. agent에게 Docker/Podman socket, host PID namespace, privileged mode, ptrace capability,
   Console 계정으로 되돌아가는 `sudo` 권한을 주지 않는다.
5. 각 agent는 필요한 workspace와 자기 전용 CLI credential/config 경로만 받는다.
   다른 agent의 HOME·credential store·임시 디렉터리를 공유하지 않는다.
6. stdin/stdout/stderr, 종료 신호, cwd, Palantir가 생성한 일회성 파일의 전달이 외부
   launcher 경계에서도 보존되는지 확인한다.
7. 음성 검증 후에만 `process_isolation_attestation` 항목을 충족시키도록
   `PALANTIR_AGENT_PROCESS_ISOLATION=verified`를 설정한다.
8. `PALANTIR_TOKEN`은 저장소 `.env`가 아니라 mode-`0600` one-shot 파일로 공급해
   `human_token` 항목을 실제 시작 시 충족시킨다.

## 레시피 A: 전용 OS 계정

이 방식은 Linux에서 외부 supervisor가 각 실행 슬롯에 고유한 비권한 계정을 할당할 수
있을 때 적합하다.

1. `palantir-console` 계정과 최대 동시 agent 수만큼의 계정
   (`palantir-agent-01`, `palantir-agent-02`, …)을 만든다. 한 계정을 동시에 두
   capability 프로세스에 배정하지 않는다.
2. Console 코드·DB·actor token 파일은 `palantir-console`만 읽게 한다. 각 workspace는
   배정된 agent 계정과 Console이 필요한 범위만 ACL로 허용한다.
3. 외부 supervisor/launcher가 agent별 HOME, 임시 디렉터리, CLI credential store를
   만들고 해당 계정으로 CLI를 `exec`하게 한다. Console 자체를 root로 계속 실행하거나
   agent에게 임의 `sudo`를 주지 않는다.
4. Manager의 `CODEX_BIN`/`CLAUDE_BIN`과 모든 Worker profile의 `command`가 이
   launcher를 통과하는지 확인한다. 하나라도 기본 `codex`/`claude` 직접 실행으로
   남으면 전체 선언은 실패다.
5. 두 agent를 동시에 띄운 뒤 각 agent 계정에서 Console 및 상대 agent의 환경과
   임시 파일 읽기를 시도한다. 읽기 성공은 즉시 NO-GO다.
6. Console API에 도달할 수 있는 `PALANTIR_BASE_URL`을 설정하고, manager가 자기
   run-bound token으로 허용된 status/dispatch API를 호출하는 positive test를 한다.
7. 공통 합격 조건을 모두 기록한 뒤 `verified`를 설정하고 진단 종료 코드 0을 확인한다.

현재 저장소에는 계정 생성·회수, agent별 UID 할당, ACL 설정을 담당하는 supervisor가
내장되어 있지 않다. 따라서 기본 tmux/subprocess executor에 환경 변수만 더하는 것은
이 레시피가 아니다.

## 레시피 B: 프로세스별 컨테이너

외부 launcher가 CLI invocation마다 새 컨테이너를 만들 수 있을 때의 계약이다.

1. capability 보유 프로세스마다 별도 컨테이너와 PID namespace를 만든다. 한 pod 안의
   여러 container도 `shareProcessNamespace: true`를 사용하지 않는다.
2. `--privileged`, host PID namespace, Docker/Podman socket mount, ptrace capability를
   금지하고 root filesystem은 가능한 한 read-only로 둔다.
3. workspace, agent 전용 HOME/credential store, Palantir가 그 invocation에 만든
   system prompt·secret 파일만 최소 범위로 mount한다. `/tmp`, Console HOME, 저장소
   전체를 공용 mount하지 않는다.
4. Manager의 `CODEX_BIN`/`CLAUDE_BIN`과 모든 Worker profile command를 launcher로
   바꾼다. launcher는 stdin/stdout/stderr와 signal을 그대로 전달하고 종료 시
   컨테이너를 제거해야 한다.
5. 컨테이너에서 Console에 닿는 URL을 `PALANTIR_BASE_URL`로 설정한다. loopback은
   컨테이너 자신이므로 기본 `localhost`를 그대로 쓰면 안 된다.
6. agent 컨테이너 안에서 host/다른 agent PID와 환경이 보이지 않는지, Docker socket이
   없는지, 다른 credential store가 mount되지 않았는지 음성 검증한다.
7. 실제 manager/worker를 각각 실행해 capability가 전달되고 허용 API만 성공하는지
   확인한 다음 `verified`와 진단 종료 코드 0을 배포 gate로 둔다.

기존 `docker-compose.yml`은 Console과 그 로컬 자식 실행을 자동으로 프로세스별
컨테이너로 나누지 않는다. `docker compose up`만으로는 이 레시피를 충족하지 않는다.
원격 node/pod도 그 안에서 여러 capability 프로세스가 같은 UID/PID 경계를 공유하면
충족하지 않는다.

## CI gate 예시

CI에는 실제 배포 launcher가 만든 경계에 대한 음성 probe를 먼저 두고, 그 다음 정책
게이트를 실행한다.

```bash
./deployment/probe-agent-boundaries.sh

PALANTIR_TOKEN=ci-nonsecret-presence-probe \
PALANTIR_ACTOR_TOKEN_SOURCE=ephemeral_file \
PALANTIR_AGENT_PROCESS_ISOLATION=verified \
npm run --silent diagnose:isolation -- --json
```

첫 번째 스크립트는 이 저장소에 포함된 명령이 아니라 각 배포의 supervisor/container
구성에 맞춰야 한다. 두 번째 명령만 통과시키고 첫 번째 음성 probe를 생략하면
same-UID 환경도 `verified`라는 문자열 하나로 통과하므로 안전 증명이 아니다.

## 검증 현황 (2026-07-29)

| 항목 | 상태 | 확인 범위 |
|---|---|---|
| 진단과 `resolveActorTokenPolicy`의 lock-step | 확인함 | token/isolation/source 조합 truth table 단위 테스트 |
| `--json` 및 종료 코드 `0/1/2` | 확인함 | Node child-process 테스트 |
| 현재 개발 호스트의 기본 진단 | 확인함 | macOS arm64에서 `human_token`, `process_isolation_attestation` 누락 및 종료 코드 2 |
| 런타임 동작 | 변경 없음 | 새 진단 모듈은 서버 시작/실행 경로에서 import하지 않음 |
| 전용 OS 계정 전체 배포 | 확인하지 못함 | 이 워크트리에 supervisor와 Linux 다중 계정 환경이 없음 |
| 프로세스별 컨테이너 전체 배포 | 확인하지 못함 | launcher·CLI image·mount 계약을 포함한 Palantir E2E 미수행 |
| Raspberry Pi / 원격 pod | 확인하지 못함 | 이 워크트리에 해당 환경이 없음 |

확인하지 못한 세 구성은 “검증된 설정”이 아니다. 실제 배포에서 공통 합격 조건과
positive/negative test를 수행하기 전에는 `verified`를 선언하지 않는다.

## 종료 코드 (교차검토 반영, 2026-07-29)

| 코드 | 뜻 |
|---|---|
| 0 | 이 환경에서 capability 활성 조건 충족 |
| 2 | **실제로 미충족** — 무엇이 빠졌는지 checks 에 나온다 |
| 3 | **판정 불가** — `PALANTIR_ACTOR_TOKEN_FILE` 이 설정돼 있다 |

3이 필요한 이유: 그 파일은 `index.js` 가 부팅 때 한 번 소비해 `createApp` 옵션으로
넘기므로 **환경변수로 존재하지 않는다.** 이 명령은 그걸 읽을 수 없고(읽으면 소비된다),
그렇다고 "없음" 으로 보고하면 **문서가 권장하는 바로 그 구성에서 NOT READY 가 나온다.**
서버와 어긋난 진단은 이 도구가 막으려는 실패 그 자체다.

CI 게이트에서는 3을 실패로 다룰지 별도로 정하라 — 파일 기반 배포에서는 정상이다.
