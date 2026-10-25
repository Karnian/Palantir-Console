'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { createProtocol } = require('../sessionHost/protocol');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(core = {}, options = {}) {
  const output = [];
  let ended = false;
  const stream = new Duplex({ read() {}, write(chunk, encoding, done) {
    output.push(...chunk.toString().trim().split('\n').map(line => JSON.parse(line)));
    done();
  }, final(done) { ended = true; done(); } });
  if (!core.submitWithReceipt) {
    core = { ...core, async submitWithReceipt(request) {
      return { durable: true, result: await core.submit(request) };
    } };
  }
  const protocol = createProtocol({ stream, core, capability: 'secret', hostBootId: 'boot', ...options });
  return { output, protocol, get ended() { return ended; },
    raw: value => stream.push(value),
    send: value => stream.push(JSON.stringify(value) + '\n'),
    hello() { stream.push('{"type":"hello","capability":"secret"}\n'); } };
}
test('P wrong capability closes without response; correct capability returns metadata', async () => {
  const wrong = harness();
  wrong.send({ type: 'hello', capability: 'wrong' });
  await flush();
  assert.equal(wrong.ended, true);
  assert.deepEqual(wrong.output, []);
  const good = harness({}, { sdkVersion: 'fake-v1' });
  good.hello();
  await flush();
  assert.deepEqual(good.output, [{ type: 'hello', host_boot_id: 'boot', schema_version: 3, sdk_version: 'fake-v1' }]);
});
test('P pre-hello request closes without invoking core', async () => {
  let calls = 0;
  const h = harness({ submit() { calls++; } });
  h.send({ type: 'submit', id: 1, request: {} });
  await flush();
  assert.equal(h.ended, true);
  assert.equal(calls, 0);
});
test('P accepted waits for durable submit return', async () => {
  let release;
  let called = false;
  const h = harness({ submit() { called = true; return new Promise(resolve => { release = resolve; }); } });
  h.hello();
  h.send({ type: 'submit', id: 1, request: { request_key: 'key' } });
  await flush();
  assert.equal(called, true);
  assert.equal(h.output.length, 1);
  release({ state: 'written' });
  await flush();
  assert.deepEqual(h.output[1], { type: 'accepted', id: 1, request_key: 'key', result: { state: 'written' } });
});
test('P storage errors use fixed code without body or path', async () => {
  const h = harness({ submit() { throw new Error('/secret/body'); } });
  h.hello();
  h.send({ type: 'submit', id: 'x', request: {} });
  await flush();
  assert.deepEqual(h.output[1], { type: 'error', id: 'x', code: 'storage_unavailable' });
});
for (const input of ['x\n', 'a'.repeat(33), 'a'.repeat(33) + '\n']) {
  test('P invalid JSON or oversized line closes: ' + input.length, async () => {
    const h = harness({}, { maxLineBytes: 32 });
    h.raw(input);
    await flush();
    assert.equal(h.ended, true);
    assert.deepEqual(h.output, []);
  });
}
test('P lookup, snapshot and replay preserve core results and arguments', async () => {
  const calls = [];
  const h = harness({ lookup(key) { calls.push(key); return { found: false }; },
    snapshot(id) { calls.push(id); return { state: {}, seq_high: 4 }; },
    eventsSince(seq) { calls.push(seq); return { events: [], seq_high: 4 }; } });
  h.hello();
  h.send({ type: 'lookup', id: 1, request_key: 'key' });
  h.send({ type: 'snapshot', id: 2, session_id: 'sid' });
  h.send({ type: 'events_since', id: 3, seq: 4 });
  await flush();
  assert.deepEqual(calls, ['key', 'sid', 4]);
  assert.deepEqual(h.output.slice(1).map(row => row.result),
    [{ found: false }, { state: {}, seq_high: 4 }, { events: [], seq_high: 4 }]);
});
test('P shutdown returns not_accepted once and suppresses late accepted', async () => {
  let release;
  const h = harness({ submit() { return new Promise(resolve => { release = resolve; }); } });
  h.hello();
  h.send({ type: 'submit', id: 9, request: { request_key: 'key' } });
  await flush();
  assert.equal(h.protocol.pendingCount, 1);
  h.protocol.drain();
  release({ state: 'done' });
  await flush();
  assert.deepEqual(h.output.slice(1), [{ type: 'not_accepted', id: 9 }]);
  assert.equal(h.ended, true);
});
test('P fragmented UTF-8 frames and pipelined hello preserve complete request boundaries', async () => {
  const calls = [];
  const h = harness({ submit(request) { calls.push(request); return { state: 'done' }; } });
  const frame = Buffer.from(JSON.stringify({ type: 'submit', id: 2, request: { body: '한글', request_key: 'key' } }) + '\n');
  h.hello();
  const split = frame.indexOf(Buffer.from('한')) + 1;
  h.raw(frame.subarray(0, split));
  await flush();
  assert.equal(calls.length, 0);
  h.raw(frame.subarray(split));
  await flush();
  assert.equal(calls[0].body, '한글');
  assert.equal(h.output[1].type, 'accepted');
});
test('P drain boundary rejects newly arrived request without invoking submit', async () => {
  let calls = 0;
  const h = harness({ submit() { calls++; } });
  h.hello();
  await flush();
  h.protocol.beginDrain();
  h.send({ type: 'submit', id: 3, request: { request_key: 'key' } });
  await flush();
  assert.equal(calls, 0);
  assert.deepEqual(h.output[1], { type: 'not_accepted', id: 3 });
  assert.equal(h.ended, true);
});
for (const invalid of ['invalid_request', 'key_expired', 'key_future', 'fingerprint_conflict']) {
  test(`R1-02 real core non-durable ${invalid} returns rejected instead of accepted`, async t => {
    const { fixture } = require('./helpers/session-host-fixture');
    const f = fixture(t);
    let request = { kind: 'start', cwd: '/tmp', request_key: f.key() };
    if (invalid === 'invalid_request') request.request_key = 'invalid';
    if (invalid === 'key_expired') request.request_key = f.key(f.time - 86400001);
    if (invalid === 'key_future') request.request_key = f.key(f.time + 300001);
    if (invalid === 'fingerprint_conflict') {
      f.core.submit(request);
      request = { ...request, cwd: '/different' };
    }
    const h = harness(f.core);
    h.hello();
    h.send({ type: 'submit', id: 1, request });
    await flush();
    assert.deepEqual(h.output[1], { type: 'rejected', id: 1, request_key: request.request_key, code: invalid });
  });
}
test('R1-02 real core durable rejection and idempotent result still return accepted', async t => {
  const { fixture } = require('./helpers/session-host-fixture');
  const f = fixture(t);
  const request = { kind: 'close', session_id: 'missing', request_key: f.key() };
  const h = harness(f.core);
  h.hello();
  for (const id of [1, 2]) h.send({ type: 'submit', id, request });
  await flush();
  assert.equal(h.output[1].type, 'accepted');
  assert.equal(h.output[1].result.state, 'rejected');
  assert.equal(h.output[2].type, 'accepted');
  assert.deepEqual(h.output[1].result, h.output[2].result);
});
test('R1-01 fatal latch rejects every authenticated request without core access or secret leakage', async () => {
  let fatal = false;
  let calls = 0;
  const h = harness({ snapshot() { calls++; return {}; } }, { isFatal: () => fatal });
  h.hello();
  await flush();
  fatal = true;
  for (const type of ['submit', 'lookup', 'snapshot', 'events_since']) h.send({ type, id: type, request: {} });
  await flush();
  assert.equal(calls, 0);
  assert.deepEqual(h.output.slice(1), ['submit', 'lookup', 'snapshot', 'events_since'].map(id =>
    ({ type: 'error', id, code: 'host_fatal' })));
});
test('R1-02 receipt recognizes interrupt aliases and deleted delivery tombstones as durable', t => {
  const { fixture } = require('./helpers/session-host-fixture');
  const f = fixture(t, { noReceipt: true, manual: true });
  f.start();
  const promptRequest = f.req('prompt', { body: 'hello' });
  f.core.submit(promptRequest);
  f.core.submit(f.req('interrupt'));
  const alias = f.req('interrupt');
  assert.equal(f.core.submitWithReceipt(alias).durable, true);
  assert.equal(f.core.submitWithReceipt(alias).durable, true);
  f.core.submit(f.req('close'));
  f.core.submit(f.req('delete'));
  const tombstone = f.core.submitWithReceipt(promptRequest);
  assert.equal(tombstone.durable, true);
  assert.equal(tombstone.result.session_deleted, 1);
});
test('R1-02 unavailable adapter receipt preserves fixed adapter_unavailable result', t => {
  const { fixture } = require('./helpers/session-host-fixture');
  const { unavailableAdapter } = require('../sessionHost/main');
  const f = fixture(t);
  f.adapter.start = unavailableAdapter().start;
  const protocolCore = { ...f.core, submit: f.core.submitUnavailable };
  const receipt = protocolCore.submitWithReceipt({ kind: 'start', cwd: '/tmp', request_key: f.key() });
  assert.equal(receipt.durable, true);
  assert.equal(receipt.result.reason, 'adapter_unavailable');
});

