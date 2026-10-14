'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { createPreactEnv, flushEffects, transformComponentSource } = require('./helpers/jsdom-preact');
const { createSnapshots } = require('./helpers/work-board-fixture.cjs');
const publicRoot = path.join(__dirname, '../public');
const REV = '0123456789abcdef';
const NEXT = 'fedcba9876543210';
function loadLib(env, file) {
  const src = fs.readFileSync(path.join(publicRoot, 'app/lib', file), 'utf8');
  vm.runInContext(src.replace(/^import .*$/gm, '').replace(/\bexport /g, ''), env.context);
}
function setup(t) {
  const env = createPreactEnv();
  const root = env.document.getElementById('root');
  env.context.AbortController = AbortController;
  loadLib(env, 'api.js'); loadLib(env, 'markdown.js'); loadLib(env, 'workBoard.js');
  env.window.marked = require('../public/vendor/marked.min.js');
  env.window.DOMPurify = require('../public/vendor/purify.min.js')(env.window);
  vm.runInContext('this.W = WORK_BOARD_LABELS;', env.context);
  for (const name of ['useSessionSnapshots', 'useSnapshotRefresh', 'useAssistantMemory']) {
    const src = fs.readFileSync(path.join(publicRoot, 'app/lib/hooks', `${name}.js`), 'utf8');
    vm.runInContext(transformComponentSource(src), env.context);
  }
  env.loadComponent('AssistantMemory');
  env.loadComponent('SnapshotRefreshControls');
  env.loadComponent('SessionHubSidebar');
  env.loadComponent('Dropdown'); env.loadComponent('SessionSnapshotParts'); env.loadComponent('AllSessionsPanel');
  env.loadComponent('SessionHubChat');
  t.after(() => { env.render(null, root); env.cleanup(); });
  return { ...env, root };
}
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-hub-ui-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return createSnapshots(temp);
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function response(body, status = 200) { return { ok: status < 400, status, json: async () => body }; }

function loadAppShell(env) {
  for (const file of ['nav.js', 'conversationId.js', 'a11y.js']) loadLib(env, file);
  for (const file of ['hooks/routing.js', 'hooks/observe.js', 'toast.js']) {
    const source = fs.readFileSync(path.join(publicRoot, 'app/lib', file), 'utf8');
    vm.runInContext(transformComponentSource(source).replace(/^export /gm, ''), env.context);
  }
  // Supply unrelated data hooks; every rendered component and the routing/observe hooks are real.
  const empty = () => {};
  env.context.useTasks = () => ({ tasks: [], setTasks: empty, reload: empty });
  env.context.useRuns = () => ({ runs: [], setRuns: empty, reload: empty });
  env.context.useProjects = () => ({ projects: [], reload: empty });
  env.context.useAgents = () => ({ agents: [], reload: empty });
  env.context.useClaudeSessions = () => ({ sessions: [] });
  env.context.useManagerLifecycle = () => ({ status: { active: false, pms: [] } });
  env.context.useConversation = () => ({ events: [], queuedMessages: [] });
  env.context.useDispatchAudit = () => ({ pending: [], count: 0 });
  env.context.useSSE = () => ({ connected: true });
  env.context.sseBroker = { subscribe: () => () => {} };
  env.context.useEscape = empty;
  env.context.requestNotificationPermission = empty;
  for (const name of ['EmptyState', 'AttentionStrip', 'SessionGrid', 'ManagerChat', 'CommandPalette', 'DriftDrawer']) {
    env.loadComponent(name);
  }
  const manager = fs.readFileSync(path.join(publicRoot, 'app/components/ManagerView.js'), 'utf8');
  vm.runInContext(transformComponentSource(manager).replace(/^export\s+\{[^}]+\};?\s*$/gm, ''), env.context);
  env.context.htmFactory = env.context.htm;
  const app = fs.readFileSync(path.join(publicRoot, 'app.js'), 'utf8');
  vm.runInContext(transformComponentSource(app), env.context);
}

test('real app preserves the off work board and navigation; active hub redirects into its panel', async t => {
  const env = setup(t), { alpha } = fixture(t);
  let active = false;
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async url => response(url === '/api/health' ? { sessionHubActive: active }
    : url.endsWith('/chat/state') ? { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'idle', messages: [] }
      : url.endsWith('/snapshots') ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] }
        : url.includes('/snapshots/alpha') ? alpha : { nodes: [], queued: [] });
  loadAppShell(env);
  env.window.location.hash = 'work';
  env.render(env.h(env.context.App), env.root); await flushEffects(); await flushEffects();
  assert.equal(env.window.location.hash, '#work');
  assert.equal(env.root.querySelectorAll('button.session-row').length, 2);
  assert.equal(env.root.querySelector('.nav-work-label').textContent, '작업');
  assert.ok(env.root.querySelector('.nav-work.active'));
  env.render(null, env.root); active = true; env.window.location.hash = 'work';
  env.render(env.h(env.context.App), env.root); await flushEffects(); await flushEffects(); await flushEffects();
  assert.equal(env.window.location.hash, '#manager/all-sessions');
  assert.equal(env.root.querySelector('.nav-work'), null);
  assert.ok(env.root.querySelector('.session-hub-chat'));
  assert.equal(env.root.querySelectorAll('.session-hub-sidebar button.session-row').length, 2);
  const chat = env.root.querySelector('.session-hub-chat');
  const work = () => Array.from(env.root.querySelectorAll('.session-hub-nav')).find(node => node.textContent === '작업');
  work().click(); await flushEffects();
  assert.equal(env.window.location.hash, '#manager/all-sessions');
  assert.ok(env.root.querySelector('.manager-grid-side'));
  for (let i = 0; i < 2; i++) {
    env.window.location.hash = 'work'; await flushEffects(); await flushEffects();
    assert.equal(env.window.location.hash, '#manager/all-sessions');
    assert.equal(env.root.querySelector('.session-hub-manager').dataset.pane, 'sidebar');
    assert.equal(env.root.querySelector('.session-hub-manager').dataset.right, 'closed');
    assert.equal(env.root.querySelector('.session-hub-chat'), chat);
    work().click(); await flushEffects();
  }
});

test('detail 503 leaves rev unconfirmed, evidence clickable and retry available', async t => {
  const env = setup(t), { alpha, beta } = fixture(t), updates = [], opened = [];
  let failDetail = true;
  env.context.fetch = async url => response(url.endsWith('/snapshots') ? { rev: REV, snapshots: [
    { machine_id: 'alpha', machine_label: 'Mac', sha256: 'a' },
    { machine_id: 'beta', machine_label: 'codev2', sha256: 'b' },
  ] } : url.includes('/alpha') ? alpha : failDetail ? { error: 'internal_error' } : beta,
  url.includes('/beta') && failDetail ? 503 : 200);
  const key = beta.sessions[0].key;
  const View = () => {
    const [panel, setPanel] = env.context.preactHooks.useState({ cards: [], rev: null });
    return env.h('div', {}, [env.h(env.context.AllSessionsPanel, { onData: data => {
      updates.push(data); setPanel(data);
    } }), env.h(env.context.SessionEvidence, { sessionKey: key, evidenceRev: REV, panel,
      onOpenSession: (...args) => opened.push(args) })]);
  };
  env.render(env.h(View), env.root); await flushEffects(); await flushEffects();
  assert.equal(updates.at(-1).rev, null);
  assert.equal(updates.at(-1).cards.length, 2);
  assert.ok(env.root.querySelector('.work-header').textContent.includes('미확정'));
  const chip = env.root.querySelector('button.session-evidence');
  assert.ok(chip); assert.equal(chip.disabled, false); assert.ok(chip.textContent.includes('확인 불가'));
  chip.click(); assert.deepEqual(opened, [[key, REV]]);
  const retry = Array.from(env.root.querySelectorAll('button'))
    .find(node => node.textContent.includes('다시 시도'));
  assert.ok(retry); failDetail = false; retry.click(); await flushEffects(); await flushEffects();
  assert.equal(updates.at(-1).rev, REV);
  assert.equal(updates.at(-1).cards.length, 3);
  assert.ok(!env.root.querySelector('button.session-evidence').textContent.includes('확인 불가'));
});

test('reconnected SSE replaces version 40 with a new epoch at version zero', async t => {
  const env = setup(t);
  let source;
  const previous = { thread_id: 'thread-1', epoch: 'previous-boot', version: 40,
    state: 'running', turnInProgress: false,
    messages: [{ role: 'assistant', content: '이전 서버 답변' }] };
  const restarted = { thread_id: 'thread-1', epoch: 'next-boot', version: 0,
    state: 'idle', messages: [], turnInProgress: false };
  let serverState = previous;
  env.context.EventSource = class {
    constructor() { source = this; }
    addEventListener(name, callback) { this.receive = callback; }
    close() {}
  };
  env.context.fetch = async () => response(serverState);
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
  assert.ok(env.root.textContent.includes('이전 서버 답변'));
  source.onerror(); await flushEffects();
  serverState = restarted;
  source.onopen(); source.receive({ data: JSON.stringify(restarted) }); await flushEffects();
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '중지됨');
  assert.equal(env.root.querySelector('.manager-msg-assistant'), null);
  source.receive({ data: JSON.stringify({ ...restarted, version: 2, state: 'running', messages: [
    { role: 'assistant', content: '새 서버 답변' },
  ] }) }); await flushEffects();
  source.receive({ data: JSON.stringify(restarted) }); await flushEffects();
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
  assert.ok(env.root.textContent.includes('새 서버 답변'));
});

for (const [operation, replyEpoch] of [['GET', 'old'], ['POST', 'old'], ['POST', 'unseen']]) {
  test(`late ${operation} from the ${replyEpoch} epoch cannot replace a restarted server`, async t => {
    const env = setup(t), delayed = deferred();
    let source;
    const old = { thread_id: 'thread-1', epoch: 'old', version: 40,
      state: 'idle', messages: [], turnInProgress: false };
    const fresh = { ...old, epoch: 'fresh', version: 0, messages: [{ role: 'assistant', content: '새 서버' }] };
    let serverState = old, reads = 0;
    env.context.EventSource = class {
      constructor() { source = this; }
      addEventListener(name, callback) { this.receive = callback; }
      close() {}
    };
    env.context.fetch = async (url, opts) => {
      if (opts.method === 'POST' || (operation === 'GET' && ++reads === 1)) return delayed.promise;
      return response(serverState);
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    if (operation === 'POST') { env.root.querySelector('[data-action="start"]').click(); await flushEffects(); }
    serverState = fresh;
    source.receive({ data: JSON.stringify(fresh) }); await flushEffects();
    delayed.resolve(response({ ...old, epoch: replyEpoch, state: 'running' })); await flushEffects();
    assert.equal(env.root.querySelector('.manager-status-badge').textContent, '중지됨');
    assert.equal(env.root.querySelector('.manager-msg-assistant').textContent.trim(), '새 서버');
    // Each different epoch requires the current HTTP state, never cumulative epoch tracking.
    serverState = { ...fresh, epoch: 'newest' };
    source.receive({ data: JSON.stringify({ ...fresh, epoch: 'newest' }) }); await flushEffects();
    source.receive({ data: JSON.stringify({ ...fresh, version: 100, state: 'running' }) }); await flushEffects();
    assert.equal(env.root.querySelector('.manager-status-badge').textContent, '중지됨');
  });
}

for (const operation of ['GET', 'POST']) {
  test(`late ${operation} with a higher version in the current epoch is applied`, async t => {
    const env = setup(t), delayed = deferred();
    let source;
    const idle = { thread_id: 'thread-1', epoch: 'same', version: 0,
      state: 'idle', messages: [], turnInProgress: false };
    env.context.EventSource = class {
      constructor() { source = this; }
      addEventListener(name, callback) { this.receive = callback; }
      close() {}
    };
    env.context.fetch = async (url, opts) => operation === 'GET' || opts.method === 'POST'
      ? delayed.promise : response(idle);
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    if (operation === 'POST') { env.root.querySelector('[data-action="start"]').click(); await flushEffects(); }
    source.receive({ data: JSON.stringify({ ...idle, version: 1 }) }); await flushEffects();
    delayed.resolve(response({ ...idle, version: 2, state: 'running', messages: [
      { role: 'assistant', content: '더 높은 버전' },
    ] })); await flushEffects();
    assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
    assert.equal(env.root.querySelector('.manager-msg-assistant').textContent.trim(), '더 높은 버전');
  });
}

test('same-route navigation and links restore the session sidebar', async t => {
  const env = setup(t), { alpha } = fixture(t);
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async url => response(url === '/api/health' ? { sessionHubActive: true }
    : url.endsWith('/chat/state') ? { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'idle', messages: [] }
      : url.endsWith('/snapshots') ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] }
        : url.includes('/snapshots/alpha') ? alpha : { nodes: [], queued: [] });
  loadAppShell(env);
  env.window.location.hash = 'manager/all-sessions';
  env.render(env.h(env.context.App), env.root); await flushEffects(); await flushEffects(); await flushEffects();
  const work = () => Array.from(env.root.querySelectorAll('.session-hub-nav')).find(node => node.textContent === '작업');
  const link = env.document.createElement('a');
  link.href = '#manager/all-sessions'; link.textContent = '목록으로 이동'; env.document.body.append(link);
  for (const enter of [() => env.context.navigate('manager/all-sessions'), () => link.click()]) {
    work().click();
    env.root.querySelectorAll('.session-hub-segments button')[1].click(); await flushEffects();
    assert.equal(env.root.querySelector('.session-hub-manager').dataset.pane, 'chat');
    enter(); await flushEffects(); await flushEffects();
    assert.equal(env.window.location.hash, '#manager/all-sessions');
    assert.equal(env.root.querySelector('.session-hub-manager').dataset.right, 'closed');
    assert.equal(env.root.querySelector('.session-hub-manager').dataset.pane, 'sidebar');
  }
});

test('real app panel clicks preserve the Operator conversation and hash', async t => {
  const env = setup(t), { alpha } = fixture(t), conversations = [];
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async url => response(url === '/api/health' ? { sessionHubActive: true }
    : url.endsWith('/chat/state') ? { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'idle', messages: [] }
      : url.endsWith('/snapshots') ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] }
        : url.includes('/snapshots/alpha') ? alpha : { nodes: [], queued: [] });
  loadAppShell(env);
  env.context.useProjects = () => ({ projects: [{ id: 'p1', name: 'Project 1', pm_enabled: 1 }] });
  env.context.useConversation = target => {
    conversations.push(target); return { events: [], queuedMessages: [] };
  };
  env.window.location.hash = 'manager/operator/p1';
  env.render(env.h(env.context.App), env.root); await flushEffects(); await flushEffects(); await flushEffects();
  assert.ok(conversations.includes('operator:p1'));
  const chat = env.root.querySelector('.session-hub-chat');
  const input = chat.querySelector('textarea');
  input.value = '유지할 질문'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects();
  env.root.querySelector('button.session-row').click(); await flushEffects();
  assert.equal(env.window.location.hash, '#manager/operator/p1');
  assert.ok(env.root.querySelector('.session-hub-detail'));
  const operator = Array.from(env.root.querySelectorAll('.session-hub-nav'))
    .find(node => node.textContent.includes('Operator'));
  operator.click(); await flushEffects(); await flushEffects();
  assert.equal(env.window.location.hash, '#manager/operator/p1');
  assert.equal(env.root.querySelector('.session-hub-chat'), chat);
  assert.equal(input.value, '유지할 질문');
  assert.ok(env.root.querySelector('.session-hub-panel-side .manager-panel-title').textContent.includes('Project 1'));
  assert.equal(conversations.at(-1), 'operator:p1');
});

test('late GET and stale SSE cannot undo newer POST state or messages', async t => {
  const env = setup(t), get = deferred(), calls = [];
  let source;
  const idle = { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'idle', messages: [], turnInProgress: false };
  const running = { ...idle, version: 2, state: 'running' };
  const answered = { ...running, version: 4, messages: [{ role: 'user', content: '보존할 질문' }] };
  env.context.EventSource = class {
    constructor() { source = this; }
    addEventListener(name, callback) { this.receive = callback; }
    close() {}
  };
  env.context.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return url.endsWith('/state') ? get.promise : response(url.endsWith('/start') ? running : answered);
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects();
  env.root.querySelector('[data-action="start"]').click(); await flushEffects();
  const input = env.root.querySelector('textarea');
  input.value = '보존할 질문'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects(); env.root.querySelector('button[type="submit"]').click(); await flushEffects();
  get.resolve(response(idle)); await flushEffects();
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
  assert.equal(env.root.querySelector('.manager-msg-user').textContent, '보존할 질문');
  source.receive({ data: JSON.stringify({ ...idle, version: 1 }) }); await flushEffects();
  assert.ok(env.root.querySelector('.manager-msg-user'));
  source.receive({ data: JSON.stringify({ ...answered, version: 5, messages: [
    ...answered.messages, { role: 'assistant', content: '최신 답변' },
  ] }) }); await flushEffects();
  source.receive({ data: JSON.stringify({ ...idle, version: 5 }) }); await flushEffects();
  assert.equal(env.root.querySelector('.manager-msg-assistant').textContent.trim(), '최신 답변');
  for (const call of calls) assert.match(call.url, /^\/api\/session-hub\/chat\//);
});

for (const success of [true, false]) {
  test(`message completion after newer SSE ${success ? 'clears input once' : 'preserves failed input'}`, async t => {
    const env = setup(t), post = deferred(), calls = [];
    let source;
    const running = { thread_id: 'thread-1', epoch: 'boot', version: 2,
      state: 'running', messages: [], turnInProgress: false };
    const sent = { ...running, version: 3, turnInProgress: true,
      messages: [{ role: 'user', content: '한 번만 보낼 질문' }] };
    const answered = { ...sent, version: 5, turnInProgress: false,
      messages: [...sent.messages, { role: 'assistant', content: '최신 답변' }] };
    env.context.EventSource = class {
      constructor() { source = this; }
      addEventListener(name, callback) { this.receive = callback; }
      close() {}
    };
    env.context.fetch = async (url, opts) => {
      calls.push({ url, opts }); return url.endsWith('/message') ? post.promise : response(running);
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    const input = env.root.querySelector('textarea'), submit = env.root.querySelector('button[type="submit"]');
    const enter = () => input.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
    input.value = '한 번만 보낼 질문';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
    enter(); await flushEffects();
    assert.equal(input.disabled, true);
    source.receive({ data: JSON.stringify(sent) }); await flushEffects();
    source.receive({ data: JSON.stringify(answered) }); await flushEffects();
    post.resolve(success ? response(sent) : response({ error: 'session_hub_failed' }, 503));
    await flushEffects();
    assert.equal(input.disabled, false);
    assert.equal(input.value, success ? '' : '한 번만 보낼 질문');
    assert.equal(env.root.querySelector('.manager-msg-assistant').textContent.trim(), '최신 답변');
    assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
    assert.equal(submit.disabled, success);
    if (success) { enter(); submit.click(); await flushEffects(); }
    else assert.equal(env.root.querySelector('[role="alert"]').textContent,
      '세션 비서 요청을 처리하지 못했습니다. 다시 시도해 주세요.');
    assert.equal(calls.filter(call => call.url.endsWith('/message')).length, 1);
  });
}

for (const replyEpoch of ['old', 'fresh']) {
  test(`${replyEpoch} message reply after restart preserves the question until a fresh resend`, async t => {
    const env = setup(t), post = deferred(), calls = [];
    let source, messages = 0;
    const question = '재시작 뒤 다시 보낼 질문';
    const old = { thread_id: 'thread-1', epoch: 'old', version: 2,
      state: 'running', messages: [], turnInProgress: false };
    const fresh = { ...old, epoch: 'fresh', version: 0, state: 'idle' };
    let serverState = old;
    const notice = '서버가 다시 시작되어 질문이 '
      + '전달되지 않았을 수 있습니다. 다시 보내 주세요.';
    env.context.EventSource = class {
      constructor() { source = this; }
      addEventListener(name, callback) { this.receive = callback; }
      close() {}
    };
    env.context.fetch = async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith('/message')) return ++messages === 1 ? post.promise
        : response({ ...fresh, version: 5, state: 'running', messages: [{ role: 'user', content: question }] });
      return response(url.endsWith('/start') ? { ...fresh, version: 1, state: 'running' } : serverState);
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    const input = env.root.querySelector('textarea'), submit = env.root.querySelector('button[type="submit"]');
    input.value = question; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await flushEffects(); submit.click(); await flushEffects();
    assert.equal(input.disabled, true);
    serverState = fresh;
    source.receive({ data: JSON.stringify(fresh) }); await flushEffects();
    post.resolve(response({ ...old, epoch: replyEpoch, version: 3 })); await flushEffects();
    assert.equal(input.disabled, false);
    assert.equal(input.value, question);
    assert.equal(submit.disabled, false);
    assert.equal(env.root.querySelector('.session-hub-note[role="status"]').textContent, notice);
    assert.equal(env.root.querySelector('[role="alert"]'), null);
    assert.equal(calls.filter(call => call.url.endsWith('/message')).length, 1);
    submit.click(); await flushEffects(); await flushEffects();
    assert.equal(input.value, '');
    assert.equal(input.disabled, false);
    assert.equal(env.root.querySelector('.session-hub-note[role="status"]'), null);
    assert.equal(calls.filter(call => call.url.endsWith('/message')).length, 2);
  });
}

test('a start reply matching the SSE version clears only the local starting indicator', async t => {
  const env = setup(t), start = deferred();
  let source;
  const idle = { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'idle', messages: [], turnInProgress: false };
  const running = { ...idle, version: 1, state: 'running' };
  env.context.EventSource = class {
    constructor() { source = this; }
    addEventListener(name, callback) { this.receive = callback; }
    close() {}
  };
  env.context.fetch = async url => url.endsWith('/start') ? start.promise : response(idle);
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  env.root.querySelector('[data-action="start"]').click(); await flushEffects();
  source.receive({ data: JSON.stringify(running) }); await flushEffects();
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '시작 중');
  start.resolve(response(running)); await flushEffects();
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
});

