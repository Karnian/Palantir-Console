'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPreactEnv, flushEffects, COMPONENTS_DIR } = require('./helpers/jsdom-preact');

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

function installRosterStubs(env, {
  managerStatus,
  profiles,
  instances = [],
  specialistResult = null,
  operatorInstancesHandler = null,
}) {
  const calls = [];
  env.context.apiFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url === '/api/manager/status') {
      return typeof managerStatus === 'function' ? managerStatus({ calls, opts, url }) : managerStatus;
    }
    if (url === '/api/operator-instances') {
      const value = typeof instances === 'function' ? instances({ calls, opts, url }) : instances;
      return { instances: value };
    }
    if (url.startsWith('/api/operator-instances/')) {
      if (operatorInstancesHandler) return operatorInstancesHandler({ calls, opts, url });
      return {};
    }
    if (url === '/api/operator/profiles') {
      const value = typeof profiles === 'function' ? profiles({ calls, opts, url }) : profiles;
      return { profiles: value };
    }
    if (url === '/api/operator/specialist') {
      return specialistResult || {
        invocationId: 'inv_roster_1',
        text: 'roster specialist result',
        toolCallCount: 0,
        iterations: 1,
      };
    }
    throw new Error(`unexpected url ${url}`);
  };
  env.context.apiFetchWithToast = async (url, opts = {}) => {
    try {
      return await env.context.apiFetch(url, opts);
    } catch (err) {
      env.context.addToast(err.message, 'error');
      throw err;
    }
  };
  env.context.addToast = () => {};
  env.context.parseProjectConversationId = (id) => {
    if (typeof id !== 'string') return null;
    const prefix = 'operator:';
    if (!id.startsWith(prefix) || id.length <= prefix.length) return null;
    const projectId = id.slice(prefix.length);
    return projectId.startsWith('oi_') ? null : { projectId };
  };
  env.context.EmptyState = function EmptyState({ text, sub }) {
    return env.context.preact.h('div', { class: 'empty-state' }, `${text} ${sub || ''}`);
  };
  return calls;
}

function loadOperatorsComponents(env) {
  env.context.useEscape = () => {};
  env.loadComponent('Modal');
  env.loadComponent('SpecialistInvokePanel');
  env.loadComponent('OperatorsView');
}

function inputValue(env, el, value) {
  el.value = value;
  el.dispatchEvent(new env.window.Event('input', { bubbles: true }));
}

function createSseBrokerStub() {
  const subs = new Map();
  return {
    subscribe(channel, cb) {
      let set = subs.get(channel);
      if (!set) { set = new Set(); subs.set(channel, set); }
      set.add(cb);
      return () => {
        const current = subs.get(channel);
        if (!current) return;
        current.delete(cb);
        if (current.size === 0) subs.delete(channel);
      };
    },
    publish(channel, data = {}) {
      const set = subs.get(channel);
      if (!set) return;
      for (const cb of Array.from(set)) cb(data);
    },
    listenerCount(channel) {
      return subs.get(channel)?.size || 0;
    },
    totalListeners() {
      let total = 0;
      for (const set of subs.values()) total += set.size;
      return total;
    },
  };
}

function countCalls(calls, url) {
  return calls.filter((call) => call.url === url).length;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderOperatorsView(env, props = {}) {
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.OperatorsView, {
    runs: [],
    projects: [],
    tasks: [],
    ...props,
  }), root);
  return root;
}

