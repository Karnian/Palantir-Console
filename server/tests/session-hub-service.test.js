'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const { serviceFixture, tick, until } = require('./helpers/session-hub-service-fixture.cjs');
const { SESSION_HUB_PROMPT } = require('../services/sessionHubPrompt');

let requestNumber = 0;
const send = (hub, text) => hub.message({ thread_id: hub.state().thread_id,
  request_id: `test-${++requestNumber}`, text });

const code = expected => err => err.code === expected;

test('state epoch identifies the service lifetime and survives start, stop and clear', async t => {
  const fx = serviceFixture(t), next = serviceFixture(t), snapshots = [];
  const initial = fx.service.state();
  assert.equal(typeof initial.epoch, 'string');
  assert.match(initial.epoch, /^[0-9a-f]{32}$/);
  assert.notEqual(initial.epoch, next.service.state().epoch);
  assert.equal(next.service.state().version, 0);
  fx.service.subscribe(value => snapshots.push(value));
  snapshots.push(await fx.service.start());
  fx.init();
  snapshots.push(await send(fx.service, '수명 확인'));
  snapshots.push(await fx.service.stop());
  snapshots.push(await fx.service.stop());
  snapshots.push(fx.service.state());
  for (const snapshot of snapshots) assert.equal(snapshot.epoch, initial.epoch);
});

test('state version increases across start, messages, stop and clear; replies match published snapshots', async t => {
  const fx = serviceFixture(t), versions = [];
  assert.equal(fx.service.state().version, 0);
  fx.service.subscribe(value => versions.push(value.version));
  const started = await fx.service.start();
  assert.equal(started.version, fx.service.state().version);
  assert.ok(started.version > 0);
  fx.init();
  const message = await send(fx.service, '버전 확인');
  assert.ok(message.version > started.version);
  assert.equal(message.user.content, '버전 확인');
  const stopped = await fx.service.stop();
  assert.ok(stopped.version > message.version);
  assert.equal(stopped.version, fx.service.state().version);
  const cleared = await fx.service.stop();
  assert.ok(cleared.version > stopped.version);
  assert.equal(cleared.version, fx.service.state().version);
  assert.ok(cleared.messages.some(row => row.content === '버전 확인'));
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
});

test('fixed argv, guard immediately before spawn, minimal Claude env and disk-free hub token', async t => {
  const order = [];
  const fx = serviceFixture(t, { assertSpawnAllowed: value => order.push(value) });
  const spawn = fx.options.spawn;
  // Install the order spy through a separate service's injectable spawn.
  const { createSessionHubService } = require('../services/sessionHubService');
  const hub = createSessionHubService({ ...fx.options, spawn: (...args) => {
    order.push('spawn'); return spawn(...args);
  } });
  t.after(() => hub.shutdown());
  await hub.start();
  const call = fx.calls[0];
  assert.deepEqual(call.argv, ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-hook-events', '--tools', '', '--setting-sources', '', '--settings',
    '{"disableAllHooks":true}', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config',
    path.join(fx.root, 'mcp.json'), '--allowedTools',
    ['mcp__session_hub__list_sessions', 'mcp__session_hub__search_instructions',
      'mcp__session_hub__get_session', 'mcp__session_hub__search_assistant_history',
      'mcp__session_hub__propose_memory', 'mcp__session_hub__propose_forget'].join(','),
    '--permission-mode', 'default',
    '--append-system-prompt', SESSION_HUB_PROMPT]);
  assert.deepEqual(order, [{ command: call.command, source: 'session-hub' }, 'spawn']);
  assert.equal(call.options.detached, true);
  assert.deepEqual(Object.keys(call.options.env).sort(),
    ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'USER']);
  const token = hub.current();
  assert.match(token, /^[0-9a-f]{64}$/);
  for (const name of fs.readdirSync(fx.root)) {
    const filename = path.join(fx.root, name);
    if (fs.lstatSync(filename).isFile()) assert.equal(fs.readFileSync(filename, 'utf8').includes(token), false);
  }
  const config = JSON.parse(fs.readFileSync(path.join(fx.root, 'mcp.json')));
  assert.deepEqual(Object.keys(config.mcpServers), ['session_hub']);
  assert.deepEqual(config.mcpServers.session_hub.env, {});
  assert.match(config.mcpServers.session_hub.args[0], /session-hub-mcp-bootstrap\.cjs$/);
  const closing = hub.stop();
  assert.equal(hub.current(), null);
  await closing;
  assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
});

test('real spawn guard rejects a non-fixture executable with zero spawn calls', async t => {
  const fx = serviceFixture(t, { resolveBinary: () => ({ path: '/bin/sh', executable: true }) });
  await assert.rejects(fx.service.start(), code('PALANTIR_SPAWN_BLOCKED'));
  assert.equal(fx.calls.length, 0);
  assert.equal(fx.service.current(), null);
});

for (const kind of ['symlink', 'permissions', 'owner', 'ancestor']) {
  test(`unsafe namespace ${kind} refuses spawn`, async t => {
    const fx = serviceFixture(t, kind === 'owner' ? { uid: process.getuid() + 1 } : {});
    if (kind === 'symlink') {
      fs.mkdirSync(path.dirname(fx.root), { recursive: true });
      fs.symlinkSync(fx.temp, fx.root);
    } else if (kind === 'permissions') fs.mkdirSync(fx.root, { recursive: true, mode: 0o755 });
    else if (kind === 'ancestor') fs.writeFileSync(path.join(fx.home, 'CLAUDE.md'), 'unsafe');
    await assert.rejects(fx.service.start());
    assert.equal(fx.calls.length, 0);
  });
}

test('managed settings including user MDM refuse start without preparation or spawn', async t => {
  const fx = serviceFixture(t, { managedPaths: ['/Library/Managed Preferences/fixture/com.anthropic.claudecode.plist'],
    managedFs: { lstatSync: () => ({ isDirectory: () => false }) } });
  await assert.rejects(fx.service.start(), code('session_hub_managed_settings'));
  assert.equal(fx.calls.length, 0);
  assert.equal(fs.existsSync(fx.root), false);
});

test('unexpected init memory path revokes token, reaps group and records owned session first', async t => {
  const fx = serviceFixture(t);
  await fx.service.start();
  fx.event({ type: 'system', subtype: 'init', session_id: 'bad-path', memory_paths: { auto: '/elsewhere/memory/' } });
  assert.equal(fx.service.current(), null);
  await fx.service.close();
  assert.equal(fx.service.state().error, 'session_hub_unexpected_paths');
  assert.equal(fs.readFileSync(path.join(fx.root, 'owned-sessions'), 'utf8'), '');
  assert.equal(fx.signals[0][1], 'SIGTERM');
});

