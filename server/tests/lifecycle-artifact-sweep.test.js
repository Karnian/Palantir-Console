const test = require('node:test');
const assert = require('node:assert/strict');

const { createLifecycleService } = require('../services/lifecycleService');

function lifecycleHarness({
  runs,
  executionEngine,
  remoteChannel,
  priorEvents = new Map(),
}) {
  const events = [];
  const runService = {
    listRuns: () => runs,
    getRun: (runId) => {
      const run = runs.find((candidate) => candidate.id === runId);
      if (!run) throw new Error('run not found');
      return run;
    },
    getRunEvents: (runId) => priorEvents.get(runId) || [],
    addRunEvent(runId, eventType, payloadJson) {
      events.push({ runId, eventType, payload: JSON.parse(payloadJson) });
    },
  };
  const nodeService = remoteChannel ? {
    getNode(nodeId) {
      if (nodeId === 'remote-a') return { id: nodeId, kind: 'ssh' };
      return { id: 'local', kind: 'local' };
    },
    pickExecutor(nodeId) {
      assert.equal(nodeId, 'remote-a');
      return remoteChannel;
    },
  } : null;
  const lifecycle = createLifecycleService({
    runService,
    taskService: {},
    agentProfileService: {},
    projectService: {},
    executionEngine,
    streamJsonEngine: {},
    worktreeService: null,
    eventBus: null,
    nodeService,
    projectMaterializationService: {},
  });
  return { lifecycle, events };
}

test('DB-aware local boot sweep annotates deletion and preserves a running worker', async () => {
  const runs = [
    { id: 'queued-residue', status: 'queued', node_id: null, is_manager: 0 },
    { id: 'running-worker', status: 'running', node_id: 'local', is_manager: 0 },
  ];
  const inspected = [];
  const executionEngine = {
    type: 'tmux',
    discoverGhostSessions: () => [],
    reapStartupArtifacts(runId) {
      inspected.push(runId);
      if (runId === 'running-worker') {
        return { action: 'preserved', reason: 'running', removed: [] };
      }
      return {
        action: 'removed',
        reason: 'no_session',
        removed: ['/tmp/palantir-scripts/run.sh', '/tmp/palantir-scripts/run.stdin'],
      };
    },
  };
  const h = lifecycleHarness({ runs, executionEngine });

  await h.lifecycle.recoverOrphanSessions();

  assert.deepEqual(inspected, ['queued-residue', 'running-worker']);
  assert.deepEqual(h.events, [{
    runId: 'queued-residue',
    eventType: 'runtime:artifacts_reaped',
    payload: {
      kind: 'local_tmux_startup',
      reason: 'no_session',
      removed_count: 2,
    },
  }]);
});

test('state 5 lifecycle sweep reaps a terminal remote statusDir and records it', async () => {
  const runs = [{
    id: 'remote-terminal',
    status: 'completed',
    node_id: 'remote-a',
    is_manager: 0,
  }];
  const cleaned = [];
  const remoteChannel = {
    async cleanupRun(runId) { cleaned.push(runId); },
  };
  const h = lifecycleHarness({
    runs,
    executionEngine: { type: 'subprocess' },
    remoteChannel,
  });

  await h.lifecycle.recoverOrphanSessions();

  assert.deepEqual(cleaned, ['remote-terminal']);
  assert.deepEqual(h.events, [{
    runId: 'remote-terminal',
    eventType: 'runtime:artifacts_reaped',
    payload: {
      kind: 'remote_status_dir',
      reason: 'terminal_run',
      removed_count: 1,
    },
  }]);
});

test('lifecycle remote sweep records no deletion when SSH cleanup is uncertain', async () => {
  const runs = [{
    id: 'remote-uncertain',
    status: 'failed',
    node_id: 'remote-a',
    is_manager: 0,
  }];
  const remoteChannel = {
    async cleanupRun() {
      const error = new Error('SSH cleanup timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  };
  const h = lifecycleHarness({
    runs,
    executionEngine: { type: 'subprocess' },
    remoteChannel,
  });

  await h.lifecycle.recoverOrphanSessions();

  assert.deepEqual(h.events, []);
});
