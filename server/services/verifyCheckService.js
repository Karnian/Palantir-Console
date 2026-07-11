'use strict';

// G2 — verify_checks (Gate 1) service. Named, reusable checks a goal task can be
// assigned; the harvest pipeline runs them and aggregates into runs.acceptance_json.
//
// Two kinds (discriminated union, spec §5a/§5k-3):
//   command  — { command, timeout_ms }; runs a shell in a code-mode workspace.
//              project-scoped + human-authored only (§6 — execution surface).
//   artifact — declarative { files, report }; the server evaluates it as a pure
//              function (no shell). Operator-authorable (no execution surface).
//
// SECURITY (Codex G2 review SERIOUS-5): `created_by` is NEVER taken from request
// data — it is derived from the authenticated actor ('human' cookie | 'operator'
// bearer) passed by the route. Provenance is the gate-eligibility signal (§5k-3):
// only a human-authored check gates a verdict; an operator-authored check is
// advisory. Editing the spec_json downgrades a human check to operator provenance
// when the editor is an Operator, so a compromised Operator cannot launder a
// human check into an always-PASS gate.

const { BadRequestError, NotFoundError, ConflictError } = require('../utils/errors');

const VALID_KINDS = new Set(['command', 'artifact']);
const VALID_ACTORS = new Set(['human', 'operator']);
const VALID_FORMATS = new Set(['markdown', 'json', 'text']);

const MAX_NAME_LEN = 120;
const MAX_COMMAND_LEN = 4000;
const MAX_FILES = 40;
const MAX_MUST_CONTAIN = 40;

function requireNonEmptyString(value, field, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`${field} is required`);
  }
  const v = value.trim();
  if (max && v.length > max) throw new BadRequestError(`${field} exceeds ${max} chars`);
  return v;
}

function normalizeActor(actor) {
  if (!VALID_ACTORS.has(actor)) {
    throw new BadRequestError('actor must be human or operator');
  }
  return actor;
}

// Validate + canonicalize a check spec by kind. Returns the normalized object.
// Fail-closed: any unknown/invalid shape throws (an Operator cannot smuggle an
// executable field into an artifact check, and command specs are shell-only).
function validateSpec(kind, spec) {
  const s = (spec && typeof spec === 'object' && !Array.isArray(spec)) ? spec : null;
  if (!s) throw new BadRequestError('spec must be an object');

  if (kind === 'command') {
    const command = requireNonEmptyString(s.command, 'spec.command', MAX_COMMAND_LEN);
    let timeout_ms = null;
    if (s.timeout_ms !== undefined && s.timeout_ms !== null) {
      const t = Number(s.timeout_ms);
      if (!Number.isFinite(t) || t <= 0 || t > 30 * 60 * 1000) {
        throw new BadRequestError('spec.timeout_ms must be 1..1800000');
      }
      timeout_ms = Math.floor(t);
    }
    return { command, timeout_ms };
  }

  // artifact — declarative, NO execution surface.
  const files = [];
  if (s.files !== undefined) {
    if (!Array.isArray(s.files)) throw new BadRequestError('spec.files must be an array');
    if (s.files.length > MAX_FILES) throw new BadRequestError(`spec.files exceeds ${MAX_FILES}`);
    for (const f of s.files) {
      if (!f || typeof f !== 'object') throw new BadRequestError('each spec.files entry must be an object');
      const glob = requireNonEmptyString(f.glob, 'files[].glob', 500);
      if (glob.includes('..')) throw new BadRequestError('files[].glob must not contain ".."');
      const entry = { glob };
      if (f.must_exist !== undefined) entry.must_exist = !!f.must_exist;
      if (f.min_bytes !== undefined) {
        const mb = Number(f.min_bytes);
        if (!Number.isFinite(mb) || mb < 0) throw new BadRequestError('files[].min_bytes must be >= 0');
        entry.min_bytes = Math.floor(mb);
      }
      files.push(entry);
    }
  }
  let report = null;
  if (s.report !== undefined && s.report !== null) {
    if (typeof s.report !== 'object' || Array.isArray(s.report)) throw new BadRequestError('spec.report must be an object');
    report = {};
    if (s.report.min_chars !== undefined) {
      const mc = Number(s.report.min_chars);
      if (!Number.isFinite(mc) || mc < 0) throw new BadRequestError('report.min_chars must be >= 0');
      report.min_chars = Math.floor(mc);
    }
    if (s.report.must_contain !== undefined) {
      if (!Array.isArray(s.report.must_contain)) throw new BadRequestError('report.must_contain must be an array');
      if (s.report.must_contain.length > MAX_MUST_CONTAIN) throw new BadRequestError(`report.must_contain exceeds ${MAX_MUST_CONTAIN}`);
      report.must_contain = s.report.must_contain.map((x) => requireNonEmptyString(x, 'must_contain[]', 500));
    }
    if (s.report.format !== undefined && s.report.format !== null) {
      if (!VALID_FORMATS.has(s.report.format)) throw new BadRequestError('report.format must be markdown|json|text');
      report.format = s.report.format;
    }
    if (s.report.path !== undefined && s.report.path !== null) {
      const p = requireNonEmptyString(s.report.path, 'report.path', 300);
      if (p.includes('..') || p.startsWith('/')) throw new BadRequestError('report.path must be a relative in-workspace path');
      report.path = p;
    }
  }
  if (files.length === 0 && !report) {
    throw new BadRequestError('artifact spec must declare at least one of files/report');
  }
  return { files, report };
}