for (const mode of ['--fixture-no-memory-paths', '--fixture-no-transcript']) {
  test(`real fake CLI ${mode}: validates transcript after first result`, async t => {
    const events = [];
    const fx = serviceFixture(t, { onProtocolEvent: event => events.push(event), reapMs: 1500,
      spawn: (command, argv, opts) => childProcess.spawn(command, [...argv, mode], opts),
      kill: (...args) => process.kill(...args),
    });
    await fx.service.start();
    await until(() => events.some(event => event.subtype === 'init'));
    assert.equal(fx.service.state().error, null);
    assert.equal(fx.service.diagnostics().initSeen, true);
    await send(fx.service, 'first turn');
    await until(() => events.some(event => event.type === 'result'));
    await until(() => !fx.service.state().turnInProgress);
    if (mode === '--fixture-no-transcript') {
      await fx.service.close();
      assert.equal(fx.service.state().error, 'session_hub_unexpected_paths');
      assert.equal(fx.service.current(), null);
      assert.equal(fx.service.state().state, 'idle');
    } else {
      assert.equal(fx.service.state().state, 'running');
      assert.equal(fx.service.state().error, null);
      const filename = path.join(fx.service.diagnostics().transcriptDir, 'fixture-session.jsonl');
      assert.equal(fs.lstatSync(filename).isFile(), true);
      assert.equal(fx.service.diagnostics().transcriptVerified, true);
      await send(fx.service, 'second turn');
      await until(() => events.filter(event => event.type === 'result').length === 2);
      await fx.service.stop();
    }
    assert.equal(fs.readFileSync(path.join(fx.root, 'owned-sessions'), 'utf8'), '');
  });
}

test('missing memory_paths holds the turn during transcript lstat and accepts next turn only after verification',
  async t => {
    let release;
    let entered;
    const held = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { entered = resolve; });
    let probes = 0;
    t.after(() => release());
    const fx = serviceFixture(t, { fs: { ...fsp, async lstat(filename) {
      if (filename.endsWith('/owned.jsonl')) { probes++; entered(); await held; }
      return fsp.lstat(filename);
    } } });
    await fx.service.start();
    fx.event({ type: 'system', subtype: 'init', session_id: 'owned' });
    assert.equal(fx.service.diagnostics().initSeen, true);
    const { transcriptDir } = fx.service.diagnostics();
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, 'owned.jsonl'), '{}\n');
    await send(fx.service, 'first'); fx.event({ type: 'result' });
    await arrived;
    assert.equal(fx.service.state().turnInProgress, true);
    await assert.rejects(() => send(fx.service, 'too early'), code('turn_in_progress'));
    release(); await until(() => !fx.service.state().turnInProgress);
    await send(fx.service, 'next'); fx.event({ type: 'result' });
    assert.equal(fx.service.state().turnInProgress, false);
    assert.equal(probes, 1);
  });

for (const kind of ['missing', 'directory', 'symlink', 'io-error']) {
  test(`missing memory_paths rejects ${kind} transcript after result and revokes token`, async t => {
    const fx = serviceFixture(t, kind === 'io-error' ? { fs: { ...fsp, async lstat(filename) {
      if (filename.endsWith('/owned.jsonl')) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return fsp.lstat(filename);
    } } } : {});
    await fx.service.start();
    fx.event({ type: 'system', subtype: 'init', session_id: 'owned' });
    assert.equal(fx.service.diagnostics().initSeen, true);
    const { transcriptDir } = fx.service.diagnostics();
    fs.mkdirSync(transcriptDir, { recursive: true });
    const filename = path.join(transcriptDir, 'owned.jsonl');
    if (kind === 'directory') fs.mkdirSync(filename);
    if (kind === 'symlink') {
      const target = path.join(fx.temp, 'other-session'); fs.writeFileSync(target, 'keep');
      fs.symlinkSync(target, filename);
    }
    await send(fx.service, 'first'); fx.event({ type: 'result' });
    await until(() => fx.service.state().error === 'session_hub_unexpected_paths');
    await fx.service.close();
    assert.equal(fx.service.current(), null);
    assert.equal(fx.service.state().state, 'idle');
    await assert.rejects(() => send(fx.service, 'next'), code('session_hub_not_running'));
  });
}

test('close waits for delayed transcript verification and its completion cannot change the next generation',
  async t => {
    let release;
    let entered;
    const held = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { entered = resolve; });
    t.after(() => release());
    const fx = serviceFixture(t, { fs: { ...fsp, async lstat(filename) {
      if (filename.endsWith('/owned.jsonl')) { entered(); await held; }
      return fsp.lstat(filename);
    } } });
    await fx.service.start();
    fx.event({ type: 'system', subtype: 'init', session_id: 'owned' });
    await send(fx.service, 'first'); fx.event({ type: 'result' });
    await arrived;
    let closed = false;
    const closing = fx.service.stop();
    closing.then(() => { closed = true; });
    await tick();
    assert.equal(closed, false);
    assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), true);
    await assert.rejects(fx.service.start(), code('session_hub_busy'));
    release(); await closing;
    assert.equal(fx.service.state().error, null);
    await fx.service.start(); fx.init('next');
    await send(fx.service, 'new turn');
    await tick();
    assert.equal(fx.service.state().turnInProgress, true);
    assert.equal(fx.service.state().error, null);
    fx.event({ type: 'result' });
  });

for (const memory_paths of [null, {}, { auto: '/other/memory/' }]) {
  test(`present invalid memory_paths ${JSON.stringify(memory_paths)} is rejected without fallback`, async t => {
    const fx = serviceFixture(t);
    await fx.service.start();
    fx.event({ type: 'system', subtype: 'init', session_id: 'owned', memory_paths });
    await fx.service.close();
    assert.equal(fx.service.state().error, 'session_hub_unexpected_paths');
    assert.equal(fx.service.current(), null);
  });
}

test('hook subtype disables every later start in this boot and ignores late output', async t => {
  const fx = serviceFixture(t);
  await fx.service.start(); fx.init();
  fx.event({ type: 'system', subtype: 'future_HOOK_finished' });
  const before = fx.service.state().messages;
  fx.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'late' }] } });
  await fx.service.close();
  assert.deepEqual(fx.service.state().messages, before);
  await assert.rejects(fx.service.start(), code('session_hub_hooks_detected'));
});

test('single turn, timeout, text/tool/error messages and both conversation caps', async t => {
  const fx = serviceFixture(t, { turnTimeoutMs: 25 });
  await fx.service.start(); fx.init();
  await send(fx.service, 'first');
  await assert.rejects(() => send(fx.service, 'second'), code('turn_in_progress'));
  fx.event({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'list_sessions', input: { limit: 1 } },
    { type: 'text', text: 'answer' }] } });
  fx.event({ type: 'result' });
  assert.deepEqual(fx.service.state().messages.map(row => row.role), ['user', 'assistant', 'tool_note']);
  for (let i = 0; i < 210; i++) {
    await send(fx.service, `message ${i}`); fx.event({ type: 'result' });
  }
  assert.equal(fx.service.state().messages.length, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(fx.service.state().messages)) <= 256 * 1024);
  await send(fx.service, 'timeout');
  await until(() => fx.service.state().state === 'idle');
  assert.equal(fx.service.state().error, 'session_hub_turn_timeout');
});

