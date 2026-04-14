# Phase 10 Worker Preset & Plugin Injection — Implementation Kickoff Brief

> **목적**: 새 Claude Code 세션이 이 브리프만 읽고 Phase 10 구현을 자율적으로 진행할 수 있도록.
> **생성**: 2026-04-14 | **스펙 author**: Claude Opus 4.6 | **Codex review**: 5 rounds → PASS

---

## 0. 무엇을 만드는가

Palantir Console 에 **Worker Preset 시스템** 을 도입한다. 스펙 전체: `docs/specs/worker-preset-and-plugin-injection.md` (main 에 merged, PR #86).

핵심:
- **Tier 1 (portable)**: MCP 서버 정의 + 시스템 프롬프트 — Claude/Codex/OpenCode 워커 모두에 스키마 동일, 주입 경로는 어댑터별
- **Tier 2 (Claude-only)**: `--bare --plugin-dir --strict-mcp-config --setting-sources ''` 로 호스트 격리 + 내부 플러그인 주입
- **Skill Pack 과 직교**: 기존 시스템 변경 없음
- **Phase 10A (auth spike) 는 hard gate**: 실패 시 전체 Phase 보류

---

## 1. 읽어야 할 문서 (순서대로)

1. `docs/specs/worker-preset-and-plugin-injection.md` — **전체 스펙 (1500줄). 가장 먼저 완독.**
2. `docs/specs/manager-v3-multilayer.md` — 기존 3계층 아키텍처 맥락
3. `docs/specs/skill-packs.md` — 직교 유지해야 하는 기존 시스템
4. `CLAUDE.md` — repo 규약
5. `.ao/prd.json` — 기계 판독 용도 (phase/user story 목록)

---

## 2. 진행 방식 (자율 + Codex 교차리뷰)

### 자율 모드 (CLAUDE.md 에 정의됨)
- 승인 없이: 브랜치 생성 / 테스트 / commit / PR / merge (codex PASS 후) / main pull / 다음 phase 진입 여부 보고
- 승인 필요: 되돌리기 불가 git 작업 / 설계 재해석 / spec 과 충돌하는 결정

### Codex 교차리뷰 루틴 (**각 Phase 단위 필수**)
`.claude/memory/feedback_phase_workflow.md` 준수:

```
branch → 구현 → npm test → Codex 교차검증 (PASS까지 반복) → commit → PR → merge → main pull → 다음 phase 진입 여부 보고
```

Codex 호출 방법:
```bash
cat <<'EOF' | node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.0.10/scripts/ask.mjs async codex
<리뷰 요청 prompt>
EOF
# → jobId 반환
node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.0.10/scripts/ask.mjs collect <jobId> --wait --timeout 1500
```

**Codex 가 P0 / P1 을 내면 반드시 수정 + 재리뷰. 최소 2 라운드 이상 수렴까지 반복.**

### 의사결정 규칙
- 명확한 spec 기반 결정: 자율 진행
- 모호 / 여러 옵션 발생: **Codex 에 옵션 나열 + 권장안 요청** → Codex 추천안으로 진행 → 사후 보고만
- 이전 결정과 충돌 / spec 재해석: 사용자 확인 필요
- Codex 가 5 라운드 넘게 수렴 안 됨: 설계 전제 오류 가능성, 사용자 보고

### 팀 꾸리기 (Athena)
필요하다고 판단되면 **Athena (Claude + Codex + Gemini peer-to-peer team)** 오케스트레이터를 자율 판단으로 사용 가능. 특히 다음 상황:
- 한 phase 안에 여러 독립 작업 분리 가능 (e.g. DB + service + route 병렬)
- 복잡한 디자인 결정에서 3 모델의 관점 필요
- Codex 가 혼자 5 라운드 수렴 못 할 때 Gemini 의 제3자 관점 유용

Athena 호출:
```
Skill(skill="agent-olympus:athena", args="<task description>")
```

---

## 3. Phase 실행 순서 (spec §7 요약)

| # | Phase | 내용 | Est. | Gate? |
|---|-------|------|------|-------|
| 10A | **Auth Compat Spike** | `--bare` + `CLAUDE_CODE_OAUTH_TOKEN` env PoC. OAuth 세션이 살아있는지 확인. | 1-2d | ✅ **hard gate** |
| 10B | DB + presetService | Migration 018, `server/services/presetService.js` (CRUD + snapshot builder + resolveForSpawn), REST `/api/worker-presets/*` | 3-5d | |
| 10C | Tier 1 Spawn Wiring | lifecycleService.executeTask + streamJsonEngine.spawnAgent (Claude) / codex exec -c mcp_servers (Codex) / OpenCode 실측. Prompt + MCP 3-source precedence (§6.8). Snapshot persistence. | 3-5d | |
| 10D | Tier 2 (Claude-only) | `--bare --plugin-dir --strict-mcp-config --setting-sources ''` + authResolverForIsolated + canary test (US-007) | 2-3d | |
| 10E | Task 연동 + UI | tasks.preferred_preset_id, ExecuteModal, #presets 페이지, US-008 invalidation UI | 3-5d | |
| 10F | Audit UI | Snapshot diff, preset mismatch warning | 1-2d | |
| 10G | agent-olympus 실연동 | server/plugins/ 에 배치 + smoke | 1d | |

**Total: 13-21d 솔로. Phase 10A 결과로 전체 계획 수정 가능.**

### Phase 10A 구체 작업 (첫 세션 착수 포인트)

1. 별도 spike 브랜치 `spike/phase-10a-bare-auth` 생성
2. PoC 스크립트 `scripts/spike-bare-auth.mjs` 작성:
   ```javascript
   // --bare + CLAUDE_CODE_OAUTH_TOKEN env 로 claude CLI 실행
   // 간단한 첫 턴 메시지 ("Say hello") 보내고 result 이벤트 수신 확인
   // 결과: PASS/FAIL + 원인 기록
   ```
3. 결과를 `docs/specs/worker-preset-and-plugin-injection.md` §11 Round 6 Review Log 에 append
4. **결과에 따른 분기**:
   - PASS → 사용자에게 보고 + Phase 10B 진입
   - FAIL → 사용자에게 보고 + 대안 (proxy 서버 경유? OAuth refresh helper?) 논의. **Phase 10B 이후 전체 보류**.

---

## 4. 주의사항 (가장 많이 당하는 것들)

1. **Worker API vs Manager API 혼동 금지**:
   - Claude worker: `streamJsonEngine.spawnAgent()` (lifecycleService 에서 호출)
   - Claude manager: `streamJsonEngine.startSession()` (claudeAdapter 에서 호출)
   - **Phase 10C 에서 변경 대상은 worker 쪽만**. Manager 는 건드리지 않음.

2. **SQLite ALTER TABLE FK 제약**: `REFERENCES ... ON DELETE SET NULL` 을 `ALTER TABLE ADD COLUMN` 에 달아도 enforce 안 됨. **App-level cascade 필수** — `presetService.deletePreset` 에서 `UPDATE tasks SET preferred_preset_id = NULL WHERE ...` 를 같은 트랜잭션 내 실행.

3. **Snapshot path namespacing**: `<pluginRef>/<relativePath>`. 두 플러그인에 `plugin.json` 이 있으면 `agent-olympus/plugin.json` vs `palantir-internal/plugin.json`. 경로만으로 sort 하면 충돌 → 반드시 namespace.

4. **MCP precedence chain**: preset > project > skill pack. `mergeMcp3(...)` 로 구현. 충돌 시 `run_events` 에 warning.

5. **Auth contract change**: 현재 `authResolver.resolveClaudeAuth` 는 keychain existence-only. Isolated worker 에는 token 을 materialize 해서 env 주입 필요. **신 메서드 `resolveClaudeAuthForIsolated` 추가** (기존 메서드는 건드리지 않음).

6. **Skill Pack 비파괴**: `skill_packs` / `project_skill_packs` / `task_skill_packs` / `run_skill_packs` 변경 0. `skillPackService.resolveForRun` signature 유지. 기존 672+ 테스트 회귀 0 필수.

7. **`server/plugins/` 는 gitignored**: 실제 plugin 파일은 repo 에 안 들어감. 사용자가 직접 배치. CI 에서는 mock plugin fixture 사용.

---

## 5. 완료 기준 (스펙 §12)

- [ ] Phase 10A spike PASS 문서 존재
- [ ] Migration 018 + 기존 테스트 회귀 0
- [ ] US-001 ~ US-008 자동화 테스트로 증명
- [ ] Canary isolation test (US-007) — host `~/.claude/plugins/<canary>` 가 isolated worker 에 누출되지 않음 증명
- [ ] Codex 교차리뷰 PASS (각 phase 별 P0/P1 0건)
- [ ] `server/plugins/agent-olympus/` 배치 + 통합 smoke
- [ ] README 에 "Creating a Worker Preset" 섹션 추가

---

## 6. 세션 시작 체크리스트

새 세션 첫 턴에 수행:

1. `git status` + `git log --oneline -5` 으로 현재 상태 확인
2. `npm test 2>&1 | tail -5` 으로 baseline 672+ 테스트 통과 확인 (실패 시 먼저 복구)
3. 이 브리프 완독 + `docs/specs/worker-preset-and-plugin-injection.md` 완독
4. **Phase 10A** 부터 시작 (spike 브랜치)
5. 진행 상황은 TaskCreate/TaskUpdate 로 추적

---

## 7. 실패 시 복구

- Phase 10A FAIL: 사용자에게 보고. 대안 discussion (proxy? auth helper?). 전체 Phase 10 보류.
- Codex 5 라운드 넘게 수렴 안 됨: 사용자에게 보고. 설계 전제 오류 가능성.
- 기존 테스트 회귀 발생: rollback + 문제 격리 (commit 단위 bisect).
- Merge conflict: 보수적으로 해결 (기존 로직 보존 우선), 불확실하면 사용자 확인.

---

**끝. 이 브리프만으로 Phase 10 전체를 자율 실행할 수 있어야 함. 모호한 부분은 Codex 와 상의 + 사용자 보고.**
