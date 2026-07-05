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

function installProjectsStubs(env, apiFetch, toasts = []) {
  env.context.apiFetch = apiFetch || (async () => ({}));
  env.context.apiFetchWithToast = async (url, options) => env.context.apiFetch(url, options);
  env.context.addToast = (message, type) => { toasts.push({ message, type }); };
  env.context.formatTime = () => '2026-07-05';
  env.context.clickableProps = (onClick) => ({ onClick, role: 'button', tabIndex: 0 });
  env.context.conversationIdMatchesProject = () => false;
  env.context.DirectoryPicker = function DirectoryPicker({ value, onSelect }) {
    return env.context.preact.h('input', {
      class: 'directory-picker-stub',
      value: value || '',
      onInput: (e) => onSelect(e.target.value),
    });
  };
  env.context.Modal = function Modal({ open, children }) {
    return open ? env.context.preact.h('div', { class: 'modal-stub' }, children) : null;
  };
  env.context.EmptyState = function EmptyState({ text }) {
    return env.context.preact.h('div', { class: 'empty-state' }, text);
  };
}

function renderProjectsView(env, props = {}) {
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.ProjectsView, {
    projects: [],
    tasks: [],
    runs: [],
    reloadProjects: () => {},
    onOpenRun: () => {},
    onOpenTask: () => {},
    ...props,
  }), root);
  return root;
}

function clickButton(root, matcher) {
  const button = Array.from(root.querySelectorAll('button')).find((candidate) => matcher(candidate.textContent));
  assert.ok(button, 'expected button to exist');
  button.click();
  return button;
}

test('ProjectsView shows queued retarget banner only after node changes and posts old node id', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const toasts = [];
  const postBodies = [];
  let reloadCount = 0;
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') {
      return {
        nodes: [
          { id: 'node-old', name: 'Old', can_execute: 1, files_only: 0, reachable: 1, max_concurrent: 1 },
          { id: 'node-new', name: 'New', can_execute: 1, files_only: 0, reachable: 1, max_concurrent: 1 },
        ],
      };
    }
    if (url === '/api/projects/proj_1' && options.method === 'PATCH') {
      return { project: { id: 'proj_1', name: 'Alpha', node_id: 'node-new', created_at: '2026-07-05T00:00:00.000Z' } };
    }
    if (url === '/api/projects/proj_1/retarget-queued' && options.method === 'POST') {
      postBodies.push(JSON.parse(options.body));
      return { moved: 2, runIds: ['run_1', 'run_2'] };
    }
    return {};
  }, toasts);
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{ id: 'proj_1', name: 'Alpha', node_id: 'node-old', created_at: '2026-07-05T00:00:00.000Z' }],
    reloadProjects: () => { reloadCount += 1; },
  });
  clickButton(root, (text) => text.includes('편집'));

  const select = await waitFor(() => {
    const el = root.querySelector('#edit-project-node');
    assert.ok(el);
    assert.ok(Array.from(el.options).some((option) => option.value === 'node-new'));
    return el;
  });
  select.value = 'node-new';
  select.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await flushEffects(20);
  clickButton(root, (text) => text.includes('저장'));

  await waitFor(() => {
    const banner = root.querySelector('[data-role="queued-retarget-suggestion"]');
    assert.ok(banner);
    assert.match(banner.textContent, /옛 노드에 대기 중인 작업/);
    assert.ok(root.querySelector('[data-role="queued-retarget-button"]'));
  });

  root.querySelector('[data-role="queued-retarget-button"]').click();

  await waitFor(() => {
    assert.deepEqual(postBodies, [{ fromNodeId: 'node-old' }]);
    assert.ok(toasts.some((toast) => toast.type === 'success' && toast.message.includes('2')));
    assert.ok(reloadCount >= 2);
  });
});

test('ProjectsView does not show queued retarget banner when node stays unchanged', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') {
      return { nodes: [{ id: 'node-old', name: 'Old', can_execute: 1, files_only: 0, reachable: 1, max_concurrent: 1 }] };
    }
    if (url === '/api/projects/proj_1' && options.method === 'PATCH') {
      return { project: { id: 'proj_1', name: 'Alpha', node_id: 'node-old', created_at: '2026-07-05T00:00:00.000Z' } };
    }
    return {};
  });
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{ id: 'proj_1', name: 'Alpha', node_id: 'node-old', created_at: '2026-07-05T00:00:00.000Z' }],
  });
  clickButton(root, (text) => text.includes('편집'));
  await waitFor(() => assert.ok(root.querySelector('#edit-project-node')));
  clickButton(root, (text) => text.includes('저장'));

  await waitFor(() => {
    assert.equal(root.querySelector('[data-role="queued-retarget-suggestion"]'), null);
    assert.equal(root.querySelector('#edit-project-node'), null);
  });
});