test('close same Promise, token revoked synchronously, shutdown permanent and stale generation harmless', async t => {
  const fx = serviceFixture(t, { turnTimeoutMs: 30 });
  await fx.service.start(); await send(fx.service, 'old');
  const old = fx.children[0];
  const first = fx.service.close();
  assert.equal(first, fx.service.close()); assert.equal(fx.service.current(), null);
  await first;
  await fx.service.start();
  const current = fx.service.current();
  old.emit('exit', 1);
  old.stdout.write('{"type":"system","subtype":"hook_started"}\n');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fx.service.current(), current); assert.equal(fx.service.state().state, 'running');
  const shutdown = fx.service.shutdown();
  assert.equal(fx.service.state().state, 'closed');
  await assert.rejects(fx.service.start(), code('session_hub_closed'));
  await assert.rejects(() => send(fx.service, 'no'), code('session_hub_closed'));
  await shutdown;
  assert.equal(fx.service.state().state, 'closed');
});

for (const delayAt of ['id', 'realpath', 'mcp.json']) {
  test(`delayed preparation ${delayAt}: clear waits, blocks next generation, never resurrects config`, async t => {
    let release;
    let entered;
    const held = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { entered = resolve; });
    let delayed = false;
    const wait = async () => { if (!delayed) { delayed = true; entered(); await held; } };
    const io = { ...fsp,
      async realpath(filename) {
        if (delayAt === 'realpath') await wait();
        return fsp.realpath(filename);
      },
      async open(filename, ...args) {
        const handle = await fsp.open(filename, ...args);
        return { stat: () => handle.stat(), close: () => handle.close(), truncate: n => handle.truncate(n),
          readFile: encoding => handle.readFile(encoding), read: (...values) => handle.read(...values),
          async writeFile(data) {
            if (path.basename(filename) === delayAt) await wait();
            return handle.writeFile(data);
          } };
      },
    };
    const fx = serviceFixture(t, { fs: io });
    const starting = fx.service.start();
    await arrived;
    const clearing = fx.service.stop();
    assert.equal(fx.service.close(), clearing);
    await assert.rejects(fx.service.start(), code('session_hub_busy'));
    let cleared = false;
    clearing.then(() => { cleared = true; });
    await tick(); assert.equal(cleared, false);
    release(); await starting; await clearing;
    assert.equal(fx.calls.length, 0);
    assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
    await fx.service.start();
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.service.state().generation, 2);
  });
}

test('reap escalates after parent exit, then verifies ESRCH before deletion', async t => {
  let alive = true;
  const signals = [];
  const fx = serviceFixture(t, { kill(pid, signal) {
    signals.push(signal);
    if (signal === 'SIGKILL') alive = false;
    if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  } });
  await fx.service.start();
  const closing = fx.service.stop();
  fx.children[0].emit('exit', 0);
  assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), true);
  await closing;
  assert.ok(signals.includes('SIGKILL'));
  assert.equal(signals.at(-1), 0);
  assert.equal(fx.service.diagnostics().pgid, null);
  assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
});

test('reap failure preserves PGID/config/messages and refuses idle/start', async t => {
  const fx = serviceFixture(t, { kill() {}, termMs: 2, reapMs: 10 });
  await fx.service.start(); await send(fx.service, 'preserve');
  await assert.rejects(fx.service.stop(), code('reap_failed'));
  assert.equal(fx.service.state().state, 'error:reap_failed');
  assert.equal(fx.service.state().messages[0].content, 'preserve');
  assert.ok(fx.service.diagnostics().pgid);
  assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), true);
  await assert.rejects(fx.service.start(), code('session_hub_busy'));
});

test('zombie-only EPERM keeps files until event-loop reaping and an ESRCH group probe', async t => {
  let reaped = false;
  let probes = 0;
  const fx = serviceFixture(t, { kill(pid, signal) {
    if (signal === 'SIGTERM') {
      setImmediate(() => { reaped = true; fx.children[0].emit('exit', 0); });
      throw Object.assign(new Error('zombie'), { code: 'EPERM' });
    }
    if (signal === 0) {
      probes++;
      assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), true);
      throw Object.assign(new Error(reaped ? 'gone' : 'zombie'), { code: reaped ? 'ESRCH' : 'EPERM' });
    }
  } });
  await fx.service.start();
  await fx.service.stop();
  assert.ok(probes >= 2);
  assert.equal(fx.service.diagnostics().pgid, null);
  assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
});

test('persistent EPERM still escalates and fails without deleting files or declaring idle', async t => {
  const signals = [];
  const fx = serviceFixture(t, { termMs: 2, reapMs: 15, kill(pid, signal) {
    signals.push(signal);
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
  } });
  await fx.service.start(); await send(fx.service, 'preserve');
  await assert.rejects(fx.service.stop(), code('reap_failed'));
  assert.ok(signals.includes('SIGTERM')); assert.ok(signals.includes('SIGKILL'));
  assert.equal(fx.service.state().state, 'error:reap_failed');
  assert.equal(fx.service.state().messages[0].content, 'preserve');
  assert.ok(fx.service.diagnostics().pgid);
  assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), true);
  await assert.rejects(fx.service.start(), code('session_hub_busy'));
});

test('spawn error and natural exit use the single cleanup Promise', async t => {
  for (const event of ['error', 'exit']) {
    const fx = serviceFixture(t);
    await fx.service.start();
    fx.children[0].emit(event, event === 'error' ? new Error('spawn') : 0);
    assert.equal(fx.service.current(), null);
    const closing = fx.service.close();
    assert.equal(fx.service.close(), closing);
    await closing;
    assert.equal(fx.signals.filter(([, signal]) => signal === 'SIGTERM').length, 1);
  }
});

