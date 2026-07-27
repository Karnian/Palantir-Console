'use strict';

/**
 * #436: run visibility for a copyable manager capability credential.
 *
 * The auth-layer allowlist decides WHICH routes a manager grant may call. It
 * cannot decide what a response may contain, and `/api/runs` returns `r.*` for
 * every run. A review reproduced an Operator grant reading the Top manager's
 * prompt and assistant text through the run list while the equivalent
 * `/api/conversations/top/events` request was correctly refused — the direction
 * rule guarded the front door while this was an open window.
 *
 * Two independent controls live here:
 *   1. `canObserveRun` — the same direction rule as conversations: a manager
 *      observes ITSELF and layers BELOW it, never a peer or its parent.
 *   2. `toCapabilityRunView` — an ALLOWLIST of columns. A denylist is the wrong
 *      shape for a table that gains columns over time: whoever adds the next
 *      credential-bearing column would have to remember this file, and the
 *      failure mode is silent disclosure. Unknown columns are dropped.
 */

// Fields an attenuated capability caller may see. Chosen for what orchestration
// and worker review actually need.
const CAPABILITY_RUN_FIELDS = Object.freeze([
  // identity and state
  'id', 'task_id', 'agent_profile_id', 'status', 'exit_code',
  'prompt', 'result_summary', 'error_message',
  // timing
  'created_at', 'started_at', 'ended_at',
  // accounting
  'input_tokens', 'output_tokens', 'cost_usd',
  // layer / routing
  'is_manager', 'manager_layer', 'manager_adapter', 'conversation_id',
  'operator_instance_id', 'parent_run_id', 'node_id',
  // retry and goal state
  'retry_count', 'retry_root_run_id', 'non_retryable',
  'goal_active', 'goal_verdict', 'goal_verdict_reason', 'goal_retry_run_id',
  'deliverable_state',
  // execution shape
  'branch', 'worktree_path', 'preset_id', 'session_model', 'session_effort',
]);

/*
 * Deliberately NOT exposed, and why:
 *   mcp_config_snapshot, mcp_config_path, queued_args — carry literal MCP `env`
 *     values, i.e. third-party API keys. Disclosure escalates past the Console.
 *   tmux_session — naming the session is enough to attach to it.
 *   manager_thread_id, claude_session_id — resuming another manager's thread
 *     (`codex exec resume <id>`) is impersonation, not observation.
 *   goal_workspace_path, goal_fingerprint, preset_snapshot_hash,
 *   judge_json, acceptance_json, goal_report, final_output — no orchestration
 *     need; withheld by default rather than by argument.
 */

/**
 * The attenuated manager grant on a request, or null. Only this grade is
 * filtered: `isolated` means the credential is not copyable, and a human cookie
 * session is the authority this whole module exists to protect.
 */
function attenuatedRunGrant(req) {
  const auth = req && req.auth;
  if (!auth || auth.actor !== 'manager') return null;
  if (auth.capabilityTier !== 'shared_uid_attenuated') return null;
  return auth;
}

/**
 * Direction rule. Mirrors `attenuatedConversationAllowed` in middleware/auth.js;
 * the two must stay in step, which is why both are stated as "self, or below".
 *
 * Limit: a worker run is visible to any Operator grant, not only the Operator
 * that spawned it. Narrowing that needs project/instance ownership plumbing;
 * the run-bound grant and the capability audit are the compensating controls.
 */
// Layers strictly BELOW a given caller layer. `top` may observe Operator runs;
// an Operator may observe no other manager at all. Written as an explicit map
// rather than `caller === 'top'` because the latter also matched OTHER Top runs
// — a copied Top credential could read a previous Top's prompt and output.
const OBSERVABLE_MANAGER_LAYERS = Object.freeze({
  top: Object.freeze(['operator', 'pm']),
});

function canObserveRun(run, grant) {
  if (!run || !grant) return false;
  if (grant.managerRunId && run.id === grant.managerRunId) return true; // self
  if (!run.is_manager) return true; // worker runs are the job
  // Another manager: allowed only when its layer is strictly below the caller's.
  // A missing or unrecognised layer is refused rather than guessed.
  const below = OBSERVABLE_MANAGER_LAYERS[grant.layer] || [];
  return below.includes(String(run.manager_layer || ''));
}

/** Project a run row onto the capability allowlist. */
function toCapabilityRunView(run) {
  if (!run || typeof run !== 'object') return run;
  const view = {};
  for (const field of CAPABILITY_RUN_FIELDS) {
    if (field in run) view[field] = run[field];
  }
  return view;
}

/**
 * Convenience for list routes: filter by direction, then project. Returns the
 * rows untouched when the caller is not an attenuated manager.
 */
function applyCapabilityRunFilter(runs, grant) {
  if (!grant) return runs;
  return runs.filter((run) => canObserveRun(run, grant)).map(toCapabilityRunView);
}

/*
 * There is deliberately no general "scrub any response body" filter here.
 * One was written and withdrawn: walking keys cannot see a forbidden field
 * through a size limit, a double-encoded string, a non-JSON serialization, or a
 * `toJSON()` that materialises it at stringify time — and re-serializing every
 * nested JSON string to check corrupted large integers, `-0`, and escape forms
 * in payloads that callers may be hashing. Credential-bearing values are kept
 * out at the producer (see `markRunStarted` in runService) and at the routes
 * that return runs, which are enumerable and testable.
 */

module.exports = {
  CAPABILITY_RUN_FIELDS,
  attenuatedRunGrant,
  canObserveRun,
  toCapabilityRunView,
  applyCapabilityRunFilter,
};
