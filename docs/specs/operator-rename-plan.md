# PM → Operator FULL rename (incl. persisted wire-format) — phased plan

**User decision (2026-07-01)**: full rename INCLUDING persisted `pm:<projectId>`
conversation_id + `manager_layer='pm'` + symbols + docs. Zero functional gain; pure
naming-consistency of the (locked) Operator role. HIGH blast-radius → **no big-bang;
dual-read first, one Codex-validated phase per PR.**

## Ground truth (footprint investigation)
- **No shared helper** for `pm:` — producers inline `` `pm:${projectId}` `` (9 server + ~6 UI
  sites); consumers inline `.startsWith('pm:')`/`.slice(3)`.
- **Consumer chokepoints (2)**: `conversationService.parseConversationId()` +
  `routerService.isValidConversationId()`/`VALID_TARGET_PREFIXES`. **Bypass sites (5)** that
  inline their own match: `runService.derivePmProjectId`, `managerRegistry.snapshot()`,
  `reconciliationService` (EQUALITY, fail-closed — riskiest), `app.js onSlotCleared`,
  `routes/manager.js` boot-resume filter.
- **THREE stored enums** (each a CHECK/table-rebuild migration): `runs.manager_layer='pm'`
  (CHECK in mig 009 AND 012), `memory_composition_events.slot_kind='pm'` (CHECK 038),
  `pm_memory_injection` (table name + PK `pm_run_id`, mig 025/033/039).
- **pm_* columns**: `projects.pm_enabled`, `projects.preferred_pm_adapter`,
  `project_briefs.pm_adapter`, `project_briefs.pm_thread_id` (⚠ = the codex VENDOR thread id,
  PM-scoped but not a `pm:` string), `dispatch_audit.pm_run_id`.
- **No external contract exposure** except the URL `/api/conversations/pm:<id>` (browser +
  docs). Webhook payload + SSE channels carry no `pm:`. `pm:force_reset` is server-internal.
- **Tests**: ~18 files assert the `pm:` wire-format (~130 lines); ~32 lines assert
  `manager_layer:'pm'`; symbol/path-coupled tests (spawn-cwd, mcp-config-pipeline, skill-packs-pm).

## Riskiest consumers (ranked)
1. `reconciliationService.js:325` — fail-closed EQUALITY `conversation_id !== \`pm:${projectId}\`` → wrong form = every claim silently rejected.
2. `routes/manager.js:172` boot-resume — `startsWith('pm:')` filter → wrong form = PM silently not resumed.
3. `manager_layer` CHECK (mig 009+012) — insert of `'operator'` throws until CHECK relaxed.
4. `pm_memory_injection` table/PK rename — heavy migration.
5. `managerRegistry` in-memory slot Map — not normalized; `pm:x` write vs `operator:x` lookup silently misses (mitigated by boot restart after migration).

## Phased plan (each = its own PR + Codex R2/R3)