// Stable canonical string of a normalized spec so we can detect real changes
// (a rename must not look like a spec edit). validateSpec already builds keys in
// a fixed order, so a plain stringify is deterministic — do NOT use a replacer
// array (it drops nested keys and would make every edit look like a no-op).
function canonicalSpec(normalized) {
  return JSON.stringify(normalized);
}

function createVerifyCheckService(db) {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO verify_checks (kind, project_id, name, spec_json, created_by, is_default)
      VALUES (@kind, @project_id, @name, @spec_json, @created_by, @is_default)
    `),
    getById: db.prepare('SELECT * FROM verify_checks WHERE id = ?'),
    listAll: db.prepare('SELECT * FROM verify_checks ORDER BY coalesce(project_id, \'\') ASC, name ASC'),
    listForProject: db.prepare(`
      SELECT * FROM verify_checks
      WHERE project_id = ? OR project_id IS NULL
      ORDER BY name ASC
    `),
    updateRow: db.prepare(`
      UPDATE verify_checks
         SET name = @name, spec_json = @spec_json, created_by = @created_by,
             is_default = @is_default, updated_at = datetime('now')
       WHERE id = @id
    `),
    delete: db.prepare('DELETE FROM verify_checks WHERE id = ?'),
    getProject: db.prepare('SELECT id FROM projects WHERE id = ?'),
    clearDefault: db.prepare(`
      UPDATE verify_checks SET is_default = 0, updated_at = datetime('now')
       WHERE coalesce(project_id, '') = ? AND is_default = 1 AND id != ?
    `),
  };

  function assertCheck(id) {
    const row = stmts.getById.get(id);
    if (!row) throw new NotFoundError(`verify_check not found: ${id}`);
    return row;
  }

  function uniqueConflict(err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new ConflictError('a verify_check with that name already exists in this project scope');
    }
    if (err && err.code === 'SQLITE_CONSTRAINT_TRIGGER') {
      // e.g. the command→project_id column-shape trigger.
      throw new BadRequestError(err.message.replace(/^.*:\s*/, ''));
    }
    throw err;
  }

  function createCheck(input = {}, { actor } = {}) {
    const a = normalizeActor(actor);
    const kind = input.kind;
    if (!VALID_KINDS.has(kind)) throw new BadRequestError('kind must be command or artifact');
    const name = requireNonEmptyString(input.name, 'name', MAX_NAME_LEN);
    const projectId = input.project_id ? requireNonEmptyString(input.project_id, 'project_id') : null;
    if (kind === 'command' && !projectId) throw new BadRequestError('command check requires project_id');
    if (projectId && !stmts.getProject.get(projectId)) throw new NotFoundError(`project not found: ${projectId}`);
    const normalized = validateSpec(kind, input.spec_json ?? input.spec);
    const is_default = input.is_default ? 1 : 0;

    const tx = db.transaction(() => {
      let info;
      try {
        info = stmts.insert.run({
          kind,
          project_id: projectId,
          name,
          spec_json: JSON.stringify(normalized),
          created_by: a, // server-derived — never from request body
          is_default,
        });
      } catch (err) { uniqueConflict(err); }
      if (is_default) stmts.clearDefault.run(projectId || '', info.lastInsertRowid);
      return stmts.getById.get(info.lastInsertRowid);
    });
    return tx();
  }

  function updateCheck(id, input = {}, { actor } = {}) {
    const a = normalizeActor(actor);
    const existing = assertCheck(id);
    // kind + project_id are immutable (execution boundary + name-scope stability).
    const name = input.name !== undefined ? requireNonEmptyString(input.name, 'name', MAX_NAME_LEN) : existing.name;
    const normalized = validateSpec(existing.kind, input.spec_json ?? input.spec ?? JSON.parse(existing.spec_json));
    // Re-validate the stored spec too so both sides are compared in canonical form.
    const existingNormalized = validateSpec(existing.kind, JSON.parse(existing.spec_json));
    const specChanged = canonicalSpec(normalized) !== canonicalSpec(existingNormalized);

    // Provenance (Codex SERIOUS-5): a human edit vouches for the current spec
    // (→ human). An Operator edit that CHANGES the spec downgrades to operator
    // (a human check can't be laundered). An Operator rename (no spec change)
    // preserves the existing provenance.
    let created_by;
    if (a === 'human') created_by = 'human';
    else created_by = specChanged ? 'operator' : existing.created_by;

    const is_default = input.is_default !== undefined ? (input.is_default ? 1 : 0) : existing.is_default;

    const tx = db.transaction(() => {
      try {
        stmts.updateRow.run({ id, name, spec_json: JSON.stringify(normalized), created_by, is_default });
      } catch (err) { uniqueConflict(err); }
      if (is_default) stmts.clearDefault.run(existing.project_id || '', id);
      return stmts.getById.get(id);
    });
    return tx();
  }

  function deleteCheck(id) {
    assertCheck(id);
    stmts.delete.run(id);
    return { status: 'ok' };
  }

  function getCheck(id) { return assertCheck(id); }
  function listChecks() { return stmts.listAll.all(); }
  function listForProject(projectId) {
    if (!projectId) return stmts.listAll.all().filter((r) => r.project_id == null);
    return stmts.listForProject.all(projectId);
  }

  return {
    validateSpec,
    createCheck,
    updateCheck,
    deleteCheck,
    getCheck,
    listChecks,
    listForProject,
  };
}

module.exports = { createVerifyCheckService, validateSpec };
