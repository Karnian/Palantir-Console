'use strict';

const { sanitizeMessage } = require('../utils/errors');
const {
  buildOutgoingBody,
  classifyCreateOutcome,
  validateReadback,
} = require('./actionReadback');

const DEFAULT_RECONCILE_DELAY_MS = 60_000;
const SENSITIVE_KEY = /^(?:authorization|token|access[_-]?token|credential|credentials|password|secret|api[_-]?key)$/i;
const MAX_RECEIPT_LABELS = 100;
const MAX_RECEIPT_LABEL_LENGTH = 256;
const MAX_RECEIPT_ID_LENGTH = 2_048;

function redactString(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[redacted]');
}

function sanitizeValue(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
    const clean = {};
    for (const key of Object.keys(value).sort()) {
      clean[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeValue(value[key], seen);
    }
    return clean;
  } finally {
    seen.delete(value);
  }
}

function sanitizeError(error) {
  const clean = {
    name: redactString(error && error.name || 'Error'),
    kind: error && error.kind != null ? redactString(error.kind) : null,
    statusCode: Number.isInteger(error && error.statusCode) ? error.statusCode : null,
    code: error && error.code != null ? redactString(error.code) : null,
    message: sanitizeMessage(error && error.message || error),
  };
  return JSON.stringify(sanitizeValue(clean));
}

function boundedString(value, maxLength) {
  if (typeof value !== 'string') return null;
  return redactString(value).slice(0, maxLength);
}

function receiptLabelName(label) {
  if (typeof label === 'string') return label;
  if (label && typeof label.name === 'string') return label.name;
  return null;
}

function sanitizeIssueReceipt(issue, validatedAt) {
  const labels = (Array.isArray(issue && issue.labels) ? issue.labels : [])
    .map(receiptLabelName)
    .filter((label) => label !== null)
    .slice(0, MAX_RECEIPT_LABELS)
    .map((label) => boundedString(label, MAX_RECEIPT_LABEL_LENGTH));
  return {
    number: Number.isSafeInteger(issue && issue.number) && issue.number > 0
      ? issue.number
      : null,
    node_id: boundedString(issue.node_id, MAX_RECEIPT_ID_LENGTH),
    html_url: boundedString(issue.html_url, MAX_RECEIPT_ID_LENGTH),
    state: boundedString(issue.state, 64),
    labels,
    validated_at: validatedAt,
  };
}

function serializeVerdict(verdict) {
  return JSON.stringify(sanitizeValue(verdict));
}

function createActionBroker({ ledger, gateway, clock, reconcileDelayMs = DEFAULT_RECONCILE_DELAY_MS }) {
  const effectiveClock = clock || ledger.clock;
  if (typeof effectiveClock !== 'function') {
    throw new TypeError('action broker requires a clock or a ledger with an exposed clock');
  }

  function nowMilliseconds() {
    const current = effectiveClock();
    const milliseconds = current instanceof Date ? current.getTime() : new Date(current).getTime();
    if (!Number.isFinite(milliseconds)) throw new TypeError('action broker clock is invalid');
    return milliseconds;
  }

  function nowIso() {
    return new Date(nowMilliseconds()).toISOString();
  }

  function nextReconcileAt() {
    return new Date(nowMilliseconds() + reconcileDelayMs).toISOString();
  }

  function hasValidExternalIdentity(issue) {
    return Boolean(
      issue
      && Number.isSafeInteger(issue.number)
      && issue.number > 0
      && typeof issue.node_id === 'string'
      && issue.node_id.length > 0
      && typeof issue.html_url === 'string'
      && issue.html_url.length > 0
    );
  }

  async function executeClaimedAction({ action, attemptId }) {
    const current = typeof ledger.getAction === 'function' ? ledger.getAction(action.id) : action;
    if (
      current
      && (current.status !== 'executing' || current.active_attempt_id !== attemptId)
    ) {
      return { status: 'stale' };
    }

    const params = JSON.parse(action.params_json);
    const outgoingBody = buildOutgoingBody(params.body, action.id);
    let createdIssue;
    let createError = null;
    try {
      createdIssue = await gateway.createIssue({
        repo: params.repo,
        title: params.title,
        body: outgoingBody,
        labels: params.labels,
      });
    } catch (error) {
      createError = error;
    }

    const outcome = classifyCreateOutcome(createError || createdIssue);
    if (outcome.transportClass === 'permanent_no_effect') {
      ledger.recordExecutionResult({
        id: action.id,
        attemptId,
        status: 'failed',
        error: sanitizeError(createError),
        verdict: serializeVerdict({ reason: 'no_effect' }),
        event: { phase: 'execution.failed', transportClass: outcome.transportClass },
      });
      return { status: 'failed' };
    }
    if (outcome.transportClass === 'rate_limited') {
      ledger.recordExecutionResult({
        id: action.id,
        attemptId,
        status: 'failed',
        error: sanitizeError(createError),
        verdict: serializeVerdict({ reason: 'no_effect', rate_limited: true }),
        event: { phase: 'execution.failed', transportClass: outcome.transportClass },
      });
      return { status: 'failed' };
    }
    if (outcome.transportClass === 'ambiguous') {
      ledger.recordExecutionResult({
        id: action.id,
        attemptId,
        status: 'unknown',
        error: sanitizeError(createError),
        nextReconcileAt: nextReconcileAt(),
        event: { phase: 'execution.unknown', transportClass: outcome.transportClass },
      });
      return { status: 'unknown' };
    }

    createdIssue = outcome.issue;
    if (!hasValidExternalIdentity(createdIssue)) {
      const identityError = {
        name: 'GatewayProtocolError',
        kind: 'malformed',
        message: 'createIssue returned a malformed external identity',
      };
      ledger.recordExecutionResult({
        id: action.id,
        attemptId,
        status: 'unknown',
        error: sanitizeError(identityError),
        nextReconcileAt: nextReconcileAt(),
        event: { phase: 'execution.unknown', transportClass: 'ambiguous' },
      });
      return { status: 'unknown' };
    }
    const externalId = JSON.stringify(sanitizeValue({
      repo: createdIssue.repo,
      number: createdIssue.number,
      html_url: createdIssue.html_url,
    }));
    const dispatched = ledger.recordExecutionResult({
      id: action.id,
      attemptId,
      status: 'executing',
      externalId,
      externalNodeId: createdIssue.node_id,
      event: {
        phase: 'execution.dispatched',
        candidateExternalId: createdIssue.node_id,
      },
    });
    if (!dispatched) return { status: 'stale' };

    let issue;
    try {
      issue = await gateway.getIssue({
        repo: params.repo,
        number: createdIssue.number,
        node_id: createdIssue.node_id,
      });
    } catch (error) {
      ledger.recordExecutionResult({
        id: action.id,
        attemptId,
        status: 'unknown',
        error: sanitizeError(error),
        nextReconcileAt: nextReconcileAt(),
        event: { phase: 'readback.unknown' },
      });
      return { status: 'unknown' };
    }

    const verdict = validateReadback({
      issue,
      expected: {
        repo: params.repo,
        title: params.title,
        userBody: params.body,
        actionId: action.id,
        labels: params.labels,
      },
    });
    ledger.recordExecutionResult({
      id: action.id,
      attemptId,
      status: verdict.status,
      receipt: sanitizeIssueReceipt(issue, nowIso()),
      verdict: serializeVerdict(verdict),
      event: { phase: `execution.${verdict.status}` },
    });
    return verdict;
  }

  return { executeClaimedAction };
}

module.exports = {
  DEFAULT_RECONCILE_DELAY_MS,
  createActionBroker,
};