test('real fixture group with SIGTERM-ignoring descendant is reaped after parent exits', async t => {
  const signals = [];
  const fx = serviceFixture(t, { termMs: 60, reapMs: 3000, pollMs: 10,
    spawn: (command, argv, opts) => childProcess.spawn(command, [...argv, '--fixture-stubborn-child'], opts),
    kill: (...args) => { signals.push(args[1]); return process.kill(...args); },
  });
  await fx.service.start();
  const childFile = path.join(fx.service.diagnostics().cwd, 'child-pid');
  await until(() => fs.existsSync(childFile));
  const descendant = Number(fs.readFileSync(childFile));
  await new Promise(resolve => setTimeout(resolve, 100));
  await fx.service.stop();
  assert.ok(signals.includes('SIGKILL'));
  // A killed orphan can remain a zombie briefly while the OS reparents/reaps it.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(descendant, 0); }
    catch (err) {
      if (err.code === 'ESRCH') break;
      throw err;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.throws(() => process.kill(descendant, 0), err => err.code === 'ESRCH');
});

function credentialFixture(t, execFile, overrides = {}) {
  const { fakeNet } = require('./helpers/session-hub-service-fixture.cjs');
  const { EventEmitter } = require('node:events');
  let server;
  const net = fakeNet();
  const create = net.createServer;
  net.createServer = handler => { server = create(handler); return server; };
  const fx = serviceFixture(t, { net, execFile, ...overrides });
  function connect(pid, pgid) {
    const socket = new EventEmitter();
    socket.setTimeout = delay => { socket.timeout = delay; };
    socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
    socket.write = value => { socket.payload = value; };
    socket.end = value => { if (value) socket.payload = value; socket.ended = true; };
    server.connect(socket);
    socket.emit('data', JSON.stringify({ pid, pgid }) + '\n');
    return socket;
  }
  return { ...fx, connect };
}

test('protected MCP checks PID with server ps, ignores claimed PGID and grants credentials once', async t => {
  const lookups = [];
  const fx = credentialFixture(t, (command, argv, opts, callback) => {
    lookups.push({ command, argv }); callback(null, String(fx.service.diagnostics().pgid));
  });
  await fx.service.start();
  const valid = fx.connect(42, 99);
  await tick();
  assert.deepEqual(JSON.parse(valid.payload), { PALANTIR_SESSION_HUB_TOKEN: fx.service.current(),
    PALANTIR_SESSION_HUB_BASE_URL: 'http://127.0.0.1:3000', answers: false });
  assert.deepEqual(lookups, [{ command: '/bin/ps', argv: ['-o', 'pgid=', '-p', '42'] }]);
  const invalid = fx.connect(42, fx.service.diagnostics().pgid);
  await tick();
  assert.equal(invalid.payload, undefined); assert.equal(invalid.destroyed, true);
  assert.equal(lookups.length, 1); assert.ok(fx.service.current());
});

test('forged claimed PGID cannot pass a different real process group', async t => {
  const fx = credentialFixture(t, (command, argv, opts, callback) => callback(null, '99'));
  await fx.service.start();
  const invalid = fx.connect(42, fx.service.diagnostics().pgid);
  await tick();
  assert.equal(invalid.payload, undefined); assert.equal(fx.service.current(), null);
  await fx.service.close();
  assert.equal(fx.service.state().error, 'session_hub_unexpected_pgid');
});

test('invalid PID never invokes ps or receives credentials', async t => {
  for (const pid of [0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
    let lookups = 0;
    const fx = credentialFixture(t, () => { lookups++; });
    await fx.service.start();
    const socket = fx.connect(pid, fx.service.diagnostics().pgid);
    await tick();
    assert.equal(socket.payload, undefined); assert.equal(lookups, 0);
    assert.equal(socket.destroyed, true);
    await fx.service.close();
  }
});

test('concurrent and repeated hellos get one lookup and one credential delivery; later generation may connect',
  async t => {
    let resolveLookup;
    let lookups = 0;
    const fx = credentialFixture(t, (command, argv, opts, callback) => { lookups++; resolveLookup = callback; });
    await fx.service.start();
    const first = fx.connect(42, 0);
    first.emit('data', '{"pid":42,"pgid":0}\n');
    const second = fx.connect(43, 0);
    await tick();
    assert.equal(lookups, 1);
    resolveLookup(null, String(fx.service.diagnostics().pgid));
    await tick();
    assert.ok(first.payload); assert.equal(second.payload, undefined); assert.equal(second.destroyed, true);
    await fx.service.stop(); await fx.service.start();
    const next = fx.connect(44, 0);
    resolveLookup(null, String(fx.service.diagnostics().pgid));
    await tick();
    assert.ok(next.payload); assert.equal(lookups, 2);
  });

test('failed server PGID lookup refuses credentials and terminates the hub', async t => {
  for (const output of ['', 'not-a-pgid', '-1']) {
    const fx = credentialFixture(t, (command, argv, opts, callback) => callback(null, output));
    await fx.service.start();
    const socket = fx.connect(42, fx.service.diagnostics().pgid);
    await tick();
    await fx.service.close();
    assert.equal(socket.payload, undefined);
    assert.equal(fx.service.state().error, 'session_hub_unexpected_pgid');
  }
  const fx = credentialFixture(t, (command, argv, opts, callback) => callback(new Error('ps denied')));
  await fx.service.start();
  const socket = fx.connect(42, fx.service.diagnostics().pgid);
  await tick(); await fx.service.close();
  assert.equal(socket.payload, undefined);
  assert.equal(fx.service.state().error, 'session_hub_unexpected_pgid');
});

for (const action of ['stop', 'newThread', 'shutdown']) {
  test(`${action} settles with a hung PGID lookup and ignores its late result`, async t => {
    const lookups = [];
    const fx = credentialFixture(t, (command, argv, opts, callback) => { lookups.push({ opts, callback }); });
    await fx.service.start();
    const previousGroup = fx.service.diagnostics().pgid;
    const socket = fx.connect(42, previousGroup);
    assert.equal(lookups[0].opts.timeout, 1000);
    const closing = fx.service[action]();
    if (action === 'newThread') await tick();
    assert.equal(fx.service.current(), null);
    const completed = await Promise.race([closing.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 200))]);
    if (!completed) lookups[0].callback(null, String(previousGroup)); // release only to clean up the RED run
    await closing;
    assert.equal(completed, true);
    assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
    assert.equal(lookups[0].opts.killSignal, 'SIGKILL');
    let next;
    let token;
    if (action !== 'shutdown') {
      await fx.service.start();
      next = fx.connect(43, previousGroup);
      lookups[1].callback(null, String(fx.service.diagnostics().pgid));
      await tick();
      token = fx.service.current(); assert.ok(next.payload);
    }
    lookups[0].callback(null, String(previousGroup));
    await tick();
    assert.equal(socket.payload, undefined);
    assert.equal(fx.service.state().error, null);
    if (next) { assert.equal(fx.service.current(), token); assert.equal(fx.service.state().state, 'running'); }
    else assert.equal(fx.service.state().state, 'closed');
  });
}

for (const event of ['close', 'end', 'error']) {
  test(`MCP ${event} closes its generation, revokes token and permits a fresh start only`, async t => {
    const fx = credentialFixture(t, (command, argv, opts, callback) => {
      callback(null, String(fx.service.diagnostics().pgid));
    });
    await fx.service.start();
    const socket = fx.connect(42, 0);
    await tick();
    const oldToken = fx.service.current();
    assert.ok(socket.payload);
    socket.emit(event, event === 'error' ? new Error('MCP died') : undefined);
    assert.equal(fx.service.state().error, null);
    assert.equal(fx.service.state().state, 'running');
    assert.equal(fx.service.current(), null);
    await assert.rejects(() => send(fx.service, 'unavailable'), code('session_hub_not_running'));
    await until(() => fx.service.state().error === 'session_hub_mcp_lost', 3000);
    await fx.service.close();
    assert.equal(fx.service.state().state, 'idle');
    assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
    await fx.service.start();
    const next = fx.connect(43, 0);
    await tick();
    assert.ok(next.payload); assert.notEqual(fx.service.current(), oldToken);
    assert.equal(next.ended, undefined); assert.equal(next.timeout, 0);
    socket.emit('close'); // an old MCP disconnect cannot affect the new generation
    assert.equal(fx.service.state().error, null);
    await send(fx.service, 'new generation'); fx.event({ type: 'result' });
    assert.equal(fx.service.state().state, 'running');
    await fx.service.stop();
    assert.equal(fx.service.state().error, null); // server-initiated disposal is not MCP loss
  });
}