test('evidence uses sanitized text only; malformed tokens, code and attributes stay literal', t => {
  const env = setup(t);
  const key = 'alpha:claude:session-0';
  const token = `[[session:${key}@${REV}]]`;
  const panel = { rev: NEXT, cards: [{ key, machine: { label: 'Mac' }, title: '<img onerror=alert(3)>' }] };
  const opened = [];
  const text = `${token}\n\n<img src=x onerror="alert(1)" title="${token}">\n\n`
    + `<span data-x="${token}" onclick="alert(2)">safe</span>\n\n`
    + `\`${token}\`\n\n\`\`\`\n${token}\n\`\`\`\n\n[[session:${key}@bad]]\n\n`
    + `[[session:missing@${REV}]]\n\n[[session:a\" onclick=alert(4)@${REV}]]`;
  const rendered = env.context.renderSessionMarkdown(text, panel, (...args) => opened.push(args));
  env.render(env.h('div', {}, rendered), env.root);
  assert.equal(env.root.querySelectorAll('button.session-evidence').length, 1);
  assert.equal(env.root.querySelector('button').textContent.includes('답변 뒤 갱신됨'), true);
  assert.equal(env.root.querySelector('button img'), null);
  assert.equal(env.root.querySelectorAll('[onerror], [onclick], script').length, 0);
  assert.equal(env.root.querySelector('img').getAttribute('title'), token);
  assert.equal(env.root.querySelectorAll('code').length, 2);
  assert.equal(env.root.querySelector('pre').textContent.trim(), token);
  assert.ok(env.root.textContent.includes(`[[session:${key}@bad]]`));
  assert.ok(env.root.textContent.includes('onclick=alert(4)'));
  assert.equal(env.root.querySelector('.session-evidence.missing').textContent, '현재 스냅샷에 없는 세션');
  assert.equal(env.root.querySelector('.session-evidence.missing').tagName, 'SPAN');
  env.root.querySelector('button.session-evidence').click();
  assert.deepEqual(opened, [[key, REV]]);
});

test('session markdown table wrappers preserve table semantics', t => {
  const env = setup(t);
  const text = '```js\nconst value = 1;\n```\n\n| 이름 | 값 |\n| --- | --- |\n| 항목 | 내용 |'
    + '\n\n| 상태 | 수량 |\n| --- | --- |\n| 완료 | 2 |';
  env.render(env.h('div', {}, env.context.renderSessionMarkdown(text)), env.root);
  const pre = env.root.querySelector('pre'), table = env.root.querySelector('table');
  assert.ok(pre); assert.ok(table);
  assert.equal(pre.getAttribute('tabindex'), '0');
  assert.equal(table.hasAttribute('tabindex'), false);
  assert.equal(table.hasAttribute('role'), false);
  const wrapper = table.parentElement;
  assert.ok(wrapper.matches('.session-hub-table-scroll[tabindex="0"]'));
  assert.equal(wrapper.children.length, 1);
  assert.equal(pre.querySelector('code').textContent.trim(), 'const value = 1;');
  assert.equal(table.querySelectorAll('th').length, 2);
  const wrappers = env.root.querySelectorAll('.session-hub-table-scroll');
  assert.equal(wrappers.length, 2);
  for (const node of wrappers) {
    assert.equal(node.getAttribute('tabindex'), '0');
    assert.equal(node.hasAttribute('role'), false);
    assert.equal(node.hasAttribute('aria-label'), false);
  }
});

test('session markdown strips source visibility and focus attributes before wrapping tables', t => {
  const env = setup(t);
  const text = '<div aria-hidden="true"><section ARIA-HIDDEN="false">'
    + '<pre ArIa-HiDdEn="true" TABINDEX="-1"><code>code</code></pre>'
    + '<table tabindex="5" title="data"><tbody><tr><td>cell</td></tr></tbody></table>'
    + '</section></div>';
  env.render(env.h('div', {}, env.context.renderSessionMarkdown(text)), env.root);
  assert.equal(env.root.querySelectorAll('[aria-hidden]').length, 0);
  assert.equal(env.root.querySelectorAll('[tabindex]:not([tabindex="0"])').length, 0);
  assert.equal(env.root.querySelector('pre').getAttribute('tabindex'), '0');
  const table = env.root.querySelector('table');
  assert.equal(table.hasAttribute('tabindex'), false);
  assert.ok(table.parentElement.matches('.session-hub-table-scroll[tabindex="0"]'));
  assert.equal(table.getAttribute('title'), 'data');
  assert.equal(table.querySelector('td').textContent, 'cell');
});

test('session markdown strips source tabindex from links and other elements', t => {
  const env = setup(t);
  const text = '<a tabindex="3" aria-hidden="true" href="https://example.com" title="link">link</a>'
    + '<span TABINDEX="-1">text</span>';
  env.render(env.h('div', {}, env.context.renderSessionMarkdown(text)), env.root);
  assert.equal(env.root.querySelectorAll('[tabindex], [aria-hidden]').length, 0);
  assert.equal(env.root.querySelector('a').getAttribute('href'), 'https://example.com');
  assert.equal(env.root.querySelector('a').getAttribute('title'), 'link');
  assert.equal(env.root.querySelector('span').textContent, 'text');
});

test('session markdown keeps pre focus across rerenders', t => {
  const env = setup(t);
  const render = text => env.render(env.h('div', {}, env.context.renderSessionMarkdown(text)), env.root);
  render('<pre tabindex="-1"><code>first</code></pre>');
  const pre = env.root.querySelector('pre');
  assert.equal(pre.getAttribute('tabindex'), '0');
  render('```\nnext\n```');
  assert.equal(env.root.querySelector('pre'), pre);
  assert.equal(pre.getAttribute('tabindex'), '0');
  render('<pre tabindex="5">third</pre>');
  assert.equal(pre.getAttribute('tabindex'), '0');
  assert.equal(pre.textContent, 'third');
  render('<pre TABINDEX="5">fourth</pre>\n\n<p tabindex="5">unchanged</p>');
  assert.equal(pre.getAttribute('tabindex'), '0');
  assert.equal(env.root.querySelector('p').hasAttribute('tabindex'), false);
});

test('session markdown scrollable HTML keeps sanitization and overrides supplied tabindex', t => {
  const env = setup(t);
  const text = '<pre tabindex="-1" title="code" onfocus="alert(1)"><code>safe code</code></pre>\n\n'
    + '<table tabindex="-1" title="data" onclick="alert(2)" role="table" aria-label="원문 이름">'
    + '<tbody><tr><td>safe cell</td></tr></tbody></table>\n\n'
    + '<div class="session-hub-table-scroll" onclick="alert(3)" onfocus="alert(4)">forged</div>';
  env.render(env.h('div', {}, env.context.renderSessionMarkdown(text)), env.root);
  for (const node of env.root.querySelectorAll('*')) {
    assert.equal(Array.from(node.attributes).some(attr => /^on/i.test(attr.name)), false);
  }
  const pre = env.root.querySelector('pre'), table = env.root.querySelector('table');
  assert.ok(pre); assert.ok(table);
  assert.equal(pre.getAttribute('tabindex'), '0');
  assert.equal(table.hasAttribute('tabindex'), false);
  assert.ok(table.parentElement.matches('.session-hub-table-scroll[tabindex="0"]'));
  assert.equal(table.parentElement.hasAttribute('role'), false);
  assert.equal(table.parentElement.hasAttribute('aria-label'), false);
  assert.equal(pre.getAttribute('title'), 'code');
  assert.equal(table.getAttribute('title'), 'data');
  assert.equal(table.getAttribute('role'), 'table');
  assert.equal(pre.textContent, 'safe code');
  assert.equal(table.querySelector('td').textContent, 'safe cell');
});

test('evidence links become spans without link attributes or nested interactive elements', t => {
  const env = setup(t), key = 'k', token = `[[session:${key}@${REV}]]`, opened = [];
  const panel = { rev: REV, cards: [{ key, machine: { label: 'Mac' }, ai_title: 'Evidence' }] };
  // Keep safe target attributes through sanitization so their removal is tested explicitly.
  env.window.DOMPurify.setConfig({ ADD_ATTR: ['target'] });
  // Escaped brackets keep the evidence token inside a markdown link's text.
  const linkedToken = token.replaceAll('[', '\\[').replaceAll(']', '\\]');
  const texts = [`[보기 ${linkedToken}](https://x "Evidence link")`,
    `<a href="https://x" target="_blank" rel="noopener noreferrer">보기 ${token}</a>`];
  for (const [index, text] of texts.entries()) {
    const sanitized = env.document.createElement('div');
    sanitized.innerHTML = env.context.renderMarkdown(text);
    const original = sanitized.querySelector('a');
    assert.equal(original.getAttribute('href'), 'https://x');
    assert.ok(original.textContent.includes(token));
    if (index === 1) {
      assert.equal(original.getAttribute('target'), '_blank');
      assert.equal(original.getAttribute('rel'), 'noopener noreferrer');
    }
    const rendered = env.context.renderSessionMarkdown(text, panel, (...args) => opened.push(args));
    env.render(env.h('div', {}, rendered), env.root);
    const chip = env.root.querySelector('button.session-evidence'), wrapper = chip.parentElement;
    assert.equal(wrapper.tagName, 'SPAN');
    assert.ok(wrapper.textContent.startsWith('보기 '));
    for (const attr of ['href', 'target', 'rel']) assert.equal(wrapper.hasAttribute(attr), false);
    assert.equal(env.root.querySelector('a'), null);
    assert.equal(env.root.querySelector('a button'), null);
    assert.equal(chip.closest('a'), null);
    chip.click();
    assert.deepEqual(opened.at(-1), [key, REV]);
  }
});

test('all chat actions share one fetch spy and dedicated SSE; new threads keep memory and cleanup notice', async t => {
  const env = setup(t), calls = [], streams = [];
  let snapshot = { thread_id: 'thread-1', epoch: 'boot', version: 0,
    state: 'idle', generation: 0, messages: [], turnInProgress: false };
  class Source {
    constructor(url) { this.url = url; streams.push(this); }
    addEventListener(name, callback) { assert.equal(name, 'snapshot'); this.receive = callback; }
    close() { this.closed = true; }
  }
  env.context.EventSource = Source;
  env.context.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (opts.method === 'POST') snapshot = { ...snapshot, version: snapshot.version + 1 };
    if (url.endsWith('/start')) snapshot = { ...snapshot, state: 'running' };
    if (url.endsWith('/stop')) snapshot = { ...snapshot, state: 'idle' };
    if (url.endsWith('/message')) snapshot = { ...snapshot, messages: [{ role: 'user', content: '모든 세션' }] };
    return response(url.endsWith('/threads') ? { ...snapshot, thread_id: 'thread-2', messages: [],
      transcripts_remaining: 4, memory: { pending_count: 2 } }
      : snapshot);
  };
  env.render(env.h(env.context.SessionHubChat, { panel: { cards: [], rev: REV } }), env.root);
  await flushEffects(); await flushEffects();
  const click = async label => {
    Array.from(env.root.querySelectorAll('button')).find(button => button.textContent.trim() === label).click();
    await flushEffects();
  };
  await click('시작');
  const input = env.root.querySelector('textarea');
  input.value = '모든 세션'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects(); await click('전송');
  await click('중지'); await click('새 대화');
  assert.ok(env.root.querySelector('.session-hub-messages .session-hub-note[role="status"]'));
  assert.ok(env.root.textContent.includes('정리할 기록 파일 4개'));
  assert.ok(!env.root.textContent.includes('서버 재시작 시 대화가 사라집니다'));
  assert.deepEqual(calls.filter(call => call.url.includes('/chat/')).map(call => call.url),
    ['state', 'start', 'message', 'stop', 'threads']
    .map(name => `/api/session-hub/chat/${name}`));
  for (const call of calls) assert.equal(call.opts.credentials, 'same-origin');
  assert.equal(JSON.parse(calls[2].opts.body).text, '모든 세션');
  assert.equal(streams[0].url, '/api/session-hub/chat/stream');
  const streamed = { ...snapshot, version: snapshot.version + 1, messages: [
    { role: 'assistant', content: '스트림 답' },
  ] };
  streams[0].receive({ data: JSON.stringify(streamed) });
  await flushEffects(); assert.ok(env.root.textContent.includes('스트림 답'));
  env.render(null, env.root); assert.equal(streams[0].closed, true);
  assert.equal(calls[0].opts.signal.aborted, true);
});

test('panel confirms rev despite failed machine, opens timeline and copies exact exclusion selector', async t => {
  const env = setup(t), { alpha } = fixture(t), updates = [], copied = [];
  env.context.fetch = async url => response(url.endsWith('/snapshots') ? {
    rev: REV, snapshots: [{ machine_id: 'alpha', machine_label: 'Mac', sha256: 'a'.repeat(64) },
      { name_id: 'bad', error_code: 'parse_error' }],
  } : alpha);
  Object.defineProperty(env.window.navigator, 'clipboard', { value: { writeText: async text => copied.push(text) } });
  env.render(env.h(env.context.AllSessionsPanel, { onData: data => updates.push(data) }), env.root);
  await flushEffects(); await flushEffects();
  assert.equal(updates.at(-1).rev, REV); assert.equal(updates.at(-1).cards.length, 2);
  assert.ok(env.root.textContent.includes('읽지 못한 스냅샷'));
  env.root.querySelector('button.session-row').click(); await flushEffects();
  assert.equal(env.root.querySelectorAll('.work-card').length, 1);
  assert.equal(env.document.activeElement.textContent, '← 모든 세션');
  env.root.querySelector('.work-event:last-child button').click(); await flushEffects();
  assert.deepEqual(copied, [`${alpha.instructions[1].id}#${alpha.instructions[1].ref}`]);
  Array.from(env.root.querySelectorAll('button')).find(button => button.textContent === '← 모든 세션').click();
  await flushEffects(); assert.equal(env.root.querySelectorAll('.work-card').length, 2);
  assert.equal(env.document.activeElement.dataset.sessionKey, alpha.sessions[0].key);
});

test('409 retries the list and discards old details; retry exhaustion surfaces error', async t => {
  const env = setup(t), { alpha } = fixture(t), stale = deferred(), calls = [], updates = [];
  let lists = 0, oldSignal;
  const request = async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/snapshots')) {
      lists++;
      return { rev: lists === 1 ? REV : NEXT, snapshots: lists === 1
        ? [{ machine_id: 'alpha', sha256: 'a' }, { machine_id: 'beta', sha256: 'b' }]
        : [{ machine_id: 'alpha', sha256: 'c' }] };
    }
    if (url.includes('beta')) { oldSignal = opts.signal; return stale.promise; }
    if (lists === 1) throw Object.assign(new Error('snapshot_changed'), { status: 409 });
    return alpha;
  };
  const loading = env.context.loadSessionSnapshots(request, new AbortController().signal, data => updates.push(data));
  await flushEffects(20); assert.equal(oldSignal.aborted, true);
  stale.resolve({ ...alpha, machine: { id: 'beta', label: 'stale' } }); await loading;
  assert.equal(lists, 2); assert.equal(updates.at(-1).rev, NEXT);
  assert.equal(updates.at(-1).snapshots.length, 1);
  assert.ok(calls.includes('/api/observe/snapshots/alpha?sha256=c'));
  let retries = 0;
  await assert.rejects(env.context.loadSessionSnapshots(async url => {
    if (url.endsWith('/snapshots')) {
      retries++; return { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'x' }] };
    }
    throw Object.assign(new Error('snapshot_changed'), { status: 409 });
  }, new AbortController().signal, () => {}), /snapshot_changed/);
  assert.equal(retries, 4);
});

test('panel reload aborts prior generation and ignores a delayed response', async t => {
  const env = setup(t), { alpha } = fixture(t), pending = deferred(), seen = [];
  let signal;
  env.context.apiFetch = async (url, opts) => {
    if (url.endsWith('/snapshots')) return { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] };
    signal = opts.signal; return pending.promise;
  };
  env.render(env.h(env.context.AllSessionsPanel, { onData: data => seen.push(data) }), env.root);
  await flushEffects();
  env.render(null, env.root); assert.equal(signal.aborted, true);
  env.context.apiFetch = async url => url.endsWith('/snapshots')
    ? { rev: NEXT, snapshots: [] } : alpha;
  env.render(env.h(env.context.AllSessionsPanel, { onData: data => seen.push(data) }), env.root);
  await flushEffects(); pending.resolve(alpha); await flushEffects();
  assert.equal(seen.at(-1).rev, NEXT); assert.equal(seen.at(-1).cards.length, 0);
});

test('inactive ManagerView preserves original DOM; active defaults to assistant and chip selects panel', async t => {
  const env = setup(t), { alpha } = fixture(t);
  env.context.ManagerChat = props => env.h('div',
    { class: 'manager-chat-side', 'data-target': props.conversationTarget });
  env.context.SessionGrid = () => env.h('div', { class: 'manager-grid-side' });
  env.context.managerProfileAuthState = () => 'ok';
  env.context.operatorConversationId = id => `operator:${id}`;
  env.context.apiFetch = async url => url.includes('/chat/')
    ? { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'running', messages: [
      { role: 'assistant', content: `[[session:${alpha.sessions[0].key}@${NEXT}]]` },
    ] }
    : url.endsWith('/snapshots') ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] } : alpha;
  env.context.EventSource = class { addEventListener() {} close() {} };
  const current = fs.readFileSync(path.join(publicRoot, 'app/components/ManagerView.js'), 'utf8');
  const transform = source => transformComponentSource(source).replace(/^export\s+\{[^}]+\};?\s*$/gm, '');
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/manager-view-pre-hub.js'), 'utf8');
  vm.runInContext(transform(original) + '\nthis.OldManagerView = ManagerView;', env.context);
  const props = { manager: { status: {} }, projects: [], runs: [], tasks: [], nodeSummary: {} };
  env.render(env.h(env.context.OldManagerView, props), env.root); await flushEffects();
  const before = env.root.innerHTML;
  env.render(null, env.root);
  vm.runInContext(transform(current) + '\nthis.ManagerView = ManagerView;', env.context);
  env.render(env.h(env.context.ManagerView, { ...props, sessionHubActive: false }), env.root);
  await flushEffects(); assert.equal(env.root.innerHTML, before);
  env.render(env.h(env.context.ManagerView, { ...props, sessionHubActive: true }), env.root);
  await flushEffects(); await flushEffects();
  assert.ok(env.root.querySelector('.session-hub-chat'));
  assert.equal(env.root.querySelectorAll('.session-hub-segments button').length, 3);
  assert.ok(env.root.querySelector('.session-hub-sidebar-header').textContent.includes('답변 뒤 갱신됨'));
  env.root.querySelector('button.session-evidence').click(); await flushEffects();
  assert.equal(env.root.querySelector('.manager-view').dataset.pane, 'right');
  assert.equal(env.root.querySelectorAll('.work-event').length, 2);
  Array.from(env.root.querySelectorAll('button')).find(button => button.textContent === '작업').click();
  await flushEffects(); assert.ok(env.root.querySelector('.manager-grid-side'));
});

test('legacy #work hash redirects to manager all-sessions tab', t => {
  const env = setup(t);
  const source = fs.readFileSync(path.join(publicRoot, 'app/lib/hooks/routing.js'), 'utf8');
  vm.runInContext(transformComponentSource(source), env.context);
  env.window.location.hash = 'work';
  env.render(env.h(() => env.h('span', {}, env.context.useRoute(true))), env.root);
  assert.equal(env.window.location.hash, '#manager/all-sessions');
  assert.equal(env.root.textContent, 'manager/all-sessions');
});

