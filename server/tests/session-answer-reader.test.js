'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const snapshotReader = require('../../scripts/lib/sessionSnapshotReader.cjs');
const policy = require('../services/observeSnapshotPolicy.js');
const { setup, cases, user, meta, message, TS } = require('./fixtures/session-snapshot/a1a.cjs');
function targetFor(f, id) {
  const snapshot = snapshotReader.runSnapshot(f.options);
  const instruction = id ? snapshot.instructions.find(row => row.id === id) : snapshot.instructions[0];
  const session = snapshot.sessions.find(row => row.key === instruction.session_key);
  return { instrId: instruction.id, ref: instruction.ref, file_fp: session.file_fp };
}
function query(f, target, extra = {}) {
  return require('../../scripts/lib/sessionAnswerReader.cjs').readAnswer({ ...f.options, ...target, ...extra });
}
for (const provider of ['claude', 'codex']) test(`exact nonempty ${provider} final and snapshot body isolation`, t => {
  const f = setup(t, cases[provider]);
  const target = targetFor(f);
  const result = query(f, target, { diag: true });
  assert.equal(result.status, 'final');
  assert.equal(result.text, 'ANSWER_BODY_SENTINEL');
  assert.equal(result.answer_at, TS);
  assert.deepEqual(result.target, target);
  assert.equal(policy.validateAnswerEnvelope(result, { allowDiag: true }).ok, true);
  assert.equal(JSON.stringify(result.diag).includes('ANSWER_BODY_SENTINEL'), false);
  assert.equal(policy.validateAnswerEnvelope(result).ok, false);
  assert.equal(JSON.stringify(snapshotReader.runSnapshot(f.options)).includes('ANSWER_BODY_SENTINEL'), false);
});
module.exports = { targetFor, query };
const assistant = (uuid = 'a', parentUuid = 'u', stop = 'end_turn', text = 'ANSWER_BODY_SENTINEL', extra = {}) => ({
  type: 'assistant', sessionId: 's', uuid, parentUuid, timestamp: TS,
  message: { id: 'msg', stop_reason: stop, content: [{ type: 'text', text }] }, ...extra
});
const event = (type, turn_id = 't', extra = {}) => ({ type: 'event_msg', timestamp: TS, payload: { type, turn_id, ...extra } });
const agent = (phase, text = 'Fallback') => ({ type: 'response_item', timestamp: TS,
  payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] } });
const queued = parentUuid => ({ type: 'attachment', sessionId: 's', uuid: 'q', parentUuid, timestamp: TS,
  attachment: { type: 'queued_command', origin: { kind: 'human' }, commandMode: 'prompt', prompt: 'Queued', humanTurn: true } });
