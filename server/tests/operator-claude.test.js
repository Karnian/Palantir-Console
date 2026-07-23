// Fleet P5-S4a — local Claude Operator spawn lifecycle.

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
const { createNodeService } = require('../services/nodeService');
const { createOperatorSpawnService } = require('../services/operatorSpawnService');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-operator-claude-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function makeFakeManagerAdapter(type) {
  const starts = [];
  return {
    type,
    capabilities: {
      persistentProcess: type === 'claude-code',
      supportsResume: true,
    },
    startSession(runId, opts) {
      starts.push({ runId, opts });
      return { sessionRef: { runId } };
    },
    runTurn() { return { accepted: true }; },
    isSessionAlive() { return true; },
    detectExitCode() { return null; },
    emitSessionEndedIfNeeded() {},
    getUsage() { return null; },
    getSessionId() { return null; },
    getOutput() { return null; },
    disposeSession() {},
    buildGuardrailsSection() { return ''; },
    _starts: starts,
  };
}

function seedTop({ runService, registry, adapter }) {
  const run = runService.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  runService.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive('top', run.id, adapter);
  return run;
}

function authOk() {
  return { canAuth: true, env: {}, sources: [], diagnostics: [] };
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

function makeAdapterFactory({ claudeAdapter, codexAdapter }) {
  return {
    getAdapter(type) {
      if (type === 'claude-code') return claudeAdapter;
      if (type === 'codex') return codexAdapter;
      throw new Error(`unexpected adapter type ${type}`);
    },
  };
}

test('P5-S4a: resolveOperatorAdapterType maps Claude preferences to claude-code', () => {
  const previousDefault = process.env.PALANTIR_DEFAULT_PM_ADAPTER;
  delete process.env.PALANTIR_DEFAULT_PM_ADAPTER;
  const logs = [];
  const spawn = createOperatorSpawnService({ logger: (msg) => logs.push(msg) });

  try {
    assert.equal(
      spawn.resolveOperatorAdapterType(
        { id: 0, preferred_pm_adapter: 'codex' },
        { preferred_adapter: 'claude' },
      ),
      'claude-code',
    );
    assert.equal(
      spawn.resolveOperatorAdapterType(
        { id: 0, preferred_pm_adapter: 'claude' },
        { preferred_adapter: 'codex' },
      ),
      'codex',
    );
    assert.equal(spawn.resolveOperatorAdapterType({ id: 1, preferred_pm_adapter: 'claude' }), 'claude-code');
    assert.equal(spawn.resolveOperatorAdapterType({ id: 2, preferred_pm_adapter: 'claude-code' }), 'claude-code');
    assert.equal(spawn.resolveOperatorAdapterType({ id: 3, preferred_pm_adapter: 'codex' }), 'codex');
    assert.equal(spawn.resolveOperatorAdapterType({ id: 4, preferred_pm_adapter: null }), 'codex');
    assert.equal(spawn.resolveOperatorAdapterType({ id: 5, preferred_pm_adapter: 'opencode' }), 'codex');
    assert.ok(logs.some(msg => msg.includes('project=5 unknown preferred=opencode')));
  } finally {
    if (previousDefault === undefined) {
      delete process.env.PALANTIR_DEFAULT_PM_ADAPTER;
    } else {
      process.env.PALANTIR_DEFAULT_PM_ADAPTER = previousDefault;
    }
  }
});

test('P5-S4c: Claude operator spawn persists local claude_session_id affinity from onSessionStarted', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService });
  const topAdapter = makeFakeManagerAdapter('claude-code');
  const claudeAdapter = makeFakeManagerAdapter('claude-code');
  const codexAdapter = makeFakeManagerAdapter('codex');
  const adapterCalls = [];
  const managerAdapterFactory = {
    getAdapter(type) {
      adapterCalls.push(type);
      if (type === 'claude-code') return claudeAdapter;
      if (type === 'codex') return codexAdapter;
      throw new Error(`unexpected adapter type ${type}`);
    },
  };
  const spawn = createOperatorSpawnService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory,
    projectService,
    projectBriefService,
    resolveManagerAuth: authOk,
  });
  const project = projectService.createProject({ name: 'claude-op', preferred_pm_adapter: 'claude' });
  seedTop({ runService, registry, adapter: topAdapter });

  const result = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result.spawned, true);
  assert.equal(result.run.manager_adapter, 'claude-code');
  assert.equal(adapterCalls[0], 'claude-code');
  assert.equal(claudeAdapter._starts.length, 1);
  const start = claudeAdapter._starts[0];
  assert.equal(typeof start.opts.onSessionStarted, 'function');
  assert.equal(typeof start.opts.onThreadStarted, 'function');
  assert.equal(start.opts.resumeSessionId, null);
  assert.equal(runService.getRun(result.run.id).status, 'queued');

  start.opts.onSessionStarted('sess_claude_1');

  assert.equal(runService.getRun(result.run.id).status, 'running');
  const thread = operatorThreadRow(runService, project.id);
  assert.equal(thread.thread_id, 'sess_claude_1');
  assert.equal(thread.pm_adapter, 'claude');
  assert.equal(thread.node_id, null);
  assert.equal(thread.cwd, null);
});

