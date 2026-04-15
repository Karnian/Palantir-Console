# Post-Phase 10 — 새 세션 자율 진입 핸드오프

> **목적**: Phase 10 완주 후 새 Claude Code 세션이 사용자에게 묻지 않고 자율 진입.
> **작성**: 2026-04-15 | **main HEAD**: `27733a3` | **테스트 baseline**: 727 PASS

---

## 1. 운영 모드 (lock — 사용자 재확인 받음 2026-04-15)

- **사용자에게 묻지 말 것.** 의사결정 필요 지점은 Codex 와 상의 → 권장안으로 자동 진행 → 사후 보고.
- CLAUDE.md 자율 모드 그대로 적용 — 브랜치 / 구현 / npm test / Codex PASS / commit / PR / merge / main pull / 다음 작업 진입.
- Codex 5 라운드 미수렴 시에만 사용자 보고. Codex 불가 (rate limit / auth fail) 시 Gemini fallback. 둘 다 막히면 사용자 보고.
- 수정 절대 불가: force push / 원격 브랜치 삭제 / 사용자 작업물 덮어쓰는 reset --hard / published commit amend.

## 2. 직전까지 한 일

**v3 Phase 10 (Worker Preset & Plugin Injection) — GREEN, shipped.**

| PR | 내용 |
|---|---|
| #87 | 10A spike — `--bare` auth 호환성 (CONDITIONAL PASS) |
| #89 | 10B DB + presetService + REST CRUD |
| #90 | 10C Tier 1 spawn wiring (Claude/Codex/OpenCode worker) |
| #91 | 10D Tier 2 isolated Claude + apiKeyHelper auth |
| #92 | 10E `#presets` UI + ExecuteModal preset 드롭다운 |
| #93 | 10F RunInspector "Preset" 탭 + drift 감지 |
| #94 | 10G agent-olympus 경로 + CI fixture + smoke + README |
| #95 | docs cleanup — US-007 EXCLUDED, PRESET 시나리오 18개 |

각 PR Codex 교차리뷰 최종 PASS. US-007 정식 제외 (argv-level Tier 2 wiring 검증으로 G1 보장 충분).

## 3. 다음 작업 — 자율 선택 가이드

**우선순위 (위에서 아래로 자동 평가)**:

### A) **Phase 3b — Claude PM 활성화** (`docs/specs/manager-v3-multilayer.md` §9.6 트리거)
- Phase 3a 가 Codex PM 만 활성화한 상태. Claude PM resume 은 트리거 조건 (실제 use case 발생 + Phase 3a 검증 완료) 에 묶여 대기.
- 트리거 조건 검증 방법:
  1. `git log --oneline --since="2026-04-09" --grep="pm:"` 로 PM 사용 흔적 확인
  2. `docs/specs/manager-v3-multilayer.md §9.6` 본문에서 트리거 정의 재확인
  3. 충족 안 됐으면 skip → B 로 진행
- 충족 시: 새 phase 브리프 자동 작성 → spec 라운드 (forward planning) → 구현.

### B) **알려진 플레이크 근본 수정**
- `server/tests/stream-json-engine.test.js` `engine: sendInput for worker returns false after process exits (single-shot)` — race
- `server/tests/preset-spawn.test.js` 의 parallel orphan sweep race (이미 mc_config_snapshot 으로 우회했지만 lifecycleService.cleanupOrphanMcpConfigs 가 다른 테스트의 활성 파일을 sweep 하는 게 근본 문제)
- 작업: lifecycleService 의 orphan sweep 이 "지금 이 테스트의 db" 에 등록된 run 만 대상으로 좁히도록 수정. 회귀 0 + 플레이크 0.

### C) **MCP Bifrost 연동 spec 작성** (`reference_mcp_bifrost.md`)
- 멀티 워크스페이스 MCP 브릿지. Palantir Console 측은 client 입장에서 어떻게 부를지 spec 부터.
- forward planning: requirements → architecture → phase 분할 → Codex consensus → 사용자 통보 (구현 진입 전 한 번만).

### D) **새 feature 요청 대기**
- 위 셋 모두 진입 불가 / 부적절하면 사용자 메시지 받기 전까지 idle. 단, idle 중에도 main 의 작은 cleanup 항목 (gitignore drift, 문서 오타 등) 은 발견 시 처리.

**선택 알고리즘**:

```
1. A 의 트리거 조건 확인 → 충족 시 A 진입
2. 미충족 시 → B 진입 (플레이크는 항상 진입 가능)
3. B 가 이미 처리된 상태면 → C 진입 전 Codex 에 "MCP Bifrost spec 시작 적기인지" 확인
4. C 도 보류면 → D (idle)
```

자율 모드이므로 위 결정은 Codex 한 번 확인 후 진행. 사용자 호출 없이 PR 까지 끝낸 후 보고.

## 4. 새 세션 진입 시 첫 단계

```bash
# 1. baseline 확인
git fetch origin
git status                                   # main, clean 인지
git log --oneline -5                         # HEAD 27733a3 인지
npm test 2>&1 | tail -5                      # 727 PASS 유지 (1 known flake 허용)

# 2. 본 브리프 + 핵심 spec 완독
cat docs/briefs/post-phase-10-handoff.md
cat docs/specs/manager-v3-multilayer.md      # §9.6 Phase 3b 트리거 재확인용
cat .claude/memory/MEMORY.md                 # (실제 경로: ~/.claude/projects/.../memory/MEMORY.md)
```

이후 §3 알고리즘 따라 자율 진입.

## 5. Codex 호출 패턴

```bash
cat <<'EOF' | node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.0/scripts/ask.mjs async codex
<prompt>
EOF
# → jobId 출력
node /Users/K/.claude/plugins/cache/agent-olympus/agent-olympus/1.1.0/scripts/ask.mjs collect <jobId> --wait --timeout 1500
```

Sync 가 더 빠른 짧은 질문은 `| node ask.mjs codex` 로 직접 (120s timeout).

## 6. 자율 모드 안전 가드

- 새 phase 진입 전에 항상 "이게 정말 사용자 의도와 정렬되는가" 를 Codex 에 한 번 확인 (옵션 + 권장안 받기).
- 권장안과 다른 방향으로 가는 게 의미 있다고 판단되면 즉시 사용자에게 보고.
- 매 phase 진입 전 main 동기화 + npm test 통과 확인.

---

**이 브리프 + Codex 한 번이면 새 세션이 사용자 호출 없이 다음 phase 까지 자율 완주 가능.**
