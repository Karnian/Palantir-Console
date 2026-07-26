'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

function createManagerChatEnv({
  conversationTarget,
  resolved,
  events = [],
  queuedMessages = [],
  pms = [],
  rememberError = null,
}) {
  const env = createPreactEnv();
  const requests = [];
  const topSends = [];

  env.context.apiFetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    requests.push({ url, method: opts.method, body });
    if (url === '/api/router/resolve') return resolved;
    if (rememberError && url.endsWith('memory/remember')) throw rememberError;
    return {};
  };
  env.context.addToast = () => {};
  env.context.useConversation = () => ({
    events,
    queuedMessages,
    run: { id: 'run_operator', status: 'running' },
    sendMessage: async () => {},
  });
  env.context.renderMarkdown = (text) => text;
  env.context.timeAgo = () => '';
  env.context.Dropdown = function Dropdown(props) {
    return env.context.preact.h(
      'select',
      {
        className: props.className || '',
        value: props.value,
        onChange: (event) => props.onChange(event.target.value),
      },
      ...(props.options || []).map((option) => env.context.preact.h(
        'option',
        { value: option.value },
        option.label,
      )),
    );
  };
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
    status: { active: true, usage: null, pms },
    events,
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

test('ManagerChat /remember saves to user memory without sending a conversation turn', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'top',
    resolved: null,
  });
  t.after(ctx.env.cleanup);

  await sendText(ctx, '/remember Prefer focused verification before the full suite.');

  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0].url, '/api/master-memory/remember');
  assert.equal(ctx.requests[0].method, 'POST');
  assert.deepEqual(ctx.requests[0].body, {
    scope: 'user',
    kind: 'preference',
    content: 'Prefer focused verification before the full suite.',
    importance: 5,
  });
  assert.equal(ctx.topSends.length, 0);
});

test('ManagerChat restores a failed /remember command instead of losing the draft', async (t) => {
  const command = '/remember Keep failed memory drafts recoverable.';
  const ctx = createManagerChatEnv({
    conversationTarget: 'top',
    resolved: null,
    rememberError: new Error('network down'),
  });
  t.after(ctx.env.cleanup);

  await sendText(ctx, command);
  await flushEffects(180);

  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.root.querySelector('.manager-input').value, command);
  assert.equal(ctx.topSends.length, 0);
});

test('ManagerChat rejects /remember with an image and preserves both inputs', async (t) => {
  const command = '/remember Keep the image attached for the actual conversation.';
  const ctx = createManagerChatEnv({
    conversationTarget: 'top',
    resolved: null,
  });
  t.after(ctx.env.cleanup);
  await flushEffects();

  const input = ctx.root.querySelector('.manager-input');
  const file = new ctx.env.window.File(['image-bytes'], 'context.png', { type: 'image/png' });
  const paste = new ctx.env.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: {
      items: [{
        type: 'image/png',
        getAsFile: () => file,
      }],
    },
  });
  input.dispatchEvent(paste);
  await flushEffects(80);
  assert.equal(ctx.root.querySelectorAll('.manager-image-preview').length, 1);

  await sendText(ctx, command);
  assert.equal(ctx.requests.length, 0);
  assert.equal(ctx.topSends.length, 0);
  assert.equal(ctx.root.querySelector('.manager-input').value, command);
  assert.equal(ctx.root.querySelectorAll('.manager-image-preview').length, 1);
});

test('ManagerChat message action remembers rendered text and excludes error rows', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'top',
    resolved: null,
    events: [
      {
        id: 1,
        event_type: 'assistant_text',
        payload_json: JSON.stringify({ text: 'Keep release notes concise and actionable.' }),
        created_at: '2026-07-26 10:00:00',
      },
      {
        id: 2,
        event_type: 'error',
        payload_json: JSON.stringify({ message: 'temporary adapter failure' }),
        created_at: '2026-07-26 10:01:00',
      },
    ],
  });
  t.after(ctx.env.cleanup);
  await flushEffects();

  const rememberButtons = Array.from(ctx.root.querySelectorAll('.manager-msg-remember'));
  assert.equal(rememberButtons.length, 1, 'error messages must not expose a remember action');
  rememberButtons[0].click();
  await flushEffects();

  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0].url, '/api/master-memory/remember');
  assert.equal(ctx.requests[0].body.content, 'Keep release notes concise and actionable.');
});

test('ManagerChat Operator /remember defaults to its primary workspace', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'operator:oi_current',
    resolved: null,
    pms: [{
      conversationId: 'operator:oi_current',
      legacyConversationId: 'operator:proj_alpha',
      primaryProjectId: 'proj_alpha',
      profileId: 'op_profile_1',
      run: { id: 'run_operator', status: 'running', manager_adapter: 'codex' },
    }],
  });
  t.after(ctx.env.cleanup);

  await sendText(ctx, '/remember Always report the exact verification command.');

  assert.equal(ctx.requests.length, 1);
  assert.equal(ctx.requests[0].url, '/api/projects/proj_alpha/memory/remember');
  assert.deepEqual(ctx.requests[0].body, {
    kind: 'convention',
    content: 'Always report the exact verification command.',
    importance: 5,
  });
});

