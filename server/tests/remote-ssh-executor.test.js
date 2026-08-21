const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRemoteSshNodeExecutor, shq } = require('../services/remoteSshExecutor');
const { createNodeService } = require('../services/nodeService');
const { EXEC_ENV_KEYS, PROJECT_TEST_ENV_KEYS } = require('../services/execEnvPolicy');

function assertSharedExecEnvScript(script) {
  assert.ok(script.startsWith('set --; for k in '), script);
  assert.ok(script.includes('exec env -i "$@"'), script);
  for (const key of EXEC_ENV_KEYS) {
    assert.ok(script.includes(shq(key)), `remote exec lost shared policy key ${key}`);
  }
}

function assertProjectTestEnvScript(script) {
  assert.ok(script.startsWith('set --; for k in '), script);
  assert.ok(script.includes('exec env -i "$@"'), script);
  for (const key of PROJECT_TEST_ENV_KEYS) {
    assert.ok(script.includes(shq(key)), `remote project test lost policy key ${key}`);
  }
  for (const secretKey of [
    'PALANTIR_TOKEN',
    'ANTHROPIC_API_KEY',
    'GIT_ASKPASS',
    'HTTPS_PROXY',
  ]) {
    assert.equal(script.includes(secretKey), false, `remote project test exposed ${secretKey}`);
  }
}

function nodeRow(fields = {}) {
  return {
    id: 'pod-a',
    kind: 'ssh',
    ssh_host: 'pod.example',
    ssh_user: 'runner',
    ssh_port: null,
    exposed_roots: JSON.stringify(['/srv/root']),
    updated_at: '2026-07-03 00:00:00',
    ...fields,
  };
}

function complete(child, { code = 0, stdout = '', stderr = '' } = {}) {
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code, null);
  });
}

function makeSpawn(handler) {
  const calls = [];
  function spawn(cmd, args, opts) {
    const child = new EventEmitter();
    const call = { cmd, args, opts, child, stdin: '', killed: false };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        call.stdin += chunk.toString();
        cb();
      },
    });
    child.kill = (signal = 'SIGTERM') => {
      call.killed = signal;
      return true;
    };
    calls.push(call);
    handler(call, child);
    return child;
  }
  spawn.calls = calls;
  return spawn;
}

function unshq(value) {
  assert.equal(value[0], "'");
  assert.equal(value[value.length - 1], "'");
  return value.slice(1, -1).replace(/'\\''/g, "'");
}

function sshDestinationIndex(args) {
  let afterDashDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (afterDashDash) {
      if (arg.includes('@')) return i;
      throw new Error(`ssh destination after -- does not contain @: ${arg}`);
    }
    if (arg === '--') {
      afterDashDash = true;
      continue;
    }
    if (arg === '-o' || arg === '-p') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (arg.includes('@')) return i;
  }
  throw new Error(`ssh destination not found in args: ${JSON.stringify(args)}`);
}

function assertSshOptionPairsInOrder(args, optionValues) {
  let start = 0;
  for (const optionValue of optionValues) {
    let found = -1;
    for (let i = start; i < args.length - 1; i += 1) {
      if (args[i] === '-o' && args[i + 1] === optionValue) {
        found = i;
        break;
      }
    }
    assert.notEqual(found, -1, `missing ordered ssh option pair: -o ${optionValue}`);
    start = found + 2;
  }
}

function remoteCommandArgsOf(call) {
  return call.args.slice(sshDestinationIndex(call.args) + 1);
}

function remoteCommandOf(call) {
  const remoteArgs = remoteCommandArgsOf(call);
  assert.equal(remoteArgs.length, 1);
  return remoteArgs[0];
}

function rawScriptOf(call) {
  const command = remoteCommandOf(call);
  const prefix = 'sh -c ';
  assert.ok(command.startsWith(prefix), `unexpected ssh remote command: ${command}`);
  return unshq(command.slice(prefix.length));
}

function scriptOf(call) {
  const script = rawScriptOf(call);
  const commandPrefix = `exec env LC_ALL=${shq('C')} `;
  const scriptPrefix = `export LC_ALL=${shq('C')}; `;
  if (
    script.startsWith(commandPrefix)
    && /^'(?:realpath|test|find)'(?: |$)/.test(script.slice(commandPrefix.length))
  ) {
    return `exec ${script.slice(commandPrefix.length)}`;
  }
  if (script.startsWith(scriptPrefix)) return script.slice(scriptPrefix.length);
  return script;
}

function loopbackSshSpawn({ env } = {}) {
  const calls = [];
  function spawn(cmd, args, opts) {
    assert.equal(cmd, 'ssh');
    const destinationIndex = sshDestinationIndex(args);
    const remoteCommandArgs = args.slice(destinationIndex + 1);
    const joined = remoteCommandArgs.join(' ');
    calls.push({
      cmd,
      args,
      opts,
      destination: args[destinationIndex],
      remoteCommandArgs,
      joined,
    });
    const actual = childProcess.spawn('sh', ['-c', joined], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : undefined,
    });
    const child = new EventEmitter();
    child.stdin = actual.stdin;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => actual.kill(signal);
    child.pid = actual.pid;

    let closeArgs = null;
    let stdoutFinished = false;
    let stderrFinished = false;
    const emitCloseWhenDrained = () => {
      if (!closeArgs || !stdoutFinished || !stderrFinished) return;
      child.emit('close', ...closeArgs);
    };
    child.stdout.once('finish', () => {
      stdoutFinished = true;
      emitCloseWhenDrained();
    });
    child.stderr.once('finish', () => {
      stderrFinished = true;
      emitCloseWhenDrained();
    });
    actual.stdout.pipe(child.stdout);
    actual.stderr.pipe(child.stderr);
    actual.once('error', err => child.emit('error', err));
    actual.once('close', (code, signal) => {
      closeArgs = [code, signal];
      emitCloseWhenDrained();
    });
    return child;
  }
  spawn.calls = calls;
  return spawn;
}

function simpleSpawn(response = { code: 0, stdout: '', stderr: '' }) {
  return makeSpawn((_call, child) => complete(child, response));
}

function rootGuardSpawn(routes = {}) {
  let uploadSequence = 0;
  const uploadedPaths = new Set();
  return makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (script.startsWith("exec 'realpath' ")) {
      const candidate = script.slice("exec 'realpath' ".length);
      const matchedPath = [...uploadedPaths].find((remotePath) => shq(remotePath) === candidate);
      if (matchedPath) return complete(child, { stdout: `${matchedPath}\n` });
    }
    if (script.includes("tmpdir=$(mktemp -d '/srv/root/.palantir-secret-XXXXXX')")) {
      uploadSequence += 1;
      const controllerEnvPath = `/real/root/.palantir-secret-test-${uploadSequence}/controller-env`;
      uploadedPaths.add(controllerEnvPath);
      call.uploadPath = controllerEnvPath;
      child.stdin.once('finish', () => complete(child, { stdout: `${controllerEnvPath}\n` }));
      return undefined;
    }
    if (routes[script]) return complete(child, routes[script]);
    complete(child, { code: 0 });
  });
}

function workerSpawnHarness(runId) {
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const sessionName = `palantir-run-${runId}`;
  return makeSpawn((call, child) => {
    const script = scriptOf(call);
    const routes = {
      "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
      "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
      "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
      [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
      "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
      [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    };
    const tmuxPrefix = `cd '/real/root/project' && tmux new-session -d -s ${shq(sessionName)} `;
    if (script.startsWith(tmuxPrefix)) return complete(child, { code: 0 });
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
}

function tmuxInnerScript(script, runId) {
  const marker = `tmux new-session -d -s ${shq(`palantir-run-${runId}`)} `;
  const start = script.indexOf(marker);
  assert.notEqual(start, -1, `tmux handoff missing for ${runId}`);
  const suffix = ' && trap - 0 HUP INT TERM';
  const raw = script.slice(
    start + marker.length,
    script.endsWith(suffix) ? -suffix.length : undefined,
  );
  return unshq(raw);
}

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-remote-ssh-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

async function mkLoopbackRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-loopback-ssh-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('shq preserves shell metacharacters as single quoted literals', () => {
  const cases = [
    'space value',
    "quote'value",
    'semi;colon',
    'sub$(date)',
    'back`tick`',
    'line\nbreak',
  ];
  for (const value of cases) {
    assert.equal(shq(value), `'${value.replace(/'/g, "'\\''")}'`);
  }
});

test('ssh argv and script quote injection attempts literally', async () => {
  const spawn = simpleSpawn({ code: 0, stdout: 'ok\n' });
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    connectTimeoutMs: 12000,
    commandAllowlist: ["say'hi"],
  });
  const args = [
    'has space',
    "x'; touch /tmp/pwn; '",
    '$(touch /tmp/pwn)',
    '`touch /tmp/pwn`',
    'line\n$(still-literal)',
  ];
  const res = await exec.exec("say'hi", args, {
    env: { LC_ALL: 'C', LANG: "en'US", SAFE: '$(literal)' },
  });
  assert.equal(res.code, 0);
  const call = spawn.calls[0];
  assert.equal(call.cmd, 'ssh');
  assert.deepEqual(call.args.slice(0, 6), [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=12',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]);
  assert.equal(call.args[6], '--');
  assert.equal(call.args[7], 'runner@pod.example');
  assert.equal(call.args.filter((arg) => arg === '-p').length, 0);
  assert.equal(call.args.some((arg) => String(arg).startsWith('ServerAlive')), false);
  const script = scriptOf(call);
  assert.deepEqual(call.args.slice(8), [`sh -c ${shq(script)}`]);
  assertSharedExecEnvScript(script);
  assert.match(script, /LC_ALL='C'/);
  assert.match(script, /LANG='en'\\''US'/);
  assert.match(script, /SAFE='\$\(literal\)'/);
  assert.match(script, /'say'\\''hi'/);
  for (const arg of args) assert.ok(script.includes(shq(arg)), `missing quoted arg ${arg}`);
});

test('custom ssh port is emitted exactly once before -- for exec and keepAlive paths', async () => {
  const spawn = simpleSpawn({ code: 0 });
  const exec = createRemoteSshNodeExecutor(nodeRow({ ssh_port: 2222 }), {
    spawnFn: spawn,
  });

  await exec.exec('git', ['--version']);
  await exec.spawnInteractive('codex', ['exec']);

  assert.equal(spawn.calls.length, 2);
  for (const call of spawn.calls) {
    const portIndexes = call.args
      .map((arg, index) => arg === '-p' ? index : -1)
      .filter((index) => index !== -1);
    assert.deepEqual(portIndexes, [call.args.indexOf('-p')]);
    assert.equal(portIndexes.length, 1);
    assert.equal(call.args[portIndexes[0] + 1], '2222');
    assert.ok(portIndexes[0] < call.args.indexOf('--'));
  }
  assertSshOptionPairsInOrder(spawn.calls[1].args, [
    'ServerAliveInterval=15',
    'ServerAliveCountMax=4',
  ]);
});

test('remote ssh executor rejects invalid raw ssh_port values', () => {
  for (const sshPort of [0, 65536, -1, 22.5, '2222', '22 -o ProxyCommand=x', true, [2222]]) {
    assert.throws(
      () => createRemoteSshNodeExecutor(nodeRow({ ssh_port: sshPort })),
      /ssh_port/,
    );
  }
});

test('loopback ssh simulator preserves exec stdout across ssh argument join', async () => {
  const spawn = loopbackSshSpawn();
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    commandAllowlist: ['echo'],
  });

  const res = await exec.exec('echo', ['fleet-ok']);

  assert.deepEqual(res, { code: 0, stdout: 'fleet-ok\n', stderr: '' });
  assert.equal(spawn.calls[0].destination, 'runner@pod.example');
  const script = rawScriptOf(spawn.calls[0]);
  assertSharedExecEnvScript(script);
  assert.ok(script.endsWith("exec env -i \"$@\" 'echo' 'fleet-ok'"));
  assert.deepEqual(spawn.calls[0].remoteCommandArgs, [`sh -c ${shq(script)}`]);
  assert.equal(spawn.calls[0].joined, `sh -c ${shq(script)}`);
});

test('loopback remote exec leaks zero ambient pod secret keys', async () => {
  const secretKeys = [
    'PALANTIR_TOKEN',
    'ANTHROPIC_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
  ];
  const spawn = loopbackSshSpawn({
    env: Object.fromEntries(secretKeys.map((key) => [key, 'must-not-pass'])),
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    commandAllowlist: [process.execPath],
  });

  const res = await exec.exec(process.execPath, [
    '-e',
    `process.stdout.write(JSON.stringify(${JSON.stringify(secretKeys)}.filter((key)=>Object.hasOwn(process.env,key))))`,
  ]);

  assert.equal(res.code, 0);
  assert.deepEqual(JSON.parse(res.stdout), []);
  assertSharedExecEnvScript(rawScriptOf(spawn.calls[0]));
});

test('exec ignores stdin EPIPE without input and resolves from process close', async () => {
  const spawn = makeSpawn((_call, child) => {
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        const err = new Error('remote stdin closed before empty input');
        err.code = 'EPIPE';
        callback(err);
      },
    });
    child.stdin.once('error', () => {
      complete(child, { stdout: 'fleet-ok\n' });
    });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    commandAllowlist: ['echo'],
  });

  const res = await exec.exec('echo', ['fleet-ok']);

  assert.deepEqual(res, { code: 0, stdout: 'fleet-ok\n', stderr: '' });
  assert.equal(spawn.calls[0].killed, false);
});

test('exec waits for close and captures stdout emitted after process exit', async () => {
  const spawn = makeSpawn((_call, child) => {
    process.nextTick(() => {
      child.emit('exit', 0, null);
      child.stdout.emit('data', 'fleet-');
      setImmediate(() => {
        child.stdout.emit('data', 'ok\n');
        child.emit('close', 0, null);
      });
    });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    commandAllowlist: ['echo'],
  });

  const res = await exec.exec('echo', ['fleet-ok']);

  assert.deepEqual(res, { code: 0, stdout: 'fleet-ok\n', stderr: '' });
});

test('loopback ssh simulator runs git through the remote login shell model', async () => {
  const spawn = loopbackSshSpawn();
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    commandAllowlist: ['git'],
  });

  const res = await exec.exec('git', ['--version']);

  assert.equal(res.code, 0);
  assert.match(res.stdout, /git version/);
});

test('loopback ssh simulator round-trips injection-hostile args literally', async () => {
  const hostile = "a'b;$(printf injected)`y\nz";
  const spawn = loopbackSshSpawn();
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    commandAllowlist: ['printf'],
  });

  const res = await exec.exec('printf', ['%s', hostile]);

  assert.deepEqual(res, { code: 0, stdout: hostile, stderr: '' });
});

test('loopback ssh simulator writeTempFile streams stdin and stays within roots', async (t) => {
  const root = await mkLoopbackRoot(t);
  const content = "first line\nquote ' ; $(printf injected) `tick`\nlast line\n";
  const spawn = loopbackSshSpawn();
  const exec = createRemoteSshNodeExecutor(nodeRow({
    exposed_roots: JSON.stringify([root]),
  }), { spawnFn: spawn });

  const remotePath = await exec.writeTempFile(path.join(root, 'tmp-'), 'payload.txt', content, 0o600);
  const readBack = await exec.readFile(remotePath);
  const canonicalRoot = await fs.realpath(root);
  const canonicalPath = await fs.realpath(remotePath);
  const relativePath = path.relative(canonicalRoot, canonicalPath);

  assert.equal(readBack, content);
  assert.equal(path.basename(remotePath), 'payload.txt');
  assert.ok(relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  assert.ok(spawn.calls.some((call) => /cat > "\$tmpdir"\/'payload\.txt'/.test(scriptOf(call))));
});

test('loopback writeTempFile cleans its fresh directory when cat or chmod fails', async (t) => {
  for (const failingCommand of ['cat', 'chmod']) {
    await t.test(failingCommand, async (st) => {
      const root = await mkLoopbackRoot(st);
      const fakeBin = await mkLoopbackRoot(st);
      const fakeCommand = path.join(fakeBin, failingCommand);
      await fs.writeFile(fakeCommand, '#!/bin/sh\nexit 41\n', { mode: 0o700 });
      await fs.chmod(fakeCommand, 0o700);
      const spawn = loopbackSshSpawn({
        env: { PATH: `${fakeBin}:${process.env.PATH}` },
      });
      const exec = createRemoteSshNodeExecutor(nodeRow({
        exposed_roots: JSON.stringify([root]),
      }), { spawnFn: spawn });
      const secret = `must-not-appear-${failingCommand}`;

      await assert.rejects(
        () => exec.writeTempFile(path.join(root, 'secret-'), 'payload', secret, 0o600),
        (err) => err?.code === 41,
      );

      assert.deepEqual(await fs.readdir(root), []);
      assert.doesNotMatch(JSON.stringify(spawn.calls.map((call) => call.args)), new RegExp(secret));
    });
  }
});

test('exec resolves genuine exits and rejects ssh transport exit 255', async () => {
  for (const code of [0, 1, 128]) {
    const spawn = simpleSpawn({ code, stdout: `out-${code}`, stderr: `err-${code}` });
    const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['cmd'] });
    const res = await exec.exec('cmd', []);
    assert.deepEqual(res, { code, stdout: `out-${code}`, stderr: `err-${code}` });
  }

  const spawn = simpleSpawn({ code: 255, stderr: 'permission denied' });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['cmd'] });
  await assert.rejects(
    () => exec.exec('cmd', []),
    (err) => err.code === 'SSH_TRANSPORT' && err.stderr === 'permission denied',
  );
});

