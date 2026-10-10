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

const commandText = (name, args = '') =>
  `<command-name>${name}</command-name><command-args>${args}</command-args>`;

test('command display accepts tag combinations and every order, preferring name over message', async () => {
  const { displayInstructionText } = await logic;
  const tags = ['<command-message>fallback</command-message>',
    '<command-name>///deep-research</command-name>', '<command-args></command-args>'];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const order of orders) {
    const text = order.map(index => tags[index]).join('\n \t');
    assert.equal(displayInstructionText(` \n${text}\t `), '/deep-research');
  }
  const cases = [
    [tags[1], '/deep-research'],
    ['<command-message>deep-research</command-message>', '/deep-research'],
    ['<command-name></command-name><command-message>/deep-research</command-message>', '/deep-research'],
    [commandText('/review', 'scripts/lib'), '/review scripts/lib'],
    ['<command-args>scripts/lib</command-args><command-message>review</command-message>', '/review scripts/lib'],
    [commandText('review', '  scripts/lib\n[REDACTED] &lt;secret&gt;  '),
      '/review   scripts/lib\n[REDACTED] &lt;secret&gt;  '],
    [commandText('review', '<img src=x onerror=alert(1)>'), '/review <img src=x onerror=alert(1)>'],
    [commandText('review', ' '), '/review  '],
  ];
  for (const [text, expected] of cases) assert.equal(displayInstructionText(text), expected);
});

test('command display preserves outside text, unknown tags and incomplete wrappers exactly', async () => {
  const { displayInstructionText } = await logic;
  const wrapper = commandText('/review', 'scripts/lib');
  const cases = [
    '', ' \nplain instruction\t ', ' \t\n ',
    `Please run ${wrapper}`, `${wrapper}\nThen explain the result.`,
    `  ${wrapper}\n<unknown>extra</unknown>  `,
    '<command-name>review</command-message>', '<command-name>review',
    '<command-name data-x="1">review</command-name>', '<command-args>scripts/lib</command-args>',
  ];
  for (const text of cases) assert.equal(displayInstructionText(text), text);
});

test('card display unwraps before selecting lines and deduplicates display strings while search stays raw', async t => {
  const { snapshotCards, rankCards } = await logic;
  const { alpha } = fixtures(t);
  alpha.sessions = alpha.sessions.slice(0, 1);
  alpha.sessions[0].ai_title = null;
  alpha.instructions = alpha.instructions.slice(0, 2);
  const first = '<command-message>fallback</command-message>\n'
    + '<command-args>scripts/lib\n[REDACTED]</command-args>\n<command-name>//review</command-name>';
  alpha.instructions[0].text = first;
  alpha.instructions[1].text = '/review scripts/lib';
  const card = snapshotCards(alpha)[0];
  assert.equal(card.title, '/review scripts/lib');
  assert.equal(card.first, '/review scripts/lib');
  assert.equal(card.recent, '/review scripts/lib');
  assert.equal(card.omitRecent, true);
  assert.equal(card.showFirst, false);
  assert.equal(card.instructions[0].text, first);
  assert.equal(rankCards([card], 'command-name')[0].match.text, first);
  assert.equal(rankCards([card], '/review scripts/lib').length, 1);
  assert.equal(rankCards([{ ...card, instructions: [card.instructions[0]] }], '/review scripts/lib').length, 0);
  alpha.instructions[1].text = `${commandText('review', 'scripts/lib')}\nOutside text`;
  assert.equal(snapshotCards(alpha)[0].recent, commandText('review', 'scripts/lib'));
  alpha.sessions[0].ai_title = commandText('review', 'scripts/lib');
  const titled = snapshotCards(alpha)[0];
  assert.equal(titled.title, '/review scripts/lib');
  assert.equal(titled.ai_title, alpha.sessions[0].ai_title);
  assert.equal(rankCards([{ ...titled, instructions: [] }], 'command-name')[0].match.target, 1);
});