function captureMcpGrace(t) {
  const callbacks = [];
  const original = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, delay, ...args) => {
    if (delay === 2000) { callbacks.push(fn); return { unref() {} }; }
    return original(fn, delay, ...args);
  });
  return callbacks;
}

for (const exitCode of [0, 7]) {
  test(`MCP EOF then final assistant/result then parent exit(${exitCode}) preserves the parent's outcome`, async t => {
    const timers = captureMcpGrace(t);
    const fx = credentialFixture(t, (command, argv, opts, callback) => {
      callback(null, String(fx.service.diagnostics().pgid));
    });
    await fx.service.start(); fx.init();
    const socket = fx.connect(42, 0);
    await tick();
    await send(fx.service, 'last turn');
    socket.emit('end'); socket.emit('close');
    assert.equal(fx.service.current(), null);
    assert.equal(fx.service.state().state, 'running');
    assert.equal(fx.service.state().error, null);
    assert.equal(timers.length, 1); // duplicate socket events must not restart the 2-second grace
    fx.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'last answer' }] } });
    fx.event({ type: 'result' });
    fx.children[0].emit('exit', exitCode);
    await fx.service.close();
    assert.equal(fx.service.state().error, exitCode === 0 ? null : 'session_hub_process_exited');
    assert.equal(fx.service.state().messages.some(row => row.content === 'last answer'), true);
    timers[0]();
    assert.equal(fx.service.state().error, exitCode === 0 ? null : 'session_hub_process_exited');
  });
}

for (const action of ['stop', 'newThread', 'shutdown']) {
  test(`${action} during MCP grace takes precedence over cancelled callbacks in a later generation`, async t => {
    const timers = captureMcpGrace(t);
    const fx = credentialFixture(t, (command, argv, opts, callback) => {
      callback(null, String(fx.service.diagnostics().pgid));
    });
    await fx.service.start();
    const socket = fx.connect(42, 0);
    await tick();
    socket.emit('end');
    assert.equal(fx.service.state().state, 'running');
    assert.equal(timers.length, 1);
    await fx.service[action]();
    assert.equal(fx.service.state().error, null);
    assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
    if (action !== 'shutdown') {
      await fx.service.start();
      const next = fx.connect(43, 0); await tick(); assert.ok(next.payload);
      const token = fx.service.current();
      timers[0]();
      assert.equal(fx.service.current(), token); assert.equal(fx.service.state().state, 'running');
    } else {
      timers[0]();
      assert.equal(fx.service.state().state, 'closed');
    }
    assert.equal(fx.service.state().error, null);
  });
}

for (const ancestor of ['transcript', 'projects', '.claude']) {
  test(`missing memory_paths rejects symlink ${ancestor} ancestor even with a regular owned transcript`, async t => {
    const fx = serviceFixture(t);
    await fx.service.start();
    const { transcriptDir } = fx.service.diagnostics();
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, 'owned.jsonl'), 'keep');
    const directory = ancestor === 'transcript' ? transcriptDir : ancestor === 'projects'
      ? path.dirname(transcriptDir) : path.dirname(path.dirname(transcriptDir));
    const moved = `${directory}-moved`;
    fs.renameSync(directory, moved); fs.symlinkSync(moved, directory);
    fx.event({ type: 'system', subtype: 'init', session_id: 'owned' });
    await send(fx.service, 'first'); fx.event({ type: 'result' });
    await until(() => !fx.service.state().turnInProgress);
    assert.equal(fx.service.state().error, 'session_hub_unexpected_paths');
    await fx.service.close();
    assert.equal(fx.service.current(), null);
    assert.equal((await fx.service.stop()).result, 'incomplete');
    assert.equal(fs.readFileSync(path.join(transcriptDir, 'owned.jsonl'), 'utf8'), 'keep');
  });
}

test('synchronous subscribers can close during starting/closing without losing preparation or duplicating cleanup',
  async t => {
    const fx = serviceFixture(t);
    let requested;
    let nested;
    const unsubscribe = fx.service.subscribe(value => {
      if (value.state === 'starting') requested = fx.service.stop();
      if (value.state === 'closing') nested = fx.service.close();
    });
    await fx.service.start();
    await requested;
    assert.equal(requested, nested);
    assert.equal(fx.calls.length, 0);
    assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
    unsubscribe();
  });

test('even a cancelled previous generation timer callback cannot terminate the next turn', async t => {
  const callbacks = [];
  const original = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, delay, ...args) => {
    if (delay === 777) callbacks.push(fn);
    return original(fn, delay, ...args);
  });
  const fx = serviceFixture(t, { turnTimeoutMs: 777 });
  await fx.service.start(); await send(fx.service, 'old'); await fx.service.stop();
  await fx.service.start(); await send(fx.service, 'new');
  const token = fx.service.current();
  callbacks[0]();
  assert.equal(fx.service.current(), token);
  assert.equal(fx.service.state().state, 'running');
  assert.equal(fx.service.state().turnInProgress, true);
  assert.equal(fx.service.state().error, null);
  fx.event({ type: 'result' });
});

test('ledger write failure still revokes token, reaps and disposes config/transport exactly once', async t => {
  let failed = false;
  const fx = serviceFixture(t, { fs: { ...fsp, async open(filename, ...args) {
    if (path.basename(filename) === 'owned-sessions' && !failed) {
      failed = true; throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
    }
    return fsp.open(filename, ...args);
  } } });
  await fx.service.start(); fx.init();
  await until(() => fx.service.state().state === 'idle');
  assert.equal(fx.service.current(), null);
  assert.equal(fx.service.state().error, 'session_hub_storage_failed');
  assert.equal(fx.service.diagnostics().pgid, null);
  assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), false);
  assert.equal(fs.readdirSync(fx.temp).some(name => name.startsWith('hub-mcp-')), false);
  assert.equal(fx.signals.filter(([, signal]) => signal === 'SIGTERM').length, 1);
});

test('a subscriber stopping on user text cannot leave a new timer or write after closing', async t => {
  const fx = serviceFixture(t, { turnTimeoutMs: 10 });
  await fx.service.start();
  const unsubscribe = fx.service.subscribe(value => {
    if (value.state === 'running' && value.messages.some(row => row.role === 'user')) void fx.service.stop();
  });
  await send(fx.service, 'close here');
  await fx.service.close();
  const messages = fx.service.state().messages;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(fx.service.state().messages, messages);
  assert.equal(fx.service.state().error, null);
  unsubscribe();
});

