# T4: harvest test_command 의 프로젝트별 node 해석

> 2026-06-14. Status: **r2 READY** (Codex r1 spec review 반영 — SERIOUS Q2/Q3 + NIT 3)
> 작성: Claude (감독). 구현: Codex. branch: `feat/t4-harvest-node-resolve`
> 배경: PR #188 (harvest-fix) 가 test_command 를 "서버를 띄운 node" 로 실행하게 했으나, 멀티프로젝트
> 허브에서 **서버와 다른 node 를 요구하는 프로젝트** 는 여전히 ABI 불일치. backlog T4.
>
> **r2 핵심 변경 (Codex r1)** — "서버 node 우선" 정책으로 Q2(느슨 파싱)+Q3(퇴행) 동시 해소:
> - 프로젝트 선언을 읽되, **서버 node major 가 그 선언을 만족하면 서버 node 유지** (전환 안 함).
>   명확히 *다른* 단일 major 를 요구할 때만 그 node 로 전환. → `>=20`+서버@22 = 서버 유지(퇴행 0),
>   `.nvmrc=20`+서버@22 = node@20 전환(T4 의 진짜 가치).
> - 파싱은 **명확한 단일 major 만** 인식 (anchored regex). range/복합/비숫자(`foo22`,`lts/*`,`>=20 <23`,
>   `||`) → null → 서버 node fallback (Q2). 단일 major 도 서버와 같으면 서버 유지 (Q3).
> - 읽기 크기 제한 + symlink/parse catch (Q5), resolver/read throw → null (Q6 never-throws), env 테스트 restore (Q4).

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

1. **서버 node 우선 (퇴행 0)**: 프로젝트 선언을 서버 node major 가 만족하면 **서버 node 유지**. 명확히
   다른 단일 major 일 때만 전환. → 현재 성공 케이스가 절대 다른 node 로 안 내려감 (Q3).
2. **명확 단일 major 만 인식**: range/복합/비숫자(`>=20 <23`, `lts/*`, `foo22`, `||`) → null → 서버 node.
   anchored 파싱 (Q2). 정밀 range 매칭(semver)은 후속.
