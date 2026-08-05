'use strict';

const { BadRequestError } = require('../utils/errors');

const RESERVED_MARKER_NAME = 'palantir-action-id';

function markerFor(actionId) {
  return `<!-- ${RESERVED_MARKER_NAME}: ${actionId} -->`;
}

function buildOutgoingBody(userBody, actionId) {
  return `${userBody}\n\n${markerFor(actionId)}`;
}

function assertBodyHasNoReservedMarker(userBody) {
  if (typeof userBody === 'string' && userBody.includes(RESERVED_MARKER_NAME)) {
    throw new BadRequestError(`${RESERVED_MARKER_NAME} is reserved for server use`);
  }
}

function statusCodeOf(value) {
  const status = value && (
    value.statusCode
    ?? value.status
    ?? (value.response && value.response.status)
  );
  const number = Number(status);
  return Number.isInteger(number) ? number : null;
}

function classifyCreateOutcome(behaviorOrError) {
  const value = behaviorOrError || {};
  const kind = value.kind || value.code || null;
  const statusCode = statusCodeOf(value);

  if (kind === 'ok') {
    return { transportClass: 'ok', issue: value.issue };
  }
  if (
    kind === 'server_error'
    || kind === 'timeout'
    || kind === 'response_lost'
    || kind === 'malformed'
  ) {
    return { transportClass: 'ambiguous' };
  }
  if (kind === 'not_found_repo' || kind === 'validation_error') {
    return { transportClass: 'permanent_no_effect' };
  }
  if (kind === 'rate_limited' || kind === 'abuse_denied') {
    return { transportClass: 'rate_limited' };
  }
  if (kind === 'permission_denied') {
    return { transportClass: 'permanent_no_effect' };
  }

  // A successful fake response is the created issue itself. Unknown failures
  // are classified conservatively because liveness is safer to sacrifice than
  // issuing a duplicate POST.
  if (kind === null && statusCode === null && value.number !== undefined) {
    return { transportClass: 'ok', issue: value };
  }
  if (statusCode !== null && statusCode >= 500) return { transportClass: 'ambiguous' };
  if (statusCode === 404 || statusCode === 422) {
    return { transportClass: 'permanent_no_effect' };
  }
  if (statusCode === 429) return { transportClass: 'rate_limited' };
  if (statusCode === 403) return { transportClass: 'permanent_no_effect' };
  return { transportClass: 'ambiguous' };
}

function labelName(label) {
  if (typeof label === 'string') return label;
  if (label && typeof label.name === 'string') return label.name;
  return null;
}

function validateReadback({ issue, expected }) {
  const requestedLabels = Array.isArray(expected.labels) ? expected.labels : [];
  const marker = markerFor(expected.actionId);
  const structuralMatch = Boolean(
    issue
    && typeof issue.body === 'string'
    && issue.body.includes(marker)
    && issue.body === buildOutgoingBody(expected.userBody, expected.actionId)
    && issue.repo === expected.repo
    && issue.title === expected.title
    && issue.state === 'open'
  );

  if (!structuralMatch) {
    return { status: 'unknown', reason: 'readback_mismatch' };
  }

  const actualLabels = new Set(
    (Array.isArray(issue.labels) ? issue.labels : [])
      .map(labelName)
      .filter((label) => label !== null)
      .map((label) => label.toLowerCase()),
  );
  const missingLabels = requestedLabels.filter(
    (label) => !actualLabels.has(label.toLowerCase()),
  );
  if (missingLabels.length > 0) {
    return {
      status: 'partially_applied',
      missingLabels,
      reason: 'missing_labels',
    };
  }

  return { status: 'succeeded', reason: 'full_readback_valid' };
}

module.exports = {
  RESERVED_MARKER_NAME,
  assertBodyHasNoReservedMarker,
  buildOutgoingBody,
  classifyCreateOutcome,
  markerFor,
  validateReadback,
};
