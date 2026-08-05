# Claude usage refresh 안전 장치와 남은 blocker

이 문서는 이슈 #440에서 **근거 없이 구현하지 않기로 한 부분**과, 근거를 확보하기 전에 만들 수
있는 저장 안전 장치를 구분한다.

## 현재 상태

직접 refresh는 기본적으로 꺼져 있다. `PALANTIR_CLAUDE_REFRESH_CONFIG_JSON`이 없거나,
JSON이 불완전하거나, `enabled`가 명시적으로 `true`가 아니면 기존 #437 경로를 그대로 사용한다.
이때 만료 토큰은 계속 `token_expired`로 보고되며 refresh 네트워크 요청과 자격증명 쓰기는
발생하지 않는다.

기본 pod-side probe의 회귀 기준은 다음과 같다.

- 길이: 1,079 bytes
- SHA-256: `820308350719054371674a32b5223987fd021e98a0b643da447fad083479a88a`

설정이 완전할 때만 별도 probe를 선택한다. 설정값은 SSH argv에 넣지 않고 stdin으로 전달한다.
endpoint host는 `api.anthropic.com` 또는 `console.anthropic.com` exact allowlist로 제한한다.
그 밖의 host는 fail-closed로 기존 non-refresh probe를 선택하고
`claude_refresh_config_rejected` 구조화 경고 이벤트를 남긴다. 경고에는 URL이나 token을
포함하지 않는다.
환경변수에는 다음 항목을 모두 명시해야 하며 코드에는 기본 endpoint, grant parameter 이름,
grant 값, `client_id`, 응답 필드 이름이 없다.

- HTTPS endpoint
- request encoding과 method
- `client_id` 값 및 그 parameter 이름
- refresh token parameter 이름
- 나머지 grant parameter 이름과 값
- access/refresh token 응답 필드 이름
- access token 만료 필드와 단위
- refresh token 응답 생략을 허용할지 여부
- 필요하면 refresh token 만료 필드와 단위

이 스키마는 지원되는 값을 알아낸 뒤 넣을 자리만 제공한다. **이 경로는 아직 실 endpoint로
검증되지 않았고 grant의 refresh token 회전 동작도 미검증이다.** 아래 blocker가 해소되기
전에는 실운영 환경변수를 설정하면 안 되며, 기능은 명시적인 `enabled=true` 없이는 비활성이다.

## Claude CLI lock 근거

로컬에 설치된 Claude Code 2.1.220 실행 파일을 읽기 전용으로 조사했다. secureStorage 구현은
설정 디렉터리의 `.storage-write`를 `proper-lockfile`로 잠근다.

- `realpath: false`
- 재시도 10회
- 재시도 간격 최소 100 ms, 최대 1,000 ms
- stale 15,000 ms
- lock 안에서 cache 무효화 후 자격증명을 다시 읽고 mutate
- plaintext backend는 같은 디렉터리의 임시 파일을 atomic rename한 뒤 `0600` 적용

`proper-lockfile`이 실제로 만드는 lock 디렉터리는 `.storage-write.lock`이다. 이번 구현은
이 디렉터리를 같은 mkdir/rmdir 프로토콜로 획득하고, 보유 중 mtime heartbeat를 갱신하며,
동일한 stale/retry 범위를 사용한다. 따라서 Palantir끼리만 통하는 별도 lock을 만든 것이 아니라
Claude CLI 저장 작업과도 경합한다.

이 근거는 현재 설치 버전에 대한 것이다. Claude CLI가 lock 경로나 저장 규칙을 바꾸면 다시
검증해야 한다.

## 되쓰기 안전 장치

설정 경로는 다음 순서를 지킨다.

1. 만료 자격증명을 읽고 원문 SHA-256과 원문 bytes를 보관한다.
2. 같은 프로세스의 동시 usage 요청을 직렬화한다.
3. Claude CLI의 `.storage-write.lock`을 획득한다.
4. lock 안에서 파일을 다시 읽고 원문 bytes가 같은지 CAS한다. 다르면 refresh하지 않는다.
5. 네트워크 전 `intent` journal을 같은 설정 디렉터리에 atomic `0600`으로 저장한다.
6. 응답을 검증한 즉시 새 자격증명 전체를 담은 `staged` journal을 atomic 저장한다.
7. 자격증명 파일을 다시 읽고 두 번째 CAS를 수행한다.
8. 기존 JSON의 미지 root/OAuth 필드를 보존한 채 token/expiry 필드만 바꾼다.
9. 같은 디렉터리에서 임시 파일을 만들고 fsync, `0600`, 기존 uid/gid 적용, atomic rename,
   디렉터리 fsync 순으로 저장한다.
10. 저장이 확정된 뒤 journal을 삭제한다.

설정 디렉터리는 새로 만들거나 교체하지 않는다. 기존 디렉터리 inode가 작업 중 바뀌면
되쓰기를 중단한다.

### crash와 불명확한 네트워크 결과

- 응답을 `staged` journal에 저장한 뒤 프로세스가 죽으면 다음 probe가 CAS 후 journal을
  자격증명 파일에 반영한다. refresh endpoint를 다시 호출하지 않는다.
- `staged` 뒤 다른 writer가 자격증명 bytes를 바꾸면 자동 반영은 중단하되 journal은 절대
  삭제하지 않는다. staged refresh token이 회전 후 남은 유일본일 수 있으므로 수동 복구
  근거를 보존한다.
