// MCP server template CRUD service (M3). Opens up `mcp_server_templates`
// for UI-driven registration in the local-single-operator threat model the
// rest of Palantir Console assumes (single PALANTIR_TOKEN, default
// 127.0.0.1 binding, .claude-auth.json plaintext). Before M3 the table was
// code-seed-only (skillPackService.DEFAULT_MCP_TEMPLATES at boot); this
// service adds POST/PATCH/DELETE while preserving the invariants that the
// spawn paths (codexMcpFlatten, legacy scan) and the two consumers
// (worker_presets.mcp_server_ids by id, skill_packs.mcp_servers by alias)
// depend on:
//
//   - alias is IMMUTABLE post-creation. Skill packs reference by alias;
//     renaming one would silently orphan their env_overrides bindings.
//   - command / args / allowed_env_keys are mutable. These are the
//     fields operators actually want to tune at runtime.
//   - DELETE is blocked while any preset or skill pack references the
//     template. Callers must remove references first (409 + refs details).
//   - allowed_env_keys goes through the shared ENV_HARD_DENYLIST so
//     `_KEY$`, `NODE_OPTIONS`, `PATH`, etc. are rejected even from a
//     trusted operator — the denylist is about runtime capability of
//     the spawned MCP process, not about whose hand typed the value.
//   - Alias regex `^[A-Za-z0-9_-]+$` matches codexMcpFlatten's validator
//     and legacy scan's TABLE_HEADER_RE / DOTTED_KEY_RE so a UI-created
//     alias cannot become un-flattenable at spawn time.
//   - updated_at is bumped on every successful PATCH. RunInspector
//     compares template.updated_at against run_preset_snapshots.applied_at
//     to surface "template modified after run started" badges — that is
//     the drift observability that spec §2.2 called for before the v1
//     CRUD freeze.

const crypto = require('node:crypto');
const { BadRequestError, NotFoundError, ConflictError } = require('../utils/errors');
const { isEnvKeyDenied } = require('./envDenylist');

// Same alias regex codexMcpFlatten enforces. Keeping it here too means a
// UI-created template cannot reach spawn time with a flatten-unsafe alias.
const ALIAS_RE = /^[A-Za-z0-9_-]+$/;
const MAX_ARGS_JSON_BYTES = 4 * 1024; // spec §6.3 — match the storage-doc cap

function validateAlias(alias) {
  if (typeof alias !== 'string' || !alias) {
    throw new BadRequestError('alias is required');
  }
  if (!ALIAS_RE.test(alias)) {
    throw new BadRequestError(`alias must match ${ALIAS_RE} (letters, digits, _ or -)`);
  }
  return alias;
}

function validateCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new BadRequestError('command is required');
  }
  // Reject surrounding whitespace rather than silently trimming so a pasted
  // "  bash " does not become an inscrutable shell-resolution failure later
  // inside lifecycleService / codexMcpFlatten. Operators will notice the
  // 400 and clean up the string; a quietly trimmed value would ship.
  if (command !== command.trim()) {
    throw new BadRequestError('command must not have leading or trailing whitespace');
  }
  return command;
}

function validateArgs(args) {
  if (args == null || args === '') return null;
  let arr = args;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      throw new BadRequestError('args must be valid JSON array');
    }
  }
  if (!Array.isArray(arr)) throw new BadRequestError('args must be an array of strings');
  for (const a of arr) {
    if (typeof a !== 'string') throw new BadRequestError('args entries must be strings');
  }
  const json = JSON.stringify(arr);
  if (Buffer.byteLength(json, 'utf8') > MAX_ARGS_JSON_BYTES) {
    throw new BadRequestError(`args JSON exceeds ${MAX_ARGS_JSON_BYTES} byte limit`);
  }
  return json;
}

function validateAllowedEnvKeys(keys) {
  if (keys == null || keys === '') return null;
  let arr = keys;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      throw new BadRequestError('allowed_env_keys must be valid JSON array');
    }
  }
  if (!Array.isArray(arr)) throw new BadRequestError('allowed_env_keys must be an array');
  for (const k of arr) {
    if (typeof k !== 'string' || !k) {
      throw new BadRequestError('allowed_env_keys entries must be non-empty strings');
    }
    if (isEnvKeyDenied(k)) {
      throw new BadRequestError(
        `allowed_env_keys contains a globally-denied key: '${k}' (see envDenylist.js)`,
      );
    }
  }
  return JSON.stringify(arr);
}

function normalizeDescription(desc) {
  if (desc == null) return null;
  if (typeof desc !== 'string') throw new BadRequestError('description must be a string');
  return desc;
}

