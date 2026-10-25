# SH1 S1-a1 구현 기록

기준은 승인된 brief v5.6의 §3.3·§3.4·§4·§5·§8.1과 S1-0 기록이다. 이번 결과는 CommonJS in-process 라이브러리다. 소켓·잠금·프로세스 기동·실제 SDK와 ps는 포함하지 않는다. 기존 서버 DB나 서비스에 연결하지 않는다.

## 인터페이스와 실행

`createHostCore({dbPath, adapter, identityProbe, clock, hostBootId, faults})`의 `submit`, `recover`, `snapshot`, `eventsSince`를 사용한다. `onEvent(event)`는 직접 입력 경로이며 같은 이벤트를 `adapter.events`의 `event` 채널로 받을 수 있다. `close()`는 라이브러리 DB 핸들만 해제한다. `idle(sessionId)`는 테스트와 후속 브리지용 조회다. `clock`은 밀리초 반환 함수 또는 `now()` 객체이며 실제 sleep은 없다.

요청 키 형식은 `rk_<epoch ms>_<16+ hex>`다. fingerprint는 키 순서를 정규화한 JSON의 SHA-256이다. 제어 요청에는 본문이 없으며 cwd도 해시로만 fingerprint에 들어간다. 기존 행·tombstone 조회가 시각 검사보다 먼저다. 새 키의 허용 구간은 호스트 시각 기준 24시간 전부터 5분 후까지다. 반환값은 durable 행의 최신 상태이며 SDK 콜백이 동기적으로 처리됐으면 완료 상태일 수도 있다. fingerprint 충돌은 `status:409`다.

`adapter.start({incarnation_id,session_id,cwd})`, `send(incarnationId,uuid,text)`, `decide(incarnationId,toolUseId,decision)`, `interrupt(incarnationId)`, `close(incarnationId)`를 사용한다. §2.4 경계를 여러 세션에 쓰기 위해 incarnation 인자를 명시했다. `facts(incarnationId,toolUseId)`는 선형화 구간의 최종 SDK 사실 조회다. `signal(incarnationId,signal)`은 가짜 신호 경로다. 실제 OS 호출은 없다. S1-b2a부터 `authCheck()`·`settingsCheck()` 대신 `checkSettings(cwd)`·`accountInfo(incarnationId)`와 `initialization`·`initialization_failed` 이벤트를 사용한다. 코어는 값과 thenable을 지원하고 실제 SDK 어댑터는 Promise를 반환한다. 상세 계약은 아래 S1-b2a 절에 있다.

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
email·organization은 own property인 비어 있지 않은 문자열이어야 하며 판정 결과와 로그에 넣지 않는다.
재확인은 유효한 구독 account의 전체 값이 같아야 통과한다. 실패·미지 값·메타데이터 변경도 거부한다.
S1-b2는 최초 account 스냅샷을 복사하여 보관하고 조회 예외를 실패 입력으로 전달해야 한다.

resolveSettingsChecked는 함수 없음·예외·10초 정체·구조 이상을 settings_check_failed로 돌려준다.
clock은 밀리초 반환 함수, timers는 setTimeout/clearTimeout 객체로 주입한다.
성공 결과는 warnings, hookSources, mcpSources를 포함한다. 출처는 provenance의 path 필드만 투영한다.
인증 설정 거부의 detail도 provenance.env 또는 provenance.apiKeyHelper의 파일 경로만 포함한다.
설정 값과 전체 sources 객체는 화면 결과에 복사하지 않는다.
시작 확인 화면은 PermissionRequest 경고와 이 경로 목록을 표시하고 실제 시작 여부를 정해야 한다.

incarnation ID는 코어 randomUUID()가 만드는 UUID v4 형식으로 제한한다. 다른 버전·variant·실측용 단순 ID는 거부한다.
최종 env는 null prototype 객체다. 표지 own key 하나·일치 값과 나머지 PALANTIR_* 부재를 검사한다.
SDK 세 변수와 기본 열 변수만 복사하고 인증 변수는 어느 입력에서도 복사하지 않는다.
argv는 고정 절대 경로의 realpath와 스트리밍 SHA-256을 검사한다.
정확히 하나의 --permission-mode=default를 요구하며 다른 permission-mode 표현과 -- 구분자는 보수적으로 거부한다.
Team ID는 이번 부품에서 고정값만 제공한다. 설치 시 codesign 확인과 경로 선택은 S1-b2에서 연결해야 한다.

ps는 /bin/ps만 실행하고 LC_ALL=C로 시작시각 형식을 고정한다.
표지는 UUID v4 공백 토큰 전체 일치로 비교한다. 별도 ppid 조회로 표지 부모가 없는 유일 루트를 구한다.
그 루트의 command는 주입된 고정 CLI 절대 경로 + 공백으로 시작해야 본체로 인정한다.
루트가 여럿이거나 목록 형식 이상·중복 pid·시작시각/부모 조회 실패·부분 파싱 실패면 query_failed다.
listMarkedDescendants는 같은 probe에서 findMarked로 확인한 본체 신원만 제외한다.
재시작 직후 본체 신원을 아직 모르면 모든 표지 프로세스를 반환한다. 생존 하위를 본체로 오인해 숨기지 않는 보수적 선택이다.
본체 종료 후 남은 표지 프로세스도 계속 반환한다. 새 probe의 findMarked는 생존 루트를 새 본체로 해석할 수 있으므로,
S1-b2 복구는 저장한 본체 신원을 check로 먼저 판정하고 하위 확인에는 목록 메서드를 사용해야 한다.
ps 조회와 신호 사이의 커널 수준 원자성은 제공하지 않는다. 신호 직전 시작시각 재대조만 수행한다.

macOS의 PID 없음 신호는 ps 종료 코드 1·길이 0인 stdout·길이 0인 stderr·signal/code 없음으로만 제한한다.
성공 코드의 빈 출력, 권한 오류와 그 밖의 실패는 사망으로 바꾸지 않는다.
첫 구현의 호스트 검증에서 실제 macOS 185/185 통과를 확인받았다(실제 ps 포함).
호스트 실측: 종료된 pid는 종료 1·stdout/stderr 길이 0, 범위 밖 pid는 종료 1·stderr 있음이다.
이번 수정의 실제 자식·손자 통합 테스트는 샌드박스 제한 때문에 호스트에서 다시 실행해야 한다.
npm test는 사용자 지시에 따라 호스트가 실행한다.

최종 지정 명령 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js` 결과:
tests 185, pass 170, fail 15, cancelled 0, skipped 0.
신규 18개 중 순수/픽스처 17개 통과, 실제 ps 통합 1개는 샌드박스 조회 제한으로 실패했다.
기존 프로세스 X 테스트 14개도 실패했다. 13개는 spawnSync /bin/ps EPERM,
나머지 1개는 기존 기록과 같은 host_start_timeout이다. 나머지 기존 153개는 통과했다.
실패를 skip이나 성공으로 바꾸지 않았다. 호스트에서 전체 명령과 npm test를 실행해야 한다.


## S1-b1 수정 라운드 1 — 표지·출력·상속 입력 검증

사용자가 전달한 적대리뷰 R1의 7개 항목을 보강했다. SDK 설치·실행과 기존 코어 변경은 없다.
ps -E는 argv와 env를 구분하지 못한다. 코어가 randomUUID()로 생성한 추측 불가능한 UUID v4만 사용하고,
probe 생성 시 S1-b2가 검증한 고정 CLI 절대 경로를 pinnedPath로 주입해야 한다.
findMarked는 유일 표지 루트의 command가 정확한 경로 + 공백으로 시작하는지도 확인한다.
공백 든 실행 경로를 토큰 분할하지 않으며 경로 접두만 같은 다른 실행 파일도 거부한다.
하위 프로세스 목록에는 실행 파일 제한을 걸지 않는다. 같은 UID는 격리 경계가 아니다(brief §3.2).
UUID 형식 검증만으로 난수 생성 자체를 증명할 수 없으므로 S1-b2는 외부 ID를 예약 ID 대신 넣으면 안 된다.

줄 끝의 표지 값이 찾는 UUID의 진접두(빈 값 포함)면 조회 전체를 query_failed로 돌려준다.
파싱 불가 줄을 버리지 않으며, 이미 유효한 행이 있어도 뒤의 부분 결과를 성공으로 처리하지 않는다.
자식 env는 Object.create(null)에 허용 own key만 복사한다.
최종 검사는 null prototype을 요구하고 for...in으로 열거 키를 검사한다.
부재 판정은 공백을 trim하지 않는다. 누락된 stream도 빈 stream으로 취급하지 않는다.
lstart는 ps가 붙인 마지막 LF 하나만 제거한 한 줄을 검증한다.
요일·월 이름, 일 1~31, 시 0~23, 분·초 0~59를 확인하고 공백을 하나로 정규화하여 저장·비교한다.
저장된 startedAt에는 줄바꿈을 허용하지 않는다.
account는 Object.prototype 또는 null prototype만 허용하고 own property만 판정한다.
email·organization의 누락·빈 문자열·공백 문자열도 거부한다. 메타데이터를 결과나 로그에 노출하지 않는다.

### 실패 선확인

제품 수정 전 `node --test server/tests/session-host-gate-review-r1.test.js` 실행:
tests 11, pass 2, fail 9, cancelled 0, skipped 0.
모든 테스트는 통과 대조를 포함하며, 아래 기존 통과 2개는 수정 전 실패를 주장하지 않는다.

| 번호 | 테스트 이름 | 수정 전 |
|---|---|---|
| 1 | R1-01 UUID v4 required by env and both marker queries | 실패 |
| 1 | R1-01 main executable must match pinned path including spaces | 실패 |
| 2 | R1-02 truncated marker prefixes and malformed PID fail closed | 실패 |
| 3 | R1-03 child env has null prototype and inherited pollution is rejected | 실패 |
| 4 | R1-04 only zero-length absent streams prove death | 실패 |
| 5 | R1-05 lstart rejects extra lines and invalid calendar/time ranges | 실패 |
| 5 | R1-05 lstart compares normalized spaces | 실패 |
| 6 | R1-06 account requires own nonempty email and organization | 실패 |
| 6 | R1-06 account rejects custom prototypes regardless of inherited fields | 실패 |
| 7 | R1-07 streaming hash uses an independent known SHA-256 literal | 기존 통과 |
| 7 | R1-07 hash throw and rejection refuse spawn with passing controls | 기존 통과 |

7번은 임시 파일의 고정 내용 abc와 알려진 SHA-256 리터럴을 비교한다.
테스트 안에서 crypto.createHash로 기대값을 계산하지 않는다.
같은 파일 내용만 abcd로 바꾸는 거부 대조와 hashFile throw/reject의 통과 대조를 추가했다.
기존 env/ps 테스트는 UUID v4·null prototype·고정 경로 계약에 맞춰 갱신했다.
실제 ps 테스트는 임의 UUID v4와 process.execPath를 고정 경로로 사용한다.

### 수정 후 검증

지정 전체 명령 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js`:
tests 196, pass 181, fail 15, cancelled 0, skipped 0.
R1 신규 11개는 모두 통과했다. 기존 순수·픽스처 170개도 통과했다.
실패는 기존 X 14개(ps EPERM 13개·host_start_timeout 1개)와 실제 ps 통합 1개다.
호스트가 전달한 이전 185/185 통과와 구분하며 수정 후 196개는 호스트에서 다시 확인해야 한다.
npm test·SDK 설치·실제 claude 실행·git 조작은 하지 않았다.