test('OperatorsView renders Master, Live Operators, and Available Operators as separate sections', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  const apiCalls = installRosterStubs(env, {
    managerStatus: {
      active: true,
      top: {
        conversationId: 'top',
        run: { id: 'run_mgr_top', status: 'running', manager_adapter: 'claude-code' },
      },
      pms: [{
        conversationId: 'operator:proj_alpha',
        run: {
          id: 'run_mgr_alpha',
          status: 'running',
          manager_adapter: 'codex',
          conversation_id: 'operator:proj_alpha',
          node_id: 'node-a',
        },
      }],
    },
    profiles: [{
      id: 'op_review',
      name: 'Review analyst',
      persona: 'Checks diffs and verifies test evidence.',
      capabilities: ['registry_metadata_search'],
    }],
  });
  loadOperatorsComponents(env);

  const root = renderOperatorsView(env, {
    projects: [{ id: 'proj_alpha', name: 'Alpha Console' }],
    runs: [
      { id: 'worker-1', is_manager: 0, status: 'running', project_id: 'proj_alpha' },
      { id: 'worker-2', is_manager: 0, status: 'needs_input', project_id: 'proj_alpha' },
      { id: 'worker-3', is_manager: 0, status: 'queued', project_id: 'proj_alpha' },
      { id: 'manager-shadow', is_manager: 1, status: 'running', project_id: 'proj_alpha' },
      { id: 'worker-other', is_manager: 0, status: 'running', project_id: 'proj_beta' },
    ],
  });

  const master = await waitFor(() => {
    const el = root.querySelector('[data-role="operator-roster-master-card"]');
    assert.ok(el);
    return el;
  });
  assert.equal(master.getAttribute('href'), '#manager');
  assert.match(master.textContent, /Top/);
  assert.match(master.textContent, /claude-code/);

  const live = await waitFor(() => {
    const el = root.querySelector('[data-role="operator-roster-live-card"]');
    assert.ok(el);
    return el;
  });
  assert.equal(live.tagName, 'ARTICLE');
  assert.equal(live.getAttribute('href'), null);
  assert.equal(live.querySelector('a a'), null);
  const liveLinks = Array.from(live.querySelectorAll('a'));
  assert.equal(liveLinks.length, 2);
  assert.equal(live.querySelector('[data-role="operator-roster-live-primary-link"]').getAttribute('href'), '#manager/operator/proj_alpha');
  assert.equal(live.querySelector('[data-role="operator-roster-live-project-link"]').getAttribute('href'), '#operator/codebases/proj_alpha');
  assert.match(live.textContent, /Alpha Console/);
  assert.match(live.textContent, /코드베이스 바인딩/);
  assert.match(live.textContent, /Dispatcher/);
  assert.match(live.textContent, /Long-running/);
  assert.match(live.textContent, /codex/);
  assert.match(live.textContent, /node-a/);
  assert.equal(root.querySelector('[data-role="operator-roster-worker-count"]').textContent.trim(), '1');

  const availableSection = root.querySelector('[data-role="operator-roster-available-section"]');
  const available = availableSection.querySelector('[data-role="operator-roster-available-card"]');
  assert.ok(available);
  assert.equal(available.tagName, 'ARTICLE');
  assert.equal(available.getAttribute('href'), null);
  assert.equal(available.querySelector('a a'), null);
  const availableLinks = Array.from(available.querySelectorAll('a'));
  assert.equal(availableLinks.length, 1);
  const invokeButton = available.querySelector('[data-role="operator-roster-available-invoke-button"]');
  assert.ok(invokeButton);
  assert.equal(invokeButton.tagName, 'BUTTON');
  assert.equal(invokeButton.getAttribute('href'), null);
  assert.equal(invokeButton.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(
    available.querySelector('[data-role="operator-roster-available-profile-link"]').getAttribute('href'),
    '#operator/profiles',
  );
  assert.match(available.textContent, /Review analyst/);
  assert.match(available.textContent, /Folder-less/);
  assert.match(available.textContent, /Doer/);
  assert.match(available.textContent, /On-demand \/ Stateless/);
  assert.match(available.textContent, /Ready to invoke/);
  assert.match(available.textContent, /호출/);
  assert.match(available.textContent, /프로필 보기/);
  assert.match(available.textContent, /registry_metadata_search/);
  assert.doesNotMatch(availableSection.textContent, /Running|Online|Live|Session|Idle/);

  invokeButton.click();
  const dialog = await waitFor(() => {
    const el = root.querySelector('[role="dialog"]');
    assert.ok(el);
    return el;
  });
  assert.equal(dialog.getAttribute('aria-labelledby'), 'operator-roster-specialist-invoke-title');
  assert.equal(dialog.querySelector('#operator-roster-specialist-invoke-title').textContent, 'Review analyst');
  await waitFor(() => {
    assert.equal(dialog.querySelector('#specialist-profile').value, 'op_review');
    assert.equal(dialog.querySelector('#specialist-origin-run').value, 'manager-shadow');
  });
  assert.equal(apiCalls.some((call) => call.url === '/api/operator/specialist'), false);

  inputValue(env, dialog.querySelector('#specialist-user-text'), 'check this from roster');
  await waitFor(() => assert.equal(dialog.querySelector('button[type="submit"]').disabled, false));
  dialog.querySelector('form').dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));

  const post = await waitFor(() => {
    const call = apiCalls.find((entry) => entry.url === '/api/operator/specialist');
    assert.ok(call);
    return call;
  });
  assert.equal(post.opts.method, 'POST');
  assert.deepEqual(JSON.parse(post.opts.body), {
    profileId: 'op_review',
    userText: 'check this from roster',
    originRunId: 'manager-shadow',
  });
  await waitFor(() => assert.match(dialog.textContent, /roster specialist result/));
  assert.ok(root.querySelector('[role="dialog"]'));
});

