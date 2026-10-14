'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { fixture, COOKIE, request } = require('./helpers/session-hub-fixture.cjs');
const store = require('../services/observeSnapshotStore');
const { createSessionHubBroker, INCOMPLETE_KEYS } = require('../services/sessionHubBroker');
const { validateSnapshot } = require('../services/observeSnapshotPolicy');
const { redactSecrets } = require('../services/memorySanitize');
const board = import(pathToFileURL(path.join(__dirname, '../public/app/lib/workBoard.js')).href);
const BASE = '/api/session-hub';
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const forbiddenKeys = new Set(['ref', 'cwd_id', 'path_id', 'path_gen', 'terminal_handle', 'pane_key', 'worktree_id']);

function assertAllowlist(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenKeys.has(key), false, key);
    assertAllowlist(child);
  }
}

function manySessions(fx, count, text = '동일한 지시') {
  const snapshot = structuredClone(fx.alpha);
  const original = snapshot.sessions[0];
  const row = snapshot.instructions[0];
  snapshot.sessions = Array.from({ length: count }, (_, index) => ({ ...original,
    key: `alpha:claude:s${index}`, session_id: `s${index}`, ai_title: '동일한 제목',
    instruction_count: 1, instruction_total: 1 }));
  snapshot.instructions = snapshot.sessions.map((session, index) => ({ ...row,
    id: `claude:s${index}:u1`, session_key: session.key, seq: 1, text }));
  assert.equal(validateSnapshot(snapshot).ok, true);
  fx.write(snapshot);
  return snapshot;
}

test('version 3 reader fixtures are accepted and version 2 snapshots require regeneration', t => {
  const fx = fixture(t);
  const old = structuredClone(fx.alpha);
  old.redaction_version = 2;
  assert.equal(validateSnapshot(old).ok, false);
  fx.write(old);
  assert.equal(store.readAllSnapshots(fx.state).snapshots[0].reason, 'policy_violation');
  assert.equal(fx.alpha.redaction_version, 3);
  fx.write(fx.alpha);
  assert.equal(store.readAllSnapshots(fx.state).snapshots[0].ok, true);
});

