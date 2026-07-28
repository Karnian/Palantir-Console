const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { resolveAgentVendor } = require('../utils/agentVendor');
const { resolveProviderEnvPolicy } = require('./providerEnvPolicy');

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

function validateStructuredModelEffort(mergedProfile) {
  const vendor = resolveAgentVendor(mergedProfile.command);
  const { model, reasoning_effort: reasoningEffort } = mergedProfile;
  const argsTemplate = String(mergedProfile.args_template || '');
  // Unquote each token to mirror buildAgentArgs' execution-time quote stripping
  // (Codex P2 review) so a quoted flag like `"--model"` / `"-c"` cannot evade
  // the conflict scan and re-inject at runtime.
  const tokens = (argsTemplate.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(unquoteToken);
  const configFragments = getConfigFragments(tokens);

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

function createAgentProfileService(db) {
  const stmts = {
    getAll: db.prepare('SELECT * FROM agent_profiles ORDER BY name ASC'),
    getById: db.prepare('SELECT * FROM agent_profiles WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, icon, color, max_concurrent, model, reasoning_effort)
      VALUES (@id, @name, @type, @command, @args_template, @capabilities_json, @env_allowlist, @icon, @color, @max_concurrent, @model, @reasoning_effort)
    `),
    // update: dynamic — see updateProfile() below
    delete: db.prepare('DELETE FROM agent_profiles WHERE id = ?'),
    countRunning: db.prepare(`
      SELECT COUNT(*) as count FROM runs
      WHERE agent_profile_id = ? AND status = 'running'
    `),
    getEnvironmentProviders: db.prepare(`
      SELECT ep.*
      FROM environment_providers ep
      JOIN agent_profile_environment_providers apep
        ON apep.environment_provider_id = ep.id
      WHERE apep.agent_profile_id = ?
      ORDER BY ep.name ASC
    `),
    getEnvironmentProviderById: db.prepare(
      'SELECT id FROM environment_providers WHERE id = ?',
    ),
    deleteEnvironmentProviderBindings: db.prepare(
      'DELETE FROM agent_profile_environment_providers WHERE agent_profile_id = ?',
    ),
    insertEnvironmentProviderBinding: db.prepare(`
      INSERT INTO agent_profile_environment_providers (
        agent_profile_id, environment_provider_id
      ) VALUES (?, ?)
    `),
  };

  function validateEnvironmentProviderIds(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) {
      throw new BadRequestError('environment_provider_ids must be an array');
    }
    const ids = [];
    const seen = new Set();
    for (const id of value) {
      if (typeof id !== 'string' || !id) {
        throw new BadRequestError(
          'environment_provider_ids entries must be non-empty strings',
        );
      }
      if (seen.has(id)) continue;
      if (!stmts.getEnvironmentProviderById.get(id)) {
        throw new BadRequestError(`environment provider not found: ${id}`);
      }
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  function replaceEnvironmentProviderBindings(profileId, providerIds) {
    stmts.deleteEnvironmentProviderBindings.run(profileId);
    for (const providerId of providerIds) {
      stmts.insertEnvironmentProviderBinding.run(profileId, providerId);
    }
  }

  function resolveEnvPolicy(profileOrId) {
    const profile = typeof profileOrId === 'string'
      ? stmts.getById.get(profileOrId)
      : profileOrId;
    if (!profile) {
      throw new NotFoundError(`Agent profile not found: ${profileOrId}`);
    }
    const providers = stmts.getEnvironmentProviders.all(profile.id);
    return resolveProviderEnvPolicy(profile.env_allowlist, providers);
  }

  function hydrateEnvironmentProviders(profile) {
    const policy = resolveEnvPolicy(profile);
    // Preserve the exact pre-#457 profile shape while no provider is bound.
    // This keeps existing API consumers and spawn/auth behavior byte-identical.
    if (policy.providers.length === 0) return profile;
    return {
      ...profile,
      environment_provider_ids: policy.providers.map((provider) => provider.id),
      environment_providers: policy.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        env_keys: provider.envKeys,
        inherited_env_keys: provider.inheritedKeys,
        secret_env_keys: provider.secretKeys,
        withheld_secret_env_keys: provider.withheldSecretKeys,
      })),
      effective_env_allowlist: policy.effectiveKeys,
    };
  }

  function listProfiles() {
    // A profile of a retired type (e.g. a migration-retained opencode row —
    // see 069_remove_opencode_agent_profile.sql's live-run guard) stays in
    // the table for FK/recovery purposes but must not be offered as a
    // pickable choice going forward.
    return stmts.getAll.all()
      .filter((profile) => profile.type !== 'opencode')
      .map(hydrateEnvironmentProviders);
  }

  function getProfile(id) {
    const profile = stmts.getById.get(id);
    if (!profile) throw new NotFoundError(`Agent profile not found: ${id}`);
    return hydrateEnvironmentProviders(profile);
  }

  function createProfile({
    name,
    type,
    command,
    args_template,
    capabilities_json,
    env_allowlist,
    icon,
    color,
    max_concurrent,
    model,
    reasoning_effort,
    environment_provider_ids,
  } = {}) {
    if (!name) throw new BadRequestError('Agent name is required');
    if (!type) throw new BadRequestError('Agent type is required');
    rejectRetiredAgentType(type);
    const validatedCommand = validateCommand(command);
    validateStructuredModelEffort({ command: validatedCommand, args_template, model, reasoning_effort });
    const providerIds = validateEnvironmentProviderIds(environment_provider_ids);
    const id = `agent_${crypto.randomUUID().slice(0, 8)}`;
    db.transaction(() => {
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
      });
      replaceEnvironmentProviderBindings(id, providerIds);
    })();
    return getProfile(id);
  }

  const AGENT_UPDATABLE = ['name', 'type', 'command', 'args_template', 'capabilities_json', 'env_allowlist', 'icon', 'color', 'max_concurrent', 'model', 'reasoning_effort'];

  function updateProfile(id, fields) {
    const existing = stmts.getById.get(id);
    if (!existing) throw new NotFoundError(`Agent profile not found: ${id}`);
    const mergedProfile = { ...existing, ...fields };
    rejectRetiredAgentType(mergedProfile.type);
    if (fields.command) {
      fields.command = validateCommand(fields.command);
      mergedProfile.command = fields.command;
    }
    validateStructuredModelEffort(mergedProfile);
    const shouldReplaceProviders = Object.prototype.hasOwnProperty.call(
      fields,
      'environment_provider_ids',
    );
    const providerIds = shouldReplaceProviders
      ? validateEnvironmentProviderIds(fields.environment_provider_ids)
      : null;
    const setClauses = [];
    const params = { id };
    for (const col of AGENT_UPDATABLE) {
      if (col in fields) {
        setClauses.push(`${col} = @${col}`);
        params[col] = fields[col] ?? null;
      }
    }
    db.transaction(() => {
      if (setClauses.length > 0) {
        db.prepare(`UPDATE agent_profiles SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
      }
      if (shouldReplaceProviders) {
        replaceEnvironmentProviderBindings(id, providerIds);
      }
    })();
    return getProfile(id);
  }

  function deleteProfile(id) {
    getProfile(id);
    stmts.delete.run(id);
  }

  function getRunningCount(profileId) {
    return stmts.countRunning.get(profileId).count;
  }

  return {
    listProfiles,
    getProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    getRunningCount,
    resolveEnvPolicy,
  };
}

module.exports = { createAgentProfileService, validateStructuredModelEffort };
