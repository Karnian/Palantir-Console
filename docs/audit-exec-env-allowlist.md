# 이슈 #455: `exec` 환경변수 allowlist 감사

작성일: 2026-07-29

## 범위와 결론

이 감사의 대상은 `NodeExecutor.exec`를 소비하는 git/materialization/worktree/filesystem
경로다. 워커·에이전트 CLI spawn 경로는 #431/#454의 별도 계약이므로 대상에서
제외한다.

결론은 “최대한 작은 env”가 아니라 “Git 실행·node-local config/credential
발견·전송·commit에 코드상 필요한 값만 유지한 env”다. 최초 후보 목록에는
Git 문서에 등장하는 키를 넓게 포함했지만, 보안 검토에서 명령 실행, 임의 config
주입, TLS 검증 무력화가 가능한 ambient 키를 제거했다.

- `GIT_*`나 `SSH_*` prefix를 허용하지 않고, 아래 표의 정확한 이름만 허용한다.
- `PALANTIR_TOKEN`, `PALANTIR_PM_TOKEN`, `PALANTIR_WORKER_TOKEN`,
  `*_API_KEY`, `*_SECRET*`를 포함한 임의 ambient 키는 상속하지 않는다.
- 호출부가 명시하는 command-local override는 ambient 필터와 별개다.
  materialization의 `GIT_TERMINAL_PROMPT=0`/BatchMode `GIT_SSH_COMMAND`,
  harvest/worktree의 빈 `GIT_EXTERNAL_DIFF`/`GIT_TEXTCONV_DIFF`가 여기에
  해당한다.

## 코드에서 실측한 Git 명령

### `projectMaterializationService.js`

모든 명령은 공통 helper를 통해 `GIT_TERMINAL_PROMPT=0`,
`GIT_SSH_COMMAND="ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new"`,
`LC_ALL=C`, `LANG=C`를 명시한다.

| 단계 | 실제 argv |
|---|---|
| cache 판별 | `git rev-parse --git-dir` |
| 최초 cache 생성 | `git clone --no-checkout -- <repoUrl> <tmpPath>` |
| 기존 cache 갱신 | `git fetch --all --tags --prune` |
| 요청 ref의 local 확인 | `git rev-parse --verify --end-of-options <ref>^{commit}` |
| 요청 ref의 remote 확인 | `git ls-remote -- <repoUrl> <ref>` |
| 확인한 SHA 수신 | `git fetch origin -- <sha>` |
| run workspace 생성 | `git worktree add -- <workspacePath> <sha>` |
| stale metadata 정리 | `git worktree prune` |
| run workspace 제거 | `git worktree remove --force <workspacePath>` |

`clone`, 두 종류의 `fetch`, `ls-remote`는 원격 전송과 credential helper를
사용할 수 있다. 나머지도 global/system/repository Git config와 hooks,
external helpers의 영향을 받을 수 있다.

### `worktreeService.js`

| 기능 | 실제 argv | 코드가 명시하는 env |
|---|---|---|
| 저장소 판별 | `git rev-parse --git-dir` | `LC_ALL=C`, `LANG=C` |
| 기준 branch | `git branch --show-current` | 없음 |
| detached fallback | `git rev-parse HEAD` | 없음 |
| run branch 생성/삭제 | `git branch <branch> <base>`, `git branch -D <branch>` | 없음 |
| worktree 생성 | `git worktree add <path> <branch>` | 없음 |
| dirty 판별 | `git status --porcelain` | 없음 |
| auto-save | `git add -A`, `git commit -m <message> --no-verify` | 없음 |
| 보존 여부 | `git rev-list --count <base>..<branch>` | 없음 |
| goal branch 검증/승격 | `git check-ref-format <ref>`, `git branch -f -- <target> <source>` | 없음 |
| goal diff 기준 | `git merge-base HEAD <source>` | 없음 |
| goal diff | `git diff --stat <range>` | 없음 |
| worktree 제거/복구 | `git worktree remove <path> --force`, `git worktree prune` | 없음 |
| worktree 목록 | `git worktree list --porcelain` | 없음 |
| harvest diff | `git diff --no-ext-diff --no-textconv --no-color <base>...<branch> --stat`, 같은 명령의 `--name-only` 변형 | `GIT_EXTERNAL_DIFF=""`, `GIT_TEXTCONV_DIFF=""` |

