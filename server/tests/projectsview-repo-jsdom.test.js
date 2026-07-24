'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects, pickDropdownOption } = require('./helpers/jsdom-preact');

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

function setInput(env, input, value) {
  assert.ok(input, 'expected input to exist');
  input.value = value;
  input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
}

// Dropdown unification (2026-07-23): these controls are shared `Dropdown`
// components now, so a value change is an open-click + option-click rather
// than a `<select>.value` assignment.
async function setSelect(env, trigger, value) {
  assert.ok(trigger, 'expected dropdown trigger to exist');
  await pickDropdownOption(env, trigger, value);
}

test('ProjectsView project source defaults to git and toggles repo/legacy fields', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installProjectsStubs(env, async (url) => {
    if (url === '/api/nodes') return { nodes: [] };
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env);
  clickButton(root, (text) => text.includes('새 프로젝트 폴더'));

  const sourceToggle = await waitFor(() => {
    const el = root.querySelector('[data-role="project-source-toggle"]');
    assert.ok(el);
    assert.equal(el.dataset.value, 'git');
    assert.ok(root.querySelector('[data-role="project-repo-url"]'));
    assert.equal(root.querySelector('[data-role="project-legacy-directory"]'), null);
    return el;
  });

  await setSelect(env, sourceToggle, 'legacy_directory');

  await waitFor(() => {
    assert.equal(root.querySelector('[data-role="project-repo-url"]'), null);
    assert.ok(root.querySelector('[data-role="project-legacy-directory"]'));
    assert.ok(root.querySelector('.directory-picker-stub'));
  });

  await setSelect(env, root.querySelector('[data-role="project-source-toggle"]'), 'git');

  await waitFor(() => {
    assert.ok(root.querySelector('[data-role="project-repo-url"]'));
    assert.equal(root.querySelector('[data-role="project-legacy-directory"]'), null);
  });
});

test('ProjectsView create sends git source payload without legacy directory fields', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let postBody = null;
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/projects' && options.method === 'POST') {
      postBody = JSON.parse(options.body);
      return { project: { id: 'proj_git' } };
    }
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env);
  clickButton(root, (text) => text.includes('새 프로젝트 폴더'));

  await waitFor(() => assert.ok(root.querySelector('[data-role="project-repo-url"]')));
  setInput(env, root.querySelector('#new-project-name'), 'Repo Project');
  setInput(env, root.querySelector('[data-role="project-repo-url"]'), 'https://github.com/acme/repo.git');
  setInput(env, root.querySelector('[data-role="project-repo-ref"]'), 'main');
  setInput(env, root.querySelector('[data-role="project-repo-subdir"]'), 'apps/web');
  await setSelect(env, root.querySelector('[data-role="project-mcp-source"]'), 'repo_relpath');

  await waitFor(() => assert.ok(root.querySelector('[data-role="project-mcp-config-relpath"]')));
  setInput(env, root.querySelector('[data-role="project-mcp-config-relpath"]'), '.palantir/mcp.json');
  await flushEffects(20);
  clickButton(root, (text) => text.includes('생성'));

  await waitFor(() => {
    assert.ok(postBody);
    assert.equal(postBody.source_type, 'git');
    assert.equal(postBody.repo_url, 'https://github.com/acme/repo.git');
    assert.equal(postBody.repo_ref, 'main');
    assert.equal(postBody.repo_subdir, 'apps/web');
    assert.equal(postBody.mcp_config_source, 'repo_relpath');
    assert.equal(postBody.mcp_config_relpath, '.palantir/mcp.json');
    assert.equal(Object.hasOwn(postBody, 'directory'), false);
    assert.equal(Object.hasOwn(postBody, 'allow_non_git_dir'), false);
    assert.equal(Object.hasOwn(postBody, 'mcp_config_path'), false);
  });
});

