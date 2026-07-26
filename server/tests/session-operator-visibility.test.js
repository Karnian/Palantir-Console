'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');
const {
  createPreactEnv,
  flushEffects,
  transformComponentSource,
} = require('./helpers/jsdom-preact');

const PUBLIC_APP = path.join(__dirname, '..', 'public', 'app');

async function waitFor(assertion, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return assertion();
    } catch (err) {
      lastError = err;
      await flushEffects(20);
    }
  }
  throw lastError;
}

function loadConversationIdHelpers(env) {
  const raw = fs.readFileSync(path.join(PUBLIC_APP, 'lib', 'conversationId.js'), 'utf8');
  const transformed = transformComponentSource(raw)
    + '\nthis.operatorConversationId = operatorConversationId;'
    + '\nthis.parseProjectConversationId = parseProjectConversationId;';
  vm.runInContext(transformed, env.context);
}

function installSessionGrid(env) {
  env.context.__attentionRuns = [];
  env.context.EmptyState = function EmptyState({ text }) {
    return env.context.preact.h('div', { class: 'empty-state' }, text);
  };
  env.context.RunInspector = () => null;
  env.context.TaskDetailPanel = () => null;
  env.context.AttentionStrip = function AttentionStrip({ runs }) {
    env.context.__attentionRuns.push(runs);
    return env.context.preact.h('div', { 'data-role': 'attention-strip-stub' });
  };
  env.context.clickableProps = (onClick) => ({ onClick, role: 'button', tabIndex: 0 });
  env.context.formatTime = (value) => value ? `시각:${value}` : '알 수 없음';
  loadConversationIdHelpers(env);
  env.loadComponent('SessionGrid');
}

function renderSessionGrid(env, props = {}) {
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.SessionGrid, {
    tasks: [],
    runs: [],
    projects: [],
    activePms: [],
    managerStatus: {},
    conversationTarget: 'top',
    onSelectConversation: () => {},
    nodeSummary: {},
    ...props,
  }), root);
  return root;
}

function operatorRun(overrides = {}) {
  return {
    id: 'run_mgr_operator',
    is_manager: 1,
    task_id: null,
    project_id: null,
    operator_instance_id: 'oi_proj_x',
    manager_adapter: 'codex',
    status: 'running',
    node_id: 'remote-node',
    started_at: '2026-07-25T01:00:00.000Z',
    ended_at: '2026-07-25T02:00:00.000Z',
    ...overrides,
  };
}

test('SessionGrid joins an instance-scoped Operator through legacyConversationId and renders a separate live row', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installSessionGrid(env);

  const selected = [];
  const managerRun = operatorRun();
  const root = renderSessionGrid(env, {
    tasks: [{
      id: 'task_x',
      project_id: 'proj_x',
      title: '칸반 진행 작업',
      status: 'in_progress',
    }],
    // The same manager run can appear in the general runs feed. It must stay
    // out of worker counts, attention rows, and the unassigned-run bucket.
    runs: [managerRun],
    projects: [{ id: 'proj_x', name: 'Project X' }],
    activePms: [{
      conversationId: 'operator:oi_proj_x',
      legacyConversationId: 'operator:proj_x',
      displayName: 'Build Operator',
      instanceId: 'oi_proj_x',
      status: 'idle',
      run: managerRun,
    }],
    conversationTarget: 'operator:oi_proj_x',
    onSelectConversation: (id) => selected.push(id),
  });

  const row = await waitFor(() => {
    const element = root.querySelector('[data-role="operator-session-row"]');
    assert.ok(element);
    return element;
  });
  assert.ok(row.classList.contains('selected'), 'canonical conversation target selects the row');
  assert.match(row.textContent, /Operator/);
  assert.match(row.textContent, /Build Operator/);
  assert.match(row.textContent, /adapter codex/);
  assert.match(row.textContent, /실행 중/);
  assert.match(row.textContent, /노드 remote-node/);
  assert.match(row.textContent, /시작 시각:2026-07-25T01:00:00.000Z/);
  assert.match(row.textContent, /종료 시각:2026-07-25T02:00:00.000Z/);

  root.querySelector('[data-role="operator-conversation-link"]').click();
  assert.deepEqual(selected, ['operator:proj_x'], 'click prefers the project-scoped legacy alias');

  assert.match(root.querySelector('[data-stat="running"]').textContent, /0 실행 중/);
  assert.match(root.querySelector('[data-stat="waiting"]').textContent, /0 대기/);
  assert.match(root.querySelector('[data-stat="failed"]').textContent, /0 실패/);
  assert.match(root.querySelector('[data-stat="operators"]').textContent, /1 Operator/);
  assert.match(root.querySelector('.worker-project-count').textContent, /활성 실행 0/);
  assert.match(root.querySelector('[data-role="task-workflow-status"]').textContent, /워크플로 진행 중/);
  assert.match(root.querySelector('[data-role="active-worker-count"]').textContent, /활성 실행 0/);
  assert.doesNotMatch(root.textContent, /미할당 런/);
  assert.deepEqual(Array.from(env.context.__attentionRuns.at(-1)), []);
});

