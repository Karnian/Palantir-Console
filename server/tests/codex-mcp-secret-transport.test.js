const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const { flattenMcpToCodexArgs } = require('../services/managerAdapters/codexMcpFlatten');
const {
  WRAPPER_FILENAME,
  WRAPPER_BOOT_ENV_KEYS,
  SECRET_CLEANUP_ATTEMPTS,
  buildWrapperSource,
  prepareCodexMcpArgs,
  removeSecretDirWithRetry,
  validateCodexMcpSecretTransport,
} = require('../services/managerAdapters/codexMcpSecretTransport');
const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');

function cflags(args) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && i + 1 < args.length) values.push(args[i + 1]);
  }
  return values;
}

function createFakeChild() {
  const child = new EventEmitter();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => { child.killedWith = signal; };
  return child;
}

function waitImmediate() {
  return new Promise(resolve => setImmediate(resolve));
}

test('issue #113: stdio env is file-backed, argv-safe, mode 0600, and round-trips exact command/args/env', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-mcp-secret-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const secret = 'sentinel-"quote"\n한글-🔐';
  const originalArg = 'arg with "quotes"\nand unicode 눈';
  const probe = 'process.stdout.write(JSON.stringify({ token: process.env.MCP_TOKEN, arg: process.argv[1] }))';
  const placements = [];
  const config = {
    mcpServers: {
      relay: {
        command: process.execPath,
        args: ['-e', probe, originalArg],
        env: { MCP_TOKEN: secret },
        required: true,
      },
      plain: { command: 'plain-command', args: ['--safe'] },
      remote: { url: 'http://127.0.0.1:3100/mcp', bearer_token_env_var: 'REMOTE_TOKEN' },
    },
  };

  const prepared = prepareCodexMcpArgs(config, {
    putSecretFile(name, content, mode) {
      placements.push({ name, content, mode });
      const filePath = path.join(tempRoot, name);
      fs.writeFileSync(filePath, content, { mode });
      fs.chmodSync(filePath, mode);
      return filePath;
    },
  });

  assert.equal(placements.length, 1, 'all env-bearing aliases share one secret wrapper');
  assert.equal(placements[0].name, WRAPPER_FILENAME);
  assert.equal(placements[0].mode, 0o600);
  assert.equal(fs.statSync(prepared.secretPath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(prepared.secretPath, 'utf8'), /MCP_TOKEN/);
  assert.ok(fs.readFileSync(prepared.secretPath, 'utf8').includes('한글-🔐'));

  const serializedArgv = JSON.stringify(prepared.args);
  assert.equal(serializedArgv.includes(secret), false, 'secret value occurs zero times in argv');
  assert.equal(serializedArgv.includes(originalArg), false, 'wrapped original args stay in the file too');

  const flags = cflags(prepared.args);
  assert.ok(flags.includes(`mcp_servers.relay.command=${JSON.stringify(process.execPath)}`));
  for (const key of WRAPPER_BOOT_ENV_KEYS) {
    assert.ok(flags.includes(`mcp_servers.relay.env.${key}=""`), `${key} is neutralized for wrapper boot`);
  }
  assert.ok(flags.includes('mcp_servers.relay.required=true'), 'non-secret leaf keeps -c precedence');
  assert.ok(flags.includes('mcp_servers.plain.command="plain-command"'));
  assert.ok(flags.includes('mcp_servers.remote.url="http://127.0.0.1:3100/mcp"'));
  assert.ok(flags.includes('mcp_servers.remote.bearer_token_env_var="REMOTE_TOKEN"'));

  const wrapperRun = spawnSync(process.execPath, [prepared.secretPath, 'relay'], { encoding: 'utf8' });
  assert.equal(wrapperRun.status, 0, wrapperRun.stderr);
  assert.deepEqual(JSON.parse(wrapperRun.stdout), { token: secret, arg: originalArg });
});

