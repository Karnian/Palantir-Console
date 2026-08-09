'use strict';

/**
 * Approval provenance passed here is derived by the route. Cookie authentication
 * itself belongs to PR2 (`req.auth.method === 'cookie'`); this service trusts its
 * caller for that authentication fact and durably records the supplied provenance.
 */

const { createHash, randomUUID } = require('node:crypto');
const {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
} = require('../utils/errors');
const { assertBodyHasNoReservedMarker } = require('./actionReadback');

const CONNECTOR = 'github';
const OPERATION = 'github.create_issue';
const ALLOWED_PARAM_KEYS = new Set(['repo', 'title', 'body', 'labels']);
const MAX_PARAMS_BYTES = 64 * 1024;
const MAX_NESTING_DEPTH = 8;
const MAX_JSON_KEYS = 64;
const MAX_ARRAY_ITEMS = 256;
const MAX_LABELS = 100;
const MAX_STRING_LENGTH = 48 * 1024;
const EXECUTION_RESULT_STATUSES = new Set([
  'executing',
  'succeeded',
  'partially_applied',
  'failed',
  'unknown',
]);
const RECONCILE_RESULT_STATUSES = new Set([
  'succeeded',
  'partially_applied',
  'conflict',
  'unknown',
]);
const REPAIR_RESULT_STATUSES = new Set([
  'succeeded',
  'repair_blocked',
  'repair_retry_wait',
  'unknown',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateBoundedJson(value, rootPath = 'params') {
  const ancestors = new Set();
  const state = { keyCount: 0 };

  function visit(current, path, depth) {
    if (depth > MAX_NESTING_DEPTH) {
      throw new BadRequestError(`${rootPath} nesting exceeds ${MAX_NESTING_DEPTH}`);
    }
    if (typeof current === 'string') {
      if (current.length > MAX_STRING_LENGTH) {
        throw new BadRequestError(`${path} exceeds the string length limit`);
      }
      return;
    }
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object') {
      throw new BadRequestError(`${path} must contain only JSON values`);
    }
    if (ancestors.has(current)) throw new BadRequestError(`${rootPath} must not be cyclic`);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_ARRAY_ITEMS) {
          throw new BadRequestError(`${path} has too many items`);
        }
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) {
            throw new BadRequestError(`${path} must not be sparse`);
          }
          visit(current[index], `${path}[${index}]`, depth + 1);
        }
        return;
      }
      if (!isPlainObject(current)) {
        throw new BadRequestError(`${path} must contain only JSON values`);
      }
      const keys = Object.keys(current);
      state.keyCount += keys.length;
      if (state.keyCount > MAX_JSON_KEYS) {
        throw new BadRequestError(`${rootPath} has too many keys`);
      }
      for (const key of keys) visit(current[key], `${path}.${key}`, depth + 1);
    } finally {
      ancestors.delete(current);
    }
  }

  visit(value, rootPath, 0);
}

function normalizeJsonValue(value, path = 'params') {
  if (typeof value === 'string') return value.normalize('NFC');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) {
    throw new BadRequestError(`${path} must contain only JSON values`);
  }

  const sorted = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) {
      throw new BadRequestError(`${path}.${key} must contain a JSON value`);
    }
    sorted[key] = normalizeJsonValue(value[key], `${path}.${key}`);
  }
  return sorted;
}

function canonicalizeParams(params) {
  if (!isPlainObject(params)) throw new BadRequestError('params must be an object');
  const snapshot = Object.create(null);
  for (const key of ALLOWED_PARAM_KEYS) {
    snapshot[key] = Object.hasOwn(params, key) ? params[key] : undefined;
  }
  const ownKeys = Object.keys(params);
  for (const key of ownKeys) {
    if (!ALLOWED_PARAM_KEYS.has(key)) {
      throw new BadRequestError(`unknown create_issue param field: ${key}`);
    }
  }
  if (snapshot.labels !== undefined && !Array.isArray(snapshot.labels)) {
    throw new BadRequestError('params.labels must be an array when present');
  }
  const labelValues = [];
  if (snapshot.labels !== undefined) {
    if (snapshot.labels.length > MAX_LABELS) {
      throw new BadRequestError('params.labels has too many items');
    }
    for (let index = 0; index < snapshot.labels.length; index += 1) {
      if (!Object.hasOwn(snapshot.labels, index)) {
        throw new BadRequestError('params.labels must not be sparse');
      }
      labelValues.push(snapshot.labels[index]);
    }
  }
  const paramsForValidation = Object.create(null);
  for (const key of ALLOWED_PARAM_KEYS) {
    if (key === 'labels') {
      paramsForValidation.labels = labelValues;
    } else {
      paramsForValidation[key] = snapshot[key];
    }
  }
  validateBoundedJson(paramsForValidation);
  if (!labelValues.every((label) => typeof label === 'string')) {
    throw new BadRequestError('params.labels must contain only strings');
  }
  for (const field of ['repo', 'title', 'body']) {
    if (typeof snapshot[field] !== 'string') {
      throw new BadRequestError(`params.${field} must be a string`);
    }
  }
  const withCanonicalFields = Object.create(null);
  withCanonicalFields.repo = snapshot.repo.normalize('NFC').toLowerCase();
  withCanonicalFields.title = snapshot.title.normalize('NFC');
  withCanonicalFields.body = snapshot.body.normalize('NFC');
  withCanonicalFields.labels = [
    ...new Set(labelValues.map((label) => label.normalize('NFC'))),
  ].sort();
  return normalizeJsonValue(withCanonicalFields);
}