## S1-b1 수정 라운드 2 — 여러 줄 argv의 ps 귀속 결함

호스트 검증은 이전 라운드 196개 중 195개 통과였다.
실제 ps 통합 1개는 샌드박스에만 기인한 실패가 아니라 구현 결함이었다.
이전 보고의 샌드박스 추정을 정정한다. Node -e 소스나 Bash -c 명령의 줄바꿈은 전역 ps 출력에도 나타난다.
따라서 전역 출력의 한 줄을 한 프로세스로 해석하거나 해석 불가 줄을 모두 오류로 보는 규칙은 폐기한다.

전역 `ps -E -ww -A -o pid=,command=` 출력은 전체 문자열에서 표지 토큰과 줄 끝 진접두의 존재만 확인한다.
정상 종료·비어 있지 않은 출력에서 둘 다 없으면 빈 목록이다. 진접두가 있으면 보수적으로 query_failed다.
정확한 토큰이 있으면 별도 `ps -A -o pid=`로 PID 목록을 구한다.
이 목록만 정수·중복·상한을 검증하며 전역 command 출력의 PID 같은 문자열은 신뢰하지 않는다.
각 PID에 `ps -E -ww -o command= -p <pid>`를 실행한다.
이 출력은 여러 줄이어도 해당 PID 하나에 귀속되므로 전체 문자열에서 표지를 검사한다.
표지 PID만 시작시각과 부모 PID를 조회한다. 유일 루트·고정 실행 경로·하위 목록 규칙은 유지한다.
개별 command·시작시각·부모 조회 중 PID가 종료 1·stdout/stderr 길이 0으로 사라지면 건너뛴다.
다른 실패·빈 성공 출력·잘린 표지·잘못된 PID 목록은 query_failed로 남긴다.

기본 상한은 스캔당 PID 4096개, 전체 기한 10000ms다.
maxPids와 deadlineMs는 테스트에서 낮춰 주입할 수 있으며 기본 상한보다 큰 값은 거부한다.
clock은 기본 단조 시계 performance.now이며 주입할 수 있다.
모든 ps 호출 전에 남은 시간을 검사하고 명령 timeout은 min(5000ms, 남은 시간의 올림)이다.
호출 후와 결과 반환 시에도 기한을 검사하여 늦은 정상 반환을 성공으로 처리하지 않는다.
findMarked/listMarkedDescendants는 성공·실패 모두 diagnostics: {elapsedMs, queryCount}를 반환한다.
queryCount는 전역·PID 목록·개별 command·시작시각·부모 조회를 포함한 실제 ps 호출 횟수다.
check/verifyThenSignal의 기존 문자열 인터페이스는 유지한다.

### 실패 선확인

수정 전 `node --test server/tests/session-host-ps-identity-r2.test.js`:
tests 7, pass 0, fail 7.
아래 픽스처 6개는 수정 전 실패를 확인했고, 실제 ps 1개는 대조군부터 샌드박스 제한으로 실패했다.
실제 테스트 실패를 이 환경에서 결함 재현 성공으로 주장하지 않는다.

- R2-01 unrelated multiline argv and marked multiline argv use per-PID attribution
- R2-01 global no-token multiline output succeeds empty without per-PID queries
- R2-02 marker-looking global PID never determines attribution
- R2-02 disappearing PID is skipped; other errors and malformed PID lists fail closed
- R2-02 prefix-only global and per-PID output fail closed with full-token controls
- R2-03 PID count and total deadline are bounded and diagnostic counts reflect executed queries
- R2 real ps ignores unrelated multiline argv while identifying a marked child

실제 테스트는 한 줄 argv 표지 자식으로 통과 대조를 먼저 확인하고,
표지가 없는 여러 줄 argv 자식을 추가해도 본체·빈 하위 목록이 유지되는지 검증한다.
기존 자식·손자 테스트의 여러 줄 소스도 그대로 유지했다.
그 테스트 기한은 스캔 전체 기한과 복수 조회를 수용하도록 30초로 늘렸다.
기존 픽스처는 전역·PID 목록·PID별 command를 분리했고 진단 필드는 별도로 확인한다.
이전 R1의 잘못된 PID 검증은 이제 전역 command가 아닌 PID 목록에 적용한다.

### 수정 후 검증

