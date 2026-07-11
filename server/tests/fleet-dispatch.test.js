const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createNodeService } = require('../services/nodeService');
const { createLifecycleService } = require('../services/lifecycleService');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fleet-dispatch-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function stubExecEngine() {
  const spawned = [];
  const killed = [];
  const inputs = [];
  return {
    type: 'subprocess',
    spawned,
    killed,
    inputs,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `local-${runId}` };
    },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput(runId, text) { inputs.push({ runId, text }); return true; },
    kill(runId) { killed.push(runId); return true; },
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function stubStreamJsonEngine() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: null };
    },
    hasProcess() { return false; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    sendInput() { return true; },
    kill() { return true; },
  };
}

function makeRemoteChannel({ alive = true, exitCode = null, output = '' } = {}) {
  const channel = {
    spawned: [],
    killed: [],
    ownerCalls: [],
    isAliveCalls: [],
    detectExitCodeCalls: [],
    getOutputCalls: [],
    async spawnWorker(runId, payload) {
      channel.spawned.push({ runId, payload });
      return { sessionName: `remote-${runId}` };
    },
    async ownerOf(runId) {
      channel.ownerCalls.push({ runId });
      return 'cli';
    },
    async isAlive(runId, engine) {
      channel.isAliveCalls.push({ runId, engine });
      return alive;
    },
    async detectExitCode(runId, engine) {
      channel.detectExitCodeCalls.push({ runId, engine });
      return exitCode;
    },
    async getOutput(runId, lines, engine) {
      channel.getOutputCalls.push({ runId, lines, engine });
      return output;
    },
    async sendInput() {
      return false;
    },
    async kill(runId, engine) {
      channel.killed.push({ runId, engine });
      return true;
    },
    async cleanupRun() {},
  };
  return channel;
}

function buildHarness(db, { remoteChannel = makeRemoteChannel(), worktreeService = null } = {}) {
  const remoteFactoryCalls = [];
  const nodeService = createNodeService(db, {
    createRemoteExecutor(node) {
      remoteFactoryCalls.push(node);
      return remoteChannel;
    },
  });
  const pickedNodeIds = [];
  const basePickExecutor = nodeService.pickExecutor.bind(nodeService);
  nodeService.pickExecutor = (nodeId) => {
    pickedNodeIds.push(nodeId);
    return basePickExecutor(nodeId);
  };

  const runService = createRunService(db, null);
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
    nodeService,
    executionEngine,
    streamJsonEngine,
    worktreeService,
    harvestService: null,
    eventBus: null,
    presetService: null,
  });

  return {
    nodeService,
    runService,
    taskService,
    projectService,
    agentProfileService,
    executionEngine,
    streamJsonEngine,
    lifecycleService,
    remoteChannel,
    remoteFactoryCalls,
    pickedNodeIds,
  };
}

function seedProfile(db, { command = 'codex', max = 5 } = {}) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'FleetDispatchAgent', 'codex', ?, '{prompt}', '{}', '[]', ?)
  `).run(id, command, max);
  return { id, command, max_concurrent: max };
}

function seedTask(taskService, projectId) {
  return taskService.createTask({
    project_id: projectId,
    title: `T-${Math.random().toString(36).slice(2)}`,
    description: 'fleet dispatch test',
    status: 'in_progress',
  });
}

function createSshNode(nodeService, fields = {}) {
  return nodeService.createNode({
    id: 'ssh-pod',
    name: 'SSH Pod',
    kind: 'ssh',
    ssh_host: 'pod.example',
    ssh_user: 'runner',
    exposed_roots: ['/workspace'],
    can_execute: true,
    reachable: true,
    node_prefix: '/opt/codex/bin',
    ...fields,
  });
}

test('reachable executable ssh node dispatches through pickExecutor and remote workerPath', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel();
  const h = buildHarness(db, {
    remoteChannel,
    worktreeService: {
      classifyProjectDir() { throw new Error('remote spawn must not classify local worktrees'); },
      createWorktree() { throw new Error('remote spawn must not create local worktrees'); },
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemoteProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run remotely',
  });

  assert.equal(run.status, 'running');
  assert.equal(h.pickedNodeIds.length, 1);
  assert.equal(h.pickedNodeIds[0], 'ssh-pod');
  assert.equal(h.remoteFactoryCalls.length, 1);
  assert.equal(remoteChannel.spawned.length, 1);
  assert.equal(h.executionEngine.spawned.length, 0, 'local executionEngine was not used');
  const spawn = remoteChannel.spawned[0];
  assert.equal(spawn.runId, run.id);
  assert.equal(spawn.payload.engine, 'cli');
  assert.equal(spawn.payload.spec.command, 'codex');
  // F-1: codex workers are pinned to the standard service tier (leaf `-c`
  // override, before the args_template) so a batch run never inherits the
  // user's ~/.codex/config.toml service_tier="fast".
  assert.deepEqual(spawn.payload.spec.args, ['-c', 'service_tier="default"', 'run remotely']);
  assert.equal(spawn.payload.spec.cwd, '/workspace/project');
  assert.equal(spawn.payload.spec.workerPath, '/opt/codex/bin');
  assert.equal(h.runService.getRun(run.id).tmux_session, `remote-${run.id}`);
});

test('unreachable ssh node remains queued until heartbeat reachability', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel();
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService, { reachable: false });
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemoteProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'wait for heartbeat',
  });

  assert.equal(run.status, 'queued');
  assert.equal(h.pickedNodeIds.length, 0);
  assert.equal(remoteChannel.spawned.length, 0);
});

test('local runs keep using the injected global worker channel', async (t) => {
  const db = await mkdb(t);
  const h = buildHarness(db);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({ name: 'LocalProject' });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run locally',
  });

  assert.equal(run.status, 'running');
  assert.equal(h.pickedNodeIds.length, 0, 'local dispatch bypasses nodeService.pickExecutor');
  assert.equal(h.executionEngine.spawned.length, 1);
  assert.equal(h.remoteChannel.spawned.length, 0);
  assert.equal(h.executionEngine.spawned[0].opts.workerPath, undefined);
});

test('remote claude stream-json worker fails closed without spawning', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel();
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'claude remotely',
  });

  assert.equal(run.status, 'failed');
  assert.equal(remoteChannel.spawned.length, 0);
  assert.equal(h.streamJsonEngine.spawned.length, 0);
  assert.equal(h.executionEngine.spawned.length, 0);
  const events = h.runService.getRunEvents(run.id);
  assert.ok(events.some(e => e.event_type === 'spawn:remote_claude_unsupported'));
});

test('async remote health completes a run when detectExitCode resolves zero', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel({ alive: true, exitCode: 0, output: 'done' });
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemoteProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.markRunStarted(run.id, { tmux_session: `remote-${run.id}` });

  await h.lifecycleService.checkHealth();

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.exit_code, 0);
  assert.equal(remoteChannel.killed.length, 1);
});

test('async remote health handles dead process with unresolved exit code', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: null, output: '' });
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemoteProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.markRunStarted(run.id, { tmux_session: `remote-${run.id}` });

  await h.lifecycleService.checkHealth();

  assert.equal(h.runService.getRun(run.id).status, 'failed');
  assert.equal(remoteChannel.killed.length, 1);
});
