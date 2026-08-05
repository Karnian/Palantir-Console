'use strict';

const { sanitizeMessage } = require('../utils/errors');
const {
  buildOutgoingBody,
  classifyCreateOutcome,
  markerFor,
  validateReadback,
} = require('./actionReadback');

const DEFAULT_RECONCILE_DELAY_MS = 60_000;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
const DEFAULT_REPAIR_BACKOFF_MS = 60_000;
const SENSITIVE_KEY = /^(?:authorization|token|access[_-]?token|credential|credentials|password|secret|api[_-]?key)$/i;
const MAX_RECEIPT_LABELS = 100;
const MAX_RECEIPT_LABEL_BYTES = 256;
const MAX_RECEIPT_ID_BYTES = 2_048;
const RECEIPT_BYTE_BUDGET = 16_384;

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

function boundedString(value, maxBytes) {
  if (typeof value !== 'string') return null;
  const redacted = redactString(value);
  let byteLength = 0;
  let bounded = '';
  for (const character of redacted) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteLength + characterBytes > maxBytes) break;
    bounded += character;
    byteLength += characterBytes;
  }
  return bounded;
}

function receiptLabelName(label) {
  if (typeof label === 'string') return label;
  if (label && typeof label.name === 'string') return label.name;
  return null;
}

function sanitizeIssueReceipt(issue, validatedAt) {
  const candidate = issue && typeof issue === 'object' ? issue : {};
  const sourceLabels = Array.isArray(candidate.labels) ? candidate.labels : [];
  const labels = sourceLabels
    .slice(0, MAX_RECEIPT_LABELS)
    .map(receiptLabelName)
    .filter((label) => label !== null)
    .map((label) => boundedString(label, MAX_RECEIPT_LABEL_BYTES));
  const receipt = {
    number: Number.isSafeInteger(candidate.number) && candidate.number > 0
      ? candidate.number
      : null,
    node_id: boundedString(candidate.node_id, MAX_RECEIPT_ID_BYTES),
    html_url: boundedString(candidate.html_url, MAX_RECEIPT_ID_BYTES),
    state: boundedString(candidate.state, 64),
    labels,
    label_count: sourceLabels.length,
    labels_truncated: sourceLabels.length > labels.length,
    validated_at: boundedString(validatedAt, 128),
  };
  while (
    receipt.labels.length > 0
    && Buffer.byteLength(JSON.stringify(receipt), 'utf8') >= RECEIPT_BYTE_BUDGET
  ) {
    receipt.labels.pop();
    receipt.labels_truncated = true;
  }
  return receipt;
}