test('OperatorsView renders watch-list badges and edits reference refs from the Live card', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  let currentInstances = [{
    id: 'oi_alpha',
    refs: [
      {
        instance_id: 'oi_alpha',
        project_id: 'proj_alpha',
        role: 'primary',
        project: { id: 'proj_alpha', name: 'Alpha Console' },
      },
      {
        instance_id: 'oi_alpha',
        project_id: 'proj_beta',
        role: 'reference',
        project: { id: 'proj_beta', name: 'Beta API' },
      },
    ],
  }];
  const apiCalls = installRosterStubs(env, {
    managerStatus: {
      active: true,
      top: {
        conversationId: 'top',
        run: { id: 'run_mgr_top', status: 'running', manager_adapter: 'claude-code' },
      },
      pms: [{
        conversationId: 'operator:oi_alpha',
        legacyConversationId: 'operator:proj_alpha',
        run: {
          id: 'run_mgr_alpha',
          status: 'running',
          manager_adapter: 'codex',
          conversation_id: 'operator:oi_alpha',
          operator_instance_id: 'oi_alpha',
        },
      }],
    },
    profiles: [],
    instances: () => currentInstances,
    operatorInstancesHandler: ({ url, opts }) => {
      if (url === '/api/operator-instances/oi_alpha/refs' && opts.method === 'POST') {
        currentInstances = [{
          ...currentInstances[0],
          refs: [
            ...currentInstances[0].refs,
            {
              instance_id: 'oi_alpha',
              project_id: 'proj_gamma',
              role: 'reference',
              project: { id: 'proj_gamma', name: 'Gamma UI' },
            },
          ],
        }];
        return { instance: currentInstances[0] };
      }
      if (url === '/api/operator-instances/oi_alpha/refs/proj_beta' && opts.method === 'DELETE') {
        currentInstances = [{
          ...currentInstances[0],
          refs: currentInstances[0].refs.filter((ref) => ref.project_id !== 'proj_beta'),
        }];
        return { instance: currentInstances[0] };
      }
      throw new Error(`unexpected operator-instances url ${url}`);
    },
  });
  loadOperatorsComponents(env);

  const root = renderOperatorsView(env, {
    projects: [
      { id: 'proj_alpha', name: 'Alpha Console' },
      { id: 'proj_beta', name: 'Beta API' },
      { id: 'proj_gamma', name: 'Gamma UI' },
    ],
  });

  const live = await waitFor(() => {
    const el = root.querySelector('[data-role="operator-roster-live-card"]');
    assert.ok(el);
    assert.match(el.textContent, /Alpha Console/);
    assert.match(el.textContent, /Beta API/);
    return el;
  });
  assert.equal(live.tagName, 'ARTICLE');
  assert.equal(live.getAttribute('href'), null);
  assert.equal(live.querySelector('a a'), null);
  assert.equal(live.querySelectorAll('[data-role="operator-watch-ref-primary"]').length, 1);
  assert.match(live.querySelector('[data-role="operator-watch-ref-primary"]').textContent, /담당/);
  assert.equal(live.querySelectorAll('[data-role="operator-watch-ref-reference"]').length, 1);
  assert.match(live.querySelector('[data-role="operator-watch-ref-reference"]').textContent, /참조/);
  assert.equal(live.querySelector('[data-role="operator-watch-ref-primary"] [data-role="operator-watch-ref-remove"]'), null);

  live.querySelector('[data-role="operator-roster-add-reference-button"]').click();
  const dialog = await waitFor(() => {
    const el = root.querySelector('[role="dialog"]');
    assert.ok(el);
    return el;
  });
  assert.equal(dialog.getAttribute('aria-labelledby'), 'operator-roster-refs-title');
  const select = dialog.querySelector('[data-role="operator-roster-ref-project-select"]');
  assert.ok(select);
  assert.deepEqual(Array.from(select.options).map((option) => option.value), ['proj_gamma']);
  assert.equal(select.value, 'proj_gamma');
  dialog.querySelector('[data-role="operator-roster-ref-submit"]').click();

  const post = await waitFor(() => {
    const call = apiCalls.find((entry) => entry.url === '/api/operator-instances/oi_alpha/refs');
    assert.ok(call);
    return call;
  });
  assert.equal(post.opts.method, 'POST');
  assert.deepEqual(JSON.parse(post.opts.body), { project_id: 'proj_gamma', role: 'reference' });
  await waitFor(() => assert.match(root.textContent, /Gamma UI/));

  const betaRemove = await waitFor(() => {
    const buttons = Array.from(root.querySelectorAll('[data-role="operator-watch-ref-remove"]'));
    const button = buttons.find((candidate) => candidate.getAttribute('aria-label').includes('Beta API'));
    assert.ok(button);
    return button;
  });
  betaRemove.click();

  const del = await waitFor(() => {
    const call = apiCalls.find((entry) => entry.url === '/api/operator-instances/oi_alpha/refs/proj_beta');
    assert.ok(call);
    return call;
  });
  assert.equal(del.opts.method, 'DELETE');
  await waitFor(() => assert.doesNotMatch(root.textContent, /Beta API/));
  assert.equal(root.querySelector('[data-role="operator-watch-ref-primary"] [data-role="operator-watch-ref-remove"]'), null);
});

