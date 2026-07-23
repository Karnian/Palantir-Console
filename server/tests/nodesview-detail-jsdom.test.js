'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function sampleNode(overrides = {}) {
  return {
    id: 'pi',
    name: 'Raspberry Pi',
    kind: 'ssh',
    reachable: 1,
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

function usageResponse(nodeId = 'pi', clis = null) {
  return {
    node: { id: nodeId, name: nodeId, kind: 'ssh', reachable: 1 },
    clis: clis || [
      {
        id: 'codex',
        installed: true,
        version: 'codex-cli 0.140.0',
        usage: {
          limits: [
            { label: '5h window', remainingPct: 72, resetAt: '2026-07-04T06:00:00.000Z' },
            { label: 'weekly', remainingPct: 18, resetAt: '2026-07-11T00:00:00.000Z', errorMessage: 'near limit' },
          ],
          account: { email: 'dev@example.com', planType: 'Plus', type: 'chatgpt' },
          updatedAt: '2026-07-04T00:10:00.000Z',
        },
        authStatus: null,
        error: null,
        updatedAt: '2026-07-04T00:10:00.000Z',
      },
      {
        id: 'claude',
        installed: false,
        version: null,
        usage: null,
        authStatus: null,
        error: { code: 'not_installed', message: 'claude not found' },
        updatedAt: '2026-07-04T00:10:01.000Z',
      },
    ],
    updatedAt: '2026-07-04T00:10:02.000Z',
  };
}

function emptySummary() {
  return { nodes: [], queued: [], updatedAt: '2026-07-04T00:00:00.000Z' };
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
    publish(channel, data) {
      const set = subs.get(channel);
      if (!set) return;
      for (const cb of Array.from(set)) cb(data);
    },
  };
}

function defaultApi(url) {
  if (url === '/api/nodes/summary') return { body: emptySummary() };
  if (url === '/api/runs') return { body: { runs: [] } };
  return null;
}

function createEnv(handler) {
  const env = createPreactEnv();

  env.context.fetch = async (url, opts = {}) => {
    let out;
    try {
      out = await handler(String(url), opts);
    } catch (err) {
      out = defaultApi(String(url));
      if (!out) throw err;
    }
    if (!out) out = defaultApi(String(url));
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
    let data;
    try { data = await res.json(); }
    catch { throw new Error(`Request failed: ${res.status}`); }
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
  env.context.EmptyState = function EmptyState({ icon, text, sub }) {
    return env.context.preact.h('div', { class: 'empty-state' }, [
      env.context.preact.h('div', { class: 'empty-state-icon' }, icon),
      env.context.preact.h('div', { class: 'empty-state-text' }, text),
      env.context.preact.h('div', { class: 'empty-state-sub' }, sub),
    ]);
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

test('NodesView detail renders node usage cards with limits and error labels', async (t) => {
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode()] } };
    if (url === '/api/nodes/pi/usage') return { body: usageResponse() };
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi' });
  await waitFor(() => assert.equal(root.querySelectorAll('[data-role="node-usage-card"]').length, 2));

  assert.ok(root.querySelector('[data-role="node-detail"]'), 'detail root should render');
  assert.equal(root.querySelector('[data-role="node-detail-back"]').getAttribute('href'), '#resources/nodes');
  assert.match(root.textContent, /Raspberry Pi/);
  assert.match(root.textContent, /5h window/);
  assert.match(root.textContent, /72% 남음/);
  assert.ok(root.querySelector('.node-usage-bar-fill.ok'), 'remainingPct bar should render with tone class');
  assert.match(root.textContent, /near limit/);
  assert.match(root.textContent, /dev@example\.com/);
  assert.match(root.textContent, /미설치/);
});

test('NodesView detail renders installed=false and every node usage error label', async (t) => {
  const codes = [
    ['not_installed', '미설치'],
    ['probe_failed', '조회 실패'],
    ['timeout', '시간 초과'],
    ['transport_lost', '노드 연결 끊김'],
    ['no_data', '데이터 없음'],
    ['not_logged_in', '미로그인'],
    ['quota_unsupported', '쿼터 조회 미지원(v2)'],
  ];
  const clis = codes.map(([code], i) => ({
    id: `cli-${i}`,
    installed: code !== 'not_installed',
    version: code === 'not_installed' ? null : '1.0.0',
    usage: null,
    authStatus: null,
    error: { code, message: `${code} message` },
    updatedAt: '2026-07-04T00:10:00.000Z',
  }));
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode()] } };
    if (url === '/api/nodes/pi/usage') return { body: usageResponse('pi', clis) };
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi' });
  await waitFor(() => assert.equal(root.querySelectorAll('[data-role="node-usage-card"]').length, codes.length));

  for (const [, label] of codes) {
    assert.match(root.textContent, new RegExp(label.replace(/[()]/g, '\\$&')));
  }
  assert.match(root.textContent, /버전: —/);
});

