'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reader = require('../../scripts/lib/sessionSnapshotReader.cjs');
const policy = require('../services/observeSnapshotPolicy.js');
const { setup, cases } = require('./fixtures/session-snapshot/a1a.cjs');
const { capture } = require('./fixtures/session-snapshot/helpers.cjs');
function requestFor(f) {
  const s = reader.runSnapshot(f.options); const i = s.instructions[0];
  return { schema: 'palantir.answer-request/1', op: 'answer_query', now: f.request.now,
    target: { kind: 'instruction', instrId: i.id, ref: i.ref, file_fp: s.sessions[0].file_fp }, diag: true };
}
for (const provider of ['claude', 'codex']) test(`remote answer_query ${provider}, hash and CLI body-free output`, async t => {
  const f = setup(t, cases[provider]); const request = requestFor(f);
  const api = await import('../../scripts/lib/sessionSnapshotBundle.mjs');
  const bundle = api.buildBundle({ request });
  assert.equal(api.MANIFEST.includes('scripts/lib/sessionAnswerReader.cjs'), true);
  const result = await api.runExecutor({ target: f.target, bundle, sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env });
  const received = api.receiveEnvelope(result, { expectedKinds: ['answer'], expectedReaderBuild: bundle.readerBuild,
    expectedMachineId: 'm', expectedTarget: request.target, allowDiag: true });
  assert.equal(received.ok, true, result.stdout.toString()); assert.equal(received.envelope.text, 'ANSWER_BODY_SENTINEL');
  assert.equal(api.receiveEnvelope(result, { expectedKinds: ['answer'], expectedReaderBuild: bundle.readerBuild }).ok, false);
  for (const expected of [{ expectedMachineId: 'other' }, { expectedTarget: { ...request.target, file_fp: '0'.repeat(16) } },
    { expectedTarget: { ...request.target, instrId: 'claude:s:uother' } }, { expectedTarget: { ...request.target, ref: '0'.repeat(16) } }]) {
    assert.equal(api.receiveEnvelope(result, { expectedKinds: ['answer'], expectedReaderBuild: bundle.readerBuild,
      allowDiag: true, ...expected }).ok, false);
  }
  for (const name of ['scripts/lib/sessionAnswerReader.cjs', 'scripts/lib/sessionSnapshotLauncher.cjs', 'scripts/lib/sessionSnapshotReader.cjs']) {
    assert.equal(api.MANIFEST.includes(name), true);
    const source = fs.readFileSync(path.resolve(__dirname, '../..', name), 'utf8');
    assert.notEqual(api.buildBundle({ request, sourceOverrides: { [name]: source + '\n// hash variation\n' } }).readerBuild, bundle.readerBuild);
  }
  const cli = await import('../../scripts/session-snapshot.mjs'); const io = capture();
  assert.equal(await cli.main(['remote', '--host', f.target.host, '--remote-node', f.target.remoteNode,
    'answer', '--instruction', request.target.instrId + '#' + request.target.ref, '--file-fp', request.target.file_fp, '--diag', '--now', request.now],
  { ...io, env: f.env }), 0, io.errors());
  const safe = JSON.parse(io.output()); assert.equal(Object.hasOwn(safe, 'text'), false); assert.equal(safe.text_chars, 20);
  assert.equal(io.output().includes('ANSWER_BODY_SENTINEL'), false); assert.equal(io.output().trim().split('\n').length, 1);
  const emitted = capture();
  assert.equal(await cli.main(['remote', '--host', f.target.host, '--remote-node', f.target.remoteNode,
    'answer', '--instruction', request.target.instrId + '#' + request.target.ref, '--file-fp', request.target.file_fp,
    '--emit-envelope', '--now', request.now], { ...emitted, env: f.env }), 0, emitted.errors());
  const envelope = JSON.parse(emitted.output()); assert.equal(envelope.text, 'ANSWER_BODY_SENTINEL');
  assert.equal(Object.hasOwn(envelope, 'text_chars'), false); assert.equal(Object.hasOwn(envelope, 'diag'), false);
  assert.equal(policy.validateAnswerEnvelope(envelope).ok, true);
  assert.equal(emitted.output().trim().split('\n').length, 1);
  const rejected = capture();
  assert.equal(await cli.main(['answer', '--instruction', request.target.instrId + '#' + request.target.ref,
    '--file-fp', request.target.file_fp, '--emit-envelope', '--diag'], { ...rejected, env: f.env }), 2);
  assert.match(rejected.errors(), /^request_invalid\n/); assert.equal(rejected.output(), ''); assert.equal(rejected.spawns(), 0);

});
test('answer request strict allowlist rejects malformed/forbidden fields before reader', async t => {
  const f = setup(t); const valid = requestFor(f); const api = await import('../../scripts/lib/sessionSnapshotBundle.mjs');
  for (const request of [{ ...valid, include_exec: true }, { ...valid, diag: 'true' }, { ...valid, deadlineAt: 123 }, { ...valid, schema: 'palantir.snapshot-request/1' },
    { ...valid, target: { ...valid.target, path: '/private' } }, { ...valid, target: { ...valid.target, file_fp: 'X'.repeat(16) } },
    { ...valid, target: { ...valid.target, instrId: 'bad' } }]) {
    const bundle = api.buildBundle({ request, sourceOverrides: { 'scripts/lib/sessionSnapshotReader.cjs': "throw Error('reader must not run');" } });
    const result = await api.runExecutor({ target: f.target, bundle, sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env });
    assert.equal(JSON.parse(result.stdout).code, 'request_invalid');
  }
});
test('answer CLI invalid input uses request_invalid plus hint, no show-text escape', async t => {
  const f = setup(t); const cli = await import('../../scripts/session-snapshot.mjs');
  for (const args of [['answer'], ['answer', '--instruction', 'bad', '--file-fp', 'a'.repeat(16)],
    ['answer', '--show-text'], ['answer', '--instruction', 'claude:s:uu#' + 'a'.repeat(16), '--file-fp', 'A'.repeat(16)]]) {
    const io = capture(); assert.equal(await cli.main(args, { ...io, env: f.env }), 2);
    assert.match(io.errors(), /^request_invalid\nhint: /); assert.equal(io.spawns(), 0); assert.equal(io.output(), '');
  }
});
test('answer response closed sets, invariants, sanitizer fixed point, size and diag allowlist', t => {
  const base = { schema: 'palantir.answer/1', kind: 'answer', machine_id: 'm', reader_build: 'a'.repeat(16),
    target: { instrId: 'claude:s:uu', ref: 'a'.repeat(16), file_fp: 'b'.repeat(16) }, status: 'final', reason: null, text: 'Safe',
    truncated: false, redacted: false, shared_turn: false, answer_at: '2026-10-08T02:00:00.000Z', observed_at: '2026-10-08T03:00:00.000Z' };
  assert.equal(policy.validateAnswerEnvelope(base).ok, true);
  for (const mutation of [{ status: 'invented' }, { reason: 'invented' }, { text: '' }, { answer_at: null }, { shared_turn: true },
    { unknown: true }, { kind: 'snapshot' }, { text: 'ghp_' + 'x'.repeat(40) }, { text: 'x'.repeat(8001) },
    { status: 'pending', text: null, answer_at: null, redacted: true }, { status: 'pending', text: null, answer_at: null, shared_turn: true }]) {
    assert.equal(policy.validateAnswerEnvelope({ ...base, ...mutation }).ok, false, JSON.stringify(mutation));
  }
  for (const status of policy.ANSWER_STATUSES) {
    const terminal = ['final', 'no_text', 'interrupted'].includes(status), reasonRequired = ['withheld', 'unbound', 'unavailable', 'target_changed'].includes(status);
    const value = { ...base, status, text: status === 'final' ? 'Safe' : null, answer_at: terminal ? base.answer_at : null, reason: reasonRequired ? 'held' : null };
    assert.equal(policy.validateAnswerEnvelope(value).ok, true, status);
    assert.equal(policy.validateAnswerEnvelope({ ...value, reason: reasonRequired ? null : 'held' }).ok, false, status);
    assert.equal(policy.validateAnswerEnvelope({ ...value, answer_at: terminal ? null : base.answer_at }).ok, false, status);
  }
  const diag = { evidence_ids: ['a'], segment: { start_id: 'u', end_id: 'a' } };
  assert.equal(policy.validateAnswerEnvelope({ ...base, diag }).ok, false);
  assert.equal(policy.validateAnswerEnvelope({ ...base, diag: { ...diag, text: 'PRIVATE' } }, { allowDiag: true }).ok, false);
  assert.equal(policy.validateAnswerEnvelope({ ...base, diag: { ...diag, evidence_ids: Array(10000).fill('x'.repeat(64)) } }, { allowDiag: true }).ok, false);
});

