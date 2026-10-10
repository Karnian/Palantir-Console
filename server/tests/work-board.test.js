'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');
const { createSnapshots } = require('./helpers/work-board-fixture.cjs');
const source = fs.readFileSync(path.join(__dirname, '../public/app/lib/workBoard.js'), 'utf8');
const logic = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixtures(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-board-'));
  const snapshots = createSnapshots(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return snapshots;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const drain = async () => { await Promise.resolve(); await Promise.resolve(); };

test('normalization preserves spaces, uses NFC/lowercase and matches partial words', async () => {
  const { normalizeSearch, matchText, highlightParts, matchedLines } = await logic;
  assert.deepEqual(normalizeSearch('CAFE\u0301 로그인 리다이렉트'),
    { spaced: 'café 로그인 리다이렉트', compact: 'café로그인리다이렉트' });
  assert.deepEqual(matchText('로그인 리다이렉트', '로그인리다'), { form: 1, position: 0, length: 5 });
  assert.deepEqual(matchText('리다이렉트', '다이'), { form: 0, position: 1, length: 2 });
  assert.equal(highlightParts('CAFE\u0301', 'café')[0].text, 'CAFE\u0301');
  assert.equal(highlightParts('로그인 리다이렉트', '로그인리다')[0].text, '로그인 리다');
  assert.equal(matchedLines('first\n로그인 리다이렉트\nlast', '로그인리다'), '로그인 리다이렉트');
  assert.equal(matchText('safe', '   '), null);
});

test('card conversion preserves exact instructions, recent/first, omission and all recovery states', async t => {
  const { snapshotCards } = await logic;
  const { alpha } = fixtures(t);
  const cards = snapshotCards(alpha);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].instructions.length, 2);
  assert.equal(cards[0].recent, '로그인 리다이렉트 테스트를 추가해 주세요.');
  assert.equal(cards[0].first, '인증 흐름을 검토해 주세요.');
  assert.equal(cards[0].omitFirst, false);
  assert.equal(cards[0].agent.state, 'waiting');
  const one = structuredClone(alpha);
  one.instructions = one.instructions.slice(0, 1);
  assert.equal(snapshotCards(one)[0].omitFirst, true);
  for (const state of ['unrecoverable', 'unknown']) {
    one.sessions[0].first_instruction = state;
    const card = snapshotCards(one)[0];
    assert.equal(card.first_instruction, state);
    assert.equal(card.first, null);
    assert.equal(card.omitFirst, false);
  }
});

test('ranking follows target, spacing, position, recency, last observation, lexical key deterministically', async t => {
  const { snapshotCards, rankCards } = await logic;
  const { alpha } = fixtures(t);
  const base = snapshotCards(alpha)[0];
  const make = (key, text, ts, last = ts, title = null) => ({ ...base, key, last_record_at: last,
    ai_title: title, instructions: text === null ? [] : [{ ...base.instructions[0], text, ts }] });
  const early = '2026-10-10T01:00:00.000Z', late = '2026-10-10T02:00:00.000Z';
  const cards = [
    make('title', null, late, late, '로그인리다'),
    make('compact', '로그인 리다', late),
    make('position', '앞 로그인리다', late),
    make('older', '로그인리다', early),
    make('last-old', '로그인리다', late, early),
    make('z-key', '로그인리다', late), make('a-key', '로그인리다', late),
  ];
  cards[6].instructions.push({ ...cards[6].instructions[0], id: 'duplicate', text: '로그인리다' });
  const expected = ['a-key', 'z-key', 'last-old', 'older', 'position', 'compact', 'title'];
  assert.deepEqual(rankCards(cards, '로그인리다').map(card => card.key), expected);
  assert.deepEqual(rankCards([...cards].reverse(), '로그인리다').map(card => card.key), expected);
  assert.equal(rankCards(cards, '로그인리다').length, 7);
  assert.equal(rankCards(cards, '', 'alpha', 'claude').length, 7);
  assert.equal(rankCards(cards, '', 'beta').length, 0);
  assert.deepEqual(rankCards(cards, '').slice(0, 2).map(card => card.key), ['a-key', 'compact']);
});

