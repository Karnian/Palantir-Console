const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createLocalNodeExecutor,
  createLocalWorkerChannel,
  createRemoteWorkerChannel,
} = require('../services/nodeExecutor');
const { createWorktreeService } = require('../services/worktreeService');
const { createFsService } = require('../services/fsService');
const {
  EXEC_ENV_KEYS,
  PROJECT_TEST_ENV_KEYS,
  GIT_ENV_ALLOWLIST_VARIABLE,
  PROJECT_TEST_ENV_ALLOWLIST_VARIABLE,
  buildExecEnv,
  buildProjectTestEnv,
} = require('../services/execEnvPolicy');

test('LocalNodeExecutor resolves the current absolute Node runtime for MCP wrappers', () => {
  const executor = createLocalNodeExecutor();
  assert.equal(executor.resolveNodeRuntime(), process.execPath);
  assert.equal(path.isAbsolute(executor.resolveNodeRuntime()), true);
});

test('createLocalWorkerChannel dispatches spawnWorker by engine and passes specs through', () => {
  const calls = [];
  const streamSpec = { prompt: 'hello' };
  const cliSpec = { command: 'codex', args: ['run'] };
  const channel = createLocalWorkerChannel({
    streamJsonEngine: {
      spawnAgent(runId, spec) {
        calls.push({ engine: 'stream-json', runId, spec });
        return { sessionName: null };
      },
    },
    executionEngine: {
      spawnAgent(runId, spec) {
        calls.push({ engine: 'cli', runId, spec });
        return { sessionName: `session-${runId}` };
      },
    },
  });

  assert.deepEqual(channel.spawnWorker('r-stream', { engine: 'stream-json', spec: streamSpec }), { sessionName: null });
  assert.deepEqual(channel.spawnWorker('r-cli', { engine: 'cli', spec: cliSpec }), { sessionName: 'session-r-cli' });
  assert.deepEqual(calls.map((call) => ({ engine: call.engine, runId: call.runId })), [
    { engine: 'stream-json', runId: 'r-stream' },
    { engine: 'cli', runId: 'r-cli' },
  ]);
  assert.strictEqual(calls[0].spec, streamSpec);
  assert.strictEqual(calls[1].spec, cliSpec);
});

test('createLocalWorkerChannel resolves worker ownership', () => {
  const channel = createLocalWorkerChannel({
    streamJsonEngine: {
      hasProcess(runId) { return runId === 'stream-run'; },
    },
    executionEngine: {
      isAlive(runId) { return runId === 'cli-run'; },
      listSessions() { return []; },
      detectExitCode() { return null; },
    },
  });

  assert.equal(channel.ownerOf('stream-run'), 'stream-json');
  assert.equal(channel.ownerOf('cli-run'), 'cli');
  assert.equal(createLocalWorkerChannel({
    streamJsonEngine: { hasProcess() { return false; } },
    executionEngine: {},
  }).ownerOf('missing-run'), null);
});

test('createLocalWorkerChannel sends input through stream-json before cli fallback', () => {
  const streamFirstCalls = [];
  const streamFirst = createLocalWorkerChannel({
    streamJsonEngine: {
      sendInput(runId, text) {
        streamFirstCalls.push({ engine: 'stream-json', runId, text });
        return true;
      },
    },
    executionEngine: {
      sendInput(runId, text) {
        streamFirstCalls.push({ engine: 'cli', runId, text });
        return true;
      },
    },
  });

  assert.equal(streamFirst.sendInput('r1', 'hello'), true);
  assert.deepEqual(streamFirstCalls, [{ engine: 'stream-json', runId: 'r1', text: 'hello' }]);

  const fallbackCalls = [];
  const fallback = createLocalWorkerChannel({
    streamJsonEngine: {
      sendInput(runId, text) {
        fallbackCalls.push({ engine: 'stream-json', runId, text });
        return false;
      },
    },
    executionEngine: {
      sendInput(runId, text) {
        fallbackCalls.push({ engine: 'cli', runId, text });
        return true;
      },
    },
  });

  assert.equal(fallback.sendInput('r2', 'fallback'), true);
  assert.deepEqual(fallbackCalls, [
    { engine: 'stream-json', runId: 'r2', text: 'fallback' },
    { engine: 'cli', runId: 'r2', text: 'fallback' },
  ]);
});