test('DOM displays command cards, timeline and raw search matches as safe literal text', async t => {
  const { alpha } = fixtures(t);
  alpha.sessions = alpha.sessions.slice(0, 1);
  alpha.instructions = alpha.instructions.slice(0, 2);
  alpha.sessions[0].ai_title = '/review scripts/lib';
  alpha.instructions[0].text = '<command-message>deep-research</command-message>\n<command-args></command-args>';
  const attack = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const args = `scripts/lib [REDACTED] ${attack}\n&lt;literal&gt;`;
  alpha.instructions[1].text = commandText('///review', args);
  const env = boardEnv(t), root = env.document.getElementById('root');
  env.context.apiFetch = async url => url.endsWith('/snapshots') ? { snapshots: [{ machine_id: 'alpha' }] } : alpha;
  env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
  assert.equal(root.querySelector('.work-title').textContent, '/review scripts/lib');
  assert.equal(root.querySelector('.work-recent').textContent, `/review scripts/lib [REDACTED] ${attack}`);
  assert.equal(root.querySelector('.work-first').textContent, '/deep-research');
  root.querySelector('.work-card button').click(); await flushEffects();
  const timeline = Array.from(root.querySelectorAll('.work-instruction'), node => node.textContent);
  assert.deepEqual(timeline, [`/review ${args}`, '/deep-research']);
  for (const term of ['command-name', 'onerror', '[REDACTED]', 'command-message']) {
    const query = root.querySelector('#work-query');
    query.value = term; query.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await flushEffects();
    assert.equal(root.querySelectorAll('.work-card').length, 1);
    const match = root.querySelector('.work-match');
    if (term.startsWith('command-')) {
      assert.equal(match.querySelectorAll('mark').length, 0);
      assert.equal(match.querySelector('p').textContent,
        term === 'command-name' ? `/review ${args}` : '/deep-research');
    } else {
      assert.equal(match.querySelector('mark').textContent, term);
      assert.equal(match.querySelector('p').textContent, `/review scripts/lib [REDACTED] ${attack}`);
    }
    assert.equal(root.querySelectorAll('img, script, [onerror]').length, 0);
    assert.equal(root.querySelectorAll('command-name, command-message, command-args').length, 0);
  }
});

test('DOM command card rows use the existing display deduplication priority', async t => {
  const { alpha } = fixtures(t);
  const env = boardEnv(t), root = env.document.getElementById('root');
  const cases = [
    { ai: null, first: commandText('review', 'scripts/lib'), recent: '/review scripts/lib', omit: true, show: false },
    { ai: '/review scripts/lib', first: commandText('deep-research'),
      recent: commandText('///review', 'scripts/lib'), omit: true, show: true },
    { ai: 'AI title', first: commandText('review', 'scripts/lib'),
      recent: '/review scripts/lib', omit: false, show: false },
    { ai: '/review scripts/lib', first: commandText('review', 'scripts/lib'),
      recent: commandText('deep-research'), omit: false, show: false },
  ];
  for (const variant of cases) {
    const snapshot = structuredClone(alpha);
    snapshot.sessions = snapshot.sessions.slice(0, 1);
    snapshot.sessions[0].ai_title = variant.ai;
    snapshot.instructions = snapshot.instructions.slice(0, 2);
    snapshot.instructions[0].text = variant.first;
    snapshot.instructions[1].text = variant.recent;
    env.context.apiFetch = async url => url.endsWith('/snapshots')
      ? { snapshots: [{ machine_id: 'alpha' }] } : snapshot;
    env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
    const check = () => {
      assert.equal(root.querySelector('.work-title').textContent, variant.ai || '/review scripts/lib');
      assert.equal(root.querySelectorAll('.work-recent-block').length, variant.omit ? 0 : 1);
      assert.equal(root.querySelectorAll('.work-first-block').length, variant.show ? 1 : 0);
    };
    check();
    const query = root.querySelector('#work-query');
    query.value = 'command-name'; query.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await flushEffects(); check();
    env.render(null, root);
  }
});

test('recent instruction placeholders distinguish blank text from zero instructions', async t => {
  const { snapshotCards } = await logic;
  const { alpha } = fixtures(t);
  const env = boardEnv(t), root = env.document.getElementById('root');
  const cases = [
    { text: ' \t\n\u00a0 ', expected: '텍스트 없는 지시' },
    { text: '', expected: '텍스트 없는 지시' },
    { text: '', missing: true, expected: '텍스트 없는 지시' },
    { empty: true, expected: '관측된 지시 없음' },
    { text: '진행해 주세요.', expected: '진행해 주세요.' },
  ];
  for (const variant of cases) {
    const snapshot = structuredClone(alpha);
    snapshot.sessions = snapshot.sessions.slice(0, 1);
    snapshot.instructions = variant.empty ? [] : snapshot.instructions.slice(1, 2);
    snapshot.sessions[0].instruction_count = snapshot.instructions.length;
    if (!variant.empty) Object.assign(snapshot.instructions[0], {
      text: variant.text, text_missing: !!variant.missing,
    });
    const card = snapshotCards(snapshot)[0];
    assert.equal(card.title, '합성 세션 검토');
    assert.equal(card.instructions.length, variant.empty ? 0 : 1);
    assert.equal(card.recent, variant.text?.trim() ? variant.text : null);
    assert.equal(card.recentMissing, !!variant.missing);
    env.context.apiFetch = async url => url.endsWith('/snapshots')
      ? { snapshots: [{ machine_id: 'alpha' }] } : snapshot;
    env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
    assert.equal(root.querySelectorAll('.work-card').length, 1);
    assert.equal(root.querySelector('.work-title').textContent, '합성 세션 검토');
    assert.equal(root.querySelector('.work-recent').textContent, variant.expected);
    const query = root.querySelector('#work-query');
    query.value = '합성'; query.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    await flushEffects();
    assert.equal(root.querySelectorAll('.work-card').length, 1);
    assert.equal(root.querySelector('.work-recent').textContent, variant.expected);
    env.render(null, root);
  }
});

