'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createTaskService } = require('../services/taskService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createProjectMaterializationService } = require('../services/projectMaterializationService');
const { createEventBus } = require('../services/eventBus');

async function mkdb(t, prefix = 'project-materialization-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  t.after(async () => {
    try { handle.close(); } catch { /* ignore */ }
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return handle.db;
}

async function tempRoot(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function withRepoEnv(t, root) {
  const prev = {
    flag: process.env.PALANTIR_PROJECT_REPO,
    workspaces: process.env.PALANTIR_WORKSPACES,
    cache: process.env.PALANTIR_REPO_CACHE,
  };
  process.env.PALANTIR_PROJECT_REPO = '1';
  process.env.PALANTIR_WORKSPACES = path.join(root, 'workspaces');
  process.env.PALANTIR_REPO_CACHE = path.join(root, 'cache');
  t.after(() => {
    if (prev.flag === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev.flag;
    if (prev.workspaces === undefined) delete process.env.PALANTIR_WORKSPACES;
    else process.env.PALANTIR_WORKSPACES = prev.workspaces;
    if (prev.cache === undefined) delete process.env.PALANTIR_REPO_CACHE;
    else process.env.PALANTIR_REPO_CACHE = prev.cache;
  });
}

function seedProfile(db, { id = 'profile_mat', max = 1 } = {}) {
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'Materialize', 'codex', 'codex', '{prompt}', '{}', '[]', ?)
  `).run(id, max);
  return { id, max_concurrent: max, command: 'codex' };
}

function seedTask(taskService, projectId, title = 'task') {
  return taskService.createTask({
    project_id: projectId,
    title,
    status: 'in_progress',
  });
}

function seedRun(runService, taskId, profileId, prompt = 'run') {
  return runService.createRun({
    task_id: taskId,
    agent_profile_id: profileId,
    prompt,
  });
}

function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      try {
        if (predicate()) return resolve();
        if (Date.now() >= deadline) {
          assert.ok(predicate(), 'condition was not met before timeout');
          return resolve();
        }
      } catch (err) {
        return reject(err);
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function fakeGitExecutor({ failClone = false, failFirstWorktreeAdd = false } = {}) {
  const calls = [];
  const commit = '0123456789012345678901234567890123456789';
  let worktreeAdds = 0;
  return {
    calls,
    async exec(command, args, opts = {}) {
      calls.push({ command, args, opts });
      if (command !== 'git') return { code: 127, stdout: '', stderr: 'bad command' };
      if (args[0] === 'clone') {
        if (failClone) return { code: 1, stdout: '', stderr: 'clone failed' };
        fs.mkdirSync(path.join(args[4], '.git'), { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${commit}\n`, stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        worktreeAdds++;
        fs.mkdirSync(args[3], { recursive: true });
        if (failFirstWorktreeAdd && worktreeAdds === 1) {
          return { code: 1, stdout: '', stderr: 'worktree add failed' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        fs.rmSync(args.at(-1), { recursive: true, force: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ls-remote') return { code: 0, stdout: `${commit}\trefs/heads/main\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async fileExists(target) {
      return fs.existsSync(target);
    },
    async mkdir(target, options = {}) {
      fs.mkdirSync(target, options);
    },
    async rmrf(target) {
      fs.rmSync(target, { recursive: true, force: true });
    },
    async move(src, dst) {
      fs.renameSync(src, dst);
    },
    async readFile(target) {
      return fs.readFileSync(target, 'utf8');
    },
  };
}

function buildMaterializeHarness(db, { executor, eventBus = null } = {}) {
  const runService = createRunService(db, eventBus);
  const projectService = createProjectService(db);
  const taskService = createTaskService(db);
  const nodeService = {
    pickExecutor() { return executor; },
    getNode() { return { id: 'local', kind: 'local', reachable: 1, can_execute: 1, files_only: 0, cordoned: 0 }; },
  };
  const materializationService = createProjectMaterializationService({
    runService,
    projectService,
    nodeService,
    eventBus,
  });
  return { runService, projectService, taskService, nodeService, materializationService };
}

test('single-flight cache materialization clones once and creates per-run worktrees', async (t) => {
  const root = await tempRoot(t, 'project-materialization-root-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const executor = fakeGitExecutor();
  const h = buildMaterializeHarness(db, { executor });
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
    repo_ref: 'main',
  });
  const taskA = seedTask(h.taskService, project.id, 'A');
  const taskB = seedTask(h.taskService, project.id, 'B');
  const runA = seedRun(h.runService, taskA.id, profile.id, 'A');
  const runB = seedRun(h.runService, taskB.id, profile.id, 'B');
  h.runService.claimQueuedRunForMaterialization(runA.id);
  h.runService.claimQueuedRunForMaterialization(runB.id);

  const first = await h.materializationService.ensureWorkspace({ project, nodeId: 'local', runId: runA.id });
  const second = await h.materializationService.ensureWorkspace({ project, nodeId: 'local', runId: runB.id });

  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.equal(executor.calls.filter((c) => c.args[0] === 'clone').length, 1);
  const afterA = h.runService.getRun(runA.id);
  const afterB = h.runService.getRun(runB.id);
  assert.equal(afterA.status, 'queued');
  assert.equal(afterB.status, 'queued');
  assert.ok(afterA.workspace_path);
  assert.ok(afterB.workspace_path);
  assert.notEqual(afterA.workspace_path, afterB.workspace_path);
  assert.equal(afterA.resolved_commit, '0123456789012345678901234567890123456789');
});

test('materialize success stores durable fields and emits materialize:ready', async (t) => {
  const root = await tempRoot(t, 'project-materialization-ready-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const readyEvents = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'materialize:ready') readyEvents.push(event.data);
  });
  const executor = fakeGitExecutor();
  const h = buildMaterializeHarness(db, { executor, eventBus });
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
    repo_ref: 'main',
    repo_subdir: 'packages/app',
  });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);
  const claim = h.runService.claimQueuedRunForMaterialization(run.id);

  const result = await h.materializationService.ensureWorkspace({ project, nodeId: 'local', runId: run.id });
  const after = h.runService.getRun(run.id);
  const pruneIndex = executor.calls.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'prune');
  const addIndex = executor.calls.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'add');

  assert.equal(result.ready, true);
  assert.equal(after.status, 'queued');
  assert.ok(after.workspace_path.endsWith(`${run.id}-${claim.token}`));
  assert.equal(after.source_type_snapshot, 'git');
  assert.equal(after.repo_subdir_snapshot, 'packages/app');
  assert.equal(after.workspace_generation, project.source_generation);
  assert.equal(after.started_at, null);
  assert.ok(pruneIndex >= 0 && pruneIndex < addIndex);
  assert.equal(readyEvents.length, 1);
  assert.deepEqual(readyEvents[0], {
    run_id: run.id,
    project_id: project.id,
    node_id: 'local',
    resolved_commit: after.resolved_commit,
  });
});