test('boot health feeds active flag to manager and the legacy route feeds panel selection', async t => {
  const env = setup(t), calls = [];
  env.context.apiFetch = async (url, opts) => {
    calls.push({ url, opts });
    return url === '/api/health' ? { sessionHubActive: true } : { snapshots: [] };
  };
  const source = fs.readFileSync(path.join(publicRoot, 'app/lib/hooks/observe.js'), 'utf8');
  vm.runInContext(transformComponentSource(source), env.context);
  env.window.location.hash = 'manager';
  env.render(env.h(() => {
    const entry = env.context.useObserveEntry();
    return env.h('span', {}, String(entry.sessionHubActive));
  }), env.root);
  await flushEffects(); await flushEffects();
  assert.equal(env.root.textContent, 'true');
  assert.equal(calls.filter(call => call.url === '/api/health').length, 1);
  const app = fs.readFileSync(path.join(publicRoot, 'app.js'), 'utf8');
  assert.match(app, /sessionHubActive=\$\{observe.sessionHubActive\}/);
  assert.match(app, /initialPanel=\$\{routeParts\[1\] === 'all-sessions' \? 'all'/);
  env.render(null, env.root);
  for (const call of calls) assert.equal(call.opts.signal.aborted, true);
});

test('readable labels skip URL lines, follow AI/first/recent priority and cap evidence at 24 characters', t => {
  const env = setup(t), make = changes => ({ key: 'alpha:claude:abcdef', machine: { label: 'Mac' }, ...changes });
  const titled = make({ ai_title: 'AI 제목', first: '처음', recent: '최근' });
  assert.equal(env.context.sessionDisplayTitle(titled), 'AI 제목');
  assert.equal(env.context.sessionDisplayTitle(make({ ai_title: 'https://example.com', first: '처음' })), '처음');
  assert.equal(env.context.sessionDisplayTitle(make({ first: 'https://example.com', recent: '최근' })), '최근');
  assert.equal(env.context.sessionDisplayTitle(make({ ai_title: 'https://example.com\n제목' })), '제목');
  assert.equal(env.context.sessionDisplayTitle(make({ first: 'https://example.com', recent: 'https://x.test' })),
    '세션 abcdef');
  assert.equal(env.context.sessionEvidenceLabel(make({ ai_title: '가'.repeat(30) })), `Mac · ${'가'.repeat(24)}`);
});

test('chat shares Top bubbles, groups tool calls without JSON, maps errors and honors Enter/IME', async t => {
  const env = setup(t), calls = [], key = 'alpha:claude:abcdef';
  const card = { key, machine: { id: 'alpha', label: 'Mac' }, ai_title: '인증 검토' };
  const snapshot = { thread_id: 'thread-1', epoch: 'boot', version: 0,
    state: 'running', turnInProgress: false, messages: [
    { id: 'u', seq: 1, turn_id: 't1', role: 'user', content: '리뷰해', request_id: 'r1' },
    { id: 'a', seq: 2, turn_id: 't1', role: 'assistant', content: '## 검토 결과\n\n- 응답 끝남' },
    { id: 'n1', seq: 3, turn_id: 't1', role: 'tool_note', content: '검색: 리뷰해 (다음 페이지)' },
    { id: 'n2', seq: 4, turn_id: 't1', role: 'tool_note', content: '세션 목록 조회 · Mac · codex' },
    { id: 'n3', seq: 5, turn_id: 't1', role: 'tool_note', content: '세션 열기: Mac · 인증 검토' },
    { id: 'err', seq: 6, role: 'system_note', status: 'error', content: 'session_hub_socket_path_too_long' },
  ] };
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async (url, opts) => { calls.push({ url, opts }); return response(snapshot); };
  env.render(env.h(env.context.SessionHubChat, { panel: { rev: REV, cards: [card] } }), env.root);
  await flushEffects(); await flushEffects();
  assert.equal(env.root.querySelector('.manager-msg-row-user .manager-msg-user .manager-msg-content').textContent,
    '리뷰해');
  assert.ok(env.root.querySelector('.manager-msg-assistant .markdown-body h2'));
  assert.ok(env.root.querySelector('.manager-msg-assistant .markdown-body ul li'));
  assert.equal(env.root.querySelectorAll('.session-hub-tools').length, 1);
  assert.equal(env.root.querySelectorAll('.session-hub-tools li').length, 3);
  const tools = env.root.querySelector('.session-hub-tools');
  assert.equal(tools.open, false); assert.equal(tools.querySelector('summary').textContent, '도구 3회 사용 ▸');
  assert.ok(tools.compareDocumentPosition(env.root.querySelector('.manager-msg-assistant'))
    & env.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(env.root.textContent.includes('검색: 리뷰해 (다음 페이지)'));
  assert.ok(env.root.textContent.includes('세션 목록 조회 · Mac · codex'));
  assert.ok(env.root.textContent.includes('세션 열기: Mac · 인증 검토'));
  assert.ok(!env.root.textContent.includes('SECRET'));
  assert.ok(!env.root.textContent.includes('session_hub_socket_path_too_long'));
  assert.ok(env.root.querySelector('.manager-status-badge.idle'));
  assert.equal(env.context.sessionHubErrorText('ENOENT'), '세션 비서를 시작하지 못했습니다(ENOENT).');
  const input = env.root.querySelector('textarea');
  input.value = '질문'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects();
  const keydown = options => input.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true, ...options,
  }));
  keydown({ shiftKey: true }); keydown({ isComposing: true }); keydown({ keyCode: 229 });
  input.dispatchEvent(new env.window.CompositionEvent('compositionstart', { bubbles: true }));
  keydown({}); assert.equal(calls.length, 1);
  input.dispatchEvent(new env.window.CompositionEvent('compositionend', { bubbles: true }));
  assert.equal(keydown({}), false);
  await flushEffects(); assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/session-hub/chat/message');
});

test('compact panel rows have three lines, searchable content and visibly named filters', async t => {
  const env = setup(t), { alpha } = fixture(t);
  env.context.apiFetch = async url => url.endsWith('/snapshots') ? { rev: REV, snapshots: [
    { machine_id: 'alpha', machine_label: 'Mac', sha256: 'a' },
  ] } : alpha;
  env.render(env.h(env.context.AllSessionsPanel), env.root); await flushEffects(); await flushEffects();
  const row = env.root.querySelector('button.session-row');
  assert.equal(row.children.length, 3);
  assert.equal(row.querySelector('.work-title').textContent, '합성 세션 검토');
  assert.ok(row.querySelector('.work-meta').textContent.includes('Mac · '));
  assert.equal(row.querySelectorAll('.work-label, .work-card-footer, button, .work-first-block').length, 0);
  assert.equal(env.root.querySelectorAll('.work-snapshot-times .work-pill').length, 0);
  assert.ok(env.root.querySelector('.work-snapshot-times').textContent.includes('상태는 스냅샷 시점 관측'));
  assert.deepEqual(Array.from(env.root.querySelectorAll('.dropdown-label'), node => node.textContent.trim()),
    ['머신: 전체', '도구: 전체']);
  const input = env.root.querySelector('#work-query');
  input.value = '로그인리다'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects(); assert.equal(env.root.querySelectorAll('button.session-row').length, 1);
  env.root.querySelector('button.session-row').click(); await flushEffects();
  assert.equal(env.root.querySelectorAll('button.session-row').length, 0);
  assert.ok(env.root.querySelector('.work-card-footer'));
  assert.equal(env.root.querySelectorAll('.work-event').length, 2);
});

test('idle questions start once before sending; start failures retain the question and never send', async t => {
  const env = setup(t), calls = [], starting = deferred();
  const idle = { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'idle', messages: [], turnInProgress: false };
  const running = { ...idle, version: 1, state: 'running' };
  env.context.EventSource = class { addEventListener() {} close() {} };
  let failStart = false;
  env.context.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/start')) return failStart
      ? response({ error: 'session_hub_binary_unavailable' }, 503) : starting.promise;
    if (url.endsWith('/message')) return response({ ...running, version: 2, messages: [
      { role: 'user', content: JSON.parse(opts.body).text },
    ] });
    return response(idle);
  };
  const mount = async () => {
    env.render(env.h(env.context.SessionHubChat, { panel: { cards: [], rev: REV } }), env.root);
    await flushEffects(); await flushEffects();
  };
  const ask = async text => {
    const input = env.root.querySelector('textarea');
    input.value = text;
    input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await flushEffects();
    assert.equal(env.root.querySelector('button[type="submit"]').disabled, false);
    const enter = () => input.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
    enter(); enter();
    await flushEffects();
  };
  await mount(); await ask('모든 세션 알려줘');
  assert.deepEqual(calls.filter(call => call.url.includes('/chat/')).map(call => call.url),
    ['state', 'start'].map(name => `/api/session-hub/chat/${name}`));
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '시작 중');
  assert.equal(env.root.querySelector('button[type="submit"]').disabled, true);
  starting.resolve(response(running)); await flushEffects(); await flushEffects();
  assert.equal(calls.at(-1).url, '/api/session-hub/chat/message');
  assert.equal(JSON.parse(calls.at(-1).opts.body).text, '모든 세션 알려줘');
  assert.equal(env.root.querySelector('textarea').value, '');
  assert.equal(env.root.querySelector('.manager-msg-user').textContent, '모든 세션 알려줘');
  assert.equal(calls.filter(call => call.url.endsWith('/start')).length, 1);
  env.render(null, env.root); failStart = true;
  await mount(); await ask('시작 실패 질문'); await flushEffects();
  assert.equal(calls.filter(call => call.url.endsWith('/message')).length, 1);
  assert.equal(env.root.querySelector('textarea').value, '시작 실패 질문');
  assert.equal(env.root.querySelector('[role="alert"]').textContent, 'Claude 실행 파일을 찾지 못했습니다.');
  for (const call of calls) assert.match(call.url, /^\/api\/session-hub\/chat\//);
});

test('sidebar rows use status evidence, exact metadata spacing and two lines', t => {
  const env = setup(t), { alpha } = fixture(t);
  const card = env.context.snapshotCards(alpha)[0];
  const now = Date.parse(card.last_record_at) + 2 * 3600000;
  const props = { card, now, query: '', compact: true, onOpen: () => {} };
  card.machine.label = 'codev2'; card.repo_label = 'c2'; card.agent = { state: 'running' };
  card.status = { state: 'ended', source: 'transcript', evidence_at: card.last_record_at, reason: 'conflict' };
  env.render(env.h(env.context.SessionRow, props), env.root);
  assert.equal(env.root.querySelector('.work-meta').textContent, 'codev2 · c2 · 2시간 전');
  assert.equal(env.root.querySelector('.session-row').children.length, 2);
  assert.equal(env.root.querySelector('.session-status-dot').title, '응답 끝남');
  card.status.state = 'unknown';
  env.render(env.h(env.context.SessionRow, { ...props }), env.root);
  assert.equal(env.root.querySelector('.session-status-dot').title, '알 수 없음');
  assert.equal(env.root.querySelector('.work-orca'), null);
  env.render(env.h(env.context.SessionHubDetail, { data: { cards: [card], load: { rev: REV }, now },
    selection: { key: card.key, rev: REV } }), env.root);
  assert.ok(env.root.textContent.includes('기록'));
  assert.ok(env.root.textContent.includes('상태 충돌'));
  assert.ok(env.root.textContent.includes('알 수 없음'));
});

test('automatic start never sends after a cancelled start or after the chat unmounts', async t => {
  const env = setup(t), calls = [];
  const idle = { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'idle', messages: [], turnInProgress: false };
  env.context.EventSource = class { addEventListener() {} close() {} };
  let pendingStart = deferred();
  env.context.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return url.endsWith('/start') ? pendingStart.promise : response(idle);
  };
  const ask = async () => {
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    const input = env.root.querySelector('textarea');
    input.value = '보관할 질문'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await flushEffects(); env.root.querySelector('form').dispatchEvent(new env.window.Event('submit', {
      bubbles: true, cancelable: true,
    }));
    await flushEffects();
  };
  await ask(); pendingStart.resolve(response({ ...idle, version: 2 })); await flushEffects();
  assert.equal(env.root.querySelector('textarea').value, '보관할 질문');
  assert.equal(env.root.querySelector('[role="alert"]').textContent, '세션 비서를 먼저 시작해 주세요.');
  env.render(null, env.root); pendingStart = deferred(); await ask();
  const signal = calls.at(-1).opts.signal;
  env.render(null, env.root); assert.equal(signal.aborted, true);
  pendingStart.resolve(response({ ...idle, state: 'running' })); await flushEffects();
  assert.equal(calls.filter(call => call.url.endsWith('/start')).length, 2);
  assert.equal(calls.filter(call => call.url.endsWith('/message')).length, 0);
});

test('panel flex children can shrink, snapshot text wraps and timeline controls use compact type', async t => {
  const env = setup(t), { alpha } = fixture(t);
  const css = fs.readFileSync(path.join(publicRoot, 'styles.css'), 'utf8');
  const style = env.document.createElement('style');
  style.textContent = css.slice(css.indexOf('/* Session snapshot board'));
  env.document.head.append(style);
  env.context.apiFetch = async url => url.endsWith('/snapshots') ? { rev: REV, snapshots: [
    { machine_id: 'alpha', machine_label: 'Mac', sha256: 'a' },
  ] } : alpha;
  env.render(env.h('div', { class: 'session-hub-manager' }, env.h('div', { class: 'session-hub-panel-content' },
    env.h(env.context.AllSessionsPanel))), env.root);
  await flushEffects(); await flushEffects();
  const computed = selector => env.window.getComputedStyle(env.root.querySelector(selector));
  for (const selector of ['.session-hub-manager', '.session-hub-panel-content', '.all-sessions-panel',
    '.work-header', '.work-body', '.work-grid', '.session-row', '.session-row .work-title',
    '.session-row .work-meta', '.session-row .work-recent']) {
    assert.equal(parseFloat(computed(selector).minWidth), 0, selector);
  }
  for (const selector of ['.session-row .work-title', '.session-row .work-meta', '.session-row .work-recent']) {
    assert.equal(computed(selector).overflow, 'hidden');
    assert.equal(computed(selector).textOverflow, 'ellipsis');
    assert.equal(computed(selector).whiteSpace, 'nowrap');
  }
  assert.equal(computed('.work-snapshot-times').whiteSpace, 'normal');
  assert.equal(computed('.work-snapshot-times').flexWrap, 'wrap');
  assert.equal(computed('.work-search').boxSizing, 'border-box');
  env.root.querySelector('button.session-row').click(); await flushEffects();
  assert.equal(computed('.work-instruction').fontSize, '13px');
  assert.equal(computed('.work-event button').fontSize, '12px');
  assert.equal(computed('.work-event button').height, '24px');
  assert.equal(computed('.work-event button').minHeight, '24px');
});

test('failed sends retry the same thread and request ID; new conversation binds the next send', async t => {
  const env = setup(t), calls = [];
  let failed = true;
  let snapshot = { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'idle',
    messages: [], turnInProgress: false };
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.match(url, /^\/api\/session-hub\/chat\//);
    if (url.endsWith('/start')) snapshot = { ...snapshot, version: snapshot.version + 1, state: 'running' };
    if (url.endsWith('/threads')) snapshot = { ...snapshot, version: snapshot.version + 1,
      state: 'idle', thread_id: 'thread-2', messages: [] };
    if (url.endsWith('/message') && failed) { failed = false; throw new Error('network'); }
    if (url.endsWith('/message')) snapshot = { ...snapshot, version: snapshot.version + 1 };
    return response(snapshot);
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  const ask = async text => {
    const input = env.root.querySelector('textarea');
    input.value = text; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await flushEffects(); env.root.querySelector('button[type="submit"]').click(); await flushEffects();
  };
  await ask('질문');
  assert.equal(env.root.querySelector('textarea').value, '질문');
  await ask('질문');
  const sent = calls.filter(call => call.url.endsWith('/message')).map(call => JSON.parse(call.options.body));
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].thread_id, 'thread-1');
  assert.match(sent[0].request_id, /^[a-z0-9-]{36}$/i);
  assert.deepEqual(calls.slice(0, 3).map(call => call.url.split('/').at(-1)), ['state', 'start', 'message']);
  Array.from(env.root.querySelectorAll('button')).find(node => node.textContent === '새 대화').click();
  await flushEffects(); await ask('다음 질문');
  const next = JSON.parse(calls.at(-1).options.body);
  assert.equal(next.thread_id, 'thread-2'); assert.notEqual(next.request_id, sent[0].request_id);
  assert.equal(env.root.querySelector('textarea').value, '');
  assert.ok(!calls.some(call => /router|conversations|clear/.test(call.url)));
});

test('scroll pages and full messages stay bound to the active thread and render sanitized evidence', async t => {
  const env = setup(t), calls = [], delayed = deferred();
  let source;
  const key = 'alpha:claude:session-0';
  const snapshot = { thread_id: 'thread-1', epoch: 'boot', version: 0, state: 'running',
    messages: [{ id: 'a', seq: 12, turn_id: 't1', role: 'assistant', status: 'complete',
      content: '잘린 답변', truncated: true }], turnInProgress: false };
  env.context.EventSource = class {
    constructor() { source = this; } addEventListener(name, callback) { this.receive = callback; } close() {}
  };
  env.context.fetch = async (url, options) => {
    calls.push({ url, options }); assert.match(url, /^\/api\/session-hub\/chat\//);
    if (url.endsWith('/messages/a')) return response({ ...snapshot.messages[0],
      content: `전체 답변 [[session:${key}@${REV}]] <img onerror="alert(1)">` });
    if (url.includes('?before=12')) return response({ thread_id: 'thread-1', messages: [
      { id: 'u', seq: 11, role: 'user', content: '이전 질문' },
    ] });
    if (url.includes('?before=11')) return delayed.promise;
    return response(snapshot);
  };
  env.render(env.h(env.context.SessionHubChat, { panel: { rev: REV, cards: [
    { key, machine: { label: 'Mac' }, ai_title: '인증 검토' },
  ] } }), env.root); await flushEffects(); await flushEffects();
  Array.from(env.root.querySelectorAll('button')).find(node => node.textContent === '전체 보기').click();
  await flushEffects(); assert.ok(env.root.querySelector('.session-evidence'));
  assert.equal(env.root.querySelectorAll('[onerror]').length, 0);
  const log = env.root.querySelector('[role="log"]');
  log.dispatchEvent(new env.window.Event('scroll')); await flushEffects();
  assert.ok(env.root.textContent.includes('이전 질문'));
  assert.ok(calls.some(call => call.url.endsWith('/messages?before=12&limit=50')));
  log.dispatchEvent(new env.window.Event('scroll')); await flushEffects();
  source.receive({ data: JSON.stringify({ ...snapshot, version: 1, thread_id: 'thread-2', messages: [] }) });
  await flushEffects();
  delayed.resolve(response({ messages: [{ id: 'old', seq: 10, role: 'user', content: '늦은 이전 질문' }] }));
  await flushEffects(); assert.ok(!env.root.textContent.includes('이전 질문'));
  assert.ok(!calls.some(call => /router|conversations/.test(call.url)));
});

test('right pane starts closed and every selection opens it without remounting the assistant', async t => {
  const env = setup(t), { alpha } = fixture(t), streams = [], calls = [];
  const style = env.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(publicRoot, 'styles.css'), 'utf8');
  env.document.head.append(style);
  env.context.EventSource = class {
    constructor() { streams.push(this); } addEventListener() {} close() { this.closed = true; }
  };
  env.context.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.match(url, /^\/api\/(session-hub|observe)\//);
    return response(url.endsWith('/chat/state') ? { thread_id: 'current', epoch: 'boot', version: 1,
      state: 'running', turnInProgress: true, messages: [{ id: 'a', seq: 1, role: 'assistant',
        status: 'partial', content: `답변 중 [[session:${alpha.sessions[0].key}@${REV}]]` }] }
      : url.endsWith('/snapshots/status') ? { enabled: true, targets: [] }
        : url === '/api/observe/snapshots' ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] }
          : alpha);
  };
  env.context.ManagerChat = props => env.h('div', { class: 'manager-chat-side',
    'data-target': props.conversationTarget });
  env.context.SessionGrid = () => env.h('div', { class: 'manager-grid-side' });
  env.context.managerProfileAuthState = () => 'ok';
  const source = fs.readFileSync(path.join(publicRoot, 'app/components/ManagerView.js'), 'utf8');
  vm.runInContext(transformComponentSource(source).replace(/^export\s+\{[^}]+\};?\s*$/gm, ''), env.context);
  env.render(env.h(env.context.ManagerView, { manager: { status: {} }, projects: [], runs: [], tasks: [],
    nodeSummary: {}, sessionHubActive: true }), env.root); await flushEffects(); await flushEffects();
  const manager = env.root.querySelector('.session-hub-manager');
  const panel = manager.querySelector('.session-hub-panel-side'), chat = manager.querySelector('.session-hub-chat');
  const input = chat.querySelector('textarea');
  input.value = '작성 중인 질문'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects();
  const assertClosed = () => {
    assert.equal(manager.dataset.right, 'closed'); assert.equal(panel.hidden, true);
    assert.equal(env.window.getComputedStyle(panel).display, 'none');
    assert.equal(manager.querySelector('.session-hub-segments button:last-child').disabled, true);
    assert.ok(!panel.textContent.includes('세션을 선택하세요.'));
  };
  const choices = [
    ['.session-row', 'session', '.session-hub-detail'],
    ['.session-evidence', 'session', '.session-hub-detail'],
    ['Top', 'manager', '[data-target="top"]'],
    ['작업', 'work', '.manager-grid-side'],
  ];
  for (const width of [1440, 1100, 390]) {
    env.window.innerWidth = width; env.window.dispatchEvent(new env.window.Event('resize'));
    assertClosed();
    for (const [selector, right, content] of choices) {
      const node = selector.startsWith('.') ? manager.querySelector(selector)
        : Array.from(manager.querySelectorAll('.session-hub-nav')).find(item => item.textContent === selector);
      node.click(); await flushEffects();
      assert.equal(manager.dataset.right, right); assert.equal(panel.hidden, false);
      assert.equal(env.window.getComputedStyle(panel).display, 'flex'); assert.ok(panel.querySelector(content));
      assert.equal(manager.querySelector('.session-hub-segments button:last-child').disabled, false);
      manager.querySelector('[aria-label="오른쪽 칸 닫기"]').click(); await flushEffects();
      assertClosed(); assert.equal(manager.dataset.pane, 'chat');
      assert.equal(manager.querySelector('.session-hub-chat'), chat);
      assert.equal(chat.querySelector('textarea'), input); assert.equal(input.value, '작성 중인 질문');
      assert.equal(env.document.activeElement, input);
      assert.ok(chat.querySelector('.manager-status-badge').textContent.includes('답변 중'));
    }
  }
  assert.equal(streams.length, 1); assert.ok(!streams[0].closed);
  assert.ok(!calls.some(call => /router|conversations/.test(call.url)));
});

