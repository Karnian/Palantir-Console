const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// Allowlist of safe agent commands — only these can be used as agent executables
const ALLOWED_COMMANDS = new Set([
  'claude', 'codex', 'opencode', 'gemini',        // known agent CLIs
  '/opt/homebrew/bin/claude', '/opt/homebrew/bin/codex',
  '/opt/homebrew/bin/opencode', '/opt/homebrew/bin/gemini',
  '/usr/local/bin/claude', '/usr/local/bin/codex',
  '/usr/local/bin/opencode', '/usr/local/bin/gemini',
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

function createAgentProfileService(db) {
  const stmts = {
    getAll: db.prepare('SELECT * FROM agent_profiles ORDER BY name ASC'),
    getById: db.prepare('SELECT * FROM agent_profiles WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, icon, color, max_concurrent)
      VALUES (@id, @name, @type, @command, @args_template, @capabilities_json, @env_allowlist, @icon, @color, @max_concurrent)
    `),
    update: db.prepare(`
      UPDATE agent_profiles
      SET name = COALESCE(@name, name),
          type = COALESCE(@type, type),
          command = COALESCE(@command, command),
          args_template = COALESCE(@args_template, args_template),
          capabilities_json = COALESCE(@capabilities_json, capabilities_json),
          env_allowlist = COALESCE(@env_allowlist, env_allowlist),
          icon = COALESCE(@icon, icon),
          color = COALESCE(@color, color),
          max_concurrent = COALESCE(@max_concurrent, max_concurrent)
      WHERE id = @id
    `),
    delete: db.prepare('DELETE FROM agent_profiles WHERE id = ?'),
    countRunning: db.prepare(`
      SELECT COUNT(*) as count FROM runs
      WHERE agent_profile_id = ? AND status IN ('queued', 'running')
    `),
  };

  function listProfiles() {
    return stmts.getAll.all();
  }

  function getProfile(id) {
    const profile = stmts.getById.get(id);
    if (!profile) throw new NotFoundError(`Agent profile not found: ${id}`);
    return profile;
  }

  function createProfile({ name, type, command, args_template, capabilities_json, env_allowlist, icon, color, max_concurrent }) {
    if (!name) throw new BadRequestError('Agent name is required');
    if (!type) throw new BadRequestError('Agent type is required');
    const validatedCommand = validateCommand(command);
    const id = `agent_${crypto.randomUUID().slice(0, 8)}`;
    stmts.insert.run({
      id, name, type, command: validatedCommand,
      args_template: args_template || null,
      capabilities_json: capabilities_json || '{}',
      env_allowlist: env_allowlist || '[]',
      icon: icon || null,
      color: color || null,
      max_concurrent: max_concurrent || 3,
    });
    return stmts.getById.get(id);
  }

  function updateProfile(id, fields) {
    getProfile(id);
    if (fields.command) {
      fields.command = validateCommand(fields.command);
    }
    stmts.update.run({
      id,
      name: null, type: null, command: null, args_template: null,
      capabilities_json: null, env_allowlist: null, icon: null, color: null, max_concurrent: null,
      ...fields,
    });
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

module.exports = { createAgentProfileService };