test('card line priority compares normalized display strings in normal and search cards', async t => {
  const { snapshotCards } = await logic;
  const { alpha } = fixtures(t);
  const env = boardEnv(t), root = env.document.getElementById('root');
  const cases = [
    { ai: '로그인 수정', first: '설계 검토', recent: '로그인 수정', omit: true, show: true },
    { ai: '설계 검토', first: '설계 검토', recent: '로그인 수정', omit: false, show: false },
    { ai: '세션 검토', first: '로그인 수정', recent: '로그인 수정', omit: false, show: false },
    { ai: '로그인 수정', first: '로그인 수정', recent: '로그인 수정', omit: true, show: false },
    { ai: null, first: '로그인 수정', recent: '로그인 수정', omit: true, show: false,
      state: 'unrecoverable' },
    { ai: null, first: '로그인 수정', recent: '로그인 수정', omit: true, show: false, state: 'unknown' },
    { ai: '  CAFÉ\t로그인  수정  ', first: '설계 검토', recent: 'CAFE\u0301 로그인   수정',
      omit: true, show: true },
    { ai: '세션 검토', first: '  로그인\t수정  ', recent: '로그인   수정', omit: false, show: false },
    { ai: 'LOGIN 수정', first: '설계 검토', recent: 'login 수정', omit: false, show: true },
    { ai: '텍스트 없는 지시', first: '설계 검토', recent: '', missing: true, omit: true, show: true },
    { ai: '세션 검토', first: '텍스트 없는 지시', recent: '', missing: true, omit: false, show: false },
  ];
  for (const variant of cases) {
    const snapshot = structuredClone(alpha);
    snapshot.sessions = snapshot.sessions.slice(0, 1);
    Object.assign(snapshot.sessions[0], { ai_title: variant.ai,
      first_instruction: variant.state || 'recoverable' });
    snapshot.instructions = snapshot.instructions.slice(0, 2);
    snapshot.instructions[0].text = variant.first;
    Object.assign(snapshot.instructions[1], { text: variant.recent, text_missing: !!variant.missing });
    const card = snapshotCards(snapshot)[0];
    if (!variant.missing) {
      assert.equal(card.title, variant.ai || variant.first);
      assert.equal(card.omitRecent, variant.omit);
      assert.equal(card.showFirst, variant.show);
    }
    env.context.apiFetch = async url => url.endsWith('/snapshots')
      ? { snapshots: [{ machine_id: 'alpha' }] } : snapshot;
    env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
    const check = () => {
      assert.equal(root.querySelectorAll('.work-card').length, 1);
      assert.equal(root.querySelector('.work-title').textContent, variant.ai || variant.first);
      assert.equal(root.querySelectorAll('.work-recent-block').length, variant.omit ? 0 : 1);
      assert.equal(root.querySelectorAll('.work-first-block').length, variant.show ? 1 : 0);
      const status = variant.state === 'unknown' ? '최초 지시 확인 불가' : '최초 지시 복구 불가';
      assert.deepEqual(Array.from(root.querySelectorAll('.work-first-status'), node => node.textContent),
        variant.state ? [status] : []);
    };
    check();
    const query = root.querySelector('#work-query');
    query.value = variant.state ? '로그인' : '검토 수정 지시'.split(' ').find(word =>
      [variant.ai, variant.first, variant.recent].some(text => text?.includes(word)));
    query.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
    check();
    env.render(null, root);
  }
});

