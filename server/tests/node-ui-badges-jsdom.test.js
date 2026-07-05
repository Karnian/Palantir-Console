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

function installCommonStubs(env, apiFetch) {
  env.context.apiFetch = apiFetch || (async () => ({}));
  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.context.timeAgo = () => '방금';
  env.context.formatTime = () => '2026-07-05';
  env.context.dueDateMeta = () => null;
  env.context.useNowTick = () => 0;
  env.context.navigate = (route) => { env.window.location.hash = `#${route}`; };
  env.context.clickableProps = (onClick) => ({ onClick, role: 'button', tabIndex: 0 });
  env.context.Dropdown = function Dropdown({ value }) {
    return env.context.preact.h('span', { class: 'dropdown-stub' }, value || '');
  };
  env.context.Modal = function Modal({ open, children }) {
    return open ? env.context.preact.h('div', { class: 'modal-stub' }, children) : null;
  };
  env.context.EmptyState = function EmptyState({ text }) {
    return env.context.preact.h('div', { class: 'empty-state' }, text);
  };
  env.context.NewTaskModal = () => null;
  env.context.ExecuteModal = () => null;
  env.context.TaskDetailPanel = () => null;
  env.context.RunInspector = () => null;
  env.context.AttentionStrip = () => null;
  env.context.requestAnimationFrame = env.context.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
  env.context.cancelAnimationFrame = env.context.cancelAnimationFrame || ((id) => clearTimeout(id));
}

function renderComponent(env, Component, props) {
  const root = env.document.getElementById('root');
  env.render(env.h(Component, props), root);
  return root;
}

const task = {
  id: 'task-1',
  title: '원격 작업',
  status: 'backlog',
  priority: 'medium',
  created_at: '2026-07-05T00:00:00.000Z',
  updated_at: '2026-07-05T00:00:00.000Z',
};

test('BoardView TaskCard renders remote node badge with encoded node link', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env);
  env.loadComponent('BoardView');

  const root = renderComponent(env, env.context.BoardView, {
    tasks: [task],
    setTasks: () => {},
    projects: [],
    agents: [],
    runs: [
      { id: 'run-old', task_id: 'task-1', node_id: 'local', created_at: '2026-07-04T00:00:00.000Z' },
      { id: 'run-new', task_id: 'task-1', node_id: 'remote/node A', created_at: '2026-07-05T00:00:00.000Z' },
    ],
    onOpenRun: () => {},
    reloadTasks: () => {},
  });

  const badge = await waitFor(() => {
    const el = root.querySelector('[data-role="node-badge"]');
    assert.ok(el);
    return el;
  });
  assert.equal(badge.getAttribute('href'), '#resources/nodes/remote%2Fnode%20A');
  assert.match(badge.textContent, /remote\/node A/);
});

test('BoardView TaskCard hides node badge when latest run is local', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env);
  env.loadComponent('BoardView');

  const root = renderComponent(env, env.context.BoardView, {
    tasks: [task],
    setTasks: () => {},
    projects: [],
    agents: [],
    runs: [
      { id: 'run-old', task_id: 'task-1', node_id: 'remote-node', created_at: '2026-07-04T00:00:00.000Z' },
      { id: 'run-new', task_id: 'task-1', node_id: 'local', created_at: '2026-07-05T00:00:00.000Z' },
    ],
    onOpenRun: () => {},
    reloadTasks: () => {},
  });

  await flushEffects();
  assert.equal(root.querySelector('[data-role="node-badge"]'), null);
});

test('TaskDetailPanel renders queue reason chips only for matching non-null queued reasons', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env, async (url) => {
    if (url === '/api/nodes/summary') {
      return {
        nodes: [],
        queued: [
          { run_id: 'queued-1', queue_reason: 'node_capacity' },
          { run_id: 'queued-2', queue_reason: null },
        ],
      };
    }
    return {};
  });
  env.loadComponent('TaskModals');

  const root = renderComponent(env, env.context.TaskDetailPanel, {
    task,
    onClose: () => {},
    projects: [],
    agents: [],
    runs: [
      { id: 'queued-1', task_id: 'task-1', status: 'queued', node_id: 'remote-a', agent_name: 'Agent A', created_at: '2026-07-05T00:00:00.000Z' },
      { id: 'queued-2', task_id: 'task-1', status: 'queued', node_id: 'remote-b', agent_name: 'Agent B', created_at: '2026-07-05T00:01:00.000Z' },
    ],
    onOpenRun: () => {},
    onExecute: () => {},
    reloadTasks: () => {},
  });

  await waitFor(() => assert.equal(root.querySelectorAll('[data-role="queue-reason-chip"]').length, 1));
  assert.match(root.textContent, /노드 슬롯 대기/);
  assert.equal(root.querySelectorAll('[data-role="node-badge"]').length, 2);
});

test('SessionGrid task row renders latest remote node badge', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env);
  env.context.operatorConversationId = (projectId) => `operator:${projectId}`;
  env.context.conversationIdMatchesProject = () => false;
  env.loadComponent('SessionGrid');

  const root = renderComponent(env, env.context.SessionGrid, {
    tasks: [{ ...task, project_id: 'proj-1', status: 'todo' }],
    runs: [{ id: 'run-1', task_id: 'task-1', node_id: 'remote-session', status: 'running', created_at: '2026-07-05T00:00:00.000Z' }],
    projects: [{ id: 'proj-1', name: 'Project' }],
    activePms: [],
    managerStatus: {},
    conversationTarget: 'top',
    onSelectConversation: () => {},
  });

  const badge = await waitFor(() => {
    const el = root.querySelector('[data-role="node-badge"]');
    assert.ok(el);
    return el;
  });
  assert.equal(badge.getAttribute('href'), '#resources/nodes/remote-session');
});

test('RunInspector header renders remote node badge and queued reason chip', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env, async (url) => {
    if (url === '/api/nodes/summary') {
      return { nodes: [], queued: [{ run_id: 'run-inspect', queue_reason: 'profile_capacity' }] };
    }
    if (url.includes('/output')) return { output: '' };
    if (url.includes('/events')) return { events: [] };
    return {
      run: {
        id: 'run-inspect',
        status: 'queued',
        node_id: 'remote-inspector',
        task_title: 'Inspect task',
        agent_name: 'Agent',
        created_at: '2026-07-05T00:00:00.000Z',
      },
    };
  });
  env.loadComponent('RunInspector');

  const root = renderComponent(env, env.context.RunInspector, {
    run: {
      id: 'run-inspect',
      status: 'queued',
      node_id: 'remote-inspector',
      task_title: 'Inspect task',
      agent_name: 'Agent',
      created_at: '2026-07-05T00:00:00.000Z',
    },
    onClose: () => {},
  });

  await waitFor(() => assert.equal(root.querySelectorAll('[data-role="queue-reason-chip"]').length, 1));
  assert.equal(root.querySelector('[data-role="node-badge"]').getAttribute('href'), '#resources/nodes/remote-inspector');
  assert.match(root.textContent, /프로필 슬롯 대기/);
});
