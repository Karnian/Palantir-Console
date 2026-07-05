const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventBus } = require('../services/eventBus');
const { createNodeHeartbeatService } = require('../services/nodeHeartbeatService');

const FIXED_NOW = '2026-07-05T00:00:00.000Z';

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

function makeStatusHarness(nodes, execImpl, onReachableFlip) {
  const eventBus = createEventBus();
  const events = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'node:status') events.push(event);
  });
  const nodeService = makeHeartbeatNodeService(nodes, execImpl);
  const heartbeat = createNodeHeartbeatService({
    nodeService,
    onReachableFlip: onReachableFlip || (({ nodeId, from, to }) => {
      eventBus.emit('node:status', {
        node_id: nodeId,
        from_reachable: from,
        to_reachable: to,
        at: FIXED_NOW,
      });
    }),
  });
  return { eventBus, events, heartbeat, nodeService };
}

test('node:status emits once for a 0 to 1 heartbeat reachable flip', async () => {
  const nodes = [{ id: 'pod-a', kind: 'ssh', reachable: 0 }];
  const h = makeStatusHarness(nodes, async () => ({ code: 0 }));

  await h.heartbeat.runOnce();
  await h.heartbeat.runOnce();

  assert.equal(h.events.length, 1);
  assert.deepEqual(Object.keys(h.events[0].data).sort(), [
    'at',
    'from_reachable',
    'node_id',
    'to_reachable',
  ]);
  assert.deepEqual(h.events[0].data, {
    node_id: 'pod-a',
    from_reachable: 0,
    to_reachable: 1,
    at: FIXED_NOW,
  });
});

test('node:status emits for a 1 to 0 heartbeat reachable flip', async () => {
  const nodes = [{ id: 'pod-a', kind: 'ssh', reachable: 1 }];
  const h = makeStatusHarness(nodes, async () => ({ code: 127 }));

  await h.heartbeat.runOnce();

  assert.deepEqual(h.nodeService.calls.unreachable, [{ nodeId: 'pod-a', reachable: false }]);
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.events[0].data, {
    node_id: 'pod-a',
    from_reachable: 1,
    to_reachable: 0,
    at: FIXED_NOW,
  });
});

test('node:status does not emit when heartbeat reachable state does not flip', async () => {
  const reachableNodes = [{ id: 'pod-up', kind: 'ssh', reachable: 1 }];
  const reachableHarness = makeStatusHarness(reachableNodes, async () => ({ code: 0 }));
  await reachableHarness.heartbeat.runOnce();

  const unreachableNodes = [{ id: 'pod-down', kind: 'ssh', reachable: 0 }];
  const unreachableHarness = makeStatusHarness(unreachableNodes, async () => ({ code: 127 }));
  await unreachableHarness.heartbeat.runOnce();

  assert.equal(reachableHarness.events.length, 0);
  assert.equal(unreachableHarness.events.length, 0);
  assert.deepEqual(unreachableHarness.nodeService.calls.unreachable, [
    { nodeId: 'pod-down', reachable: false },
  ]);
});

test('node heartbeat isolates onReachableFlip throws from the probe loop', async () => {
  const nodes = [
    { id: 'pod-a', kind: 'ssh', reachable: 0 },
    { id: 'pod-b', kind: 'ssh', reachable: 0 },
  ];
  const seen = [];
  const h = makeStatusHarness(nodes, async () => ({ code: 0 }), ({ nodeId }) => {
    seen.push(nodeId);
    if (nodeId === 'pod-a') throw new Error('boom');
  });

  await h.heartbeat.runOnce();

  assert.deepEqual(seen, ['pod-a', 'pod-b']);
  assert.deepEqual(h.nodeService.calls.touched, ['pod-a', 'pod-b']);
});

test('node heartbeat isolates onReachableFlip async rejections from the probe loop', async () => {
  const nodes = [
    { id: 'pod-a', kind: 'ssh', reachable: 0 },
    { id: 'pod-b', kind: 'ssh', reachable: 0 },
  ];
  const seen = [];
  const h = makeStatusHarness(nodes, async () => ({ code: 0 }), ({ nodeId }) => {
    seen.push(nodeId);
    return Promise.reject(new Error('async boom'));
  });

  await h.heartbeat.runOnce();
  await immediate();

  assert.deepEqual(seen, ['pod-a', 'pod-b']);
  assert.deepEqual(h.nodeService.calls.touched, ['pod-a', 'pod-b']);
});

test('node heartbeat fires onReachableFlip and onNodeRecovered for the same 0 to 1 flip', async () => {
  const nodes = [{ id: 'pod-a', kind: 'ssh', reachable: 0 }];
  const flips = [];
  const recovered = [];
  const nodeService = makeHeartbeatNodeService(nodes, async () => ({ code: 0 }));
  const heartbeat = createNodeHeartbeatService({
    nodeService,
    onReachableFlip: (flip) => flips.push(flip),
    onNodeRecovered: (nodeId) => recovered.push(nodeId),
  });

  await heartbeat.runOnce();

  assert.deepEqual(flips, [{ nodeId: 'pod-a', from: 0, to: 1 }]);
  assert.deepEqual(recovered, ['pod-a']);
});
