'use strict';

/**
 * operatorProfileService — CRUD for the Operator Profile entity (PF-1).
 *
 * A Profile is a stored bundle { name, persona, capabilities } that the
 * specialist feature resolves by id (PF-3), instead of raw per-request params.
 * NEW table `operator_profiles` (migration 043); does NOT touch agent_profiles.
 *
 * Validation is enforced HERE (mirrors presetService): names unique, lengths
 * capped, and every capability validated against the capability vocabulary
 * (isCapability) so an unknown cap fails as a clean 400 rather than surfacing
 * later inside createGrant. capabilities is stored as a JSON array string.
 */

const crypto = require('crypto');
const { isCapability } = require('../utils/capability');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');

const NAME_MAX = 128;
const DESC_MAX = 500;
const PERSONA_MAX = 2000;
const CAPS_MAX = 32; // sanity cap on the number of capabilities in a profile

function safeParseArray(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    persona: row.persona ?? null,
    // Codex R2 MINOR: filter to valid capability strings at read time — a direct
    // DB write could store non-string/unknown entries (the SQL CHECK only enforces
    // array shape); PF-3 must never resolve a bogus cap.
    capabilities: safeParseArray(row.capabilities_json).filter((c) => typeof c === 'string' && isCapability(c)),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Validate + normalize input into a DB-ready row shape. For updates
 * (partial=true) only provided keys are validated; the caller merges first.
 * Returns { name, description, persona, capabilities_json }.
 */
function normalizeInputs(data, { partial = false } = {}) {
  // Codex R2 MINOR: reject a non-object body up front, else a PATCH with a
  // scalar/array body silently no-ops (200) and createProfile(null) TypeErrors.
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BadRequestError('request body must be an object');
  }
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(data, k);

  if (!partial || has('name')) {
    const name = data.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new BadRequestError('name is required (non-empty string)');
    }
    if (name.length > NAME_MAX) throw new BadRequestError(`name too long (max ${NAME_MAX})`);
    out.name = name.trim();
  }

  if (!partial || has('description')) {
    const d = data.description;
    if (d != null && typeof d !== 'string') throw new BadRequestError('description must be a string');
    if (typeof d === 'string' && d.length > DESC_MAX) throw new BadRequestError(`description too long (max ${DESC_MAX})`);
    out.description = (d == null || d === '') ? null : d;
  }

  if (!partial || has('persona')) {
    const p = data.persona;
    if (p != null && typeof p !== 'string') throw new BadRequestError('persona must be a string');
    if (typeof p === 'string' && p.length > PERSONA_MAX) throw new BadRequestError(`persona too long (max ${PERSONA_MAX})`);
    out.persona = (p == null || p === '') ? null : p;
  }

  if (!partial || has('capabilities')) {
    const caps = data.capabilities;
    if (caps != null && !Array.isArray(caps)) throw new BadRequestError('capabilities must be an array');
    const list = Array.isArray(caps) ? caps : [];
    if (list.length > CAPS_MAX) throw new BadRequestError(`too many capabilities (max ${CAPS_MAX})`);
    const seen = [];
    for (const c of list) {
      if (typeof c !== 'string') throw new BadRequestError('capabilities must be strings');
      if (!isCapability(c)) throw new BadRequestError(`unknown capability: ${c}`);
      if (!seen.includes(c)) seen.push(c); // dedup, preserve order
    }
    out.capabilities_json = JSON.stringify(seen);
  }

  return out;
}

function createOperatorProfileService(db) {
  const stmts = {
    getById: db.prepare('SELECT * FROM operator_profiles WHERE id = ?'),
    getByName: db.prepare('SELECT * FROM operator_profiles WHERE name = ?'),
    listAll: db.prepare('SELECT * FROM operator_profiles ORDER BY name ASC'),
    insert: db.prepare(
      'INSERT INTO operator_profiles (id, name, description, persona, capabilities_json) VALUES (@id, @name, @description, @persona, @capabilities_json)'
    ),
    update: db.prepare(
      'UPDATE operator_profiles SET name=@name, description=@description, persona=@persona, capabilities_json=@capabilities_json WHERE id=@id'
    ),
    delete: db.prepare('DELETE FROM operator_profiles WHERE id = ?'),
  };

  function createProfile(data = {}) {
    const norm = normalizeInputs(data, { partial: false });
    const id = `op_${crypto.randomUUID().slice(0, 12)}`;
    const row = {
      id,
      name: norm.name,
      description: norm.description ?? null,
      persona: norm.persona ?? null,
      capabilities_json: norm.capabilities_json ?? '[]',
    };
    try {
      stmts.insert.run(row);
    } catch (err) {
      if (String(err && err.message).includes('UNIQUE')) {
        throw new ConflictError(`operator profile name already exists: ${norm.name}`);
      }
      throw err;
    }
    return rowToProfile(stmts.getById.get(id));
  }

  function getProfile(id) {
    const row = stmts.getById.get(id);
    if (!row) throw new NotFoundError(`operator profile not found: ${id}`);
    return rowToProfile(row);
  }

  function listProfiles() {
    return stmts.listAll.all().map(rowToProfile);
  }

  function updateProfile(id, data = {}) {
    const existing = stmts.getById.get(id);
    if (!existing) throw new NotFoundError(`operator profile not found: ${id}`);
    const norm = normalizeInputs(data, { partial: true });
    // Merge normalized changes over the existing row.
    const merged = {
      id,
      name: norm.name ?? existing.name,
      description: 'description' in norm ? norm.description : existing.description,
      persona: 'persona' in norm ? norm.persona : existing.persona,
      capabilities_json: norm.capabilities_json ?? existing.capabilities_json,
    };
    if (merged.name !== existing.name) {
      const clash = stmts.getByName.get(merged.name);
      if (clash && clash.id !== id) throw new ConflictError(`operator profile name already exists: ${merged.name}`);
    }
    try {
      stmts.update.run(merged);
    } catch (err) {
      if (String(err && err.message).includes('UNIQUE')) {
        throw new ConflictError(`operator profile name already exists: ${merged.name}`);
      }
      throw err;
    }
    return rowToProfile(stmts.getById.get(id));
  }

  function deleteProfile(id) {
    const existing = stmts.getById.get(id);
    if (!existing) throw new NotFoundError(`operator profile not found: ${id}`);
    stmts.delete.run(id);
    return rowToProfile(existing);
  }

  return { createProfile, getProfile, listProfiles, updateProfile, deleteProfile };
}

module.exports = { createOperatorProfileService, normalizeInputs, rowToProfile };
