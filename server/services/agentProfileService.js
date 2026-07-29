const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { resolveAgentVendor } = require('../utils/agentVendor');

// Accepting a mode here means the CLI recognises the spelling, not that this
// installation will honour it: `manual` needs a recent enough Claude Code, and
// `auto` depends on plan/model entitlement. Neither is checkable from the
// control plane, so an unsupported pick surfaces at spawn rather than at save.
// Narrowing the set to dodge that would instead reject values that DO work for
// operators who have them.
const CLAUDE_PERMISSION_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'manual',
  'plan',
]);

// Allowlist of safe agent commands — only these can be used as agent executables
const ALLOWED_COMMANDS = new Set([
  'claude', 'codex', 'gemini', // known agent CLIs
  '/opt/homebrew/bin/claude', '/opt/homebrew/bin/codex',
  '/opt/homebrew/bin/gemini',
  '/usr/local/bin/claude', '/usr/local/bin/codex',
  '/usr/local/bin/gemini',
]);

// Additional allowed commands can be set via PALANTIR_ALLOWED_COMMANDS env var (comma-separated)
if (process.env.PALANTIR_ALLOWED_COMMANDS) {
  process.env.PALANTIR_ALLOWED_COMMANDS.split(',').map(s => s.trim()).filter(Boolean).forEach(cmd => ALLOWED_COMMANDS.add(cmd));
}

function validateCommand(command) {
  if (!command || typeof command !== 'string') {
    throw new BadRequestError('Agent command is required');
  }
  const trimmed = command.trim();
  if (!ALLOWED_COMMANDS.has(trimmed)) {
    throw new BadRequestError(
      `Command '${trimmed}' is not in the allowlist. Allowed: ${[...ALLOWED_COMMANDS].filter(c => !c.startsWith('/')).join(', ')}. ` +
      'Set PALANTIR_ALLOWED_COMMANDS env var to add custom commands.'
    );
  }
  return trimmed;
}

function rejectRetiredAgentType(type) {
  if (type === 'opencode') {
    throw new BadRequestError('opencode is a retired agent type, no longer supported');
  }
}

function validateTypeCommandVendor(profile) {
  const expectedVendor = {
    'claude-code': 'claude',
    codex: 'codex',
  }[profile.type];
  if (!expectedVendor) return;
  const commandVendor = resolveAgentVendor(profile.command);
  if (commandVendor !== expectedVendor) {
    throw new BadRequestError(
      `agent type ${profile.type} requires a ${expectedVendor} command`,
    );
  }
}

// Codex P2 review: buildAgentArgs strips a token's surrounding double quotes at
// EXECUTION (`part.replace(/^"(.*)"$/, '$1')`), so a template token `"--model"`
// runs as the real `--model` flag. The conflict scanner must unquote each token
// the SAME way before matching, else `exec "--model" baked` evades the check and
// double-sets model at runtime.
function unquoteToken(token) {
  return String(token).replace(/^"(.*)"$/, '$1');
}

function normalizeConfigFragment(fragment) {
  let value = String(fragment || '').trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      value = value.slice(1, -1).trim();
    }
  }
  return value;
}

function getConfigFragments(tokens) {
  const fragments = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-c' || token === '--config') {
      if (i + 1 < tokens.length) fragments.push(tokens[i + 1]);
    } else if (token.startsWith('-c=')) {
      fragments.push(token.slice(3));
    } else if (token.startsWith('--config=')) {
      fragments.push(token.slice('--config='.length));
    }
  }
  return fragments.map(normalizeConfigFragment);
}