test('exec timeout kills local ssh process and rejects with partial output', async () => {
  const spawn = makeSpawn((call, child) => {
    process.nextTick(() => child.stdout.emit('data', 'partial'));
    call.child = child;
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['sleep'] });
  await assert.rejects(
    () => exec.exec('sleep', ['10'], { timeoutMs: 5 }),
    (err) => err.killed === true && err.code === 'ETIMEDOUT' && err.stdout === 'partial',
  );
  assert.equal(spawn.calls[0].killed, 'SIGTERM');
});

test('exec maxBuffer overflow rejects with partial stdout', async () => {
  const spawn = simpleSpawn({ code: 0, stdout: 'abcdef' });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['printf'] });
  await assert.rejects(
    () => exec.exec('printf', ['abcdef'], { maxBuffer: 3 }),
    (err) => err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && err.stdout === 'abc',
  );
  assert.equal(spawn.calls[0].killed, 'SIGTERM');
});

test('env uses only explicit keys and never merges process.env', async () => {
  process.env.REMOTE_SSH_EXECUTOR_SECRET_SHOULD_NOT_APPEAR = 'secret';
  const spawn = simpleSpawn({ code: 0 });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['env'] });
  await exec.exec('env', [], { env: { LC_ALL: 'C' } });
  const script = scriptOf(spawn.calls[0]);
  assert.match(script, /LC_ALL='C'/);
  assert.doesNotMatch(script, /REMOTE_SSH_EXECUTOR_SECRET_SHOULD_NOT_APPEAR/);
});

test('exposed_roots guard allows canonical inside path', async () => {
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "cd '/real/root/project' && exec 'pwd'": { stdout: '/real/root/project\n' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['pwd'] });
  const res = await exec.exec('pwd', [], { cwd: '/srv/root/project' });
  assert.equal(res.code, 0);
  const script = scriptOf(spawn.calls.at(-1));
  assertSharedExecEnvScript(script);
  assert.ok(script.endsWith("cd '/real/root/project' && exec env -i \"$@\" 'pwd'"));
});

test('exposed_roots rejects outside, symlink escapes, and prefix traps', async () => {
  for (const [name, target, canonical] of [
    ['outside', '/etc', '/etc'],
    ['symlink', '/srv/root/link-out', '/var/escape'],
    ['prefix', '/srv/rootX', '/real/rootX'],
  ]) {
    const spawn = rootGuardSpawn({
      [`exec 'realpath' ${shq(target)}`]: { stdout: `${canonical}\n` },
    });
    const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['pwd'] });
    await assert.rejects(
      () => exec.exec('pwd', [], { cwd: target }),
      (err) => err.code === 'EXPOSED_ROOTS',
      name,
    );
  }
});

test('rmrf refuses exposed root itself', async () => {
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await assert.rejects(
    () => exec.rmrf('/srv/root'),
    (err) => err.code === 'EXPOSED_ROOTS' && /Refusing/.test(err.message),
  );
});

test('move guards source and destination within exposed_roots', async () => {
  let finalRealpathCalls = 0;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root/tmp'") return complete(child, { stdout: '/real/root/tmp\n' });
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (script === "exec 'realpath' '/srv/root/final'") {
      finalRealpathCalls += 1;
      if (finalRealpathCalls === 1) return complete(child, { code: 1, stderr: 'missing' });
      return complete(child, { stdout: '/real/root/final\n' });
    }
    if (script === "exec 'mv' '/real/root/tmp' '/real/root/final'") return complete(child, { code: 0 });
    complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await exec.move('/srv/root/tmp', '/srv/root/final');

  assert.ok(spawn.calls.some((call) => scriptOf(call) === "exec 'mv' '/real/root/tmp' '/real/root/final'"));

  const escapeSpawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/tmp'": { stdout: '/real/root/tmp\n' },
    "exec 'realpath' '/etc/final'": { code: 1, stderr: 'missing' },
    "exec 'realpath' '/etc'": { stdout: '/etc\n' },
  });
  const escapeExec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: escapeSpawn });
  await assert.rejects(
    () => escapeExec.move('/srv/root/tmp', '/etc/final'),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
  assert.equal(escapeSpawn.calls.some((call) => scriptOf(call).startsWith("exec 'mv'")), false);
});

test('creation targets guard their parent directory', async () => {
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'mkdir' '-p' '/srv/root/new-dir'": { code: 0 },
    "exec 'realpath' '/srv/root/new-dir'": { stdout: '/real/root/new-dir\n' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await exec.mkdir('/srv/root/new-dir', { recursive: true });
  assert.ok(spawn.calls.some((call) => scriptOf(call) === "exec 'mkdir' '-p' '/srv/root/new-dir'"));
});

test('fileExists resolves true false and rejects transport', async () => {
  const trueSpawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/file'": { stdout: '/real/root/file\n' },
    "exec 'test' '-e' '/real/root/file'": { code: 0 },
  });
  assert.equal(await createRemoteSshNodeExecutor(nodeRow(), { spawnFn: trueSpawn }).fileExists('/srv/root/file'), true);

  const falseSpawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/missing'": { code: 1, stderr: 'missing' },
    "exec 'test' '-e' '/srv/root/missing'": { code: 1 },
  });
  assert.equal(await createRemoteSshNodeExecutor(nodeRow(), { spawnFn: falseSpawn }).fileExists('/srv/root/missing'), false);

  const transportSpawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/file'": { code: 255, stderr: 'ssh down' },
  });
  await assert.rejects(
    () => createRemoteSshNodeExecutor(nodeRow(), { spawnFn: transportSpawn }).fileExists('/srv/root/file'),
    (err) => err.code === 'SSH_TRANSPORT',
  );
});

test('stat returns isDirectory/isFile shape', async () => {
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/dir'": { stdout: '/real/root/dir\n' },
    "exec 'test' '-d' '/real/root/dir'": { code: 0 },
    "exec 'test' '-f' '/real/root/dir'": { code: 1 },
  });
  const stat = await createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn }).stat('/srv/root/dir');
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isFile(), false);
});

test('internal filesystem helpers force C locale while public exec uses the shared env policy', async () => {
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/dir'": { stdout: '/real/root/dir\n' },
    "exec 'test' '-d' '/real/root/dir'": { code: 0 },
    "exec 'test' '-f' '/real/root/dir'": { code: 1 },
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.stat('/srv/root/dir');
  await executor.exec('git', ['status']);

  const filesystemCalls = spawn.calls.filter((call) => (
    /^exec '(?:realpath|test)' /.test(scriptOf(call))
  ));
  assert.ok(filesystemCalls.length >= 4);
  for (const call of filesystemCalls) {
    assert.match(rawScriptOf(call), /^exec env LC_ALL='C' '(?:realpath|test)' /);
  }
  assertSharedExecEnvScript(rawScriptOf(spawn.calls.at(-1)));
  assert.ok(rawScriptOf(spawn.calls.at(-1)).endsWith("exec env -i \"$@\" 'git' 'status'"));
});

test('writeTempFile rejects non-bare names and sends content via stdin', async () => {
  const bad = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: simpleSpawn() });
  await assert.rejects(() => bad.writeTempFile('/srv/root/tmp-', '../x', 'nope'), /bare filename/);

  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") {
      complete(child, { stdout: '/real/root\n' });
      return;
    }
    if (script === "exec 'realpath' '/srv/root/tmp-abc123/payload.txt'") {
      complete(child, { stdout: '/real/root/tmp-abc123/payload.txt\n' });
      return;
    }
    child.stdin.on('finish', () => {
      complete(child, { stdout: '/srv/root/tmp-abc123/payload.txt\n' });
    });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  const remotePath = await exec.writeTempFile('/srv/root/tmp-', 'payload.txt', 'secret-content', 0o600);
  assert.equal(remotePath, '/srv/root/tmp-abc123/payload.txt');
  const writeCall = spawn.calls.find((call) => /mktemp -d/.test(scriptOf(call)));
  assert.equal(writeCall.stdin, 'secret-content');
  assert.match(scriptOf(writeCall), /mktemp -d '\/srv\/root\/tmp-XXXXXX'/);
  assert.match(scriptOf(writeCall), /trap 'rc=\$\?; cleanup; exit "\$rc"' 0/);
  assert.match(scriptOf(writeCall), /trap 'exit 129' HUP/);
  assert.match(scriptOf(writeCall), /trap 'exit 130' INT/);
  assert.match(scriptOf(writeCall), /trap 'exit 143' TERM/);
  assert.ok(
    scriptOf(writeCall).indexOf(`printf '%s\\n' "$tmpdir"/'payload.txt'`)
      < scriptOf(writeCall).indexOf('trap - 0 HUP INT TERM'),
    'cleanup traps must stay armed until after the path is printed successfully',
  );
  assert.doesNotMatch(scriptOf(writeCall), /secret-content/);
});

test('writeTempFile handles stdin EPIPE without an unhandled stream error', async () => {
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") {
      complete(child, { stdout: '/real/root\n' });
      return;
    }
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        const err = new Error('remote stdin closed early');
        err.code = 'EPIPE';
        callback(err);
      },
    });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => exec.writeTempFile('/srv/root/tmp-', 'payload.txt', 'x'.repeat(64 * 1024), 0o600),
    (err) => err.code === 'EPIPE' && err.stdout === '' && err.stderr === '',
  );

  const writeCall = spawn.calls.find((call) => /mktemp -d/.test(scriptOf(call)));
  assert.equal(writeCall.killed, 'SIGTERM');
});

test('putSecretFile builds temp secret flow and streams content via stdin', async () => {
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") {
      complete(child, { stdout: '/real/root\n' });
      return;
    }
    if (script === "exec 'realpath' '/srv/root/.palantir-secret-abc123/model_instructions_file'") {
      complete(child, { stdout: '/real/root/.palantir-secret-abc123/model_instructions_file\n' });
      return;
    }
    child.stdin.on('finish', () => {
      complete(child, { stdout: '/srv/root/.palantir-secret-abc123/model_instructions_file\n' });
    });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  const remotePath = await exec.putSecretFile('model_instructions_file', 'secret-content', 0o600);

  assert.equal(remotePath, '/srv/root/.palantir-secret-abc123/model_instructions_file');
  const writeCall = spawn.calls.find((call) => /mktemp -d/.test(scriptOf(call)));
  assert.equal(writeCall.stdin, 'secret-content');
  assert.match(scriptOf(writeCall), /mktemp -d '\/srv\/root\/\.palantir-secret-XXXXXX'/);
  assert.match(scriptOf(writeCall), /cat > "\$tmpdir"\/'model_instructions_file'/);
  assert.match(scriptOf(writeCall), /chmod '600' "\$tmpdir"\/'model_instructions_file'/);
  assert.doesNotMatch(scriptOf(writeCall), /secret-content/);
});

test('putSecretFile rejects non-bare names and revalidates created path', async () => {
  const bad = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: simpleSpawn() });
  await assert.rejects(() => bad.putSecretFile('../evil', 'nope'), /bare filename/);
  await assert.rejects(() => bad.putSecretFile('a/b', 'nope'), /bare filename/);

  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (script === "exec 'realpath' '/srv/root/.palantir-secret-abc/model_instructions_file'") {
      return complete(child, { stdout: '/escape/model_instructions_file\n' });
    }
    if (script === "exec 'rm' '-rf' '/srv/root/.palantir-secret-abc'") return complete(child, { code: 0 });
    child.stdin.on('finish', () => complete(child, { stdout: '/srv/root/.palantir-secret-abc/model_instructions_file\n' }));
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => exec.putSecretFile('model_instructions_file', 'secret'),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
  assert.ok(spawn.calls.some((call) => scriptOf(call) === "exec 'rm' '-rf' '/srv/root/.palantir-secret-abc'"));
});

test('resolveNodeRuntime uses node_prefix, probes a canonical executable, and returns its absolute path', async () => {
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    assert.match(script, /PATH='\/opt\/codex\/bin':\$PATH command -v node/);
    assert.match(script, /candidate=\$\(realpath "\$candidate"\)/);
    assert.match(script, /\[ -x "\$candidate" \]/);
    assert.match(script, /require\("node:child_process"\)/);
    assert.match(script, /NODE_OPTIONS=''/);
    assert.doesNotMatch(script, /runtime-secret-sentinel/);
    complete(child, { stdout: '/usr/local/bin/node\n' });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow({ node_prefix: '/opt/codex/bin' }), {
    spawnFn: spawn,
  });
  assert.equal(await exec.resolveNodeRuntime(), '/usr/local/bin/node');
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].stdin, '');
});

test('resolveNodeRuntime fails closed on missing/unsafe runtimes and preserves SSH transport errors', async () => {
  const missingSpawn = makeSpawn((_call, child) => complete(child, { code: 127 }));
  const missing = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: missingSpawn });
  await assert.rejects(
    () => missing.resolveNodeRuntime(),
    (err) => err.code === 'MCP_WRAPPER_RUNTIME_UNAVAILABLE',
  );

  const unsafeSpawn = makeSpawn((_call, child) => complete(child, { stdout: 'relative/node\n' }));
  const unsafe = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: unsafeSpawn });
  await assert.rejects(() => unsafe.resolveNodeRuntime(), /unsafe path/);

  const transportSpawn = makeSpawn((_call, child) => complete(child, { code: 255 }));
  const transport = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: transportSpawn });
  await assert.rejects(
    () => transport.resolveNodeRuntime(),
    (err) => err.code === 'SSH_TRANSPORT',
  );

  await assert.rejects(
    () => missing.resolveNodeRuntime({ pathPrefix: 'relative/bin' }),
    /absolute POSIX path/,
  );
});

test('spawnInteractive builds piped ssh child with canonical cwd explicit env and quoted argv', async () => {
  process.env.REMOTE_SSH_EXECUTOR_INTERACTIVE_SECRET_SHOULD_NOT_APPEAR = 'secret';
  const hostileArg = '; rm -rf /';
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['git'] });
  const child = await exec.spawnInteractive('codex', ['exec', hostileArg], {
    cwd: '/srv/root/project',
    env: { LC_ALL: 'C', TOKEN: "a'b", SKIP: undefined },
  });
  const call = spawn.calls.at(-1);
  const script = scriptOf(call);

  assert.equal(call.cmd, 'ssh');
  assert.strictEqual(child, call.child);
  assert.deepEqual(call.opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(call.args.includes('-n'), false);
  assertSshOptionPairsInOrder(call.args, [
    'ServerAliveInterval=15',
    'ServerAliveCountMax=4',
  ]);
  assert.ok(script.startsWith('set --; for k in '), script);
  assert.ok(
    script.includes(
      `cd ${shq('/real/root/project')} && exec env -i "$@" PATH="$PATH" `
      + `PALANTIR_TOKEN=${shq('')} PALANTIR_PM_TOKEN=${shq('')} `
      + `PALANTIR_WORKER_TOKEN=${shq('')} PALANTIR_MANAGER_TOKEN=${shq('')} `
      + '/bin/sh -c ',
    ),
  );
  assert.equal((script.match(/PATH="\$PATH"/g) || []).length, 1);
  assert.ok(script.endsWith(`${shq('sh')} ${shq('codex')} ${shq('exec')} ${shq(hostileArg)}`));
  assert.ok(script.includes('LC_ALL=$(cat --'));
  assert.ok(script.includes('export LC_ALL'));
  assert.ok(script.includes('TOKEN=$(cat --'));
  assert.ok(script.includes('export TOKEN'));
  const uploads = spawn.calls.filter((entry) => entry.uploadPath);
  assert.equal(uploads.length, 2);
  const uploadByValue = new Map(uploads.map((entry) => [entry.stdin, entry.uploadPath]));
  assert.deepEqual([...uploadByValue.keys()].sort(), ['C', "a'b"].sort());
  assert.equal(uploads.filter((entry) => entry.stdin === 'C').length, 1);
  assert.equal(uploads.filter((entry) => entry.stdin === "a'b").length, 1);
  for (const [key, value] of [['LC_ALL', 'C'], ['TOKEN', "a'b"]]) {
    const readStart = script.indexOf(`${key}=$(cat --`);
    const read = script.slice(readStart, script.indexOf(';', readStart));
    assert.ok(readStart >= 0, `${key} must be read from a materialized file`);
    assert.ok(read.includes(uploadByValue.get(value)), `${key} must read the file containing its own value`);
  }
  assert.equal(JSON.stringify(call.args).includes("'C'"), false);
  assert.equal(JSON.stringify(call.args).includes("a'b"), false);
  assert.doesNotMatch(script, /SKIP=/);
  assert.ok(script.includes(shq(hostileArg)));
  assert.doesNotMatch(script, /REMOTE_SSH_EXECUTOR_INTERACTIVE_SECRET_SHOULD_NOT_APPEAR/);
  assert.equal(child.stdin.writable, true);
  assert.equal(typeof child.stdout.on, 'function');
  assert.equal(typeof child.stderr.on, 'function');
});

