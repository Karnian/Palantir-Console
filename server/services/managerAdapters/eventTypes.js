/**
 * Normalized manager event type enum (PR1b).
 *
 * Vendor-agnostic event names emitted by every ManagerAdapter alongside the
 * legacy run_events. The legacy events stay until PR1c flips the frontend
 * over; PR5 may eventually drop them.
 *
 * payload_json shape (D3):
 *   { turnIndex, vendorItemId?, summaryText, hasRawStored, data }
 *
 * - turnIndex:      integer, 0-based, increments per turn boundary
 * - vendorItemId:   optional vendor-side id (Claude tool_use.id, Codex item.id)
 * - summaryText:    short human-readable summary for UI
 * - hasRawStored:   true iff the matching raw_vendor_event was also written
 *                   (only when PALANTIR_DEBUG_RAW_EVENTS=1)
 * - data:           adapter-specific structured fields (tokens, exit_code, ...)
 */

const { createHash } = require('node:crypto');

// Note: TURN_STARTED is reserved for adapters that emit a clear turn-boundary
// vendor signal at the START of each turn (e.g. Codex's turn.started). Claude's
// stream-json protocol has no equivalent event, so claudeAdapter never emits
// TURN_STARTED — turnIndex is advanced on each `result`. Consumers must NOT
// require TURN_STARTED to be present.
const NORMALIZED_EVENT_TYPES = Object.freeze({
  SESSION_STARTED:    'mgr.session_started',
  TURN_STARTED:       'mgr.turn_started',
  ASSISTANT_MESSAGE:  'mgr.assistant_message',
  TOOL_CALL_STARTED:  'mgr.tool_call_started',
  TOOL_CALL_FINISHED: 'mgr.tool_call_finished',
  USAGE:              'mgr.usage',
  TURN_COMPLETED:     'mgr.turn_completed',
  TURN_FAILED:        'mgr.turn_failed',
  SESSION_ENDED:      'mgr.session_ended',
  RAW_VENDOR_EVENT:   'mgr.raw_vendor_event',
});

const RAW_EVENTS_ENABLED = process.env.PALANTIR_DEBUG_RAW_EVENTS === '1';
const VENDOR_HANDLE_KEYS = new Set([
  'threadId',
  'thread_id',
  'sessionId',
  'session_id',
  'claude_session_id',
]);

function vendorHandleFingerprint(handle) {
  if (typeof handle !== 'string' || handle.length === 0) return null;
  return createHash('sha256').update(handle).digest('hex').slice(0, 12);
}

/**
 * Best-effort redaction for raw vendor events. Vendors can still introduce a
 * handle under an unknown key; this protects the known handle key spellings.
 * The input is never mutated because legacy persistence runs after raw capture.
 */
function redactVendorHandles(value) {
  try {
    function visit(current, ancestors) {
      if (current === null || typeof current !== 'object') return current;
      if (ancestors.has(current)) return '[Circular]';

      const copy = Array.isArray(current) ? [] : {};
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(current);
      for (const key of Object.keys(current)) {
        try {
          copy[key] = VENDOR_HANDLE_KEYS.has(key)
            ? vendorHandleFingerprint(current[key])
            : visit(current[key], nextAncestors);
        } catch {
          copy[key] = null;
        }
      }
      return copy;
    }

    return visit(value, new Set());
  } catch {
    return null;
  }
}

/**
 * Build a normalized payload object.
 */
function buildPayload({ turnIndex, vendorItemId, summaryText, data, hasRawStored }) {
  return {
    turnIndex: Number.isInteger(turnIndex) ? turnIndex : 0,
    vendorItemId: vendorItemId || undefined,
    summaryText: summaryText || '',
    hasRawStored: !!hasRawStored,
    data: data || {},
  };
}

module.exports = {
  NORMALIZED_EVENT_TYPES,
  RAW_EVENTS_ENABLED,
  buildPayload,
  vendorHandleFingerprint,
  redactVendorHandles,
};