지정 명령 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js`:
tests 203, pass 187, fail 16, cancelled 0, skipped 0.
R2 픽스처 6개 및 기존 순수·픽스처 181개가 통과했다.
실패는 기존 프로세스 X 14개(ps EPERM 13개·host_start_timeout 1개)와 실제 ps 통합 2개다.
실제 ps 회귀 테스트는 통과 대조부터 이 샌드박스에서 query_failed다.
이 결과로 실제 macOS 결함이 해결됐다고 단정하지 않는다. 호스트에서 두 실제 ps 테스트를 포함해 재검증해야 한다.
SDK 설치·실제 claude 실행·npm test·git 조작은 하지 않았다.

## S1-b1 수정 라운드 3 — lstart 열 맞춤·신원 구간·조회 불일치

호스트 실측으로 macOS lstart 출력의 끝에 열 맞춤 공백이 있음을 확인받았다.
실제 값 `"Sat Oct 24 17:40:20 2026    \n"`을 기존 엄격 검사가 거부한 것은 구현 결함이다.
normalizeStart는 마지막 LF 하나를 제거한 뒤 끝의 ASCII 공백(0x20)만 제거한다.
탭·NBSP·CR·추가 줄바꿈은 제거하지 않으며 기존 형식·범위 검사로 거부한다.
공백 정규화와 check의 문자열 3값 인터페이스는 유지한다.
호스트는 process.execPath와 ps command가 모두 Node의 realpath임도 확인했다. 테스트의 고정 경로 주입을 유지한다.

PID 재사용을 막기 위해 모든 개별 command 조회 전에 lstart를 먼저 읽는다.
표지 후보에는 `lstart 전 → command → ppid → lstart 후` 순서를 요구한다.
두 정규화 시작시각이 같을 때만 command·부모·시작시각을 같은 신원으로 확정한다.
다르면 query_failed다. 표지 여부를 아직 모르는 PID도 command 전 시작시각 조회가 필요하다.
후보 확인 도중 PID가 사라지면 그 PID는 버리고, 조회 오류는 기존대로 query_failed다.
단, 모든 후보가 사라졌다고 곧바로 빈 목록으로 확정하지 않는다.

전역 표지가 양성인데 개별 조회로 표지 신원을 하나도 확정하지 못하면 내부적으로 inconsistent다.
이 경우에만 전역 조회부터 전체 스캔을 한 번 다시 한다.
다시 불일치하면 query_failed다. 재조회 전역이 정상 음성이면 그 시점의 빈 목록을 인정한다.
형식 오류·권한 오류·시작시각 불일치는 불일치 재시도로 감추지 않고 즉시 실패한다.
재시도는 최초의 10000ms 기한과 누적 4096 PID 예산을 공유한다.
diagnostics의 조회 횟수와 시간도 두 시도를 합쳐 반환한다.
호스트가 측정한 이전 구현의 545 PID 약 3.3초는 새 이중 신원 검사 성능의 실측값이 아니다.
추가 lstart 조회 비용을 포함한 실제 macOS 실행 시간은 호스트에서 재확인해야 한다.

account의 일반 필드는 own property로 확인하지만 인증 출처는 예외다.
tokenSource·apiKeySource는 `in`으로 검사하여 own·상속·undefined 값 모두 존재하면 거부한다.
Object.prototype 또는 null prototype만 허용하는 규칙은 유지한다.
Object.prototype에 두 필드를 각각 임시로 심는 테스트는 try/finally로 원래 descriptor를 복원하거나 삭제한다.

### 남은 한계와 ps 계약 가정

R1-01: ps 출력만으로 argv와 env를 구분할 수 없다.
코어 randomUUID()로 만든 추측 불가능한 UUID v4와 본체 command의 고정 실행 파일 경로 두 조건을 함께 요구한다.
이것은 같은 UID 프로세스에 대한 격리가 아니다. 같은 UID는 격리 경계가 아니다(brief §3.2).
하위 도구는 어떤 실행 파일이든 가능하므로 표지와 신원 구간 검사로 판정한다.
lstart는 초 단위이므로 같은 초 안의 PID 재사용이나 신호와 조회 사이의 커널 수준 원자성을 보장하지 않는다.

R1-02: `-ww`는 폭 제한 없는 출력을 요청한다. 표지 앞에서의 잘림은 ps 계약상 일어나지 않는다고 가정한다.
따라서 검출 가능한 줄 끝 표지 진접두만 검사한다. 앞 잘림까지 검출한다는 보장은 하지 않는다.
버퍼 상한·명령 기한 초과·명령 실패는 성공한 잘린 출력으로 취급하지 않고 query_failed다.

### 실패 선확인

제품 수정 전 `node --test server/tests/session-host-gate-review-r3.test.js`:
tests 9, pass 0, fail 9. 아래 9개 모두 수정 전 실패를 확인했다.

- R3-01 actual macOS lstart literal accepts ASCII padding and rejects other trailing whitespace
- R3-02 candidate command and parent are bracketed by equal lstart reads
- R3-02 reused PID between command and parent cannot establish main or descendant identity
- R3-03 persistent global-positive individual-negative mismatch retries once and rejects
- R3-03 retry resolves transient mismatch by rerunning global and individual queries
- R3-03 retry may confirm globally absent marker but never returns empty on persistent disappearance
- R3-03 retries share the original deadline and PID budget
- R3-04 inherited Object.prototype.tokenSource rejects initialization and recheck with cleanup
- R3-04 inherited Object.prototype.apiKeySource rejects initialization and recheck with cleanup

각 거부 사례는 같은 조건의 통과 대조를 포함한다.
수정 후 위 9개가 모두 통과했다. 기존 R2 진단 횟수 기대값은 추가 lstart 조회를 반영해 갱신했다.

### 전체 검증

`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js`:
tests 212, pass 196, fail 16, cancelled 0, skipped 0.
R3 신규 9개를 포함한 순수·픽스처 테스트 196개가 통과했다.
실패는 기존 X 14개(ps EPERM 13개·host_start_timeout 1개)와 실제 ps 테스트 2개다.
실측 리터럴에 대한 수정은 검증했지만 이 샌드박스에서 실제 macOS ps 통합의 통과를 확인한 것은 아니다.
호스트에서 전체 212개와 실제 조회 시간을 재검증해야 한다.
SDK 설치·실제 claude 실행·npm test·git 조작은 하지 않았다.


## S1-b2a — 비동기 인증·설정 게이트 코어 연결

SDK 없이 S1-b1의 authGate·spawnEnv·pin을 코어와 가짜 어댑터에 연결했다.
§4.4는 접수 행·세션·incarnation 예약을 같은 트랜잭션으로 묶으므로 순서는
예약 → 설정 검사 → spawn이다. §5-1의 설정 검사 → 예약이라는 설명과 순서는 다르지만,
spawn 전에 검사하고 검사 실패 시 spawn 0이라는 계약은 유지한다.

### 어댑터 경계와 동기·비동기 호환

| 경계 | 계약 |
|---|---|
| `checkSettings(cwd)` | resolveSettings 결과 값 또는 thenable. 실제 SDK는 Promise |
| `accountInfo(incarnationId)` | account 값 또는 thenable. 실제 SDK는 Promise |
| `start({incarnation_id,session_id,cwd,...resume})` | 예약 ID로 한 번만 실행하고 pid·startedAt·provider 대화 ID를 동기 반환 |
| `initialization` | `initialization` 필드에 account·pid·claude_code_version·current_permission_mode·remote_control_auto_enable을 포함한 초기화 응답 전문 |
| `initialization_failed` | 고정 코드. 외부 자유문 code를 저장하지 않고 내부 `initialization_failed`로 처리 |
| `close(incarnationId)` | 정리 요청. 반환·Promise 완료 자체는 본체 사망 증거가 아님 |
| `rate_limit` | `rate_limit_info`의 status·resetsAt·rateLimitType·overageStatus·overageDisabledReason·isUsingOverage |

코어의 continueResult 한 곳에서 반환값의 thenable 여부를 가른다.
즉시 값은 같은 틱의 세션 큐로 이어지고, 미완료 값은 큐를 점유하지 않으며 완료를 큐에 다시 넣는다.
동기 설정 값에는 evaluateResolvedSettings를 직접 적용한다.
R1부터 어댑터 호출 전에 잡은 절대 기한은 동기 값에도 적용한다.
thenable에는 남은 시간으로 resolveSettingsChecked를 적용하며 어댑터를 두 번 호출하지 않는다.
설정 기한에는 주입 clock과 tick 타이머를 사용한다. 실제 setTimeout·sleep은 없다.

가짜 어댑터는 기본적으로 설정·account 값과 start 내부 초기화 이벤트를 동기로 제공한다.
`async: true`는 두 조회를 Promise로, 초기화 이벤트를 다음 microtask로 바꾼다.
동기 start 안에서 온 초기화 이벤트는 신원 커밋 뒤 같은 세션 큐에서 판정한다.
판정 때 pid·생존 상태를 다시 읽으므로 신원 커밋 전 스냅샷의 null pid를 쓰거나,
초기화와 함께 이미 exit한 실행을 done으로 바꾸지 않는다.

가짜도 buildChildEnv/assertChildEnv를 통과한 뒤에만 starts를 기록한다.
테스트 전용 injectEnv로 PALANTIR_TOKEN 등을 섞으면 spawn 0·invalid_child_env다.
실제 SDK·argvCheck·고정 실행 파일 검증 연결은 S1-b2b 범위다.
공개 submit·receipt·lookup의 동기 반환 계약은 유지한다.
미구현 제품 어댑터의 submitUnavailable도 adapter_unavailable 고정 응답을 유지한다.

### 게이트·정리·복구

시작·재개 제어 요청 stage는 requested → settings_checking → settings_checked → spawn_sent → gating → done이다.
검사 거부는 settings_rejected 또는 settings_check_failed와 never_started를 함께 커밋한다.
설정 값은 저장하지 않고 판정·경고·출처 경로만 events에 쓴다. 출처 경로는 control reason이나 snapshot에 넣지 않는다.

초기화 게이트는 evaluateInitialization으로 account·pid·버전·권한 모드·원격 제어를 전부 검사한다.
초기화 기한은 pin의 60초이며, tick 검사와 늦은 초기화 응답의 수신 시각 검사로 닫는다.
실패하면 gate_rejected 이벤트와 gate_close_sent를 기록한 뒤 close한다.
본체 exit를 최대 5초 기다리고, 미확인이면 gate_signal_sent 커밋 뒤
identityProbe.verifyThenSignal(pid, startedAt, SIGTERM)을 한 번 호출한다.
다시 최대 5초 뒤 본체 신원과 listMarkedDescendants를 확인한다.
신원 불일치·조회 실패 때는 신호가 나가지 않는다.

본체 사망과 빈 표지 하위 목록이 함께 확인돼야 exited와 gate_rejected_cleaned
또는 initialization_failed·initialization_timeout으로 종결한다.
하위 생존·조회 실패·본체 생존은 liveness_unknown과 gate_rejected_unverified다.
close·신호·정리 판정은 모두 세션 큐 안에서 실행한다.
게이트 전 hooks·MCP 실행 가능성은 gate_rejected 이벤트로 화면에 전달할 수 있다.

settings_checking 중 크래시는 spawn이 없으므로 신원 조회 없이 never_started·failed(not_started)다.
gating 중 크래시는 저장한 pid·시작시각으로 판정하며 match이면 orphaned·blocked(control_lost)다.
어떤 복구도 spawn을 반복하거나 게이트 미통과 orphaned에 prompt를 보내지 않는다.

### prompt 재확인과 사후 탐지

초기 account 원본은 재확인 판정에 필요한 메모리 복사본으로만 보관한다.
DB account_snapshot에는 subscriptionType·apiProvider만 저장한다.
초기화 응답 원문·email·organization은 DB·events·snapshot에 저장하지 않는다.
exit 또는 코어 close 때 메모리 기준 account도 제거한다.

큐 맨 앞 prompt를 꺼낼 때 accountInfo와 evaluateAccountRecheck를 적용한다.
각 delivery ID·turn_gen에 묶인 일회용 통과 토큰을 sending 트랜잭션에서 검사하고 소비한다.
조회 예외·변경·미지 account는 rejected(auth_recheck_failed), send 0이다.
다음 prompt는 자기 차례에 새 조회를 해야 하며 앞 prompt의 토큰을 재사용하지 않는다.
재확인 중 인터럽트는 그 재확인만 무효화한다. 아직 재확인을 시작하지 않은 대기 prompt의 기존 상태는 보존한다.
exit·세션 상태 변화도 dispatch의 재검증으로 차단한다.
sending 커밋 → facts → 효과 호출의 동기 구간에는 await가 없다.

첫 system/init은 evaluateSystemInit으로 판정한다.
apiKeySource가 정확히 none이 아니면 턴을 errored(auth_source_not_subscription)로 기록하고
기존 capability 누락과 같은 호스트 close 제어 경로로 닫는다.
기존 실패 원인은 exit 정리의 host_lost로 덮어쓰지 않는다.
capability 누락의 첫 턴 증거·턴 종료 뒤 자동 close·사람 제어 우선 계약은 유지한다.
rate limit은 events에 기록하고 incarnation별 최신 값을 snapshot의 rate_limit_info로 투영한다.
재기동 뒤에도 유지되며 새 incarnation에는 앞 실행의 한도 값을 복사하지 않는다.

### 테스트와 수정 전 실패 증거

기본 동기 모드 덕분에 기존 동기 테스트 대부분은 원래 단언 그대로 실행한다.
삭제된 authCheck/settingsCheck 계약을 직접 검증하던 control 테스트 3건만
새 필수 코드(settings_rejected·auth_recheck_failed·gate_rejected_cleaned)와
5초+5초 tick 정리 계약에 맞췄다. 실패 상태·spawn/send/close/신호 횟수 단언은 유지하거나 보강했다.
즉시 SIGTERM을 기대하던 단언은 실제 신원 재대조 인터페이스인 probe.signals를 확인한다.

S1-b2a 테스트는 async-gate 26개·dual-gate 14개·gate-flow 54개, 총 94개다.
정상 지시 20회·승인 10회, 전달 크래시 3곳, 인터럽트 영수증, stop/resume/close는
동기와 async:true 모드 양쪽에서 같은 증거를 검증한다.
설정 거부·throw·10초 정체·구조 오류·함수 없음, 여섯 account 모양,
초기화의 pid·버전·권한·원격 제어, 정리 단계·신원 판정·하위 조회,
두 새 크래시 stage, 재확인 예외·변경·대기 중 인터럽트/exit/상태 변화,
사후 인증 탐지·최신 rate limit·금지 env도 비동기 모드에서 검증한다.
settle helper는 microtask와 tick을 소진하며 실제 sleep을 사용하지 않는다.

이번 수정 시작 전 WIP 제품 파일을 /tmp/sh1-b2a-baseline에 복사해 보존했다.
git checkout·reset 없이 같은 최종 테스트 94개를 이 보관본에 실행했다.
보관본은 이미 S1-b2a 일부 구현을 포함하므로 전체 94개가 수정 전 실패했다고 주장하지 않는다.
결과 원문 요약은 tests 94, pass 83, fail 11, cancelled 0, skipped 0이다.

수정 전 실패 11개는 다음과 같다.

- non-subscription system init fails turn and closes
- sync adapter returns values and initialization at the contracted time
- sync crash before_accepted_reply never retransmits
- delayed initialization passes before deadline and fails at deadline without tick
- async queued prompts each consume a fresh recheck token only when dequeued
- async system init source ANTHROPIC_API_KEY / 빈 문자열 / null / undefined의 네 사례
- async unknown account null / undefined의 두 사례

현재 동일 명령의 제품 경로 실행:
`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-{async-gate,dual-gate,gate-flow}.test.js`

결과 원문 요약: tests 94, pass 94, fail 0, cancelled 0, skipped 0.

### 지정 전체 검증과 환경 제한

`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js`

결과 원문 요약: tests 306, pass 290, fail 16, cancelled 0, skipped 0.
새 S1-b2a 94개와 기존 순수·픽스처 196개는 전부 통과했다.
실패는 X 14개(ps EPERM 13개·host_start_timeout 1개)와 실제 ps 통합 2개다.
직접 /bin/ps spawnSync 재확인도 status:null·error:EPERM이었다.
두 실제 ps 테스트는 통과 대조부터 query_failed이며 이 환경에서 실제 프로세스 귀속을 검증하지 못했다.
실패를 skip이나 통과로 바꾸지 않았다. 호스트에서 전체 306개를 다시 실행해야 한다.

이전 기록의 maxExecInvocations 5회를 셸 호출 상한으로 해석한 것은 잘못이었다.
호스트 재호출 상한이라는 사용자 정정에 따라 필요한 명령·테스트를 실행했다.
S1-b1 판정 모듈·pin·프로세스/프로토콜 공개 API 파일·설계 원문은 수정하지 않았다.
SDK 설치·실제 claude 실행·npm test·git 조작은 하지 않았다.


## S1-b2a 수정 라운드 1 — 게이트 전 응답·설정 절대 기한·rate limit 정제

호스트가 이전 구현을 실제 macOS에서 306/306 통과했다고 확인한 뒤 받은 적대리뷰 R1을 반영했다.
새 테스트 파일은 `server/tests/session-host-gate-flow-r1.test.js`이며 제품 코드를 고치기 전에 실행했다.
S1-b1의 authGate·spawnEnv·argvCheck·psIdentity·pin은 수정하지 않았다.

### 1. 게이트 전 승인·질문 응답 차단

sending과 같은 트랜잭션의 재검증에서 해당 incarnation의 start/resume이 done·stage done인지,
메모리에 게이트 통과 account가 있는지, 해당 게이트 정리가 진행 중이지 않은지 검사한다.
미통과·정리 중 tool_decision·question_answer는 rejected(gate_pending)이며 decide 효과는 0이다.
거부한 delivery만 종결하고 카드는 pending으로 두므로, 통과 뒤 사람이 새 키로 다시 답할 수 있다.
이미 거부한 같은 키는 게이트 통과 뒤에도 그대로 거부 상태를 반환한다.

start 내부에서 신원 커밋보다 먼저 온 tool_request도 버리지 않는다.
큐에서 처리할 때 incarnation 생존 상태를 다시 읽어 카드로 기록한다.
게이트 실패 정리 종료 시에는 본체 종료가 확인됐는지와 무관하게 남은 pending 카드를 expired로 만든다.
이 변경은 정리 미확인의 liveness_unknown에도 적용한다.

`B2a-R1-01` 테스트 10개:
동기·비동기 × 승인·질문의 게이트 전 거부/통과 후 새 답변 4개,
정리 두 단계에서의 거부와 카드 만료 4개,
start 내부 조기 카드 기록과 게이트 거부 뒤 만료 2개다.
수정 전 10개 모두 실패했고 수정 후 전부 통과했다.

### 2. 어댑터 호출 전부터 공유하는 설정 절대 기한

settings_checking에서 checkSettings 호출 직전에 `now() + pin.resolveSettingsDeadlineMs`를 잡는다.
동기 값은 이미 절대 기한에 도달했으면 구조 검사를 진행하지 않고 settings_check_failed로 거부한다.
thenable은 호출이 소비한 시간을 뺀 remaining만 resolveSettingsChecked에 넘긴다.
주입 타이머의 만료 시각도 원래 절대 기한으로 고정한다.
기한이 이미 끝났으면 반환된 Promise의 rejection을 관측해 미처리 거절을 방지하면서 즉시 실패한다.
동기 값·비동기 완료·예외 결과는 큐 복귀 시 같은 절대 기한으로 다시 검사한다.
판정 중 또는 큐 복귀 전에 기한을 넘겨도 spawn하지 않는다. 실제 타이머나 sleep은 추가하지 않았다.

`B2a-R1-02` 테스트 9개:
동기 값·Promise·thenable 각각 10000ms/10001ms 지연 반환 6개,
기한 뒤 throw/reject 2개, 호출 중 6000ms 소비 후 남은 4000ms만 기다리는 사례 1개다.
지연 반환의 통과 대조는 9999ms다.
수정 전 7개 실패·2개 통과였고 수정 후 9개 모두 통과했다.
throw/reject 2개는 기존에도 거부됐으므로 새 결함 재현 성공으로 주장하지 않는다.

### 3. rate limit만 저장 전에 정제

rate_limit은 onEvent 진입에서 type·incarnation_id·정제한 rate_limit_info로 새 객체를 만든다.
허용 키는 status·resetsAt·rateLimitType·overageStatus·overageDisabledReason·isUsingOverage뿐이다.
값은 문자열·유한 숫자·불리언·null만 복사한다.
객체·배열·undefined·함수·symbol·bigint·NaN·Infinity는 버린다.
이 객체만 sdk 이벤트와 rate_limit 이벤트에 들어가므로 일반 sdk 원문 저장이 우회 경로가 되지 않는다.
email·organization·account는 최상위와 rate_limit_info 양쪽에서 버린다.
다른 SDK 이벤트의 원문 정책은 바꾸지 않았으며 S1-b2b에서 정한다.

`B2a-R1-03` 테스트 10개:
동기·비동기 메타데이터 2개와 허용하지 않는 값 타입 8개다.
DB events 행·snapshot·eventsSince·재기동 snapshot을 확인하며,
깨끗한 통과 이벤트와 동일 필드에 금지 값을 넣은 거부 대조를 함께 실행한다.
수정 전 7개 실패·3개 통과였고 수정 후 모두 통과했다.
undefined·함수·symbol 3개는 기존 JSON 직렬화도 버리므로 수정 전 실패를 주장하지 않는다.

### 4. 정리 미확인 뒤 늦은 exit는 결함이 아님

호스트 판정대로 incarnation의 exited는 본체 종료라는 사실이다.
본체 종료 후에도 표지 하위 프로세스가 남을 수 있으므로 이 상태만으로 재개·넘기기를 허용하지 않는다.
resume과 handoff는 제출 때 §3.4의 listMarkedDescendants를 다시 확인한다.
따라서 늦은 child_exit가 liveness_unknown을 exited로 바꾸는 기존 전이는 유지했다.
이미 종결된 start/resume control의 failed(gate_rejected_unverified) 사유도 바꾸지 않는다.

`B2a-R1-04` 동기·비동기 테스트 2개는 수정 전부터 모두 통과했다.
정리 미확인 → 늦은 본체 exit → 표지 하위 생존 상태에서
resume rejected(subprocess_remaining)·handoff blocked(subprocess_remaining)·추가 spawn 0을 확인한다.
같은 하위 표지만 제거하면 새 resume은 done이고 spawn이 정확히 한 번 늘어난다.
이후에도 원래 control의 gate_rejected_unverified 사유가 보존된다.

### 실패 선확인과 최종 검증

수정 전:
`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-gate-flow-r1.test.js`

원문 요약: tests 31, pass 7, fail 24, cancelled 0, skipped 0.
번호별 실패는 1번 10/10, 2번 7/9, 3번 7/10, 4번 0/2다.
수정 후 같은 명령: tests 31, pass 31, fail 0, cancelled 0, skipped 0.

지정 전체 명령:
`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js`

원문 요약: tests 337, pass 321, fail 16, cancelled 0, skipped 0.
기존 기능·픽스처 290개와 신규 31개는 모두 통과했다.
실패는 기존 X 14개(ps EPERM 13개·host_start_timeout 1개)와 실제 ps 통합 2개(query_failed)다.
실패를 skip하지 않았다. 이번 라운드의 전체 337개는 실제 macOS 호스트에서 다시 확인해야 한다.
SDK 설치·실제 claude 실행·npm test·git 조작은 하지 않았다.

## S1-b2b — 실제 SDK 어댑터와 테스트 전용 실행 파일

2026-10-25, 설치된 SDK 0.3.308을 그대로 사용했다.
설치·rebuild·네트워크·실제 Claude 실행·LLM 호출은 하지 않았다.
코어·stateRules·spawnEnv·authGate 등 변경 금지 파일은 수정하지 않았다.
제품 main은 ESM SDK를 import한 어댑터와 동봉 경로를 가진 psIdentity를 연결한다.
SDK 또는 동봉 경로를 찾지 못하면 unavailableAdapter로 호스트를 유지한다.
시작 요청 전에는 query·spawn·resolveSettings를 호출하지 않는다.

### wire 근거와 타입 선언의 누락

다음 줄 번호는 이 worktree에 설치된 파일 기준이다.
sdk.mjs는 압축돼 있어 한 줄이 매우 길다. 함수 이름과 바이트 위치도 함께 적는다.

| 근거 | 확인한 계약 |
|---|---|
| sdk.d.ts:2492, 9767, 9819 | custom spawn 콜백, ChildProcess 호환 SpawnedProcess, command·args·cwd·env·signal |
| sdk.d.ts:2555 | allow의 updatedInput, deny의 message |
| sdk.d.ts:4742, 4753, 4776 | initialize 응답에 account가 필수, claude_code_version은 선택 필드 |
| sdk.d.ts:4813, 4815, 4819 | older CLI는 still_queued 없는 성공 응답, 배열이 있어야 영수증 |
| sdk.d.ts:4991, 5200, 5251 | can_use_tool 요청, control_request, control_response의 바깥 구조 |
| sdk.d.ts:5870, 5950, 6000 | rate_limit_event와 result의 user_message_uuids 배열 |
| sdk.d.ts:6236, 6508 | system/init capabilities, user 메시지 content와 parent_tool_use_id |
| sdk.d.ts:3375 | resolveSettings의 settingSources 생략은 CLI 기본 소스와 같음 |
| sdk-tools.d.ts:1136, 2685, 3959 | AskUserQuestion questions와 answers의 질문 텍스트→문자열 사전 |
| sdk.mjs:157, 위치 1210728 | ProcessTransport.initialize 안에서 custom spawn 직접 호출 |
| sdk.mjs:163 Rv, 164 d9e | query → Rv → transport 생성. spawn throw가 query에서 동기로 전파됨 |
| sdk.mjs:157 handleControlRequest, 159 processControlRequest | success 응답의 response.request_id·response.response, canUseTool의 toolUseID 전달 |
| sdk.mjs:161 streamInput, 163 Tv | initialize 쓰기 뒤 입력 iterable 소비, user NDJSON 전달 |
| sdk.mjs:159 interrupt, 위치 1240267 | SDK 자체도 still_queued 배열이 아니면 undefined 반환 |
| sdk.mjs:161 accountInfo, 위치 1253138 | 초기화 Promise의 account를 반환하며 새 CLI 요청을 보내지 않음 |
| sdk.mjs:157 readMessages | 제어 프레임 처리 뒤 일반 메시지는 inputStream.enqueue로 전달 |
| sdk.mjs:157 p9, 39 Pt·cu | resolveSettings는 프로세스의 설정 루트·HOME을 읽음. query의 자식 env로 바뀌지 않음 |

**선언 누락**: 이 SDK의 SDKMessage union(sdk.d.ts:5556)에는 command_lifecycle이 없다.
4803줄 주석에서 이름만 언급한다. 따라서 선언에서 type/subtype을 확인했다고 주장하지 않는다.
S1-0 기록도 lifecycle의 type/subtype을 생략했으므로 그것만으로 wire를 추측하지 않았다.
동봉 바이너리를 실행하지 않고 mmap으로 읽은 선언 문자열의 위치 219689000에
`type:T("command_lifecycle"),command_uuid:o(),state:U([...])`가 있다.
실제 wire는 최상위 `type:'command_lifecycle'`이며 system subtype이 아니다.
상태는 queued·started·completed·cancelled·discarded·refused다.
가짜와 어댑터 모두 이 최상위 type을 사용하며 SDK가 그대로 전달하는 것을 테스트했다.
초기화 응답의 pid·current_permission_mode·remote_control_auto_enable도 이 공개 응답 타입에는 없다.
이 필드는 S1-0 s11-initfields 실측과 게이트 계약을 따르며 SDK는 응답 전문을 보존한다.
account는 선언에 있으므로 accountInfo 결과를 합치지 않는다. 누락·null을 그대로 게이트에 넘긴다.

### 실행·효과 경계

start는 빈 입력 queue를 query에 주고 동기로 pid·시작시각·대화 UUID를 반환한다.
새 대화는 randomUUID를 sessionId로, resume은 기존 대화 UUID를 resume으로 넘긴다.
SDK가 custom spawn의 오류를 감추는 경우에도 기록한 오류를 동기 throw하도록 방어한다.
실제 고정 SDK에서는 숨기지 않고 그대로 동기 throw한다.

spawn 순서는 spawnGuard → 공유 argv 판정·매번 파일 해시 → buildChildEnv·assertChildEnv
→ pipe stdio로 spawn → identityProbe.readStartTime이다.
새 프로세스 그룹이나 detached 옵션은 없다. stderr는 저장하지 않고 소비해 pipe 정체를 막는다.
SDK가 부모에서 받은 CLAUDECODE·CLAUDE_CODE_SESSION_ID·CLAUDE_PID 등은 자식에게 전달하지 않는다.
허용된 SDK 키 세 개만 buildChildEnv가 고르며 표지는 예약 UUID 하나다.
체크 실패는 경로·env 값 없는 고정 code/message로 바꾼다.
argvCheck의 기존 비동기 함수와 새 동기 함수는 경로·argv 판정 함수를 공유한다.
해시는 캐시하지 않는다. start와 resume 두 spawn에서 해시 호출이 각각 일어남을 검증했다.

시작시각 조회 실패면 즉시 소유 ChildProcess 핸들로 SIGKILL하고 identity_unavailable을 throw한다.
핸들 kill은 아직 회수하지 않은 직접 자식을 대상으로 한다.
직접 자식이 죽어도 wait/reap 전 PID는 재사용되지 않고, Node가 exit를 처리하면 핸들이 닫힌다.
따라서 저장된 숫자 PID를 나중에 다시 보내는 경로와 달리 PID 재사용 대상에 신호를 보내지 않는다.
코어는 동기 실패를 never_started로 기록하며, 뒤의 실제 exit 이벤트도 이를 exited로 덮지 않는다.
단, SIGKILL 요청 반환은 사망 확인이 아니며 OS 오류·호스트 동시 사망·이미 생긴 하위 작업의 위험은 남는다.
특히 이 오류 경로의 never_started는 코어에 정상 신원을 커밋하지 않았다는 뜻이다.
실제 spawn이 전혀 없었다는 뜻으로 확대하면 안 된다. 표지 복구와 하위 확인이 계속 필요하다.

send·decide·interrupt 호출부에는 await가 없다.
도구별 대기 Promise는 한 번만 resolve하며 두 번째 결정은 throw한다.
abort면 대기를 삭제하고 deny로 정리한다. 코어는 전달한 AbortSignal을 직접 관측한다.
allow는 입력 객체 그대로, deny는 nonce 포함 메시지 그대로 반환한다.
answer는 answers 사전을 합친 updatedInput을 반환한다.
기존 문자열 answer는 질문 하나일 때만 질문 텍스트를 키로 변환한다.
복수 질문은 명시적인 사전을 받아야 하며 값은 전부 문자열이어야 한다.

일반 이벤트는 코어가 요구하는 최소 필드만 전달한다.
assistant·본문·알 수 없는 프레임은 버린다. result의 단수 uuid를 배열로 승격하지 않는다.
tool_result 배열 content는 text 블록만 연결한다.
초기화 성공은 전문, 실패는 고정 코드 이벤트다.
스트림 종료·오류·close 반환은 사망 이벤트가 아니며 child_exit는 직접 자식 exit에서 한 번만 나온다.
SDK interrupt의 undefined 반환도 어댑터에서 다시 검사한다.

checkSettings와 query는 모두 settingSources를 지정하지 않아 user/project/local 기본값을 공유한다.
테스트 파일 프로세스에서 SDK import 전에 HOME을 임시 디렉터리로 바꾸고
CLAUDE_CONFIG_DIR·CLAUDE_SECURESTORAGE_CONFIG_DIR을 제거한다.
자식도 같은 HOME을 받는다. project 설정뿐 아니라 임시 HOME의 user 설정을 읽는 대조도 통과했다.
사용자 실제 ~/.claude 설정·hooks를 가짜 실행 파일에 넘기지 않는다.

### 가짜와 테스트

fake-claude-sdk.cjs는 의존성 없는 executable Node 스크립트다.
설정은 cwd의 fake-claude.json에서만 읽는다.
initialize·can_use_tool·interrupt 제어 요청/응답, uuid lifecycle, system/init,
assistant/result, user tool_result를 실제 SDK와 교환한다.
merge는 실제로 받은 두 입력을 묶는다. 코어는 두 번째 입력을 보내지 않으므로
이 결함 테스트만 어댑터로 두 번째 UUID를 직접 넣어 provider 이상을 주입한다.
drop·delayMs·omitLifecycle·olderReceipt·초기화 필드 덮어쓰기·초기화 정체/실패,
EOF/SIGTERM 무시·손자·rate limit·toolError·단수 uuid 결과도 재현한다.
SDK close 자체도 나중에 SIGTERM/SIGKILL을 예약하므로 정리 미확인 테스트는
주입 clock을 먼저 진행시켜 코어의 보수적 판정을 검증한다.

provider 로그의 user UUID·tool_use_id 개수를 효과로 센다.
정상 20회 지시·10회 승인에서 UUID별 수신/실행 각 1회, unknown 0을 확인했다.
거부는 실행 0, 단일 질문 문자열 답변은 observed다.
실제 손자 표지 상속은 ps 없이도 별도 테스트로 확인했다.
각 fixture의 after는 직접 자식 SIGKILL 후 exit를 기다리고 손자 종료도 기다린다.
각 테스트는 20초 제한, 폴링은 4초 제한을 가진다.

능력 판정은 고정 버전쌍·default 모드에서 observe/tool_approval/resume을 supported로 둔다.
첫 system/init 전 prompt·cancel은 unknown이며,
각각 msg_lifecycle_v1·interrupt_receipt_v1이 확인되면 supported, 없으면 unsupported다.
버전 또는 모드가 다르면 다섯 능력 모두 unsupported다. snapshot 연결은 S1-c다.

### 변경 금지 경계에서 확인한 불일치·남는 위험

1. **구조화된 question_answer 관측**:
   stateRules.js:18은 제출 answer를 그대로 보존하고 50줄에서
   `JSON.stringify(adapterEvent.content) === JSON.stringify(decision.answer)`로 비교한다.
   이번 계약은 tool_result.content를 반드시 문자열로 정규화하므로 사전 형태 answer는
   올바른 SDK updatedInput.answers와 성공 tool_result가 있어도 unknown(tool_finished)이다.
   문자열 단일 질문 경로는 observed이고, 구조화된 답변의 한계는 별도 재현 테스트로 고정했다.
   content를 객체로 바꾸거나 stateRules를 수정해 숨기지 않았다. S1-e 전에 호스트 판단이 필요하다.
2. **accountInfo의 신선도**:
   어댑터는 요구대로 q.accountInfo()를 호출하지만 고정 SDK는 초기화 account를 반환한다.
   따라서 매 prompt 호출이 실제 인증 소스의 새 조회를 의미하지 않는다.
   reinitialize 같은 별도 제어는 이번 경계에 추가하지 않았다.
3. **baseEnv 거부 문구와 필터 계약**:
   baseEnv의 PALANTIR_TOKEN·ANTHROPIC_API_KEY·ANTHROPIC_BASE_URL은 기존 buildChildEnv가 버린다.
   이 입력만으로 spawn 0을 요구하는 문구는 지정된 필터 계약과 맞지 않는다.
   안전한 최종 env는 spawn 1로 대조하고, 허용 키 HOME에 sk-ant- 값을 넣으면 spawn 0을 확인했다.
   최종 env의 금지 키·표지 누락·일반 prototype은 assertChildEnv가 거부한다.
4. 실행 파일 realpath/해시 확인과 실제 exec 사이의 파일 교체 경쟁은 남는다.
   파일 핸들로 exec하는 OS 계약을 도입하지 않았으며, 같은 UID 격리도 주장하지 않는다.
5. 실제 CLI/LLM·키체인·hooks·도구 부작용은 실행하지 않았다.
   가짜 wire 검증은 실제 CLI 의미 전체의 증명이 아니다. 실제 ps·소켓 검증은 아래 환경 제한을 따른다.


## S1-b2b 수정 라운드 1 — ps 후보 검증과 동기 해시 메모리

호스트가 실제 macOS에서 관측한 전체 스캔 비용은 표지 하위 조회 7,510ms·ps 1,394회였다.
1.5초 손자가 스캔 도중 종료돼 SDK 실제 ps 테스트가 실패했다.
이번 수정은 ps 후보 최적화, 가짜 손자 수명, 동기 해시 버퍼의 세 항목으로 한정했다.
코어·게이트·상태 규칙·SDK 어댑터·설치본은 수정하지 않았다.

### 빠른 후보 경로와 전체 스캔 fallback

G(`-E -ww -A -o pid=,command=`)와 P(`-A -o pid=`)를 같은 순서로 읽는다.
G의 정확한 표지 줄마다 그 줄 또는 위쪽의 가장 가까운 숫자 시작 줄에서 PID를 얻는다.
후보가 없거나 P에 없거나 두 표지 줄이 같은 PID로 매핑되면 기존 전체 스캔으로 돌아간다.
후보마다 before lstart → per-PID command·정확한 표지 1개 → ppid → after lstart를 검증한다.
per-PID에 표지가 없으면 전체 스캔으로 돌아간다.
absent는 건너뛰고, 조회 오류·부분 표지·시작시각 불일치는 기존처럼 query_failed다.
검증된 표지 수 + absent 수가 표지 줄 수와 같아야 빠른 결과를 채택한다.
원래 전체 PID 순회 본문과 재시도·공유 기한·PID 예산은 유지했다.

근거: env 표지는 프로세스 레코드 끝에 한 번 나오므로 표지 줄 수는 표지 보유 프로세스 수다.
매핑이 단사이고 매핑 대상의 실제 per-PID 표지가 확인됐으면,
같은 크기 집합으로의 단사는 전단사이므로 빠진 표지 프로세스가 없다.
argv 줄바꿈으로 다른 실제 PID를 위조해도 중복 매핑이나 per-PID 표지 불일치가 드러나면
전체 스캔으로 돌아간다. 후보만으로 PID를 신뢰하거나 신호를 보내지 않는다.
absent를 제외한 모든 채택 신원은 앞뒤 시작시각도 일치해야 한다.
의도적으로 모호한 출력의 느린 경로는 여전히 O(전체 PID 수)이고 기한을 넘기면 fail-closed다.

주입 프로세스 3,000개·표지 2개 테스트에서 findMarked와 listMarkedDescendants 모두
ps 10회(전역 2 + 표지별 4)로 끝났다.
위조 PID 중복, 후보 표지 부재, absent 후보, 기존 여러 줄 argv·권한 오류·PID 재사용·불일치 재시도도 검증했다.
기존 R2 fixture 기본 출력은 후보를 특정하지 않는 전역 hint로 두어 전체 스캔 오류 검증을 유지했다.
정상 여러 줄 argv 사례의 queryCount는 8→6으로 갱신했다.
기존 R3 재시도 사례는 실패 후보의 before/command 2회가 전체 스캔 앞에 추가되므로
persistent 8→12, transient 10→12, 제한 예산 사례의 누적 command 수 2→3으로 갱신했다.
재시도 횟수·기한·최종 판정 단언은 유지했다.

### 손자 수명과 실제 ps 테스트의 한계

가짜 손자의 1.5초 자동 종료를 제거했다. 부모가 살아 있으면 interval로 계속 산다.
부모 정상 exit에서는 소유 ChildProcess 핸들로 손자를 SIGKILL한다.
SIGTERM에서는 손자 exit를 기다린 뒤 부모가 종료한다.
부모 SIGKILL은 exit 콜백이 실행되지 않으므로 손자가 전달받은 원래 부모 PID와
현재 ppid를 100ms마다 비교해 고아가 되면 스스로 끝난다.
기존 fixture after의 직접 자식 kill·exit 대기·손자 종료 대기는 유지했다.
ps 없이도 부모가 살아 있을 때 손자가 1.6초 이후 생존함을 단언한다.

SDK 실제 ps 테스트는 readStartTime·check·손자 포함 listMarkedDescendants·종료 뒤 mismatch_confirmed만 검증한다.
셔뱅 가짜의 ps command는 `node <script> …`이므로 이 가짜로는
findMarked의 `pinnedPath` 루트 접두사 판정을 증명하지 않는다.
제품은 동봉 실행 파일 자체가 루트이므로 판정 대상이 다르다.
별도 기존 native Node 루트 테스트에서 findMarked와 listMarkedDescendants 각각 2초 미만을 단언하고,
SDK 가짜 테스트에서도 listMarkedDescendants 2초 미만을 단언한다.
이 샌드박스에서는 실제 ps가 차단돼 시간 기준 달성 여부는 호스트가 재검증해야 한다.

### 동기 해시와 검증 결과

hashFileSync는 openSync 후 고정 1MiB 버퍼로 readSync를 반복한다.
마지막 부분 읽기는 실제 읽은 길이만 해시에 넣으며 fd는 finally에서 닫는다.
빈 파일·1바이트·정확한 1MiB·2MiB+17바이트에서 async hash 및 기준 SHA-256과 동일했다.
readSync 예외를 주입해 closeSync가 한 번 호출되는 것도 확인했다.
274MB 동봉 파일을 통째로 할당하는 경로는 제거했다.

검증 명령:
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js`
  → tests 390, pass 373, fail 17, cancelled 0, skipped 0.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-gate-review-r3.test.js server/tests/session-host-ps-identity-fast.test.js`
  → tests 15, pass 15, fail 0.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/spawn-guard.test.js`
  → tests 9, pass 9, fail 0.