test('spawnInteractive cleans earlier materialized files when a later upload fails', async () => {
  const firstPath = '/real/root/.palantir-secret-test-1/controller-env';
  let uploadCount = 0;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") {
      return complete(child, { stdout: '/real/root\n' });
    }
    if (script === `exec 'realpath' ${shq(firstPath)}`) {
      return complete(child, { stdout: `${firstPath}\n` });
    }
    if (script.includes("tmpdir=$(mktemp -d '/srv/root/.palantir-secret-XXXXXX')")) {
      uploadCount += 1;
      child.stdin.once('finish', () => complete(child, uploadCount === 1
        ? { stdout: `${firstPath}\n` }
        : { code: 1, stderr: 'injected upload failure' }));
      return undefined;
    }
    if (script === `exec 'rm' '-f' ${shq(firstPath)}`) return complete(child);
    return complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => exec.spawnInteractive('codex', ['exec'], {
      env: { KEY_A: 'first-secret', KEY_B: 'second-secret' },
    }),
    /injected upload failure/,
  );
  assert.equal(uploadCount, 2);
  assert.ok(
    spawn.calls.some((call) => scriptOf(call) === `exec 'rm' '-f' ${shq(firstPath)}`),
    'the successfully uploaded credential must be removed after the later upload fails',
  );
});

test('spawnInteractive bootstraps a manager capability through stdin, never SSH argv', async () => {
  const managerToken = 'mgr_run_capability_secret';
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const child = await exec.spawnInteractive('codex', ['exec', '-'], {
    cwd: '/srv/root/project',
    env: {
      PALANTIR_MANAGER_TOKEN: managerToken,
      PALANTIR_TOKEN: 'must-be-scrubbed',
      LC_ALL: 'C',
    },
  });
  child.stdin.write('manager prompt');

  const call = spawn.calls.at(-1);
  const script = scriptOf(call);
  // #431: the read moved INSIDE the clean shell. Reading it in the outer
  // bootstrap would force re-injecting the value as an `env -i` argument, and
  // the real /usr/bin/env argv is world-readable through /proc/<pid>/cmdline.
  // The stdin transport itself is unchanged.
  assert.doesNotMatch(script, /^IFS= read -r PALANTIR_MANAGER_TOKEN/);
  assert.match(
    script,
    /\/bin\/sh -c 'IFS= read -r PALANTIR_MANAGER_TOKEN \|\| exit 126; export PALANTIR_MANAGER_TOKEN; .*exec "\$@"'/,
  );
  assert.doesNotMatch(script, /PALANTIR_MANAGER_TOKEN="\$PALANTIR_MANAGER_TOKEN"/);
  assert.match(script, /PALANTIR_TOKEN=''/);
  assert.doesNotMatch(script, /PALANTIR_MANAGER_TOKEN=''/);
  assert.doesNotMatch(script, /must-be-scrubbed/);
  assert.ok(script.includes('LC_ALL=$(cat --'));
  assert.ok(script.includes('export LC_ALL'));
  assert.equal(JSON.stringify(call.args).includes("'C'"), false);
  assert.equal(call.stdin, `${managerToken}\nmanager prompt`);
  for (const entry of spawn.calls) {
    assert.doesNotMatch(JSON.stringify(entry.args), new RegExp(managerToken));
  }
});

test('spawnInteractive bootstraps a worker capability through stdin with worker env policy', async () => {
  const workerToken = 'worker_run_capability_secret';
  const apiBase = 'https://argv-zero.example:8443/proxy-prefix';
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const child = await exec.spawnInteractive('claude', ['--print'], {
    cwd: '/srv/root/project',
    worker: true,
    envAllowlist: ['POD_ONLY_WORKER_KEY'],
    env: {
      PALANTIR_WORKER_TOKEN: workerToken,
      PALANTIR_MANAGER_TOKEN: 'must-be-scrubbed',
      PALANTIR_API_BASE: apiBase,
    },
  });
  child.stdin.write('worker follow-up');

  const call = spawn.calls.at(-1);
  const script = scriptOf(call);
  assert.match(
    script,
    /\/bin\/sh -c 'IFS= read -r PALANTIR_WORKER_TOKEN \|\| exit 126; export PALANTIR_WORKER_TOKEN; IFS= read -r PALANTIR_API_BASE \|\| exit 126; export PALANTIR_API_BASE; exec "\$@"'/,
  );
  assert.doesNotMatch(script, /PALANTIR_WORKER_TOKEN="\$PALANTIR_WORKER_TOKEN"/);
  assert.match(script, /PALANTIR_MANAGER_TOKEN=''/);
  assert.doesNotMatch(script, /must-be-scrubbed/);
  assert.doesNotMatch(script, new RegExp(apiBase));
  assert.match(script, /POD_ONLY_WORKER_KEY/);
  assert.equal(call.stdin, `${workerToken}\n${apiBase}\nworker follow-up`);
  for (const entry of spawn.calls) {
    assert.doesNotMatch(JSON.stringify(entry.args), new RegExp(workerToken));
    assert.doesNotMatch(JSON.stringify(entry.args), new RegExp(apiBase));
  }
});

test('remote --bare Claude materializes pod login auth inside the clean child only', async (t) => {
  const root = await mkLoopbackRoot(t);
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude');
  const bin = path.join(root, 'bin');
  const fakeClaude = path.join(bin, 'claude');
  const podToken = 'pod-login-access-token';
  const managerToken = 'run-bound-manager-capability';
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: podToken,
        expiresAt: Date.now() + 60_000,
      },
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    fakeClaude,
    [
      '#!/bin/sh',
      '[ "$1" = "--bare" ] || exit 91',
      '[ "$ANTHROPIC_API_KEY" = "pod-login-access-token" ] || exit 92',
      '[ "$PALANTIR_MANAGER_TOKEN" = "run-bound-manager-capability" ] || exit 93',
      'printf AUTH_OK',
    ].join('\n'),
    { mode: 0o700 },
  );

  const spawn = loopbackSshSpawn({ env: { HOME: home } });
  const executor = createRemoteSshNodeExecutor(nodeRow({
    exposed_roots: JSON.stringify([root]),
  }), { spawnFn: spawn });
  const child = await executor.spawnInteractive('claude', ['--bare'], {
    cwd: root,
    pathPrefix: bin,
    claudeBareAuth: true,
    env: { PALANTIR_MANAGER_TOKEN: managerToken },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const [code] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (...args) => resolve(args));
  });

  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'AUTH_OK');
  for (const secret of [podToken, managerToken]) {
    for (const call of spawn.calls) {
      assert.doesNotMatch(
        JSON.stringify(call.args),
        new RegExp(secret),
        'pod and run-bound tokens must stay out of local SSH argv',
      );
    }
  }
});

test('remote --bare Claude defers to settings apiKeyHelper when pod login auth is absent', async (t) => {
  const root = await mkLoopbackRoot(t);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const fakeClaude = path.join(bin, 'claude');
  const settings = path.join(home, 'settings.json');
  const helper = path.join(home, 'auth-helper.sh');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    helper,
    '#!/bin/sh\nprintf settings-helper-token\n',
    { mode: 0o700 },
  );
  await fs.writeFile(
    settings,
    JSON.stringify({ apiKeyHelper: helper }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    fakeClaude,
    [
      '#!/bin/sh',
      '[ "$1" = "--bare" ] || exit 91',
      '[ "$2" = "--settings" ] || exit 92',
      '[ "$3" = "$HOME/settings.json" ] || exit 93',
      '[ -z "${ANTHROPIC_API_KEY:-}" ] || exit 94',
      '[ "$(cat "$HOME/settings.json")" = "{\\"apiKeyHelper\\":\\"$HOME/auth-helper.sh\\"}" ] || exit 95',
      '[ "$("$HOME/auth-helper.sh")" = "settings-helper-token" ] || exit 96',
      'printf SETTINGS_AUTH_OK',
    ].join('\n'),
    { mode: 0o700 },
  );

  const spawn = loopbackSshSpawn({ env: { HOME: home } });
  const executor = createRemoteSshNodeExecutor(nodeRow({
    exposed_roots: JSON.stringify([root]),
  }), { spawnFn: spawn });
  const child = await executor.spawnInteractive(
    'claude',
    ['--bare', '--settings', settings],
    {
      cwd: root,
      pathPrefix: bin,
      claudeBareAuth: true,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const [code] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (...args) => resolve(args));
  });

  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'SETTINGS_AUTH_OK');
});

test('remote --bare Claude preserves allowlisted Bedrock auth through the clean child', async (t) => {
  const root = await mkLoopbackRoot(t);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const fakeClaude = path.join(bin, 'claude');
  const providerEnv = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'remote-bedrock-access-key',
    AWS_SECRET_ACCESS_KEY: 'remote-bedrock-secret-key',
  };
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    fakeClaude,
    [
      '#!/bin/sh',
      '[ "$1" = "--bare" ] || exit 91',
      '[ "$CLAUDE_CODE_USE_BEDROCK" = "1" ] || exit 92',
      '[ "$AWS_REGION" = "us-east-1" ] || exit 93',
      '[ "$AWS_ACCESS_KEY_ID" = "remote-bedrock-access-key" ] || exit 94',
      '[ "$AWS_SECRET_ACCESS_KEY" = "remote-bedrock-secret-key" ] || exit 95',
      '[ -z "${ANTHROPIC_API_KEY:-}" ] || exit 96',
      'printf BEDROCK_AUTH_OK',
    ].join('\n'),
    { mode: 0o700 },
  );

  const spawn = loopbackSshSpawn({ env: { HOME: home, ...providerEnv } });
  const executor = createRemoteSshNodeExecutor(nodeRow({
    exposed_roots: JSON.stringify([root]),
  }), { spawnFn: spawn });
  const child = await executor.spawnInteractive('claude', ['--bare'], {
    cwd: root,
    pathPrefix: bin,
    claudeBareAuth: true,
    envAllowlist: Object.keys(providerEnv),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const [code] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (...args) => resolve(args));
  });

  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'BEDROCK_AUTH_OK');
  for (const secret of [
    providerEnv.AWS_ACCESS_KEY_ID,
    providerEnv.AWS_SECRET_ACCESS_KEY,
  ]) {
    for (const call of spawn.calls) {
      assert.doesNotMatch(
        JSON.stringify(call.args),
        new RegExp(secret),
        'provider credentials must stay out of local SSH argv',
      );
    }
  }
});

test('spawnInteractive worker ignores allowlisted ambient API base and keeps run-bound values out of env argv', async (t) => {
  const workerToken = 'worker_run_capability_secret';
  const apiBase = 'https://argv-zero.example:8443/proxy-prefix';
  const ambientApiBase = 'http://pod-user:pod-password@ambient-console:4177';
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-interactive-argv-'));
  const argvCapturePath = path.join(sandbox, 'argv.bin');
  const envShimPath = path.join(sandbox, 'env');
  const claudeShimPath = path.join(sandbox, 'claude');
  t.after(async () => fs.rm(sandbox, { recursive: true, force: true }));
  await fs.writeFile(envShimPath, [
    '#!/bin/sh',
    ': > "$PALANTIR_TEST_ENV_ARGV_CAPTURE"',
    'for arg do',
    '  printf \'%s\\0\' "$arg" >> "$PALANTIR_TEST_ENV_ARGV_CAPTURE"',
    'done',
    'exec /usr/bin/env "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  await fs.writeFile(claudeShimPath, [
    '#!/bin/sh',
    'cat >/dev/null',
    'printf \'%s\\n%s\\n\' "$PALANTIR_WORKER_TOKEN" "$PALANTIR_API_BASE"',
    '',
  ].join('\n'), { mode: 0o700 });

  const spawn = loopbackSshSpawn({
    env: {
      PATH: `${sandbox}:${process.env.PATH || ''}`,
      PALANTIR_TEST_ENV_ARGV_CAPTURE: argvCapturePath,
      PALANTIR_API_BASE: ambientApiBase,
    },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  const child = await exec.spawnInteractive('claude', ['--print'], {
    worker: true,
    envAllowlist: ['PALANTIR_API_BASE'],
    env: {
      PALANTIR_WORKER_TOKEN: workerToken,
      PALANTIR_API_BASE: apiBase,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise((resolve) => child.once('close', (...args) => resolve(args)));
  child.stdin.end('worker prompt');
  const [code] = await closed;

  assert.equal(code, 0, stderr);
  assert.equal(stdout, `${workerToken}\n${apiBase}\n`);
  const actualEnvArgv = (await fs.readFile(argvCapturePath))
    .toString()
    .split('\0')
    .filter(Boolean);
  assert.ok(actualEnvArgv.includes('/bin/sh'), actualEnvArgv);
  assert.equal(actualEnvArgv.some((arg) => arg.includes(workerToken)), false, actualEnvArgv);
  assert.equal(actualEnvArgv.some((arg) => arg.includes(apiBase)), false, actualEnvArgv);
  assert.equal(actualEnvArgv.some((arg) => arg.includes(ambientApiBase)), false, actualEnvArgv);
  const sshCall = spawn.calls.at(-1);
  assert.equal(JSON.stringify(sshCall.args).includes(workerToken), false);
  assert.equal(JSON.stringify(sshCall.args).includes(apiBase), false);
  assert.equal(JSON.stringify(sshCall.args).includes(ambientApiBase), false);

  const bareChild = await exec.spawnInteractive('claude', ['--print'], {
    worker: true,
    envAllowlist: ['PALANTIR_API_BASE'],
    env: {},
  });
  let bareStdout = '';
  let bareStderr = '';
  bareChild.stdout.on('data', (chunk) => { bareStdout += chunk.toString(); });
  bareChild.stderr.on('data', (chunk) => { bareStderr += chunk.toString(); });
  const bareClosed = new Promise((resolve) => bareChild.once('close', (...args) => resolve(args)));
  bareChild.stdin.end('worker prompt without capability');
  const [bareCode] = await bareClosed;

  assert.equal(bareCode, 0, bareStderr);
  assert.equal(bareStdout, '\n\n');
  const bareEnvArgv = (await fs.readFile(argvCapturePath))
    .toString()
    .split('\0')
    .filter(Boolean);
  assert.equal(bareEnvArgv.some((arg) => arg.includes(ambientApiBase)), false, bareEnvArgv);
});

test('spawnInteractive worker rejects API base URL userinfo before spawning ssh', async () => {
  const spawn = makeSpawn(() => {});
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await assert.rejects(
    () => exec.spawnInteractive('claude', ['--print'], {
      worker: true,
      env: {
        PALANTIR_WORKER_TOKEN: 'token',
        PALANTIR_API_BASE: 'http://user:pass@console:4177',
      },
    }),
    (err) => (
      err.code === 'WORKER_API_BASE_USERINFO'
      && /userinfo/.test(err.message)
      && !/user|pass/.test(err.message.replace('userinfo', ''))
    ),
  );
  assert.equal(spawn.calls.length, 0);
});

test('spawnInteractive worker removes a case-variant API base from explicit env and allowlist', async () => {
  const apiBase = 'http://case-user:case-password@console.internal:4177';
  const spawn = rootGuardSpawn();
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await exec.spawnInteractive('claude', ['--print'], {
    worker: true,
    envAllowlist: ['palantir_api_base'],
    env: { palantir_api_base: apiBase },
  });

  assert.equal(spawn.calls.length, 1);
  const callText = JSON.stringify(spawn.calls[0].args);
  assert.equal(callText.includes(apiBase), false);
  assert.doesNotMatch(callText, /palantir_api_base/i);
});

test('spawnInteractive rejects a manager capability that cannot be line-framed', async () => {
  const spawn = makeSpawn(() => {});
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await assert.rejects(
    () => exec.spawnInteractive('codex', ['exec'], {
      env: { PALANTIR_MANAGER_TOKEN: 'bad\ncapability' },
    }),
    (err) => err.code === 'SECRET_TRANSPORT_INVALID',
  );
  assert.equal(spawn.calls.length, 0);
});

test('spawnInteractive injects pathPrefix as PATH prepend with quoted "$PATH"', async () => {
  // codex/claude live outside the pod's minimal non-interactive-ssh PATH
  // (~/.npm-global/bin). pathPrefix prepends the literal (shq-quoted) dir while
  // the pod's own PATH still resolves the codex shebang's node.
  //
  // The expansion is DOUBLE-QUOTED. In the pre-#431 form this was an assignment
  // word, which POSIX exempts from field splitting, so bare :$PATH was safe.
  // Under `env -i` it is an ordinary argument: a pod PATH containing a space
  // splits into two arguments and env fails with 127 (reproduced on a live pod
  // with PATH="/opt/my bin:...").
  const spawn = makeSpawn(() => {});
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await exec.spawnInteractive('codex', ['exec'], { pathPrefix: '/home/karnian/.npm-global/bin' });
  const script = scriptOf(spawn.calls.at(-1));
  assert.ok(
    script.includes(
      `exec env -i "$@" PATH=${shq('/home/karnian/.npm-global/bin')}:"$PATH" `
      + `PALANTIR_TOKEN=${shq('')} PALANTIR_PM_TOKEN=${shq('')} `
      + `PALANTIR_WORKER_TOKEN=${shq('')} PALANTIR_MANAGER_TOKEN=${shq('')} `
      + `${shq('codex')} ${shq('exec')}`,
    ),
    script,
  );
  // The prefix is single-quoted (literal); the pod expansion is double-quoted.
  assert.ok(script.includes(`PATH=${shq('/home/karnian/.npm-global/bin')}:"$PATH"`));
  assert.doesNotMatch(script, /PATH='[^']*':\$PATH(?!")/, 'bare :$PATH would field-split');
});

test('spawnInteractive rejects relative/control-char/non-string pathPrefix (PATH-trust guard)', async () => {
  const spawn = makeSpawn(() => {});
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  for (const bad of [
    '.', 'relative/bin', '', '/x\nety', '/x\x00y', 123, {},
    '/opt/bin:relative/bin', '/opt/bin:.', '/opt/bin:', ':/opt/bin',
  ]) {
    await assert.rejects(
      () => exec.spawnInteractive('codex', ['exec'], { pathPrefix: bad }),
      /pathPrefix must be one or more absolute POSIX paths/,
    );
  }
  // absolute + clean → accepted (no throw, spawns)
  await exec.spawnInteractive('codex', ['exec'], { pathPrefix: '/home/karnian/.npm-global/bin' });
});

test('spawnInteractive allows only trusted manager commands independent from public exec allowlist', async () => {
  const spawn = makeSpawn(() => {});
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    commandAllowlist: ['bash', 'git'],
  });

  await exec.spawnInteractive('claude', ['--version']);
  assert.ok(
    scriptOf(spawn.calls.at(-1)).endsWith(
      `exec env -i "$@" PATH="$PATH" PALANTIR_TOKEN=${shq('')} `
      + `PALANTIR_PM_TOKEN=${shq('')} PALANTIR_WORKER_TOKEN=${shq('')} `
      + `PALANTIR_MANAGER_TOKEN=${shq('')} 'claude' '--version'`,
    ),
  );

  for (const command of ['bash', 'git']) {
    await assert.rejects(
      () => exec.spawnInteractive(command, []),
      (err) => err.code === 'COMMAND_NOT_ALLOWED',
    );
  }
});

test('readdir returns child names and rejects options', async () => {
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/dir'": { stdout: '/real/root/dir\n' },
    "exec 'find' '/real/root/dir' '-mindepth' '1' '-maxdepth' '1' '-print'": {
      stdout: '/real/root/dir/a\n/real/root/dir/b.txt\n',
    },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  assert.deepEqual(await exec.readdir('/srv/root/dir'), ['a', 'b.txt']);
  await assert.rejects(() => exec.readdir('/srv/root/dir', { withFileTypes: true }), /does not support options/);
});

test('public exec enforces command allowlist while internal fs primitives still run', async () => {
  const spawn = simpleSpawn({ code: 0, stdout: 'ok\n' });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  const res = await exec.exec('git', ['status']);
  assert.equal(res.code, 0);
  assertSharedExecEnvScript(scriptOf(spawn.calls[0]));
  assert.ok(scriptOf(spawn.calls[0]).endsWith("exec env -i \"$@\" 'git' 'status'"));

  for (const command of ['cat', 'sh']) {
    await assert.rejects(
      () => exec.exec(command, command === 'sh' ? ['-c', 'id'] : ['/etc/passwd']),
      (err) => err.code === 'COMMAND_NOT_ALLOWED',
      command,
    );
  }
  assert.equal(spawn.calls.length, 1);

  const internalSpawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/file'": { stdout: '/real/root/file\n' },
    "exec 'test' '-e' '/real/root/file'": { code: 0 },
  });
  const internal = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: internalSpawn });
  assert.equal(await internal.fileExists('/srv/root/file'), true);
  assert.equal(await internal.realpath('/srv/root/file'), '/real/root/file');
});

