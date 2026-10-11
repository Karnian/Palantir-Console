'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { serviceFixture, tick, until } = require('./helpers/session-hub-service-fixture.cjs');
const { createAssistantStore, sanitize } = require('../services/assistantStore');
const { createSessionHubService } = require('../services/sessionHubService');
const send = (hub, request_id, text) => hub.message({ thread_id: hub.state().thread_id, request_id, text });
const output = (fx, text) => fx.event({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

function transcript(fx, name, content = 'owned') {
  const filename = path.join(fx.service.diagnostics().transcriptDir, `${name}.jsonl`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
  return filename;
}
function ledger(fx, entries) {
  fs.writeFileSync(path.join(fx.root, 'owned-sessions'), entries, { mode: 0o600 });
}

test('R1.1 full raw stream is re-redacted; unfinished secrets never reach DB, SSE or search', async t => {
  const fx = serviceFixture(t);
  const published = [];
  fx.service.subscribe(value => published.push(JSON.stringify(value)));
  await fx.service.start(); fx.init('secret-stream');
  await send(fx.service, 'secret', 'stream safely');
  output(fx, 'public line\npassword=ab');
  assert.equal(JSON.stringify(fx.service.state()).includes('password=ab'), false);
  output(fx, 'cdefgh');
  output(fx, '\n');
  fx.event({ type: 'result' });
  const content = fx.store.messages(fx.store.active()).find(row => row.role === 'assistant').content;
  assert.equal(content, sanitize('public line\npassword=abcdefgh\n'));
  assert.equal(published.some(value => value.includes('password=ab') || value.includes('efgh')), false);
  assert.equal(fx.service.searchHistory({ q: 'efgh' }).results.length, 0);
});

test('R1.2 deleting an unrelated thread preserves regular legacy transcript and ledger', async t => {
  const fx = serviceFixture(t);
  await fx.service.start();
  const old = fx.store.active();
  await fx.service.newThread();
  const legacy = transcript(fx, 'legacy');
  ledger(fx, 'legacy\n');
  const result = await fx.service.deleteThread(old);
  assert.equal(result.result, 'complete');
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.readFileSync(path.join(fx.root, 'owned-sessions'), 'utf8'), 'legacy\n');
  await fx.service.start(); await fx.service.stop();
  assert.equal(fs.existsSync(legacy), false);
});

for (const retry of ['stop', 'rotation', 'boot']) {
  test(`R1.3 incomplete deletion survives as hidden tombstone and retries on ${retry}`, async t => {
    let denied = true;
    const fx = serviceFixture(t, { fs: { ...fsp, async unlink(filename) {
      if (denied && filename.endsWith('/pending.jsonl')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fsp.unlink(filename);
    } } });
    await fx.service.start();
    const old = fx.store.active();
    await fx.service.newThread();
    const filename = transcript(fx, 'pending');
    ledger(fx, `pending\t${old}\n`);
    assert.equal((await fx.service.deleteThread(old)).result, 'incomplete');
    assert.equal(fx.db.prepare('SELECT deleting FROM assistant_threads WHERE id = ?').get(old).deleting, 1);
    assert.equal(fx.service.listThreads().some(row => row.id === old), false);
    assert.throws(() => fx.service.messages(old), { code: 'not_found' });
    denied = false;
    if (retry === 'boot') {
      const next = createSessionHubService(fx.options);
      t.after(() => next.shutdown());
      await until(() => !fs.existsSync(filename));
    } else {
      await fx.service.start();
      if (retry === 'rotation') {
        fx.service.invalidateContext(); await send(fx.service, 'rotate', 'new context');
        fx.event({ type: 'result' });
      } else await fx.service.stop();
    }
    assert.equal(fs.existsSync(filename), false);
    assert.equal(fx.db.prepare('SELECT id FROM assistant_threads WHERE id = ?').get(old), undefined);
  });
}

test('R1.4 cleanup read-modify-write serializes against init ledger additions', async t => {
  let release;
  let entered;
  let hold = false;
  const held = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { entered = resolve; });
  const fx = serviceFixture(t, { fs: { ...fsp, async lstat(filename) {
    if (hold && filename === fx.service.diagnostics().transcriptDir) { hold = false; entered(); await held; }
    return fsp.lstat(filename);
  } } });
  t.after(() => release());
  await fx.service.start();
  const old = fx.store.active();
  await fx.service.newThread(); await fx.service.start();
  transcript(fx, 'old');
  const activeFile = transcript(fx, 'new');
  ledger(fx, `old\t${old}\n`);
  hold = true;
  const deleting = fx.service.deleteThread(old);
  await arrived;
  fx.init('new'); await tick(); await tick();
  release(); await deleting;
  await until(() => fs.readFileSync(path.join(fx.root, 'owned-sessions'), 'utf8').includes('new\t'));
  await fx.service.stop();
  assert.equal(fs.existsSync(activeFile), false);
  assert.equal(fx.service.state().transcripts_remaining, 0);
});

test('R1.5 receipts survive pruning and restart, preserving replay and conflict', async t => {
  const fx = serviceFixture(t);
  await fx.service.start(); fx.init('receipts');
  const first = await send(fx.service, 'retained', 'password=abcd retained');
  fx.event({ type: 'result' });
  const smallStore = createAssistantStore(fx.db, { maxMessages: 4 });
  for (let i = 0; i < 10; i++) smallStore.append(fx.store.active(), 'system_note', `retention ${i}`);
  assert.equal(fx.store.messages(fx.store.active()).some(row => row.id === first.user.id), false);
  let writes = 0;
  t.mock.method(fx.children[0].stdin, 'write', () => { writes++; return true; });
  const replay = await send(fx.service, 'retained', 'password=changed retained');
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.turn_id, first.user.turn_id);
  assert.equal(replay.receipt.status, 'complete');
  assert.equal(writes, 0);
  await assert.rejects(send(fx.service, 'retained', 'different'), { code: 'request_conflict', status: 409 });
  await fx.service.stop();
  const restarted = createSessionHubService(fx.options);
  t.after(() => restarted.shutdown());
  assert.equal((await send(restarted, 'retained', 'password=next retained')).replayed, true);
  await restarted.newThread();
  await restarted.deleteThread(first.user.thread_id);
  assert.equal(fx.db.prepare('SELECT count(*) AS n FROM assistant_requests').get().n, 0);
});

for (const action of ['stop', 'shutdown', 'result', 'partial']) {
  test(`R1.6 ${action} DB failure still clears timers, reaps and disposes transport`, async t => {
    const intervals = [];
    const realInterval = global.setInterval;
    t.mock.method(global, 'setInterval', (fn, ms) => {
      intervals.push(fn); return realInterval(fn, ms);
    });
    const fx = serviceFixture(t);
    await fx.service.start(); fx.init('write-failure');
    await send(fx.service, 'failure', 'pending');
    const update = fx.store.update;
    fx.store.update = () => { throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); };
    try {
      if (action === 'partial') assert.doesNotThrow(() => intervals[0]());
      else if (action === 'result') fx.event({ type: 'result' });
      if (action === 'partial' || action === 'result') await tick();
      await assert.rejects(Promise.resolve().then(() => fx.service[action === 'shutdown' ? 'shutdown' : 'stop']()),
        { code: 'assistant_storage_failed' });
      assert.equal(fx.service.current(), null);
      assert.equal(fx.service.diagnostics().pgid, null);
      assert.equal(fx.service.state().turnInProgress, false);
      assert.equal(fx.signals.filter(([, signal]) => signal === 'SIGTERM').length, 1);
      assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
      assert.equal(fs.readdirSync(fx.temp).some(name => name.startsWith('hub-mcp-')), false);
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally { fx.store.update = update; }
  });
}

test('R1.7 manual smoke uses persistent request contract and validates transcripts before stop', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/session-hub-smoke.mjs'), 'utf8');
  assert.match(source, /createAssistantStore/);
  assert.match(source, /request_id/);
  assert.match(source, /row\.content/);
  assert.doesNotMatch(source, /service\.clear\(/);
  assert.ok(source.indexOf('const transcripts =') < source.indexOf('await service.stop();'));
});

test('R1.7 smoke executes with fixture spawn, temporary DB and untouched user instructions', async t => {
  const { EventEmitter } = require('node:events');
  const { pathToFileURL } = require('node:url');
  const { TOOL_NAMES } = require('../services/sessionHubService');
  const smokeUrl = pathToFileURL(path.join(__dirname, '../../scripts/session-hub-smoke.mjs'));
  const { runSessionHubSmoke } = await import(smokeUrl);
  const fx = serviceFixture(t);
  const instructions = path.join(fx.home, '.claude/CLAUDE.md');
  const sentinel = 'existing-user-instructions-that-must-never-be-written-by-smoke';
  fs.mkdirSync(path.dirname(instructions), { recursive: true }); fs.writeFileSync(instructions, sentinel);
  let handler;
  let hub;
  let requests = 0;
  const result = await runSessionHubSmoke({
    env: { HOME: fx.home, PALANTIR_ALLOW_REAL_SPAWN: '1' },
    resolveBinary: fx.options.resolveBinary,
    exec: async () => ({ stdout: '--include-hook-events' }),
    createServer(callback) {
      handler = callback;
      const server = new EventEmitter();
      server.listen = (port, host, done) => done();
      server.address = () => ({ port: 9999 });
      server.close = done => done();
      return server;
    },
    createService(options) {
      assert.ok(options.store);
      hub = createSessionHubService({ ...fx.options, ...options });
      const emit = value => fx.children.at(-1).stdout.write(`${JSON.stringify(value)}\n`);
      const start = hub.start;
      hub.start = async () => {
        const value = await start();
        emit({ type: 'system', subtype: 'init', session_id: 'smoke-session',
          tools: TOOL_NAMES.map(name => `mcp__session_hub__${name}`),
          mcp_servers: [{ name: 'session_hub', status: 'connected' }], slash_commands: [], skills: [],
          memory_paths: { auto: `${hub.diagnostics().transcriptDir}/memory/` },
        });
        options.onMcpProcess({ pid: 8001, pgid: hub.diagnostics().pgid, kind: 'mcp' });
        return value;
      };
      const message = hub.message;
      hub.message = async payload => {
        requests++;
        assert.equal(typeof payload.request_id, 'string');
        assert.equal(payload.thread_id, hub.state().thread_id);
        const value = await message(payload);
        const { transcriptDir, cwd } = hub.diagnostics();
        fs.mkdirSync(transcriptDir, { recursive: true });
        fs.writeFileSync(path.join(transcriptDir, 'smoke-session.jsonl'), `${JSON.stringify({ cwd })}\n`);
        await handler({ method: 'GET', url: '/api/session-hub/sessions?limit=1',
          headers: { authorization: `Bearer ${hub.current()}` } }, {
          setHeader() {}, writeHead(status) { assert.equal(status, 200); },
          end(body) { assert.ok(JSON.parse(body).sessions); },
        });
        emit({ type: 'assistant', message: { content: [{ type: 'text', text: '센티넬 없음' }] } });
        emit({ type: 'result' });
        return value;
      };
      return hub;
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests, 1);
  assert.equal(result.checks.onlyExpectedMcpTools, true);
  assert.equal(result.checks.historySurvivesStop, true);
  assert.equal(result.checks.stopDeletedTranscripts, true);
  assert.equal(result.checks.deleteComplete, true);
  assert.equal(fs.readFileSync(instructions, 'utf8'), sentinel);
  assert.equal(fx.calls.length, 1);
});

for (const secret of ['password="first line\nsecond line', '-----BEGIN PRIVATE KEY-----\nsecret body\n']) {
  test('R1.1 incomplete multiline secret is withheld even if the process stops mid-value', async t => {
    const fx = serviceFixture(t);
    await fx.service.start(); await send(fx.service, 'unfinished', 'stream safely');
    output(fx, secret);
    assert.equal(JSON.stringify(fx.service.state()).includes('first line'), false);
    assert.equal(JSON.stringify(fx.service.state()).includes('secret body'), false);
    await fx.service.stop();
    const row = fx.store.messages(fx.store.active()).find(message => message.role === 'assistant');
    assert.equal(row.status, 'error');
    assert.equal(row.content, '[REDACTED]');
  });
}

test('R1.6 application shutdown awaits failed persistence cleanup before rejecting and closing DB', async t => {
  const { fixture } = require('./helpers/session-hub-fixture.cjs');
  const fx = fixture(t);
  const child = serviceFixture(t);
  const app = fx.app({ sessionHubServiceOptions: child.options, masterMemoryXprojectScanEnabled: false });
  const hub = app.sessionHubService;
  const shutdown = app.shutdown;
  // The fixture's teardown can await the already-verified rejection without failing its own cleanup hook.
  app.shutdown = () => shutdown().catch(() => {});
  await hub.start(); await send(hub, 'app-error', 'pending');
  const update = child.store.update;
  child.store.update = () => { throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' }); };
  try {
    let closing;
    assert.doesNotThrow(() => { closing = shutdown(); });
    await assert.rejects(closing, { code: 'assistant_storage_failed' });
    assert.equal(hub.current(), null);
    assert.equal(hub.diagnostics().pgid, null);
    assert.equal(hub.diagnostics().storageErrorCode, 'SQLITE_FULL');
    assert.equal(hub.state().turnInProgress, false);
    assert.equal(fs.existsSync(path.join(child.root, 'mcp.json')), false);
  } finally { child.store.update = update; }
});

test('R1.3 unsuccessful stop retry reports incomplete and retains the deletion for a later retry', async t => {
  let denied = true;
  const fx = serviceFixture(t, { fs: { ...fsp, async unlink(filename) {
    if (denied && filename.endsWith('/pending-stop.jsonl')) {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return fsp.unlink(filename);
  } } });
  await fx.service.start();
  const old = fx.store.active();
  await fx.service.newThread();
  const filename = transcript(fx, 'pending-stop');
  ledger(fx, `pending-stop\t${old}\n`);
  await fx.service.deleteThread(old);
  await fx.service.start();
  const failed = await fx.service.stop();
  assert.equal(failed.result, 'incomplete');
  assert.equal(failed.remaining, 1);
  assert.equal(fx.store.deletingThreads().length, 1);
  denied = false;
  assert.equal((await fx.service.stop()).result, 'complete');
  assert.equal(fs.existsSync(filename), false);
  assert.equal(fx.store.deletingThreads().length, 0);
});
