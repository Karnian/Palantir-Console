# Palantir Console

AI 코딩 에이전트(Claude Code, Codex, OpenCode)를 중앙에서 관리하는 관제 허브.

여러 프로젝트에서 여러 에이전트를 동시에 돌릴 때, 누가 뭘 하고 있는지, 어디서 막혔는지, 비용은 얼마인지를 한 화면에서 본다.

## 빠른 시작

```bash
# 설치
npm install

# 실행 (localhost:4177)
npm start

# 브라우저에서
open http://localhost:4177
```

기본적으로 인증 없이 `localhost`에만 바인딩된다. 외부 접근이 필요하면:

```bash
PALANTIR_TOKEN=my-secret-token npm start
# → 0.0.0.0:4177 에 바인딩, 모든 API에 Bearer 토큰 필요
# → 브라우저: http://host:4177?token=my-secret-token
```

## 핵심 개념

```
Project  →  Task  →  Run  →  Agent
 (묶음)    (할 일)  (실행)   (Claude/Codex/OpenCode)
```

| 개념 | 설명 |
|------|------|
| **Project** | 작업 묶음. 예: "백엔드 API", "프론트엔드 리팩토링" |
| **Task** | 구체적인 할 일. 칸반 보드에서 관리. 상태: Backlog → Todo → In Progress → Review → Done |
| **Run** | Task에 대해 에이전트를 실행한 기록. 하나의 Task에 여러 Run 가능 |
| **Agent Profile** | 실행할 에이전트 설정 (Claude Code, Codex CLI, OpenCode, 커스텀) |

## 화면 구성

### 1. Dashboard (◉)

**관제 허브.** 지금 바로 신경 써야 할 것만 보여준다.

- **Active** — 현재 실행 중인 에이전트 수
- **Needs Input** — 에이전트가 사용자 응답을 기다리는 중 (최우선)
- **Done Today** — 오늘 완료된 Run 수
- **Total Tasks** — 전체 Task 수

아래에 **Triage Feed**:
- Needs Input (가장 긴급) — "Respond" 버튼으로 바로 응답
- Failed — 실패한 Run, 재시도 가능
- Running — 정상 실행 중, "Inspect"로 실시간 로그 확인
- Review — 에이전트가 끝냈으니 결과 확인 필요

**아무 문제 없으면 "All clear" 표시.** 이 화면만 띄워놓으면 된다.

### 2. Task Board (⊞)

**칸반 보드.** 5개 컬럼으로 Task를 관리한다.

```
Backlog  →  Todo  →  In Progress  →  Review  →  Done
```

**기본 사용법:**
1. **`+ New Task`** 또는 키보드 **`N`** — 새 Task 생성
2. Task 카드를 **드래그**해서 컬럼 간 이동
3. Todo → In Progress로 드래그하면 **에이전트 실행 모달**이 열림
4. Task 카드를 **클릭**하면 상세 패널:
   - 전체 제목 / 설명 보기
   - Status, Priority, Project 변경 (Edit 버튼)
   - Run Agent — 에이전트 실행
   - 실행 이력 (Runs) 확인 → 클릭하면 Run Inspector
   - Delete

**필터:** 상단 드롭다운으로 프로젝트별/우선순위별 필터링.

### 3. Projects (▣)

프로젝트 목록. `+ New Project`로 생성.

프로젝트는 Task를 논리적으로 묶는 단위. Task 생성 시 프로젝트를 지정하면 보드에서 프로젝트 뱃지가 표시된다.

### 4. Manager (✦)

**중앙 오케스트레이터.** Claude Code CLI를 Manager 에이전트로 실행해 워커들을 관제한다.

- **40/60 분할 레이아웃**: 왼쪽 채팅(40%) + 오른쪽 워커 세션 그리드(60%)
- **Start Manager** — Manager 세션 시작. Claude Code가 stream-json 프로토콜로 multi-turn 대화
- **채팅** — Manager에게 상태 보고, 작업 위임, 실패 분석 등 지시
- **Stop** — Manager 세션 종료