function tokenizeArgsTemplate(argsTemplate) {
  return (String(argsTemplate || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(unquoteToken);
}

function hasPermissionModeOption(tokens) {
  return tokens.some(token => /^--permission-mode($|=)/.test(token));
}

function stripClaudePermissionModeOption(argsTemplate) {
  const source = String(argsTemplate || '');
  const matches = Array.from(
    source.matchAll(/(?:[^\s"]+|"[^"]*")+/g),
    match => ({
      token: unquoteToken(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    }),
  );
  const removals = [];

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (match.token === '--permission-mode') {
      const value = matches[i + 1];
      removals.push({
        start: match.start,
        end: value && !value.token.startsWith('-') ? value.end : match.end,
      });
      if (value && !value.token.startsWith('-')) i += 1;
    } else if (match.token.startsWith('--permission-mode=')) {
      removals.push({ start: match.start, end: match.end });
    }
  }

  if (removals.length === 0) return source;
  let result = '';
  let cursor = 0;
  for (const removal of removals) {
    let { start, end } = removal;
    if (start > cursor && /\s/.test(source[start - 1])) {
      while (start > cursor && /\s/.test(source[start - 1])) start -= 1;
    } else {
      while (end < source.length && /\s/.test(source[end])) end += 1;
    }
    result += source.slice(cursor, start);
    cursor = end;
  }
  return (result + source.slice(cursor)).trim();
}

function readSingleClaudeTemplateOption(tokens, flag) {
  const values = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === flag) {
      const value = tokens[i + 1];
      if (!value || value.startsWith('-')) {
        throw new BadRequestError(`${flag} in args_template requires a value`);
      }
      values.push(value);
      i += 1;
    } else if (token.startsWith(`${flag}=`)) {
      const value = token.slice(flag.length + 1);
      if (!value) throw new BadRequestError(`${flag} in args_template requires a value`);
      values.push(value);
    }
  }
  if (values.length > 1) {
    throw new BadRequestError(`${flag} must appear at most once in args_template`);
  }
  return values[0] ?? null;
}

function readClaudeTemplateBooleanOption(tokens, flag) {
  let occurrences = 0;
  for (const token of tokens) {
    if (token === flag) {
      occurrences += 1;
    } else if (token.startsWith(`${flag}=`)) {
      throw new BadRequestError(`${flag} in args_template does not accept a value`);
    }
  }
  if (occurrences > 1) {
    throw new BadRequestError(`${flag} must appear at most once in args_template`);
  }
  return occurrences === 1;
}

function readClaudeTemplateListOption(tokens, flags, displayFlag) {
  const values = [];
  let occurrences = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const flag = flags.find(candidate => (
      token === candidate || token.startsWith(`${candidate}=`)
    ));
    if (!flag) continue;

    occurrences += 1;
    if (occurrences > 1) {
      throw new BadRequestError(
        `${displayFlag} must appear at most once in args_template`,
      );
    }

    if (token.startsWith(`${flag}=`)) {
      const value = token.slice(flag.length + 1);
      if (!value) {
        throw new BadRequestError(
          `${displayFlag} in args_template requires at least one value`,
        );
      }
      values.push(value);
      continue;
    }

    let valueCount = 0;
    while (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
      values.push(tokens[i + 1]);
      valueCount += 1;
      i += 1;
    }
    if (valueCount === 0) {
      throw new BadRequestError(
        `${displayFlag} in args_template requires at least one value`,
      );
    }
  }

  return values;
}

function parseClaudeArgsTemplate(argsTemplate) {
  const tokens = tokenizeArgsTemplate(argsTemplate);
  const permissionMode = readSingleClaudeTemplateOption(tokens, '--permission-mode');
  const rawMaxBudgetUsd = readSingleClaudeTemplateOption(tokens, '--max-budget-usd');
  const mcpConfig = readSingleClaudeTemplateOption(tokens, '--mcp-config');
  const strictMcpConfig = readClaudeTemplateBooleanOption(tokens, '--strict-mcp-config');
  const tools = readClaudeTemplateListOption(
    tokens,
    ['--tools'],
    '--tools',
  );
  const disallowedTools = readClaudeTemplateListOption(
    tokens,
    ['--disallowedTools', '--disallowed-tools'],
    '--disallowedTools',
  );

  if (permissionMode != null && !CLAUDE_PERMISSION_MODES.has(permissionMode)) {
    throw new BadRequestError(
      `--permission-mode in args_template must be one of: ${Array.from(CLAUDE_PERMISSION_MODES).join(', ')}`,
    );
  }

  let maxBudgetUsd = null;
  if (rawMaxBudgetUsd != null) {
    maxBudgetUsd = Number(rawMaxBudgetUsd);
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      throw new BadRequestError('--max-budget-usd in args_template must be a positive number');
    }
  }

  return {
    permissionMode,
    maxBudgetUsd,
    mcpConfig,
    strictMcpConfig,
    tools,
    disallowedTools,
  };
}