3. **fallback 안전**: 선언 없음 / 다른 major 인데 node@major 미설치 / 파싱·읽기 실패 → **서버 node**
   (PR #188 동작). never worse than 현재.
4. **resolver 주입**: `createHarvestService({ nodeResolver })`. 기본 homebrew `node@N`. fnm/nvm 후속.
5. **never-throws**: 모든 read/parse/resolve 는 내부 catch → null. harvest 절대 안 깸 (Q6).
6. **단일 프로젝트 무변경**: 콘솔 자신(.nvmrc=22, 서버 node@22) → 서버 major==선언 major → 서버 node 유지.

## 4. 구현 지침

### 4.1 `harvestService.js`
- **상수**: `SERVER_NODE_MAJOR = parseInt(process.versions.node, 10)` (예 22). `MAX_DECL_BYTES = 1MB`.
- **`resolveDeclaredNodeMajor(worktreePath)`** → `number | null` (선언된 단일 major, 못 뽑으면 null):
  1. `<worktreePath>/.nvmrc` (크기 ≤ MAX_DECL_BYTES, symlink/read 실패 catch): trim 후
     **anchored** `^v?(\d+)(?:\.\d+){0,2}$` 매칭 → group1 major. (`foo22`/`lts/*`/`node` → 불일치 → null.)
  2. 없으면 `<worktreePath>/package.json` (크기 제한, JSON.parse catch) 의 `engines.node`:
     **단일 major 형태만** — `^v?(\d+)(\.\d+|\.x)?` exact / `^\^v?(\d+)/` caret / `^~v?(\d+)/` tilde.
     **range/복합** (`>=`, `<`, `>`, 공백 2개 이상, `||`, ` - `) → null (서버 node 가 만족한다고 가정, 보수적).
  3. 모든 fs/parse 실패 → null.
- **`defaultNodeResolver(major)`** → `binDir | null`:
  - `<prefix>/node@<major>/bin` 에 실행가능 `node` 존재하면 그 dir, else null.
    `prefix = process.env.PALANTIR_NODE_PREFIX || '/opt/homebrew/opt'`.
- **`resolveProjectNode(worktreePath, nodeResolver)`** → `{ binDir, major, source }`:
  - `declared = resolveDeclaredNodeMajor(worktreePath)`
  - declared == null → `{ binDir: null, major: SERVER_NODE_MAJOR, source: 'server' }` (선언 없음/모호).
  - **declared === SERVER_NODE_MAJOR → `{ binDir: null, major: declared, source: 'server' }`** (서버 만족 — 퇴행 0).
  - declared !== SERVER → `bin = nodeResolver(declared)`:
    - bin 있으면 `{ binDir: bin, major: declared, source: 'project' }`.
    - 없으면 `{ binDir: null, major: declared, source: 'fallback' }` (요구 node 미설치 → 서버 node).
  - 전체 try/catch → 실패 시 `{ binDir: null, major: SERVER_NODE_MAJOR, source: 'server' }` (never-throws).
- **`buildHarvestEnv(worktreePath, nodeResolver)`** (시그니처 확장; 무인자 호출 = 현행 서버 node):
  - `const { binDir } = worktreePath ? resolveProjectNode(worktreePath, nodeResolver) : { binDir: null }`
  - `extraPaths = [ binDir || path.dirname(process.execPath), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin' ]`
- **`runTestCommand({ command, cwd, testRunner, nodeResolver })`**: `buildHarvestEnv(cwd, nodeResolver)`.
  resolveProjectNode 의 `{ major, source }` 를 결과에 포함.
- **`createHarvestService({ ..., nodeResolver = defaultNodeResolver })`**: runTestCommand 에 전달.
- harvest:test payload 에 `node_major`, `node_source ∈ {server, project, fallback}` 추가 (관측). source=
  'fallback' 시 단계 경고 (addError 'node_unresolved' annotate, harvest 계속).

### 4.2 비-homebrew / 신뢰 전제
- `PALANTIR_NODE_PREFIX` 로 prefix override (기본 `/opt/homebrew/opt`) — 운영자 신뢰 prefix. fnm/nvm 후속.
- worktree 의 `.nvmrc`/`package.json` 는 워커가 쓴 코드 — 단 **정수 major 만** 추출하므로 임의 경로 강제 불가
  (Q5). prefix + node@<정수> 조합만 PATH 에 삽입. test_command 자체가 이미 worktree 임의 실행이라 증분 위험 0.

## 5. 비범위
| 항목 | 이유 |
|---|---|
| fnm/nvm/asdf 통합 | 현재 환경에 없음. resolver 주입점만 열어둠 |
| patch/minor 정밀 매칭 | major 면 ABI 충분 (node ABI 는 major 단위) |
| node 자동 설치 | 없으면 fallback. 설치는 운영자 |
| .node-version / volta 등 타 선언 | .nvmrc + engines 로 시작 |
| per-test_command node override | 프로젝트 단위로 충분 |

## 6. 수용 기준
1. `.nvmrc=20`(서버≠20) + node@20 존재 → test_command 가 node@20 (PATH 첫 node=node@20), source='project'.
2. `.nvmrc` 없고 `engines.node='^20'`(서버≠20) → 동일하게 node@20.
3. **서버 만족 케이스 퇴행 0**: `engines.node='>=20'` + 서버@22 → **서버 node** (range 모호 → null → server).
   `.nvmrc=22` + 서버@22 → 서버 node. (Q3)
4. **오염/range 입력**: `.nvmrc='foo22'`/`'lts/*'`, `engines='>=20 <23'`/`'18 || 20'` → null → 서버 node. (Q2)
5. `.nvmrc=20`(서버≠20) 인데 node@20 미설치 → 서버 node fallback + node_source='fallback' + 경고.
6. node 선언 없음 → 서버 node. 콘솔 자신(.nvmrc=22, 서버@22) → 서버 node, 기존 테스트/도그푸딩 불변.
7. 파싱/읽기 실패(.nvmrc 깨짐, 거대 파일, symlink) → 서버 node, harvest never-throws.
8. harvest:test payload 에 `node_major` + `node_source ∈ {server,project,fallback}`.
9. 전체 `node --test` 그린 + harvest.test 확장.

## 7. 테스트 지침
- `nodeResolver` 주입 (fake): major→fake bin dir. 실제 /opt/homebrew 비의존. env 변경 시 반드시 restore (Q4).
- 케이스: .nvmrc 단일major(서버≠) → project / engines caret(서버≠) → project / **서버==선언 → server(퇴행0)** /
  range·복합·`foo22`·`lts/*` → server(Q2) / 다른major인데 resolver null → fallback / 선언없음 → server /
  파싱·거대파일·resolver throw → server(never-throws, Q6) / payload node_major·node_source.
- buildHarvestEnv 단위: worktreePath + fake nodeResolver → PATH 첫 엔트리 = project bin (PR #188 PATH-walk 확장).
- 회귀: 무인자/worktreePath 없음 → 현행 서버 node. 콘솔-자신 도그푸딩 동등.

## 8. 구현 순서
1. resolveDeclaredNodeMajor (anchored 파싱) + defaultNodeResolver + resolveProjectNode (서버 우선 정책)
2. buildHarvestEnv(worktreePath, nodeResolver) + runTestCommand/createHarvestService 배선 + payload node 필드
3. harvest.test 확장 (nodeResolver 주입, 서버-우선/퇴행0/오염입력/never-throws 케이스)
4. 검증: harvest.test → 회귀(queue/preset/lifecycle) → 전체 --test-concurrency=2

## 9. Codex r1 spec review 처리 기록
| 판정 | 내용 | r2 |
|---|---|---|
| Q1 PASS | 코드 사실 정확 (runTestCommand cwd 미전달은 배선 대상) | 유지 |
| Q2 SERIOUS | 느슨 파싱 (foo22→22, range→첫정수) | anchored 단일 major 만, range/복합 → null |
| Q3 SERIOUS | "never worse" 과장 (major+node존재 시 전환 퇴행) | 서버 node 우선 — 서버 만족 시 유지, 다른 major 만 전환 |
| Q4 NIT | env 테스트 restore | §7 명시 |
| Q5 NIT | 크기제한/symlink/prefix 신뢰 | §4.1 MAX_DECL_BYTES + catch, §4.2 신뢰 전제 |
| Q6 NIT | resolver throw 테스트 | resolveProjectNode 전체 try/catch + §7 케이스 |
