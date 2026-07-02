const crypto = require('node:crypto');
const path = require('node:path');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { createLocalNodeExecutor } = require('./nodeExecutor');
const { createRemoteSshNodeExecutor } = require('./remoteSshExecutor');

const VALID_KINDS = new Set(['local', 'ssh']);
const NODE_FIELDS = [
  'id', 'name', 'kind', 'can_execute', 'can_control', 'files_only',
  'ssh_host', 'ssh_user', 'exposed_roots', 'node_prefix',
  'max_concurrent', 'reachable',
];

function normalizeBoolean(value, field, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  throw new BadRequestError(`${field} must be boolean or 0/1`);
}

function normalizeString(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestError(`${field} is required`);
    return value === undefined ? undefined : null;
  }
  if (typeof value !== 'string') throw new BadRequestError(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new BadRequestError(`${field} is required`);
  return trimmed || null;
}

function normalizeMaxConcurrent(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestError('max_concurrent must be null or an integer >= 1');
  }
  return n;
}

function parseExposedRoots(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to the uniform validation error below.
    }
  }
  throw new BadRequestError('exposed_roots must be a JSON array of absolute paths');
}

function normalizeExposedRoots(value) {
  if (value === undefined) return undefined;
  const roots = parseExposedRoots(value);
  if (roots === null) return null;
  if (!roots.every((root) => typeof root === 'string' && path.isAbsolute(root))) {
    throw new BadRequestError('exposed_roots must contain only absolute path strings');
  }
  return JSON.stringify(roots);
}

function validateSshDestinationPart(value, field) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('-')
    || /[\s@]/.test(value)
    || /[\x00-\x1F\x7F]/.test(value)
  ) {
    throw new BadRequestError(`${field} is not a safe ssh destination component`);
  }
}

function normalizeSshDestinationInput(value, field) {
  if (value === undefined || value === null) return value === undefined ? undefined : null;
  if (typeof value !== 'string') throw new BadRequestError(`${field} must be a string`);
  if (value !== value.trim()) throw new BadRequestError(`${field} is not a safe ssh destination component`);
  const normalized = normalizeString(value, field);
  if (normalized !== null) validateSshDestinationPart(normalized, field);
  return normalized;
}

function normalizeNodeInput(fields, { existing = null } = {}) {
  const input = fields || {};
  const out = {};

  if ('id' in input) out.id = normalizeString(input.id, 'id');
  if ('name' in input) out.name = normalizeString(input.name, 'name');
  if ('kind' in input) {
    const kind = normalizeString(input.kind, 'kind');
    if (!VALID_KINDS.has(kind)) throw new BadRequestError(`Invalid node kind: ${kind}`);
    out.kind = kind;
  }
  if ('can_execute' in input) out.can_execute = normalizeBoolean(input.can_execute, 'can_execute');
  if ('can_control' in input) out.can_control = normalizeBoolean(input.can_control, 'can_control');
  if ('files_only' in input) out.files_only = normalizeBoolean(input.files_only, 'files_only');
  if ('reachable' in input) out.reachable = normalizeBoolean(input.reachable, 'reachable');
  if ('ssh_host' in input) out.ssh_host = normalizeSshDestinationInput(input.ssh_host, 'ssh_host');
  if ('ssh_user' in input) out.ssh_user = normalizeSshDestinationInput(input.ssh_user, 'ssh_user');
  if ('node_prefix' in input) out.node_prefix = normalizeString(input.node_prefix, 'node_prefix');
  if ('exposed_roots' in input) out.exposed_roots = normalizeExposedRoots(input.exposed_roots);
  if ('max_concurrent' in input) out.max_concurrent = normalizeMaxConcurrent(input.max_concurrent);

  const effective = {
    ...(existing || {}),
    ...out,
  };
  effective.kind = effective.kind || 'local';
  effective.can_execute = effective.can_execute ?? 1;
  effective.can_control = effective.can_control ?? 0;
  effective.files_only = effective.files_only ?? 0;
  effective.reachable = effective.reachable ?? 0;

  if (!VALID_KINDS.has(effective.kind)) {
    throw new BadRequestError(`Invalid node kind: ${effective.kind}`);
  }
  if (effective.files_only === 1 && effective.can_execute === 1) {
    throw new BadRequestError('files_only nodes cannot also can_execute');
  }
  if (effective.kind === 'ssh') {
    if (!effective.ssh_host) throw new BadRequestError('ssh_host is required for ssh nodes');
    if (!effective.ssh_user) throw new BadRequestError('ssh_user is required for ssh nodes');
    validateSshDestinationPart(effective.ssh_host, 'ssh_host');
    validateSshDestinationPart(effective.ssh_user, 'ssh_user');
    if (!effective.exposed_roots) throw new BadRequestError('exposed_roots is required for ssh nodes');
    normalizeExposedRoots(effective.exposed_roots);
  }

  return { out, effective };
}

function createConflict(message) {
  const err = new Error(message);
  err.httpStatus = 409;
  return err;
}