test('real fake CLI hook output closes and disables the service for this boot', async t => {
  const probes = [];
  let leaderExited = false;
  let firstProbe = true;
  let leader;
  const fx = serviceFixture(t, { spawn: (...args) => {
    assert.equal(args[2].detached, true);
    leader = childProcess.spawn(...args);
    leader.once('exit', () => { leaderExited = true; });
    return leader;
  }, kill: (pid, signal) => {
      try {
        // Hold JS before libuv's waitpid to expose the real Darwin zombie-only group race deterministically.
        if (signal === 0 && firstProbe && process.platform === 'darwin') {
          firstProbe = false;
          const deadline = Date.now() + 200;
          while (Date.now() < deadline) process.kill(pid, signal);
        }
        return process.kill(pid, signal);
      }
      catch (err) {
        if (signal === 0) probes.push(err.code);
        if (err.code === 'EPERM') {
          assert.equal(pid, -leader.pid);
          assert.equal(leaderExited, false);
          assert.doesNotThrow(() => process.kill(leader.pid, 0));
        }
        throw err;
      }
    }, reapMs: 1500 });
  await fx.service.start();
  await until(() => fx.service.diagnostics().initSeen, 5000);
  await send(fx.service, 'hook');
  await until(() => fx.service.state().disabled === 'session_hub_hooks_detected', 5000);
  await fx.service.close();
  if (process.platform === 'darwin') assert.ok(probes.includes('EPERM'));
  assert.equal(probes.at(-1), 'ESRCH');
  assert.equal(leaderExited, true);
  assert.equal(fx.service.state().state, 'idle');
  assert.equal(fx.service.state().disabled, 'session_hub_hooks_detected');
  assert.equal(fx.service.current(), null);
  await assert.rejects(fx.service.start(), code('session_hub_hooks_detected'));
});

test('long TMPDIR falls back to a private short socket directory and cleans both directories', async t => {
  const fx = serviceFixture(t);
  const longTmp = path.join(fx.temp, '한글'.repeat(40));
  fs.mkdirSync(longTmp, { mode: 0o700 });
  const alternate = serviceFixture(t, { tmpDir: longTmp });
  await alternate.service.start();
  assert.equal(alternate.service.state().state, 'running');
  const config = JSON.parse(fs.readFileSync(path.join(alternate.root, 'mcp.json'), 'utf8'));
  const socket = config.mcpServers.session_hub.args.at(-1);
  assert.ok(socket.startsWith('/tmp/phub-'), socket);
  assert.ok(Buffer.byteLength(socket) <= 100);
  const directory = path.dirname(socket);
  const info = fs.lstatSync(directory);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(info.mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(longTmp), []);
  await alternate.service.stop();
  assert.equal(fs.existsSync(directory), false);
});

test('socket fallback rejects a still-overlong path before listening or spawning', async t => {
  const base = serviceFixture(t);
  const longTmp = path.join(base.temp, 'x'.repeat(120));
  fs.mkdirSync(longTmp, { mode: 0o700 });
  let listened = false;
  const fx = serviceFixture(t, { tmpDir: longTmp, fs: { ...fsp,
    mkdtemp: prefix => fsp.mkdtemp(prefix === '/tmp/phub-' ? path.join(longTmp, 'phub-') : prefix),
  }, net: { createServer() { listened = true; throw new Error('unexpected listen'); } } });
  await assert.rejects(fx.service.start(), code('session_hub_socket_path_too_long'));
  assert.equal(listened, false); assert.equal(fx.calls.length, 0);
  assert.deepEqual(fs.readdirSync(longTmp), []);
});

test('socket directory symlink is refused before chmod or spawn without touching its target', async t => {
  const base = serviceFixture(t), target = path.join(base.temp, 'target'), link = path.join(base.temp, 'link');
  fs.mkdirSync(target, { mode: 0o755 });
  fs.symlinkSync(target, link);
  const fx = serviceFixture(t, { fs: { ...fsp, mkdtemp: async () => link } });
  await assert.rejects(fx.service.start(), code('session_hub_unsafe_storage'));
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.equal(fx.calls.length, 0);
});

test('commit precedes stdin, request replay is stable, conflicts and inactive requests are 409', async t => {
  const fx = serviceFixture(t);
  await fx.service.start(); fx.init('commit');
  const payload = { thread_id: fx.service.state().thread_id, request_id: 'retry', text: 'password=abcdef hello' };
  let writes = 0;
  const stdin = fx.children[0].stdin;
  const original = stdin.write.bind(stdin);
  stdin.write = data => {
    writes++;
    const rows = fx.store.messages(payload.thread_id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].content, '[REDACTED] hello');
    assert.equal(rows[1].status, 'partial');
    assert.equal(fx.db.inTransaction, false);
    return original(data);
  };
  const first = await fx.service.message(payload);
  const replay = await fx.service.message({ ...payload, text: 'password=changed hello' });
  assert.equal(replay.user.id, first.user.id);
  assert.equal(writes, 1);
  await assert.rejects(fx.service.message({ ...payload, text: 'other' }), { code: 'request_conflict', status: 409 });
  await assert.rejects(fx.service.newThread(), { code: 'turn_in_progress', status: 409 });
  fx.event({ type: 'result' });
  await fx.service.newThread();
  await assert.rejects(fx.service.message({ ...payload, request_id: 'another' }),
    { code: 'thread_not_active', status: 409 });
});

test('new conversation and message serialize; old output cannot write to the next thread', async t => {
  const fx = serviceFixture(t);
  await fx.service.start(); fx.init('old');
  const oldThread = fx.service.state().thread_id;
  const oldChild = fx.children[0];
  const change = fx.service.newThread();
  const sendOld = fx.service.message({ thread_id: oldThread, request_id: 'old-send', text: 'racing' });
  await change;
  await assert.rejects(sendOld, { code: 'thread_not_active' });
  await fx.service.start(); fx.init('next');
  oldChild.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"late"}]}}\n');
  oldChild.emit('exit', 1);
  assert.deepEqual(fx.service.state().messages, []);
  assert.deepEqual(fx.store.messages(oldThread), []);
  const sending = send(fx.service, 'accepted');
  const changeDuringTurn = fx.service.newThread();
  await sending;
  await assert.rejects(changeDuringTurn, { code: 'turn_in_progress' });
  fx.event({ type: 'result' });
});

test('usage sum and invalidateContext rotate before next stdin with restored context on same thread', async t => {
  const fx = serviceFixture(t);
  await fx.service.start(); fx.init('rotate-1');
  const id = fx.service.state().thread_id;
  await send(fx.service, 'previous turn');
  fx.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'remember this answer' }] } });
  fx.event({ type: 'result', usage: { input_tokens: 1, cache_read_input_tokens: 60000,
    cache_creation_input_tokens: 60000 } });
  assert.equal(fx.calls.length, 1);
  await send(fx.service, 'next turn');
  assert.equal(fx.calls.length, 2);
  assert.equal(fx.service.state().thread_id, id);
  const body = JSON.parse(fx.children[1].stdin.read().toString()).message.content;
  assert.ok(body.includes('previous turn') && body.includes('remember this answer'));
  assert.ok(body.endsWith('next turn'));
  assert.equal(fx.store.messages(id).at(-2).content, 'next turn');
  fx.init('rotate-2'); fx.event({ type: 'result' });
  fx.service.invalidateContext();
  await send(fx.service, 'after invalidate');
  assert.equal(fx.calls.length, 3);
  assert.equal(fx.store.messages(id).filter(row => row.content === '맥락을 새로 정리함').length, 2);
  fx.init('rotate-3'); fx.event({ type: 'result' });
});

