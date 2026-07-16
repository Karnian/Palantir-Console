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

function installAgentsStubs(env) {
  const calls = [];
  const toasts = [];

  env.context.apiFetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {};
  };
  env.context.apiFetchWithToast = async (url, options = {}) => {
    try {
      return await env.context.apiFetch(url, options);
    } catch (err) {
      env.context.addToast(err.message, 'error');
      throw err;
    }
  };
  env.context.addToast = (message, type) => { toasts.push({ message, type }); };
  env.context.Modal = function Modal({ open, labelledBy, children }) {
    return open
      ? env.context.preact.h('div', { role: 'dialog', 'aria-labelledby': labelledBy }, children)
      : null;
  };
  env.context.EmptyState = function EmptyState({ text }) {
    return env.context.preact.h('div', { class: 'empty-state' }, text);
  };

  return { calls, toasts };
}

function renderAgentsView(env, props = {}) {
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.AgentsView, {
    agents: [],
    loading: false,
    reloadAgents: () => {},
    ...props,
  }), root);
  return root;
}

async function openNewAgentModal(env, root) {
  root.querySelector('.agents-header button.primary').click();
  await waitFor(() => assert.ok(root.querySelector('#agent-name')));
  await flushEffects(30);
  return root.querySelector('[role="dialog"]');
}

function setInput(env, input, value) {
  assert.ok(input, 'expected input to exist');
  input.value = value;
  input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
}

function setSelect(env, select, value) {
  assert.ok(select, 'expected select to exist');
  select.value = value;
  select.dispatchEvent(new env.window.Event('change', { bubbles: true }));
}

test('codex preset uses structured high effort without a baked args flag', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installAgentsStubs(env);
  env.loadComponent('AgentsView');

  const root = renderAgentsView(env);
  await openNewAgentModal(env, root);
  setSelect(env, root.querySelector('#agent-type'), 'codex');

  await waitFor(() => {
    assert.equal(root.querySelector('#agent-command').value, 'codex');
    assert.equal(
      root.querySelector('#agent-args').value,
      'exec --full-auto --skip-git-repo-check {prompt}',
    );
    assert.doesNotMatch(root.querySelector('#agent-args').value, /model_reasoning_effort/);
    assert.equal(root.querySelector('#agent-reasoning-effort').value, 'high');
  });
});

test('model and reasoning effort controls follow the command vendor', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  installAgentsStubs(env);
  env.loadComponent('AgentsView');

  const root = renderAgentsView(env);
  await openNewAgentModal(env, root);

  setInput(env, root.querySelector('#agent-command'), '/usr/local/bin/codex');
  await waitFor(() => {
    assert.ok(root.querySelector('#agent-model'));
    assert.ok(root.querySelector('#agent-reasoning-effort'));
  });

  setInput(env, root.querySelector('#agent-command'), '/usr/local/bin/claude');
  await waitFor(() => {
    assert.ok(root.querySelector('#agent-model'));
    assert.equal(root.querySelector('#agent-reasoning-effort'), null);
  });

  setInput(env, root.querySelector('#agent-command'), '/usr/local/bin/gemini');
  await waitFor(() => {
    assert.equal(root.querySelector('#agent-model'), null);
    assert.equal(root.querySelector('#agent-reasoning-effort'), null);
  });
});

test('create payload includes structured model and reasoning effort', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const { calls } = installAgentsStubs(env);
  env.loadComponent('AgentsView');

  const root = renderAgentsView(env);
  await openNewAgentModal(env, root);
  setSelect(env, root.querySelector('#agent-type'), 'codex');
  await waitFor(() => assert.ok(root.querySelector('#agent-model')));
  setInput(env, root.querySelector('#agent-name'), 'Structured Codex');
  setInput(env, root.querySelector('#agent-model'), '  gpt-5.1-codex  ');
  setSelect(env, root.querySelector('#agent-reasoning-effort'), 'medium');
  await flushEffects(30);
  root.querySelector('.modal-footer button.primary').click();

  const call = await waitFor(() => {
    const match = calls.find((entry) => entry.url === '/api/agents');
    assert.ok(match);
    return match;
  });
  const body = JSON.parse(call.options.body);
  assert.equal(call.options.method, 'POST');
  assert.equal(body.model, 'gpt-5.1-codex');
  assert.equal(body.reasoning_effort, 'medium');
});

test('clearing structured fields sends explicit nulls on edit', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const { calls } = installAgentsStubs(env);
  env.loadComponent('AgentsView');

  const agent = {
    id: 'agent_codex',
    name: 'Existing Codex',
    type: 'codex',
    command: 'codex',
    args_template: 'exec --full-auto --skip-git-repo-check {prompt}',
    model: 'gpt-5.1-codex',
    reasoning_effort: 'high',
    max_concurrent: 1,
    capabilities_json: '{}',
  };
  const root = renderAgentsView(env, { agents: [agent] });
  root.querySelector('.agent-card-actions button').click();

  await waitFor(() => {
    assert.equal(root.querySelector('#agent-model').value, 'gpt-5.1-codex');
    assert.equal(root.querySelector('#agent-reasoning-effort').value, 'high');
  });
  setInput(env, root.querySelector('#agent-model'), '');
  setSelect(env, root.querySelector('#agent-reasoning-effort'), '');
  await flushEffects(30);
  root.querySelector('.modal-footer button.primary').click();

  const call = await waitFor(() => {
    const match = calls.find((entry) => entry.url === '/api/agents/agent_codex');
    assert.ok(match);
    return match;
  });
  const body = JSON.parse(call.options.body);
  assert.equal(call.options.method, 'PATCH');
  assert.equal(body.model, null);
  assert.equal(body.reasoning_effort, null);
});