test('C1 list and settings preview preserve protocol authentication and arguments', async () => {
  const calls = [];
  const h = harness({ listSessions() { calls.push('list'); return { sessions: [], seq_high: 0 }; },
    settingsPreview(cwd) { calls.push(cwd); return { ok: true }; } });
  h.hello();
  h.send({ type: 'list', id: 1 });
  h.send({ type: 'settings_preview', id: 2, cwd: '/safe' });
  await flush();
  assert.deepEqual(calls, ['list', '/safe']);
  assert.deepEqual(h.output.slice(1), [
    { type: 'list', id: 1, result: { sessions: [], seq_high: 0 } },
    { type: 'settings_preview', id: 2, result: { ok: true } }
  ]);
});

test('R1 protocol forwards replay byte limit and more flag', async () => {
  let options;
  const h = harness({ eventsSince(seq, value) { options = value; return { events: [{ seq: seq + 1 }], seq_high: 10, more: true }; } });
  h.hello(); h.send({ type: 'events_since', id: 1, seq: 3, max_bytes: 2048 }); await flush();
  assert.deepEqual(options, { maxBytes: 2048 }); assert.equal(h.output[1].result.more, true);
});

test('R2 chunk protocol preserves session ownership arguments and UTF-8 data', async () => {
  const calls = [];
  const result = { found: true, total_bytes: 3, offset: 0, data: '가', done: true };
  const h = harness({ chunk(...args) { calls.push(args); return result; } });
  h.hello(); h.send({ type: 'chunk', id: 1, session_id: 'session', source: 'event', id_or_seq: 7, offset: 0 });
  await flush(); assert.deepEqual(calls, [['session', 'event', 7, 0]]);
  assert.deepEqual(h.output[1], { type: 'chunk', id: 1, result });
});

