'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { BadRequestError, ConflictError, ForbiddenError } = require('../utils/errors');

const CONNECTOR = 'github';
const OPERATION = 'github.create_issue';
const EXECUTION_RESULT_STATUSES = new Set([
  'executing',
  'succeeded',
  'partially_applied',
  'failed',
  'unknown',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

  const sorted = {};
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
  for (const field of ['repo', 'title', 'body']) {
    if (typeof params[field] !== 'string') {
      throw new BadRequestError(`params.${field} must be a string`);
    }
  }
  if (params.labels !== undefined && !Array.isArray(params.labels)) {
    throw new BadRequestError('params.labels must be an array when present');
  }
  const labels = params.labels === undefined ? [] : params.labels;
  if (!labels.every((label) => typeof label === 'string')) {
    throw new BadRequestError('params.labels must contain only strings');
  }

  const withCanonicalFields = {
    ...params,
    repo: params.repo.normalize('NFC').toLowerCase(),
    title: params.title.normalize('NFC'),
    body: params.body.normalize('NFC'),
    labels: [...new Set(labels.map((label) => label.normalize('NFC')))].sort(),
  };
  return normalizeJsonValue(withCanonicalFields);
}

function canonicalParamsJson(params) {
  return JSON.stringify(canonicalizeParams(params));
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

function jsonOrNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function createActionLedgerService(db, options = {}) {
  const clock = options.clock || (() => new Date());
  const actionIdFactory = options.actionIdFactory || randomUUID;
  const attemptIdFactory = options.attemptIdFactory || randomUUID;

  const stmts = {
    getAction: db.prepare('SELECT * FROM actions WHERE id = ?'),
    getByIntent: db.prepare('SELECT * FROM actions WHERE task_id = ? AND action_slot = ?'),
    listActions: db.prepare('SELECT * FROM actions ORDER BY created_at, rowid'),
    listEvents: db.prepare('SELECT * FROM action_events WHERE action_id = ? ORDER BY id'),
    insertAction: db.prepare(`
      INSERT INTO actions (
        id, task_id, action_slot, connector, operation,
        params_json, params_hash, status, created_at, reissues_action_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?)
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
      WHERE id = @id AND status = 'awaiting_approval'
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

    const paramsJson = canonicalParamsJson(input.params);
    const hash = paramsHash(paramsJson);
    const existing = stmts.getByIntent.get(taskId, actionSlot);
    if (existing) {
      if (
        existing.connector !== connector
        || existing.operation !== operation
        || existing.params_hash !== hash
      ) {
        throw new ConflictError(`action intent ${taskId}/${actionSlot} was declared differently`);
      }
      return existing;
    }

    const id = String(actionIdFactory());
    const createdAt = nowIso();
    const reissuesActionId = input.reissuesActionId ?? input.reissues_action_id ?? null;
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
    );
    insertEvent(id, { phase: 'action.declared', requestDigest: hash }, createdAt);
    return stmts.getAction.get(id);
  });

  const approveTx = db.transaction((id, approval) => {
    requiredString(id, 'id');
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

    const info = stmts.approve.run({
      id,
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
        : (event.phase || 'execution.result.stale'),
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

  return {
    declareAction: (input) => declareTx(input),
    approveAction: (id, approval) => approveTx(id, approval || {}),
    claimForExecution: (id) => claimTx(id),
    recordExecutionResult: (input) => recordExecutionResultTx(input),
    expireStaleApprovals: () => expireTx(),
    appendEvent: (actionId, event) => insertEvent(actionId, event),
    getAction: (id) => stmts.getAction.get(id) || null,
    getActionByIntent: (taskId, actionSlot) => stmts.getByIntent.get(taskId, actionSlot) || null,
    listActions: () => stmts.listActions.all(),
    listEvents: (actionId) => stmts.listEvents.all(actionId),
  };
}

module.exports = {
  createActionLedgerService,
  canonicalizeParams,
  canonicalParamsJson,
  paramsHash,
};
