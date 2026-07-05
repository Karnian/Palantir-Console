const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createApp } = require('../app');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await createTempDir('palantir-node-summary-storage-');
  const fsRoot = await createTempDir('palantir-node-summary-fs-');
  const dbDir = await createTempDir('palantir-node-summary-db-');
  const pluginsRoot = await createTempDir('palantir-node-summary-plugins-');
  const app = createApp({
    storageRoot,
    fsRoot,
    pluginsRoot,
    opencodeBin: 'opencode',
    dbPath: path.join(dbDir, 'test.db'),
    authResolverOpts: { hasKeychain: () => false },
    authToken: null,
  });
  const http = require('node:http');
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.listen(0, '127.0.0.1');
    });
  } catch (err) {
    if (app.shutdown) await app.shutdown();
    else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(pluginsRoot, { recursive: true, force: true });
    throw err;
  }

  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    if (app.shutdown) await app.shutdown();
    else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(pluginsRoot, { recursive: true, force: true });
  });

  return { app, server };
}

function createProfile(agentProfileService, { name, max }) {
  return agentProfileService.createProfile({
    name,
    type: 'codex',
    command: 'codex',
    args_template: '{prompt}',
    capabilities_json: '{}',
    env_allowlist: '[]',
    max_concurrent: max,
  });
}

function createTask({ projectService, taskService }, title) {
  const project = projectService.createProject({ name: `Project ${title}` });
  const task = taskService.createTask({
    project_id: project.id,
    title,
    description: 'node summary fixture',
  });
  return { project, task };
}

function createQueuedRun({ runService, task, profile, nodeId, prompt }) {
  return runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: prompt || 'queued',
    node_id: nodeId,
  });
}

function createRunningRun(args) {
  const run = createQueuedRun(args);
  return args.runService.markRunStarted(run.id, {
    tmux_session: `session-${run.id}`,
  });
}

function byNode(body, nodeId) {
  return body.nodes.find((node) => node.node_id === nodeId);
}

function byRun(body, runId) {
  return body.queued.find((run) => run.run_id === runId);
}

test('GET /api/nodes/summary returns local-only summary without queued runs', async (t) => {
  const { server } = await createTestApp(t);

  const res = await request(server).get('/api/nodes/summary');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.updatedAt, 'string');
  assert.deepEqual(res.body.queued, []);

  const local = byNode(res.body, 'local');
  assert.ok(local, 'local node is present');
  assert.equal(local.name, 'Local');
  assert.equal(local.reachable, 1);
  assert.equal(local.can_execute, 1);
  assert.equal(local.files_only, 0);
  assert.equal(local.cordoned, 0);
  assert.equal(local.max_concurrent, null);
  assert.equal(local.running_total, 0);
  assert.equal(local.queued_total, 0);
  assert.deepEqual(local.running_by_profile, {});
  assert.deepEqual(local.queued_by_profile, {});
});

test('GET /api/nodes/summary aggregates nodes and recomputes queued reasons', async (t) => {
  const { app, server } = await createTestApp(t);
  const {
    nodeService,
    agentProfileService,
    projectService,
    taskService,
    runService,
  } = app.services;

  nodeService.createNode({ id: 'down-node', name: 'Down Node', reachable: false });
  nodeService.createNode({ id: 'profile-node', name: 'Profile Node', reachable: true });
  nodeService.createNode({ id: 'node-cap', name: 'Node Cap', reachable: true, max_concurrent: 1 });

  const limited = createProfile(agentProfileService, { name: 'Limited', max: 1 });
  const wide = createProfile(agentProfileService, { name: 'Wide', max: 10 });

  const profileRunningTask = createTask({ projectService, taskService }, 'profile running').task;
  const profileQueuedTask = createTask({ projectService, taskService }, 'profile queued').task;
  const nodeRunningTask = createTask({ projectService, taskService }, 'node running').task;
  const nodeQueuedTask = createTask({ projectService, taskService }, 'node queued').task;
  const downQueuedTask = createTask({ projectService, taskService }, 'down queued').task;

  createRunningRun({
    runService,
    task: profileRunningTask,
    profile: limited,
    nodeId: 'profile-node',
    prompt: 'profile running',
  });
  const profileQueued = createQueuedRun({
    runService,
    task: profileQueuedTask,
    profile: limited,
    nodeId: 'profile-node',
    prompt: 'profile queued',
  });

  createRunningRun({
    runService,
    task: nodeRunningTask,
    profile: wide,
    nodeId: 'node-cap',
    prompt: 'node running',
  });
  const nodeQueued = createQueuedRun({
    runService,
    task: nodeQueuedTask,
    profile: wide,
    nodeId: 'node-cap',
    prompt: 'node queued',
  });

  const downQueued = createQueuedRun({
    runService,
    task: downQueuedTask,
    profile: wide,
    nodeId: 'down-node',
    prompt: 'down queued',
  });

  runService.createRun({
    prompt: 'manager should not count',
    is_manager: 1,
    manager_layer: 'top',
    conversation_id: 'top',
    node_id: 'profile-node',
  });

  const res = await request(server).get('/api/nodes/summary');
  assert.equal(res.status, 200);
  assert.equal(byRun(res.body, downQueued.id).queue_reason, 'node_unreachable');
  assert.equal(byRun(res.body, profileQueued.id).queue_reason, 'profile_capacity');
  assert.equal(byRun(res.body, nodeQueued.id).queue_reason, 'node_capacity');

  const profileNode = byNode(res.body, 'profile-node');
  assert.equal(profileNode.running_total, 1);
  assert.equal(profileNode.queued_total, 1);
  assert.deepEqual(profileNode.running_by_profile, { [limited.id]: 1 });
  assert.deepEqual(profileNode.queued_by_profile, { [limited.id]: 1 });

  const nodeCap = byNode(res.body, 'node-cap');
  assert.equal(nodeCap.max_concurrent, 1);
  assert.equal(nodeCap.running_total, 1);
  assert.equal(nodeCap.queued_total, 1);
  assert.deepEqual(nodeCap.running_by_profile, { [wide.id]: 1 });
  assert.deepEqual(nodeCap.queued_by_profile, { [wide.id]: 1 });

  const downNode = byNode(res.body, 'down-node');
  assert.equal(downNode.reachable, 0);
  assert.equal(downNode.queued_total, 1);
});

test('GET /api/nodes/summary reports profile_missing for a queued run whose profile was deleted', async (t) => {
  const { app, server } = await createTestApp(t);
  const { nodeService, agentProfileService, projectService, taskService, runService } = app.services;

  nodeService.createNode({ id: 'orphan-node', name: 'Orphan Node', reachable: true });
  const doomed = createProfile(agentProfileService, { name: 'doomed', max: 2 });
  const task = createTask({ projectService, taskService }, 'orphan profile queued').task;
  const queued = createQueuedRun({
    runService,
    task,
    profile: doomed,
    nodeId: 'orphan-node',
    prompt: 'orphan profile queued',
  });
  agentProfileService.deleteProfile(doomed.id);

  const res = await request(server).get('/api/nodes/summary');
  assert.equal(res.status, 200);
  assert.equal(byRun(res.body, queued.id).queue_reason, 'profile_missing');
});
