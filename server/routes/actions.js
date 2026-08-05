'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const {
  BadRequestError,
  NotFoundError,
} = require('../utils/errors');

const ACTION_STATUSES = new Set([
  'awaiting_approval',
  'queued',
  'executing',
  'succeeded',
  'partially_applied',
  'failed',
  'unknown',
  'reconciling',
  'repairing',
  'repair_retry_wait',
  'repair_blocked',
  'conflict',
]);

const SENSITIVE_KEY_MARKERS = new Set([
  'secret',
  'token',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'authorization',
  'apikey',
  'accesskey',
  'accesskeyid',
  'secretkey',
  'privatekey',
  'clientsecret',
  'sessionkey',
  'sessiontoken',
  'bearer',
  'cookie',
  'signature',
]);
const EXACT_SENSITIVE_KEYS = new Set(['pw', 'pwd', 'pass', 'sig']);
const OPAQUE_SECRET = /^(?=.{24,}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9+/=_-]+$/;
const MAX_SUMMARY_STRING_LENGTH = 180;
const MAX_SUMMARY_DEPTH = 4;
const MAX_SUMMARY_ITEMS = 24;

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[\s_-]/g, '');
  if (EXACT_SENSITIVE_KEYS.has(normalized)) return true;
  for (const marker of SENSITIVE_KEY_MARKERS) {
    if (normalized.includes(marker)) return true;
  }
  return false;
}

function capSummaryString(text) {
  return text.length > MAX_SUMMARY_STRING_LENGTH
    ? text.slice(0, MAX_SUMMARY_STRING_LENGTH - 3) + '...'
    : text;
}

function redactString(value, { opaque = false, longRuns = false } = {}) {
  // This route is a primary redaction layer for the observability surface.
  // Free text still has an inherent residual: arbitrary prose secrets with no
  // marker and no recognized value format cannot be guaranteed to be found.
  // Structured receipt/verdict data avoids that class via allowlist projection.
  let text = String(value ?? '');
  text = text
    .replace(
      /\b(Basic|Bearer|Digest|Negotiate|Token)\s+[A-Za-z0-9+/=_.-]{8,}/gi,
      '$1 [redacted]',
    )
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gi, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ACCA)[0-9A-Z]{12,}\b/g, '[redacted]');
  if (longRuns) {
    text = text
      .replace(/[0-9a-fA-F]{40,}/g, '[redacted]')
      .replace(/[A-Za-z0-9+/=_-]{40,}/g, '[redacted]');
  }
  text = text
    // Redact each marked value through its line ending. The global flag keeps
    // later lines independently protected without consuming them wholesale.
    .replace(
      /(["']?\b(?:password|passwd|passphrase|secret|token|api[ \t_-]?key|access[ \t_-]?key|private[ \t_-]?key|secret[ \t_-]?key|client[ \t_-]?secret|credentials?|authorization|bearer|cookie|signature|basic)\b["']?[ \t]*[:=][ \t]*)[^\r\n]*/gim,
      '$1[redacted]',
    )
    .replace(/\b(?:token|secret)[-_:][A-Za-z0-9._~+/-]{4,}\b/gi, '[redacted]');
  if (opaque && OPAQUE_SECRET.test(text)) text = '[redacted]';
  return capSummaryString(text);
}

function redactValue(value, key = '', depth = 0) {
  if (isSensitiveKey(key)) return '[redacted]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_SUMMARY_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_SUMMARY_ITEMS)
      .map((item) => redactValue(item, '', depth + 1));
  }
  if (typeof value !== 'object') return redactString(String(value));

  const summary = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_SUMMARY_ITEMS)) {
    if (['__proto__', 'prototype', 'constructor'].includes(childKey)) continue;
    summary[childKey] = redactValue(childValue, childKey, depth + 1);
  }
  return summary;
}

function parsePlainJsonObject(value) {
  if (value === null || value === undefined) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const prototype = Object.getPrototypeOf(parsed);
    return prototype === Object.prototype || prototype === null ? parsed : null;
  } catch {
    return null;
  }
}

function projectReceiptWithFields(value, { includeEventEvidence = false } = {}) {
  const source = parsePlainJsonObject(value);
  if (!source) return null;
  const receipt = {};

  if (Number.isSafeInteger(source.number)) receipt.number = source.number;
  for (const key of ['node_id', 'html_url', 'state', 'validated_at']) {
    if (typeof source[key] === 'string') receipt[key] = source[key];
  }
  if (
    Array.isArray(source.labels)
    && source.labels.every((label) => typeof label === 'string')
  ) {
    receipt.labels = source.labels;
  }
  if (Number.isSafeInteger(source.label_count)) receipt.label_count = source.label_count;
  if (typeof source.labels_truncated === 'boolean') {
    receipt.labels_truncated = source.labels_truncated;
  }
  if (includeEventEvidence) {
    for (const key of [
      'approved_at',
      'approved_by',
      'approval_auth_method',
      'approved_params_hash',
      'approval_policy_version',
      'approval_expires_at',
      'status',
      'reason',
      'orphaned_status',
    ]) {
      if (typeof source[key] === 'string') receipt[key] = source[key];
    }
    if (
      Array.isArray(source.missingLabels)
      && source.missingLabels.every((label) => typeof label === 'string')
    ) {
      receipt.missingLabels = source.missingLabels;
    }
    if (typeof source.rate_limited === 'boolean') {
      receipt.rate_limited = source.rate_limited;
    }
    for (const key of ['candidateCount', 'candidate_count', 'repair_attempts']) {
      if (Number.isSafeInteger(source[key])) receipt[key] = source[key];
    }
  }

  return redactValue(receipt);
}

