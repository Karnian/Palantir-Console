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
const { assertSafeUrl } = require('./ssrf');

// M4-a: bearer_token_env_var has a NARROWER denylist than allowed_env_keys.
// The shared `isEnvKeyDenied` rejects credential-suffix names (`_TOKEN$`,
// `_KEY$`) because skill packs put those into MCP `env={...}` and the
// values would leak via argv. For `bearer_token_env_var` the value never
// reaches argv (the worker reads `process.env[<name>]` directly at MCP
// connect), and `_TOKEN`/`_KEY` is exactly the natural way to name
// bearer-token env vars (e.g. `BIFROST_MCP_TOKEN`, `LINEAR_API_KEY`).
// Only the process-loader / path-hijack patterns still apply — those would
// hijack the worker process regardless of how the value is read.
const BEARER_ENV_HARD_DENYLIST_PATTERNS = [
  /^NODE_OPTIONS$/, /^NODE_EXTRA_CA_CERTS$/, /^LD_PRELOAD$/, /^LD_LIBRARY_PATH$/,
  /^DYLD_/, /^PYTHONPATH$/, /^RUBYOPT$/, /^PERL5OPT$/, /^JAVA_TOOL_OPTIONS$/,
  /^PATH$/, /^HOME$/, /^SHELL$/, /^GIT_CONFIG_GLOBAL$/, /^GIT_CONFIG_SYSTEM$/,
  /^XDG_CONFIG_HOME$/,
];

function isBearerEnvKeyDenied(key) {
  return BEARER_ENV_HARD_DENYLIST_PATTERNS.some((pattern) => pattern.test(key));
}

// Same alias regex codexMcpFlatten enforces. Keeping it here too means a
// UI-created template cannot reach spawn time with a flatten-unsafe alias.
const ALIAS_RE = /^[A-Za-z0-9_-]+$/;
const MAX_ARGS_JSON_BYTES = 4 * 1024; // spec §6.3 — match the storage-doc cap

// Same regex used for template alias / env keys + bearer_token_env_var name.
// Matches `^[A-Za-z_][A-Za-z0-9_]*$` (POSIX env var convention).
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const VALID_TRANSPORTS = new Set(['stdio', 'http']);

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

function normalizeTransport(t) {
  if (t == null || t === '') return 'stdio';
  if (typeof t !== 'string') throw new BadRequestError('transport must be a string');
  if (!VALID_TRANSPORTS.has(t)) {
    throw new BadRequestError(`transport must be 'stdio' or 'http' (got ${JSON.stringify(t)})`);
  }
  return t;
}

// http template URL is validated through the shared `assertSafeUrl` helper
// so that CRUD validation and spawn-time preflight cannot diverge. Returns
// the canonical URL string so DB stores a single normalized form.
async function validateUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new BadRequestError('url is required for http transport');
  }
  if (url !== url.trim()) {
    throw new BadRequestError('url must not have leading or trailing whitespace');
  }
  try {
    const result = await assertSafeUrl(url);
    return result.url;
  } catch (err) {
    // assertSafeUrl throws { status: 400, code, message } — wrap as
    // BadRequestError so the route → errorHandler chain emits a 400 with
    // the diagnostic message.
    throw new BadRequestError(err.message);
  }
}

function validateBearerTokenEnvVar(name) {
  if (name == null || name === '') return null;
  if (typeof name !== 'string') {
    throw new BadRequestError('bearer_token_env_var must be a string');
  }
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed !== name) {
    throw new BadRequestError('bearer_token_env_var must not have leading or trailing whitespace');
  }
  if (!ENV_VAR_NAME_RE.test(trimmed)) {
    throw new BadRequestError(
      `bearer_token_env_var must match ${ENV_VAR_NAME_RE} (POSIX env var name)`,
    );
  }
  if (isBearerEnvKeyDenied(trimmed)) {
    throw new BadRequestError(
      `bearer_token_env_var is globally-denied: '${trimmed}' (process-loader / path-hijack pattern rejected)`,
    );
  }
  return trimmed;
}

