'use strict';

/**
 * Operator execution mode (Operator P-B, slice P-B2a).
 *
 * brief §2: `OperatorInstance = Profile × WorkspaceBinding × ExecutionMode`.
 * ExecutionMode is the third axis (Codex added it so "PM" doesn't decay into
 * "anything above a Worker"):
 *   - dispatcher: delegates work to Workers (today's Top + coder PM). It plans /
 *     routes / spawns; it does not do the task itself.
 *   - doer: performs the task directly (a Worker, and a folder-less specialist).
 *
 * It is NOT derivable from capability or workspace binding — capability says
 * WHAT is allowed; execution mode says WHETHER the operator delegates or
 * performs (Codex P-B2 review Q4). Kept as its own axis + contract, mirroring
 * workspaceBinding.js.
 */

const EXECUTION_MODE = Object.freeze({ DISPATCHER: 'dispatcher', DOER: 'doer' });

const MODE_SET = new Set([EXECUTION_MODE.DISPATCHER, EXECUTION_MODE.DOER]);

function isExecutionMode(value) {
  return MODE_SET.has(value);
}

/**
 * Assert `value` is a valid execution mode (typo guard; fail-closed).
 * @param {'dispatcher'|'doer'} value
 * @returns {void}
 */
function assertExecutionMode(value) {
  if (!MODE_SET.has(value)) {
    throw new Error(`assertExecutionMode: invalid execution mode "${value}" (expected dispatcher|doer)`);
  }
}

module.exports = { EXECUTION_MODE, isExecutionMode, assertExecutionMode };