test('ProjectsView create sends legacy directory payload without repo fields', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let postBody = null;
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/projects' && options.method === 'POST') {
      postBody = JSON.parse(options.body);
      return { project: { id: 'proj_legacy' } };
    }
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env);
  clickButton(root, (text) => text.includes('새 프로젝트 폴더'));

  const sourceToggle = await waitFor(() => {
    const el = root.querySelector('[data-role="project-source-toggle"]');
    assert.ok(el);
    return el;
  });
  await setSelect(env, sourceToggle, 'legacy_directory');

  await waitFor(() => assert.ok(root.querySelector('.directory-picker-stub')));
  setInput(env, root.querySelector('#new-project-name'), 'Legacy Project');
  setInput(env, root.querySelector('.directory-picker-stub'), '/srv/projects/legacy');
  setInput(env, root.querySelector('[data-role="project-mcp-config-path"]'), '/srv/projects/mcp.json');
  const allow = root.querySelector('#new-project-allow-non-git-dir');
  allow.checked = true;
  allow.dispatchEvent(new env.window.Event('change', { bubbles: true }));
  await flushEffects(20);
  clickButton(root, (text) => text.includes('생성'));

  await waitFor(() => {
    assert.ok(postBody);
    assert.equal(postBody.source_type, 'legacy_directory');
    assert.equal(postBody.directory, '/srv/projects/legacy');
    assert.equal(postBody.mcp_config_path, '/srv/projects/mcp.json');
    assert.equal(postBody.allow_non_git_dir, 1);
    assert.equal(Object.hasOwn(postBody, 'repo_url'), false);
    assert.equal(Object.hasOwn(postBody, 'repo_ref'), false);
    assert.equal(Object.hasOwn(postBody, 'repo_subdir'), false);
    assert.equal(Object.hasOwn(postBody, 'mcp_config_source'), false);
    assert.equal(Object.hasOwn(postBody, 'mcp_config_relpath'), false);
  });
});

test('ProjectsView create maps repo preflight reason to friendly toast', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const toasts = [];
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/projects' && options.method === 'POST') {
      const err = new Error('preflight failed');
      err.status = 400;
      err.reason = 'repo_unreachable';
      throw err;
    }
    return {};
  }, toasts);
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env);
  clickButton(root, (text) => text.includes('새 프로젝트 폴더'));

  await waitFor(() => assert.ok(root.querySelector('[data-role="project-repo-url"]')));
  setInput(env, root.querySelector('#new-project-name'), 'Repo Project');
  setInput(env, root.querySelector('[data-role="project-repo-url"]'), 'https://github.com/acme/private.git');
  await flushEffects(20);
  clickButton(root, (text) => text.includes('생성'));

  await waitFor(() => {
    assert.ok(toasts.some((toast) => toast.type === 'error' && toast.message.includes('레포에 접근할 수 없습니다')));
  });
});

test('ProjectsView edit maps repo preflight reason to friendly toast', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const toasts = [];
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/projects/proj_git' && options.method === 'PATCH') {
      const err = new Error('preflight failed');
      err.status = 400;
      err.reason = 'repo_ref_not_found';
      throw err;
    }
    return {};
  }, toasts);
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{
      id: 'proj_git',
      name: 'Repo Project',
      source_type: 'git',
      repo_url: 'https://github.com/acme/repo.git',
      repo_ref: 'missing',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });
  clickButton(root, (text) => text.includes('편집'));

  await waitFor(() => assert.ok(root.querySelector('#edit-project-name')));
  clickButton(root, (text) => text.includes('저장'));

  await waitFor(() => {
    assert.ok(toasts.some((toast) => toast.type === 'error' && toast.message.includes('레포 ref를 찾을 수 없습니다')));
  });
});

test('ProjectsView edit detects legacy source_type before stale repo_url', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installProjectsStubs(env, async (url) => {
    if (url === '/api/nodes') return { nodes: [] };
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{
      id: 'proj_legacy',
      name: 'Legacy Project',
      source_type: 'legacy_directory',
      repo_url: 'https://github.com/acme/stale.git',
      directory: '/srv/legacy',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });
  clickButton(root, (text) => text.includes('편집'));

  await waitFor(() => {
    const sourceToggle = root.querySelector('[data-role="project-source-toggle"]');
    assert.ok(sourceToggle);
    assert.equal(sourceToggle.dataset.value, 'legacy_directory');
    assert.equal(root.querySelector('[data-role="project-repo-url"]'), null);
    assert.ok(root.querySelector('.directory-picker-stub'));
  });
});