test('createLocalWorkerChannel kills stream-json first then cli when needed', () => {
  const fallbackCalls = [];
  const fallback = createLocalWorkerChannel({
    streamJsonEngine: {
      kill(runId) {
        fallbackCalls.push({ engine: 'stream-json', runId });
        return false;
      },
    },
    executionEngine: {
      kill(runId) {
        fallbackCalls.push({ engine: 'cli', runId });
        return true;
      },
    },
  });

  assert.equal(fallback.kill('r1'), true);
  assert.deepEqual(fallbackCalls, [
    { engine: 'stream-json', runId: 'r1' },
    { engine: 'cli', runId: 'r1' },
  ]);

  const streamCalls = [];
  const streamOnly = createLocalWorkerChannel({
    streamJsonEngine: {
      kill(runId) {
        streamCalls.push({ engine: 'stream-json', runId });
        return true;
      },
    },
    executionEngine: {
      kill(runId) {
        streamCalls.push({ engine: 'cli', runId });
        return true;
      },
    },
  });

  assert.equal(streamOnly.kill('r2'), true);
  assert.deepEqual(streamCalls, [{ engine: 'stream-json', runId: 'r2' }]);
});

test('createLocalWorkerChannel cleanupRun is an awaitable no-op', async () => {
  const channel = createLocalWorkerChannel();

  assert.equal(await channel.cleanupRun('r1'), undefined);
});

test('createRemoteWorkerChannel gives stream-json workers durable remote ownership', async () => {
  const calls = [];
  const remoteExecutor = {
    marker: 'raw-remote-filesystem-surface',
    spawnWorker(runId, request) {
      calls.push({ type: 'spawn', runId, request });
      return { sessionName: `palantir-run-${runId}` };
    },
    ownerOf(runId) { calls.push({ type: 'owner', runId }); return 'cli'; },
    isAlive(runId, engine) { calls.push({ type: 'alive', runId, engine }); return true; },
    detectExitCode(runId, engine) { calls.push({ type: 'exit', runId, engine }); return null; },
    getOutput(runId, lines, engine) {
      calls.push({ type: 'output', runId, lines, engine });
      return 'remote-output';
    },
    getStructuredResult(runId) {
      calls.push({ type: 'structured-result', runId });
      return '{"type":"result"}';
    },
    sendInput(runId, text) { calls.push({ type: 'input', runId, text }); return false; },
    kill(runId, engine) { calls.push({ type: 'kill', runId, engine }); return true; },
  };
  const streamJsonEngine = {
    buildDetachedWorkerSpec(spec, { workerPath }) {
      calls.push({ type: 'build', spec, workerPath });
      return {
        command: 'claude',
        args: ['--print', '-p'],
        stdin: spec.prompt,
        cwd: spec.cwd,
        env: {},
        envAllowlist: [],
        workerPath,
      };
    },
  };
  const channel = createRemoteWorkerChannel({
    remoteExecutor,
    streamJsonEngine,
    nodePrefix: '/pod/bin',
    nodeId: 'pod-a',
  });

  const result = await channel.spawnWorker('remote-claude', {
    engine: 'stream-json',
    spec: { prompt: 'hello', cwd: '/pod/ws' },
  });

  assert.deepEqual(result, { sessionName: 'palantir-run-remote-claude' });
  assert.equal(channel.marker, 'raw-remote-filesystem-surface');
  assert.equal(await channel.ownerOf('remote-claude'), 'cli');
  assert.equal(channel.isAlive('remote-claude'), true);
  assert.equal(channel.detectExitCode('remote-claude'), null);
  assert.equal(channel.getOutput('remote-claude', 12), 'remote-output');
  assert.equal(channel.getStructuredResult('remote-claude'), '{"type":"result"}');
  assert.equal(channel.sendInput('remote-claude', 'continue'), false);
  assert.equal(channel.kill('remote-claude'), true);
  assert.deepEqual(calls[0], {
    type: 'build',
    spec: { prompt: 'hello', cwd: '/pod/ws' },
    workerPath: '/pod/bin',
  });
  assert.equal(calls[1].request.engine, 'stream-json');
  assert.equal(calls[1].request.spec.stdin, 'hello');
  assert.deepEqual(calls.map((call) => call.type), [
    'build', 'spawn', 'owner', 'alive', 'exit', 'output', 'structured-result', 'input', 'kill',
  ]);
});

