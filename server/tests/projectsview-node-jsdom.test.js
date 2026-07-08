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
  env.context.apiFetchWithToast = async (url, options = {}) => {
    try {
      return await env.context.apiFetch(url, options);
    } catch (err) {
      const message = typeof options.errorMessage === 'function'
        ? options.errorMessage(err)
        : options.errorMessage || err.message;
      env.context.addToast(message, 'error');
      throw err;
    }
  };
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

test('ProjectsView node select renders health and slot labels plus unreachable warning', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installProjectsStubs(env, async (url) => {
    if (url === '/api/nodes') {
      return {
        nodes: [
          { id: 'node-a', name: 'Node A', can_execute: 1, files_only: 0, reachable: 1, max_concurrent: 3, running_count: 1 },
          { id: 'node-down', name: 'Node Down', can_execute: 1, files_only: 0, reachable: 0, max_concurrent: 2, running_count: 0 },
        ],
      };
    }
    return {};
  });
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env);
  clickButton(root, (text) => text.includes('새 코드베이스'));

  const select = await waitFor(() => {
    const el = root.querySelector('#new-project-node');
    assert.ok(el);
    assert.ok(Array.from(el.options).some((option) => option.textContent.includes('● Node A (node-a) · 슬롯 2/3')));
    assert.ok(Array.from(el.options).some((option) => option.textContent.includes('○ Node Down (node-down) · 슬롯 2/2')));
    return el;
  });

  select.value = 'node-down';
  select.dispatchEvent(new env.window.Event('change', { bubbles: true }));

  await waitFor(() => {
    const warning = root.querySelector('[data-role="project-node-warning"]');
    assert.ok(warning);
    assert.match(warning.textContent, /선택한 노드는 현재 연결되지 않았습니다/);
  });
});

test('ProjectsView shows rebind 409 guidance and reset action', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let resetCalled = false;
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') {
      return { nodes: [{ id: 'node-a', name: 'Node A', can_execute: 1, files_only: 0, reachable: 1, max_concurrent: 1 }] };
    }
    if (url === '/api/projects/proj_1' && options.method === 'PATCH') {
      const err = new Error('operator thread is bound to the current node — reset the operator before rebinding');
      err.status = 409;
      throw err;
    }
    if (url === '/api/projects/proj_1/reset' && options.method === 'POST') {
      resetCalled = true;
      return { status: 'reset' };
    }
    return {};
  });
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{ id: 'proj_1', name: 'Alpha', created_at: '2026-07-05T00:00:00.000Z' }],
  });
  clickButton(root, (text) => text.includes('편집'));

  await waitFor(() => assert.ok(root.querySelector('#edit-project-name')));
  clickButton(root, (text) => text.includes('저장'));

  await waitFor(() => {
    const guidance = root.querySelector('[data-role="operator-rebind-guidance"]');
    assert.ok(guidance);
    assert.match(guidance.textContent, /Operator 를 먼저 리셋해야 합니다/);
    assert.ok(root.querySelector('[data-role="operator-reset-button"]'));
  });

  root.querySelector('[data-role="operator-reset-button"]').click();

  await waitFor(() => {
    assert.equal(resetCalled, true);
    assert.match(root.querySelector('[data-role="operator-rebind-guidance"]').textContent, /다시 저장하세요/);
  });
});

test('ProjectsView warm operator action maps 409, 400, and 502 errors to friendly toasts without navigating', async (t) => {
  for (const { status, expected } of [
    { status: 409, expected: '먼저 Top 매니저를 시작하거나 노드/설정을 확인하세요.' },
    { status: 400, expected: '오퍼레이터 인증을 확인하세요.' },
    { status: 502, expected: '오퍼레이터 준비에 실패했습니다. 어댑터 또는 실행기를 확인하세요.' },
  ]) {
    const env = createPreactEnv();
    t.after(env.cleanup);
    const toasts = [];
    installProjectsStubs(env, async (url, options = {}) => {
      if (url === '/api/nodes') return { nodes: [] };
      if (url === '/api/manager/pm/proj_1/warm' && options.method === 'POST') {
        const err = new Error(`warm failed ${status}`);
        err.status = status;
        throw err;
      }
      return {};
    }, toasts);
    env.loadComponent('ProjectsView');

    const root = renderProjectsView(env, {
      projects: [{ id: 'proj_1', name: 'Alpha', created_at: '2026-07-05T00:00:00.000Z' }],
    });

    const button = await waitFor(() => {
      const el = root.querySelector('[data-role="project-warm-operator"]');
      assert.ok(el);
      return el;
    });
    button.click();

    await waitFor(() => {
      assert.ok(toasts.some((toast) => toast.type === 'error' && toast.message === expected));
      assert.equal(env.window.location.hash, '');
      assert.equal(button.disabled, false);
    });
  }
});
