'use strict';

const crypto = require('node:crypto');
const {
  BadRequestError,
  ConflictError,
  NotFoundError,
} = require('../utils/errors');
const {
  isProviderSecretEnvKey,
  normalizeProviderEnvKeys,
  parseEnvKeyArray,
} = require('./providerEnvPolicy');

const NAME_MAX = 128;
const DESCRIPTION_MAX = 1000;

function normalizeName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError('name is required (non-empty string)');
  }
  const name = value.trim();
  if (name.length > NAME_MAX) {
    throw new BadRequestError(`name too long (max ${NAME_MAX})`);
  }
  return name;
}

function normalizeDescription(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BadRequestError('description must be a string');
  }
  if (value.length > DESCRIPTION_MAX) {
    throw new BadRequestError(`description too long (max ${DESCRIPTION_MAX})`);
  }
  return value;
}

function rowToProvider(row) {
  if (!row) return null;
  const parsed = parseEnvKeyArray(row.env_keys);
  const envKeys = parsed.valid ? parsed.keys : [];
  return {
    id: row.id,
    name: row.name,
    env_keys: envKeys,
    secret_env_keys: envKeys.filter(isProviderSecretEnvKey),
    description: row.description ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createEnvironmentProviderService(db) {
  const stmts = {
    listAll: db.prepare('SELECT * FROM environment_providers ORDER BY name ASC'),
    getById: db.prepare('SELECT * FROM environment_providers WHERE id = ?'),
    getByName: db.prepare('SELECT * FROM environment_providers WHERE name = ?'),
    insert: db.prepare(`
      INSERT INTO environment_providers (id, name, env_keys, description)
      VALUES (@id, @name, @env_keys, @description)
    `),
    update: db.prepare(`
      UPDATE environment_providers
      SET name = @name,
          env_keys = @env_keys,
          description = @description,
          updated_at = CASE
            WHEN name != @name
              OR env_keys != @env_keys
              OR COALESCE(description, '') != COALESCE(@description, '')
            THEN datetime('now')
            ELSE updated_at
          END
      WHERE id = @id
    `),
    delete: db.prepare('DELETE FROM environment_providers WHERE id = ?'),
    references: db.prepare(`
      SELECT ap.id, ap.name
      FROM agent_profiles ap
      JOIN agent_profile_environment_providers apep
        ON apep.agent_profile_id = ap.id
      WHERE apep.environment_provider_id = ?
      ORDER BY ap.name ASC
    `),
  };

  function listProviders() {
    return stmts.listAll.all().map(rowToProvider);
  }

  function getProvider(id) {
    const row = stmts.getById.get(id);
    if (!row) throw new NotFoundError(`environment provider not found: ${id}`);
    return rowToProvider(row);
  }

  function createProvider(data = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestError('request body must be an object');
    }
    const name = normalizeName(data.name);
    const envKeys = normalizeProviderEnvKeys(data.env_keys ?? []);
    const description = normalizeDescription(data.description);
    if (stmts.getByName.get(name)) {
      throw new ConflictError(`environment provider name already exists: ${name}`);
    }
    const id = `envp_${crypto.randomUUID().slice(0, 12)}`;
    try {
      stmts.insert.run({
        id,
        name,
        env_keys: JSON.stringify(envKeys),
        description,
      });
    } catch (err) {
      if (String(err && err.message).includes('UNIQUE')) {
        throw new ConflictError(`environment provider name already exists: ${name}`);
      }
      throw err;
    }
    return getProvider(id);
  }

  function updateProvider(id, data = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestError('request body must be an object');
    }
    const existingRow = stmts.getById.get(id);
    if (!existingRow) {
      throw new NotFoundError(`environment provider not found: ${id}`);
    }
    const name = Object.prototype.hasOwnProperty.call(data, 'name')
      ? normalizeName(data.name)
      : existingRow.name;
    const envKeys = Object.prototype.hasOwnProperty.call(data, 'env_keys')
      ? normalizeProviderEnvKeys(data.env_keys)
      : parseEnvKeyArray(existingRow.env_keys).keys;
    const description = Object.prototype.hasOwnProperty.call(data, 'description')
      ? normalizeDescription(data.description)
      : existingRow.description;
    const clash = stmts.getByName.get(name);
    if (clash && clash.id !== id) {
      throw new ConflictError(`environment provider name already exists: ${name}`);
    }
    try {
      stmts.update.run({
        id,
        name,
        env_keys: JSON.stringify(envKeys),
        description,
      });
    } catch (err) {
      if (String(err && err.message).includes('UNIQUE')) {
        throw new ConflictError(`environment provider name already exists: ${name}`);
      }
      throw err;
    }
    return getProvider(id);
  }

  function findReferences(id) {
    getProvider(id);
    return { agent_profiles: stmts.references.all(id) };
  }

  function deleteProvider(id) {
    const existing = getProvider(id);
    const references = stmts.references.all(id);
    if (references.length > 0) {
      const err = new ConflictError(
        `environment provider is in use by ${references.length} agent profile(s); remove references first`,
      );
      err.details = { agent_profiles: references };
      throw err;
    }
    stmts.delete.run(id);
    return existing;
  }

  return {
    listProviders,
    getProvider,
    createProvider,
    updateProvider,
    deleteProvider,
    findReferences,
  };
}

module.exports = {
  createEnvironmentProviderService,
  rowToProvider,
};
