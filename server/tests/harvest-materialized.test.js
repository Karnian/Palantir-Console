const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHarvestService } = require('../services/harvestService');

const WORKSPACE = '/pod/workspaces/run-1';
const CACHE = '/pod/cache/project.gitcache';
const COMMIT = '0123456789012345678901234567890123456789';

function withRepoFlag(t) {
  const prev = process.env.PALANTIR_PROJECT_REPO;
  process.env.PALANTIR_PROJECT_REPO = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev;
  });
}

function parseEvent(evt) {
  return JSON.parse(evt.payload_json || '{}');
}

function createRunService(run, events = []) {
  return {
    events,
    getRun: () => run,
    getRunEvents: (runId) => events.filter(evt => evt.run_id === runId),
    addRunEvent(runId, eventType, payloadJson) {
      events.push({ run_id: runId, event_type: eventType, payload_json: payloadJson });
    },
  };
}

function createExecutor({ exists = true, failStage = null } = {}) {
  const calls = [];
  return {
    calls,
    async fileExists(target) {
      calls.push({ kind: 'fileExists', target });
      return exists;
    },
    async exec(command, args, opts = {}) {
      calls.push({ kind: 'exec', command, args: [...args], opts: { ...opts } });
      if (command !== 'git') {
        return { code: 0, stdout: `executor ran ${args.at(-1) || ''}\n`, stderr: '' };
      }
      if (args[2] === 'diff' && args[3] === '--stat') {
        if (failStage === 'diff') return { code: 1, stdout: '', stderr: 'diff broke' };
        return { code: 0, stdout: ' src/file.js | 1 +\n', stderr: '' };
      }
      // `-z` output: NUL-separated (not newline). Mirrors real git so the
      // parser's \0-split is exercised (Codex PR5c review NIT hardening).
      if (args[2] === 'diff' && args[3] === '--name-only') {
        return { code: 0, stdout: 'src/file.js\0', stderr: '' };
      }
      if (args[2] === 'status') {
        return { code: 0, stdout: '?? src/new-file.js\0 M src/file.js\0', stderr: '' };
      }
      if (args[2] === 'worktree' && args[3] === 'remove') {
        if (failStage === 'worktree_remove') return { code: 1, stdout: '', stderr: 'remove broke' };
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[2] === 'worktree' && args[3] === 'prune') {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function createHarness(t, {
  executor = createExecutor(),
  runOverrides = {},
  project = { id: 'project-1', test_command: null },
  nodeService = null,
  nodeResolver = undefined,
} = {}) {
  withRepoFlag(t);
  const run = {
    id: 'run-1',
    project_id: project.id,
    is_manager: 0,
    status: 'completed',
    worktree_path: null,
    branch: null,
    workspace_path: WORKSPACE,
    repo_cache_path: CACHE,
    resolved_commit: COMMIT,
    node_id: 'local',
    ...runOverrides,
  };
  const runService = createRunService(run);
  const harvested = [];
  const harvestService = createHarvestService({
    runService,
    worktreeService: {},
    projectService: { getProject: () => project },
    eventBus: { emit(channel, payload) { harvested.push({ channel, payload }); } },
    nodeExecutor: executor,
    nodeService,
    nodeResolver,
    testRunner: { bin: '/bin/sh', args: ['-c'] },
  });
  return { run, runService, harvested, harvestService, executor };
}

test('harvestRun captures materialized workspace diff instead of no_worktree', async (t) => {
  const { run, runService, harvested, harvestService, executor } = createHarness(t);

  await harvestService.harvestRun(run);

  assert.equal(harvested.length, 1);
  assert.equal(harvested[0].payload.summary.harvested, true);
  assert.deepEqual(harvested[0].payload.summary.errors, []);
  const diff = parseEvent(runService.events.find(evt => evt.event_type === 'harvest:diff'));
  assert.equal(diff.base, COMMIT);
  assert.equal(diff.branch, null);
  assert.deepEqual(diff.commits, []);
  assert.deepEqual(diff.files, ['src/file.js', 'src/new-file.js']);
  const diffCall = executor.calls.find(call => call.kind === 'exec' && call.args[2] === 'diff' && call.args[3] === '--stat');
  assert.deepEqual(diffCall.args, ['-C', WORKSPACE, 'diff', '--stat', COMMIT, '--', '.']);
  const nameCall = executor.calls.find(call => call.kind === 'exec' && call.args[2] === 'diff' && call.args[3] === '--name-only');
  assert.deepEqual(nameCall.args, ['-C', WORKSPACE, 'diff', '--name-only', '-z', COMMIT, '--', '.']);
  const statusCall = executor.calls.find(call => call.kind === 'exec' && call.args[2] === 'status');
  assert.deepEqual(statusCall.args, ['-C', WORKSPACE, 'status', '--porcelain', '-z', '--', '.']);
  const stages = runService.events
    .filter(evt => evt.event_type === 'harvest:error')
    .map(evt => parseEvent(evt).stage);
  assert.equal(stages.includes('no_worktree'), false);
});

test('harvestRun runs materialized test_command through the selected remote executor', async (t) => {
  const localExecutor = createExecutor();
  const remoteExecutor = createExecutor();
  const picked = [];
  let nodeResolverCalls = 0;
  const nodeService = {
    pickExecutor(nodeId) {
      picked.push(nodeId);
      return nodeId === 'remote-1' ? remoteExecutor : localExecutor;
    },
  };
  const { run, runService, harvestService } = createHarness(t, {
    executor: localExecutor,
    nodeService,
    nodeResolver: () => {
      nodeResolverCalls += 1;
      return null;
    },
    project: { id: 'project-1', test_command: 'npm test' },
    runOverrides: { node_id: 'remote-1', repo_subdir_snapshot: 'packages/app' },
  });

  await harvestService.harvestRun(run);

  assert.deepEqual(picked, ['remote-1']);
  assert.equal(nodeResolverCalls, 0);
  const testCall = remoteExecutor.calls.find(call => call.kind === 'exec' && call.command === '/bin/sh');
  assert.ok(testCall, 'test command used executor.exec');
  assert.deepEqual(testCall.args, ['-c', 'npm test']);
  assert.equal(testCall.opts.cwd, `${WORKSPACE}/packages/app`);
  const testPayload = parseEvent(runService.events.find(evt => evt.event_type === 'harvest:test'));
  assert.equal(testPayload.node_major, null);
  assert.equal(testPayload.node_source, 'executor');
  assert.equal('declared_node_major' in testPayload, false);
});

test('harvestRun emits 3-way declared_node_major for materialized local workspaces', async (t) => {
  const cases = [
    {
      name: 'exact',
      write(workspace) { fs.writeFileSync(path.join(workspace, '.nvmrc'), '20\n'); },
      expected: 20,
    },
    { name: 'none', write() {}, expected: null },
    {
      name: 'indeterminate',
      write(workspace) { fs.writeFileSync(path.join(workspace, '.nvmrc'), '>=20\n'); },
      expected: undefined,
    },
  ];

  for (const item of cases) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `palantir-materialized-${item.name}-`));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    item.write(workspace);
    const { run, runService, harvestService } = createHarness(t, {
      nodeResolver: () => '/fake/node/bin',
      project: { id: 'project-1', test_command: 'npm test' },
      runOverrides: { workspace_path: workspace, node_id: 'local' },
    });

    await harvestService.harvestRun(run);

    const testPayload = parseEvent(runService.events.find(evt => evt.event_type === 'harvest:test'));
    if (item.expected === undefined) {
      assert.equal('declared_node_major' in testPayload, false, item.name);
    } else {
      assert.equal(testPayload.declared_node_major, item.expected, item.name);
    }
  }
});

test('harvestRun removes and prunes materialized worktrees through git -C cache', async (t) => {
  const { run, harvestService, executor } = createHarness(t);

  await harvestService.harvestRun(run);

  const removeCall = executor.calls.find(call => (
    call.kind === 'exec' && call.args[2] === 'worktree' && call.args[3] === 'remove'
  ));
  const pruneCall = executor.calls.find(call => (
    call.kind === 'exec' && call.args[2] === 'worktree' && call.args[3] === 'prune'
  ));
  assert.deepEqual(removeCall.args, ['-C', CACHE, 'worktree', 'remove', '--force', '--', WORKSPACE]);
  assert.deepEqual(pruneCall.args, ['-C', CACHE, 'worktree', 'prune']);
});

test('harvestRun records materialized stage errors without throwing and emits harvested once', async (t) => {
  const executor = createExecutor({ failStage: 'diff' });
  const { run, runService, harvested, harvestService } = createHarness(t, { executor });

  await assert.doesNotReject(() => harvestService.harvestRun(run));

  assert.equal(harvested.length, 1);
  const stages = runService.events
    .filter(evt => evt.event_type === 'harvest:error')
    .map(evt => parseEvent(evt).stage);
  assert.ok(stages.includes('diff'));
  assert.equal(harvested[0].payload.summary.errors.includes('diff'), true);
});

test('harvestRun emits worktree_missing for absent materialized workspace paths', async (t) => {
  const executor = createExecutor({ exists: false });
  const { run, runService, harvested, harvestService } = createHarness(t, { executor });

  await harvestService.harvestRun(run);

  assert.equal(harvested.length, 1);
  assert.deepEqual(harvested[0].payload.summary.errors, ['worktree_missing']);
  assert.equal(harvested[0].payload.summary.harvested, false);
  assert.equal(runService.events.length, 0);
});
