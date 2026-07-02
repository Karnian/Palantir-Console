const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createDatabase } = require('../db/database');
const { createApp } = require('../app');
const { createEventBus } = require('../services/eventBus');
const { createNodeService } = require('../services/nodeService');
const { createProjectService } = require('../services/projectService');
const { createProjectBriefService } = require('../services/projectBriefService');
const { createTaskService } = require('../services/taskService');
const { createRunService } = require('../services/runService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');

async function mkdb(t, prefix = 'palantir-fleet-nodes-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { db, dbPath, dir };
}

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fs-'));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-db-'));
  const pluginsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-plugins-'));
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath: path.join(dbDir, 'test.db'),
    pluginsRoot,
    opencodeBin: 'opencode',
    authResolverOpts: { hasKeychain: () => false },
    authToken: null,
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown(); else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(pluginsRoot, { recursive: true, force: true });
  });
  return app;
}

function stubExecEngine() {
  const spawned = [];
  return {
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

function buildHarness(db, { eventBus = null } = {}) {
  const nodeService = createNodeService(db);
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
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
    worktreeService: null,
    harvestService: null,
    eventBus,
    presetService: null,
  });
  return {
    nodeService,
    runService,
    taskService,
    projectService,
    projectBriefService,
    agentProfileService,
    executionEngine,
    streamJsonEngine,
    lifecycleService,
  };
}