function projectReceipt(value) {
  return projectReceiptWithFields(value);
}

function projectEventReceipt(value) {
  return projectReceiptWithFields(value, { includeEventEvidence: true });
}

function projectVerdict(value) {
  const source = parsePlainJsonObject(value);
  if (!source) return null;
  const verdict = {};

  for (const key of ['status', 'reason']) {
    if (typeof source[key] === 'string') verdict[key] = source[key];
  }
  if (
    Array.isArray(source.missingLabels)
    && source.missingLabels.every((label) => typeof label === 'string')
  ) {
    verdict.missingLabels = source.missingLabels;
  }
  if (typeof source.rate_limited === 'boolean') verdict.rate_limited = source.rate_limited;
  for (const key of ['candidateCount', 'candidate_count']) {
    if (Number.isSafeInteger(source[key])) verdict[key] = source[key];
  }

  return redactValue(verdict);
}

function redactError(value) {
  return value === null || value === undefined
    ? null
    : redactString(value, { opaque: true, longRuns: true });
}

function paramsSummary(paramsJson) {
  const fallback = { repo: null, title: null, label_count: 0 };
  try {
    const params = typeof paramsJson === 'string' ? JSON.parse(paramsJson) : paramsJson;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return fallback;
    return {
      repo: typeof params.repo === 'string' ? redactString(params.repo) : null,
      title: typeof params.title === 'string' ? redactString(params.title) : null,
      label_count: Array.isArray(params.labels) ? params.labels.length : 0,
    };
  } catch {
    return fallback;
  }
}

function nullableString(value) {
  return value === null || value === undefined ? null : redactString(String(value));
}

function credentialIdentifier(value) {
  if (value === null || value === undefined) return null;
  // External identifiers are opaque by nature, so generic long-base64/hex
  // detection would destroy valid evidence (notably GitHub node IDs). Known
  // credential formats are still removed and the result is capped. A raw
  // high-entropy ID with no recognizable credential format is an accepted,
  // bounded residual.
  return redactString(String(value));
}

function projectAction(row) {
  return {
    id: nullableString(row.id),
    task_id: nullableString(row.task_id),
    action_slot: nullableString(row.action_slot),
    connector: nullableString(row.connector),
    operation: nullableString(row.operation),
    status: nullableString(row.status),
    created_at: nullableString(row.created_at),
    approved_at: nullableString(row.approved_at),
    approved_by: nullableString(row.approved_by),
    approval_auth_method: nullableString(row.approval_auth_method),
    approval_expires_at: nullableString(row.approval_expires_at),
    external_id: credentialIdentifier(row.external_id),
    external_node_id: credentialIdentifier(row.external_node_id),
    receipt: projectReceipt(row.receipt_json),
    error: redactError(row.last_error),
    verdict: projectVerdict(row.verdict),
    repair_attempts: Number.isSafeInteger(row.repair_attempts) ? row.repair_attempts : 0,
    next_reconcile_at: nullableString(row.next_reconcile_at),
    next_repair_at: nullableString(row.next_repair_at),
    reissues_action_id: nullableString(row.reissues_action_id),
    params_summary: paramsSummary(row.params_json),
  };
}

function projectEvent(row) {
  return {
    id: row.id,
    phase: nullableString(row.phase),
    attempt_id: nullableString(row.attempt_id),
    transport_class: nullableString(row.transport_class),
    request_digest: nullableString(row.request_digest),
    external_request_id: credentialIdentifier(row.external_request_id),
    candidate_external_id: credentialIdentifier(row.candidate_external_id),
    ts: nullableString(row.ts),
    receipt: projectEventReceipt(row.receipt_json),
    error: redactError(row.error),
  };
}

function createActionsRouter({ ledger }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { status } = req.query;
    if (status !== undefined && (typeof status !== 'string' || !ACTION_STATUSES.has(status))) {
      throw new BadRequestError('Unknown action status');
    }

    const actions = ledger.listActions()
      .filter((action) => status === undefined || action.status === status)
      .slice()
      .reverse()
      .map(projectAction);
    res.json({ actions });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const action = ledger.getAction(req.params.id);
    if (!action) throw new NotFoundError('Action not found');
    const events = ledger.listEvents(action.id).map(projectEvent);
    res.json({ action: projectAction(action), events });
  }));

  return router;
}

module.exports = {
  ACTION_STATUSES,
  createActionsRouter,
  projectAction,
  projectEvent,
  projectEventReceipt,
  projectReceipt,
  projectVerdict,
};