test('ManagerChat remembers an Operator response in that message turn codebase', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'operator:oi_current',
    resolved: null,
    pms: [{
      conversationId: 'operator:oi_current',
      legacyConversationId: 'operator:proj_alpha',
      primaryProjectId: 'proj_alpha',
      profileId: 'op_profile_1',
      run: { id: 'run_operator', status: 'running', manager_adapter: 'codex' },
    }],
    queuedMessages: [{
      id: 'queue_beta',
      idempotency_key: 'client_beta',
      client_message_id: 'queue_beta',
      conversation_id: 'operator:oi_current',
      display_text: 'Review beta.',
      codebase_project_id: 'proj_beta',
      attachment_count: 0,
      status: 'delivered',
      created_at: '2026-07-26 10:00:00',
    }],
    events: [{
      id: 10,
      event_type: 'mgr.assistant_message',
      payload_json: JSON.stringify({
        summaryText: 'Beta uses transactional migrations.',
        data: {
          text: 'Beta uses transactional migrations.',
          invocationId: 'queue_beta',
        },
      }),
      created_at: '2026-07-26 10:01:00',
    }],
  });
  t.after(ctx.env.cleanup);
  await flushEffects(120);

  const assistantAction = ctx.root.querySelector(
    '.manager-msg-row-assistant .manager-msg-remember',
  );
  assert.ok(assistantAction);
  assistantAction.click();
  await flushEffects();

  const remember = ctx.requests.find((request) => request.url.endsWith('/memory/remember'));
  assert.equal(remember.url, '/api/projects/proj_beta/memory/remember');
  assert.equal(remember.body.content, 'Beta uses transactional migrations.');
});

test('ManagerChat ignores caller idempotency keys that collide with another invocation id', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'operator:oi_current',
    resolved: null,
    pms: [{
      conversationId: 'operator:oi_current',
      legacyConversationId: 'operator:proj_alpha',
      primaryProjectId: 'proj_alpha',
      profileId: 'op_profile_1',
      run: { id: 'run_operator', status: 'running', manager_adapter: 'codex' },
    }],
    queuedMessages: [{
      id: 'queue_alpha',
      idempotency_key: 'client_alpha',
      client_message_id: 'invocation_alpha',
      conversation_id: 'operator:oi_current',
      display_text: 'Review alpha.',
      memory_owner_type: 'workspace',
      memory_owner_id: 'proj_alpha',
      attachment_count: 0,
      status: 'delivered',
      created_at: '2026-07-26 10:00:00',
    }, {
      id: 'queue_beta',
      // Caller-controlled namespace intentionally collides with the earlier
      // server-issued adapter invocation id.
      idempotency_key: 'invocation_alpha',
      client_message_id: 'invocation_beta',
      conversation_id: 'operator:oi_current',
      display_text: 'Review beta.',
      memory_owner_type: 'workspace',
      memory_owner_id: 'proj_beta',
      attachment_count: 0,
      status: 'delivered',
      created_at: '2026-07-26 10:02:00',
    }],
    events: [{
      id: 10,
      event_type: 'mgr.assistant_message',
      payload_json: JSON.stringify({
        summaryText: 'Alpha requires signed releases.',
        data: {
          text: 'Alpha requires signed releases.',
          invocationId: 'invocation_alpha',
        },
      }),
      created_at: '2026-07-26 10:01:00',
    }],
  });
  t.after(ctx.env.cleanup);
  await flushEffects(120);

  const assistantAction = ctx.root.querySelector(
    '.manager-msg-row-assistant .manager-msg-remember',
  );
  assert.ok(assistantAction);
  assistantAction.click();
  await flushEffects();

  const remember = ctx.requests.find((request) => request.url.endsWith('/memory/remember'));
  assert.equal(remember.url, '/api/projects/proj_alpha/memory/remember');
});