function resolveClaudePermissionMode(profile) {
  if (resolveAgentVendor(profile?.command) !== 'claude') return undefined;
  if (profile.permission_mode != null) return profile.permission_mode;

  // Permission resolution is a security boundary. Parse only its own option so
  // a malformed unrelated template value (for example max-budget) cannot make
  // a caller fall back to the more permissive default.
  const permissionMode = readSingleClaudeTemplateOption(
    tokenizeArgsTemplate(profile.args_template),
    '--permission-mode',
  );
  if (permissionMode != null && !CLAUDE_PERMISSION_MODES.has(permissionMode)) {
    throw new BadRequestError(
      `--permission-mode in args_template must be one of: ${Array.from(CLAUDE_PERMISSION_MODES).join(', ')}`,
    );
  }
  return permissionMode ?? 'bypassPermissions';
}

function validateStructuredModelEffort(mergedProfile) {
  const vendor = resolveAgentVendor(mergedProfile.command);
  const {
    model,
    reasoning_effort: reasoningEffort,
    permission_mode: permissionMode,
  } = mergedProfile;
  const argsTemplate = String(mergedProfile.args_template || '');
  // Unquote each token to mirror buildAgentArgs' execution-time quote stripping
  // (Codex P2 review) so a quoted flag like `"--model"` / `"-c"` cannot evade
  // the conflict scan and re-inject at runtime.
  const tokens = tokenizeArgsTemplate(argsTemplate);
  const configFragments = getConfigFragments(tokens);

  if (permissionMode != null) {
    if (vendor !== 'claude') {
      throw new BadRequestError('permission_mode only supported for claude workers');
    }
    if (typeof permissionMode !== 'string' || !CLAUDE_PERMISSION_MODES.has(permissionMode)) {
      throw new BadRequestError(
        `permission_mode must be one of: ${Array.from(CLAUDE_PERMISSION_MODES).join(', ')}`,
      );
    }
  }

  if (reasoningEffort != null) {
    if (vendor !== 'codex') {
      throw new BadRequestError('reasoning_effort only supported for codex workers');
    }
    if (!['low', 'medium', 'high'].includes(reasoningEffort)) {
      throw new BadRequestError('reasoning_effort must be one of: low, medium, high');
    }
  }

  if (model != null) {
    if (vendor !== 'codex' && vendor !== 'claude') {
      throw new BadRequestError('model only supported for codex/claude workers');
    }
    if (
      typeof model !== 'string'
      || model.trim().length === 0
      || model.length > 200
      || /[\u0000-\u001F\u007F-\u009F]/.test(model)
      || model.startsWith('-')
    ) {
      throw new BadRequestError('model must be a non-empty string of at most 200 characters, without control characters or a leading hyphen');
    }
  }

  const hasModelOption = tokens.some(token => /^-m($|[=]|[^-])/.test(token) || /^--model($|=)/.test(token));
  // Exact plain TOML keys are intentional. Exotic unicode-escaped keys are
  // best-effort and may evade detection, but do not create a security boundary.
  const hasModelConfig = configFragments.some(fragment => /^"?model"?\s*=/.test(fragment));
  const hasReasoningEffortConfig = configFragments.some(fragment => /^"?model_reasoning_effort"?\s*=/.test(fragment));

  if (model != null && (hasModelOption || hasModelConfig)) {
    throw new BadRequestError('structured model conflicts with a flag in args_template; use one');
  }
  if (reasoningEffort != null && hasReasoningEffortConfig) {
    throw new BadRequestError('structured reasoning_effort conflicts with a flag in args_template; use one');
  }
}