test('parallel loading keeps good snapshot, reports list/detail failures and exact progress', async t => {
  const { loadWorkSnapshots } = await logic;
  const { alpha } = fixtures(t);
  const pending = deferred();
  const calls = [], updates = [];
  const controller = new AbortController();
  const request = (url, { signal }) => {
    calls.push(url); assert.equal(signal, controller.signal);
    if (url.endsWith('/snapshots')) return Promise.resolve({ snapshots: [
      { machine_id: 'alpha' }, { machine_id: 'beta' }, { name_id: 'opaque', error_code: 'parse_error' },
    ] });
    if (url.endsWith('/alpha')) return Promise.resolve(alpha);
    return pending.promise;
  };
  const loading = loadWorkSnapshots(request, controller.signal, update => updates.push(update));
  await drain();
  assert.deepEqual(calls, ['/api/observe/snapshots', '/api/observe/snapshots/alpha', '/api/observe/snapshots/beta']);
  assert.equal(updates.at(-1).snapshots.length, 1);
  assert.equal(updates.at(-1).snapshots[0].machine.label, 'Mac');
  assert.equal(updates.at(-1).done, 2);
  pending.reject(new Error('raw English error'));
  await loading;
  assert.equal(updates.at(-1).done, 3);
  assert.equal(updates.at(-1).total, 3);
  assert.equal(updates.at(-1).failures.length, 2);
});

test('abort suppresses all late snapshot publications', async t => {
  const { loadWorkSnapshots } = await logic;
  const { alpha } = fixtures(t);
  for (const abortAt of ['list', 'detail']) {
    const pending = deferred(), controller = new AbortController(), updates = [];
    const request = url => url.endsWith('/snapshots') && abortAt === 'detail'
      ? Promise.resolve({ snapshots: [{ machine_id: 'alpha' }] }) : pending.promise;
    const loading = loadWorkSnapshots(request, controller.signal, update => updates.push(update));
    await drain();
    assert.equal(updates.length, abortAt === 'detail' ? 1 : 0);
    controller.abort();
    const before = updates.length;
    pending.resolve(abortAt === 'list' ? { snapshots: [] } : alpha);
    await loading;
    assert.equal(updates.length, before);
  }
});

function entryHarness(t, startObserveEntry, initial = '') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred(), states = [], writes = [];
  let hash = initial, listener, signal;
  const cleanup = startObserveEntry({
    request: (url, options) => { assert.equal(url, '/api/observe/snapshots'); signal = options.signal;
      assert.equal(options.expectedStatus, 200);
      return pending.promise; },
    getHash: () => hash, navigate: route => { writes.push(route); hash = `#${route}`; },
    subscribe: callback => { listener = callback; return () => { listener = null; }; },
    publish: state => states.push(state),
  });
  t.after(cleanup);
  return { pending, states, writes, get hash() { return hash; }, get signal() { return signal; }, cleanup,
    move: route => { hash = route; listener(); } };
}

for (const activation of ['on', 'off', 'error']) {
  test(`entry ${activation}: empty hash selects default only after timely verdict`, async t => {
    const { startObserveEntry } = await logic;
    const fx = entryHarness(t, startObserveEntry);
    assert.deepEqual(fx.states[0], { activation: 'pending', loading: true });
    t.mock.timers.tick(1499);
    if (activation === 'on') fx.pending.resolve({ snapshots: [] });
    else fx.pending.reject({ status: activation === 'off' ? 404 : 503 });
    await drain();
    assert.equal(fx.states.at(-1).activation, activation);
    assert.equal(fx.states.at(-1).loading, false);
    assert.deepEqual(fx.writes, activation === 'on' ? ['work'] : []);
  });
  test(`entry late ${activation}: fallback writes no hash and never switches the screen`, async t => {
    const { startObserveEntry } = await logic;
    const fx = entryHarness(t, startObserveEntry);
    t.mock.timers.tick(1500);
    assert.deepEqual(fx.states.at(-1), { activation: 'pending', loading: false });
    assert.equal(fx.hash, ''); assert.deepEqual(fx.writes, []);
    if (activation === 'on') fx.pending.resolve({ snapshots: [] });
    else fx.pending.reject({ status: activation === 'off' ? 404 : 500 });
    await drain();
    assert.equal(fx.states.at(-1).activation, activation);
    assert.equal(fx.states.at(-1).loading, false);
    assert.equal(fx.hash, ''); assert.deepEqual(fx.writes, []);
  });
}

for (const initial of ['#manager', '#work/subpath']) {
  test(`entry preserves explicit ${initial}`, async t => {
    const { startObserveEntry } = await logic;
    const fx = entryHarness(t, startObserveEntry, initial);
    assert.equal(fx.states[0].loading, false);
    fx.pending.resolve({ snapshots: [] }); await drain();
    assert.equal(fx.hash, initial); assert.deepEqual(fx.writes, []);
  });
}