test('batch shares bounded bytes/hash, one enumeration and one budget; legacy shapes stay intact', t => {
  const fx = fixture(t);
  const readdir = fs.readdirSync;
  const read = fs.readSync;
  let enumerations = 0;
  let reads = 0;
  fs.readdirSync = function (...args) { enumerations++; return readdir.apply(fs, args); };
  fs.readSync = function (...args) { reads++; return read.apply(fs, args); };
  let batch;
  try { batch = store.readAllSnapshots(fx.state); } finally { fs.readdirSync = readdir; fs.readSync = read; }
  assert.equal(enumerations, 1);
  assert.equal(reads, 4); // One data read and EOF per small file; hashing never rereads.
  for (const entry of batch.snapshots) {
    const raw = fs.readFileSync(path.join(fx.dir, `${entry.machineId}.json`));
    assert.equal(entry.sha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(entry.bytes, raw.length);
  }
  const limited = store.createObserveSnapshotStore({ totalBytes: batch.snapshots[0].bytes });
  const entries = limited.readAllSnapshots(fx.state).snapshots;
  assert.equal(entries[0].ok, true);
  assert.equal(entries[1].reason, 'total_limit');
  assert.equal(entries[1].bytes, 0);
  assert.deepEqual(Object.keys(store.readSnapshot(fx.state, 'alpha')).sort(), ['bytes', 'ok', 'snapshot']);
  assert.equal('sha256' in store.listSnapshots(fx.state).snapshots[0], false);
  // Whitespace in the raw file participates in the hash, unlike JSON reserialization.
  fs.appendFileSync(path.join(fx.dir, 'alpha.json'), '\n');
  assert.notEqual(store.readAllSnapshots(fx.state).snapshots[0].sha256, batch.snapshots[0].sha256);
});

test('all endpoints expose only allowlisted fields, closed incompleteness, status and instruction flags', async t => {
  const fx = fixture(t);
  for (const [provider, keys] of Object.entries(INCOMPLETE_KEYS)) {
    for (const key of keys) fx.alpha.coverage[provider][key] = 1;
    fx.alpha.coverage[provider].excluded_sessions = 50;
  }
  fx.write(fx.alpha);
  fs.writeFileSync(path.join(fx.dir, 'broken.json'), 'invalid');
  const broker = createSessionHubBroker({ state: fx.state });
  const list = await broker.list({});
  assert.equal(list.meta.unreadable, 1);
  assert.deepEqual(list.meta.machines[0].incomplete, INCOMPLETE_KEYS);
  assert.equal(list.meta.machines_clipped, false);
  assert.deepEqual(new Set(list.sessions.map(row => row.first_status)),
    new Set(['recoverable', 'unrecoverable', 'unknown']));
  const unrecoverable = list.sessions.find(row => row.first_status === 'unrecoverable');
  assert.equal(unrecoverable.first, null);
  assert.equal(unrecoverable.compact_only_history, true);
  const unknown = list.sessions.find(row => row.first_status === 'unknown');
  assert.equal(unknown.first, null);
  assert.equal(unknown.format_unverified, true);
  assert.deepEqual(unknown.orca, { link: 'unknown', state: null, state_since: null });
  const recent = list.sessions.find(row => row.key === fx.alpha.sessions[0].key);
  assert.deepEqual(recent.recent_flags, ['source_truncated', 'attachments']);
  const detail = await broker.detail(recent.key, {});
  assert.equal(detail.instructions.at(-1).source_truncated, true);
  assert.equal(detail.instructions.at(-1).attachments, 2);
  const search = await broker.search({ q: '로그인' });
  assert.deepEqual(search.sessions[0].instructions[0].flags, ['source_truncated', 'clipped_text', 'attachments']);
  for (const body of [list, detail, search]) assertAllowlist(body);
});

test('search shares board ranking, title-only results, middle around and centered tail snippets', async t => {
  const fx = fixture(t);
  const snapshot = manySessions(fx, 34, '가'.repeat(1600) + ' 찾 을 표 현 ' + '나'.repeat(300));
  const broker = createSessionHubBroker({ state: fx.state });
  const helpers = await board;
  const expected = helpers.rankCards(helpers.snapshotCards(snapshot), '찾을표현').map(card => card.key);
  const result = await broker.search({ q: '찾을표현', limit: '15', machine: 'alpha' });
  assert.deepEqual(result.sessions.map(card => card.key), expected.slice(0, 15));
  assert.ok(result.next);
  assert.ok(result.sessions[0].instructions[0].snippet.includes('찾 을 표 현'));
  assert.equal(result.sessions[0].instructions[0].snippet.length, 240);
  assert.ok(result.sessions[0].instructions[0].flags.includes('clipped_text'));
  const title = await broker.search({ q: '동일한 제목', machine: 'alpha' });
  assert.equal(title.sessions[0].title_match, true);
  assert.deepEqual(title.sessions[0].instructions, []);
  const key = snapshot.sessions[0].key;
  const seed = snapshot.instructions[0];
  snapshot.instructions = Array.from({ length: 60 }, (_, index) => ({ ...seed,
    id: `claude:s0:u${index}`, session_key: key, seq: index, text: index === 24 ? '중간 일치' : '작업' }));
  fx.write(snapshot);
  const middle = await broker.search({ q: '중간 일치' });
  const around = middle.sessions[0].instructions[0].id;
  const detail = await broker.detail(key, { rev: middle.meta.rev, around });
  assert.ok(detail.instructions.some(row => row.id === around));
  assert.equal(detail.instructions.at(-1).id, 'claude:s0:u59');
  snapshot.instructions[24].text = '다른 내용'; fx.write(snapshot);
  await assert.rejects(broker.detail(key, { rev: middle.meta.rev, around }), /snapshot_changed/);
});

test('cursor enumerates 31+ identical sessions without gaps; content changes invalidate generations', async t => {
  const fx = fixture(t);
  const snapshot = manySessions(fx, 67);
  const broker = createSessionHubBroker({ state: fx.state });
  let page = await broker.list({ machine: 'alpha', limit: '30' });
  const rev = page.meta.rev;
  const keys = [...page.sessions.map(row => row.key)];
  while (page.next) {
    page = await broker.list({ machine: 'alpha', limit: '30', cursor: page.next });
    keys.push(...page.sessions.map(row => row.key));
  }
  assert.equal(keys.length, 67); assert.equal(new Set(keys).size, 67);
  assert.deepEqual(new Set(keys), new Set(snapshot.sessions.map(row => row.key)));
  const first = await broker.list({ limit: '30' });
  const length = bytes(snapshot);
  snapshot.instructions[0].text = '다른한 지시'; // Same byte size and generated_at.
  assert.equal(bytes(snapshot), length);
  fx.write(snapshot);
  assert.notEqual((await broker.list({})).meta.rev, rev);
  await assert.rejects(broker.list({ cursor: first.next }), /snapshot_changed/);
});

test('safe read failures contribute named errors to revision and unreadable, including symlink and policy', async t => {
  const fx = fixture(t);
  fs.symlinkSync(path.join(fx.dir, 'alpha.json'), path.join(fx.dir, 'link.json'));
  fs.writeFileSync(path.join(fx.dir, 'bad.json'), '{}');
  fs.writeFileSync(path.join(fx.dir, 'corrupt.json'), 'bad');
  const broker = createSessionHubBroker({ state: fx.state });
  const result = await broker.list({});
  const entries = store.readAllSnapshots(fx.state).snapshots;
  assert.equal(result.meta.unreadable, 3);
  assert.equal(result.meta.rev, store.snapshotRevision(entries));
  assert.deepEqual(entries.filter(row => !row.ok).map(row => row.reason),
    ['policy_violation', 'parse_error', 'symlink']);
  fs.unlinkSync(path.join(fx.dir, 'corrupt.json'));
  fs.writeFileSync(path.join(fx.dir, 'corrupt.json'), '{}');
  assert.notEqual((await broker.list({})).meta.rev, result.meta.rev);
  const limited = store.createObserveSnapshotStore({ fileBytes: 1 });
  const rejected = await createSessionHubBroker({ state: fx.state, store: limited }).list({});
  assert.equal(rejected.sessions.length, 0); assert.equal(rejected.meta.unreadable, 5);
});

test('Korean maximum fixtures stay <=65536; size trimming preserves first, around and newest', async t => {
  const fx = fixture(t);
  const snapshot = manySessions(fx, 40, '한'.repeat(2000));
  for (const session of snapshot.sessions) {
    session.ai_title = '제'.repeat(200);
    session.repo_label = '저'.repeat(64); session.git_branch = '분'.repeat(64);
    session.key += 'x'.repeat(100);
  }
  snapshot.instructions.forEach((row, index) => { row.session_key = snapshot.sessions[index].key; });
  const key = snapshot.sessions[0].key;
  const seed = snapshot.instructions[0];
  snapshot.instructions = Array.from({ length: 45 }, (_, index) => ({ ...seed,
    id: `claude:s0:u${index}`, session_key: key, seq: index, text: '한'.repeat(1990) + '검색' }));
  assert.equal(validateSnapshot(snapshot).ok, true);
  fx.write(snapshot);
  const broker = createSessionHubBroker({ state: fx.state });
  const list = await broker.list({ limit: '30' });
  assert.ok(bytes(list) <= 65536);
  assert.equal(list.clipped, list.sessions.length < 30);
  const search = await broker.search({ q: '검색', limit: '15' });
  assert.ok(bytes(search) <= 65536);
  const detail = await broker.detail(key, { rev: search.meta.rev, around: 'claude:s0:u20' });
  assert.ok(bytes(detail) <= 65536); assert.equal(detail.clipped, true);
  assert.equal(detail.first.id, 'claude:s0:u0');
  assert.ok(detail.instructions.some(row => row.id === 'claude:s0:u20'));
  assert.ok(detail.instructions.some(row => row.id === 'claude:s0:u44'));
  const short = await broker.detail(fx.beta.sessions[0].key, {});
  assert.equal(short.clipped, false);
  // Enough machines to exercise metadata clipping independently of response clipping.
  for (let index = 0; index < 18; index++) {
    const machine = structuredClone(fx.beta); machine.machine.id = `m${index}`; fx.write(machine);
  }
  const machines = await broker.list({});
  assert.equal(machines.meta.machines.length, 16); assert.equal(machines.meta.machines_clipped, true);
  assert.ok(bytes(machines) <= 65536);
});

test('display normalization is shared and secrets are redacted after transformation', async t => {
  const fx = fixture(t);
  fx.alpha.instructions[0].text = '<pasted_content id="abc">붙인 지시</pasted_content>';
  fx.write(fx.alpha);
  const broker = createSessionHubBroker({ state: fx.state });
  const result = await broker.detail(fx.alpha.sessions[0].key, {});
  assert.equal(result.first.text, '[붙여넣은 내용] 붙인 지시');
  assert.equal(result.session.first, result.first.text);
  const poisoned = structuredClone(fx.alpha);
  poisoned.instructions[0].text = 'sk-ant-api03-' + 'Q'.repeat(80);
  const double = { readAllSnapshots: () => ({ ok: true, snapshots: [
    { machineId: 'alpha', ok: true, snapshot: poisoned, sha256: 'a'.repeat(64) },
  ] }) };
  const redacted = await createSessionHubBroker({ state: fx.state, store: double })
    .detail(poisoned.sessions[0].key, {});
  assert.equal(JSON.stringify(redacted).includes('Q'.repeat(80)), false);
});

test('search snippets use displayed sanitized text and do not restore hidden tag attributes', async t => {
  const fx = fixture(t);
  const snapshot = manySessions(fx, 1, '<pasted_content id="needle">' + '가'.repeat(1000));
  const broker = createSessionHubBroker({ state: fx.state });
  const helpers = await board;
  const ranked = helpers.rankCards(helpers.snapshotCards(snapshot), 'needle');
  assert.equal(ranked.length, 1);
  assert.ok(helpers.matchedLines(ranked[0].match.text, 'needle').includes('id="needle"'));
  const result = await broker.search({ q: 'needle' });
  assert.equal(result.sessions.length, 1);
  const hidden = result.sessions[0].instructions[0];
  const full = redactSecrets(helpers.displayInstructionText(snapshot.instructions[0].text)).text;
  assert.equal(hidden.snippet, full.slice(0, 240));
  assert.equal(hidden.snippet.includes('needle'), false);
  assert.ok(hidden.flags.includes('clipped_text'));
  assert.ok(result.sessions[0].instructions[0].snippet.length <= 240);

  snapshot.instructions[0].text = '<pasted_content id="' + '한'.repeat(600) + '">needle' + '가'.repeat(1000);
  assert.equal(validateSnapshot(snapshot).ok, true);
  fx.write(snapshot);
  const contentMatch = await broker.search({ q: 'needle' });
  const snippet = contentMatch.sessions[0].instructions[0].snippet;
  assert.ok(snippet.includes('needle'));
  assert.ok(snippet.startsWith('[붙여넣은 내용] needle'), 'window is selected after display normalization');
  assert.equal(snippet.length, 240);
});

test('snippet redacts whole command args before centering on a command-name match', async t => {
  const fx = fixture(t);
  const helpers = await board;
  const secret = '비밀'.repeat(300);
  for (const argument of [`--password="${secret}"`, `--password "${secret}"`]) {
    const snapshot = structuredClone(fx.alpha);
    const row = snapshot.instructions[0];
    row.text = `<command-args>${argument}</command-args><command-name>review</command-name>`;
    const broker = createSessionHubBroker({ state: fx.state, store: { readAllSnapshots: () => ({
      ok: true, snapshots: [{ machineId: 'alpha', ok: true, snapshot, sha256: 'a'.repeat(64) }],
    }) } });
    const result = await broker.search({ q: 'review' });
    const snippet = result.sessions[0].instructions[0].snippet;
    assert.equal(snippet.includes('비밀'), false);
    assert.ok(snippet.includes('[REDACTED]'));
    const expected = redactSecrets(helpers.displayInstructionText(row.text)).text;
    assert.equal(snippet, expected);
    const detail = await broker.detail(row.session_key, {});
    assert.equal(detail.first.text, expected);
    const list = await broker.list({});
    assert.equal(list.sessions.find(session => session.key === row.session_key).first, expected);
  }
});

test('snippet never restores a query inside a redacted secret and uses the safe leading excerpt', async t => {
  const fx = fixture(t);
  const helpers = await board;
  const snapshot = structuredClone(fx.alpha);
  const row = snapshot.instructions[0];
  const secret = '가'.repeat(300) + 'needle' + '나'.repeat(300);
  row.text = '<pasted_content id="x">' + '안전 안내 '.repeat(50) + `--password="${secret}"</pasted_content>`;
  const broker = createSessionHubBroker({ state: fx.state, store: { readAllSnapshots: () => ({
    ok: true, snapshots: [{ machineId: 'alpha', ok: true, snapshot, sha256: 'a'.repeat(64) }],
  }) } });
  const result = await broker.search({ q: 'needle' });
  const match = result.sessions[0].instructions[0];
  assert.equal(match.snippet.includes('needle'), false);
  assert.equal(match.snippet.includes('가'.repeat(20)), false);
  assert.equal(match.snippet.includes('나'.repeat(20)), false);
  assert.ok(match.flags.includes('clipped_text'));
  const safe = redactSecrets(helpers.displayInstructionText(row.text)).text;
  assert.equal(match.snippet, safe.slice(0, 240));
  const detail = await broker.detail(row.session_key, {});
  assert.equal(detail.first.text, safe);
  const list = await broker.list({});
  assert.equal(list.sessions.find(session => session.key === row.session_key).first,
    safe.slice(0, 120));
  row.text = '<pasted_content id="x">--password="needle hidden"</pasted_content>';
  const short = (await broker.search({ q: 'needle' })).sessions[0].instructions[0];
  assert.equal(short.snippet, '[붙여넣은 내용] --[REDACTED]');
  assert.ok(short.flags.includes('clipped_text'), 'a redacted-only match is marked even below the size limit');
});

test('snippet uses exactly the same displayed redacted full text as list and detail for Bearer commands', async t => {
  const fx = fixture(t);
  const helpers = await board;
  const snapshot = structuredClone(fx.alpha);
  const row = snapshot.instructions[0];
  row.text = '<command-name>Bearer</command-name><command-args>needle</command-args>';
  const full = redactSecrets(helpers.displayInstructionText(row.text)).text;
  const broker = createSessionHubBroker({ state: fx.state, store: { readAllSnapshots: () => ({
    ok: true, snapshots: [{ machineId: 'alpha', ok: true, snapshot, sha256: 'a'.repeat(64) }],
  }) } });
  const match = (await broker.search({ q: 'needle' })).sessions[0].instructions[0];
  if (helpers.matchText(full, 'needle')) assert.ok(match.snippet.includes('needle'));
  else {
    assert.equal(match.snippet, full.slice(0, 240));
    assert.ok(match.flags.includes('clipped_text'));
  }
  assert.equal((await broker.detail(row.session_key, {})).first.text, full);
  const list = (await broker.list({})).sessions.find(session => session.key === row.session_key);
  assert.equal(list.first, full.slice(0, 120));
});

test('snippet does not transform or redact again after slicing the canonical full text', async t => {
  const fx = fixture(t);
  const raw = '가'.repeat(800) + 'xBearer ' + 'Q'.repeat(110) + 'needle' + '나'.repeat(500);
  manySessions(fx, 1, raw);
  const full = redactSecrets((await board).displayInstructionText(raw)).text;
  assert.equal(full, raw);
  const match = (await createSessionHubBroker({ state: fx.state }).search({ q: 'needle' }))
    .sessions[0].instructions[0];
  assert.equal(match.snippet, full.slice(801, 1041));
  assert.ok(match.snippet.includes('needle'));
});

test('snippet slices preserve surrogate pairs at both window boundaries', async t => {
  const fx = fixture(t);
  const broker = createSessionHubBroker({ state: fx.state });
  for (const query of ['needle', 'x']) {
    manySessions(fx, 1, '😀'.repeat(250) + query + '😀'.repeat(250));
    const snippet = (await broker.search({ q: query })).sessions[0].instructions[0].snippet;
    assert.ok(snippet.isWellFormed(), 'neither boundary may split a surrogate pair');
    assert.ok(snippet.includes(query));
    assert.ok(snippet.length <= 240);
  }
});

test('broker shares multiline pasted display in first, recent and detail text', async t => {
  const fx = fixture(t);
  const key = fx.alpha.sessions[0].key;
  const rows = fx.alpha.instructions.filter(row => row.session_key === key);
  rows[0].text = '<pasted_content id="first">\n인증 구현\n</pasted_content>';
  rows[1].text = '<pasted_content id="recent">\n검색 구현\n</pasted_content>\n후속 설명';
  fx.write(fx.alpha);
  const broker = createSessionHubBroker({ state: fx.state });
  const list = (await broker.list({})).sessions.find(session => session.key === key);
  assert.equal(list.first, '[붙여넣은 내용] 인증 구현');
  assert.equal(list.recent, '[붙여넣은 내용] 검색 구현\n후속 설명');
  const detail = await broker.detail(key, {});
  assert.equal(detail.first.text, list.first);
  assert.equal(detail.instructions.at(-1).text, list.recent);
});

test('observe list shares partial-failure rev with broker and detail hash prevents replacement races', async t => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.dir, 'broken.json'), 'bad');
  const app = fx.app();
  const observe = await request(app).get('/api/observe/snapshots').set('Cookie', COOKIE);
  const broker = await request(app).get(`${BASE}/sessions`).set('Cookie', COOKIE);
  assert.equal(observe.status, 200); assert.equal(broker.status, 200);
  assert.equal(observe.body.rev, broker.body.meta.rev);
  assert.deepEqual(observe.body.snapshots.at(-1), { name_id: 'broken', error_code: 'parse_error' });
  const sha256 = observe.body.snapshots[0].sha256;
  const detail = await request(app).get(`/api/observe/snapshots/alpha?sha256=${sha256}`).set('Cookie', COOKIE);
  assert.deepEqual(detail.body, fx.alpha);
  fx.alpha.instructions[0].text = '갱신된 지시'; fx.write(fx.alpha);
  const changed = await request(app).get(`/api/observe/snapshots/alpha?sha256=${sha256}`).set('Cookie', COOKIE);
  assert.equal(changed.status, 409);
  assert.deepEqual(changed.body, { error: 'snapshot_changed', reason: 'snapshot_changed' });
});