### Phase 0 — helper + DUAL-READ (this PR; additive, behavior-preserving, NO persisted change)
Add `utils/conversationId.js`: `conversationIdForProject(projectId)` (returns `pm:` STILL),
`parseProjectConversationId(id)` (accepts BOTH `pm:`/`operator:` → `{projectId}` else null),
`isProjectLayer(layer)` (`'pm'` OR `'operator'`), `OPERATOR_*`/`LEGACY_PM_*` constants + prefix set.
Route **ALL** of these consumers through dual-read (Codex design review — the plan's original
5-site count was undercounted; these are the verified complete set):
- `conversationService.parseConversationId` (~120-134) — accept `pm:` and `operator:`  [chokepoint 1]
- `routerService.isValidConversationId` + `VALID_TARGET_PREFIXES` (~47-54)               [chokepoint 2]
- `reconciliationService` **:320 `manager_layer!=='pm'`** AND **:325-326 conv_id equality** — TWO
  separate fail-closed checks; both accept operator form (else migrated PM's every claim 400s)
- `conversationService.resolveParentSlot` :664 (`manager_layer!=='pm'` + `pmSlotKey.startsWith('pm:')`)
- `runService.derivePmProjectId` :45 (`manager_layer==='pm'` + `startsWith('pm:')`/slice)
- `managerRegistry.snapshot()` :172 (`key.startsWith('pm:')` → `pms[]`) — **restart does NOT fix;
    after migration all keys are `operator:` → empty pms → /api/manager/status silently breaks**
- `app.js onSlotCleared` :161 (`startsWith('pm:')` early-return) — else autoReviewCounts cleanup
    skips `operator:` slots (memory leak / stale suppression)
- `routes/manager.js` boot-resume **:114 `!=='pm'` AND :115 `==='pm'`** (layer split) **AND :172
    `startsWith('pm:')`** (projectId extract) — else migrated PMs classified wrong + not resumed
- `conversationService.js:267` `expectedLayer` + `runService.js:462` listRuns filter (accept both layer values)
- Producers still emit `pm:`/`'pm'`. No migration. **Result: understands `operator:` everywhere,
  still writes `pm:` → 100% behavior-preserving.** Tests: dual-read equivalence (both prefixes →
  identical parse/route/bind/snapshot/resume); existing `pm:` tests stay green untouched.

### Phase 1 — enum CHECK relaxation + data migration (persisted flip)
- Migration: relax CHECKs to include `'operator'` (table rebuilds for runs [mig 009+012 shape],
  memory_composition_events); THEN rewrite persisted values `runs.conversation_id` pm:→operator:,
  `runs.manager_layer` 'pm'→'operator', `slot_kind` 'pm'→'operator'. Ships AFTER Phase 0 is live
  (dual-read already deployed), so any not-yet-migrated row is still understood.
- `pm_memory_injection` table/PK: decide — rename table+PK (heavy) vs leave as internal ledger
  name (its `pm_run_id` is a column value, not a `pm:` conv-id). Likely DEFER to Phase 3.
- Restart re-populates managerRegistry from migrated DB (operator: keys). Boot-resume already
  dual-reads (Phase 0), so mid-migration rows resume fine.

### Phase 2 — flip PRODUCERS to `operator:`
- `conversationIdForProject` → emit `operator:`; producers of manager_layer/slot_kind → `'operator'`.
- managerSystemPrompt CONVERSATION_ID format + `/api/conversations/operator:PROJECT_ID` examples.
- `pm_run_id` prompt/envelope FIELD → `operator_run_id` couples to a PM-reset (live prompts bake
  the old field) — sequence carefully or keep the field name (transient) to avoid desync.

### Phase 3 — symbols / files / columns / UI / docs (mechanical, but column renames = migrations)
- `pmSpawnService`→`operatorSpawnService`, `pmCleanupService`→`operatorCleanupService`,
  `derivePmProjectId`→`deriveOperatorProjectId`, etc. + all importers/tests.
- Column renames (`pm_enabled`, `preferred_pm_adapter`, `pm_adapter`, `dispatch_audit.pm_run_id`,
  `pm_memory_injection`) — each a migration + service + validate + UI + tests. Can be its own sub-PR.
- UI labels/CSS/copy.js; CLAUDE.md/AGENT.md/README/docs/specs.

### Phase 4 — drop dual-read (cleanup)
- Remove `pm:`/`'pm'` acceptance from consumers + legacy CHECK values, once all persisted +
  producers are `operator:`. (Leave the URL `pm:` accept longest for bookmarked links, or drop
  with a documented breaking note.)

## Invariants held every phase
- Never write a form consumers don't yet read (dual-read precedes producer/data flip).
- Each phase `npm test` green + Codex R2/R3 GO before merge.
- Additive/reversible until Phase 4.

## Codex design review outcome (2026-07-01) — REVISE applied
- **Phase 0 bypass list corrected** above (reconciliation :320 + :325 as TWO checks; snapshot();
  onSlotCleared; boot-resume :114/:115/:172; resolveParentSlot; expectedLayer; listRuns filter).
- **Single-deploy rule (tightened)**: dual-read code MUST be in the SAME deploy as (or earlier
  than) the data migration, migration idempotent. "Old code + migrated data = immediate breakage."
  Phase 1 migration ships only after Phase 0 is fully complete + live.
- **slot_kind ordering (Phase 1)**: relax CHECK → update code to query BOTH values → THEN migrate
  data. Migrating slot_kind before the gate code reads both makes `shouldCompose` miss prior
  accepted rows → unexpected recompose/reinjection. (Phase 0 already makes consumers read both.)
- **runs rebuild (Phase 1)**: use the CURRENT full `runs` schema, NOT the mig-012 shape — later
  migrations added mcp_config_path / mcp_config_snapshot / preset_id / preset_snapshot_hash /
  queued_args / retry_count. Rebuilding from the stale shape drops columns.
- **managerSystemPrompt `layer==='pm'` (6+ conditionals, Phase 2)**: flip ATOMICALLY with the
  callers that pass `layer` — else PM-specific prompt sections silently vanish.
- **pm_run_id prompt/envelope FIELD**: KEEP the name (transient; renaming desyncs live PM prompts).

## SCOPE decision (Codex recommendation — narrow "full" to the wire-format + role name)
Rename: the `pm:` **conversation-id wire-format**, the `manager_layer`/`slot_kind` **stored enums**,
service **symbols/files** (pmSpawnService→operatorSpawnService …), **UI labels/copy**, **docs**, and
the `pm:force_reset` **event** (dual-emit in Phase 3).
LEAVE (internal, zero user/wire value; rename = migration/API-shape churn for no gain):
- `pm_memory_injection` — **already dropped by migration 040** (nothing to rename).
- columns `projects.pm_enabled` / `preferred_pm_adapter` / `project_briefs.pm_adapter` /
  `pm_thread_id` (vendor thread) / `dispatch_audit.pm_run_id` — internal columns; renaming changes
  the projects/audit API response shape + needs migration+service+validate+UI+tests for 0 gain.
- role identifiers `skillPackService.callerType==='pm'` + `pinned_by CHECK('pm','user')` — a role
  flag, not the conversation-id/layer; unrelated to the wire-format.
*(User asked for "전면/full". This narrowing keeps everything user- or wire-visible as Operator
while sparing pure-internal, API-shape-breaking column churn. Flagged for the user to override if
they truly want the column renames too — that would be an extra Phase 3b of column migrations.)*
