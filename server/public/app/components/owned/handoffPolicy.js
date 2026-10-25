// Shared browser/host policy. This module has no runtime dependencies or effects beyond export.
(function (root) {
  function ownedHandoffRejection(session, incarnation, controlPending = false) {
    if (session?.state !== 'active') return 'session_inactive';
    if (controlPending) return 'busy';
    if (incarnation && !['alive', 'orphaned', 'exited', 'never_started'].includes(incarnation.state)) {
      return incarnation.state === 'liveness_unknown' ? 'liveness_unknown' : 'busy';
    }
    if (!incarnation || !session.claude_session_id) return 'no_session_id';
    return null;
  }
  if (typeof module === 'object' && module.exports) module.exports = { ownedHandoffRejection };
  else root.ownedHandoffRejection = ownedHandoffRejection;
})(globalThis);
