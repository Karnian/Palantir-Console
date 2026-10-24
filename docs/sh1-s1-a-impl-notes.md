# SH1 S1-a1 구현 기록

기준은 승인된 brief v5.6의 §3.3·§3.4·§4·§5·§8.1과 S1-0 기록이다. 이번 결과는 CommonJS in-process 라이브러리다. 소켓·잠금·프로세스 기동·실제 SDK와 ps는 포함하지 않는다. 기존 서버 DB나 서비스에 연결하지 않는다.

## 인터페이스와 실행

`createHostCore({dbPath, adapter, identityProbe, clock, hostBootId, faults})`의 `submit`, `recover`, `snapshot`, `eventsSince`를 사용한다. `onEvent(event)`는 직접 입력 경로이며 같은 이벤트를 `adapter.events`의 `event` 채널로 받을 수 있다. `close()`는 라이브러리 DB 핸들만 해제한다. `idle(sessionId)`는 테스트와 후속 브리지용 조회다. `clock`은 밀리초 반환 함수 또는 `now()` 객체이며 실제 sleep은 없다.

요청 키 형식은 `rk_<epoch ms>_<16+ hex>`다. fingerprint는 키 순서를 정규화한 JSON의 SHA-256이다. 제어 요청에는 본문이 없으며 cwd도 해시로만 fingerprint에 들어간다. 기존 행·tombstone 조회가 시각 검사보다 먼저다. 새 키의 허용 구간은 호스트 시각 기준 24시간 전부터 5분 후까지다. 반환값은 durable 행의 최신 상태이며 SDK 콜백이 동기적으로 처리됐으면 완료 상태일 수도 있다. fingerprint 충돌은 `status:409`다.

`adapter.start({incarnation_id,session_id,cwd})`, `send(incarnationId,uuid,text)`, `decide(incarnationId,toolUseId,decision)`, `interrupt(incarnationId)`, `close(incarnationId)`를 사용한다. §2.4 경계를 여러 세션에 쓰기 위해 incarnation 인자를 명시했다. `facts(incarnationId,toolUseId)`는 선형화 구간의 최종 SDK 사실 조회다. `signal(incarnationId,signal)`은 가짜 신호 경로다. 실제 OS 호출은 없다. `authCheck()`·`settingsCheck()`는 이번 경계에서 **동기 boolean 판정 결과**를 반환한다. 실제 account·초기화 응답·resolveSettings 구조/기한 검사는 S1-b 어댑터가 수행한다. Promise·누락·예외·true 이외 값은 통과하지 않는다.

이벤트 형식은 `{type,incarnation_id,...payload}`다. lifecycle은 `command_uuid,state`, result는 `user_message_uuids,is_error,subtype`, tool_request는 `tool_use_id,name,input,signal`, tool_result는 `tool_use_id,is_error,content`, interrupt_receipt는 `still_queued`, system_init은 `capabilities,apiKeySource`다. exit와 abort는 각각 `child_exit`, `signal_abort`다.

가짜는 `drop`, `merge`, `late`, `omitLifecycle`, `stillQueued`, `noReceipt`, `capabilities`, `noExit`, `manual`, `manualTools`, `resultError`, `toolError`, `spawnError` 옵션을 제공한다. `flush()`로 지연 소비, `emit()`으로 개별 프레임, `toolRequest()` 반환 AbortController로 abort를 발생시킨다. `log.received`·`log.executions`가 provider 효과 증거이며 본문·입력·account 값은 로그에 없다.

## 저장과 복구

호스트 전용 스키마 버전 3과 WAL을 사용한다. 버전 1에서 2로의 마이그레이션은 본문 없는 `request_aliases`를 추가한다. 버전 3은 delivery별 `attribution_pending`을 추가하고 기존 effect_failed 일시 장벽의 원인도 복원한다. 상태 변경 helper는 허용 이전 상태를 명시한 UPDATE와 replay 이벤트를 같은 트랜잭션에 쓴다. 원문 SDK 이벤트와 상태 전이는 events의 AUTOINCREMENT seq를 공유한다. snapshot은 read transaction 하나로 상태와 seq를 읽으며 replay의 삭제 구멍은 `snapshot_required:true`다. 마이그레이션 실패는 생성자를 실패시키고 쓰기 실패는 해당 인스턴스를 fail-closed로 고정한다. `faults.hit('db_write')`에서 일반 오류를 던지면 저장 실패를 재현한다.

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

## 수정 라운드 1 — 적대리뷰 A/B

resume의 start 인자에는 `{resume:true,claude_session_id}`를 포함하며 일반 start에는 두 필드를 생략한다. 가짜의 `log.startRequests`는 이 두 필드를 기록·검증한다. interrupt 효과는 `interrupt(incarnationId,interruptId)`이고 영수증도 `interrupt_id`를 싣는다. 호출과 무관한 영수증은 상태를 바꾸지 않는다. `INTERRUPT_RECEIPT_TIMEOUT_MS=10000`이며 `tick()`에서 주입 clock으로 기한을 검사한다. 효과 반환 뒤에는 written, 기한 뒤에만 unknown이다. 기한 이후 영수증은 전달 관측 증거가 될 수 있지만 중단 여부 불명 장벽은 대상 turn_gen의 result만 해제한다.

