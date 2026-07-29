'use strict';

// SQL admits only rows whose JSON1 terminal value is boolean true before this
// bound is applied. Same-invocation non-terminal failures therefore consume no
// slots and cannot exhaust the scan; eight candidates still bound JSON.parse
// work while allowing JavaScript to reject a newer anomalous row and fall back
// to an earlier terminal event.
const MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES = 8;

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

// Candidates are newest-first. JSON.parse is the live-parser authority, so a
// SQL/JavaScript disagreement on an anomalous row rejects only that row and the
// scan continues to any earlier durable terminal evidence.
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
