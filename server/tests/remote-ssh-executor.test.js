const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRemoteSshNodeExecutor, shq } = require('../services/remoteSshExecutor');
const { createNodeService } = require('../services/nodeService');

function nodeRow(fields = {}) {
  return {
    id: 'pod-a',
    kind: 'ssh',
    ssh_host: 'pod.example',
    ssh_user: 'runner',
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
    if (arg === '-o') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (arg.includes('@')) return i;
  }
  throw new Error(`ssh destination not found in args: ${JSON.stringify(args)}`);
}

function remoteCommandArgsOf(call) {
  return call.args.slice(sshDestinationIndex(call.args) + 1);
}

function remoteCommandOf(call) {
  const remoteArgs = remoteCommandArgsOf(call);
  assert.equal(remoteArgs.length, 1);
  return remoteArgs[0];
}

function scriptOf(call) {
  const command = remoteCommandOf(call);
  const prefix = 'sh -c ';
  assert.ok(command.startsWith(prefix), `unexpected ssh remote command: ${command}`);
  return unshq(command.slice(prefix.length));
}

function loopbackSshSpawn() {
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
    return childProcess.spawn('sh', ['-c', joined], { stdio: ['pipe', 'pipe', 'pipe'] });
  }
  spawn.calls = calls;
  return spawn;
}

function simpleSpawn(response = { code: 0, stdout: '', stderr: '' }) {
  return makeSpawn((_call, child) => complete(child, response));
}

function rootGuardSpawn(routes = {}) {
  return makeSpawn((call, child) => {
    const script = scriptOf(call);
    if (script === "exec 'realpath' '/srv/root'") return complete(child, { stdout: '/real/root\n' });
    if (routes[script]) return complete(child, routes[script]);
    complete(child, { code: 0 });
  });
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
  const script = scriptOf(call);
  assert.deepEqual(call.args.slice(8), [`sh -c ${shq(script)}`]);
  assert.match(script, /^exec env /);
  assert.match(script, /LC_ALL='C'/);
  assert.match(script, /LANG='en'\\''US'/);
  assert.match(script, /SAFE='\$\(literal\)'/);
  assert.match(script, /'say'\\''hi'/);
  for (const arg of args) assert.ok(script.includes(shq(arg)), `missing quoted arg ${arg}`);
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
  assert.deepEqual(spawn.calls[0].remoteCommandArgs, [`sh -c ${shq("exec 'echo' 'fleet-ok'")}`]);
  assert.equal(spawn.calls[0].joined, `sh -c ${shq("exec 'echo' 'fleet-ok'")}`);
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
  assert.equal(scriptOf(spawn.calls.at(-1)), "cd '/real/root/project' && exec 'pwd'");
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
  assert.doesNotMatch(scriptOf(writeCall), /secret-content/);
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
  assert.equal(scriptOf(spawn.calls[0]), "exec 'git' 'status'");

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

test('remote exec serializes only explicit env keys and validates key syntax', async () => {
  const oldSecret = process.env.REMOTE_EXEC_FAKE_CONTROLLER_SECRET;
  process.env.REMOTE_EXEC_FAKE_CONTROLLER_SECRET = 'do-not-forward';
  try {
    const spawn = simpleSpawn({ code: 0 });
    const exec = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });
    await exec.exec('git', ['status'], { env: { LC_ALL: 'C' } });
    const script = scriptOf(spawn.calls[0]);
    assert.match(script, /^exec env LC_ALL='C' 'git' 'status'$/);
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