test('OperatorsView renders scoped empty states for no live project operators and no available profiles', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  installRosterStubs(env, {
    managerStatus: {
      active: true,
      top: {
        conversationId: 'top',
        run: { id: 'run_mgr_top', status: 'running', manager_adapter: 'claude-code' },
      },
      pms: [],
    },
    profiles: [],
  });
  loadOperatorsComponents(env);

  const root = renderOperatorsView(env);
  const liveSection = root.querySelector('[data-role="operator-roster-live-section"]');
  await waitFor(() => assert.match(liveSection.textContent, /코드베이스 바인딩 오퍼레이터가 없습니다/));

  const availableSection = root.querySelector('[data-role="operator-roster-available-section"]');
  await waitFor(() => assert.match(availableSection.textContent, /폴더 없는 프로필이 없습니다/));
  assert.doesNotMatch(availableSection.textContent, /Running|Online|Live|Session|Idle/);
});

test('OperatorsView debounces live roster SSE events into one manager status refetch', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  const broker = createSseBrokerStub();
  env.context.sseBroker = broker;

  const calls = installRosterStubs(env, {
    managerStatus: {
      active: true,
      top: {
        conversationId: 'top',
        run: { id: 'run_mgr_top', status: 'running', manager_adapter: 'claude-code' },
      },
      pms: [],
    },
    profiles: [],
  });
  loadOperatorsComponents(env);

  renderOperatorsView(env);
  await waitFor(() => assert.equal(countCalls(calls, '/api/manager/status'), 1));
  assert.equal(countCalls(calls, '/api/operator-instances'), 1);
  assert.equal(countCalls(calls, '/api/operator/profiles'), 1);
  assert.equal(broker.listenerCount('manager:started'), 1);
  assert.equal(broker.listenerCount('manager:stopped'), 1);
  assert.equal(broker.listenerCount('run:status'), 1);
  assert.equal(broker.listenerCount('run:completed'), 1);

  broker.publish('manager:started');
  broker.publish('run:status');
  broker.publish('run:completed');

  await waitFor(() => assert.equal(countCalls(calls, '/api/manager/status'), 2), 1000);
  assert.equal(countCalls(calls, '/api/operator-instances'), 2);
  assert.equal(countCalls(calls, '/api/operator/profiles'), 1);
});