function createMcpTemplateService(db) {
  const stmts = {
    listAll: db.prepare('SELECT * FROM mcp_server_templates ORDER BY alias ASC'),
    getById: db.prepare('SELECT * FROM mcp_server_templates WHERE id = ?'),
    getByAlias: db.prepare('SELECT * FROM mcp_server_templates WHERE alias = ?'),
    insert: db.prepare(`
      INSERT INTO mcp_server_templates (
        id, alias, transport,
        command, args, allowed_env_keys,
        url, bearer_token_env_var,
        description, updated_at
      ) VALUES (
        @id, @alias, @transport,
        @command, @args, @allowed_env_keys,
        @url, @bearer_token_env_var,
        @description, datetime('now')
      )
    `),
    // `updated_at` is only bumped when the content actually changed. A
    // no-op PATCH (edit modal opened, Save hit with unchanged values) must
    // NOT trigger `mcp_template_drift` in RunInspector — matches the
    // seed-upsert CASE WHEN policy in skillPackService. Codex final review
    // flagged the naive always-bump as oversensitive.
    //
    // M4-a: url / bearer_token_env_var join the comparison so http template
    // edits also surface drift; transport/alias are immutable so they're
    // not in the SET list (DB triggers ABORT on mutation regardless).
    updateContent: db.prepare(`
      UPDATE mcp_server_templates SET
        command = @command,
        args = @args,
        allowed_env_keys = @allowed_env_keys,
        url = @url,
        bearer_token_env_var = @bearer_token_env_var,
        description = @description,
        updated_at = CASE
          WHEN COALESCE(command, '') != COALESCE(@command, '')
            OR COALESCE(args, '') != COALESCE(@args, '')
            OR COALESCE(allowed_env_keys, '') != COALESCE(@allowed_env_keys, '')
            OR COALESCE(url, '') != COALESCE(@url, '')
            OR COALESCE(bearer_token_env_var, '') != COALESCE(@bearer_token_env_var, '')
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

  // M4-a: createTemplate is async because http-transport URL validation
  // resolves DNS via assertSafeUrl. Routes (asyncHandler) and tests must
  // `await`. The seed-upsert path in skillPackService bypasses this via
  // direct SQL on stdio templates only, so it stays sync.
  async function createTemplate(data) {
    const alias = validateAlias(data.alias);
    const transport = normalizeTransport(data.transport);
    const description = normalizeDescription(data.description);

    let command = null;
    let args = null;
    let allowed_env_keys = null;
    let url = null;
    let bearer_token_env_var = null;

    if (transport === 'stdio') {
      command = validateCommand(data.command);
      args = validateArgs(data.args);
      allowed_env_keys = validateAllowedEnvKeys(data.allowed_env_keys);
      // http-only fields rejected outright so the validator + trigger agree
      // even when the operator forgets to clear them on a transport flip
      // attempt (which itself is rejected — alias+transport immutable).
      if (data.url != null && data.url !== '') {
        throw new BadRequestError('url is only valid for http transport');
      }
      if (data.bearer_token_env_var != null && data.bearer_token_env_var !== '') {
        throw new BadRequestError('bearer_token_env_var is only valid for http transport');
      }
    } else { // 'http'
      url = await validateUrl(data.url);
      bearer_token_env_var = validateBearerTokenEnvVar(data.bearer_token_env_var);
      if (data.command != null && data.command !== '') {
        throw new BadRequestError('command is only valid for stdio transport');
      }
      if (data.args != null && (Array.isArray(data.args) ? data.args.length > 0 : data.args !== '')) {
        throw new BadRequestError('args is only valid for stdio transport');
      }
      if (data.allowed_env_keys != null && (Array.isArray(data.allowed_env_keys)
        ? data.allowed_env_keys.length > 0 : data.allowed_env_keys !== '')) {
        throw new BadRequestError('allowed_env_keys is only valid for stdio transport');
      }
    }

    const dup = stmts.getByAlias.get(alias);
    if (dup) throw new ConflictError(`alias already exists: ${alias}`);

    const id = `tpl_${crypto.randomUUID().slice(0, 12)}`;
    try {
      stmts.insert.run({
        id, alias, transport,
        command, args, allowed_env_keys,
        url, bearer_token_env_var,
        description,
      });
    } catch (err) {
      // Race between getByAlias and insert; surface as 409 regardless.
      if (String(err.message).includes('UNIQUE')) {
        throw new ConflictError(`alias already exists: ${alias}`);
      }
      throw err;
    }
    return stmts.getById.get(id);
  }

  // M4-a: updateTemplate is async (validateUrl is async). Transport is
  // immutable; same-transport echo is accepted, different value rejected.
  // The DB trigger is the last line of defense.
  async function updateTemplate(id, data) {
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
    // Transport is also immutable — same lock applied for the M4-a
    // discriminated union. Operator must create a new alias to switch.
    if ('transport' in data && data.transport && data.transport !== existing.transport) {
      throw new BadRequestError(
        'transport is immutable — create a new template instead',
      );
    }

    const transport = existing.transport; // never changes post-create
    const description = 'description' in data
      ? normalizeDescription(data.description)
      : existing.description;

    let command = existing.command;
    let args = existing.args;
    let allowed_env_keys = existing.allowed_env_keys;
    let url = existing.url;
    let bearer_token_env_var = existing.bearer_token_env_var;

    if (transport === 'stdio') {
      if ('command' in data) command = validateCommand(data.command);
      if ('args' in data) args = validateArgs(data.args);
      if ('allowed_env_keys' in data) allowed_env_keys = validateAllowedEnvKeys(data.allowed_env_keys);
      if ('url' in data && data.url != null && data.url !== '') {
        throw new BadRequestError('url is only valid for http transport');
      }
      if ('bearer_token_env_var' in data && data.bearer_token_env_var != null && data.bearer_token_env_var !== '') {
        throw new BadRequestError('bearer_token_env_var is only valid for http transport');
      }
    } else { // 'http'
      if ('url' in data) url = await validateUrl(data.url);
      if ('bearer_token_env_var' in data) {
        bearer_token_env_var = validateBearerTokenEnvVar(data.bearer_token_env_var);
      }
      if ('command' in data && data.command != null && data.command !== '') {
        throw new BadRequestError('command is only valid for stdio transport');
      }
      if ('args' in data && data.args != null
        && (Array.isArray(data.args) ? data.args.length > 0 : data.args !== '')) {
        throw new BadRequestError('args is only valid for stdio transport');
      }
      if ('allowed_env_keys' in data && data.allowed_env_keys != null
        && (Array.isArray(data.allowed_env_keys) ? data.allowed_env_keys.length > 0 : data.allowed_env_keys !== '')) {
        throw new BadRequestError('allowed_env_keys is only valid for stdio transport');
      }
    }

    stmts.updateContent.run({
      id, command, args, allowed_env_keys, url, bearer_token_env_var, description,
    });
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