test('whitespace-only AI titles fall back to the first text instruction', async t => {
  const { snapshotCards } = await logic;
  const { alpha } = fixtures(t);
  alpha.sessions = alpha.sessions.slice(0, 1);
  alpha.sessions[0].ai_title = ' \t\n\u00a0 ';
  const card = snapshotCards(alpha)[0];
  assert.equal(card.title, '인증 흐름을 검토해 주세요.');
  assert.equal(card.titleSource, 'first');
  assert.equal(card.showFirst, false);
  const env = boardEnv(t), root = env.document.getElementById('root');
  env.context.apiFetch = async url => url.endsWith('/snapshots') ? { snapshots: [{ machine_id: 'alpha' }] } : alpha;
  env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
  assert.equal(root.querySelectorAll('.work-card').length, 1);
  assert.equal(root.querySelector('.work-title').textContent, '인증 흐름을 검토해 주세요.');
  assert.equal(root.querySelector('.work-title').previousElementSibling.textContent, '처음');
  assert.equal(root.querySelectorAll('.work-first-block').length, 0);
});

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
  assert.equal(cards[0].title, '합성 세션 검토');
  assert.equal(cards[0].titleSource, 'ai');
  assert.equal(cards[0].showFirst, true);
  assert.equal(cards[0].recentAt, alpha.instructions[1].ts);
  assert.equal(cards[0].omitRecent, false);
  assert.equal(cards[0].agent.state, 'waiting');
  const one = structuredClone(alpha);
  one.instructions = one.instructions.slice(0, 1);
  assert.equal(snapshotCards(one)[0].omitRecent, false);
  assert.equal(snapshotCards(one)[0].showFirst, false);
  one.sessions[0].ai_title = null;
  const fallback = snapshotCards(one)[0];
  assert.equal(fallback.title, '인증 흐름을 검토해 주세요.');
  assert.equal(fallback.titleSource, 'first');
  assert.equal(fallback.showFirst, false);
  one.sessions[0].ai_title = '';
  assert.equal(snapshotCards(one)[0].title, '인증 흐름을 검토해 주세요.');
  assert.equal(snapshotCards(one)[0].showFirst, false);
  for (const state of ['unrecoverable', 'unknown']) {
    one.sessions[0].first_instruction = state;
    const card = snapshotCards(one)[0];
    assert.equal(card.first_instruction, state);
    assert.equal(card.first, null);
    assert.equal(card.title, '인증 흐름을 검토해 주세요.');
    assert.equal(card.titleSource, 'first');
    assert.equal(card.showFirst, false);
    assert.equal(card.omitRecent, true);
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
  assert.equal(cards[0].querySelector('.work-repo').textContent, attack);
  assert.equal(cards[0].querySelector('.work-title').textContent, attack);
  assert.equal(cards[0].querySelectorAll('.work-recent-block').length, 0);
  assert.equal(cards[0].querySelector('.work-title').previousElementSibling.textContent, 'AI 제목');
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
  assert.deepEqual(Array.from(root.querySelectorAll('.work-title'), node => node.textContent),
    ['합성 세션 검토', '이미지 크기별 결과를 정리해 주세요.',
      '주간 보고 초안을 작성해 주세요.']);
  assert.deepEqual(Array.from(root.querySelectorAll('.work-first-status'), node => node.textContent),
    ['최초 지시 복구 불가', '최초 지시 확인 불가']);
});

test('attachment-first title instruction hides the same recent seq in normal and search cards', async t => {
  const { snapshotCards } = await logic;
  const { alpha } = fixtures(t);
  alpha.sessions = alpha.sessions.slice(0, 1);
  alpha.sessions[0].ai_title = null;
  alpha.instructions = alpha.instructions.slice(0, 2);
  Object.assign(alpha.instructions[0], { text: '', text_missing: true, attachments: 1 });
  alpha.instructions[1].text = '검색 가능한 첫 텍스트';
  assert.equal(snapshotCards(alpha)[0].title, '검색 가능한 첫 텍스트');
  assert.equal(snapshotCards(alpha)[0].omitRecent, true);
  alpha.sessions[0].ai_title = 'AI 제목';
  assert.equal(snapshotCards(alpha)[0].omitRecent, false);
  alpha.sessions[0].ai_title = null;
  const env = boardEnv(t), root = env.document.getElementById('root');
  env.context.apiFetch = async url => url.endsWith('/snapshots') ? { snapshots: [{ machine_id: 'alpha' }] } : alpha;
  env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
  assert.equal(root.querySelector('.work-title').textContent, '검색 가능한 첫 텍스트');
  assert.equal(root.querySelectorAll('.work-recent-block').length, 0);
  const query = root.querySelector('#work-query');
  query.value = '검색가능'; query.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects();
  assert.equal(root.querySelectorAll('.work-card').length, 1);
  assert.equal(root.querySelector('.work-title').textContent, '검색 가능한 첫 텍스트');
  assert.equal(root.querySelectorAll('.work-recent-block').length, 0);
});

