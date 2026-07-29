# 이슈 #466 워커 idle 타임아웃 조사

## 결론

`idleMs=32429699`처럼 약 540분으로 기록된 값의 원인은 코드로 특정했다.
9시간 idle 상수가 있는 것이 아니라, `lifecycleService`의 기존 기본값은
30분이다. SQLite `datetime('now')` 문자열은 UTC인데 idle 계산이 zone 표식
없는 문자열을 로컬 시각으로 파싱했다. Asia/Seoul에서는 방금 기록한 event가
약 9시간 전 event로 계산된다.

반면 워커가 결론을 출력한 뒤에도 프로세스가 종료하지 않은 원인은 코드로
특정하지 못했다. 저장소의 stdin 전달과 종료 감지 경로는 확인했지만, 실측
3건의 profile row, 실제 argv, process tree가 없어 어느 분기를 탔는지
입증할 수 없다. 따라서 출력 정지, 특정 문구, 임의 EOF 주입 같은 조기 종료
휴리스틱은 구현하지 않았다.

## 확인한 stdin 경로

- 로컬 subprocess: `child.stdin.end(prompt)`로 prompt 전달과 EOF를 함께
  보낸다.
- 로컬 tmux: mode 0600 prompt 파일을 만들고 `< prompt-file`로 실행한다.
  파일 끝에서 EOF가 전달된다.
- 원격 tmux: prompt를 원격 mode 0600 파일로 materialize한 뒤 같은 방식으로
  stdin redirect한다.
- Claude manager: stdin이 닫히면 persistent manager process가 종료되므로
  manager 경로는 이번 변경 대상이 아니다.

표준 Codex worker profile의 `{prompt}`는 invocation 조립 단계에서 실제
argv의 끝 `-`로 바뀌고 prompt는 별도의 `stdin` 값으로 전달된다. 따라서
이 표준 경로는 위 세 실행 엔진 모두에서 EOF가 닫힌다.

별도의 custom profile이 `{prompt}` 없이 리터럴 `-`로 끝나면 `stdin` 값이
없는 경로도 확인했다. 그러나 이 경로에서는 작업 prompt 자체도 전달되지
않으므로, 작업 내용을 받아 결론까지 출력한 실측 3건을 설명하는 근거가
되지 않는다. 해당 profile row와 실제 argv가 없는 상태에서 이 분기를
원인으로 단정하거나 동작을 바꾸지 않았다.

채널은 텍스트의 의미상 "결론 도출"을 종료 신호로 해석하지 않는다. process
exit를 terminal 신호로 사용하고, 살아 있는 process에는 output/process
activity와 idle timeout만 적용한다. 결론 문구를 감지해 process를 죽이는
것은 진행 중인 워커의 정상 출력을 오인할 수 있어 추가하지 않았다.

## idle 시간 계산

- 기본 임계값은 계속 `30 * 60 * 1000`이다.
- `agent_profiles.idle_timeout_ms`가 NULL이면 이 값을 그대로 쓴다.
- 값이 있으면 해당 worker profile의 양의 정수 millisecond 값을 쓴다.
- health poll 자체가 남기는 payload 없는 `heartbeat`는 worker activity로
  계산하지 않는다. 출력 변화 또는 process activity가 담긴 heartbeat는
  activity로 계산한다.
- SQLite 시각은 UTC로 명시해 파싱한다.

프로젝트 override는 넣지 않았다. 실행의 idle 정책을 직접 소유하는 엔티티는
worker profile이고, 프로젝트 override를 추가하면 profile/project 우선순위,
실행 중 설정 변경, run snapshot 여부까지 별도 계약이 필요하다. 이슈의 최소
요구인 profile 단위로 충분하며, 소비자가 없는 범위를 넓히지 않았다.

## terminal 상태 판단

새 `timed_out` status는 추가하지 않았다. 새 status는 현재의
`VALID_TRANSITIONS`, terminal status 목록, B-lite retry, goal verdict,
harvest, SSE/UI의 모든 소비자가 동시에 알아야 한다. 하나라도 빠지면 이미
끝난 run을 non-terminal로 오인할 수 있다.

대신 기존 `completed`/`failed` 호환성을 유지하고 `runs.terminal_reason`을
추가했다. idle timeout으로 `needs_input`이 된 run이 이후 종료되면
`terminal_reason='idle_timeout'`을 기록한다. 기존 `run:needs_input`과
`reason:'idle_timeout'` 신호는 그대로 사용하며 새 알림 채널은 만들지
않았다. task의 run 이력은 정상 완료와 idle timeout 후 완료를 다른 문구로
표시한다.

## 남은 미확인 사항

이슈의 실측 3개 run에 저장됐던 당시 profile row와 실제 argv/process tree는
이 worktree에 없다. 따라서 결론을 출력한 process가 왜 자연 종료하지
않았는지는 미해결이다. 추가 조사에는 최소한 해당 profile의
`command`/`args_template`, 실행 시 최종 argv, stdin 유무, process tree와
Codex CLI 버전이 필요하다.

540분 값은 timezone 계산으로 재현 가능하므로 이 부분은 추측이 아니다.
조기 종료 원인은 재현 자료가 없으므로 특정하지 않았고, 관련 동작도
변경하지 않았다.
