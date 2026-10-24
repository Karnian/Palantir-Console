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