test('three panes, grouping preferences and Palantir details preserve assistant DOM and SSE', async t => {
  const env = setup(t), { alpha, beta } = fixture(t), streams = [], calls = [];
  alpha.sessions[0].status = { state: 'working', source: 'orca', evidence_at: alpha.generated_at, reason: null };
  alpha.sessions[1].status = { state: 'waiting', source: 'transcript', evidence_at: alpha.generated_at,
    reason: 'conflict' };
  beta.sessions[0].status = { state: 'ended', source: 'transcript', evidence_at: beta.generated_at, reason: null };
  env.context.EventSource = class {
    constructor() { streams.push(this); } addEventListener() {} close() { this.closed = true; }
  };
  env.context.fetch = async (url, options) => {
    calls.push({ url, options });
    return response(url.endsWith('/chat/state') ? { thread_id: 'thread-1', epoch: 'boot', version: 0,
      state: 'running', messages: [], turnInProgress: false }
      : url.endsWith('/snapshots/status') ? { enabled: true, targets: [] }
        : url === '/api/observe/snapshots' ? { rev: REV, snapshots: [
          { machine_id: 'alpha', machine_label: 'Mac', sha256: 'a' },
          { machine_id: 'beta', machine_label: 'codev2', sha256: 'b' },
        ] } : url.includes('/alpha') ? alpha : beta);
  };
  env.context.ManagerChat = props => env.h('div', { class: 'manager-chat-side',
     'data-target': props.conversationTarget });
  env.context.SessionGrid = props => env.h('button', { class: 'manager-grid-side',
    onClick: () => props.onSelectConversation('top') }, 'grid');
  env.context.managerProfileAuthState = () => 'ok';
  const src = fs.readFileSync(path.join(publicRoot, 'app/components/ManagerView.js'), 'utf8');
  vm.runInContext(transformComponentSource(src).replace(/^export\s+\{[^}]+\};?\s*$/gm, ''), env.context);
  const props = { manager: { status: {} }, projects: [{ id: 'p', name: 'Project', pm_enabled: 1 }],
    runs: [], tasks: [], nodeSummary: {}, sessionHubActive: true };
  env.render(env.h(env.context.ManagerView, props), env.root); await flushEffects(); await flushEffects();
  const chat = env.root.querySelector('.session-hub-chat'), input = chat.querySelector('textarea');
  input.value = '계속 쓰는 질문'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects();
  assert.deepEqual(Array.from(env.root.querySelectorAll('.session-hub-group h2'), node => node.textContent.trim()),
    ['입력 대기 1', '작업 중 1', '응답 끝남 1']);
  const rows = () => Array.from(env.root.querySelectorAll('.session-hub-sidebar .session-row'));
  assert.deepEqual(rows().map(row => row.dataset.sessionKey),
    [alpha.sessions[1].key, alpha.sessions[0].key, beta.sessions[0].key]);
  rows()[0].click(); await flushEffects();
  assert.ok(env.root.querySelector('.session-hub-detail').textContent.includes('상태 충돌'));
  Array.from(env.root.querySelectorAll('button')).find(node => node.textContent === '비서에게 묻기').click();
  await flushEffects(); assert.ok(input.value.includes(`[[session:${alpha.sessions[1].key}@${REV}]]`));
  assert.equal(env.document.activeElement, input);
  const nav = label => Array.from(env.root.querySelectorAll('.session-hub-nav'))
    .find(node => node.textContent === label);
  for (const [label, target] of [['Top', 'top'], ['Operator · Project', 'operator:p']]) {
    nav(label).click(); await flushEffects();
    assert.equal(env.root.querySelector('.session-hub-panel-side [data-target]').dataset.target, target);
  }
  nav('작업').click(); await flushEffects();
  env.root.querySelector('.manager-grid-side').click(); await flushEffects();
  assert.equal(env.root.querySelector('.session-hub-panel-side [data-target]').dataset.target, 'top');
  for (const width of [1400, 1100, 800]) {
    env.window.innerWidth = width; env.window.dispatchEvent(new env.window.Event('resize'));
    for (const segment of env.root.querySelectorAll('.session-hub-segments button')) {
      segment.click(); await flushEffects(); assert.equal(env.root.querySelector('.session-hub-chat'), chat);
    }
  }
  assert.equal(streams.length, 1); assert.ok(!streams[0].closed);
  const grouping = env.root.querySelector('[aria-label="묶음 선택, 상태별"]');
  grouping.click(); await flushEffects();
  Array.from(env.root.querySelectorAll('[role="option"]')).find(node => node.textContent === '머신·repo').click();
  await flushEffects(); assert.equal(env.window.localStorage.getItem('session-hub-grouping'), 'repo');
  assert.equal(env.root.querySelectorAll('.session-hub-group h2').length, 3);
  const choose = async (label, option) => {
    env.root.querySelector(`[aria-label="${label}"]`).click(); await flushEffects();
    Array.from(env.root.querySelectorAll('[role="option"]')).find(node => node.textContent === option).click();
    await flushEffects();
  };
  await choose('머신, 머신', 'codev2');
  assert.equal(rows().length, 1); assert.equal(rows()[0].dataset.sessionKey, beta.sessions[0].key);
  await choose('머신, codev2', '머신');
  await choose('도구, 도구', 'Codex');
  assert.equal(rows().length, 1); assert.equal(rows()[0].dataset.sessionKey, beta.sessions[0].key);
  await choose('도구, Codex', '도구');
  env.root.querySelector('button.session-hub-group-title').click(); await flushEffects();
  assert.equal(env.root.querySelector('button.session-hub-group-title').getAttribute('aria-expanded'), 'false');
  assert.equal(env.window.localStorage.getItem('session-hub-palantir'), 'closed');
  const search = env.root.querySelector('#hub-query');
  search.value = '로그인리다'; search.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects(); assert.equal(rows().length, 1);
  nav('★ 비서').click(); await flushEffects(); assert.equal(env.document.activeElement, input);
  env.render(null, env.root); assert.ok(streams[0].closed);
  env.render(env.h(env.context.ManagerView, props), env.root); await flushEffects(); await flushEffects();
  assert.equal(env.root.querySelector('[aria-label="묶음 선택, 머신·repo"]').dataset.value, 'repo');
  assert.equal(env.root.querySelector('button.session-hub-group-title').getAttribute('aria-expanded'), 'false');
  const storage = env.window.Storage.prototype;
  storage.getItem = () => { throw new Error('blocked'); };
  storage.setItem = () => { throw new Error('blocked'); };
  env.render(null, env.root); env.render(env.h(env.context.ManagerView, props), env.root);
  await flushEffects(); await flushEffects();
  env.root.querySelector('[aria-label="묶음 선택, 상태별"]').click(); await flushEffects();
  Array.from(env.root.querySelectorAll('[role="option"]')).find(node => node.textContent === '머신·repo').click();
  await flushEffects(); assert.ok(env.root.querySelector('[aria-label="묶음 선택, 머신·repo"]'));
  assert.ok(!calls.some(call => /router|conversations/.test(call.url)));
  const css = fs.readFileSync(path.join(publicRoot, 'styles.css'), 'utf8');
  assert.match(css, /@media \(min-width: 900px\) and \(max-width: 1279px\)/);
  assert.match(css, /@media \(max-width: 899px\)/);
  assert.match(css, /\.session-hub-panel-side\s*\{\s*position: absolute/);
});

test('R1 old transcript is a working subgroup with observation age, never a new state', t => {
  const env = setup(t), now = Date.parse('2026-10-12T12:00:00Z');
  const card = (key, state, source, age) => ({ key, machine: { id: 'm', label: 'Mac' }, repo_label: 'repo',
    status: { state, source, evidence_at: new Date(now - age * 60000).toISOString() } });
  const cards = [card('old', 'working', 'transcript', 31), card('orca', 'working', 'orca', 20000),
    card('edge', 'working', 'transcript', 30), card('wait', 'waiting', 'orca', 10),
    card('end', 'ended', 'transcript', 40), card('stop', 'interrupted', 'transcript', 50),
    card('unknown', 'unknown', 'none', 100)];
  assert.deepEqual(Array.from(env.context.sessionGroups(cards, 'status', now), group => group.key),
    ['waiting', 'working', 'working-old-record', 'ended', 'interrupted', 'unknown']);
  assert.equal(env.context.sessionDisplayState(cards[0], now), 'working');
  assert.equal(env.context.sessionDisplayState(cards[1], now), 'working');
  assert.equal(env.context.sessionDisplayState(cards[2], now), 'working');
  assert.equal(cards[0].status.state, 'working');
  assert.equal(env.context.sessionDisplayState({ status: { state: 'working', source: 'transcript' } }, now), 'working');
  env.render(env.h(env.context.SessionRow, { card: { ...cards[0], instructions: [], ai_title: '오래된 지시' },
    now, compact: true, onOpen: () => {} }), env.root);
  assert.ok(env.root.querySelector('.session-status-dot.working.old-record'));
  assert.ok(env.root.textContent.includes('작업 중 · 마지막 기록 31분 전'));
  const groups = env.context.sessionGroups(cards, 'status', now);
  assert.equal(groups[2].label, '작업 중 · 30분 넘게 새 기록 없음');
  assert.equal(env.context.sessionGroups(cards, 'repo', now).length, 1);
  const old = { ...env.context.snapshotCards(fixture(t).alpha)[0],
    status: { ...cards[0].status, evidence_at: new Date(now - 3 * 86400000).toISOString() } };
  env.render(env.h(env.context.SessionHubDetail, { data: { cards: [old], now, load: { rev: REV } },
    selection: { key: old.key } }), env.root);
  assert.ok(env.root.textContent.includes('작업 중 · 마지막 기록 3일 전'));
  const make = changes => ({ key: 'k', first_instruction: 'recoverable', instructions: [
    { text: '<command-name>/login</command-name>' }, { text: '인증 흐름을 검토해 주세요.' },
  ], ...changes });
  assert.equal(env.context.sessionDisplayTitle(make({ ai_title: '인증 검토' })), '인증 검토');
  assert.equal(env.context.sessionDisplayTitle(make({ ai_title: '/exit' })), '인증 흐름을 검토해 주세요.');
  assert.equal(env.context.sessionDisplayTitle(make({ instructions: [{ text: '/login' }] })), '/login');
});

for (const decision of ['approve', 'reject']) test(
  `chat memory ${decision} binds displayed revision/hash and rereads 409`,
  async t => {
    const env = setup(t), calls = [];
    let conflict = true;
    let proposal = { id: 'p1', operation: 'forget', kind: 'fact', status: 'pending', revision: 3,
      content_hash: 'hash3', content: '<img onerror="alert(1)"> 기억 전체', reason: '이유',
      source_content: '이 기억을 보관해 줘', source_thread_id: 't1', source_message_id: 'u1' };
    const snapshot = { thread_id: 't1', epoch: 'boot', version: 1, state: 'running', turnInProgress: false,
      memory: { pending_count: 1, revision: 1 }, messages: [
        { id: 'u1', seq: 1, turn_id: 'turn', role: 'user', content: '보관 요청' },
        { id: 'a1', seq: 2, turn_id: 'turn', role: 'assistant', content: '제안했습니다.' },
        { id: 'n1', seq: 3, turn_id: 'turn', role: 'tool_note', content: '기억 제안', memory_proposal_id: 'p1' },
      ] };
    env.context.EventSource = class { addEventListener() {} close() {} };
    env.context.fetch = async (url, options) => {
      calls.push({ url, options }); assert.match(url, /^\/api\/session-hub\/(chat|memory)/);
      if (url === '/api/session-hub/memory') return response({ proposals: proposal ? [proposal] : [], memories: [],
        pending_count: proposal ? 1 : 0 });
      if (url.endsWith('/decision')) {
        if (conflict) {
          conflict = false; proposal = { ...proposal, revision: 4, content_hash: 'hash4', content: '갱신된 전체 기억' };
          return response({ error: 'proposal_conflict' }, 409);
        }
        proposal = null; return response({ proposal: { status: decision === 'approve' ? 'approved' : 'rejected' } });
      }
      return response(snapshot);
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    const card = () => env.root.querySelector('.session-hub-proposal');
    assert.ok(card().textContent.includes('기억 전체')); assert.ok(card().textContent.includes('이 기억을 보관해 줘'));
    assert.equal(card().querySelectorAll('img, [onerror]').length, 0);
    assert.equal(card().closest('details'), null);
    const click = async () => {
      Array.from(card().querySelectorAll('button'))
        .find(node => node.textContent === (decision === 'approve' ? '기억' : '거절'))
        .click(); await flushEffects(); await flushEffects();
    };
    await click();
    assert.ok(card().textContent.includes('갱신된 전체 기억'));
    assert.ok(env.root.textContent.includes('기억이 바뀌었습니다. 다시 확인해 주세요.'));
    let posts = calls.filter(call => call.url.endsWith('/decision'));
    assert.deepEqual(JSON.parse(posts[0].options.body), { decision, revision: 3, content_hash: 'hash3' });
    await click(); assert.equal(card(), null);
    posts = calls.filter(call => call.url.endsWith('/decision'));
    assert.deepEqual(JSON.parse(posts[1].options.body), { decision, revision: 4, content_hash: 'hash4' });
    assert.ok(!calls.some(call => /router|conversations/.test(call.url)));
  });

test('previous threads keep read-only paging, full retrieval, deletion and current drafts', async t => {
  const env = setup(t), calls = [], sources = [];
  let deleted = false;
  const snapshot = { thread_id: 'current', epoch: 'boot', version: 1, state: 'running', messages: [
    { id: 'c', seq: 1, role: 'assistant', content: '현재 답변' },
  ], turnInProgress: false };
  env.context.EventSource = class { constructor() { sources.push(this); } addEventListener() {} close() {} };
  env.context.fetch = async (url, options) => {
    calls.push({ url, options }); assert.match(url, /^\/api\/session-hub\/chat\//);
    if (url.endsWith('/threads')) return response({ threads: [{ id: 'current', title: '현재' },
      ...deleted ? [] : [{ id: 'old', title: '이전 질문' }]] });
    if (options.method === 'DELETE') { assert.ok(url.endsWith('/threads/old')); deleted = true; return response({}); }
    if (url.endsWith('/messages/a')) return response({ id: 'a', content: '이전 전체 답변' });
    if (url.includes('before=10')) return response({ messages: [{ id: 'u', seq: 9, role: 'user', content: '이전 발언' }] });
    if (url.includes('/threads/old/messages')) return response({ messages: [
      { id: 'a', seq: 10, role: 'assistant', content: '이전 답변', truncated: true },
    ] });
    return response(snapshot);
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  const input = env.root.querySelector('textarea');
  input.value = '현재 초안'; input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
  const click = async label => {
    Array.from(env.root.querySelectorAll('button')).find(node => node.textContent.trim() === label).click();
    await flushEffects();
  };
  await click('이전 대화');
  assert.equal(env.root.querySelector('[aria-label="현재 삭제"]'), null);
  await click('이전 질문 · 읽기 전용');
  assert.equal(input.disabled, true); assert.equal(env.root.querySelector('button[type="submit"]').disabled, true);
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await click('전체 보기'); assert.ok(env.root.textContent.includes('이전 전체 답변'));
  env.root.querySelector('[role="log"]').dispatchEvent(new env.window.Event('scroll')); await flushEffects();
  assert.ok(env.root.textContent.includes('이전 발언'));
  await click('현재 대화로'); assert.equal(input.value, '현재 초안'); assert.equal(input.disabled, false);
  assert.ok(env.root.textContent.includes('현재 답변'));
  await click('이전 대화'); await click('이전 질문 · 읽기 전용'); await click('삭제');
  assert.ok(env.root.textContent.includes('현재 답변')); assert.equal(input.value, '현재 초안');
  assert.equal(calls.filter(call => call.options.method === 'DELETE').length, 1);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0); assert.equal(sources.length, 1);
});

test('memory scope lists, edits, archives and approves assistant memory using cookie APIs and revisions', async t => {
  const env = setup(t), calls = [];
  env.context.addToast = () => {};
  env.context.sseBroker = { subscribe: () => () => {} };
  env.loadComponent('EmptyState'); env.loadComponent('Modal'); env.loadComponent('MemoryView');
  let item = { id: 'm1', kind: 'preference', content: '한국어로 답변', revision: 2, status: 'active' };
  let proposal = { id: 'p', operation: 'add', kind: 'fact', content: '기억 제안 전체', revision: 1,
    content_hash: 'h', source_content: '출처 발언', status: 'pending' };
  let conflict = true;
  env.context.apiFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/memory/status') return {};
    if (url.startsWith('/api/master-memory')) return { memory: [] };
    assert.match(url, /^\/api\/session-hub\/memory/);
    if (options.method === 'PATCH') {
      const body = JSON.parse(options.body); assert.equal(body.revision, item.revision);
      if (conflict) { conflict = false; item = { ...item, revision: 3, content: '서버에서 수정됨' };
        throw Object.assign(new Error('conflict'), { status: 409 }); }
      item = { ...item, ...body, revision: 4 }; return item;
    }
    if (url.endsWith('/archive')) {
      assert.equal(JSON.parse(options.body).revision, 4);
      item = { ...item, status: 'archived', revision: 5 }; return item;
    }
    if (url.endsWith('/decision')) {
      assert.deepEqual(JSON.parse(options.body), { decision: 'approve', revision: 1, content_hash: 'h' });
      proposal = null; return {};
    }
    return { memories: [item], proposals: proposal ? [proposal] : [], pending_count: proposal ? 1 : 0 };
  };
  env.render(env.h(env.context.MemoryView), env.root); await flushEffects(); await flushEffects();
  const click = async label => {
    Array.from(env.root.querySelectorAll('button')).find(node => node.textContent.trim() === label).click();
    await flushEffects(); await flushEffects();
  };
  await click('비서 기억'); assert.ok(env.root.querySelector('[aria-label="비서 기억"]').textContent.includes('한국어로 답변'));
  await click('수정');
  let input = env.root.querySelector('[aria-label="비서 기억 내용"]');
  input.value = '간단히 답변'; input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
  await click('저장'); assert.ok(env.root.textContent.includes('기억이 바뀌었습니다. 다시 확인해 주세요.'));
  await click('취소'); await click('수정');
  input = env.root.querySelector('[aria-label="비서 기억 내용"]');
  input.value = '간단히 답변'; input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
  await click('저장');
  Array.from(env.root.querySelectorAll('.assistant-memory-item button')).find(node => node.textContent.trim() === '보관')
    .click(); await flushEffects(); await flushEffects(); await click('보관');
  assert.ok(env.root.textContent.includes('간단히 답변'));
  await click('승인 대기 1'); await click('기억'); assert.equal(env.root.querySelector('.session-hub-proposal'), null);
  assert.ok(!calls.some(call => /router|conversations/.test(call.url)));
});

test('sidebar controls stay in a compact normal-flow header and navigation uses borderless rows', async t => {
  const env = setup(t), { alpha } = fixture(t);
  const style = env.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(publicRoot, 'styles/tokens.css'), 'utf8')
    + fs.readFileSync(path.join(publicRoot, 'styles.css'), 'utf8');
  env.document.head.append(style);
  env.context.apiFetch = async () => ({ enabled: true, targets: [] });
  const cards = env.context.snapshotCards(alpha), now = Date.parse(alpha.generated_at);
  const data = { cards, now, loading: false, reload: () => {}, load: { rev: REV, snapshots: [alpha], failures: [],
    entries: [{ machine_id: 'alpha', machine_label: 'Mac', generated_at: alpha.generated_at }] } };
  env.render(env.h('div', { class: 'session-hub-manager' },
    env.h(env.context.SessionHubSidebar, { data, onAssistant: () => {}, onConversation: () => {},
      onWork: () => {}, onOpenSession: () => {} })), env.root); await flushEffects();
  const computed = selector => env.window.getComputedStyle(env.root.querySelector(selector));
  assert.equal(computed('.session-hub-sidebar-header').position, 'static');
  assert.equal(computed('.session-hub-sidebar-header').display, 'grid');
  assert.equal(computed('.session-hub-filters').display, 'grid');
  assert.equal(computed('.session-hub-filters .dropdown-button').height, '28px');
  assert.equal(env.root.querySelectorAll('.session-hub-filters .dropdown-button').length, 3);
  assert.equal(env.root.querySelectorAll('.session-hub-sidebar-header > button').length, 0);
  assert.equal(env.root.querySelectorAll('.work-header, .work-snapshot-times').length, 0);
  assert.equal(computed('.session-hub-nav').borderTopStyle, 'none');
  assert.equal(env.root.querySelector('.session-hub-nav').getAttribute('aria-current'), 'page');
  assert.equal(computed('.session-hub-group-title').fontSize, '11px');
  env.render(env.h(env.context.SessionHubDetail, { data, selection: { key: cards[0].key } }), env.root);
  await flushEffects();
  assert.equal(env.root.querySelectorAll('.work-orca').length, 0);
  assert.equal(env.root.querySelectorAll('.session-hub-detail-header .work-meta').length, 1);
});