test('materialize transient clone failure requeues before max attempts', async (t) => {
  const root = await tempRoot(t, 'project-materialization-fail-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const failedEvents = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'materialize:failed') failedEvents.push(event.data);
  });
  const executor = fakeGitExecutor({ failClone: true });
  const h = buildMaterializeHarness(db, { executor, eventBus });
  const agentProfileService = createAgentProfileService(db);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
    repo_ref: 'main',
  });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);
  const lifecycleService = createLifecycleService({
    runService: h.runService,
    taskService: h.taskService,
    agentProfileService,
    projectService: h.projectService,
    executionEngine: stubExecEngine(),
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus,
    presetService: null,
    nodeService: h.nodeService,
    projectMaterializationService: h.materializationService,
  });

  await lifecycleService.drainQueue(profile.id);
  await waitFor(() => {
    const current = h.runService.getRun(run.id);
    return current.status === 'queued' && Number(current.materialize_attempts || 0) === 1;
  });
  lifecycleService.stopMonitoring();
  const after = h.runService.getRun(run.id);

  assert.equal(after.status, 'queued');
  assert.equal(after.started_at, null);
  assert.equal(after.materialize_started_at, null);
  assert.equal(after.materialize_claim_token, null);
  assert.match(after.materialize_last_error, /clone failed/);
  assert.equal(after.materialize_attempts, 1);
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].transient, true);
});