for (const kind of ['local', 'remote']) test(`bundled ${kind} launcher sets an internal 25 second deadline`, async t => {
  const f = setup(t); const request = requestFor(f); const api = await import('../../scripts/lib/sessionSnapshotBundle.mjs');
  const launcher = 'scripts/lib/sessionSnapshotLauncher.cjs', answer = 'scripts/lib/sessionAnswerReader.cjs';
  const launcherSource = fs.readFileSync(path.resolve(__dirname, '../..', launcher), 'utf8');
  const answerSource = fs.readFileSync(path.resolve(__dirname, '../..', answer), 'utf8');
  const bundle = api.buildBundle({ request, sourceOverrides: {
    [launcher]: 'Date.now = function fakeStartTime() { return 1000; };\n' + launcherSource,
    [answer]: answerSource + `
const bundledReadAnswer = readAnswer;
module.exports.readAnswer = function verifyDeadline(options) {
  if (options.deadlineAt !== 26000) throw new Error('deadline_invalid');
  return bundledReadAnswer({ ...options, clock: () => 26001 });
};`
  } });
  const result = await api.runExecutor({ target: kind === 'local' ? { kind: 'local' } : f.target,
    bundle, sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env });
  const received = api.receiveEnvelope(result, { expectedKinds: ['answer'], expectedReaderBuild: bundle.readerBuild,
    expectedMachineId: 'm', expectedTarget: request.target, allowDiag: true });
  assert.equal(received.ok, true, result.stdout.toString());
  assert.equal(received.envelope.status, 'unavailable'); assert.equal(received.envelope.reason, 'timeout');
  assert.equal(received.envelope.text, null);
});
