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
  const fx = serviceFixture(t, { termMs: 60, reapMs: 1500, pollMs: 10,
    spawn: (command, argv, opts) => childProcess.spawn(command, [...argv, '--fixture-stubborn-child'], opts),
    kill: (...args) => process.kill(...args),
  });
  await fx.service.start();
  const childFile = path.join(fx.service.diagnostics().cwd, 'child-pid');
  await until(() => fs.existsSync(childFile));
  const descendant = Number(fs.readFileSync(childFile));
  await new Promise(resolve => setTimeout(resolve, 100));
  await fx.service.clear();
  assert.throws(() => process.kill(descendant, 0), err => err.code === 'ESRCH');
});

test('protected MCP bootstrap receives exactly two env keys and PGID mismatch fails closed', async t => {
  const { fakeNet } = require('./helpers/session-hub-service-fixture.cjs');
  const { EventEmitter } = require('node:events');
  let server;
  const net = fakeNet();
  const create = net.createServer;
  net.createServer = handler => { server = create(handler); return server; };
  const fx = serviceFixture(t, { net });
  await fx.service.start();
  function connect(pgid) {
    const socket = new EventEmitter();
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    socket.end = value => { socket.payload = value; };
    server.connect(socket);
    socket.emit('data', JSON.stringify({ pid: 42, pgid }) + '\n');
    return socket;
  }
  const valid = connect(fx.service.diagnostics().pgid);
  assert.deepEqual(JSON.parse(valid.payload), { PALANTIR_SESSION_HUB_TOKEN: fx.service.current(),
    PALANTIR_SESSION_HUB_BASE_URL: 'http://127.0.0.1:3000' });
  const invalid = connect(99);
  assert.equal(invalid.payload, undefined); assert.equal(fx.service.current(), null);
  await fx.service.close();
  assert.equal(fx.service.state().error, 'session_hub_unexpected_pgid');
});

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