test('new instance on same DB recovers partial and injects history without resume', async t => {
  const fx = serviceFixture(t);
  const id = fx.store.active();
  fx.store.reserve({ thread_id: id, request_id: 'crashed', text: 'persisted before crash' });
  const { createSessionHubService } = require('../services/sessionHubService');
  const next = createSessionHubService(fx.options);
  t.after(() => next.shutdown());
  assert.equal(next.state().messages[1].status, 'error');
  assert.equal(next.state().messages[1].content, '서버 재시작으로 중단됨');
  await next.start();
  assert.equal(fx.calls[0].argv.includes('--resume'), false);
  await send(next, 'fresh request');
  const content = JSON.parse(fx.children[0].stdin.read().toString()).message.content;
  assert.ok(content.includes('persisted before crash'));
  assert.equal(next.state().thread_id, id);
});

test('thread deletion only removes its bound transcripts, retains symlinks for retry and legacy cleanup', async t => {
  const fx = serviceFixture(t);
  await fx.service.start();
  const old = fx.service.state().thread_id;
  fx.init('old-session');
  const { transcriptDir } = fx.service.diagnostics();
  fs.mkdirSync(transcriptDir, { recursive: true });
  const oldFile = path.join(transcriptDir, 'old-session.jsonl');
  fs.writeFileSync(oldFile, 'x'.repeat(8 * 1024 * 1024 + 1));
  await fx.service.newThread();
  assert.equal(fs.existsSync(oldFile), false);
  const active = fx.service.state().thread_id;
  fs.writeFileSync(oldFile, 'old');
  const activeFile = path.join(transcriptDir, 'active-session.jsonl');
  fs.writeFileSync(activeFile, 'active');
  const protectedFile = path.join(fx.temp, 'protected'); fs.writeFileSync(protectedFile, 'keep');
  fs.symlinkSync(protectedFile, path.join(transcriptDir, 'legacy.jsonl'));
  fs.writeFileSync(path.join(fx.root, 'owned-sessions'),
    `old-session\t${old}\nactive-session\t${active}\nlegacy\n`, { mode: 0o600 });
  const deleted = await fx.service.deleteThread(old);
  assert.equal(deleted.remaining, 0);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.readFileSync(activeFile, 'utf8'), 'active');
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'keep');
  assert.equal(fx.service.state().transcripts_remaining, 2);
  await assert.rejects(fx.service.deleteThread(active), { code: 'thread_active' });
  fs.unlinkSync(path.join(transcriptDir, 'legacy.jsonl'));
  await fx.service.start(); await fx.service.stop();
  assert.equal(fs.existsSync(activeFile), false);
  assert.equal(fx.service.state().transcripts_remaining, 0);
});

test('partial output commits within two seconds and final commit sanitizes without saving tool arguments', async t => {
  const fx = serviceFixture(t);
  await fx.service.start(); fx.init('partial');
  const reserved = await send(fx.service, 'streaming turn');
  fx.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'first chunk\n' }] } });
  fx.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'password=secret-value\n' },
    { type: 'tool_use', name: 'search_assistant_history', input: { q: 'sensitive-query' } }] } });
  assert.equal(fx.store.get(reserved.user.thread_id, reserved.assistant.id).content, 'first chunk\n');
  await until(() => fx.store.get(reserved.user.thread_id, reserved.assistant.id).content.includes('[REDACTED]'), 2500);
  assert.equal(fx.store.get(reserved.user.thread_id, reserved.assistant.id).status, 'partial');
  fx.event({ type: 'result' });
  assert.equal(fx.store.get(reserved.user.thread_id, reserved.assistant.id).status, 'complete');
  assert.equal(JSON.stringify(fx.store.messages(reserved.user.thread_id)).includes('secret-value'), false);
  assert.equal(JSON.stringify(fx.store.messages(reserved.user.thread_id)).includes('sensitive-query'), false);
});

const answerRev = n => n.toString(16).padStart(16, '0');
const answerRow = (key = 'a', n = 1, machineId = 'mac') => ({ key, rev: answerRev(n), machineId,
  sha256: n.toString(16).padStart(64, '0'), label: machineId });
async function answerTurn(fx) {
  if (fx.service.state().state !== 'running') await fx.service.start();
  await send(fx.service, '답변 확인');
  return fx.service.captureHubTurn(fx.service.current());
}

test('answer scope capture, malformed bindings, reservation limits and byte clipping are synchronous', async t => {
  const fx = serviceFixture(t), hub = fx.service;
  assert.throws(() => hub.captureHubTurn('bad'), code('forbidden'));
  await hub.start();
  assert.throws(() => hub.captureHubTurn(hub.current()), code('turn_not_active'));
  const handle = await answerTurn(fx);
  assert.equal(Object.isFrozen(handle), true);
  assert.throws(() => hub.captureHubTurn('bad'), code('forbidden'));
  for (const invalid of [null, undefined, {}, { ...handle, token: 'bad' },
    { ...handle, generation: -1 }, { ...handle, thread_id: 'bad' }, { ...handle, turn_id: 'bad' }]) {
    hub.recordReturnedKeys(invalid, [answerRow()]);
    assert.throws(() => hub.reserveAnswer(invalid, 'a'), code('turn_not_active'));
    assert.throws(() => hub.completeAnswer(invalid, 'a', 0), code('turn_not_active'));
    assert.throws(() => hub.answerBinding(invalid, 'a', answerRev(1)), code('turn_not_active'));
  }
  hub.recordReturnedKeys(handle, [null, {}, answerRow('../bad'), { ...answerRow(), rev: 'bad' },
    { ...answerRow(), sha256: 'bad' }, { ...answerRow(), rev: answerRev(1) + '\n' },
    { ...answerRow(), sha256: answerRow().sha256 + '\n' }]);
  assert.throws(() => hub.reserveAnswer(handle, 'a'), code('answer_out_of_scope'));
  hub.recordReturnedKeys(handle, ['a', 'b', 'c', 'd'].map(key => answerRow(key)));
  assert.throws(() => hub.answerBinding(handle, 'unknown', answerRev(1)), code('answer_out_of_scope'));
  assert.throws(() => hub.answerBinding(handle, 'a', answerRev(2)), code('snapshot_changed'));
  for (const key of ['a', 'b', 'c']) hub.reserveAnswer(handle, key);
  assert.throws(() => hub.reserveAnswer(handle, 'd'), code('answer_budget_exceeded'));
  hub.reserveAnswer(handle, 'a'); hub.reserveAnswer(handle, 'a');
  assert.throws(() => hub.reserveAnswer(handle, 'a'), code('answer_budget_exceeded'));
  assert.deepEqual(hub.completeAnswer(handle, 'a', 24000), { budget_clipped: false });
  assert.deepEqual(hub.completeAnswer(handle, 'a', 577), { budget_clipped: true });
  assert.deepEqual(hub.completeAnswer(handle, 'a', 576), { budget_clipped: false });
  assert.deepEqual(hub.completeAnswer(handle, 'a', 1), { budget_clipped: true });
  hub.recordReturnedKeys(handle, [answerRow('new')]);
  assert.throws(() => hub.reserveAnswer(handle, 'new'), code('answer_out_of_scope'));
});

