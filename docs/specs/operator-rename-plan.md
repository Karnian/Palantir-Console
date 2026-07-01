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
- Add a shared module (e.g. `utils/conversationId.js`): `conversationIdForProject(projectId)`
  (returns `pm:` STILL — producers unchanged), `parseProjectConversationId(id)` (accepts BOTH
  `pm:` and `operator:` → `{projectId}`), `OPERATOR_LAYER`/`LEGACY_PM_LAYER` constants, and an
  `isProjectConversationId`/prefix set.
- Route ALL consumers through dual-read: the 2 chokepoints + the 5 bypass sites accept BOTH
  `pm:` and `operator:` (and manager_layer/slot_kind accept both `'pm'` and `'operator'`).
- reconciliationService: change the EQUALITY to accept EITHER `pm:${id}` or `operator:${id}`.
- Producers still emit `pm:` / `'pm'`. No migration. **Result: system understands `operator:`
  everywhere but still writes `pm:` → 100% behavior-preserving; verifiable by asserting both
  prefixes route/bind/parse identically.**
- Tests: dual-read equivalence (pm: and operator: → same routing/binding/parse); existing
  `pm:` tests stay green untouched.

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

## For Codex design review
- Is the dual-read-first ordering sufficient to prevent ALL silent breakage (esp. reconciliation
  equality + boot-resume + registry Map)? Any consumer the footprint missed?
- Phase 1 migration on a single-deploy system: is "Phase 0 merged+deployed, THEN Phase 1 migration"
  safe, or must dual-read + migration ship together (same deploy) with the migration idempotent?
- `pm_memory_injection` + column renames — worth the churn now, or leave internal names?
- Smallest safe Phase 0 slice.
