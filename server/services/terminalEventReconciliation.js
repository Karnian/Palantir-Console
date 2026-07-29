'use strict';

// A terminal event for the single in-flight turn should be the newest terminal
// event on its run. Keep a generous corruption/mismatch budget (255 newer rows)
// while bounding JSON parsing on every queue tick and scheduler restart.
const MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES = 256;

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

// Candidates must be newest-first. Invalid or mismatched rows are skipped so
// they cannot shadow an earlier event that the live JSON parser would accept.
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
  findPersistedTerminalEvent,
};
