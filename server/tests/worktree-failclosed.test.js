const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createEventBus } = require('../services/eventBus');
const { createWorktreeService } = require('../services/worktreeService');

async function mkdb(t, prefix = 'palantir-wt-failclosed-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return { db };
}

async function tmpdir(t, prefix = 'palantir-wt-project-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

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
    spawned: [],
    spawnAgent(runId, opts) {
      this.spawned.push({ runId, opts });
      return { sessionName: null };
    },
    hasProcess() { return false; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    sendInput() { return true; },
    kill() { return true; },
  };
}

function seedProfile(db, { command = 'codex' } = {}) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'WorktreeAgent', 'codex', ?, '{prompt}', '{}', '[]', 1)
  `).run(id, command);
  return { id, command };
}

function buildHarness(db, { eventBus = null, worktreeService = null } = {}) {
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const executionEngine = stubExecEngine();
  const streamJsonEngine = stubStreamJsonEngine();
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    executionEngine,
    streamJsonEngine,
    worktreeService,
    harvestService: null,
    eventBus,
    presetService: null,
  });
  return {
    runService,
    taskService,
    projectService,
    agentProfileService,
    executionEngine,
    streamJsonEngine,
    lifecycleService,
  };
}

function seedProject(projectService, fields = {}) {
  return projectService.createProject({
    name: `P-${Math.random().toString(36).slice(2)}`,
    ...fields,
  });
}

function seedTask(taskService, projectId = null) {
  return taskService.createTask({
    project_id: projectId,
    title: `T-${Math.random().toString(36).slice(2)}`,
    description: 'worktree fail-closed test',
    status: 'in_progress',
  });
}

function seedRun(runService, taskId, profileId, prompt = 'run') {
  return runService.createRun({
    task_id: taskId,
    agent_profile_id: profileId,
    prompt,
    queued_args: null,
    retry_count: 0,
  });
}

function eventsOf(runService, runId, type) {
  return runService.getRunEvents(runId).filter((evt) => evt.event_type === type);
}

function parsePayload(evt) {
  const raw = evt.payload_json ?? evt.payload ?? '{}';
  return raw ? JSON.parse(raw) : {};
}

function fakeClassifyExecutor(mode, seenOpts = []) {
  return {
    async exec(_command, args, opts) {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
        seenOpts.push(opts);
        if (mode === 'git') return { code: 0, stdout: '.git\n', stderr: '' };
        if (mode === 'non_git') {
          return {
            code: 128,
            stdout: '',
            stderr: 'fatal: not a git repository (or any of the parent directories): .git',
          };
        }
        const err = new Error('spawn git ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

test('classifyProjectDir reports git, non_git, and unknown via injected nodeExecutor', async () => {
  const seenOpts = [];
  assert.equal(await createWorktreeService({ nodeExecutor: fakeClassifyExecutor('git', seenOpts) }).classifyProjectDir('/repo'), 'git');
  assert.equal(await createWorktreeService({ nodeExecutor: fakeClassifyExecutor('non_git', seenOpts) }).classifyProjectDir('/plain'), 'non_git');
  assert.equal(await createWorktreeService({ nodeExecutor: fakeClassifyExecutor('unknown', seenOpts) }).classifyProjectDir('/repo'), 'unknown');
  // Lock the locale override: stderr matching breaks on non-English git
  // (found live on this ko_KR host) — every classify exec must force C locale.
  assert.equal(seenOpts.length, 3);
  for (const opts of seenOpts) {
    assert.equal(opts.env.LC_ALL, 'C');
    assert.equal(opts.env.LANG, 'C');
  }
});

test('classifyProjectDir classifies real git and real non-git directories', async (t) => {
  const root = await tmpdir(t, 'palantir-wt-real-');
  const repoDir = path.join(root, 'repo');
  const plainDir = path.join(root, 'plain');
  fs.mkdirSync(repoDir);
  fs.mkdirSync(plainDir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });

  const ws = createWorktreeService();
  assert.equal(await ws.classifyProjectDir(repoDir), 'git');
  assert.equal(await ws.classifyProjectDir(plainDir), 'non_git');
});

test('createWorktree throws on non-git directories', async () => {
  const ws = createWorktreeService({ nodeExecutor: fakeClassifyExecutor('non_git') });
  await assert.rejects(() => ws.createWorktree('/plain', 'palantir/non-git'), /non_git project directory/);
});

test('createWorktree throws on worktree add failure and attempts branch rollback', async () => {
  const calls = [];
  const fake = {
    async exec(_command, args) {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { code: 0, stdout: '.git\n', stderr: '' };
      if (args[0] === 'branch' && args[1] === '--show-current') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'branch' && args[1] === 'palantir/add-fail') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { code: 1, stdout: '', stderr: 'add failed' };
      if (args[0] === 'branch' && args[1] === '-D') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async fileExists() { return false; },
    async mkdir() {},
  };
  const ws = createWorktreeService({ nodeExecutor: fake });

  await assert.rejects(() => ws.createWorktree('/repo', 'palantir/add-fail'), /add failed/);
  assert.ok(calls.some((args) => args[0] === 'branch' && args[1] === '-D' && args[2] === 'palantir/add-fail'));
});

test('spawnQueuedRun fails closed when git worktree creation fails', async (t) => {
  const { db } = await mkdb(t);
  const projectDir = await tmpdir(t);
  const worktreeService = {
    classifyProjectDir() { return 'git'; },
    createWorktree() { throw new Error('worktree add exploded'); },
  };
  const h = buildHarness(db, { worktreeService });
  const profile = seedProfile(db);
  const project = seedProject(h.projectService, { directory: projectDir });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);

  await assert.rejects(() => h.lifecycleService.spawnQueuedRun(run.id), /Worktree creation failed/);

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.retry_count, 0);
  assert.equal(h.executionEngine.spawned.length, 0);
  assert.deepEqual(parsePayload(eventsOf(h.runService, run.id, 'worktree:create_failed')[0]), { reason: 'worktree_add_failed' });
});

test('spawnQueuedRun fails closed when git classification is unknown', async (t) => {
  const { db } = await mkdb(t);
  const projectDir = await tmpdir(t);
  const h = buildHarness(db, {
    worktreeService: {
      classifyProjectDir() { return 'unknown'; },
      createWorktree() { throw new Error('should not create worktree'); },
    },
  });
  const profile = seedProfile(db);
  const project = seedProject(h.projectService, { directory: projectDir });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);

  await assert.rejects(() => h.lifecycleService.spawnQueuedRun(run.id), /classification failed/);

  assert.equal(h.runService.getRun(run.id).status, 'failed');
  assert.equal(h.executionEngine.spawned.length, 0);
  assert.deepEqual(parsePayload(eventsOf(h.runService, run.id, 'worktree:create_failed')[0]), { reason: 'git_classify_failed' });
});

test('spawnQueuedRun exhausts retry budget for non-git projects without opt-in', async (t) => {
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const projectDir = await tmpdir(t);
  const h = buildHarness(db, {
    eventBus,
    worktreeService: {
      classifyProjectDir() { return 'non_git'; },
      createWorktree() { throw new Error('should not create worktree'); },
    },
  });
  t.after(() => h.lifecycleService.stopMonitoring());
  h.lifecycleService.startMonitoring();
  const profile = seedProfile(db);
  const project = seedProject(h.projectService, { directory: projectDir });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);

  await assert.rejects(() => h.lifecycleService.spawnQueuedRun(run.id), /Non-git project directory/);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.retry_count, 1);
  assert.equal(h.executionEngine.spawned.length, 0);
  assert.equal(h.runService.listRuns({ task_id: task.id }).length, 1);
  assert.deepEqual(parsePayload(eventsOf(h.runService, run.id, 'worktree:create_failed')[0]), { reason: 'non_git_not_allowed' });
});

test('spawnQueuedRun allows non-git project directories with explicit opt-in', async (t) => {
  const { db } = await mkdb(t);
  const projectDir = await tmpdir(t);
  const h = buildHarness(db, {
    worktreeService: {
      classifyProjectDir() { return 'non_git'; },
      createWorktree() { throw new Error('should not create worktree'); },
    },
  });
  const profile = seedProfile(db);
  const project = seedProject(h.projectService, { directory: projectDir, allow_non_git_dir: 1 });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);

  const spawned = await h.lifecycleService.spawnQueuedRun(run.id);

  assert.equal(spawned.status, 'running');
  assert.equal(h.executionEngine.spawned.length, 1);
  assert.equal(h.executionEngine.spawned[0].opts.cwd, projectDir);
  assert.equal(eventsOf(h.runService, run.id, 'worktree:create_failed').length, 0);
  const optInEvents = eventsOf(h.runService, run.id, 'worktree:shared_dir_optin');
  assert.equal(optInEvents.length, 1);
  assert.deepEqual(parsePayload(optInEvents[0]), {});
});

test('spawnQueuedRun leaves projectless tasks on the legacy cwd path without worktree events', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db, {
    worktreeService: {
      classifyProjectDir() { throw new Error('should not classify projectless task'); },
      createWorktree() { throw new Error('should not create worktree'); },
    },
  });
  const profile = seedProfile(db);
  const task = seedTask(h.taskService, null);
  const run = seedRun(h.runService, task.id, profile.id);

  await h.lifecycleService.spawnQueuedRun(run.id);

  assert.equal(h.executionEngine.spawned.length, 1);
  assert.equal(h.executionEngine.spawned[0].opts.cwd, process.cwd());
  assert.equal(eventsOf(h.runService, run.id, 'worktree:create_failed').length, 0);
  assert.equal(eventsOf(h.runService, run.id, 'worktree:shared_dir_optin').length, 0);
});

test('spawnQueuedRun preserves legacy projectDir behavior when worktreeService is not injected', async (t) => {
  const { db } = await mkdb(t);
  const projectDir = await tmpdir(t);
  const h = buildHarness(db, { worktreeService: null });
  const profile = seedProfile(db);
  const project = seedProject(h.projectService, { directory: projectDir });
  const task = seedTask(h.taskService, project.id);
  const run = seedRun(h.runService, task.id, profile.id);

  await h.lifecycleService.spawnQueuedRun(run.id);

  assert.equal(h.executionEngine.spawned.length, 1);
  assert.equal(h.executionEngine.spawned[0].opts.cwd, projectDir);
  assert.equal(eventsOf(h.runService, run.id, 'worktree:create_failed').length, 0);
  assert.equal(eventsOf(h.runService, run.id, 'worktree:shared_dir_optin').length, 0);
});

test('executeTask fails git source projects when the repo feature is DISABLED (rollback)', async (t) => {
  // PALANTIR_PROJECT_REPO now defaults ON; this test pins the rollback path —
  // with the flag explicitly OFF a git-source run fails closed rather than
  // materializing (legacy behavior preserved for operators who disable it).
  const prevFlag = process.env.PALANTIR_PROJECT_REPO;
  process.env.PALANTIR_PROJECT_REPO = '0';
  t.after(() => {
    if (prevFlag === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prevFlag;
  });
  const { db } = await mkdb(t);
  const h = buildHarness(db, { worktreeService: null });
  const profile = seedProfile(db);
  const project = seedProject(h.projectService, {
    source_type: 'git',
    repo_url: 'git@github.com:acme/repo.git',
    repo_ref: 'main',
  });
  const task = seedTask(h.taskService, project.id);

  const result = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run',
  });

  const runs = h.runService.listRuns({ task_id: task.id });
  assert.equal(runs.length, 1);
  const run = h.runService.getRun(runs[0].id);
  assert.equal(result.status, 'failed');
  assert.equal(run.status, 'failed');
  assert.equal(h.executionEngine.spawned.length, 0);
  assert.deepEqual(parsePayload(eventsOf(h.runService, run.id, 'run:repo_materialize_unavailable')[0]), {
    project_id: project.id,
  });
});