test('materialize clone failure fails when attempts are exhausted', async (t) => {
  const root = await tempRoot(t, 'project-materialization-fail-max-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const executor = fakeGitExecutor({ failClone: true });
  const h = buildMaterializeHarness(db, { executor });
  const agentProfileService = createAgentProfileService(db);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
    repo_ref: 'main',
  });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);
  db.prepare('UPDATE runs SET materialize_attempts = 3 WHERE id = ?').run(run.id);
  const lifecycleService = createLifecycleService({
    runService: h.runService,
    taskService: h.taskService,
    agentProfileService,
    projectService: h.projectService,
    executionEngine: stubExecEngine(),
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus: null,
    presetService: null,
    nodeService: h.nodeService,
    projectMaterializationService: h.materializationService,
  });

  await lifecycleService.drainQueue(profile.id);
  await waitFor(() => h.runService.getRun(run.id).status === 'failed');
  lifecycleService.stopMonitoring();
  const after = h.runService.getRun(run.id);

  assert.equal(after.status, 'failed');
  assert.equal(after.started_at, null);
  assert.match(after.materialize_last_error, /clone failed/);
  assert.equal(after.materialize_attempts, 4);
});

function stubExecEngine() {
  const spawned = [];
  return {
    type: 'subprocess',
    spawned,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `session-${runId}` };
    },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() { return true; },
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function stubStreamJsonEngine() {
  return {
    spawnAgent() { return { sessionName: null }; },
    hasProcess() { return false; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    sendInput() { return true; },
    kill() { return true; },
  };
}

test('materializing git run does not consume worker slot for legacy dispatch', async (t) => {
  const prev = process.env.PALANTIR_PROJECT_REPO;
  process.env.PALANTIR_PROJECT_REPO = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev;
  });
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const executionEngine = stubExecEngine();
  const profile = seedProfile(db, { max: 1 });
  const gitProject = projectService.createProject({
    name: 'Git',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
  });
  const legacyProject = projectService.createProject({
    name: 'Legacy',
    directory: process.cwd(),
  });
  const gitTask = seedTask(taskService, gitProject.id, 'git');
  const legacyTask = seedTask(taskService, legacyProject.id, 'legacy');
  const gitRun = seedRun(runService, gitTask.id, profile.id, 'git');
  const legacyRun = seedRun(runService, legacyTask.id, profile.id, 'legacy');
  runService.claimQueuedRunForMaterialization(gitRun.id);

  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    executionEngine,
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus: null,
    presetService: null,
  });

  await lifecycleService.drainQueue(profile.id);

  assert.equal(runService.getRun(gitRun.id).status, 'materializing');
  assert.equal(runService.getRun(legacyRun.id).status, 'running');
  assert.equal(executionEngine.spawned.length, 1);
  assert.equal(executionEngine.spawned[0].runId, legacyRun.id);
});

test('materializer throw after claim requeues instead of leaving materializing', async (t) => {
  const root = await tempRoot(t, 'project-materialization-throw-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const profile = seedProfile(db, { max: 1 });
  const project = projectService.createProject({
    name: 'Git',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
  });
  const task = seedTask(taskService, project.id, 'git');
  const run = seedRun(runService, task.id, profile.id, 'git');
  const nodeService = {
    getNode() { return { id: 'local', kind: 'local', reachable: 1, can_execute: 1, files_only: 0, cordoned: 0 }; },
  };
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    executionEngine: stubExecEngine(),
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus: null,
    presetService: null,
    nodeService,
    projectMaterializationService: {
      ensureWorkspace() { throw new Error('flag flipped off'); },
    },
  });

  await lifecycleService.drainQueue(profile.id);
  await waitFor(() => runService.getRun(run.id).status === 'queued');
  lifecycleService.stopMonitoring();

  const after = runService.getRun(run.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.materialize_attempts, 1);
  assert.match(after.materialize_last_error, /flag flipped off/);
  assert.equal(runService.getRunEvents(run.id).some((e) => e.event_type === 'materialize:failed'), true);
});