test('P5-S4c: Claude lazy-spawn resumes a persisted session on the matching remote node', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService });
  const nodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(nodeService, 'nodeA');
  const claudeAdapter = makeFakeManagerAdapter('claude-code');
  const codexAdapter = makeFakeManagerAdapter('codex');
  const spawn = createOperatorSpawnService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory({ claudeAdapter, codexAdapter }),
    projectService,
    projectBriefService,
    nodeService,
    resolveManagerAuth: authOk,
  });
  const project = projectService.createProject({
    name: 'claude-resume',
    preferred_pm_adapter: 'claude',
    node_id: 'nodeA',
    directory: '/workspace/claude-resume',
  });
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'sessA',
    pm_adapter: 'claude',
    pm_thread_node_id: 'nodeA',
    pm_thread_cwd: '/workspace/claude-resume',
  });
  seedTop({ runService, registry, adapter: makeFakeManagerAdapter('claude-code') });

  const result = spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.resumed, true);
  assert.equal(claudeAdapter._starts[0].opts.resumeSessionId, 'sessA');
  assert.equal(claudeAdapter._starts[0].opts.resumeThreadId, null);
  assert.equal(claudeAdapter._starts[0].opts.cwd, '/workspace/claude-resume');
});

test('P5-S4c: Claude lazy-spawn clears a persisted session bound to a different node', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const baseBriefService = createProjectBriefService(db);
  const projectBriefService = wrapBriefService(baseBriefService);
  const registry = createManagerRegistry({ runService });
  const nodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(nodeService, 'nodeA');
  createSshNode(nodeService, 'nodeB');
  const claudeAdapter = makeFakeManagerAdapter('claude-code');
  const codexAdapter = makeFakeManagerAdapter('codex');
  const spawn = createOperatorSpawnService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory({ claudeAdapter, codexAdapter }),
    projectService,
    projectBriefService,
    nodeService,
    resolveManagerAuth: authOk,
  });
  const project = projectService.createProject({
    name: 'claude-rebind',
    preferred_pm_adapter: 'claude',
    node_id: 'nodeB',
    directory: '/workspace/claude-rebind',
  });
  seedOperatorThread(runService, project.id, {
    pm_thread_id: 'sessA',
    pm_adapter: 'claude',
    pm_thread_node_id: 'nodeA',
    pm_thread_cwd: '/workspace/old',
  });
  seedTop({ runService, registry, adapter: makeFakeManagerAdapter('claude-code') });

  const result = spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.resumed, false);
  assert.equal(claudeAdapter._starts[0].opts.resumeSessionId, null);
  assert.equal(operatorThreadRow(runService, project.id).thread_id, null);
  const event = runService.getRunEvents(result.run.id).find(e => e.event_type === 'operator:thread_rebind_reset');
  assert.deepEqual(JSON.parse(event.payload_json), { from_node: 'nodeA', to_node: 'nodeB' });
});

test('P5-S4c: Claude lazy-spawn clears a Codex thread instead of resuming it as a session', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const baseBriefService = createProjectBriefService(db);
  const projectBriefService = wrapBriefService(baseBriefService);
  const registry = createManagerRegistry({ runService });
  const claudeAdapter = makeFakeManagerAdapter('claude-code');
  const codexAdapter = makeFakeManagerAdapter('codex');
  const spawn = createOperatorSpawnService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory({ claudeAdapter, codexAdapter }),
    projectService,
    projectBriefService,
    resolveManagerAuth: authOk,
  });
  const project = projectService.createProject({ name: 'claude-adapter-mismatch', preferred_pm_adapter: 'claude' });
  seedOperatorThread(runService, project.id, {
    pm_thread_id: 'threadA',
    pm_adapter: 'codex',
    pm_thread_node_id: null,
    pm_thread_cwd: null,
  });
  seedTop({ runService, registry, adapter: makeFakeManagerAdapter('claude-code') });

  const result = spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.resumed, false);
  assert.equal(claudeAdapter._starts[0].opts.resumeSessionId, null);
  assert.equal(operatorThreadRow(runService, project.id).thread_id, null);
});