for (const frozen of [false, true]) test(`binding revisions keep insertion order and machine identity, frozen=${frozen}`, async t => {
  const fx = serviceFixture(t), hub = fx.service, handle = await answerTurn(fx);
  hub.recordReturnedKeys(handle, [answerRow(), answerRow('a', 1, 'evil')]);
  const captured = hub.answerBinding(handle, 'a', answerRev(1));
  assert.equal(captured.machineId, 'mac');
  captured.label = 'mutated copy';
  assert.equal(hub.answerBinding(handle, 'a', answerRev(1)).label, 'mac');
  if (frozen) hub.completeAnswer(handle, 'a', 0);
  hub.recordReturnedKeys(handle, [answerRow('a', 2), answerRow('a', 3), answerRow('a', 4)]);
  // Updating the oldest rev must not make it the newest inserted rev.
  hub.recordReturnedKeys(handle, [{ ...answerRow(), label: 'updated' }]);
  assert.equal(hub.answerBinding(handle, 'a', answerRev(1)).label, 'updated');
  hub.recordReturnedKeys(handle, [answerRow('a', 5), answerRow('a', 6, 'evil'), answerRow('new')]);
  assert.throws(() => hub.answerBinding(handle, 'a', answerRev(1)), code('snapshot_changed'));
  for (const n of [2, 3, 4, 5]) assert.equal(hub.answerBinding(handle, 'a', answerRev(n)).machineId, 'mac');
  assert.throws(() => hub.answerBinding(handle, 'a', answerRev(6)), code('snapshot_changed'));
  assert.equal(captured.sha256, answerRow().sha256, 'in-flight copy survives eviction');
  if (frozen) assert.throws(() => hub.reserveAnswer(handle, 'new'), code('answer_out_of_scope'));
  // Rejected rev checks have not consumed any reservations.
  for (let i = 0; i < 5; i++) hub.reserveAnswer(handle, 'a');
  assert.throws(() => hub.reserveAnswer(handle, 'a'), code('answer_budget_exceeded'));
});

test('answer handles expire at turn end, new turn, close and generation replacement; partial commits retain scope', async t => {
  const fx = serviceFixture(t), hub = fx.service;
  const old = await answerTurn(fx);
  hub.recordReturnedKeys(old, [answerRow()]);
  fx.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial\n' }] } });
  assert.equal(hub.answerBinding(old, 'a', answerRev(1)).machineId, 'mac');
  const expired = handle => {
    hub.recordReturnedKeys(handle, [answerRow('leaked')]);
    assert.throws(() => hub.reserveAnswer(handle, 'a'), code('turn_not_active'));
    assert.throws(() => hub.completeAnswer(handle, 'a', 0), code('turn_not_active'));
  };
  fx.event({ type: 'result' }); expired(old);
  const next = await answerTurn(fx); expired(old);
  assert.throws(() => hub.reserveAnswer(next, 'leaked'), code('answer_out_of_scope'));
  await hub.stop(); expired(next);
  const replacement = await answerTurn(fx); expired(next);
  assert.notEqual(replacement.generation, next.generation);
  assert.throws(() => hub.reserveAnswer(replacement, 'a'), code('answer_out_of_scope'));
});

test('MCP loss immediately invalidates answer operations during the two-second turn grace', async t => {
  const fx = credentialFixture(t, (cmd, argv, opts, cb) => cb(null, String(fx.service.diagnostics().pgid)));
  await fx.service.start(); const socket = fx.connect(41); await tick();
  const handle = await answerTurn(fx), hub = fx.service;
  hub.recordReturnedKeys(handle, [answerRow()]); hub.reserveAnswer(handle, 'a');
  socket.emit('end');
  assert.equal(hub.current(), null); assert.equal(hub.state().turnInProgress, true);
  hub.recordReturnedKeys(handle, [answerRow('new')]);
  assert.throws(() => hub.reserveAnswer(handle, 'a'), code('turn_not_active'));
  assert.throws(() => hub.completeAnswer(handle, 'a', 1), code('turn_not_active'));
});

for (const answers of [false, true]) test(`sealed answers=${answers} reaches actual spawn, prompt version and credentials`, async t => {
  const { sessionHubArgv, TOOL_NAMES } = require('../services/sessionHubService');
  const { sessionHubPrompt, sessionHubPromptVersion } = require('../services/sessionHubPrompt');
  const fx = credentialFixture(t, (cmd, argv, opts, cb) => cb(null, String(fx.service.diagnostics().pgid)), { answers });
  await fx.service.start();
  const socket = fx.connect(41); await tick();
  const argv = fx.calls[0].argv;
  assert.deepEqual(argv, sessionHubArgv(path.join(fx.root, 'mcp.json'), { answers }));
  assert.equal(argv[argv.indexOf('--allowedTools') + 1].includes('mcp__session_hub__get_answer'), answers);
  assert.equal(TOOL_NAMES.includes('get_answer'), false);
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], sessionHubPrompt(answers));
  assert.equal(fx.service.state().promptVersion, sessionHubPromptVersion(answers));
  assert.equal(JSON.parse(socket.payload).answers, answers);
  assert.equal(sessionHubPrompt(answers).includes('get_answer'), answers);
  if (answers) for (const text of ['비신뢰', '사실 확인이 아니다', '추가 조회·기억 제안', '검증된 완료',
    'answer_at·observed_at', '5회·3세션', 'budget_clipped', 'rev 없이 get_session', '한 번만 다시 시도']) {
    assert.ok(sessionHubPrompt(true).includes(text), text);
  }
});

test('get_answer protocol persists the exact tool name only and drops tool_result bodies', async t => {
  const fx = serviceFixture(t), hub = fx.service;
  await answerTurn(fx);
  const name = 'mcp__session_hub__get_answer', secret = 'UNIQUE_UNTRUSTED_ANSWER_BODY_6_3';
  fx.event({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'answer-1', name,
    input: { key: 'a', instruction: 'claude:a:u1', rev: answerRev(1) } }] } });
  fx.event({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'answer-1',
    content: [{ type: 'text', text: secret }] }] } });
  fx.event({ type: 'result' });
  const messages = hub.state().messages;
  assert.deepEqual(messages.filter(row => row.role === 'tool_note').map(row => row.content), [name]);
  assert.equal(JSON.stringify(fx.db.prepare('SELECT * FROM assistant_messages').all()).includes(secret), false);
});