test('projectTest alone permits /bin/sh and still emits a clean positive-list environment', async () => {
  const spawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const result = await exec.exec('/bin/sh', ['-c', 'npm test'], {
    cwd: '/srv/root/project',
    projectTest: true,
  });

  assert.equal(result.code, 0);
  const commandCall = spawn.calls.at(-1);
  const script = scriptOf(commandCall);
  assertProjectTestEnvScript(script);
  assert.ok(script.endsWith("'/bin/sh' '-c' 'npm test'"), script);

  await assert.rejects(
    () => exec.exec('/bin/sh', ['-c', 'npm test'], { cwd: '/srv/root/project' }),
    (err) => err.code === 'COMMAND_NOT_ALLOWED',
  );
  await assert.rejects(
    () => exec.exec('sh', ['-c', 'npm test'], { projectTest: true }),
    (err) => err.code === 'COMMAND_NOT_ALLOWED',
  );
});

test('ssh destination components reject option smuggling and unsafe separators', async (t) => {
  assert.throws(() => createRemoteSshNodeExecutor(nodeRow({ ssh_host: '-oProxyCommand=x' })), /ssh_host/);
  assert.throws(() => createRemoteSshNodeExecutor(nodeRow({ ssh_user: '-x' })), /ssh_user/);
  assert.throws(() => createRemoteSshNodeExecutor(nodeRow({ ssh_host: 'pod example' })), /ssh_host/);
  assert.throws(() => createRemoteSshNodeExecutor(nodeRow({ ssh_host: 'runner@pod.example' })), /ssh_host/);

  const spawn = simpleSpawn({ code: 0, stdout: 'git version\n' });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await exec.exec('git', ['--version']);
  assert.equal(spawn.calls[0].args[6], '--');
  assert.equal(spawn.calls[0].args[7], 'runner@pod.example');
  assert.deepEqual(remoteCommandArgsOf(spawn.calls[0]), [remoteCommandOf(spawn.calls[0])]);
  assert.match(remoteCommandOf(spawn.calls[0]), /^sh -c '/);

  const db = await mkdb(t);
  const nodeService = createNodeService(db, { localExecutor: { local: true } });
  for (const patch of [
    { ssh_host: '-oProxyCommand=x', ssh_user: 'runner' },
    { ssh_host: 'pod example', ssh_user: 'runner' },
    { ssh_host: 'runner@pod.example', ssh_user: 'runner' },
    { ssh_host: 'pod.example', ssh_user: '-x' },
  ]) {
    assert.throws(
      () => nodeService.createNode({
        id: `bad-${Math.random()}`,
        name: 'Bad SSH',
        kind: 'ssh',
        exposed_roots: ['/srv/root'],
        ...patch,
      }),
      /safe ssh destination/,
    );
  }
  assert.equal(nodeService.createNode({
    id: 'good-ssh',
    name: 'Good SSH',
    kind: 'ssh',
    ssh_host: 'pod.example',
    ssh_user: 'runner',
    exposed_roots: ['/srv/root'],
  }).id, 'good-ssh');
});

test('remote exec filters pod env, serializes explicit overrides, and validates key syntax', async () => {
  const oldSecret = process.env.REMOTE_EXEC_FAKE_CONTROLLER_SECRET;
  process.env.REMOTE_EXEC_FAKE_CONTROLLER_SECRET = 'do-not-forward';
  try {
    const spawn = simpleSpawn({ code: 0 });
    const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
    await exec.exec('git', ['status'], { env: { LC_ALL: 'C' } });
    const script = scriptOf(spawn.calls[0]);
    assertSharedExecEnvScript(script);
    assert.ok(script.endsWith("exec env -i \"$@\" LC_ALL='C' 'git' 'status'"));
    assert.doesNotMatch(script, /REMOTE_EXEC_FAKE_CONTROLLER_SECRET/);
    assert.doesNotMatch(script, /do-not-forward/);

    await assert.rejects(
      () => exec.exec('git', ['status'], { env: { 'PATH x': 'y' } }),
      (err) => err.code === 'ENV_KEY_INVALID',
    );
    assert.equal(spawn.calls.length, 1);
  } finally {
    if (oldSecret === undefined) delete process.env.REMOTE_EXEC_FAKE_CONTROLLER_SECRET;
    else process.env.REMOTE_EXEC_FAKE_CONTROLLER_SECRET = oldSecret;
  }
});

test('spawnWorker builds file-backed tmux script through the internal runner', async () => {
  const runId = 'run_1';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const stdoutLog = `${statusDir}/stdout.log`;
  const exitSentinel = `${statusDir}/exit.code`;
  const hostile = "x'; touch /tmp/pwn; '";
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) {
      complete(child, { code: 0 });
      return;
    }
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    commandAllowlist: ['git'],
  });

  const result = await exec.spawnWorker(runId, {
    command: 'codex',
    args: ['--version', hostile, '$(literal)'],
    cwd: '/srv/root/project',
    env: { LC_ALL: 'C', QUOTE: "a'b" },
    workerPath: '/home/karnian/.npm-global/bin',
  });

  assert.deepEqual(result, { sessionName: 'palantir-run-run_1' });
  const workerScript = spawn.calls.map(scriptOf).find((script) => script.includes('tmux new-session'));
  const inner = tmuxInnerScript(workerScript, runId);
  assert.ok(inner.includes(`env -i "$@" PATH=${shq('/home/karnian/.npm-global/bin')}:"$PATH"`), inner);
  assert.ok(inner.includes('LC_ALL=$(cat --'));
  assert.ok(inner.includes('QUOTE=$(cat --'));
  assert.ok(inner.includes('export LC_ALL'));
  assert.ok(inner.includes('export QUOTE'));
  assert.ok(inner.includes(`${shq('codex')} ${shq('--version')} ${shq(hostile)} ${shq('$(literal)')}`));
  assert.equal(JSON.stringify(spawn.calls.map((call) => call.args)).includes("a'b"), false);
  assert.equal(spawn.calls.find((call) => scriptOf(call).startsWith('umask 077')).stdin, "Ca'b");
  assert.ok(spawn.calls.some((call) => scriptOf(call) === "exec 'mkdir' '-p' '/srv/root/.palantir-runs'"));
  assert.ok(spawn.calls.some((call) => scriptOf(call) === `exec 'mkdir' '-p' ${shq(statusDir)}`));
});

test('spawnWorker file-backs a scoped capability and keeps it out of SSH command strings', async () => {
  const runId = 'run_secret_transport';
  const workerToken = 'worker_run_capability_secret';
  const apiBase = 'https://argv-zero.example:8443/console-prefix';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const bundlePath = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const secretPath = `/real/root/.palantir-runs/${runId}/worker-capability`;
  const apiBasePath = `/real/root/.palantir-runs/${runId}/worker-api-base`;
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) {
      complete(child, { code: 0 });
      return;
    }
    if (Object.hasOwn(routes, script)) {
      complete(child, routes[script]);
      return;
    }
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const result = await exec.spawnWorker(runId, {
    command: 'codex',
    args: ['exec'],
    cwd: '/srv/root/project',
    env: {
      PALANTIR_WORKER_TOKEN: workerToken,
      PALANTIR_API_BASE: apiBase,
      PALANTIR_MANAGER_TOKEN: 'must-be-scrubbed',
      LC_ALL: 'C',
    },
  });

  assert.deepEqual(result, { sessionName: `palantir-run-${runId}` });
  const writeCall = spawn.calls.find((call) => scriptOf(call).startsWith('umask 077'));
  assert.equal(writeCall.stdin, workerToken + apiBase + 'C');
  const handoffScript = scriptOf(writeCall);
  const inner = tmuxInnerScript(handoffScript, runId);
  assert.ok(handoffScript.includes(
    `head -c ${Buffer.byteLength(workerToken + apiBase + 'C')} > ${shq(bundlePath)}`,
  ));
  assert.ok(inner.includes(
    `head -c ${Buffer.byteLength(workerToken)} ${shq(bundlePath)} > ${shq(secretPath)}`,
  ));
  assert.ok(inner.includes(
    `tail -c +${Buffer.byteLength(workerToken) + 1} ${shq(bundlePath)} `
    + `| head -c ${Buffer.byteLength(apiBase)} > ${shq(apiBasePath)}`,
  ));
  assert.ok(handoffScript.includes('tmux new-session'));
  // Read inside the clean shell (`cat --` guards a leading-dash path); the
  // value is never an env -i argument, so it stays out of /usr/bin/env's argv.
  // The read now lives in a nested `sh -c` body, so its own quoting is escaped
  // one extra level inside this tmux script. Assert quoting-agnostically.
  assert.ok(inner.includes('PALANTIR_WORKER_TOKEN=$(cat -- '));
  assert.ok(inner.includes(secretPath), 'the token file path must be referenced');
  assert.ok(inner.includes('PALANTIR_API_BASE=$(cat -- '));
  assert.ok(inner.includes(apiBasePath), 'the API base file path must be referenced');
  assert.ok(inner.includes('export PALANTIR_API_BASE'));
  assert.doesNotMatch(inner, /PALANTIR_WORKER_TOKEN="\$PALANTIR_WORKER_TOKEN"/);
  assert.equal(inner.includes(apiBase), false);
  assert.ok(inner.includes('rm -f -- '));
  assert.doesNotMatch(inner, /PALANTIR_WORKER_TOKEN=''/);
  assert.doesNotMatch(inner, /must-be-scrubbed/);
  assert.equal(
    spawn.calls.some((call) => scriptOf(call).includes('.palantir-secret-')),
    false,
    'capability recovery must not depend on a random directory outside run status',
  );
  for (const entry of spawn.calls) {
    assert.doesNotMatch(JSON.stringify(entry.args), new RegExp(workerToken));
    assert.equal(JSON.stringify(entry.args).includes(apiBase), false);
  }
  assert.equal(
    spawn.calls.reduce((count, call) => count + call.stdin.split(apiBase).length - 1, 0),
    1,
    'the API base value appears exactly once, in upload stdin',
  );
});

test('spawnWorker exports the file-backed API base inside the pod clean shell', async (t) => {
  const root = await mkLoopbackRoot(t);
  const projectDir = path.join(root, 'project');
  const fakeBin = await mkLoopbackRoot(t);
  const fakeTmux = path.join(fakeBin, 'tmux');
  const portableChmod = path.join(fakeBin, 'chmod');
  const runId = 'api_base_export';
  const workerToken = 'loopback-worker-capability';
  const apiBase = 'https://console.example:8443/proxy-prefix';
  await fs.mkdir(projectDir);
  await fs.writeFile(
    fakeTmux,
    '#!/bin/sh\nexec /bin/sh -c "$5"\n',
    { mode: 0o700 },
  );
  await fs.writeFile(
    portableChmod,
    '#!/bin/sh\nmode=$1\nshift\n[ "$1" = "--" ] && shift\nexec /bin/chmod "$mode" "$@"\n',
    { mode: 0o700 },
  );
  const spawn = loopbackSshSpawn({
    env: { PATH: `${fakeBin}:${process.env.PATH}` },
  });
  const executor = createRemoteSshNodeExecutor(nodeRow({
    exposed_roots: JSON.stringify([root]),
  }), { spawnFn: spawn });

  await executor.spawnWorker(runId, {
    command: '/usr/bin/env',
    cwd: projectDir,
    workerPath: '/usr/bin:/bin',
    env: {
      PALANTIR_WORKER_TOKEN: workerToken,
      PALANTIR_API_BASE: apiBase,
    },
  });

  const statusDir = path.join(root, '.palantir-runs', runId);
  const output = await fs.readFile(path.join(statusDir, 'stdout.log'), 'utf8');
  assert.ok(output.split('\n').includes(`PALANTIR_WORKER_TOKEN=${workerToken}`));
  assert.ok(output.split('\n').includes(`PALANTIR_API_BASE=${apiBase}`));
  await assert.rejects(
    () => fs.stat(path.join(statusDir, 'worker-capability')),
    (err) => err.code === 'ENOENT',
  );
  await assert.rejects(
    () => fs.stat(path.join(statusDir, 'worker-api-base')),
    (err) => err.code === 'ENOENT',
  );
  for (const call of spawn.calls) {
    assert.equal(JSON.stringify(call.args).includes(apiBase), false);
  }
});

test('spawnWorker ignores allowlisted ambient API base without a worker capability', async (t) => {
  const root = await mkLoopbackRoot(t);
  const projectDir = path.join(root, 'project');
  const fakeBin = await mkLoopbackRoot(t);
  const fakeTmux = path.join(fakeBin, 'tmux');
  const envShim = path.join(fakeBin, 'env');
  const argvCapturePath = path.join(fakeBin, 'env-argv.bin');
  const ambientApiBase = 'http://pod-user:pod-password@ambient-console:4177';
  const runId = 'ambient_api_base_denied';
  await fs.mkdir(projectDir);
  await fs.writeFile(
    fakeTmux,
    '#!/bin/sh\nexec /bin/sh -c "$5"\n',
    { mode: 0o700 },
  );
  await fs.writeFile(envShim, [
    '#!/bin/sh',
    ': > "$PALANTIR_TEST_ENV_ARGV_CAPTURE"',
    'for arg do',
    '  printf \'%s\\0\' "$arg" >> "$PALANTIR_TEST_ENV_ARGV_CAPTURE"',
    'done',
    'exec /usr/bin/env "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  const spawn = loopbackSshSpawn({
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      PALANTIR_TEST_ENV_ARGV_CAPTURE: argvCapturePath,
      PALANTIR_API_BASE: ambientApiBase,
    },
  });
  const executor = createRemoteSshNodeExecutor(nodeRow({
    exposed_roots: JSON.stringify([root]),
  }), { spawnFn: spawn });

  await executor.spawnWorker(runId, {
    command: '/usr/bin/env',
    cwd: projectDir,
    workerPath: '/usr/bin:/bin',
    envAllowlist: ['PALANTIR_API_BASE'],
    env: {},
  });

  const statusDir = path.join(root, '.palantir-runs', runId);
  const output = await fs.readFile(path.join(statusDir, 'stdout.log'), 'utf8');
  assert.equal(output.includes('PALANTIR_API_BASE='), false, output);
  const actualEnvArgv = (await fs.readFile(argvCapturePath))
    .toString()
    .split('\0')
    .filter(Boolean);
  assert.equal(actualEnvArgv.some((arg) => arg.includes(ambientApiBase)), false, actualEnvArgv);
});

test('spawnWorker removes a case-variant API base from SSH argv and the pod allowlist', async () => {
  const runId = 'case_variant_api_base';
  const apiBase = 'http://case-user:case-password@console.internal:4177';
  const spawn = workerSpawnHarness(runId);
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnWorker(runId, {
    command: 'codex',
    args: ['exec'],
    cwd: '/srv/root/project',
    env: { palantir_api_base: apiBase },
    envAllowlist: ['palantir_api_base'],
  });

  const tmuxCall = spawn.calls.find((call) => scriptOf(call).includes('tmux new-session'));
  assert.ok(tmuxCall);
  const callText = JSON.stringify(tmuxCall.args);
  assert.equal(callText.includes(apiBase), false);
  assert.doesNotMatch(callText, /palantir_api_base/i);
});