test('query grammar and missing targets produce only closed errors', async t => {
  const fx = fixture(t);
  const broker = createSessionHubBroker({ state: fx.state });
  for (const query of [{ limit: '31' }, { limit: '0' }, { provider: 'other' }, { machine: '../bad' },
    { cursor: 'bad' }, { limit: ['1'] }, { other: 'value' }]) {
    await assert.rejects(broker.list(query), /invalid_query/);
  }
  for (const query of [{ q: '' }, { q: ' ' }, { q: 'a'.repeat(201) }, { q: 'a', limit: '16' }]) {
    await assert.rejects(broker.search(query), /invalid_query/);
  }
  await assert.rejects(broker.detail('bad/path', {}), /invalid_query/);
  await assert.rejects(broker.detail('missing', {}), /not_found/);
  await assert.rejects(broker.detail(fx.alpha.sessions[0].key, { around: fx.alpha.instructions[0].id }),
    /invalid_query/);
  const rev = (await broker.list({})).meta.rev;
  await assert.rejects(broker.detail(fx.alpha.sessions[0].key, { rev, around: 'claude:s:u999' }), /not_found/);
  const unavailable = createSessionHubBroker({ state: fx.state,
    store: { readAllSnapshots: () => ({ ok: false, reason: '/secret/path' }) } });
  await assert.rejects(unavailable.list({}), /^Error: snapshot_unavailable$/);
});