Manager는 Palantir Console REST API를 curl로 직접 조회하여 실제 런/태스크 상태를 파악한다.

**기술 구현:**
- Claude Code CLI `--print --output-format stream-json --input-format stream-json` 모드
- OAuth 인증 자동 전달 (`.claude-auth.json` 메커니즘)
- 매 턴마다 result 이벤트가 발생하지만, Manager는 세션을 유지 (completed로 전환하지 않음)
- Health check에서 Manager 런을 건너뜀 (TmuxEngine 미사용)

### 5. Agents (⚙)

에이전트 프로필 관리. 기본 3개가 제공된다:

| 프로필 | 명령어 | 용도 |
|--------|--------|------|
| Claude Code | `claude` | Anthropic Claude Code CLI |
| Codex CLI | `codex` | OpenAI Codex CLI |
| OpenCode | `opencode` | OpenCode CLI |

`+ New Agent`로 커스텀 에이전트 추가 가능:
- **Command**: 실행할 CLI (`claude`, `codex`, `opencode`, `gemini` 중 하나)
- **Args Template**: 인자 템플릿. `{prompt}`가 실제 프롬프트로 치환됨
  - 예: `-p {prompt}` → `claude -p "Fix the auth bug"`
- **Max Concurrent**: 동시 실행 제한 (기본 3)

보안: 허용된 명령어만 실행 가능 (allowlist). `PALANTIR_ALLOWED_COMMANDS` 환경변수로 추가 가능.

## 에이전트 실행 흐름

```
1. Task Board에서 Task를 "In Progress"로 드래그
   (또는 Task 상세 → Run Agent)
        ↓
2. 에이전트 선택 + 프롬프트 입력 → "Start Agent"
        ↓
3. Run 생성 (queued → running)
   - tmux 세션에서 에이전트 실행 (서버에 tmux 필요)
   - 독립 git worktree에서 격리 실행
        ↓
4. Dashboard에서 실시간 모니터링
   - Running: 실행 중
   - Needs Input: 사용자 입력 대기
   - Failed: 실패 (재시도 가능)
        ↓
5. 완료 시 Task 자동으로 "Review"로 이동
        ↓
6. 결과 확인 후 "Done"으로 이동
```

## Run Inspector

Run을 클릭하면 열리는 상세 패널:

- **Status** — 현재 상태 (running/needs_input/completed/failed 등)
- **Events** — 상태 변경 이력 실시간 표시
- **Send Input** — `needs_input` 상태일 때 에이전트에게 텍스트 전달
- **Cancel** — 실행 중인 Run 취소

## 키보드 단축키

| 키 | 동작 |
|----|------|
| `Cmd+K` / `Ctrl+K` | Command Palette 열기 |
| `N` | 새 Task 생성 (Board 뷰에서) |
| `Esc` | 모달/패널 닫기 |
| `1`-`4` | Command Palette에서 빠른 뷰 전환 |

Command Palette (`Cmd+K`)에서 뷰 이동, 태스크 검색 가능.

## 실시간 업데이트 (SSE)

브라우저는 서버와 SSE(Server-Sent Events) 연결을 유지한다.

- Task/Run 상태가 바뀌면 **자동으로 UI가 갱신**됨
- `needs_input` / 완료 / 실패 시 **브라우저 알림**
- 좌측 하단 점: 초록=연결됨, 빨강=연결 끊김

## API

REST API로 외부에서 제어 가능. 인증 설정 시 `Authorization: Bearer <token>` 헤더 필요.

### Projects
```
GET    /api/projects          — 목록
POST   /api/projects          — 생성 { name, directory?, color? }
GET    /api/projects/:id      — 조회
PATCH  /api/projects/:id      — 수정
DELETE /api/projects/:id      — 삭제
GET    /api/projects/:id/tasks — 프로젝트의 태스크 목록
```

