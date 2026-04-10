// server/services/eventChannels.js
//
// P2-3: canonical SSE channel registry. This is the single source of
// truth for which channels the server emits over the eventBus → SSE
// pipeline and which channels the frontend `useSSE` hook subscribes to.
//
// Why this file exists: Phase 5 and Phase 7 both shipped with a channel
// gap — the server added a new channel (`run:needs_input`, then
// `dispatch_audit:recorded`) but the hard-coded `channels` array in
// `server/public/app/lib/hooks.js useSSE` was not updated in the same
// commit. The handler was registered but never delivered because
// `EventSource.addEventListener` only fires for channels that were
// explicitly named in the subscription step. Both bugs survived
// review because the two lists were not visibly coupled.
//
// This file fixes the coupling: it lists the channels the runtime cares
// about, and a static-assertion test (`server/tests/sse-channels.test.js`)
// parses the frontend hooks.js subscription list and asserts that the
// client set is a SUBSET of this canonical set. Subset (not equality)
// is intentional — the client MAY legitimately subscribe to channels the
// server has not yet started emitting (the dead `run:created` /
// `task:deleted` subs predate P2-3 and we leave them alone for now; they
// are forward compat hooks). But the reverse drift — server emits, client
// never subscribes — is a bug the test refuses.
//
// Contract for new channels:
//   1. Add the channel name to SERVER_EMITS below.
//   2. If the client should receive it live, also add the name to
//      server/public/app/lib/hooks.js useSSE channels array AND register
//      a handler in the component that cares. Otherwise leave it server-
//      only (it will still be in replayFrom and /api/events stream).
//   3. Run `node --test server/tests/sse-channels.test.js`. The test
//      parses hooks.js literally — do not move the array out of
//      useSSE or rename it without updating the test's extractor.

'use strict';

/**
 * Channels the server emits via eventBus.emit(...). Keep this alphabetized
 * within each grouping so diffs are clean.
 */
const SERVER_EMITS = Object.freeze([
  // diagnostic (server-only observability)
  'diagnostic:pm_project_mismatch',

  // dispatch audit (v3 Phase 7)
  'dispatch_audit:recorded',

  // manager lifecycle
  'manager:started',
  'manager:stopped',

  // run lifecycle
  'run:completed',
  'run:ended',
  'run:event',
  'run:init',
  'run:needs_input',
  'run:output',
  'run:result',
  'run:status',

  // task lifecycle
  'task:created',
  'task:recurring-error',
  'task:recurring-spawned',
  'task:updated',
]);

/**
 * Channels the frontend useSSE hook is REQUIRED to subscribe to because
 * some consumer relies on live push (not just polled reload). This is
 * currently informational — the subset assertion in sse-channels.test.js
 * is what actually enforces the contract. Keep it in sync manually when
 * a handler in the UI starts depending on a channel being live.
 */
const CLIENT_REQUIRED_LIVE = Object.freeze([
  'run:status',
  'run:needs_input',
  'run:completed',
  'run:event',
  'run:output',
  'run:result',
  'manager:started',
  'manager:stopped',
  'task:created',
  'task:updated',
  'dispatch_audit:recorded',
]);

module.exports = {
  SERVER_EMITS,
  CLIENT_REQUIRED_LIVE,
};