// R1 regressions: these cases fail on the reviewed implementation.
test('R1 remote HTTP without randomUUID sends and retries the same fallback request id', async t => {
  const env = setup(t), calls = [];
  Object.defineProperty(env.window.crypto, 'randomUUID', { value: undefined, configurable: true });
  env.context.globalThis = env.context;
  env.context.EventSource = class { addEventListener() {} close() {} };
  const snapshot = { thread_id: 'current', epoch: 'boot', version: 1, state: 'running', messages: [] };
  env.context.fetch = async (url, options) => {
    assert.match(url, /^\/api\/session-hub\/chat\//);
    if (url.endsWith('/message')) { calls.push(JSON.parse(options.body));
      if (calls.length === 1) throw new Error('network'); }
    return response({ ...snapshot, version: calls.length + 1 });
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects();
  const input = env.root.querySelector('textarea');
  input.value = 'HTTP 질문'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects(); env.root.querySelector('button[type="submit"]').click(); await flushEffects();
  assert.equal(calls.length, 1);
  env.root.querySelector('button[type="submit"]').click(); await flushEffects();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.match(calls[0].request_id, /^msg_\d+_[a-f0-9]+$/);
});

for (const operation of ['message', 'threads']) test(
  `R1 delayed ${operation} response preserves a newer external draft`, async t => {
    const env = setup(t), delayed = deferred();
    env.context.EventSource = class { addEventListener() {} close() {} };
    const snapshot = { thread_id: 'current', epoch: 'boot', version: 1, state: 'running', messages: [] };
    env.context.fetch = async (url, options) => {
      assert.match(url, /^\/api\/session-hub\/chat\//);
      return url.endsWith(`/${operation}`) && options.method === 'POST' ? delayed.promise : response(snapshot);
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects();
    const input = env.root.querySelector('textarea');
    input.value = '질문 A'; input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
    (operation === 'message' ? env.root.querySelector('button[type="submit"]')
      : Array.from(env.root.querySelectorAll('button')).find(node => node.textContent === '새 대화')).click();
    await flushEffects();
    env.render(env.h(env.context.SessionHubChat, { draft: { text: '질문 B', version: 1 } }), env.root);
    await flushEffects();
    delayed.resolve(response({ ...snapshot, version: 2, thread_id: operation === 'threads' ? 'next' : 'current' }));
    await flushEffects(); assert.equal(input.value, '질문 B');
  });

for (const mode of ['page', 'full', 'full-window']) test(
  `R1 ${mode} partial outside the SSE window refreshes to final`, async t => {
  const env = setup(t), calls = [];
  let receive, complete = false;
  const partial = { id: 'a', seq: 10, role: 'assistant', status: 'partial', content: '오래된 답변', truncated: true };
  const note = { id: 'note', seq: 12, role: 'system_note', content: '최근 기록', status: 'complete' };
  const snapshot = { thread_id: 'current', epoch: 'boot', version: 1, state: 'running',
    messages: mode === 'full-window' ? [partial, note] : [note] };
  env.context.EventSource = class { addEventListener(name, handler) { receive = handler; } close() {} };
  env.context.fetch = async url => {
    calls.push(url); assert.match(url, /^\/api\/session-hub\/chat\//);
    if (url.includes('?before=')) return response({ messages: [partial] });
    if (url.endsWith('/messages/a')) return response({ ...partial,
      status: complete ? 'complete' : 'partial', content: complete ? '최종 답변' : '진행 중 전체 답변', truncated: false });
    return response(snapshot);
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects();
  if (mode !== 'full-window') {
    env.root.querySelector('[role="log"]').dispatchEvent(new env.window.Event('scroll')); await flushEffects();
  }
  if (mode !== 'page') {
    Array.from(env.root.querySelectorAll('button')).find(node => node.textContent === '전체 보기').click();
    await flushEffects();
  }
  complete = true; receive({ data: JSON.stringify({ ...snapshot, messages: [note], version: 2 }) });
  await flushEffects(); await flushEffects();
  assert.ok(env.root.textContent.includes('최종 답변'));
  assert.ok(!env.root.querySelector('.manager-msg-assistant').textContent.includes('답변 중'));
  assert.ok(calls.some(url => url.endsWith('/messages/a')));
});

test('R1 changed recent message invalidates its cached full content', async t => {
  const env = setup(t); let receive;
  const message = { id: 'a', seq: 1, role: 'assistant', status: 'partial', content: '처음', truncated: true };
  const snapshot = { thread_id: 'current', epoch: 'boot', version: 1, state: 'running', messages: [message] };
  env.context.EventSource = class { addEventListener(name, handler) { receive = handler; } close() {} };
  env.context.fetch = async url => {
    assert.match(url, /^\/api\/session-hub\/chat\//);
    return response(url.endsWith('/messages/a') ? { ...message, content: '이전 전체 본문' } : snapshot);
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects();
  Array.from(env.root.querySelectorAll('button')).find(node => node.textContent === '전체 보기').click();
  await flushEffects(); assert.ok(env.root.textContent.includes('이전 전체 본문'));
  receive({ data: JSON.stringify({ ...snapshot, version: 2,
    messages: [{ ...message, content: '최종 본문', status: 'complete', truncated: false }] }) });
  await flushEffects(); assert.ok(env.root.textContent.includes('최종 본문'));
  assert.ok(!env.root.textContent.includes('이전 전체 본문'));
});

async function r1Manager(t) {
  const env = setup(t), { alpha } = fixture(t), delayed = deferred();
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.useConversation = () => ({ events: [], queuedMessages: [], reloadQueue: () => {} });
  env.context.addToast = () => {};
  loadLib(env, 'conversationId.js');
  env.loadComponent('EmptyState'); env.loadComponent('MentionInput'); env.loadComponent('ManagerChat');
  env.context.SessionGrid = () => env.h('div', { class: 'manager-grid-side' }, '작업 목록');
  env.context.fetch = async (url, options) => {
    if (url === '/api/router/resolve') return response({ target: 'top', text: '매니저 질문' });
    if (url === '/api/conversations/top/message') return delayed.promise;
    return response(url.endsWith('/chat/state') ? { thread_id: 'current', epoch: 'boot', version: 1,
      state: 'running', messages: [] } : url.endsWith('/snapshots/status') ? { enabled: true, targets: [] }
        : url === '/api/observe/snapshots' ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] }
          : url.includes('/snapshots/alpha') ? alpha : {});
  };
  const source = fs.readFileSync(path.join(publicRoot, 'app/components/ManagerView.js'), 'utf8');
  vm.runInContext(transformComponentSource(source).replace(/^export\s+\{[^}]+\};?\s*$/gm, ''), env.context);
  env.render(env.h(env.context.ManagerView, { manager: { status: { active: true, pms: [] }, events: [],
    queuedMessages: [], reloadQueue: () => {} }, projects: [], runs: [], tasks: [], nodeSummary: {},
    sessionHubActive: true }), env.root); await flushEffects(); await flushEffects();
  const nav = async label => {
    Array.from(env.root.querySelectorAll('.session-hub-nav')).find(node => node.textContent === label).click();
    await flushEffects();
  };
  return { env, nav, delayed };
}

test('R1 real ManagerChat keeps draft, image and sending lock across right pane switches', async t => {
  const { env, nav, delayed } = await r1Manager(t);
  await nav('Top');
  const chat = env.root.querySelector('.manager-chat-side'), input = chat.querySelector('textarea');
  input.value = '매니저 질문'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  const file = chat.querySelector('input[type="file"]');
  Object.defineProperty(file, 'files', { value: [new env.window.File(['image'], 'test.png', { type: 'image/png' })] });
  file.dispatchEvent(new env.window.Event('change', { bubbles: true })); await flushEffects();
  assert.equal(chat.querySelectorAll('.manager-image-preview').length, 1);
  await nav('작업');
  const wrapper = chat.closest('.session-hub-manager-chat');
  assert.ok(wrapper?.hidden); assert.equal(wrapper.getAttribute('aria-hidden'), 'true');
  assert.ok(wrapper.hasAttribute('inert'));
  await nav('Top'); assert.equal(env.root.querySelector('.manager-chat-side'), chat);
  assert.equal(input.value, '매니저 질문'); assert.equal(chat.querySelectorAll('.manager-image-preview').length, 1);
  chat.querySelector('.manager-send-btn').click(); await flushEffects();
  assert.equal(chat.querySelector('.manager-send-btn').disabled, true);
  env.root.querySelector('.session-row').click(); await flushEffects(); await nav('Top');
  assert.equal(env.root.querySelector('.manager-chat-side'), chat);
  assert.equal(chat.querySelector('.manager-send-btn').disabled, true);
  delayed.resolve(response({ message: { id: 'done', status: 'queued' } })); await flushEffects();
});

test('R1 drawer asking assistant closes the drawer and focuses its draft', async t => {
  const { env } = await r1Manager(t); env.window.innerWidth = 1100;
  env.root.querySelector('.session-row').click(); await flushEffects();
  Array.from(env.root.querySelectorAll('button')).find(node => node.textContent === '비서에게 묻기').click();
  await flushEffects();
  assert.equal(env.root.querySelector('.session-hub-manager').dataset.right, 'closed');
  const input = env.root.querySelector('.session-hub-chat textarea');
  assert.equal(env.document.activeElement, input); assert.ok(input.value.includes('[[session:'));
});

test('R2 real manager route return never reads or sends a hub conversation', async t => {
  const env = setup(t), { alpha } = fixture(t), calls = [];
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/health') return response({ sessionHubActive: true });
    if (url.endsWith('/chat/state')) return response({ thread_id: 'current', epoch: 'boot', version: 1,
      state: 'running', messages: [] });
    if (url.endsWith('/snapshots/status')) return response({ enabled: true, targets: [] });
    if (url === '/api/observe/snapshots') return response({ rev: REV,
      snapshots: [{ machine_id: 'alpha', sha256: 'a' }] });
    if (url.includes('/snapshots/alpha')) return response(alpha);
    if (url === '/api/router/resolve') {
      const body = JSON.parse(options.body); return response({ target: body.currentConversationId, text: body.text });
    }
    return response({ conversation: { run: { id: 'manager-run', status: 'running' } },
      events: [], messages: [], profiles: [], nodes: [], queued: [], message: { id: 'sent', status: 'queued' } });
  };
  loadAppShell(env); env.loadComponent('MentionInput');
  env.context.useProjects = () => ({ projects: [{ id: 'p1', name: 'Project 1', pm_enabled: 1 }], reload: () => {} });
  env.context.useManagerLifecycle = () => ({ status: { active: true, pms: [] }, reloadQueue: () => {} });
  const hook = fs.readFileSync(path.join(publicRoot, 'app/lib/hooks/conversation.js'), 'utf8');
  vm.runInContext(transformComponentSource(hook), env.context);
  const hubCalls = () => calls.filter(call => /^\/api\/conversations\/hub/.test(decodeURIComponent(call.url)));
  env.window.location.hash = '#manager/operator/p1'; env.render(env.h(env.context.App), env.root);
  await flushEffects(); await flushEffects(); await flushEffects();
  const chat = env.root.querySelector('.manager-chat-side'); assert.ok(chat);
  env.window.location.hash = '#manager'; await flushEffects(); await flushEffects();
  assert.deepEqual(hubCalls(), []);
  assert.equal(env.root.querySelector('.session-hub-manager').dataset.right, 'closed');
  assert.equal(env.root.querySelector('.manager-chat-side'), chat);
  const nav = async label => {
    Array.from(env.root.querySelectorAll('.session-hub-nav')).find(node => node.textContent === label).click();
    await flushEffects();
  };
  await nav('Operator · Project 1');
  const file = chat.querySelector('input[type="file"]');
  Object.defineProperty(file, 'files', { value: [new env.window.File(['image'], 'only.png', { type: 'image/png' })] });
  file.dispatchEvent(new env.window.Event('change', { bubbles: true })); await flushEffects();
  chat.querySelector('.manager-send-btn').click(); await flushEffects();
  let sent = calls.filter(call => call.options.method === 'POST' && call.url.endsWith('/message'));
  assert.equal(decodeURIComponent(sent.at(-1).url), '/api/conversations/operator:p1/message');
  assert.equal(JSON.parse(sent.at(-1).options.body).images.length, 1);
  await nav('Top');
  const input = chat.querySelector('textarea'); input.value = 'Top 질문';
  input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
  chat.querySelector('.manager-send-btn').click(); await flushEffects();
  sent = calls.filter(call => call.options.method === 'POST' && call.url.endsWith('/message'));
  assert.equal(sent.at(-1).url, '/api/conversations/top/message');
  for (const hash of ['#manager/all-sessions', '#manager', '#manager/operator/p1', '#manager']) {
    env.window.location.hash = hash; await flushEffects(); await flushEffects();
  }
  assert.deepEqual(hubCalls(), []);
});

test('R2 active ManagerView accepts only manager targets from props and callbacks', async t => {
  const env = setup(t), calls = [], targets = []; let change;
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async url => {
    calls.push(url); return response(url.endsWith('/chat/state') ? { thread_id: 'current', epoch: 'boot', version: 1,
      state: 'running', messages: [] } : url.endsWith('/snapshots/status') ? { enabled: true, targets: [] }
        : { rev: REV, snapshots: [] });
  };
  env.context.ManagerChat = props => {
    targets.push(props.conversationTarget); change = props.onConversationChange;
    env.context.preactHooks.useEffect(() => {
      void env.context.apiFetch(`/api/conversations/${encodeURIComponent(props.conversationTarget)}`);
    }, [props.conversationTarget]);
    return env.h('div', { class: 'manager-chat-side' });
  };
  env.context.SessionGrid = props => env.h('button', { class: 'manager-grid-side',
    onClick: () => props.onSelectConversation('hub') }, 'bad grid target');
  env.context.managerProfileAuthState = () => 'ok';
  const source = fs.readFileSync(path.join(publicRoot, 'app/components/ManagerView.js'), 'utf8');
  vm.runInContext(transformComponentSource(source).replace(/^export\s+\{[^}]+\};?\s*$/gm, ''), env.context);
  const props = { manager: { status: {} }, projects: [], runs: [], tasks: [], nodeSummary: {}, sessionHubActive: true };
  const render = async (initialTarget, sessionHubActive = true) => {
    env.render(env.h(env.context.ManagerView, { ...props, initialTarget, sessionHubActive }), env.root);
    await flushEffects();
  };
  await render('operator:p1'); await render('hub'); await render(undefined);
  change('hub'); await flushEffects(); change('hub:invalid'); await flushEffects();
  Array.from(env.root.querySelectorAll('.session-hub-nav')).find(node => node.textContent === '작업').click();
  await flushEffects(); env.root.querySelector('.manager-grid-side').click(); await flushEffects();
  await render('operator:'); await render('operator:p2'); change('top'); await flushEffects();
  await render('hub', false); change('hub'); await flushEffects();
  await render(undefined, false); await render('hub', true);
  assert.ok(targets.every(target => target === 'top' || /^operator:.+/.test(target)), targets.join(','));
  assert.ok(!calls.some(url => /^\/api\/conversations\/hub/.test(decodeURIComponent(url))));
});

// R3 replaces the editable pending-draft policy with a locked form.
for (const operation of ['add', 'edit']) for (const outcome of ['success', 'failure', 'conflict']) test(
  `R3 memory ${operation} locks the pending form and handles ${outcome}`, async t => {
    const env = setup(t), delayed = deferred(), writes = [];
    const memories = [{ id: 'existing', content: '기존 기억', kind: 'fact', status: 'active', revision: 2 }];
    let nextId = 0;
    env.context.fetch = async (url, options = {}) => {
      assert.match(url, /^\/api\/session-hub\/memory/);
      if (options.method === 'POST' || options.method === 'PATCH') {
        const body = JSON.parse(options.body);
        writes.push({ url, method: options.method, body });
        if (writes.length === 1) {
          await delayed.promise;
          if (outcome !== 'success') return response({}, outcome === 'conflict' ? 409 : 500);
        }
        if (options.method === 'POST') {
          // The real server creates a new row for every successful POST; it never upserts.
          const item = { ...body, id: `created-${++nextId}`, status: 'active', revision: 1 };
          memories.push(item); return response(item);
        }
        const item = memories.find(row => url.endsWith(`/${row.id}`));
        assert.equal(body.revision, item.revision);
        Object.assign(item, body, { revision: item.revision + 1 }); return response(item);
      }
      return response({ memories, proposals: [], pending_count: 0 });
    };
    env.render(env.h(env.context.AssistantMemoryView), env.root); await flushEffects(); await flushEffects();
    const button = label => Array.from(env.root.querySelectorAll('button'))
      .find(node => node.textContent.trim() === label);
    const click = async label => { button(label).click(); await flushEffects(); };
    await click(operation === 'add' ? '기억 추가' : '수정');
    const input = env.root.querySelector('textarea');
    input.value = '내용 A'; input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
    env.root.querySelector('[aria-label^="기억 종류,"]').click(); await flushEffects();
    env.root.querySelector('[role="option"][data-value="person"]').click(); await flushEffects();
    await click('저장');
    const form = env.root.querySelector('form'), kind = env.root.querySelector('[aria-label="기억 종류, 인물"]');
    assert.equal(input.disabled, true, 'pending textarea must reject edits');
    assert.equal(kind.disabled, true, 'pending kind must reject changes');
    assert.equal(button('기억 추가').disabled, true, 'pending save must prevent a new form');
    assert.equal(button('취소').disabled, true, 'pending form must stay bound to its request');
    assert.equal(form.getAttribute('aria-busy'), 'true');
    const save = form.querySelector('[type="submit"]');
    assert.equal(save.disabled, true); assert.match(save.textContent, /저장 중/);
    button('기억 추가').click(); button('취소').click(); kind.click(); save.click();
    form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    await flushEffects();
    assert.equal(env.root.querySelector('textarea'), input);
    assert.equal(input.value, '내용 A'); assert.equal(kind.dataset.value, 'person');
    assert.equal(env.root.querySelector('[role="listbox"]'), null);
    assert.equal(writes.length, 1); assert.equal(writes[0].body.content, '내용 A');
    assert.equal(writes[0].body.kind, 'person');
    delayed.resolve(); await flushEffects(); await flushEffects();
    if (outcome !== 'success') {
      assert.equal(env.root.querySelector('textarea'), input, 'failure must retain the same form');
      assert.equal(input.value, '내용 A'); assert.equal(input.disabled, false);
      assert.equal(kind.disabled, false); assert.equal(button('기억 추가').disabled, false);
      assert.equal(button('취소').disabled, false); assert.equal(button('저장').disabled, false);
      assert.equal(form.getAttribute('aria-busy'), 'false');
      assert.ok(env.root.textContent.includes(outcome === 'conflict'
        ? '기억이 바뀌었습니다. 다시 확인해 주세요.' : '기억을 저장하지 못했습니다.'));
      assert.equal(memories.length, 1); assert.equal(memories[0].content, '기존 기억');
      await click('저장'); await flushEffects();
      assert.equal(writes.length, 2); assert.deepEqual(writes[1].body, writes[0].body);
    }
    assert.equal(env.root.querySelector('form'), null, 'success must close the form');
    assert.equal(memories.length, operation === 'add' ? 2 : 1);
    assert.equal(memories.filter(row => row.content === '내용 A').length, 1, 'exactly one successful memory');
    await click('기억 추가');
    assert.equal(env.root.querySelector('textarea').value, '', 'success must clear the next draft');
    assert.ok(env.root.querySelector('[aria-label="기억 종류, 선호"]'));
    assert.ok(writes.every(write => !/router|conversations/.test(write.url)));
  });

for (const outcome of ['complete', 'disabled', 'error']) test(
  `R4 hub off standalone work restores snapshot refresh ${outcome}`, async t => {
    const env = setup(t), { alpha } = fixture(t), calls = [], polls = [];
    let snapshot = alpha, loads = 0;
    let status = { enabled: outcome !== 'disabled', auto_interval_ms: 0, targets: [
      { name: 'mac', machine_id: 'alpha', running: false, last_result: null },
      { name: 'codev2', machine_id: 'beta', running: false, last_result: { code: 'failed' } },
    ] };
    const schedule = env.window.setTimeout.bind(env.window);
    env.window.setTimeout = (fn, delay, ...args) => {
      if (delay === 10000 || delay === 1000) { polls.push(fn); return schedule(() => {}, 60000); }
      return schedule(fn, delay, ...args);
    };
    env.context.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/health') return response({ sessionHubActive: false });
      if (url.endsWith('/snapshots/status')) return response(status);
      if (url.endsWith('/snapshots/refresh')) {
        if (outcome === 'error') return response({}, 500);
        status = { ...status, targets: status.targets.map(target => ({ ...target, running: true })) };
        return response(status, 202);
      }
      if (url === '/api/observe/snapshots') { loads++;
        return response({ rev: snapshot === alpha ? REV : NEXT, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] }); }
      if (url.includes('/snapshots/alpha')) return response(snapshot);
      return response({ nodes: [], queued: [] });
    };
    loadAppShell(env); env.window.location.hash = '#work'; env.render(env.h(env.context.App), env.root);
    await flushEffects(); await flushEffects(); await flushEffects();
    const board = env.root.querySelector('[data-view="work"]'); assert.ok(board);
    assert.equal(env.root.querySelector('.session-hub-chat'), null);
    const button = board.querySelector('[aria-label="새로 만들기"]');
    assert.ok(button, 'standalone board must retain snapshot generation');
    assert.ok(board.textContent.includes('mac · 수집 전')); assert.ok(board.textContent.includes('codev2 · 수집 실패'));
    assert.equal(button.disabled, outcome === 'disabled');
    const initialLoads = loads;
    button.click(); await flushEffects();
    const posts = calls.filter(call => call.options.method === 'POST');
    if (outcome === 'disabled') { assert.equal(posts.length, 0); return; }
    assert.equal(posts.length, 1); assert.equal(posts[0].url, '/api/session-hub/snapshots/refresh');
    assert.equal(posts[0].options.body, '{}'); assert.equal(posts[0].options.credentials, 'same-origin');
    if (outcome === 'error') {
      assert.equal(button.disabled, false); assert.ok(board.querySelector('[role="alert"]'));
      assert.equal(loads, initialLoads); return;
    }
    assert.equal(button.disabled, true); assert.ok(board.textContent.includes('mac · 수집 중'));
    assert.ok(board.textContent.includes('codev2 · 수집 중'));
    snapshot = structuredClone(alpha); snapshot.generated_at = '2026-10-12T00:00:00.000Z';
    snapshot.sessions[0].ai_title = '수집 후 새 상태';
    status = { ...status, targets: status.targets.map(target => ({ ...target, running: false,
      last_result: { code: 'ok' }, last_success_at: snapshot.generated_at })) };
    await polls.shift()(); await flushEffects(); await flushEffects();
    assert.equal(loads, initialLoads + 1); assert.equal(button.disabled, false);
    assert.ok(board.textContent.includes('mac · 수집 완료')); assert.ok(board.textContent.includes('codev2 · 수집 완료'));
    assert.ok(board.textContent.includes('수집 후 새 상태'));
    const reads = loads;
    Array.from(board.querySelectorAll('button')).find(node => node.textContent === '스냅샷 새로고침').click();
    await flushEffects(); await flushEffects(); assert.equal(loads, reads + 1);
    assert.ok(!calls.some(call => /router|conversations|session-hub\/chat/.test(call.url)));
  });

for (const action of ['picker', 'reset']) test(
  `R4 right ManagerChat ${action} synchronizes sidebar aria-current`, async t => {
    const { env } = await r1Manager(t), targets = [], calls = [];
    env.context.confirm = () => true;
    env.context.useConversation = target => {
      targets.push(target); return { run: { id: 'operator-run', status: 'running' }, events: [], queuedMessages: [] };
    };
    const fetch = env.context.fetch;
    env.context.fetch = async (url, options) => {
      calls.push({ url, options }); return url.endsWith('/reset') ? response({}) : fetch(url, options);
    };
    env.render(env.h(env.context.ManagerView, { manager: { status: { active: true, pms: [] }, events: [],
      queuedMessages: [], reloadQueue: () => {} }, projects: [{ id: 'p1', name: 'Project 1', pm_enabled: true }],
      runs: [], tasks: [], agents: [], nodeSummary: {}, sessionHubActive: true,
      initialTarget: action === 'reset' ? 'operator:p1' : 'top' }), env.root);
    await flushEffects(); await flushEffects();
    const chat = env.root.querySelector('.manager-chat-side');
    const nav = label => Array.from(env.root.querySelectorAll('.session-hub-nav'))
      .find(node => node.textContent === label);
    if (action === 'picker') {
      chat.querySelector('.manager-pm-picker button').click(); await flushEffects();
      chat.querySelector('[role="option"][data-value="operator:p1"]').click(); await flushEffects();
      assert.equal(targets.at(-1), 'operator:p1');
      assert.equal(nav('Operator · Project 1').getAttribute('aria-current'), 'page');
      assert.equal(nav('Top').getAttribute('aria-current'), null);
    } else {
      chat.querySelector('[data-action="reset-pm"]').click(); await flushEffects(); await flushEffects();
      assert.equal(calls.filter(call => call.url === '/api/manager/pm/p1/reset').length, 1);
      assert.equal(targets.at(-1), null);
      assert.equal(nav('Top').getAttribute('aria-current'), 'page');
      assert.equal(nav('Operator · Project 1').getAttribute('aria-current'), null);
    }
    assert.equal(env.root.querySelector('.manager-chat-side'), chat);
    nav('작업').click(); await flushEffects(); assert.equal(nav('작업').getAttribute('aria-current'), 'page');
    assert.ok(!calls.some(call => /^\/api\/conversations\/hub/.test(decodeURIComponent(call.url))));
  });

function r5Snapshots() {
  const snapshot = (epoch, version, content) => ({ epoch, version, thread_id: `thread-${epoch}`,
    state: 'idle', turnInProgress: false, messages: [{ id: `answer-${epoch}`, seq: 1,
      role: 'assistant', status: 'complete', content }] });
  return { a: snapshot('A', 40, '이전 A'), b: snapshot('B', 0, '확정 B'), snapshot };
}
function r5Sources(env) {
  const sources = [];
  env.context.EventSource = class {
    constructor(url) { assert.equal(url, '/api/session-hub/chat/stream'); sources.push(this); this.closed = false; }
    addEventListener(name, callback) { assert.equal(name, 'snapshot'); this.receive = callback; }
    emit(value) { this.receive({ data: JSON.stringify(value) }); }
    close() { this.closed = true; }
  };
  return sources;
}

test('R5 delayed initial A cannot replace HTTP B and later B SSE remains live', async t => {
  const env = setup(t), { a, b, snapshot } = r5Snapshots(), sources = r5Sources(env), sync = deferred();
  const calls = [];
  env.context.fetch = async (url, options) => {
    calls.push({ url, options }); assert.equal(url, '/api/session-hub/chat/state');
    return calls.length === 1 ? response(b) : sync.promise;
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  const old = sources[0]; old.emit(a); await flushEffects();
  assert.ok(env.root.textContent.includes('확정 B'), 'unconfirmed A must never replace B');
  assert.ok(!env.root.textContent.includes('이전 A')); assert.equal(old.closed, true); assert.equal(calls.length, 2);
  assert.equal(sources.length, 1, 'new stream must wait for canonical state');
  old.emit(snapshot('B', 500, '이전 연결 B')); old.receive({ data: '{bad json' });
  old.onerror(); old.onopen(); await flushEffects();
  assert.ok(!env.root.textContent.includes('이전 연결 B')); assert.equal(env.root.querySelector('[role="alert"]'), null);
  sync.resolve(response(snapshot('B', 1, '재동기화 B'))); await flushEffects(); await flushEffects();
  assert.equal(sources.length, 2); assert.ok(env.root.textContent.includes('재동기화 B'));
  sources[1].emit(snapshot('B', 2, '후속 B')); await flushEffects();
  old.emit(a); old.onerror(); await flushEffects();
  sources[1].emit(snapshot('B', 2, '같은 버전')); sources[1].emit(snapshot('B', 0, '낮은 버전')); await flushEffects();
  assert.ok(env.root.textContent.includes('후속 B')); assert.equal(env.root.querySelector('[role="alert"]'), null);
  assert.equal(calls.length, 2);
});

test('R5 different HTTP epoch is confirmed only by resynchronized state', async t => {
  const env = setup(t), { a, b, snapshot } = r5Snapshots(), sources = r5Sources(env);
  const post = deferred(), sync = deferred();
  const calls = [];
  env.context.fetch = async (url, options = {}) => {
    calls.push({ url, options }); assert.match(url, /^\/api\/session-hub\/chat\/(state|start)$/);
    if (url.endsWith('/start')) return post.promise;
    return calls.filter(call => call.url.endsWith('/state')).length === 1 ? response(a) : sync.promise;
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  env.root.querySelector('[data-action="start"]').click(); await flushEffects();
  post.resolve(response({ ...b, state: 'running', messages: [{ role: 'assistant', content: '미확정 HTTP B' }] }));
  await flushEffects();
  assert.equal(sources[0].closed, true); assert.equal(sources.length, 1);
  assert.ok(env.root.textContent.includes('이전 A')); assert.ok(!env.root.textContent.includes('미확정 HTTP B'));
  sources[0].emit(snapshot('A', 100, '늦은 A')); await flushEffects();
  assert.ok(!env.root.textContent.includes('늦은 A'));
  sync.resolve(response(b)); await flushEffects(); await flushEffects();
  assert.ok(env.root.textContent.includes('확정 B')); assert.equal(sources.length, 2);
  sources[1].emit({ ...snapshot('B', 1, '최신 B'), state: 'running' }); await flushEffects();
  assert.ok(env.root.textContent.includes('최신 B'));
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
});

test('R5 resynchronization ignores an older initial HTTP response and all retired callbacks', async t => {
  const env = setup(t), { a, b, snapshot } = r5Snapshots(), sources = r5Sources(env);
  const initial = deferred(), sync = deferred(); let reads = 0;
  env.context.fetch = async url => {
    assert.equal(url, '/api/session-hub/chat/state'); return ++reads === 1 ? initial.promise : sync.promise;
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects();
  sources[0].emit(b); await flushEffects();
  sources[0].emit(snapshot('C', 0, '미확정 C')); await flushEffects();
  assert.equal(sources[0].closed, true); assert.equal(reads, 2);
  initial.resolve(response(a)); sources[0].emit(snapshot('B', 900, '폐기된 갱신'));
  sources[0].onerror(); sources[0].onopen(); await flushEffects();
  assert.ok(env.root.textContent.includes('확정 B')); assert.ok(!env.root.textContent.includes('미확정 C'));
  assert.ok(!env.root.textContent.includes('이전 A')); assert.equal(reads, 2);
  sync.resolve(response(b)); await flushEffects(); await flushEffects();
  sources[1].emit(snapshot('B', 1, '유효 갱신')); await flushEffects();
  assert.ok(env.root.textContent.includes('유효 갱신')); assert.equal(reads, 2);
});

for (const outcome of ['recover', 'unmount']) test(`R5 failed state resynchronization retries safely through ${outcome}`,
  async t => {
    const env = setup(t), { a, b, snapshot } = r5Snapshots(), sources = r5Sources(env), retried = deferred();
    const timers = [];
    const schedule = env.window.setTimeout.bind(env.window);
    env.window.setTimeout = (fn, delay, ...args) => {
      if (delay === 1000) { timers.push(fn); return schedule(() => {}, 60000); }
      return schedule(fn, delay, ...args);
    };
    let reads = 0;
    env.context.fetch = async url => {
      assert.equal(url, '/api/session-hub/chat/state');
      return ++reads === 1 ? response(b) : reads === 2 ? response({}, 500) : retried.promise;
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    sources[0].emit(a); await flushEffects(); await flushEffects();
    assert.equal(sources[0].closed, true); assert.equal(sources.length, 1); assert.equal(timers.length, 1);
    assert.equal(env.root.querySelector('textarea').disabled, true);
    assert.ok(env.root.textContent.includes('확정 B'));
    sources[0].emit(snapshot('B', 500, '폐기된 응답')); sources[0].onopen(); await flushEffects();
    assert.ok(env.root.querySelector('[role="alert"]'), 'old open callback must not clear retry failure');
    assert.ok(!env.root.textContent.includes('폐기된 응답'));
    timers[0](); await flushEffects(); assert.equal(reads, 3);
    if (outcome === 'unmount') env.render(null, env.root);
    retried.resolve(response(snapshot('B', 1, '복구된 B'))); await flushEffects(); await flushEffects();
    if (outcome === 'unmount') {
      assert.equal(sources.length, 1); assert.equal(env.root.textContent, '');
    } else {
      assert.equal(sources.length, 2); assert.ok(env.root.textContent.includes('복구된 B'));
      assert.equal(env.root.querySelector('textarea').disabled, false);
      assert.equal(env.root.querySelector('[role="alert"]'), null);
    }
  });

for (const operation of ['message', 'threads', 'start', 'stop']) test(
  `R6 resynchronization aborts ${operation} and retired finally preserves the new lock`, async t => {
    const env = setup(t), sources = r5Sources(env), oldReply = deferred(), newReply = deferred(), posts = [];
    const initial = { epoch: 'A', version: 1, thread_id: 'current', state: operation === 'start' ? 'idle' : 'running',
      messages: [], turnInProgress: false };
    let server = initial;
    env.context.fetch = async (url, options = {}) => {
      assert.match(url, /^\/api\/session-hub\/chat\//);
      if (options.method === 'POST') {
        posts.push({ url, options, body: JSON.parse(options.body) });
        return posts.length === 1 ? oldReply.promise : newReply.promise;
      }
      return response(server);
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    const input = env.root.querySelector('textarea'); input.value = '보존할 초안';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
    const act = () => (operation === 'message' ? env.root.querySelector('[type="submit"]')
      : operation === 'threads' ? Array.from(env.root.querySelectorAll('button'))
        .find(node => node.textContent === '새 대화')
        : env.root.querySelector(`[data-action="${operation}"]`) || Array.from(env.root.querySelectorAll('button'))
          .find(node => node.textContent === '중지')).click();
    act(); await flushEffects(); assert.equal(posts.length, 1); assert.equal(input.disabled, true);
    server = { ...initial, epoch: 'B', version: 0 };
    sources[0].emit(server); await flushEffects(); await flushEffects();
    assert.equal(posts[0].options.signal.aborted, true, 'retired HTTP must be aborted');
    assert.equal(input.disabled, false, 'canonical state must unlock without waiting for the old reply');
    assert.equal(input.value, '보존할 초안');
    assert.equal(env.root.querySelector('.manager-status-badge').textContent,
      operation === 'start' ? '중지됨' : '조회 준비됨');
    act(); await flushEffects(); assert.equal(posts.length, 2); assert.equal(input.disabled, true);
    if (operation === 'message') assert.equal(posts[0].body.request_id, posts[1].body.request_id);
    oldReply.resolve(response({ ...initial, version: 100 })); await flushEffects(); await flushEffects();
    assert.equal(input.disabled, true, 'retired finally must never release the current action');
    assert.equal(input.value, '보존할 초안'); act(); await flushEffects(); assert.equal(posts.length, 2);
    newReply.resolve(response({ ...server, version: 2, state: operation === 'stop' ? 'idle' : 'running' }));
    await flushEffects(); await flushEffects(); assert.equal(input.disabled, false);
    assert.equal(input.value, ['message', 'threads'].includes(operation) ? '' : '보존할 초안');
    assert.equal(env.root.querySelector('[role="alert"]'), null);
  });

for (const sameThread of [true, false]) test(`R6 retry keeps its request id with ${sameThread ? 'same' : 'new'} thread`,
  async t => {
    const env = setup(t), sources = r5Sources(env), requests = [], held = deferred();
    let server = { epoch: 'A', version: 1, thread_id: 'current', state: 'running', messages: [], turnInProgress: false };
    env.context.fetch = async (url, options = {}) => {
      assert.match(url, /^\/api\/session-hub\/chat\//);
      if (url.endsWith('/message')) {
        requests.push({ body: JSON.parse(options.body), signal: options.signal });
        if (requests.length === 1) return held.promise;
        return response({ ...server, version: 1 });
      }
      return response(server);
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    const input = env.root.querySelector('textarea'); input.value = '같은 질문';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
    env.root.querySelector('[type="submit"]').click(); await flushEffects();
    server = { ...server, epoch: 'B', version: 0, thread_id: sameThread ? 'current' : 'new-current' };
    sources[0].emit(server); await flushEffects(); await flushEffects();
    assert.equal(input.disabled, false); assert.equal(requests[0].signal.aborted, true);
    env.root.querySelector('[type="submit"]').click(); await flushEffects(); await flushEffects();
    assert.equal(requests.length, 2); assert.equal(requests[1].body.request_id, requests[0].body.request_id);
    assert.equal(requests[1].body.thread_id, server.thread_id); assert.equal(input.value, '');
    held.resolve(response({ ...server, epoch: 'A', version: 100 })); await flushEffects();
    assert.equal(input.value, ''); assert.equal(env.root.querySelector('[role="alert"]'), null);
    assert.equal(env.root.querySelector('.session-hub-note[role="status"]'), null);
  });

test('R6 retired page aborts and its finally cannot unlock the next page', async t => {
  const env = setup(t), sources = r5Sources(env), pages = [], oldPage = deferred(), newPage = deferred();
  let server = { epoch: 'A', version: 1, thread_id: 'current', state: 'running', turnInProgress: false,
    messages: [{ id: 'recent', seq: 12, role: 'assistant', content: '최근 답변', status: 'complete' }] };
  env.context.fetch = async (url, options = {}) => {
    assert.match(url, /^\/api\/session-hub\/chat\//);
    if (url.includes('before=')) { pages.push(options); return pages.length === 1 ? oldPage.promise : newPage.promise; }
    return response(server);
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  const scroll = async () => {
    env.root.querySelector('[role="log"]').dispatchEvent(new env.window.Event('scroll')); await flushEffects();
  };
  await scroll(); server = { ...server, epoch: 'B', version: 0 };
  sources[0].emit(server); await flushEffects(); await flushEffects();
  assert.equal(pages[0].signal.aborted, true); await scroll(); assert.equal(pages.length, 2);
  oldPage.resolve(response({ messages: [{ id: 'old', seq: 1, role: 'user', content: '폐기된 페이지' }] }));
  await flushEffects(); await scroll(); assert.equal(pages.length, 2, 'current page must remain locked');
  assert.ok(!env.root.textContent.includes('폐기된 페이지'));
  newPage.resolve(response({ messages: [{ id: 'new', seq: 8, role: 'user', content: '새 페이지' }] }));
  await flushEffects(); assert.ok(env.root.textContent.includes('새 페이지'));
});

for (const remaining of [1, 3]) test(`R6 incomplete deletion reports ${remaining} remaining records`, async t => {
  const env = setup(t), calls = []; let deleted = false;
  env.context.EventSource = class { addEventListener() {} close() {} };
  const current = { epoch: 'A', version: 1, thread_id: 'current', state: 'running',
    messages: [], turnInProgress: false };
  env.context.fetch = async (url, options = {}) => {
    calls.push({ url, options }); assert.match(url, /^\/api\/session-hub\/chat\//);
    if (options.method === 'DELETE') { deleted = true; return response({ result: 'incomplete', remaining }); }
    if (url.endsWith('/threads')) return response({ threads: [
      { id: 'current', title: '현재' }, ...deleted ? [] : [{ id: 'old', title: '이전 질문' }],
    ] });
    return response(current);
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  const input = env.root.querySelector('textarea'); input.value = '남길 초안';
  input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
  const click = async label => {
    Array.from(env.root.querySelectorAll('button')).find(node => node.textContent.trim() === label).click();
    await flushEffects();
  };
  await click('이전 대화'); env.root.querySelector('[aria-label="이전 질문 삭제"]').click(); await flushEffects();
  assert.ok(env.root.textContent.includes(`일부 기록 삭제 대기(잔여 ${remaining}개)`));
  assert.ok(!env.root.textContent.includes('이전 대화를 삭제했습니다.'));
  assert.equal(env.root.querySelector('[aria-label="이전 질문 삭제"]'), null); assert.equal(input.value, '남길 초안');
  await click('이전 대화'); assert.ok(!env.root.textContent.includes('이전 질문 · 읽기 전용'));
  assert.equal(calls.filter(call => call.options.method === 'DELETE').length, 1);
});

test('R6 abort rejection retires automatic start without sending from the cancelled chain', async t => {
  const env = setup(t), sources = r5Sources(env), requests = [], started = deferred();
  let server = { epoch: 'A', version: 1, thread_id: 'current', state: 'idle', messages: [], turnInProgress: false };
  env.context.fetch = async (url, options = {}) => {
    assert.match(url, /^\/api\/session-hub\/chat\//);
    if (url.endsWith('/start')) {
      requests.push({ url, options });
      if (requests.length === 1) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new env.window.DOMException('aborted', 'AbortError')));
      });
      return started.promise;
    }
    if (url.endsWith('/message')) { requests.push({ url, options }); return response({ ...server, version: 2 }); }
    return response(server);
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  const input = env.root.querySelector('textarea'); input.value = '자동 시작 뒤 질문';
  input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
  env.root.querySelector('[type="submit"]').click(); await flushEffects();
  server = { ...server, epoch: 'B', version: 0 };
  sources[0].emit(server); await flushEffects(); await flushEffects();
  assert.equal(requests[0].options.signal.aborted, true); assert.equal(input.disabled, false);
  assert.equal(input.value, '자동 시작 뒤 질문'); assert.equal(env.root.querySelector('[role="alert"]'), null);
  assert.equal(requests.filter(request => request.url.endsWith('/message')).length, 0);
  env.root.querySelector('[type="submit"]').click(); await flushEffects(); assert.equal(input.disabled, true);
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '시작 중');
  server = { ...server, version: 1, state: 'running' }; started.resolve(response(server));
  await flushEffects(); await flushEffects();
  assert.equal(requests.filter(request => request.url.endsWith('/message')).length, 1);
  assert.equal(requests.at(-1).options.signal.aborted, false); assert.equal(input.value, '');
  assert.equal(input.disabled, false);
});

test('R6 complete deletion retains the completion notice', async t => {
  const env = setup(t);
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async (url, options = {}) => {
    assert.match(url, /^\/api\/session-hub\/chat\//);
    if (options.method === 'DELETE') return response({ result: 'complete', remaining: 0 });
    if (url.endsWith('/threads')) return response({ threads: [{ id: 'old', title: '이전 질문' }] });
    return response({ epoch: 'A', version: 1, thread_id: 'current', state: 'running', messages: [] });
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  Array.from(env.root.querySelectorAll('button')).find(node => node.textContent === '이전 대화').click();
  await flushEffects(); env.root.querySelector('[aria-label="이전 질문 삭제"]').click(); await flushEffects();
  assert.ok(env.root.textContent.includes('이전 대화를 삭제했습니다.'));
  assert.ok(!env.root.textContent.includes('일부 기록 삭제 대기'));
});

test('R7 send rejects a displayed thread superseded before the next render', async t => {
  const env = setup(t), sources = r5Sources(env), posts = [];
  const initial = { epoch: 'A', version: 1, thread_id: 'displayed', state: 'running',
    messages: [], turnInProgress: false };
  env.context.fetch = async (url, options = {}) => {
    assert.match(url, /^\/api\/session-hub\/chat\/(state|message)$/);
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body)); return response({ ...initial, version: 3 });
    }
    return response(initial);
  };
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  const input = env.root.querySelector('textarea'); input.value = '전환 직전 질문';
  input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
  const send = env.root.querySelector('[type="submit"]'); assert.equal(send.disabled, false);
  // SSE updates the active thread immediately; the visible form still has its previous render's handler.
  sources[0].emit({ ...initial, version: 2, thread_id: 'active' });
  send.click(); await flushEffects();
  assert.equal(posts.length, 0, 'a stale form must not POST to its previous thread');
  assert.equal(env.root.querySelector('[role="alert"]').textContent, '대화가 바뀌었습니다. 다시 보내 주세요.');
  assert.equal(input.value, '전환 직전 질문'); assert.equal(input.disabled, false);
  env.root.querySelector('[type="submit"]').click(); await flushEffects();
  assert.equal(posts.length, 1); assert.equal(posts[0].thread_id, 'active');
});

for (const arrival of ['after resynchronization', 'at completion handoff']) test(
  `R7 retired send response ${arrival} preserves input, canonical state and retry`, async t => {
    const env = setup(t), sources = r5Sources(env), held = deferred(), posts = [];
    const initial = { epoch: 'A', version: 1, thread_id: 'current', state: 'running',
      messages: [], turnInProgress: false };
    const handoff = arrival === 'at completion handoff';
    const canonical = { ...initial, epoch: handoff ? 'A' : 'B', version: 3,
      messages: [{ id: 'canonical', role: 'assistant', content: '현재 서버의 답변', status: 'complete' }] };
    let reads = 0;
    env.context.fetch = async (url, options = {}) => {
      assert.match(url, /^\/api\/session-hub\/chat\/(state|message)$/);
      if (url.endsWith('/message')) {
        posts.push({ body: JSON.parse(options.body), signal: options.signal });
        // Deliberately ignore AbortSignal: a retired request can still deliver its response.
        return posts.length === 1 ? held.promise : response({ ...canonical, version: 4 });
      }
      return response(++reads === 1 ? initial : canonical);
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    const input = env.root.querySelector('textarea'); input.value = '재전송할 질문';
    input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
    env.root.querySelector('[type="submit"]').click(); await flushEffects();
    assert.equal(posts.length, 1); assert.equal(input.disabled, true);
    const foreign = { ...initial, epoch: 'B', version: 0 };
    let interleaved = false;
    if (handoff) {
      const options = env.context.preact.options, previous = options.debounceRendering;
      t.after(() => { options.debounceRendering = previous; });
      // Queue SSE between the request's snapshot update and the action's awaited completion.
      // Ordinary post-abort replies are already rejected inside request(); this covers the next async boundary.
      options.debounceRendering = flush => queueMicrotask(() => {
        if (!interleaved) { interleaved = true; sources[0].emit(foreign); }
        flush();
      });
    } else {
      sources[0].emit(foreign); await flushEffects(); await flushEffects();
      assert.equal(posts[0].signal.aborted, true); assert.equal(input.disabled, false);
    }
    held.resolve(response({ ...initial, version: 2,
      messages: [{ id: 'retired', role: 'assistant', content: '퇴역 요청의 답변', status: 'complete' }] }));
    await flushEffects(); await flushEffects();
    if (handoff) assert.equal(interleaved, true, 'SSE must run before the awaited send completion');
    assert.equal(posts[0].signal.aborted, true); assert.equal(sources[0].closed, true);
    assert.equal(sources.length, 2); assert.equal(reads, 2);
    assert.equal(input.value, '재전송할 질문'); assert.equal(input.disabled, false);
    assert.ok(env.root.textContent.includes('현재 서버의 답변'));
    assert.ok(!env.root.textContent.includes('퇴역 요청의 답변'));
    assert.ok(env.root.textContent.includes('전달되지 않았을 수 있습니다. 다시 보내 주세요.'));
    assert.equal(env.root.querySelector('[role="alert"]'), null);
    env.root.querySelector('[type="submit"]').click(); await flushEffects(); await flushEffects();
    assert.equal(posts.length, 2); assert.equal(posts[1].body.request_id, posts[0].body.request_id);
    assert.equal(posts[1].body.text, '재전송할 질문'); assert.equal(posts[1].signal.aborted, false);
    assert.equal(input.value, ''); assert.equal(env.root.querySelector('.session-hub-note[role="status"]'), null);
  });

function timelineSnapshot(t) {
  const { alpha } = fixture(t);
  const session = alpha.sessions[0];
  const base = alpha.instructions.find(row => row.session_key === session.key);
  alpha.instructions = [3, 1, 2].map(seq => ({ ...base, seq, id: `ordered-${seq}`,
    ts: `2026-10-10T02:0${seq}:00.000Z`, text: `지시 ${seq}` }));
  session.instruction_count = session.instruction_total = 3;
  return alpha;
}

// jsdom has no layout: model a bordered, offset viewport with a nonzero initial scroll.
// Extra content follows the timeline, so scrolling to scrollHeight would overshoot it.
function trackTimelineScroll(t, env, container, initialHeight = 300) {
  let scrollTop = 80, height = initialHeight;
  const writes = [], focused = [];
  Object.defineProperties(container, {
    scrollTop: { configurable: true, get: () => scrollTop,
      set: value => { writes.push(value); scrollTop = value; } },
    clientTop: { configurable: true, value: 2 },
    clientHeight: { configurable: true, get: () => height },
    scrollHeight: { configurable: true, value: 2400 },
  });
  const rect = env.window.HTMLElement.prototype.getBoundingClientRect;
  t.mock.method(env.window.HTMLElement.prototype, 'getBoundingClientRect', function () {
    if (this === container) return { top: 120, bottom: 424 };
    if (this.matches('.work-event') && container.contains(this)) {
      const index = Array.from(container.querySelectorAll('.work-event')).indexOf(this);
      return { top: 122 + index * 400 - scrollTop, bottom: 122 + (index + 1) * 400 - scrollTop };
    }
    return rect.call(this);
  });
  const focus = env.window.HTMLElement.prototype.focus;
  t.mock.method(env.window.HTMLElement.prototype, 'focus', function (options) {
    focused.push({ node: this, preventScroll: options?.preventScroll });
    return focus.call(this, options);
  });
  env.window.HTMLElement.prototype.scrollIntoView = () => assert.fail('must not scroll outer layout');
  for (const method of ['scroll', 'scrollTo', 'scrollBy']) {
    t.mock.method(env.window, method, () => assert.fail('must not scroll window'));
  }
  return { writes, focused, read: () => scrollTop, userScroll: value => { scrollTop = value; },
    resize: value => { height = value; } };
}

for (const view of ['manager', 'work']) test(
  `timeline chat order: ${view} selected detail shows three instructions oldest to newest`, async t => {
    const env = setup(t), alpha = timelineSnapshot(t);
    if (view === 'manager') {
      const cards = env.context.snapshotCards(alpha);
      env.render(env.h(env.context.SessionHubDetail, {
        data: { cards, load: { rev: REV }, now: Date.parse(alpha.generated_at) },
        selection: { key: cards[0].key },
      }), env.root);
    } else {
      env.context.apiFetch = async url => url.endsWith('/snapshots')
        ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] } : alpha;
      env.render(env.h(env.context.AllSessionsPanel, { standalone: true }), env.root);
      await flushEffects(); await flushEffects();
      env.root.querySelector(`[data-session-key="${alpha.sessions[0].key}"]`).click();
    }
    await flushEffects();
    assert.deepEqual(Array.from(env.root.querySelectorAll('.work-instruction'), node => node.textContent),
      ['지시 1', '지시 2', '지시 3']);
  });

test('timeline selection scroll: manager scrolls once per key, preserves focus and reader position on updates', async t => {
  const env = setup(t), alpha = timelineSnapshot(t);
  let cards = env.context.snapshotCards(alpha);
  const show = key => env.render(env.h(env.context.SessionHubDetail, {
    data: { cards, load: { rev: REV }, now: Date.parse(alpha.generated_at) },
    selection: { key, query: '' },
  }), env.root);
  show(cards[0].key);
  const container = env.root.querySelector('.session-hub-detail');
  const tracked = trackTimelineScroll(t, env, container);
  await flushEffects();
  assert.deepEqual(tracked.writes, [900]);
  const header = container.querySelector('.session-hub-detail-header');
  assert.equal(env.document.activeElement, header);
  assert.equal(tracked.focused.length, 1);
  assert.equal(tracked.focused[0].node, header);
  assert.equal(tracked.focused[0].preventScroll, true);
  tracked.userScroll(150);
  alpha.instructions.push({ ...alpha.instructions[0], seq: 4, id: 'ordered-4',
    ts: '2026-10-10T02:04:00.000Z', text: '새 지시 4' });
  cards = env.context.snapshotCards(alpha);
  show(cards[0].key); await flushEffects();
  assert.equal(container.querySelectorAll('.work-event').length, 4);
  assert.deepEqual(tracked.writes, [900]);
  assert.equal(tracked.read(), 150);
  assert.equal(tracked.focused.length, 1);
  assert.equal(env.document.activeElement, header);
  show(cards[1].key); await flushEffects();
  assert.equal(container.querySelectorAll('.work-event').length, 0);
  assert.deepEqual(tracked.writes, [900, 0], 'empty timeline must scroll to the top');
  assert.equal(tracked.read(), 0);
  assert.equal(env.document.activeElement, header);
  show(cards[0].key); await flushEffects();
  assert.deepEqual(tracked.writes, [900, 0, 1300]);
  assert.equal(tracked.focused.length, 3);
  assert.ok(tracked.focused.every(call => call.preventScroll === true));
  assert.equal(env.root.scrollTop, 0);
  assert.equal(env.document.documentElement.scrollTop, 0);
  assert.equal(env.document.body.scrollTop, 0);
});

test('timeline selection scroll: work preserves position while the selected card stays present', async t => {
  const env = setup(t);
  let alpha = timelineSnapshot(t), revision = REV;
  env.context.useSessionSnapshots = () => liveTimelineData(alpha, revision);
  env.context.apiFetch = async url => url.endsWith('/snapshots')
    ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] } : alpha;
  const show = selection => env.render(env.h(env.context.AllSessionsPanel, { standalone: true, selection }), env.root);
  show(null); await flushEffects(); await flushEffects();
  const container = env.root.querySelector('.work-board');
  const tracked = trackTimelineScroll(t, env, container);
  const key = alpha.sessions[0].key;
  show({ key, rev: REV }); await flushEffects();
  assert.deepEqual(tracked.writes, [900]);
  assert.equal(env.document.activeElement.textContent, '← 모든 세션');
  assert.equal(tracked.focused.length, 1);
  assert.equal(tracked.focused[0].preventScroll, true);
  tracked.userScroll(150);
  alpha = structuredClone(alpha);
  alpha.instructions.push({ ...alpha.instructions[0], seq: 4, id: 'ordered-4',
    ts: '2026-10-10T02:04:00.000Z', text: '새 지시 4' });
  const cardElement = container.querySelector('.work-card');
  revision = NEXT;
  show({ key, rev: NEXT }); await flushEffects();
  assert.equal(container.querySelector('.work-card'), cardElement, 'card DOM stays mounted during update');
  assert.equal(container.querySelectorAll('.work-event').length, 4);
  assert.deepEqual(tracked.writes, [900]);
  assert.equal(tracked.read(), 150);
  assert.equal(tracked.focused.length, 1);
  show({ key: alpha.sessions[1].key }); await flushEffects();
  assert.equal(container.querySelectorAll('.work-event').length, 0);
  assert.deepEqual(tracked.writes, [900, 0], 'empty timeline must scroll to the top');
  assert.equal(tracked.read(), 0);
  show({ key }); await flushEffects();
  assert.deepEqual(tracked.writes, [900, 0, 1300]);
  assert.equal(tracked.focused.length, 3);
  assert.ok(tracked.focused.every(call => call.preventScroll === true));
  assert.equal(env.root.scrollTop, 0);
  assert.equal(env.document.documentElement.scrollTop, 0);
  assert.equal(env.document.body.scrollTop, 0);
});


test('timeline retry: manager waits for the selected card and preserves position after completion', async t => {
  const env = setup(t), alpha = timelineSnapshot(t), key = alpha.sessions[0].key;
  let cards = [], loading = true;
  const show = () => env.render(env.h(env.context.SessionHubDetail, {
    data: { cards, loading, now: Date.parse(alpha.generated_at), load: { rev: loading ? null : REV } },
    selection: { key },
  }), env.root);
  show();
  const container = env.root.querySelector('.session-hub-detail');
  const tracked = trackTimelineScroll(t, env, container);
  await flushEffects();
  assert.deepEqual(tracked.writes, [], 'pending card must not complete the initial scroll');
  assert.equal(env.document.activeElement, container.querySelector('.session-hub-detail-header'));
  cards = env.context.snapshotCards(alpha); loading = false;
  show(); await flushEffects();
  assert.equal(container.querySelectorAll('.work-event').length, 3);
  assert.deepEqual(tracked.writes, [900]);
  tracked.userScroll(150);
  alpha.instructions.push({ ...alpha.instructions[0], seq: 4, id: 'ordered-4',
    ts: '2026-10-10T02:04:00.000Z', text: '새 지시 4' });
  cards = env.context.snapshotCards(alpha);
  show(); await flushEffects();
  assert.equal(container.querySelectorAll('.work-event').length, 4);
  assert.deepEqual(tracked.writes, [900]);
  assert.equal(tracked.read(), 150);
  assert.equal(tracked.focused.length, 1);
  assert.equal(tracked.focused[0].preventScroll, true);
});

test('timeline retry: work waits for the selected card and scrolls again after reload', async t => {
  const env = setup(t), pending = deferred();
  let alpha = timelineSnapshot(t);
  const key = alpha.sessions[0].key;
  let delayed = true;
  env.context.apiFetch = async url => url.endsWith('/snapshots')
    ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] }
    : delayed ? pending.promise : alpha;
  env.render(env.h(env.context.AllSessionsPanel, { standalone: true, selection: { key } }), env.root);
  const container = env.root.querySelector('.work-board');
  const tracked = trackTimelineScroll(t, env, container);
  await flushEffects(); await flushEffects();
  assert.equal(container.querySelectorAll('.work-event').length, 0);
  assert.deepEqual(tracked.writes, [], 'pending card must not complete the initial scroll');
  delayed = false; pending.resolve(alpha);
  await flushEffects(); await flushEffects();
  assert.equal(container.querySelectorAll('.work-event').length, 3);
  assert.deepEqual(tracked.writes, [900]);
  tracked.userScroll(150);
  alpha = structuredClone(alpha);
  alpha.instructions.push({ ...alpha.instructions[0], seq: 4, id: 'ordered-4',
    ts: '2026-10-10T02:04:00.000Z', text: '새 지시 4' });
  Array.from(container.querySelectorAll('button')).find(button => button.textContent === '스냅샷 새로고침').click();
  await flushEffects(); await flushEffects();
  assert.equal(container.querySelectorAll('.work-event').length, 4);
  assert.deepEqual(tracked.writes, [900, 1300]);
  assert.equal(tracked.read(), 1300);
  assert.equal(tracked.focused.length, 1);
  assert.equal(tracked.focused[0].preventScroll, true);
});

async function readyTimelineDetail(t, view, initialHeight = 300) {
  const env = setup(t), alpha = timelineSnapshot(t);
  const cards = env.context.snapshotCards(alpha);
  env.context.apiFetch = async url => url.endsWith('/snapshots')
    ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] } : alpha;
  const show = key => env.render(view === 'manager'
    ? env.h(env.context.SessionHubDetail, {
      data: { cards, loading: false, now: Date.parse(alpha.generated_at), load: { rev: REV } },
      selection: key ? { key } : null,
    }) : env.h(env.context.AllSessionsPanel, { standalone: true, selection: key ? { key } : null }), env.root);
  show(null); await flushEffects(); await flushEffects();
  const container = env.root.querySelector(view === 'manager' ? '.session-hub-detail' : '.work-board');
  const tracked = trackTimelineScroll(t, env, container, initialHeight);
  return { env, alpha, container, tracked, select: async key => { show(key); await flushEffects(); } };
}

function fakeTimelineResizeObserver(env) {
  const observers = [];
  env.context.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    notify() { this.callback([{ target: this.target }]); }
  };
  return observers;
}

for (const view of ['manager', 'work']) {
  test(`timeline retry: ${view} opens an empty loaded session at the top`, async t => {
    const { alpha, tracked, container, select } = await readyTimelineDetail(t, view);
    tracked.userScroll(2100);
    await select(alpha.sessions[1].key);
    assert.equal(container.querySelectorAll('.work-event').length, 0);
    assert.ok(container.querySelector('.work-card'), 'empty session card is loaded');
    assert.deepEqual(tracked.writes, [0]);
    assert.equal(tracked.read(), 0);
    tracked.userScroll(100);
    await select(alpha.sessions[1].key);
    assert.deepEqual(tracked.writes, [0]);
    assert.equal(tracked.read(), 100, 'completed empty session must preserve reader position');
  });

  test(`timeline retry: ${view} opens a confirmed missing session at the top`, async t => {
    const { container, tracked, select } = await readyTimelineDetail(t, view);
    tracked.userScroll(2100);
    await select('missing-session');
    assert.ok(container.textContent.includes('현재 스냅샷에 없는 세션'));
    assert.deepEqual(tracked.writes, [0]);
    assert.equal(tracked.read(), 0);
  });

  test(`timeline retry: ${view} waits for layout and scrolls once after ResizeObserver notification`, async t => {
    const { env, alpha, tracked, container, select } = await readyTimelineDetail(t, view, 0);
    const observers = fakeTimelineResizeObserver(env);
    await select(alpha.sessions[0].key);
    assert.deepEqual(tracked.writes, [], 'hidden container must not scroll or complete');
    const observer = observers.find(item => !item.disconnected);
    assert.ok(observer, 'pending scroll must observe layout changes');
    assert.equal(observer.target, container);
    tracked.resize(300);
    observer.notify();
    assert.deepEqual(tracked.writes, [900]);
    assert.equal(observer.disconnected, true, 'successful scroll stops observing');
    tracked.userScroll(150);
    tracked.resize(400);
    observer.notify();
    await select(alpha.sessions[0].key);
    assert.deepEqual(tracked.writes, [900]);
    assert.equal(tracked.read(), 150);
    tracked.resize(0);
    await select(alpha.sessions[1].key);
    assert.deepEqual(tracked.writes, [900], 'changing keys while hidden resets completion');
    const nextObserver = observers.find(item => !item.disconnected);
    assert.ok(nextObserver);
    observer.notify();
    assert.deepEqual(tracked.writes, [900], 'retired observer cannot scroll another selection');
    tracked.resize(300);
    nextObserver.notify();
    assert.deepEqual(tracked.writes, [900, 0]);
    tracked.userScroll(100);
    nextObserver.notify();
    assert.deepEqual(tracked.writes, [900, 0]);
    tracked.resize(0);
    await select(alpha.sessions[0].key);
    const unfinishedObserver = observers.find(item => !item.disconnected);
    assert.ok(unfinishedObserver, 'another hidden selection is still pending');
    env.render(null, env.root);
    assert.ok(observers.every(item => item.disconnected), 'unmount disconnects observers');
    tracked.resize(300);
    unfinishedObserver.notify();
    assert.deepEqual(tracked.writes, [900, 0], 'retired callbacks cannot scroll after unmount');
  });
}


// A live update retains the card; real useSessionSnapshots reloads are tested separately below.
function liveTimelineData(snapshot, revision = REV) {
  return {
    load: { rev: revision, snapshots: [snapshot], failures: [], done: 1, total: 1,
      entries: [{ machine_id: 'alpha', machine_label: 'Mac', sha256: 'a' }] },
    cards: [], loading: false, error: false, now: Date.parse(snapshot.generated_at), reload: () => {},
  };
}

async function timelineTargetLifecycle(t, view, initialPhase) {
  const env = setup(t), alpha = timelineSnapshot(t), key = alpha.sessions[0].key;
  let phase = initialPhase, pending;
  const emptySnapshot = { ...alpha, sessions: [], instructions: [] };
  const snapshot = () => phase === 'absent' ? emptySnapshot : alpha;
  const render = () => {
    if (view === 'manager') {
      const settled = phase === 'present' || phase === 'absent';
      env.render(env.h(env.context.SessionHubDetail, {
        data: { cards: settled ? env.context.snapshotCards(snapshot()) : [],
          loading: phase === 'pending', now: Date.parse(alpha.generated_at),
          load: { rev: settled ? REV : null } },
        selection: { key },
      }), env.root);
    } else {
      env.render(env.h(env.context.AllSessionsPanel, { standalone: true, selection: { key } }), env.root);
    }
  };
  env.context.apiFetch = async url => {
    if (url.startsWith('/api/session-hub/snapshots')) return { enabled: true, targets: [] };
    if (phase === 'failed') throw new Error('snapshot unavailable');
    if (url.endsWith('/snapshots')) return { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] };
    return phase === 'pending' ? pending.promise : snapshot();
  };
  render();
  const container = env.root.querySelector(view === 'manager' ? '.session-hub-detail' : '.work-board');
  const tracked = trackTimelineScroll(t, env, container);
  await flushEffects(); await flushEffects();
  return { env, alpha, container, tracked,
    beginReload: async () => {
      phase = 'pending'; pending = deferred();
      if (view === 'manager') render();
      else Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === '스냅샷 새로고침').click();
      await flushEffects(); await flushEffects();
      assert.equal(container.querySelector('.work-card'), null, 'reload removes the card DOM');
    },
    finishReload: async () => {
      phase = 'present';
      if (view === 'manager') render();
      else pending.resolve(alpha);
      await flushEffects(); await flushEffects();
      assert.equal(container.querySelectorAll('.work-event').length, 3);
    },
  };
}

