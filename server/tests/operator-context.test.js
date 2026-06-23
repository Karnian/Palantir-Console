'use strict';

// Operator P-B2a — OperatorContext + ExecutionMode + SpecialistInvocation contracts.
//
// Pure, unwired (no spawn/route constructs a context yet — P-B2b wires it). Verifies:
//   - ExecutionMode axis (enum + guards).
//   - deriveLegacyContext: descriptive context for existing runs (passthrough).
//   - createSpecialistContext: folder-less doer, deny-by-default.
//   - kind ⟺ grant.legacy invariant (Codex S3/Q5) — enforced by assert, not trusted.
//   - isEnforced gate derives from the branded grant (legacy=false, specialist=true).
//   - SpecialistInvocation trace contract (Codex BLOCKER-1): anchored to origin run.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { EXECUTION_MODE, isExecutionMode, assertExecutionMode } = require('../utils/executionMode');
const { WORKSPACE_BINDING } = require('../utils/workspaceBinding');
const { CAPABILITIES, createLegacyGrant, createGrant, assertCapability } = require('../utils/capability');
const {
  OPERATOR_KIND,
  DEFAULT_SPECIALIST_CAPS,
  deriveLegacyContext,
  createSpecialistContext,
  assertOperatorContext,
  isEnforced,
  createSpecialistInvocation,
} = require('../utils/operatorContext');

// ──────────────────────────────────────────────────────────────
// ExecutionMode axis
// ──────────────────────────────────────────────────────────────
test('executionMode: enum + isExecutionMode', () => {
  assert.deepEqual(EXECUTION_MODE, { DISPATCHER: 'dispatcher', DOER: 'doer' });
  assert.ok(isExecutionMode('dispatcher') && isExecutionMode('doer'));
  assert.ok(!isExecutionMode('boss') && !isExecutionMode(undefined));
});

test('executionMode: assertExecutionMode typo guard', () => {
  assert.doesNotThrow(() => assertExecutionMode('doer'));
  assert.throws(() => assertExecutionMode('worker'), /invalid execution mode/);
});

// ──────────────────────────────────────────────────────────────
// deriveLegacyContext — existing runs (descriptive, passthrough)
// ──────────────────────────────────────────────────────────────
test('deriveLegacyContext: manager + workspaceDir → dispatcher / folder / legacy grant', () => {
  const ctx = deriveLegacyContext({ run: { is_manager: true, agent_profile_id: 'p-codex' }, workspaceDir: '/repo' });
  assert.equal(ctx.kind, OPERATOR_KIND.LEGACY);
  assert.equal(ctx.executionMode, EXECUTION_MODE.DISPATCHER);
  assert.equal(ctx.workspaceBinding, WORKSPACE_BINDING.FOLDER);
  assert.equal(ctx.profileId, 'p-codex');
  assert.equal(ctx.capabilityGrant.legacy, true);
  assert.ok(Object.isFrozen(ctx));
});

test('deriveLegacyContext: worker (is_manager false) → doer', () => {
  const ctx = deriveLegacyContext({ run: { is_manager: false, agent_profile_id: 'p1' }, workspaceDir: '/repo' });
  assert.equal(ctx.executionMode, EXECUTION_MODE.DOER);
  assert.equal(ctx.workspaceBinding, WORKSPACE_BINDING.FOLDER);
});

test('deriveLegacyContext: no workspaceDir (e.g. Top) → descriptive none, still legacy (never enforced)', () => {
  const ctx = deriveLegacyContext({ run: { is_manager: true } });
  assert.equal(ctx.workspaceBinding, WORKSPACE_BINDING.NONE);
  assert.equal(ctx.profileId, null);
  assert.equal(isEnforced(ctx), false, 'legacy context is NOT enforced even when binding is none');
});

test('deriveLegacyContext: missing run throws', () => {
  assert.throws(() => deriveLegacyContext({}), /run is required/);
  assert.throws(() => deriveLegacyContext({ run: null }), /run is required/);
});

test('deriveLegacyContext: legacy grant is full passthrough (existing behavior unchanged)', () => {
  const ctx = deriveLegacyContext({ run: { is_manager: true }, workspaceDir: '/repo' });
  for (const cap of Object.values(CAPABILITIES)) {
    assert.doesNotThrow(() => assertCapability(ctx.capabilityGrant, cap), `legacy should allow ${cap}`);
  }
});

