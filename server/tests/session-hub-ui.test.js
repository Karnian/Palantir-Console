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
  env.context.EventSource = class {
    constructor() { source = this; }
    addEventListener(name, callback) { this.receive = callback; }
    close() {}
  };
  env.context.fetch = async () => response(previous);
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
  assert.ok(env.root.textContent.includes('이전 서버 답변'));
  source.onerror(); await flushEffects();
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
    env.context.EventSource = class {
      constructor() { source = this; }
      addEventListener(name, callback) { this.receive = callback; }
      close() {}
    };
    env.context.fetch = async (url, opts) => operation === 'GET' || opts.method === 'POST'
      ? delayed.promise : response(old);
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    if (operation === 'POST') { env.root.querySelector('[data-action="start"]').click(); await flushEffects(); }
    source.receive({ data: JSON.stringify(fresh) }); await flushEffects();
    delayed.resolve(response({ ...old, epoch: replyEpoch, state: 'running' })); await flushEffects();
    assert.equal(env.root.querySelector('.manager-status-badge').textContent, '중지됨');
    assert.equal(env.root.querySelector('.manager-msg-assistant').textContent.trim(), '새 서버');
    // Once accepted, a retired epoch must also be rejected through ordered SSE.
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
      return response(url.endsWith('/start') ? { ...fresh, version: 1, state: 'running' } : old);
    };
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    const input = env.root.querySelector('textarea'), submit = env.root.querySelector('button[type="submit"]');
    input.value = question; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await flushEffects(); submit.click(); await flushEffects();
    assert.equal(input.disabled, true);
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
  env.root.querySelector('.work-event button').click(); await flushEffects();
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
  const original = require('node:child_process').execFileSync('git',
    ['show', 'origin/main:server/public/app/components/ManagerView.js'], { encoding: 'utf8' });
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

for (const operation of ['add', 'edit']) for (const newer of ['new-form', 'content', 'kind']) test(
  `R2 delayed memory ${operation} keeps newer ${newer} draft`, async t => {
    const env = setup(t), delayed = deferred(), posts = [];
    let item = { id: 'm1', content: '기존 기억', kind: 'fact', status: 'active', revision: 2 };
    env.context.fetch = async (url, options = {}) => {
      assert.match(url, /^\/api\/session-hub\/memory/);
      if (options.method === 'POST' || options.method === 'PATCH') {
        posts.push({ url, body: JSON.parse(options.body) });
        if (posts.length === 1) await delayed.promise;
        item = { ...item, ...JSON.parse(options.body), revision: item.revision + 1 }; return response(item);
      }
      return response({ memories: [item], proposals: [], pending_count: 0 });
    };
    env.render(env.h(env.context.AssistantMemoryView), env.root); await flushEffects(); await flushEffects();
    const click = async label => {
      Array.from(env.root.querySelectorAll('button')).find(node => node.textContent.trim() === label).click();
      await flushEffects();
    };
    const type = async text => {
      const input = env.root.querySelector('textarea'); input.value = text;
      input.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
    };
    await click(operation === 'add' ? '기억 추가' : '수정'); await type('내용 A'); await click('저장');
    if (newer === 'new-form') await click('기억 추가');
    if (newer === 'kind') {
      env.root.querySelector('[aria-label^="기억 종류,"]').click(); await flushEffects();
      Array.from(env.root.querySelectorAll('[role="option"]')).find(node => node.textContent === '인물').click();
      await flushEffects();
    } else await type('내용 B');
    delayed.resolve(); await flushEffects(); await flushEffects();
    const input = env.root.querySelector('textarea'); assert.ok(input, 'newer form must stay open');
    assert.equal(input.value, newer === 'kind' ? '내용 A' : '내용 B');
    if (newer === 'kind') assert.ok(env.root.querySelector('[aria-label="기억 종류, 인물"]'));
    assert.equal(posts[0].body.content, '내용 A');
    await click('저장'); assert.equal(env.root.querySelector('textarea'), null);
    assert.equal(posts[1].body.content, newer === 'kind' ? '내용 A' : '내용 B');
    if (operation === 'edit' && newer !== 'new-form') assert.equal(posts[1].body.revision, 3);
  });
