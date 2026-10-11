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
    : url.endsWith('/chat/state') ? { epoch: 'boot', version: 0, state: 'idle', messages: [] }
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
  assert.equal(env.root.querySelectorAll('.session-hub-panel-content button.session-row').length, 2);
  const tab = label => Array.from(env.root.querySelectorAll('.session-hub-tabs button'))
    .find(node => node.textContent === label);
  tab('Palantir 작업').click(); await flushEffects();
  assert.equal(env.window.location.hash, '#manager/all-sessions');
  assert.equal(tab('Palantir 작업').getAttribute('aria-pressed'), 'true');
  assert.ok(env.root.querySelector('.manager-grid-side'));
  env.window.location.hash = 'work'; await flushEffects(); await flushEffects();
  assert.equal(env.window.location.hash, '#manager/all-sessions');
  assert.equal(tab('모든 세션').getAttribute('aria-pressed'), 'true');
  tab('Palantir 작업').click(); await flushEffects();
  env.window.location.hash = 'work'; await flushEffects(); await flushEffects();
  assert.equal(env.window.location.hash, '#manager/all-sessions');
  assert.equal(tab('모든 세션').getAttribute('aria-pressed'), 'true');
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
  const previous = { epoch: 'previous-boot', version: 40, state: 'running', turnInProgress: false,
    messages: [{ role: 'assistant', text: '이전 서버 답변' }] };
  const restarted = { epoch: 'next-boot', version: 0, state: 'idle', messages: [], turnInProgress: false };
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
    { role: 'assistant', text: '새 서버 답변' },
  ] }) }); await flushEffects();
  source.receive({ data: JSON.stringify(restarted) }); await flushEffects();
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
  assert.ok(env.root.textContent.includes('새 서버 답변'));
});

for (const [operation, replyEpoch] of [['GET', 'old'], ['POST', 'old'], ['POST', 'unseen']]) {
  test(`late ${operation} from the ${replyEpoch} epoch cannot replace a restarted server`, async t => {
    const env = setup(t), delayed = deferred();
    let source;
    const old = { epoch: 'old', version: 40, state: 'idle', messages: [], turnInProgress: false };
    const fresh = { ...old, epoch: 'fresh', version: 0, messages: [{ role: 'assistant', text: '새 서버' }] };
    env.context.EventSource = class {
      constructor() { source = this; }
      addEventListener(name, callback) { this.receive = callback; }
      close() {}
    };
    env.context.fetch = async (url, opts) => operation === 'GET' || opts.method === 'POST'
      ? delayed.promise : response(old);
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    if (operation === 'POST') { env.root.querySelector('button').click(); await flushEffects(); }
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
    const idle = { epoch: 'same', version: 0, state: 'idle', messages: [], turnInProgress: false };
    env.context.EventSource = class {
      constructor() { source = this; }
      addEventListener(name, callback) { this.receive = callback; }
      close() {}
    };
    env.context.fetch = async (url, opts) => operation === 'GET' || opts.method === 'POST'
      ? delayed.promise : response(idle);
    env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
    if (operation === 'POST') { env.root.querySelector('button').click(); await flushEffects(); }
    source.receive({ data: JSON.stringify({ ...idle, version: 1 }) }); await flushEffects();
    delayed.resolve(response({ ...idle, version: 2, state: 'running', messages: [
      { role: 'assistant', text: '더 높은 버전' },
    ] })); await flushEffects();
    assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
    assert.equal(env.root.querySelector('.manager-msg-assistant').textContent.trim(), '더 높은 버전');
  });
}

test('same-route navigation and links restore the all-sessions tab and mobile panel', async t => {
  const env = setup(t), { alpha } = fixture(t);
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async url => response(url === '/api/health' ? { sessionHubActive: true }
    : url.endsWith('/chat/state') ? { epoch: 'boot', version: 0, state: 'idle', messages: [] }
      : url.endsWith('/snapshots') ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] }
        : url.includes('/snapshots/alpha') ? alpha : { nodes: [], queued: [] });
  loadAppShell(env);
  env.window.location.hash = 'manager/all-sessions';
  env.render(env.h(env.context.App), env.root); await flushEffects(); await flushEffects(); await flushEffects();
  const tab = label => Array.from(env.root.querySelectorAll('.session-hub-tabs button'))
    .find(node => node.textContent === label);
  const link = env.document.createElement('a');
  link.href = '#manager/all-sessions'; link.textContent = '세션 패널로 이동'; env.document.body.append(link);
  for (const enter of [() => env.context.navigate('manager/all-sessions'), () => link.click()]) {
    tab('Palantir 작업').click();
    env.root.querySelector('.session-hub-segments button').click(); await flushEffects();
    assert.equal(env.root.querySelector('.session-hub-manager').dataset.pane, 'chat');
    enter(); await flushEffects(); await flushEffects();
    assert.equal(env.window.location.hash, '#manager/all-sessions');
    assert.equal(tab('모든 세션').getAttribute('aria-pressed'), 'true');
    assert.equal(env.root.querySelector('.session-hub-manager').dataset.pane, 'panel');
  }
});

