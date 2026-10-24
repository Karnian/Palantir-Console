'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const net = require('node:net');
const fs = require('node:fs/promises');
const { createClient } = require('../sessionHost/launcher');
const flush = () => new Promise(resolve => setImmediate(resolve));
function clientHarness(t, reply, lookupResult = { state: 'completed', outcome: 'completed' }) {
  let bootNumber = 1;
  let boot = 'boot-1';
  let stream;
  const lookups = [];
  t.mock.method(fs, 'readFile', async () => 'secret');
  t.mock.method(net, 'createConnection', () => {
    stream = new Duplex({ read() {}, write(chunk, encoding, done) {
      const message = JSON.parse(chunk.toString());
      let response;
      if (message.type === 'hello') response = { type: 'hello', host_boot_id: boot };
      else if (message.type === 'lookup') {
        lookups.push(message.request_key);
        response = { type: 'lookup', id: message.id, result: typeof lookupResult === 'function' ? lookupResult() : lookupResult };
      } else response = { id: message.id, ...reply(message.request) };
      if (response) queueMicrotask(() => stream.push(JSON.stringify(response) + '\n'));
      done();
    } });
    queueMicrotask(() => stream.emit('connect'));
    return stream;
  });
  const client = createClient({ runtimeDir: '/unused', timeoutMs: 100 });
  t.after(() => client.close());
  return { client, lookups, async reboot() { stream.destroy(); await flush(); boot = `boot-${++bootNumber}`; } };
}
for (const result of [
  { kind: 'prompt', state: 'queued', outcome: null },
  { kind: 'prompt', state: 'sending', outcome: null },
  { kind: 'prompt', state: 'written', outcome: null },
  { kind: 'prompt', state: 'provider_observed', outcome: null },
  { kind: 'prompt', state: 'completed', outcome: null },
  { kind: 'close', state: 'accepted' },
  { kind: 'tool_decision', state: 'written' }
]) {
  test(`R1-03 accepted unfinished ${result.kind}/${result.state} is looked up after boot change`, async t => {
    const h = clientHarness(t, () => ({ type: 'accepted', result }));
    await h.client.connect();
    await h.client.submit({ kind: result.kind, request_key: 'key' });
    await h.reboot();
    const results = await h.client.reconcile();
    assert.equal(h.client.hostBootChanged, true);
    assert.deepEqual(h.lookups, ['key']);
    assert.deepEqual(results.get('key'), { state: 'completed', outcome: 'completed' });
  });
}
for (const code of ['storage_unavailable', 'host_fatal']) {
  test(`R1-04 submit error ${code} remains acceptance_unknown until lookup`, async t => {
    const h = clientHarness(t, () => ({ type: 'error', code }));
    await h.client.connect();
    await assert.rejects(h.client.submit({ kind: 'start', request_key: 'key' }), { message: 'acceptance_unknown', code });
    await h.reboot();
    assert.ok((await h.client.reconcile()).has('key'));
    assert.deepEqual(h.lookups, ['key']);
  });
}
test('R1-04 rejected submit is definitive and never retained for lookup', async t => {
  const h = clientHarness(t, () => ({ type: 'rejected', code: 'key_expired', request_key: 'key' }));
  await h.client.connect();
  await assert.rejects(h.client.submit({ kind: 'start', request_key: 'key' }), { message: 'key_expired', code: 'key_expired' });
  await h.reboot();
  assert.equal((await h.client.reconcile()).size, 0);
  assert.deepEqual(h.lookups, []);
});
test('R1-03 terminal prompt outcome is not retained for lookup', async t => {
  const h = clientHarness(t, () => ({ type: 'accepted', result: { kind: 'prompt', state: 'provider_observed', outcome: 'interrupted' } }));
  await h.client.connect();
  await h.client.submit({ kind: 'prompt', request_key: 'key' });
  await h.reboot();
  assert.equal((await h.client.reconcile()).size, 0);
});
test('R1-03 unfinished lookup remains tracked across another boot, terminal lookup removes it', async t => {
  let terminal = false;
  const h = clientHarness(t,
    () => ({ type: 'accepted', result: { kind: 'prompt', state: 'queued', outcome: null } }),
    () => terminal ? { kind: 'prompt', state: 'completed', outcome: 'completed' } :
      { kind: 'prompt', state: 'written', outcome: null });
  await h.client.connect();
  await h.client.submit({ kind: 'prompt', request_key: 'key' });
  await h.reboot();
  assert.equal((await h.client.reconcile()).get('key').state, 'written');
  terminal = true;
  await h.reboot();
  assert.equal((await h.client.reconcile()).get('key').state, 'completed');
  await h.reboot();
  assert.equal((await h.client.reconcile()).size, 0);
  assert.deepEqual(h.lookups, ['key', 'key']);
});
test('R1-04 submit error is reconciled after reconnect to the same boot', async t => {
  const h = clientHarness(t, () => ({ type: 'error', code: 'storage_unavailable' }));
  await h.client.connect();
  await assert.rejects(h.client.submit({ kind: 'start', request_key: 'key' }), /acceptance_unknown/);
  h.client.close();
  await flush();
  assert.ok((await h.client.reconcile()).has('key'));
  assert.equal(h.client.hostBootChanged, false);
  assert.deepEqual(h.lookups, ['key']);
});
