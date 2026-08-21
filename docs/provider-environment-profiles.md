# 선언형 provider 환경 프로파일

이 문서는 이슈 #457의 후속 기반을 설명한다. 이 기능은 Bedrock, Vertex,
Foundry 또는 custom provider의 환경 변수 집합을 코드가 추측하지 않도록
만든다. 저장소에는 provider별 기본 선언이 없고, 마이그레이션도 provider를
한 건도 seed하지 않는다.

중요: 이 작업만으로 이슈 #457을 닫지 않는다. 이슈에 적힌 진행 조건인
실제 사용 사례 확인과 provider별 공식 문서 근거 확보는 여전히 남아 있다.
이 기능은 그 조건이 충족됐을 때 코드 변경 없이 운영자 설정으로 대응할
수 있는 구조만 제공한다.

## 데이터 모델

- `environment_providers`: 운영자가 정한 이름, 필요한 환경 변수 **이름**
  목록(`env_keys`), 선택적 활성화 조건(`gate_env_key` + 선택적
  `gate_env_value`), 설명을 저장한다. credential 값은 저장하지 않으며,
  secret 형태 gate는 값 자체를 받지 않는다.
- `agent_profile_environment_providers`: `agent_profiles`와 provider 선언을
  ID로 연결한다.
- `agent_profiles.env_allowlist`: 기존의 프로필별 명시적 승인 목록으로
  그대로 유지된다.

provider가 연결되지 않은 프로필은 기존 행과 같은 `env_allowlist`만
사용한다. 기존 spawn/auth 기본 환경과 API의 프로필 형태도 바뀌지 않는다.

## 일반 키와 secret 키의 구분

provider 선언은 “이 provider에 이 키가 필요하다”는 요구사항 기록이지,
모든 키를 자식 프로세스로 보낼 권한이 아니다.

활성 provider를 프로필에 연결하면 credential 형태가 아닌 키만 기존
`env_allowlist`에 합쳐져 유효 allowlist가 된다. 이름에 `SECRET`,
`API_KEY`, `ACCESS_KEY` 토큰이 있거나 `_KEY`, `_TOKEN`, `_PASSWORD`,
`_CREDENTIAL(S)`, `_CERT`, `_PRIVATE`로 끝나는 키는 secret으로 분류한다.
이 기준은 특정 provider 이름이나 vendor별 변수 집합을 유추하지 않으며,
기존 `envDenylist.js`의 credential 패턴을 더 보수적으로 적용한 것이다.

secret으로 분류된 키는 provider를 선택하는 것만으로는 합쳐지지 않는다.
동일한 키가 프로필의 기존 `env_allowlist`에도 직접 적혀 있고 provider의
gate 조건도 충족되어야 전달된다.
따라서 provider 선언과 secret 전달 승인은 서로 다른 운영자 행위와 저장
필드로 남는다. `AWS_SECRET_ACCESS_KEY`와 `*_API_KEY`가 provider 선언에
있더라도 프로필의 명시적 승인 전에는 자식 환경에 없다.

API가 반환하는 연결된 프로필에는 다음 진단 필드가 추가된다.

- `environment_provider_ids`: 연결된 provider ID
- `effective_env_allowlist`: 실제 spawn에 사용하는 병합 결과
- `environment_providers[].inherited_env_keys`: provider 참조로 합쳐진 키
- `environment_providers[].secret_env_keys`: secret으로 분류된 키
- `environment_providers[].withheld_secret_env_keys`: 아직 프로필에서
  명시적으로 승인하지 않아 보류된 키
- `environment_providers[].active`: 현재 호스트 환경에서 gate가 활성인지
- `environment_providers[].inactive_env_keys`: gate 불일치로 보류된 키

명시 allowlist가 `[]` 또는 `NULL`이면 기존처럼 adapter의 기본 인증 키를
허용한다. provider의 일반 설정 키를 병합해도 이 기본 의미는 바뀌지 않는다.
활성 provider의 custom secret 키는 명시 승인 후 전달될 수 있지만 그것만으로
manager 인증 preflight를 통과하지 않는다. Claude는
`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` 및 기존 cloud-mode 계약만,
Codex는 `CODEX_API_KEY`/`OPENAI_API_KEY`만 인증 근거로 인정한다.

