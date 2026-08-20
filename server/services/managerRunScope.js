'use strict';

const isId = (value) => typeof value === 'string' && value.length > 0;

function managerCanAccessRun(grant, run, { runService } = {}) {
  if (!run) return false;
  if (!grant) return false;
  if (grant.layer === 'top') return !run.is_manager;
  // Anything that is not Top is treated as an operator-layer grant, matching
  // managerCapabilityRequestAllowed's `layer !== 'top'` convention. Requiring
  // the literal 'operator' would deny every legacy 'pm' grant outright, which
  // mint() still accepts.
  if (run.is_manager) return false;
  // Both ids must be real. `null === null` would otherwise read as ownership
  // for a legacy worker with no parent whenever a grant carried no run id.
  if (isId(run.parent_run_id) && isId(grant.runId) && run.parent_run_id === grant.runId) return true;

  if (isId(run.operator_instance_id) && runService
      && typeof runService.resolveOperatorConversationIdWithDb === 'function') {
    try {
      const resolved = runService.resolveOperatorConversationIdWithDb(grant.conversationId);
      if (resolved?.instanceId === run.operator_instance_id) return true;
    } catch {
      return false;
    }
  }

  // Fail closed for legacy rows with neither ownership marker. Manager
  // capabilities are a security boundary: unknown ownership is never access.
  return false;
}

module.exports = { managerCanAccessRun };
