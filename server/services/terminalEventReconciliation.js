'use strict';

// SQL correlates by invocation and boolean terminality before applying this
// bound. Oldest-first ordering preserves the live CAS path's first-event-wins
// contract while keeping JSON.parse work bounded on every reconciliation.
const MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES = 8;
const MAX_TERMINAL_ERROR_LENGTH = 2000;

function parseTerminalEventPayload(payloadJson) {
  try {
    return payloadJson ? JSON.parse(payloadJson) : null;
  } catch {
    return null;
  }
}

function isTerminalEventForInvocation(payload, invocationId) {
  return payload?.data?.invocationId === invocationId
    && payload?.data?.terminal === true;
}

function normalizeTerminalError(error, fallback = 'manager turn failed') {
  if (error == null) return null;
  let normalized;
  try {
    normalized = String(error);
  } catch {
    try {
      normalized = JSON.stringify(error);
    } catch {
      normalized = null;
    }
  }
  if (typeof normalized !== 'string' || normalized.length === 0) {
    normalized = fallback;
  }
  return normalized.slice(0, MAX_TERMINAL_ERROR_LENGTH);
}

// Candidates are oldest-first. JSON.parse remains the payload authority, so a
// SQL/JavaScript disagreement on an anomalous duplicate-key row rejects that
// row and falls through to the next bounded candidate.
function findPersistedTerminalEvent(candidates, invocationId) {
  for (const candidate of candidates) {
    const payload = parseTerminalEventPayload(candidate.payload_json);
    if (!isTerminalEventForInvocation(payload, invocationId)) continue;
    return { ...candidate, payload };
  }
  return null;
}

module.exports = {
  MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES,
  parseTerminalEventPayload,
  isTerminalEventForInvocation,
  normalizeTerminalError,
  findPersistedTerminalEvent,
};