const writeRecords = (f, records) => fs.writeFileSync(f.files[0], records.map(JSON.stringify).join('\n') + '\n');
const claudeCases = [
  ['multiple text blocks, same message group', [user('Synthetic instruction A'), assistant(), assistant('b', 'a', 'end_turn', 'Second')], 'final', 'ANSWER_BODY_SENTINEL\n\nSecond'],
  ['thinking ignored', [user('Synthetic instruction A'), assistant('a', 'u', 'end_turn', '', { message: { id: 'm', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'SECRET_THINKING' }] } })], 'no_text', null],
  ['tool_use resumes', [user('Synthetic instruction A'), assistant(), assistant('b', 'a', 'tool_use')], 'pending', null],
  ['tool_result resumes', [user('Synthetic instruction A'), assistant(), user('', { uuid: 'tr', parentUuid: 'a', message: { content: [{ type: 'tool_result', content: 'SECRET_TOOL' }] } })], 'pending', null],
  ['stop hook resumes', [user('Synthetic instruction A'), assistant(), user('hook', { uuid: 'h', parentUuid: 'a', promptSource: 'system' }), assistant('b', 'h', 'tool_use')], 'pending', null],
  ['interrupted', [user('Synthetic instruction A'), user('[Request interrupted by user]', { uuid: 'i', parentUuid: 'u' })], 'interrupted', null],
  ['competing final/open branch', [user('Synthetic instruction A'), assistant(), assistant('b', 'u', 'tool_use')], 'unbound', null, 'branch_conflict'],
  ['duplicate assistant uuid', [user('Synthetic instruction A'), assistant(), assistant()], 'unbound', null, 'branch_conflict'],
  ['missing parent', [user('Synthetic instruction A'), assistant('a', 'missing')], 'unbound', null, 'chain_broken'],
  ['cycle', [user('Synthetic instruction A'), assistant('a', 'b'), assistant('b', 'a')], 'unbound', null, 'branch_conflict'],
  ['sidechain ignored', [user('Synthetic instruction A'), assistant(), assistant('b', 'u', 'tool_use', 'PRIVATE_SIDECHAIN', { isSidechain: true })], 'final', 'ANSWER_BODY_SENTINEL'],
  ['compact cannot restore chain', [user('Synthetic instruction A'), user('replacement', { uuid: 'compact', parentUuid: null, isCompactSummary: true }), assistant('a', 'compact')], 'pending', null],
  ['next instruction ends prior segment', [user('Synthetic instruction A'), assistant(), user('Next', { uuid: 'next', parentUuid: 'a' }), assistant('b', 'next', 'end_turn', 'Wrong')], 'final', 'ANSWER_BODY_SENTINEL']
];
for (const [name, records, status, text, reason = null] of claudeCases) test(`Claude ${name}`, t => {
  const f = setup(t); const target = targetFor(f); writeRecords(f, records);
  const result = query(f, target, { diag: true });
  assert.equal(result.status, status); assert.equal(result.text, text); assert.equal(result.reason, reason);
  assert.equal(policy.validateAnswerEnvelope(result, { allowDiag: true }).ok, true);
});
for (const placement of ['inside', 'sibling', 'before']) test(`queued ${placement} does not change S`, t => {
  const q = queued(placement === 'inside' ? 'u' : null);
  const records = placement === 'before' ? [q, user('Synthetic instruction A'), assistant()] :
    [user('Synthetic instruction A'), q, assistant('a', placement === 'inside' ? 'q' : 'u')];
  const f = setup(t, [['claude', 's', records]]);
  assert.equal(query(f, targetFor(f, 'claude:s:uu')).status, 'final');
  assert.equal(query(f, targetFor(f, 'claude:s:uq')).status, 'queued_joined');
});
for (const local of [false, true]) test(`slash local=${local}`, t => {
  const start = user('<command-name>/custom</command-name>');
  const records = [start, local ? user('<local-command-stdout>done', { uuid: 'out', parentUuid: 'u' }) : assistant()];
  const f = setup(t, [['claude', 's', records]]);
  const answer = query(f, targetFor(f));
  assert.equal(answer.status, local ? 'local_command' : 'final');
});
const codexCases = [
  ['priority and duplicate representation', [meta(), event('task_started'), message(), agent('final_answer'), event('task_complete', 't', { last_agent_message: 'Priority' })], 'final', 'Priority'],
  ['fallback', [meta(), event('task_started'), message(), agent('final_answer'), event('task_complete', 't', { last_agent_message: '' })], 'final', 'Fallback'],
  ['open final', [meta(), event('task_started'), message(), agent('final_answer')], 'pending', null],
  ['commentary ignored', [meta(), event('task_started'), message(), agent('commentary'), event('task_complete')], 'no_text', null],
  ['phase absent', [meta(), event('task_started'), message(), agent(undefined)], 'unbound', null, 'unsupported_format'],
  ['aborted', [meta(), event('task_started'), message(), event('turn_aborted')], 'interrupted', null],
  ['complete aborted conflict', [meta(), event('task_started'), message(), event('task_complete'), event('turn_aborted')], 'unbound', null, 'segment_conflict'],
  ['no completion', [meta(), event('task_started'), message()], 'pending', null],
  ['outside before start', [meta(), message(), event('task_started'), event('task_complete')], 'unbound', null, 'segment_conflict'],
  ['overlap', [meta(), event('task_started'), message(), event('task_started', 'other'), event('task_complete')], 'unbound', null, 'segment_conflict'],
  ['turn mismatch', [meta(), event('task_started'), message(), event('task_complete', 'other')], 'unbound', null, 'segment_conflict'],
  ['context mismatch', [meta(), event('task_started'), message(), { type: 'turn_context', timestamp: TS, payload: { turn_id: 'other' } }, event('task_complete')], 'unbound', null, 'segment_conflict'],
  ['between closed segments', [meta(), event('task_started'), event('task_complete'), message()], 'unbound', null, 'segment_conflict']
];
for (const [name, records, status, text, reason = null] of codexCases) test(`Codex ${name}`, t => {
  const f = setup(t, cases.codex); const target = targetFor(f); writeRecords(f, records);
  const result = query(f, target, { diag: true });
  assert.equal(result.status, status); assert.equal(result.text, text); assert.equal(result.reason, reason);
  assert.equal(policy.validateAnswerEnvelope(result, { allowDiag: true }).ok, true);
});
test('Codex multiple instructions share completed turn, completed_at fallback', t => {
  const f = setup(t, [['codex', 's', [meta(), event('task_started'), message(), message({ id: 'second' }),
    event('task_complete', 't', { last_agent_message: 'Shared', completed_at: 'invalid' })]]]);
  for (const id of ['codex:s:n1', 'codex:s:isecond']) {
    const a = query(f, targetFor(f, id)); assert.equal(a.text, 'Shared'); assert.equal(a.shared_turn, true); assert.equal(a.answer_at, TS);
  }
});
for (const [name, mutate, status, reason] of [
  ['exclude after snapshot', (f) => { const c = JSON.parse(fs.readFileSync(f.config)); c.exclude.sessions.push('claude:s'); fs.writeFileSync(f.config, JSON.stringify(c)); }, 'withheld', 'excluded'],
  ['any deletion rule', f => { const c = JSON.parse(fs.readFileSync(f.config)); c.exclude.instructions.push({ id: 'claude:s:uother' }); fs.writeFileSync(f.config, JSON.stringify(c)); }, 'withheld', 'deleted_rule'],
  ['mixed identity', f => writeRecords(f, [user('Synthetic instruction A'), assistant(), user('Other', { sessionId: 'other', uuid: 'other' })]), 'withheld', 'held'],
  ['duplicate user', f => writeRecords(f, [user('Synthetic instruction A'), user('duplicate')]), 'withheld', 'held'],
  ['invalid timestamp', f => writeRecords(f, [user('Synthetic instruction A'), assistant('a', 'u', 'end_turn', 'x', { timestamp: 'bad' })]), 'withheld', 'held'],
  ['identity mismatch', f => writeRecords(f, [user('Synthetic instruction A', { sessionId: 'other' }), assistant()]), 'withheld', 'identity_mismatch'],
  ['ref mismatch', (f, target) => { target.ref = '0'.repeat(16); }, 'target_changed', 'ref_mismatch'],
  ['missing fingerprint', (f, target) => { delete target.file_fp; }, 'target_changed', 'file_missing'],
  ['missing file', (f, target) => { target.file_fp = '0'.repeat(16); }, 'target_changed', 'file_missing'],
  ['hardlinks', f => fs.linkSync(f.files[0], path.join(path.dirname(f.files[0]), 'alias.jsonl')), 'withheld', 'held'],
  ['one MiB limit', f => writeRecords(f, [user('Synthetic instruction A'), assistant('a', 'u', 'end_turn', 'x'.repeat(1024 * 1024 + 1))]), 'withheld', 'too_large']
]) test(`policy ${name}`, t => {
  const f = setup(t); const target = targetFor(f); mutate(f, target);
  const result = query(f, target); assert.equal(result.status, status); assert.equal(result.reason, reason); assert.equal(result.text, null);
});
test('exec sessions withheld', t => {
  const f = setup(t, cases.codex); const target = targetFor(f);
  writeRecords(f, [meta({ source: 'exec' }), event('task_started'), message(), event('task_complete', 't', { last_agent_message: 'PRIVATE_EXEC' })]);
  assert.equal(query(f, target).reason, 'excluded');
});
test('lookup reads only matched file, one S0 pass; incomplete enumeration with and without match', t => {
  const f = setup(t); const target = targetFor(f);
  const unrelated = path.join(path.dirname(f.files[0]), 'other.jsonl'); fs.writeFileSync(unrelated, 'UNRELATED_NEVER_READ');
  const originalOpen = fs.openSync, originalRead = fs.readSync; let fd, bytes = 0;
  t.mock.method(fs, 'openSync', (name, ...args) => { assert.notEqual(name, unrelated); const value = originalOpen(name, ...args); if (name === f.files[0]) fd = value; return value; });
  t.mock.method(fs, 'readSync', (descriptor, ...args) => { const count = originalRead(descriptor, ...args); if (descriptor === fd) bytes += count; return count; });
  assert.equal(query(f, target).status, 'final'); assert.equal(bytes, fs.statSync(f.files[0]).size);
  const denied = path.join(path.dirname(f.files[0]), 'denied'); fs.mkdirSync(denied);
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (name, ...args) => { if (name === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return original(name, ...args); });
  assert.equal(query(f, target).status, 'final');
  assert.equal(query(f, { ...target, file_fp: '0'.repeat(16) }).reason, 'read_limit');
});
test('large path, line limit, EOF inode change', t => {
  const f = setup(t); const target = targetFor(f);
  const padding = JSON.stringify({ type: 'padding', value: 'x'.repeat(1024 * 1024) }) + '\n';
  for (let i = 0; i < 17; i++) fs.appendFileSync(f.files[0], padding);
  assert.equal(query(f, target).text, 'ANSWER_BODY_SENTINEL');
  const original = fs.statSync;
  t.mock.method(fs, 'statSync', (name, options) => { const s = original(name, options); return name === f.files[0] ? { ...s, ino: typeof s.ino === 'bigint' ? s.ino + 1n : s.ino + 1 } : s; });
  assert.equal(query(f, target).reason, 'file_changed');
  t.mock.restoreAll();
  fs.appendFileSync(f.files[0], 'x'.repeat(8 * 1024 * 1024 + 1));
  assert.equal(query(f, target).reason, 'read_limit');
});