test('spawnWorker rejects an API base with URL userinfo before handoff', async () => {
  const runId = 'api_base_userinfo';
  const apiBase = 'http://worker-user:worker-password@console.internal:4177';
  const spawn = workerSpawnHarness(runId);
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => executor.spawnWorker(runId, {
      command: 'codex',
      args: ['exec'],
      cwd: '/srv/root/project',
      env: {
        PALANTIR_WORKER_TOKEN: 'scoped-worker-token',
        PALANTIR_API_BASE: apiBase,
      },
    }),
    (err) => (
      err.code === 'WORKER_API_BASE_USERINFO'
      && !/worker-user|worker-password/.test(err.message)
    ),
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call).includes('tmux new-session')),
    false,
  );
  for (const call of spawn.calls) {
    assert.equal(JSON.stringify(call.args).includes(apiBase), false);
  }
});

test('spawnWorker transports prompt text through a guarded mode-0600 stdin file', async () => {
  const runId = 'stdin_worker';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const stdinFile = `${statusDir}/stdin.txt`;
  const canonicalStdin = `/real/root/.palantir-runs/${runId}/stdin.txt`;
  const canonicalBundle = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const prompt = '--- a/file.js\n-c service_tier="fast"\n--help\n';
  // The prompt file does not exist yet when its path is resolved, so realpath on
  // it fails and allowMissing canonicalises the parent instead.
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) return complete(child, { code: 0 });
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await exec.spawnWorker(runId, {
    command: 'codex',
    args: ['exec', '-'],
    stdin: prompt,
    cwd: '/srv/root/project',
  });

  // Upload and handoff must be ONE invocation. Two calls would leave the prompt
  // on disk owned by nobody if the controller died in between.
  const uploadCalls = spawn.calls.filter((call) => (
    scriptOf(call).includes(`head -c ${Buffer.byteLength(prompt, 'utf8')} > ${shq(canonicalBundle)}`)
  ));
  assert.equal(uploadCalls.length, 1, 'prompt upload and tmux handoff share one SSH invocation');
  const combined = scriptOf(uploadCalls[0]);
  assert.equal(uploadCalls[0].stdin, prompt);
  assert.ok(combined.includes('tmux new-session'), 'the upload invocation also starts the worker');
  assert.doesNotMatch(combined, /service_tier="fast"|--- a\/file\.js|--help/);

  // Trap armed before the file can exist, disarmed only after tmux owns it.
  const armIndex = combined.indexOf(`trap 'rc=$?; cleanup; exit "$rc"' 0`);
  const writeIndex = combined.indexOf(
    `head -c ${Buffer.byteLength(prompt, 'utf8')} > ${shq(canonicalBundle)}`,
  );
  const tmuxIndex = combined.indexOf('tmux new-session');
  const disarmIndex = combined.lastIndexOf('trap - 0 HUP INT TERM');
  assert.ok(armIndex >= 0 && armIndex < writeIndex, 'cleanup trap is armed before the upload starts');
  assert.ok(tmuxIndex < disarmIndex, 'cleanup trap stays armed until tmux owns the prompt file');
  assert.ok(combined.includes(
    `cleanup() { rm -f -- ${shq(canonicalStdin)} ${shq(canonicalBundle)}; }`,
  ));

  // Signal handlers must exit, not fall through — otherwise the && chain keeps
  // going and starts a worker on the prompt the handler just deleted.
  for (const [signal, code] of [['HUP', 129], ['INT', 130], ['TERM', 143]]) {
    assert.ok(
      combined.includes(`trap 'exit ${code}' ${signal}`),
      `${signal} aborts the chain instead of falling through`,
    );
  }

  // A dying controller closes stdin, which head reads as a clean EOF — the
  // single bundle byte check stops a truncated handoff from launching a worker.
  assert.ok(
    combined.includes(`[ "$(wc -c < ${shq(canonicalBundle)})" -eq ${Buffer.byteLength(prompt, 'utf8')} ]`),
    'short uploads fail the chain instead of starting a worker',
  );
  assert.ok(combined.indexOf('chmod 600') < tmuxIndex);

  // Isolate the quoted innerScript tmux runs, between the new-session prefix and
  // the outer shell's trailing disarm.
  const disarmSuffix = ' && trap - 0 HUP INT TERM';
  assert.ok(combined.endsWith(disarmSuffix));
  const prefix = `${combined.slice(0, tmuxIndex)}tmux new-session -d -s ${shq(`palantir-run-${runId}`)} `;
  const quotedInnerScript = combined.slice(prefix.length, combined.length - disarmSuffix.length);
  const inner = unshq(quotedInnerScript);
  assert.ok(
    inner.startsWith(
      `umask 077; trap ${shq(`rm -f -- ${shq(canonicalStdin)} ${shq(canonicalBundle)}`)} `
      + `EXIT HUP INT TERM; set -C && head -c ${Buffer.byteLength(prompt, 'utf8')} `
      + `${shq(canonicalBundle)} > ${shq(canonicalStdin)}`,
    ),
    inner,
  );
  assert.ok(
    inner.includes(`rm -f -- ${shq(canonicalBundle)} && ( set --; for k in `),
    inner,
  );
  assert.ok(
    inner.includes(`${shq('codex')} ${shq('exec')} ${shq('-')} ) < ${shq(canonicalStdin)} `
      + `> ${shq(`${statusDir}/stdout.log`)} 2>&1; agent_exit_code=$?; `),
    inner,
  );
  assert.ok(
    inner.includes(
      `rm -f -- ${shq(canonicalStdin)} ${shq(canonicalBundle)}; `
      + `trap - EXIT HUP INT TERM; echo "$agent_exit_code" > ${shq(`${statusDir}/exit.code`)}`,
    ),
    inner,
  );
});

test('detached Claude worker composes pod auth with file-backed user/system prompts', async () => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const runId = 'claude_prompt_boundary';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalDir = `/real/root/.palantir-runs/${runId}`;
  const userPrompt = 'user prompt pasted-secret';
  const systemPrompt = 'private system context';
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `${canonicalDir}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) return complete(child, { code: 0 });
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  const streamEngine = createStreamJsonEngine();
  const spec = streamEngine.buildDetachedWorkerSpec({
    prompt: userPrompt,
    systemPrompt,
    cwd: '/srv/root/project',
    bare: true,
    envAllowlist: ['ANTHROPIC_API_KEY'],
    env: {
      ANTHROPIC_API_KEY: 'controller-secret-must-not-cross',
      PALANTIR_WORKER_TOKEN: '',
    },
  }, { workerPath: '/home/runner/.npm-global/bin' });

  await executor.spawnWorker(runId, { engine: 'stream-json', spec });

  const upload = spawn.calls.find((call) => scriptOf(call).startsWith('umask 077'));
  assert.ok(upload);
  assert.equal(upload.stdin, systemPrompt + userPrompt);
  for (const call of spawn.calls) {
    const serialized = JSON.stringify(call.args);
    assert.doesNotMatch(serialized, /pasted-secret|private system context|controller-secret-must-not-cross/);
  }
  const script = scriptOf(upload);
  const workerScript = tmuxInnerScript(script, runId);
  assert.equal(spec.claudeBareAuth, true);
  const systemFile = `${canonicalDir}/system-prompt.txt`;
  const stdinFile = `${canonicalDir}/stdin.txt`;
  const bundleFile = `${canonicalDir}/worker-input.bundle`;
  const totalBytes = Buffer.byteLength(systemPrompt + userPrompt, 'utf8');
  assert.ok(script.includes(
    `head -c ${totalBytes} > ${shq(bundleFile)}`,
  ));
  assert.ok(workerScript.includes(
    `head -c ${Buffer.byteLength(systemPrompt, 'utf8')} ${shq(bundleFile)} > ${shq(systemFile)}`,
  ));
  assert.ok(workerScript.includes(
    `tail -c +${Buffer.byteLength(systemPrompt, 'utf8') + 1} ${shq(bundleFile)} `
    + `| head -c ${Buffer.byteLength(userPrompt, 'utf8')} > ${shq(stdinFile)}`,
  ));
  assert.ok(script.includes('--append-system-prompt-file'));
  assert.ok(script.includes(systemFile));
  assert.ok(script.includes(stdinFile));
  assert.ok(script.includes(`${statusDir}/result.jsonl.tmp`));
  assert.ok(script.includes(`${statusDir}/result.jsonl`));
  assert.match(script, /awk .*"type".*"result"/);
  assert.ok(script.includes(shq('HOME')), 'pod HOME must survive env -i');
  assert.ok(script.includes(shq('ANTHROPIC_API_KEY')), 'only the allowlisted key name crosses');
  assert.ok(workerScript.includes('.credentials.json'), 'pod login token is materialized inside tmux');
  assert.doesNotMatch(script, /ANTHROPIC_API_KEY='controller-secret/);
});

test('spawnWorker never follows a stdin.txt symlink that points at another in-root file', async () => {
  // A link to a file that is itself inside the exposed roots passes the
  // exposed-roots check, so resolving the final component would hand the upload
  // a victim path to delete and overwrite with the prompt. The prompt path must
  // come from the canonical PARENT plus the fixed basename.
  const runId = 'stdin_symlink';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const stdinFile = `${statusDir}/stdin.txt`;
  const victim = '/real/root/project/victim.txt';
  const expectedStdin = `/real/root/.palantir-runs/${runId}/stdin.txt`;
  const expectedBundle = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    const routes = {
      "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
      "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
      "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
      [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
      // stdin.txt already exists as a symlink aimed at an in-root file.
      [`exec 'realpath' ${shq(stdinFile)}`]: { stdout: `${victim}\n` },
      "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
      [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    };
    if (script.startsWith('umask 077 && cleanup()')) return complete(child, { code: 0 });
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await exec.spawnWorker(runId, {
    command: 'codex',
    args: ['exec', '-'],
    stdin: '--help\n',
    cwd: '/srv/root/project',
  });

  const combined = spawn.calls.map(scriptOf).find((script) => script.includes('head -c '));
  const workerScript = tmuxInnerScript(combined, runId);
  assert.ok(combined);
  assert.ok(
    !combined.includes(victim),
    'the symlink target must never appear in the upload script',
  );
  assert.ok(combined.includes(`rm -f -- ${shq(expectedStdin)} ${shq(expectedBundle)}`));
  assert.ok(combined.includes(`head -c 7 > ${shq(expectedBundle)}`));
  assert.ok(workerScript.includes(`head -c 7 ${shq(expectedBundle)} > ${shq(expectedStdin)}`));
  // noclobber stops a symlink recreated between the unlink and the redirect.
  assert.ok(workerScript.includes(`set -C && head -c 7 ${shq(expectedBundle)} > ${shq(expectedStdin)}`));
  assert.ok(
    workerScript.includes(`rm -f -- ${shq(expectedBundle)} && ( set --; for k in `),
    'the complete worker invocation must remain guarded by successful input materialization',
  );
});

test('spawnWorker cleans a partial remote stdin file when SSH upload rejects', async () => {
  const runId = 'stdin_upload_failure';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalStdin = `/real/root/.palantir-runs/${runId}/stdin.txt`;
  const canonicalBundle = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const cleanupScript = `exec 'rm' '-f' ${shq(canonicalStdin)} ${shq(canonicalBundle)}`;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    const routes = {
      "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
      "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
      "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
      [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
      "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
      [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
      [cleanupScript]: { code: 0 },
    };
    if (script.startsWith('umask 077 && cleanup()')) {
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          const error = new Error('simulated upload EPIPE');
          error.code = 'EPIPE';
          callback(error);
        },
      });
      return;
    }
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => exec.spawnWorker(runId, {
      command: 'codex',
      args: ['exec', '-'],
      stdin: '--help\n',
      cwd: '/srv/root/project',
    }),
    (error) => error.code === 'EPIPE',
  );

  // The remote trap covers a dropped connection; this local-side rejection may
  // leave a remote shell that never ran, so the controller still sweeps.
  assert.ok(
    spawn.calls.some((call) => scriptOf(call) === cleanupScript),
    'rejected upload must attempt to remove the partial remote prompt file',
  );
});

test('spawnWorker removes the remote prompt when the combined upload/handoff fails', async () => {
  const runId = 'stdin_handoff_failure';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalStdin = `/real/root/.palantir-runs/${runId}/stdin.txt`;
  const canonicalBundle = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const cleanupScript = `exec 'rm' '-f' ${shq(canonicalStdin)} ${shq(canonicalBundle)}`;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    const routes = {
      "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
      "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
      "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
      [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
      "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
      [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
      [cleanupScript]: { code: 0 },
    };
    // Whole chain fails the way a short upload (byte check) or a tmux failure
    // would — the run must not be reported as started.
    if (script.startsWith('umask 077 && cleanup()')) return complete(child, { code: 1, stderr: 'tmux: no server' });
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(() => exec.spawnWorker(runId, {
    command: 'codex',
    args: ['exec', '-'],
    stdin: '--help\n',
    cwd: '/srv/root/project',
  }));

  assert.ok(
    spawn.calls.some((call) => scriptOf(call) === cleanupScript),
    'a failed handoff must not leave the prompt behind',
  );
});

test('detached spawn SSH acknowledgement loss preserves deterministic ownership', async () => {
  const runId = 'spawn_ack_lost';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalStdin = `/real/root/.palantir-runs/${runId}/stdin.txt`;
  const canonicalBundle = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const cleanupScript = `exec 'rm' '-f' ${shq(canonicalStdin)} ${shq(canonicalBundle)}`;
  const ownerProbe = `exec 'tmux' 'has-session' '-t' ${shq(`palantir-run-${runId}`)}`;
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    [ownerProbe]: { code: 0 },
    [cleanupScript]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) {
      return complete(child, { code: 255, stderr: 'ssh transport lost after remote start' });
    }
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => executor.spawnWorker(runId, {
      command: 'claude',
      args: ['--print', '-p'],
      stdin: 'work',
      cwd: '/srv/root/project',
    }),
    (err) => (
      err.code === 'REMOTE_SPAWN_UNCERTAIN'
      && err.transportCode === 'SSH_TRANSPORT'
      && err.sessionName === `palantir-run-${runId}`
    ),
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call) === ownerProbe),
    false,
    'the payload was delivered, so no probe answer could change the outcome — '
      + 'do not spend a round-trip on a link that just failed',
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call) === cleanupScript),
    false,
    'a detached owner that may exist must retain prompts until its own trap removes them',
  );
});

test('detached spawn stdin EPIPE also preserves a confirmed remote owner', async () => {
  const runId = 'spawn_epipe_owner';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalStdin = `/real/root/.palantir-runs/${runId}/stdin.txt`;
  const canonicalBundle = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const cleanupScript = `exec 'rm' '-f' ${shq(canonicalStdin)} ${shq(canonicalBundle)}`;
  const ownerProbe = `exec 'tmux' 'has-session' '-t' ${shq(`palantir-run-${runId}`)}`;
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    [ownerProbe]: { code: 0 },
    [cleanupScript]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) {
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          const error = new Error('SSH stdin closed after detached start');
          error.code = 'EPIPE';
          callback(error);
        },
      });
      return;
    }
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => executor.spawnWorker(runId, {
      command: 'claude',
      args: ['--print', '-p'],
      stdin: 'work',
      cwd: '/srv/root/project',
    }),
    // An observed pane outranks the undelivered-payload proof. Retries carry a
    // fresh run id, so a session under this run's name is this run's own start.
    (err) => (
      err.code === 'REMOTE_SPAWN_UNCERTAIN'
      && err.transportCode === 'EPIPE'
      && err.sessionName === `palantir-run-${runId}`
    ),
  );
  assert.ok(spawn.calls.some((call) => scriptOf(call) === ownerProbe));
  assert.equal(
    spawn.calls.some((call) => scriptOf(call) === cleanupScript),
    false,
    'an EPIPE after start must not delete files owned by the remote pane',
  );
});

test('a stdin failure AFTER the payload was fully written stays uncertain', async () => {
  const runId = 'spawn_stdin_shutdown';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalStdin = `/real/root/.palantir-runs/${runId}/stdin.txt`;
  const canonicalBundle = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const cleanupScript = `exec 'rm' '-f' ${shq(canonicalStdin)} ${shq(canonicalBundle)}`;
  const ownerProbe = `exec 'tmux' 'has-session' '-t' ${shq(`palantir-run-${runId}`)}`;
  const completionProbe = `exec 'test' '-f' ${shq(`${statusDir}/exit.code`)}`;
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    [ownerProbe]: { code: 1 },
    [completionProbe]: { code: 1 },
    [cleanupScript]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) {
      // Every byte is accepted; only the shutdown that follows fails. The
      // remote byte-count guard therefore PASSED and `tmux new-session` may
      // already own the run, so this must not read as "never delivered".
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
          const error = new Error('socket shutdown failed after full delivery');
          error.code = 'EPIPE';
          callback(error);
        },
      });
      return;
    }
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => executor.spawnWorker(runId, {
      command: 'claude',
      args: ['--print', '-p'],
      stdin: 'work',
      cwd: '/srv/root/project',
    }),
    (err) => err.code === 'REMOTE_SPAWN_UNCERTAIN' && err.preserveRemoteFiles === true,
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call) === cleanupScript),
    false,
    'a delivered payload whose shutdown failed may already be owned by a pane',
  );
});

test('a SYNCHRONOUS end() throw after a written payload stays uncertain', async () => {
  const runId = 'spawn_stdin_sync_end';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalStdin = `/real/root/.palantir-runs/${runId}/stdin.txt`;
  const canonicalBundle = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const cleanupScript = `exec 'rm' '-f' ${shq(canonicalStdin)} ${shq(canonicalBundle)}`;
  const ownerProbe = `exec 'tmux' 'has-session' '-t' ${shq(`palantir-run-${runId}`)}`;
  const completionProbe = `exec 'test' '-f' ${shq(`${statusDir}/exit.code`)}`;
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    [ownerProbe]: { code: 1 },
    [completionProbe]: { code: 1 },
    [cleanupScript]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) {
      // The payload write is accepted; only the shutdown throws, and it throws
      // SYNCHRONOUSLY. Sharing one catch with the write would record this as an
      // undelivered payload and license a retry against a pane that may exist.
      child.stdin = {
        write(_chunk, callback) { if (typeof callback === 'function') callback(); },
        end() {
          const error = new Error('synchronous shutdown failure');
          error.code = 'EPIPE';
          throw error;
        },
        once() {},
      };
      return;
    }
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => executor.spawnWorker(runId, {
      command: 'claude',
      args: ['--print', '-p'],
      stdin: 'work',
      cwd: '/srv/root/project',
    }),
    (err) => err.code === 'REMOTE_SPAWN_UNCERTAIN' && err.preserveRemoteFiles === true,
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call) === cleanupScript),
    false,
    'a delivered payload whose shutdown threw may already be owned by a pane',
  );
});

test('a transport loss whose payload was fully delivered stays uncertain despite an absent owner', async () => {
  const runId = 'spawn_ack_lost_no_owner';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalDir = `/real/root/.palantir-runs/${runId}`;
  const canonicalStdin = `${canonicalDir}/stdin.txt`;
  const canonicalBundle = `${canonicalDir}/worker-input.bundle`;
  const ownerProbe = `exec 'tmux' 'has-session' '-t' ${shq(`palantir-run-${runId}`)}`;
  const cleanupScript = `exec 'rm' '-f' ${shq(canonicalStdin)} ${shq(canonicalBundle)}`;
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `${canonicalDir}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    [ownerProbe]: { code: 1 },
    [cleanupScript]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) {
      return complete(child, { code: 255, stderr: 'ssh transport lost before start' });
    }
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => executor.spawnWorker(runId, {
      command: 'claude',
      args: ['--print', '-p'],
      stdin: 'work',
      cwd: '/srv/root/project',
    }),
    // The exec request may have reached sshd before the acknowledgement was
    // lost. `has-session` says "not there YET"; the pane can still start after
    // the probe answers. Retrying on that answer puts a second worker in the
    // same remote cwd, so absence is never treated as proof.
    (err) => (
      err.code === 'REMOTE_SPAWN_UNCERTAIN'
      && err.transportCode === 'SSH_TRANSPORT'
      && err.preserveRemoteFiles === true
    ),
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call) === ownerProbe),
    false,
    'no probe answer could license a retry here',
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call) === cleanupScript),
    false,
    'files a possibly-live pane owns must survive for the reap path',
  );
});

