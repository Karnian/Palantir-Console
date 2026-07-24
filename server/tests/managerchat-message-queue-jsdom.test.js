'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

function createEnv({ apiFetch } = {}) {
  const env = createPreactEnv();
  const requests = [];
  env.context.apiFetch = apiFetch || (async (url, opts = {}) => {
    requests.push({ url, opts });
    if (url === '/api/router/resolve') {
      const body = JSON.parse(opts.body);
      return { target: body.currentConversationId, text: body.text };
    }
    if (opts.method === 'DELETE') {
      return { message: { id: 'msg-queued', status: 'cancelled' } };
    }
    return {};
  });
  env.context.addToast = () => {};
  env.context.useConversation = () => ({
    events: [],
    queuedMessages: [],
    run: null,
    reloadQueue: () => {},
  });
  env.context.renderMarkdown = text => text;
  env.context.timeAgo = () => '';
  env.context.Dropdown = () => null;
  env.context.EmptyState = () => null;
  env.context.MentionInput = function MentionInput(props) {
    return env.context.preact.h('textarea', props);
  };
  env.context.RunInspector = () => null;
  env.context.operatorConversationId = id => `operator:${id}`;
  env.context.parseProjectConversationId = () => null;
  env.context.conversationIdMatchesProject = () => false;
  env.loadComponent('ManagerChat');

  const root = env.document.getElementById('root');
  const renderChat = (queuedMessages = []) => {
    const manager = {
      status: { active: true, usage: null, pms: [] },
      events: [],
      queuedMessages,
      loading: false,
      start: async () => {},
      stop: async () => {},
      checkStatus: async () => {},
      reloadQueue: () => {},
    };
    env.render(env.h(env.context.ManagerChat, {
      manager,
      projects: [],
      runs: [],
      tasks: [],
      conversationTarget: 'top',
      onConversationChange: () => {},
    }), root);
  };
  renderChat();
  return { env, root, requests, renderChat };
}

function row(status, overrides = {}) {
  return {
    id: 'msg-queued',
    idempotency_key: 'client-key',
    conversation_id: 'top',
    sequence: 1,
    display_text: '두 번째 요청',
    attachment_count: 0,
    status,
    created_at: '2026-07-24 10:00:00',
    updated_at: '2026-07-24 10:00:00',
    ...overrides,
  };
}

test('ManagerChat renders queued → processing → delivered and exposes queued cancellation', async (t) => {
  const ctx = createEnv();
  t.after(ctx.env.cleanup);

  ctx.renderChat([row('queued')]);
  await flushEffects();
  let state = ctx.root.querySelector('[data-message-status]');
  assert.equal(state?.dataset.messageStatus, 'queued');
  assert.match(state.textContent, /대기 중/);
  const cancel = ctx.root.querySelector('.manager-msg-cancel');
  assert.ok(cancel);
  cancel.click();
  await flushEffects();
  assert.match(ctx.requests.at(-1).url, /\/api\/conversations\/top\/messages\/msg-queued$/);
  assert.equal(ctx.requests.at(-1).opts.method, 'DELETE');

  ctx.renderChat([row('processing')]);
  await flushEffects();
  state = ctx.root.querySelector('[data-message-status]');
  assert.equal(state?.dataset.messageStatus, 'processing');
  assert.match(state.textContent, /처리 중/);
  assert.equal(ctx.root.querySelector('.manager-msg-cancel'), null);

  ctx.renderChat([row('delivered')]);
  await flushEffects();
  state = ctx.root.querySelector('[data-message-status]');
  assert.equal(state?.dataset.messageStatus, 'delivered');
  assert.match(state.textContent, /전달됨/);
});

test('ManagerChat renders terminal failure reason inline instead of replacing the bubble with a red send error', async (t) => {
  const ctx = createEnv();
  t.after(ctx.env.cleanup);
  ctx.renderChat([row('failed', { last_error: 'adapter process exited with code 1' })]);
  await flushEffects();

  assert.equal(
    ctx.root.querySelector('[data-message-status]')?.dataset.messageStatus,
    'failed',
  );
  const reason = ctx.root.querySelector('.manager-msg-delivery-error');
  assert.ok(reason);
  assert.equal(reason.textContent, 'adapter process exited with code 1');
  assert.equal(reason.getAttribute('role'), 'alert');
});

test('ManagerChat paints an optimistic queued bubble before the enqueue request resolves', async (t) => {
  let resolvePost;
  const postPending = new Promise(resolve => { resolvePost = resolve; });
  const ctx = createEnv({
    apiFetch: async (url, opts = {}) => {
      if (url === '/api/router/resolve') {
        const body = JSON.parse(opts.body);
        return { target: 'top', text: body.text };
      }
      if (url === '/api/conversations/top/message') return postPending;
      return {};
    },
  });
  t.after(ctx.env.cleanup);
  await flushEffects();

  const input = ctx.root.querySelector('.manager-input');
  input.value = '빠르게 연속 입력';
  input.dispatchEvent(new ctx.env.window.Event('input', { bubbles: true }));
  await flushEffects();
  ctx.root.querySelector('.manager-send-btn').click();
  await flushEffects(30);

  const state = ctx.root.querySelector('[data-message-status="queued"]');
  assert.ok(state, 'optimistic queued status is visible while POST is pending');
  assert.match(ctx.root.querySelector('.manager-msg-content').textContent, /빠르게 연속 입력/);

  resolvePost({
    status: 'queued',
    message: row('queued', { display_text: '빠르게 연속 입력' }),
  });
  await flushEffects();
});