test('entry preserves user navigation even when the user returns to empty hash', async t => {
  const { startObserveEntry } = await logic;
  const fx = entryHarness(t, startObserveEntry);
  fx.move('#board'); fx.move('');
  assert.equal(fx.states.at(-1).loading, false);
  fx.pending.resolve({ snapshots: [] }); await drain();
  assert.equal(fx.hash, ''); assert.deepEqual(fx.writes, []);
});

test('entry cleanup aborts probe and ignores late resolution', async t => {
  const { startObserveEntry } = await logic;
  const fx = entryHarness(t, startObserveEntry);
  assert.equal(fx.signal.aborted, false);
  fx.cleanup(); assert.equal(fx.signal.aborted, true);
  fx.pending.resolve({ snapshots: [] }); await drain();
  assert.equal(fx.states.length, 1); assert.deepEqual(fx.writes, []);
});

function boardEnv(t) {
  const env = createPreactEnv();
  vm.runInContext(source.replace(/\bexport /g, ''), env.context);
  vm.runInContext('this.W = WORK_BOARD_LABELS;', env.context);
  env.loadComponent('WorkBoardView');
  t.after(() => { env.render(null, env.document.getElementById('root')); env.cleanup(); });
  return env;
}

test('DOM preserves XSS instruction/title/repo as text, timeline flags and selectable copy fallback', async t => {
  const { alpha } = fixtures(t);
  const env = boardEnv(t);
  const attack = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  alpha.instructions[1].text = attack;
  alpha.sessions[0].ai_title = attack;
  alpha.sessions[0].repo_label = attack;
  env.context.apiFetch = async url => url.endsWith('/snapshots') ? { snapshots: [
    { machine_id: 'alpha', machine_label: 'Mac', generated_at: alpha.generated_at },
    { name_id: 'bad', error_code: 'parse_error' },
  ] } : alpha;
  env.render(env.h(env.context.WorkBoardView), env.document.getElementById('root'));
  await flushEffects(); await flushEffects();
  const cards = env.document.querySelectorAll('.work-card');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector('.work-recent').textContent, attack);
  assert.equal(cards[0].querySelector('.work-repo').textContent, attack);
  assert.ok(cards[0].textContent.includes(`AI 제목: ${attack}`));
  assert.ok(env.document.querySelector('.work-coverage').textContent.includes('읽지 못한 스냅샷'));
  assert.equal(env.document.querySelectorAll('img, script').length, 0);
  assert.equal(env.document.querySelectorAll('[onerror]').length, 0);
  cards[0].querySelector('button').click(); await flushEffects();
  assert.equal(cards[0].querySelectorAll('.work-event').length, 2);
  assert.equal(cards[0].querySelector('.work-instruction').textContent, attack);
  assert.ok(cards[0].textContent.includes('살균됨'));
  assert.ok(cards[0].textContent.includes('첨부 2개'));
  assert.equal(env.document.querySelectorAll('img, script').length, 0);
  cards[0].querySelector('.work-event button').click(); await flushEffects(); await flushEffects();
  const input = cards[0].querySelector('.work-selector');
  assert.equal(input.value, `${alpha.instructions[1].id}#${alpha.instructions[1].ref}`);
  assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, input.value.length);
  const query = env.document.getElementById('work-query');
  query.value = 'onerror'; query.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects();
  assert.equal(env.document.querySelectorAll('.work-card').length, 1);
  assert.equal(env.document.querySelector('.work-match mark').textContent, 'onerror');
  assert.equal(env.document.querySelectorAll('img, script').length, 0);
});

test('DOM cleanup aborts detail requests and removes data; recovery messages remain distinct', async t => {
  const { alpha, beta } = fixtures(t);
  const env = boardEnv(t), pending = deferred();
  let signal;
  env.context.apiFetch = (url, options) => {
    signal = options.signal;
    return url.endsWith('/snapshots') ? Promise.resolve({ snapshots: [{ machine_id: 'alpha' }] }) : pending.promise;
  };
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.WorkBoardView), root); await flushEffects();
  assert.equal(root.querySelector('[role="status"]').textContent, '불러오는 중 (0/1)');
  assert.equal(signal.aborted, false);
  env.render(null, root); assert.equal(signal.aborted, true);
  pending.resolve(alpha); await flushEffects(); assert.equal(root.textContent, '');
  env.context.apiFetch = async url => url.endsWith('/snapshots')
    ? { snapshots: [{ machine_id: 'alpha' }, { machine_id: 'beta' }] } : url.endsWith('alpha') ? alpha : beta;
  env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
  assert.equal(root.querySelectorAll('.work-card').length, 3);
  assert.ok(root.textContent.includes('최초 지시 복구 불가'));
  assert.ok(root.textContent.includes('최초 지시 복구 여부 불명'));
});

