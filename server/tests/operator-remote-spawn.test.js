const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createProjectBriefService } = require('../services/projectBriefService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');
const { createNodeService } = require('../services/nodeService');
const { createOperatorSpawnService } = require('../services/operatorSpawnService');
const { resolveManagerApiEndpoints } = require('../services/managerSystemPrompt');
const { createManagerRouter } = require('../routes/manager');
const { createApp } = require('../app');

const TEST_MANAGER_API_ENDPOINTS = {
  local: 'http://localhost:4177',
  remote: 'http://console.test:4177',
};

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-operator-remote-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function withCodexAuth(t) {
  const old = process.env.CODEX_API_KEY;
  process.env.CODEX_API_KEY = 'test-key';
  t.after(() => {
    if (old === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = old;
  });
}

function withoutBaseUrl(t) {
  const old = process.env.PALANTIR_BASE_URL;
  delete process.env.PALANTIR_BASE_URL;
  t.after(() => {
    if (old === undefined) delete process.env.PALANTIR_BASE_URL;
    else process.env.PALANTIR_BASE_URL = old;
  });
}

function makeAdapter(type = 'codex') {
  const starts = [];
  const turns = [];
  const disposes = [];
  return {
    type,
    capabilities: { persistentProcess: type === 'claude-code', supportsResume: true },
    startSession(runId, opts) {
      starts.push({ runId, opts });
      if (opts.resumeThreadId && typeof opts.onThreadStarted === 'function') {
        opts.onThreadStarted(opts.resumeThreadId);
      }
      if (opts.resumeSessionId && typeof opts.onSessionStarted === 'function') {
        opts.onSessionStarted(opts.resumeSessionId);
      }
      return { sessionRef: { resumedThreadId: opts.resumeThreadId || null } };
    },
    runTurn(runId, payload) {
      turns.push({ runId, payload });
      return { accepted: true };
    },
    isSessionAlive() { return true; },
    detectExitCode() { return null; },
    emitSessionEndedIfNeeded() {},
    getUsage() { return null; },
    getSessionId() { return null; },
    getOutput() { return null; },
    disposeSession(runId) { disposes.push(runId); },
    buildGuardrailsSection() { return ''; },
    _starts: starts,
    _turns: turns,
    _disposes: disposes,
  };
}

function wireFactory(adapter) {
  return { getAdapter: () => adapter };
}

function createSshNode(nodeService, id = 'nodeA') {
  return nodeService.createNode({
    id,
    name: id,
    kind: 'ssh',
    ssh_host: `${id}.example`,
    ssh_user: 'runner',
    exposed_roots: ['/workspace'],
    can_execute: true,
    reachable: true,
    node_prefix: `/opt/${id}/bin`,
  });
}

function wrapNodeService(realNodeService, { executor = { remote: true }, throwPick = false } = {}) {
  const calls = { resolveNode: [], getNode: [], pickExecutor: [] };
  return {
    resolveNode(project) {
      calls.resolveNode.push(project && project.id);
      return project && project.node_id ? project.node_id : 'local';
    },
    getNode(id) {
      calls.getNode.push(id);
      return realNodeService.getNode(id);
    },
    pickExecutor(id) {
      calls.pickExecutor.push(id);
      if (throwPick) {
        const err = new Error(`Node ${id} cannot host execution`);
        err.httpStatus = 400;
        throw err;
      }
      return executor;
    },
    _calls: calls,
  };
}

function wrapBriefService(projectBriefService) {
  const clearCalls = [];
  return {
    getBrief: projectBriefService.getBrief,
    ensureBrief: projectBriefService.ensureBrief,
    updateBrief: projectBriefService.updateBrief,
    setPmThread: projectBriefService.setPmThread,
    deleteBrief: projectBriefService.deleteBrief,
    clearPmThread(projectId) {
      clearCalls.push(projectId);
      return projectBriefService.clearPmThread(projectId);
    },
    _clearCalls: clearCalls,
  };
}

function operatorThreadRow(runService, projectId) {
  return runService.getOperatorThreadForProject(projectId, { ensure: true });
}

function seedOperatorThread(runService, projectId, fields) {
  const resolved = runService.ensurePrimaryOperatorInstanceForProject(projectId);
  runService.setOperatorInstanceThread(resolved.instanceId, fields);
  return resolved.instanceId;
}

function seedTop({ runService, registry, adapter }) {
  const run = runService.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  runService.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive('top', run.id, adapter);
  return run;
}

function makeSpawn({
  runService,
  registry,
  adapter,
  managerAdapterFactory,
  projectService,
  projectBriefService,
  nodeService,
  nodeUsageService,
  agentProfileService,
  resolveManagerAuth,
  managerApiEndpoints = TEST_MANAGER_API_ENDPOINTS,
}) {
  return createOperatorSpawnService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: managerAdapterFactory || wireFactory(adapter),
    projectService,
    projectBriefService,
    nodeService,
    nodeUsageService,
    agentProfileService,
    managerApiEndpoints,
    authResolverOpts: {},
    ...(resolveManagerAuth ? { resolveManagerAuth } : {}),
  });
}

