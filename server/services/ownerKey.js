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
 *   { profile_id } (truthy string)    -> { owner_type: 'profile',   owner_id: profile_id }
 *       (Operator P-B folder-less specialist owner. Storage is RESERVED in P-B1
 *        — no read/write path is wired yet; P-B2 builds on this fixed mapping.)
 *   unknown shape / missing / empty   -> THROW
 *
 * Key contract: EXACTLY ONE of { project_id (L1), scope (L2), profile_id } is
 * required; two or more present → throw (fail-closed). memoryService uses
 * { project_id }, masterMemoryService uses { scope }; profile_id is P-B only.
 *
 * Pure (no db, no side effects). Safe to import anywhere.
 */

'use strict';

const VALID_L2_SCOPES = new Set(['user', 'cross_project']);
const OWNER_INPUT_KEYS = ['project_id', 'scope', 'profile_id'];

/**
 * Normalize an owner input to { owner_type, owner_id }.
 *
 * @param {{ project_id?: string } | { scope?: string } | { profile_id?: string }} input
 * @returns {{ owner_type: string, owner_id: string }}
 * @throws {Error} if input cannot be normalized (fail-closed)
 */
function normalizeOwner(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('normalizeOwner: input must be a non-null object');
  }

  // Reject ambiguous input — EXACTLY ONE of project_id / scope / profile_id.
  const present = OWNER_INPUT_KEYS.filter((k) => k in input);
  if (present.length > 1) {
    throw new Error(
      `normalizeOwner: exactly one of project_id (L1) / scope (L2) / profile_id required, not multiple (got: ${present.join(', ')})`
    );
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

  // Operator P-B: folder-less specialist (profile) owner. Storage reserved in
  // P-B1; no read/write path wired yet.
  if ('profile_id' in input) {
    const fid = input.profile_id;
    if (typeof fid !== 'string' || fid.trim() === '') {
      throw new Error('normalizeOwner: profile_id must be a non-empty string');
    }
    return { owner_type: 'profile', owner_id: fid };
  }

  throw new Error(
    'normalizeOwner: input must have one of project_id (L1) / scope (L2) / profile_id'
  );
}

module.exports = { normalizeOwner };
