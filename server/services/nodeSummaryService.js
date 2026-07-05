const { explainDispatch } = require('./dispatchPolicy');

function profileCountKey(profileId) {
  return profileId || '_unknown';
}

function incrementProfileCount(target, profileId) {
  const key = profileCountKey(profileId);
  target[key] = (target[key] || 0) + 1;
}

function normalizeNodeId(nodeId) {
  return nodeId || 'local';
}

function toSummaryNode(node) {
  return {
    node_id: node.id,
    name: node.name || node.id,
    reachable: Number(node.reachable) === 1 ? 1 : 0,
    can_execute: Number(node.can_execute) === 1 ? 1 : 0,
    files_only: Number(node.files_only) === 1 ? 1 : 0,
    cordoned: 0,
    max_concurrent: node.max_concurrent ?? null,
    running_total: 0,
    queued_total: 0,
    running_by_profile: {},
    queued_by_profile: {},
  };
}

function createSyntheticNode(nodeId) {
  return toSummaryNode({
    id: nodeId,
    name: nodeId,
    reachable: 0,
    can_execute: 0,
    files_only: 0,
    max_concurrent: null,
  });
}

function compareCreatedAsc(a, b) {
  const ac = a.created_at || '';
  const bc = b.created_at || '';
  if (ac !== bc) return ac < bc ? -1 : 1;
  const ai = String(a.id || '');
  const bi = String(b.id || '');
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

function createNodeSummaryService({ nodeService, runService, agentProfileService } = {}) {
  function getProfile(profileId, cache) {
    if (!profileId) return null;
    if (cache.has(profileId)) return cache.get(profileId);
    let profile = null;
    try {
      profile = agentProfileService.getProfile(profileId);
    } catch {
      profile = null;
    }
    cache.set(profileId, profile);
    return profile;
  }

  function getSummary() {
    const nodesById = new Map();
    for (const node of nodeService.listNodes()) {
      nodesById.set(node.id, toSummaryNode(node));
    }

    function ensureNode(nodeId) {
      const id = normalizeNodeId(nodeId);
      if (!nodesById.has(id)) nodesById.set(id, createSyntheticNode(id));
      return nodesById.get(id);
    }

    const runningRuns = (runService.listRuns({ status: 'running' }) || [])
      .filter((run) => Number(run.is_manager || 0) === 0);
    const queuedRuns = (runService.listRuns({ status: 'queued' }) || [])
      .filter((run) => Number(run.is_manager || 0) === 0);

    const runningByNodeProfile = new Map();
    const runningTotalByNode = new Map();

    for (const run of runningRuns) {
      const nodeId = normalizeNodeId(run.node_id);
      const node = ensureNode(nodeId);
      node.running_total += 1;
      incrementProfileCount(node.running_by_profile, run.agent_profile_id);

      const profileKey = profileCountKey(run.agent_profile_id);
      const nodeProfileKey = `${nodeId}\u0000${profileKey}`;
      runningByNodeProfile.set(nodeProfileKey, (runningByNodeProfile.get(nodeProfileKey) || 0) + 1);
      runningTotalByNode.set(nodeId, (runningTotalByNode.get(nodeId) || 0) + 1);
    }

    for (const run of queuedRuns) {
      const node = ensureNode(run.node_id);
      node.queued_total += 1;
      incrementProfileCount(node.queued_by_profile, run.agent_profile_id);
    }

    const profileCache = new Map();
    const queued = queuedRuns.slice().sort(compareCreatedAsc).map((run) => {
      const nodeId = normalizeNodeId(run.node_id);
      const profileKey = profileCountKey(run.agent_profile_id);
      const nodeProfileKey = `${nodeId}\u0000${profileKey}`;
      const nodeRow = nodesById.get(nodeId);
      const profile = getProfile(run.agent_profile_id, profileCache);
      const explanation = explainDispatch({
        node: nodeRow ? {
          id: nodeRow.node_id,
          reachable: nodeRow.reachable,
          can_execute: nodeRow.can_execute,
          files_only: nodeRow.files_only,
          max_concurrent: nodeRow.max_concurrent,
        } : null,
        profile,
        runningOnNodeForProfile: runningByNodeProfile.get(nodeProfileKey) || 0,
        runningTotalOnNode: runningTotalByNode.get(nodeId) || 0,
      });

      return {
        run_id: run.id,
        task_id: run.task_id || null,
        project_id: run.project_id || null,
        agent_profile_id: run.agent_profile_id || null,
        node_id: nodeId,
        queue_reason: explanation.reason,
        enqueued_at: run.created_at || null,
      };
    });

    return {
      nodes: Array.from(nodesById.values()),
      queued,
      updatedAt: new Date().toISOString(),
    };
  }

  return { getSummary };
}

module.exports = { createNodeSummaryService };