test('issue #113: __proto__ alias remains an own server and cannot silently drop its env', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-mcp-proto-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const secret = 'proto-alias-secret';
  const probe = 'process.stdout.write(process.env.PROTO_TOKEN || "missing")';
  const config = JSON.parse(
    `{"mcpServers":{"__proto__":{"command":${JSON.stringify(process.execPath)},` +
    `"args":["-e",${JSON.stringify(probe)}],"env":{"PROTO_TOKEN":${JSON.stringify(secret)}}}}}`,
  );
  let placements = 0;
  const prepared = prepareCodexMcpArgs(config, {
    putSecretFile(name, content, mode) {
      placements += 1;
      const filePath = path.join(tempRoot, name);
      fs.writeFileSync(filePath, content, { mode });
      return filePath;
    },
  });

  assert.equal(placements, 1);
  assert.equal(JSON.stringify(prepared.args).includes(secret), false);
  assert.ok(
    cflags(prepared.args).includes(
      `mcp_servers.__proto__.command=${JSON.stringify(process.execPath)}`,
    ),
  );
  const run = spawnSync(process.execPath, [prepared.secretPath, '__proto__'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, secret);

  const inherited = spawnSync(process.execPath, [prepared.secretPath, 'toString'], { encoding: 'utf8' });
  assert.equal(inherited.status, 64, 'prototype names are not treated as configured aliases');
});

test('issue #113: wrapper propagates child exit code and rejects an unknown alias', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-mcp-exit-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const prepared = prepareCodexMcpArgs({
    mcpServers: {
      exits: {
        command: process.execPath,
        args: ['-e', 'process.exit(23)'],
        env: { ONLY_IN_FILE: 'exit-secret' },
      },
    },
  }, {
    putSecretFile(name, content, mode) {
      const filePath = path.join(tempRoot, name);
      fs.writeFileSync(filePath, content, { mode });
      return filePath;
    },
  });

  assert.equal(spawnSync(process.execPath, [prepared.secretPath, 'exits']).status, 23);
  assert.equal(spawnSync(process.execPath, [prepared.secretPath, 'missing']).status, 64);
});

test('issue #113: raw flatten and env-only partial aliases fail closed without placement', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({
      mcpServers: { leak: { command: 'x', env: { TOKEN: 'never-argv' } } },
    }),
    /require file-backed secret transport/,
  );

  let placed = 0;
  assert.throws(
    () => prepareCodexMcpArgs({
      mcpServers: { partial: { env: { TOKEN: 'never-argv' } } },
    }, {
      putSecretFile() { placed += 1; },
    }),
    /has env values but no concrete command/,
  );
  assert.equal(placed, 0, 'invalid config is rejected before a secret file is placed');
  assert.throws(
    () => validateCodexMcpSecretTransport({
      mcpServers: { badArgs: { command: 'x', args: ['ok', 3], env: { TOKEN: 'x' } } },
    }),
    /args must be an array of strings/,
  );
});

test('issue #113: unsafe placement paths never reach cleanup tracking', () => {
  const config = {
    mcpServers: { secret: { command: 'x', env: { TOKEN: 'file-only' } } },
  };
  const unsafePaths = [
    '',
    WRAPPER_FILENAME,
    `/tmp/../${WRAPPER_FILENAME}`,
    `/${WRAPPER_FILENAME}`,
    '/tmp/wrong-name.cjs',
    `/tmp/${WRAPPER_FILENAME}\n`,
  ];
  let callbacks = 0;
  for (const unsafePath of unsafePaths) {
    assert.throws(
      () => prepareCodexMcpArgs(config, {
        putSecretFile() { return unsafePath; },
        onSecretPlaced() { callbacks += 1; },
      }),
      /wrapper path|absolute wrapper path|unsafe wrapper parent/,
    );
  }
  assert.equal(callbacks, 0, 'unsafe path must never become an rmrf target');
});

test('issue #113: wrapper runtime is resolved before placement and must be a safe absolute path', async () => {
  const config = {
    mcpServers: { secret: { command: 'x', env: { TOKEN: 'file-only' } } },
  };
  let placements = 0;
  const prepared = await prepareCodexMcpArgs(config, {
    async resolveWrapperCommand() { return '/opt/node/bin/node'; },
    putSecretFile(name) {
      placements += 1;
      return `/tmp/runtime-resolution/${name}`;
    },
  });
  assert.equal(placements, 1);
  assert.ok(
    cflags(prepared.args).includes('mcp_servers.secret.command="/opt/node/bin/node"'),
  );

  for (const unsafe of ['', 'node', '/tmp/../node', '/node\n']) {
    let unsafePlacements = 0;
    await assert.rejects(
      async () => prepareCodexMcpArgs(config, {
        resolveWrapperCommand() { return unsafe; },
        putSecretFile() { unsafePlacements += 1; },
      }),
      /runtime must resolve to a safe absolute path/,
    );
    assert.equal(unsafePlacements, 0);
  }
});

