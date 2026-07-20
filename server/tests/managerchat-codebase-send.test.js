'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

function createManagerChatEnv({ conversationTarget, resolved }) {
  const env = createPreactEnv();
  const requests = [];
  const topSends = [];

  env.context.apiFetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    requests.push({ url, method: opts.method, body });
    if (url === '/api/router/resolve') return resolved;
    return {};
  };
  env.context.addToast = () => {};
  env.context.useConversation = () => ({
    events: [],
    run: { id: 'run_operator', status: 'running' },
    sendMessage: async () => {},
  });
  env.context.renderMarkdown = (text) => text;
  env.context.timeAgo = () => '';
  env.context.Dropdown = () => null;
  env.context.EmptyState = () => null;
  env.context.MentionInput = function MentionInput(props) {
    return env.context.preact.h('textarea', props);
  };
  env.context.RunInspector = () => null;
  env.context.operatorConversationId = (id) => `operator:${id}`;
  env.context.parseProjectConversationId = (id) => {
    const match = /^operator:(proj_.+)$/.exec(id || '');
    return match ? { projectId: match[1] } : null;
  };
  env.context.conversationIdMatchesProject = (id, projectId) => id === `operator:${projectId}`;

  env.loadComponent('ManagerChat');

  const manager = {
    status: { active: true, usage: null },
    events: [],
    loading: false,
    start: async () => {},
    sendMessage: async (...args) => { topSends.push(args); },
    stop: async () => {},
    checkStatus: async () => {},
  };
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.ManagerChat, {
    manager,
    projects: [
      { id: 'proj_alpha', name: 'alpha' },
      { id: 'proj_beta', name: 'beta' },
    ],
    conversationTarget,
    onConversationChange: () => {},
  }), root);

  return { env, root, requests, topSends };
}

async function sendText(ctx, text) {
  await flushEffects();
  const input = ctx.root.querySelector('.manager-input');
  assert.ok(input, 'chat input rendered');
  input.value = text;
  input.dispatchEvent(new ctx.env.window.Event('input', { bubbles: true }));
  await flushEffects();
  const button = ctx.root.querySelector('.manager-send-btn');
  assert.ok(button, 'send button rendered');
  button.click();
  await flushEffects();
}

test('A2b-3a ManagerChat threads resolved codebase context into Operator direct send', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'operator:oi_current',
    resolved: {
      target: 'operator:oi_current',
      codebaseProjectId: 'proj_beta',
      turnMode: 'codebase',
      text: 'hi',
      matchedRule: '1_explicit',
    },
  });
  t.after(ctx.env.cleanup);

  await sendText(ctx, '@beta hi');

  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.requests[0].url, '/api/router/resolve');
  assert.deepEqual(ctx.requests[0].body, {
    text: '@beta hi',
    currentConversationId: 'operator:oi_current',
  });
  assert.equal(ctx.requests[1].url, '/api/conversations/operator%3Aoi_current/message');
  assert.deepEqual(ctx.requests[1].body, {
    text: 'hi',
    codebaseProjectId: 'proj_beta',
    turnMode: 'codebase',
  });
});

test('A2b-3a ManagerChat Top legacy reroute sends no codebase context fields', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'top',
    resolved: {
      target: 'operator:proj_beta',
      text: 'hi',
      matchedRule: '1_explicit',
    },
  });
  t.after(ctx.env.cleanup);

  await sendText(ctx, '@beta hi');

  assert.equal(ctx.requests.length, 2);
  assert.equal(ctx.requests[1].url, '/api/conversations/operator%3Aproj_beta/message');
  assert.deepEqual(ctx.requests[1].body, { text: 'hi' });
  assert.equal(ctx.topSends.length, 0);
});
