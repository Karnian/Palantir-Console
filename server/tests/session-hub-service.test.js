'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const { serviceFixture, tick, until } = require('./helpers/session-hub-service-fixture.cjs');
const { SESSION_HUB_PROMPT } = require('../services/sessionHubPrompt');

const code = expected => err => err.code === expected;

test('state version increases across start, messages, stop and clear; replies match published snapshots', async t => {
  const fx = serviceFixture(t), versions = [];
  assert.equal(fx.service.state().version, 0);
  fx.service.subscribe(value => versions.push(value.version));
  const started = await fx.service.start();
  assert.equal(started.version, fx.service.state().version);
  assert.ok(started.version > 0);
  fx.init();
  const message = fx.service.message('버전 확인');
  assert.ok(message.version > started.version);
  assert.equal(message.messages.at(-1).text, '버전 확인');
  const stopped = await fx.service.stop();
  assert.ok(stopped.version > message.version);
  assert.equal(stopped.version, fx.service.state().version);
  const cleared = await fx.service.clear();
  assert.ok(cleared.version > stopped.version);
  assert.equal(cleared.version, fx.service.state().version);
  assert.deepEqual(cleared.messages, []);
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
      'mcp__session_hub__get_session'].join(','), '--permission-mode', 'default',
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
  assert.equal(fs.readFileSync(path.join(fx.root, 'owned-sessions'), 'utf8'), 'bad-path\n');
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
    fx.service.message('first turn');
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
      fx.service.message('second turn');
      await until(() => events.filter(event => event.type === 'result').length === 2);
      await fx.service.stop();
    }
    assert.equal(fs.readFileSync(path.join(fx.root, 'owned-sessions'), 'utf8'), 'fixture-session\n');
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
    fx.service.message('first'); fx.event({ type: 'result' });
    await arrived;
    assert.equal(fx.service.state().turnInProgress, true);
    assert.throws(() => fx.service.message('too early'), code('turn_in_progress'));
    release(); await until(() => !fx.service.state().turnInProgress);
    fx.service.message('next'); fx.event({ type: 'result' });
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
    fx.service.message('first'); fx.event({ type: 'result' });
    await until(() => fx.service.state().error === 'session_hub_unexpected_paths');
    await fx.service.close();
    assert.equal(fx.service.current(), null);
    assert.equal(fx.service.state().state, 'idle');
    assert.throws(() => fx.service.message('next'), code('session_hub_not_running'));
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
    fx.service.message('first'); fx.event({ type: 'result' });
    await arrived;
    let closed = false;
    const closing = fx.service.clear();
    closing.then(() => { closed = true; });
    await tick();
    assert.equal(closed, false);
    assert.equal(fs.existsSync(path.join(fx.root, 'mcp.json')), true);
    await assert.rejects(fx.service.start(), code('session_hub_busy'));
    release(); await closing;
    assert.equal(fx.service.state().error, null);
    await fx.service.start(); fx.init('next');
    fx.service.message('new turn');
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
  fx.service.message('first');
  assert.throws(() => fx.service.message('second'), code('turn_in_progress'));
  fx.event({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'list_sessions', input: { limit: 1 } },
    { type: 'text', text: 'answer' }] } });
  fx.event({ type: 'result' });
  assert.deepEqual(fx.service.state().messages.map(row => row.role), ['user', 'tool', 'assistant']);
  for (let i = 0; i < 210; i++) {
    fx.service.message(`message ${i}`); fx.event({ type: 'result' });
  }
  assert.equal(fx.service.state().messages.length, 200);
  assert.equal(fx.service.state().messages[0].text, 'message 10');
  for (let i = 0; i < 3; i++) {
    fx.service.message('한'.repeat(150000)); fx.event({ type: 'result' });
  }
  assert.ok(Buffer.byteLength(JSON.stringify(fx.service.state().messages)) <= 1024 * 1024);
  fx.service.message('timeout');
  await until(() => fx.service.state().state === 'idle');
  assert.equal(fx.service.state().error, 'session_hub_turn_timeout');
});