- 자격증명 rename 뒤 journal 삭제 전에 죽으면 다음 처리에서 이미 반영된 SHA-256을 확인하고
  journal만 정리한다.
- 요청 후 응답을 받기 전에 연결이 끊기면 서버가 refresh token을 이미 회전했을 수 있다.
  이 경우 journal을 `ambiguous`로 남기고 old refresh token을 자동 재시도하지 않는다.
- 응답 수신 직후 `staged` journal fsync 전에 프로세스/OS가 죽는 창은 일반 파일 API만으로
  없앨 수 없다. `intent`만 남으므로 다음 실행은 복구를 추측하지 않고 `refresh_ambiguous`로
  중단한다. 이 상태는 새 토큰을 복원하지는 못하지만, 소모됐을 수 있는 old token을 반복
  사용해 상황을 악화시키지 않는다.

## 남은 blocker

### 1. refresh protocol의 1차 근거

Anthropic 공식 문서 또는 지원 답변이 필요하다.

- 정확한 endpoint
- method, encoding, 모든 grant parameter 이름과 값
- `client_id`
- 응답 token/expiry 필드와 단위
- scope 보존/갱신 규칙
- refresh token 응답 생략의 의미

transport mock 테스트는 이 값을 증명하지 못한다. mock은 어떤 잘못된 URL도 성공시킬 수 있으므로
endpoint 검증 테스트로 취급하지 않는다.

### 2. refresh token 회전 여부

별도 시험 계정과 별도 Claude 설정 디렉터리가 필요하다. 실사용 자격증명을 복사한 임시 HOME은
서버 측 token이 같으므로 안전한 격리가 아니다. 시험 전후에는 token 원문을 출력하지 않고
SHA-256만 비교해야 한다.

확인해야 할 결과는 성공 시 refresh token이 항상 회전하는지, 조건부 회전인지, 응답에서
생략될 수 있는지다.

### 3. probe가 credential manager가 되어도 되는가

저장 안전 장치가 있어도 권한 경계 판단은 별개다. 현재 probe의 계약은 pod 안에서 token을 읽고
usage JSON만 반환하는 것이다. 타 제품 소유 자격증명을 수정하는 역할까지 맡길지, Claude CLI
호출에 갱신을 위임할지, keepalive를 둘지, 자동 복구를 포기할지 결정해야 한다.

macOS에서는 Keychain이 진실이고 `.credentials.json`은 잔재일 수 있으므로 plaintext refresh
경로를 사용하지 않는다.

## 이번 작업에서 하지 않은 것

- 추측한 endpoint나 `client_id`를 코드 또는 문서 예시에 넣지 않았다.
- 실사용 `~/.claude/.credentials.json`을 쓰지 않았다.
- 실제 refresh 요청을 한 번도 실행하지 않았다.
- `claude auth status`도 갱신 가능성을 배제할 수 없어 실행하지 않았다.


## 교차검토가 남긴 잔여 위험 (2026-07-29)

**1. 응답을 읽지 못한 경우 — 이제 저널에 보존한다.**
서버가 **응답했는데** 설정의 필드명이 틀려 파싱에 실패하면, 이전 구현은 그 payload 를
버렸다. grant 가 회전한다면 옛 refresh token 은 이미 소모됐고 새 토큰은 그 payload 안에
있으므로, 버리는 순간 **그 노드의 CLI 로그인이 영구히 깨지고 복구 근거도 사라진다.**
스키마가 아직 미확인이므로 이건 첫 활성화에서 가장 그럴듯한 실패 형태다.
이제 `unreadableResponse` 로 저널에 그대로 남긴다(자격증명 파일과 같은 0600).

**2. CLI lock 근거는 이 저장소에서 재검증 불가.**
`.storage-write.lock` / `proper-lockfile` 사용은 Claude Code 2.1.220 바이너리를 읽어
확인했다고 기록돼 있으나, **저장소에 증거 산출물이 없다.** 파일명이나 stale 임계값이
틀리면 이 락은 실제 CLI 와 조율되지 않으면서 조율되는 것처럼 보인다.
활성화 전에 실제 CLI 소스로 독립 재확인이 필요하다.

**3. 결정적 거부와 진짜 불확실을 같게 취급한다.**
`400 invalid_grant`(토큰이 **확실히** 소모되지 않음)와 응답 전 연결 단절(결과 불명)이
모두 같은 ambiguous 격리로 간다. 안전한 방향이지만, `client_id` 하나 틀린 것만으로
그 토큰이 영구히 refresh 불가가 된다. 실제 엔드포인트의 오류 의미가 확인되면 완화한다.

**4. 이 경로는 명시적으로 켤 수 있지만 아직 검증되지 않았다.**
`PALANTIR_CLAUDE_REFRESH_CONFIG_JSON` 을 완전해 보이는 값과 `enabled=true`로 설정하면
allowlist 안의 host에 한해 실 pod 자격증명 파일을 대상으로 **진짜 refresh가 시도된다.**
allowlist 밖 endpoint는 코드가 fail-closed로 거부하고 관측 가능한 경고를 남기지만,
allowlist 안 endpoint의 정확한 path·client_id·grant·회전 계약은 여전히 실증되지 않았다.
위 세 blocker가 해소되기 전에는 설정하지 말 것.