function canonicalParamsJson(params) {
  const json = JSON.stringify(canonicalizeParams(params));
  if (Buffer.byteLength(json, 'utf8') > MAX_PARAMS_BYTES) {
    throw new BadRequestError(`canonical params exceed ${MAX_PARAMS_BYTES} bytes`);
  }
  return json;
}

function paramsHash(paramsJson) {
  return createHash('sha256').update(paramsJson, 'utf8').digest('hex');
}

function timestamp(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BadRequestError(`${name} must be a valid timestamp`);
  return date.toISOString();
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestError(`${name} must be a non-empty string`);
  }
  return value;
}

function jsonOrNull(value, name = 'receipt') {
  if (value === undefined || value === null) return null;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BadRequestError(`${name} must be valid JSON`);
    }
  }
  validateBoundedJson(parsed, name);
  const json = typeof value === 'string' ? value : JSON.stringify(parsed);
  if (Buffer.byteLength(json, 'utf8') > MAX_PARAMS_BYTES) {
    throw new BadRequestError(`${name} exceeds ${MAX_PARAMS_BYTES} bytes`);
  }
  return json;
}

function translateSqliteConstraint(error) {
  if (error instanceof AppError) return error;
  if (!String(error && error.code || '').startsWith('SQLITE_CONSTRAINT')) return error;
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return new ConflictError(error.message);
  }
  return new BadRequestError(error.message);
}

function isExternalIdentityUniqueViolation(error) {
  return error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
    && /actions\.connector,\s*actions\.external_node_id|ux_actions_external_node/i
      .test(String(error.message || ''));
}

function publicMutation(fn) {
  try {
    return fn();
  } catch (error) {
    throw translateSqliteConstraint(error);
  }
}