역회귀는 psIdentity.js를 각각 임시 변형한 뒤 원본 바이트로 원복했다.
- 중복 매핑 fallback 검사 삭제 → (b) tests 1, pass 0, fail 1.
  기대 PID [10,11] 대신 [11,11]이 반환돼 실패했다.
- per-PID 표지 부재 fallback 검사 삭제 → (c) tests 1, pass 0, fail 1.
  기대 ok 대신 query_failed라 실패했다.
- 원복 후 신규 빠른 경로·해시 테스트 tests 6, pass 6, fail 0.

전체 테스트의 환경 제한 실패 목록(테스트를 skip하지 않음):
- `X simultaneous hosts preserve winner socket inode and capability` — 'spawnSync /bin/ps EPERM'
- `X lock does not survive in a live inherited-environment child` — 'spawnSync /bin/ps EPERM'
- `X detached host survives launcher parent SIGKILL` — 'spawnSync /bin/ps EPERM'
- `X detached host survives launcher parent SIGTERM` — 'spawnSync /bin/ps EPERM'
- `X detached host survives launcher parent SIGHUP` — 'spawnSync /bin/ps EPERM'
- `X before accepted crash is reconciled by lookup after boot change, effect occurs once` — 'spawnSync /bin/ps EPERM'
- `X idle drain refuses arrival with not_accepted, new host retries exactly once` — 'spawnSync /bin/ps EPERM'
- `X active ownership prevents idle and SIGTERM exit; zero ownership releases socket and lock` — 'spawnSync /bin/ps EPERM'
- `X private file modes, capability absent from argv and env, launcher sanitizes env` — 'host_start_timeout'
- `X SIGTERM with zero ownership exits cleanly and releases exclusion` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous throw, active ownership=false` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous throw, active ownership=true` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous rejection, active ownership=false` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous rejection, active ownership=true` — 'spawnSync /bin/ps EPERM'
- `R2 real ps ignores unrelated multiline argv while identifying a marked child` — query_failed !== ok (ps 오류를 보수적으로 반환)
- `real ps identifies marked child and grandchild then confirms exit` — query_failed !== ok (ps 오류를 보수적으로 반환)
- `SDK real ps identity reads actual child and inherited grandchild marker then mismatch` — 'spawnSync /bin/ps EPERM'

