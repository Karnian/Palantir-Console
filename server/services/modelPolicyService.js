'use strict';

const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require('../utils/errors');
const { resolveModelPolicy } = require('./modelPolicyResolver');

const CLI_DEFAULT = '__cli_default__';
const VALID_SCOPE_TYPES = new Set(['global', 'layer:top', 'layer:operator', 'codebase']);
const VALID_VENDORS = new Set(['codex', 'claude']);
const VALID_LAYERS = new Set(['top', 'operator', 'worker']);
const VENDOR_KEYS = {
  codex: new Set(['model', 'reasoning_effort', 'tier']),
  claude: new Set(['model']),
};
const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', CLI_DEFAULT]);
const VALID_TIERS = new Set(['fast', 'standard']);
const CONTROL_CHAR_RE = /\p{Cc}/u;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function validatePolicyKey({ scope_type, scope_id, vendor } = {}) {
  if (!VALID_SCOPE_TYPES.has(scope_type)) {
    throw new BadRequestError('invalid model policy scope_type');
  }
  if (!VALID_VENDORS.has(vendor)) {
    throw new BadRequestError('invalid model policy vendor');
  }
  if (typeof scope_id !== 'string') {
    throw new BadRequestError('invalid model policy scope_id');
  }
  if (scope_type === 'codebase') {
    if (scope_id === '*') {
      throw new BadRequestError('codebase scope_id must not be *');
    }
  } else if (scope_id !== '*') {
    throw new BadRequestError(`${scope_type} scope_id must be *`);
  }
}

function validateVendorParams(vendor, params) {
  if (!VALID_VENDORS.has(vendor)) {
    throw new BadRequestError('invalid model policy vendor');
  }

  const prototype = params == null ? null : Object.getPrototypeOf(params);
  if (params == null || typeof params !== 'object' || Array.isArray(params)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new BadRequestError('params must be a plain object');
  }

  const allowedKeys = VENDOR_KEYS[vendor];
  for (const key of Reflect.ownKeys(params)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      throw new BadRequestError(`unsupported ${vendor} parameter: ${String(key)}`);
    }
  }

  if (hasOwn(params, 'model')) {
    const model = params.model;
    if (typeof model !== 'string' || model.length === 0 || model.length > 200
      || CONTROL_CHAR_RE.test(model)) {
      throw new BadRequestError('model must be a non-empty string of at most 200 characters with no control characters');
    }
  }

  if (hasOwn(params, 'reasoning_effort')
    && !VALID_REASONING_EFFORTS.has(params.reasoning_effort)) {
    throw new BadRequestError('reasoning_effort must be low, medium, high, or __cli_default__');
  }

  if (hasOwn(params, 'tier') && !VALID_TIERS.has(params.tier)) {
    throw new BadRequestError('tier must be fast or standard');
  }

  return params;
}

function toPolicy(row) {
  if (!row) return null;
  return {
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    vendor: row.vendor,
    params: JSON.parse(row.params_json),
    revision: row.revision,
    changed_by: row.changed_by,
    updated_at: row.updated_at,
  };
}