test('display lines skip leading empty lines and whitespace-only title candidates', async t => {
  const { snapshotCards } = await logic;
  const { alpha } = fixtures(t);
  alpha.sessions[0].ai_title = null;
  alpha.instructions[0].text = '\n \t\n로그인 고쳐 주세요.\n둘째 줄';
  alpha.instructions[1].text = '\r\n\r\n최근 지시';
  const card = snapshotCards(alpha)[0];
  assert.equal(card.title, '로그인 고쳐 주세요.');
  assert.equal(card.first, '로그인 고쳐 주세요.');
  assert.equal(card.recent, '최근 지시');
  alpha.instructions[0].text = '\n \t\n';
  assert.equal(snapshotCards(alpha)[0].title, '최근 지시');
});

test('recovery status remains visible with AI titles and text titles, including search results', async t => {
  const { alpha } = fixtures(t);
  const env = boardEnv(t), root = env.document.getElementById('root');
  const states = [['unrecoverable', '최초 지시 복구 불가'], ['unknown', '최초 지시 확인 불가']];
  for (const [state, message] of states) {
    for (const title of ['AI 세션 제목', null]) {
      const snapshot = structuredClone(alpha);
      snapshot.sessions = snapshot.sessions.slice(0, 1);
      Object.assign(snapshot.sessions[0], { first_instruction: state, ai_title: title });
      env.context.apiFetch = async url => url.endsWith('/snapshots')
        ? { snapshots: [{ machine_id: 'alpha' }] } : snapshot;
      env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
      assert.equal(root.querySelectorAll('.work-card').length, 1);
      assert.equal(root.querySelector('.work-title').textContent, title || '인증 흐름을 검토해 주세요.');
      assert.deepEqual(Array.from(root.querySelectorAll('.work-first-status'), node => node.textContent), [message]);
      const query = root.querySelector('#work-query');
      query.value = '로그인'; query.dispatchEvent(new env.window.Event('input', { bubbles: true }));
      await flushEffects();
      assert.equal(root.querySelectorAll('.work-card').length, 1);
      assert.equal(root.querySelector('.work-first-status').textContent, message);
      env.render(null, root);
    }
  }
});

for (const [status, reason, bounces] of [[403, 'cookie auth required', false], [403, null, true], [401, null, true]]) {
  test(`observe API ${status} reason=${reason}: activation, list and detail preserve auth contract`, async t => {
    const { startObserveEntry, loadWorkSnapshots } = await logic;
    const apiSource = fs.readFileSync(path.join(__dirname, '../public/app/lib/api.js'), 'utf8');
    const redirects = [], requests = [];
    let goodList = false;
    const context = vm.createContext({ Headers, location: { hash: '', pathname: '/', search: '',
      replace: url => redirects.push(url) }, fetch: async (url, options) => {
      requests.push([url, options]);
      const isList = goodList && url.endsWith('/snapshots');
      return new Response(JSON.stringify(isList ? { snapshots: [{ machine_id: 'alpha' }] }
        : reason ? { reason } : {}), { status: isList ? 200 : status });
    } });
    vm.runInContext(apiSource.replace(/\bexport /g, ''), context);
    const states = [], writes = [];
    const cleanup = startObserveEntry({ request: context.apiFetch, getHash: () => '',
      navigate: hash => writes.push(hash), subscribe: () => () => {}, publish: state => states.push(state),
      setTimer: () => 1, clearTimer: () => {} });
    t.after(cleanup);
    // The API response body introduces additional promise turns.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(states.at(-1).activation, 'error');
    assert.deepEqual(writes, []);
    assert.equal(redirects.length, bounces ? 1 : 0);
    const controller = new AbortController();
    await assert.rejects(loadWorkSnapshots(context.apiFetch, controller.signal, () => {}));
    assert.equal(redirects.length, bounces ? 2 : 0);
    goodList = true;
    const updates = [];
    const detailLoad = loadWorkSnapshots(context.apiFetch, controller.signal, state => updates.push(state));
    if (bounces) await assert.rejects(detailLoad, /Not authenticated/);
    else await detailLoad;
    assert.equal(updates.at(-1).failures.length, 1);
    assert.equal(redirects.length, bounces ? 3 : 0);
    assert.equal(requests.length, 4);
    assert.equal(requests.at(-1)[0], '/api/observe/snapshots/alpha');
    assert.equal(requests.every(([, options]) => options.credentials === 'same-origin'), true);
    assert.equal(redirects.every(url => url === '/login.html?next=%2F'), true);
  });
}

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