test('summary/search size clipping advances cursor by emitted rows and never clips a fitting response', async t => {
  const fx = fixture(t);
  const snapshot = manySessions(fx, 35, '한'.repeat(1995) + '검색');
  const originals = snapshot.instructions;
  snapshot.machine.label = 'M'.repeat(32);
  for (const session of snapshot.sessions) {
    session.key = session.key.padEnd(128, 'x');
    session.repo_label = '저'.repeat(64); session.git_branch = '분'.repeat(64);
    session.ai_title = '제'.repeat(200); session.instruction_total = 1000000000;
    session.format_unverified = true;
  }
  snapshot.instructions = snapshot.sessions.flatMap((session, index) =>
    Array.from({ length: 3 }, (_, seq) => ({ ...originals[index], session_key: session.key,
      id: `claude:s${index}:u${seq}`, seq, truncated: true, attachments: 1000000000, unknown_blocks: 1000000000 })));
  for (const [provider, keys] of Object.entries(INCOMPLETE_KEYS)) {
    for (const key of keys) snapshot.coverage[provider][key] = 1;
  }
  assert.equal(validateSnapshot(snapshot).ok, true);
  const entries = Array.from({ length: 16 }, (_, index) => {
    const machine = structuredClone(snapshot); machine.machine.id = `m${index}`;
    if (index) { machine.sessions = []; machine.instructions = []; }
    return { machineId: machine.machine.id, ok: true, snapshot: machine, sha256: String(index).padStart(64, '0') };
  });
  const broker = createSessionHubBroker({ state: fx.state,
    store: { readAllSnapshots: () => ({ ok: true, snapshots: entries }) } });
  const recorded = [];
  const list = await broker.list({ limit: '30' }, { onBindings: rows => recorded.push(rows) });
  const search = await broker.search({ q: '검색', limit: '15' }, { onBindings: rows => recorded.push(rows) });
  for (const [index, response] of [list, search].entries()) {
    assert.deepEqual(recorded[index].map(row => row.key), response.sessions.map(row => row.key));
    assert.ok(recorded[index].length < (index ? 15 : 30), 'clipped keys are never bound');
  }
  for (const response of [list, search]) {
    assert.ok(bytes(response) <= 65536);
    assert.equal(response.clipped, true);
    assert.equal(Number(response.next.split('.')[1]), response.sessions.length);
    assert.ok(response.sessions.length > 0);
    const next = await broker.list({ cursor: response.next, limit: '1' });
    const expected = snapshot.sessions.map(session => session.key).sort();
    assert.equal(next.sessions[0].key, expected[response.sessions.length]);
  }
  const fitting = await broker.list({ limit: '1' });
  assert.equal(fitting.clipped, false);
});

