# `shared_uid_attenuated` 기각 기록

## 결정

이 저장소에는 `shared_uid_attenuated` capability 등급과 그 토큰 포맷을 구현하지
않는다. #436의 same-UID 문제는 새 중간 등급이 아니라 기존 `isolated`를 운영자가
달성·진단하기 쉽게 만드는 방향으로 해결한다.

commit `69797ad`(원래 브랜치 `fix/436-attenuated-manager-capability`, 2026-08-01 에
브랜치는 회수하고 annotated 태그 `design/shared-uid-attenuated-rejected` 로 보존 —
GC 방지, 머지 후보 아님)에서 설계를 만들고 적대 리뷰를 8라운드 수행했으나 모두
NO-GO였고 누적 지적은 33건이었다. 핵심 결론은
“복사 가능한 자격증명의 위험을 감쇠하려면 저장소에 아직 없는 소유권·감사·비용
모델을 먼저 만들어야 한다”는 것이다.

## 다시 시도하기 전에 필요한 다섯 선행 공사

### 1. run/event/output 단위 소유권

현재 Operator capability는 다른 Operator가 만든 worker의 prompt·event·output을
관찰하고 input/cancel까지 보낼 수 있는 경로가 있다. `worker.parent_run_id ===
grant.runId` 같은 직접 소유권과 parent가 없는 legacy worker를 위한 별도
instance/project 규칙이 먼저 필요하다.

### 2. 생산 지점에서 vendor resume handle 제거

`manager_thread_id`나 `claude_session_id` DTO만 숨겨서는 부족하다. Codex
`mgr.session_started`, Claude normalized event, stream-json legacy event, raw debug event
등 여러 생산자가 resume handle을 event payload에 남긴다. 이 값은 다른 vendor
session을 resume하는 impersonation 권한이므로 저장 전에 제거하는 소유권-aware
event schema가 필요하다.

### 3. exec 시점 환경 증명

Linux `/proc/<pid>/environ`은 exec 당시 환경을 노출하며 이후 `process.env`에서 값을
지워도 바뀌지 않는다. import 순서에 좌우되는 모듈-load snapshot은 우회가 재현됐다.
`/proc/self/environ` 같은 exec-time 증명 또는 검증 불가 플랫폼 fail-closed가
필요하다.

### 4. 정상 사용자를 DoS하지 않는 비용 예산

검토한 세 방식은 모두 실패했다.

- `(run, method, path)` dedup은 가짜 id로 key budget을 소진한 뒤 실제 경로를
  무감사 조회할 수 있었고, 거부 GET 증폭은 남았다.
- per-run lifetime 요청 상한은 복사된 토큰이 금지 endpoint 호출로 정상 manager를
  영구 429에 빠뜨릴 수 있었다.
- in-flight run 상한은 parent 없는 Top worker가 회계에서 빠졌고 누적 비용이
  무제한이며, 상한 선점으로 정상 manager를 계속 429시킬 수 있었다.

서버 지정 dispatch grant id와 시간창 기반 누적 비용 예산이 선행되어야 한다.

### 5. 감사 전용 저장소와 retention

감사를 `run_events`에 섞으면 cursor 없는 조회의 오래된 1,000행 제한 때문에 감사행이
실제 assistant/result event를 밀어낸다. 관찰 기능을 해치지 않는 전용 저장소,
조회 cursor, retention 정책이 먼저 필요하다.

## 응답 스크러버를 재사용하지 않는 이유

응답 단계에서 민감 필드를 재귀 삭제하는 방식은 보안 경계로 사용할 수 없다. 리뷰에서
다음 우회가 모두 재현됐다.

- 크기 상한을 넘어 scrub 탐색을 중단시키기
- 이중 인코딩
- 비-JSON 직렬화
- 객체의 `toJSON()` 동작

유출은 producer와 저장 schema에서 막아야 한다. 기존 브랜치의 응답 스크러버 코드는
재사용 금지다.

## 왜 `isolated`는 위 공사를 요구하지 않는가

다섯 문제는 모두 같은 UID의 형제가 capability를 복사할 수 있다는 전제에서 생긴다.
실제 OS 계정/컨테이너 경계가 Console과 peer process의 환경 관찰을 차단하면 복사
전제를 제거할 수 있다. 따라서 현재 비용 대비 우선순위는
[`isolated` 달성 런북](./runbook-isolated-capabilities.md)과 진단 도구다.

## 재검토 gate

향후 중간 등급을 다시 제안하려면 위 다섯 선행 요구가 독립적으로 구현·검증됐다는
근거와 producer-side 유출 방지 테스트가 먼저 있어야 한다. 그 전에는 commit
`69797ad`(태그 `design/shared-uid-attenuated-rejected`)를 구현 출발점으로
cherry-pick하거나 응답 스크러버를 되살리지 않는다.