function serializeVerdict(verdict) {
  return JSON.stringify(sanitizeValue(verdict));
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

function classifyRepairOutcome(value) {
  return classifyCreateOutcome(value);
}

function createActionBroker({
  ledger,
  gateway,
  clock,
  reconcileDelayMs = DEFAULT_RECONCILE_DELAY_MS,
  maxRepairAttempts: configuredMaxRepairAttempts = DEFAULT_MAX_REPAIR_ATTEMPTS,
  repairBackoffMs: configuredRepairBackoffMs = DEFAULT_REPAIR_BACKOFF_MS,
}) {
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

  function delayedIso(baseNow, delayMs) {
    const baseMs = baseNow === undefined ? nowMilliseconds() : new Date(baseNow).getTime();
    if (!Number.isFinite(baseMs)) throw new TypeError('repair base time is invalid');
    return new Date(baseMs + delayMs).toISOString();
  }

  function repairExpected(action, params) {
    return {
      actionId: action.id,
      repo: params.repo,
      title: params.title,
      userBody: params.body,
      labels: params.labels,
    };
  }

  function repairIssueLocator(action, params) {
    let external = null;
    try {
      external = JSON.parse(action.external_id);
    } catch {
      return null;
    }
    if (!external || !Number.isSafeInteger(external.number) || external.number <= 0) return null;
    return {
      repo: typeof external.repo === 'string' ? external.repo : params.repo,
      number: external.number,
      node_id: action.external_node_id || undefined,
    };
  }

  async function repairClaimedAction({
    action,
    attemptId,
    now: repairNow,
    maxRepairAttempts = configuredMaxRepairAttempts,
    backoffMs = configuredRepairBackoffMs,
  }) {
    const current = typeof ledger.getAction === 'function' ? ledger.getAction(action.id) : action;
    if (!current || current.status !== 'repairing' || current.active_attempt_id !== attemptId) {
      return { status: 'stale' };
    }
    const limit = Number(maxRepairAttempts);
    const delay = Number(backoffMs);
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new TypeError('maxRepairAttempts must be a non-negative integer');
    }
    if (!Number.isFinite(delay) || delay < 0) {
      throw new TypeError('backoffMs must be a non-negative number');
    }
    const params = JSON.parse(action.params_json);
    const locator = repairIssueLocator(action, params);
    const reconcileAt = () => delayedIso(repairNow, reconcileDelayMs);
    const retryAt = () => delayedIso(repairNow, delay);
    const expected = repairExpected(action, params);
    const recordOutcome = (status, input) => ({
      status: ledger.recordRepairResult(input) ? status : 'stale',
    });
    const retryOrBlock = ({
      retryReason,
      receipt,
      error,
      transportClass,
      verdict = {},
    }) => {
      const canRetry = Number(current.repair_attempts) < limit;
      const status = canRetry ? 'repair_retry_wait' : 'repair_blocked';
      return recordOutcome(status, {
        id: action.id,
        attemptId,
        status,
        receipt,
        error,
        nextRepairAt: canRetry ? retryAt() : undefined,
        verdict: serializeVerdict({
          ...verdict,
          status,
          reason: canRetry ? retryReason : 'max_attempts',
        }),
        event: {
          phase: canRetry ? 'repair.retry_wait' : 'repair.blocked',
          transportClass,
        },
      });
    };

    const recordUnknown = (error, receipt, reason = 'ambiguous_repair') => {
      return recordOutcome('unknown', {
        id: action.id,
        attemptId,
        status: 'unknown',
        receipt,
        error: error ? sanitizeError(error) : undefined,
        nextReconcileAt: reconcileAt(),
        verdict: serializeVerdict({ status: 'unknown', reason }),
        event: { phase: 'repair.unknown', transportClass: 'ambiguous' },
      });
    };

    if (locator === null) return recordUnknown(null, undefined, 'invalid_external_identity');
    let initialIssue;
    try {
      initialIssue = await gateway.getIssue(locator);
    } catch (error) {
      return recordUnknown(error);
    }
    const initialReceipt = sanitizeIssueReceipt(initialIssue, nowIso());
    const initialVerdict = validateReadback({ issue: initialIssue, expected });
    if (initialVerdict.status === 'unknown') {
      return recordUnknown(null, initialReceipt, initialVerdict.reason);
    }
    if (initialVerdict.status === 'succeeded') {
      return recordOutcome('succeeded', {
        id: action.id,
        attemptId,
        status: 'succeeded',
        receipt: initialReceipt,
        verdict: serializeVerdict(initialVerdict),
        event: { phase: 'repair.succeeded', transportClass: 'ok' },
      });
    }

    let updatedIssue;
    let addError = null;
    try {
      updatedIssue = await gateway.addLabels({
        repo: locator.repo,
        number: locator.number,
        labels: initialVerdict.missingLabels,
      });
    } catch (error) {
      addError = error;
    }
    const addOutcome = classifyRepairOutcome(addError || updatedIssue);
    if (addOutcome.transportClass === 'permanent_no_effect') {
      return recordOutcome('repair_blocked', {
        id: action.id,
        attemptId,
        status: 'repair_blocked',
        receipt: initialReceipt,
        error: sanitizeError(addError),
        verdict: serializeVerdict({ status: 'repair_blocked', reason: 'permanent_denial' }),
        event: { phase: 'repair.blocked', transportClass: addOutcome.transportClass },
      });
    }
    if (addOutcome.transportClass === 'rate_limited') {
      return retryOrBlock({
        retryReason: 'rate_limited',
        receipt: initialReceipt,
        error: sanitizeError(addError),
        transportClass: addOutcome.transportClass,
      });
    }
    if (addOutcome.transportClass === 'ambiguous') return recordUnknown(addError, initialReceipt);

    let readback;
    try {
      readback = await gateway.getIssue(locator);
    } catch (error) {
      return recordUnknown(error, initialReceipt);
    }
    const receipt = sanitizeIssueReceipt(readback, nowIso());
    const verdict = validateReadback({ issue: readback, expected });
    if (verdict.status === 'succeeded') {
      return recordOutcome('succeeded', {
        id: action.id,
        attemptId,
        status: 'succeeded',
        receipt,
        verdict: serializeVerdict(verdict),
        event: { phase: 'repair.succeeded', transportClass: 'ok' },
      });
    }
    if (verdict.status === 'partially_applied') {
      return retryOrBlock({
        retryReason: 'still_missing_labels',
        receipt,
        transportClass: 'ok',
        verdict,
      });
    }
    return recordUnknown(null, receipt, verdict.reason);
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

    if (!hasValidExternalIdentity(issue)) {
      const readbackError = {
        name: 'GatewayProtocolError',
        kind: 'malformed',
        message: 'getIssue returned a malformed external identity',
      };
      ledger.recordExecutionResult({
        id: action.id,
        attemptId,
        status: 'unknown',
        error: sanitizeError(readbackError),
        nextReconcileAt: nextReconcileAt(),
        event: { phase: 'readback.unknown', transportClass: 'ambiguous' },
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

  async function reconcileClaimedAction({ action, attemptId }) {
    const current = typeof ledger.getAction === 'function' ? ledger.getAction(action.id) : action;
    if (
      current
      && (current.status !== 'reconciling' || current.active_attempt_id !== attemptId)
    ) {
      return { status: 'stale' };
    }

    const params = JSON.parse(action.params_json);
    const expected = {
      repo: params.repo,
      title: params.title,
      userBody: params.body,
      actionId: action.id,
      labels: params.labels,
    };

    function persistResult({ status, verdict, issue, error, event = {} }) {
      const won = ledger.recordReconcileResult({
        id: action.id,
        attemptId,
        status,
        externalId: issue === undefined
          ? undefined
          : JSON.stringify(sanitizeValue({
            repo: issue.repo,
            number: issue.number,
            html_url: issue.html_url,
          })),
        externalNodeId: issue === undefined ? undefined : issue.node_id,
        receipt: issue === undefined ? undefined : sanitizeIssueReceipt(issue, nowIso()),
        verdict: serializeVerdict(verdict),
        nextReconcileAt: status === 'unknown' ? nextReconcileAt() : undefined,
        event: {
          ...event,
          phase: event.phase || `reconcile.${status}`,
          error: error === undefined ? event.error : sanitizeError(error),
        },
      });
      if (!won) return { status: 'stale' };
      const persisted = typeof ledger.getAction === 'function'
        ? ledger.getAction(action.id)
        : null;
      if (persisted && persisted.status !== status) {
        return {
          status: persisted.status,
          reason: persisted.status === 'conflict'
            ? 'external_identity_conflict'
            : 'persisted_status_changed',
        };
      }
      return verdict;
    }

    let candidates;
    try {
      candidates = await gateway.searchIssuesByMarker({
        repo: params.repo,
        marker: markerFor(action.id),
      });
      if (!Array.isArray(candidates)) {
        throw new TypeError('searchIssuesByMarker must return an array');
      }
    } catch (error) {
      return persistResult({
        status: 'unknown',
        verdict: { status: 'unknown', reason: 'search_fault' },
        error,
        event: { phase: 'reconcile.unknown', transportClass: 'ambiguous' },
      });
    }

    const validMatches = [];
    let sawAmbiguousCandidate = false;
    for (const candidate of candidates) {
      let issue;
      try {
        issue = await gateway.getIssue({
          repo: params.repo,
          number: candidate && candidate.number,
          node_id: candidate && candidate.node_id,
        });
      } catch (error) {
        return persistResult({
          status: 'unknown',
          verdict: { status: 'unknown', reason: 'candidate_get_fault' },
          error,
          event: { phase: 'reconcile.unknown', transportClass: 'ambiguous' },
        });
      }
      if (!hasValidExternalIdentity(issue)) {
        sawAmbiguousCandidate = true;
        continue;
      }
      const verdict = validateReadback({ issue, expected });
      if (verdict.status === 'succeeded' || verdict.status === 'partially_applied') {
        validMatches.push({ issue, verdict });
      } else {
        sawAmbiguousCandidate = true;
      }
    }

    if (validMatches.length > 1) {
      return persistResult({
        status: 'conflict',
        verdict: {
          status: 'conflict',
          reason: 'ambiguous_candidates',
          candidateCount: validMatches.length,
        },
      });
    }
    if (sawAmbiguousCandidate) {
      return persistResult({
        status: 'unknown',
        verdict: { status: 'unknown', reason: 'ambiguous_candidate' },
      });
    }
    if (validMatches.length === 1) {
      const match = validMatches[0];
      return persistResult({
        status: match.verdict.status,
        verdict: match.verdict,
        issue: match.issue,
      });
    }
    return persistResult({
      status: 'unknown',
      verdict: {
        status: 'unknown',
        reason: candidates.length === 0 ? 'search_empty' : 'no_valid_candidate',
      },
    });
  }

  async function driveReconciliation({ leaseTtlMs, now } = {}) {
    const driveDate = now === undefined ? new Date(nowMilliseconds()) : new Date(now);
    if (!Number.isFinite(driveDate.getTime())) {
      throw new TypeError('driveReconciliation now is invalid');
    }
    const driveNow = driveDate.toISOString();
    const summary = {
      recovered: ledger.recoverOrphans({ leaseTtlMs, now: driveNow }),
      claimed: 0,
      outcomes: {
        succeeded: 0,
        partially_applied: 0,
        conflict: 0,
        unknown: 0,
        stale: 0,
      },
    };

    const eligibleIds = ledger.listReconcilableActionIds({ now: driveNow });
    for (const id of eligibleIds) {
      const attemptId = ledger.claimForReconcile(id, { now: driveNow });
      if (attemptId === null) continue;
      summary.claimed += 1;
      const outcome = await reconcileClaimedAction({
        action: ledger.getAction(id),
        attemptId,
      });
      if (Object.hasOwn(summary.outcomes, outcome.status)) {
        summary.outcomes[outcome.status] += 1;
      }
    }
    return summary;
  }

  async function driveRepair({
    now,
    maxRepairAttempts = configuredMaxRepairAttempts,
    backoffMs = configuredRepairBackoffMs,
  } = {}) {
    const driveNow = now === undefined ? nowIso() : new Date(now).toISOString();
    const ids = ledger.listRepairableActionIds({ now: driveNow });
    const summary = {
      scanned: ids.length,
      claimed: 0,
      blocked: 0,
      outcomes: {
        succeeded: 0,
        repair_blocked: 0,
        repair_retry_wait: 0,
        unknown: 0,
        stale: 0,
      },
    };
    for (const id of ids) {
      const claim = ledger.claimForRepair(id, { now: driveNow, maxRepairAttempts });
      if (claim && typeof claim === 'object' && claim.blocked === true) {
        summary.blocked += 1;
        summary.outcomes.repair_blocked += 1;
        continue;
      }
      if (claim === null) continue;
      summary.claimed += 1;
      const outcome = await repairClaimedAction({
        action: ledger.getAction(id),
        attemptId: claim,
        now: driveNow,
        maxRepairAttempts,
        backoffMs,
      });
      if (Object.hasOwn(summary.outcomes, outcome.status)) {
        summary.outcomes[outcome.status] += 1;
      }
    }
    return summary;
  }

  return {
    driveRepair,
    driveReconciliation,
    executeClaimedAction,
    repairClaimedAction,
    reconcileClaimedAction,
  };
}

module.exports = {
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_RECONCILE_DELAY_MS,
  DEFAULT_REPAIR_BACKOFF_MS,
  classifyRepairOutcome,
  createActionBroker,
  hasValidExternalIdentity,
  sanitizeIssueReceipt,
};
