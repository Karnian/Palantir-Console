'use strict';

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

// SQLite JSON1 uses the first duplicate object key while JSON.parse uses the
// last, so duplicate-key payloads can make the SQL and JavaScript decisions
// diverge. Normal writers use JSON.stringify and cannot produce duplicate keys.
// Trying to defend this unrealizable input in SQL twice caused real regressions:
// normal terminal events were hidden, then a bounded candidate scan was
// exhausted. We intentionally do not defend duplicate keys here.
//
// SQL returns at most one correlated terminal candidate. JavaScript still
// revalidates the live-parser contract; a mismatch leaves the owner unsettled.
function findPersistedTerminalEvent(candidate, invocationId) {
  if (!candidate) return null;
  const payload = parseTerminalEventPayload(candidate.payload_json);
  if (!isTerminalEventForInvocation(payload, invocationId)) return null;
  return { ...candidate, payload };
}

module.exports = {
  parseTerminalEventPayload,
  isTerminalEventForInvocation,
  findPersistedTerminalEvent,
};