test('sanitization preserves exact nonempty text, fixed point, UTF-16 boundary and raw UTF-8 bound', t => {
  const f = setup(t); const target = targetFor(f);
  const secret = 'ghp_' + 'Q'.repeat(40);
  writeRecords(f, [user('Synthetic instruction A'), assistant('a', 'u', 'end_turn', 'Safe ' + secret + ' ' + 'x'.repeat(8100))]);
  const answer = query(f, target);
  assert.equal(answer.status, 'final'); assert.equal(answer.redacted, true); assert.equal(answer.truncated, true);
  assert.equal(answer.text.length, 8000); assert.equal(answer.text.includes(secret), false);
  assert.equal(policy.finalizeAnswerText(answer.text).value, answer.text);
  writeRecords(f, [user('Synthetic instruction A'), assistant('a', 'u', 'end_turn', 'x'.repeat(7999) + '😀')]);
  const boundary = query(f, target); assert.equal(boundary.text.length, 7999); assert.equal(boundary.truncated, true);
  writeRecords(f, [user('Synthetic instruction A'), assistant('a', 'u', 'end_turn', '가'.repeat(350000))]);
  assert.equal(query(f, target).reason, 'too_large');
});
test('combined message group limit is measured before sanitization, includes join separators', t => {
  const f = setup(t); const target = targetFor(f);
  writeRecords(f, [user('Synthetic instruction A'), assistant('a', 'u', 'end_turn', 'x'.repeat(524288)),
    assistant('b', 'a', 'end_turn', 'y'.repeat(524288))]);
  assert.equal(query(f, target).reason, 'too_large');
});
test('same-id records interleaved with a reminder remain in the final group', t => {
  const f = setup(t); const target = targetFor(f);
  writeRecords(f, [user('Synthetic instruction A'), assistant(), { type: 'system', uuid: 'reminder', parentUuid: 'a', timestamp: TS, sessionId: 's' },
    assistant('b', 'reminder', 'end_turn', 'Second')]);
  assert.equal(query(f, target).text, 'ANSWER_BODY_SENTINEL\n\nSecond');
});
test('target fp alone chooses original file after a same-session competitor appears', t => {
  const f = setup(t); const target = targetFor(f);
  const competitor = path.join(path.dirname(f.files[0]), 'competitor.jsonl');
  fs.writeFileSync(competitor, [user('Synthetic instruction A'), assistant('a', 'u', 'end_turn', 'WRONG_FILE')].map(JSON.stringify).join('\n') + '\n');
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', (name, ...args) => { assert.notEqual(name, competitor); return original(name, ...args); });
  assert.equal(query(f, target).text, 'ANSWER_BODY_SENTINEL');
});
test('S0 excludes concurrent appended answer and verifies short files too', t => {
  const f = setup(t); const target = targetFor(f);
  writeRecords(f, [user('Synthetic instruction A')]);
  const original = fs.readSync; let appended = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = original(...args);
    if (!appended) { appended = true; fs.appendFileSync(f.files[0], JSON.stringify(assistant()) + '\n'); }
    return count;
  });
  assert.equal(query(f, target).status, 'pending');
});
test('malformed record versus unfinished final JSON; core state transition remains shared', t => {
  const f = setup(t); const target = targetFor(f);
  fs.appendFileSync(f.files[0], '{"type":');
  assert.equal(query(f, target).status, 'final');
  fs.appendFileSync(f.files[0], '\n');
  assert.equal(query(f, target).status, 'unbound');
  assert.equal(query(f, target).reason, 'unsupported_format');
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/lib/sessionAnswerReader.cjs'), 'utf8');
  assert.match(source, /core\.claudeStatus\(/); assert.match(source, /core\.codexStatus\(/);
  assert.doesNotMatch(source, /resolveTarget\(|scanSessions\(/);
});
test('EOF shortening and open-inode mismatch refuse an answer', t => {
  const f = setup(t); const target = targetFor(f);
  const original = fs.fstatSync; let initial = true;
  t.mock.method(fs, 'fstatSync', (fd, opts) => {
    const stats = original(fd, opts);
    if (opts?.bigint) { if (initial) initial = false; else return { ...stats, size: 0n }; }
    return stats;
  });
  assert.equal(query(f, target).reason, 'file_changed');
  t.mock.restoreAll();
  t.mock.method(fs, 'fstatSync', (fd, opts) => { const s = original(fd, opts); return opts?.bigint ? { ...s, ino: s.ino + 1n } : s; });
  assert.equal(query(f, target).reason, 'file_changed');
});
test('file and metadata ceilings return unavailable/read_limit', t => {
  const f = setup(t); const target = targetFor(f);
  const original = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (fd, opts) => { const s = original(fd, opts); return opts?.bigint ? { ...s, size: 256n * 1024n * 1024n + 1n } : s; });
  // Sparse virtual size must hit the bound before reading beyond the selected physical file.
  assert.equal(query(f, target).reason, 'read_limit');
  t.mock.restoreAll();
  writeRecords(f, [user('Synthetic instruction A'), assistant()]);
  const padding = JSON.stringify({ type: 'padding' }) + '\n'; fs.appendFileSync(f.files[0], padding.repeat(100000));
  assert.equal(query(f, target).reason, 'read_limit');
});
test('empty text blocks retain file-order separators, thinking records add none', t => {
  const f = setup(t); const target = targetFor(f);
  writeRecords(f, [user('Synthetic instruction A'), assistant('a', 'u', 'end_turn', ''), assistant('b', 'a', 'end_turn', 'Second')]);
  assert.equal(query(f, target).text, '\n\nSecond');
});
for (const mode of ['excluded', 'deleted_rule', 'ref_mismatch']) test(`result precedence ${mode} before read limit`, t => {
  const f = setup(t); const target = targetFor(f);
  fs.appendFileSync(f.files[0], 'x'.repeat(8 * 1024 * 1024 + 1));
  const config = JSON.parse(fs.readFileSync(f.config));
  if (mode === 'excluded') config.exclude.sessions.push('claude:s');
  if (mode === 'deleted_rule') config.exclude.instructions.push({ id: 'claude:s:uother' });
  if (mode === 'ref_mismatch') target.ref = '0'.repeat(16);
  fs.writeFileSync(f.config, JSON.stringify(config));
  assert.equal(query(f, target).reason, mode);
});
test('answer lookup delegates enumeration and S0 reads to snapshot IO exports', t => {
  const f = setup(t); const target = targetFor(f);
  assert.equal(typeof snapshotReader.listFiles, 'function');
  assert.equal(typeof snapshotReader.transcriptRecords, 'function');
  const listing = t.mock.method(snapshotReader, 'listFiles');
  const streaming = t.mock.method(snapshotReader, 'transcriptRecords');
  assert.equal(query(f, target).text, 'ANSWER_BODY_SENTINEL');
  assert.equal(listing.mock.callCount(), 1); assert.equal(streaming.mock.callCount(), 1);
});
test('tool_use text does not join the terminal same-message answer group', t => {
  const f = setup(t); const target = targetFor(f);
  writeRecords(f, [user('Synthetic instruction A'), assistant('tool', 'u', 'tool_use', 'PRIVATE_TOOL_NARRATION'),
    assistant('a', 'tool', 'end_turn', 'Final')]);
  const a = query(f, target, { diag: true });
  assert.equal(a.text, 'Final'); assert.deepEqual(a.diag.evidence_ids, ['a']);
});
for (const c of require('./fixtures/session-snapshot/answer-chain.cjs').cases) test(`corrected chain ${c.name}`, t => {
  const f = setup(t); const target = targetFor(f); writeRecords(f, c.records);
  const a = query(f, target, { diag: true });
  assert.equal(a.status, c.status); assert.equal(a.reason, c.reason ?? null);
  assert.equal(a.text, c.status === 'final' ? 'ANSWER_BODY_SENTINEL' : null);
  if (c.status !== 'unbound') assert.deepEqual(a.diag, { evidence_ids: c.evidence_ids, segment: { start_id: 'u', end_id: c.end_id } });
});
for (const provider of ['claude', 'codex']) test(`answer memory retains only ${provider} final candidates`, t => {
  const core = require('../../scripts/lib/sessionTranscriptCore.cjs');
  const f = setup(t, cases[provider]); const target = targetFor(f);
  const records = provider === 'claude' ? [user('Synthetic instruction A'), assistant('tool', 'u', 'tool_use', 'PRIVATE_PROGRESS'),
    assistant('a', 'tool', 'end_turn', 'Candidate')] : [meta(), event('task_started'), message(), agent('commentary', 'PRIVATE_PROGRESS'),
    agent('final_answer', 'Candidate'), event('task_complete', 't', { last_agent_message: 'Completed' })];
  writeRecords(f, records); const seen = [];
  const fn = provider === 'claude' ? 'claudeStatus' : 'codexStatus', original = core[fn];
  t.mock.method(core, fn, rows => { seen.push(...rows); return original(rows); });
  const result = query(f, target); assert.equal(result.status, 'final');
  const dropped = seen.filter(r => provider === 'claude' ? r.type === 'assistant' && r.message?.stop_reason === 'tool_use'
    : r.payload?.role === 'assistant' && r.payload.phase === 'commentary');
  assert.ok(dropped.length > 0);
  for (const r of dropped) { assert.equal(Object.hasOwn(r, 'answerText'), false); assert.ok(r.answerBytes > 0); }
  assert.ok(seen.some(r => r.answerText === 'Candidate'));
  if (provider === 'codex') assert.ok(seen.some(r => r.answerText === 'Completed'));
});
for (const c of require('./fixtures/session-snapshot/answer-parallel-tools.cjs').cases) test(`parallel tools reader ${c.name}`, t => {
  const f = setup(t); const target = targetFor(f); writeRecords(f, c.records);
  const a = query(f, target, { diag: true });
  assert.equal(a.status, c.status); assert.equal(a.reason, c.reason ?? null);
  assert.equal(a.text, c.status === 'final' ? 'ANSWER_BODY_SENTINEL' : null);
  if (c.status !== 'unbound') assert.deepEqual(a.diag, { evidence_ids: c.evidence_ids, segment: { start_id: 'u', end_id: c.end_id } });
  assert.equal(JSON.stringify(a.diag).includes('PRIVATE_TOOL'), false);
});
test('parallel tool identifiers share the 100000 metadata ceiling', t => {
  const f = setup(t); const target = targetFor(f);
  writeRecords(f, [user('Synthetic instruction A'), { type: 'assistant', sessionId: 's', uuid: 'tool', parentUuid: 'u', timestamp: TS,
    message: { id: 'parallel-message', stop_reason: 'tool_use', content: Array.from({ length: 100000 }, () => ({ type: 'tool_use', id: 'call' })) } }]);
  const a = query(f, target); assert.equal(a.status, 'unavailable'); assert.equal(a.reason, 'read_limit'); assert.equal(a.text, null);
});
for (const suffix of ['n1', 'n2']) test(`v6 R1 B2 abandoned first Codex turn ${suffix}`, t => {
  const f = setup(t, cases.codex); const target = targetFor(f);
  if (suffix === 'n2') {
    writeRecords(f, [meta(), event('task_started', 'T1'), message(), event('task_complete', 'T1'),
      event('task_started', 'T2'), message(), event('task_complete', 'T2', { last_agent_message: 'SAFE' })]);
    Object.assign(target, targetFor(f, 'codex:s:n2'));
  }
  writeRecords(f, [meta(), event('task_started', 'T1'), message(), event('task_started', 'T2'), message(), event('task_complete', 'T2', { last_agent_message: 'SAFE' })]);
  const a = query(f, target); assert.equal(a.status, suffix === 'n1' ? 'unbound' : 'final');
  assert.equal(a.reason, suffix === 'n1' ? 'segment_conflict' : null);
  assert.equal(a.text, suffix === 'n1' ? null : 'SAFE');
});
for (const provider of ['claude', 'codex']) test(`R1 S1 partially observed ${provider} mixed identity precedes read_limit`, t => {
  const f = setup(t, cases[provider]); const target = targetFor(f);
  fs.appendFileSync(f.files[0], JSON.stringify(provider === 'claude' ? user('Other', { uuid: 'other', sessionId: 'other' }) : meta({ id: 'other' })) + '\n' + 'x'.repeat(8 * 1024 * 1024 + 1));
  const a = query(f, target); assert.equal(a.status, 'withheld'); assert.equal(a.reason, 'held');
});
for (const order of ['queued-before-user', 'user-before-queued']) test(`R1 S1 partial queued alias ${order} precedes read_limit`, t => {
  const f = setup(t); const target = targetFor(f);
  const q = { ...queued('a'), source_uuid: 'alias' };
  const u = user('Another', { uuid: 'another', parentUuid: 'a', source_uuid: 'alias' });
  const extra = order === 'queued-before-user' ? [q, u] : [u, q];
  fs.appendFileSync(f.files[0], extra.map(JSON.stringify).join('\n') + '\n' + 'x'.repeat(8 * 1024 * 1024 + 1));
  const a = query(f, target); assert.equal(a.status, 'withheld'); assert.equal(a.reason, 'held');
});
for (const c of require('./fixtures/session-snapshot/answer-codex-v6.cjs').cases) test(`R2 Codex v6 reader ${c.name}`, t => {
  const f = setup(t, [['codex', 's', c.records]]); const target = targetFor(f, c.id);
  const a = query(f, target, { diag: true });
  assert.equal(a.status, c.status); assert.equal(a.reason, c.status === 'unbound' ? 'segment_conflict' : null);
  assert.equal(a.text, c.status === 'final' ? 'SAFE' : null);
  assert.equal(a.diag.segment.start_id, c.turn);
});
test('R2 unbound Claude diag identifies the instruction', t => {
  const c = require('./fixtures/session-snapshot/answer-parallel-tools.cjs').cases.find(c => c.name.includes('R1 B1'));
  const f = setup(t); const target = targetFor(f); writeRecords(f, c.records);
  const a = query(f, target, { diag: true }); assert.equal(a.status, 'unbound'); assert.equal(a.reason, 'branch_conflict');
  assert.deepEqual(a.diag, { evidence_ids: [], segment: { start_id: 'u', end_id: null } });
});
for (const c of require('./fixtures/session-snapshot/answer-send-now.cjs').cases) test(`send-now reader ${c.name}`, t => {
  const records = require('./fixtures/session-snapshot/answer-send-now.cjs').records(c.options);
  const f = setup(t, [['claude', 's', records]]);
  const a = query(f, targetFor(f, 'claude:s:u234'), { diag: true });
  assert.equal(a.status, 'interrupted'); assert.equal(a.reason, null); assert.equal(a.text, null);
  assert.deepEqual(a.diag, { evidence_ids: ['241'], segment: { start_id: '234', end_id: '241' } });
  const next = query(f, targetFor(f, 'claude:s:u242'), { diag: true });
  assert.equal(next.status, c.options.followingAnswer ? 'final' : 'pending');
  assert.deepEqual(next.diag, { evidence_ids: c.options.followingAnswer ? ['243'] : [],
    segment: { start_id: '242', end_id: c.options.shell ? '244' : c.options.followingAnswer ? '243' : '242' } });
  assert.equal(next.text, c.options.followingAnswer ? 'ANSWER_BODY_SENTINEL' : null);
  assert.equal(JSON.stringify(snapshotReader.runSnapshot(f.options)).includes('ANSWER_BODY_SENTINEL'), false);
  assert.equal(JSON.stringify(a.diag).includes('PRIVATE_'), false);
});

for (const provider of ['claude', 'codex']) test(`deadline ${provider}: timeout invariants and unexpired/no-deadline byte equivalence`, t => {
  const f = setup(t, cases[provider]); const target = targetFor(f);
  const baseline = JSON.stringify(query(f, target, { diag: true }));
  assert.equal(JSON.stringify(query(f, target, { diag: true, deadlineAt: 1000, clock: () => 999 })), baseline);
  assert.equal(JSON.stringify(query(f, target, { diag: true, clock() { throw Error('no deadline must not read clock'); } })), baseline);
  const timeout = query(f, target, { deadlineAt: 1000, clock: () => 1001 });
  assert.equal(timeout.status, 'unavailable'); assert.equal(timeout.reason, 'timeout');
  assert.equal(timeout.text, null); assert.equal(timeout.answer_at, null);
  assert.equal(timeout.truncated, false); assert.equal(timeout.redacted, false); assert.equal(timeout.shared_turn, false);
  assert.equal(timeout.observed_at, f.options.now.toISOString());
  assert.equal(policy.validateAnswerEnvelope(timeout).ok, true);
});

test('deadline interrupts recursive enumeration without opening a transcript', t => {
  const f = setup(t); const target = targetFor(f); const config = snapshotReader.loadConfig(f.options);
  const nested = path.join(f.home, '.claude/projects/nested'); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'extra.jsonl'), '');
  let clock = 0, opens = 0, entered = false;
  const lstat = fs.lstatSync, open = fs.openSync;
  t.mock.method(fs, 'lstatSync', (filename, ...args) => {
    const value = lstat(filename, ...args);
    if (filename === nested) { clock = 1001; entered = true; }
    return value;
  });
  t.mock.method(fs, 'openSync', (...args) => { opens++; return open(...args); });
  const answer = query(f, target, { config, deadlineAt: 1000, clock: () => clock });
  assert.equal(entered, true); assert.equal(opens, 0);
  assert.equal(answer.status, 'unavailable'); assert.equal(answer.reason, 'timeout');
});

test('deadline interrupts chunk reads even when the remaining input has no records, and closes fd', t => {
  const f = setup(t); const target = targetFor(f); const config = snapshotReader.loadConfig(f.options);
  fs.appendFileSync(f.files[0], ' '.repeat(2 * 256 * 1024));
  let clock = 0, reads = 0, closes = 0;
  const read = fs.readSync, close = fs.closeSync;
  t.mock.method(fs, 'readSync', (...args) => { const count = read(...args); reads++; clock = 1001; return count; });
  t.mock.method(fs, 'closeSync', (...args) => { closes++; return close(...args); });
  const answer = query(f, target, { config, deadlineAt: 1000, clock: () => clock });
  assert.equal(answer.status, 'unavailable'); assert.equal(answer.reason, 'timeout');
  assert.equal(reads, 1); assert.equal(closes, 1); assert.equal(answer.text, null);
});

test('deadline interrupts record processing and closes the transcript fd', t => {
  const f = setup(t); const target = targetFor(f); const config = snapshotReader.loadConfig(f.options);
  let clock = 0, records = 0, closes = 0;
  const original = snapshotReader.transcriptRecords, close = fs.closeSync;
  t.mock.method(snapshotReader, 'transcriptRecords', function* (...args) {
    for (const record of original(...args)) {
      records++; if (records === 2) clock = 1001;
      yield record;
    }
  });
  t.mock.method(fs, 'closeSync', (...args) => { closes++; return close(...args); });
  const answer = query(f, target, { config, deadlineAt: 1000, clock: () => clock });
  assert.equal(answer.status, 'unavailable'); assert.equal(answer.reason, 'timeout');
  assert.equal(records, 2); assert.equal(closes, 1); assert.equal(answer.text, null);
});

test('40000 transparent parents shared by 40000 assistants are memoized within two seconds', { timeout: 10000 }, t => {
  const f = setup(t); const target = targetFor(f); const config = snapshotReader.loadConfig(f.options);
  const records = [user('Synthetic instruction A')];
  for (let index = 0; index < 40000; index++) records.push({ type: 'attachment', uuid: `m${index}`,
    parentUuid: index ? `m${index - 1}` : 'u', timestamp: TS, attachment: { type: 'summary' } });
  for (let index = 0; index < 40000; index++) records.push({ type: 'assistant', uuid: `a${index}`,
    parentUuid: 'm39999', timestamp: TS, message: { id: 'shared', stop_reason: 'end_turn', content: [] } });
  writeRecords(f, records);
  const begun = performance.now();
  const answer = query(f, target, { config });
  const elapsed = performance.now() - begun;
  assert.equal(answer.status, 'unbound'); assert.equal(answer.reason, 'branch_conflict');
  assert.equal(policy.validateAnswerEnvelope(answer).ok, true);
  assert.ok(elapsed < 2000, `memoized answer read took ${elapsed.toFixed(1)}ms`);
  t.diagnostic(`80001-record answer read: ${elapsed.toFixed(1)}ms`);
});

for (const provider of ['claude', 'codex']) test(`${provider} judgment loops check the deadline after EOF`, t => {
  const f = setup(t, cases[provider]); const target = targetFor(f);
  const records = provider === 'claude' ? [user('Synthetic instruction A')] : [meta(), event('task_started'), message()];
  for (let index = 0; index < 5000; index++) records.push(provider === 'claude'
    ? assistant(`a${index}`, index ? `a${index - 1}` : 'u') : agent('commentary'));
  if (provider === 'codex') records.push(event('task_complete', 't', { last_agent_message: 'SAFE' }));
  writeRecords(f, records);
  let eof = false, judgmentChecks = 0;
  const original = snapshotReader.transcriptRecords;
  t.mock.method(snapshotReader, 'transcriptRecords', function* (...args) { yield* original(...args); eof = true; });
  const answer = query(f, target, { deadlineAt: 1000, clock() {
    if (!eof) return 0;
    // The first post-parse check passes; the next must come from a judgment loop.
    return ++judgmentChecks === 1 ? 0 : 1001;
  } });
  assert.equal(eof, true); assert.equal(judgmentChecks, 2);
  assert.equal(answer.status, 'unavailable'); assert.equal(answer.reason, 'timeout');
  assert.equal(answer.text, null); assert.equal(policy.validateAnswerEnvelope(answer).ok, true);
});

// Captured before parent memoization; only the inode-dependent fingerprint is normalized.
const PRE_MEMOIZATION_ANSWER_BYTES = {
  "claude": "{\"schema\":\"palantir.answer/1\",\"kind\":\"answer\",\"machine_id\":\"m\",\"reader_build\":\"0123456789abcdef\",\"target\":{\"instrId\":\"claude:s:uu\",\"ref\":\"fd82305462f77ffc\",\"file_fp\":\"0000000000000000\"},\"status\":\"final\",\"reason\":null,\"text\":\"ANSWER_BODY_SENTINEL\",\"truncated\":false,\"redacted\":false,\"shared_turn\":false,\"answer_at\":\"2026-10-08T02:00:00.000Z\",\"observed_at\":\"2026-10-08T03:00:00.000Z\",\"diag\":{\"evidence_ids\":[\"a\"],\"segment\":{\"start_id\":\"u\",\"end_id\":\"a\"}}}",
  "codex": "{\"schema\":\"palantir.answer/1\",\"kind\":\"answer\",\"machine_id\":\"m\",\"reader_build\":\"0123456789abcdef\",\"target\":{\"instrId\":\"codex:s:n1\",\"ref\":\"24aaeeab19987449\",\"file_fp\":\"0000000000000000\"},\"status\":\"final\",\"reason\":null,\"text\":\"ANSWER_BODY_SENTINEL\",\"truncated\":false,\"redacted\":false,\"shared_turn\":false,\"answer_at\":\"2026-10-08T02:00:00.000Z\",\"observed_at\":\"2026-10-08T03:00:00.000Z\",\"diag\":{\"evidence_ids\":[\"t\"],\"segment\":{\"start_id\":\"t\",\"end_id\":\"t\"}}}",
  "queued_resume": "{\"schema\":\"palantir.answer/1\",\"kind\":\"answer\",\"machine_id\":\"m\",\"reader_build\":\"0123456789abcdef\",\"target\":{\"instrId\":\"claude:s:uu\",\"ref\":\"fd82305462f77ffc\",\"file_fp\":\"0000000000000000\"},\"status\":\"pending\",\"reason\":null,\"text\":null,\"truncated\":false,\"redacted\":false,\"shared_turn\":false,\"answer_at\":null,\"observed_at\":\"2026-10-08T03:00:00.000Z\",\"diag\":{\"evidence_ids\":[],\"segment\":{\"start_id\":\"u\",\"end_id\":\"b\"}}}"
};
for (const [name, expected] of Object.entries(PRE_MEMOIZATION_ANSWER_BYTES)) test(
  `answer serialized bytes preserve pre-memoization ${name}`, t => {
    const f = setup(t, cases[name]); const answer = query(f, targetFor(f), { diag: true });
    answer.target.file_fp = '0000000000000000';
    assert.equal(JSON.stringify(answer), expected);
  });
