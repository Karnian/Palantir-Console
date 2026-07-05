'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

async function waitFor(assertion, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return assertion();
    } catch (err) {
      lastErr = err;
      await flushEffects(20);
    }
  }
  throw lastErr;
}

function createDashboardEnv(summaryRef) {
  const env = createPreactEnv();
  const subscribers = new Map();

  env.context.apiFetch = async (url) => {
    if (url === '/api/nodes/summary') return summaryRef.current;
    throw new Error(`unexpected url ${url}`);
  };
  env.context.timeAgo = () => '방금';
  env.context.formatDuration = () => '1분';
  env.context.parseDate = (value) => new Date(value);
  env.context.navigate = (route) => { env.window.location.hash = `#${route}`; };
  env.context.useNowTick = () => 0;
  env.context.dueDateMeta = () => null;
  env.context.sseBroker = {
    subscribe(channel, cb) {
      subscribers.set(channel, cb);
      return () => subscribers.delete(channel);
    },
  };
  env.context.EmptyState = function EmptyState({ text, sub }) {
    return env.context.preact.h('div', { class: 'empty-state' }, `${text} ${sub || ''}`);
  };

  env.loadComponent('DashboardView');
  return { env, subscribers };
}

function renderDashboard(env, props = {}) {
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.DashboardView, {
    tasks: [],
    runs: [],
    onOpenRun: () => {},
    onOpenTask: () => {},
    onDeleteRun: () => {},
    claudeSessions: [],
    manager: { status: {} },
    driftAudit: null,
    onOpenDrift: () => {},
    ...props,
  }), root);
  return root;
}

test('Dashboard fleet strip stays collapsed for local-only idle summary', async (t) => {
  const summaryRef = {
    current: {
      nodes: [{ node_id: 'local', name: 'Local', reachable: true, max_concurrent: 2, running_total: 0, queued_total: 0 }],
      queued: [],
      updatedAt: '2026-07-05T00:00:00.000Z',
    },
  };
  const { env } = createDashboardEnv(summaryRef);
  t.after(env.cleanup);

  const root = renderDashboard(env);
  await flushEffects();

  assert.equal(root.querySelector('[data-role="fleet-strip"]'), null);
  assert.equal(root.querySelector('[data-role="queued-total-stat"] .stat-value').textContent.trim(), '0');
});

test('Dashboard fleet strip renders queued total, unreachable warning, and per-node slots', async (t) => {
  const summaryRef = {
    current: {
      nodes: [
        { node_id: 'remote-a', name: 'Remote A', kind: 'ssh', reachable: false, max_concurrent: 3, running_total: 1, queued_total: 2 },
        { node_id: 'remote-b', name: 'Remote B', kind: 'ssh', reachable: true, max_concurrent: null, running_total: 4, queued_total: 0 },
      ],
      queued: [
        { run_id: 'q1', node_id: 'remote-a', queue_reason: 'node_unreachable' },
        { run_id: 'q2', node_id: 'remote-a', queue_reason: 'node_capacity' },
      ],
      updatedAt: '2026-07-05T00:00:00.000Z',
    },
  };
  const { env } = createDashboardEnv(summaryRef);
  t.after(env.cleanup);

  const root = renderDashboard(env);
  await waitFor(() => assert.ok(root.querySelector('[data-role="fleet-strip"]')));

  assert.equal(root.querySelector('[data-role="queued-total-stat"] .stat-value').textContent.trim(), '2');
  assert.match(root.querySelector('[data-role="fleet-unreachable-warning"]').textContent, /연결 불가 노드 1/);
  assert.equal(root.querySelectorAll('[data-role="fleet-node-row"]').length, 2);
  assert.match(root.textContent, /실행 1 · 대기 2 \/ 슬롯 3/);
  assert.match(root.textContent, /실행 4 · 대기 0 \/ 슬롯 ∞/);
});

test('Dashboard node attention item navigates to node detail and refetches on node:status', async (t) => {
  const summaryRef = {
    current: {
      nodes: [{ node_id: 'local', name: 'Local', reachable: true, max_concurrent: 2, running_total: 0, queued_total: 0 }],
      queued: [],
    },
  };
  const { env, subscribers } = createDashboardEnv(summaryRef);
  t.after(env.cleanup);

  const root = renderDashboard(env);
  await flushEffects();
  assert.equal(root.querySelector('[data-role="fleet-strip"]'), null);

  summaryRef.current = {
    nodes: [{ node_id: 'remote-a', name: 'Remote A', kind: 'ssh', reachable: false, max_concurrent: 2, running_total: 0, queued_total: 1 }],
    queued: [{ run_id: 'q1', node_id: 'remote-a', queue_reason: 'node_unreachable' }],
  };
  subscribers.get('node:status')?.({ node_id: 'remote-a' });

  const item = await waitFor(() => {
    const el = root.querySelector('[data-role="node-attention-item"]');
    assert.ok(el);
    return el;
  });
  item.click();
  assert.equal(env.window.location.hash, '#resources/nodes/remote-a');
});

test('Dashboard promotes cordoned queued nodes to node attention', async (t) => {
  const summaryRef = {
    current: {
      nodes: [{
        node_id: 'remote-c',
        name: 'Remote C',
        kind: 'ssh',
        reachable: true,
        cordoned: 1,
        max_concurrent: 2,
        running_total: 0,
        queued_total: 2,
      }],
      queued: [
        { run_id: 'q1', node_id: 'remote-c', queue_reason: 'node_cordoned' },
        { run_id: 'q2', node_id: 'remote-c', queue_reason: 'node_cordoned' },
      ],
    },
  };
  const { env } = createDashboardEnv(summaryRef);
  t.after(env.cleanup);

  const root = renderDashboard(env);

  const item = await waitFor(() => {
    const el = root.querySelector('[data-role="node-attention-item"]');
    assert.ok(el);
    return el;
  });

  assert.match(item.textContent, /Remote C 노드/);
  assert.match(item.textContent, /드레인 중 · 대기 2/);
});
