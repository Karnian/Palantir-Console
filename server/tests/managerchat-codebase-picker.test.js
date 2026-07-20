'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

const BASE_PROJECTS = [
  { id: 'proj_primary', name: 'Primary', pm_enabled: 1 },
  { id: 'proj_beta', name: 'beta', pm_enabled: 1 },
  { id: 'proj_alpha', name: 'Alpha', pm_enabled: 1 },
  { id: 'proj_inactive', name: 'Inactive', pm_enabled: 0 },
  { id: 'proj_other', name: 'Other', pm_enabled: 1 },
];

function createManagerChatEnv({
  conversationTarget = 'operator:proj_primary',
  active = true,
  projects = BASE_PROJECTS,
  pms = [],
  resolveRouter = (body) => ({
    target: body.currentConversationId,
    text: body.text,
  }),
} = {}) {
  const env = createPreactEnv();
  const requests = [];
  const topSends = [];
  const toasts = [];
  const pmConversation = {
    events: [],
    run: { id: 'run_operator', status: 'running' },
    sendMessage: async () => {},
  };

  env.context.apiFetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    requests.push({ url, method: opts.method, body });
    if (url === '/api/router/resolve') return resolveRouter(body);
    return {};
  };
  env.context.addToast = (...args) => { toasts.push(args); };
  env.context.useConversation = () => pmConversation;
  env.context.renderMarkdown = (text) => text;
  env.context.timeAgo = () => '';
  env.context.Dropdown = function NativeDropdown(props) {
    return env.context.preact.h(
      'select',
      {
        class: props.className || '',
        value: props.value,
        disabled: props.disabled,
        'aria-label': props.ariaLabel,
        onChange: (event) => props.onChange(event.currentTarget.value),
      },
      props.options.map((option) => env.context.preact.h(
        'option',
        { key: option.value, value: option.value },
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

  const root = env.document.getElementById('root');
  let renderState = { conversationTarget, active, projects, pms };
  const renderChat = (patch = {}) => {
    renderState = { ...renderState, ...patch };
    const manager = {
      status: { active: renderState.active, usage: null, pms: renderState.pms },
      events: [],
      loading: false,
      start: async () => {},
      sendMessage: async (...args) => { topSends.push(args); },
      stop: async () => {},
      checkStatus: async () => {},
    };
    env.render(env.h(env.context.ManagerChat, {
      manager,
      projects: renderState.projects,
      conversationTarget: renderState.conversationTarget,
      onConversationChange: () => {},
    }), root);
  };
  renderChat();

  return { env, root, requests, topSends, toasts, renderChat };
}

function picker(ctx) {
  return ctx.root.querySelector('[aria-label="대상 코드베이스"]');
}

async function selectCodebase(ctx, value) {
  const select = picker(ctx);
  assert.ok(select, 'codebase picker rendered');
  select.value = value;
  select.dispatchEvent(new ctx.env.window.Event('change', { bubbles: true }));
  await flushEffects();
}

async function sendText(ctx, text) {
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

function messageRequests(ctx) {
  return ctx.requests.filter(request => /\/message$/.test(request.url));
}

test('A2b-3b picker renders only for an active Operator and excludes the primary project', async (t) => {
  const ctx = createManagerChatEnv();
  t.after(ctx.env.cleanup);
  await flushEffects();

  const select = picker(ctx);
  assert.ok(select);
  assert.equal(select.options[0].value, '');
  assert.equal(select.options[0].textContent, '기본 · Primary');
  assert.deepEqual(
    Array.from(select.options).map(option => option.value),
    ['', 'proj_alpha', 'proj_beta', 'proj_other'],
  );
  assert.equal(Array.from(select.options).some(option => option.value === 'proj_primary'), false);

  ctx.renderChat({ conversationTarget: 'top' });
  await flushEffects();
  assert.equal(picker(ctx), null, 'Top conversation hides codebase picker');

  ctx.renderChat({ conversationTarget: 'operator:proj_primary', active: false });
  await flushEffects();
  assert.equal(picker(ctx), null, 'inactive session hides codebase picker');
});

test('A2b-3b picker threads codebase context and default omits both fields', async (t) => {
  const ctx = createManagerChatEnv();
  t.after(ctx.env.cleanup);
  await flushEffects();

  await selectCodebase(ctx, 'proj_beta');
  await sendText(ctx, 'secondary turn');
  assert.deepEqual(messageRequests(ctx)[0].body, {
    text: 'secondary turn',
    codebaseProjectId: 'proj_beta',
    turnMode: 'codebase',
  });

  await selectCodebase(ctx, '');
  await sendText(ctx, 'default turn');
  assert.deepEqual(messageRequests(ctx)[1].body, { text: 'default turn' });
});

test('A2b-3b @mention overrides the picker for one turn without changing its value', async (t) => {
  const ctx = createManagerChatEnv({
    resolveRouter: (body) => body.text.startsWith('@')
      ? {
          target: body.currentConversationId,
          text: 'mention turn',
          codebaseProjectId: 'proj_alpha',
          turnMode: 'codebase',
          matchedRule: '1_explicit',
        }
      : { target: body.currentConversationId, text: body.text },
  });
  t.after(ctx.env.cleanup);
  await flushEffects();

  await selectCodebase(ctx, 'proj_beta');
  await sendText(ctx, '@alpha mention turn');
  assert.deepEqual(messageRequests(ctx)[0].body, {
    text: 'mention turn',
    codebaseProjectId: 'proj_alpha',
    turnMode: 'codebase',
  });
  assert.equal(picker(ctx).value, 'proj_beta');

  await sendText(ctx, 'picker resumes');
  assert.deepEqual(messageRequests(ctx)[1].body, {
    text: 'picker resumes',
    codebaseProjectId: 'proj_beta',
    turnMode: 'codebase',
  });
});

test('A2b-3b explicit unresolved mentions fail closed instead of falling back to the picker', async (t) => {
  const ctx = createManagerChatEnv({
    resolveRouter: (body) => ({
      target: body.currentConversationId,
      text: body.text,
      matchedRule: '4_default',
    }),
  });
  t.after(ctx.env.cleanup);
  await flushEffects();

  await selectCodebase(ctx, 'proj_beta');
  await sendText(ctx, '@missing do this');
  await sendText(ctx, '@disabled do this');

  assert.equal(messageRequests(ctx).length, 0, 'neither unresolved mention is delivered');
  assert.equal(ctx.toasts.length, 2);
  assert.match(ctx.toasts[0][0], /전송을 취소/);
  assert.equal(ctx.toasts[0][1], 'error');
});

test('A2b-3b cancels a send when the picked codebase went stale at send time', async (t) => {
  const projects = BASE_PROJECTS.map(project => ({ ...project }));
  const ctx = createManagerChatEnv({ projects });
  t.after(ctx.env.cleanup);
  await flushEffects();

  await selectCodebase(ctx, 'proj_beta');
  // Disable the picked codebase AFTER selection — simulate a pool change racing the
  // send (the passive effect has not fired yet in this synchronous window).
  projects.find(project => project.id === 'proj_beta').pm_enabled = 0;
  await sendText(ctx, 'stale selection');

  // Fail-closed: the send is cancelled (never silently delivered to the primary),
  // a toast is shown, the stale selection is cleared, and the input is restored.
  assert.equal(messageRequests(ctx).length, 0, 'stale selection is not delivered');
  assert.match(ctx.toasts[0][0], /유효하지 않습니다/);
  await flushEffects();
  assert.equal(picker(ctx).value, '', 'the stale selection is reset to the default');
});

test('A2b-3b canonical Operator snapshot excludes and labels its primary project', async (t) => {
  const ctx = createManagerChatEnv({
    conversationTarget: 'operator:oi_current',
    pms: [{
      conversationId: 'operator:oi_current',
      legacyConversationId: 'operator:proj_primary',
      run: { id: 'run_operator', status: 'running' },
    }],
  });
  t.after(ctx.env.cleanup);
  await flushEffects();

  const select = picker(ctx);
  assert.ok(select);
  assert.equal(select.options[0].textContent, '기본 · Primary');
  assert.equal(Array.from(select.options).some(option => option.value === 'proj_primary'), false);
});

test('A2b-3b resets on conversation changes and repairs disabled or removed selections', async (t) => {
  const ctx = createManagerChatEnv();
  t.after(ctx.env.cleanup);
  await flushEffects();

  await selectCodebase(ctx, 'proj_beta');
  ctx.renderChat({ conversationTarget: 'operator:proj_other' });
  await flushEffects();
  assert.equal(picker(ctx).value, '', 'conversation change resets selection');

  await selectCodebase(ctx, 'proj_beta');
  ctx.renderChat({
    projects: BASE_PROJECTS.map(project => project.id === 'proj_beta'
      ? { ...project, pm_enabled: 0 }
      : project),
  });
  await flushEffects();
  assert.equal(picker(ctx).value, '', 'disabled project repairs selection');

  ctx.renderChat({ projects: BASE_PROJECTS });
  await flushEffects();
  await selectCodebase(ctx, 'proj_beta');
  ctx.renderChat({ projects: BASE_PROJECTS.filter(project => project.id !== 'proj_beta') });
  await flushEffects();
  assert.equal(picker(ctx).value, '', 'removed project repairs selection');

  await sendText(ctx, 'after repair');
  assert.deepEqual(messageRequests(ctx).at(-1).body, { text: 'after repair' });
});

test('A2b-3b disables the picker while a send is pending', async (t) => {
  let finishResolve;
  const pendingResolve = new Promise(resolve => { finishResolve = resolve; });
  const ctx = createManagerChatEnv({ resolveRouter: () => pendingResolve });
  t.after(ctx.env.cleanup);
  await flushEffects();

  const input = ctx.root.querySelector('.manager-input');
  input.value = 'pending';
  input.dispatchEvent(new ctx.env.window.Event('input', { bubbles: true }));
  await flushEffects();
  ctx.root.querySelector('.manager-send-btn').click();
  await flushEffects(20);
  assert.equal(picker(ctx).disabled, true);

  finishResolve({
    target: 'operator:proj_primary',
    text: 'pending',
  });
  await flushEffects();
  assert.equal(picker(ctx).disabled, false);
});
