'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects, pickDropdownOption } = require('./helpers/jsdom-preact');

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

// Dropdown unification (2026-07-23): the policy editor's scope / vendor /
// mode controls are shared `Dropdown` components now.
async function changeValue(env, trigger, value) {
  assert.ok(trigger, 'expected dropdown trigger to exist');
  await pickDropdownOption(env, trigger, value);
}

function createEnv({ policies = [], effective } = {}) {
  const env = createPreactEnv();
  const calls = [];
  let currentPolicies = policies;

  env.context.apiFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url === '/api/model-policies') return { policies: currentPolicies };
    if (url.startsWith('/api/model-policies/effective?')) {
      return {
        effective: effective || {
          model: 'gpt-5',
          effort: 'high',
          tier: 'fast',
          sources: { model: 'codebase', effort: 'layer', tier: 'env' },
        },
      };
    }
    if (opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      currentPolicies = [{
        scope_type: 'global',
        scope_id: '*',
        vendor: 'codex',
        params: body.params,
        revision: 1,
      }];
      return { policy: currentPolicies[0] };
    }
    if (opts.method === 'DELETE') return { deleted: true };
    throw new Error(`unexpected url ${url}`);
  };
  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.loadComponent('Dropdown');
  env.loadComponent('EmptyState');
  env.loadComponent('Modal');
  env.loadComponent('ModelPoliciesView');

  return { env, calls };
}

function renderView(env) {
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.ModelPoliciesView, {
    projects: [
      { id: 'project-alpha', name: 'Alpha' },
      { id: 'project-beta', name: 'Beta' },
    ],
  }), root);
  return root;
}

test('ModelPoliciesView renders a policy and effective source tags', async (t) => {
  const { env } = createEnv({
    policies: [{
      scope_type: 'layer:operator',
      scope_id: '*',
      vendor: 'codex',
      params: { tier: 'fast' },
      revision: 1,
    }],
  });
  t.after(env.cleanup);
  const root = renderView(env);

  const card = await waitFor(() => {
    const element = root.querySelector('[data-role="model-policy-card"]');
    assert.ok(element);
    return element;
  });
  assert.match(card.textContent, /layer:operator/);
  assert.match(card.textContent, /codex/);
  assert.match(card.textContent, /tier:\s*fast/);
  assert.match(card.textContent, /revision 1/);

  await waitFor(() => {
    assert.equal(root.querySelector('[data-role="effective-source-model"]').textContent.trim(), 'codebase');
    assert.equal(root.querySelector('[data-role="effective-source-effort"]').textContent.trim(), 'layer');
    assert.equal(root.querySelector('[data-role="effective-source-tier"]').textContent.trim(), 'env');
  });
});

test('ModelPoliciesView editor shows only fields supported by the selected vendor', async (t) => {
  const { env } = createEnv({
    policies: [{
      scope_type: 'global',
      scope_id: '*',
      vendor: 'claude',
      params: { model: 'claude-sonnet' },
      revision: 2,
    }],
  });
  t.after(env.cleanup);
  const root = renderView(env);
  await waitFor(() => assert.ok(root.querySelector('[data-role="model-policy-card"]')));

  root.querySelector('[data-role="new-model-policy"]').click();
  let dialog = await waitFor(() => {
    const element = root.querySelector('[role="dialog"]');
    assert.ok(element);
    return element;
  });
  assert.ok(dialog.querySelector('#model-policy-model-mode'));
  assert.ok(dialog.querySelector('#model-policy-reasoning_effort-mode'));
  assert.ok(dialog.querySelector('#model-policy-tier-mode'));

  // Let the editor's open/reset effect settle before simulating a human
  // changing the vendor. Otherwise the queued reset can overwrite the
  // synthetic selection in jsdom even though a real click cannot race it.
  await flushEffects(50);
  await changeValue(env, dialog.querySelector('#model-policy-vendor'), 'claude');
  await waitFor(() => {
    dialog = root.querySelector('[role="dialog"]');
    assert.ok(dialog.querySelector('#model-policy-model-mode'));
    assert.equal(dialog.querySelector('#model-policy-reasoning_effort-mode'), null);
    assert.equal(dialog.querySelector('#model-policy-tier-mode'), null);
  });

  dialog.querySelector('[data-role="model-policy-editor-cancel"]').click();
  await waitFor(() => assert.equal(root.querySelector('[role="dialog"]'), null));
  root.querySelector('[data-role="model-policy-card"][data-vendor="claude"] [data-action="edit"]').click();
  dialog = await waitFor(() => {
    const element = root.querySelector('[role="dialog"]');
    assert.ok(element);
    assert.ok(element.querySelector('#model-policy-model-mode'));
    assert.equal(element.querySelector('#model-policy-reasoning_effort-mode'), null);
    assert.equal(element.querySelector('#model-policy-tier-mode'), null);
    return element;
  });
});

test('ModelPoliciesView omits inherited fields and emits the CLI-default sentinel', async (t) => {
  const { env, calls } = createEnv();
  t.after(env.cleanup);
  const root = renderView(env);
  await waitFor(() => assert.ok(root.querySelector('[data-role="new-model-policy"]')));

  root.querySelector('[data-role="new-model-policy"]').click();
  const dialog = await waitFor(() => {
    const element = root.querySelector('[role="dialog"]');
    assert.ok(element);
    return element;
  });
  await changeValue(env, dialog.querySelector('#model-policy-reasoning_effort-mode'), 'cli-default');
  await flushEffects(20);
  dialog.querySelector('[data-role="model-policy-save"]').click();

  const putCall = await waitFor(() => {
    const call = calls.find(item => item.opts.method === 'PUT');
    assert.ok(call);
    return call;
  });
  assert.equal(putCall.url, '/api/model-policies/global/*/codex');
  const body = JSON.parse(putCall.opts.body);
  assert.deepEqual(body.params, { reasoning_effort: '__cli_default__' });
  assert.equal(Object.hasOwn(body, 'expectedRevision'), false);
  await waitFor(() => assert.equal(root.querySelector('[role="dialog"]'), null));
});