test('observe nav is labeled and gated in both sidebar items and palette', async t => {
  const env = createPreactEnv();
  const navSource = fs.readFileSync(path.join(__dirname, '../public/app/lib/nav.js'), 'utf8');
  vm.runInContext(navSource.replace(/^import .*$/gm, '').replace(/^export /gm, ''), env.context);
  const get = state => vm.runInContext(`getNavItems('${state}')`, env.context);
  assert.equal(get('on').length, 6);
  assert.equal(get('on')[0].label, '작업');
  assert.equal(get('on')[0].hash, 'work');
  for (const state of ['pending', 'off', 'error']) {
    assert.equal(get(state).length, 5);
    assert.equal(get(state).some(item => item.hash === 'work'), false);
  }
  env.context.useEscape = () => {};
  env.context.navigate = hash => { env.window.location.hash = hash; };
  env.loadComponent('CommandPalette');
  const root = env.document.getElementById('root');
  t.after(() => { env.render(null, root); env.cleanup(); });
  env.render(env.h(env.context.CommandPalette, { open: true, onClose: () => {}, navItems: get('on') }), root);
  await flushEffects();
  assert.equal(root.querySelectorAll('.command-palette-item').length, 6);
  assert.equal(root.querySelector('.command-palette-label').textContent, '작업');
  const input = root.querySelector('input');
  input.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: '1', bubbles: true }));
  assert.equal(env.window.location.hash, '#work');
  env.render(env.h(env.context.CommandPalette, { open: true, onClose: () => {}, navItems: get('off') }), root);
  await flushEffects();
  assert.equal(root.querySelectorAll('.command-palette-item').length, 5);
  assert.equal(root.querySelector('.command-palette-label').textContent, '매니저');
});

test('clipboard success receives exact id#ref; total failures never expose raw errors', async t => {
  const { alpha } = fixtures(t);
  const env = boardEnv(t), root = env.document.getElementById('root'), copied = [];
  Object.defineProperty(env.window.navigator, 'clipboard', { value: {
    writeText: async text => copied.push(text),
  } });
  env.context.apiFetch = async url => url.endsWith('/snapshots')
    ? { snapshots: [{ machine_id: 'alpha' }] } : alpha;
  env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
  assert.equal(root.querySelectorAll('.work-card').length, 2);
  root.querySelector('.work-card button').click(); await flushEffects();
  root.querySelector('.work-event button').click(); await flushEffects();
  assert.deepEqual(copied, [`${alpha.instructions[1].id}#${alpha.instructions[1].ref}`]);
  assert.ok(root.textContent.includes('복사됨'));
  assert.equal(root.querySelectorAll('.work-selector').length, 0);
  env.render(null, root);
  env.context.apiFetch = async () => { throw new Error('secret English sentinel'); };
  env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
  assert.equal(root.querySelector('[role="alert"]').textContent,
    '스냅샷을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  assert.equal(root.textContent.includes('secret English sentinel'), false);
});

test('strict activation HTTP status keeps apiFetch cookie transport and 401 login bounce', async () => {
  const apiSource = fs.readFileSync(path.join(__dirname, '../public/app/lib/api.js'), 'utf8');
  for (const status of [200, 201, 404, 401]) {
    const requests = [], redirects = [];
    const context = vm.createContext({ Headers,
      location: { pathname: '/', search: '', hash: '#work', replace: url => redirects.push(url) },
      fetch: async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({ snapshots: [] }), { status });
      },
    });
    vm.runInContext(apiSource.replace(/^export /gm, ''), context);
    const promise = vm.runInContext("apiFetch('/api/observe/snapshots', { expectedStatus: 200 })", context);
    if (status === 200) assert.equal((await promise).snapshots.length, 0);
    else await assert.rejects(promise, error => status === 401
      ? error.message === 'Not authenticated' : error.status === status);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.credentials, 'same-origin');
    assert.equal('expectedStatus' in requests[0].options, false);
    assert.deepEqual(redirects, status === 401 ? ['/login.html?next=%2F%23work'] : []);
  }
});