test('ready cache loser skips fetch while winner holds single-flight lease', async (t) => {
  const root = await tempRoot(t, 'project-materialization-ready-lease-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const executor = fakeGitExecutor();
  const h = buildMaterializeHarness(db, { executor });
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
    repo_ref: 'main',
  });
  const paths = h.materializationService.buildPaths({
    project,
    nodeId: 'local',
    source: { repoUrl: project.repo_url, repoRef: project.repo_ref },
  });
  fs.mkdirSync(path.join(paths.cachePath, '.git'), { recursive: true });
  h.runService.markProjectNodeWorkspaceReady({
    project_id: project.id,
    node_id: 'local',
    source_generation: project.source_generation,
    repo_url: project.repo_url,
    repo_ref: project.repo_ref,
    repo_cache_path: paths.cachePath,
    resolved_commit: '0123456789012345678901234567890123456789',
  });
  const held = h.runService.acquireMaterializationLease({
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    ownerRunId: 'run_holder',
  });
  assert.equal(held.acquired, true);
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);
  h.runService.claimQueuedRunForMaterialization(run.id);

  const result = await h.materializationService.ensureWorkspace({ project, nodeId: 'local', runId: run.id });

  assert.equal(result.ready, true);
  assert.equal(executor.calls.filter((c) => c.args[0] === 'fetch').length, 0);
  assert.equal(executor.calls.filter((c) => c.args[0] === 'clone').length, 0);
  assert.equal(h.runService.getRun(run.id).status, 'queued');
});

test('stale lease uses heartbeat and valid cache is reused without reclone', async (t) => {
  const root = await tempRoot(t, 'project-materialization-stale-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const executor = fakeGitExecutor();
  const h = buildMaterializeHarness(db, { executor });
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
    repo_ref: 'main',
  });
  const paths = h.materializationService.buildPaths({
    project,
    nodeId: 'local',
    source: { repoUrl: project.repo_url, repoRef: project.repo_ref },
  });
  fs.mkdirSync(path.join(paths.cachePath, '.git'), { recursive: true });
  const lease = h.runService.acquireMaterializationLease({
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    ownerRunId: 'run_holder',
  });
  db.prepare(`UPDATE project_materialization_leases SET locked_at = '2000-01-01 00:00:00' WHERE claim_token = ?`).run(lease.token);
  assert.equal(h.runService.touchMaterializationLease(lease.token), 1);
  const blocked = h.runService.acquireMaterializationLease({
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    ownerRunId: 'run_blocked',
    staleMs: 60 * 60 * 1000,
  });
  assert.equal(blocked.pending, true, 'heartbeat prevents stale steal');
  h.runService.releaseMaterializationLease(lease.token, { status: 'failed' });

  const stale = h.runService.acquireMaterializationLease({
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    ownerRunId: 'run_stale',
  });
  db.prepare(`UPDATE project_materialization_leases SET locked_at = '2000-01-01 00:00:00' WHERE claim_token = ?`).run(stale.token);
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);
  h.runService.claimQueuedRunForMaterialization(run.id);

  const result = await h.materializationService.ensureWorkspace({ project, nodeId: 'local', runId: run.id });

  assert.equal(result.ready, true);
  assert.equal(executor.calls.filter((c) => c.args[0] === 'clone').length, 0, 'valid cache must not be removed and recloned');
  assert.equal(executor.calls.some((c) => c.args[0] === 'fetch'), true);
});