test('SessionGrid keeps the legacy operator:<projectId> join and click fallback', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installSessionGrid(env);

  let selected = null;
  const root = renderSessionGrid(env, {
    projects: [{ id: 'proj_x', name: 'Project X' }],
    activePms: [{
      conversationId: 'operator:proj_x',
      legacyConversationId: null,
      run: operatorRun({ conversation_id: 'operator:proj_x' }),
    }],
    conversationTarget: 'operator:proj_x',
    onSelectConversation: (id) => { selected = id; },
  });

  const row = await waitFor(() => {
    const element = root.querySelector('[data-role="operator-session-row"]');
    assert.ok(element, 'legacy alias creates a taskless project group and Operator row');
    return element;
  });
  assert.ok(row.classList.contains('selected'));
  row.click();
  assert.equal(selected, 'operator:proj_x');
});

test('SessionGrid derives a project alias when only the canonical Operator id is available', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installSessionGrid(env);

  let selected = null;
  const root = renderSessionGrid(env, {
    projects: [{ id: 'proj_x', name: 'Project X' }],
    activePms: [{
      conversationId: 'operator:oi_proj_x',
      legacyConversationId: null,
      primaryProjectId: 'proj_x',
      run: operatorRun(),
    }],
    onSelectConversation: (id) => { selected = id; },
  });

  const row = await waitFor(() => {
    const element = root.querySelector('[data-role="operator-session-row"]');
    assert.ok(element);
    return element;
  });
  row.click();
  assert.equal(selected, 'operator:proj_x');
  assert.equal(env.context.parseProjectConversationId('operator:oi_x'), null);
  assert.equal(
    env.context.operatorConversationTarget({ conversationId: 'operator:oi_orphan' }, null),
    'operator:oi_orphan',
    'canonical id remains the final fallback when no project alias can be formed',
  );
});

test('SessionGrid omits missing run times and renders an available end time', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installSessionGrid(env);

  const basePm = {
    conversationId: 'operator:oi_proj_x',
    legacyConversationId: 'operator:proj_x',
    displayName: 'Build Operator',
  };
  const root = renderSessionGrid(env, {
    projects: [{ id: 'proj_x', name: 'Project X' }],
    activePms: [{
      ...basePm,
      run: operatorRun({ started_at: null, ended_at: null }),
    }],
  });

  await waitFor(() => {
    const row = root.querySelector('[data-role="operator-session-row"]');
    assert.ok(row);
    assert.doesNotMatch(row.textContent, /알 수 없음/);
    assert.doesNotMatch(row.textContent, /시작/);
    assert.doesNotMatch(row.textContent, /종료/);
  });

  renderSessionGrid(env, {
    projects: [{ id: 'proj_x', name: 'Project X' }],
    activePms: [{
      ...basePm,
      run: operatorRun({
        status: 'completed',
        started_at: null,
        ended_at: '2026-07-25T02:00:00.000Z',
      }),
    }],
  });
  await waitFor(() => {
    const row = root.querySelector('[data-role="operator-session-row"]');
    assert.match(row.textContent, /종료 시각:2026-07-25T02:00:00.000Z/);
    assert.doesNotMatch(row.textContent, /시작/);
  });
});

test('SessionGrid reflects queued/running/cancelled/completed live run transitions', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installSessionGrid(env);

  const root = env.document.getElementById('root');
  for (const [status, label] of [
    ['queued', '대기 중'],
    ['running', '실행 중'],
    ['cancelled', '취소됨'],
    ['completed', '완료'],
  ]) {
    renderSessionGrid(env, {
      projects: [{ id: 'proj_x', name: 'Project X' }],
      activePms: [{
        conversationId: 'operator:oi_proj_x',
        legacyConversationId: 'operator:proj_x',
        run: operatorRun({ status }),
      }],
    });
    await waitFor(() => {
      const statusNode = root.querySelector('[data-role="operator-run-status"]');
      assert.ok(statusNode);
      assert.equal(statusNode.textContent.trim(), label);
    });
  }
});