test('issue #113: secret cleanup retries transient failures and remains bounded', async () => {
  let transientCalls = 0;
  await removeSecretDirWithRetry({
    async rmrf() {
      transientCalls += 1;
      if (transientCalls < SECRET_CLEANUP_ATTEMPTS) throw new Error('transient');
    },
  }, '/tmp/transient-secret', { retryMs: 0 });
  assert.equal(transientCalls, SECRET_CLEANUP_ATTEMPTS);

  let persistentCalls = 0;
  await assert.rejects(
    () => removeSecretDirWithRetry({
      async rmrf() {
        persistentCalls += 1;
        throw new Error('persistent');
      },
    }, '/tmp/persistent-secret', { retryMs: 0 }),
    /persistent/,
  );
  assert.equal(persistentCalls, SECRET_CLEANUP_ATTEMPTS);
});

test('issue #113: NUL is rejected before placement without echoing the value', () => {
  const nulSecret = 'nul-secret\0tail';
  let placements = 0;
  let error;
  try {
    prepareCodexMcpArgs({
      mcpServers: { secret: { command: 'x', env: { TOKEN: nulSecret } } },
    }, {
      putSecretFile() { placements += 1; },
    });
  } catch (err) {
    error = err;
  }
  assert.ok(error);
  assert.match(error.message, /secret\.env\.TOKEN contains NUL/);
  assert.equal(error.message.includes(nulSecret), false);
  assert.equal(placements, 0);

  assert.throws(
    () => validateCodexMcpSecretTransport({
      mcpServers: { secret: { command: 'bad\0command', env: { TOKEN: 'x' } } },
    }),
    /command contains NUL/,
  );
  assert.throws(
    () => validateCodexMcpSecretTransport({
      mcpServers: { secret: { command: 'x', args: ['ok', 'bad\0arg'], env: { TOKEN: 'x' } } },
    }),
    /args\[1\] contains NUL/,
  );
});

test('issue #113: wrapper catches synchronous spawn validation errors without a secret-bearing stack', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-mcp-wrapper-defense-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const source = buildWrapperSource({
    secret: { command: 'x', args: [], env: { TOKEN: 'defense-secret\0tail' } },
  });
  const wrapperPath = path.join(tempRoot, WRAPPER_FILENAME);
  fs.writeFileSync(wrapperPath, source, { mode: 0o600 });

  const result = spawnSync(process.execPath, [wrapperPath, 'secret'], { encoding: 'utf8' });
  assert.equal(result.status, 127);
  assert.equal(result.stderr, 'Palantir MCP wrapper spawn failed\n');
  assert.equal(result.stderr.includes('defense-secret'), false);

  fs.writeFileSync(wrapperPath, buildWrapperSource({
    secret: { command: '/definitely/missing/async-defense-secret', args: [], env: { TOKEN: 'x' } },
  }), { mode: 0o600 });
  const asyncError = spawnSync(process.execPath, [wrapperPath, 'secret'], { encoding: 'utf8' });
  assert.equal(asyncError.status, 127);
  assert.equal(asyncError.stderr, 'Palantir MCP wrapper spawn failed\n');
  assert.equal(asyncError.stderr.includes('async-defense-secret'), false);
});

test('issue #113: wrapper forwards SIGTERM and preserves signal termination', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-mcp-wrapper-signal-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const wrapperPath = path.join(tempRoot, WRAPPER_FILENAME);
  fs.writeFileSync(wrapperPath, buildWrapperSource({
    signal: {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
      env: { TOKEN: 'signal-secret' },
    },
  }), { mode: 0o600 });

  const wrapper = spawn(process.execPath, [wrapperPath, 'signal'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { wrapper.kill('SIGKILL'); } catch { /* already exited */ } });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('wrapper child did not become ready')), 3000);
    wrapper.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    wrapper.once('error', reject);
  });

  const exited = new Promise(resolve => wrapper.once('exit', (code, signal) => resolve({ code, signal })));
  wrapper.kill('SIGTERM');
  let exitTimeout;
  const terminal = await Promise.race([
    exited,
    new Promise((_, reject) => {
      exitTimeout = setTimeout(() => reject(new Error('wrapper did not terminate')), 3000);
    }),
  ]);
  clearTimeout(exitTimeout);
  assert.deepEqual(terminal, { code: null, signal: 'SIGTERM' });
});

