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
  // Reaping now requires evidence that the output was already consumed —
  // terminal status alone is not enough, because capture/harvest run
  // asynchronously after the status is committed.
  const h = lifecycleHarness({
    runs,
    executionEngine: { type: 'subprocess' },
    remoteChannel,
    priorEvents: new Map([['remote-terminal', [{ event_type: 'harvest:diff', payload_json: '{}' }]]]),
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

// ---------------------------------------------------------------------------
// Integrated adversarial review findings on the boot sweep.
// ---------------------------------------------------------------------------

test('remote statusDir is preserved until something durable shows the output was consumed', async () => {
  // Terminal status lands in the DB before capture/harvest, which run
  // asynchronously off run:ended. A controller that dies in that window leaves
  // the remote stdout.log as the only copy of the result, and nothing at boot
  // re-runs the capture — so deleting on terminal status alone destroys it.
  const runs = [
    { id: 'unconsumed', status: 'completed', node_id: 'remote-a', is_manager: 0 },
    { id: 'consumed', status: 'completed', node_id: 'remote-a', is_manager: 0 },
  ];
  const cleaned = [];
  const remoteChannel = {
    cleanupRun: async (runId) => { cleaned.push(runId); },
    kill: async () => true,
  };
  const priorEvents = new Map([
    ['unconsumed', []],
    ['consumed', [{ event_type: 'harvest:diff', payload_json: '{}' }]],
  ]);
  const h = lifecycleHarness({
    runs,
    executionEngine: { type: 'subprocess' },
    remoteChannel,
    priorEvents,
  });

  await h.lifecycle.recoverOrphanSessions();

  assert.deepEqual(cleaned, ['consumed'], 'only a run whose output was consumed may be reaped');
  assert.equal(
    h.events.some((e) => e.runId === 'unconsumed' && e.eventType === 'runtime:artifacts_reaped'),
    false,
    'an unconsumed run must not even be annotated as reaped',
  );
});

test('active worker capability revocation is not queued behind terminal housekeeping', async () => {
  // Each terminal cleanup is an SSH round trip, and an offline node costs the
  // full timeout. Revoking a capability on a worker that is still RUNNING has a
  // security deadline; sweeping old directories does not. Order matters.
  const runs = [
    { id: 'old-terminal', status: 'completed', node_id: 'remote-a', is_manager: 0 },
    { id: 'live-worker', status: 'running', node_id: 'remote-a', is_manager: 0 },
  ];
  const order = [];
  const remoteChannel = {
    cleanupRun: async (runId) => { order.push(`cleanup:${runId}`); },
    kill: async (runId) => { order.push(`kill:${runId}`); return true; },
    getOutput: async () => null,
    detectExitCode: async () => null,
    isAlive: async () => true,
  };
  const priorEvents = new Map([
    ['old-terminal', [{ event_type: 'harvest:diff', payload_json: '{}' }]],
    ['live-worker', [{ event_type: 'security:worker_capability_scoped', payload_json: '{}' }]],
  ]);
  const h = lifecycleHarness({
    runs,
    executionEngine: { type: 'subprocess' },
    remoteChannel,
    priorEvents,
  });

  await h.lifecycle.recoverOrphanSessions();

  const killIdx = order.findIndex((entry) => entry.startsWith('kill:'));
  const cleanupIdx = order.findIndex((entry) => entry.startsWith('cleanup:'));
  assert.ok(killIdx >= 0, 'the expired capability must be revoked');
  assert.ok(cleanupIdx >= 0, 'housekeeping must still run');
  assert.ok(killIdx < cleanupIdx, 'revocation must not wait behind terminal housekeeping');
});
