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

function installSpecialistStubs(env, { profiles, result = null }) {
  const calls = [];
  env.context.apiFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url === '/api/operator/profiles') return { profiles };
    if (url === '/api/operator/specialist') {
      return result || {
        invocationId: 'inv_1',
        text: 'specialist result',
        toolCallCount: 0,
        iterations: 1,
      };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return calls;
}

function renderSpecialistView(env, props = {}) {
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.SpecialistView, {
    runs: [],
    ...props,
  }), root);
  return root;
}

function changeValue(env, el, value) {
  el.value = value;
  el.dispatchEvent(new env.window.Event('change', { bubbles: true }));
}

function inputValue(env, el, value) {
  el.value = value;
  el.dispatchEvent(new env.window.Event('input', { bubbles: true }));
}

const PROFILES = [
  { id: 'op_review', name: 'Review analyst', description: 'Reviews diffs.' },
  { id: 'op_research', name: 'Research analyst', description: 'Checks sources.' },
];

test('SpecialistView seeds initialProfileId after profiles load and auto-selects the only active manager run', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  installSpecialistStubs(env, { profiles: PROFILES });
  env.loadComponent('SpecialistView');

  const root = renderSpecialistView(env, {
    initialProfileId: 'op_review',
    runs: [{ id: 'run-one', is_manager: 1, status: 'running', conversation_id: 'top' }],
  });

  await waitFor(() => {
    assert.equal(root.querySelector('#specialist-profile').value, 'op_review');
    assert.equal(root.querySelector('#specialist-origin-run').value, 'run-one');
  });
  assert.match(root.textContent, /Reviews diffs/);
  assert.equal(root.querySelector('button[type="submit"]').disabled, true);
});

test('SpecialistView ignores an initialProfileId that is not in the loaded profile list', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  installSpecialistStubs(env, { profiles: PROFILES });
  env.loadComponent('SpecialistView');

  const root = renderSpecialistView(env, {
    initialProfileId: 'op_missing',
    runs: [{ id: 'run-one', is_manager: 1, status: 'running', conversation_id: 'top' }],
  });

  await waitFor(() => {
    assert.equal(root.querySelector('#specialist-profile').options.length, 3);
    assert.equal(root.querySelector('#specialist-origin-run').value, 'run-one');
  });
  assert.equal(root.querySelector('#specialist-profile').value, '');
});

test('SpecialistView keeps multiple active manager runs user-picked and posts through the invoke flow', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  const calls = installSpecialistStubs(env, { profiles: PROFILES });
  env.loadComponent('SpecialistView');

  const root = renderSpecialistView(env, {
    initialProfileId: 'op_review',
    runs: [
      { id: 'run-a', is_manager: 1, status: 'running', conversation_id: 'top' },
      { id: 'run-b', is_manager: 1, status: 'needs_input', conversation_id: 'operator:proj' },
    ],
  });

  await waitFor(() => {
    assert.equal(root.querySelector('#specialist-profile').value, 'op_review');
    assert.equal(root.querySelector('#specialist-origin-run').value, '');
  });

  inputValue(env, root.querySelector('#specialist-user-text'), 'please inspect this');
  await flushEffects(20);
  assert.equal(root.querySelector('button[type="submit"]').disabled, true);

  changeValue(env, root.querySelector('#specialist-origin-run'), 'run-b');
  await waitFor(() => assert.equal(root.querySelector('button[type="submit"]').disabled, false));

  root.querySelector('form').dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));

  const post = await waitFor(() => {
    const call = calls.find((entry) => entry.url === '/api/operator/specialist');
    assert.ok(call);
    return call;
  });
  assert.equal(post.opts.method, 'POST');
  assert.deepEqual(JSON.parse(post.opts.body), {
    profileId: 'op_review',
    userText: 'please inspect this',
    originRunId: 'run-b',
  });
  await waitFor(() => assert.match(root.textContent, /specialist result/));
});

test('SpecialistView drops the auto-selected origin run when the active set grows to multiple (forces explicit pick)', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  installSpecialistStubs(env, { profiles: PROFILES });
  env.loadComponent('SpecialistView');

  // One active manager run → auto-anchored.
  renderSpecialistView(env, {
    initialProfileId: 'op_review',
    runs: [{ id: 'run-a', is_manager: 1, status: 'running', conversation_id: 'top' }],
  });
  const root = env.document.getElementById('root');
  await waitFor(() => assert.equal(root.querySelector('#specialist-origin-run').value, 'run-a'));

  // A second active manager run appears — the user never explicitly picked, so
  // the previously auto-selected run must be cleared (multiple = explicit pick).
  renderSpecialistView(env, {
    initialProfileId: 'op_review',
    runs: [
      { id: 'run-a', is_manager: 1, status: 'running', conversation_id: 'top' },
      { id: 'run-b', is_manager: 1, status: 'needs_input', conversation_id: 'operator:proj' },
    ],
  });
  await waitFor(() => assert.equal(root.querySelector('#specialist-origin-run').value, ''));

  inputValue(env, root.querySelector('#specialist-user-text'), 'please inspect this');
  await flushEffects(20);
  assert.equal(root.querySelector('button[type="submit"]').disabled, true);
});

test('SpecialistView with zero active manager runs keeps submit disabled and shows the origin hint', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  const calls = installSpecialistStubs(env, { profiles: PROFILES });
  env.loadComponent('SpecialistView');

  const root = renderSpecialistView(env, {
    initialProfileId: 'op_review',
    runs: [
      { id: 'run-completed', is_manager: 1, status: 'completed', conversation_id: 'top' },
      { id: 'worker-running', is_manager: 0, status: 'running', conversation_id: 'worker:1' },
    ],
  });

  await waitFor(() => {
    assert.equal(root.querySelector('#specialist-profile').value, 'op_review');
    assert.equal(root.querySelector('#specialist-origin-run').value, '');
  });

  inputValue(env, root.querySelector('#specialist-user-text'), 'please inspect this');
  await flushEffects(20);

  assert.equal(root.querySelector('button[type="submit"]').disabled, true);
  assert.match(root.textContent, /활성 매니저 run이 없습니다/);
  assert.equal(calls.some((entry) => entry.url === '/api/operator/specialist'), false);
});