## S1-b2b 수정 라운드 2 — 적대리뷰 R1

이번 절은 앞선 accountInfo 캐시 위험과 라운드 1의 absent 허용 논증을 대체한다.
설치·네트워크·실제 Claude 실행·LLM 호출은 0이다. 변경 금지 코어·stateRules는 유지했다.

### 수정 전 실패 증거

먼저 재현 테스트를 추가하고 제품 동작을 바꾸기 전에 실행했다.
테스트 관측을 위해 onQuery 훅만 추가해 실제 SDK에 넘긴 canUseTool 함수를 캡처했고,
가짜 실행 파일에는 initialize 요청의 기록·설정 재읽기를 먼저 추가했다.
SDK 모듈·query·Query 객체를 가짜로 대체하지 않았다.

명령:
`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test --test-name-pattern='R2 ps |R2 config root|R2 prompt recheck|R2 duplicate tool' server/tests/session-host-ps-identity-fast.test.js server/tests/session-host-sdk-adapter.test.js`

수정 전 tests 7, pass 0, fail 7. 수정 후 같은 명령 tests 7, pass 7, fail 0.
다음 줄 번호는 수정 전 실행 당시의 테스트 파일 기준이며 이후 추가로 이동했다.

| 항목 | 테스트와 실패 줄 |
|---|---|
| 1 absent 누락 | `R2 ps absent forged candidate cannot hide live marked child`, ps-identity-fast:119, `assert.deepEqual(markedPids(probe), [11])`: 실제 [] |
| 1 새 표지 | `R2 ps new marked process between G and P cannot be omitted`, 같은 파일:130, 기대 [10,11,12], 실제 [10,11] |
| 1 재조회 | `R2 ps changed final G mapping forces full scan`, 같은 파일:141, `changed mapping must use full scan` 실패 |
| 2 루트 | `R2 config root mismatch rejects settings and start before spawn`, sdk-adapter:489, `assert.rejects(...config_root_mismatch)`: Missing expected rejection |
| 3 새 조회 | `R2 prompt recheck gets fresh account instead of initialization cache`, sdk-adapter:499, initialize 횟수 기대 3, 실제 1 |
| 4 중복 | `R2 duplicate tool callback shares pending promise aborted=false/true`, `assert.strictEqual(first, second)` 실패: 서로 다른 Promise |