test('ProjectsView edit clears git fields when switching to legacy source', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let patchBody = null;
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/projects/proj_git' && options.method === 'PATCH') {
      patchBody = JSON.parse(options.body);
      return { project: { id: 'proj_git', node_id: null } };
    }
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{
      id: 'proj_git',
      name: 'Repo Project',
      source_type: 'git',
      repo_url: 'https://github.com/acme/repo.git',
      repo_ref: 'main',
      repo_subdir: 'apps/web',
      mcp_config_source: 'repo_relpath',
      mcp_config_relpath: '.palantir/mcp.json',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });
  clickButton(root, (text) => text.includes('편집'));

  const sourceToggle = await waitFor(() => {
    const el = root.querySelector('[data-role="project-source-toggle"]');
    assert.ok(el);
    return el;
  });
  await setSelect(env, sourceToggle, 'legacy_directory');
  await waitFor(() => assert.ok(root.querySelector('.directory-picker-stub')));
  setInput(env, root.querySelector('.directory-picker-stub'), '/srv/legacy');
  await flushEffects(20);
  clickButton(root, (text) => text.includes('저장'));

  await waitFor(() => {
    assert.ok(patchBody);
    assert.equal(patchBody.source_type, 'legacy_directory');
    assert.equal(patchBody.directory, '/srv/legacy');
    assert.equal(patchBody.repo_url, null);
    assert.equal(patchBody.repo_ref, null);
    assert.equal(patchBody.repo_subdir, null);
    assert.equal(patchBody.mcp_config_source, 'legacy_control_plane_path');
    assert.equal(patchBody.mcp_config_relpath, null);
  });
});

test('ProjectsView edit clears legacy fields when switching to git source', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let patchBody = null;
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/projects/proj_legacy' && options.method === 'PATCH') {
      patchBody = JSON.parse(options.body);
      return { project: { id: 'proj_legacy', node_id: null } };
    }
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{
      id: 'proj_legacy',
      name: 'Legacy Project',
      source_type: 'legacy_directory',
      directory: '/srv/legacy',
      allow_non_git_dir: 1,
      mcp_config_path: '/srv/mcp.json',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });
  clickButton(root, (text) => text.includes('편집'));

  const sourceToggle = await waitFor(() => {
    const el = root.querySelector('[data-role="project-source-toggle"]');
    assert.ok(el);
    return el;
  });
  await setSelect(env, sourceToggle, 'git');
  await waitFor(() => assert.ok(root.querySelector('[data-role="project-repo-url"]')));
  setInput(env, root.querySelector('[data-role="project-repo-url"]'), 'https://github.com/acme/repo.git');
  await flushEffects(20);
  clickButton(root, (text) => text.includes('저장'));

  await waitFor(() => {
    assert.ok(patchBody);
    assert.equal(patchBody.source_type, 'git');
    assert.equal(patchBody.repo_url, 'https://github.com/acme/repo.git');
    assert.equal(patchBody.directory, null);
    assert.equal(patchBody.allow_non_git_dir, null);
  });
});

test('ProjectsView warm operator action posts warm endpoint, disables in-flight, toasts, and navigates roster', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const toasts = [];
  let warmRequest = null;
  let resolveWarm;
  const warmPromise = new Promise((resolve) => { resolveWarm = resolve; });
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/manager/pm/proj_alpha/warm' && options.method === 'POST') {
      warmRequest = { url, options };
      return warmPromise;
    }
    return {};
  }, toasts);
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{
      id: 'proj_alpha',
      name: 'Alpha Console',
      source_type: 'git',
      repo_url: 'https://github.com/acme/alpha.git',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });

  const button = await waitFor(() => {
    const el = root.querySelector('[data-role="project-warm-operator"]');
    assert.ok(el);
    assert.match(el.textContent, /오퍼레이터 준비/);
    return el;
  });
  button.click();

  await waitFor(() => {
    assert.ok(warmRequest);
    assert.equal(warmRequest.url, '/api/manager/pm/proj_alpha/warm');
    assert.equal(warmRequest.options.method, 'POST');
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.ok(button.querySelector('.operator-spinner'));
  });

  resolveWarm({ spawned: true });

  await waitFor(() => {
    assert.ok(toasts.some((toast) => toast.type === 'success' && toast.message === '오퍼레이터를 준비했습니다'));
    assert.equal(env.window.location.hash, '#operator');
    assert.equal(button.disabled, false);
  });
});

test('ProjectsView warm operator action reports already-ready fast path', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const toasts = [];
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/manager/pm/proj_alpha/warm' && options.method === 'POST') {
      return { spawned: false };
    }
    return {};
  }, toasts);
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{
      id: 'proj_alpha',
      name: 'Alpha Console',
      source_type: 'git',
      repo_url: 'https://github.com/acme/alpha.git',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });

  const button = await waitFor(() => {
    const el = root.querySelector('[data-role="project-warm-operator"]');
    assert.ok(el);
    return el;
  });
  button.click();

  await waitFor(() => {
    assert.ok(toasts.some((toast) => toast.type === 'success' && toast.message === '이미 준비된 오퍼레이터가 있습니다'));
    assert.equal(env.window.location.hash, '#operator');
  });
});

