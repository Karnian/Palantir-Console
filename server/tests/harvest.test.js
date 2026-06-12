const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createWorktreeService } = require('../services/worktreeService');
const { createHarvestService } = require('../services/harvestService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createEventBus } = require('../services/eventBus');

const fakeRunner = path.join(__dirname, 'fixtures', 'bin', 'fake-test-runner.js');
const injectedTestRunner = { bin: process.execPath, args: [fakeRunner] };

async function mkdb(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-harvest-db-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-harvest-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# harvest\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return dir;
}

function seedProfile(db) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO agent_profiles (id, name, type, command, capabilities_json, env_allowlist, max_concurrent)
     VALUES (?, 'TestAgent', 'codex', 'codex', '{}', '[]', 5)`
  ).run(id);
  return { id };
}

function parseEvent(evt) {
  return JSON.parse(evt.payload_json || '{}');
}

function eventsOf(runService, runId, type) {
  return runService.getRunEvents(runId).filter(evt => evt.event_type === type);
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  assert.ok(predicate(), 'condition was not met before timeout');
}

function makeServices(db, { eventBus = null, worktreeService = createWorktreeService() } = {}) {
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const harvestService = createHarvestService({
    runService,
    worktreeService,
    projectService,
    testRunner: injectedTestRunner,
  });
  return { runService, taskService, projectService, agentProfileService, worktreeService, harvestService };
}

function createRunInWorktree({ db, runService, taskService, projectService, worktreeService, repoDir, testCommand = null }) {
  const project = projectService.createProject({
    name: 'Harvest Project',
    directory: repoDir,
    test_command: testCommand,
  });
  const task = taskService.createTask({ project_id: project.id, title: 'Harvest task' });
  const profile = seedProfile(db);
  const queued = runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'do work',
  });
  const branchName = `palantir/${queued.id.replace(/_/g, '-')}`;
  const wt = worktreeService.createWorktree(repoDir, branchName);
  const running = runService.markRunStarted(queued.id, {
    tmux_session: `session-${queued.id}`,
    worktree_path: wt.path,
    branch: wt.branch,
  });
  return { project, task, profile, run: running, worktreePath: wt.path, branch: wt.branch };
}

test('harvestRun autosaves uncommitted worker changes before diff capture', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath, branch } = createRunInWorktree({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  const diffEvents = eventsOf(services.runService, run.id, 'harvest:diff');
  assert.equal(diffEvents.length, 1);
  const payload = parseEvent(diffEvents[0]);
  assert.ok(payload.files.includes('agent-output.txt'), 'diff includes autosaved uncommitted file');
  assert.ok(payload.commits.some(line => line.includes('[palantir] auto-save')), 'commit list includes autosave commit');
  assert.equal(payload.branch, branch);
  assert.ok(!fs.existsSync(worktreePath), 'worktree removed after harvest');
});

test('harvestRun does not commit files created by the test command', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath, branch } = createRunInWorktree({
    db,
    repoDir,
    testCommand: 'write:test-artifact.txt pass',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  const testEvents = eventsOf(services.runService, run.id, 'harvest:test');
  assert.equal(testEvents.length, 1);
  assert.equal(parseEvent(testEvents[0]).passed, true);
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
    cwd: repoDir,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  assert.match(tree, /agent-output\.txt/);
  assert.doesNotMatch(tree, /test-artifact\.txt/, 'test artifact is discarded instead of committed');
});

test('harvestRun is deduped per run and by existing DB harvest events', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath } = createRunInWorktree({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });

  await services.harvestService.harvestRun(completed, { projectDir: repoDir });
  await services.harvestService.harvestRun(completed, { projectDir: repoDir });

  assert.equal(eventsOf(services.runService, run.id, 'harvest:diff').length, 1);
  assert.equal(eventsOf(services.runService, run.id, 'harvest:error').length, 0);

  const second = createRunInWorktree({ db, repoDir, ...services });
  const secondCompleted = services.runService.updateRunStatus(second.run.id, 'completed', { force: true });
  services.runService.addRunEvent(second.run.id, 'harvest:error', JSON.stringify({ stage: 'preexisting', error: 'done' }));
  await services.harvestService.harvestRun(secondCompleted, { projectDir: repoDir });
  assert.equal(eventsOf(services.runService, second.run.id, 'harvest:error').length, 1);
  assert.ok(fs.existsSync(second.worktreePath), 'preexisting DB harvest event skips new harvest work');
});

test('harvestRun never throws when stages fail', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const real = makeServices(db);
  const brokenWorktreeService = {
    autoSaveWorktree() { throw new Error('autosave broke'); },
    getWorktreeDiff() { throw new Error('diff broke'); },
    removeWorktree() { throw new Error('cleanup broke'); },
  };
  const harvestService = createHarvestService({
    runService: real.runService,
    worktreeService: brokenWorktreeService,
    projectService: real.projectService,
    testRunner: injectedTestRunner,
  });
  const { run } = createRunInWorktree({ db, repoDir, ...real });
  const completed = real.runService.updateRunStatus(run.id, 'completed', { force: true });

  await assert.doesNotReject(() => harvestService.harvestRun(completed, { projectDir: repoDir }));

  const stages = eventsOf(real.runService, run.id, 'harvest:error').map(evt => parseEvent(evt).stage);
  assert.ok(stages.includes('autosave'));
  assert.ok(stages.includes('diff'));
  assert.ok(stages.includes('cleanup'));
});

test('harvestRun skips cancelled and manager runs', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath, branch } = createRunInWorktree({ db, repoDir, ...services });
  const cancelled = services.runService.updateRunStatus(run.id, 'cancelled', { force: true });

  await services.harvestService.harvestRun(cancelled, { projectDir: repoDir });
  assert.equal(eventsOf(services.runService, run.id, 'harvest:diff').length, 0);
  assert.ok(fs.existsSync(worktreePath), 'direct service skip leaves cancelled cleanup to lifecycle');

  const manager = services.runService.createRun({
    is_manager: true,
    prompt: 'manage',
    manager_adapter: 'codex',
    manager_layer: 'top',
    conversation_id: 'top',
  });
  await services.harvestService.harvestRun({
    ...manager,
    status: 'completed',
    is_manager: 1,
    worktree_path: worktreePath,
    branch,
  }, { projectDir: repoDir });
  assert.equal(eventsOf(services.runService, manager.id, 'harvest:diff').length, 0);
});

test('harvestRun tolerates DELETE race without throwing', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath } = createRunInWorktree({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });
  services.runService.deleteRun(run.id);

  await assert.doesNotReject(() => services.harvestService.harvestRun(completed, { projectDir: repoDir }));
  assert.ok(!fs.existsSync(worktreePath), 'harvest still performs best-effort cleanup after run deletion');
});

test('harvestRun records timed-out test results', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath } = createRunInWorktree({
    db,
    repoDir,
    testCommand: 'sleep:250 pass',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const completed = services.runService.updateRunStatus(run.id, 'completed', { force: true });
  const prev = process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS;
  process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS = '50';
  try {
    await services.harvestService.harvestRun(completed, { projectDir: repoDir });
  } finally {
    if (prev === undefined) delete process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS;
    else process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS = prev;
  }

  const payload = parseEvent(eventsOf(services.runService, run.id, 'harvest:test')[0]);
  assert.equal(payload.timed_out, true);
  assert.equal(payload.passed, false);
  assert.equal(payload.exit_code, null);
});

test('failed runs capture diff but skip test execution', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath } = createRunInWorktree({
    db,
    repoDir,
    testCommand: 'write:should-not-exist.txt pass',
    ...services,
  });
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  const failed = services.runService.updateRunStatus(run.id, 'failed', { force: true });

  await services.harvestService.harvestRun(failed, { projectDir: repoDir });

  assert.equal(eventsOf(services.runService, run.id, 'harvest:diff').length, 1);
  assert.equal(eventsOf(services.runService, run.id, 'harvest:test').length, 0);
});

test('lifecycle run:ended subscriber runs harvest before removing worktree', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const eventBus = createEventBus();
  const realWorktreeService = createWorktreeService();
  const observed = [];
  let runIdForObservation = null;
  const observingWorktreeService = {
    ...realWorktreeService,
    removeWorktree(projectDir, worktreePath, branch, opts) {
      if (runIdForObservation) {
        observed.push(eventsOf(runService, runIdForObservation, 'harvest:diff').length);
      }
      return realWorktreeService.removeWorktree(projectDir, worktreePath, branch, opts);
    },
  };
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const harvestService = createHarvestService({
    runService,
    worktreeService: observingWorktreeService,
    projectService,
    testRunner: injectedTestRunner,
  });
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    executionEngine: { type: 'subprocess', discoverGhostSessions: () => [] },
    streamJsonEngine: null,
    worktreeService: observingWorktreeService,
    harvestService,
    eventBus,
  });
  t.after(() => lifecycleService.stopMonitoring());

  const { run, worktreePath } = createRunInWorktree({
    db,
    runService,
    taskService,
    projectService,
    worktreeService: observingWorktreeService,
    repoDir,
  });
  runIdForObservation = run.id;
  fs.writeFileSync(path.join(worktreePath, 'agent-output.txt'), 'agent work\n');
  lifecycleService.startMonitoring();
  runService.updateRunStatus(run.id, 'completed', { force: true });

  await waitFor(() => eventsOf(runService, run.id, 'harvest:diff').length === 1 && !fs.existsSync(worktreePath));
  assert.ok(observed.some(count => count > 0), 'removeWorktree observed harvest:diff already recorded');
});

test('boot stale terminal worktree cleanup autosaves remaining work', async (t) => {
  const db = await mkdb(t);
  const repoDir = makeRepo(t);
  const services = makeServices(db);
  const { run, worktreePath, branch } = createRunInWorktree({ db, repoDir, ...services });
  fs.writeFileSync(path.join(worktreePath, 'boot-leftover.txt'), 'leftover work\n');
  services.runService.updateRunStatus(run.id, 'completed', { force: true });
  const lifecycleService = createLifecycleService({
    runService: services.runService,
    taskService: services.taskService,
    agentProfileService: services.agentProfileService,
    projectService: services.projectService,
    executionEngine: { type: 'subprocess', discoverGhostSessions: () => [] },
    streamJsonEngine: null,
    worktreeService: services.worktreeService,
    harvestService: services.harvestService,
    eventBus: null,
  });

  const cleaned = lifecycleService.cleanupStaleTerminalWorktrees();

  assert.equal(cleaned, 1);
  assert.ok(!fs.existsSync(worktreePath), 'stale worktree removed');
  const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], {
    cwd: repoDir,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  assert.match(tree, /boot-leftover\.txt/, 'boot cleanup preserves uncommitted work via autosave');
});