test('local Operator spawn passes no executor or nodePrefix', async (t) => {
  withCodexAuth(t);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  const nodeService = wrapNodeService(realNodeService);
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({ name: 'local', directory: '/tmp/local-project' });

  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService });
  const result = spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.spawned, true);
  assert.equal(adapter._starts.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(adapter._starts[0].opts, 'executor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(adapter._starts[0].opts, 'nodePrefix'), false);
  assert.equal(nodeService._calls.pickExecutor.length, 0);
});

test('createApp derives and wires a remote Manager API endpoint for the implicit authenticated wildcard bind', async (t) => {
  const previousBaseUrl = process.env.PALANTIR_BASE_URL;
  const previousHost = process.env.HOST;
  delete process.env.PALANTIR_BASE_URL;
  delete process.env.HOST;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-operator-app-base-'));
  const app = createApp({
    dbPath: path.join(dir, 'test.db'),
    storageRoot: path.join(dir, 'storage'),
    fsRoot: dir,
    authToken: 'test-console-token',
    agentProcessIsolation: true,
    memoryDistillEnabled: false,
    masterMemoryXprojectScanEnabled: false,
    nodeUsageService: {
      async getUsageSnapshot() {
        return {
          clis: [
            { id: 'codex', installed: true, authStatus: null, error: null },
            { id: 'claude', installed: true, authStatus: { loggedIn: true }, error: null },
          ],
        };
      },
    },
    networkInterfaces: () => ({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
      utun4: [{ family: 'IPv4', internal: false, address: '100.120.25.112' }],
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    }),
  });
  t.after(async () => {
    await app.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
    if (previousBaseUrl === undefined) delete process.env.PALANTIR_BASE_URL;
    else process.env.PALANTIR_BASE_URL = previousBaseUrl;
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
  });

  app.services.nodeService.createNode({
    id: 'nodeA',
    name: 'nodeA',
    kind: 'ssh',
    ssh_host: 'nodeA.example',
    ssh_user: 'runner',
    exposed_roots: ['/workspace'],
    can_execute: true,
    reachable: true,
  });
  const project = app.services.projectService.createProject({
    name: 'app-wired-remote',
    directory: '/workspace/app-wired-remote',
    node_id: 'nodeA',
  });
  const topAdapter = makeAdapter();
  seedTop({
    runService: app.services.runService,
    registry: app.managerRegistry,
    adapter: topAdapter,
  });

  const result = await app.services.operatorSpawnService.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.spawned, true);
  assert.equal(result.run.node_id, 'nodeA');
});

test('wildcard Manager endpoint prefers the tailnet address in the actual remote Operator prompt', async (t) => {
  const managerApiEndpoints = resolveManagerApiEndpoints({
    explicitBaseUrl: null,
    host: '0.0.0.0',
    port: 4177,
    networkInterfaces: () => ({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
      utun4: [{ family: 'IPv4', internal: false, address: '100.120.25.112' }],
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    }),
  });
  assert.equal(managerApiEndpoints.remote, 'http://100.120.25.112:4177');

  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const nodeService = wrapNodeService(realNodeService, { executor: { remote: 'executor' } });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({
    name: 'tailnet-prompt',
    directory: '/workspace/tailnet-prompt',
    node_id: 'nodeA',
  });
  const spawn = makeSpawn({
    runService,
    registry,
    adapter,
    projectService,
    projectBriefService,
    nodeService,
    managerApiEndpoints,
  });

  const result = spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.spawned, true);
  assert.match(adapter._starts[0].opts.systemPrompt, /http:\/\/100\.120\.25\.112:4177\/api\/tasks/);
  assert.doesNotMatch(adapter._starts[0].opts.systemPrompt, /http:\/\/192\.168\.1\.20:4177/);
});

