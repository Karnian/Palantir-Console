# SH1 S1-a1 구현 기록

기준은 승인된 brief v5.6의 §3.3·§3.4·§4·§5·§8.1과 S1-0 기록이다. 이번 결과는 CommonJS in-process 라이브러리다. 소켓·잠금·프로세스 기동·실제 SDK와 ps는 포함하지 않는다. 기존 서버 DB나 서비스에 연결하지 않는다.

## 인터페이스와 실행

`createHostCore({dbPath, adapter, identityProbe, clock, hostBootId, faults})`의 `submit`, `recover`, `snapshot`, `eventsSince`를 사용한다. `onEvent(event)`는 직접 입력 경로이며 같은 이벤트를 `adapter.events`의 `event` 채널로 받을 수 있다. `close()`는 라이브러리 DB 핸들만 해제한다. `idle(sessionId)`는 테스트와 후속 브리지용 조회다. `clock`은 밀리초 반환 함수 또는 `now()` 객체이며 실제 sleep은 없다.

요청 키 형식은 `rk_<epoch ms>_<16+ hex>`다. fingerprint는 키 순서를 정규화한 JSON의 SHA-256이다. 제어 요청에는 본문이 없으며 cwd도 해시로만 fingerprint에 들어간다. 기존 행·tombstone 조회가 시각 검사보다 먼저다. 새 키의 허용 구간은 호스트 시각 기준 24시간 전부터 5분 후까지다. 반환값은 durable 행의 최신 상태이며 SDK 콜백이 동기적으로 처리됐으면 완료 상태일 수도 있다. fingerprint 충돌은 `status:409`다.

`adapter.start({incarnation_id,session_id,cwd})`, `send(incarnationId,uuid,text)`, `decide(incarnationId,toolUseId,decision)`, `interrupt(incarnationId)`, `close(incarnationId)`를 사용한다. §2.4 경계를 여러 세션에 쓰기 위해 incarnation 인자를 명시했다. `facts(incarnationId,toolUseId)`는 선형화 구간의 최종 SDK 사실 조회다. `signal(incarnationId,signal)`은 가짜 신호 경로다. 실제 OS 호출은 없다. `authCheck()`·`settingsCheck()`는 이번 경계에서 **동기 boolean 판정 결과**를 반환한다. 실제 account·초기화 응답·resolveSettings 구조/기한 검사는 S1-b 어댑터가 수행한다. Promise·누락·예외·true 이외 값은 통과하지 않는다.

이벤트 형식은 `{type,incarnation_id,...payload}`다. lifecycle은 `command_uuid,state`, result는 `user_message_uuids,is_error,subtype`, tool_request는 `tool_use_id,name,input,signal`, tool_result는 `tool_use_id,is_error,content`, interrupt_receipt는 `still_queued`, system_init은 `capabilities,apiKeySource`다. exit와 abort는 각각 `child_exit`, `signal_abort`다.

가짜는 `drop`, `merge`, `late`, `omitLifecycle`, `stillQueued`, `noReceipt`, `capabilities`, `noExit`, `manual`, `manualTools`, `resultError`, `toolError`, `spawnError` 옵션을 제공한다. `flush()`로 지연 소비, `emit()`으로 개별 프레임, `toolRequest()` 반환 AbortController로 abort를 발생시킨다. `log.received`·`log.executions`가 provider 효과 증거이며 본문·입력·account 값은 로그에 없다.

## 저장과 복구

호스트 전용 스키마 버전 1과 WAL을 사용한다. 상태 변경 helper는 허용 이전 상태를 명시한 UPDATE와 replay 이벤트를 같은 트랜잭션에 쓴다. 원문 SDK 이벤트와 상태 전이는 events의 AUTOINCREMENT seq를 공유한다. snapshot은 read transaction 하나로 상태와 seq를 읽으며 replay의 삭제 구멍은 `snapshot_required:true`다. 마이그레이션 실패는 생성자를 실패시키고 쓰기 실패는 해당 인스턴스를 fail-closed로 고정한다. `faults.hit('db_write')`에서 일반 오류를 던지면 저장 실패를 재현한다.

세션 큐는 동기 명령만 소유하며 provider의 비동기 완료를 기다리지 않는다. sending 커밋·facts·효과 호출 사이에는 await가 없다. SDK exit/abort의 무효화는 큐 밖에서 즉시 기록한다. 재기동 시 새 코어를 만들고 `recover()`를 호출한다. spawn 예약을 재사용해 spawn하지 않으며 3값 신원 판정만으로 orphaned/exited/never_started/liveness_unknown을 정한다. pending 카드는 expired, decided는 유지한다. 미관측 sending/written은 unknown이며 재전송하지 않는다.