test('coverage aggregates every board counter and renders machine totals with Korean Orca status', async t => {
  const { coverageCounts } = await logic;
  const { alpha } = fixtures(t);
  Object.assign(alpha.coverage.claude, {
    files_scanned: 3, files_skipped: 2, files_failed: 1, excluded_sessions: 4,
    deleted_instructions: 5, records_unknown: 6, records_unverified: 7,
    multi_file_withheld: 1, mixed_session_withheld: 2, invalid_time_withheld: 3,
  });
  Object.assign(alpha.coverage.codex, {
    files_scanned: 8, files_failed: 9, excluded_sessions: 10, deleted_instructions: 11,
    records_unknown: 12, records_unverified: 13, exec_sessions_excluded: 14, withheld_sessions: 15,
    multi_file_withheld: 4, mixed_session_withheld: 5, invalid_time_withheld: 6,
  });
  const expected = { scanned: 11, skipped: 2, failed: 10, excluded: 14, deleted: 16,
    unknown: 18, unverified: 20, exec: 14, withheld: 36 };
  assert.deepEqual(coverageCounts(alpha.coverage), expected);
  const env = boardEnv(t);
  env.context.apiFetch = async url => url.endsWith('/snapshots') ? { snapshots: [{
    machine_id: 'alpha', machine_label: 'Mac', generated_at: '2026-10-10T01:00:00.000Z',
  }] } : alpha;
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
  assert.equal(root.querySelectorAll('.work-card').length, 2);
  const machines = root.querySelectorAll('.work-coverage-machine');
  assert.equal(machines.length, 1);
  assert.equal(machines[0].querySelector('h3').textContent, 'Mac');
  const rows = Array.from(machines[0].querySelectorAll('dl > div'), row => [
    row.querySelector('dt').textContent, row.querySelector('dd').textContent,
  ]);
  assert.deepEqual(rows, [
    ['스캔', '11'], ['건너뜀', '2'], ['읽기 실패', '10'], ['세션 제외', '14'], ['지시 삭제', '16'],
    ['판별 불명', '18'], ['미검증', '20'], ['exec 제외', '14'], ['보류', '36'],
    ['형식 미검증 세션', '2'], ['Orca', '수집됨'],
  ]);
  const { formatLocalSnapshotTime } = await logic;
  const snapshotTime = root.querySelector('.work-snapshot-times').textContent;
  assert.ok(snapshotTime.includes(formatLocalSnapshotTime(alpha.generated_at)));
  assert.equal(snapshotTime.includes(formatLocalSnapshotTime('2026-10-10T01:00:00.000Z')), false);
});

test('local absolute time follows browser timezone and omits only the local current year', async () => {
  const { execFileSync } = require('node:child_process');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  for (const [timezone, expected] of [
    ['Asia/Seoul', ['10/10 18:02', '2025/12/31 00:00', '01/01 03:30', null]],
    ['America/Los_Angeles', ['10/10 02:02', '2025/12/30 07:00', '2025/12/31 10:30', null]],
  ]) {
    const script = `import(${JSON.stringify(moduleUrl)}).then(({formatLocalSnapshotTime: format}) => {
      const now = Date.parse('2026-10-10T12:00:00.000Z');
      console.log(JSON.stringify(['2026-10-10T09:02:00.000Z', '2025-12-30T15:00:00.000Z',
        '2025-12-31T18:30:00.000Z', 'invalid'].map(value => format(value, now))));
    });`;
    const output = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(output), expected);
  }
});

