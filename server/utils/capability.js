'use strict';

/**
 * Operator capability contract (Operator P-B, slice P-B0).
 *
 * brief §8 NO-GO #2 + §9 O9: a folder-less specialist runs deny-by-default — no
 * shell/FS/network/MCP/browser/env/artifacts, and none of the privileged
 * internal REST surfaces. Codex review (P-B): a PM's real authority is its REST
 * surface, NOT just CLI tools, so capabilities cover BOTH planes.
 *
 * Two grant modes (Codex: "allow all" ✗ → legacy passthrough):
 *   - legacy passthrough (`createLegacyGrant()`): every capability allowed, no
 *     check. TODAY's coder PM and workers get this, preserving behavior EXACTLY
 *     (Claude PM restricted tool set / Codex PM sandbox bypass unchanged).
 *   - explicit (`createGrant([...])`): deny-by-default; only listed caps allowed.
 *     A folder-less specialist gets a minimal grant (O9: registry_metadata_search).
 *
 * 🔒 Anti-forgery (Codex review SERIOUS, R2): a grant is ONLY honored if it is
 * the EXACT object a factory returned, tracked in a module-private WeakSet by
 * object identity. This defeats every copy-based forgery — a plain
 * `{ legacy:true }`, a spread/`Object.assign` clone of a real grant, or an
 * `Object.create(realGrant)` prototype — because each is a different object not
 * in the WeakSet. (R1 used an enumerable Symbol brand, which spread/clone copied
 * — R2 caught that.) Grants are also frozen with a frozen cap list (no
 * `caps.push` escalation); CAP_SET is private so the vocabulary can't be mutated.
 *
 * ⚠️ fail-open guard (Codex review): there is intentionally NO "no grant ⇒
 * legacy" default. `assertCapability(undefined, cap)` THROWS. When P-B2 wires
 * this, legacy MUST be injected explicitly at the existing coder/worker context
 * creation points; a privileged surface that simply forgets to assert is the
 * real fail-open risk and is a wiring bug, not a default here.
 *
 * NOT WIRED YET (P-B0 scaffold): no caller today (mirrors resolveSpawnCwd
 * requireExplicit #225 and assertWorkspaceBound #250). P-B2 builds the
 * OperatorContext = { workspaceBinding, capabilityGrant, executionMode } and maps
 * each privileged route/service to a capability. This vocabulary is the specialist
 * DENY baseline, NOT a closed set — P-B2 may add caps as it maps routes.
 */

// Module-private registry of factory-issued grants, keyed by object identity.
// Identity (not a property) means a forged/cloned object is never in the set,
// so spread/Object.assign/Object.create cannot fabricate an honored grant.
const ISSUED_GRANTS = new WeakSet();

const CAPABILITIES = Object.freeze({
  // CLI / process plane
  SHELL: 'shell',
  FS: 'fs',
  NETWORK: 'network',
  MCP: 'mcp',
  BROWSER: 'browser',
  ENV: 'env',
  ARTIFACT: 'artifact',
  INHERIT_RUN_CONTEXT: 'inherit_run_context',
  // internal REST plane — write/control (a PM's real authority; Codex P-B review)
  DISPATCH_EXECUTE: 'dispatch_execute',     // POST /execute (spawn worker run)
  TASK_WRITE: 'task_write',                 // task create/update/delete
  RUN_CONTROL: 'run_control',               // run cancel/retry/status mutation
  RUN_READ: 'run_read',                     // run diff/output/inspect
  DISPATCH_AUDIT_WRITE: 'dispatch_audit_write',
  MEMORY_WRITE: 'memory_write',             // /memory/* writes
  PROJECT_WRITE: 'project_write',           // project + brief create/update/delete
  CONVERSATION_SEND: 'conversation_send',   // post into a conversation
  REGISTRY_WRITE: 'registry_write',         // skill-pack/mcp-template/agent-profile install·CRUD
  // internal REST plane — read
  PROJECT_READ: 'project_read',
  WORKSPACE_CONTENT_READ: 'workspace_content_read',
  FS_BROWSE: 'fs_browse',                   // /fs browse API (read)
  // allowlist — the one thing a folder-less specialist MAY do (O9):
  // internal registry / profile METADATA search only (GET; never install/fetch).
  REGISTRY_METADATA_SEARCH: 'registry_metadata_search',
});

// Private (not exported) so the vocabulary can't be mutated by a caller.
const CAP_SET = new Set(Object.values(CAPABILITIES));

/**
 * Legacy passthrough grant — every capability allowed, no enforcement. Today's
 * coder PM and workers use this so existing behavior is unchanged. Branded +
 * frozen so it can't be forged.
 */
function createLegacyGrant() {
  const grant = Object.freeze({ legacy: true, caps: Object.freeze([]) });
  ISSUED_GRANTS.add(grant);
  return grant;
}

/**
 * Explicit deny-by-default grant for a specialist. Only `capabilities` are
 * allowed. Each must be a known capability (typo guard — fail-closed). Returns
 * a branded, frozen object with a frozen cap list (no post-hoc escalation).
 * @param {Iterable<string>} capabilities
 */
function createGrant(capabilities = []) {
  const caps = [];
  for (const cap of capabilities) {
    if (!CAP_SET.has(cap)) {
      throw new Error(`createGrant: unknown capability "${cap}"`);
    }
    if (!caps.includes(cap)) caps.push(cap);
  }
  const grant = Object.freeze({ legacy: false, caps: Object.freeze(caps) });
  ISSUED_GRANTS.add(grant);
  return grant;
}

/**
 * Assert that `grant` permits `capability`.
 * - unknown `capability` → throw (typo guard).
 * - non-branded / malformed grant → throw (forgery + fail-open guard).
 * - legacy grant → allow (passthrough).
 * - explicit grant → allow only if listed; else throw (code `CAPABILITY_DENIED`).
 * @param {object} grant  a grant from createLegacyGrant()/createGrant()
 * @param {string} capability
 * @returns {void}
 */
function assertCapability(grant, capability) {
  if (!CAP_SET.has(capability)) {
    throw new Error(`assertCapability: unknown capability "${capability}"`);
  }
  if (!grant || typeof grant !== 'object' || !ISSUED_GRANTS.has(grant)) {
    throw new Error('assertCapability: invalid or forged grant (use createGrant/createLegacyGrant)');
  }
  if (grant.legacy === true) return; // passthrough
  if (Array.isArray(grant.caps) && grant.caps.includes(capability)) return;
  const e = new Error(`capability denied: "${capability}"`);
  e.code = 'CAPABILITY_DENIED';
  throw e;
}

// isCapability lets callers validate a string without exposing the mutable set.
function isCapability(value) {
  return CAP_SET.has(value);
}

module.exports = { CAPABILITIES, createLegacyGrant, createGrant, assertCapability, isCapability };