test('NodesView detail distinguishes installed, not-installed, and unknown states', async (t) => {
  const clis = [
    { id: 'installed-cli', installed: true },
    { id: 'missing-cli', installed: false },
    { id: 'unknown-cli', installed: null },
  ].map(cli => ({
    ...cli,
    version: null,
    usage: null,
    authStatus: null,
    error: null,
    updatedAt: '2026-07-04T00:10:00.000Z',
  }));
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode()] } };
    if (url === '/api/nodes/pi/usage') return { body: usageResponse('pi', clis) };
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi' });
  await waitFor(() => assert.equal(root.querySelectorAll('[data-role="node-usage-card"]').length, clis.length));

  const statusFor = id => root.querySelector(`[data-cli-id="${id}"] .node-usage-card-status`).textContent;
  assert.equal(statusFor('installed-cli'), '설치됨');
  assert.equal(statusFor('missing-cli'), '미설치');
  assert.equal(statusFor('unknown-cli'), '설치 여부 확인 안 됨');
});

test('NodesView detail refresh button refetches usage', async (t) => {
  let usageCalls = 0;
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode()] } };
    if (url === '/api/nodes/pi/usage') {
      usageCalls += 1;
      return { body: usageResponse('pi', [{
        id: 'codex',
        installed: true,
        version: `v${usageCalls}`,
        usage: { limits: [{ label: `limit ${usageCalls}`, remainingPct: 55, resetAt: null }], account: null, updatedAt: '2026-07-04T00:10:00.000Z' },
        authStatus: null,
        error: null,
        updatedAt: '2026-07-04T00:10:00.000Z',
      }]) };
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi' });
  await waitFor(() => assert.match(root.textContent, /limit 1/));

  root.querySelector('[data-role="node-usage-refresh"]').click();
  await waitFor(() => assert.match(root.textContent, /limit 2/));
  assert.equal(usageCalls, 2);
});

test('NodesView detail retry recovers after a failed usage fetch', async (t) => {
  let usageCalls = 0;
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode()] } };
    if (url === '/api/nodes/pi/usage') {
      usageCalls += 1;
      if (usageCalls === 1) return { status: 500, body: { error: 'probe failed' } };
      return { body: usageResponse('pi', [{
        id: 'codex',
        installed: true,
        version: 'recovered',
        usage: { limits: [{ label: 'recovered limit', remainingPct: 44, resetAt: null }], account: null, updatedAt: '2026-07-04T00:10:00.000Z' },
        authStatus: null,
        error: null,
        updatedAt: '2026-07-04T00:10:00.000Z',
      }]) };
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi' });
  await waitFor(() => assert.ok(root.querySelector('[data-role="node-detail-error"]')));
  assert.match(root.textContent, /probe failed/);

  root.querySelector('[data-role="node-usage-retry"]').click();
  await waitFor(() => assert.match(root.textContent, /recovered limit/));

  assert.equal(usageCalls, 2);
  assert.equal(root.querySelector('[data-role="node-detail-error"]'), null);
});

test('NodesView detail async fence ignores a slow previous usage response', async (t) => {
  const slow = deferred();
  let slowStarted = false;
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode({ id: 'slow', name: 'Slow Node' }), sampleNode({ id: 'fast', name: 'Fast Node' })] } };
    if (url === '/api/nodes/slow/usage') {
      slowStarted = true;
      return slow.promise;
    }
    if (url === '/api/nodes/fast/usage') {
      return { body: usageResponse('fast', [{
        id: 'fast-cli',
        installed: true,
        version: 'fast',
        usage: { limits: [{ label: 'fast limit', remainingPct: 90, resetAt: null }], account: null, updatedAt: '2026-07-04T00:10:00.000Z' },
        authStatus: null,
        error: null,
        updatedAt: '2026-07-04T00:10:00.000Z',
      }]) };
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'slow' });
  await waitFor(() => assert.equal(slowStarted, true));

  renderNodes(env, { detailId: 'fast' });
  await waitFor(() => assert.match(root.textContent, /fast limit/));

  slow.resolve({ body: usageResponse('slow', [{
    id: 'slow-cli',
    installed: true,
    version: 'slow',
    usage: { limits: [{ label: 'slow limit', remainingPct: 12, resetAt: null }], account: null, updatedAt: '2026-07-04T00:10:00.000Z' },
    authStatus: null,
    error: null,
    updatedAt: '2026-07-04T00:10:00.000Z',
  }]) });
  await flushEffects(80);

  assert.match(root.textContent, /fast limit/);
  assert.doesNotMatch(root.textContent, /slow limit/);
});