// ──────────────────────────────────────────────────────────────
// createSpecialistContext — folder-less doer, deny-by-default
// ──────────────────────────────────────────────────────────────
test('createSpecialistContext: none + doer + deny-by-default (default O9 allowlist)', () => {
  const ctx = createSpecialistContext({ profileId: 'sec-reviewer' });
  assert.equal(ctx.kind, OPERATOR_KIND.SPECIALIST);
  assert.equal(ctx.workspaceBinding, WORKSPACE_BINDING.NONE);
  assert.equal(ctx.executionMode, EXECUTION_MODE.DOER);
  assert.equal(ctx.profileId, 'sec-reviewer');
  assert.equal(ctx.capabilityGrant.legacy, false);
  assert.ok(Object.isFrozen(ctx));
  // only registry_metadata_search allowed; everything else denied
  assert.doesNotThrow(() => assertCapability(ctx.capabilityGrant, 'registry_metadata_search'));
  for (const cap of ['shell', 'fs', 'network', 'mcp', 'dispatch_execute', 'task_write', 'memory_write']) {
    assert.throws(() => assertCapability(ctx.capabilityGrant, cap), /capability denied/);
  }
  assert.deepEqual(DEFAULT_SPECIALIST_CAPS, ['registry_metadata_search']);
});

test('createSpecialistContext: custom capabilities honored; unknown rejected', () => {
  const ctx = createSpecialistContext({ profileId: 'p', capabilities: [CAPABILITIES.PROJECT_READ, CAPABILITIES.RUN_READ] });
  assert.doesNotThrow(() => assertCapability(ctx.capabilityGrant, 'project_read'));
  assert.doesNotThrow(() => assertCapability(ctx.capabilityGrant, 'run_read'));
  assert.throws(() => assertCapability(ctx.capabilityGrant, 'shell'), /capability denied/);
  assert.throws(() => createSpecialistContext({ profileId: 'p', capabilities: ['bogus'] }), /unknown capability/);
});

test('createSpecialistContext: profileId required (fail-closed)', () => {
  assert.throws(() => createSpecialistContext({}), /profileId must be a non-empty string/);
  assert.throws(() => createSpecialistContext({ profileId: '   ' }), /profileId must be a non-empty string/);
  assert.throws(() => createSpecialistContext({ profileId: 123 }), /profileId must be a non-empty string/);
});

// ──────────────────────────────────────────────────────────────
// isEnforced gate + kind⟺grant invariant (Codex S3/Q5)
// ──────────────────────────────────────────────────────────────
test('isEnforced: legacy → false, specialist → true', () => {
  assert.equal(isEnforced(deriveLegacyContext({ run: { is_manager: true }, workspaceDir: '/r' })), false);
  assert.equal(isEnforced(createSpecialistContext({ profileId: 'p' })), true);
});

test('invariant: kind=legacy with an EXPLICIT (non-legacy) grant is rejected', () => {
  // A tampered/hand-built context whose kind disagrees with its branded grant
  // must not slip past — assertOperatorContext (and isEnforced) reject it.
  const tampered = { kind: 'legacy', profileId: null, workspaceBinding: 'none', executionMode: 'doer', capabilityGrant: createGrant([]) };
  assert.throws(() => assertOperatorContext(tampered), /kind\/grant invariant/);
  assert.throws(() => isEnforced(tampered), /kind\/grant invariant/);
});

test('invariant: kind=specialist with a LEGACY grant is rejected', () => {
  const tampered = { kind: 'specialist', profileId: 'p', workspaceBinding: 'none', executionMode: 'doer', capabilityGrant: createLegacyGrant() };
  assert.throws(() => assertOperatorContext(tampered), /kind\/grant invariant/);
});

test('assertOperatorContext: shape validation (kind / binding / mode / grant)', () => {
  assert.throws(() => assertOperatorContext(null), /non-null object/);
  assert.throws(() => assertOperatorContext({ kind: 'boss', workspaceBinding: 'none', executionMode: 'doer', capabilityGrant: createGrant([]) }), /invalid kind/);
  assert.throws(() => assertOperatorContext({ kind: 'specialist', workspaceBinding: 'cloud', executionMode: 'doer', capabilityGrant: createGrant([]) }), /invalid workspaceBinding/);
  assert.throws(() => assertOperatorContext({ kind: 'specialist', workspaceBinding: 'none', executionMode: 'boss', capabilityGrant: createGrant([]) }), /invalid execution mode/);
  assert.throws(() => assertOperatorContext({ kind: 'specialist', workspaceBinding: 'none', executionMode: 'doer', capabilityGrant: { legacy: 'nope' } }), /must be a grant object/);
});