test('lease stale config is clamped above git timeout', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const materializationService = createProjectMaterializationService({
    runService,
    gitTimeoutMs: 1000,
    leaseStaleMs: 1,
  });

  const config = materializationService.getConfig();

  assert.equal(config.gitTimeoutMs, 1000);
  assert.equal(config.leaseStaleMs, 1);
  assert.equal(config.effectiveLeaseStaleMs, 62000);
});

test('failed worktree add prunes so the same run can retry', async (t) => {
  const root = await tempRoot(t, 'project-materialization-worktree-retry-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const executor = fakeGitExecutor({ failFirstWorktreeAdd: true });
  const h = buildMaterializeHarness(db, { executor });
  const agentProfileService = createAgentProfileService(db);
  const profile = seedProfile(db, { max: 0 });
  const project = h.projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
    repo_ref: 'main',
  });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);
  const lifecycleService = createLifecycleService({
    runService: h.runService,
    taskService: h.taskService,
    agentProfileService,
    projectService: h.projectService,
    executionEngine: stubExecEngine(),
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus: null,
    presetService: null,
    nodeService: h.nodeService,
    projectMaterializationService: h.materializationService,
  });

  await lifecycleService.drainQueue(profile.id);
  await waitFor(() => {
    const current = h.runService.getRun(run.id);
    return current.status === 'queued' && Number(current.materialize_attempts || 0) === 1;
  });
  assert.match(h.runService.getRun(run.id).materialize_last_error, /worktree add failed/);

  db.prepare("UPDATE runs SET materialize_run_after = datetime('now', '-1 second') WHERE id = ?").run(run.id);
  await lifecycleService.drainQueue(profile.id);
  await waitFor(() => {
    const current = h.runService.getRun(run.id);
    return current.status === 'queued' && Boolean(current.workspace_path) && Boolean(current.resolved_commit);
  });
  lifecycleService.stopMonitoring();
  const after = h.runService.getRun(run.id);
  const addCalls = executor.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
  const pruneCalls = executor.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'prune');

  assert.equal(after.materialize_attempts, 1);
  assert.equal(after.resolved_commit, '0123456789012345678901234567890123456789');
  assert.equal(addCalls.length, 2);
  assert.ok(pruneCalls.length >= 1);
});

test('CAS mismatch after worktree add cleans worktree and releases ref', async (t) => {
  const root = await tempRoot(t, 'project-materialization-cas-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const taskService = createTaskService(db);
  const profile = seedProfile(db);
  const project = projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
    repo_ref: 'main',
  });
  const task = seedTask(taskService, project.id);
  const run = seedRun(runService, task.id, profile.id);
  const materializeClaim = runService.claimQueuedRunForMaterialization(run.id);
  const commit = '0123456789012345678901234567890123456789';
  const calls = [];
  const executor = {
    calls,
    async exec(command, args) {
      calls.push({ command, args });
      if (args[0] === 'rev-parse') return { code: 0, stdout: args[1] === '--git-dir' ? '.git\n' : `${commit}\n`, stderr: '' };
      if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        fs.mkdirSync(args[3], { recursive: true });
        runService.updateRunStatus(run.id, 'cancelled');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'clone') {
        fs.mkdirSync(path.join(args[4], '.git'), { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async fileExists(target) { return fs.existsSync(target); },
    async mkdir(target, options = {}) { fs.mkdirSync(target, options); },
    async rmrf(target) { fs.rmSync(target, { recursive: true, force: true }); },
    async move(src, dst) { fs.renameSync(src, dst); },
    async readFile(target) { return fs.readFileSync(target, 'utf8'); },
  };
  const nodeService = {
    pickExecutor() { return executor; },
    getNode() { return { id: 'local', kind: 'local', reachable: 1, can_execute: 1, files_only: 0, cordoned: 0 }; },
  };
  const materializationService = createProjectMaterializationService({ runService, projectService, nodeService });

  const result = await materializationService.ensureWorkspace({
    project,
    nodeId: 'local',
    runId: run.id,
    claimToken: materializeClaim.token,
  });

  const after = runService.getRun(run.id);
  assert.equal(result.stale, true);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.workspace_path, null);
  assert.equal(after.resolved_commit, null);
  assert.equal(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove'), true);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM project_workspace_refs WHERE run_id = ?').get(run.id).count,
    0,
  );
});