`envDenylist.js`가 차단하는 프로세스 로더·런타임 키(`NODE_OPTIONS`,
`LD_PRELOAD`, `DYLD_*`, `PYTHONPATH` 등)는 provider에 선언할 수 없다.
직접 삽입된 오래된 행에서도 resolution 단계에 다시 차단되며 spawn은
정책 오류로 실패한다.

## API 사용

provider 선언을 만든다. 아래 이름들은 API 모양을 보여 주기 위한 예시일
뿐이며, 실제 키 목록은 확인된 사용 사례와 해당 provider 문서를 근거로
운영자가 작성해야 한다.

```http
POST /api/environment-providers
Content-Type: application/json

{
  "name": "confirmed-provider",
  "env_keys": ["USE_EXAMPLE_PROVIDER", "EXAMPLE_REGION", "EXAMPLE_API_KEY"],
  "gate_env_key": "USE_EXAMPLE_PROVIDER",
  "gate_env_value": "1",
  "description": "확인된 운영 환경과 문서 링크를 내부 기록에 남긴다"
}
```

`gate_env_key`는 `env_keys`에도 포함되어야 한다. 일반 키에서
`gate_env_value`를 생략하면 `"1"`을 사용한다. secret 형태의 gate 키는
presence-only이며 값 저장·반환을 금지한다. gate 키가 없거나 값이
정확히 일치하지 않으면 provider가
선언한 일반 키와 명시 승인 secret 모두 child 환경에서 보류된다. gate가
필요 없는 custom provider는 두 필드를 생략할 수 있다.

목록·단건 조회·수정·삭제 API는 다음과 같다.

```text
GET    /api/environment-providers
GET    /api/environment-providers/:id
GET    /api/environment-providers/:id/references
PATCH  /api/environment-providers/:id
DELETE /api/environment-providers/:id
```

사용 중인 provider는 연결된 프로필을 먼저 해제하기 전까지 삭제할 수
없다. 프로필에 provider를 연결하거나 교체할 때는 전체 ID 배열을 보낸다.

```http
PATCH /api/agents/:profileId
Content-Type: application/json

{
  "environment_provider_ids": ["envp_..."]
}
```

secret 키를 전달해야 한다는 근거까지 확인됐을 때만, 현재 프로필의
`env_allowlist`를 읽어 기존 항목을 보존하면서 해당 키를 추가한다.
provider 선언에 키를 쓰는 것만으로는 이 승인이 되지 않는다.

gate 평가는 controller의 환경을 기준으로 한다. 원격 worker/Operator의 값은
노드에서 공급되므로 양쪽 환경이 같다고 가정하지 않는다. node-side gate
평가 프로토콜이 생기기 전까지 gated provider가 연결된 원격 spawn은 명시적
이벤트를 남기고 실패한다.

## 관측

기존 `[security] manager_spawn_env_dropped` 로그는 값이 아니라 드롭된 키
이름만 기록한다. 드롭된 키가 연결된 provider 선언에 속하면
`providers` 배열에 provider ID·이름과 해당 키 이름이 함께 표시된다.
provider가 연결되지 않았거나 관련 키가 없으면 기존 로그 JSON은 그대로다.

이 매핑으로 운영자는 “어떤 키가 드롭됐는가”뿐 아니라 “어느 선언의 필요
키였는가”를 확인할 수 있다. 환경 변수 값은 어느 경우에도 기록하지 않는다.

## 남은 진행 조건

이 구조가 있어도 다음 확인 없이는 provider별 기본 지원을 추가하거나
이슈 #457을 닫지 않는다.

1. 실제 사용자가 어떤 provider와 실행 경로(manager/worker, local/remote)를
   쓰는지 확인한다.
2. 필요한 키 목록과 gate 조건을 provider 공식 문서로 확정해 선언한다.
3. 확인된 목록은 운영자 선언으로 등록한다. 저장소 코드에 `AWS_*` 같은
   추정 allowlist를 추가하지 않는다.
