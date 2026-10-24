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