function createActionLedgerService(db, options = {}) {
  const clock = options.clock || (() => new Date());
  const actionIdFactory = options.actionIdFactory || randomUUID;
  const attemptIdFactory = options.attemptIdFactory || randomUUID;

  const stmts = {
    getAction: db.prepare('SELECT * FROM actions WHERE id = ?'),
    getByIntent: db.prepare('SELECT * FROM actions WHERE task_id = ? AND action_slot = ?'),
    listActions: db.prepare('SELECT * FROM actions ORDER BY created_at, rowid'),
    listReconcilableActionIds: db.prepare(`
      SELECT id FROM actions
      WHERE status = 'unknown'
        AND (
          next_reconcile_at IS NULL
          OR julianday(next_reconcile_at) <= julianday(@now)
        )
      ORDER BY created_at, rowid
    `),
    listRepairableActionIds: db.prepare(`
      SELECT id FROM actions
      WHERE status = 'partially_applied'
        OR (
          status = 'repair_retry_wait'
          AND next_repair_at IS NOT NULL
          AND julianday(next_repair_at) <= julianday(@now)
        )
      ORDER BY created_at, rowid
    `),
    listEvents: db.prepare('SELECT * FROM action_events WHERE action_id = ? ORDER BY id'),
    insertAction: db.prepare(`
      INSERT INTO actions (
        id, task_id, action_slot, connector, operation,
        params_json, params_hash, status, created_at, reissues_action_id, declared_by_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?)
    `),
    insertEvent: db.prepare(`
      INSERT INTO action_events (
        action_id, attempt_id, phase, request_digest, transport_class,
        external_request_id, candidate_external_id, receipt_json, error, ts
      ) VALUES (
        @action_id, @attempt_id, @phase, @request_digest, @transport_class,
        @external_request_id, @candidate_external_id, @receipt_json, @error, @ts
      )
    `),
    approve: db.prepare(`
      UPDATE actions
      SET status = 'queued',
          approved_at = @approved_at,
          approved_by = @approved_by,
          approval_auth_method = 'cookie',
          approved_params_hash = params_hash,
          approval_policy_version = @approval_policy_version,
          approval_expires_at = @approval_expires_at
      WHERE id = @id
        AND status = 'awaiting_approval'
        AND params_hash = @expected_params_hash
    `),
    expireOne: db.prepare(`
      UPDATE actions
      SET status = 'awaiting_approval', active_attempt_id = NULL, claimed_at = NULL
      WHERE id = ?
        AND status = 'queued'
        AND (
          approval_expires_at IS NULL
          OR julianday(approval_expires_at) IS NULL
          OR julianday(approval_expires_at) <= julianday(?)
        )
    `),
    expiredQueued: db.prepare(`
      SELECT * FROM actions
      WHERE status = 'queued'
        AND (
          approval_expires_at IS NULL
          OR julianday(approval_expires_at) IS NULL
          OR julianday(approval_expires_at) <= julianday(?)
        )
      ORDER BY created_at, rowid
    `),
    claim: db.prepare(`
      UPDATE actions
      SET status = 'executing', active_attempt_id = @attempt_id, claimed_at = @claimed_at
      WHERE id = @id
        AND status = 'queued'
        AND approved_params_hash = params_hash
        AND julianday(approval_expires_at) > julianday(@claimed_at)
    `),
    claimForReconcile: db.prepare(`
      UPDATE actions
      SET status = 'reconciling',
          active_attempt_id = @attempt_id,
          claimed_at = @claimed_at
      WHERE id = @id
        AND status = 'unknown'
        AND (
          next_reconcile_at IS NULL
          OR julianday(next_reconcile_at) <= julianday(@claimed_at)
        )
    `),
    blockRepair: db.prepare(`
      UPDATE actions
      SET status = 'repair_blocked',
          active_attempt_id = NULL,
          claimed_at = NULL,
          next_repair_at = NULL
      WHERE id = @id
        AND (
          status = 'partially_applied'
          OR (
            status = 'repair_retry_wait'
            AND next_repair_at IS NOT NULL
            AND julianday(next_repair_at) <= julianday(@claimed_at)
          )
        )
    `),
    claimForRepair: db.prepare(`
      UPDATE actions
      SET status = 'repairing',
          active_attempt_id = @attempt_id,
          claimed_at = @claimed_at,
          repair_attempts = repair_attempts + 1,
          next_repair_at = NULL
      WHERE id = @id
        AND (
          status = 'partially_applied'
          OR (
            status = 'repair_retry_wait'
            AND next_repair_at IS NOT NULL
            AND julianday(next_repair_at) <= julianday(@claimed_at)
          )
        )
        AND repair_attempts < @max_repair_attempts
        AND julianday(approval_expires_at) > julianday(@claimed_at)
    `),
    recordExecutionResult: db.prepare(`
      UPDATE actions
      SET status = @target_status,
          external_id = CASE WHEN @has_external_id = 1 THEN @external_id ELSE external_id END,
          external_node_id = CASE
            WHEN @has_external_node_id = 1 THEN @external_node_id ELSE external_node_id
          END,
          receipt_json = CASE WHEN @has_receipt = 1 THEN @receipt_json ELSE receipt_json END,
          last_error = CASE WHEN @has_error = 1 THEN @last_error ELSE last_error END,
          next_reconcile_at = CASE
            WHEN @has_next_reconcile_at = 1 THEN @next_reconcile_at ELSE next_reconcile_at
          END,
          verdict = CASE WHEN @has_verdict = 1 THEN @verdict ELSE verdict END,
          active_attempt_id = CASE
            WHEN @target_status = 'executing' THEN active_attempt_id ELSE NULL
          END,
          claimed_at = CASE WHEN @target_status = 'executing' THEN claimed_at ELSE NULL END
      WHERE id = @id
        AND status = 'executing'
        AND active_attempt_id = @attempt_id
    `),
    recordReconcileResult: db.prepare(`
      UPDATE actions
      SET status = @target_status,
          external_id = CASE WHEN @has_external_id = 1 THEN @external_id ELSE external_id END,
          external_node_id = CASE
            WHEN @has_external_node_id = 1 THEN @external_node_id ELSE external_node_id
          END,
          receipt_json = CASE WHEN @has_receipt = 1 THEN @receipt_json ELSE receipt_json END,
          next_reconcile_at = CASE
            WHEN @target_status = 'unknown' THEN @next_reconcile_at ELSE NULL
          END,
          verdict = CASE WHEN @has_verdict = 1 THEN @verdict ELSE verdict END,
          active_attempt_id = NULL,
          claimed_at = NULL
      WHERE id = @id
        AND status = 'reconciling'
        AND active_attempt_id = @attempt_id
    `),
    recordRepairResult: db.prepare(`
      UPDATE actions
      SET status = @target_status,
          receipt_json = CASE WHEN @has_receipt = 1 THEN @receipt_json ELSE receipt_json END,
          last_error = CASE WHEN @has_error = 1 THEN @last_error ELSE last_error END,
          verdict = CASE WHEN @has_verdict = 1 THEN @verdict ELSE verdict END,
          next_repair_at = CASE
            WHEN @target_status = 'repair_retry_wait' THEN @next_repair_at ELSE NULL
          END,
          next_reconcile_at = CASE
            WHEN @target_status = 'unknown' THEN @next_reconcile_at ELSE NULL
          END,
          active_attempt_id = NULL,
          claimed_at = NULL
      WHERE id = @id
        AND status = 'repairing'
        AND active_attempt_id = @attempt_id
    `),
    orphanCandidates: db.prepare(`
      SELECT * FROM actions
      WHERE status IN ('executing', 'reconciling', 'repairing')
        AND ROUND(
          (julianday(@now) - julianday(claimed_at)) * 86400000
        ) >= @lease_ttl_ms
      ORDER BY claimed_at, rowid
    `),
    recoverOrphan: db.prepare(`
      UPDATE actions
      SET status = 'unknown',
          active_attempt_id = NULL,
          claimed_at = NULL,
          next_reconcile_at = @now
      WHERE id = @id
        AND status = @status
        AND active_attempt_id = @attempt_id
        AND claimed_at = @claimed_at
        AND ROUND(
          (julianday(@now) - julianday(claimed_at)) * 86400000
        ) >= @lease_ttl_ms
    `),
  };

  function nowIso() {
    return timestamp(clock(), 'clock');
  }

  function insertEvent(actionId, event = {}, ts = nowIso()) {
    const info = stmts.insertEvent.run({
      action_id: actionId,
      attempt_id: event.attemptId ?? event.attempt_id ?? null,
      phase: requiredString(event.phase, 'event.phase'),
      request_digest: event.requestDigest ?? event.request_digest ?? null,
      transport_class: event.transportClass ?? event.transport_class ?? null,
      external_request_id: event.externalRequestId ?? event.external_request_id ?? null,
      candidate_external_id: event.candidateExternalId ?? event.candidate_external_id ?? null,
      receipt_json: jsonOrNull(event.receipt ?? event.receipt_json),
      error: event.error == null ? null : String(event.error),
      ts,
    });
    return Number(info.lastInsertRowid);
  }

  const declareTx = db.transaction((input) => {
    const taskId = requiredString(input.taskId ?? input.task_id, 'taskId');
    const actionSlot = requiredString(input.actionSlot ?? input.action_slot, 'actionSlot');
    const connector = input.connector ?? CONNECTOR;
    const operation = input.operation ?? OPERATION;
    if (connector !== CONNECTOR) throw new BadRequestError(`unsupported connector: ${connector}`);
    if (operation !== OPERATION) throw new BadRequestError(`unsupported operation: ${operation}`);
    const declaredByMethod = input.declaredByMethod ?? input.declared_by_method ?? 'cookie';
    if (!['bearer', 'cookie'].includes(declaredByMethod)) {
      throw new BadRequestError('declaredByMethod must be bearer or cookie');
    }

    const paramsJson = canonicalParamsJson(input.params);
    assertBodyHasNoReservedMarker(JSON.parse(paramsJson).body);
    const hash = paramsHash(paramsJson);
    const rawReissuesActionId = input.reissuesActionId ?? input.reissues_action_id ?? null;
    if (
      rawReissuesActionId !== null
      && (typeof rawReissuesActionId !== 'string' || rawReissuesActionId.length === 0)
    ) {
      throw new BadRequestError('reissuesActionId must be a string');
    }
    const reissuesActionId = rawReissuesActionId;
    const existing = stmts.getByIntent.get(taskId, actionSlot);
    if (existing) {
      if (
        existing.connector !== connector
        || existing.operation !== operation
        || existing.params_hash !== hash
        || existing.reissues_action_id !== reissuesActionId
      ) {
        throw new ConflictError(`action intent ${taskId}/${actionSlot} was declared differently`);
      }
      return existing;
    }

    const id = String(actionIdFactory());
    const createdAt = nowIso();
    stmts.insertAction.run(
      id,
      taskId,
      actionSlot,
      connector,
      operation,
      paramsJson,
      hash,
      createdAt,
      reissuesActionId,
      declaredByMethod,
    );
    insertEvent(id, { phase: 'action.declared', requestDigest: hash }, createdAt);
    return stmts.getAction.get(id);
  });

  const approveTx = db.transaction((id, approval) => {
    requiredString(id, 'id');
    const expectedParamsHash = requiredString(
      approval.expectedParamsHash ?? approval.expected_params_hash,
      'expectedParamsHash',
    );
    const approvedBy = requiredString(
      approval.approvedBy ?? approval.approved_by,
      'approvedBy',
    );
    const authMethod = approval.authMethod
      ?? approval.approvalAuthMethod
      ?? approval.approval_auth_method;
    if (authMethod !== 'cookie') {
      throw new ForbiddenError('actions may only be approved with cookie authentication');
    }
    const policyVersion = requiredString(
      approval.policyVersion ?? approval.approvalPolicyVersion ?? approval.approval_policy_version,
      'approvalPolicyVersion',
    );
    const approvedAt = nowIso();
    const expiresAt = timestamp(
      approval.expiresAt ?? approval.approvalExpiresAt ?? approval.approval_expires_at,
      'approvalExpiresAt',
    );
    if (new Date(expiresAt).getTime() <= new Date(approvedAt).getTime()) {
      throw new BadRequestError('approvalExpiresAt must be in the future');
    }
    const current = stmts.getAction.get(id);
    if (!current) return null;
    if (current.params_hash !== expectedParamsHash) {
      throw new ConflictError('action params changed after they were reviewed');
    }

    const info = stmts.approve.run({
      id,
      expected_params_hash: expectedParamsHash,
      approved_at: approvedAt,
      approved_by: approvedBy,
      approval_policy_version: policyVersion,
      approval_expires_at: expiresAt,
    });
    if (info.changes !== 1) return null;
    const row = stmts.getAction.get(id);
    insertEvent(id, {
      phase: 'approval.queued',
      requestDigest: row.params_hash,
      receipt: {
        approved_at: row.approved_at,
        approved_by: row.approved_by,
        approval_auth_method: row.approval_auth_method,
        approved_params_hash: row.approved_params_hash,
        approval_policy_version: row.approval_policy_version,
        approval_expires_at: row.approval_expires_at,
      },
    }, approvedAt);
    return row;
  });

  function appendExpiryEvent(row, expiredAt) {
    insertEvent(row.id, {
      phase: 'approval.expired',
      requestDigest: row.params_hash,
      receipt: {
        approved_at: row.approved_at,
        approved_by: row.approved_by,
        approval_auth_method: row.approval_auth_method,
        approved_params_hash: row.approved_params_hash,
        approval_policy_version: row.approval_policy_version,
        approval_expires_at: row.approval_expires_at,
      },
    }, expiredAt);
  }

  const claimTx = db.transaction((id) => {
    requiredString(id, 'id');
    const claimedAt = nowIso();
    const current = stmts.getAction.get(id);
    if (current && stmts.expireOne.run(id, claimedAt).changes === 1) {
      appendExpiryEvent(current, claimedAt);
      return null;
    }
    if (
      !current
      || current.status !== 'queued'
      || current.approved_params_hash !== current.params_hash
    ) {
      return null;
    }

    const attemptId = String(attemptIdFactory());
    const info = stmts.claim.run({ id, attempt_id: attemptId, claimed_at: claimedAt });
    if (info.changes !== 1) return null;
    const row = stmts.getAction.get(id);
    insertEvent(id, {
      attemptId,
      phase: 'execution.claimed',
      requestDigest: row.params_hash,
    }, claimedAt);
    return attemptId;
  });

  const claimForReconcileTx = db.transaction((id, reconcileOptions = {}) => {
    requiredString(id, 'id');
    const claimedAt = reconcileOptions.now === undefined
      ? nowIso()
      : timestamp(reconcileOptions.now, 'now');
    const current = stmts.getAction.get(id);
    if (!current || current.status !== 'unknown') return null;

    const attemptId = String(attemptIdFactory());
    const info = stmts.claimForReconcile.run({
      id,
      attempt_id: attemptId,
      claimed_at: claimedAt,
    });
    if (info.changes !== 1) return null;
    const row = stmts.getAction.get(id);
    insertEvent(id, {
      attemptId,
      phase: 'reconcile.claimed',
      requestDigest: row.params_hash,
    }, claimedAt);
    return attemptId;
  });

  const claimForRepairTx = db.transaction((id, repairOptions = {}) => {
    requiredString(id, 'id');
    const claimedAt = repairOptions.now === undefined
      ? nowIso()
      : timestamp(repairOptions.now, 'now');
    const maxRepairAttempts = Number(repairOptions.maxRepairAttempts);
    if (!Number.isSafeInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
      throw new BadRequestError('maxRepairAttempts must be a non-negative integer');
    }
    const current = stmts.getAction.get(id);
    const retryAt = new Date(current && current.next_repair_at).getTime();
    const claimTime = new Date(claimedAt).getTime();
    const eligible = current && (
      current.status === 'partially_applied'
      || (
        current.status === 'repair_retry_wait'
        && current.next_repair_at !== null
        && Number.isFinite(retryAt)
        && retryAt <= claimTime
      )
    );
    if (!eligible) return null;

    let blockReason = null;
    if (current.repair_attempts >= maxRepairAttempts) {
      blockReason = 'max_attempts';
    } else {
      const expiresAt = new Date(current.approval_expires_at).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= claimTime) {
        blockReason = 'approval_expired';
      }
    }
    if (blockReason !== null) {
      const info = stmts.blockRepair.run({ id, claimed_at: claimedAt });
      if (info.changes !== 1) return null;
      insertEvent(id, {
        phase: 'repair.blocked',
        requestDigest: current.params_hash,
        receipt: { reason: blockReason },
      }, claimedAt);
      return { blocked: true, reason: blockReason };
    }

    const attemptId = String(attemptIdFactory());
    const info = stmts.claimForRepair.run({
      id,
      attempt_id: attemptId,
      claimed_at: claimedAt,
      max_repair_attempts: maxRepairAttempts,
    });
    if (info.changes !== 1) return null;
    const row = stmts.getAction.get(id);
    insertEvent(id, {
      attemptId,
      phase: 'repair.claimed',
      requestDigest: row.params_hash,
      receipt: { repair_attempts: row.repair_attempts },
    }, claimedAt);
    return attemptId;
  });

  const expireTx = db.transaction(() => {
    const expiredAt = nowIso();
    const candidates = stmts.expiredQueued.all(expiredAt);
    let count = 0;
    for (const row of candidates) {
      if (stmts.expireOne.run(row.id, expiredAt).changes !== 1) continue;
      appendExpiryEvent(row, expiredAt);
      count += 1;
    }
    return count;
  });

  const recordExecutionResultTx = db.transaction((input) => {
    const id = requiredString(input.id ?? input.actionId ?? input.action_id, 'id');
    const attemptId = requiredString(input.attemptId ?? input.attempt_id, 'attemptId');
    const targetStatus = input.status ?? 'executing';
    if (!EXECUTION_RESULT_STATUSES.has(targetStatus)) {
      throw new BadRequestError(`invalid execution result status: ${targetStatus}`);
    }
    const event = input.event || {};
    const receiptValue = input.receipt ?? input.receipt_json;
    const errorValue = input.error ?? input.lastError ?? input.last_error;
    const nextReconcileAt = input.nextReconcileAt ?? input.next_reconcile_at;
    const externalId = input.externalId ?? input.external_id;
    const externalNodeId = input.externalNodeId ?? input.external_node_id;
    const verdict = input.verdict;
    const params = {
      id,
      attempt_id: attemptId,
      target_status: targetStatus,
      has_external_id: externalId !== undefined ? 1 : 0,
      external_id: externalId ?? null,
      has_external_node_id: externalNodeId !== undefined ? 1 : 0,
      external_node_id: externalNodeId ?? null,
      has_receipt: receiptValue !== undefined ? 1 : 0,
      receipt_json: jsonOrNull(receiptValue),
      has_error: errorValue !== undefined ? 1 : 0,
      last_error: errorValue == null ? null : String(errorValue),
      has_next_reconcile_at: nextReconcileAt !== undefined ? 1 : 0,
      next_reconcile_at: nextReconcileAt ?? null,
      has_verdict: verdict !== undefined ? 1 : 0,
      verdict: verdict ?? null,
    };
    const info = stmts.recordExecutionResult.run(params);
    const existing = stmts.getAction.get(id);
    if (!existing) return false;
    insertEvent(id, {
      attemptId,
      phase: info.changes === 1
        ? (event.phase || 'execution.result')
        : 'execution.result.stale',
      requestDigest: event.requestDigest ?? event.request_digest ?? null,
      transportClass: event.transportClass ?? event.transport_class ?? null,
      externalRequestId: event.externalRequestId ?? event.external_request_id ?? null,
      candidateExternalId: event.candidateExternalId
        ?? event.candidate_external_id
        ?? externalNodeId
        ?? null,
      receipt: event.receipt ?? event.receipt_json ?? receiptValue ?? null,
      error: event.error ?? errorValue ?? null,
    });
    return info.changes === 1;
  });

  const recordReconcileResultTx = db.transaction((input) => {
    const id = requiredString(input.id ?? input.actionId ?? input.action_id, 'id');
    const attemptId = requiredString(input.attemptId ?? input.attempt_id, 'attemptId');
    const targetStatus = input.status;
    if (!RECONCILE_RESULT_STATUSES.has(targetStatus)) {
      throw new BadRequestError(`invalid reconcile result status: ${targetStatus}`);
    }
    const event = input.event || {};
    const receiptValue = input.receipt ?? input.receipt_json;
    const nextReconcileValue = input.nextReconcileAt ?? input.next_reconcile_at;
    const nextReconcileAt = targetStatus === 'unknown'
      ? timestamp(nextReconcileValue, 'nextReconcileAt')
      : null;
    const externalId = input.externalId ?? input.external_id;
    const externalNodeId = input.externalNodeId ?? input.external_node_id;
    const verdict = input.verdict;
    const params = {
      id,
      attempt_id: attemptId,
      target_status: targetStatus,
      has_external_id: externalId !== undefined ? 1 : 0,
      external_id: externalId ?? null,
      has_external_node_id: externalNodeId !== undefined ? 1 : 0,
      external_node_id: externalNodeId ?? null,
      has_receipt: receiptValue !== undefined ? 1 : 0,
      receipt_json: jsonOrNull(receiptValue),
      next_reconcile_at: nextReconcileAt,
      has_verdict: verdict !== undefined ? 1 : 0,
      verdict: verdict ?? null,
    };

    let info;
    let identityConflict = false;
    try {
      info = stmts.recordReconcileResult.run(params);
    } catch (error) {
      if (
        externalNodeId === undefined
        || !isExternalIdentityUniqueViolation(error)
      ) {
        throw error;
      }
      identityConflict = true;
      info = stmts.recordReconcileResult.run({
        ...params,
        target_status: 'conflict',
        has_external_id: 0,
        external_id: null,
        has_external_node_id: 0,
        external_node_id: null,
        next_reconcile_at: null,
        has_verdict: 1,
        verdict: JSON.stringify({
          status: 'conflict',
          reason: 'external_identity_conflict',
        }),
      });
    }

    const existing = stmts.getAction.get(id);
    if (!existing) return false;
    insertEvent(id, {
      attemptId,
      phase: info.changes !== 1
        ? 'reconcile.result.stale'
        : (identityConflict ? 'reconcile.conflict' : (event.phase || 'reconcile.result')),
      requestDigest: event.requestDigest ?? event.request_digest ?? null,
      transportClass: event.transportClass ?? event.transport_class ?? null,
      externalRequestId: event.externalRequestId ?? event.external_request_id ?? null,
      candidateExternalId: event.candidateExternalId
        ?? event.candidate_external_id
        ?? externalNodeId
        ?? null,
      receipt: event.receipt ?? event.receipt_json ?? receiptValue ?? null,
      error: event.error ?? null,
    });
    return info.changes === 1;
  });

  const recoverOrphansTx = db.transaction((input = {}) => {
    const leaseTtlMs = Number(input.leaseTtlMs ?? input.lease_ttl_ms);
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs < 0) {
      throw new BadRequestError('leaseTtlMs must be a non-negative number');
    }
    const recoveredAt = input.now === undefined ? nowIso() : timestamp(input.now, 'now');
    const candidates = stmts.orphanCandidates.all({
      now: recoveredAt,
      lease_ttl_ms: leaseTtlMs,
    });
    let count = 0;
    for (const row of candidates) {
      const info = stmts.recoverOrphan.run({
        id: row.id,
        status: row.status,
        attempt_id: row.active_attempt_id,
        claimed_at: row.claimed_at,
        now: recoveredAt,
        lease_ttl_ms: leaseTtlMs,
      });
      if (info.changes !== 1) continue;
      insertEvent(row.id, {
        attemptId: row.active_attempt_id,
        phase: 'orphan.recovered',
        requestDigest: row.params_hash,
        receipt: { orphaned_status: row.status },
      }, recoveredAt);
      count += 1;
    }
    return count;
  });

  const recordRepairResultTx = db.transaction((input) => {
    const id = requiredString(input.id ?? input.actionId ?? input.action_id, 'id');
    const attemptId = requiredString(input.attemptId ?? input.attempt_id, 'attemptId');
    const targetStatus = input.status;
    if (!REPAIR_RESULT_STATUSES.has(targetStatus)) {
      throw new BadRequestError('invalid repair result status: ' + targetStatus);
    }
    const event = input.event || {};
    const receiptValue = input.receipt ?? input.receipt_json;
    const errorValue = input.error ?? input.lastError ?? input.last_error;
    const verdict = input.verdict;
    const rawNextRepairAt = input.nextRepairAt ?? input.next_repair_at;
    const rawNextReconcileAt = input.nextReconcileAt ?? input.next_reconcile_at;
    const nextRepairAt = targetStatus === 'repair_retry_wait'
      ? timestamp(rawNextRepairAt, 'nextRepairAt')
      : null;
    const nextReconcileAt = targetStatus === 'unknown'
      ? timestamp(rawNextReconcileAt, 'nextReconcileAt')
      : null;
    const info = stmts.recordRepairResult.run({
      id,
      attempt_id: attemptId,
      target_status: targetStatus,
      has_receipt: receiptValue !== undefined ? 1 : 0,
      receipt_json: jsonOrNull(receiptValue),
      has_error: errorValue !== undefined ? 1 : 0,
      last_error: errorValue == null ? null : String(errorValue),
      has_verdict: verdict !== undefined ? 1 : 0,
      verdict: verdict ?? null,
      next_repair_at: nextRepairAt,
      next_reconcile_at: nextReconcileAt,
    });
    const existing = stmts.getAction.get(id);
    if (!existing) return false;
    insertEvent(id, {
      attemptId,
      phase: info.changes === 1 ? (event.phase || 'repair.result') : 'repair.result.stale',
      requestDigest: event.requestDigest ?? event.request_digest ?? null,
      transportClass: event.transportClass ?? event.transport_class ?? null,
      candidateExternalId: event.candidateExternalId
        ?? event.candidate_external_id
        ?? existing.external_node_id
        ?? null,
      receipt: event.receipt ?? event.receipt_json ?? receiptValue ?? null,
      error: event.error ?? errorValue ?? null,
    });
    return info.changes === 1;
  });

  return {
    clock,
    declareAction: (input) => publicMutation(() => declareTx(input)),
    approveAction: (id, approval) => publicMutation(() => approveTx(id, approval || {})),
    claimForExecution: (id) => publicMutation(() => claimTx(id)),
    recordExecutionResult: (input) => publicMutation(() => recordExecutionResultTx(input)),
    claimForReconcile: (id, reconcileOptions) => publicMutation(
      () => claimForReconcileTx(id, reconcileOptions || {}),
    ),
    recordReconcileResult: (input) => publicMutation(() => recordReconcileResultTx(input)),
    claimForRepair: (id, repairOptions) => publicMutation(
      () => claimForRepairTx(id, repairOptions || {}),
    ),
    recordRepairResult: (input) => publicMutation(() => recordRepairResultTx(input)),
    recoverOrphans: (input) => publicMutation(() => recoverOrphansTx(input || {})),
    expireStaleApprovals: () => publicMutation(() => expireTx()),
    appendEvent: (actionId, event) => publicMutation(() => insertEvent(actionId, event)),
    getAction: (id) => stmts.getAction.get(id) || null,
    getActionByIntent: (taskId, actionSlot) => stmts.getByIntent.get(taskId, actionSlot) || null,
    listActions: () => stmts.listActions.all(),
    listReconcilableActionIds: (input = {}) => {
      const asOf = input.now === undefined ? nowIso() : timestamp(input.now, 'now');
      return stmts.listReconcilableActionIds.all({ now: asOf }).map((row) => row.id);
    },
    listRepairableActionIds: (input = {}) => {
      const asOf = input.now === undefined ? nowIso() : timestamp(input.now, 'now');
      return stmts.listRepairableActionIds.all({ now: asOf }).map((row) => row.id);
    },
    listEvents: (actionId) => stmts.listEvents.all(actionId),
  };
}

module.exports = {
  createActionLedgerService,
  canonicalizeParams,
  canonicalParamsJson,
  paramsHash,
};