// `templateIsBeingSet` is what keeps this from stranding legacy rows. The scan
// has to run against the merged state to see the vendor, but rejecting on a
// template the caller did not touch would 400 every future PATCH of a profile
// that already carries the flag — including one that only renames it. Such rows
// exist by construction: putting --permission-mode in args_template is exactly
// the workaround #469 says users reach for. They would then be uneditable
// through the API or UI, fixable only by hand-editing the database.
//
// Migrating the flag into the column instead was rejected: the Claude spawn path
// ignores args_template entirely, so a stored `--permission-mode acceptEdits`
// has never had any effect. Lifting it into the structured field would start
// honouring it at upgrade time — a silent permission change on rows nobody
// touched. Leaving it inert and refusing it the moment the template is edited
// keeps every behaviour change explicit.
function validateAgentProfileForSave(mergedProfile, { templateIsBeingSet = true } = {}) {
  validateTypeCommandVendor(mergedProfile);
  validateStructuredModelEffort(mergedProfile);

  if (templateIsBeingSet && resolveAgentVendor(mergedProfile.command) === 'claude') {
    // Claude workers use the stream-json engine instead of executing the raw
    // template. Parse every template option that engine deliberately carries
    // forward so malformed values fail at save time instead of becoming a
    // silent runtime no-op.
    parseClaudeArgsTemplate(mergedProfile.args_template);
  }

  if (
    templateIsBeingSet
    && resolveAgentVendor(mergedProfile.command) === 'claude'
    && hasPermissionModeOption(tokenizeArgsTemplate(mergedProfile.args_template))
  ) {
    throw new BadRequestError(
      'args_template must not set --permission-mode; use the structured permission_mode field',
    );
  }
}

