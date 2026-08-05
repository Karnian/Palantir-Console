'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const {
  BadRequestError,
  NotFoundError,
  sanitizeMessage,
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

const SENSITIVE_KEY = /(?:^|[_-])(?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|private[_-]?key)(?:$|[_-])/i;
const OPAQUE_SECRET = /^(?=.{24,}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9+/=_-]+$/;
const MAX_SUMMARY_DEPTH = 4;
const MAX_SUMMARY_ITEMS = 24;

function redactString(value, { opaque = false } = {}) {
  let text = sanitizeMessage(value);
  text = text
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/gi, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(
      /(["']?(?:token|secret|password|passphrase|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:token|secret)[-_:][A-Za-z0-9._~+/-]{4,}\b/gi, '[redacted]');
  return opaque && OPAQUE_SECRET.test(text) ? '[redacted]' : text;
}

function redactValue(value, key = '', depth = 0) {
  if (value === null || value === undefined) return null;
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(value, { opaque: true });
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_SUMMARY_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_SUMMARY_ITEMS)
      .map((item) => redactValue(item, '', depth + 1));
  }
  if (typeof value !== 'object') return redactString(String(value));

  const summary = Object.create(null);
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_SUMMARY_ITEMS)) {
    if (['__proto__', 'prototype', 'constructor'].includes(childKey)) continue;
    summary[childKey] = redactValue(childValue, childKey, depth + 1);
  }
  return summary;
}

function parseJsonSummary(value) {
  if (value === null || value === undefined) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return redactValue(parsed);
  } catch {
    return { summary: '[unavailable]' };
  }
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
    external_id: nullableString(row.external_id),
    external_node_id: nullableString(row.external_node_id),
    verdict: nullableString(row.verdict),
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
    external_request_id: nullableString(row.external_request_id),
    candidate_external_id: nullableString(row.candidate_external_id),
    ts: nullableString(row.ts),
    receipt: parseJsonSummary(row.receipt_json),
    error: row.error === null || row.error === undefined
      ? null
      : redactString(String(row.error), { opaque: true }),
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
};