test('createRemoteWorkerChannel preserves the remote CLI worker channel', async () => {
  const calls = [];
  const remoteExecutor = {
    async spawnWorker(runId, request) {
      calls.push({ type: 'spawn', runId, request });
      return { sessionName: `remote-${runId}` };
    },
    async ownerOf(runId) { calls.push({ type: 'owner', runId }); return 'cli'; },
    async isAlive(runId, engine) { calls.push({ type: 'alive', runId, engine }); return true; },
    async detectExitCode() { return null; },
    async getOutput() { return 'cli-output'; },
    async sendInput() { return false; },
    async kill() { return true; },
  };
  const channel = createRemoteWorkerChannel({ remoteExecutor });
  const request = { engine: 'cli', spec: { command: 'codex', args: [] } };

  assert.deepEqual(await channel.spawnWorker('remote-cli', request), {
    sessionName: 'remote-remote-cli',
  });
  assert.equal(await channel.ownerOf('remote-cli'), 'cli');
  assert.equal(await channel.isAlive('remote-cli', 'cli'), true);
  assert.deepEqual(calls[0].request, request);
});

test('LocalNodeExecutor worker channel methods fail fast before attachEngines', () => {
  const executor = createLocalNodeExecutor();
  const calls = [
    ['spawnWorker', ['r1', { engine: 'cli', spec: {} }]],
    ['ownerOf', ['r1']],
    ['isAlive', ['r1']],
    ['detectExitCode', ['r1']],
    ['getOutput', ['r1', 10]],
    ['sendInput', ['r1', 'hello']],
    ['kill', ['r1']],
  ];

  for (const [method, args] of calls) {
    assert.throws(() => executor[method](...args), /worker channel is not attached/);
  }
});

test('LocalNodeExecutor exposes worker channel after attachEngines', () => {
  const calls = [];
  const executor = createLocalNodeExecutor();
  const cliSpec = { command: 'codex', args: [] };
  executor.attachEngines({
    streamJsonEngine: {
      hasProcess(runId) { return runId === 'stream-run'; },
      isAlive() { return true; },
      detectExitCode() { return null; },
      sendInput() { return false; },
      kill() { return false; },
    },
    executionEngine: {
      spawnAgent(runId, spec) {
        calls.push({ type: 'spawn', runId, spec });
        return { sessionName: `session-${runId}` };
      },
      isAlive(runId) { return runId === 'cli-run'; },
      detectExitCode() { return null; },
      getOutput(runId, lines) { return `${runId}:${lines}`; },
      sendInput(runId, text) {
        calls.push({ type: 'input', runId, text });
        return true;
      },
      kill(runId) {
        calls.push({ type: 'kill', runId });
        return true;
      },
    },
  });

  assert.deepEqual(executor.spawnWorker('cli-run', { engine: 'cli', spec: cliSpec }), { sessionName: 'session-cli-run' });
  assert.equal(executor.ownerOf('stream-run'), 'stream-json');
  assert.equal(executor.ownerOf('cli-run'), 'cli');
  assert.equal(executor.getOutput('cli-run', 5), 'cli-run:5');
  assert.equal(executor.sendInput('cli-run', 'ok'), true);
  assert.equal(executor.kill('cli-run'), true);
  assert.strictEqual(calls[0].spec, cliSpec);
  assert.deepEqual(calls.map((call) => call.type), ['spawn', 'input', 'kill']);
});

test('LocalNodeExecutor cleanupRun passthrough resolves when worker channel is attached', async () => {
  const executor = createLocalNodeExecutor();
  executor.attachEngines({});

  assert.equal(await executor.cleanupRun('r1'), undefined);
});

test('LocalNodeExecutor.exec resolves success with code and stdout', async () => {
  const executor = createLocalNodeExecutor();
  const result = await executor.exec(process.execPath, ['-e', 'process.stdout.write("ok")']);

  assert.deepEqual(result, { code: 0, stdout: 'ok', stderr: '' });
});

test('LocalNodeExecutor.exec resolves nonzero exit without rejecting', async () => {
  const executor = createLocalNodeExecutor();
  const result = await executor.exec(process.execPath, [
    '-e',
    'process.stderr.write("bad"); process.exit(7)',
  ]);

  assert.equal(result.code, 7);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'bad');
});

test('exec env policy is non-empty and keeps measured Git prerequisites', () => {
  const selected = buildExecEnv({
    PATH: '/fixture/bin',
    HOME: '/fixture/home',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    SSH_AUTH_SOCK: '/fixture/agent.sock',
    LC_ALL: 'C',
    TMPDIR: '/fixture/tmp',
    PALANTIR_TOKEN: 'must-not-pass',
  });

  assert.ok(EXEC_ENV_KEYS.length > 0, 'exec env allowlist must not be empty');
  assert.deepEqual(selected, {
    PATH: '/fixture/bin',
    HOME: '/fixture/home',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    SSH_AUTH_SOCK: '/fixture/agent.sock',
    LC_ALL: 'C',
    TMPDIR: '/fixture/tmp',
  });
});