test('NodesView detail shows not-found for usage 404', async (t) => {
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode({ id: 'gone' })] } };
    if (url === '/api/nodes/gone/usage') return { status: 404, body: { error: 'Node not found' } };
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'gone' });
  await waitFor(() => assert.ok(root.querySelector('[data-role="node-detail-not-found"]')));

  assert.match(root.textContent, /노드를 찾을 수 없습니다/);
  assert.equal(root.querySelector('[data-role="node-detail-back"]').getAttribute('href'), '#resources/nodes');
});

test('NodesView without detailId keeps rendering the existing list surface', async (t) => {
  let usageCalls = 0;
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode()] } };
    if (url.includes('/usage')) {
      usageCalls += 1;
      return { body: usageResponse() };
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env);
  await waitFor(() => assert.equal(root.querySelectorAll('.skill-pack-card').length, 1));

  assert.equal(root.querySelector('[data-role="node-detail"]'), null);
  assert.equal(root.querySelector('[data-role="node-detail-link"]').getAttribute('href'), '#resources/nodes/pi');
  assert.match(root.textContent, /새 노드/);
  assert.equal(usageCalls, 0);
});

test('NodesView detail single-encodes ids with spaces in the usage fetch URL', async (t) => {
  // Codex U-2 review S1 regression: app.js decodes the route part, so the
  // component receives the RAW id and must encode exactly once.
  const fetched = [];
  const env = createEnv(async (url) => {
    fetched.push(url);
    if (url === '/api/nodes') return { body: { nodes: [sampleNode({ id: 'pod a', name: 'Pod A' })] } };
    if (url === '/api/nodes/pod%20a/usage') return { body: usageResponse('pod a') };
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pod a' });
  await waitFor(() => assert.equal(root.querySelectorAll('[data-role="node-usage-card"]').length, 2));
  assert.ok(fetched.includes('/api/nodes/pod%20a/usage'), 'usage fetch must single-encode the id');
});

test('NodesView detail shows a section empty state for clis: []', async (t) => {
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode()] } };
    if (url === '/api/nodes/pi/usage') return { body: usageResponse('pi', []) };
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi' });
  await waitFor(() => assert.ok(root.querySelector('[data-role="node-usage-no-clis"]')));
  assert.equal(root.querySelectorAll('[data-role="node-usage-card"]').length, 0);
});

test('NodesView detail renders summary-backed running and queued runs for this node only', async (t) => {
  const summary = {
    nodes: [
      { node_id: 'pi', name: 'Raspberry Pi', reachable: 1, running_total: 1, queued_total: 1 },
      { node_id: 'other', name: 'Other', reachable: 1, running_total: 0, queued_total: 1 },
    ],
    queued: [
      { run_id: 'run_pi_queued', task_id: 'task_pi', project_id: 'proj1', agent_profile_id: 'worker', node_id: 'pi', queue_reason: 'node_capacity', enqueued_at: '2026-07-04T00:00:00.000Z' },
      { run_id: 'run_other_queued', task_id: 'task_other', project_id: 'proj1', agent_profile_id: 'worker', node_id: 'other', queue_reason: 'node_unreachable', enqueued_at: '2026-07-04T00:01:00.000Z' },
    ],
    updatedAt: '2026-07-04T00:02:00.000Z',
  };
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode(), sampleNode({ id: 'other', name: 'Other' })] } };
    if (url === '/api/runs') return { body: { runs: [
      { id: 'run_pi_running', task_id: 'task_running', agent_profile_id: 'worker', node_id: 'pi', status: 'running', is_manager: 0, created_at: '2026-07-04T00:00:00.000Z' },
      { id: 'run_other_running', task_id: 'task_other', agent_profile_id: 'worker', node_id: 'other', status: 'running', is_manager: 0, created_at: '2026-07-04T00:00:00.000Z' },
    ] } };
    if (url === '/api/nodes/pi/usage') return { body: usageResponse('pi', []) };
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi', nodeSummary: summary });
  await waitFor(() => assert.ok(root.querySelector('[data-role="node-run-list"]')));

  assert.match(root.querySelector('[data-role="node-run-list"]').textContent, /실행 중: 1/);
  assert.match(root.querySelector('[data-role="node-run-list"]').textContent, /대기 중: 1/);
  assert.equal(root.querySelectorAll('[data-role="node-running-run"]').length, 1);
  assert.equal(root.querySelector('[data-role="node-running-run"]').getAttribute('href'), '#run/run_pi_running');
  assert.equal(root.querySelectorAll('[data-role="node-queued-run"]').length, 1);
  assert.equal(root.querySelector('[data-role="node-queued-run"]').getAttribute('href'), '#run/run_pi_queued');
  assert.match(root.textContent, /노드 슬롯 대기/);
  assert.doesNotMatch(root.textContent, /task_other/);
});