test('issue #113: HTTP MCP stays byte-identical and does not place a file', () => {
  const config = {
    mcpServers: {
      remote: { url: 'http://127.0.0.1:3100/mcp', bearer_token_env_var: 'REMOTE_TOKEN' },
    },
  };
  const expected = flattenMcpToCodexArgs(config);
  const prepared = prepareCodexMcpArgs(config, {
    putSecretFile() { throw new Error('must not place'); },
    resolveWrapperCommand() { throw new Error('must not resolve runtime'); },
  });
  assert.deepEqual(prepared.args, expected);
  assert.equal(prepared.secretPath, null);
});

test('issue #113: CodexAdapter reuses wrapper on initial/resume and removes all secret dirs on dispose', async () => {
  const secret = 'adapter-secret-sentinel-🔐';
  const putCalls = [];
  const spawnCalls = [];
  const rmrfCalls = [];
  const children = [];
  let runtimeResolveCalls = 0;
  const executor = {
    putSecretFile(name, content, mode) {
      const dir = `/pod/.palantir-secret-${putCalls.length + 1}`;
      putCalls.push({ name, content, mode, dir });
      return `${dir}/${name}`;
    },
    resolveNodeRuntime() { runtimeResolveCalls += 1; return '/usr/bin/node'; },
    spawnInteractive(_command, args) {
      spawnCalls.push([...args]);
      const child = createFakeChild();
      children.push(child);
      return child;
    },
    rmrf(dir) { rmrfCalls.push(dir); },
  };
  const adapter = createCodexAdapter({ codexBin: 'codex-test', runService: null });
  adapter.startSession('run_secret_resume', {
    systemPrompt: 'system',
    cwd: process.cwd(),
    executor,
    mcpConfig: {
      mcpServers: {
        secret: { command: 'npx', args: ['-y', '@scope/mcp'], env: { TOKEN: secret } },
      },
    },
  });

  assert.equal(adapter.runTurn('run_secret_resume', { text: 'first' }).accepted, true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(JSON.stringify(spawnCalls[0]).includes(secret), false);
  assert.ok(cflags(spawnCalls[0]).includes('mcp_servers.secret.env.NODE_OPTIONS=""'));
  assert.equal(putCalls.length, 2, 'system prompt + one MCP wrapper');
  assert.equal(runtimeResolveCalls, 1, 'runtime is resolved once before wrapper placement');
  assert.equal(putCalls[1].name, WRAPPER_FILENAME);
  assert.equal(putCalls[1].mode, 0o600);
  assert.ok(putCalls[1].content.includes(secret));

  children[0].stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread-secret' })}\n`);
  await waitImmediate();
  children[0].emit('exit', 0);

  assert.equal(adapter.runTurn('run_secret_resume', { text: 'second' }).accepted, true);
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[1].slice(0, 4), ['exec', 'resume', 'thread-secret', '--json']);
  assert.equal(JSON.stringify(spawnCalls[1]).includes(secret), false);
  assert.equal(putCalls.length, 2, 'resume reuses both placed files');
  assert.equal(runtimeResolveCalls, 1, 'resume reuses the resolved runtime and wrapper');

  await adapter.disposeSession('run_secret_resume');
  assert.deepEqual(rmrfCalls.sort(), putCalls.map(call => call.dir).sort());
});

test('issue #113: CodexAdapter spawn failure removes prompt and MCP wrapper dirs', async () => {
  const secret = 'spawn-failure-secret';
  const putCalls = [];
  const rmrfCalls = [];
  const statuses = [];
  const executor = {
    putSecretFile(name, content, mode) {
      const dir = `/pod/.palantir-secret-failure-${putCalls.length + 1}`;
      putCalls.push({ name, content, mode, dir });
      return `${dir}/${name}`;
    },
    resolveNodeRuntime() { return '/usr/bin/node'; },
    spawnInteractive() { throw new Error('intentional spawn failure'); },
    rmrf(dir) { rmrfCalls.push(dir); },
  };
  const adapter = createCodexAdapter({
    codexBin: 'codex-test',
    runService: {
      addRunEvent() {},
      updateRunStatus(_runId, status) { statuses.push(status); },
      updateManagerThreadId() {},
      updateRunResult() {},
    },
  });
  adapter.startSession('run_secret_failure', {
    systemPrompt: 'system', cwd: process.cwd(), executor,
    mcpConfig: {
      mcpServers: { secret: { command: 'x', env: { TOKEN: secret } } },
    },
  });

  assert.equal(adapter.runTurn('run_secret_failure', { text: 'go' }).accepted, true);
  await waitImmediate();
  await waitImmediate();
  assert.equal(putCalls.length, 2);
  assert.deepEqual(rmrfCalls.sort(), putCalls.map(call => call.dir).sort());
  assert.ok(statuses.includes('failed'));
  assert.equal(adapter.isSessionAlive('run_secret_failure'), false);
});

