'use strict';

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

// Candidates are newest-first. Keep the oldest valid match so persisted
// reconciliation has the same first-terminal-event-wins semantics as the live
// CAS path. JSON.parse remains the only payload authority.
function findPersistedTerminalEvent(candidates, invocationId) {
  let terminal = null;
  for (const candidate of candidates) {
    const payload = parseTerminalEventPayload(candidate.payload_json);
    if (!isTerminalEventForInvocation(payload, invocationId)) continue;
    terminal = { ...candidate, payload };
  }
  return terminal;
}

module.exports = {
  parseTerminalEventPayload,
  isTerminalEventForInvocation,
  normalizeTerminalError,
  findPersistedTerminalEvent,
};