for (const view of ['manager', 'work']) {
  test(`timeline target: ${view} does not complete on failure and scrolls after a successful retry`, async t => {
    const { tracked, container, beginReload, finishReload } = await timelineTargetLifecycle(t, view, 'failed');
    assert.equal(container.querySelector('.work-card'), null);
    assert.deepEqual(tracked.writes, [], 'no revision means failure, not confirmed absence');
    assert.equal(tracked.read(), 80);
    await beginReload();
    assert.deepEqual(tracked.writes, []);
    await finishReload();
    assert.deepEqual(tracked.writes, [900]);
    assert.equal(tracked.read(), 900);
  });

  test(`timeline target: ${view} returns to the latest instruction after reload removes and restores the card`, async t => {
    const { tracked, beginReload, finishReload } = await timelineTargetLifecycle(t, view, 'present');
    assert.deepEqual(tracked.writes, [900]);
    tracked.userScroll(150);
    await beginReload();
    assert.deepEqual(tracked.writes, [900], 'loading without a card must not explicitly scroll');
    // Model the browser clamping scrollTop after the tall timeline disappears.
    tracked.userScroll(0);
    await finishReload();
    assert.deepEqual(tracked.writes, [900, 900]);
    assert.equal(tracked.read(), 900);
  });

  test(`timeline target: ${view} scrolls from confirmed absence to a present card without changing keys`, async t => {
    const env = setup(t), alpha = timelineSnapshot(t), key = alpha.sessions[0].key;
    let snapshot = { ...alpha, sessions: [], instructions: [] };
    env.context.apiFetch = async () => ({ enabled: true, targets: [] });
    env.context.useSessionSnapshots = () => liveTimelineData(snapshot);
    const render = () => env.render(view === 'manager'
      ? env.h(env.context.SessionHubDetail, {
        data: { ...liveTimelineData(snapshot), cards: env.context.snapshotCards(snapshot) },
        selection: { key },
      }) : env.h(env.context.AllSessionsPanel, { standalone: true, selection: { key } }), env.root);
    render();
    const container = env.root.querySelector(view === 'manager' ? '.session-hub-detail' : '.work-board');
    const tracked = trackTimelineScroll(t, env, container);
    tracked.userScroll(2100);
    await flushEffects();
    assert.ok(container.textContent.includes('현재 스냅샷에 없는 세션'));
    assert.deepEqual(tracked.writes, [0]);
    assert.equal(tracked.read(), 0);
    snapshot = alpha;
    render(); await flushEffects();
    assert.equal(container.querySelectorAll('.work-event').length, 3);
    assert.deepEqual(tracked.writes, [0, 900]);
    tracked.userScroll(150);
    snapshot = structuredClone(alpha);
    snapshot.instructions.push({ ...snapshot.instructions[0], seq: 4, id: 'ordered-4',
      ts: '2026-10-10T02:04:00.000Z', text: '새 지시 4' });
    const cardElement = container.querySelector('.work-card');
    render(); await flushEffects();
    assert.equal(container.querySelector('.work-card'), cardElement);
    assert.equal(container.querySelectorAll('.work-event').length, 4);
    assert.deepEqual(tracked.writes, [0, 900]);
    assert.equal(tracked.read(), 150);
  });
}

