const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createLocalNodeExecutor } = require('../services/nodeExecutor');
const { createWorktreeService } = require('../services/worktreeService');
const { createFsService } = require('../services/fsService');

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

test('runs diff route consults injected executor for worktree existence', async () => {
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

  const res = await request(app).get('/api/runs/r1/diff');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { diff: null, reason: 'worktree_missing' });
  assert.deepEqual(calls, ['/nope']);
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
