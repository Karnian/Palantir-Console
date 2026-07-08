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
const { createManagerRouter } = require('../routes/manager');

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
    runTurn() { return { accepted: true }; },
    isSessionAlive() { return true; },
    detectExitCode() { return null; },
    emitSessionEndedIfNeeded() {},
    getUsage() { return null; },
    getSessionId() { return null; },
    getOutput() { return null; },
    disposeSession(runId) { disposes.push(runId); },
    buildGuardrailsSection() { return ''; },
    _starts: starts,
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

function makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, resolveManagerAuth }) {
  return createOperatorSpawnService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(adapter),
    projectService,
    projectBriefService,
    nodeService,
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

test('remote Operator spawn uses node executor, pod cwd, placement persistence, and manager node_id', async (t) => {
  withCodexAuth(t);
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
  assert.equal(runService.getRun(result.run.id).node_id, 'nodeA');
  assert.deepEqual(nodeService._calls.pickExecutor, ['nodeA']);

  start.opts.onThreadStarted('thread-remote');
  const thread = operatorThreadRow(runService, project.id);
  assert.equal(thread.thread_id, 'thread-remote');
  assert.equal(thread.node_id, 'nodeA');
  assert.equal(thread.cwd, '/workspace/remote-project');

  const warning = runService.getRunEvents(result.run.id).find(e => e.event_type === 'operator:remote_base_url_localhost');
  assert.ok(warning, 'remote localhost base URL warning should be observable');
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
  const run = db.prepare('SELECT * FROM runs WHERE conversation_id = ?').get(`operator:${project.id}`);
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
    authResolverOpts: {},
  });

  assert.equal(adapter._starts.length, 1);
  assert.equal(adapter._starts[0].runId, run.id);
  assert.equal(adapter._starts[0].opts.resumeThreadId, 'thread-boot');
  assert.equal(adapter._starts[0].opts.executor, remoteExecutor);
  assert.equal(adapter._starts[0].opts.nodePrefix, '/opt/nodeA/bin');
  assert.equal(adapter._starts[0].opts.cwd, '/workspace/boot');
  const warning = runService.getRunEvents(run.id).find(e => e.event_type === 'operator:remote_base_url_localhost');
  assert.ok(warning, 'boot resume should record remote localhost base URL warning');
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

  assert.equal(adapter._starts.length, 1);
  assert.equal(adapter._starts[0].runId, run.id);
  assert.equal(adapter._starts[0].opts.resumeSessionId, 'sess-boot');
  assert.equal(adapter._starts[0].opts.resumeThreadId, undefined);
  assert.equal(adapter._starts[0].opts.executor, remoteExecutor);
  assert.equal(adapter._starts[0].opts.nodePrefix, '/opt/nodeA/bin');
  assert.equal(adapter._starts[0].opts.cwd, '/workspace/claude-boot');
  assert.deepEqual(adapter._starts[0].opts.env, {});
  const warning = runService.getRunEvents(run.id).find(e => e.event_type === 'operator:remote_base_url_localhost');
  assert.ok(warning, 'Claude boot resume should record remote localhost base URL warning');
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