test('P5-S4c: Codex lazy-spawn resumes only Codex handles and clears Claude sessions', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const baseBriefService = createProjectBriefService(db);
  const projectBriefService = wrapBriefService(baseBriefService);
  const registry = createManagerRegistry({ runService });
  const claudeAdapter = makeFakeManagerAdapter('claude-code');
  const codexAdapter = makeFakeManagerAdapter('codex');
  const spawn = createOperatorSpawnService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory({ claudeAdapter, codexAdapter }),
    projectService,
    projectBriefService,
    resolveManagerAuth: authOk,
  });
  seedTop({ runService, registry, adapter: makeFakeManagerAdapter('claude-code') });

  const codexProject = projectService.createProject({ name: 'codex-resume' });
  baseBriefService.setPmThread(codexProject.id, {
    pm_thread_id: 'threadA',
    pm_adapter: 'codex',
    pm_thread_node_id: null,
    pm_thread_cwd: null,
  });
  const codexResult = spawn.ensureLiveOperator({ projectId: codexProject.id });

  assert.equal(codexResult.resumed, true);
  assert.equal(codexAdapter._starts[0].opts.resumeThreadId, 'threadA');
  assert.equal(codexAdapter._starts[0].opts.resumeSessionId, null);

  const mismatchProject = projectService.createProject({ name: 'codex-adapter-mismatch' });
  seedOperatorThread(runService, mismatchProject.id, {
    pm_thread_id: 'sessA',
    pm_adapter: 'claude',
    pm_thread_node_id: null,
    pm_thread_cwd: null,
  });
  const mismatchResult = spawn.ensureLiveOperator({ projectId: mismatchProject.id });

  assert.equal(mismatchResult.resumed, false);
  assert.equal(codexAdapter._starts[1].opts.resumeThreadId, null);
  assert.equal(operatorThreadRow(runService, mismatchProject.id).thread_id, null);
});

test('P5-S4a: default Codex operator still starts from onThreadStarted', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService });
  const topAdapter = makeFakeManagerAdapter('claude-code');
  const claudeAdapter = makeFakeManagerAdapter('claude-code');
  const codexAdapter = makeFakeManagerAdapter('codex');
  const adapterCalls = [];
  const managerAdapterFactory = {
    getAdapter(type) {
      adapterCalls.push(type);
      if (type === 'claude-code') return claudeAdapter;
      if (type === 'codex') return codexAdapter;
      throw new Error(`unexpected adapter type ${type}`);
    },
  };
  const spawn = createOperatorSpawnService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory,
    projectService,
    projectBriefService,
    resolveManagerAuth: authOk,
  });
  const project = projectService.createProject({ name: 'codex-op' });
  seedTop({ runService, registry, adapter: topAdapter });

  const result = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result.spawned, true);
  assert.equal(result.run.manager_adapter, 'codex');
  assert.equal(adapterCalls[0], 'codex');
  assert.equal(codexAdapter._starts.length, 1);
  const start = codexAdapter._starts[0];
  assert.equal(typeof start.opts.onThreadStarted, 'function');
  assert.equal(runService.getRun(result.run.id).status, 'queued');

  start.opts.onThreadStarted('thread_codex_1');

  assert.equal(runService.getRun(result.run.id).status, 'running');
  assert.equal(operatorThreadRow(runService, project.id).thread_id, 'thread_codex_1');
});

test('P5-S4a: claudeAdapter onSessionStarted fires once on system:init', () => {
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const { NORMALIZED_EVENT_TYPES } = require('../services/managerAdapters/eventTypes');
  const events = [];
  const runService = {
    addRunEvent(runId, type, payload) {
      events.push({ runId, type, payload: payload ? JSON.parse(payload) : null });
      return events.length;
    },
  };
  let vendorHook = null;
  const streamJsonEngine = {
    spawnAgent(runId, opts) {
      vendorHook = opts.onVendorEvent;
      return { pid: 1234 };
    },
  };
  const sessionIds = [];
  const adapter = createClaudeAdapter({ streamJsonEngine, runService });

  adapter.startSession('run_claude', {
    prompt: undefined,
    cwd: process.cwd(),
    onSessionStarted: (sessionId) => sessionIds.push(sessionId),
  });
  assert.equal(typeof vendorHook, 'function');

  vendorHook({ type: 'system', subtype: 'init', session_id: 'sess_1', model: 'sonnet', cwd: '/tmp' }, {});
  vendorHook({ type: 'system', subtype: 'init', session_id: 'sess_2', model: 'sonnet', cwd: '/tmp' }, {});
  vendorHook({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }, {});

  assert.deepEqual(sessionIds, ['sess_1']);
  assert.equal(events.filter(ev => ev.type === NORMALIZED_EVENT_TYPES.SESSION_STARTED).length, 1);
});