test('issue #113: CodexAdapter preserves failed cleanup dirs and retries only those on dispose', async () => {
  const putCalls = [];
  const attempts = new Map();
  let allowCleanup = false;
  const executor = {
    putSecretFile(name, content, mode) {
      const dir = `/pod/.palantir-secret-retry-${putCalls.length + 1}`;
      putCalls.push({ name, content, mode, dir });
      return `${dir}/${name}`;
    },
    resolveNodeRuntime() { return '/usr/bin/node'; },
    spawnInteractive() { return createFakeChild(); },
    async rmrf(dir) {
      attempts.set(dir, (attempts.get(dir) || 0) + 1);
      if (!allowCleanup) throw new Error('temporary node outage');
    },
  };
  const adapter = createCodexAdapter({ codexBin: 'codex-test', runService: null });
  adapter.startSession('run_cleanup_retry', {
    systemPrompt: 'system', cwd: process.cwd(), executor,
    mcpConfig: {
      mcpServers: { secret: { command: 'x', env: { TOKEN: 'cleanup-secret' } } },
    },
  });
  assert.equal(adapter.runTurn('run_cleanup_retry', { text: 'go' }).accepted, true);
  assert.equal(putCalls.length, 2);

  assert.equal(await adapter.disposeSession('run_cleanup_retry'), false);
  for (const { dir } of putCalls) {
    assert.equal(attempts.get(dir), SECRET_CLEANUP_ATTEMPTS);
  }
  assert.equal(adapter.isSessionAlive('run_cleanup_retry'), false);

  allowCleanup = true;
  assert.equal(await adapter.disposeSession('run_cleanup_retry'), true);
  for (const { dir } of putCalls) {
    assert.equal(attempts.get(dir), SECRET_CLEANUP_ATTEMPTS + 1);
  }
  await adapter.disposeSession('run_cleanup_retry');
  for (const { dir } of putCalls) {
    assert.equal(attempts.get(dir), SECRET_CLEANUP_ATTEMPTS + 1, 'successful dirs are forgotten');
  }
});

test('issue #113: dispose during pending remote spawn forgets state after the late child is killed', async () => {
  const putCalls = [];
  const rmrfCalls = [];
  let resolveSpawn;
  const lateChild = createFakeChild();
  const executor = {
    putSecretFile(name) {
      const dir = `/pod/.palantir-secret-pending-spawn-${putCalls.length + 1}`;
      putCalls.push(dir);
      return `${dir}/${name}`;
    },
    resolveNodeRuntime() { return '/usr/bin/node'; },
    spawnInteractive() {
      return new Promise(resolve => { resolveSpawn = resolve; });
    },
    async rmrf(dir) { rmrfCalls.push(dir); },
  };
  const adapter = createCodexAdapter({ codexBin: 'codex-test', runService: null });
  adapter.startSession('run_pending_spawn_dispose', {
    systemPrompt: 'system', cwd: process.cwd(), executor,
    mcpConfig: {
      mcpServers: { secret: { command: 'x', env: { TOKEN: 'pending-secret' } } },
    },
  });
  assert.equal(adapter.runTurn('run_pending_spawn_dispose', { text: 'go' }).accepted, true);
  assert.equal(putCalls.length, 2);
  assert.equal(await adapter.disposeSession('run_pending_spawn_dispose'), true);
  assert.deepEqual(rmrfCalls.sort(), [...putCalls].sort());

  resolveSpawn(lateChild);
  await waitImmediate();
  await waitImmediate();
  assert.equal(lateChild.killedWith, 'SIGTERM');
  assert.doesNotThrow(() => adapter.startSession('run_pending_spawn_dispose', {
    systemPrompt: 'replacement', cwd: process.cwd(),
  }));
  await adapter.disposeSession('run_pending_spawn_dispose');
});

