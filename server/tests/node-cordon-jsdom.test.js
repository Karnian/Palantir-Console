'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

function sampleNode(overrides = {}) {
  return {
    id: 'pi',
    name: 'Raspberry Pi',
    kind: 'ssh',
    reachable: 1,
    cordoned: 0,
    ssh_user: 'ubuntu',
    ssh_host: 'pi.local',
    exposed_roots: '["/srv/workspaces"]',
    node_prefix: '/opt/bin',
    max_concurrent: 2,
    can_execute: 1,
    can_control: 0,
    files_only: 0,
    last_heartbeat_at: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function createBroker() {
  const subs = new Map();
  return {
    subscribe(channel, cb) {
      let set = subs.get(channel);
      if (!set) { set = new Set(); subs.set(channel, set); }
      set.add(cb);
      return () => set.delete(cb);
    },
  };
}

function createEnv(handler) {
  const env = createPreactEnv();
  env.context.fetch = async (url, opts = {}) => {
    const out = await handler(String(url), opts);
    if (!out) throw new Error(`unexpected url ${url}`);
    const status = out.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => out.body,
    };
  };
  env.context.apiFetch = async (url, opts = {}) => {
    const res = await env.context.fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
    return data;
  };
  env.context.apiFetchWithToast = env.context.apiFetch;
  env.context.addToast = () => {};
  env.context.parseDate = (value) => new Date(value);
  env.context.formatTime = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '알 수 없음' : d.toLocaleString();
  };
  env.context.sseBroker = createBroker();
  env.context.useEscape = () => {};
  env.context.EmptyState = function EmptyState({ text, sub }) {
    return env.context.preact.h('div', { class: 'empty-state' }, [text, sub]);
  };
  env.context.Modal = function Modal({ open, children }) {
    return open ? env.context.preact.h('div', { class: 'modal-panel' }, children) : null;
  };
  env.loadComponent('NodesView');
  return env;
}

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

function renderNodes(env, props = {}) {
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');
  render(h(env.context.NodesView, props), root);
  return root;
}

function summaryFor(node) {
  return {
    nodes: [{
      node_id: node.id,
      reachable: Number(node.reachable) === 1 ? 1 : 0,
      can_execute: Number(node.can_execute) === 1 ? 1 : 0,
      files_only: Number(node.files_only) === 1 ? 1 : 0,
      cordoned: Number(node.cordoned) === 1 ? 1 : 0,
      max_concurrent: node.max_concurrent ?? null,
      running_total: 0,
      queued_total: 0,
      running_by_profile: {},
      queued_by_profile: {},
    }],
    queued: [],
    updatedAt: '2026-07-04T00:00:00.000Z',
  };
}

test('NodesView renders cordon badge and PATCHes detail toggle', async (t) => {
  let node = sampleNode();
  const patchCalls = [];
  const env = createEnv(async (url, opts = {}) => {
    if (url === '/api/nodes') return { body: { nodes: [node] } };
    if (url === '/api/nodes/summary') return { body: summaryFor(node) };
    if (url === '/api/runs') return { body: { runs: [] } };
    if (url === '/api/nodes/pi/usage') return { body: { node, clis: [], updatedAt: '2026-07-04T00:00:00.000Z' } };
    if (url === '/api/nodes/pi' && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      patchCalls.push(body);
      node = { ...node, cordoned: body.cordoned };
      return { body: { node } };
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi' });
  await waitFor(() => assert.ok(root.querySelector('[data-role="node-cordon-toggle"]')));
  const toggle = root.querySelector('[data-role="node-cordon-toggle"]');
  assert.match(toggle.textContent, /드레인 모드/);
  assert.equal(root.querySelector('[data-role="node-cordoned-badge"]'), null);

  toggle.click();
  await waitFor(() => assert.deepEqual(patchCalls, [{ cordoned: 1 }]));
  await waitFor(() => assert.ok(root.querySelector('[data-role="node-cordoned-badge"]')));
  assert.match(root.querySelector('[data-role="node-cordoned-badge"]').textContent, /드레인 모드/);
  assert.match(root.querySelector('[data-role="node-cordon-toggle"]').textContent, /드레인 해제/);
});