### 1. ps 빠른 경로의 채택 조건

어느 단계에서든 후보가 absent면 즉시 기존 전체 스캔으로 돌아간다.
absent 개수를 더해 cardinality를 맞추던 도달 불가 검사는 제거했다.
후보 검증 뒤 G를 한 번 더 읽고 같은 순서의 표지 줄→PID 매핑인지 비교한다.
달라졌으면 전체 스캔이다. 재조회에서 원래 P에 없던 새 PID가 나오면
기존 P를 순회해도 빠뜨릴 수 있으므로 query_failed로 닫는다.
잘못된 재조회 출력·부분 표지도 query_failed다.

채택 조건은 단사 매핑 + 모든 후보의 per-PID 표지·앞뒤 신원 확인 + absent 0 + 재조회 매핑 일치다.
이 강제 조건이 있을 때만 같은 크기 집합으로의 단사를 전단사로 해석한다.
스캔 자체를 OS 원자 snapshot으로 주장하지 않으며 마지막 조회 이후의 생성은 관측 범위 밖이다.
표지 프로세스 2개·전체 3,000개의 정상 경로는 전역 재조회 1회가 추가돼 11회다.

G와 P 사이 새 프로세스, P 뒤 새 PID, 숫자 줄 위조+absent, 재조회 매핑 변화 테스트를 추가했다.
R2 공통 fixture는 정상 숫자 PID와 강제 fallback 형식 모두 지원한다.
같은 권한 오류·부분 표지·PID 예산·여러 줄 argv 행렬을 fast=true/false 양쪽에서 실행한다.
R3의 lstart bracket 단언은 그대로 유지하고 그 뒤 G 재조회도 단언한다.
transient 재시도는 전역 조회 수 3(시도 2 + 마지막 재조회 1), queryCount 13으로 갱신했다.