test('exec env policy preserves Windows process-launch prerequisites with native casing', () => {
  const selected = buildExecEnv({
    Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: 'C:\\Users\\runner',
    PALANTIR_TOKEN: 'must-not-pass',
  });

  assert.deepEqual(selected, {
    Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: 'C:\\Users\\runner',
  });
});

test('exec env policy rejects ambient command/config/TLS bypass vectors but keeps explicit hardening', () => {
  const ambient = {
    GIT_SSH_COMMAND: 'ambient-command',
    GIT_SSH: 'ambient-command',
    GIT_PROXY_COMMAND: 'ambient-command',
    GIT_TERMINAL_PROMPT: '1',
    SSH_ASKPASS: 'ambient-command',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.sshCommand',
    GIT_CONFIG_VALUE_0: 'ambient-command',
    GIT_CONFIG_PARAMETERS: "'core.sshCommand=ambient-command'",
    GIT_CONFIG_GLOBAL: '/tmp/ambient-config',
    GIT_CONFIG_SYSTEM: '/tmp/ambient-config',
    GIT_SSL_NO_VERIFY: '1',
    GIT_EXTERNAL_DIFF: 'ambient-command',
    GIT_TEXTCONV_DIFF: 'ambient-command',
    GIT_EDITOR: 'ambient-command',
    GIT_SEQUENCE_EDITOR: 'ambient-command',
    EDITOR: 'ambient-command',
    VISUAL: 'ambient-command',
    PAGER: 'ambient-command',
  };
  const hardening = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
    GIT_EXTERNAL_DIFF: '',
    GIT_TEXTCONV_DIFF: '',
  };

  assert.deepEqual(buildExecEnv(ambient), {});
  assert.deepEqual(buildExecEnv(ambient, hardening), hardening);
});

test('exec env policy preserves node-local GIT_ASKPASS and an allowlisted companion credential', () => {
  assert.deepEqual(buildExecEnv({
    GIT_ASKPASS: '/opt/palantir/askpass',
    REPO_PASSWORD: 'private-secret',
    [GIT_ENV_ALLOWLIST_VARIABLE]: 'REPO_PASSWORD',
    ANTHROPIC_API_KEY: 'must-not-pass',
  }), {
    GIT_ASKPASS: '/opt/palantir/askpass',
    REPO_PASSWORD: 'private-secret',
  });
});