test('issue #113: CodexAdapter env-only alias refuses synchronously before placement or spawn', () => {
  let placements = 0;
  let spawns = 0;
  const statuses = [];
  const adapter = createCodexAdapter({
    codexBin: 'codex-test',
    runService: {
      addRunEvent() {},
      updateRunStatus(_runId, status) { statuses.push(status); },
      updateManagerThreadId() {},
      updateRunResult() {},
    },
  });
  adapter.startSession('run_env_only', {
    systemPrompt: 'system', cwd: process.cwd(),
    executor: {
      putSecretFile() { placements += 1; return '/pod/secret/file'; },
      spawnInteractive() { spawns += 1; return createFakeChild(); },
      rmrf() {},
    },
    mcpConfig: { mcpServers: { partial: { env: { TOKEN: 'file-only' } } } },
  });

  assert.deepEqual(adapter.runTurn('run_env_only', { text: 'go' }), { accepted: false });
  assert.equal(placements, 0);
  assert.equal(spawns, 0);
  assert.ok(statuses.includes('failed'));
});

test('issue #113: CodexAdapter refuses env-bearing config synchronously when executor lacks secret placement', () => {
  let spawns = 0;
  const adapter = createCodexAdapter({ runService: null, codexBin: 'codex-test' });
  adapter.startSession('run_no_secret_placement', {
    systemPrompt: 'system', cwd: process.cwd(),
    executor: {
      spawnInteractive() { spawns += 1; return createFakeChild(); },
      rmrf() {},
    },
    mcpConfig: {
      mcpServers: { secret: { command: 'x', env: { TOKEN: 'file-only' } } },
    },
  });

  assert.deepEqual(adapter.runTurn('run_no_secret_placement', { text: 'go' }), { accepted: false });
  assert.equal(spawns, 0);
  assert.equal(adapter.isSessionAlive('run_no_secret_placement'), false);
});

test('issue #113: CodexAdapter refuses before placement when executor cannot resolve Node runtime', () => {
  let placements = 0;
  let spawns = 0;
  const adapter = createCodexAdapter({ runService: null, codexBin: 'codex-test' });
  adapter.startSession('run_no_runtime_resolution', {
    systemPrompt: 'system', cwd: process.cwd(),
    executor: {
      putSecretFile() { placements += 1; return '/pod/secret/wrapper'; },
      spawnInteractive() { spawns += 1; return createFakeChild(); },
      rmrf() {},
    },
    mcpConfig: {
      mcpServers: { secret: { command: 'x', env: { TOKEN: 'file-only' } } },
    },
  });

  assert.deepEqual(adapter.runTurn('run_no_runtime_resolution', { text: 'go' }), { accepted: false });
  assert.equal(placements, 0);
  assert.equal(spawns, 0);
  assert.equal(adapter.isSessionAlive('run_no_runtime_resolution'), false);
});

test('issue #113: default local placement write failure removes both fresh temp dirs', async () => {
  const originalWriteFileSync = fs.writeFileSync;
  const attemptedPaths = [];
  let spawns = 0;
  fs.writeFileSync = function failWrapperWrite(filePath, ...args) {
    attemptedPaths.push(String(filePath));
    if (path.basename(String(filePath)) === WRAPPER_FILENAME) {
      throw new Error('intentional wrapper write failure');
    }
    return originalWriteFileSync.call(this, filePath, ...args);
  };

  try {
    const adapter = createCodexAdapter({
      runService: {
        addRunEvent() {}, updateRunStatus() {}, updateManagerThreadId() {}, updateRunResult() {},
      },
      spawnFn() { spawns += 1; return createFakeChild(); },
    });
    adapter.startSession('run_local_write_failure', {
      systemPrompt: 'system', cwd: process.cwd(),
      mcpConfig: {
        mcpServers: { secret: { command: 'x', env: { TOKEN: 'write-failure-secret' } } },
      },
    });
    assert.equal(adapter.runTurn('run_local_write_failure', { text: 'go' }).accepted, true);
    for (let i = 0; i < 20 && attemptedPaths.some(p => fs.existsSync(path.dirname(p))); i++) {
      await waitImmediate();
    }
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(spawns, 0);
  assert.equal(attemptedPaths.length, 2, 'prompt write then wrapper write');
  for (const filePath of attemptedPaths) {
    assert.equal(fs.existsSync(path.dirname(filePath)), false, `${path.dirname(filePath)} was removed`);
  }
});