삭제는 deleting 선기록, tombstone 생성, 원문 행 제거, 세션·incarnation의 민감 필드 null, checkpoint·VACUUM·추가 checkpoint, deleted 순서다. 세션·incarnation id와 상태는 §4.6 표대로 남긴다. 추가 checkpoint는 VACUUM이 생성한 WAL까지 본 파일에 반영하기 위한 것이다. 재생 이벤트에는 삭제 이후 민감 필드를 재기록하지 않는다. tombstone과 본문 없는 control 행은 30일 보존한다. alive 대상 handoff는 close_sent를 먼저 기록한 뒤 interrupt → close를 수행하며 재기동 때 두 효과 모두 재전송하지 않는다.

## 테스트가 막는 구현 실수

테스트 이름에 §8.1 사례를 포함했다. 다음은 사례별 역회귀 목적이다. 외부 mutation 실행은 후속 호스트 검증에서 수행한다.

| 사례 | 막는 구현 실수 |
|---|---|
| 같은 키 두 요청/본문 충돌 | 중복 provider 수신과 fingerprint 누락 |
| 두 탭 승인 | pending 조건 없이 같은 도구 두 번 실행 |
| 정상 20회/10회·거부·질문 | 모든 전달을 unknown으로 남기는 구현 |
| result/lifecycle 분리 | result만 보고 다음 지시 전송 |
| 오류/결과 없음 종결 | errored와 outcome_unknown 혼동, idle 영구 차단 |
| 다른 상관 ID | 다른 턴·도구의 결과를 잘못 귀속 |
| 합쳐진 result | 복수 uuid를 성공으로 임의 귀속 |
| 허용 오류 결과 | 오류를 허용 전달의 양성 증거로 오인 |
| nonce 거부 | 일반 오류를 거부 관측으로 오인 |
| lifecycle 생략·지연 소비 | 미관측 입력을 성공 처리하거나 재전송 |
| capability 누락 | 첫 턴 이후 계속 지시 전송 |
| interrupt 우선·abort | 취소된 승인 콜백 resolve |
| sending 뒤 facts | 선형화 직전 SDK 취소/exit 무시 |
| 효과 뒤 abort | written을 cancelled로 덮어쓰기 |
| still_queued | 귀속 불확실 상태에서 큐 배출 |
| 영수증 없음·세대 상관 | 이전 턴 결과로 interrupt 완료 |
| 인터럽트 뒤 승인 | 이전 인터럽트가 다음 결정까지 오염 |
| 각 delivery crash | sending을 queued로 복원하거나 효과 재실행 |
| decided crash | decided 카드를 pending으로 복원 |
| spawn 예약의 세 crash | 같은 키가 새 예약·새 spawn 생성 |
| 신원 세 값·표지 실패 | query_failed를 사망으로 간주 |
| observed 복구 | 이미 받은 전달을 unknown으로 덮어쓰기 |
| stop/resume/close | stop이 세션까지 닫거나 closed 재개 허용 |
| uncertainty 우회 | 사람 확인으로 incarnation 장벽 해제 |
| 제어 배타권 | exit 대기 중 다른 제어 효과 수행 |
| close_sent crash | 재기동 때 close·signal 재전송 |
| orphaned 새 close | blocked가 영구 잠금이 되거나 신원 재대조 생략 |
| 이미 종료된 대상 | close 효과 없이 닫을 수 없어 active에 갇힘 |
| 하위 표지·조회 실패 | 본체 종료만으로 resume/handoff 허용 |
| 주입 gate 실패 | false/조회 실패에도 spawn·send 진행 |
| 초기화 정리 미확인 | exit 안 했는데 정리 성공 표시 |
| 키 시각·30일 재시도 | tombstone 만료 뒤 오래된 키 재실행 |
| deleting crash·살균 | 삭제 완료 조기 표시·본문 잔류 |
| spawn 오류 고정 reason | 삭제 후 control 행에 경로 잔류 |
| snapshot/replay | snapshot 이후 이벤트 누락·seq 분리 |
| DB 쓰기 실패 | 기록 없는 외부 효과 발생 |

각 provider 호출은 가짜의 공통 transport 함수에서 로그를 남긴다. 호출 억제 검사는 같은 테스트의 성공 경로 또는 시작·수신·결정 로그의 양성 대조를 사용한다. 테스트별 DB는 os.tmpdir 아래 별도 디렉터리에 만들고 종료 시 제거한다.

## 후속 범위와 제한

S1-a2: 호스트 잠금·동시 기동·FD 상속·소켓·handshake·유휴 종료·서버 생존 분리. S1-b: 실제 SDK/가짜 CLI 프로토콜, account 여섯 모양/버전/pid/권한모드/원격 제어 검사, resolveSettings 구조·10초 기한, 초기화 60초 및 종료 유예 5초, env allowlist와 capability 값 유출 검사, 실제 ps·신호 transport. S1-c: cookie·origin·bearer 거부와 소켓 장애 화면. S1-e: 넘기기 shell argv·환경·실제 CLI와 hook 실측. 이 검증은 이번 라이브러리 테스트로 대체하지 않는다.