function createModelPolicyService(db) {
  const stmts = {
    list: db.prepare(`
      SELECT scope_type, scope_id, vendor, params_json, revision, changed_by, updated_at
      FROM model_policies
      ORDER BY scope_type, scope_id, vendor
    `),
    get: db.prepare(`
      SELECT scope_type, scope_id, vendor, params_json, revision, changed_by, updated_at
      FROM model_policies
      WHERE scope_type = @scope_type AND scope_id = @scope_id AND vendor = @vendor
    `),
    getRevision: db.prepare(`
      SELECT revision
      FROM model_policies
      WHERE scope_type = @scope_type AND scope_id = @scope_id AND vendor = @vendor
    `),
    projectExists: db.prepare('SELECT 1 FROM projects WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO model_policies (
        scope_type, scope_id, vendor, params_json, revision, changed_by
      ) VALUES (
        @scope_type, @scope_id, @vendor, @params_json, 1, @changed_by
      )
    `),
    update: db.prepare(`
      UPDATE model_policies
      SET params_json = @params_json,
          revision = revision + 1,
          changed_by = @changed_by
      WHERE scope_type = @scope_type
        AND scope_id = @scope_id
        AND vendor = @vendor
        AND revision = @expected_revision
    `),
    delete: db.prepare(`
      DELETE FROM model_policies
      WHERE scope_type = @scope_type AND scope_id = @scope_id AND vendor = @vendor
    `),
    audit: db.prepare(`
      INSERT INTO model_policy_audit (
        scope_type, scope_id, vendor, action, params_json_after, changed_by
      ) VALUES (
        @scope_type, @scope_id, @vendor, @action, @params_json_after, @changed_by
      )
    `),
  };

  function listPolicies() {
    return stmts.list.all().map(toPolicy);
  }

  function getPolicy(key) {
    validatePolicyKey(key);
    return toPolicy(stmts.get.get(key));
  }

  const putPolicyTx = db.transaction(({
    scope_type,
    scope_id,
    vendor,
    params,
    changed_by,
    expectedRevision,
  } = {}) => {
    const key = { scope_type, scope_id, vendor };
    validatePolicyKey(key);
    validateVendorParams(vendor, params);

    if (scope_type === 'codebase' && !stmts.projectExists.get(scope_id)) {
      throw new NotFoundError('codebase not found');
    }

    const paramsJson = JSON.stringify(params);
    const actor = changed_by == null ? null : changed_by;
    const existing = stmts.getRevision.get(key);
    let action;

    if (!existing) {
      try {
        stmts.insert.run({ ...key, params_json: paramsJson, changed_by: actor });
      } catch (err) {
        if (String(err && err.code).startsWith('SQLITE_CONSTRAINT')) {
          throw new ConflictError('model policy already exists, refetch before updating');
        }
        throw err;
      }
      action = 'insert';
    } else {
      if (expectedRevision == null || expectedRevision !== existing.revision) {
        throw new ConflictError('model policy is stale, refetch before updating');
      }

      const result = stmts.update.run({
        ...key,
        params_json: paramsJson,
        changed_by: actor,
        expected_revision: expectedRevision,
      });
      if (result.changes === 0) {
        if (stmts.getRevision.get(key)) {
          throw new ConflictError('model policy was concurrently edited, refetch before updating');
        }
        throw new NotFoundError('model policy not found');
      }
      action = 'update';
    }

    stmts.audit.run({
      ...key,
      action,
      params_json_after: paramsJson,
      changed_by: actor,
    });
    return toPolicy(stmts.get.get(key));
  });

  function putPolicy(input) {
    return putPolicyTx(input);
  }

  const deletePolicyTx = db.transaction(({
    scope_type,
    scope_id,
    vendor,
    changed_by,
  } = {}) => {
    const key = { scope_type, scope_id, vendor };
    validatePolicyKey(key);
    const actor = changed_by == null ? null : changed_by;
    const result = stmts.delete.run(key);
    if (result.changes === 0) {
      throw new NotFoundError('model policy not found');
    }
    stmts.audit.run({
      ...key,
      action: 'delete',
      params_json_after: null,
      changed_by: actor,
    });
    return { deleted: true };
  });

  function deletePolicy(input) {
    return deletePolicyTx(input);
  }

  function resolveEffective({
    layer,
    vendor,
    projectId,
    instanceFastMode,
    requestModel,
    env,
  } = {}) {
    if (!VALID_LAYERS.has(layer)) {
      throw new BadRequestError('layer must be top, operator, or worker');
    }
    if (!VALID_VENDORS.has(vendor)) {
      throw new BadRequestError('invalid model policy vendor');
    }

    const scopedPolicies = [];
    const appendPolicy = (scope_type, scope_id) => {
      const row = stmts.get.get({ scope_type, scope_id, vendor });
      if (row) scopedPolicies.push({ scope_type, params: JSON.parse(row.params_json) });
    };

    if (layer === 'operator') {
      if (projectId) appendPolicy('codebase', projectId);
      appendPolicy('layer:operator', '*');
      appendPolicy('global', '*');
    } else if (layer === 'top') {
      appendPolicy('layer:top', '*');
      appendPolicy('global', '*');
    }

    return resolveModelPolicy({
      layer,
      vendor,
      scopedPolicies,
      instanceFastMode,
      requestModel,
      env,
    });
  }

  return {
    listPolicies,
    getPolicy,
    putPolicy,
    deletePolicy,
    resolveEffective,
  };
}

module.exports = { createModelPolicyService, validateVendorParams };