test('remote Operator spawn uses node executor, pod cwd, placement persistence, and manager node_id', async (t) => {
  withCodexAuth(t);
  withoutBaseUrl(t);
  const oldProxy = process.env.HTTP_PROXY;
  const originalWarn = console.warn;
  const warnings = [];
  process.env.HTTP_PROXY = 'http://controller-user:controller-password@controller-proxy:3128';
  console.warn = (line) => warnings.push(String(line));
  t.after(() => {
    if (oldProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = oldProxy;
    console.warn = originalWarn;
  });
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const remoteExecutor = { remote: 'executor' };
  const nodeService = wrapNodeService(realNodeService, { executor: remoteExecutor });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({
    name: 'remote',
    directory: '/workspace/remote-project',
    node_id: 'nodeA',
  });

  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService });
  const result = spawn.ensureLiveOperator({ projectId: project.id });
  const start = adapter._starts[0];

  assert.equal(start.opts.executor, remoteExecutor);
  assert.equal(start.opts.nodePrefix, '/opt/nodeA/bin');
  assert.equal(start.opts.cwd, '/workspace/remote-project');
  // A remote Operator must get a MINIMAL env — NOT the control-plane's
  // process.env-based spawnEnv (which would ship the Mac's PATH to the pod,
  // breaking codex resolution, and leak CODEX_API_KEY). Real-Pi finding.
  assert.deepEqual(start.opts.env, {}, 'remote Operator env must be minimal ({})');
  assert.equal(start.opts.env.CODEX_API_KEY, undefined, 'no control-plane creds to the pod');
  assert.equal(
    warnings.some((line) => line.includes('manager_spawn_proxy_userinfo')),
    false,
    'discarded control-plane proxy env must not emit a forwarding diagnostic',
  );
  assert.equal(runService.getRun(result.run.id).node_id, 'nodeA');
  assert.deepEqual(nodeService._calls.pickExecutor, ['nodeA']);

  start.opts.onThreadStarted('thread-remote');
  const thread = operatorThreadRow(runService, project.id);
  assert.equal(thread.thread_id, 'thread-remote');
  assert.equal(thread.node_id, 'nodeA');
  assert.equal(thread.cwd, '/workspace/remote-project');

  assert.match(start.opts.systemPrompt, /http:\/\/console\.test:4177\/api\/tasks/);
  assert.doesNotMatch(start.opts.systemPrompt, /http:\/\/localhost:4177/);
});

test('remote pickExecutor failure marks the Operator run failed and never starts locally', async (t) => {
  withCodexAuth(t);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const nodeService = wrapNodeService(realNodeService, { throwPick: true });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({ name: 'remote', directory: '/workspace/remote-project', node_id: 'nodeA' });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService });

  assert.throws(
    () => spawn.ensureLiveOperator({ projectId: project.id }),
    (err) => err.httpStatus === 502 && /node executor unavailable/.test(err.message),
  );
  assert.equal(adapter._starts.length, 0);
  const run = db.prepare('SELECT * FROM runs WHERE conversation_id = ?').get(`operator:oi_${project.id}`); // W-P5: canonical slot is instance-form
  assert.equal(run.status, 'failed');
  assert.equal(run.node_id, 'nodeA');
});

test('resume affinity mismatch clears stale thread and starts fresh on the current node', async (t) => {
  withCodexAuth(t);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const baseBriefService = createProjectBriefService(db);
  const projectBriefService = wrapBriefService(baseBriefService);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  createSshNode(realNodeService, 'nodeB');
  const nodeService = wrapNodeService(realNodeService, { executor: { remote: 'nodeB' } });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({ name: 'rebound', directory: '/workspace/rebound', node_id: 'nodeB' });
  seedOperatorThread(runService, project.id, {
    pm_thread_id: 'thread-on-node-a',
    pm_adapter: 'codex',
    pm_thread_node_id: 'nodeA',
    pm_thread_cwd: '/workspace/old',
  });

  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService });
  const result = spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.resumed, false);
  assert.equal(adapter._starts[0].opts.resumeThreadId, null);
  assert.equal(operatorThreadRow(runService, project.id).thread_id, null);
  const event = runService.getRunEvents(result.run.id).find(e => e.event_type === 'operator:thread_rebind_reset');
  assert.deepEqual(JSON.parse(event.payload_json), { from_node: 'nodeA', to_node: 'nodeB' });
});

