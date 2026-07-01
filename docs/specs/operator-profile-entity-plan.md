# Operator Profile 엔티티 트랙 (계획 v0.1, Codex+Explore 병렬설계 수렴)

> 상위: `operator-generalization-brief.md`(Profile = identity bundle). 선행: specialist feature 완성(#256~259) + P-B1(#253/#254) profile owner 예약.
> 설계: Explore(CRUD 템플릿 매핑) + Codex(스키마/계약/sub-slicing) 병렬 수렴.

## 0. 목표 + 핵심 결정
specialist 가 요청마다 raw `persona`/`capabilities` 를 받는 대신, **저장된 Profile 번들을 id 로 해석**. 이름으로 프로필 선택 UI.
- **새 테이블 `operator_profiles`** — `agent_profiles`(=CLI adapter config)는 **안 건드림**(그 rename=별개 거대 refactor #6, 이 트랙 제외).
- **P-B1 연결**: `operator_profiles.id` = profile memory 의 `owner_id`(normalizeOwner `{profile_id}`→(profile, id)). memory owner 컬럼은 plain TEXT = **FK 불필요**(삭제 cascade 위험 회피, run_preset_snapshots 선례).

## 1. Sub-slicing (Codex + 재정렬로 broken 중간상태 회피)
- **PF-1 (본 PR) — 백엔드**: migration 043(table+trigger+CHECK) + `operatorProfileService` CRUD + `/api/operator/profiles` route. specialist 미접촉.
- **PF-2 — 관리 UI**: `OperatorProfilesView`(#operator-profiles: list/create/edit/delete) + nav + a11y/visual. → 프로필을 UI 로 생성 가능. specialist 미접촉.
- **PF-3 — specialist 배선(원자적)**: entry Contract A(profileId→profile 해석) + `SpecialistView` 프로필 picker + inline persona/caps 전송 중단. **entry 계약변경 + 유일 caller(SpecialistView)를 함께** = broken 중간상태 없음. (Codex 는 PF-2=entry/PF-3=UI 였으나, flag-off 라도 old SpecialistView 가 persona 보내면 400 → 원자화가 더 깨끗.)

## 2. Entry-resolution 계약 = Contract A (Codex Q3, PF-3 에서 적용)
- `profileId` 는 반드시 `operator_profiles` 에 존재 → 프로필의 persona+capabilities 가 **authoritative**.
- 요청에 `persona`/`capabilities` 도 있으면 → **400**(audit 모호성 거부, silent discard 아님).
- `profileId` 미존재 → **404**(구체 엔티티 참조).
- 근거: Contract C(opaque 폴백)는 typo/삭제 profileId 가 silent 하게 위험(빈 persona 로 실행). specialist flag-gated+신규=backward-compat 불요.

## 3. PF-1 변경 (백엔드)
### (a) `server/db/migrations/043_operator_profiles.sql`
```sql
CREATE TABLE operator_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  persona TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (json_valid(capabilities_json) AND json_type(capabilities_json, '$') = 'array')
);
-- updated_at 트리거 (020_mcp_template_updated_at 패턴; service drift 방지)
CREATE TRIGGER operator_profiles_updated_at AFTER UPDATE ON operator_profiles
FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE operator_profiles SET updated_at = datetime('now') WHERE id = OLD.id; END;
```
### (b) `server/services/operatorProfileService.js` (presetService clone)
`createOperatorProfileService(db)` → create/get/list/update/delete. id `op_`+uuid12. 검증(service): name(필수 ≤128, UNIQUE→ConflictError), description(≤500), persona(≤2000), capabilities(배열, 각 `isCapability`→BadRequestError, 빈배열 OK). rowToProfile(capabilities_json parse). errors.js(Bad/Conflict/NotFound).
### (c) `server/routes/operatorProfiles.js` (workerPresets clone)
GET `/` (list) · POST `/` (create 201) · GET `/:id` · PATCH `/:id` · DELETE `/:id`. asyncHandler, 검증은 service.
### (d) `server/app.js`
`operatorProfileService` 상시 구성(agentProfileService 옆) + `app.use('/api/operator/profiles', createOperatorProfilesRouter({operatorProfileService}))` **상시 mount**(순수 config CRUD=무해·testable; specialist INVOCATION 만 flag-gated) + app.services 노출.

## 4. 수용 기준 (PF-1)
service: create/list/get/update/delete / name UNIQUE→Conflict / description·persona 길이 / capabilities 배열+unknown cap→BadRequest / 빈배열 OK / updated_at 트리거 변경. route(supertest): 5 엔드포인트 + 404(미존재) + 400(bad cap) + 409(중복 name).

## 5. 보안/불변식
persona=operator(authenticated) 신뢰 콘텐츠(단일테넌트)지만 길이 cap. capabilities `isCapability` 검증(specialist createGrant fail-closed 재확인). persona 는 specialist system prompt 의 고정 preamble **뒤** 주입(약화 불가) — 저장 출처든 요청 출처든 동일 슬롯, injection gap 없음(PF-3). migration 043 저위험(inbound FK 0).

## 6. 제외 (별개)
agent_profiles→adapter_config rename(#6), model 선택, workspace/execution_mode(specialist 고정), mid-turn 위임, profile memory read/write 배선(P-B2).

## 7. 검증
Explore+Codex 병렬설계 수렴. **Codex R2 impl = GO** (0 blocker/serious, 3 MINOR → 2 반영: normalizeInputs 비-object body 거부 / rowToProfile capabilities isCapability 필터[direct DB write 방어]; #3 트리거 초단위 note=무조치). 11 supertest, 풀스위트 green.
