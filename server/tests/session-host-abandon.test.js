'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');

test('abandon durably rejects a delayed submit with no provider effect, including reboot', t => {
  const f = fixture(t, { manual: true });
  f.start();
  const request = f.req('prompt', { body: 'delayed private prompt' });
  assert.deepEqual(f.core.abandon(request.request_key), { abandoned: true });
  assert.equal(f.core.submit(request).reason, 'request_abandoned');
  assert.equal(f.core.submitWithReceipt(request).durable, true);
  assert.equal(f.adapter.log.received.length, 0);
  f.reboot();
  assert.equal(f.core.submit({ ...request, body: 'different body' }).reason, 'request_abandoned');
  const Database = require('better-sqlite3');
  const db = new Database(f.dbPath);
  t.after(() => db.close());
  const row = db.prepare('SELECT * FROM request_tombstones WHERE request_key=?').get(request.request_key);
  assert.equal(row.state, 'abandoned');
  assert.equal(row.fingerprint, '');
  assert.equal(row.expires_at, f.time + 30 * 86400000);
  assert.equal(JSON.stringify(row).includes('private prompt'), false);
});

test('abandon preserves an accepted row, alias, and tombstone', t => {
  const f = fixture(t, { manual: true });
  f.start();
  const prompt = f.prompt();
  const result = f.core.abandon(prompt.request_key);
  assert.equal(result.abandoned, false);
  assert.equal(result.existing.id, prompt.id);
  const interrupt = f.core.submit(f.req('interrupt'));
  const alias = f.req('interrupt');
  assert.equal(f.core.submit(alias).id, interrupt.id);
  assert.equal(f.core.abandon(alias.request_key).existing.id, interrupt.id);
  const key = f.key();
  assert.equal(f.core.abandon(key).abandoned, true);
  assert.equal(f.core.abandon(key).abandoned, false);
});

test('submit and abandon races linearize to zero or one provider effect', async t => {
  for (const abandonFirst of [true, false]) {
    const f = fixture(t, { manual: true });
    f.start();
    const request = f.req('prompt', { body: 'racing request' });
    const operations = [() => f.core.abandon(request.request_key), () => f.core.submit(request)];
    if (!abandonFirst) operations.reverse();
    const results = await Promise.all(operations.map(operation => Promise.resolve().then(operation)));
    assert.equal(f.adapter.log.received.length, abandonFirst ? 0 : 1);
    assert.equal(results[0].abandoned, abandonFirst ? true : undefined);
    f.core.submit(request);
    assert.equal(f.adapter.log.received.length, abandonFirst ? 0 : 1);
  }
});

test('abandon validates the same key window as submit and leaves no invalid tombstone', t => {
  const f = fixture(t);
  for (const [key, reason] of [['bad', 'invalid_request'], [f.key(f.time - 86400001), 'key_expired'],
    [f.key(f.time + 300001), 'key_future']]) {
    assert.throws(() => f.core.abandon(key), { message: reason });
    assert.equal(f.core.lookup(key).found, false);
  }
});

test('abandon also fences a submit already queued behind another command', t => {
  const f = fixture(t, { manual: true });
  f.start();
  const delayed = f.req('prompt', { body: 'queued delayed request' });
  const send = f.adapter.send.bind(f.adapter);
  let abandoned;
  f.adapter.send = (...args) => {
    f.core.submit(delayed);
    abandoned = f.core.abandon(delayed.request_key);
    send(...args);
  };
  f.prompt('occupies the session queue');
  assert.equal(abandoned.abandoned, true);
  assert.equal(f.core.lookup(delayed.request_key).reason, 'request_abandoned');
  assert.equal(f.adapter.log.received.length, 1);
});

test('launcher abandon traverses the authenticated protocol and fences a delayed submit without sockets', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const net = require('node:net');
  const { Duplex } = require('node:stream');
  const { createProtocol } = require('../sessionHost/protocol');
  const { createClient } = require('../sessionHost/launcher');
  const f = fixture(t, { manual: true });
  f.start();
  let server;
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { server.push(chunk); done(); } });
  server = new Duplex({ read() {}, write(chunk, _encoding, done) { socket.push(chunk); done(); } });
  createProtocol({ stream: server, core: f.core, capability: 'secret', hostBootId: 'abandon-test' });
  t.mock.method(net, 'createConnection', () => {
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  fs.writeFileSync(path.join(f.dir, 'capability'), 'secret');
  const client = createClient({ runtimeDir: f.dir });
  t.after(() => { client.close(); socket.destroy(); server.destroy(); });
  await client.connect();
  const request = f.req('prompt', { body: 'delayed through launcher' });
  assert.deepEqual(await client.abandon(request.request_key), { abandoned: true });
  assert.equal((await client.submit(request)).reason, 'request_abandoned');
  assert.equal((await client.lookup(request.request_key)).reason, 'request_abandoned');
  assert.equal(f.adapter.log.received.length, 0);
});
