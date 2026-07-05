'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

function installCommonStubs(env) {
  env.context.apiFetch = async () => ({});
  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.context.timeAgo = () => '방금';
  env.context.formatTime = () => '2026-07-05';
  env.context.dueDateMeta = () => null;
  env.context.useNowTick = () => 0;
  env.context.navigate = (route) => { env.window.location.hash = `#${route}`; };
  env.context.clickableProps = (onClick) => ({ onClick, role: 'button', tabIndex: 0 });
  env.context.Dropdown = function Dropdown({ value, onChange, options, ariaLabel, title }) {
    const role = ariaLabel === '배치 노드 필터'
      ? 'node-filter-select'
      : ariaLabel === '우선순위 필터'
        ? 'priority-filter-select'
        : ariaLabel === '프로젝트 필터'
          ? 'project-filter-select'
          : 'dropdown-select';
    return env.context.preact.h(
      'select',
      {
        'data-role': role,
        'aria-label': ariaLabel,
        title: title || '',
        value,
        onChange: (event) => onChange(event.target.value),
      },
      options.map(option => env.context.preact.h(
        'option',
        { key: option.value, value: option.value },
        option.label,
      )),
    );
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

const projects = [
  { id: 'project-a', name: 'Remote A', node_id: 'remote-a' },
  { id: 'project-b', name: 'Remote B', node_id: 'remote-b' },
  { id: 'project-a-2', name: 'Remote A Mirror', node_id: 'remote-a' },
  { id: 'project-local-null', name: 'Local Null', node_id: null },
  { id: 'project-local-empty', name: 'Local Empty', node_id: '' },
];

const tasks = [
  {
    id: 'task-a-high',
    title: 'Remote A High',
    status: 'todo',
    priority: 'high',
    project_id: 'project-a',
    sort_order: 1,
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
  },
  {
    id: 'task-a-low',
    title: 'Remote A Low',
    status: 'todo',
    priority: 'low',
    project_id: 'project-a-2',
    sort_order: 2,
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
  },
  {
    id: 'task-b-high',
    title: 'Remote B High',
    status: 'todo',
    priority: 'high',
    project_id: 'project-b',
    sort_order: 3,
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
  },
  {
    id: 'task-local-project',
    title: 'Local Project',
    status: 'todo',
    priority: 'medium',
    project_id: 'project-local-null',
    sort_order: 4,
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
  },
  {
    id: 'task-local-none',
    title: 'No Project Local',
    status: 'todo',
    priority: 'high',
    sort_order: 5,
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
  },
];

function renderBoard(env) {
  const root = env.document.getElementById('root');
  env.loadComponent('BoardView');
  env.render(env.h(env.context.BoardView, {
    tasks,
    setTasks: () => {},
    projects,
    agents: [],
    runs: [],
    onOpenRun: () => {},
    reloadTasks: () => {},
  }), root);
  return root;
}

function visibleTaskTitles(root) {
  return Array.from(root.querySelectorAll('.task-card-title')).map(el => el.textContent.trim());
}

async function selectValue(env, root, role, value) {
  const select = root.querySelector(`[data-role="${role}"]`);
  assert.ok(select, `${role} should exist`);
  select.value = value;
  select.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await flushEffects();
}

test('BoardView node filter options use distinct project placement nodes plus local', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env);
  const root = renderBoard(env);

  const wrapper = root.querySelector('[data-role="node-filter"]');
  assert.ok(wrapper, 'node filter wrapper should expose a stable data-role');
  assert.match(wrapper.getAttribute('title'), /배치 노드/);

  const select = root.querySelector('[data-role="node-filter-select"]');
  assert.ok(select, 'node filter select should render');
  assert.equal(select.getAttribute('aria-label'), '배치 노드 필터');
  assert.match(select.getAttribute('title'), /프로젝트 바인딩 기준/);
  assert.deepEqual(
    Array.from(select.options).map(option => option.value),
    ['', 'local', 'remote-a', 'remote-b'],
  );
  assert.deepEqual(
    Array.from(select.options).map(option => option.textContent.trim()),
    ['전체 배치 노드', '로컬 배치 노드', '배치 노드 remote-a', '배치 노드 remote-b'],
  );
});

test('BoardView node filter shows only tasks bound to the selected placement node', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env);
  const root = renderBoard(env);

  await selectValue(env, root, 'node-filter-select', 'remote-a');

  assert.deepEqual(visibleTaskTitles(root), ['Remote A High', 'Remote A Low']);
});

test('BoardView local node filter includes node-less projects and tasks without project_id', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env);
  const root = renderBoard(env);

  await selectValue(env, root, 'node-filter-select', 'local');

  assert.deepEqual(visibleTaskTitles(root), ['Local Project', 'No Project Local']);
});

test('BoardView all placement nodes option restores every task', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env);
  const root = renderBoard(env);

  await selectValue(env, root, 'node-filter-select', 'remote-b');
  assert.deepEqual(visibleTaskTitles(root), ['Remote B High']);

  await selectValue(env, root, 'node-filter-select', '');
  assert.deepEqual(visibleTaskTitles(root), [
    'Remote A High',
    'Remote A Low',
    'Remote B High',
    'Local Project',
    'No Project Local',
  ]);
});

test('BoardView node filter combines with existing filters using AND semantics', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installCommonStubs(env);
  const root = renderBoard(env);

  await selectValue(env, root, 'node-filter-select', 'remote-a');
  await selectValue(env, root, 'priority-filter-select', 'high');

  assert.deepEqual(visibleTaskTitles(root), ['Remote A High']);
});