test('P5-S4a: Claude operator preflights auth with the claude-code profile allowlist (not codex) — Codex R1 BLOCKER', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const { createAgentProfileService } = require('../services/agentProfileService');
  const agentProfileService = createAgentProfileService(db); // migrations seed claude-code + codex profiles + env_allowlist
  const registry = createManagerRegistry({ runService });
  const claudeAdapter = makeFakeManagerAdapter('claude-code');
  const codexAdapter = makeFakeManagerAdapter('codex');
  const managerAdapterFactory = {
    getAdapter(type) {
      if (type === 'claude-code') return claudeAdapter;
      if (type === 'codex') return codexAdapter;
      throw new Error(`unexpected adapter type ${type}`);
    },
  };
  let capturedType;
  let capturedAllowlist;
  const capturingAuth = (type, opts) => {
    capturedType = type;
    capturedAllowlist = opts && opts.envAllowlist;
    return { canAuth: true, env: {}, sources: [], diagnostics: [] };
  };
  const spawn = createOperatorSpawnService({
    runService, managerRegistry: registry, managerAdapterFactory,
    projectService, projectBriefService, agentProfileService,
    resolveManagerAuth: capturingAuth,
  });
  const project = projectService.createProject({ name: 'claude-prof', preferred_pm_adapter: 'claude' });
  seedTop({ runService, registry, adapter: makeFakeManagerAdapter('claude-code') });

  spawn.ensureLiveOperator({ projectId: project.id });

  // The wrong (codex) profile would preflight Claude auth with the codex
  // allowlist, dropping CLAUDE_CODE_OAUTH_TOKEN → auth failure on a real deploy.
  assert.equal(capturedType, 'claude-code');
  assert.ok(Array.isArray(capturedAllowlist), 'an allowlist was resolved from the profile');
  assert.ok(capturedAllowlist.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'claude-code profile allowlist used');
  assert.ok(!capturedAllowlist.includes('CODEX_API_KEY'), 'not the codex profile allowlist');
});

test('P5-S4b: remote node + Claude preference spawns a remote Claude Operator (executor + nodePrefix + pod cwd + minimal env)', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService });
  const claudeAdapter = makeFakeManagerAdapter('claude-code');
  const codexAdapter = makeFakeManagerAdapter('codex');
  const managerAdapterFactory = {
    getAdapter(type) {
      if (type === 'claude-code') return claudeAdapter;
      if (type === 'codex') return codexAdapter;
      throw new Error(`unexpected adapter type ${type}`);
    },
  };
  const { createNodeService } = require('../services/nodeService');
  const nodeService = createNodeService(db, { localExecutor: { local: true } });
  nodeService.createNode({
    id: 'nodeA', name: 'nodeA', kind: 'ssh', ssh_host: 'nodeA.example', ssh_user: 'runner',
    exposed_roots: ['/workspace'], can_execute: true, reachable: true, node_prefix: '/opt/nodeA/bin',
  });
  const spawn = createOperatorSpawnService({
    runService, managerRegistry: registry, managerAdapterFactory,
    projectService, projectBriefService, nodeService,
    resolveManagerAuth: authOk,
  });
  const project = projectService.createProject({
    name: 'remote-claude', preferred_pm_adapter: 'claude', node_id: 'nodeA', directory: '/workspace/remote-claude',
  });
  seedTop({ runService, registry, adapter: makeFakeManagerAdapter('claude-code') });

  // P5-S4b: remote + claude now spawns a remote Claude Operator (gate removed).
  const result = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result.spawned, true);
  assert.equal(result.run.manager_adapter, 'claude-code');
  assert.equal(result.run.node_id, 'nodeA');
  assert.equal(claudeAdapter._starts.length, 1);
  const start = claudeAdapter._starts[0];
  assert.ok(start.opts.executor, 'remote Claude Operator receives an executor');
  assert.equal(start.opts.nodePrefix, '/opt/nodeA/bin');
  assert.equal(start.opts.cwd, '/workspace/remote-claude', 'pod cwd (project.directory)');
  assert.deepEqual(start.opts.env, {}, 'remote Operator gets a minimal env (no control-plane creds)');
  // Claude uses onSessionStarted for markRunStarted (not codex onThreadStarted).
  assert.equal(typeof start.opts.onSessionStarted, 'function');

  start.opts.onSessionStarted('sess_remote_claude');
  const thread = operatorThreadRow(runService, project.id);
  assert.equal(thread.thread_id, 'sess_remote_claude');
  assert.equal(thread.pm_adapter, 'claude');
  assert.equal(thread.node_id, 'nodeA');
  assert.equal(thread.cwd, '/workspace/remote-claude');
});