test('SessionGrid renders Top metadata and actual needs_input status without counting it as a worker or Operator', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installSessionGrid(env);

  const selected = [];
  const topRun = operatorRun({
    id: 'run_mgr_top',
    operator_instance_id: null,
    manager_adapter: 'claude-code',
    status: 'needs_input',
    node_id: 'top-node',
    started_at: '2026-07-25T03:00:00.000Z',
    ended_at: null,
  });
  const root = renderSessionGrid(env, {
    // The general runs feed may contain Top just like an Operator run. It must
    // remain excluded from every worker-facing aggregate.
    runs: [topRun],
    managerStatus: {
      active: true,
      run: topRun,
      top: { conversationId: 'top', run: topRun },
    },
    onSelectConversation: (id) => selected.push(id),
  });

  const row = await waitFor(() => {
    const element = root.querySelector('[data-role="top-manager-session-row"]');
    assert.ok(element);
    return element;
  });
  assert.ok(row.classList.contains('selected'), 'top conversation selection contract is preserved');
  assert.match(row.textContent, /adapter claude-code/);
  assert.match(row.textContent, /노드 top-node/);
  assert.match(row.textContent, /시작 시각:2026-07-25T03:00:00.000Z/);
  assert.doesNotMatch(row.textContent, /종료/);
  assert.doesNotMatch(row.textContent, /알 수 없음/);
  assert.equal(
    row.querySelector('[data-role="top-manager-run-status"]').textContent.trim(),
    '입력 필요',
  );
  assert.doesNotMatch(row.textContent, /활성/);

  row.click();
  assert.deepEqual(selected, ['top']);
  assert.match(root.querySelector('[data-stat="running"]').textContent, /0 실행 중/);
  assert.match(root.querySelector('[data-stat="waiting"]').textContent, /0 대기/);
  assert.match(root.querySelector('[data-stat="failed"]').textContent, /0 실패/);
  assert.match(root.querySelector('[data-stat="operators"]').textContent, /0 Operator/);
  assert.deepEqual(Array.from(env.context.__attentionRuns.at(-1)), []);
});

test('SessionGrid keeps the legacy managerStatus.run alias and omits missing Top times', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installSessionGrid(env);

  const topRun = operatorRun({
    id: 'run_mgr_top_legacy',
    operator_instance_id: null,
    status: 'running',
    node_id: null,
    started_at: null,
    ended_at: null,
  });
  const root = renderSessionGrid(env, {
    managerStatus: { active: true, run: topRun },
  });

  await waitFor(() => {
    const row = root.querySelector('[data-role="top-manager-session-row"]');
    assert.ok(row);
    assert.match(row.textContent, /노드 local/);
    assert.match(row.textContent, /실행 중/);
    assert.doesNotMatch(row.textContent, /알 수 없음/);
    assert.doesNotMatch(row.textContent, /시작/);
    assert.doesNotMatch(row.textContent, /종료/);
  });
});

function createBroker() {
  const subscriptions = new Map();
  return {
    subscribe(channel, callback) {
      let listeners = subscriptions.get(channel);
      if (!listeners) {
        listeners = new Set();
        subscriptions.set(channel, listeners);
      }
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
        if (listeners.size === 0) subscriptions.delete(channel);
      };
    },
    publish(channel, data = {}) {
      for (const callback of Array.from(subscriptions.get(channel) || [])) callback(data);
    },
    listenerCount(channel) {
      return subscriptions.get(channel)?.size || 0;
    },
  };
}

function loadManagerLifecycle(env) {
  const raw = fs.readFileSync(path.join(PUBLIC_APP, 'lib', 'hooks', 'manager.js'), 'utf8');
  const transformed = transformComponentSource(raw) + '\nthis.useManagerLifecycle = useManagerLifecycle;';
  vm.runInContext(transformed, env.context);
}

