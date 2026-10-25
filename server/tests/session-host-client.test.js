'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const net = require('node:net');
const fs = require('node:fs/promises');
const { createClient } = require('../sessionHost/launcher');
const flush = () => new Promise(resolve => setImmediate(resolve));
function clientHarness(t, reply, lookupResult = { state: 'completed', outcome: 'completed' }, events = []) {
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
      } else if (message.type === 'events_since') response = { type: 'events_since', id: message.id, result: { events, seq_high: 1 } };
      else {
        const result = reply(message.request, message);
        response = result && { id: message.id, ...result };
      }
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
test('R2-M lookup terminal result immediately removes recheck entry', async t => {
  const h = clientHarness(t, () => ({ type: 'accepted', result: { kind: 'prompt', state: 'written', outcome: null } }));
  await h.client.connect();
  await h.client.submit({ kind: 'prompt', request_key: 'key' });
  await h.client.lookup('key');
  await h.reboot();
  assert.equal((await h.client.reconcile()).size, 0);
  assert.deepEqual(h.lookups, ['key']);
});
for (const source of ['submit', 'lookup', 'reconcile']) {
  test(`R2-M ${source} session_deleted tombstone immediately ends tracking`, async t => {
    const tombstone = { request_key: 'key', state: 'unknown', session_deleted: 1, expires_at: 1900000000000 };
    const h = clientHarness(t, () => ({ type: 'accepted', result: source === 'submit' ? tombstone :
      { kind: 'prompt', state: 'written', outcome: null } }), tombstone);
    await h.client.connect();
    await h.client.submit({ kind: 'prompt', request_key: 'key' });
    if (source === 'lookup') await h.client.lookup('key');
    if (source === 'reconcile') await h.client.reconcile();
    const previousLookups = h.lookups.length;
    await h.reboot();
    assert.equal((await h.client.reconcile()).size, 0);
    assert.equal(h.lookups.length, previousLookups);
  });
}
for (const control of [false, true]) {
  test(`R2-M terminal transition event immediately removes ${control ? 'control' : 'delivery'} tracking`, async t => {
    const kind = control ? 'close' : 'prompt';
    const h = clientHarness(t, () => ({ type: 'accepted', result: {
      id: control ? undefined : 'delivery', kind, state: control ? 'accepted' : 'written', outcome: null
    } }), undefined, [{ type: 'transition', json: {
      table: control ? 'control_requests' : 'deliveries', id: control ? 'key' : 'delivery',
      state: control ? 'done' : 'completed', ...(control ? {} : { outcome: 'completed' })
    } }]);
    await h.client.connect();
    await h.client.submit({ kind, request_key: 'key' });
    await h.client.eventsSince(0);
    await h.reboot();
    assert.equal((await h.client.reconcile()).size, 0);
    assert.deepEqual(h.lookups, []);
  });
}
for (const outcome of ['accepted', 'error', 'timeout', 'disconnect']) {
  test(`R2-M ${outcome} tracking is independent of original request and body`, async t => {
    const h = clientHarness(t, () => outcome === 'accepted' ?
      { type: 'accepted', result: { state: 'written', outcome: null } } : outcome === 'error' ?
        { type: 'error', code: 'storage_unavailable' } : null, { state: 'written', outcome: null });
    await h.client.connect();
    const request = { kind: 'prompt', request_key: 'key', body: { private: 'user-content' } };
    const response = h.client.submit(request);
    const checked = outcome === 'accepted' ? response : assert.rejects(response, /acceptance_unknown/);
    if (outcome === 'disconnect') { h.client.close(); await flush(); }
    await checked;
    for (const field of ['kind', 'request_key', 'body']) {
      Object.defineProperty(request, field, { get() { throw new Error('original request retained'); } });
    }
    await h.reboot();
    assert.equal((await h.client.reconcile()).get('key').state, 'written');
    await h.reboot();
    assert.equal((await h.client.reconcile()).get('key').state, 'written');
  });
}
test('R2-M terminal resubmit response removes an existing unfinished entry', async t => {
  let terminal = false;
  const h = clientHarness(t, () => ({ type: 'accepted', result: {
    kind: 'prompt', state: terminal ? 'completed' : 'written', outcome: terminal ? 'completed' : null
  } }));
  await h.client.connect();
  const request = { kind: 'prompt', request_key: 'key' };
  await h.client.submit(request);
  terminal = true;
  await h.client.submit(request);
  await h.reboot();
  assert.equal((await h.client.reconcile()).size, 0);
  assert.deepEqual(h.lookups, []);
});
test('R2-M partial and unrelated events preserve unfinished state until matching outcome', async t => {
  const events = [{ type: 'transition', json: { table: 'deliveries', id: 'other', outcome: 'completed' } },
    { type: 'transition', json: { table: 'deliveries', id: 'delivery', state: 'completed' } }];
  const h = clientHarness(t, () => ({ type: 'accepted', result: {
    id: 'delivery', kind: 'prompt', state: 'written', outcome: null
  } }), { id: 'delivery', state: 'completed', outcome: null }, events);
  await h.client.connect();
  await h.client.submit({ kind: 'prompt', request_key: 'key' });
  await h.client.eventsSince(0);
  assert.equal((await h.client.reconcile()).size, 1);
  events.splice(0, events.length, { type: 'transition', json: {
    table: 'deliveries', id: 'delivery', outcome: 'completed'
  } });
  await h.client.eventsSince(1);
  await h.reboot();
  assert.equal((await h.client.reconcile()).size, 0);
  assert.deepEqual(h.lookups, ['key']);
});
test('R2-M tombstone remains terminal when session_deleted is zero', async t => {
  const h = clientHarness(t, () => ({ type: 'accepted', result: {
    request_key: 'key', state: 'unknown', session_deleted: 0
  } }));
  await h.client.connect();
  await h.client.submit({ kind: 'prompt', request_key: 'key' });
  await h.reboot();
  assert.equal((await h.client.reconcile()).size, 0);
  assert.deepEqual(h.lookups, []);
});


test('C1 client list and settings preview send matching protocol frames', async t => {
  const frames = [];
  const h = clientHarness(t, (_request, message) => {
    frames.push(message);
    return { type: message.type, result: message.type === 'list' ? { sessions: [], seq_high: 0 } : { ok: true } };
  });
  await h.client.connect();
  assert.deepEqual(await h.client.list(), { sessions: [], seq_high: 0 });
  assert.deepEqual(await h.client.settingsPreview('/safe'), { ok: true });
  assert.deepEqual(frames.map(({ id, ...frame }) => frame), [{ type: 'list' }, { type: 'settings_preview', cwd: '/safe' }]);
});