test('R7 metadata overflow returns a fixed snapshot error without closing the connection', async () => {
  const h = harness({ snapshot() { throw new Error('snapshot_too_large'); },
    listSessions() { return { sessions: [], seq_high: 0 }; } });
  h.hello(); h.send({ type: 'snapshot', id: 1, session_id: 'session' });
  h.send({ type: 'list', id: 2 }); await flush();
  assert.deepEqual(h.output.find(row => row.id === 1), { type: 'error', id: 1, code: 'snapshot_too_large' });
  assert.equal(h.output.find(row => row.id === 2).type, 'list'); assert.equal(h.ended, false);
});

test('P abandon and delayed submit serialize on the same durable key over the protocol', async t => {
  const { fixture } = require('./helpers/session-host-fixture');
  for (const abandonFirst of [true, false]) {
    const f = fixture(t, { manual: true });
    f.start();
    const request = f.req('prompt', { body: 'delayed wire request' });
    const h = harness(f.core);
    h.hello();
    const frames = [{ type: 'abandon', id: 'a', request_key: request.request_key }, { type: 'submit', id: 's', request }];
    if (!abandonFirst) frames.reverse();
    for (const frame of frames) h.send(frame);
    await flush();
    const abandonment = h.output.find(row => row.id === 'a');
    const submission = h.output.find(row => row.id === 's');
    assert.equal(abandonment.result.abandoned, abandonFirst);
    assert.equal(submission.type, 'accepted');
    if (abandonFirst) assert.equal(submission.result.reason, 'request_abandoned');
    else assert.equal(abandonment.result.existing.id, submission.result.id);
    assert.equal(f.adapter.log.received.length, abandonFirst ? 0 : 1);
  }
});