function createAgentProfileService(db) {
  const stmts = {
    getAll: db.prepare('SELECT * FROM agent_profiles ORDER BY name ASC'),
    getById: db.prepare('SELECT * FROM agent_profiles WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, icon, color, max_concurrent, model, reasoning_effort, permission_mode)
      VALUES (@id, @name, @type, @command, @args_template, @capabilities_json, @env_allowlist, @icon, @color, @max_concurrent, @model, @reasoning_effort, @permission_mode)
    `),
    // update: dynamic — see updateProfile() below
    delete: db.prepare('DELETE FROM agent_profiles WHERE id = ?'),
    countRunning: db.prepare(`
      SELECT COUNT(*) as count FROM runs
      WHERE agent_profile_id = ? AND status = 'running'
    `),
  };

  function listProfiles() {
    // A profile of a retired type (e.g. a migration-retained opencode row —
    // see 069_remove_opencode_agent_profile.sql's live-run guard) stays in
    // the table for FK/recovery purposes but must not be offered as a
    // pickable choice going forward.
    return stmts.getAll.all().filter((profile) => profile.type !== 'opencode');
  }

  function getProfile(id) {
    const profile = stmts.getById.get(id);
    if (!profile) throw new NotFoundError(`Agent profile not found: ${id}`);
    return profile;
  }

  function createProfile({ name, type, command, args_template, capabilities_json, env_allowlist, icon, color, max_concurrent, model, reasoning_effort, permission_mode }) {
    if (!name) throw new BadRequestError('Agent name is required');
    if (!type) throw new BadRequestError('Agent type is required');
    rejectRetiredAgentType(type);
    const validatedCommand = validateCommand(command);
    validateAgentProfileForSave({
      type,
      command: validatedCommand,
      args_template,
      model,
      reasoning_effort,
      permission_mode,
    });
    const id = `agent_${crypto.randomUUID().slice(0, 8)}`;
    stmts.insert.run({
      id, name, type, command: validatedCommand,
      args_template: args_template || null,
      capabilities_json: capabilities_json || '{}',
      env_allowlist: env_allowlist || '[]',
      icon: icon || null,
      color: color || null,
      max_concurrent: max_concurrent || 3,
      model: model || null,
      reasoning_effort: reasoning_effort || null,
      permission_mode: permission_mode || null,
    });
    return stmts.getById.get(id);
  }

  const AGENT_UPDATABLE = ['name', 'type', 'command', 'args_template', 'capabilities_json', 'env_allowlist', 'icon', 'color', 'max_concurrent', 'model', 'reasoning_effort', 'permission_mode'];

  function updateProfile(id, fields) {
    const existing = getProfile(id);
    const mergedProfile = { ...existing, ...fields };
    rejectRetiredAgentType(mergedProfile.type);
    if (fields.command) {
      fields.command = validateCommand(fields.command);
      mergedProfile.command = fields.command;
    }
    // NULL is the UI/API's explicit "run as bypassPermissions" selection.
    // A migrated legacy row can still carry the old raw flag beside its
    // structured value. Remove that compatibility copy on reset; otherwise
    // the resolver cannot distinguish this explicit NULL from a pre-migration
    // row and would immediately promote the stale raw value again at runtime.
    if (
      resolveAgentVendor(mergedProfile.command) === 'claude'
      && Object.prototype.hasOwnProperty.call(fields, 'permission_mode')
      && fields.permission_mode == null
    ) {
      const cleanedTemplate = stripClaudePermissionModeOption(
        mergedProfile.args_template,
      );
      if (cleanedTemplate !== mergedProfile.args_template) {
        fields.args_template = cleanedTemplate || null;
        mergedProfile.args_template = fields.args_template;
      }
    }
    // Migration 076 backfills normal legacy rows. Keep this runtime promotion
    // for databases that had already recorded 075 before the backfill shipped,
    // and for rows imported later through raw SQL, but only when the caller
    // omits permission_mode. An explicit null is the UI's bypass selection and
    // must win over an unchanged compatibility flag in args_template.
    if (
      resolveAgentVendor(mergedProfile.command) === 'claude'
      && mergedProfile.permission_mode == null
      && !Object.prototype.hasOwnProperty.call(fields, 'permission_mode')
    ) {
      const legacyPermissionMode = parseClaudeArgsTemplate(
        mergedProfile.args_template,
      ).permissionMode;
      if (legacyPermissionMode) {
        fields.permission_mode = legacyPermissionMode;
        mergedProfile.permission_mode = legacyPermissionMode;
      }
    }
    // AgentsView sends command and args_template on every PATCH, including a
    // name-only edit. Compare persisted values instead of key presence so an
    // unchanged legacy raw flag does not strand the profile, while introducing
    // or changing such a flag still enters the validator and is rejected.
    const templateActuallyChanged = (
      ('args_template' in fields && fields.args_template !== existing.args_template)
      || (
        'command' in fields
        && resolveAgentVendor(fields.command) !== resolveAgentVendor(existing.command)
      )
    );
    validateAgentProfileForSave(mergedProfile, {
      // Also re-scan when the vendor changes into claude: the template was
      // legitimate for the old vendor but is not for this one.
      templateIsBeingSet: templateActuallyChanged,
    });
    const setClauses = [];
    const params = { id };
    for (const col of AGENT_UPDATABLE) {
      if (col in fields) {
        setClauses.push(`${col} = @${col}`);
        params[col] = fields[col] ?? null;
      }
    }
    if (setClauses.length > 0) {
      db.prepare(`UPDATE agent_profiles SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
    }
    return stmts.getById.get(id);
  }

  function deleteProfile(id) {
    getProfile(id);
    stmts.delete.run(id);
  }

  function getRunningCount(profileId) {
    return stmts.countRunning.get(profileId).count;
  }

  return { listProfiles, getProfile, createProfile, updateProfile, deleteProfile, getRunningCount };
}

module.exports = {
  createAgentProfileService,
  parseClaudeArgsTemplate,
  resolveClaudePermissionMode,
  validateStructuredModelEffort,
};