test('normal and search cards share title rules, omit duplicate rows and limit warnings', async t => {
  const { alpha } = fixtures(t);
  const env = boardEnv(t), root = env.document.getElementById('root');
  env.context.Date = class extends Date { static now() { return Date.parse('2026-10-10T03:00:00.000Z'); } };
  const cases = [
    { ai: '인증 설계 검토', state: 'recoverable', title: '인증 설계 검토', first: true },
    { ai: null, state: 'recoverable', title: '인증 흐름을 검토해 주세요.', first: false },
    { ai: null, state: 'unrecoverable', title: '인증 흐름을 검토해 주세요.', first: false },
    { ai: null, state: 'unknown', title: '인증 흐름을 검토해 주세요.', first: false },
    { ai: '인증 설계 검토', state: 'recoverable', title: '인증 설계 검토', first: false, same: true },
    { ai: null, state: 'recoverable', title: '인증 흐름을 검토해 주세요.', first: false, same: true },
  ];
  for (const variant of cases) {
    const omitRecent = variant.same && !variant.ai;
    const snapshot = structuredClone(alpha);
    snapshot.sessions = snapshot.sessions.slice(0, 1);
    snapshot.instructions = snapshot.instructions.slice(0, 2);
    Object.assign(snapshot.sessions[0], {
      ai_title: variant.ai, first_instruction: variant.state,
      format_unverified: true, compact_only_history: true, unknown_count: 1,
      orca_link: { confirmed: false, evidence: 'none', pane_key: null, terminal_handle: null },
    });
    if (variant.same) snapshot.instructions[1].text = snapshot.instructions[0].text;
    env.context.apiFetch = async url => url.endsWith('/snapshots') ? { snapshots: [{
      machine_id: 'alpha', machine_label: 'Mac', generated_at: snapshot.generated_at,
    }] } : snapshot;
    env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
    const card = root.querySelector('.work-card');
    assert.equal(root.querySelectorAll('.work-card').length, 1);
    assert.equal(card.querySelector('.work-title').textContent, variant.title);
    assert.equal(card.querySelectorAll('.work-first-block').length, variant.first ? 1 : 0);
    assert.equal(card.querySelectorAll('.work-recent-block').length, omitRecent ? 0 : 1);
    if (!omitRecent) {
      const expectedRecent = variant.same ? '인증 흐름을 검토해 주세요.'
        : '로그인 리다이렉트 테스트를 추가해 주세요.';
      assert.equal(card.querySelector('.work-recent').textContent,
        expectedRecent);
      assert.equal(card.querySelector('.work-recent-block .work-label').textContent.trim(),
        '최근 지시 · 59분 전');
    }
    assert.deepEqual(Array.from(card.querySelectorAll('.work-warning'), node => node.textContent.trim()),
      ['compact 이력', '판별 불명 1/3']);
    assert.equal(card.textContent.includes('형식 미검증'), false);
    assert.equal(card.querySelectorAll('.work-orca').length, 0);
    assert.equal(card.textContent.includes('스냅샷 시점 관측'), false);
    assert.equal(card.textContent.includes('Orca 연결 불명'), false);
    assert.equal(root.querySelectorAll('.work-observation-note').length, 1);
    const coverage = root.querySelector('.work-coverage');
    assert.ok(coverage.textContent.includes('형식 미검증 세션1'));
    const pill = root.querySelector('.work-snapshot-times .work-pill');
    assert.ok(pill.textContent.trim().startsWith('Mac · 방금 스냅샷 · '));
    if (variant.state === 'recoverable') {
      const query = root.querySelector('#work-query');
      query.value = variant.same ? '인증흐름' : '로그인리다';
      query.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
      assert.equal(root.querySelectorAll('.work-card').length, 1);
      assert.equal(root.querySelector('.work-title').textContent, variant.title);
      assert.equal(root.querySelectorAll('.work-first-block').length, variant.first ? 1 : 0);
      assert.equal(root.querySelectorAll('.work-recent-block').length, omitRecent ? 0 : 1);
      assert.equal(root.querySelector('.work-match mark').textContent,
        variant.same ? '인증 흐름' : '로그인 리다');
      if (variant.ai) {
        query.value = '설계';
        query.dispatchEvent(new env.window.Event('input', { bubbles: true })); await flushEffects();
        assert.equal(root.querySelectorAll('.work-card').length, 1);
        assert.equal(root.querySelector('.work-title').textContent, variant.title);
        assert.equal(root.querySelector('.work-title mark').textContent, '설계');
        assert.equal(root.querySelector('.work-match .work-label').textContent, 'AI 제목 일치');
        assert.equal(root.querySelectorAll('.work-first-block').length, variant.first ? 1 : 0);
      }
    }
    env.render(null, root);
  }
});

test('title selects the earliest nonempty text by seq, with AI priority and recovery fallback', async t => {
  const { snapshotCards } = await logic;
  const { alpha } = fixtures(t);
  alpha.sessions = alpha.sessions.slice(0, 1);
  alpha.sessions[0].ai_title = null;
  const base = alpha.instructions[0];
  const instruction = (seq, text, missing = false) => ({ ...base, seq, text, text_missing: missing });
  alpha.instructions = [instruction(4, '나중 지시'), instruction(0, '', true),
    instruction(3, '첫 텍스트 지시\n둘째 줄'), instruction(1, ''),
    instruction(2, '무시할 텍스트', true)];
  const card = snapshotCards(alpha)[0];
  assert.equal(card.instructions.length, 5);
  assert.deepEqual(card.instructions.map(row => row.seq), [0, 1, 2, 3, 4]);
  assert.equal(card.title, '첫 텍스트 지시');
  assert.equal(card.first, null);
  assert.equal(card.showFirst, false);
  for (const state of ['recoverable', 'unrecoverable', 'unknown']) {
    alpha.sessions[0].first_instruction = state;
    assert.equal(snapshotCards(alpha)[0].title, '첫 텍스트 지시');
  }
  alpha.sessions[0].ai_title = 'AI 세션 제목';
  assert.equal(snapshotCards(alpha)[0].title, 'AI 세션 제목');
  assert.equal(snapshotCards(alpha)[0].showFirst, false);
  alpha.sessions[0].ai_title = null;
  alpha.instructions = [instruction(0, '', true), instruction(1, '')];
  assert.equal(snapshotCards(alpha)[0].title, null);
});