test('LocalNodeExecutor.exec filters ambient env, keeps explicit overrides, and leaks zero secret keys', async () => {
  const keys = [
    'LOCAL_NODE_EXECUTOR_BASE_ENV',
    'PALANTIR_TOKEN',
    'ANTHROPIC_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.LOCAL_NODE_EXECUTOR_BASE_ENV = 'ambient-must-not-pass';
  process.env.PALANTIR_TOKEN = 'palantir-secret';
  process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret';
  try {
    const executor = createLocalNodeExecutor();
    const result = await executor.exec(
      process.execPath,
      [
        '-e',
        [
          'const secretKeys=["PALANTIR_TOKEN","ANTHROPIC_API_KEY","AWS_SECRET_ACCESS_KEY"];',
          'process.stdout.write(JSON.stringify({',
          'hasPath:Object.hasOwn(process.env,"PATH"),',
          'ambient:process.env.LOCAL_NODE_EXECUTOR_BASE_ENV,',
          'override:process.env.LOCAL_NODE_EXECUTOR_OVERRIDE_ENV,',
          'secretKeys:secretKeys.filter((key)=>Object.hasOwn(process.env,key))',
          '}));',
        ].join(''),
      ],
      { env: { LOCAL_NODE_EXECUTOR_OVERRIDE_ENV: 'override-visible' } },
    );

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      hasPath: true,
      override: 'override-visible',
      secretKeys: [],
    });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('LocalNodeExecutor.exec projectTest keeps runtime keys without control-plane secrets', async () => {
  const keys = [
    'NODE_ENV',
    'VIRTUAL_ENV',
    'PYTHONPATH',
    PROJECT_TEST_ENV_ALLOWLIST_VARIABLE,
    'PALANTIR_TOKEN',
    'ANTHROPIC_API_KEY',
    'GIT_ASKPASS',
    'HTTPS_PROXY',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = 'project-suite-needs-this';
  process.env.VIRTUAL_ENV = '/fixture/venv';
  process.env.PYTHONPATH = '/opt/project-specific-python-libs';
  process.env[PROJECT_TEST_ENV_ALLOWLIST_VARIABLE] = 'PYTHONPATH';
  process.env.PALANTIR_TOKEN = 'palantir-secret';
  process.env.ANTHROPIC_API_KEY = 'model-secret';
  process.env.GIT_ASKPASS = '/fixture/credential-helper';
  process.env.HTTPS_PROXY = 'http://user:password@proxy.example';
  try {
    const executor = createLocalNodeExecutor();
    const script = [
      'process.stdout.write(JSON.stringify({',
      'project:process.env.NODE_ENV ?? null,',
      'virtualEnv:process.env.VIRTUAL_ENV ?? null,',
      'pythonPath:process.env.PYTHONPATH ?? null,',
      'override:process.env.LOCAL_NODE_EXECUTOR_OVERRIDE_ENV ?? null,',
      'palantir:process.env.PALANTIR_TOKEN ?? null,',
      'anthropic:process.env.ANTHROPIC_API_KEY ?? null,',
      'askpass:process.env.GIT_ASKPASS ?? null,',
      'proxy:process.env.HTTPS_PROXY ?? null,',
      '}));',
    ].join('');
    const opts = { env: { LOCAL_NODE_EXECUTOR_OVERRIDE_ENV: 'override-visible' } };

    const projectTest = await executor.exec(process.execPath, ['-e', script], {
      ...opts,
      projectTest: true,
    });
    assert.deepEqual(JSON.parse(projectTest.stdout), {
      project: 'project-suite-needs-this',
      virtualEnv: '/fixture/venv',
      pythonPath: '/opt/project-specific-python-libs',
      override: 'override-visible',
      palantir: null,
      anthropic: null,
      askpass: null,
      proxy: null,
    }, 'project tests keep runtime discovery without inheriting server credentials');

    const filtered = await executor.exec(process.execPath, ['-e', script], opts);
    assert.deepEqual(JSON.parse(filtered.stdout), {
      project: null,
      virtualEnv: null,
      pythonPath: null,
      override: 'override-visible',
      palantir: null,
      anthropic: null,
      askpass: '/fixture/credential-helper',
      proxy: 'http://user:password@proxy.example',
    }, 'the default keeps the separate Git authentication policy');

    assert.ok(PROJECT_TEST_ENV_KEYS.includes('NODE_ENV'));
    assert.deepEqual(buildProjectTestEnv({
      NODE_ENV: 'test',
      PYTHONPATH: '/fixture/python',
      [PROJECT_TEST_ENV_ALLOWLIST_VARIABLE]: 'PYTHONPATH',
      PALANTIR_TOKEN: 'secret',
    }), {
      NODE_ENV: 'test',
      PYTHONPATH: '/fixture/python',
    });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('configured exec allowlists reject control-plane credential names', () => {
  assert.throws(
    () => buildExecEnv({
      [GIT_ENV_ALLOWLIST_VARIABLE]: 'REPO_PASSWORD,PALANTIR_TOKEN',
      REPO_PASSWORD: 'private-secret',
      PALANTIR_TOKEN: 'control-plane-secret',
    }),
    /cannot include control-plane credential PALANTIR_TOKEN/,
  );
  assert.throws(
    () => buildProjectTestEnv({
      [PROJECT_TEST_ENV_ALLOWLIST_VARIABLE]: 'PYTHONPATH,PALANTIR_PM_TOKEN',
      PYTHONPATH: '/fixture/python',
      PALANTIR_PM_TOKEN: 'control-plane-secret',
    }),
    /cannot include control-plane credential PALANTIR_PM_TOKEN/,
  );
});

test('LocalNodeExecutor.exec rejects missing binary as spawn-level failure', async () => {
  const executor = createLocalNodeExecutor();
  const missing = path.join(os.tmpdir(), `palantir-missing-bin-${process.pid}-${Date.now()}`);

  await assert.rejects(
    () => executor.exec(missing, []),
    (err) => err && err.code === 'ENOENT',
  );
});

test('LocalNodeExecutor.exec passes maxBuffer through for successful output', async () => {
  const executor = createLocalNodeExecutor();
  const result = await executor.exec(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(4096))'],
    { maxBuffer: 8192 },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 4096);
  assert.equal(result.stderr, '');
});

test('LocalNodeExecutor.exec rejects maxBuffer overflow with partial stdout attached', async () => {
  const executor = createLocalNodeExecutor();

  await assert.rejects(
    () => executor.exec(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(1024 * 1024))'],
      { maxBuffer: 1024 },
    ),
    (err) => err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      && typeof err.stdout === 'string'
      && err.stdout.length > 0
      && typeof err.stderr === 'string',
  );
});

test('LocalNodeExecutor async fs operations round-trip in a tmpdir', async (t) => {
  const executor = createLocalNodeExecutor();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-node-executor-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const regular = path.join(root, 'regular.txt');
  const nested = path.join(root, 'nested');
  await fsp.writeFile(regular, 'regular');
  await executor.mkdir(nested, { recursive: true });

  assert.equal(await executor.fileExists(regular), true);
  assert.equal(await executor.fileExists(path.join(root, 'missing.txt')), false);
  assert.equal(await executor.realpath(root), fs.realpathSync(root));
  assert.equal((await executor.stat(nested)).isDirectory(), true);
  assert.equal(await executor.readFile(regular), 'regular');
  assert.deepEqual((await executor.readdir(root)).sort(), ['nested', 'regular.txt']);

  const tempFile = await executor.writeTempFile(path.join(root, 'tmp-'), 'secret.txt', 'secret', 0o600);
  assert.equal(await executor.readFile(tempFile), 'secret');
  assert.equal((await fsp.stat(tempFile)).mode & 0o777, 0o600);

  await executor.rmrf(path.dirname(tempFile));
  assert.equal(await executor.fileExists(tempFile), false);
});

test('createWorktreeService routes git calls through injected executor', async () => {
  const calls = [];
  const fake = {
    async exec(command, args, opts) {
      calls.push({ type: 'exec', command, args, cwd: opts?.cwd });
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { code: 0, stdout: '.git\n', stderr: '' };
      if (args[0] === 'branch' && args[1] === '--show-current') return { code: 0, stdout: 'main\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async fileExists(p) {
      calls.push({ type: 'fileExists', path: p });
      return false;
    },
    async mkdir(p, opts) {
      calls.push({ type: 'mkdir', path: p, opts });
    },
  };
  const service = createWorktreeService({ nodeExecutor: fake });
  const result = await service.createWorktree('/repo', 'palantir/test');

  assert.equal(result.created, true);
  assert.deepEqual(
    calls.filter((call) => call.type === 'exec').map((call) => call.args),
    [
      ['rev-parse', '--git-dir'],
      ['branch', '--show-current'],
      ['branch', 'palantir/test', 'main'],
      ['worktree', 'add', path.join('/repo', '.palantir-worktrees', 'palantir/test'), 'palantir/test'],
    ],
  );
  assert.ok(calls.some((call) => call.type === 'mkdir'));
});

test('LocalNodeExecutor.exec rejects timeout kills instead of faking an exit code', async () => {
  const executor = createLocalNodeExecutor();

  await assert.rejects(
    () => executor.exec(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 }),
    (err) => (err.killed === true || Boolean(err.signal)) && typeof err.stdout === 'string',
  );
});

test('LocalNodeExecutor.writeTempFile rejects names that escape the temp dir', async () => {
  const executor = createLocalNodeExecutor();

  await assert.rejects(() => executor.writeTempFile('palantir-esc-', '../evil.txt', 'x'), /invalid file name/);
  await assert.rejects(() => executor.writeTempFile('palantir-esc-', 'a/b.txt', 'x'), /invalid file name/);
});

test('LocalNodeExecutor.writeTempFile removes its fresh directory when writeFile fails', async (t) => {
  const executor = createLocalNodeExecutor();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-temp-write-fail-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => executor.writeTempFile(path.join(root, 'secret-'), 'payload', Symbol('invalid-content')),
    (err) => err?.code === 'ERR_INVALID_ARG_TYPE',
  );
  assert.deepEqual(await fsp.readdir(root), []);
});

test('LocalNodeExecutor.writeTempFile removes its fresh directory and preserves chmod failure', async (t) => {
  const executor = createLocalNodeExecutor();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-temp-chmod-fail-'));
  const originalChmod = fsp.chmod;
  const chmodError = new Error('synthetic chmod failure');
  t.after(async () => {
    fsp.chmod = originalChmod;
    await fsp.rm(root, { recursive: true, force: true });
  });
  fsp.chmod = async () => { throw chmodError; };

  try {
    await assert.rejects(
      () => executor.writeTempFile(path.join(root, 'secret-'), 'payload', 'sensitive'),
      (err) => err === chmodError,
    );
  } finally {
    fsp.chmod = originalChmod;
  }
  assert.deepEqual(await fsp.readdir(root), []);
});

test('LocalNodeExecutor.putSecretFile writes 0600 secret and rejects escaping names', async (t) => {
  const executor = createLocalNodeExecutor();
  const secretPath = await executor.putSecretFile('model_instructions_file', 'secret', 0o600);
  t.after(async () => {
    await fsp.rm(path.dirname(secretPath), { recursive: true, force: true });
  });

  assert.equal(await executor.readFile(secretPath), 'secret');
  assert.equal((fs.statSync(secretPath).mode & 0o777), 0o600);
  assert.ok(path.dirname(secretPath).startsWith(path.join(os.tmpdir(), 'palantir-secret-')));
  await assert.rejects(() => executor.putSecretFile('../evil', 'x'), /invalid file name/);
  await assert.rejects(() => executor.putSecretFile('a/b', 'x'), /invalid file name/);
});

test('LocalNodeExecutor.spawnInteractive returns piped child with cwd and env', async (t) => {
  const executor = createLocalNodeExecutor();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-node-executor-spawn-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const child = executor.spawnInteractive(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify({ cwd: process.cwd(), flag: process.env.LOCAL_EXECUTOR_FLAG || null }));',
  ], {
    cwd: root,
    env: { LOCAL_EXECUTOR_FLAG: 'present' },
  });

  assert.ok(child.stdin);
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  assert.equal(child.stdin.writable, true);
  assert.equal(child.stdout.readable, true);
  assert.equal(child.stderr.readable, true);

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { cwd: fs.realpathSync(root), flag: 'present' });
});

