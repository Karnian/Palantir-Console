# T4: harvest test_command 의 프로젝트별 node 해석

> 2026-06-14. Status: **draft r1** (Codex spec review 전)
> 작성: Claude (감독). 구현: Codex. branch: `feat/t4-harvest-node-resolve`
> 배경: PR #188 (harvest-fix) 가 test_command 를 "서버를 띄운 node" 로 실행하게 했으나, 멀티프로젝트
> 허브에서 **서버와 다른 node 를 요구하는 프로젝트** 는 여전히 ABI 불일치. backlog T4.

---

## 1. 현재 코드 사실 + 환경

- `buildHarvestEnv()` (인자 없음, `harvestService.js:37`): PATH 앞에 `path.dirname(process.execPath)`
  (= 서버 node) + homebrew/usr 경로. `runTestCommand({command, cwd, testRunner})` 가 호출 (`:76`),
  `cwd = run.worktree_path` (`:312`). 즉 worktreePath 를 buildHarvestEnv 에 넘기면 `.nvmrc` 읽기 가능.
- **이 환경엔 fnm/nvm/asdf 없음.** node 버전 관리는 **homebrew `node@N` formula** —
  `/opt/homebrew/opt/node@20`, `node@22`, `node@26` 설치됨. 즉 per-project node 의 현실적 소스는
  `/opt/homebrew/opt/node@<major>/bin`.
- 프로젝트 node 선언: `.nvmrc` (예 `22` / `v22.1.0`) 또는 `package.json` `engines.node` (예 `^22`, `>=20`).

## 2. 목표 (Small~Medium)

harvest 가 test_command 를 실행할 때, **프로젝트가 선언한 node 버전** 의 node 를 (찾을 수 있으면) 사용한다.
못 찾으면 현재 동작(서버 node) fallback + 경고. 단일 프로젝트(콘솔 자신)는 동작 불변.

## 3. Lock-in

