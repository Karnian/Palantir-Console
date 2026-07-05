const test = require('node:test');
const assert = require('node:assert/strict');

const { createLifecycleService } = require('../services/lifecycleService');

const NOW = Date.parse('2026-07-05T12:00:00.000Z');
const FIFTEEN_MINUTES = 15 * 60 * 1000;

function isoBefore(ms) {
  return new Date(NOW - ms).toISOString();
}

function makeRun(overrides = {}) {
  return {
    id: overrides.id || `run-${Math.random().toString(36).slice(2)}`,
    status: 'queued',
    is_manager: 0,
    node_id: 'node-a',
    created_at: isoBefore(16 * 60 * 1000),
    ...overrides,
  };
}

function makeHarness({ runs, nodes, events = {}, failRunningScan = false }) {
  const addedEvents = [];
  const statusUpdates = [];
  let failedRunningScan = false;
  const runService = {
    listRuns(filter = {}) {
      if (failRunningScan && filter.status === 'running' && !failedRunningScan) {
        failedRunningScan = true;
        throw new Error('running scan failed');
      }
      if (!filter.status) return runs;
      return runs.filter((run) => run.status === filter.status);
    },
    getRunEvents(runId) {
      return events[runId] || [];
    },
    addRunEvent(runId, eventType, payloadJson) {
      const event = { event_type: eventType, payload_json: payloadJson };
      events[runId] = events[runId] || [];
      events[runId].push(event);
      addedEvents.push({ runId, eventType, payloadJson });
      return addedEvents.length;
    },
    updateRunStatus(runId, status) {
      statusUpdates.push({ runId, status });
      const run = runs.find((item) => item.id === runId);
      if (run) run.status = status;
      return run;
    },
  };

  const nodeService = {
    getNode(nodeId) {
      const node = nodes[nodeId];
      if (node instanceof Error) throw node;
      if (!node) throw new Error(`missing node ${nodeId}`);
      return node;
    },
  };

  const lifecycle = createLifecycleService({
    runService,
    taskService: { updateTaskStatus() {} },
    agentProfileService: {},
    projectService: {},
    executionEngine: {},
    streamJsonEngine: {},
    authResolver: {},
    nodeService,
    nodeExecutor: {
      async fileExists() { return false; },
      async spawnWorker() { return { sessionName: 'unused' }; },
    },
    queueStuckMs: FIFTEEN_MINUTES,
    now: () => NOW,
  });

  return { lifecycle, addedEvents, statusUpdates, events };
}

test('sweepStuckQueuedRuns annotates old queued runs on unreachable and cordoned nodes', () => {
  const runs = [
    makeRun({ id: 'run-unreachable', node_id: 'node-a' }),
    makeRun({ id: 'run-cordoned', node_id: 'node-b' }),
  ];
  const { lifecycle, addedEvents, statusUpdates } = makeHarness({
    runs,
    nodes: {
      'node-a': { id: 'node-a', reachable: 0, cordoned: 0 },
      'node-b': { id: 'node-b', reachable: 1, cordoned: 1 },
    },
  });

  assert.equal(lifecycle.sweepStuckQueuedRuns(), 2);

  assert.deepEqual(addedEvents.map((event) => ({
    runId: event.runId,
    eventType: event.eventType,
    payload: JSON.parse(event.payloadJson),
  })), [
    {
      runId: 'run-unreachable',
      eventType: 'queue:stuck',
      payload: { node_id: 'node-a', reason: 'node_unreachable', waited_ms: 16 * 60 * 1000 },
    },
    {
      runId: 'run-cordoned',
      eventType: 'queue:stuck',
      payload: { node_id: 'node-b', reason: 'node_cordoned', waited_ms: 16 * 60 * 1000 },
    },
  ]);
  assert.deepEqual(statusUpdates, []);
  assert.deepEqual(runs.map((run) => run.status), ['queued', 'queued']);
});

test('sweepStuckQueuedRuns skips fresh, healthy, manager, and already annotated runs', () => {
  const runs = [
    makeRun({ id: 'run-fresh', node_id: 'node-a', created_at: isoBefore(5 * 60 * 1000) }),
    makeRun({ id: 'run-healthy', node_id: 'node-b' }),
    makeRun({ id: 'run-manager', node_id: 'node-a', is_manager: 1 }),
    makeRun({ id: 'run-duplicate', node_id: 'node-a' }),
  ];
  const { lifecycle, addedEvents, statusUpdates } = makeHarness({
    runs,
    nodes: {
      'node-a': { id: 'node-a', reachable: 0, cordoned: 0 },
      'node-b': { id: 'node-b', reachable: 1, cordoned: 0 },
    },
    events: {
      'run-duplicate': [{ event_type: 'queue:stuck', payload_json: '{}' }],
    },
  });

  assert.equal(lifecycle.sweepStuckQueuedRuns(), 0);
  assert.deepEqual(addedEvents, []);
  assert.deepEqual(statusUpdates, []);
  assert.deepEqual(runs.map((run) => run.status), ['queued', 'queued', 'queued', 'queued']);
});

test('sweepStuckQueuedRuns does not re-annotate after it writes queue:stuck', () => {
  const runs = [makeRun({ id: 'run-once', node_id: 'node-a' })];
  const { lifecycle, addedEvents } = makeHarness({
    runs,
    nodes: {
      'node-a': { id: 'node-a', reachable: 0, cordoned: 0 },
    },
  });

  assert.equal(lifecycle.sweepStuckQueuedRuns(), 1);
  assert.equal(lifecycle.sweepStuckQueuedRuns(), 0);
  assert.equal(addedEvents.length, 1);
});

test('sweepStuckQueuedRuns isolates getNode failures and continues', () => {
  const runs = [
    makeRun({ id: 'run-missing-node', node_id: 'deleted-node' }),
    makeRun({ id: 'run-next', node_id: 'node-a' }),
  ];
  const { lifecycle, addedEvents, statusUpdates } = makeHarness({
    runs,
    nodes: {
      'deleted-node': new Error('node deleted'),
      'node-a': { id: 'node-a', reachable: 0, cordoned: 0 },
    },
  });

  assert.doesNotThrow(() => lifecycle.sweepStuckQueuedRuns());
  assert.deepEqual(addedEvents.map((event) => event.runId), ['run-next']);
  assert.deepEqual(statusUpdates, []);
  assert.deepEqual(runs.map((run) => run.status), ['queued', 'queued']);
});

test('checkHealth runs stuck sweep even when the running health scan fails', async () => {
  const runs = [makeRun({ id: 'run-after-health-error', node_id: 'node-a' })];
  const { lifecycle, addedEvents, statusUpdates } = makeHarness({
    runs,
    failRunningScan: true,
    nodes: {
      'node-a': { id: 'node-a', reachable: 0, cordoned: 0 },
    },
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await lifecycle.checkHealth();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(addedEvents.map((event) => event.runId), ['run-after-health-error']);
  assert.deepEqual(statusUpdates, []);
  assert.equal(runs[0].status, 'queued');
});