test('createHarvestService routes worktree existence through injected executor', async () => {
  const { createHarvestService } = require('../services/harvestService');
  const calls = [];
  const events = [];
  const fake = { async fileExists(p) { calls.push(p); return false; } };
  const run = { id: 'rh1', is_manager: 0, status: 'completed', worktree_path: '/gone', branch: 'palantir/run-rh1' };
  const harvest = createHarvestService({
    runService: { getRunEvents: () => [], addRunEvent() {}, getRun: () => run },
    worktreeService: {},
    projectService: {},
    eventBus: { emit(ch, payload) { events.push({ ch, payload }); } },
    nodeExecutor: fake,
  });

  await harvest.harvestRun(run);

  assert.deepEqual(calls, ['/gone']);
  const harvested = events.find((e) => e.ch === 'run:harvested');
  assert.ok(harvested, 'run:harvested emitted');
  assert.ok(harvested.payload.summary.errors.includes('worktree_missing'));
  assert.equal(harvested.payload.summary.harvested, false);
});

test('runs diff route consults injected executor for worktree existence', async (t) => {
  const express = require('express');
  const request = require('supertest');
  const { createRunsRouter } = require('../routes/runs');
  const calls = [];
  const fake = { async fileExists(p) { calls.push(p); return false; }, async realpath(p) { return p; } };
  const app = express();
  app.use('/api/runs', createRunsRouter({
    runService: { getRun: () => ({ id: 'r1', worktree_path: '/nope' }) },
    lifecycleService: {},
    executionEngine: {},
    streamJsonEngine: {},
    conversationService: {},
    presetService: {},
    mcpTemplateService: {},
    projectService: {},
    taskService: {},
    nodeExecutor: fake,
  }));

  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await request(server).get('/api/runs/r1/diff');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { diff: null, reason: 'worktree_missing' });
  assert.deepEqual(calls, ['/nope']);
});

