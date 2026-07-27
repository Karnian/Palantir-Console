'use strict';

/**
 * #436: what a manager capability may see of a run row.
 *
 * The tmux session NAME is enough to attach to a worker's terminal, which is
 * authority well beyond the Console API — and nothing reads it back off a
 * response (no client reference; the server only ever writes it). So it does
 * not travel to a manager grant.
 *
 * This lives in one place because enumerating "routes that return a run" is
 * exactly the discipline that failed in review: the field was removed from the
 * run list and single-run routes, and `POST /api/tasks/:id/execute` still handed
 * it back with the freshly started run. Every route that returns a run to a
 * possibly-manager caller must go through here.
 *
 * Scoped to the manager actor rather than stripped globally, so the human UI's
 * view of a run is unchanged.
 */
function withoutSessionHandle(req, run) {
  if (!run || typeof run !== 'object') return run;
  if (req?.auth?.actor !== 'manager') return run;
  const { tmux_session, ...rest } = run;
  return rest;
}

module.exports = { withoutSessionHandle };
