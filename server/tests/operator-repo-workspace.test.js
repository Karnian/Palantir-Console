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
const { createConversationService } = require('../services/conversationService');
const { createManagerRouter } = require('../routes/manager');
const { repoSourceHash } = require('../utils/repoOperatorThread');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-operator-repo-'));
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

function withRepoFlag(t, value) {
  const old = process.env.PALANTIR_PROJECT_REPO;
  process.env.PALANTIR_PROJECT_REPO = value;
  t.after(() => {
    if (old === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = old;
  });
}

function makeAdapter() {
  const starts = [];
  const disposes = [];
  return {
    type: 'codex',
    capabilities: { persistentProcess: false, supportsResume: true },
    startSession(runId, opts) {
      starts.push({ runId, opts });
      if (opts.resumeThreadId && typeof opts.onThreadStarted === 'function') {
        opts.onThreadStarted(opts.resumeThreadId);
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

function seedTop({ runService, registry, adapter }) {
  const run = runService.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  runService.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive('top', run.id, adapter);
  return run;
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

function makeNodeService(realNodeService, { remote = false } = {}) {
  return {
    resolveNode(project) {
      return remote ? project.node_id : 'local';
    },
    getNode(id) {
      return realNodeService.getNode(id);
    },
    pickExecutor() {
      return { exec() { return { code: 0, stdout: '', stderr: '' }; } };
    },
  };
}

function makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, materializationService }) {
  return createOperatorSpawnService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    projectService,
    projectBriefService,
    nodeService,
    projectMaterializationService: materializationService,
  });
}

function makeMaterializationMock({ runService, workspacePath = '/tmp/operator-ws', cwd = workspacePath } = {}) {
  const calls = [];
  return {
    calls,
    async ensureWorkspace({ project, nodeId, runId, claimToken }) {
      calls.push({ projectId: project.id, nodeId, runId, claimToken });
      const run = runService.updateRunMaterialized(runId, {
        materialize_claim_token: claimToken,
        source_type_snapshot: 'git',
        run_source_generation: project.source_generation,
        repo_url_snapshot: project.repo_url,
        repo_ref_snapshot: project.repo_ref,
        repo_subdir_snapshot: project.repo_subdir,
        repo_cache_path: '/tmp/operator-cache.git',
        workspace_path: workspacePath,
        workspace_generation: project.source_generation,
        resolved_commit: '0123456789abcdef',
      });
      return { ready: true, run, workspacePath, cwd };
    },
  };
}

test('local git Operator materializes workspace and starts with workspace subdir cwd', async (t) => {
  withCodexAuth(t);
  withRepoFlag(t, '1');
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = makeNodeService(createNodeService(db, { localExecutor: { local: true } }));
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({
    name: 'repo',
    source_type: 'git',
    repo_url: 'file:///tmp/repo.git',
    repo_ref: 'main',
    repo_subdir: 'packages/api',
  });
  const materializationService = makeMaterializationMock({
    runService,
    workspacePath: '/tmp/materialized/repo-worktree',
    cwd: '/tmp/materialized/repo-worktree/packages/api',
  });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, materializationService });

  const result = await spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.spawned, true);
  assert.equal(materializationService.calls.length, 1);
  assert.equal(adapter._starts[0].opts.cwd, '/tmp/materialized/repo-worktree/packages/api');
  assert.equal(adapter._starts[0].opts.resumeThreadId, null);
});

test('legacy_directory Operator keeps project.directory cwd and never materializes', async (t) => {
  withCodexAuth(t);
  withRepoFlag(t, '1');
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = makeNodeService(createNodeService(db, { localExecutor: { local: true } }));
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({ name: 'legacy', directory: '/tmp/legacy-project' });
  const materializationService = makeMaterializationMock({ runService });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, materializationService });

  const result = spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.spawned, true);
  assert.equal(materializationService.calls.length, 0);
  assert.equal(adapter._starts[0].opts.cwd, '/tmp/legacy-project');
});

test('flag-off git Operator fails closed before materialization', async (t) => {
  withCodexAuth(t);
  withRepoFlag(t, '0');
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = makeNodeService(createNodeService(db, { localExecutor: { local: true } }));
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({ name: 'repo-off', source_type: 'git', repo_url: 'file:///tmp/repo.git' });
  const materializationService = makeMaterializationMock({ runService });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, materializationService });

  assert.throws(() => spawn.ensureLiveOperator({ projectId: project.id }), /materialization is disabled/);
  assert.equal(materializationService.calls.length, 0);
  assert.equal(adapter._starts.length, 0);
});

test('remote git Operator fails closed as unsupported', async (t) => {
  withCodexAuth(t);
  withRepoFlag(t, '1');
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const realNodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(realNodeService, 'nodeA');
  const nodeService = makeNodeService(realNodeService, { remote: true });
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({
    name: 'remote-repo',
    source_type: 'git',
    repo_url: 'file:///tmp/repo.git',
    node_id: 'nodeA',
  });
  const materializationService = makeMaterializationMock({ runService });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, materializationService });

  assert.throws(() => spawn.ensureLiveOperator({ projectId: project.id }), /unsupported on remote/);
  assert.equal(materializationService.calls.length, 0);
  assert.equal(adapter._starts.length, 0);
});