const ANSWER_REV = 'a'.repeat(64);
function answerEnvelope(status = 'final', text = '최종 답변') {
  return { status, reason: null, text: status === 'final' ? text : null,
    truncated: false, redacted: false, shared_turn: false,
    answer_at: ['final', 'no_text', 'interrupted'].includes(status) ? '2026-10-10T03:00:00Z' : null,
    observed_at: '2026-10-10T03:10:00Z' };
}
function answerHarness(t, handler = async () => response(answerEnvelope())) {
  const env = setup(t), { alpha } = fixture(t), calls = [];
  const card = { ...env.context.snapshotCards(alpha)[0], answers: true, machineRev: ANSWER_REV };
  env.context.fetch = (url, options) => {
    calls.push({ url, options }); return handler(url, options);
  };
  const render = next => env.render(env.h(env.context.SessionCard,
    { card: next || card, timeline: true, now: Date.parse('2026-10-10T03:10:00Z') }), env.root);
  render();
  const toggle = () => env.root.querySelector('.work-answer-toggle');
  return { ...env, card, calls, render, toggle };
}

test('answers are closed on mount, gated by answers and machine sha256, and fetch exactly four cookie query parameters', async t => {
  const fx = answerHarness(t);
  await flushEffects();
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.root.querySelector('.work-answer'), null);
  assert.equal(fx.toggle().textContent.trim(), '답변 보기');
  assert.equal(fx.toggle().getAttribute('aria-expanded'), 'false');
  fx.toggle().dispatchEvent(new fx.window.MouseEvent('mouseover', { bubbles: true }));
  fx.root.dispatchEvent(new fx.window.Event('scroll'));
  await flushEffects(20); assert.equal(fx.calls.length, 0);
  fx.toggle().click(); await flushEffects();
  assert.equal(fx.calls.length, 1);
  const { url, options } = fx.calls[0];
  const params = new URL(url, 'http://localhost').searchParams;
  const instruction = fx.card.instructions[0];
  assert.equal(url, '/api/observe/answers?' + new URLSearchParams({ machine: fx.card.machine.id,
    key: instruction.session_key, instruction: instruction.id, rev: ANSWER_REV }));
  assert.deepEqual([...params.keys()], ['machine', 'key', 'instruction', 'rev']);
  for (const key of params.keys()) assert.equal(params.getAll(key).length, 1);
  assert.equal(params.get('instruction').includes('#'), false);
  assert.ok(Buffer.byteLength(url.split('?')[1]) <= 2048);
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers.has('Authorization'), false);
  assert.equal('allowAppForbidden' in options, false);
  assert.equal(fx.toggle().getAttribute('aria-expanded'), 'true');
  assert.equal(fx.root.querySelector('.work-answer').id, fx.toggle().getAttribute('aria-controls'));
  assert.equal(fx.root.querySelector('.work-answer').getAttribute('role'), 'region');
  assert.equal(fx.root.querySelector('.work-answer').getAttribute('aria-label'), '답변');
  assert.equal(fx.root.querySelector('.work-answer').closest('li.work-event'), fx.toggle().closest('li.work-event'));
  fx.toggle().click(); await flushEffects();
  assert.equal(fx.root.querySelector('.work-answer'), null);
  for (const props of [{ answers: false }, { answers: undefined }, { answers: 'true' },
    { machineRev: null }, { machineRev: undefined }, { machineRev: REV }]) {
    fx.render({ ...fx.card, ...props }); await flushEffects(20);
    assert.equal(fx.root.querySelector('.work-answer-toggle'), null);
  }
  assert.equal(fx.calls.length, 1);
});