function createNodeService(db, { localExecutor = createLocalNodeExecutor(), createRemoteExecutor = createRemoteSshNodeExecutor } = {}) {
  const remoteExecutorCache = new Map();
  const stmts = {
    list: db.prepare('SELECT * FROM nodes ORDER BY id ASC'),
    get: db.prepare('SELECT * FROM nodes WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO nodes (
        id, name, kind, can_execute, can_control, files_only,
        ssh_host, ssh_user, exposed_roots, node_prefix,
        max_concurrent, reachable
      )
      VALUES (
        @id, @name, @kind, @can_execute, @can_control, @files_only,
        @ssh_host, @ssh_user, @exposed_roots, @node_prefix,
        @max_concurrent, @reachable
      )
    `),
    delete: db.prepare('DELETE FROM nodes WHERE id = ?'),
    projectCount: db.prepare('SELECT COUNT(*) AS count FROM projects WHERE node_id = ?'),
    projectNode: db.prepare('SELECT node_id FROM projects WHERE id = ?'),
    setReachable: db.prepare(`
      UPDATE nodes SET reachable = ?, updated_at = datetime('now') WHERE id = ?
    `),
    touchHeartbeat: db.prepare(`
      UPDATE nodes
         SET last_heartbeat_at = datetime('now'), reachable = 1, updated_at = datetime('now')
       WHERE id = ?
    `),
  };

  function listNodes() {
    return stmts.list.all();
  }

  function getNode(id) {
    const node = stmts.get.get(id);
    if (!node) throw new NotFoundError(`Node not found: ${id}`);
    return node;
  }

  function createNode(fields) {
    const { out, effective } = normalizeNodeInput(fields || {});
    const id = out.id || `node_${crypto.randomUUID().slice(0, 8)}`;
    if (!effective.name) throw new BadRequestError('name is required');
    stmts.insert.run({
      id,
      name: effective.name,
      kind: effective.kind,
      can_execute: effective.can_execute,
      can_control: effective.can_control,
      files_only: effective.files_only,
      ssh_host: effective.ssh_host || null,
      ssh_user: effective.ssh_user || null,
      exposed_roots: effective.exposed_roots || null,
      node_prefix: effective.node_prefix || null,
      max_concurrent: effective.max_concurrent ?? null,
      reachable: effective.reachable,
    });
    return getNode(id);
  }

  function updateNode(id, patch) {
    const current = getNode(id);
    const input = patch || {};
    if ('id' in input && input.id !== id) throw new BadRequestError('node id is immutable');
    if ('kind' in input && input.kind !== current.kind) throw new BadRequestError('node kind is immutable');
    const { out } = normalizeNodeInput(input, { existing: current });
    const setClauses = [];
    const params = { id };
    for (const field of NODE_FIELDS) {
      if (field === 'id') continue;
      if (field in out) {
        setClauses.push(`${field} = @${field}`);
        params[field] = out[field] ?? null;
      }
    }
    if (setClauses.length > 0) {
      setClauses.push("updated_at = datetime('now')");
      db.prepare(`UPDATE nodes SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
      remoteExecutorCache.delete(id);
    }
    return getNode(id);
  }

  function deleteNode(id) {
    getNode(id);
    if (id === 'local') throw new BadRequestError('local node cannot be deleted');
    const boundProjects = stmts.projectCount.get(id).count;
    if (boundProjects > 0) {
      throw createConflict(`Cannot delete node ${id}: ${boundProjects} project(s) are bound to it`);
    }
    remoteExecutorCache.delete(id);
    stmts.delete.run(id);
  }

  function resolveNode(projectRowOrId) {
    if (!projectRowOrId) return 'local';
    if (typeof projectRowOrId === 'object') return projectRowOrId.node_id || 'local';
    const row = stmts.projectNode.get(projectRowOrId);
    if (!row) throw new NotFoundError(`Project not found: ${projectRowOrId}`);
    return row.node_id || 'local';
  }

  function setReachable(id, reachable) {
    getNode(id);
    stmts.setReachable.run(normalizeBoolean(reachable, 'reachable'), id);
    return getNode(id);
  }

  function touchHeartbeat(id) {
    getNode(id);
    stmts.touchHeartbeat.run(id);
    return getNode(id);
  }

  function pickExecutor(nodeId) {
    if (nodeId === undefined || nodeId === null || nodeId === 'local') {
      return localExecutor;
    }
    const node = getNode(nodeId);
    if (!node.kind || node.kind === 'local') {
      return localExecutor;
    }
    if (node.kind !== 'ssh') {
      throw new BadRequestError(`Unsupported node kind: ${node.kind}`);
    }
    if (Number(node.can_execute) !== 1 || Number(node.files_only) === 1) {
      throw new BadRequestError(`Node ${node.id} cannot host execution`);
    }
    const cached = remoteExecutorCache.get(node.id);
    if (cached && cached.updated_at === node.updated_at) {
      return cached.executor;
    }
    const executor = createRemoteExecutor(node);
    remoteExecutorCache.set(node.id, { updated_at: node.updated_at, executor });
    return executor;
  }

  return {
    listNodes,
    getNode,
    createNode,
    updateNode,
    deleteNode,
    resolveNode,
    pickExecutor,
    setReachable,
    touchHeartbeat,
  };
}

module.exports = { createNodeService };