test('missing text and unknown-block flags persist across summary, title search and detail', async t => {
  const fx = fixture(t);
  const row = fx.alpha.instructions[1];
  row.text = ''; row.text_missing = true; row.unknown_blocks = 2;
  fx.write(fx.alpha);
  const broker = createSessionHubBroker({ state: fx.state });
  const list = await broker.list({});
  const summary = list.sessions.find(session => session.key === row.session_key);
  assert.equal(summary.recent, null);
  assert.deepEqual(summary.recent_flags, ['text_missing', 'source_truncated', 'attachments', 'unknown_blocks']);
  const search = await broker.search({ q: fx.alpha.sessions[0].ai_title });
  assert.deepEqual(search.sessions.find(session => session.key === row.session_key).recent_flags,
    summary.recent_flags);
  const detail = await broker.detail(row.session_key, {});
  assert.equal(detail.instructions.at(-1).text_missing, true);
  assert.equal(detail.instructions.at(-1).unknown_blocks, 2);
});


test('long query remains fully visible in the centered snippet and HTTP errors never leak exceptions', async t => {
  const fx = fixture(t);
  const query = '검색'.repeat(100);
  const snapshot = manySessions(fx, 1, '가'.repeat(1200) + query + '나'.repeat(300));
  const broker = createSessionHubBroker({ state: fx.state });
  const searched = await broker.search({ q: query });
  assert.ok(searched.sessions[0].instructions[0].snippet.includes(query));
  const app = fx.app();
  for (const [url, status, code] of [
    ['/api/session-hub/sessions?limit=31', 400, 'invalid_query'],
    ['/api/session-hub/search?q=', 400, 'invalid_query'],
    ['/api/session-hub/sessions/missing', 404, 'not_found'],
    ['/api/session-hub/sessions/%zz', 400, 'invalid_query'],
    [`/api/session-hub/sessions/${snapshot.sessions[0].key}?rev=0000000000000000`, 409, 'snapshot_changed'],
  ]) {
    const response = await request(app).get(url).set('Cookie', COOKIE);
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { error: code, reason: code });
  }
  const failed = fx.app({ observeSnapshotStore: {
    readAllSnapshots: () => { throw new Error('/private/secret/failure'); },
  } });
  const response = await request(failed).get('/api/session-hub/sessions').set('Cookie', COOKIE);
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: 'snapshot_unavailable', reason: 'snapshot_unavailable' });
});

test('search ranking agrees with the board for target, whitespace, position, timestamp and filters', async t => {
  const fx = fixture(t);
  const snapshot = manySessions(fx, 18);
  const texts = ['찾을표현', '앞쪽 찾을표현', '찾 을 표 현',
    '다른 지시', '찾을표현 뒤쪽', '전혀 다름'];
  snapshot.instructions.forEach((row, index) => {
    row.text = texts[index % texts.length];
    row.ts = new Date(Date.parse(row.ts) + index * 1000).toISOString();
    snapshot.sessions[index].ai_title = index % texts.length === 3 ? '찾을표현 제목' : '다른 제목';
    snapshot.sessions[index].last_record_at = row.ts;
  });
  fx.write(snapshot);
  fx.beta.instructions[0].text = '찾을표현'; fx.write(fx.beta);
  const broker = createSessionHubBroker({ state: fx.state });
  const helpers = await board;
  const cards = [...helpers.snapshotCards(snapshot), ...helpers.snapshotCards(fx.beta)];
  for (const filter of [{}, { machine: 'alpha' }, { machine: 'beta' }, { provider: 'codex' }]) {
    const expected = helpers.rankCards(cards, '찾을표현', filter.machine, filter.provider).map(card => card.key);
    const keys = [];
    let cursor;
    do {
      const response = await broker.search({ q: '찾을표현', limit: '3', ...filter, ...(cursor ? { cursor } : {}) });
      keys.push(...response.sessions.map(card => card.key));
      cursor = response.next;
    } while (cursor);
    assert.deepEqual(keys, expected);
  }
  const nfc = await broker.search({ q: '찾을표현'.normalize('NFD') });
  assert.deepEqual(nfc.sessions.map(card => card.key),
    helpers.rankCards(cards, '찾을표현').slice(0, 10).map(card => card.key));
});

test('batch debits failed reads from the shared budget and never trusts a swapped file identity', t => {
  const fx = fixture(t);
  const alphaBytes = fs.statSync(path.join(fx.dir, 'alpha.json')).size;
  const bad = Buffer.alloc(alphaBytes, 'x');
  fs.writeFileSync(path.join(fx.dir, 'a-broken.json'), bad);
  const limited = store.createObserveSnapshotStore({ totalBytes: alphaBytes * 2 });
  const entries = limited.readAllSnapshots(fx.state).snapshots;
  assert.equal(entries[0].reason, 'parse_error'); assert.equal(entries[0].bytes, alphaBytes);
  assert.equal(entries[1].ok, true);
  assert.equal(entries[2].reason, 'total_limit'); assert.equal(entries[2].bytes, 0);
  fs.unlinkSync(path.join(fx.dir, 'a-broken.json'));
  const filename = path.join(fx.dir, 'alpha.json');
  const replacement = `${filename}.replacement`;
  fs.writeFileSync(replacement, JSON.stringify(fx.alpha));
  const open = fs.openSync;
  fs.openSync = function (name, ...args) {
    if (name === filename) fs.renameSync(replacement, filename);
    return open.call(fs, name, ...args);
  };
  try {
    const swapped = store.readAllSnapshots(fx.state).snapshots[0];
    assert.equal(swapped.reason, 'identity_mismatch');
    assert.equal(swapped.bytes, 0); assert.equal(swapped.sha256, null);
  } finally { fs.openSync = open; }
});