test('close same Promise, token revoked synchronously, shutdown permanent and stale generation harmless', async t => {
  const fx = serviceFixture(t, { turnTimeoutMs: 30 });
  await fx.service.start(); fx.service.message('old');
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
  assert.throws(() => fx.service.message('no'), code('session_hub_closed'));
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
    const clearing = fx.service.clear();
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

test('six transcript ownership fixtures: large owned deleted, four remain and ledger retains symlink ID', async t => {
  const fx = serviceFixture(t);
  await fx.service.start(); fx.init('large-owned'); await fx.service.stop();
  const { cwd, transcriptDir } = fx.service.diagnostics();
  fs.mkdirSync(transcriptDir, { recursive: true });
  const write = (name, text) => fs.writeFileSync(path.join(transcriptDir, `${name}.jsonl`), text);
  write('large-owned', 'x'.repeat(8 * 1024 * 1024 + 1));
  write('matching', `${JSON.stringify({ cwd })}\n${JSON.stringify({ cwd })}\n`);
  write('mixed', `${JSON.stringify({ cwd })}\n${JSON.stringify({ cwd: '/other' })}\n`);
  write('no-cwd', '{"text":"not ours"}\n');
  write('large-unowned', 'x'.repeat(8 * 1024 * 1024 + 1));
  const target = path.join(fx.temp, 'protected'); fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, path.join(transcriptDir, 'link-owned.jsonl'));
  fs.appendFileSync(path.join(fx.root, 'owned-sessions'), 'link-owned\n');
  const result = await fx.service.clear();
  assert.equal(result.result, 'incomplete'); assert.equal(result.remaining, 4);
  assert.deepEqual(fs.readdirSync(transcriptDir).sort(),
    ['large-unowned.jsonl', 'link-owned.jsonl', 'mixed.jsonl', 'no-cwd.jsonl']);
  assert.equal(fs.readFileSync(path.join(fx.root, 'owned-sessions'), 'utf8'), 'link-owned\n');
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.equal(fs.existsSync(cwd), false);
  for (const name of fs.readdirSync(transcriptDir)) fs.unlinkSync(path.join(transcriptDir, name));
  assert.equal((await fx.service.clear()).result, 'complete');
});

test('memory files remain and transcript symlink is never followed', async t => {
  const fx = serviceFixture(t);
  await fx.service.start(); await fx.service.stop();
  const { transcriptDir } = fx.service.diagnostics();
  fs.mkdirSync(path.join(transcriptDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, 'memory/one'), 'memory');
  fs.writeFileSync(path.join(transcriptDir, 'memory/two'), 'memory');
  assert.equal((await fx.service.clear()).remaining, 2);
  const moved = `${transcriptDir}-moved`;
  fs.renameSync(transcriptDir, moved); fs.symlinkSync(moved, transcriptDir);
  assert.equal((await fx.service.clear()).result, 'incomplete');
  assert.equal(fs.readFileSync(path.join(moved, 'memory/one'), 'utf8'), 'memory');
});

test('reap escalates after parent exit, then verifies ESRCH before deletion', async t => {
  let alive = true;
  const signals = [];
  const fx = serviceFixture(t, { kill(pid, signal) {
    signals.push(signal);
    if (signal === 'SIGKILL') alive = false;
    if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  } });
  await fx.service.start();
  const closing = fx.service.clear();
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
  await fx.service.start(); fx.service.message('preserve');
  await assert.rejects(fx.service.clear(), code('reap_failed'));
  assert.equal(fx.service.state().state, 'error:reap_failed');
  assert.equal(fx.service.state().messages[0].text, 'preserve');
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
  await fx.service.clear();
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
  await fx.service.start(); fx.service.message('preserve');
  await assert.rejects(fx.service.clear(), code('reap_failed'));
  assert.ok(signals.includes('SIGTERM')); assert.ok(signals.includes('SIGKILL'));
  assert.equal(fx.service.state().state, 'error:reap_failed');
  assert.equal(fx.service.state().messages[0].text, 'preserve');
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
  const fx = serviceFixture(t, { termMs: 60, reapMs: 1500, pollMs: 10,
    spawn: (command, argv, opts) => childProcess.spawn(command, [...argv, '--fixture-stubborn-child'], opts),
    kill: (...args) => { signals.push(args[1]); return process.kill(...args); },
  });
  await fx.service.start();
  const childFile = path.join(fx.service.diagnostics().cwd, 'child-pid');
  await until(() => fs.existsSync(childFile));
  const descendant = Number(fs.readFileSync(childFile));
  await new Promise(resolve => setTimeout(resolve, 100));
  await fx.service.clear();
  assert.ok(signals.includes('SIGKILL'));
  assert.throws(() => process.kill(descendant, 0), err => err.code === 'ESRCH');
});

function credentialFixture(t, execFile) {
  const { fakeNet } = require('./helpers/session-hub-service-fixture.cjs');
  const { EventEmitter } = require('node:events');
  let server;
  const net = fakeNet();
  const create = net.createServer;
  net.createServer = handler => { server = create(handler); return server; };
  const fx = serviceFixture(t, { net, execFile });
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
    PALANTIR_SESSION_HUB_BASE_URL: 'http://127.0.0.1:3000' });
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