test('useManagerLifecycle refetches status on manager lifecycle SSE while inactive', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const broker = createBroker();
  const responses = [
    { active: false, run: null, top: null, pms: [] },
    { active: true, run: { id: 'run_top', status: 'running' }, top: {}, pms: [] },
    { active: true, run: { id: 'run_top', status: 'completed' }, top: {}, pms: [] },
    { active: false, run: null, top: null, pms: [] },
  ];
  let calls = 0;
  env.context.sseBroker = broker;
  env.context.addToast = () => {};
  env.context.apiFetch = async (url) => {
    assert.equal(url, '/api/manager/status');
    const response = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return response;
  };
  loadManagerLifecycle(env);

  function Probe() {
    const manager = env.context.useManagerLifecycle();
    return env.h('div', {
      'data-role': 'manager-active',
      'data-active': String(manager.status.active),
      'data-status': manager.status.run?.status || '',
    });
  }

  const root = env.document.getElementById('root');
  env.render(env.h(Probe), root);
  await waitFor(() => {
    assert.equal(calls, 1);
    assert.equal(root.querySelector('[data-role="manager-active"]').getAttribute('data-active'), 'false');
  });
  assert.equal(broker.listenerCount('manager:started'), 1);
  assert.equal(broker.listenerCount('manager:stopped'), 1);
  assert.equal(broker.listenerCount('run:status'), 1);
  assert.equal(broker.listenerCount('run:completed'), 1);

  broker.publish('manager:started');
  await waitFor(() => {
    assert.equal(calls, 2);
    assert.equal(root.querySelector('[data-role="manager-active"]').getAttribute('data-active'), 'true');
  });

  broker.publish('run:status', { run: { id: 'run_worker', is_manager: 0, status: 'running' } });
  await flushEffects(20);
  assert.equal(calls, 2, 'worker status events must not refetch manager status');

  broker.publish('run:status', { run: { id: 'run_top', is_manager: 1, status: 'completed' } });
  await waitFor(() => {
    assert.equal(calls, 3);
    assert.equal(root.querySelector('[data-role="manager-active"]').getAttribute('data-status'), 'completed');
  });

  broker.publish('manager:stopped');
  await waitFor(() => {
    assert.equal(calls, 4);
    assert.equal(root.querySelector('[data-role="manager-active"]').getAttribute('data-active'), 'false');
  });
});

async function createApiApp(t) {
  const storageRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'palantir-session-op-storage-'));
  const fsRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'palantir-session-op-fs-'));
  const dbRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'palantir-session-op-db-'));
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath: path.join(dbRoot, 'test.db'),
    authToken: null,
  });
  t.after(async () => {
    await app.shutdown();
    await fsPromises.rm(storageRoot, { recursive: true, force: true });
    await fsPromises.rm(fsRoot, { recursive: true, force: true });
    await fsPromises.rm(dbRoot, { recursive: true, force: true });
  });
  return app;
}

test('/api/manager/status exposes the instance-scoped Operator legacy alias and primary metadata', async (t) => {
  const app = await createApiApp(t);
  const runService = app.services.runService;
  const project = app.services.projectService.createProject({ name: 'Operator API Project' });
  const resolved = runService.ensurePrimaryOperatorInstanceForProject(project.id);
  app.services._rawDb.prepare(
    'UPDATE operator_instances SET display_name = ? WHERE id = ?'
  ).run('API Operator', resolved.instanceId);

  const adapter = {
    isSessionAlive: () => true,
    detectExitCode: () => null,
    getUsage: () => null,
    getSessionId: () => null,
    disposeSession: () => {},
  };
  const top = runService.createRun({
    is_manager: true,
    manager_layer: 'top',
    conversation_id: 'top',
    manager_adapter: 'codex',
  });
  runService.updateRunStatus(top.id, 'running', { force: true });
  app.managerRegistry.setActive('top', top.id, adapter);

  const operator = runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: resolved.instanceConversationId,
    operator_instance_id: resolved.instanceId,
    manager_adapter: 'codex',
  });
  runService.updateRunStatus(operator.id, 'running', { force: true });
  app.managerRegistry.setActive(resolved.instanceConversationId, operator.id, adapter);

  const response = await invokeApp(app, { method: 'GET', path: '/api/manager/status' });
  assert.equal(response.status, 200);
  const pm = response.body.pms.find(entry => entry.conversationId === resolved.instanceConversationId);
  assert.ok(pm);
  assert.equal(pm.legacyConversationId, `operator:${project.id}`);
  assert.equal(pm.primaryProjectId, project.id);
  assert.equal(pm.instanceId, resolved.instanceId);
  assert.equal(pm.displayName, 'API Operator');
  assert.equal(pm.run.id, operator.id);
  assert.equal(pm.run.status, 'running');
});