test('resume affinity match resumes the persisted thread on the remote node', async (t) => {
  withCodexAuth(t);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const nodeService = wrapNodeService(realNodeService, { executor: { remote: 'nodeA' } });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({ name: 'resume', directory: '/workspace/resume', node_id: 'nodeA' });
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread-on-node-a',
    pm_adapter: 'codex',
    pm_thread_node_id: 'nodeA',
    pm_thread_cwd: '/workspace/resume',
  });

  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService });
  const result = spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.resumed, true);
  assert.equal(adapter._starts[0].opts.resumeThreadId, 'thread-on-node-a');
  assert.equal(adapter._starts[0].opts.cwd, '/workspace/resume');
});

test('createRun preserves manager node_id when provided', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');

  const run = runService.createRun({
    is_manager: true,
    prompt: 'manager on node',
    node_id: 'nodeA',
  });

  assert.equal(run.node_id, 'nodeA');
});

test('boot resume uses remote node executor, nodePrefix, pod cwd, and thread affinity', async (t) => {
  withCodexAuth(t);
  withoutBaseUrl(t);
  const oldProxy = process.env.HTTP_PROXY;
  const originalWarn = console.warn;
  const warnings = [];
  process.env.HTTP_PROXY = 'http://controller-user:controller-password@controller-proxy:3128';
  console.warn = (line) => warnings.push(String(line));
  t.after(() => {
    if (oldProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = oldProxy;
    console.warn = originalWarn;
  });
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const remoteExecutor = { remote: 'boot' };
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const nodeService = wrapNodeService(realNodeService, { executor: remoteExecutor });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  const factory = wireFactory(adapter);
  const top = runService.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  runService.updateRunStatus(top.id, 'completed', { force: true });
  registry.setActive('top', top.id, makeAdapter());
  const conversationService = createConversationService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: factory,
    lifecycleService: null,
  });
  const project = projectService.createProject({ name: 'boot', directory: '/workspace/boot', node_id: 'nodeA' });
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread-boot',
    pm_adapter: 'codex',
    pm_thread_node_id: 'nodeA',
    pm_thread_cwd: '/workspace/boot',
  });
  const run = runService.createRun({
    is_manager: true,
    manager_adapter: 'codex',
    manager_layer: 'operator',
    conversation_id: `operator:${project.id}`,
    prompt: 'boot resume',
    node_id: 'nodeA',
  });
  runService.updateRunStatus(run.id, 'running', { force: true });

  createManagerRouter({
    runService,
    managerAdapterFactory: factory,
    managerRegistry: registry,
    conversationService,
    projectService,
    projectBriefService,
    nodeService,
    managerApiEndpoints: TEST_MANAGER_API_ENDPOINTS,
    authResolverOpts: {},
  });

  assert.equal(adapter._starts.length, 1);
  assert.equal(adapter._starts[0].runId, run.id);
  assert.equal(adapter._starts[0].opts.resumeThreadId, 'thread-boot');
  assert.equal(adapter._starts[0].opts.executor, remoteExecutor);
  assert.equal(adapter._starts[0].opts.nodePrefix, '/opt/nodeA/bin');
  assert.equal(adapter._starts[0].opts.cwd, '/workspace/boot');
  assert.equal(
    warnings.some((line) => line.includes('manager_spawn_proxy_userinfo')),
    false,
    'remote boot resume must not diagnose a discarded control-plane proxy',
  );
  assert.match(adapter._starts[0].opts.systemPrompt, /http:\/\/console\.test:4177\/api\/tasks/);
  assert.doesNotMatch(adapter._starts[0].opts.systemPrompt, /http:\/\/localhost:4177/);
});

