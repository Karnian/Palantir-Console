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
  let snapshot = { state: 'idle', generation: 0, messages: [], turnInProgress: false };
  class Source {
    constructor(url) { this.url = url; streams.push(this); }
    addEventListener(name, callback) { assert.equal(name, 'snapshot'); this.receive = callback; }
    close() { this.closed = true; }
  }
  env.context.EventSource = Source;
  env.context.fetch = async (url, opts) => {
    calls.push({ url, opts });
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
  assert.ok(env.root.textContent.includes('파일 4개가 남았습니다'));
  assert.ok(env.root.textContent.includes('서버 재시작 시 대화가 사라집니다'));
  assert.deepEqual(calls.map(call => call.url), ['state', 'start', 'message', 'stop', 'clear']
    .map(name => `/api/session-hub/chat/${name}`));
  for (const call of calls) assert.equal(call.opts.credentials, 'same-origin');
  assert.equal(JSON.parse(calls[2].opts.body).text, '모든 세션');
  assert.equal(streams[0].url, '/api/session-hub/chat/stream');
  const streamed = { ...snapshot, messages: [{ role: 'assistant', text: '스트림 답' }] };
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
  env.root.querySelector('.work-event button').click(); await flushEffects();
  assert.deepEqual(copied, [`${alpha.instructions[1].id}#${alpha.instructions[1].ref}`]);
  Array.from(env.root.querySelectorAll('button')).find(button => button.textContent === '← 모든 세션').click();
  await flushEffects(); assert.equal(env.root.querySelectorAll('.work-card').length, 2);
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
    ? { state: 'running', messages: [{ role: 'assistant', text: `[[session:${alpha.sessions[0].key}@${NEXT}]]` }] }
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
  env.render(env.h(() => env.h('span', {}, env.context.useRoute())), env.root);
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
  assert.match(app, /initialPanel=\$\{routeParts\[1\] === 'all-sessions' \? 'all' : undefined\}/);
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
  const snapshot = { state: 'running', turnInProgress: false, messages: [
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