test('detached spawn transport loss preserves a worker that finished before the owner probe', async () => {
  const runId = 'spawn_ack_lost_fast_finish';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalDir = `/real/root/.palantir-runs/${runId}`;
  const canonicalStdin = `${canonicalDir}/stdin.txt`;
  const canonicalBundle = `${canonicalDir}/worker-input.bundle`;
  const ownerProbe = `exec 'tmux' 'has-session' '-t' ${shq(`palantir-run-${runId}`)}`;
  const completionProbe = `exec 'test' '-f' ${shq(`${statusDir}/exit.code`)}`;
  const cleanupScript = `exec 'rm' '-f' ${shq(canonicalStdin)} ${shq(canonicalBundle)}`;
  const routes = {
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
    "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `${canonicalDir}\n` },
    "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
    [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    [ownerProbe]: { code: 1 },
    [completionProbe]: { code: 0 },
    [cleanupScript]: { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script.startsWith('umask 077 && cleanup()')) {
      return complete(child, { code: 255, stderr: 'ssh acknowledgement lost after fast completion' });
    }
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => executor.spawnWorker(runId, {
      command: 'claude',
      args: ['--print', '-p'],
      stdin: 'work',
      cwd: '/srv/root/project',
    }),
    (err) => err.code === 'REMOTE_SPAWN_UNCERTAIN' && err.preserveRemoteFiles,
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call) === completionProbe),
    false,
    'the payload was delivered, so uncertainty already holds without probing',
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call) === cleanupScript),
    false,
    'a completed detached owner must not be retried or have its artifacts swept',
  );
});

test('uncertain detached start keeps the capability in run status for later reap', async () => {
  const runId = 'spawn_ack_and_probe_lost';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const canonicalDir = `/real/root/.palantir-runs/${runId}`;
  const tokenPath = `${canonicalDir}/worker-capability`;
  const killCommand = `exec 'tmux' 'kill-session' '-t' ${shq(`palantir-run-${runId}`)}`;
  const cleanupCommand = [
    'exec',
    shq('rm'),
    shq('-f'),
    shq(`${statusDir}/stdin.txt`),
    shq(`${statusDir}/system-prompt.txt`),
    shq(`${statusDir}/worker-capability`),
    shq(`${statusDir}/worker-api-base`),
    shq(`${statusDir}/worker-input.bundle`),
    shq(`${statusDir}/result.jsonl.tmp`),
  ].join(' ');
  let afterUncertainStart = false;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    const routes = {
      "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
      "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
      "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
      [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `${canonicalDir}\n` },
      "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
      [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    };
    if (script.startsWith('umask 077 && cleanup()')) {
      afterUncertainStart = true;
      return complete(child, { code: 255, stderr: 'start acknowledgement lost' });
    }
    if (
      afterUncertainStart
      && script === `exec 'tmux' 'has-session' '-t' ${shq(`palantir-run-${runId}`)}`
    ) {
      return complete(child, { code: 255, stderr: 'probe transport lost' });
    }
    if (script === killCommand) return complete(child, { code: 1 });
    if (script === cleanupCommand) return complete(child, { code: 0 });
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => executor.spawnWorker(runId, {
      command: 'claude',
      args: ['--print', '-p'],
      cwd: '/srv/root/project',
      env: { PALANTIR_WORKER_TOKEN: 'scoped-run-token' },
    }),
    error => error.code === 'REMOTE_SPAWN_UNCERTAIN' && error.preserveRemoteFiles,
  );

  const upload = spawn.calls.find(call => scriptOf(call).startsWith('umask 077'));
  assert.equal(upload.stdin, 'scoped-run-token');
  assert.ok(scriptOf(upload).includes(tokenPath));
  assert.equal(
    spawn.calls.some(call => scriptOf(call).includes('.palantir-secret-')),
    false,
  );

  assert.equal(await executor.kill(runId), false);
  assert.ok(
    spawn.calls.some(call => scriptOf(call) === cleanupCommand),
    'ownership resolution must reap the deterministic capability path',
  );
});

test('spawnWorker accepts canonical cli worker envelope', async () => {
  const runId = 'canonical_cli';
  const spawn = workerSpawnHarness(runId);
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const result = await exec.spawnWorker(runId, {
    engine: 'cli',
    spec: {
      command: 'codex',
      args: ['--version'],
      cwd: '/srv/root/project',
      workerPath: '/home/runner/.npm-global/bin',
    },
  });

  assert.deepEqual(result, { sessionName: `palantir-run-${runId}` });
  assert.ok(spawn.calls.some((call) => scriptOf(call).includes(`tmux new-session -d -s ${shq(`palantir-run-${runId}`)}`)));
});

test('raw spawnWorker accepts a prepared stream-json spec on the durable channel', async () => {
  const spawn = simpleSpawn();
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const result = await exec.spawnWorker('claude_remote', {
    engine: 'stream-json',
    spec: { command: 'claude', args: [], cwd: '/srv/root/project' },
  });
  assert.deepEqual(result, { sessionName: 'palantir-run-claude_remote' });
  assert.ok(spawn.calls.some((call) => scriptOf(call).includes('tmux new-session')));
});

test('spawnWorker preserves direct spec backward compatibility', async () => {
  const runId = 'direct_compat';
  const spawn = workerSpawnHarness(runId);
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const result = await exec.spawnWorker(runId, {
    command: 'codex',
    args: ['--version'],
    cwd: '/srv/root/project',
  });

  assert.deepEqual(result, { sessionName: `palantir-run-${runId}` });
  assert.ok(spawn.calls.some((call) => scriptOf(call).includes(`tmux new-session -d -s ${shq(`palantir-run-${runId}`)}`)));
});

test('spawnWorker validates runId and exposed root guards for cwd and status dir', async () => {
  const invalid = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: simpleSpawn() });
  await assert.rejects(
    () => invalid.spawnWorker('bad/run', { command: 'codex', args: [], cwd: '/srv/root' }),
    /runId is not a safe token/,
  );

  const outsideCwd = rootGuardSpawn({
    "exec 'realpath' '/etc'": { stdout: '/etc\n' },
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
  });
  await assert.rejects(
    () => createRemoteSshNodeExecutor(nodeRow(), { spawnFn: outsideCwd }).spawnWorker('run2', {
      command: 'codex',
      args: [],
      cwd: '/etc',
    }),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
  assert.equal(outsideCwd.calls.some((call) => scriptOf(call).includes('tmux new-session')), false);

  const statusDir = '/srv/root/.palantir-runs/run3';
  const statusEscape = makeSpawn((call, child) => {
    const script = scriptOf(call);
    const routes = {
      "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
      "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
      "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
      "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
      [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
      [`exec 'realpath' ${shq(statusDir)}`]: { stdout: '/escape/run3\n' },
      [`exec 'rm' '-rf' ${shq(statusDir)}`]: { code: 0 },
    };
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  await assert.rejects(
    () => createRemoteSshNodeExecutor(nodeRow(), { spawnFn: statusEscape }).spawnWorker('run3', {
      command: 'codex',
      args: [],
      cwd: '/srv/root/project',
    }),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
  assert.ok(statusEscape.calls.some((call) => scriptOf(call) === `exec 'rm' '-rf' ${shq(statusDir)}`));
  assert.equal(statusEscape.calls.some((call) => scriptOf(call).includes('tmux new-session')), false);
});

test('spawnWorker validates args and workerPath before building the tmux script', async () => {
  const invalidSpawn = simpleSpawn();
  const invalid = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: invalidSpawn });

  await assert.rejects(
    () => invalid.spawnWorker('badargs1', { command: 'codex', args: null, cwd: '/srv/root' }),
    /spawnWorker args must be an array/,
  );
  await assert.rejects(
    () => invalid.spawnWorker('badargs2', { command: 'codex', args: 'x', cwd: '/srv/root' }),
    /spawnWorker args must be an array/,
  );
  await assert.rejects(
    () => invalid.spawnWorker('badstdin', { command: 'codex', args: [], stdin: Buffer.from('x'), cwd: '/srv/root' }),
    /spawnWorker stdin must be a string/,
  );
  for (const workerPath of [
    'relative/bin', '/x\nety', '',
    '/opt/bin:relative/bin', '/opt/bin:.', '/opt/bin:', ':/opt/bin',
  ]) {
    await assert.rejects(
      () => invalid.spawnWorker('badpath', { command: 'codex', args: [], cwd: '/srv/root', workerPath }),
      /spawnWorker workerPath entries must be absolute POSIX paths without control characters/,
    );
  }
  assert.equal(invalidSpawn.calls.length, 0);

  const runId = 'noargs';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    const routes = {
      "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
      "exec 'realpath' '/srv/root/project'": { stdout: '/real/root/project\n' },
      "exec 'realpath' '/srv/root/.palantir-runs'": { stdout: '/real/root/.palantir-runs\n' },
      [`exec 'realpath' ${shq(statusDir)}`]: { stdout: `/real/root/.palantir-runs/${runId}\n` },
      "exec 'mkdir' '-p' '/srv/root/.palantir-runs'": { code: 0 },
      [`exec 'mkdir' '-p' ${shq(statusDir)}`]: { code: 0 },
    };
    if (script.startsWith("cd '/real/root/project' && tmux new-session -d -s 'palantir-run-noargs' ")) {
      complete(child, { code: 0 });
      return;
    }
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['git'] });

  await exec.spawnWorker(runId, {
    command: 'codex',
    cwd: '/srv/root/project',
    workerPath: '/home/x/.npm-global/bin',
  });

  const workerScript = spawn.calls.map(scriptOf).find((script) => script.includes('tmux new-session'));
  const prefix = "cd '/real/root/project' && tmux new-session -d -s 'palantir-run-noargs' ";
  const inner = unshq(workerScript.slice(prefix.length));
  assert.ok(inner.startsWith('umask 077; set --; for k in '), inner);
  assert.ok(
    inner.endsWith(
      `env -i "$@" PATH=${shq('/home/x/.npm-global/bin')}:"$PATH" `
      + `PALANTIR_TOKEN=${shq('')} PALANTIR_PM_TOKEN=${shq('')} `
      + `PALANTIR_WORKER_TOKEN=${shq('')} PALANTIR_MANAGER_TOKEN=${shq('')} `
      + `${shq('codex')} > ${shq(`${statusDir}/stdout.log`)} `
      + `2>&1; echo $? > ${shq(`${statusDir}/exit.code`)}`,
    ),
    inner,
  );
});

test('remote worker isAlive maps tmux has-session exit codes', async () => {
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'tmux' 'has-session' '-t' 'palantir-run-live'") return complete(child, { code: 0 });
    if (script === "exec 'tmux' 'has-session' '-t' 'palantir-run-done'") return complete(child, { code: 1 });
    complete(child, { code: 1, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['git'] });

  assert.equal(await exec.isAlive('live'), true);
  assert.equal(await exec.isAlive('done'), false);
});

test('remote worker ownerOf maps live sessions to cli', async () => {
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'tmux' 'has-session' '-t' 'palantir-run-live'") return complete(child, { code: 0 });
    if (script === "exec 'tmux' 'has-session' '-t' 'palantir-run-gone'") return complete(child, { code: 1 });
    complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await exec.ownerOf('live'), 'cli');
  assert.equal(await exec.ownerOf('gone'), null);
});

test('remote worker sendInput resolves false without sending remote input', async () => {
  const spawn = simpleSpawn();
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await exec.sendInput('run7', 'hello'), false);
  assert.equal(spawn.calls.length, 0);
});

test('remote worker getOutput reads stdout log and treats missing log as empty', async () => {
  const stdoutLog = '/srv/root/.palantir-runs/run4/stdout.log';
  const spawn = rootGuardSpawn({
    [`exec 'realpath' ${shq(stdoutLog)}`]: { stdout: '/real/root/.palantir-runs/run4/stdout.log\n' },
    "exec 'tail' '-n' '2' '/real/root/.palantir-runs/run4/stdout.log'": { stdout: 'two\nthree\n' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await exec.getOutput('run4', 2), 'two\nthree\n');
  assert.ok(spawn.calls.some((call) => scriptOf(call) === "exec 'tail' '-n' '2' '/real/root/.palantir-runs/run4/stdout.log'"));

  const missing = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: rootGuardSpawn({
      "exec 'realpath' '/srv/root/.palantir-runs/missing/stdout.log'": { code: 1, stderr: 'missing' },
      "exec 'realpath' '/srv/root/.palantir-runs/missing'": { stdout: '/real/root/.palantir-runs/missing\n' },
      "exec 'tail' '-n' '200' '/srv/root/.palantir-runs/missing/stdout.log'": {
        code: 1,
        stderr: 'tail: cannot open stdout.log: No such file',
      },
    }),
  });
  assert.equal(await missing.getOutput('missing'), '');
});

test('remote worker getOutput caps remote tail lines and applies maxBuffer', async () => {
  const stdoutLog = '/srv/root/.palantir-runs/noisy/stdout.log';
  const sourceLines = Array.from({ length: 650 }, (_, index) => `line-${index + 1}`);
  const tailOutput = `${sourceLines.slice(-500).join('\n')}\n`;
  const spawn = rootGuardSpawn({
    [`exec 'realpath' ${shq(stdoutLog)}`]: { stdout: '/real/root/.palantir-runs/noisy/stdout.log\n' },
    "exec 'tail' '-n' '500' '/real/root/.palantir-runs/noisy/stdout.log'": { stdout: tailOutput },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await exec.getOutput('noisy', 2000), tailOutput);
  assert.ok(spawn.calls.some((call) => scriptOf(call) === "exec 'tail' '-n' '500' '/real/root/.palantir-runs/noisy/stdout.log'"));

  const hugeLog = '/srv/root/.palantir-runs/huge/stdout.log';
  const hugeSpawn = rootGuardSpawn({
    [`exec 'realpath' ${shq(hugeLog)}`]: { stdout: '/real/root/.palantir-runs/huge/stdout.log\n' },
    "exec 'tail' '-n' '200' '/real/root/.palantir-runs/huge/stdout.log'": { stdout: 'x'.repeat((256 * 1024) + 1) },
  });
  const huge = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: hugeSpawn });

  assert.equal(await huge.getOutput('huge'), '');
  const tailCall = hugeSpawn.calls.find((call) => scriptOf(call) === "exec 'tail' '-n' '200' '/real/root/.palantir-runs/huge/stdout.log'");
  assert.equal(tailCall.killed, 'SIGTERM');
});