test('hash remains tied to bytes on the opened descriptor when the pathname is replaced after its read', t => {
  const fx = fixture(t);
  const filename = path.join(fx.dir, 'alpha.json');
  const before = fs.readFileSync(filename);
  const updated = structuredClone(fx.alpha);
  updated.instructions[0].text = '교체된 내용';
  const replacement = `${filename}.replacement`;
  fs.writeFileSync(replacement, JSON.stringify(updated));
  const read = fs.readSync;
  let swapped = false;
  fs.readSync = function (...args) {
    const count = read.apply(fs, args);
    if (!swapped && count > 0) { swapped = true; fs.renameSync(replacement, filename); }
    return count;
  };
  let entry;
  try { entry = store.readAllSnapshots(fx.state).snapshots[0]; } finally { fs.readSync = read; }
  assert.equal(entry.ok, true); assert.deepEqual(entry.snapshot, fx.alpha);
  assert.equal(entry.sha256, createHash('sha256').update(before).digest('hex'));
  assert.notEqual(entry.sha256, createHash('sha256').update(fs.readFileSync(filename)).digest('hex'));
});

test('replacement during the next directory enumeration rejects list cursor and Codex around via HTTP', async t => {
  const fx = fixture(t);
  manySessions(fx, 40);
  const app = fx.app();

  // The Codex fixture uses n<sequence> ids; their meaning must stay bound to the search generation.
  fx.beta.instructions[0].text = '중간 검색'; fx.write(fx.beta);
  const first = await request(app).get(`${BASE}/sessions?limit=1`).set('Cookie', COOKIE);
  async function replaceDuringEnumeration(url, snapshot) {
    const readdir = fs.readdirSync;
    let calls = 0;
    fs.readdirSync = function (...args) {
      const names = readdir.apply(fs, args);
      if (args[0] === fx.dir) {
        calls++;
        snapshot.instructions[0].text += ' 교체';
        fx.write(snapshot);
      }
      return names;
    };
    try {
      const response = await request(app).get(url).set('Cookie', COOKIE);
      assert.equal(response.status, 409);
      assert.deepEqual(response.body, { error: 'snapshot_changed', reason: 'snapshot_changed' });
      assert.equal(calls, 1);
    } finally { fs.readdirSync = readdir; }
  }
  await replaceDuringEnumeration(`${BASE}/sessions?cursor=${first.body.next}`, fx.alpha);
  const codex = await request(app).get(`${BASE}/search?q=중간&provider=codex`).set('Cookie', COOKIE);
  assert.equal(codex.status, 200); assert.equal(codex.body.sessions.length, 1);
  const row = codex.body.sessions[0];
  await replaceDuringEnumeration(`${BASE}/sessions/${row.key}?rev=${codex.body.meta.rev}`
    + `&around=${row.instructions[0].id}`, fx.beta);
});

test('revision sorts filenames and uses a length-prefixed canonical vector including failed machines', () => {
  // Vector encoded independently as uint32be byte length + UTF-8 field, in actual filename order:
  // domain, a-b.json/sha256/b*64, a.json/sha256/a*64, broken.json/error/parse_error.
  const entries = [
    { machineId: 'a', ok: true, sha256: 'a'.repeat(64) },
    { machineId: 'broken', ok: false, reason: 'parse_error' },
    { machineId: 'a-b', ok: true, sha256: 'b'.repeat(64) },
  ];
  assert.equal(store.snapshotRevision(entries), 'cd73df58035fec99');
  assert.equal(store.snapshotRevision([...entries].reverse()), 'cd73df58035fec99');
  assert.notEqual(store.snapshotRevision(entries.map(entry => entry.ok ? entry : { ...entry, reason: 'read_error' })),
    'cd73df58035fec99');
});

test('PR-S v1 read compatibility and v2 closed status slots survive all broker endpoints', async t => {
  const fx = fixture(t);
  const expected = { state: 'ended', source: 'transcript', evidence_at: fx.alpha.sessions[0].last_record_at,
    reason: null };
  fx.alpha.sessions[0].status = expected;
  fx.write(fx.alpha);
  const broker = createSessionHubBroker({ state: fx.state });
  const key = fx.alpha.sessions[0].key;
  for (const body of [await broker.list({}), await broker.search({ q: '인증' }), await broker.detail(key, {})]) {
    const row = body.session || body.sessions.find(session => session.key === key);
    assert.deepEqual(row.status, expected);
    assert.deepEqual(Object.keys(row.status).sort(), ['evidence_at', 'reason', 'source', 'state']);
    assertAllowlist(body);
    for (const forbidden of ['last_agent_message', 'PRIVATE_ASSISTANT_SENTINEL', 'PRIVATE_COMPLETION_SENTINEL'])
      assert.equal(Buffer.from(JSON.stringify(body)).includes(Buffer.from(forbidden)), false);
  }
  fx.alpha.policy_version = 1;
  for (const session of fx.alpha.sessions) delete session.status;
  fx.alpha.orca.worktrees[0].agents[0].state = 'completed';
  assert.equal(validateSnapshot(fx.alpha).ok, true);
  fx.write(fx.alpha);
  assert.equal(store.readAllSnapshots(fx.state).snapshots[0].ok, true);
  const unknown = { state: 'unknown', source: 'none', evidence_at: null, reason: null };
  assert.deepEqual((await broker.list({})).sessions.find(session => session.key === key).status, unknown);
  const legacyDetail = (await broker.detail(key, {})).session;
  assert.deepEqual(legacyDetail.status, unknown);
  assert.equal(legacyDetail.orca.state, 'unknown');
});

test('PR-S reader to broker byte search excludes assistant, tool and completion text', async t => {
  const fx = fixture(t);
  const directory = path.join(fx.homeDir, '.codex', 'sessions');
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = '2026-10-10T02:00:00.000Z';
  const rows = [
    { type: 'session_meta', timestamp,
      payload: { id: 'status', cwd: '/synthetic', source: 'cli', thread_source: 'user' } },
    { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'response_item', timestamp,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'status fixture' }] } },
    { type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'PRIVATE_ASSISTANT_SENTINEL' }] } },
    { type: 'response_item', timestamp,
      payload: { type: 'function_call_output', output: 'PRIVATE_TOOL_SENTINEL' } },
    { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'turn',
      last_agent_message: 'PRIVATE_COMPLETION_SENTINEL' } },
  ];
  fs.writeFileSync(path.join(directory, 'status.jsonl'), rows.map(JSON.stringify).join('\n'));
  const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot({
    homeDir: fx.homeDir, configDir: path.join(fx.root, 'status-config'),
    now: new Date('2026-10-10T03:00:00.000Z'), readerBuild: 'a'.repeat(16), runOrca: () => null
  });
  fx.write(snapshot);
  const key = snapshot.sessions.find(session => session.session_id === 'status').key;
  const broker = createSessionHubBroker({ state: fx.state });
  const responses = [await broker.list({}), await broker.search({ q: 'status' }), await broker.detail(key, {})];
  for (const response of responses) {
    const row = response.session || response.sessions.find(session => session.key === key);
    assert.equal(row.status.state, 'ended');
    const raw = Buffer.from(JSON.stringify(response));
    for (const forbidden of ['last_agent_message', 'PRIVATE_ASSISTANT_SENTINEL',
      'PRIVATE_TOOL_SENTINEL', 'PRIVATE_COMPLETION_SENTINEL']) assert.equal(raw.includes(forbidden), false);
  }
});