test('boot resume uses remote node executor, nodePrefix, pod cwd, and Claude session affinity', async (t) => {
  withoutBaseUrl(t);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const remoteExecutor = { remote: 'claude-boot' };
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const nodeService = wrapNodeService(realNodeService, { executor: remoteExecutor });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter('claude-code');
  const factory = wireFactory(adapter);
  const top = runService.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  runService.updateRunStatus(top.id, 'completed', { force: true });
  registry.setActive('top', top.id, makeAdapter('claude-code'));
  const conversationService = createConversationService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: factory,
    lifecycleService: null,
  });
  const project = projectService.createProject({
    name: 'claude-boot',
    preferred_pm_adapter: 'claude',
    directory: '/workspace/claude-boot',
    node_id: 'nodeA',
  });
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'sess-boot',
    pm_adapter: 'claude',
    pm_thread_node_id: 'nodeA',
    pm_thread_cwd: '/workspace/claude-boot',
  });
  const run = runService.createRun({
    is_manager: true,
    manager_adapter: 'claude-code',
    manager_layer: 'operator',
    conversation_id: `operator:${project.id}`,
    prompt: 'boot resume claude',
    node_id: 'nodeA',
  });
  runService.setSessionSnapshot(run.id, {
    sessionClaudeOptions: { bare: true },
  });
  runService.updateRunStatus(run.id, 'running', { force: true });

  let controllerTokenReads = 0;
  createManagerRouter({
    runService,
    managerAdapterFactory: factory,
    managerRegistry: registry,
    conversationService,
    projectService,
    projectBriefService,
    nodeService,
    managerApiEndpoints: TEST_MANAGER_API_ENDPOINTS,
    authResolverOpts: {
      hasKeychain: () => true,
      readKeychainTokenSync: () => {
        controllerTokenReads += 1;
        return 'controller-token-must-not-be-materialized';
      },
      hasCredentialsFile: () => false,
    },
  });

  assert.equal(adapter._starts.length, 1);
  assert.equal(adapter._starts[0].runId, run.id);
  assert.equal(adapter._starts[0].opts.resumeSessionId, 'sess-boot');
  assert.equal(adapter._starts[0].opts.resumeThreadId, undefined);
  assert.equal(adapter._starts[0].opts.executor, remoteExecutor);
  assert.equal(adapter._starts[0].opts.nodePrefix, '/opt/nodeA/bin');
  assert.equal(adapter._starts[0].opts.cwd, '/workspace/claude-boot');
  assert.deepEqual(adapter._starts[0].opts.env, {});
  assert.match(adapter._starts[0].opts.systemPrompt, /http:\/\/console\.test:4177\/api\/tasks/);
  assert.doesNotMatch(adapter._starts[0].opts.systemPrompt, /http:\/\/localhost:4177/);
  assert.equal(adapter._starts[0].opts.bare, true);
  assert.equal(controllerTokenReads, 0);
  // The `operator:remote_base_url_localhost` warning this test used to assert is
  // gone on purpose: a remote Operator now RESOLVES a reachable endpoint (and
  // fails closed with OPERATOR_REMOTE_BASE_URL_UNAVAILABLE when none exists)
  // instead of being handed localhost with an annotation. The two assertions
  // above cover the replacement contract.
});

test('boot resume clears a Claude session bound to a different node and leaves it for lazy fresh spawn', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const baseBriefService = createProjectBriefService(db);
  const projectBriefService = wrapBriefService(baseBriefService);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  createSshNode(realNodeService, 'nodeB');
  const nodeService = wrapNodeService(realNodeService, { executor: { remote: 'nodeB' } });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter('claude-code');
  const factory = wireFactory(adapter);
  const top = runService.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  runService.updateRunStatus(top.id, 'completed', { force: true });
  registry.setActive('top', top.id, makeAdapter('claude-code'));
  const conversationService = createConversationService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: factory,
    lifecycleService: null,
  });
  const project = projectService.createProject({
    name: 'claude-boot-rebind',
    preferred_pm_adapter: 'claude',
    directory: '/workspace/claude-boot-rebind',
    node_id: 'nodeB',
  });
  seedOperatorThread(runService, project.id, {
    pm_thread_id: 'sess-on-node-a',
    pm_adapter: 'claude',
    pm_thread_node_id: 'nodeA',
    pm_thread_cwd: '/workspace/old',
  });
  const run = runService.createRun({
    is_manager: true,
    manager_adapter: 'claude-code',
    manager_layer: 'operator',
    conversation_id: `operator:${project.id}`,
    prompt: 'boot resume claude mismatch',
    node_id: 'nodeB',
  });
  runService.updateRunStatus(run.id, 'running', { force: true });

  createManagerRouter({
    runService,
    managerAdapterFactory: factory,
    managerRegistry: registry,
    conversationService,
    projectService,
    projectBriefService,
    nodeService,
    authResolverOpts: {},
  });

  assert.equal(adapter._starts.length, 0);
  assert.equal(operatorThreadRow(runService, project.id).thread_id, null);
  assert.equal(runService.getRun(run.id).status, 'stopped');
  assert.deepEqual(adapter._disposes, [run.id]);
  const event = runService.getRunEvents(run.id).find(e => e.event_type === 'operator:thread_rebind_reset');
  assert.deepEqual(JSON.parse(event.payload_json), { from_node: 'nodeA', to_node: 'nodeB' });
});