for (const action of ['stop', 'clear', 'shutdown']) {
  test(`${action} settles with a hung PGID lookup and ignores its late result`, async t => {
    const lookups = [];
    const fx = credentialFixture(t, (command, argv, opts, callback) => { lookups.push({ opts, callback }); });
    await fx.service.start();
    const previousGroup = fx.service.diagnostics().pgid;
    const socket = fx.connect(42, previousGroup);
    assert.equal(lookups[0].opts.timeout, 1000);
    const closing = fx.service[action]();
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
    assert.throws(() => fx.service.message('unavailable'), code('session_hub_not_running'));
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
    fx.service.message('new generation'); fx.event({ type: 'result' });
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
    fx.service.message('last turn');
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
    assert.equal(fx.service.state().messages.some(row => row.text === 'last answer'), true);
    timers[0]();
    assert.equal(fx.service.state().error, exitCode === 0 ? null : 'session_hub_process_exited');
  });
}

for (const action of ['stop', 'clear', 'shutdown']) {
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
    fx.service.message('first'); fx.event({ type: 'result' });
    await until(() => !fx.service.state().turnInProgress);
    assert.equal(fx.service.state().error, 'session_hub_unexpected_paths');
    await fx.service.close();
    assert.equal(fx.service.current(), null);
    assert.equal((await fx.service.clear()).result, 'incomplete');
    assert.equal(fs.readFileSync(path.join(transcriptDir, 'owned.jsonl'), 'utf8'), 'keep');
  });
}

test('synchronous subscribers can close during starting/closing without losing preparation or duplicating cleanup',
  async t => {
    const fx = serviceFixture(t);
    let requested;
    let nested;
    const unsubscribe = fx.service.subscribe(value => {
      if (value.state === 'starting') requested = fx.service.clear();
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
  await fx.service.start(); fx.service.message('old'); await fx.service.stop();
  await fx.service.start(); fx.service.message('new');
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
  fx.service.message('close here');
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
  fx.service.message('hook');
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

test('clear after reboot deletes old owned transcripts without resuming messages or spawning', async t => {
  const fx = serviceFixture(t);
  await fx.service.start(); fx.init('previous-boot'); await fx.service.stop();
  const { transcriptDir, cwd } = fx.service.diagnostics();
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, 'previous-boot.jsonl'), 'x'.repeat(8 * 1024 * 1024 + 1));
  fs.writeFileSync(path.join(cwd, 'leftover'), 'old CLI file');
  const { createSessionHubService } = require('../services/sessionHubService');
  const next = createSessionHubService(fx.options);
  t.after(() => next.shutdown());
  assert.deepEqual(next.state().messages, []);
  const result = await next.clear();
  assert.equal(result.result, 'complete'); assert.equal(result.remaining, 0);
  assert.equal(fs.existsSync(transcriptDir), false); assert.equal(fs.existsSync(cwd), false);
  assert.equal(fs.readFileSync(path.join(fx.root, 'owned-sessions'), 'utf8'), '');
  assert.equal(fx.calls.length, 1);
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
