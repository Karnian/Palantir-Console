/**
 * ownerKey.js — single normalization point for (owner_type, owner_id) pairs.
 *
 * P-A1 slice 1: owner-keying foundation. This module is the O12 single
 * normalization point. NEVER returns a NULL owner — unknown/missing input
 * throws (fail-closed).
 *
 * Mapping:
 *   L1 { project_id } (truthy string) -> { owner_type: 'workspace', owner_id: project_id }
 *   L2 { scope: 'user' }              -> { owner_type: 'user',      owner_id: 'user' }
 *   L2 { scope: 'cross_project' }     -> { owner_type: 'user',      owner_id: 'user' }
 *       (cross_project collapses to user — NOT a separate owner key)
 *   unknown shape / missing / empty   -> THROW
 *
 * Key contract: exactly one key required; both present → throw (fail-closed).
 * Callers must pass exactly project_id (L1) OR scope (L2), never both.
 * memoryService uses { project_id }, masterMemoryService uses { scope }.
 *
 * Pure (no db, no side effects). Safe to import anywhere.
 */

'use strict';

const VALID_L2_SCOPES = new Set(['user', 'cross_project']);

/**
 * Normalize an owner input to { owner_type, owner_id }.
 *
 * @param {{ project_id?: string } | { scope?: string }} input
 * @returns {{ owner_type: string, owner_id: string }}
 * @throws {Error} if input cannot be normalized (fail-closed)
 */
function normalizeOwner(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('normalizeOwner: input must be a non-null object');
  }

  // Reject ambiguous input — exactly one key required.
  if ('project_id' in input && 'scope' in input) {
    throw new Error('normalizeOwner: input must have exactly one of project_id (L1) or scope (L2), not both');
  }

  // L1: project_id present
  if ('project_id' in input) {
    const pid = input.project_id;
    if (typeof pid !== 'string' || pid.trim() === '') {
      throw new Error('normalizeOwner: project_id must be a non-empty string');
    }
    return { owner_type: 'workspace', owner_id: pid };
  }

  // L2: scope-keyed
  if ('scope' in input) {
    const scope = input.scope;
    if (!VALID_L2_SCOPES.has(scope)) {
      throw new Error(
        `normalizeOwner: scope must be one of ${Array.from(VALID_L2_SCOPES).join('|')}, got: ${scope}`
      );
    }
    // cross_project collapses to 'user' — it is NOT a separate owner.
    return { owner_type: 'user', owner_id: 'user' };
  }

  throw new Error(
    'normalizeOwner: input must have either project_id (L1) or scope (L2)'
  );
}

module.exports = { normalizeOwner };