test('remote Operator spawns even when control-plane Codex auth is unavailable (pod authenticates)', async (t) => {
  // A remote Operator authenticates on the POD (~/.codex), not the control
  // plane, and gets env:{} — so control-plane canAuth=false must NOT block it.
  // Codex S3b review. (resolveManagerAuth is DI-injected here because on a dev
  // machine with ~/.codex/auth.json canAuth is unconditionally true.)
  withoutBaseUrl(t);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const remoteExecutor = { remote: 'executor' };
  const nodeService = wrapNodeService(realNodeService, { executor: remoteExecutor });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({ name: 'remote-noauth', directory: '/workspace/p', node_id: 'nodeA' });
  const noAuth = () => ({ canAuth: false, env: {}, sources: [], diagnostics: [] });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, resolveManagerAuth: noAuth });
  const result = spawn.ensureLiveOperator({ projectId: project.id });
  assert.ok(result && result.spawned, 'remote Operator spawned without control-plane auth');
  assert.equal(adapter._starts[0].opts.executor, remoteExecutor);
  assert.deepEqual(adapter._starts[0].opts.env, {});
});

test('remote NULL preference selects the authenticated Claude CLI on the execution node', async (t) => {
  const previousDefault = process.env.PALANTIR_DEFAULT_PM_ADAPTER;
  delete process.env.PALANTIR_DEFAULT_PM_ADAPTER;
  t.after(() => {
    if (previousDefault === undefined) delete process.env.PALANTIR_DEFAULT_PM_ADAPTER;
    else process.env.PALANTIR_DEFAULT_PM_ADAPTER = previousDefault;
  });

  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const remoteExecutor = { remote: 'executor' };
  const nodeService = wrapNodeService(realNodeService, { executor: remoteExecutor });
  const registry = createManagerRegistry({ runService });
  const codexAdapter = makeAdapter('codex');
  const claudeAdapter = makeAdapter('claude-code');
  const requestedAdapters = [];
  const managerAdapterFactory = {
    getAdapter(type) {
      requestedAdapters.push(type);
      return type === 'claude-code' ? claudeAdapter : codexAdapter;
    },
  };
  const usageCalls = [];
  const nodeUsageService = {
    async getUsageSnapshot(nodeId) {
      usageCalls.push(nodeId);
      return {
        clis: [
          {
            id: 'codex',
            installed: false,
            authStatus: null,
            error: { code: 'not_installed', message: 'codex is not installed' },
          },
          {
            id: 'claude',
            installed: true,
            authStatus: { loggedIn: true },
            // Quota lookup failure must not hide the already-proven CLI auth.
            error: { code: 'network_error', message: 'quota endpoint unavailable' },
          },
        ],
      };
    },
  };
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({
    name: 'remote-claude-only',
    directory: '/workspace/remote-claude-only',
    node_id: 'nodeA',
  });
  assert.equal(project.preferred_pm_adapter, null);
  const spawn = makeSpawn({
    runService,
    registry,
    adapter: codexAdapter,
    managerAdapterFactory,
    projectService,
    projectBriefService,
    nodeService,
    nodeUsageService,
  });
  const conversationService = createConversationService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory,
    lifecycleService: null,
    operatorSpawnService: spawn,
    projectService,
    projectBriefService,
  });

  const delivery = await conversationService.sendMessage(
    `operator:${project.id}`,
    { text: 'start with the node-authenticated CLI' },
  );

  assert.equal(delivery.status, 'sent');
  assert.deepEqual(usageCalls, ['nodeA']);
  assert.deepEqual(requestedAdapters, ['claude-code']);
  assert.equal(codexAdapter._starts.length, 0);
  assert.equal(claudeAdapter._starts.length, 1);
  const run = runService.getRun(claudeAdapter._starts[0].runId);
  assert.equal(run.manager_adapter, 'claude-code');
  assert.equal(claudeAdapter._starts[0].opts.executor, remoteExecutor);
  assert.equal(claudeAdapter._turns.length, 1);
  assert.equal(claudeAdapter._turns[0].payload.text, 'start with the node-authenticated CLI');
});