// ──────────────────────────────────────────────────────────────
// R2 security/coherence fixes (Codex P-B2 R2 NO-GO → fixes)
// ──────────────────────────────────────────────────────────────
test('🔒 R2 BLOCKER: a forged (non-factory) grant is rejected — no enforcement-gate bypass', () => {
  // The crux: isEnforced reads grant.legacy. A forged plain object {legacy:true}
  // would make isEnforced return false → B2b skips BOTH asserts, never reaching
  // assertCapability's WeakSet. assertOperatorContext must reject it (fail-closed),
  // so isEnforced THROWS rather than silently returning a wrong gate value.
  const forgedLegacy = { kind: 'legacy', profileId: null, workspaceBinding: 'none', executionMode: 'doer', capabilityGrant: { legacy: true, caps: [] } };
  assert.throws(() => assertOperatorContext(forgedLegacy), /factory-issued grant/);
  assert.throws(() => isEnforced(forgedLegacy), /factory-issued grant/);
  // a forged "specialist" with an explicit-looking grant is likewise rejected
  const forgedSpecialist = { kind: 'specialist', profileId: 'p', workspaceBinding: 'none', executionMode: 'doer', capabilityGrant: { legacy: false, caps: ['shell'] } };
  assert.throws(() => assertOperatorContext(forgedSpecialist), /factory-issued grant/);
  // a spread/clone of a REAL grant is a different object → not in the WeakSet → rejected
  const cloned = { kind: 'legacy', profileId: null, workspaceBinding: 'none', executionMode: 'doer', capabilityGrant: { ...createLegacyGrant() } };
  assert.throws(() => assertOperatorContext(cloned), /factory-issued grant/);
});

test('🔒 R2 SERIOUS: assertOperatorContext rejects an incoherent specialist (folder / dispatcher)', () => {
  const realGrant = createGrant([CAPABILITIES.REGISTRY_METADATA_SEARCH]);
  assert.throws(
    () => assertOperatorContext({ kind: 'specialist', profileId: 'p', workspaceBinding: 'folder', executionMode: 'doer', capabilityGrant: realGrant }),
    /specialist must be workspace:none/
  );
  assert.throws(
    () => assertOperatorContext({ kind: 'specialist', profileId: 'p', workspaceBinding: 'none', executionMode: 'dispatcher', capabilityGrant: realGrant }),
    /specialist must be executionMode:doer/
  );
});

// ──────────────────────────────────────────────────────────────
// SpecialistInvocation — ephemeral trace anchored to origin run (Codex BLOCKER-1)
// ──────────────────────────────────────────────────────────────
test('createSpecialistInvocation: builds a frozen trace from a specialist context + origin run', () => {
  const ctx = createSpecialistContext({ profileId: 'researcher' });
  const inv = createSpecialistInvocation({ operatorContext: ctx, originRunId: 'run-top-1', originConversationId: 'top' });
  assert.equal(inv.profileId, 'researcher');
  assert.equal(inv.originRunId, 'run-top-1');
  assert.equal(inv.originConversationId, 'top');
  assert.equal(inv.operatorContext, ctx);
  assert.ok(typeof inv.invocationId === 'string' && inv.invocationId.length > 0);
  assert.ok(Object.isFrozen(inv));
});

test('createSpecialistInvocation: freezes a hand-built (unfrozen) nested context (R2 MEDIUM)', () => {
  const handBuilt = { kind: 'specialist', profileId: 'p', workspaceBinding: 'none', executionMode: 'doer', capabilityGrant: createGrant([CAPABILITIES.REGISTRY_METADATA_SEARCH]) };
  assert.ok(!Object.isFrozen(handBuilt));
  const inv = createSpecialistInvocation({ operatorContext: handBuilt, originRunId: 'r1' });
  assert.ok(Object.isFrozen(inv.operatorContext), 'nested context must be frozen by the invocation');
});

test('createSpecialistInvocation: explicit invocationId honored; else generated unique', () => {
  const ctx = createSpecialistContext({ profileId: 'p' });
  const inv = createSpecialistInvocation({ operatorContext: ctx, originRunId: 'r1', invocationId: 'fixed-id' });
  assert.equal(inv.invocationId, 'fixed-id');
  const a = createSpecialistInvocation({ operatorContext: ctx, originRunId: 'r1' });
  const b = createSpecialistInvocation({ operatorContext: ctx, originRunId: 'r1' });
  assert.notEqual(a.invocationId, b.invocationId);
});

test('createSpecialistInvocation: rejects legacy context + requires origin run anchor', () => {
  const legacy = deriveLegacyContext({ run: { is_manager: true }, workspaceDir: '/r' });
  assert.throws(() => createSpecialistInvocation({ operatorContext: legacy, originRunId: 'r1' }), /requires a specialist operatorContext/);
  const ctx = createSpecialistContext({ profileId: 'p' });
  assert.throws(() => createSpecialistInvocation({ operatorContext: ctx }), /originRunId must be a non-empty string/);
  assert.throws(() => createSpecialistInvocation({ operatorContext: ctx, originRunId: '  ' }), /originRunId must be a non-empty string/);
});