test('attachment-first cards hide empty first rows and fall back only when no text exists', async t => {
  const { alpha } = fixtures(t);
  const env = boardEnv(t), root = env.document.getElementById('root');
  const variants = [
    { ai: null, state: 'recoverable', text: '검색 가능한 첫 텍스트', title: '검색 가능한 첫 텍스트' },
    { ai: 'AI 세션 제목', state: 'recoverable', text: '검색 가능한 첫 텍스트', title: 'AI 세션 제목' },
    { ai: null, state: 'recoverable', text: '', title: '텍스트가 있는 지시 없음' },
    { ai: null, state: 'unrecoverable', text: '', title: '최초 지시 복구 불가' },
    { ai: null, state: 'unknown', text: '', title: '최초 지시 확인 불가' },
  ];
  for (const variant of variants) {
    const snapshot = structuredClone(alpha);
    snapshot.sessions = snapshot.sessions.slice(0, 1);
    Object.assign(snapshot.sessions[0], { ai_title: variant.ai, first_instruction: variant.state });
    snapshot.instructions = snapshot.instructions.slice(0, 2);
    Object.assign(snapshot.instructions[0], { text: '', text_missing: true, attachments: 1 });
    Object.assign(snapshot.instructions[1], { text: variant.text, text_missing: false });
    env.context.apiFetch = async url => url.endsWith('/snapshots')
      ? { snapshots: [{ machine_id: 'alpha' }] } : snapshot;
    env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
    assert.equal(root.querySelectorAll('.work-card').length, 1);
    assert.equal(root.querySelector('.work-title').textContent, variant.title);
    assert.equal(root.querySelectorAll('.work-first-block').length, 0);
    if (variant.text) {
      const query = root.querySelector('#work-query');
      query.value = '검색가능'; query.dispatchEvent(new env.window.Event('input', { bubbles: true }));
      await flushEffects();
      assert.equal(root.querySelectorAll('.work-card').length, 1);
      assert.equal(root.querySelector('.work-title').textContent, variant.title);
      assert.equal(root.querySelector('.work-match mark').textContent, '검색 가능');
      assert.equal(root.querySelectorAll('.work-first-block').length, 0);
    }
    env.render(null, root);
  }
});

test('all composed separators have one space on each side; machine pill uses one complete time text node', async t => {
  const { alpha } = fixtures(t);
  const env = boardEnv(t), root = env.document.getElementById('root');
  env.context.Date = class extends Date { static now() { return Date.parse('2026-10-10T03:10:00.000Z'); } };
  env.context.apiFetch = async url => url.endsWith('/snapshots') ? { snapshots: [{
    machine_id: 'alpha', machine_label: 'Mac', generated_at: alpha.generated_at,
  }] } : alpha;
  env.render(env.h(env.context.WorkBoardView), root); await flushEffects(); await flushEffects();
  assert.equal(root.querySelectorAll('.work-card').length, 2);
  const { formatLocalSnapshotTime } = await logic;
  const absolute = formatLocalSnapshotTime(alpha.generated_at, Date.parse('2026-10-10T03:10:00.000Z'));
  const pill = root.querySelector('.work-snapshot-times .work-pill');
  assert.equal(pill.textContent, `Mac · 10분 전 스냅샷 · ${absolute}`);
  assert.equal(pill.childNodes.length, 1);
  assert.equal(pill.firstChild.tagName, 'TIME');
  assert.equal(pill.firstChild.childNodes.length, 1);
  assert.equal(pill.firstChild.firstChild.nodeType, env.window.Node.TEXT_NODE);
  assert.equal(root.querySelector('.work-recent-block .work-label').textContent, '최근 지시 · 1시간 전');
  assert.equal(root.querySelector('.work-orca').textContent.trim(), 'Orca · 응답 대기');
  root.querySelector('.work-card button').click(); await flushEffects();
  assert.equal(root.querySelectorAll('.work-event').length, 2);
  const walker = env.document.createTreeWalker(root, env.window.NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.includes('·')) assert.doesNotMatch(node.textContent, /(?<! )·|·(?! )| {2}·|· {2}/u);
  }
});