test('source-generation mismatch clears stored thread and starts fresh', async (t) => {
  withCodexAuth(t);
  withRepoFlag(t, '1');
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = makeNodeService(createNodeService(db, { localExecutor: { local: true } }));
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const created = projectService.createProject({ name: 'stale', source_type: 'git', repo_url: 'file:///tmp/repo.git' });
  db.prepare('UPDATE projects SET source_generation = 2 WHERE id = ?').run(created.id);
  const project = projectService.getProject(created.id);
  seedOperatorThread(runService, project.id, {
    pm_thread_id: 'thread-old',
    pm_adapter: 'codex',
    pm_thread_source_generation: 1,
    pm_thread_source_hash: repoSourceHash(project),
    pm_thread_workspace_path: '/tmp/old-workspace',
    pm_thread_cwd: '/tmp/old-workspace',
  });
  const materializationService = makeMaterializationMock({ runService, workspacePath: '/tmp/new-workspace', cwd: '/tmp/new-workspace' });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, materializationService });

  const result = await spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.resumed, false);
  assert.equal(adapter._starts[0].opts.resumeThreadId, null);
  assert.equal(operatorThreadRow(runService, project.id).thread_id, null);
  const event = runService.getRunEvents(result.run.id).find((row) => row.event_type === 'operator:thread_source_reset');
  assert.deepEqual(JSON.parse(event.payload_json), { from_generation: 1, to_generation: 2, reason: 'generation_mismatch' });
});

test('source-generation match resumes from stored workspace without materializing', async (t) => {
  withCodexAuth(t);
  withRepoFlag(t, '1');
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = makeNodeService(createNodeService(db, { localExecutor: { local: true } }));
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({
    name: 'resume-repo',
    source_type: 'git',
    repo_url: 'file:///tmp/repo.git',
    repo_subdir: 'svc',
  });
  seedOperatorThread(runService, project.id, {
    pm_thread_id: 'thread-current',
    pm_adapter: 'codex',
    pm_thread_source_generation: project.source_generation,
    pm_thread_source_hash: repoSourceHash(project),
    pm_thread_workspace_path: '/tmp/current-workspace',
    pm_thread_cwd: '/tmp/current-workspace/svc',
  });
  const materializationService = makeMaterializationMock({ runService, workspacePath: '/tmp/unused', cwd: '/tmp/unused' });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, materializationService });

  const result = spawn.ensureLiveOperator({ projectId: project.id });

  assert.equal(result.resumed, true);
  assert.equal(materializationService.calls.length, 0);
  assert.equal(adapter._starts[0].opts.resumeThreadId, 'thread-current');
  assert.equal(adapter._starts[0].opts.cwd, '/tmp/current-workspace/svc');
});

test('operator instance thread persists repo generation hash and workspace path', async (t) => {
  withCodexAuth(t);
  withRepoFlag(t, '1');
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = makeNodeService(createNodeService(db, { localExecutor: { local: true } }));
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  seedTop({ runService, registry, adapter: makeAdapter() });
  const project = projectService.createProject({
    name: 'persist',
    source_type: 'git',
    repo_url: 'file:///tmp/repo.git',
    repo_ref: 'main',
  });
  const materializationService = makeMaterializationMock({ runService, workspacePath: '/tmp/persist-workspace', cwd: '/tmp/persist-workspace' });
  const spawn = makeSpawn({ runService, registry, adapter, projectService, projectBriefService, nodeService, materializationService });

  await spawn.ensureLiveOperator({ projectId: project.id });
  adapter._starts[0].opts.onThreadStarted('thread-new');
  const thread = operatorThreadRow(runService, project.id);

  assert.equal(thread.thread_id, 'thread-new');
  assert.equal(thread.source_generation, project.source_generation);
  assert.equal(thread.source_hash, repoSourceHash(project));
  assert.equal(thread.workspace_path, '/tmp/persist-workspace');
  assert.equal(thread.cwd, '/tmp/persist-workspace');
});

test('boot resume skips stale repo thread and records source reset', async (t) => {
  withCodexAuth(t);
  withRepoFlag(t, '1');
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = makeNodeService(createNodeService(db, { localExecutor: { local: true } }));
  const registry = createManagerRegistry({ runService });
  const adapter = makeAdapter();
  const top = runService.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  runService.updateRunStatus(top.id, 'completed', { force: true });
  registry.setActive('top', top.id, makeAdapter());
  const conversationService = createConversationService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    lifecycleService: null,
  });
  const created = projectService.createProject({ name: 'boot-stale', source_type: 'git', repo_url: 'file:///tmp/repo.git' });
  db.prepare('UPDATE projects SET source_generation = 3 WHERE id = ?').run(created.id);
  const project = projectService.getProject(created.id);
  seedOperatorThread(runService, project.id, {
    pm_thread_id: 'thread-boot-old',
    pm_adapter: 'codex',
    pm_thread_source_generation: 2,
    pm_thread_source_hash: repoSourceHash(project),
    pm_thread_workspace_path: '/tmp/boot-old-workspace',
    pm_thread_cwd: '/tmp/boot-old-workspace',
  });
  const run = runService.createRun({
    is_manager: true,
    manager_adapter: 'codex',
    manager_layer: 'operator',
    conversation_id: `operator:${project.id}`,
    prompt: 'boot stale',
  });
  runService.updateRunStatus(run.id, 'running', { force: true });

  createManagerRouter({
    runService,
    managerAdapterFactory: { getAdapter: () => adapter },
    managerRegistry: registry,
    conversationService,
    projectService,
    projectBriefService,
    nodeService,
  });

  assert.equal(adapter._starts.length, 0);
  assert.equal(operatorThreadRow(runService, project.id).thread_id, null);
  assert.equal(runService.getRun(run.id).status, 'stopped');
  const event = runService.getRunEvents(run.id).find((row) => row.event_type === 'operator:thread_source_reset');
  assert.deepEqual(JSON.parse(event.payload_json), { from_generation: 2, to_generation: 3, reason: 'generation_mismatch' });
});