test('stale attempt cleanup does not remove winner worktree or ref', async (t) => {
  const root = await tempRoot(t, 'project-materialization-token-scope-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const executor = fakeGitExecutor();
  const h = buildMaterializeHarness(db, { executor });
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
    repo_ref: 'main',
  });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);
  const staleClaim = h.runService.claimQueuedRunForMaterialization(run.id);
  const paths = h.materializationService.buildPaths({
    project,
    nodeId: 'local',
    source: { repoUrl: project.repo_url, repoRef: project.repo_ref },
  });
  const winnerToken = 'winner-token';
  const winnerPath = h.materializationService.buildAttemptWorkspacePath({
    workspaceBase: paths.workspaceBase,
    runId: run.id,
    claimToken: winnerToken,
  });
  const stalePath = h.materializationService.buildAttemptWorkspacePath({
    workspaceBase: paths.workspaceBase,
    runId: run.id,
    claimToken: staleClaim.token,
  });
  fs.mkdirSync(winnerPath, { recursive: true });
  fs.writeFileSync(path.join(winnerPath, 'alive.txt'), 'winner');
  db.prepare(`
    UPDATE runs
       SET status = 'queued',
           workspace_path = ?,
           workspace_generation = ?,
           resolved_commit = ?,
           repo_cache_path = ?,
           materialize_claim_token = NULL
     WHERE id = ?
  `).run(winnerPath, project.source_generation, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', paths.cachePath, run.id);
  h.runService.acquireWorkspaceRef({
    runId: run.id,
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    repoCachePath: paths.cachePath,
    worktreePath: winnerPath,
  });

  const result = await h.materializationService.ensureWorkspace({
    project,
    nodeId: 'local',
    runId: run.id,
    claimToken: staleClaim.token,
  });
  const after = h.runService.getRun(run.id);

  assert.equal(result.stale, true);
  assert.equal(after.workspace_path, winnerPath);
  assert.equal(fs.existsSync(path.join(winnerPath, 'alive.txt')), true);
  assert.equal(fs.existsSync(stalePath), false);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM project_workspace_refs WHERE run_id = ? AND worktree_path = ? AND released_at IS NULL').get(run.id, winnerPath).count,
    1,
  );
});

test('non-repo claimed run returns to queued through token CAS', async (t) => {
  const root = await tempRoot(t, 'project-materialization-non-repo-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const executor = fakeGitExecutor();
  const h = buildMaterializeHarness(db, { executor });
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'Legacy',
    directory: process.cwd(),
  });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);
  const claim = h.runService.claimQueuedRunForMaterialization(run.id);
  db.prepare(`
    UPDATE runs
       SET materialize_started_at = '2000-01-01 00:00:00',
           materialize_last_error = 'old error'
     WHERE id = ?
  `).run(run.id);

  const result = await h.materializationService.ensureWorkspace({
    project,
    nodeId: 'local',
    runId: run.id,
    claimToken: claim.token,
  });
  const after = h.runService.getRun(run.id);

  assert.equal(result.skipped, true);
  assert.equal(after.status, 'queued');
  assert.equal(after.materialize_claim_token, null);
  assert.equal(after.materialize_started_at, null);
  assert.equal(after.materialize_last_error, null);
  assert.equal(after.started_at, null);
  assert.equal(executor.calls.length, 0);
});

