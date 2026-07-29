# 실행 주체별 권한 지형

이 문서는 Palantir가 모델 실행 주체를 시작할 때 코드로 부여하는 권한을 정리한다.
운영 머신의 별도 컨테이너·OS 정책이나 사용자가 수정한 에이전트 프로필은 추정하지
않는다. 따라서 프로필의 `args_template`에 권한 플래그를 맡기는 경로는 특정
샌드박스 상태로 단정하지 않고 `프로필 의존`으로 표시한다.

현재 런타임 권한을 판단할 때는 이 문서를 기준으로 하며, 과거 설계를 보존한
`docs/specs/manager-v3-multilayer.md`의 role-based sandbox 제안은 현재 동작을
설명하지 않는다.

또한 `bypassPermissions`와 파일시스템 샌드박스 해제는 구분한다. 전자는 Claude
Code의 승인 절차를 우회하는 설정이고, `allowedTools`가 함께 전달되면 도구 표면은
별도로 제한된다. Git worktree도 변경 격리·수집 경계이지 OS 샌드박스는 아니다.

| 실행 주체 | 코드가 설정하는 승인·샌드박스 상태 | 별도 권한 경계 | 코드 근거 |
|---|---|---|---|
| Codex Operator 매니저 | 역할과 무관하게 `--dangerously-bypass-approvals-and-sandbox`를 항상 전달한다. Codex 승인과 파일시스템 샌드박스가 모두 우회된다. 매니저가 Console API를 호출하려면 네트워크가 필요하고 `--full-auto` 샌드박스가 이를 막는다는 것이 코드의 사유다. | materialized workspace가 있으면 그 경로를 cwd로 쓴다. 그렇지 않은 local Operator는 `project.directory`를 쓰고, directory가 없으면 `resolveSpawnCwd`의 fallback인 `process.cwd()` — **Console 서버 자신의 소스 디렉터리** — 를 쓴다. 따라서 directory 없는 local Operator의 cwd는 기본 Top과 동일하다. remote Operator는 `project.directory`가 있으면 그 pod 경로를 cwd로 전달하고, 없으면 `null`을 전달한다. 직접 수정은 기술적으로 가능하지만 시스템 프롬프트 정책으로 worker 위임을 요구한다. | `server/services/managerAdapters/codexAdapter.js:279-282`, `server/services/managerAdapters/codexAdapter.js:490-501`, `server/services/operatorSpawnService.js:721-733`, `server/utils/spawnCwd.js:42-49` |
| Codex Top 매니저 | Operator와 동일하게 bypass를 항상 전달한다. | Top spawn은 `cwd`를 요청 본문의 선택 필드로 받는데 UI는 이 값을 보내지 않고, boot resume 경로는 아예 넘기지 않는다. 명시적 cwd가 없으면 `resolveSpawnCwd`가 `process.cwd()` — **Console 서버 자신의 소스 디렉터리** — 를 반환한다. 프로젝트 디렉터리에 결합된 Operator와는 cwd가 다르지만, directory 없는 local Operator와는 같다. | `server/routes/manager.js:643`, `server/routes/manager.js:217`, `server/utils/spawnCwd.js:42-49` |
| Claude Top / Operator 매니저 | `permissionMode` 기본값으로 `bypassPermissions`를 전달한다. 코드에서 별도 파일시스템 샌드박스를 설정하지 않는다. | 기본 내장 도구는 `Bash(curl/jq/ls/pwd)`, `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`로 제한하고, 프로필의 MCP 도구만 합친다. 따라서 승인 우회 상태여도 Codex 매니저보다 도구 표면이 좁다. | `server/services/managerAdapters/claudeAdapter.js:265-290`, `server/services/streamJsonEngine.js:150-155` |
| Claude worker | `permissionMode: 'bypassPermissions'`를 명시한다. 코드에서 별도 파일시스템 샌드박스를 설정하지 않는다. | 프로필에 MCP 도구가 있을 때만 그 목록을 `allowedTools`로 넘기며, 없으면 서버가 도구 allowlist를 지정하지 않는다. 로컬 Git 프로젝트는 실행 전에 run 전용 worktree를 만든다. | `server/services/lifecycleService.js:1453-1475`, `server/services/lifecycleService.js:1654-1665` |
| Codex worker | 샌드박스·승인 플래그는 에이전트 프로필의 편집 가능한 `args_template`에 의존한다. 서버가 공통으로 추가하는 Codex 인자는 모델·reasoning effort·standard service tier이며, 매니저용 bypass 플래그를 worker 경로에 강제 주입하지 않는다. 따라서 코드만으로 모든 Codex worker가 sandboxed 또는 unsandboxed라고 단정할 수 없다. | 로컬 Git 프로젝트는 run 전용 worktree를 사용한다. 최종 CLI 인자는 프로필 템플릿에서 만든 인자와 서버 추가 인자를 합쳐 실행한다. | `server/services/lifecycleService.js:1453-1475`, `server/services/lifecycleService.js:1792-1818`, `server/services/lifecycleService.js:1991-2004`, `server/services/lifecycleService.js:2081-2082` |
| 그 밖의 CLI worker | 권한 플래그를 포함한 실행 인자를 프로필의 `args_template`에서 만든다. 서버 차원의 공통 샌드박스 강제는 없으므로 실제 상태는 프로필 의존이다. | 로컬 Git 프로젝트의 run 전용 worktree와 필터된 worker 환경을 사용한다. | `server/services/lifecycleService.js:1453-1475`, `server/services/lifecycleService.js:1814-1818`, `server/services/lifecycleService.js:1832-1854`, `server/services/lifecycleService.js:1961-1988` |
| Folder-less specialist | CLI를 시작하지 않고 Anthropic Messages API를 직접 호출하므로 CLI 샌드박스/bypass 플래그가 없다. | capability에서 도구를 가산식으로 구성한다. 현재 등록된 유일한 도구는 읽기 전용 메타데이터 검색이며 shell·filesystem·network·MCP 도구는 등록하지 않는다. 모델의 `tool_use`마다 allowlist를 다시 검사한다. | `server/services/specialistBackend.js:41-50`, `server/services/specialistBackend.js:242-253`, `server/services/specialistBackend.js:280-286` |

이 표에서 명시적으로 파일시스템 샌드박스를 해제하는 실행 주체는 Codex
Top/Operator 매니저다. 둘의 파일 노출 범위는 cwd 결합에 따라 달라진다. 기본
Top과 directory 없는 local Operator는 모두 Console 서버 소스 트리를 cwd로
쓰며, 프로젝트 디렉터리에 결합된 Operator만 cwd가 다르다. 다만 cwd는 OS
샌드박스가 아니므로 Top이 언제나 더 좁거나 넓다고 단정할 수 없다. Claude
매니저와 Claude worker는 승인 절차를 우회하지만 동일한 Codex bypass 플래그를
쓰는 경로가 아니며, Codex 및 기타 CLI worker는 프로필 인자에 따라 달라진다.