test('real app panel clicks preserve the Operator conversation and hash', async t => {
  const env = setup(t), { alpha } = fixture(t), conversations = [];
  env.context.EventSource = class { addEventListener() {} close() {} };
  env.context.fetch = async url => response(url === '/api/health' ? { sessionHubActive: true }
    : url.endsWith('/chat/state') ? { epoch: 'boot', version: 0, state: 'idle', messages: [] }
      : url.endsWith('/snapshots') ? { rev: REV, snapshots: [{ machine_id: 'alpha', sha256: 'a' }] }
        : url.includes('/snapshots/alpha') ? alpha : { nodes: [], queued: [] });
  loadAppShell(env);
  env.context.useProjects = () => ({ projects: [{ id: 'p1', name: 'Project 1', pm_enabled: 1 }] });
  env.context.useConversation = target => {
    conversations.push(target); return { events: [], queuedMessages: [] };
  };
  env.window.location.hash = 'manager/operator/p1';
  env.render(env.h(env.context.App), env.root); await flushEffects(); await flushEffects(); await flushEffects();
  const tab = label => Array.from(env.root.querySelectorAll('.session-hub-tabs button'))
    .find(node => node.textContent === label);
  assert.ok(conversations.includes('operator:p1'));
  for (const label of ['Palantir 작업', '모든 세션', 'Palantir 작업']) {
    tab(label).click(); await flushEffects(); await flushEffects();
    assert.equal(env.window.location.hash, '#manager/operator/p1');
    assert.equal(env.root.querySelector('.session-hub-picker .dropdown-button').dataset.value, 'operator:p1');
    assert.equal(env.root.querySelector('.session-hub-chat'), null);
    assert.ok(env.root.querySelector('.manager-panel-title').textContent.includes('Project 1'));
    assert.equal(conversations.at(-1), 'operator:p1');
  }
});

