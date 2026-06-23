'use strict';

/**
 * Operator context (Operator P-B, slice P-B2a).
 *
 * brief §2: `OperatorInstance = Profile × WorkspaceBinding × ExecutionMode`. This
 * module is the 1st-class combiner of the three P-B0/P-B1 axes into one object
 * the spawn/enforcement paths can carry. It is PURE + UNWIRED (mirrors
 * workspaceBinding #250 / capability #251 landing as contracts first): no caller
 * constructs or reads a context yet — P-B2b wires enforcement, P-B2c spawns
 * specialists.
 *
 * Two kinds (Codex review: "allow all" ✗ → legacy passthrough):
 *   - legacy:     every existing run (Top, coder PM, worker, resumed managers).
 *                 capabilityGrant = legacy passthrough (#251); workspaceBinding /
 *                 executionMode are DESCRIPTIVE ONLY and are NEVER enforced.
 *   - specialist: a folder-less doer (workspace:none + deny-by-default grant).
 *                 The ONLY kind P-B2b enforces.
 *
 * 🔑 Enforcement gate (Codex P-B2 review S3/Q5): `isEnforced(ctx)` derives from
 * the BRANDED, forgery-proof grant's `legacy` bit — NOT from `ctx.kind` alone —
 * with a factory + assert invariant that pins `kind==='legacy' ⟺ grant.legacy`.
 * So a context whose kind was tampered to 'legacy' but still carries an explicit
 * grant can't slip past enforcement (and vice-versa).
 *
 * ⚠️ Necessary-but-not-sufficient (Codex P-B2 review BLOCKER-2): the asserts a
 * context enables (P-B2b) do NOT by themselves sandbox a specialist — the codex
 * adapter always passes `--dangerously-bypass-approvals-and-sandbox` + falls back
 * to server cwd/process.env. P-B2c MUST run specialists on a dedicated backend
 * that grants NO ambient authority (tools restricted to the grant, no sandbox
 * bypass). A context is the policy; the backend must honor it.
 */

const crypto = require('crypto');
const { WORKSPACE_BINDING } = require('./workspaceBinding');
const { createLegacyGrant, createGrant, CAPABILITIES, isRealGrant } = require('./capability');
const { EXECUTION_MODE, assertExecutionMode } = require('./executionMode');

const OPERATOR_KIND = Object.freeze({ LEGACY: 'legacy', SPECIALIST: 'specialist' });
const KIND_SET = new Set([OPERATOR_KIND.LEGACY, OPERATOR_KIND.SPECIALIST]);
const BINDING_SET = new Set([WORKSPACE_BINDING.NONE, WORKSPACE_BINDING.FOLDER]);

// Default specialist capability = O9 allowlist only (internal registry/profile
// METADATA search; never install/fetch, never shell/FS/network/MCP/artifact).
const DEFAULT_SPECIALIST_CAPS = Object.freeze([CAPABILITIES.REGISTRY_METADATA_SEARCH]);

/**
 * Validate an OperatorContext shape + the kind↔grant invariant (fail-closed).
 * @param {object} ctx
 * @returns {void}
 */
function assertOperatorContext(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('assertOperatorContext: context must be a non-null object');
  }
  if (!KIND_SET.has(ctx.kind)) {
    throw new Error(`assertOperatorContext: invalid kind "${ctx.kind}" (expected legacy|specialist)`);
  }
  if (!BINDING_SET.has(ctx.workspaceBinding)) {
    throw new Error(`assertOperatorContext: invalid workspaceBinding "${ctx.workspaceBinding}"`);
  }
  assertExecutionMode(ctx.executionMode);
  const grant = ctx.capabilityGrant;
  if (!grant || typeof grant !== 'object' || typeof grant.legacy !== 'boolean') {
    throw new Error('assertOperatorContext: capabilityGrant must be a grant object');
  }
  // 🔒 Forgery (Codex P-B2 R2 BLOCKER — same class as #251): the enforcement
  // GATE (isEnforced) reads grant.legacy, so a forged plain object {legacy:true}
  // would skip BOTH asserts in P-B2b without ever reaching the WeakSet check in
  // assertCapability. Verify the grant is factory-issued (WeakSet identity)
  // BEFORE trusting its legacy bit. Fail-closed.
  if (!isRealGrant(grant)) {
    throw new Error('assertOperatorContext: capabilityGrant must be a factory-issued grant (forged/cloned grants are rejected)');
  }
  // Invariant (Codex S3/Q5): kind === legacy IFF the grant is a legacy grant.
  if ((ctx.kind === OPERATOR_KIND.LEGACY) !== (grant.legacy === true)) {
    throw new Error(
      `assertOperatorContext: kind/grant invariant violated (kind=${ctx.kind}, grant.legacy=${grant.legacy})`
    );
  }
  // Specialist coherence (Codex P-B2 R2 SERIOUS): the MVP specialist is pinned to
  // workspace:none + doer. A folder-bound / dispatcher operator is a LEGACY/coder,
  // not a specialist. Validate at the contract boundary, not just in the factory,
  // so B2b/B2c can't build an incoherent specialist shape the plan doesn't intend.
  if (ctx.kind === OPERATOR_KIND.SPECIALIST) {
    if (ctx.workspaceBinding !== WORKSPACE_BINDING.NONE) {
      throw new Error(`assertOperatorContext: specialist must be workspace:none (got "${ctx.workspaceBinding}")`);
    }
    if (ctx.executionMode !== EXECUTION_MODE.DOER) {
      throw new Error(`assertOperatorContext: specialist must be executionMode:doer (got "${ctx.executionMode}")`);
    }
  }
}