`git commit` 때문에 author/committer identity와 사용자 config가 필요하다.
`--no-verify`는 commit hook만 건너뛸 뿐, 사용자 identity·credential·signing
설정을 없애지 않는다.

### `harvestService.js`

materialized workspace용 helper는 모든 명령에 `GIT_EXTERNAL_DIFF=""`,
`GIT_TEXTCONV_DIFF=""`, `LC_ALL=C`, `LANG=C`를 명시한다.

| 기능 | 실제 argv |
|---|---|
| stat | `git -C <workspace> diff --stat <resolvedCommit> -- .` |
| 파일 목록 | `git -C <workspace> diff --name-only -z <resolvedCommit> -- .` |
| untracked 목록 | `git -C <workspace> status --porcelain -z -- .` |
| materialized worktree 제거 | `git -C <cache> worktree remove --force -- <workspace>` |
| materialized metadata 정리 | `git -C <cache> worktree prune` |
| legacy commit 목록 | `git log --no-color --oneline --max-count=101 <base>..<branch>` |

legacy commit 목록은 `GIT_EXTERNAL_DIFF=""`, `GIT_TEXTCONV_DIFF=""`만
명시하며, legacy diff와 auto-save는 `worktreeService`의 명령을 재사용한다.
`harvestService`의 test runner spawn은 **두 경로로 갈린다.** 교차검토에서
지적되어 정정한다 — 초안은 둘을 뭉뚱그려 "무관" 이라고 단언했는데 절반만 맞았다.

- **legacy 폴더 경로** (`runTestCommand`): `child_process.spawn` 을 직접 쓰므로
  이 정책과 정말 무관하다.
- **materialized(git repo) 경로** (`runExecutorTestCommand`): git 호출과
  **같은 `executor.exec`** 를 쓴다. 따라서 이 정책의 영향을 그대로 받는다.

프로젝트가 선언한 `test_command` 는 git 호출이 아니라 에이전트가 수정할 수 있는
임의 코드다. 따라서 Console의 전체 `process.env`를 상속하면 `PALANTIR_TOKEN`,
모델 API key 등 제어면 시크릿을 그대로 읽을 수 있다. 반대로 Git 전용 목록만
쓰면 `NODE_ENV`, 버전 매니저 루트, virtualenv 같은 테스트 런타임을 잃는다.

`PROJECT_TEST_ENV_KEYS`는 이 두 경계를 분리한 별도 양성 목록이다. harvest는
`exec(..., { projectTest: true })`만 요청하고, 로컬·원격 executor 모두 이
목록으로 다시 만든 환경에서 실행한다. 원격 public exec의 기본 명령 목록은
계속 `['git']`이며, `projectTest: true`일 때만 정확한 `/bin/sh`를 허용한다.
`inheritFullEnv` 분기와 전체 환경 병합은 없다.

## 최종 allowlist와 각 키의 근거

규범적 소스는 `server/services/execEnvPolicy.js`의 `EXEC_ENV_KEYS`와
`PROJECT_TEST_ENV_KEYS`다.
로컬은 컨트롤 플레인 env에서 이 목록만 선택하고, 원격은 pod login env에서
같은 목록만 `env -i`에 재구성한다.