1. **fallback 안전**: 프로젝트 node 선언 없거나 해당 major 의 node 를 못 찾으면 → **서버 node**
   (현재 PR #188 동작) 로 fallback. harvest 가 깨지지 않음 (never worse than 현재).
2. **resolver 주입**: node 탐색 로직은 주입 가능 (`createHarvestService({ nodeResolver })`). 기본은
   homebrew `node@N`. fnm/nvm 환경은 후속 (resolver 교체로 확장 — 현재 환경에 없음).
3. **major 만 매칭**: `.nvmrc=22.1.0` 이어도 major(22) 로 node@22 매칭. patch/minor 정밀 매칭 안 함 (B-lite).
4. **읽기 실패 안전**: `.nvmrc`/`package.json` 파싱 실패는 fallback (throw 안 함). harvest never-throws 유지.
5. **단일 프로젝트 무변경**: 콘솔 자신(.nvmrc=22, 서버=node@22)은 resolve 결과가 서버 node 와 동일 →
   기존 테스트/도그푸딩 동작 불변.

## 4. 구현 지침

### 4.1 `harvestService.js`
- **`resolveProjectNodeMajor(worktreePath)`** → `number | null`:
  1. `<worktreePath>/.nvmrc` 존재 → 내용 trim, 첫 `v?` 제거, `\d+` 첫 그룹 = major.
  2. 없으면 `<worktreePath>/package.json` 의 `engines.node` → semver range 에서 첫 정수 major
     (`^22`/`>=20`/`22.x`/`22` → 22). 파싱 실패/부재 → null.
  3. 모든 fs/parse 실패 → null (fallback).
- **`defaultNodeResolver(major)`** → `binDir | null`:
  - `/opt/homebrew/opt/node@<major>/bin` 에 실행가능 `node` 존재하면 그 dir 반환, else null.
  - (PALANTIR_NODE_PREFIX env 로 prefix override 가능하게 — 비-homebrew 환경/테스트. 기본
    `/opt/homebrew/opt`.) 즉 `<prefix>/node@<major>/bin/node`.
- **`buildHarvestEnv(worktreePath, nodeResolver)`** (시그니처 확장, 기존 무인자 호출은 worktreePath
  undefined → 현재 동작):
  - `major = worktreePath ? resolveProjectNodeMajor(worktreePath) : null`
  - `projectNodeBin = (major != null && nodeResolver) ? nodeResolver(major) : null`
  - `extraPaths = [ projectNodeBin || path.dirname(process.execPath), '/opt/homebrew/bin', ... ]`
  - projectNodeBin 이 서버 node dir 와 다르면(실제 override) → 호출자가 알 수 있게 반환값에 표식? →
    간단히: buildHarvestEnv 는 env 만 반환(현행), resolve 여부는 runTestCommand 가 별도 계산해
    harvest:test payload 에 `node_major`/`node_source: 'project'|'server'` 기록 (관측용).
- **`runTestCommand({ command, cwd, testRunner, nodeResolver })`**: `buildHarvestEnv(cwd, nodeResolver)`.
  resolve 결과(major, source)를 결과에 포함 → harvestRun 이 harvest:test payload 에 추가.
- **`createHarvestService({ ..., nodeResolver = defaultNodeResolver })`**: runTestCommand 에 전달.
- major 명시인데 node@major 못 찾음 → fallback(서버 node) + `harvest:test` 에 `node_resolve: 'fallback'`
  + 단계 경고 (addError 'node_unresolved' annotate, harvest 계속).

### 4.2 비-homebrew 일반화 (최소)
- `PALANTIR_NODE_PREFIX` (기본 `/opt/homebrew/opt`) — `<prefix>/node@<major>/bin`. fnm/nvm 은 후속
  (resolver 주입으로 교체 가능하게 설계만, 구현은 homebrew).

## 5. 비범위
| 항목 | 이유 |
|---|---|
| fnm/nvm/asdf 통합 | 현재 환경에 없음. resolver 주입점만 열어둠 |
| patch/minor 정밀 매칭 | major 면 ABI 충분 (node ABI 는 major 단위) |
| node 자동 설치 | 없으면 fallback. 설치는 운영자 |
| .node-version / volta 등 타 선언 | .nvmrc + engines 로 시작 |
| per-test_command node override | 프로젝트 단위로 충분 |

## 6. 수용 기준
1. worktree 에 `.nvmrc=20` + node@20 존재 → test_command 가 node@20 으로 실행 (PATH 첫 node = node@20).
2. `.nvmrc` 없고 `engines.node='^20'` → 동일하게 node@20 resolve.
3. node 선언 없음 → 서버 node (현재 동작).
4. `.nvmrc=20` 인데 node@20 미설치 → 서버 node fallback + `harvest:test` node_resolve='fallback' + 경고.
5. 콘솔 자신(.nvmrc=22, 서버 node@22) → resolve = 서버 node, 동작·기존 테스트 불변.
6. 파싱 실패(.nvmrc 깨짐) → fallback, harvest never-throws.
7. harvest:test payload 에 node 출처(project/server/fallback) 관측 필드.
8. 전체 `node --test` 그린 + harvest.test 확장.

## 7. 테스트 지침
- `nodeResolver` 주입 (fake): major→fake bin dir 매핑. 실제 /opt/homebrew 안 의존.
- 케이스: .nvmrc major / engines major / 둘 다 없음 fallback / node@major 없음 fallback /
  .nvmrc 우선(.nvmrc + engines 동시) / 파싱 실패 fallback / 콘솔-자신 동등(서버 node) / payload node 필드.
- buildHarvestEnv 단위: worktreePath + nodeResolver → PATH 첫 엔트리 검증 (PR #188 PATH-walk 테스트 확장).
- 기존 harvest 테스트(서버 node 경로) 회귀 — worktreePath 없거나 resolver null 이면 현행.

## 8. 구현 순서
1. resolveProjectNodeMajor + defaultNodeResolver + buildHarvestEnv(worktreePath, nodeResolver)
2. runTestCommand/createHarvestService nodeResolver 배선 + harvest:test payload node 필드
3. harvest.test 확장 (nodeResolver 주입)
4. 검증: harvest.test → 회귀(queue/preset/lifecycle) → 전체 --test-concurrency=2
