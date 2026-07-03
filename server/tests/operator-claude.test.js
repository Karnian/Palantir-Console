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

test('P5-S4a: resolveOperatorAdapterType maps Claude preferences to claude-code', () => {
  const previousDefault = process.env.PALANTIR_DEFAULT_PM_ADAPTER;
  delete process.env.PALANTIR_DEFAULT_PM_ADAPTER;
  const logs = [];
  const spawn = createOperatorSpawnService({ logger: (msg) => logs.push(msg) });

  try {
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

test('P5-S4a: Claude operator spawn marks running from onSessionStarted without persisting pm_thread', async (t) => {
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
  assert.equal(runService.getRun(result.run.id).status, 'queued');

  start.opts.onSessionStarted('sess_claude_1');

  assert.equal(runService.getRun(result.run.id).status, 'running');
  assert.equal(projectBriefService.getBrief(project.id).pm_thread_id, null);
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
  assert.equal(projectBriefService.getBrief(project.id).pm_thread_id, 'thread_codex_1');
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

test('P5-S4a: remote node + Claude preference fails closed until S4b — Codex R1 SERIOUS', async (t) => {
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
  const project = projectService.createProject({ name: 'remote-claude', preferred_pm_adapter: 'claude', node_id: 'nodeA' });
  seedTop({ runService, registry, adapter: makeFakeManagerAdapter('claude-code') });

  // Remote + claude must fail closed (S4a is local-only; remote claude is S4b).
  assert.throws(() => spawn.ensureLiveOperator({ projectId: project.id }), /Remote Claude Operator is not yet supported/);
  // No Claude adapter was ever spawned on the pod.
  assert.equal(claudeAdapter._starts.length, 0);
});
