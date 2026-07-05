const DISPATCH_BLOCK_REASONS = [
  'node_unreachable',
  'node_not_executable',
  'node_cordoned',
  'profile_missing',
  'profile_capacity',
  'node_capacity',
];

function explainDispatch({
  node,
  profile,
  runningOnNodeForProfile,
  runningTotalOnNode,
} = {}) {
  if (!node || Number(node.reachable) !== 1) {
    return { ok: false, reason: 'node_unreachable' };
  }

  if (Number(node.can_execute) !== 1 || Number(node.files_only) === 1) {
    return { ok: false, reason: 'node_not_executable' };
  }

  if (Number(node.cordoned) === 1) {
    return { ok: false, reason: 'node_cordoned' };
  }

  // A queued run whose agent profile was deleted can never spawn
  // (drainQueue bails on getProfile failure) — surface that instead of
  // reporting "no blocker" (Codex N1-B review, SERIOUS). Legacy
  // canDispatchOnNode never reaches this branch: its callers always
  // resolve a live profile first.
  if (!profile) {
    return { ok: false, reason: 'profile_missing' };
  }

  if (runningOnNodeForProfile >= profile.max_concurrent) {
    return { ok: false, reason: 'profile_capacity' };
  }

  if (node.max_concurrent != null && runningTotalOnNode >= node.max_concurrent) {
    return { ok: false, reason: 'node_capacity' };
  }

  return { ok: true, reason: null };
}

module.exports = {
  DISPATCH_BLOCK_REASONS,
  explainDispatch,
};