function freezeContext(ctx) {
  assertOperatorContext(ctx);
  return Object.freeze(ctx);
}

/**
 * Derive the DESCRIPTIVE legacy context for an existing run (Top, coder PM,
 * worker, resumed manager). Legacy contexts are passthrough — never enforced —
 * so the descriptive workspaceBinding/executionMode are best-effort.
 *
 * `workspaceDir` is passed EXPLICITLY by the caller (Codex S2): `getRun()` does
 * not select `project.directory`, so guessing here would mis-derive folder-bound
 * PMs/workers to workspace:none. Caller resolves it (worktree path or
 * project.directory) and hands it in.
 *
 * @param {{ run: object, workspaceDir?: string|null }} args
 * @returns {object} frozen legacy OperatorContext
 */
function deriveLegacyContext({ run, workspaceDir = null } = {}) {
  if (!run || typeof run !== 'object') {
    throw new Error('deriveLegacyContext: run is required');
  }
  return freezeContext({
    kind: OPERATOR_KIND.LEGACY,
    profileId: run.agent_profile_id || null,
    workspaceBinding: workspaceDir ? WORKSPACE_BINDING.FOLDER : WORKSPACE_BINDING.NONE,
    capabilityGrant: createLegacyGrant(),
    executionMode: run.is_manager ? EXECUTION_MODE.DISPATCHER : EXECUTION_MODE.DOER,
  });
}

/**
 * Construct a folder-less specialist context: workspace:none + deny-by-default
 * grant + doer. This is the only kind P-B2b enforces.
 *
 * @param {{ profileId: string, capabilities?: string[] }} args
 * @returns {object} frozen specialist OperatorContext
 */
function createSpecialistContext({ profileId, capabilities = DEFAULT_SPECIALIST_CAPS } = {}) {
  if (typeof profileId !== 'string' || profileId.trim() === '') {
    throw new Error('createSpecialistContext: profileId must be a non-empty string');
  }
  return freezeContext({
    kind: OPERATOR_KIND.SPECIALIST,
    profileId,
    workspaceBinding: WORKSPACE_BINDING.NONE,
    capabilityGrant: createGrant(capabilities), // throws on unknown capability
    executionMode: EXECUTION_MODE.DOER,
  });
}

/**
 * The single enforcement gate (Codex S3/Q5): is this context subject to
 * assertWorkspaceBound + assertCapability? Derives from the branded grant's
 * legacy bit (single source of truth), AFTER validating the context. Legacy →
 * false (passthrough); specialist → true.
 * @param {object} ctx
 * @returns {boolean}
 */
function isEnforced(ctx) {
  assertOperatorContext(ctx);
  return ctx.capabilityGrant.legacy === false;
}

/**
 * SpecialistInvocation — the ephemeral trace/identity span for ONE specialist
 * turn (Codex BLOCKER-1). A specialist has NO durable run, but the system's
 * observability is run-bound, so its trace hangs off the ORIGIN run (the durable
 * Top/PM that invoked it) via `invocationId`: P-B2c emits specialist events on
 * `originRunId`'s stream tagged with this id. This keeps the specialist ephemeral
 * (no new run kind / no HARD-boundary migration) while remaining observable.
 *
 * @param {{ operatorContext: object, originRunId: string,
 *           originConversationId?: string|null, invocationId?: string }} args
 * @returns {object} frozen SpecialistInvocation
 */
function createSpecialistInvocation({ operatorContext, originRunId, originConversationId = null, invocationId } = {}) {
  assertOperatorContext(operatorContext);
  if (operatorContext.kind !== OPERATOR_KIND.SPECIALIST) {
    throw new Error('createSpecialistInvocation: requires a specialist operatorContext');
  }
  if (typeof originRunId !== 'string' || originRunId.trim() === '') {
    // The trace MUST anchor to a durable origin run for observability.
    throw new Error('createSpecialistInvocation: originRunId must be a non-empty string');
  }
  const id = (typeof invocationId === 'string' && invocationId.trim()) ? invocationId : crypto.randomUUID();
  // Freeze the nested context too (Codex P-B2 R2 MEDIUM): factory contexts are
  // already frozen, but a hand-built coherent context could otherwise be mutated
  // after the invocation observed it. Shallow freeze suffices — the grant +
  // caps array are independently frozen by the capability factory.
  Object.freeze(operatorContext);
  return Object.freeze({
    invocationId: id,
    profileId: operatorContext.profileId,
    originRunId,
    originConversationId,
    operatorContext,
  });
}

module.exports = {
  OPERATOR_KIND,
  DEFAULT_SPECIALIST_CAPS,
  deriveLegacyContext,
  createSpecialistContext,
  assertOperatorContext,
  isEnforced,
  createSpecialistInvocation,
};