| 정확한 키 | 보존 이유 | 코드/문서 근거 |
|---|---|---|
| `PATH`, `Path` | 서비스가 `git`을 bare name으로 실행하며 Git도 `ssh`와 credential/remote helper를 찾는다. Windows 서비스의 실제 키 casing인 `Path`도 보존한다. | 세 서비스의 `executor.exec('git', ...)`; [Node `execFile`](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback), [git(1) `PATH`](https://git-scm.com/docs/git#Documentation/git.txt-codePATHcode) |
| `HOME` | clone/fetch/commit에 필요한 `~/.gitconfig`, credential helper 설정, `~/.ssh/config`와 known_hosts를 찾는다. | project materialization의 원격 Git 명령과 worktree auto-save commit; [git-config FILES](https://git-scm.com/docs/git-config#FILES), [ssh(1) FILES](https://man.openbsd.org/ssh.1#FILES) |
| `XDG_CONFIG_HOME` | HOME과 같은 user-scoped Git config/credential store의 XDG 위치다. | 같은 clone/fetch/commit 경로; [git-config FILES](https://git-scm.com/docs/git-config#FILES) |
| `HOMEDRIVE`, `HOMEPATH`, `USERPROFILE` | Windows에서 HOME이 없을 때 user Git config 위치를 계산하는 fallback이다. | 플랫폼 공용 local executor; [git(1) System env](https://git-scm.com/docs/git#Documentation/git.txt-codeHOMEcode) |
| `SystemRoot`, `SYSTEMROOT`, `WINDIR`, `ComSpec`, `COMSPEC`, `PATHEXT` | Windows에서 Git/SSH와 `.cmd` credential helper가 실행 파일을 찾고 command shell을 시작하는 process-launch baseline이다. | `actorTokenPolicy.PROCESS_BASE_ENV_KEYS`의 기존 Windows subprocess 계약과 동일 |
| `LANG`, `LANGUAGE`, `LC_ALL`, `LC_ADDRESS`, `LC_COLLATE`, `LC_CTYPE`, `LC_IDENTIFICATION`, `LC_MEASUREMENT`, `LC_MESSAGES`, `LC_MONETARY`, `LC_NAME`, `LC_NUMERIC`, `LC_PAPER`, `LC_TELEPHONE`, `LC_TIME` | stderr 분류와 Git 출력/파일명 처리가 locale에 의존한다. 결정적 출력이 필요한 호출은 코드가 `LC_ALL=C`, `LANG=C`로 override한다. | `projectMaterializationService`, `worktreeService`, `harvestService`의 locale override |
| `TMPDIR`, `TMP`, `TEMP` | clone/index/diff/helper가 쓰기 가능한 node-local 임시 위치를 사용한다. 세 이름은 POSIX/macOS 및 Windows 실행기를 함께 지원한다. | materialization의 clone/fetch/worktree와 2026-07-29 호스트의 실제 `TMPDIR` |
| `SSH_AUTH_SOCK` | clone/fetch/ls-remote의 SSH 인증을 key 값이나 실행 helper 없이 agent socket으로 제공한다. | project materialization의 원격 전송 명령; [ssh-agent(1) ENVIRONMENT](https://man.openbsd.org/ssh-agent.1#ENVIRONMENT) |
| `GIT_ASKPASS` | node-local helper가 private HTTPS 저장소의 유일한 비대화식 credential source일 수 있다. | 실제 자체 서명 HTTPS + Basic auth 저장소를 materialize하며 Username/Password askpass 호출과 인증 재시도를 검증 |
| `http_proxy`, `https_proxy`, `ftp_proxy`, `all_proxy`, `no_proxy`, `HTTP_PROXY`, `HTTPS_PROXY`, `FTP_PROXY`, `ALL_PROXY`, `NO_PROXY` | HTTP(S) clone/fetch/ls-remote가 node의 proxy/no-proxy 경로를 유지한다. 대소문자 양쪽은 libcurl 소비자 호환용이다. | project materialization의 원격 전송 명령; [Git FAQ: proxies](https://git-scm.com/docs/gitfaq#Documentation/gitfaq.txt-HowdoIconfigureaproxyforGit) |
| `CURL_CA_BUNDLE`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH` | 사내 CA를 쓰는 HTTPS clone/fetch를 지원하되 인증서 검증을 끄지는 않는다. | project materialization의 HTTPS 전송 명령; [curl environment](https://curl.se/docs/manpage.html#ENVIRONMENT), [git-config `http.sslCAInfo`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpsslCAInfo) |
| `EMAIL`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | `worktreeService`의 `git commit -m ... --no-verify`가 editor 없이 auto-save commit identity를 구성한다. HOME config가 없는 CI도 지원한다. | `worktreeService.js` auto-save commit; [git(1) Git Commits env](https://git-scm.com/docs/git#Documentation/git.txt-codeGITAUTHORNAMEcode) |

## 보안 검토에서 ambient 상속을 제거한 키

명시적 override는 로컬에서 filtered env 뒤에 병합되고, 원격에서 pod env를
수집한 `"$@"` 뒤에 배치된다. 따라서 기존 넓은 후보 목록에서도
materialization의 명시적 BatchMode 값이 ambient 값에 덮이지는 않았다.
그러나 다른 `exec`에서 실행 벡터가 되며, 호출부가 ambient 값을 요구하지
않으므로 다음을 제거했다.

| 제거한 키 | 판단 근거 |
|---|---|
| `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_PROXY_COMMAND`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `DISPLAY`, `GIT_SSH_VARIANT` | executable/helper 선택이다. materialization과 repo preflight가 필요한 `GIT_TERMINAL_PROMPT=0` 및 BatchMode `GIT_SSH_COMMAND`를 직접 넘긴다. ambient `GIT_TERMINAL_PROMPT`도 필요 없어 제거했다. `GIT_ASKPASS`는 실제 private HTTPS 회귀 때문에 보존 목록으로 이동했다. |
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM` | `core.sshCommand` 같은 임의 command-scope config를 주입하거나 config source를 교체할 수 있다. 호스트에서 COUNT family가 관측됐지만 서비스 코드가 요구하지 않으며, 필요한 node-local config는 `HOME`/`XDG_CONFIG_HOME`으로 읽는다. |
| `GIT_SSL_NO_VERIFY` | HTTPS 인증서 검증을 조용히 비활성화한다. 코드가 요구하지 않는다. CA 경로 변수만 남겼다. |
| `GIT_EXTERNAL_DIFF`, `GIT_TEXTCONV_DIFF`, `GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE` | diff helper 실행 벡터다. harvest/worktree는 필요한 두 값을 명시적으로 빈 문자열로 넘기고 `--no-ext-diff`/`--no-textconv`도 사용한다. ambient 상속은 필요 없다. |
| `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `EDITOR`, `VISUAL`, `GIT_PAGER`, `PAGER` | executable 선택이다. commit은 `-m`을 사용하고 rebase/sequence 편집 호출이 없으며 출력은 pipe로 수집한다. |
| `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR` | subprogram/template 선택으로 실행 표면을 넓힌다. 서비스는 표준 Git subcommands만 쓰며 코드상 override 필요가 없다. |
| repository redirect, pathspec, protocol, trace, date, tuning 계열의 나머지 `GIT_*` 후보 | 호출부가 필요로 하지 않으며 저장소 선택/출력/파일 쓰기/전송 정책을 ambient에서 바꿀 이유가 없다. bare `GIT_*` prefix 대신 위 최종 표의 identity/CA 키만 남겼다. |

## 호스트 실측과 재생

2026-07-29, macOS arm64, Node `v22.22.2`, Git `2.39.1`에서 측정했다.

- `git` 실제 위치: `/opt/homebrew/bin/git`. 따라서 이 호스트에서는 `PATH`
  제거 시 `/usr/bin` 기본 탐색으로 다른 Git을 선택하거나 fixture Git을 찾지
  못하는 회귀가 생긴다.
- 관련 ambient key로 `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`,
  `TMPDIR`, `SSH_AUTH_SOCK`, `SSH_ASKPASS`, `GIT_ASKPASS`,
  `GIT_CONFIG_COUNT/KEY_0/KEY_1/VALUE_0/VALUE_1`, `GIT_EDITOR`,
  `GIT_PAGER`, `GIT_TERMINAL_PROMPT`가 실제 존재했다. 관측은 허용 근거로
  간주하지 않았으며, 이 중 실행/config 주입 벡터는 최종 목록에서 제거했다.
- global/system config에는 `osxkeychain`과 `gh auth git-credential` helper,
  global user name/email이 실제 등록돼 있었다. 즉 `HOME`과 `PATH`는 단순
  이론상 후보가 아니다.
- 최초 후보 키만 가진 `env -i`에서 이 감사에 나열한 command family를 실제
  로컬 저장소에 재생했다. clone, fetch, rev-parse, ls-remote, materialized
  worktree add/diff/status/remove/prune, legacy branch/worktree/status/add/commit,
  rev-list/check-ref-format/merge-base/diff/log/list/remove/prune/branch delete가
  모두 통과했다: `filtered git audit suite: PASS`. 이후 위험 키를 제거한 최종
  정책은 아래 실제 프로젝트 스위트(실 Git worktree/commit 포함)로 재검증했다.
- 재생은 실제 작업 트리 밖의 OS 임시 디렉터리
  `/var/folders/jb/f4llg5ls6cx65p1j5557y2v00000gr/T/tmp.6zgU2wQ24i`에서
  수행했고 제품 저장소 파일은 변경하지 않았다.

최초 재생은 후보 목록의 회귀 탐색 자료이고, 최종 정책의 합격 근거는 최종
`npm test`다. 추가로 실제 Git, 자체 서명 HTTPS 서버, Basic 인증 challenge,
실행 가능한 askpass helper를 묶어 materialization을 수행했다. 최초 요청은
401이고 Git이 askpass의 Username/Password 응답으로 재시도해 worktree의
파일까지 읽히는 것을 확인했다.

## 테스트와 뮤테이션 검출

- 최종 `npm test`: tests `2966`, suites `6`, pass `2966`, fail `0`.
- 핵심 정책/materialization/remote 묶음:
  `node --test server/tests/node-executor.test.js
  server/tests/project-materialization.test.js
  server/tests/remote-spawn-env.test.js
  server/tests/remote-ssh-executor.test.js
  server/tests/harvest-materialized.test.js` → tests `153`, pass `153`, fail `0`.
- project-test 로컬 환경을 `{ ...process.env, ...env }`로 되돌리면 실제 harvest
  probe에서 `PALANTIR_TOKEN=control-plane-secret`,
  `ANTHROPIC_API_KEY=model-secret`이 검출되어 tests `1`, fail `1`. 원복 후
  tests `1`, pass `1`.
- 원격 `/bin/sh` 예외를 제거하면 실제 harvest가
  `Remote exec command is not allowed: /bin/sh`를 기록하여 tests `1`, fail `1`.
  원복 후 tests `1`, pass `1`.
- Windows process-launch 키를 제거하면 결과가 `USERPROFILE`만 남아 tests `1`,
  fail `1`. 원복 후 tests `1`, pass `1`.
- `GIT_ASKPASS`를 제거하면 실제 원격 HTTPS materialization이 exit `128`,
  `could not read Username ... terminal prompts disabled`로 tests `1`, fail `1`.
  원복 후 tests `1`, pass `1`.
- harvest의 `projectTest: true`를 제거하면 double의 소비자 계약 단언과 실제
  remote harvest가 함께 실패해 tests `2`, fail `2`. 원복 후 tests `2`,
  pass `2`.
- 원격 project-test 전용 env 선택을 Git 목록으로 되돌리면 실제 test의
  `NODE_ENV`가 null이 되고 script 계약에서도 `USER`가 빠져 tests `2`,
  fail `2`. 원복 후 tests `2`, pass `2`.

## 남은 검증 경계

이 워크트리에는 원격 Pi 노드가 없다. private HTTPS + askpass 인증은 실제
remote SSH executor의 loopback transport로 materialization 전체를 수행했고,
pod login env에서 키를 선택하는 스크립트까지 함께 실행했다. 다만 실제 Pi의
login env/SSH agent 상태를 포함한 운영 노드 검증은 별도이며, 없는 Pi 검증을
완료로 간주하지 않는다.