### Tasks
```
GET    /api/tasks              — 목록 (?project_id=, ?status=)
POST   /api/tasks              — 생성 { title, project_id?, priority?, description? }
GET    /api/tasks/:id          — 조회
PATCH  /api/tasks/:id          — 수정
PATCH  /api/tasks/:id/status   — 상태 변경 { status }
DELETE /api/tasks/:id          — 삭제
PATCH  /api/tasks/reorder      — 순서 변경 { orderedIds: [] }
POST   /api/tasks/:id/execute  — 에이전트 실행 { agent_profile_id, prompt? }
```

### Runs
```
GET    /api/runs               — 목록 (?task_id=, ?status=)
GET    /api/runs/:id           — 조회
GET    /api/runs/:id/events    — 이벤트 목록
GET    /api/runs/:id/output    — 실시간 출력 (tmux)
POST   /api/runs/:id/input     — 입력 전달 { text }
POST   /api/runs/:id/cancel    — 취소
DELETE /api/runs/:id           — 삭제
```

### Agents
```
GET    /api/agents             — 프로필 목록
POST   /api/agents             — 생성 { name, type, command, args_template?, max_concurrent? }
GET    /api/agents/:id         — 조회 (+ runningCount)
PATCH  /api/agents/:id         — 수정
DELETE /api/agents/:id         — 삭제
```

### Manager Session
```
POST   /api/manager/start      — Manager 시작 { prompt?, cwd?, model? }
POST   /api/manager/message    — Manager에 메시지 전송 { text }
GET    /api/manager/status     — Manager 상태 (active, run, usage, claudeSessionId)
GET    /api/manager/events     — Manager 이벤트 목록
GET    /api/manager/output     — Manager 출력 텍스트
POST   /api/manager/stop       — Manager 종료
```

### SSE / Health
```
GET    /api/events             — SSE 스트림 (task:*, run:*, manager:* 이벤트)
GET    /api/health             — 헬스체크
```

### Legacy (OpenCode 세션)
```
GET    /api/sessions           — 기존 OpenCode 세션 목록
GET    /api/sessions/:id       — 세션 메시지 조회
POST   /api/sessions/:id/message — 메시지 전송
```

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `4177` | 서버 포트 |
| `PALANTIR_TOKEN` | (없음) | 설정 시 Bearer 인증 활성화 + 외부 접근 허용 |
| `PALANTIR_ALLOWED_COMMANDS` | (없음) | 추가 허용 CLI 명령어 (쉼표 구분) |
| `OPENCODE_STORAGE` | `~/.local/share/opencode/storage` | OpenCode 세션 저장소 경로 |
| `OPENCODE_BIN` | `opencode` | OpenCode 바이너리 경로 |
| `OPENCODE_FS_ROOT` | `$HOME` | 디렉토리 피커 루트 경로 |

## 기술 스택

- **Backend**: Express.js 5, SQLite (WAL mode, better-sqlite3)
- **Frontend**: Preact + HTM (UMD, 빌드 불필요)
- **Font**: Inter (Google Fonts CDN)
- **워커 에이전트 실행**: tmux 세션 + git worktree 격리
- **매니저 에이전트 실행**: Claude Code CLI stream-json 프로토콜 (NDJSON)
- **실시간**: SSE (Server-Sent Events)
- **테스트**: Node.js built-in test runner + supertest

## 개발

```bash
# 테스트
npm test

# 개발 서버
npm run dev
```

데이터는 `palantir.db` (SQLite)에 저장된다. 서버 시작 시 자동 마이그레이션.

## 보안

- `PALANTIR_TOKEN` 미설정 시 인증 비활성, localhost만 접근 가능
- 에이전트 명령어는 allowlist로 제한 (임의 명령 실행 불가)
- tmux 세션에서 에이전트 실행 시 shell injection 방지 (execFileSync + temp script)
- git worktree로 에이전트 간 파일시스템 격리

## 라이선스

ISC
