'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOwnedSessionService } = require('../services/ownedSessionService');
const { startHost } = require('../sessionHost/hostProcess');
function harness(t, { fail = false, history = true } = {}) {
  const dir = fs.mkdtempSync('/private/tmp/owned-r1-');
  if (history) fs.writeFileSync(path.join(dir, 'host.db'), 'history');
  let now = 0, online = false, launches = 0, held = false, onDisconnect;
  const scheduled = new Map(); let id = 0;
  const client = { async connect() { if (!online) throw Error('offline'); }, hostBootId: 'boot',
    list: async () => ({ sessions: [] }), eventsSince: async () => ({ events: [] }),
    settingsPreview: async () => ({}), close() {} };
  const service = createOwnedSessionService({ runtimeDir: dir, createClient: options => { onDisconnect = options.onDisconnect; return client; },
    clock: () => now, diagnose: () => ({ held }),
    timers: { setTimeout(fn, ms) { scheduled.set(++id, { fn, ms }); return id; }, clearTimeout(id) { scheduled.delete(id); } },
    ensureHost: async () => { launches++; if (fail) throw Error('private failure'); online = true; return { close() {} }; } });
  t.after(async () => { await service.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, service, get launches() { return launches; }, set online(x) { online = x; }, set held(x) { held = x; },
    disconnect() { online = false; onDisconnect(); },
    advance(ms) { now += ms; }, get now() { return now; },
    async tick() { const [id, timer] = scheduled.entries().next().value; scheduled.delete(id); timer.fn();
      for (let n = 0; n < 100; n++) await Promise.resolve(); } };
}
test('R1 ten early crashes share exponential backoff across GET, SSE and changes; stable 30s resets', async t => {
  const h = harness(t); const off = h.service.subscribe(0, () => {});
  assert.equal((await h.service.list()).host, 'running');
  for (let n = 0; n < 10; n++) {
    h.online = false;
    const delay = Math.min(60000, 1000 * 2 ** n);
    const result = await h.service.list();
    assert.equal(result.reason, 'restart_backoff');
    assert.equal(result.diagnostics.code, 'host_restart_backoff');
    assert.equal(result.diagnostics.next_retry_at, h.now + delay);
    for (let j = 0; j < 10; j++) { await h.service.list(); await h.tick(); }
    await assert.rejects(h.service.settingsPreview(process.cwd()), { code: 'host_restart_backoff' });
    assert.equal(h.launches, n + 1);
    h.advance(delay - 1); await h.service.list(); assert.equal(h.launches, n + 1);
    h.advance(1); assert.equal((await h.service.list()).host, 'running');
    assert.equal(h.launches, n + 2);
  }
  h.advance(30000); await h.service.list(); h.online = false;
  assert.equal((await h.service.list()).host, 'running');
  h.online = false;
  assert.equal((await h.service.list()).diagnostics.next_retry_at, h.now + 1000);
  off();
});
test('R1 failed startup is diagnosed, throttled, and one manual reconnect bypasses backoff with single flight', async t => {
  const h = harness(t, { fail: true });
  let result = await h.service.list();
  assert.equal(result.reason, 'recovery_failed'); assert.equal(result.diagnostics.code, 'host_start_failed');
  result = await h.service.list(); assert.equal(result.reason, 'restart_backoff'); assert.equal(h.launches, 1);
  await Promise.all([h.service.reconnect(), h.service.reconnect(), h.service.list()]);
  assert.equal(h.launches, 2);
  h.advance(1999); await h.service.list(); assert.equal(h.launches, 2);
  h.advance(1); await h.service.list(); assert.equal(h.launches, 3);
});
test('R1 DB symlink is not history and host refuses it before lock or recover', async t => {
  const h = harness(t, { history: false });
  const other = fs.mkdtempSync('/private/tmp/owned-other-');
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const target = path.join(other, 'host.db'); fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, path.join(h.dir, 'host.db'));
  const result = await h.service.list(); assert.equal(result.host, 'not_running');
  assert.equal(result.reason, 'recovery_failed'); assert.equal(result.diagnostics.code, 'invalid_host_storage');
  assert.equal(h.launches, 0);
  await assert.rejects(startHost({ runtimeDir: h.dir, adapter: {}, identityProbe: {} }), { code: 'invalid_host_storage' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
  assert.equal(fs.existsSync(path.join(h.dir, 'host.lock')), false);
});
test('R1 never started is distinct and manual reconnect does not create a first host', async t => {
  const h = harness(t, { history: false });
  assert.deepEqual(await h.service.list(), { host: 'not_running', reason: 'never_started' });
  assert.deepEqual(await h.service.reconnect(), { host: 'not_running', reason: 'never_started' });
  assert.equal(h.launches, 0);
});
test('R1 manual reconnect cannot bypass a held lock', async t => {
  const h = harness(t); h.held = true;
  assert.equal((await h.service.reconnect()).host, 'unreachable'); assert.equal(h.launches, 0);
});

test('R1 canonical runtime keeps lock and DB together, rejecting aliases and non-files before recovery', async t => {
  const { inspectHostRuntime } = require('../sessionHost/launcher');
  const dir = fs.mkdtempSync('/private/tmp/owned-r1-path-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, 'real'); fs.mkdirSync(runtime);
  const alias = path.join(dir, 'alias'); fs.symlinkSync(runtime, alias);
  fs.writeFileSync(path.join(runtime, 'host.db'), 'untouched');
  assert.deepEqual(inspectHostRuntime(alias), { runtimeDir: fs.realpathSync(runtime), history: true });
  for (const name of ['host.lock', 'host.db-wal', 'host.db-shm', 'host.db-journal']) {
    const file = path.join(runtime, name);
    fs.symlinkSync(path.join(runtime, 'host.db'), file);
    assert.throws(() => inspectHostRuntime(alias), { code: 'invalid_host_storage' });
    await assert.rejects(startHost({ runtimeDir: alias, adapter: {}, identityProbe: {} }), { code: 'invalid_host_storage' });
    fs.unlinkSync(file);
    assert.equal(fs.readFileSync(path.join(runtime, 'host.db'), 'utf8'), 'untouched');
  }
  fs.unlinkSync(path.join(runtime, 'host.db')); fs.mkdirSync(path.join(runtime, 'host.db'));
  assert.throws(() => inspectHostRuntime(alias), { code: 'invalid_host_storage' });
});

test('R1 SSE-only failed startup obeys the same cooldown and carries recovery diagnostics', async t => {
  const h = harness(t, { fail: true }); const frames = [];
  const off = h.service.subscribe(0, (event, data) => frames.push({ event, data }));
  await h.tick();
  assert.equal(h.launches, 1);
  assert.equal(frames[0].data.reason, 'recovery_failed');
  assert.equal(frames[0].data.diagnostics.next_retry_at, 1000);
  for (let n = 0; n < 10; n++) await h.tick();
  assert.equal(h.launches, 1);
  h.advance(1000); await h.tick(); assert.equal(h.launches, 2);
  off();
});

test('R1 early socket loss stays a failure even when the next GET arrives after 30s', async t => {
  const h = harness(t);
  await h.service.list(); h.advance(1000); h.disconnect();
  h.advance(30000); await h.service.list();
  h.disconnect();
  assert.equal((await h.service.list()).diagnostics.next_retry_at, h.now + 2000);
});

test('R1 real launcher client reports a greeted socket loss at disconnect time', async t => {
  const { Duplex } = require('node:stream');
  const net = require('node:net');
  const promises = require('node:fs/promises');
  const { createClient } = require('../sessionHost/launcher');
  let socket, disconnects = 0;
  t.mock.method(promises, 'readFile', async () => 'capability');
  t.mock.method(net, 'createConnection', () => {
    socket = new Duplex({ read() {}, write(chunk, encoding, done) {
      const message = JSON.parse(chunk.toString());
      if (message.type === 'hello') queueMicrotask(() => socket.push(JSON.stringify({ type: 'hello', host_boot_id: 'one' }) + '\n'));
      done();
    } });
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
  const client = createClient({ runtimeDir: '/unused', onDisconnect: () => { disconnects++; } });
  t.after(() => client.close());
  await client.connect(); assert.equal(disconnects, 0);
  const closed = new Promise(resolve => socket.once('close', resolve)); socket.destroy(); await closed;
  assert.equal(disconnects, 1);
});