test('PR-S assistant prompt distinguishes response end from completion and names both times', () => {
  const { SESSION_HUB_PROMPT, SESSION_HUB_PROMPT_VERSION } = require('../services/sessionHubPrompt');
  assert.equal(SESSION_HUB_PROMPT_VERSION, 'c1-pa-pr-m-2');
  for (const phrase of ['응답 끝남을 일 완료라고 말하지 않는다', 'status.evidence_at',
    'meta.machines[].generated_at', 'unknown=알 수 없음']) assert.ok(SESSION_HUB_PROMPT.includes(phrase));
});

test('broker bindings use the same batch hashes, stay private and run synchronously before return', async t => {
  const fx = fixture(t), batch = store.readAllSnapshots(fx.state);
  let reads = 0;
  const broker = createSessionHubBroker({ state: fx.state, store: { readAllSnapshots: () => { reads++; return batch; } } });
  for (const kind of ['list', 'search', 'detail']) {
    let recorded;
    const options = { onBindings: bindings => { recorded = bindings; } };
    const response = kind === 'detail' ? await broker.detail(fx.alpha.sessions[0].key, {}, options)
      : await broker[kind](kind === 'search' ? { q: '인증' } : {}, options);
    const sessions = response.session ? [response.session] : response.sessions;
    assert.ok(sessions.length > 0);
    assert.deepEqual(recorded.map(row => row.key), sessions.map(row => row.key));
    for (const binding of recorded) {
      const entry = batch.snapshots.find(row => row.snapshot.sessions.some(session => session.key === binding.key));
      assert.deepEqual(binding, { key: binding.key, rev: response.meta.rev, machineId: entry.snapshot.machine.id,
        sha256: entry.sha256, label: entry.snapshot.machine.label });
    }
    assert.equal(JSON.stringify(response).includes('sha256'), false);
  }
  assert.equal(reads, 3);
});

// Real router + broker + turn owner, driven by Node HTTP objects without binding sockets.
async function answerRouterFixture(t, { query, broker: brokerOverride } = {}) {
  const express = require('express');
  const { serviceFixture } = require('./helpers/session-hub-service-fixture.cjs');
  const { createSessionHubRouter, sessionHubErrorHandler, createSessionHubTokenGate } = require('../routes/sessionHub');
  const fx = fixture(t), processFx = serviceFixture(t), hub = processFx.service;
  await hub.start();
  let turnNumber = 0;
  const newTurn = async () => {
    if (hub.state().turnInProgress) processFx.event({ type: 'result' });
    await hub.message({ thread_id: hub.state().thread_id, request_id: `router-${++turnNumber}`, text: 'answer' });
  };
  await newTurn();
  const broker = createSessionHubBroker({ state: fx.state });
  const result = { status: 'final', text: 'worker report', truncated: false, redacted: false,
    shared_turn: false, reason: null, answer_at: '2026-10-14T00:00:00Z', observed_at: '2026-10-14T00:01:00Z' };
  const calls = [];
  const app = express();
  app.use(createSessionHubTokenGate(hub));
  app.use('/api/session-hub', createSessionHubRouter({ state: fx.state, provider: hub, hub, answers: true,
    broker: brokerOverride ? brokerOverride(broker, fx) : broker,
    answerService: { query: input => { calls.push(input); return query ? query(input) : result; } } }));
  app.use(sessionHubErrorHandler);
  function pending(url) {
    const http = require('node:http'), { Duplex } = require('node:stream');
    const socket = new Duplex({ read() {}, write(chunk, enc, cb) { cb(); } });
    const req = new http.IncomingMessage(socket);
    req.method = 'GET'; req.url = url; req.headers = { host: 'localhost', authorization: `Bearer ${hub.current()}` };
    const res = new http.ServerResponse(req);
    let resolve;
    const response = new Promise(done => { resolve = done; });
    res.end = value => {
      Object.defineProperty(res, 'writableEnded', { value: true });
      resolve({ status: res.statusCode, body: JSON.parse(String(value)), text: String(value) }); return res;
    };
    app.handle(req, res);
    req.push(null);
    return { req, res, response, abort() { res.emit('close'); } };
  }
  const get = url => pending(url).response;
  const answer = (key, rev) => `${BASE}/answers/${key}/claude:s:u1?rev=${rev}`;
  return { ...fx, hub, processFx, broker, newTurn, result, calls, get, pending, answer };
}
const later = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject }; };

for (const outcome of ['normal', 'aborted-success', 'aborted-error']) test(
  `answer connection ${outcome}: consumption persists and abandoned results cannot freeze or charge bytes`, async t => {
    const task = later(); let entered;
    const started = new Promise(done => { entered = done; });
    const fx = await answerRouterFixture(t, { query: () => { entered(); return task.promise; } });
    const list = await fx.get(`${BASE}/sessions?machine=alpha`), key = list.body.sessions[0].key, rev = list.body.meta.rev;
    const original = fx.hub.completeAnswer; let completed = 0;
    fx.hub.completeAnswer = (...args) => { completed++; return original(...args); };
    const request = fx.pending(fx.answer(key, rev)); await started;
    if (outcome === 'normal') request.req.emit('close'); // normal request body EOF must not cancel completion
    else request.abort();
    if (outcome === 'aborted-error') task.reject(Object.assign(new Error('answer_busy'), { code: 'answer_busy', status: 429 }));
    else task.resolve({ ...fx.result, text: '한'.repeat(8000) });
    await new Promise(done => setImmediate(done));
    if (outcome === 'normal') {
      assert.equal((await request.response).status, 200); assert.equal(completed, 1);
    } else {
      assert.equal(completed, 0);
      // An abandoned reply did not freeze the set; a new key can still be returned and reserved.
      const beta = await fx.get(`${BASE}/sessions?machine=beta`), next = beta.body.sessions[0].key;
      const handle = fx.hub.captureHubTurn(fx.hub.current());
      assert.equal(fx.hub.answerBinding(handle, next, beta.body.meta.rev).machineId, 'beta');
      assert.deepEqual(fx.hub.completeAnswer(handle, key, 24576), { budget_clipped: false });
    }
    const handle = fx.hub.captureHubTurn(fx.hub.current());
    for (let i = 0; i < 4; i++) fx.hub.reserveAnswer(handle, key);
    assert.throws(() => fx.hub.reserveAnswer(handle, key), /answer_budget_exceeded/);
  });