function outputRangeStatFormats(script) {
  return [...script.matchAll(/stat -c '([^']+)'/g)].map((match) => match[1]);
}

function renderOutputRangeStat(format, { sourceId, size }) {
  if (sourceId === null) return 'MISSING';
  if (format === '%d:%i %s') return `${sourceId} ${size}`;
  if (format === '%d:%i') return sourceId;
  throw new Error(`unexpected stat format: ${format}`);
}

function outputRangeHarness(runId, responses, { canonicalDir } = {}) {
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const safeDir = canonicalDir || `/real/root/.palantir-runs/${runId}`;
  let frameIndex = 0;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (script === `exec 'realpath' ${shq(statusDir)}`) {
      return complete(child, { stdout: `${safeDir}\n` });
    }
    if (script.includes('stat -c ')) {
      const response = responses[Math.min(frameIndex, responses.length - 1)];
      frameIndex += 1;
      const formats = outputRangeStatFormats(script);
      const first = renderOutputRangeStat(formats[0], response.first);
      const last = renderOutputRangeStat(formats[1], response.last);
      const stdout = `${first}\n${response.sealed ? 1 : 0}\n${response.encoded}\n${last}\n`;
      return complete(child, { stdout });
    }
    return complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  return { spawn, statusDir };
}

async function realShellOutputRangeHarness(runId, initialBytes, {
  sealed = false,
  appendAfterFirstStat = '',
  omitStdout = false,
  malformedFirstStat = false,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-output-range-'));
  const statusDir = path.join(root, '.palantir-runs', runId);
  const binDir = path.join(root, 'bin');
  const stdoutLog = path.join(statusDir, 'stdout.log');
  await fs.mkdir(statusDir, { recursive: true });
  await fs.mkdir(binDir);
  if (!omitStdout) await fs.writeFile(stdoutLog, initialBytes);
  if (sealed) await fs.writeFile(path.join(statusDir, 'exit.code'), '0\n');

  const nativeStat = process.platform === 'darwin'
    ? `dev=$(/usr/bin/stat -f '%d' -- "$file") || exit $?\nino=$(/usr/bin/stat -f '%i' -- "$file") || exit $?\nsize=$(/usr/bin/stat -f '%z' -- "$file") || exit $?`
    : `dev=$(/usr/bin/stat -c '%d' -- "$file") || exit $?\nino=$(/usr/bin/stat -c '%i' -- "$file") || exit $?\nsize=$(/usr/bin/stat -c '%s' -- "$file") || exit $?`;
  const statShim = `#!/bin/sh
test "$1" = -c || exit 64
format=$2
test "$3" = -- || exit 64
file=$4
${nativeStat}
if [ -n "$STAT_APPEND_PATH" ] && [ "$file" = "$STAT_APPEND_PATH" ] && [ ! -e "$STAT_APPEND_MARKER" ]; then
  : > "$STAT_APPEND_MARKER"
  printf '%s' "$STAT_APPEND_DATA" >> "$file"
fi
case "$format" in
  '%d:%i %s') if [ -n "$STAT_MALFORMED_FIRST" ]; then printf 'garbage\n'; else printf '%s:%s %s\n' "$dev" "$ino" "$size"; fi ;;
  '%d:%i') printf '%s:%s\n' "$dev" "$ino" ;;
  *) exit 65 ;;
esac
`;
  const statPath = path.join(binDir, 'stat');
  await fs.writeFile(statPath, statShim, { mode: 0o755 });

  const shellResults = [];
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === `exec 'realpath' ${shq(root)}`) return complete(child, { stdout: `${root}\n` });
    if (script === `exec 'realpath' ${shq(statusDir)}`) return complete(child, { stdout: `${statusDir}\n` });
    if (script.includes('stat -c ')) {
      const result = childProcess.spawnSync('/bin/sh', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          STAT_APPEND_PATH: appendAfterFirstStat ? stdoutLog : '',
          STAT_APPEND_MARKER: path.join(root, 'appended'),
          STAT_APPEND_DATA: appendAfterFirstStat,
          STAT_MALFORMED_FIRST: malformedFirstStat ? '1' : '',
        },
      });
      shellResults.push(result);
      return complete(child, { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr });
    }
    return complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow({ exposed_roots: JSON.stringify([root]) }), { spawnFn: spawn });
  return { exec, root, stdoutLog, spawn, shellResults };
}

test('remote worker readOutputRange preserves raw bytes, cut-off, has_more, and sealed state', async () => {
  const bytes = Buffer.from([0x61, 0xff, 0x80, 0x00, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67]);
  const { spawn } = outputRangeHarness('range', [
    { first: { sourceId: '7:9', size: 20 }, sealed: false, encoded: bytes.toString('base64'), last: { sourceId: '7:9', size: 99 } },
    { first: { sourceId: '7:9', size: 20 }, sealed: true, encoded: bytes.toString('base64'), last: { sourceId: '7:9', size: 99 } },
  ]);
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const first = await exec.readOutputRange('range', { after: 3, maxBytes: 10 });
  assert.deepEqual(first.data, bytes);
  assert.equal(first.source_id, '7:9');
  assert.equal(first.next_offset, 3 + bytes.length);
  assert.equal(first.end_offset, 20, 'cut-off must remain the first stat size');
  assert.equal(first.has_more, true);
  assert.equal(first.sealed, false);
  assert.equal(first.missing, false);

  const callsBeforePoll = spawn.calls.length;
  const second = await exec.readOutputRange('range', { after: 3, maxBytes: 10 });
  assert.equal(second.sealed, true);
  assert.equal(spawn.calls.length - callsBeforePoll, 1, 'cached-path poll must use one SSH spawn');
  const pollScript = scriptOf(spawn.calls.at(-1));
  assert.deepEqual(outputRangeStatFormats(pollScript), ['%d:%i %s', '%d:%i']);
  assert.match(pollScript, /tail -c \+4 -- '\/real\/root\/\.palantir-runs\/range\/stdout\.log'/);
  assert.match(pollScript, /head -c "\$want"/);
});

test('remote worker readOutputRange discards bytes when the output generation changes', async () => {
  const encoded = Buffer.from('old generation').toString('base64');
  const { spawn } = outputRangeHarness('changed', [
    { first: { sourceId: '1:2', size: 50 }, sealed: false, encoded, last: { sourceId: '1:3', size: 50 } },
  ]);
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const result = await exec.readOutputRange('changed', { after: 8, maxBytes: 32 });
  assert.equal(result.generation_changed, true);
  assert.equal(result.deleted, false);
  assert.deepEqual(result.data, Buffer.alloc(0));
  assert.equal(result.next_offset, 0);
  assert.equal(result.end_offset, 50);
});

test('remote worker readOutputRange distinguishes deletion during read from generation change', async () => {
  const { spawn } = outputRangeHarness('deleted-range', [
    { first: { sourceId: '1:2', size: 50 }, sealed: false, encoded: '', last: { sourceId: null, size: 0 } },
  ]);
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const result = await exec.readOutputRange('deleted-range', { after: 8, maxBytes: 32 });
  assert.equal(result.deleted, true);
  assert.equal(result.generation_changed, false);
  assert.equal(result.source_id, '1:2');
  assert.deepEqual(result.data, Buffer.alloc(0));
  assert.equal(result.next_offset, 0);
});

test('remote worker readOutputRange treats a final-stat deletion race as deleted and discards data', async () => {
  const runId = 'deleted-stat-race';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (script === `exec 'realpath' ${shq(statusDir)}`) {
      return complete(child, { stdout: `/real/root/.palantir-runs/${runId}\n` });
    }
    if (script.includes('stat -c ')) {
      const raceRecovered = script.includes(`elif [ ! -e '/real/root/.palantir-runs/${runId}/stdout.log' ]; then echo MISSING`);
      return complete(child, raceRecovered
        ? { stdout: `1:2 12\n0\n${Buffer.from('data').toString('base64')}\nMISSING\n` }
        : { code: 1, stderr: 'stat: stdout.log: No such file' });
    }
    return complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const result = await exec.readOutputRange(runId, { after: 8, maxBytes: 32 });
  assert.equal(result.deleted, true);
  assert.deepEqual(result.data, Buffer.alloc(0));
  assert.equal(result.next_offset, 0);
});

test('remote worker readOutputRange rejects a final-stat failure when the file still exists', async () => {
  const runId = 'failed-final-stat';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (script === `exec 'realpath' ${shq(statusDir)}`) {
      return complete(child, { stdout: `/real/root/.palantir-runs/${runId}\n` });
    }
    if (script.includes('stat -c ')) {
      const preservesFailure = script.includes(`elif [ ! -e '/real/root/.palantir-runs/${runId}/stdout.log' ]; then echo MISSING`);
      return complete(child, preservesFailure
        ? { code: 13, stderr: 'stat: stdout.log: Permission denied' }
        : { stdout: `1:2 12\n0\n${Buffer.from('data').toString('base64')}\nMISSING\n` });
    }
    return complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => exec.readOutputRange(runId, { after: 8, maxBytes: 32 }),
    (err) => err.code === 13 && err.stderr === 'stat: stdout.log: Permission denied',
  );
});

test('remote worker readOutputRange maps the malformed-first-stat guard to OUTPUT_FRAME_INVALID', async () => {
  const runId = 'malformed-first-stat';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (script === `exec 'realpath' ${shq(statusDir)}`) {
      return complete(child, { stdout: `/real/root/.palantir-runs/${runId}\n` });
    }
    if (script.includes('stat -c ')) {
      assert.match(script, /case "\$first_size" in ''\|\*\[!0-9\]\*\) echo 'OUTPUT_FRAME_INVALID:first-stat' >&2; exit 90;; esac/);
      return complete(child, { code: 90, stdout: 'garbage\n', stderr: 'OUTPUT_FRAME_INVALID:first-stat\n' });
    }
    return complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => exec.readOutputRange(runId, { after: 0, maxBytes: 32 }),
    (err) => err.code === 'OUTPUT_FRAME_INVALID',
  );
});

test('remote worker readOutputRange treats exit 90 without the marker as commandError', async () => {
  const runId = 'unmarked-exit-90';
  const statusDir = `/srv/root/.palantir-runs/${runId}`;
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (script === `exec 'realpath' ${shq(statusDir)}`) {
      return complete(child, { stdout: `/real/root/.palantir-runs/${runId}\n` });
    }
    if (script.includes('stat -c ')) return complete(child, { code: 90, stderr: 'stat failed\n' });
    return complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => exec.readOutputRange(runId, { after: 0, maxBytes: 32 }),
    (err) => err.code === 90 && err.stderr === 'stat failed\n',
  );
});

test('remote worker readOutputRange reports a missing initial stdout log without throwing', async () => {
  const { spawn } = outputRangeHarness('missing-range', [
    { first: { sourceId: null, size: 0 }, sealed: true, encoded: '', last: { sourceId: null, size: 0 } },
  ]);
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.deepEqual(await exec.readOutputRange('missing-range', { after: 7, maxBytes: 16 }), {
    source_id: null,
    data: Buffer.alloc(0),
    next_offset: 7,
    end_offset: 0,
    has_more: false,
    sealed: true,
    generation_changed: false,
    deleted: false,
    missing: true,
  });
});

test('remote worker readOutputRange accepts empty data for zero maxBytes and a cursor past EOF', async () => {
  const { spawn } = outputRangeHarness('empty-range', [
    { first: { sourceId: '4:8', size: 12 }, sealed: false, encoded: '', last: { sourceId: '4:8', size: 12 } },
    { first: { sourceId: '4:8', size: 12 }, sealed: true, encoded: '', last: { sourceId: '4:8', size: 12 } },
  ]);
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  const zeroMax = await exec.readOutputRange('empty-range', { after: 5, maxBytes: 0 });
  assert.deepEqual(zeroMax.data, Buffer.alloc(0));
  assert.equal(zeroMax.next_offset, 5);
  assert.equal(zeroMax.has_more, true);

  const pastEof = await exec.readOutputRange('empty-range', { after: 20, maxBytes: 8 });
  assert.deepEqual(pastEof.data, Buffer.alloc(0));
  assert.equal(pastEof.next_offset, 20);
  assert.equal(pastEof.end_offset, 12);
  assert.equal(pastEof.has_more, false);
});

test('remote worker readOutputRange rejects all invalid base64 and range frame variants', async () => {
  const cases = [
    ['non-canonical padding', 'YQ===', 8, 10],
    ['invalid base64 character', 'YQ?=', 8, 10],
    ['decoded range over maxBytes', Buffer.from('ab').toString('base64'), 1, 10],
    ['decoded range over cut-off', Buffer.from('ab').toString('base64'), 8, 1],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [label, encoded, maxBytes, endOffset] = cases[index];
    const runId = `bad-frame-${index}`;
    const { spawn } = outputRangeHarness(runId, [
      { first: { sourceId: '2:4', size: endOffset }, sealed: false, encoded, last: { sourceId: '2:4', size: endOffset } },
    ]);
    const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
    await assert.rejects(
      () => exec.readOutputRange(runId, { after: 0, maxBytes }),
      (err) => err.code === 'OUTPUT_FRAME_INVALID',
      label,
    );
  }
});

test('remote worker readOutputRange rejects a short read from an otherwise stable generation', async () => {
  const { spawn } = outputRangeHarness('short-range', [{
    first: { sourceId: '2:4', size: 10 },
    sealed: false,
    encoded: Buffer.from('short').toString('base64'),
    last: { sourceId: '2:4', size: 10 },
  }]);
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await assert.rejects(
    () => exec.readOutputRange('short-range', { after: 0, maxBytes: 10 }),
    (err) => err.code === 'OUTPUT_FRAME_INVALID',
  );
});

test('remote worker readOutputRange emitted script runs in /bin/sh with binary data and a fixed first-stat cut-off', async (t) => {
  const initial = Buffer.from([0x61, 0xff, 0x80, 0x00, 0x62, 0x63]);
  const harness = await realShellOutputRangeHarness('real-shell-range', initial, {
    sealed: true,
    appendAfterFirstStat: 'APPENDED',
  });
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));

  const result = await harness.exec.readOutputRange('real-shell-range', { after: 1, maxBytes: 256 });
  assert.deepEqual(result.data, initial.subarray(1));
  assert.equal(result.end_offset, initial.length);
  assert.equal(result.next_offset, initial.length);
  assert.equal(result.sealed, true);
  assert.equal(result.generation_changed, false);
  assert.equal(result.deleted, false);
  assert.equal(harness.shellResults[0].stdout.split('\n').length, 5, 'four lines plus the trailing split field');
});

test('remote worker readOutputRange emitted script rejects malformed stat before arithmetic', async (t) => {
  const harness = await realShellOutputRangeHarness('real-shell-malformed-stat', Buffer.from('abc'), {
    malformedFirstStat: true,
  });
  t.after(() => fs.rm(harness.root, { recursive: true, force: true }));

  await assert.rejects(
    () => harness.exec.readOutputRange('real-shell-malformed-stat', { after: 0, maxBytes: 8 }),
    (err) => err.code === 'OUTPUT_FRAME_INVALID',
  );
  assert.equal(harness.shellResults[0].status, 90);
  assert.equal(harness.shellResults[0].stderr, 'OUTPUT_FRAME_INVALID:first-stat\n');
});

test('remote worker readOutputRange emitted script handles EOF, head -c 0, and the MISSING four-line frame', async (t) => {
  const eofHarness = await realShellOutputRangeHarness('real-shell-eof', Buffer.from('abc'));
  const zeroHarness = await realShellOutputRangeHarness('real-shell-zero', Buffer.from('abc'));
  const missingHarness = await realShellOutputRangeHarness('real-shell-missing', Buffer.alloc(0), { omitStdout: true });
  t.after(() => Promise.all([eofHarness.root, zeroHarness.root, missingHarness.root]
    .map((root) => fs.rm(root, { recursive: true, force: true }))));

  assert.deepEqual((await eofHarness.exec.readOutputRange('real-shell-eof', { after: 9, maxBytes: 8 })).data, Buffer.alloc(0));
  assert.deepEqual((await zeroHarness.exec.readOutputRange('real-shell-zero', { after: 1, maxBytes: 0 })).data, Buffer.alloc(0));
  const missing = await missingHarness.exec.readOutputRange('real-shell-missing', { after: 2, maxBytes: 8 });
  assert.equal(missing.missing, true);
  assert.equal(missingHarness.shellResults[0].stdout, 'MISSING\n0\n\nMISSING\n');
  assert.equal(missingHarness.shellResults[0].stdout.split('\n').length, 5, 'four lines plus the trailing split field');
});

test('remote worker readOutputRange validates offsets and guards the status directory', async () => {
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: simpleSpawn() });
  await assert.rejects(() => exec.readOutputRange('range', { after: -1, maxBytes: 1 }), TypeError);
  await assert.rejects(() => exec.readOutputRange('range', { after: Number.NaN, maxBytes: 1 }), TypeError);

  const { spawn } = outputRangeHarness('escaped-range', [{
    first: { sourceId: null, size: 0 }, sealed: false, encoded: '', last: { sourceId: null, size: 0 },
  }], {
    canonicalDir: '/outside/status',
  });
  const escaped = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await assert.rejects(
    () => escaped.readOutputRange('escaped-range', { after: 0, maxBytes: 1 }),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
  assert.equal(spawn.calls.some((call) => scriptOf(call).includes("stat -c '%d:%i %s'")), false);
});

