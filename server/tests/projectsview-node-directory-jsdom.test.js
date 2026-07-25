'use strict';

// task_85d43f96 — node-first project forms and the node-aware DirectoryPicker.
//
// The API/service side is covered by fs-node-browse.test.js; this file pins the
// client contract that made the feature worth building:
//   * the execution node is chosen BEFORE the source/directory fields, because
//     every path in those fields only means something on a specific node;
//   * changing the node invalidates in-flight listings and re-validates the
//     already-selected directory against the NEW node, clearing it only when
//     that node says the path is genuinely invalid there;
//   * a superseded listing can never land on top of a newer one;
//   * a save carries node_id and directory together, and a rejected binding is
//     reported by cause rather than as a raw server string.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreactEnv,
  flushEffects,
  pickDropdownOption,
} = require('./helpers/jsdom-preact');

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

/** `true` when `a` appears before `b` in document order. */
function precedes(a, b) {
  assert.ok(a, 'expected the first element to exist');
  assert.ok(b, 'expected the second element to exist');
  return Boolean(a.compareDocumentPosition(b) & 4 /* DOCUMENT_POSITION_FOLLOWING */);
}

function assertOrder(root, selectors) {
  const els = selectors.map((sel) => {
    const el = root.querySelector(sel);
    assert.ok(el, `expected ${sel} to be rendered`);
    return el;
  });
  for (let i = 0; i < els.length - 1; i += 1) {
    assert.ok(
      precedes(els[i], els[i + 1]),
      `expected ${selectors[i]} to come before ${selectors[i + 1]}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DirectoryPicker (defined in BoardView.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * apiFetch stub that hands each call back to the test as a deferred, so
 * out-of-order resolution (the whole point of the stale-response fence) can be
 * driven deterministically.
 */
function makeDeferredFetch() {
  const calls = [];
  const fetchFn = (url, opts) => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ url, opts, resolve, reject });
    return promise;
  };
  fetchFn.calls = calls;
  fetchFn.lastCall = () => calls[calls.length - 1];
  return fetchFn;
}

function browseError({ status, reason, message = 'browse failed' }) {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

function installPickerStubs(env, apiFetch, toasts = []) {
  env.context.apiFetch = apiFetch;
  env.context.apiFetchWithToast = apiFetch;
  env.context.addToast = (message, type) => { toasts.push({ message, type }); };
  env.context.useEscape = () => {};
  env.context.timeAgo = () => '방금';
  env.context.formatTime = () => '2026-07-05';
  env.context.dueDateMeta = () => null;
  env.context.useNowTick = () => 0;
  env.context.navigate = () => {};
  env.context.clickableProps = (onClick) => ({ onClick, role: 'button', tabIndex: 0 });
  env.context.Dropdown = () => null;
  env.context.EmptyState = () => null;
  env.context.NewTaskModal = () => null;
  env.context.ExecuteModal = () => null;
  env.context.TaskDetailPanel = () => null;
  env.context.RunInspector = () => null;
  env.context.AttentionStrip = () => null;
  // Render the modal body inline so the picker's list/error surfaces are
  // queryable without driving the real focus-trap primitive.
  env.context.Modal = function Modal({ open, children }) {
    return open ? env.context.preact.h('div', { class: 'modal-stub' }, children) : null;
  };
  env.context.requestAnimationFrame = env.context.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
  env.context.cancelAnimationFrame = env.context.cancelAnimationFrame || ((id) => clearTimeout(id));
}

function makePickerHarness(env, apiFetch, toasts) {
  installPickerStubs(env, apiFetch, toasts);
  env.loadComponent('BoardView');
  const root = env.document.getElementById('root');
  const selected = [];
  const render = (props) => {
    env.render(env.h(env.context.DirectoryPicker, {
      value: '',
      nodeId: '',
      nodeLabel: '',
      onSelect: (next) => { selected.push(next); },
      ...props,
    }), root);
  };
  return { root, render, selected };
}

function clickBrowse(root) {
  const button = Array.from(root.querySelectorAll('button'))
    .find((el) => el.textContent.includes('찾아보기'));
  assert.ok(button, 'expected the browse button to exist');
  button.click();
  return button;
}

test('DirectoryPicker browses the selected node and labels the scope', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const apiFetch = makeDeferredFetch();
  const { root, render } = makePickerHarness(env, apiFetch, []);

  render({ nodeId: '', nodeLabel: '' });
  await flushEffects(20);
  assert.match(
    root.querySelector('[data-role="dir-picker-scope"]').textContent,
    /컨트롤 플레인 \(local\)/,
  );

  render({ nodeId: 'pod-a', nodeLabel: 'Pod A (pod-a)' });
  assert.match(
    root.querySelector('[data-role="dir-picker-scope"]').textContent,
    /노드 Pod A \(pod-a\)/,
  );
  // Let the node-change effect settle before browsing — it deliberately
  // invalidates whatever was in flight, so a listing started in the same tick
  // as the switch would (correctly) be discarded.
  await flushEffects(40);
  assert.equal(apiFetch.calls.length, 0, 'an empty selection needs no re-validation');

  clickBrowse(root);
  await waitFor(() => assert.equal(apiFetch.calls.length, 1));
  const [call] = apiFetch.calls;
  assert.match(call.url, /^\/api\/fs\?/);
  assert.match(call.url, /nodeId=pod-a/);
  // /api/fs answers 403 for out-of-root and permission-denied paths, which are
  // browse outcomes — the picker must opt out of apiFetch's login bounce or it
  // navigates the operator away mid-browse.
  assert.equal(call.opts?.allowAppForbidden, true, 'browse must opt out of the auth bounce');

  call.resolve({
    root: '/srv/root',
    path: '/srv/root',
    directories: [{ name: 'proj-a', path: '/srv/root/proj-a' }],
    truncated: false,
  });
  await waitFor(() => {
    const items = Array.from(root.querySelectorAll('.directory-item')).map((el) => el.textContent);
    assert.ok(items.some((text) => text.includes('proj-a')));
  });
});

test('DirectoryPicker gives unreachable, unreadable, outside-root, and symlink escape distinct copy', async () => {
  const cases = [
    { status: 502, reason: 'node_unreachable', copy: /노드에 연결할 수 없습니다/ },
    { status: 403, reason: 'permission_denied', copy: /경로에 접근할 권한이 없습니다/ },
    { status: 403, reason: 'path_outside_root', copy: /허용된 경로\(exposed_roots\) 밖입니다/ },
    { status: 403, reason: 'symlink_escape', copy: /심볼릭 링크가 허용된 경로 밖을 가리켜/ },
  ];
  const renderedMessages = [];

  for (const expected of cases) {
    const env = createPreactEnv();
    try {
      const apiFetch = makeDeferredFetch();
      const toasts = [];
      const { root, render } = makePickerHarness(env, apiFetch, toasts);

      render({ nodeId: 'pod-a', nodeLabel: 'Pod A (pod-a)' });
      await flushEffects(20);
      clickBrowse(root);
      await waitFor(() => assert.equal(apiFetch.calls.length, 1));
      apiFetch.calls[0].reject(browseError({
        status: expected.status,
        reason: expected.reason,
        message: 'raw browse failure',
      }));

      await waitFor(() => {
        // The browser is open, so the failure is reported inside the dialog.
        const error = root.querySelector('[data-role="dir-picker-modal-error"]');
        assert.ok(error, `expected ${expected.reason} to render`);
        assert.match(error.textContent, expected.copy);
        assert.ok(!error.textContent.includes('raw browse failure'), 'raw server string must not leak');
        renderedMessages.push(error.textContent);
      });
      assert.ok(toasts.some((toast) => toast.type === 'error' && expected.copy.test(toast.message)));
    } finally {
      env.cleanup();
    }
  }

  assert.equal(
    new Set(renderedMessages).size,
    cases.length,
    'each actionable failure cause must have different operator copy',
  );
});

test('DirectoryPicker announces a browse failure through exactly one live region', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const apiFetch = makeDeferredFetch();
  const { root, render } = makePickerHarness(env, apiFetch, []);

  render({ nodeId: 'pod-a' });
  await flushEffects(20);
  clickBrowse(root);
  await waitFor(() => assert.equal(apiFetch.calls.length, 1));
  apiFetch.calls[0].reject(browseError({ status: 404, reason: 'path_not_found' }));

  // The browser is open, so the error belongs to the dialog. Rendering the
  // same text again in the form field behind the backdrop would make screen
  // readers announce it twice (role=alert + role=status) for one failure.
  await waitFor(() => assert.ok(root.querySelector('[data-role="dir-picker-modal-error"]')));
  assert.equal(
    root.querySelector('[data-role="dir-picker-error"]'),
    null,
    'the inline error must not duplicate the dialog error while the dialog is open',
  );

  // Closing the dialog hands the same message back to the field.
  Array.from(root.querySelectorAll('button'))
    .find((el) => el.textContent.includes('닫기'))
    .click();
  await waitFor(() => {
    assert.ok(root.querySelector('[data-role="dir-picker-error"]'));
    assert.equal(root.querySelector('[data-role="dir-picker-modal-error"]'), null);
  });
});

test('DirectoryPicker falls back to the server message for an unknown reason', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const apiFetch = makeDeferredFetch();
  const { root, render } = makePickerHarness(env, apiFetch, []);

  render({ nodeId: 'pod-a' });
  await flushEffects(20);
  clickBrowse(root);
  await waitFor(() => assert.equal(apiFetch.calls.length, 1));
  // A reason this client build has never heard of must degrade to "specific
  // but untranslated" rather than to a generic failure.
  apiFetch.calls[0].reject(browseError({
    status: 400,
    reason: 'some_future_reason',
    message: 'node refused the walk',
  }));

  await waitFor(() => assert.match(
    root.querySelector('[data-role="dir-picker-modal-error"]').textContent,
    /node refused the walk/,
  ));
});

test('DirectoryPicker re-validates the selected directory against the new node', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const apiFetch = makeDeferredFetch();
  const { root, render, selected } = makePickerHarness(env, apiFetch, []);

  render({ nodeId: '', value: '/srv/projects/app' });
  await flushEffects(20);
  assert.equal(apiFetch.calls.length, 0, 'the initial mount must not re-validate');

  render({ nodeId: 'pod-a', nodeLabel: 'Pod A (pod-a)', value: '/srv/projects/app' });
  await waitFor(() => assert.equal(apiFetch.calls.length, 1));
  const [call] = apiFetch.calls;
  assert.match(call.url, /nodeId=pod-a/);
  assert.match(call.url, /path=%2Fsrv%2Fprojects%2Fapp/);
  assert.equal(call.opts?.allowAppForbidden, true);

  // The path exists on the new node → the operator keeps their selection.
  call.resolve({ root: '/srv', path: '/srv/projects/app', directories: [] });
  await flushEffects(40);
  assert.deepEqual(selected, [], 'a valid directory must survive a node change');
  assert.equal(root.querySelector('[data-role="dir-picker-error"]'), null);
});

test('DirectoryPicker clears the directory when the new node rejects the path', async (t) => {
  for (const reason of ['path_outside_root', 'symlink_escape', 'path_not_found', 'permission_denied']) {
    const env = createPreactEnv();
    t.after(env.cleanup);
    const apiFetch = makeDeferredFetch();
    const toasts = [];
    const { root, render, selected } = makePickerHarness(env, apiFetch, toasts);

    render({ nodeId: '', value: '/home/karnian/local-only' });
    await flushEffects(20);
    render({ nodeId: 'pod-a', nodeLabel: 'Pod A (pod-a)', value: '/home/karnian/local-only' });
    await waitFor(() => assert.equal(apiFetch.calls.length, 1));
    apiFetch.calls[0].reject(browseError({ status: 403, reason }));

    await waitFor(() => {
      assert.deepEqual(selected, [''], `expected ${reason} to clear the selection`);
      const error = root.querySelector('[data-role="dir-picker-error"]');
      assert.ok(error);
      assert.match(error.textContent, /노드를 변경하여 선택한 디렉터리를 해제했습니다/);
    });
    assert.ok(toasts.some((toast) => toast.type === 'error'));
    env.cleanup();
  }
});

test('DirectoryPicker keeps the directory when the new node is merely unreachable', async (t) => {
  for (const { reason, copy } of [
    { reason: 'node_unreachable', copy: /노드에 연결할 수 없습니다/ },
    { reason: 'node_timeout', copy: /노드가 응답하지 않습니다/ },
  ]) {
    const env = createPreactEnv();
    t.after(env.cleanup);
    const apiFetch = makeDeferredFetch();
    const { root, render, selected } = makePickerHarness(env, apiFetch, []);

    render({ nodeId: '', value: '/srv/projects/app' });
    await flushEffects(20);
    render({ nodeId: 'pod-a', value: '/srv/projects/app' });
    await waitFor(() => assert.equal(apiFetch.calls.length, 1));
    apiFetch.calls[0].reject(browseError({ status: 502, reason }));

    await waitFor(() => assert.match(
      root.querySelector('[data-role="dir-picker-error"]').textContent,
      copy,
    ));
    // A pod that is briefly down must never delete a correct directory.
    assert.deepEqual(selected, [], `expected ${reason} to preserve the selection`);
    env.cleanup();
  }
});

test('DirectoryPicker drops a listing that a newer request superseded', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const apiFetch = makeDeferredFetch();
  const { root, render } = makePickerHarness(env, apiFetch, []);

  render({ nodeId: 'pod-a' });
  await flushEffects(20);
  clickBrowse(root);
  await waitFor(() => assert.equal(apiFetch.calls.length, 1));
  clickBrowse(root);
  await waitFor(() => assert.equal(apiFetch.calls.length, 2));

  // The NEWER request answers first, then the stale one lands.
  apiFetch.calls[1].resolve({
    root: '/srv/root',
    path: '/srv/root',
    directories: [{ name: 'fresh', path: '/srv/root/fresh' }],
  });
  await waitFor(() => assert.ok(
    root.querySelector('.directory-list').textContent.includes('fresh'),
  ));
  apiFetch.calls[0].resolve({
    root: '/stale',
    path: '/stale',
    directories: [{ name: 'stale', path: '/stale/stale' }],
  });
  await flushEffects(60);

  const listing = root.querySelector('.directory-list').textContent;
  assert.ok(listing.includes('fresh'), 'the newest listing must survive');
  assert.ok(!listing.includes('stale'), 'a superseded listing must never land');
  assert.match(root.querySelector('.directory-path').textContent, /\/srv\/root/);
});

test('DirectoryPicker discards an in-flight listing from the previous node', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const apiFetch = makeDeferredFetch();
  const { root, render } = makePickerHarness(env, apiFetch, []);

  render({ nodeId: 'pod-a' });
  await flushEffects(20);
  clickBrowse(root);
  await waitFor(() => assert.equal(apiFetch.calls.length, 1));

  // Switch node while pod-a's listing is still in flight. The identity ref is
  // updated during render, so even a response in the render→effect gap loses.
  render({ nodeId: 'pod-b', value: '' });
  apiFetch.calls[0].resolve({
    root: '/stale',
    path: '/stale',
    directories: [{ name: 'pod-a-only', path: '/stale/pod-a-only' }],
  });
  await flushEffects(40);

  // Open the new node and establish its result before the final assertion.
  clickBrowse(root);
  await waitFor(() => assert.equal(apiFetch.calls.length, 2));
  apiFetch.calls[1].resolve({
    root: '/pod-b/root',
    path: '/pod-b/root',
    directories: [{ name: 'pod-b-fresh', path: '/pod-b/root/pod-b-fresh' }],
  });
  await waitFor(() => assert.match(root.querySelector('.directory-list').textContent, /pod-b-fresh/));

  assert.ok(
    !root.textContent.includes('pod-a-only'),
    "the previous node's listing must not land on the new node",
  );
  assert.match(root.querySelector('.directory-path').textContent, /\/pod-b\/root/);
});

// ─────────────────────────────────────────────────────────────────────────────
// ProjectsView — field ordering, node plumbing, save coherence
// ─────────────────────────────────────────────────────────────────────────────

function installProjectsStubs(env, apiFetch, toasts = [], pickerProps = []) {
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
  // Records the node identity the form hands down, so the "paths belong to the
  // selected node" contract is asserted at the seam rather than inferred.
  env.context.DirectoryPicker = function DirectoryPicker(props) {
    pickerProps.push({ value: props.value, nodeId: props.nodeId, nodeLabel: props.nodeLabel });
    return env.context.preact.h('input', {
      'data-role': 'directory-picker-stub',
      'data-node-id': props.nodeId || '',
      'data-node-label': props.nodeLabel || '',
      value: props.value || '',
      onInput: (e) => props.onSelect(e.target.value),
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

const NODES = [
  { id: 'pod-a', name: 'Pod A', can_execute: 1, files_only: 0, reachable: 1, max_concurrent: 2, running_count: 0 },
];

test('new project form places the execution node before the source and directory fields', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installProjectsStubs(env, async (url) => (url === '/api/nodes' ? { nodes: NODES } : {}));
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env);
  clickButton(root, (text) => text.includes('새 프로젝트 폴더'));
  await waitFor(() => assert.ok(root.querySelector('#new-project-node')));

  // Git is the default source, so the node must already sit above it.
  assertOrder(root, [
    '#new-project-name',
    '[data-role="project-node-field"]',
    '#new-project-source-type',
    '[data-role="project-repo-url"]',
  ]);

  await pickDropdownOption(env, root.querySelector('#new-project-source-type'), 'legacy_directory');
  await waitFor(() => assert.ok(root.querySelector('[data-role="project-legacy-source"]')));
  assertOrder(root, [
    '#new-project-name',
    '[data-role="project-node-field"]',
    '#new-project-source-type',
    '[data-role="project-legacy-source"]',
    '[data-role="directory-picker-stub"]',
  ]);
});

test('edit project form places the execution node before the source and directory fields', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installProjectsStubs(env, async (url) => (url === '/api/nodes' ? { nodes: NODES } : {}));
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{
      id: 'proj_1',
      name: 'Legacy',
      source_type: 'legacy_directory',
      directory: '/srv/projects/app',
      node_id: 'pod-a',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });
  clickButton(root, (text) => text.includes('편집'));
  await waitFor(() => assert.ok(root.querySelector('#edit-project-node')));

  assertOrder(root, [
    '#edit-project-name',
    '[data-role="project-node-field"]',
    '#edit-project-source-type',
    '[data-role="project-legacy-source"]',
    '[data-role="directory-picker-stub"]',
  ]);
});

test('the directory picker is scoped to the node the form has selected', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const pickerProps = [];
  installProjectsStubs(
    env,
    async (url) => (url === '/api/nodes' ? { nodes: NODES } : {}),
    [],
    pickerProps,
  );
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env);
  clickButton(root, (text) => text.includes('새 프로젝트 폴더'));
  await waitFor(() => assert.ok(root.querySelector('#new-project-source-type')));
  await pickDropdownOption(env, root.querySelector('#new-project-source-type'), 'legacy_directory');
  await waitFor(() => assert.ok(root.querySelector('[data-role="directory-picker-stub"]')));

  // Default (no node picked) → the control plane.
  assert.equal(root.querySelector('[data-role="directory-picker-stub"]').dataset.nodeId, '');

  await pickDropdownOption(env, root.querySelector('#new-project-node'), 'pod-a');
  await waitFor(() => {
    const picker = root.querySelector('[data-role="directory-picker-stub"]');
    assert.equal(picker.dataset.nodeId, 'pod-a');
    assert.equal(picker.dataset.nodeLabel, 'Pod A (pod-a)');
  });
});

test('create saves node_id and directory together', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let postBody = null;
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: NODES };
    if (url === '/api/projects' && options.method === 'POST') {
      postBody = JSON.parse(options.body);
      return { project: { id: 'proj_new' } };
    }
    return {};
  });
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env);
  clickButton(root, (text) => text.includes('새 프로젝트 폴더'));
  await waitFor(() => assert.ok(root.querySelector('#new-project-source-type')));
  setInput(env, root.querySelector('#new-project-name'), 'Remote Project');
  await pickDropdownOption(env, root.querySelector('#new-project-source-type'), 'legacy_directory');
  await pickDropdownOption(env, root.querySelector('#new-project-node'), 'pod-a');
  await waitFor(() => assert.ok(root.querySelector('[data-role="directory-picker-stub"]')));
  setInput(env, root.querySelector('[data-role="directory-picker-stub"]'), '/srv/root/app');
  await flushEffects(20);
  clickButton(root, (text) => text.includes('생성'));

  await waitFor(() => {
    assert.ok(postBody, 'expected the create request to be sent');
    assert.equal(postBody.node_id, 'pod-a');
    assert.equal(postBody.directory, '/srv/root/app');
    assert.equal(postBody.source_type, 'legacy_directory');
  });
});

test('create reports a rejected node/directory binding by cause, exactly once', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const toasts = [];
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: NODES };
    if (url === '/api/projects' && options.method === 'POST') {
      const err = new Error('Directory not found or outside exposed_roots on node pod-a: /home/karnian/app');
      err.status = 400;
      err.reason = 'path_outside_root';
      throw err;
    }
    return {};
  }, toasts);
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env);
  clickButton(root, (text) => text.includes('새 프로젝트 폴더'));
  await waitFor(() => assert.ok(root.querySelector('#new-project-source-type')));
  setInput(env, root.querySelector('#new-project-name'), 'Remote Project');
  await pickDropdownOption(env, root.querySelector('#new-project-source-type'), 'legacy_directory');
  await pickDropdownOption(env, root.querySelector('#new-project-node'), 'pod-a');
  await waitFor(() => assert.ok(root.querySelector('[data-role="directory-picker-stub"]')));
  setInput(env, root.querySelector('[data-role="directory-picker-stub"]'), '/home/karnian/app');
  await flushEffects(20);
  clickButton(root, (text) => text.includes('생성'));

  await waitFor(() => assert.equal(toasts.length, 1));
  await flushEffects(40);
  // One toast, naming the cause — not the raw "outside exposed_roots" string
  // and not a duplicate from the wrapper plus the catch.
  assert.equal(toasts.length, 1, 'a rejected save must produce exactly one toast');
  assert.match(toasts[0].message, /디렉터리 확인 실패: 노드에 허용된 경로\(exposed_roots\) 밖입니다/);
  assert.ok(!toasts[0].message.includes('exposed_roots on node'), 'raw server string must not leak');
  // The modal stays open so the operator can correct the path in place.
  assert.ok(root.querySelector('#new-project-name'));
});

test('edit saves node_id with the directory and reports a binding rejection by cause', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const toasts = [];
  let patchBody = null;
  installProjectsStubs(env, async (url, options = {}) => {
    if (url === '/api/nodes') return { nodes: NODES };
    if (url === '/api/projects/proj_1' && options.method === 'PATCH') {
      patchBody = JSON.parse(options.body);
      const err = new Error('Directory not found or outside exposed_roots on node pod-a: /srv/root/app');
      err.status = 400;
      err.reason = 'node_unreachable';
      throw err;
    }
    return {};
  }, toasts);
  env.loadComponent('Dropdown');
  env.loadComponent('ProjectsView');

  const root = renderProjectsView(env, {
    projects: [{
      id: 'proj_1',
      name: 'Legacy',
      source_type: 'legacy_directory',
      directory: '/srv/root/app',
      node_id: 'pod-a',
      created_at: '2026-07-05T00:00:00.000Z',
    }],
  });
  clickButton(root, (text) => text.includes('편집'));
  await waitFor(() => assert.ok(root.querySelector('#edit-project-node')));
  clickButton(root, (text) => text.includes('저장'));

  await waitFor(() => {
    assert.ok(patchBody, 'expected the update request to be sent');
    assert.equal(patchBody.node_id, 'pod-a');
    assert.equal(patchBody.directory, '/srv/root/app');
  });
  await waitFor(() => {
    assert.ok(toasts.some((toast) => /노드에 연결할 수 없습니다/.test(toast.message)));
  });
  assert.ok(
    !toasts.some((toast) => toast.message.includes('exposed_roots on node')),
    'raw server string must not leak',
  );
});
