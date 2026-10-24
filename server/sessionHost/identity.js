'use strict';

/**
 * IdentityProbe (synchronous, no process operations in this package):
 * findMarked(id), listMarkedDescendants(id): {status:'ok',pids:[{pid,startedAt}]}
 *   | {status:'query_failed'}
 * check(pid, startedAt): 'match' | 'mismatch_confirmed' | 'query_failed'.
 * verifyThenSignal(pid, startedAt, signal): recheck before signalling.
 * signal(pid, startedAt, signal): optional fake/adapter transport, never an OS call.
 */
function createFakeIdentityProbe() {
  const marked = new Map(), checks = new Map(), descendants = new Map(), signals = [];
  return {
    marked, checks, descendants, signals,
    findMarked(id) { return marked.get(id) || { status: 'ok', pids: [] }; },
    check(pid, startedAt) { return checks.get(`${pid}:${startedAt}`) || 'mismatch_confirmed'; },
    listMarkedDescendants(id) { return descendants.get(id) || { status: 'ok', pids: [] }; },
    register(id, identity) {
      marked.set(id, { status: 'ok', pids: [identity] });
      checks.set(`${identity.pid}:${identity.startedAt}`, 'match');
    },
    exit(id) {
      for (const p of (marked.get(id)?.pids || [])) checks.set(`${p.pid}:${p.startedAt}`, 'mismatch_confirmed');
      marked.set(id, { status: 'ok', pids: [] });
    },
    verifyThenSignal(pid, startedAt, signal) {
      const verdict = this.check(pid, startedAt);
      if (verdict !== 'match') return verdict;
      signals.push({ pid, startedAt, signal });
      return 'signalled';
    },
    signal(pid, startedAt, signal) { signals.push({ pid, startedAt, signal }); }
  };
}
module.exports = { createFakeIdentityProbe };
