const test = require('node:test');
const assert = require('node:assert/strict');

const { createNodeHeartbeatService } = require('../services/nodeHeartbeatService');
const { createLifecycleService } = require('../services/lifecycleService');

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeHeartbeatNodeService(nodes, execImpl) {
  const calls = { touched: [], unreachable: [], picked: [] };
  return {
    calls,
    listNodes() {
      return nodes;
    },
    pickExecutor(nodeId) {
      calls.picked.push(nodeId);
      return {
        exec: (...args) => execImpl(nodeId, ...args),
      };
    },
    async touchHeartbeat(nodeId) {
      calls.touched.push(nodeId);
      const node = nodes.find((item) => item.id === nodeId);
      if (node) node.reachable = 1;
    },
    async setReachable(nodeId, reachable) {
      calls.unreachable.push({ nodeId, reachable });
      const node = nodes.find((item) => item.id === nodeId);
      if (node) node.reachable = reachable ? 1 : 0;
    },
  };
}

test('node heartbeat calls onNodeRecovered once for a 0 to 1 reachable flip', async () => {
  const nodes = [{ id: 'pod-a', kind: 'ssh', reachable: 0 }];
  const nodeService = makeHeartbeatNodeService(nodes, async () => ({ code: 0 }));
  const recovered = [];
  const heartbeat = createNodeHeartbeatService({
    nodeService,
    onNodeRecovered: (nodeId) => recovered.push(nodeId),
  });

  await heartbeat.runOnce();
  await heartbeat.runOnce();

  assert.deepEqual(recovered, ['pod-a']);
  assert.deepEqual(nodeService.calls.touched, ['pod-a', 'pod-a']);
});

test('node heartbeat does not call onNodeRecovered when probe fails', async () => {
  const nodes = [{ id: 'pod-a', kind: 'ssh', reachable: 0 }];
  const nodeService = makeHeartbeatNodeService(nodes, async () => ({ code: 127 }));
  const recovered = [];
  const heartbeat = createNodeHeartbeatService({
    nodeService,
    onNodeRecovered: (nodeId) => recovered.push(nodeId),
  });

  await heartbeat.runOnce();

  assert.deepEqual(recovered, []);
  assert.deepEqual(nodeService.calls.unreachable, [{ nodeId: 'pod-a', reachable: false }]);
});

test('node heartbeat isolates onNodeRecovered throws from the probe loop', async () => {
  const nodes = [
    { id: 'pod-a', kind: 'ssh', reachable: 0 },
    { id: 'pod-b', kind: 'ssh', reachable: 0 },
  ];
  const nodeService = makeHeartbeatNodeService(nodes, async () => ({ code: 0 }));
  const seen = [];
  const heartbeat = createNodeHeartbeatService({
    nodeService,
    onNodeRecovered: (nodeId) => {
      seen.push(nodeId);
      if (nodeId === 'pod-a') throw new Error('boom');
    },
  });

  await heartbeat.runOnce();

  assert.deepEqual(seen, ['pod-a', 'pod-b']);
  assert.deepEqual(nodeService.calls.touched, ['pod-a', 'pod-b']);
});

test('node heartbeat isolates onNodeRecovered async rejections from the probe loop', async () => {
  const nodes = [
    { id: 'pod-a', kind: 'ssh', reachable: 0 },
    { id: 'pod-b', kind: 'ssh', reachable: 0 },
  ];
  const nodeService = makeHeartbeatNodeService(nodes, async () => ({ code: 0 }));
  const seen = [];
  const heartbeat = createNodeHeartbeatService({
    nodeService,
    onNodeRecovered: (nodeId) => {
      seen.push(nodeId);
      return Promise.reject(new Error('async boom'));
    },
  });

  await heartbeat.runOnce();
  // Let the swallowed rejection settle; an unhandled rejection would fail the test process.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, ['pod-a', 'pod-b']);
  assert.deepEqual(nodeService.calls.touched, ['pod-a', 'pod-b']);
});