test('late GET and stale SSE cannot undo newer POST state or messages', async t => {
  const env = setup(t), get = deferred(), calls = [];
  let source;
  const idle = { epoch: 'boot', version: 0, state: 'idle', messages: [], turnInProgress: false };
  const running = { ...idle, version: 2, state: 'running' };
  const answered = { ...running, version: 4, messages: [{ role: 'user', text: '보존할 질문' }] };
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
  env.root.querySelector('button').click(); await flushEffects();
  const input = env.root.querySelector('textarea');
  input.value = '보존할 질문'; input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects(); env.root.querySelector('button[type="submit"]').click(); await flushEffects();
  get.resolve(response(idle)); await flushEffects();
  assert.equal(env.root.querySelector('.manager-status-badge').textContent, '조회 준비됨');
  assert.equal(env.root.querySelector('.manager-msg-user').textContent, '보존할 질문');
  source.receive({ data: JSON.stringify({ ...idle, version: 1 }) }); await flushEffects();
  assert.ok(env.root.querySelector('.manager-msg-user'));
  source.receive({ data: JSON.stringify({ ...answered, version: 5, messages: [
    ...answered.messages, { role: 'assistant', text: '최신 답변' },
  ] }) }); await flushEffects();
  source.receive({ data: JSON.stringify({ ...idle, version: 5 }) }); await flushEffects();
  assert.equal(env.root.querySelector('.manager-msg-assistant').textContent.trim(), '최신 답변');
  for (const call of calls) assert.match(call.url, /^\/api\/session-hub\/chat\//);
});

for (const success of [true, false]) {
  test(`message completion after newer SSE ${success ? 'clears input once' : 'preserves failed input'}`, async t => {
    const env = setup(t), post = deferred(), calls = [];
    let source;
    const running = { epoch: 'boot', version: 2, state: 'running', messages: [], turnInProgress: false };
    const sent = { ...running, version: 3, turnInProgress: true,
      messages: [{ role: 'user', text: '한 번만 보낼 질문' }] };
    const answered = { ...sent, version: 5, turnInProgress: false,
      messages: [...sent.messages, { role: 'assistant', text: '최신 답변' }] };
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

test('a start reply matching the SSE version clears only the local starting indicator', async t => {
  const env = setup(t), start = deferred();
  let source;
  const idle = { epoch: 'boot', version: 0, state: 'idle', messages: [], turnInProgress: false };
  const running = { ...idle, version: 1, state: 'running' };
  env.context.EventSource = class {
    constructor() { source = this; }
    addEventListener(name, callback) { this.receive = callback; }
    close() {}
  };
  env.context.fetch = async url => url.endsWith('/start') ? start.promise : response(idle);
  env.render(env.h(env.context.SessionHubChat), env.root); await flushEffects(); await flushEffects();
  env.root.querySelector('button').click(); await flushEffects();
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
  env.root.querySelector('button').click();
  assert.deepEqual(opened, [[key, REV]]);
});

test('all chat actions share one fetch spy and dedicated SSE; incomplete clear shows remaining', async t => {
  const env = setup(t), calls = [], streams = [];
  let snapshot = { epoch: 'boot', version: 0, state: 'idle', generation: 0, messages: [], turnInProgress: false };
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
    if (url.endsWith('/message')) snapshot = { ...snapshot, messages: [{ role: 'user', text: '모든 세션' }] };
    return response(url.endsWith('/clear') ? { ...snapshot, messages: [], result: 'incomplete', remaining: 4 }
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
  await click('중지'); await click('대화 지우기');
  assert.ok(env.root.querySelector('.session-hub-messages .session-hub-note[role="status"]'));
  assert.ok(env.root.textContent.includes('파일 4개가 남았습니다'));
  assert.ok(env.root.textContent.includes('서버 재시작 시 대화가 사라집니다'));
  assert.deepEqual(calls.map(call => call.url), ['state', 'start', 'message', 'stop', 'clear']
    .map(name => `/api/session-hub/chat/${name}`));
  for (const call of calls) assert.equal(call.opts.credentials, 'same-origin');
  assert.equal(JSON.parse(calls[2].opts.body).text, '모든 세션');
  assert.equal(streams[0].url, '/api/session-hub/chat/stream');
  const streamed = { ...snapshot, version: snapshot.version + 1, messages: [
    { role: 'assistant', text: '스트림 답' },
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
    ? { epoch: 'boot', version: 0, state: 'running', messages: [
      { role: 'assistant', text: `[[session:${alpha.sessions[0].key}@${NEXT}]]` },
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
  assert.equal(env.root.querySelector('[aria-label="대화 선택, 세션 비서"]').dataset.value, 'hub');
  assert.ok(env.root.querySelector('.work-header').textContent.includes('답변 뒤 갱신됨'));
  env.root.querySelector('button.session-evidence').click(); await flushEffects();
  assert.equal(env.root.querySelector('.manager-view').dataset.pane, 'panel');
  assert.equal(env.root.querySelectorAll('.work-event').length, 2);
  Array.from(env.root.querySelectorAll('button')).find(button => button.textContent === 'Palantir 작업').click();
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
  const snapshot = { epoch: 'boot', version: 0, state: 'running', turnInProgress: false, messages: [
    { role: 'user', text: '리뷰해' },
    { role: 'tool', name: 'mcp__session_hub__search_instructions', text: '{"q":"리뷰해","cursor":"SECRET"}' },
    { role: 'tool', name: 'mcp__session_hub__list_sessions', text: '{"machine":"alpha","provider":"codex"}' },
    { role: 'tool', name: 'mcp__session_hub__get_session', text: JSON.stringify({ key }) },
    { role: 'assistant', text: '## 검토 결과\n\n- 완료' },
    { role: 'error', text: 'session_hub_socket_path_too_long' },
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
  const idle = { epoch: 'boot', version: 0, state: 'idle', messages: [], turnInProgress: false };
  const running = { ...idle, version: 1, state: 'running' };
  env.context.EventSource = class { addEventListener() {} close() {} };
  let failStart = false;
  env.context.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/start')) return failStart
      ? response({ error: 'session_hub_binary_unavailable' }, 503) : starting.promise;
    if (url.endsWith('/message')) return response({ ...running, version: 2, messages: [
      { role: 'user', text: JSON.parse(opts.body).text },
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
  assert.deepEqual(calls.map(call => call.url), ['state', 'start'].map(name => `/api/session-hub/chat/${name}`));
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

test('row metadata has exact separator spacing and omits unknown Orca while detail retains it', t => {
  const env = setup(t), { alpha } = fixture(t);
  const card = env.context.snapshotCards(alpha)[0];
  const now = Date.parse(card.last_record_at) + 2 * 3600000;
  const props = { card, now, query: '', onOpen: () => {} };
  card.machine.label = 'codev2'; card.repo_label = 'c2'; card.agent = { state: 'running' };
  env.render(env.h(env.context.SessionRow, props), env.root);
  assert.equal(env.root.querySelector('.work-meta').textContent, 'codev2 · c2 · 2시간 전 · Orca 실행 중');
  card.agent = { state: 'unknown' };
  env.render(env.h(env.context.SessionRow, { ...props }), env.root);
  assert.equal(env.root.querySelector('.work-meta').textContent, 'codev2 · c2 · 2시간 전');
  assert.equal(env.root.querySelector('.work-orca'), null);
  env.render(env.h(env.context.SessionCard, { ...props, timeline: true }), env.root);
  assert.match(env.root.querySelector('.work-orca').textContent, /Orca · 불명/);
  card.orca_link.confirmed = false; card.agent = { state: 'running' };
  env.render(env.h(env.context.SessionRow, { ...props }), env.root);
  assert.equal(env.root.querySelector('.work-orca'), null);
});

test('automatic start never sends after a cancelled start or after the chat unmounts', async t => {
  const env = setup(t), calls = [];
  const idle = { epoch: 'boot', version: 0, state: 'idle', messages: [], turnInProgress: false };
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