test('runs output route reads detached output through the run node executor', async (t) => {
  const express = require('express');
  const request = require('supertest');
  const { createRunsRouter } = require('../routes/runs');
  const calls = [];
  const remoteExecutor = {
    async getOutput(runId, lines) {
      calls.push({ runId, lines });
      return [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"remote"},{"type":"tool_use","name":"Bash","input":{"secret":"must-not-render"}}]}}',
        '{"type":"result","result":"remote"}',
      ].join('\n');
    },
  };
  const app = express();
  app.use('/api/runs', createRunsRouter({
    runService: {
      getRun: () => ({ id: 'r-remote', node_id: 'ssh-pod' }),
      hasRunEvent: (_runId, eventType) => eventType === 'runtime:remote_worker_engine',
    },
    lifecycleService: {},
    executionEngine: {
      getOutput() {
        throw new Error('local execution engine must not serve remote output');
      },
    },
    streamJsonEngine: {
      getOutput() {
        throw new Error('local stream-json engine must not serve remote output');
      },
    },
    conversationService: {},
    presetService: {},
    mcpTemplateService: {},
    projectService: {},
    taskService: {},
    nodeExecutor: {},
    nodeService: {
      pickExecutor(nodeId) {
        assert.equal(nodeId, 'ssh-pod');
        return remoteExecutor;
      },
    },
  }));

  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await request(server).get('/api/runs/r-remote/output?lines=321');

  assert.equal(res.status, 200);
  assert.equal(res.body.output, 'remote');
  assert.equal(res.body.output.includes('must-not-render'), false);
  assert.deepEqual(calls, [{ runId: 'r-remote', lines: 321 }]);
});

