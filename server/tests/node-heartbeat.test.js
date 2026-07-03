const test = require('node:test');
const assert = require('node:assert/strict');

const { createNodeHeartbeatService } = require('../services/nodeHeartbeatService');

function createHarness({ nodes, executors = {}, pickExecutor } = {}) {
  const calls = {
    pickExecutor: [],
    touchHeartbeat: [],
    setReachable: [],
  };
  const nodeService = {
    listNodes: () => nodes || [],
    pickExecutor: (id) => {
      calls.pickExecutor.push(id);
      if (pickExecutor) return pickExecutor(id);
      return executors[id];
    },
    touchHeartbeat: async (id) => {
      calls.touchHeartbeat.push(id);
    },
    setReachable: async (id, reachable) => {
      calls.setReachable.push([id, reachable]);
    },
  };
  return { calls, nodeService };
}

function createExecutor(execCalls, id, impl) {
  return {
    exec: async (command, args, options) => {
      execCalls.push({ id, command, args, options });
      if (impl) return impl(command, args, options);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

test('runOnce: ssh probe success touches heartbeat and does not mark unreachable', async () => {
  const execCalls = [];
  const { calls, nodeService } = createHarness({
    nodes: [{ id: 'ssh-1', kind: 'ssh' }],
    executors: { 'ssh-1': createExecutor(execCalls, 'ssh-1') },
  });
  const heartbeat = createNodeHeartbeatService({ nodeService, intervalMs: 5000 });

  await heartbeat.runOnce();

  assert.deepEqual(calls.pickExecutor, ['ssh-1']);
  assert.deepEqual(execCalls, [{
    id: 'ssh-1',
    // Must be an allowlisted command (remote exec allowlist is ['git']); a
    // non-allowlisted probe like 'true' would COMMAND_NOT_ALLOWED-reject and
    // falsely mark every ssh node unreachable. Locked here on purpose.
    command: 'git',
    args: ['--version'],
    options: { timeoutMs: 5000 },
  }]);
  assert.deepEqual(calls.touchHeartbeat, ['ssh-1']);
  assert.deepEqual(calls.setReachable, []);
});

test('runOnce: ssh probe failure marks node unreachable and does not touch heartbeat', async () => {
  const execCalls = [];
  const { calls, nodeService } = createHarness({
    nodes: [{ id: 'ssh-1', kind: 'ssh' }],
    executors: {
      'ssh-1': createExecutor(execCalls, 'ssh-1', async () => {
        throw new Error('transport failed');
      }),
    },
  });
  const heartbeat = createNodeHeartbeatService({ nodeService });

  await heartbeat.runOnce();

  assert.deepEqual(calls.pickExecutor, ['ssh-1']);
  assert.deepEqual(execCalls.map((call) => call.id), ['ssh-1']);
  assert.deepEqual(calls.touchHeartbeat, []);
  assert.deepEqual(calls.setReachable, [['ssh-1', false]]);
});

test('runOnce: nonzero probe exit (git missing) marks unreachable, not reachable', async () => {
  // NodeExecutor.exec RESOLVES on genuine nonzero exits (127 = git not found),
  // so "did not throw" is NOT success — the service must check res.code===0.
  const execCalls = [];
  const { calls, nodeService } = createHarness({
    nodes: [{ id: 'ssh-1', kind: 'ssh' }],
    executors: {
      'ssh-1': createExecutor(execCalls, 'ssh-1', async () => ({ code: 127, stdout: '', stderr: 'git: not found' })),
    },
  });
  const heartbeat = createNodeHeartbeatService({ nodeService });

  await heartbeat.runOnce();

  assert.deepEqual(calls.touchHeartbeat, []);
  assert.deepEqual(calls.setReachable, [['ssh-1', false]]);
});

test('runOnce: non-ssh nodes are skipped entirely', async () => {
  const { calls, nodeService } = createHarness({
    nodes: [{ id: 'local', kind: 'local' }],
  });
  const heartbeat = createNodeHeartbeatService({ nodeService });

  await heartbeat.runOnce();

  assert.deepEqual(calls.pickExecutor, []);
  assert.deepEqual(calls.touchHeartbeat, []);
  assert.deepEqual(calls.setReachable, []);
});

test('runOnce: pickExecutor throw skips the ssh node without reachability writes', async () => {
  const { calls, nodeService } = createHarness({
    nodes: [{ id: 'files-only', kind: 'ssh' }],
    pickExecutor: () => {
      throw new Error('Node files-only cannot host execution');
    },
  });
  const heartbeat = createNodeHeartbeatService({ nodeService });

  await heartbeat.runOnce();

  assert.deepEqual(calls.pickExecutor, ['files-only']);
  assert.deepEqual(calls.touchHeartbeat, []);
  assert.deepEqual(calls.setReachable, []);
});

test('runOnce: one node failure never prevents other ssh nodes from being probed', async () => {
  const execCalls = [];
  const calls = {
    pickExecutor: [],
    touchHeartbeat: [],
    setReachable: [],
  };
  const nodeService = {
    listNodes: () => [
      { id: 'bad', kind: 'ssh' },
      { id: 'good', kind: 'ssh' },
    ],
    pickExecutor: (id) => {
      calls.pickExecutor.push(id);
      return createExecutor(execCalls, id);
    },
    touchHeartbeat: async (id) => {
      calls.touchHeartbeat.push(id);
      if (id === 'bad') throw new Error('heartbeat write failed');
    },
    setReachable: async (id, reachable) => {
      calls.setReachable.push([id, reachable]);
      if (id === 'bad') throw new Error('reachability write failed');
    },
  };
  const heartbeat = createNodeHeartbeatService({ nodeService });

  await assert.doesNotReject(async () => heartbeat.runOnce());

  assert.deepEqual(calls.pickExecutor, ['bad', 'good']);
  assert.deepEqual(execCalls.map((call) => call.id), ['bad', 'good']);
  assert.deepEqual(calls.touchHeartbeat, ['bad', 'good']);
  assert.deepEqual(calls.setReachable, [['bad', false]]);
});

test('start and stop manage the injected timer exactly once', () => {
  const handle = {
    unrefCalls: 0,
    unref() {
      this.unrefCalls += 1;
    },
  };
  const intervals = [];
  const cleared = [];
  const { nodeService } = createHarness();
  const heartbeat = createNodeHeartbeatService({
    nodeService,
    intervalMs: 1234,
    setIntervalFn: (fn, intervalMs) => {
      intervals.push({ fn, intervalMs });
      return handle;
    },
    clearIntervalFn: (timer) => {
      cleared.push(timer);
    },
  });

  heartbeat.stop();
  assert.deepEqual(cleared, []);

  heartbeat.start();
  heartbeat.start();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].fn, heartbeat.runOnce);
  assert.equal(intervals[0].intervalMs, 1234);
  assert.equal(handle.unrefCalls, 1);

  heartbeat.stop();
  heartbeat.stop();
  assert.deepEqual(cleared, [handle]);
});