test('remote worker getStructuredResult reads the durable final result record', async () => {
  const resultPath = '/srv/root/.palantir-runs/structured/result.jsonl';
  const payload = JSON.stringify({
    type: 'result',
    stop_reason: 'max_turns',
    result: 'x'.repeat(300 * 1024),
    usage: { input_tokens: 10, output_tokens: 20 },
  }) + '\n';
  const spawn = rootGuardSpawn({
    [`exec 'realpath' ${shq(resultPath)}`]: {
      stdout: '/real/root/.palantir-runs/structured/result.jsonl\n',
    },
    "exec 'cat' '/real/root/.palantir-runs/structured/result.jsonl'": {
      stdout: payload,
    },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await exec.getStructuredResult('structured'), payload);
});

test('remote worker getStructuredResult applies maxBuffer', async () => {
  const resultPath = '/srv/root/.palantir-runs/huge-result/result.jsonl';
  const spawn = rootGuardSpawn({
    [`exec 'realpath' ${shq(resultPath)}`]: {
      stdout: '/real/root/.palantir-runs/huge-result/result.jsonl\n',
    },
    "exec 'cat' '/real/root/.palantir-runs/huge-result/result.jsonl'": {
      stdout: 'x'.repeat((4 * 1024 * 1024) + 1),
    },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await exec.getStructuredResult('huge-result'), '');
  const catCall = spawn.calls.find((call) => (
    scriptOf(call) === "exec 'cat' '/real/root/.palantir-runs/huge-result/result.jsonl'"
  ));
  assert.equal(catCall.killed, 'SIGTERM');
});

test('remote worker detectExitCode reads sentinel and treats missing sentinel as running', async () => {
  const exitSentinel = '/srv/root/.palantir-runs/run5/exit.code';
  const spawn = rootGuardSpawn({
    [`exec 'realpath' ${shq(exitSentinel)}`]: { stdout: '/real/root/.palantir-runs/run5/exit.code\n' },
    "exec 'cat' '/real/root/.palantir-runs/run5/exit.code'": { stdout: '7\n' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await exec.detectExitCode('run5'), 7);

  const missing = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: rootGuardSpawn({
      "exec 'realpath' '/srv/root/.palantir-runs/running/exit.code'": { code: 1, stderr: 'missing' },
    }),
  });
  assert.equal(await missing.detectExitCode('running'), null);
});

test('remote worker detectExitCode strictly parses POSIX exit codes', async () => {
  const cases = [
    ['0', 0],
    ['7', 7],
    ['255', 255],
    ['7garbage', null],
    ['7\njunk', null],
    ['  7 x', null],
    ['999', null],
    ['-1', null],
    ['', null],
    [' ', null],
  ];

  for (let i = 0; i < cases.length; i += 1) {
    const [content, expected] = cases[i];
    const runId = `strict_${i}`;
    const exitSentinel = `/srv/root/.palantir-runs/${runId}/exit.code`;
    const spawn = rootGuardSpawn({
      [`exec 'realpath' ${shq(exitSentinel)}`]: { stdout: `/real/root/.palantir-runs/${runId}/exit.code\n` },
      [`exec 'cat' '/real/root/.palantir-runs/${runId}/exit.code'`]: { stdout: content },
    });
    const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

    assert.equal(await exec.detectExitCode(runId), expected, JSON.stringify(content));
  }
});

test('remote worker methods ignore trailing engine argument', async () => {
  const stdoutLog = '/srv/root/.palantir-runs/out/stdout.log';
  const exitSentinel = '/srv/root/.palantir-runs/exit/exit.code';
  const routes = {
    "exec 'tmux' 'has-session' '-t' 'palantir-run-live'": { code: 0 },
    "exec 'realpath' '/srv/root'": { stdout: '/real/root\n' },
    [`exec 'realpath' ${shq(stdoutLog)}`]: { stdout: '/real/root/.palantir-runs/out/stdout.log\n' },
    "exec 'tail' '-n' '3' '/real/root/.palantir-runs/out/stdout.log'": { stdout: 'a\nb\nc\n' },
    [`exec 'realpath' ${shq(exitSentinel)}`]: { stdout: '/real/root/.palantir-runs/exit/exit.code\n' },
    "exec 'cat' '/real/root/.palantir-runs/exit/exit.code'": { stdout: '42\n' },
    "exec 'tmux' 'kill-session' '-t' 'palantir-run-killme'": { code: 0 },
  };
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (Object.hasOwn(routes, script)) return complete(child, routes[script]);
    complete(child, { code: 255, stderr: `unexpected script: ${script}` });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await exec.isAlive('live', 'cli'), true);
  assert.equal(await exec.detectExitCode('exit', 'cli'), 42);
  assert.equal(await exec.getOutput('out', 3, 'cli'), 'a\nb\nc\n');
  assert.equal(await exec.kill('killme', 'cli'), true);
  assert.ok(spawn.calls.some((call) => scriptOf(call) === "exec 'tail' '-n' '3' '/real/root/.palantir-runs/out/stdout.log'"));
  assert.ok(spawn.calls.some((call) => scriptOf(call) === "exec 'tmux' 'kill-session' '-t' 'palantir-run-killme'"));
});

test('state 5: terminal remote run cleanup reaps only its guarded statusDir', async () => {
  const statusDir = '/srv/root/.palantir-runs/run6';
  const spawn = rootGuardSpawn({
    [`exec 'tmux' 'kill-session' '-t' 'palantir-run-run6'`]: { code: 0 },
    [`exec 'realpath' ${shq(statusDir)}`]: { stdout: '/real/root/.palantir-runs/run6\n' },
    "exec 'rm' '-rf' '/real/root/.palantir-runs/run6'": { code: 0 },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await exec.kill('run6'), true);
  await exec.cleanupRun('run6');
  assert.ok(spawn.calls.some((call) => scriptOf(call) === `exec 'tmux' 'kill-session' '-t' 'palantir-run-run6'`));
  assert.ok(spawn.calls.some((call) => scriptOf(call) === "exec 'rm' '-rf' '/real/root/.palantir-runs/run6'"));

  const escape = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: rootGuardSpawn({
      "exec 'realpath' '/srv/root/.palantir-runs/escape'": { stdout: '/escape/run\n' },
    }),
  });
  await assert.rejects(
    () => escape.cleanupRun('escape'),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
});

test('remote cleanup fail-safe preserves statusDir on SSH transport failure', async () => {
  const statusDir = '/srv/root/.palantir-runs/transport-failure';
  const spawn = rootGuardSpawn({
    [`exec 'realpath' ${shq(statusDir)}`]: { code: 255, stderr: 'connection lost' },
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    () => exec.cleanupRun('transport-failure'),
    (err) => err.code === 'SSH_TRANSPORT',
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call).includes("'rm' '-rf'")),
    false,
    'transport uncertainty must not issue a delete command',
  );
});

test('remote cleanup fail-safe preserves statusDir when SSH inspection times out', async () => {
  const statusDir = '/srv/root/.palantir-runs/timeout';
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === `exec 'realpath' ${shq(statusDir)}`) return;
    complete(child, { code: 0 });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    connectTimeoutMs: 20,
  });

  await assert.rejects(
    () => exec.cleanupRun('timeout'),
    (err) => err.code === 'ETIMEDOUT',
  );
  assert.equal(
    spawn.calls.some((call) => scriptOf(call).includes("'rm' '-rf'")),
    false,
    'timeout uncertainty must not issue a delete command',
  );
});

test('creation targets are revalidated after writeTempFile and mkdir', async () => {
  const writeSpawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (script === "exec 'realpath' '/srv/root/tmp-abc/payload.txt'") return complete(child, { stdout: '/escape/payload.txt\n' });
    if (script === "exec 'rm' '-rf' '/srv/root/tmp-abc'") return complete(child, { code: 0 });
    child.stdin.on('finish', () => complete(child, { stdout: '/srv/root/tmp-abc/payload.txt\n' }));
  });
  const writeExec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: writeSpawn });
  await assert.rejects(
    () => writeExec.writeTempFile('/srv/root/tmp-', 'payload.txt', 'secret'),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
  assert.ok(writeSpawn.calls.some((call) => scriptOf(call) === "exec 'rm' '-rf' '/srv/root/tmp-abc'"));

  const mkdirSpawn = rootGuardSpawn({
    "exec 'realpath' '/srv/root/link'": { stdout: '/real/root/link\n' },
    "exec 'mkdir' '/srv/root/link/new'": { code: 0 },
    "exec 'realpath' '/srv/root/link/new'": { stdout: '/escape/new\n' },
    "exec 'rm' '-rf' '/srv/root/link/new'": { code: 0 },
  });
  const mkdirExec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: mkdirSpawn });
  await assert.rejects(
    () => mkdirExec.mkdir('/srv/root/link/new'),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
  assert.ok(mkdirSpawn.calls.some((call) => scriptOf(call) === "exec 'rm' '-rf' '/srv/root/link/new'"));
});

test('exec maxBuffer slices by byte length before utf8 decode', async () => {
  const spawn = makeSpawn((_call, child) => {
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('€€', 'utf8'));
      child.emit('close', 0, null);
    });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn, commandAllowlist: ['printf'] });
  await assert.rejects(
    () => exec.exec('printf', [], { maxBuffer: 4 }),
    (err) => err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && err.stdout !== '€€',
  );
  assert.equal(spawn.calls[0].killed, 'SIGTERM');
});

test('fileExists missing paths prove nearest existing ancestor is inside exposed_roots', async () => {
  const spawn = makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/etc/missing'") return complete(child, { code: 1, stderr: 'missing' });
    if (script === "exec 'realpath' '/etc'") return complete(child, { stdout: '/etc\n' });
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    complete(child, { code: 1 });
  });
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await assert.rejects(
    () => exec.fileExists('/etc/missing'),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
});

test('nodeService.pickExecutor rejects ssh nodes that cannot host execution', async (t) => {
  const db = await mkdb(t);
  let remoteCreateCount = 0;
  const nodeService = createNodeService(db, {
    localExecutor: { local: true },
    createRemoteExecutor() {
      remoteCreateCount += 1;
      return { remote: true };
    },
  });

  nodeService.createNode({
    id: 'no-exec',
    name: 'No Exec',
    kind: 'ssh',
    can_execute: false,
    ssh_host: 'pod.example',
    ssh_user: 'runner',
    exposed_roots: ['/srv/root'],
  });
  nodeService.createNode({
    id: 'files-only',
    name: 'Files Only',
    kind: 'ssh',
    can_execute: false,
    files_only: true,
    ssh_host: 'pod2.example',
    ssh_user: 'runner',
    exposed_roots: ['/srv/root'],
  });

  assert.throws(() => nodeService.pickExecutor('no-exec'), /cannot host execution/);
  assert.throws(() => nodeService.pickExecutor('files-only'), /cannot host execution/);
  assert.equal(remoteCreateCount, 0);
});

test('nodeService.pickExecutor selects local and caches ssh executors until updateNode evicts', async (t) => {
  const db = await mkdb(t);
  const localExecutor = { local: true };
  const created = [];
  const nodeService = createNodeService(db, {
    localExecutor,
    createRemoteExecutor(node) {
      const executor = { nodeId: node.id, created: created.length + 1 };
      created.push({ node, executor });
      return executor;
    },
  });

  assert.equal(nodeService.pickExecutor(null), localExecutor);
  assert.equal(nodeService.pickExecutor('local'), localExecutor);

  nodeService.createNode({
    id: 'local-alias',
    name: 'Local Alias',
    kind: 'local',
    reachable: true,
  });
  assert.equal(nodeService.pickExecutor('local-alias'), localExecutor);

  nodeService.createNode({
    id: 'pod-a',
    name: 'Pod A',
    kind: 'ssh',
    ssh_host: 'pod.example',
    ssh_user: 'runner',
    exposed_roots: ['/srv/root'],
  });
  const first = nodeService.pickExecutor('pod-a');
  const second = nodeService.pickExecutor('pod-a');
  assert.equal(first, second);
  assert.equal(created.length, 1);

  nodeService.updateNode('pod-a', { ssh_host: 'pod2.example' });
  const third = nodeService.pickExecutor('pod-a');
  assert.notEqual(third, first);
  assert.equal(created.length, 2);
  assert.equal(created[1].node.ssh_host, 'pod2.example');

  assert.throws(() => nodeService.pickExecutor('missing'), /Node not found/);
});

test('readClaudeOAuthUsage runs a fixed script with no caller interpolation', async () => {
  const captured = [];
  const executor = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: (cmd, args) => {
      captured.push({ cmd, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => {} };
      process.nextTick(() => {
        child.stdout.emit('data', '{"five_hour":{"utilization":10}}');
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const res = await executor.readClaudeOAuthUsage({ timeoutMs: 1000 });
  assert.equal(res.code, 0);
  assert.equal(captured.length, 1);
  const script = captured[0].args[captured[0].args.length - 1];
  // Fixed pod-side script: reads pod credentials, calls the OAuth usage
  // endpoint from the pod. The token must never be part of the client-side
  // command line — only the constant script is.
  assert.ok(script.includes('api.anthropic.com'));
  assert.ok(script.includes('/api/oauth/usage'));
  assert.ok(script.includes('.claude/.credentials.json'));
  assert.ok(script.includes('__NO_CLAUDE_TOKEN__'));
  assert.ok(!script.includes('Bearer sk'), 'no literal token on the client side');
  // R1 BLOCKER regression: the probe must not shell out to curl — a pod-local
  // ~/.curlrc (e.g. trace-ascii) could echo the Authorization header back.
  assert.ok(!/\bcurl\b/.test(script), 'probe must not use curl');
});

test('readClaudeOAuthUsage injects pathPrefix as PATH prepend without altering the fixed JS body', async () => {
  // Real-node-usage regression: the pod's `node` often lives outside the
  // minimal non-interactive-ssh PATH (Homebrew/nvm/npm-global) — without a
  // pathPrefix the probe exits 127 even when node_prefix is configured on
  // the node row, since this script previously never threaded pathPrefix
  // through at all (unlike every other remote command).
  const spawn = makeSpawn((_call, child) => complete(child, { code: 0, stdout: '{"five_hour":{"utilization":10}}' }));
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await exec.readClaudeOAuthUsage({ timeoutMs: 1000, pathPrefix: '/Users/K/.local/bin:/opt/homebrew/bin' });
  const script = scriptOf(spawn.calls.at(-1));
  assert.ok(
    script.startsWith(`exec env PATH=${shq('/Users/K/.local/bin:/opt/homebrew/bin')}:$PATH node -e '`),
    `expected PATH prepend before the fixed node invocation, got: ${script.slice(0, 120)}`,
  );
  // The security-hardened JS body itself must be byte-identical to the
  // no-pathPrefix case — only the outer `exec` wrapper changes.
  assert.ok(script.includes('api.anthropic.com'));
  assert.ok(script.includes('/api/oauth/usage'));
  assert.ok(script.includes('__NO_CLAUDE_TOKEN__'));
  assert.ok(!/\bcurl\b/.test(script), 'probe must not use curl');
});

test('readClaudeOAuthUsage rejects relative/control-char/non-string pathPrefix (PATH-trust guard)', async () => {
  const spawn = makeSpawn(() => {});
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  for (const bad of [
    '.', 'relative/bin', '', '/x\nety', '/x\x00y', 123, {},
    // Colon-joined multi-path prefixes with a relative segment must be
    // rejected too — isAbsolute() on the whole string only sees the first
    // char, so '/opt/bin:relative/bin' previously slipped through and let
    // the remote CWD supply the `node` this OAuth-token-reading script runs
    // (Codex adversarial review catch).
    '/opt/bin:relative/bin', '/opt/bin:.', '/opt/bin:', ':/opt/bin',
  ]) {
    await assert.rejects(
      () => exec.readClaudeOAuthUsage({ timeoutMs: 1000, pathPrefix: bad }),
      /pathPrefix must be one or more absolute POSIX paths/,
    );
  }
});

test('readClaudeOAuthUsage with no pathPrefix runs the script unchanged (back-compat)', async () => {
  const spawn = makeSpawn((_call, child) => complete(child, { code: 0, stdout: '{"five_hour":{"utilization":10}}' }));
  const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
  await exec.readClaudeOAuthUsage({ timeoutMs: 1000 });
  const script = scriptOf(spawn.calls.at(-1));
  assert.ok(script.startsWith("exec node -e '"), 'no pathPrefix means the original exec form is untouched');
});

test('readClaudeVersion probes the selected pod with its node_prefix', async () => {
  const spawn = makeSpawn((_call, child) => complete(child, {
    code: 0,
    stdout: '2.1.42 (Claude Code)\\n',
  }));
  const exec = createRemoteSshNodeExecutor(nodeRow({
    node_prefix: '/opt/claude/bin:/usr/local/bin',
  }), { spawnFn: spawn });

  assert.equal(await exec.readClaudeVersion(), '2.1.42');
  assert.equal(
    scriptOf(spawn.calls.at(-1)),
    `exec env PATH=${shq('/opt/claude/bin:/usr/local/bin')}:"$PATH" claude --version`,
  );
});

test('readClaudeVersion rejects untrusted path segments and returns null for bad output', async () => {
  const spawn = makeSpawn((_call, child) => complete(child, {
    code: 0,
    stdout: 'unknown version\\n',
  }));
  const exec = createRemoteSshNodeExecutor(nodeRow({ node_prefix: null }), { spawnFn: spawn });

  await assert.rejects(
    () => exec.readClaudeVersion({ pathPrefix: '/opt/claude/bin:relative/bin' }),
    /pathPrefix must be one or more absolute POSIX paths/,
  );
  assert.equal(await exec.readClaudeVersion({ pathPrefix: '/opt/claude/bin' }), null);
});