function makeLifecycleHarness() {
  const runs = [
    {
      id: 'run-a-1',
      task_id: 'task-a-1',
      agent_profile_id: 'P1',
      status: 'queued',
      is_manager: 0,
      node_id: 'node-a',
      prompt: 'a1',
      queued_args: null,
    },
    {
      id: 'run-a-2',
      task_id: 'task-a-2',
      agent_profile_id: 'P1',
      status: 'queued',
      is_manager: 0,
      node_id: 'node-a',
      prompt: 'a2',
      queued_args: null,
    },
    {
      id: 'run-b-1',
      task_id: 'task-b-1',
      agent_profile_id: 'P1',
      status: 'queued',
      is_manager: 0,
      node_id: 'node-b',
      prompt: 'b1',
      queued_args: null,
    },
  ];
  const spawned = [];
  const runService = {
    listRuns(filter = {}) {
      return runs.filter((run) => !filter.status || run.status === filter.status);
    },
    claimQueuedRun(runId) {
      const run = runs.find((item) => item.id === runId);
      if (!run || run.status !== 'queued') return false;
      run.status = 'running';
      return true;
    },
    getRun(runId) {
      return runs.find((run) => run.id === runId) || null;
    },
    addRunEvent() {},
    setRetryCount() {},
    updateRunStatus(runId, status) {
      const run = runs.find((item) => item.id === runId);
      if (run) run.status = status;
      return run;
    },
    markRunStarted(runId, fields = {}) {
      const run = runs.find((item) => item.id === runId);
      if (run) Object.assign(run, fields, { status: 'running' });
      return run;
    },
    countRunningOnNode(nodeId, profileId) {
      return runs.filter((run) => (
        run.status === 'running'
        && (run.node_id || 'local') === nodeId
        && run.agent_profile_id === profileId
      )).length;
    },
    countRunning() {
      return runs.filter((run) => run.status === 'running').length;
    },
    getOldestQueuedOnNode(nodeId, profileId) {
      return runs.find((run) => (
        run.status === 'queued'
        && !run.is_manager
        && run.agent_profile_id === profileId
        && (run.node_id || 'local') === nodeId
      )) || null;
    },
    getOldestQueued(profileId) {
      return runs.find((run) => (
        run.status === 'queued'
        && !run.is_manager
        && run.agent_profile_id === profileId
      )) || null;
    },
  };
  const lifecycleService = createLifecycleService({
    runService,
    taskService: {
      getTask(taskId) {
        return { id: taskId, project_id: null };
      },
      updateTaskStatus() {},
    },
    agentProfileService: {
      getProfile(profileId) {
        return { id: profileId, command: 'claude', max_concurrent: 10 };
      },
    },
    projectService: {
      getProject() {
        return null;
      },
    },
    executionEngine: {},
    streamJsonEngine: {},
    nodeService: {
      getNode(nodeId) {
        return {
          id: nodeId,
          kind: 'local',
          reachable: 1,
          can_execute: 1,
          files_only: 0,
          max_concurrent: null,
        };
      },
    },
    nodeExecutor: {
      async fileExists() {
        return true;
      },
      async spawnWorker(runId, payload) {
        spawned.push({ runId, payload });
        return { sessionName: `session-${runId}` };
      },
    },
  });

  return { lifecycleService, runs, spawned };
}

test('scheduleDrainForNode drains only queued runs on the recovered node', async () => {
  const { lifecycleService, runs, spawned } = makeLifecycleHarness();

  lifecycleService.scheduleDrainForNode('node-a');
  await immediate();
  await immediate();

  assert.deepEqual(spawned.map((call) => call.runId), ['run-a-1', 'run-a-2']);
  assert.equal(runs.find((run) => run.id === 'run-b-1').status, 'queued');
});

test('drainQueue without node filter keeps draining queued runs across all nodes', async () => {
  const { lifecycleService, runs, spawned } = makeLifecycleHarness();

  const started = await lifecycleService.drainQueue('P1');

  assert.equal(started, 3);
  assert.deepEqual(spawned.map((call) => call.runId), ['run-a-1', 'run-a-2', 'run-b-1']);
  assert.deepEqual(runs.map((run) => run.status), ['running', 'running', 'running']);
});
