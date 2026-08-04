# Migration 번호 충돌 하드닝

## 문제 (반복됨: #475·#478·#457, owner-exit 084)

병렬 feature 브랜치가 각자 "다음 정수"를 migration 번호로 예약해 **같은 번호에 충돌**한다.
런너(`server/db/database.js`)의 skip 판정이 **`version <= MAX(applied)`** 라서, 먼저 머지된
브랜치가 높은 번호(예: 084)를 차지하면 기존 배포는 `schema_version` head 가 84 가 되고, 나중에
머지되는 브랜치의 더 낮은 번호(예: 082/083)는 `≤ 84` 라 **조용히 skip** 된다 — 실행도 기록도
안 됨. 신규 DB 는 순서대로 다 적용되므로 **테스트가 구조적으로 못 잡는다**(fresh DB).

구체 현행 사례: main 은 `081 → 084_run_owner_leases`(082/083 은 빈 gap). draft PR #479(fix/457)
가 `082_environment_providers` + `083_environment_provider_gates` 를 추가한다. 기존 DB(head 84)에
머지되면 둘 다 skip → `environment_providers` 테이블 미생성 → `createAgentProfileService` 생성자가
그 테이블을 prepare 하다 **부팅 실패**(`no such table`).

## 핵심 사실 — 적용 집합은 이미 기록돼 있다

`schema_version` 는 스칼라가 아니라 **`version PRIMARY KEY, applied_at` 테이블**이고, 런너가
migration 마다 행을 INSERT 한다. 즉 "어떤 migration 이 실제로 돌았는지"가 **authoritative 하게
행으로 존재**한다. 따라서 무거운 ledger 아키텍처나 **위험한 prod-DB cutover/baseline-backfill 이
불필요**하다(codex 2R 확인). 유일한 버그는 skip 이 set-membership 이 아니라 `MAX` 기반이라는 것.

## 안전한 첫 단계 (구현됨) — read-only 대조 도구

`scripts/migration-audit.mjs` (`npm run diagnose:migrations`). **아무것도 수정하지 않는다**
(`readonly:true` + `PRAGMA query_only=ON`, `fileMustExist`). 파일 manifest(version/filename/sha256)와
DB 의 applied 집합을 대조해 다음을 loud 하게 낸다(exit 1):

- **RETROACTIVE** — head 미만인데 미기록인 파일(런너가 조용히 skip 할 것). #479 부류.
- **DUPLICATE** — 같은 번호 접두사 2개 파일.
- **MALFORMED** — `NNN_name.sql`(양수 접두사) 아님.
- **ORPHAN** — 기록됐는데 파일 없음(DB 가 바이너리보다 앞섬/history 재작성).

gap(파일도 행도 없는 번호)은 무해 — 보고 안 함. 라이브 DB 는 `.db` 만 복사하지 말고
`VACUUM INTO`/`.backup` 로 일관 스냅샷을 떠서 `--db` 로 가리킨다(WAL 일관성).

## 권장 런너 수정 (다음 단계 — 미승인)

read-only 진단이 정당화하는 실제 수정. 부팅 동작을 바꾸므로 라이브 배포 대상 — 별도 승인 필요.

1. 실행 전에 manifest 전체 검증: 엄격한 파일명, 양수 버전, 중복 없음.
2. applied 집합을 1회 read.
3. **미적용 파일이 head 미만이면 실행 전에 FAIL LOUD**(renumber 요구) — 조용히 skip 금지.
4. skip 은 오직 `appliedSet.has(version)`.
5. forward migration 을 숫자 순서로 적용, 같은 tx 에서 version 기록, commit 후 in-memory 집합 갱신.

**renumber 주의**(codex): 어떤 DB 에도 안 돈 번호만 renumber 안전. 이미 돈 곳이 있으면 blind
renumber 는 이중 실행 위험 → idempotent forward reconciliation 또는 리뷰된 retroactive 적용.
#479 의 082/083 은 기존 배포에서 skip 돼 **아무 데서도 안 돌았으므로** 085 로 renumber 안전.

## 추가 하드닝 — content 체크섬 ✅ 구현됨

per-migration **content 체크섬**(sha256) 컬럼. `MAX` 버그와 독립. 이미 적용된 migration 의 파일
내용이 나중에 바뀐 경우를 잡는다. `schema_version.content_sha256`(runner bootstrap 이 legacy DB 에
ALTER 로 추가), 적용 시 실행한 정확한 바이트의 sha 를 version 행과 **원자적으로** 기록(FK-off·일반
branch + self-insert 행은 backfill), boot 시 기록 체크섬 ≠ 현재 파일이면 **fail-loud**(적용 후 변경
감지). 과거 `NULL` 행은 unknown → skip(현재 해시로 조용히 backfill 안 함).

**스코프: single-runner.** `migrate()` 는 applied 집합을 boot 에 1회 읽고 루프하는 single-runner
설계다(this repo = 단일 컨트롤플레인 인스턴스/DB). **단일 DB 동시 boot 은 미지원**(pre-existing —
ALTER·applied-read·재실행 모두 single-runner 전제). codex 적대리뷰가 동시-boot 축으로 반복 지적했으나
실배포에 없는 시나리오라 스코프 밖으로 확정(사용자 승인). immutable-migration 규율 + 이 체크섬 +
audit(`diagnose:migrations`)이 방어선.