test('ManagerChat keeps a primary-turn response bound to primary after picker changes', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'operator:oi_current',
    resolved: null,
    pms: [{
      conversationId: 'operator:oi_current',
      legacyConversationId: 'operator:proj_alpha',
      primaryProjectId: 'proj_alpha',
      profileId: 'op_profile_1',
      run: { id: 'run_operator', status: 'running', manager_adapter: 'codex' },
    }],
    queuedMessages: [{
      id: 'queue_alpha',
      client_message_id: 'queue_alpha',
      conversation_id: 'operator:oi_current',
      display_text: 'Review the primary project.',
      codebase_project_id: null,
      memory_owner_type: 'workspace',
      memory_owner_id: 'proj_alpha',
      attachment_count: 0,
      status: 'delivered',
      created_at: '2026-07-26 10:00:00',
    }],
    events: [{
      id: 10,
      event_type: 'mgr.assistant_message',
      payload_json: JSON.stringify({
        summaryText: 'Alpha requires release notes.',
        data: {
          text: 'Alpha requires release notes.',
          invocationId: 'queue_alpha',
        },
      }),
      created_at: '2026-07-26 10:01:00',
    }],
  });
  t.after(ctx.env.cleanup);
  await flushEffects(120);

  const picker = ctx.root.querySelector('.manager-codebase-picker');
  assert.ok(picker);
  picker.value = 'proj_beta';
  picker.dispatchEvent(new ctx.env.window.Event('change', { bubbles: true }));
  await flushEffects(40);

  const assistantAction = ctx.root.querySelector(
    '.manager-msg-row-assistant .manager-msg-remember',
  );
  assert.ok(assistantAction);
  assistantAction.click();
  await flushEffects();

  const remember = ctx.requests.find((request) => request.url.endsWith('/memory/remember'));
  assert.equal(remember.url, '/api/projects/proj_alpha/memory/remember');
});

test('ManagerChat hides remember for an Operator response whose durable owner is unavailable', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'operator:oi_current',
    resolved: null,
    pms: [{
      conversationId: 'operator:oi_current',
      legacyConversationId: 'operator:proj_alpha',
      primaryProjectId: 'proj_alpha',
      profileId: 'op_profile_1',
      run: { id: 'run_operator', status: 'running', manager_adapter: 'codex' },
    }],
    events: [{
      id: 10,
      event_type: 'assistant_text',
      payload_json: JSON.stringify({
        text: 'This historical response has no durable invocation owner.',
      }),
      created_at: '2026-07-26 10:01:00',
    }],
  });
  t.after(ctx.env.cleanup);
  await flushEffects(120);

  assert.equal(
    ctx.root.querySelector('.manager-msg-row-assistant .manager-msg-remember'),
    null,
  );
});

test('ManagerChat remembers a generic Operator response in its durable profile owner', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'operator:oi_current',
    resolved: null,
    pms: [{
      conversationId: 'operator:oi_current',
      legacyConversationId: 'operator:proj_alpha',
      primaryProjectId: 'proj_alpha',
      profileId: 'op_profile_1',
      run: { id: 'run_operator', status: 'running', manager_adapter: 'codex' },
    }],
    queuedMessages: [{
      id: 'queue_generic',
      client_message_id: 'queue_generic',
      conversation_id: 'operator:oi_current',
      display_text: 'Give general guidance.',
      codebase_project_id: null,
      memory_owner_type: 'profile',
      memory_owner_id: 'op_profile_1',
      attachment_count: 0,
      status: 'delivered',
      created_at: '2026-07-26 10:00:00',
    }],
    events: [{
      id: 10,
      event_type: 'mgr.assistant_message',
      payload_json: JSON.stringify({
        summaryText: 'Prefer bounded work queues.',
        data: {
          text: 'Prefer bounded work queues.',
          invocationId: 'queue_generic',
        },
      }),
      created_at: '2026-07-26 10:01:00',
    }],
  });
  t.after(ctx.env.cleanup);
  await flushEffects(120);

  const assistantAction = ctx.root.querySelector(
    '.manager-msg-row-assistant .manager-msg-remember',
  );
  assert.ok(assistantAction);
  assistantAction.click();
  await flushEffects();

  const remember = ctx.requests.find((request) => request.url.endsWith('/memory/remember'));
  assert.equal(remember.url, '/api/operator/profiles/op_profile_1/memory/remember');
});

test('ManagerChat refuses to retarget memory when a message project is no longer valid', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'operator:oi_current',
    resolved: null,
    pms: [{
      conversationId: 'operator:oi_current',
      legacyConversationId: 'operator:proj_alpha',
      primaryProjectId: 'proj_alpha',
      profileId: 'op_profile_1',
      run: { id: 'run_operator', status: 'running', manager_adapter: 'codex' },
    }],
    queuedMessages: [{
      id: 'queue_retired',
      client_message_id: 'queue_retired',
      conversation_id: 'operator:oi_current',
      display_text: 'Review the retired project.',
      codebase_project_id: 'proj_retired',
      attachment_count: 0,
      status: 'delivered',
      created_at: '2026-07-26 10:00:00',
    }],
    events: [{
      id: 10,
      event_type: 'mgr.assistant_message',
      payload_json: JSON.stringify({
        summaryText: 'The retired project requires a legacy build.',
        data: {
          text: 'The retired project requires a legacy build.',
          invocationId: 'queue_retired',
        },
      }),
      created_at: '2026-07-26 10:01:00',
    }],
  });
  t.after(ctx.env.cleanup);
  await flushEffects(120);

  const assistantAction = ctx.root.querySelector(
    '.manager-msg-row-assistant .manager-msg-remember',
  );
  assert.ok(assistantAction);
  assistantAction.click();
  await flushEffects();

  assert.equal(
    ctx.requests.some((request) => request.url.endsWith('/memory/remember')),
    false,
  );
});