test('remote node without exposed_roots is unsupported and never picks executor', async (t) => {
  const root = await tempRoot(t, 'project-materialization-remote-');
  withRepoEnv(t, root);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const taskService = createTaskService(db);
  const profile = seedProfile(db);
  const project = projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: 'https://github.com/acme/repo.git',
    repo_ref: 'main',
  });
  const task = seedTask(taskService, project.id);
  const run = seedRun(runService, task.id, profile.id);
  runService.claimQueuedRunForMaterialization(run.id);
  let picked = 0;
  const nodeService = {
    getNode() { return { id: 'node_remote', kind: 'ssh', reachable: 1, can_execute: 1, files_only: 0, cordoned: 0 }; },
    pickExecutor() { picked++; throw new Error('must not pick executor for malformed remote materialization'); },
  };
  const materializationService = createProjectMaterializationService({ runService, projectService, nodeService });

  const result = await materializationService.ensureWorkspace({ project, nodeId: 'node_remote', runId: run.id });

  assert.equal(result.unsupported, true);
  assert.equal(result.pending, false);
  assert.equal(picked, 0);
  assert.equal(runService.getRun(run.id).status, 'materializing');
});

test('stuck materializing sweep requeues orphan even when repo flag is off', async (t) => {
  const prev = process.env.PALANTIR_PROJECT_REPO;
  process.env.PALANTIR_PROJECT_REPO = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev;
  });
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const profile = seedProfile(db, { max: 1 });
  const project = projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
  });
  const task = seedTask(taskService, project.id);
  const run = seedRun(runService, task.id, profile.id);
  runService.claimQueuedRunForMaterialization(run.id);
  db.prepare(`UPDATE runs SET materialize_started_at = '2000-01-01 00:00:00' WHERE id = ?`).run(run.id);
  process.env.PALANTIR_PROJECT_REPO = '0';
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    executionEngine: stubExecEngine(),
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus: null,
    presetService: null,
    materializeStuckMs: 1,
    now: () => Date.now(),
  });

  assert.equal(lifecycleService.sweepStuckMaterializations(), 1);

  const after = runService.getRun(run.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.materialize_attempts, 1);
});

test('stuck materializing sweep force-recovers tokenless rows', async (t) => {
  const prev = process.env.PALANTIR_PROJECT_REPO;
  process.env.PALANTIR_PROJECT_REPO = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev;
  });
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const profile = seedProfile(db, { max: 1 });
  const project = projectService.createProject({
    name: 'Repo',
    source_type: 'git',
    repo_url: '/tmp/repo-source',
  });
  const taskA = seedTask(taskService, project.id, 'tokenless retry');
  const taskB = seedTask(taskService, project.id, 'tokenless fail');
  const runA = seedRun(runService, taskA.id, profile.id, 'retry');
  const runB = seedRun(runService, taskB.id, profile.id, 'fail');
  runService.claimQueuedRunForMaterialization(runA.id);
  runService.claimQueuedRunForMaterialization(runB.id);
  db.prepare(`
    UPDATE runs
       SET materialize_started_at = '2000-01-01 00:00:00',
           materialize_claim_token = NULL,
           materialize_attempts = ?
     WHERE id = ?
  `).run(0, runA.id);
  db.prepare(`
    UPDATE runs
       SET materialize_started_at = '2000-01-01 00:00:00',
           materialize_claim_token = NULL,
           materialize_attempts = ?
     WHERE id = ?
  `).run(3, runB.id);
  process.env.PALANTIR_PROJECT_REPO = '0';
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    executionEngine: stubExecEngine(),
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus: null,
    presetService: null,
    materializeStuckMs: 1,
    now: () => Date.now(),
  });

  assert.equal(lifecycleService.sweepStuckMaterializations(), 2);

  const afterA = runService.getRun(runA.id);
  const afterB = runService.getRun(runB.id);
  assert.equal(afterA.status, 'queued');
  assert.equal(afterA.materialize_attempts, 1);
  assert.equal(afterA.materialize_claim_token, null);
  assert.equal(afterB.status, 'failed');
  assert.equal(afterB.materialize_attempts, 4);
  assert.equal(afterB.materialize_claim_token, null);
});
