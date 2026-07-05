// Node-first UI helpers shared by board/detail/inspector/dashboard surfaces.
// Kept dependency-free so jsdom tests can preload the exports as sandbox
// globals while browser ESM imports use the same functions.

export function shouldRenderNodeBadge(run) {
  const nodeId = run?.node_id;
  return !!nodeId && nodeId !== 'local';
}

export function nodeDetailHref(nodeId) {
  return `#resources/nodes/${encodeURIComponent(String(nodeId || ''))}`;
}

export function latestRunForTask(runs, taskId) {
  if (!taskId) return null;
  const taskRuns = (runs || []).filter(r => r.task_id === taskId);
  if (taskRuns.length === 0) return null;
  return taskRuns.slice().sort((a, b) => {
    const at = Date.parse(a.created_at || a.updated_at || '') || 0;
    const bt = Date.parse(b.created_at || b.updated_at || '') || 0;
    return bt - at;
  })[0];
}

export function queueReasonsByRunId(summary) {
  const out = {};
  for (const item of summary?.queued || []) {
    if (item?.run_id && item.queue_reason) out[item.run_id] = item.queue_reason;
  }
  return out;
}

export function nodeDisplayName(node) {
  return node?.name || node?.node_id || 'unknown';
}

export function isRemoteNode(node) {
  if (!node) return false;
  if (node.kind) return node.kind === 'ssh';
  return !!node.node_id && node.node_id !== 'local';
}

export function isNodeReachable(node) {
  return node?.reachable === true || node?.reachable === 1;
}

export function nodeQueuedTotal(summary) {
  if (Array.isArray(summary?.queued)) return summary.queued.length;
  return (summary?.nodes || []).reduce((sum, node) => sum + Number(node?.queued_total || 0), 0);
}

export function fleetStripModel(summary) {
  const nodes = summary?.nodes || [];
  const remoteNodes = nodes.filter(isRemoteNode);
  const queuedTotal = nodeQueuedTotal(summary);
  const unreachableNodes = remoteNodes.filter(node => !isNodeReachable(node));
  const blockedNodes = remoteNodes.filter(node => (
    (!isNodeReachable(node) || Number(node?.cordoned || 0) === 1)
    && Number(node?.queued_total || 0) > 0
  ));
  // Strip rows: remote nodes always; the local node only when it has
  // activity (queued/running) that explains why the strip is visible.
  // An idle local-only fleet renders no rows (Codex N1-C review, SERIOUS 1).
  const rows = nodes.filter(node => isRemoteNode(node)
    || Number(node?.queued_total || 0) > 0
    || Number(node?.running_total || 0) > 0);
  return {
    nodes,
    rows,
    remoteNodes,
    queuedTotal,
    unreachableNodes,
    blockedNodes,
    visible: remoteNodes.length > 0 || queuedTotal > 0,
  };
}
