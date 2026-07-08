'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createPreactEnv, flushEffects, transformComponentSource } = require('./helpers/jsdom-preact');

function loadManagerView(env) {
  env.context.__managerChatProps = [];
  env.context.__sessionGridProps = [];
  env.context.ManagerChat = function ManagerChat(props) {
    env.context.__managerChatProps.push(props);
    return env.context.preact.h('div', {
      'data-role': 'manager-chat-stub',
      'data-target': props.conversationTarget,
    });
  };
  env.context.SessionGrid = function SessionGrid(props) {
    env.context.__sessionGridProps.push(props);
    return env.context.preact.h('button', {
      type: 'button',
      'data-role': 'session-grid-select-top',
      onClick: () => props.onSelectConversation('top'),
    }, 'top');
  };
  env.context.managerProfileAuthState = () => 'ok';

  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'components', 'ManagerView.js'), 'utf8');
  const transformed = transformComponentSource(src)
    .replace(/^export\s+\{[^}]+\};?\s*$/gm, '')
    + '\nthis.ManagerView = ManagerView;';
  vm.runInContext(transformed, env.context);
}

function renderManagerView(env, props = {}) {
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.ManagerView, {
    manager: { status: { active: true, pms: [] } },
    runs: [],
    tasks: [],
    projects: [],
    agents: [],
    agentsError: null,
    agentsLoading: false,
    reloadAgents: () => {},
    driftAudit: {},
    onOpenDrift: () => {},
    nodeSummary: {},
    ...props,
  }), root);
  return root;
}

async function waitForTarget(root, expected) {
  for (let i = 0; i < 20; i += 1) {
    const el = root.querySelector('[data-role="manager-chat-stub"]');
    if (el && el.getAttribute('data-target') === expected) return el;
    await flushEffects(20);
  }
  const el = root.querySelector('[data-role="manager-chat-stub"]');
  assert.equal(el && el.getAttribute('data-target'), expected);
  return el;
}

test('ManagerView defaults conversationTarget to top when initialTarget is absent', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  loadManagerView(env);

  const root = renderManagerView(env);
  await waitForTarget(root, 'top');
});

test('ManagerView seeds and updates conversationTarget from initialTarget', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  loadManagerView(env);

  const root = renderManagerView(env, { initialTarget: 'operator:proj_alpha' });
  await waitForTarget(root, 'operator:proj_alpha');

  renderManagerView(env, { initialTarget: 'operator:proj_beta' });
  await waitForTarget(root, 'operator:proj_beta');

  root.querySelector('[data-role="session-grid-select-top"]').click();
  await waitForTarget(root, 'top');
});