test('ProjectsView renders operator watch reverse index without changing warm action', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installProjectsStubs(env, async (url) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/operator-instances') {
      return {
        instances: [
          {
            id: 'oi_alpha',
            refs: [
              { project_id: 'proj_alpha', role: 'primary' },
              { project_id: 'proj_beta', role: 'reference' },
            ],
          },
          {
            id: 'oi_reviewer',
            refs: [
              { project_id: 'proj_alpha', role: 'reference' },
            ],
          },
        ],
      };
    }
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [
      {
        id: 'proj_alpha',
        name: 'Alpha Console',
        source_type: 'git',
        repo_url: 'https://github.com/acme/alpha.git',
        created_at: '2026-07-05T00:00:00.000Z',
      },
      {
        id: 'proj_beta',
        name: 'Beta API',
        source_type: 'git',
        repo_url: 'https://github.com/acme/beta.git',
        created_at: '2026-07-05T00:00:00.000Z',
      },
      {
        id: 'proj_empty',
        name: 'No Watchers',
        source_type: 'git',
        repo_url: 'https://github.com/acme/empty.git',
        created_at: '2026-07-05T00:00:00.000Z',
      },
    ],
  });

  const alphaCard = await waitFor(() => {
    const el = root.querySelector('[data-role="project-card"][data-project-id="proj_alpha"]');
    assert.ok(el);
    assert.match(el.textContent, /이 프로젝트 폴더를 보는 오퍼레이터 2/);
    return el;
  });
  assert.match(alphaCard.querySelector('[data-role="project-operator-watch-primary"]').textContent, /담당/);
  assert.match(alphaCard.querySelector('[data-role="project-operator-watch-reference"]').textContent, /참조/);
  const alphaWarm = alphaCard.querySelector('[data-role="project-warm-operator"]');
  assert.ok(alphaWarm);
  assert.match(alphaWarm.textContent, /오퍼레이터 준비/);

  const betaCard = root.querySelector('[data-role="project-card"][data-project-id="proj_beta"]');
  assert.match(betaCard.textContent, /이 프로젝트 폴더를 보는 오퍼레이터 1/);
  assert.equal(betaCard.querySelector('[data-role="project-operator-watch-primary"]'), null);
  assert.match(betaCard.querySelector('[data-role="project-operator-watch-reference"]').textContent, /참조/);

  const emptyCard = root.querySelector('[data-role="project-card"][data-project-id="proj_empty"]');
  assert.ok(emptyCard);
  assert.equal(emptyCard.querySelector('[data-role="project-operator-watchers"]'), null);
});

test('ProjectsView hides operator watch reverse index when metadata is unavailable', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installProjectsStubs(env, async (url) => {
    if (url === '/api/nodes') return { nodes: [] };
    if (url === '/api/operator-instances') throw new Error('request failed');
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{
      id: 'proj_alpha',
      name: 'Alpha Console',
      source_type: 'git',
      repo_url: 'https://github.com/acme/alpha.git',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });

  await waitFor(() => assert.equal(root.querySelector('[data-view="projects"]').getAttribute('data-operator-watch-index-state'), 'unknown'));
  const card = await waitFor(() => {
    const el = root.querySelector('[data-role="project-card"][data-project-id="proj_alpha"]');
    assert.ok(el);
    assert.match(el.textContent, /Alpha Console/);
    return el;
  });
  assert.equal(card.querySelector('[data-role="project-operator-watchers"]'), null);
  const warm = card.querySelector('[data-role="project-warm-operator"]');
  assert.ok(warm);
  assert.match(warm.textContent, /오퍼레이터 준비/);
});

test('ProjectsView highlights codebase selected by #operator/codebases deep link', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installProjectsStubs(env, async (url) => {
    if (url === '/api/nodes') return { nodes: [] };
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    highlightProjectId: 'proj_alpha',
    projects: [{
      id: 'proj_alpha',
      name: 'Alpha Console',
      source_type: 'git',
      repo_url: 'https://github.com/acme/alpha.git',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });

  const card = await waitFor(() => {
    const el = root.querySelector('[data-role="project-card"][data-project-id="proj_alpha"]');
    assert.ok(el);
    assert.equal(el.getAttribute('data-highlighted'), 'true');
    return el;
  });
  const operatorButton = card.querySelector('[data-role="project-warm-operator"]');
  assert.ok(operatorButton);
  assert.equal(card.querySelector('[data-role="project-open-operator"]'), null);
  assert.match(operatorButton.textContent, /오퍼레이터 준비/);
});
