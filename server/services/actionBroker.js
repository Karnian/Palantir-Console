'use strict';

const { sanitizeMessage } = require('../utils/errors');
const {
  buildOutgoingBody,
  classifyCreateOutcome,
  validateReadback,
} = require('./actionReadback');

const DEFAULT_RECONCILE_DELAY_MS = 60_000;
const SENSITIVE_KEY = /^(?:authorization|token|access[_-]?token|credential|credentials|password|secret|api[_-]?key)$/i;

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

function sanitizeIssueReceipt(issue) {
  return sanitizeValue({
    repo: issue && issue.repo,
    number: issue && issue.number,
    node_id: issue && issue.node_id,
    html_url: issue && issue.html_url,
    state: issue && issue.state,
    title: issue && issue.title,
    body: issue && issue.body,
    labels: issue && issue.labels,
  });
}

function serializeVerdict(verdict) {
  return JSON.stringify(sanitizeValue(verdict));
}

function createActionBroker({ ledger, gateway, clock, reconcileDelayMs = DEFAULT_RECONCILE_DELAY_MS }) {
  const effectiveClock = clock || ledger.clock;
  if (typeof effectiveClock !== 'function') {
    throw new TypeError('action broker requires a clock or a ledger with an exposed clock');
  }

  function nextReconcileAt() {
    const current = effectiveClock();
    const milliseconds = current instanceof Date ? current.getTime() : new Date(current).getTime();
    if (!Number.isFinite(milliseconds)) throw new TypeError('action broker clock is invalid');
    return new Date(milliseconds + reconcileDelayMs).toISOString();
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
      receipt: sanitizeIssueReceipt(issue),
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