진행 중 interrupt에 대한 새 키는 request_aliases에 키·fingerprint·대상 id·세션 id·접수 시각만 저장한다. 같은 키는 완료·재기동 뒤에도 원래 요청을 돌려준다. 세션 삭제 때 별칭도 tombstone으로 옮긴다. deleting/deleted 대상 새 요청은 본문·원문 이벤트 없이 tombstone에 거부 상태만 남긴다. capability 누락의 자동 close는 호스트 키와 고정 reason `capability_missing`을 가진 control_requests로 기록하고 수동 close와 같은 stage·복구 경로를 쓴다. lifecycle 최초 종결은 SQL의 `outcome IS NULL` 조건으로 고정한다. 오류 result의 subtype은 prompt reason에 남긴다.

호스트의 이번 명확화(#10)에 따라, 이미 해당 tool_result가 도착한 허용 결정의 unknown(`tool_finished_error`/`tool_finished`)은 도구가 끝났으므로 attribution_uncertain을 걸지 않는다. 이는 §4.3의 “원본이 provider 안에 남아 늦게 실행될 수 있음”과 다른 경우다. 결과 없는 결정은 복구 시 unknown과 decided를 유지하며 같은 incarnation에서 재결정·재전송할 수 없다. 효과 뒤 예외로 prompt 원본이 남은 경우는 장벽을 걸되, 정확한 원본 UUID의 lifecycle 증거로만 해소한다. 복수 UUID/비어 있지 않은 still_queued의 장벽은 그 incarnation에서 해제하지 않는다. 내부 attribution_uncertain 값 1은 영구 장벽, 2는 원본 증거 대기이며 둘 다 boolean 조회에서는 참이다.

system_init은 가짜의 첫 prompt에서 incarnation당 한 번만 발생한다. 코어도 첫 capability 판정을 유지한다. 테스트 전용 `readHooks.afterState`는 store의 read transaction 안에서 상태 조회와 seq 조회 사이에 호출한다. 별도 WAL 연결의 실제 커밋을 이 지점에 넣어 snapshot/replay 누락을 검사한다.

수정 전 `session-host-review-r1.test.js`는 20개 중 16개 실패·4개 통과였다. #10·#12·#13과 #7의 completed 우선 방향은 이미 올바른 동작이므로 수정 전에도 통과했다. 이 사실을 RED로 포장하지 않는다. 각 번호별 테스트명은 다음과 같다(접두어 뒤 전체 설명은 테스트 파일에 있다).

| 결함 | 테스트명 접두어 | 수정 전 |
|---|---|---|
| 1 | R1-01 resume carries saved Claude session identity | 실패 |
| 2 | R1-02 receipts correlate request id | 실패 |
| 3 | R1-03 interrupt stays written until injected-clock receipt deadline | 실패 |
| 4 | R1-04 duplicate interrupt key alias is durable | 실패 |
| 5 | R1-05 deleting/deleted rejects new requests without retaining body | 두 경우 실패 |
| 6 | R1-06 capability auto-close has durable close_sent intent | 실패 |
| 7 | R1-07 first terminal cancelled/completed survives late opposite lifecycle | cancelled 우선 실패, completed 우선 통과 |
| 8 | R1-08 pending start recovery | match/query_failed/mismatch_confirmed 모두 실패; 수정 후 resume 네 분기도 추가 검증 |
| 9 | R1-09-17 error subtype is retained | 실패 |
| 10 | R1-10 finished tool error unknown has no attribution barrier | 통과, 현행 유지 |
| 11 | R1-11 missing capability plus missing lifecycle | 실패 |
| 12 | R1-12 abort at after_sending_commit | 통과, 기존 최종 SDK 검사 실효화 |
| 13 | R1-13 observed committed before written cannot regress | 통과, 기존 sending 조건 실효화 |
| 14 | R1-14 delayed unknown original executes once | 실패 |
| 15 | R1-15 system_init emitted only for first prompt | 실패 |
| 16 | R1-16 WAL writer between snapshot state and seq | 실패 |
| 17 | R1-09-17 error subtype is retained | 실패 |

각 테스트는 해당 결함의 재발을 막는다. 특히 #12는 abort 검사 제거 시 decide가 발생하고, #13은 늦은 written의 이전 상태 조건 제거 시 observed가 written으로 역행하며, #16은 read transaction 제거 시 상태에는 없는 이벤트가 seq_high 뒤 replay에서도 누락된다.

## 수정 라운드 2 — 대화 신원·종료 우선순위·장벽 원인

start에서 어댑터가 대화 id를 주지 않으면 null을 유지한다. resume 응답에 id가 없으면 저장된 값을 유지하고, 명시적으로 반환한 비어 있지 않은 대화 id만 반영한다. 소유 세션 id는 대화 id의 대체값이 아니다. 가짜는 start/resume 응답에 실제 가짜 대화 id를 제공한다.

capability 누락은 **세션 종료 의도가 우선**이다. 해당 incarnation의 사용자 stop은 `rejected(capability_close_pending)`이며, 자동 close가 아직 없으면 그 요청 처리 중 먼저 durable 자동 close를 시작한다. 이미 진행 중인 자동 close와 배타권을 공유한다. 첫 prompt의 정확한 UUID result 또는 lifecycle 종결 중 먼저 온 신호로 자동 close를 시작한다. 이것은 정리를 시작하는 근거일 뿐 전달 완료 근거가 아니다. lifecycle이 없으면 written이며, exit 후 unknown과 결과에 따른 outcome을 기록한다. 이 결정은 라운드 1의 “lifecycle 없으면 외부 exit까지 close 대기” 테스트를 대체한다.

completed interrupt의 늦은 영수증도 survivor UUID를 처리한다. completed는 역행하지 않으며, still_queued가 비어 있지 않으면 영구 장벽을 건다. written 영수증 처리 시에도 durable updated_at(해당 written 커밋 시각)과 10초 기한을 검사하므로 tick 선후에 따라 판정이 달라지지 않는다. 늦은 영수증은 provider_observed라는 관측을 남기면서 interrupt_unknown을 세운다. 대상 세대 result가 이미 interrupt를 완료한 경우는 중단 불명을 다시 만들지 않는다.

효과 예외의 일시 장벽은 각 delivery의 attribution_pending으로 원인을 보존한다. 그 delivery의 정상 lifecycle·상관된 tool_result·interrupt 영수증만 그 원인을 해소한다. 도구의 오류 결과도 해당 도구가 끝났다는 사실이므로 라운드 1 #10의 정책대로 원인을 해소한다. 원인이 하나라도 남으면 값 2를 유지하며, 값 1(합쳐진 턴·survivor)의 영구 장벽은 원인이 전부 해소돼도 유지한다. incarnation 종료 시 unknown prompt도 outcome IS NULL 조건으로 확정한다.

수정 전 신규 테스트 14개 중 실패 12개·통과 2개를 확인했다. 각 지적 번호에서 최소 한 사례는 수정 전 실패했다.

| 지적 | 추가 테스트명 | 수정 전 실패 여부 / 막는 실수 |
|---|---|---|
| 1 | R2-01 two resumes preserve saved conversation id when adapter omits response id | 실패 / 두 번째 resume에 소유 id 전달 |
| 1 | R2-01 fake start returns conversation id; missing start id stays null and blocks handoff | 실패 / 대화 id 날조 및 no_session_id 누락 |
| 2 | R2-02 completed interrupt still processes late survivor receipt without state regression | 실패 / 완료 후 survivor 영수증 무시 |
| 3 | R2-03 capability close wins user stop, alreadyClosing=false/true | 둘 다 실패 / stop이 종료 의도를 취소하거나 busy로 오분류 |
| 4 | R2-04 missing lifecycle closes on exact result without external exit or completed delivery | 실패 / lifecycle 생략 시 정리 영구 대기 |
| 4 | R2-04 wrong result cannot initiate capability close, exact result can | 실패 / 상관없는 결과로 종료 또는 정확한 결과 무시 |
| 5 | R2-05 late receipt durable deadline is order independent, tickFirst=false/true | false 실패·true 기존 통과 / tick 순서 의존 |
| 6 | R2-06 unknown prompt receives terminal outcome on exit, withResult=false/true | 둘 다 실패 / unknown prompt 결과 영구 미확정 |
| 7 | R2-07 multiple tool effect barriers clear only their own cause and release after last positive result | 실패 / 원인 하나 해소로 전체 장벽 해제 또는 영구 대기 |
| 7 | R2-07 unrelated unknown prompt cannot clear another delivery barrier | 실패 / prompt 증거가 다른 도구 원인까지 해제 |
| 7 | R2-07 resolving temporary cause never clears permanent survivor barrier | 기존 통과 / 일시 원인 해소가 영구 장벽까지 해제 |

S1-a2: 호스트 잠금·동시 기동·FD 상속·소켓·handshake·유휴 종료·서버 생존 분리. S1-b: 실제 SDK/가짜 CLI 프로토콜, account 여섯 모양/버전/pid/권한모드/원격 제어 검사, resolveSettings 구조·10초 기한, 초기화 60초 및 종료 유예 5초, env allowlist와 capability 값 유출 검사, 실제 ps·신호 transport. S1-c: cookie·origin·bearer 거부와 소켓 장애 화면. S1-e: 넘기기 shell argv·환경·실제 CLI와 hook 실측. 이 검증은 이번 라이브러리 테스트로 대체하지 않는다.

## 수정 라운드 3 — 미관측 결정 오염과 종료 경로 보존

호스트 결정에 따라 capability 자동 close는 **아직 alive인 incarnation에서만 시작**한다. 이미 사용자 stop/close/handoff가 접수되어 종료 경로에 들어갔다면 그 진행 중 제어 요청의 배타권을 유지한다. exit 뒤에는 자동 close를 새로 만들지 않는다. 특히 init 지연 중 먼저 접수된 stop은 뒤늦은 capability 누락 때문에 세션 close로 바뀌지 않으며, stop done 뒤 세션 active와 resume 가능 상태를 유지한다. 누락 사실은 해당 incarnation에만 남고 새 incarnation은 첫 init으로 다시 판정한다. 반대로 누락 판정 뒤 새로 제출한 stop은 기존 라운드 2 정책대로 `rejected(capability_close_pending)`다. 이 정책은 라운드 2의 종료 의도 우선 규칙을 위 조건으로 한정한다.

인터럽트·signal abort·exit는 sending/written뿐 아니라 결과를 아직 받지 못한 unknown tool_decision/question_answer도 taint한다. 이미 `tool_finished`/`tool_finished_error`로 끝난 unknown은 제외한다. 오염된 허용·질문 응답은 정상 tool_result가 뒤늦게 와도 observed로 승격하지 않고 unknown·`tool_finished`로 남긴다. 해당 도구가 끝난 사실로 일시 장벽 원인은 해소하되, 영구 장벽은 유지한다. R2-07의 survivor 테스트도 이 정책에 맞게 unknown을 엄격히 단언한다.

대상 turn_gen의 result로 interrupt가 completed가 되면 같은 트랜잭션에서 그 interrupt의 attribution_pending을 해소한다. 다른 delivery의 원인은 남기며 원인이 모두 해소된 경우에만 값 2의 일시 장벽을 해제한다. 값 1의 영구 장벽은 해제하지 않는다.

수정 전 신규 테스트 10개 중 9개 실패·1개 통과를 확인했고 수정 후 전체 전용 테스트 102개가 통과했다.

| 지적 | 추가 테스트 이름 | 수정 전 결과 / 막는 구현 실수 |
|---|---|---|
| 1 | R3-01 unknown tool_decision/question_answer tainted by interrupt/abort/exit cannot become observed on normal tool result | 6개 모두 실패 / 효과 예외를 거친 미관측 결정이 오염 구간을 무시하고 observed로 승격 |
| 2 | R3-02 stop accepted before delayed missing init remains active after exit and can resume | 실패 / stop 완료 뒤 자동 close를 추가해 세션을 닫음 |
| 3 | R3-03 target result clears interrupt effect barrier only, otherCause=false/true | 2개 모두 실패 / interrupt 완료 뒤 원인이 남거나 다른 원인까지 해제 |
| 3 | R3-03 completed interrupt result cannot release an existing permanent barrier | 기존 통과 / 일시 장벽 해소가 survivor 영구 장벽까지 해제 |

테스트는 가짜 자체의 결정·실행·close·interrupt 로그로 효과 횟수를 확인한다. npm test는 이번 라운드 지시에 따라 호스트에서 실행한다.

## S1-a2 — 세션 호스트 프로세스 껍데기

설계 v5.6 §3.1·§3.2·§4.1·§5-6·§8.1에 맞춰 CommonJS 프로세스 계층을 추가했다.
서버 라우트 연결, 실제 SDK 설치·실행, 기존 인증 서비스와 package.json 변경은 하지 않는다.

### 잠금과 부팅

`lock.js`는 **flock 대신 SQLite 배타 잠금**을 사용한다.
`host.lock`을 better-sqlite3로 열고 `busy_timeout=0`, `locking_mode=EXCLUSIVE`,
`BEGIN EXCLUSIVE` 쓰기 트랜잭션을 커밋한 뒤 연결을 프로세스 수명 동안 유지한다.
SQLite EXCLUSIVE 모드는 커밋 뒤에도 배타 잠금을 유지한다.
의미는 비차단 배타, 평생 보유, 사망 시 커널 해제, 자식 비상속으로 동일하다.
잠금 파일은 삭제하지 않는다. 파일을 지웠다 다시 만드는 방식의 서로 다른 inode 잠금 경쟁을 피한다.
SQLite의 프로세스 소유 잠금과 exec 시 닫히는 파일 descriptor, Node의 stdio 외 descriptor 차단을 사용한다.
장수 Node 자식이 살아 있어도 소유자 SIGKILL 뒤 새 호스트가 잠금을 잡는 X 테스트로 비상속을 검증한다.
같은 테스트에서 기존 소유자가 살아 있을 때 새 호스트가 반드시 실패하는 음성 대조도 둔다.
자식이 배타권을 유지하도록 바꾸면 소유자 사망 뒤 replacement readiness 단언이 실패한다.

잠금 DB를 열 부모 디렉터리가 필요하므로 디렉터리 생성·0700 설정은 잠금 획득 직전에 한다.
기존 소켓 제거, host.db 열기·recover, listen·0600, capability 교체는 잠금 보유자만 한다.
capability는 32바이트 랜덤 hex이고 0600 임시 파일을 rename한다.
argv·env에 capability를 넣지 않는다. SIGTERM/SIGINT는 active 소유 세션이 있으면 무시하고
고정 로그 코드만 남긴다. SIGHUP도 무시한다. 정상 종료에서 process.exit를 호출하지 않는다.

### 프로토콜과 유휴 종료

`protocol.js`는 Duplex 스트림에 연결하는 줄 단위 JSON 처리기다.
capability 비교는 SHA-256으로 길이를 고정한 뒤 timingSafeEqual을 사용한다.
잘못된 capability, hello 이전 요청, JSON 오류, 1 MiB 초과 줄은 응답 없이 닫는다.
submit 반환 뒤에만 accepted를 쓰고, 예외는 고정 `storage_unavailable` 또는 `invalid_request`만 보낸다.
lookup·snapshot·events_since의 결과는 result 필드로 감싼 코어 원본이다.
요청 본문·도구 입력·account·capability·예외 원문은 로그에 쓰지 않는다.

유휴 시 새 연결을 막고 기존 연결을 접수 거부 상태로 전환한 뒤 미응답 요청에 not_accepted를 보낸다.
응답 write가 끝난 뒤 스트림을 닫아 not_accepted를 즉시 destroy로 버리지 않는다.
큐·소유 세션을 다시 확인하여 일이 생겼으면 다시 listen한다.
활동이 있으면 유휴 시각을 초기화한다. 주입 clock으로 시간을 읽고 실제 unref 타이머는 유휴 검사에만 쓴다.
`before_idle_drain` fault는 fixture에서만 파일 기반 대기를 반환한다.
이 지점에서 새 요청을 보내 not_accepted와 새 호스트 재시도를 결정적으로 검증한다.
제품 main은 fault·fake 환경 설정을 받지 않는다.

### 코어 공개 메서드 추가 이유

기존 submit·recover·상태 전이 구현은 변경하지 않고 반환 객체에 다음 공개 메서드만 추가했다.

- `lookup(requestKey)`: 별칭·delivery·control·삭제 tombstone을 같은 read transaction에서 조회한다.
  서버가 DB를 직접 열거나 조회를 위해 submit을 호출하지 않도록 한다.
- `activity()`: active 소유 세션 수와 동기 큐 수를 제공한다. private DB·큐를 프로세스 계층에 노출하지 않는다.
- `submitUnavailable(request)`: 기본 unavailableAdapter 전용 공개 진입이다.
  기존 submit의 검증·멱등·durable 접수·spawn 실패 처리를 그대로 거친다.
  start/resume의 spawn_failed만 adapter_unavailable로 저장하고 응답한다.
  이는 기존 submit의 고정 spawn_failed 동작을 바꾸지 않으면서 제품 stub의 요구 reason을 제공하기 위한 것이다.
  원래 core submit과 일반 어댑터 경로의 동작은 그대로다.

### 서버 기동기와 재연결

`ensureHost`는 capability 파일·hello를 먼저 시도하고 실패하면 detached·stdio ignore·unref로 호스트를 띄운다.
부모 env에서 모든 PALANTIR_*와 CLAUDE_CODE_OAUTH_TOKEN을 무조건 제거하고,
OAuth 형식 ANTHROPIC_API_KEY도 authResolver.isClaudeOAuthTokenValue로 판별해 제거한다.
stripClaudeOAuthEnv의 레거시 우회 경로는 사용하지 않는다.
레거시 스위치가 정확히 1이면 launcher와 제품 main 모두 legacy_credential_mode로 거부한다.
동시 기동의 패자는 host_locked로 종료하고 launcher는 기한 내 이긴 호스트에 연결한다.

`createClient`는 connect 이후 submit·lookup·snapshot·eventsSince를 id로 매칭한다.
연결 상실·응답 기한 초과의 submit은 acceptance_unknown이며 원래 request_key를 보존한다.
호스트 재기동 후 기존 client.reconcile()을 호출하면 재연결하고 보존한 키들을 lookup한다.
결과는 request_key → 결과 Map이며 found:false인 항목만 호출자가 같은 키로 재제출한다.
hostBootId와 hostBootChanged로 부팅 신원 변화를 관측한다. 자동 효과 재전송은 하지 않는다.

### 검증과 남은 실행

P 테스트는 실제 소켓 없이 Duplex로 잘못된 인증·hello 순서·durable 응답 순서·저장 오류·줄 제한·
lookup/snapshot/replay·UTF-8 분할·유휴 not_accepted를 검증한다.
정책 테스트는 환경 제거·레거시 거부·기본 어댑터 실패 reason·삭제 tombstone·별칭·SQLite 잠금을 검증한다.
기존 상태 기계 102개와 P/정책 17개는 통과했다.
전체 명령은 129개 중 119개 통과, X 10개 실패, skip 0이다.

샌드박스에서 실행 불가한 테스트 목록(`session-host-process-lifecycle.test.js`):

1. 동시 호스트·패자의 inode/capability 보존.
2. 장수 자식 생존 중 잠금 비상속.
3. launcher 부모 SIGKILL 뒤 호스트 신원·snapshot 유지.
4. launcher 부모 SIGTERM 뒤 호스트 신원·snapshot 유지.
5. launcher 부모 프로세스 그룹 SIGHUP 뒤 호스트 신원·snapshot 유지.
6. before_accepted_reply SIGKILL 뒤 boot 변경·lookup·멱등 재제출·효과 1회.
7. 유휴 drain 중 not_accepted 뒤 새 호스트 재시도·효과 1회.
8. active 소유 세션의 idle/SIGTERM 생존과 소유 세션 0개 시 자동 종료.
9. 디렉터리·파일 mode와 ps -E -ww로 capability/env/argv 미노출 확인.
10. 소유 세션 0개에서 SIGTERM 정리·잠금 해제.

9개는 신원 확인용 /bin/ps 실행 자체가 EPERM이다.
9번은 소켓 bind가 EPERM이어서 launcher가 host_start_timeout으로 실패한다.
별도 fixture 직접 기동으로 종료 코드 1·stderr EPERM도 확인했다.
보안 검사를 skip하거나 실패를 성공으로 바꾸지 않았다. 호스트 macOS에서 이 10개를 다시 실행해야 한다.
각 테스트는 9.5초 제한과 기한 있는 짧은 조건 polling을 사용한다.
직접 생성한 ChildProcess handle 또는 ps 시작시각 신원을 확인한 PID만 정리하고 runtimeDir을 제거한다.
npm test는 지시대로 실행하지 않았다. 호스트 전체 회귀 검증이 남아 있다.

## S1-a2 수정 라운드 1 — fatal 보존·접수 증거·재확인 범위

호스트 사전 확인: 이전 HEAD에서 실제 macOS 전용 테스트 129/129 통과, 잔존 프로세스 0.
EXCLUSIVE 제거·active 보호 제거·accepted 선응답 mutation 3종 모두 검출됐다는 결과를 받았다.

### R1-01 치명 오류 정책

uncaughtException·unhandledRejection 처리기를 호스트 수명에 맞춰 등록·제거한다.
첫 치명 오류에서 fatal을 래치하고 고정 진단 host_fatal 한 줄만 기록한다.
예외 값·본문·스택은 읽거나 로그로 넘기지 않는다. 이후 정상 인증된 모든 새 요청은 host_fatal 오류다.
인증 실패 연결은 기존처럼 무응답으로 닫고, 올바른 hello는 진단 연결을 위해 계속 허용한다.
active 소유 세션이 있거나 그 수를 확인할 수 없으면 종료하지 않고 유휴 검사도 중지한다.
세션이 없으면 연결·코어·잠금을 정리한 뒤 exitCode=1로 자연 종료한다.
process.exit 호출은 추가하지 않았다. active 상태의 SIGTERM 보호도 유지한다.

fixture의 SH_ASYNC_FATAL(throw/rejection)과 SH_ASYNC_FATAL_POINT로 비동기 오류 지점을 고른다.
trigger_file 지점은 파일 신호로 오류를 발생시켜 세션 생성 전후를 결정적으로 나눈다.
제품 main은 이 설정을 받지 않는다. X 테스트는 같은 PID·부팅 신원 유지, 재연결 후 host_fatal,
추가 효과 0, 반복 오류의 진단 중복 없음, 유휴 기한·SIGTERM 생존을 확인한다.
세션 0개 대조군은 exit 1·소켓 제거·새 호스트 잠금 획득을 확인한다.

### R1-02 명시적 durable 접수 증거

기존 submit 및 상태 전이 구현은 바꾸지 않고 공개 submitWithReceipt(request)를 추가했다.
기존 submit 결과와 별도로 저장된 alias/delivery/control/tombstone 행 및 fingerprint 일치를
read transaction에서 확인하여 {durable,result,code?}를 반환한다.
존재하는 다른 fingerprint의 행은 해당 제출의 durable 증거로 인정하지 않는다.
submitUnavailable을 사용하는 facade에서도 같은 메서드가 해당 submit 경로를 사용한다.

프로토콜은 명시적인 durable 값으로만 accepted/rejected를 나눈다.
미기록 형식 오류·만료·미래 키·fingerprint 충돌은 rejected(id,request_key,code)다.
반대로 저장된 rejected 행, 별칭, 삭제 tombstone과 같은 키의 멱등 결과는 accepted다.
따라서 상태 문자열이나 reason으로 기록 여부를 추측하지 않는다.

### R1-03·04 클라이언트 재확인

accepted 결과라도 control accepted, delivery queued/sending/written/provider_observed,
prompt의 미종결 outcome은 request_key를 보존한다.
reconcile()은 재연결 후 이 키들을 모두 lookup하여 갱신 결과 Map을 반환한다.
조회 결과도 미종결이면 다음 재연결을 위해 계속 남기고 종결·found:false면 제거한다.
prompt의 interrupted 같은 종결 outcome은 provider_observed 상태여도 재확인 대상에서 뺀다.
자동 재제출이나 효과 재전송은 하지 않는다.

submit의 error 응답은 원래 오류 code를 유지하면서 acceptance_unknown으로 reject하고 키를 보존한다.
rejected는 해당 고정 code로 확정 거부하며 새 재확인 대상으로 추가하지 않는다.
응답 유실·시간 초과의 보존 동작도 유지한다. 같은 부팅으로 재연결해도 reconcile로 판정할 수 있다.

### 실패 선확인과 최종 검증

제품 수정 전 신규 P 테스트를 먼저 실행했다: 28개 중 통과 13·실패 15.
다음은 지적별 테스트 이름과 실제 수정 전 결과다.

| 번호 | 테스트 이름 | 수정 전 |
|---|---|---|
| 1 | R1-01 fatal latch rejects every authenticated request without core access or secret leakage | 실패 |
| 1 | X R1-01 asynchronous throw, active ownership=false/true | 호스트 확인 필요 |
| 1 | X R1-01 asynchronous rejection, active ownership=false/true | 호스트 확인 필요 |
| 2 | R1-02 real core non-durable invalid_request/key_expired/key_future/fingerprint_conflict returns rejected instead of accepted | 4개 모두 실패 |
| 2 | R1-02 real core durable rejection and idempotent result still return accepted | 기존 통과, 양성 대조 |
| 3 | R1-03 accepted unfinished prompt/queued·sending·written·provider_observed·completed is looked up after boot change | 5개 모두 실패 |
| 3 | R1-03 accepted unfinished close/accepted is looked up after boot change | 실패 |
| 3 | R1-03 accepted unfinished tool_decision/written is looked up after boot change | 실패 |
| 3 | R1-03 terminal prompt outcome is not retained for lookup | 기존 통과, 종결 대조 |
| 4 | R1-04 submit error storage_unavailable/host_fatal remains acceptance_unknown until lookup | 2개 모두 실패 |
| 4 | R1-04 rejected submit is definitive and never retained for lookup | 실패 |

수정 후 추가한 보강 테스트 4개도 통과한다. 이 4개는 수정 전 실패를 주장하지 않는다.

- R1-03 unfinished lookup remains tracked across another boot, terminal lookup removes it
- R1-04 submit error is reconciled after reconnect to the same boot
- R1-02 receipt recognizes interrupt aliases and deleted delivery tombstones as durable
- R1-02 unavailable adapter receipt preserves fixed adapter_unavailable result

최종 실행은 X 파일을 제외한 명시적 파일 목록으로 했다.
`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test $(rg --files server/tests -g 'session-host-*.test.js' | rg -v 'session-host-process-lifecycle.test.js')`
결과: tests 140, pass 140, fail 0, cancelled 0, skipped 0.
기존 102개와 이전 P·정책 17개, 이번 신규 P·클라이언트 21개가 포함된다.

그 전 이름 필터로 X를 제외하려던 실행에서는 필터가 적용되지 않아 X 14개도 실행됐다.
그 실행은 P 136개 통과·X 14개 샌드박스 실패였다(보강 4개 추가 전).
X의 ps EPERM·소켓 제한을 성공이나 skip으로 처리하지 않았다.
이번 신규 X 4개와 변경 후 기존 X 10개는 실제 macOS에서 호스트 확인이 필요하다.
npm test·commit·push는 실행하지 않았다.

## S1-a2 마무리 — R2 MODERATE 재확인 추적 수명

호스트 확인으로 이전 변경의 전체 154/154(X 포함) 통과와 적대리뷰 R2 GO를 받았다.
이번에는 launcher의 재확인 목록 수명과 보관 데이터만 수정했다.

일반 lookup, submit 응답, eventsSince의 delivery/control transition을 받을 때 즉시 추적 상태를 갱신한다.
종결이면 즉시 제거하고, 미종결이면 마지막 상태만 갱신한다.
분할된 transition은 기존 state/outcome과 합치고 다른 delivery의 이벤트는 적용하지 않는다.
별칭은 같은 delivery id를 기준으로 함께 갱신할 수 있다.
reconcile은 일반 lookup 경로를 사용하므로 별도 정리 루프가 필요하지 않다.

session_deleted 또는 expires_at 필드가 있는 tombstone은 원래 state가 unknown이어도 종결이다.
session_deleted가 0인 tombstone도 재등록하지 않는다. found:false도 추적을 끝낸다.

추적 목록은 request_key·kind·lastState만 보관한다.
lastState는 이벤트 상관관계에 필요한 id와 state/outcome만 투영한다.
요청 본문, 전체 요청 객체, 응답의 delivery 본문·도구 입력 등을 복사하지 않는다.
error·timeout·disconnect 경로도 같은 최소 메타데이터를 사용한다.
진행 중 요청의 응답 매칭용 pending에도 submit의 key·kind만 남긴다.
재확인은 lookup만 호출하며 자동 재제출하지 않는다.

### 실패 선확인

제품 수정 전 클라이언트 테스트 23개를 실행하여 기존 13개 통과·신규 10개 실패를 확인했다.
신규 실패 테스트 이름은 다음과 같다.

- R2-M lookup terminal result immediately removes recheck entry
- R2-M submit/lookup/reconcile session_deleted tombstone immediately ends tracking (3개)
- R2-M terminal transition event immediately removes control/delivery tracking (2개)
- R2-M accepted/error/timeout/disconnect tracking is independent of original request and body (4개)

마지막 네 테스트는 제출이 끝난 원래 요청의 kind/key/body 접근자를 실패하도록 바꾼 뒤
두 번의 재연결·lookup을 수행한다. 원래 요청 객체를 재확인 데이터로 사용하는 회귀를 검출한다.
수정 후 위 23개가 모두 통과했다.
추가로 종결 submit 응답의 기존 항목 제거, 부분·무관 이벤트의 미종결 보존,
session_deleted=0 tombstone의 종결 처리 테스트 3개도 통과했다.
이 보강 3개는 수정 전 실패를 주장하지 않는다.

### 최종 검증

`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test $(rg --files server/tests -g 'session-host-*.test.js' | rg -v 'session-host-process-lifecycle.test.js')`

결과: tests 153, pass 153, fail 0, cancelled 0, skipped 0.
기존·P·정책·클라이언트 테스트를 포함한다. git diff --check도 통과했다.
X 14개는 이번 턴에 실행하지 않았다. 변경 후 전체 예상 167개는 호스트에서 재검증한다.
npm test와 commit/push는 실행하지 않았다.

## S1-b1 — SDK 없는 판정·구성 부품

SDK 설치·실행 및 기존 코어 연결 없이 CommonJS 순수 게이트, env 구성, argv 검사, ps 신원 조회를 추가했다.
고정 버전·해시·Team ID·구독 유형·capability·기한은 pin.js의 동결 객체와 동결 배열에 둔다.
account는 실측된 email·organization·subscriptionType·apiProvider만 허용한다.
인증 출처는 값이 undefined여도 키가 존재하면 거부한다. 미지 필드도 거부한다.
email·organization은 선택 문자열이며 판정 결과와 로그에 넣지 않는다.
재확인은 유효한 구독 account의 전체 값이 같아야 통과한다. 실패·미지 값·메타데이터 변경도 거부한다.
S1-b2는 최초 account 스냅샷을 복사하여 보관하고 조회 예외를 실패 입력으로 전달해야 한다.

resolveSettingsChecked는 함수 없음·예외·10초 정체·구조 이상을 settings_check_failed로 돌려준다.
clock은 밀리초 반환 함수, timers는 setTimeout/clearTimeout 객체로 주입한다.
성공 결과는 warnings, hookSources, mcpSources를 포함한다. 출처는 provenance의 path 필드만 투영한다.
인증 설정 거부의 detail도 provenance.env 또는 provenance.apiKeyHelper의 파일 경로만 포함한다.
설정 값과 전체 sources 객체는 화면 결과에 복사하지 않는다.
시작 확인 화면은 PermissionRequest 경고와 이 경로 목록을 표시하고 실제 시작 여부를 정해야 한다.

incarnation ID는 UUID와 실측 inc_spike_sub를 수용하는 영숫자 시작의 영숫자·밑줄·하이픈 1~128자로 제한한다.
최종 env는 객체이며 중복 키를 표현할 수 없다. 표지 own key 하나·일치 값과 나머지 PALANTIR_* 부재를 검사한다.
SDK 세 변수와 기본 열 변수만 복사하고 인증 변수는 어느 입력에서도 복사하지 않는다.
argv는 고정 절대 경로의 realpath와 스트리밍 SHA-256을 검사한다.
정확히 하나의 --permission-mode=default를 요구하며 다른 permission-mode 표현과 -- 구분자는 보수적으로 거부한다.
Team ID는 이번 부품에서 고정값만 제공한다. 설치 시 codesign 확인과 경로 선택은 S1-b2에서 연결해야 한다.

ps는 /bin/ps만 실행하고 LC_ALL=C로 시작시각 형식을 고정한다.
표지는 공백 토큰 전체 일치로 비교한다. 별도 ppid 조회로 표지 프로세스 중 표지 부모가 없는 유일 루트를 본체로 정한다.
루트가 여럿이거나 목록 형식 이상·중복 pid·시작시각/부모 조회 실패·부분 파싱 실패면 query_failed다.
listMarkedDescendants는 같은 probe에서 findMarked로 확인한 본체 신원만 제외한다.
재시작 직후 본체 신원을 아직 모르면 모든 표지 프로세스를 반환한다. 생존 하위를 본체로 오인해 숨기지 않는 보수적 선택이다.
본체 종료 후 남은 표지 프로세스도 계속 반환한다. 새 probe의 findMarked는 생존 루트를 새 본체로 해석할 수 있으므로,
S1-b2 복구는 저장한 본체 신원을 check로 먼저 판정하고 하위 확인에는 목록 메서드를 사용해야 한다.
ps 조회와 신호 사이의 커널 수준 원자성은 제공하지 않는다. 신호 직전 시작시각 재대조만 수행한다.

macOS의 PID 없음 후보 신호는 ps 종료 코드 1·빈 stdout·빈 stderr·signal/code 없음으로만 제한했다.
성공 코드의 빈 출력, 권한 오류와 그 밖의 실패는 사망으로 바꾸지 않는다.
이번 샌드박스에서 /bin/ps 직접 실행은 operation not permitted로 막혀 PID 없음 동작을 실제 확인하지 못했다.
픽스처는 이 구분을 고정하며 실제 자식·손자 통합 테스트는 호스트에서 반드시 재실행해야 한다.
macOS 실측에서 다른 신호가 나오면 위 부재 판정을 실측에 맞춰 고쳐야 한다. 지금은 확인 완료를 주장하지 않는다.
npm test는 사용자 지시에 따라 호스트가 실행한다.

최종 지정 명령 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js` 결과:
tests 185, pass 170, fail 15, cancelled 0, skipped 0.
신규 18개 중 순수/픽스처 17개 통과, 실제 ps 통합 1개는 샌드박스 조회 제한으로 실패했다.
기존 프로세스 X 테스트 14개도 실패했다. 13개는 spawnSync /bin/ps EPERM,
나머지 1개는 기존 기록과 같은 host_start_timeout이다. 나머지 기존 153개는 통과했다.
실패를 skip이나 성공으로 바꾸지 않았다. 호스트에서 전체 명령과 npm test를 실행해야 한다.