test('remote NULL preference keeps Codex first when both node CLIs are authenticated', async (t) => {
  const previousDefault = process.env.PALANTIR_DEFAULT_PM_ADAPTER;
  delete process.env.PALANTIR_DEFAULT_PM_ADAPTER;
  t.after(() => {
    if (previousDefault === undefined) delete process.env.PALANTIR_DEFAULT_PM_ADAPTER;
    else process.env.PALANTIR_DEFAULT_PM_ADAPTER = previousDefault;
  });

  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const nodeService = wrapNodeService(realNodeService, { executor: { remote: 'executor' } });
  const registry = createManagerRegistry({ runService });
  const codexAdapter = makeAdapter('codex');
  const claudeAdapter = makeAdapter('claude-code');
  const requestedAdapters = [];
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({
    name: 'remote-both-authenticated',
    directory: '/workspace/remote-both-authenticated',
    node_id: 'nodeA',
  });
  const spawn = makeSpawn({
    runService,
    registry,
    adapter: codexAdapter,
    managerAdapterFactory: {
      getAdapter(type) {
        requestedAdapters.push(type);
        return type === 'claude-code' ? claudeAdapter : codexAdapter;
      },
    },
    projectService,
    projectBriefService,
    nodeService,
    nodeUsageService: {
      async getUsageSnapshot() {
        return {
          clis: [
            { id: 'codex', installed: true, authStatus: null, error: null },
            { id: 'claude', installed: true, authStatus: { loggedIn: true }, error: null },
          ],
        };
      },
    },
  });

  const result = await spawn.ensureLiveOperator({ projectId: project.id });

  assert.deepEqual(requestedAdapters, ['codex']);
  assert.equal(result.run.manager_adapter, 'codex');
  assert.equal(codexAdapter._starts.length, 1);
  assert.equal(claudeAdapter._starts.length, 0);
});

test('local Operator still fails closed when control-plane Codex auth is unavailable', async (t) => {
  // Byte-equivalent local behavior: a LOCAL Operator with no auth must still 400.
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  const nodeService = wrapNodeService(realNodeService);
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({ name: 'local-noauth', directory: '/workspace/p' });
  const noAuth = () => ({ canAuth: false, env: {}, sources: [], diagnostics: [] });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, resolveManagerAuth: noAuth });
  assert.throws(() => spawn.ensureLiveOperator({ projectId: project.id }), /PM auth unavailable/);
});

test('P5-S4c: LOCAL Claude operator boot-resume uses adapter auth (not hardcoded codex) + resumeSessionId', async (t) => {
  // The operator boot-resume loop now admits claude-code (P5-S4c); auth must be
  // resolved for the run's ACTUAL adapter, not a hardcoded 'codex' (Codex
  // BLOCKER). Covers the LOCAL claude boot path the remote-only tests missed
  // (remote skips auth via isRemoteNode||canAuth, which masked the bug).
  const prevTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-claude-tok';
  t.after(() => {
    if (prevTok === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevTok;
  });
  withoutBaseUrl(t);
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = createNodeService(db, { localExecutor: { local: true } }); // local (no ssh node)
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter('claude-code');
  const factory = wireFactory(adapter);
  const top = runService.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  runService.updateRunStatus(top.id, 'completed', { force: true });
  registry.setActive('top', top.id, makeAdapter('claude-code'));
  const conversationService = createConversationService({
    runService, managerRegistry: registry, managerAdapterFactory: factory, lifecycleService: null,
  });
  const project = projectService.createProject({
    name: 'claude-boot-local', preferred_pm_adapter: 'claude', directory: '/tmp/claude-boot-local',
  });
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'sess-local', pm_adapter: 'claude', pm_thread_node_id: null,
  });
  const run = runService.createRun({
    is_manager: true, manager_adapter: 'claude-code', manager_layer: 'operator',
    conversation_id: `operator:${project.id}`, prompt: 'boot',
  });
  runService.updateRunStatus(run.id, 'running', { force: true });

  createManagerRouter({
    runService, managerAdapterFactory: factory, managerRegistry: registry,
    conversationService, projectService, projectBriefService, nodeService, authResolverOpts: {},
  });

  assert.equal(adapter._starts.length, 1, 'local claude operator boot-resumed');
  assert.equal(adapter._starts[0].opts.resumeSessionId, 'sess-local');
  assert.equal(adapter._starts[0].opts.resumeThreadId, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(adapter._starts[0].opts, 'executor'), false);
});