function createMcpTemplateService(db) {
  const stmts = {
    listAll: db.prepare('SELECT * FROM mcp_server_templates ORDER BY alias ASC'),
    getById: db.prepare('SELECT * FROM mcp_server_templates WHERE id = ?'),
    getByAlias: db.prepare('SELECT * FROM mcp_server_templates WHERE alias = ?'),
    insert: db.prepare(`
      INSERT INTO mcp_server_templates (
        id, alias, command, args, allowed_env_keys, description, updated_at
      ) VALUES (
        @id, @alias, @command, @args, @allowed_env_keys, @description, datetime('now')
      )
    `),
    // `updated_at` is only bumped when the content actually changed. A
    // no-op PATCH (edit modal opened, Save hit with unchanged values) must
    // NOT trigger `mcp_template_drift` in RunInspector — matches the
    // seed-upsert CASE WHEN policy in skillPackService. Codex final review
    // flagged the naive always-bump as oversensitive.
    updateContent: db.prepare(`
      UPDATE mcp_server_templates SET
        command = @command,
        args = @args,
        allowed_env_keys = @allowed_env_keys,
        description = @description,
        updated_at = CASE
          WHEN command != @command
            OR COALESCE(args, '') != COALESCE(@args, '')
            OR COALESCE(allowed_env_keys, '') != COALESCE(@allowed_env_keys, '')
            OR COALESCE(description, '') != COALESCE(@description, '')
          THEN datetime('now')
          ELSE updated_at
        END
      WHERE id = @id
    `),
    delete: db.prepare('DELETE FROM mcp_server_templates WHERE id = ?'),
    // Reference queries use the json1 extension (shipped with better-sqlite3).
    // Preset references are by id; skill pack references are by alias.
    refPresets: db.prepare(`
      SELECT id, name
      FROM worker_presets
      WHERE EXISTS (
        SELECT 1 FROM json_each(worker_presets.mcp_server_ids) WHERE value = ?
      )
    `),
    refSkillPacks: db.prepare(`
      SELECT id, name
      FROM skill_packs
      WHERE mcp_servers IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM json_each(skill_packs.mcp_servers) WHERE key = ?
        )
    `),
  };

  function findReferences(id, alias) {
    const presets = stmts.refPresets.all(id);
    const skillPacks = stmts.refSkillPacks.all(alias);
    return { presets, skillPacks };
  }

  function listTemplates() {
    return stmts.listAll.all();
  }

  function getTemplate(id) {
    const row = stmts.getById.get(id);
    if (!row) throw new NotFoundError(`MCP template not found: ${id}`);
    return row;
  }

  function createTemplate(data) {
    const alias = validateAlias(data.alias);
    const command = validateCommand(data.command);
    const args = validateArgs(data.args);
    const allowed_env_keys = validateAllowedEnvKeys(data.allowed_env_keys);
    const description = normalizeDescription(data.description);

    const dup = stmts.getByAlias.get(alias);
    if (dup) throw new ConflictError(`alias already exists: ${alias}`);

    const id = `tpl_${crypto.randomUUID().slice(0, 12)}`;
    try {
      stmts.insert.run({ id, alias, command, args, allowed_env_keys, description });
    } catch (err) {
      // Race between getByAlias and insert; surface as 409 regardless.
      if (String(err.message).includes('UNIQUE')) {
        throw new ConflictError(`alias already exists: ${alias}`);
      }
      throw err;
    }
    return stmts.getById.get(id);
  }

  function updateTemplate(id, data) {
    const existing = stmts.getById.get(id);
    if (!existing) throw new NotFoundError(`MCP template not found: ${id}`);

    // Alias is immutable — reject explicit rename attempts. Silently
    // accepting a "no-op same-alias" PATCH is fine (UIs tend to echo the
    // current value back); rejecting a different value is what blocks the
    // skill-pack reference break described in the file header.
    if ('alias' in data && data.alias !== existing.alias) {
      throw new BadRequestError(
        'alias is immutable (skill packs reference templates by alias — rename would orphan bindings)',
      );
    }

    const command = 'command' in data ? validateCommand(data.command) : existing.command;
    const args = 'args' in data ? validateArgs(data.args) : existing.args;
    const allowed_env_keys = 'allowed_env_keys' in data
      ? validateAllowedEnvKeys(data.allowed_env_keys)
      : existing.allowed_env_keys;
    const description = 'description' in data
      ? normalizeDescription(data.description)
      : existing.description;

    stmts.updateContent.run({ id, command, args, allowed_env_keys, description });
    return stmts.getById.get(id);
  }

  function deleteTemplate(id) {
    const existing = stmts.getById.get(id);
    if (!existing) throw new NotFoundError(`MCP template not found: ${id}`);
    const refs = findReferences(id, existing.alias);
    if (refs.presets.length > 0 || refs.skillPacks.length > 0) {
      const err = new ConflictError(
        `Template in use: ${refs.presets.length} preset(s), ${refs.skillPacks.length} skill pack(s). Remove references first.`,
      );
      err.details = refs;
      throw err;
    }
    stmts.delete.run(id);
    return { status: 'ok' };
  }

  return {
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    findReferences,
  };
}

module.exports = { createMcpTemplateService };