test('OperatorsView unsubscribes SSE roster listeners on unmount', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  const broker = createSseBrokerStub();
  env.context.sseBroker = broker;

  const calls = installRosterStubs(env, {
    managerStatus: {
      active: true,
      top: {
        conversationId: 'top',
        run: { id: 'run_mgr_top', status: 'running', manager_adapter: 'claude-code' },
      },
      pms: [],
    },
    profiles: [],
  });
  loadOperatorsComponents(env);

  const root = renderOperatorsView(env);
  await waitFor(() => assert.equal(countCalls(calls, '/api/manager/status'), 1));
  assert.equal(countCalls(calls, '/api/operator-instances'), 1);

  env.render(null, root);
  await flushEffects(20);
  assert.equal(broker.totalListeners(), 0);

  broker.publish('manager:stopped');
  await flushEffects(500);
  assert.equal(countCalls(calls, '/api/manager/status'), 1);
  assert.equal(countCalls(calls, '/api/operator-instances'), 1);
});

test('OperatorsView ignores stale manager status responses after a newer SSE refetch wins', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  const broker = createSseBrokerStub();
  env.context.sseBroker = broker;
  env.context.addToast = () => {};
  env.context.parseProjectConversationId = (id) => {
    if (typeof id !== 'string') return null;
    const prefix = 'operator:';
    if (!id.startsWith(prefix) || id.length <= prefix.length) return null;
    const projectId = id.slice(prefix.length);
    return projectId.startsWith('oi_') ? null : { projectId };
  };
  env.context.EmptyState = function EmptyState({ text, sub }) {
    return env.context.preact.h('div', { class: 'empty-state' }, `${text} ${sub || ''}`);
  };

  const statusRequests = [];
  env.context.apiFetch = async (url) => {
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/operator-instances') return { instances: [] };
    if (url === '/api/manager/status') {
      const request = deferred();
      statusRequests.push(request);
      return request.promise;
    }
    throw new Error(`unexpected url ${url}`);
  };
  loadOperatorsComponents(env);

  const root = renderOperatorsView(env);
  await waitFor(() => assert.equal(statusRequests.length, 1));

  broker.publish('run:status');
  await waitFor(() => assert.equal(statusRequests.length, 2), 1000);

  statusRequests[1].resolve({
    active: true,
    top: {
      conversationId: 'top',
      run: { id: 'run_mgr_latest', status: 'running', manager_adapter: 'latest-adapter' },
    },
    pms: [],
  });
  await waitFor(() => assert.match(root.textContent, /latest-adapter/));

  statusRequests[0].resolve({
    active: true,
    top: {
      conversationId: 'top',
      run: { id: 'run_mgr_stale', status: 'running', manager_adapter: 'stale-adapter' },
    },
    pms: [],
  });
  await flushEffects(20);

  assert.match(root.textContent, /latest-adapter/);
  assert.doesNotMatch(root.textContent, /stale-adapter/);
});

test('OperatorsView delegates specialist invoke contract to SpecialistInvokePanel source', () => {
  const operatorsSource = fs.readFileSync(path.join(COMPONENTS_DIR, 'OperatorsView.js'), 'utf8');
  const specialistViewSource = fs.readFileSync(path.join(COMPONENTS_DIR, 'SpecialistView.js'), 'utf8');
  const panelSource = fs.readFileSync(path.join(COMPONENTS_DIR, 'SpecialistInvokePanel.js'), 'utf8');

  assert.equal(operatorsSource.includes('/api/operator/specialist'), false);
  assert.equal(operatorsSource.includes('originAutoSelectedRef'), false);
  assert.equal(operatorsSource.includes('originRunId'), false);
  assert.equal(specialistViewSource.includes('/api/operator/specialist'), false);
  assert.equal(specialistViewSource.includes('originAutoSelectedRef'), false);
  assert.match(panelSource, /\/api\/operator\/specialist/);
  assert.match(panelSource, /originAutoSelectedRef/);
});