for (const method of ['list', 'search', 'detail']) for (const boundary of ['new-turn', 'frozen', 'no-capture', 'aborted']) test(
  `delayed ${method} bindings cannot cross ${boundary}`, async t => {
    const gate = later(), entered = later();
    const fx = await answerRouterFixture(t, { broker: broker => {
      const wrapped = { ...broker };
      wrapped[method] = async (...args) => { entered.resolve(); await gate.promise; return broker[method](...args); };
      return wrapped;
    } });
    const key = fx.alpha.sessions[0].key;
    if (boundary === 'no-capture') fx.processFx.event({ type: 'result' });
    const url = method === 'list' ? `${BASE}/sessions?machine=alpha`
      : method === 'search' ? `${BASE}/search?q=${encodeURIComponent('인증')}` : `${BASE}/sessions/${key}`;
    const delayed = fx.pending(url); await entered.promise;
    if (boundary === 'new-turn' || boundary === 'no-capture') await fx.newTurn();
    if (boundary === 'frozen') {
      // Use an unblocked endpoint to return only beta before completing its answer.
      const betaKey = fx.beta.sessions[0].key;
      const beta = method === 'detail' ? await fx.get(`${BASE}/sessions?machine=beta`)
        : await fx.get(`${BASE}/sessions/${betaKey}`);
      assert.equal((await fx.get(fx.answer(betaKey, beta.body.meta.rev))).status, 200);
    }
    if (boundary === 'aborted') delayed.abort();
    gate.resolve();
    await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
    if (boundary !== 'aborted') assert.equal((await delayed.response).status, 200);
    const rev = (await fx.broker.detail(key, {})).meta.rev;
    const rejected = await fx.get(fx.answer(key, rev));
    assert.equal(rejected.status, 403); assert.equal(rejected.body.error, 'answer_out_of_scope');
    await fx.newTurn();
    const fresh = await fx.get(url); assert.equal(fresh.status, 200);
    assert.equal((await fx.get(fx.answer(key, fresh.body.meta.rev))).status, 200,
      'same real endpoint binds in a live unfrozen turn');
  });

for (const frozen of [false, true]) test(`real session reads preserve four revs and evict only the oldest inserted rev, frozen=${frozen}`, async t => {
  const fx = await answerRouterFixture(t), key = fx.alpha.sessions[0].key, revs = [];
  const detail = () => fx.get(`${BASE}/sessions/${key}`);
  const first = await detail(); revs.push(first.body.meta.rev);
  if (frozen) assert.equal((await fx.get(fx.answer(key, revs[0]))).status, 200);
  for (let i = 0; i < 3; i++) {
    fx.beta.instructions[0].text += ` rev-${i}`; fx.write(fx.beta);
    revs.push((await detail()).body.meta.rev);
  }
  await detail(); // Same revision cannot consume a fifth slot.
  const handle = fx.hub.captureHubTurn(fx.hub.current());
  for (const rev of revs) assert.equal(fx.hub.answerBinding(handle, key, rev).machineId, 'alpha');
  fx.beta.instructions[0].text += ' fifth'; fx.write(fx.beta);
  revs.push((await detail()).body.meta.rev);
  assert.equal((await fx.get(fx.answer(key, revs[0]))).body.error, 'snapshot_changed');
  const remaining = frozen ? 4 : 5;
  for (let i = 0; i < remaining; i++) assert.equal((await fx.get(fx.answer(key, revs[1 + i % 4]))).status, 200);
  assert.equal((await fx.get(fx.answer(key, revs.at(-1)))).body.error, 'answer_budget_exceeded');
  assert.equal(fx.calls.length, 5, 'evicted rev rejection never reserved an attempt');
});

test('in-flight answer uses its captured binding and requested meta.rev after rev eviction and machine refresh', async t => {
  const task = later(), started = later();
  const fx = await answerRouterFixture(t, { query: () => { started.resolve(); return task.promise; } });
  const key = fx.alpha.sessions[0].key, initial = await fx.get(`${BASE}/sessions/${key}`), rev = initial.body.meta.rev;
  const pending = fx.pending(fx.answer(key, rev)); await started.promise;
  const originalHash = fx.calls[0].rev;
  for (let i = 0; i < 5; i++) {
    fx.alpha.instructions[0].text += ` update-${i}`; fx.write(fx.alpha);
    assert.equal((await fx.get(`${BASE}/sessions/${key}`)).status, 200);
  }
  assert.equal((await fx.get(fx.answer(key, rev))).body.error, 'snapshot_changed');
  task.resolve(fx.result);
  const response = await pending.response;
  assert.equal(response.status, 200); assert.equal(response.body.meta.rev, rev);
  assert.equal(fx.calls.length, 1); assert.equal(fx.calls[0].rev, originalHash);
  assert.notEqual(originalHash, store.readSnapshotHashed(fx.state, 'alpha').sha256);
});

for (const frozen of [false, true]) test(`same-key machine collision in real returned cards cannot rebind, frozen=${frozen}`, async t => {
  const fx = await answerRouterFixture(t), key = fx.alpha.sessions[0].key;
  const initial = await fx.get(`${BASE}/sessions/${key}`), rev = initial.body.meta.rev;
  if (frozen) assert.equal((await fx.get(fx.answer(key, rev))).status, 200);
  const betaKey = fx.beta.sessions[0].key;
  fx.beta.sessions[0].key = key;
  fx.beta.instructions.filter(row => row.session_key === betaKey).forEach(row => { row.session_key = key; });
  assert.equal(validateSnapshot(fx.beta).ok, true);
  fx.write(fx.beta);
  const collision = await fx.get(`${BASE}/sessions?machine=beta`);
  assert.ok(collision.body.sessions.some(row => row.key === key));
  assert.equal((await fx.get(fx.answer(key, collision.body.meta.rev))).body.error, 'snapshot_changed');
  assert.equal((await fx.get(fx.answer(key, rev))).status, 200);
  assert.ok(fx.calls.every(input => input.machineId === 'alpha'));
  // Now start with both collisions in a single real list response. The first returned one wins.
  await fx.newTurn();
  const together = await fx.get(`${BASE}/sessions`);
  const duplicates = together.body.sessions.filter(row => row.key === key);
  assert.equal(duplicates.length, 2);
  assert.equal((await fx.get(fx.answer(key, together.body.meta.rev))).status, 200);
  const firstMachine = duplicates[0].machine === fx.alpha.machine.label ? 'alpha' : 'beta';
  assert.equal(fx.calls.at(-1).machineId, firstMachine);
});