test('runs output route falls back to the durable detached Claude result', async (t) => {
  const express = require('express');
  const request = require('supertest');
  const { createRunsRouter } = require('../routes/runs');
  const calls = [];
  const remoteExecutor = {
    async getOutput(runId, lines) {
      calls.push({ type: 'output', runId, lines });
      return '';
    },
    async getStructuredResult(runId) {
      calls.push({ type: 'result', runId });
      return JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'durable oversized result',
      });
    },
  };
  const app = express();
  app.use('/api/runs', createRunsRouter({
    runService: {
      getRun: () => ({
        id: 'r-durable',
        node_id: 'ssh-pod',
        status: 'completed',
      }),
      hasRunEvent: (_runId, eventType) => eventType === 'runtime:remote_worker_engine',
    },
    lifecycleService: {},
    executionEngine: {},
    streamJsonEngine: {},
    conversationService: {},
    presetService: {},
    mcpTemplateService: {},
    projectService: {},
    taskService: {},
    nodeExecutor: {},
    nodeService: {
      pickExecutor() {
        return remoteExecutor;
      },
    },
  }));

  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await request(server).get('/api/runs/r-durable/output?lines=200');

  assert.equal(res.status, 200);
  assert.equal(res.body.output, 'durable oversized result');
  assert.deepEqual(calls, [
    { type: 'output', runId: 'r-durable', lines: 200 },
    { type: 'result', runId: 'r-durable' },
  ]);
});

test('runs output route keeps remote manager output on its live stream-json owner', async (t) => {
  const express = require('express');
  const request = require('supertest');
  const { createRunsRouter } = require('../routes/runs');
  let remotePicks = 0;
  const app = express();
  app.use('/api/runs', createRunsRouter({
    runService: {
      getRun: () => ({
        id: 'r-remote-manager',
        node_id: 'ssh-pod',
        is_manager: 1,
      }),
    },
    lifecycleService: {},
    executionEngine: {
      getOutput() {
        throw new Error('CLI fallback must not win while the manager stream is live');
      },
    },
    streamJsonEngine: {
      getOutput(runId, lines) {
        assert.equal(runId, 'r-remote-manager');
        assert.equal(lines, 200);
        return 'live remote manager output';
      },
    },
    conversationService: {},
    presetService: {},
    mcpTemplateService: {},
    projectService: {},
    taskService: {},
    nodeExecutor: {},
    nodeService: {
      pickExecutor() {
        remotePicks++;
        throw new Error('remote manager output must stay on the live duplex owner');
      },
    },
  }));

  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await request(server).get('/api/runs/r-remote-manager/output?lines=200');

  assert.equal(res.status, 200);
  assert.equal(res.body.output, 'live remote manager output');
  assert.equal(remotePicks, 0);
});

test('createFsService routes directory listing through injected executor', async () => {
  const calls = [];
  const fake = {
    async readdir(p, opts) {
      calls.push({ path: p, opts });
      return [
        { name: 'visible', isDirectory: () => true },
        { name: '.hidden', isDirectory: () => true },
        { name: 'file.txt', isDirectory: () => false },
      ];
    },
  };
  const service = createFsService({ fsRoot: '/root' }, { nodeExecutor: fake });
  const result = await service.listDirectories('/root', false);

  assert.deepEqual(calls, [{ path: '/root', opts: { withFileTypes: true } }]);
  assert.deepEqual(result.directories, [{ name: 'visible', path: path.join('/root', 'visible') }]);
});