test('NodesView detail shows Operator session link only for active operator manager runs on this node', async (t) => {
  const summary = {
    nodes: [{ node_id: 'pi', name: 'Raspberry Pi', reachable: 1, running_total: 0, queued_total: 0 }],
    queued: [],
    updatedAt: '2026-07-04T00:02:00.000Z',
  };
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode()] } };
    if (url === '/api/runs') return { body: { runs: [
      { id: 'run_mgr_top', node_id: 'pi', status: 'running', is_manager: 1, conversation_id: 'top', manager_layer: 'top' },
      { id: 'run_mgr_other_operator', node_id: 'other', status: 'running', is_manager: 1, conversation_id: 'operator:other', manager_layer: 'operator' },
      { id: 'run_mgr_operator', node_id: 'pi', status: 'running', is_manager: 1, conversation_id: 'operator:proj1', manager_layer: 'operator' },
    ] } };
    if (url === '/api/nodes/pi/usage') return { body: usageResponse('pi', []) };
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi', nodeSummary: summary });
  await waitFor(() => assert.ok(root.querySelector('[data-role="node-operator-link"]')));

  const link = root.querySelector('[data-role="node-operator-link"]');
  assert.equal(link.getAttribute('href'), '#manager');
  assert.match(link.textContent, /Operator 세션 열기/);
  assert.equal(link.getAttribute('title'), 'operator:proj1');
});

test('NodesView detail updates reachable chip after node:status SSE refreshes summary', async (t) => {
  let reachable = 1;
  let usageCalls = 0;
  const env = createEnv(async (url) => {
    if (url === '/api/nodes') return { body: { nodes: [sampleNode({ reachable })] } };
    if (url === '/api/nodes/summary') return { body: {
      nodes: [{ node_id: 'pi', name: 'Raspberry Pi', reachable, running_total: 0, queued_total: 0 }],
      queued: [],
      updatedAt: '2026-07-04T00:02:00.000Z',
    } };
    if (url === '/api/runs') return { body: { runs: [] } };
    if (url === '/api/nodes/pi/usage') {
      usageCalls += 1;
      return { body: usageResponse('pi', [{
        id: 'codex',
        installed: true,
        version: 'stable',
        usage: { limits: [{ label: 'stable limit', remainingPct: 66, resetAt: null }], account: null, updatedAt: '2026-07-04T00:10:00.000Z' },
        authStatus: null,
        error: null,
        updatedAt: '2026-07-04T00:10:00.000Z',
      }]) };
    }
    throw new Error(`unexpected url ${url}`);
  });
  t.after(env.cleanup);

  const root = renderNodes(env, { detailId: 'pi' });
  await waitFor(() => assert.match(root.textContent, /stable limit/));
  assert.match(root.textContent, /연결됨/);
  assert.equal(usageCalls, 1);

  reachable = 0;
  env.context.sseBroker.publish('node:status', { node_id: 'pi', from_reachable: 1, to_reachable: 0, at: '2026-07-04T00:03:00.000Z' });

  await waitFor(() => assert.match(root.textContent, /연결 끊김/));
  assert.ok(root.querySelector('.node-status-dot.unreachable'));
  assert.match(root.textContent, /stable limit/);
  assert.equal(usageCalls, 1);
});
