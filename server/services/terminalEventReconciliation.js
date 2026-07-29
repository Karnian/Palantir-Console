'use strict';

// SQL narrows candidates to one invocation before this bound is applied. A
// normal writer emits one terminal outcome, so 32 still leaves room to skip 31
// malformed/non-terminal anomalies while bounding parse work on every queue
// tick and scheduler restart.
const MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES = 32;

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

// Candidates are already correlated by SQL and must be newest-first. Invalid
// or non-terminal rows are skipped so they cannot shadow an earlier event that
// the live JSON parser would accept.
function findPersistedTerminalEvent(candidates) {
  for (const candidate of candidates) {
    const payload = parseTerminalEventPayload(candidate.payload_json);
    if (payload?.data?.terminal !== true) continue;
    return { ...candidate, payload };
  }
  return null;
}

module.exports = {
  MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES,
  parseTerminalEventPayload,
  isTerminalEventForInvocation,
  findPersistedTerminalEvent,
};