test('final answer is a single literal text node, includes metadata, and never writes either web storage', async t => {
  const literal = '<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n[링크](javascript:alert(3))\n**굵게**';
  const fx = answerHarness(t, async () => response({ ...answerEnvelope('final', literal),
    truncated: true, redacted: true, shared_turn: true }));
  const writes = t.mock.method(fx.window.Storage.prototype, 'setItem', () => assert.fail('answer storage write'));
  fx.toggle().click(); await flushEffects();
  const text = fx.root.querySelector('.work-answer-text'), region = fx.root.querySelector('.work-answer');
  assert.equal(text.textContent, literal);
  assert.equal(text.childNodes.length, 1);
  assert.equal(text.firstChild.nodeType, fx.window.Node.TEXT_NODE);
  assert.equal(region.querySelectorAll('img,script,a,strong').length, 0);
  for (const label of ['답변 시각', '조회 시각', '앞부분만 표시', '일부 가림', '여러 지시를 함께 받은 실행의 답변']) {
    assert.ok(region.textContent.includes(label));
  }
  assert.deepEqual(Array.from(region.querySelectorAll('time'), time => time.dateTime),
    ['2026-10-10T03:00:00Z', '2026-10-10T03:10:00Z']);
  const answerURL = fx.window.location.href;
  fx.toggle().click(); await flushEffects();
  assert.equal(fx.root.querySelector('.work-answer'), null);
  fx.toggle().click(); await flushEffects();
  assert.equal(fx.calls.length, 2);
  assert.equal(fx.window.location.href, answerURL);
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(fx.window.localStorage.length, 0);
  assert.equal(fx.window.sessionStorage.length, 0);
});

test('all nine nonfinal answer states show only public copy and no_text/interrupted answer times', async t => {
  let status;
  const fx = answerHarness(t, async () => response({ ...answerEnvelope(status), reason: 'hidden_reason' }));
  const labels = {
    no_text: '응답 끝남 · 텍스트 없음', pending: '최종 답변 아직 없음',
    interrupted: '중단됨 · 최종 답변 없음', local_command: '로컬 명령 · 비서 답변 없음',
    queued_joined: '작업 중 추가로 전달한 지시 · 위 지시의 답변을 보세요',
    unbound: '답변 연결 확인 불가', withheld: '정책상 비공개',
    target_changed: '기록이 바뀜 · 스냅샷을 새로 만들어 주세요', unavailable: '조회 실패 · 다시 시도',
  };
  for (const [value, label] of Object.entries(labels)) {
    status = value;
    fx.toggle().click(); await flushEffects(20);
    const region = fx.root.querySelector('.work-answer');
    assert.equal(region.querySelector('.work-answer-status').textContent, label);
    assert.equal(region.textContent.includes('hidden_reason'), false);
    assert.equal(region.textContent.includes('답변 시각'), ['no_text', 'interrupted'].includes(status));
    assert.ok(region.textContent.includes('조회 시각'));
    assert.equal(region.querySelectorAll('.work-answer-retry').length, status === 'unavailable' ? 1 : 0);
    if (status === 'unavailable') {
      const before = fx.calls.length;
      region.querySelector('.work-answer-retry').click(); await flushEffects(20);
      assert.equal(fx.calls.length, before + 1);
      assert.equal(fx.calls.at(-1).url, fx.calls.at(-2).url);
    }
    fx.toggle().click(); await flushEffects(20);
  }
});

test('HTTP 409/429/503/400/404 and network errors use public messages and manual retries', async t => {
  let status;
  const fx = answerHarness(t, async () => {
    if (status === 0) throw new Error('private network detail');
    return response({ error: 'private failure', reason: 'answers_off' }, status);
  });
  for (const code of [409, 429, 503, 400, 404, 0]) {
    status = code;
    fx.toggle().click(); await flushEffects(20);
    const region = fx.root.querySelector('.work-answer');
    assert.equal(region.querySelector('.work-answer-status').textContent, code === 409
      ? '스냅샷이 바뀜 · 목록을 새로고침해 주세요'
      : code === 429 ? '다른 답변을 조회하는 중 · 잠시 후 다시 시도' : '조회 실패 · 다시 시도');
    assert.equal(region.textContent.includes('private'), false);
    assert.equal(region.textContent.includes('answers_off'), false);
    const retry = region.querySelector('.work-answer-retry'), before = fx.calls.length;
    await flushEffects(20); assert.equal(fx.calls.length, before, 'no automatic retry');
    if (code === 409) assert.equal(retry, null);
    else {
      assert.equal(retry.textContent, '다시 시도');
      retry.click(); await flushEffects(20);
      assert.equal(fx.calls.length, before + 1);
      assert.equal(fx.calls.at(-1).url, fx.calls.at(-2).url);
    }
    fx.toggle().click(); await flushEffects(20);
  }
});

test('collapse removes body and aborts; reopening rejects a late response even when fetch ignores abort', async t => {
  const pending = [];
  const fx = answerHarness(t, () => { const item = deferred(); pending.push(item); return item.promise; });
  fx.toggle().click(); await flushEffects(20);
  assert.equal(fx.root.querySelector('.work-answer [role="status"]').textContent, '답변 불러오는 중');
  fx.toggle().click(); await flushEffects(20);
  assert.equal(fx.calls[0].options.signal.aborted, true);
  assert.equal(fx.root.querySelector('.work-answer'), null);
  fx.toggle().click(); await flushEffects(20);
  pending[1].resolve(response(answerEnvelope('final', '새 답변'))); await flushEffects(20);
  pending[0].resolve(response(answerEnvelope('final', '늦은 이전 답변'))); await flushEffects(20);
  assert.equal(fx.root.querySelector('.work-answer-text').textContent, '새 답변');
  fx.toggle().click(); await flushEffects(20);
  fx.toggle().click(); await flushEffects(20);
  fx.context.preact.render(null, fx.root);
  assert.equal(fx.calls[2].options.signal.aborted, true);
  pending[2].resolve(response(answerEnvelope('final', '언마운트 뒤 답변'))); await flushEffects(20);
  assert.equal(fx.root.textContent, '');
});

test('machine rev and a fresh load with the same rev collapse, abort and discard old answers', async t => {
  const pending = [];
  const fx = answerHarness(t, () => { const item = deferred(); pending.push(item); return item.promise; });
  let card = fx.card;
  for (const change of [{ machineRev: 'b'.repeat(64) }, { snapshotLoad: {} },
    { machine: { id: 'other', label: '다른 머신' } },
    { key: 'other-session', instructions: fx.card.instructions.map(row => ({ ...row, session_key: 'other-session' })) },
    { instructions: fx.card.instructions.map(row => ({ ...row, id: `next-${row.id}` })) }]) {
    fx.toggle().click(); await flushEffects(20);
    const index = fx.calls.length - 1;
    card = { ...card, ...change }; fx.render(card);
    assert.equal(fx.root.querySelector('.work-answer'), null);
    assert.equal(fx.toggle().getAttribute('aria-expanded'), 'false');
    assert.equal(fx.calls[index].options.signal.aborted, true);
    pending[index].resolve(response(answerEnvelope('final', '폐기할 이전 답변'))); await flushEffects(20);
    assert.equal(fx.root.querySelector('.work-answer'), null);
  }
  fx.toggle().click(); await flushEffects(20);
  pending.at(-1).resolve(response(answerEnvelope('final', '현재 답변'))); await flushEffects(20);
  assert.equal(fx.root.querySelector('.work-answer-text').textContent, '현재 답변');
  fx.render({ ...card, snapshotLoad: {} }); await flushEffects(20);
  assert.equal(fx.root.querySelector('.work-answer'), null);
  assert.equal(fx.toggle().getAttribute('aria-expanded'), 'false');
});

for (const view of ['manager', 'work']) test(
  `answer integration: ${view} carries list metadata, keeps initial scroll, and closes on real hook reload`, async t => {
    const env = setup(t), alpha = timelineSnapshot(t), pending = [], requests = [];
    let snapshots, lists = 0;
    env.context.fetch = (url, options) => {
      if (url.startsWith('/api/observe/answers?')) {
        const item = deferred(); pending.push(item); requests.push({ url, options }); return item.promise;
      }
      if (url === '/api/observe/snapshots') {
        lists++;
        return Promise.resolve(response({ rev: REV, answers: true,
          snapshots: [{ machine_id: 'alpha', sha256: ANSWER_REV }] }));
      }
      if (url.startsWith('/api/observe/snapshots/')) return Promise.resolve(response(alpha));
      return Promise.resolve(response({ enabled: false, targets: [] }));
    };
    const key = alpha.sessions[0].key;
    function View() {
      if (view === 'work') return env.h(env.context.AllSessionsPanel, { standalone: true, selection: { key } });
      snapshots = env.context.useSessionSnapshots();
      return env.h(env.context.SessionHubDetail, {
        data: { ...snapshots, cards: snapshots.load.snapshots.flatMap(env.context.snapshotCards) },
        selection: { key },
      });
    }
    env.render(env.h(View), env.root);
    const container = env.root.querySelector(view === 'manager' ? '.session-hub-detail' : '.work-board');
    const tracked = trackTimelineScroll(t, env, container);
    await flushEffects(); await flushEffects();
    assert.equal(requests.length, 0);
    assert.equal(container.querySelectorAll('.work-answer-toggle').length, 3);
    assert.deepEqual(tracked.writes, [900]);
    tracked.userScroll(150);
    container.querySelector('.work-answer-toggle').click(); await flushEffects(20);
    assert.equal(requests.length, 1);
    pending[0].resolve(response(answerEnvelope())); await flushEffects(20);
    assert.equal(container.querySelector('.work-answer-text').textContent, '최종 답변');
    assert.deepEqual(tracked.writes, [900]);
    assert.equal(tracked.read(), 150);
    assert.deepEqual(Array.from(container.querySelectorAll('.work-instruction'), node => node.textContent),
      ['지시 1', '지시 2', '지시 3']);
    container.querySelector('.work-answer-toggle').click(); await flushEffects(20);
    container.querySelector('.work-answer-toggle').click(); await flushEffects(20);
    if (view === 'manager') snapshots.reload();
    else Array.from(container.querySelectorAll('button')).find(button => button.textContent === '스냅샷 새로고침').click();
    await flushEffects(); await flushEffects();
    assert.equal(lists, 2);
    assert.equal(requests[1].options.signal.aborted, true);
    assert.equal(container.querySelector('.work-answer'), null);
    assert.equal(container.querySelector('.work-answer-toggle').getAttribute('aria-expanded'), 'false');
    pending[1].resolve(response(answerEnvelope('final', '이전 로드의 답변'))); await flushEffects(20);
    assert.equal(container.querySelector('.work-answer'), null);
  });