### 2. 설정 루트

생성 시 루트 일치 여부를 보관하고 checkSettings·start마다 다시 검증한다.
process.env 또는 baseEnv에 CLAUDE_CONFIG_DIR·CLAUDE_SECURESTORAGE_CONFIG_DIR이 있거나,
HOME이 비었거나 두 HOME이 다르면 checkSettings는 config_root_mismatch reject,
start는 같은 코드로 동기 throw하며 spawn 0이다.
생성 때 불일치했던 어댑터는 나중에 env를 고쳐도 사용할 수 없다.
각 필드 변경에 대한 통과 대조와 생성 후 변경·빈 HOME·누락 HOME을 검증했다.

### 3. accountInfo는 매번 reinitialize

sdk.d.ts:3030–3054는 reinitialize가 캐시와 달리 새 initialize 요청을 보내며,
대기 중 can_use_tool/request_user_dialog를 재전달하고 hooks를 다시 등록할 수 있다고 명시한다.
이 어댑터는 SDK hooks 옵션을 사용하지 않으므로 취소될 SDK hook callback이 없다.
prompt는 코어의 idle 조건에서만 보내므로 정상 경로에 대기 중 can_use_tool도 없다.
재전달이 와도 아래 도구 ID 멱등 처리가 동일 Promise를 돌려준다.
CLI 파일 settings의 hooks 자체가 없다는 보장은 아니다.

accountInfo(id)는 q.reinitialize() 응답의 account를 반환하고 reject·account 누락은 실패로 전파한다.
가짜는 initialize마다 fake-claude.json을 다시 읽는다.
첫 prompt 뒤 account를 API 키 모양으로 바꾸면 두 번째는 auth_recheck_failed로 거부되고
provider 수신은 한 줄뿐이다. 바꾸지 않은 대조는 두 번 전송된다.
재초기화 오류·account 누락도 거부한다. 로그의 initialize 횟수는 초기 1 + prompt 수다.
정상 20회 지시 테스트는 initialize 21회를 확인한다.
**실제 CLI의 새 initialize가 인증 변경을 반영하는지는 S1-e 실측 항목이다.**

### 4–6. 도구 재전달·답변·서브에이전트

pending 항목이 Promise를 소유한다. 같은 tool_use_id가 오면 signal을 읽거나 바꾸기 전에
동일 Promise를 반환한다. 이미 aborted인 재전달 signal도 기존 항목을 지우지 않는다.
settle은 자신이 아직 등록된 항목일 때만 삭제하고 결정 완료 ID를 보관한다.
완료 ID 재사용은 새 이벤트 없이 duplicate_tool_request deny다.
실제 SDK가 만든 첫 요청에 같은 콜백의 재전달을 주입하고,
사람 결정 1회·동일 결과·tool_request 1회·provider 실행 1회를 확인했다.

answer 사전은 질문 텍스트 키 집합과 정확히 같아야 하며 값은 공백뿐이지 않은 문자열이어야 한다.
질문 두 개에서 빈 사전·한 질문 누락·여분 키·빈 값·공백 값 각각 invalid_decision이고,
그 뒤 완전한 사전으로 결정하면 실행 1회다.
구조화 답변의 기존 코어 관측 테스트는 `known limit (S1-e)`로 표시하고 정상 기준에서 제외했다.

서브에이전트 tool_result 폐기는 기각했다.
tool_use_id는 모델 API의 고유 상관 ID이며 서브에이전트 승인도 같은 canUseTool로 들어온다.
이를 버리면 해당 승인 결과를 관측할 수 없다.
대신 tool_result에 parent_tool_use_id를 추가했다. 코어는 무시하고 S1-c가 구분에 사용할 수 있다.
서브에이전트 결과로도 승인이 observed가 되는 대조 테스트를 추가했다.

### 7–11. 증거 강화와 코어 계약 차이

늦은 실행 테스트는 입력 yield 뒤 오류를 주입해 alive incarnation의 원본을 unknown으로 만든다.
서로 다른 키의 queued 두 개와 추가 prompt를 넣고 원본 결과 도착 뒤까지 상태·outcome을 확인한다.
provider 로그는 원본 UUID 한 개뿐이고 다른 delivery에는 결과가 귀속되지 않는다.
기존 복구 테스트에도 queued 두 개와 unknown 중 다른 키 제출을 추가했다.

merge는 두 UUID의 lifecycle completed까지 기다린 뒤에도 attribution_uncertain=1,
원본 outcome=null, 대기열 queued·outcome=null, 새 prompt rejected, 수신 2개만임을 검증한다.
가짜는 allow의 updatedInput을 기록하고 원래 요청 입력과 같은 경우에만 실행한다.
AskUserQuestion은 원래 질문 입력에 answers가 합쳐진 형태를 비교한다.
정상 승인 10회에서 inputMatch=true·원래 Bash 입력 일치·input_mismatch 0을 단언한다.
입력 변조 대조는 실행 0·input_mismatch 1·오류 결과다.

구형 interrupt는 고정 80ms 대신 provider interrupt_response 로그와
SDK interrupt Promise 완료를 관측하는 테스트 훅을 모두 기다린 후 clock을 진행한다.
중복 exit 검증은 이벤트 루프 drain으로, SIGTERM 무시 검증은 자식의 처리 로그로 바꿨다.
손자 1.6초 생존 시험의 시간 대기는 검증 대상 자체여서 유지했다.

**9번의 코어 계약 차이**: core.js finishIncarnationDeliveries는 정확히 귀속된 result가 있으면
lifecycle 없이 exit해도 state=unknown, outcome=completed로 보존한다.
따라서 기존 omitLifecycle + 정상 result 사례는 그 최종 값을 단언한다.
result 배열도 없는 별도 사례는 state=unknown, outcome=outcome_unknown을 단언한다.
둘 다 원본 provider 수신은 한 번이다. 정상 result를 버려 요구된 outcome_unknown을 만들거나
변경 금지 core/stateRules를 수정하지 않았다. 이 차이는 호스트 판단 항목이다.


### 최종 검증

- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js`
  → tests 412, pass 395, fail 17, cancelled 0, skipped 0.
  신규 22개는 전부 통과했다. 아래 17개는 기존 샌드박스 ps·소켓 제한 사례다.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/spawn-guard.test.js`
  → tests 9, pass 9, fail 0.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test --test-name-pattern='R2' server/tests/session-host-ps-identity-fast.test.js server/tests/session-host-sdk-adapter.test.js`
  → 당시 tests 20, pass 20, fail 0. 이후 추가한 P 뒤 생성·alive unknown 사례도 최종 전체 실행에서 통과했다.

샌드박스 실패 목록:
- `X simultaneous hosts preserve winner socket inode and capability` — 'spawnSync /bin/ps EPERM'
- `X lock does not survive in a live inherited-environment child` — 'spawnSync /bin/ps EPERM'
- `X detached host survives launcher parent SIGKILL` — 'spawnSync /bin/ps EPERM'
- `X detached host survives launcher parent SIGTERM` — 'spawnSync /bin/ps EPERM'
- `X detached host survives launcher parent SIGHUP` — 'spawnSync /bin/ps EPERM'
- `X before accepted crash is reconciled by lookup after boot change, effect occurs once` — 'spawnSync /bin/ps EPERM'
- `X idle drain refuses arrival with not_accepted, new host retries exactly once` — 'spawnSync /bin/ps EPERM'
- `X active ownership prevents idle and SIGTERM exit; zero ownership releases socket and lock` — 'spawnSync /bin/ps EPERM'
- `X private file modes, capability absent from argv and env, launcher sanitizes env` — 'host_start_timeout'
- `X SIGTERM with zero ownership exits cleanly and releases exclusion` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous throw, active ownership=false` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous throw, active ownership=true` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous rejection, active ownership=false` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous rejection, active ownership=true` — 'spawnSync /bin/ps EPERM'
- `R2 real ps ignores unrelated multiline argv while identifying a marked child` — query_failed !== ok (실제 ps 조회 차단)
- `real ps identifies marked child and grandchild then confirms exit` — query_failed !== ok (실제 ps 조회 차단)
- `SDK real ps identity reads actual child and inherited grandchild marker then mismatch` — 'spawnSync /bin/ps EPERM'

## S1-b2b 수정 라운드 3 — 설정 스냅샷과 requestId별 재전달

이 절은 앞선 루트의 가변 baseEnv 참조와 완료 tool_use_id의 무조건 deny 계약을 대체한다.
수정은 sdkAdapter, 테스트 전용 실행 파일, SDK 테스트, 이 기록에 한정했다.
실제 Claude·LLM·네트워크·설치·git 조작은 하지 않았다.

### 먼저 실행한 실패 테스트

제품 수정 전에 fake의 tool_request_sent 로그와 재전달·취소 모드, 재현 테스트를 추가했다.
실행 당시 줄 번호는 이후 테스트 보강으로 이동할 수 있다.

| 지적 | 테스트 이름 | 수정 전 실패 줄·원문 요약 |
|---|---|---|
| 1 기본 env 참조 | `R3 default environment HOME is fixed at adapter creation` | sdk-adapter.test.js:707 `assert.rejects(...config_root_mismatch)` — Missing expected rejection |
| 1 호출자 가변 객체 | `R3 caller environment mutation cannot change child snapshot` | :723 `assert.equal((await f.start()).state, 'done')` — 실제 failed |
| 2 완료 allow·answer | `R3 completed same request replays original result question=false/true` | :742 `assert.strictEqual(await callback(...), result)` — 저장된 allow 대신 duplicate_tool_request deny |
| 3 실제 wire 재전달 | `R3 wire redelivery preserves human decision question=false/true` | :759 `assert.deepEqual(replies[1].decision, replies[0].decision)` — 두 번째 응답이 allow에서 deny로 변경 |

첫 명령은 tests 4, pass 0, fail 4였다.
`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test --test-name-pattern='R3 default environment|R3 caller environment|R3 completed same' server/tests/session-host-sdk-adapter.test.js`

wire 명령은 tests 3, pass 1, fail 2였다. cancellation은 기존 구현에서도 통과했다.
`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test --test-name-pattern='R3 wire' server/tests/session-host-sdk-adapter.test.js`

### 1. 설정 루트 불변 스냅샷

어댑터 생성 시 Object.assign(Object.create(null), baseEnv)로 얕은 복사하고 Object.freeze한다.
fixedHome은 이 스냅샷에서 한 번만 정한다.
checkSettings·start는 현재 process.env.HOME과 fixedHome이 같은지,
현재 프로세스와 스냅샷에 금지 설정 루트 키가 없는지 확인한다.
초기 불일치 여부도 유지하므로 생성 때 잘못된 어댑터를 나중에 env만 바꿔 살릴 수 없다.
자식 buildChildEnv는 원래 객체가 아니라 스냅샷을 받는다.

기본 baseEnv=process.env에서도 HOME 변경은 config_root_mismatch이며 spawn·가짜 로그 0이다.
같은 어댑터에서 HOME을 원복하면 설정 검사·시작이 통과한다.
호출자가 넘긴 객체의 HOME·PATH·LANG을 생성 뒤 변경해도 자식에는 생성 시 값만 들어간다.
SDK Pt의 HOME 캐시를 env 변경으로 갱신하려 하지 않고, 어댑터의 루트를 고정해 불일치를 차단한다.

### 2. requestId와 결정 결과 보존

근거는 sdk.d.ts:304의 CanUseTool 옵션 `requestId`와 3036–3038의 유실 응답 재전달·멱등 주석이다.
requestId는 제어 프레임 바깥 request_id이며 toolUseID와 별개다.
pending과 결정 기록 모두 requestId를 보관한다.

- 같은 tool_use_id + 같은 비어 있지 않은 requestId: pending이면 같은 Promise,
  완료 뒤에도 저장된 결과로 resolve된 같은 Promise를 반환한다. 이벤트·사람 결정은 추가하지 않는다.
- 같은 tool_use_id + 다른 requestId 또는 requestId 누락: duplicate_tool_request deny다.
  기존 pending·signals·사람 결정 결과는 바꾸지 않는다.
- 처음 보는 ID는 정상 승인 경로를 따른다. requestId 없는 옛 콜백의 재전달에는 승인을 재사용하지 않는다.

결정 Map에는 requestId·결과·Promise가 메모리로만 남으며 직접 자식 exit에서 지운다.
exit 시 남은 pending도 deny로 정리한다. closed/exited 콜백은 request_aborted로 거부한다.
settle의 자기 항목 확인은 유지한다.
기존 직접 콜백 테스트는 실제 wire에서 얻은 request_id를 사용하도록 갱신하고,
다른 requestId·누락 requestId를 pending/완료 양쪽에서 거부하는 대조를 추가했다.

### 3. 실제 SDK 제어 프로토콜 검증

가짜의 redeliverToolRequest는 같은 프레임을 응답 전 한 번 더 쓰고,
첫 응답을 받은 뒤 같은 request_id·tool_use_id로 한 번 더 쓴다.
각 전송 단계와 받은 응답 수·결정 전문을 provider 로그에 기록한다.
실행은 첫 allow 응답에서만 한 번 수행하고 후속 응답은 기록만 한다.

고정 시간 대기를 쓰지 않고, 두 사전 프레임 뒤의 initialize 응답을 실제 SDK가 처리할 때까지 기다린다.
이 순서 장벽으로 첫 사람 결정 전에 SDK가 사전 중복 프레임을 읽었음을 보장한다.
이 장벽이 없으면 OS pipe 분할에 따라 두 번째 프레임을 첫 응답 뒤에 처리할 수도 있어
응답 수 2/3이 달라졌다. 장벽을 넣어 in-flight/응답 후 경로를 명시적으로 분리했다.

설치된 SDK 0.3.308에서 관측한 결과:
- 사전 중복은 SDK가 in-flight request_id로 거른다.
  sdk.mjs:157 handleControlRequest의 cancelControllers 중복 검사와 일치한다.
- 첫 응답 뒤 재전송은 canUseTool 콜백으로 다시 들어오고 두 번째 control_response가 나간다.
- 따라서 프레임 전송 3회에 응답은 2회이며 두 응답의 결정 내용은 완전히 같다.
  allow와 AskUserQuestion answer 각각에서 사람 결정 delivery 1개,
  tool_request 이벤트 1회, provider 도구 실행 1회를 확인했다.

cancelToolRequest는 can_use_tool 뒤
`{type:'control_cancel_request', request_id:<같은 request_id>}`를 쓴다.
정확한 형식은 sdk.d.ts:3967–3974다. 취소 자체에는 응답을 요구하지 않는다.
실제 SDK가 callback signal을 abort했고 코어 승인 카드는 cancelled로 남았다.
원래 permission 요청에 대한 deny 응답을 로그에서 확인했고,
늦은 사람 allow는 rejected, 도구 실행은 0이었다.
직접 콜백 호출 시험은 보조로 남겼으며 이 wire 시험이 재전달·취소 계약의 검증이다.

### 최종 검증

- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test --test-name-pattern='R3 |R2 duplicate' server/tests/session-host-sdk-adapter.test.js`
  → tests 11, pass 11, fail 0.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/session-host-*.test.js`
  → tests 421, pass 404, fail 17, cancelled 0, skipped 0. 신규 9개는 모두 통과했다.
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test server/tests/spawn-guard.test.js`
  → tests 9, pass 9, fail 0.

실제 macOS 재검증은 호스트가 해야 한다. 이번 샌드박스에서도 아래 기존 ps·소켓 제한 사례가 실패했다.
- `X simultaneous hosts preserve winner socket inode and capability` — 'spawnSync /bin/ps EPERM'
- `X lock does not survive in a live inherited-environment child` — 'spawnSync /bin/ps EPERM'
- `X detached host survives launcher parent SIGKILL` — 'spawnSync /bin/ps EPERM'
- `X detached host survives launcher parent SIGTERM` — 'spawnSync /bin/ps EPERM'
- `X detached host survives launcher parent SIGHUP` — 'spawnSync /bin/ps EPERM'
- `X before accepted crash is reconciled by lookup after boot change, effect occurs once` — 'spawnSync /bin/ps EPERM'
- `X idle drain refuses arrival with not_accepted, new host retries exactly once` — 'spawnSync /bin/ps EPERM'
- `X active ownership prevents idle and SIGTERM exit; zero ownership releases socket and lock` — 'spawnSync /bin/ps EPERM'
- `X private file modes, capability absent from argv and env, launcher sanitizes env` — 'host_start_timeout'
- `X SIGTERM with zero ownership exits cleanly and releases exclusion` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous throw, active ownership=false` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous throw, active ownership=true` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous rejection, active ownership=false` — 'spawnSync /bin/ps EPERM'
- `X R1-01 asynchronous rejection, active ownership=true` — 'spawnSync /bin/ps EPERM'
- `R2 real ps ignores unrelated multiline argv while identifying a marked child` — query_failed !== ok (실제 ps 조회 차단)
- `real ps identifies marked child and grandchild then confirms exit` — query_failed !== ok (실제 ps 조회 차단)
- `SDK real ps identity reads actual child and inherited grandchild marker then mismatch` — 'spawnSync /bin/ps EPERM'
