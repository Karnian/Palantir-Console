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
  validateStructuredModelEffort(mergedProfile);

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
    validateAgentProfileForSave(mergedProfile, {
      // Also re-scan when the vendor changes into claude: the template was
      // legitimate for the old vendor but is not for this one.
      templateIsBeingSet: 'args_template' in fields || 'command' in fields,
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

module.exports = { createAgentProfileService, validateStructuredModelEffort };