function seedProfile(db, { max = 1, command = 'codex' } = {}) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'FleetAgent', 'codex', ?, '{prompt}', '{}', '[]', ?)
  `).run(id, command, max);
  return { id, max_concurrent: max, command };
}

function seedProject(projectService, fields = {}) {
  return projectService.createProject({
    name: `P-${Math.random().toString(36).slice(2)}`,
    ...fields,
  });
}

function seedTask(taskService, projectId, fields = {}) {
  return taskService.createTask({
    project_id: projectId,
    title: `T-${Math.random().toString(36).slice(2)}`,
    description: 'fleet test',
    status: 'in_progress',
    ...fields,
  });
}

function createRunningRun(runService, { taskId, profileId, nodeId = null }) {
  const run = runService.createRun({
    task_id: taskId,
    agent_profile_id: profileId,
    prompt: 'running',
    node_id: nodeId,
    queued_args: { skillPackIds: null, presetId: null },
  });
  return runService.markRunStarted(run.id, { tmux_session: `session-${run.id}` });
}

test('migration 047: node invariants, local seed, and immutable identity', async (t) => {
  const { db } = await mkdb(t);
  const local = db.prepare('SELECT * FROM nodes WHERE id = ?').get('local');
  assert.equal(local.name, 'Local');
  assert.equal(local.kind, 'local');
  assert.equal(local.can_execute, 1);
  assert.equal(local.can_control, 1);
  assert.equal(local.reachable, 1);
  assert.equal(local.max_concurrent, null);

  assert.throws(
    () => db.prepare(`INSERT INTO nodes (id, name, kind) VALUES ('bad-kind', 'Bad', 'docker')`).run(),
    /CHECK|constraint/i,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO nodes (id, name, max_concurrent) VALUES ('bad-cap', 'Bad', 0)`).run(),
    /CHECK|constraint/i,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO nodes (id, name, files_only, can_execute) VALUES ('bad-files', 'Bad', 1, 1)`).run(),
    /CHECK|constraint/i,
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO nodes (id, name, kind, ssh_user, exposed_roots)
      VALUES ('bad-ssh', 'Bad', 'ssh', 'me', '["/tmp"]')
    `).run(),
    /CHECK|constraint/i,
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO nodes (id, name, kind, ssh_host, ssh_user, exposed_roots)
      VALUES ('bad-roots', 'Bad', 'ssh', 'host', 'me', '{"root":"/tmp"}')
    `).run(),
    /JSON array|constraint/i,
  );

  db.prepare(`
    INSERT INTO nodes (id, name, kind, ssh_host, ssh_user, exposed_roots)
    VALUES ('ssh-good', 'SSH', 'ssh', 'host', 'me', '["/tmp"]')
  `).run();
  assert.throws(
    () => db.prepare(`UPDATE nodes SET kind = 'local' WHERE id = 'ssh-good'`).run(),
    /kind is immutable|constraint/i,
  );
  assert.throws(
    () => db.prepare(`UPDATE nodes SET id = 'ssh-other' WHERE id = 'ssh-good'`).run(),
    /id is immutable|constraint/i,
  );
});

test('nodeService CRUD validates nodes and refuses unsafe deletes', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db);
  const node = h.nodeService.createNode({
    id: 'pod-a',
    name: 'Pod A',
    kind: 'ssh',
    ssh_host: 'pod-a.local',
    ssh_user: 'runner',
    exposed_roots: ['/tmp'],
    reachable: true,
    max_concurrent: 2,
  });
  assert.equal(node.id, 'pod-a');
  assert.equal(node.exposed_roots, '["/tmp"]');
  assert.equal(h.nodeService.getNode('pod-a').reachable, 1);

  const updated = h.nodeService.updateNode('pod-a', { reachable: false, max_concurrent: null });
  assert.equal(updated.reachable, 0);
  assert.equal(updated.max_concurrent, null);

  assert.throws(
    () => h.nodeService.createNode({ id: 'bad-roots', name: 'Bad', kind: 'ssh', ssh_host: 'h', ssh_user: 'u', exposed_roots: ['relative'] }),
    /absolute path/,
  );
  assert.throws(
    () => h.nodeService.updateNode('pod-a', { kind: 'local' }),
    /kind is immutable/,
  );
  assert.throws(
    () => h.nodeService.deleteNode('local'),
    /local node cannot be deleted/,
  );

  h.nodeService.createNode({ id: 'bound-pod', name: 'Bound', reachable: true });
  seedProject(h.projectService, { node_id: 'bound-pod' });
  assert.throws(
    () => h.nodeService.deleteNode('bound-pod'),
    (err) => err.httpStatus === 409 && /project/.test(err.message),
  );
});

test('/api/nodes routes expose CRUD', async (t) => {
  const app = await createTestApp(t);

  const create = await request(app).post('/api/nodes').send({
    id: 'api-pod',
    name: 'API Pod',
    kind: 'ssh',
    ssh_host: 'api.local',
    ssh_user: 'runner',
    exposed_roots: ['/tmp'],
    reachable: true,
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.node.id, 'api-pod');

  const list = await request(app).get('/api/nodes');
  assert.equal(list.status, 200);
  assert.ok(list.body.nodes.some((node) => node.id === 'local'));
  assert.ok(list.body.nodes.some((node) => node.id === 'api-pod'));

  const patch = await request(app).patch('/api/nodes/api-pod').send({ reachable: false });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.node.reachable, 0);

  const get = await request(app).get('/api/nodes/api-pod');
  assert.equal(get.status, 200);
  assert.equal(get.body.node.name, 'API Pod');

  const del = await request(app).delete('/api/nodes/api-pod');
  assert.equal(del.status, 200);
});

test('executeTask snapshots project node and defaults NULL project node to local', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db);
  h.nodeService.createNode({ id: 'pod-a', name: 'Pod A', reachable: true });
  const profile = seedProfile(db, { max: 3 });

  const boundProject = seedProject(h.projectService, { node_id: 'pod-a' });
  const boundTask = seedTask(h.taskService, boundProject.id);
  const boundRun = await h.lifecycleService.executeTask(boundTask.id, {
    agentProfileId: profile.id,
    prompt: 'bound',
  });
  assert.equal(h.runService.getRun(boundRun.id).node_id, 'pod-a');

  const localProject = seedProject(h.projectService);
  const localTask = seedTask(h.taskService, localProject.id);
  const localRun = await h.lifecycleService.executeTask(localTask.id, {
    agentProfileId: profile.id,
    prompt: 'local',
  });
  assert.equal(h.runService.getRun(localRun.id).node_id, 'local');
});

test('retry runs copy node_id from the failed worker', async (t) => {
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const h = buildHarness(db, { eventBus });
  t.after(() => h.lifecycleService.stopMonitoring());
  h.nodeService.createNode({ id: 'pod-a', name: 'Pod A', reachable: true });
  const project = seedProject(h.projectService, { node_id: 'pod-a' });
  const task = seedTask(h.taskService, project.id);
  const profile = seedProfile(db, { max: 0 });
  const original = createRunningRun(h.runService, {
    taskId: task.id,
    profileId: profile.id,
    nodeId: 'pod-a',
  });

  h.lifecycleService.startMonitoring();
  h.runService.updateRunStatus(original.id, 'failed', { force: true });

  const runs = h.runService.listRuns({ task_id: task.id });
  assert.equal(runs.length, 2);
  const retry = runs.find((run) => run.id !== original.id);
  assert.equal(retry.node_id, 'pod-a');
  assert.equal(retry.retry_count, 1);
});

test('runService per-node queue helpers normalize NULL run node as local', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db);
  h.nodeService.createNode({ id: 'pod-a', name: 'Pod A', reachable: true });
  const profile = seedProfile(db, { max: 5 });
  const project = seedProject(h.projectService);
  const task = seedTask(h.taskService, project.id);

  createRunningRun(h.runService, { taskId: task.id, profileId: profile.id });
  const queuedLocal = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'queued local',
  });
  const queuedPod = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'queued pod',
    node_id: 'pod-a',
  });
  db.prepare(`UPDATE runs SET created_at = '2026-01-01 00:00:01' WHERE id = ?`).run(queuedLocal.id);
  db.prepare(`UPDATE runs SET created_at = '2026-01-01 00:00:02' WHERE id = ?`).run(queuedPod.id);

  assert.equal(h.runService.countRunningOnNode('local', profile.id), 1);
  assert.equal(h.runService.countRunningTotalOnNode('local'), 1);
  assert.equal(h.runService.getOldestQueuedOnNode('local', profile.id).id, queuedLocal.id);
  assert.equal(h.runService.getOldestQueuedOnNode('pod-a', profile.id).id, queuedPod.id);
});

test('drainQueue drains dispatchable nodes independently', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db);
  h.nodeService.createNode({ id: 'pod-a', name: 'Pod A', reachable: true });
  const profile = seedProfile(db, { max: 1 });
  const localProject = seedProject(h.projectService);
  const podProject = seedProject(h.projectService, { node_id: 'pod-a' });
  const localBlockerTask = seedTask(h.taskService, localProject.id);
  const localQueuedTask = seedTask(h.taskService, localProject.id);
  const podQueuedTask = seedTask(h.taskService, podProject.id);
  createRunningRun(h.runService, { taskId: localBlockerTask.id, profileId: profile.id });
  const localQueued = h.runService.createRun({
    task_id: localQueuedTask.id,
    agent_profile_id: profile.id,
    prompt: 'local queued',
    node_id: 'local',
  });
  const podQueued = h.runService.createRun({
    task_id: podQueuedTask.id,
    agent_profile_id: profile.id,
    prompt: 'pod queued',
    node_id: 'pod-a',
  });

  const started = await h.lifecycleService.drainQueue(profile.id);
  assert.equal(started, 1);
  assert.equal(h.runService.getRun(localQueued.id).status, 'queued');
  assert.equal(h.runService.getRun(podQueued.id).status, 'running');
});

test('project rebind guard blocks active Operator affinity and rejects files-only nodes', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db);
  h.nodeService.createNode({ id: 'pod-a', name: 'Pod A', reachable: true });
  h.nodeService.createNode({ id: 'pod-b', name: 'Pod B', reachable: true });
  h.nodeService.createNode({
    id: 'files-node',
    name: 'Files',
    can_execute: false,
    files_only: true,
  });
  const project = seedProject(h.projectService, { node_id: 'pod-a' });

  h.projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread-1',
    pm_adapter: 'codex',
  });

  assert.throws(
    () => h.projectService.updateProject(project.id, { node_id: 'pod-b' }),
    (err) => err.httpStatus === 409 && /reset the operator/.test(err.message),
  );
  assert.equal(h.projectService.updateProject(project.id, { node_id: 'pod-a' }).node_id, 'pod-a');

  h.projectBriefService.clearPmThread(project.id);
  assert.equal(h.projectService.updateProject(project.id, { node_id: 'pod-b' }).node_id, 'pod-b');
  assert.throws(
    () => h.projectService.updateProject(project.id, { node_id: 'files-node' }),
    (err) => err.status === 400 && /cannot host execution/.test(err.message),
  );
});

test('dispatcher refuses nodes downgraded after binding (can_execute/files_only)', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db);
  h.nodeService.createNode({ id: 'pod-a', name: 'Pod A', reachable: true });
  const profile = seedProfile(db, { max: 5 });
  const project = seedProject(h.projectService, { node_id: 'pod-a' });
  const task = seedTask(h.taskService, project.id);
  const queued = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'queued on pod',
    node_id: 'pod-a',
  });

  // Downgrade AFTER binding + enqueue — bind-time validation cannot catch this
  // (Codex P1a review, SERIOUS #1). The dispatcher itself must refuse.
  h.nodeService.updateNode('pod-a', { can_execute: false, files_only: true });

  const started = await h.lifecycleService.drainQueue(profile.id);
  assert.equal(started, 0);
  assert.equal(h.runService.getRun(queued.id).status, 'queued');
});

test('project rebind guard also blocks live Operator runs before thread persist', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db);
  h.nodeService.createNode({ id: 'pod-a', name: 'Pod A', reachable: true });
  h.nodeService.createNode({ id: 'pod-b', name: 'Pod B', reachable: true });
  const project = seedProject(h.projectService, { node_id: 'pod-a' });

  // Operator spawn registers the manager run BEFORE pm_thread_id is persisted
  // (thread id arrives on thread.started) — simulate that window: live operator
  // run, no brief thread (Codex P1a review, SERIOUS #2).
  h.runService.createRun({
    prompt: 'operator boot',
    is_manager: 1,
    manager_layer: 'operator',
    conversation_id: `operator:${project.id}`,
  });

  assert.throws(
    () => h.projectService.updateProject(project.id, { node_id: 'pod-b' }),
    (err) => err.httpStatus === 409 && /reset the operator/.test(err.message),
  );
});
