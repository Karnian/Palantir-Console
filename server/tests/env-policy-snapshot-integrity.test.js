'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createProjectBriefService } = require('../services/projectBriefService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createOperatorSpawnService } = require('../services/operatorSpawnService');

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-env-snapshot-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => { close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { db, runService: createRunService(db, null) };
}

const policy = (key) => ({
  effectiveKeys: [key],
  providers: [],
  allowDefaultAuth: false,
  blockedKeys: [],
});

test('envPolicy is write-once, preserves the first value, and permits an identical retry', async (t) => {
  const { runService } = await harness(t);
  const run = runService.createRun({ is_manager: true, prompt: 'snapshot' });
  assert.doesNotThrow(() => runService.setSessionSnapshot(run.id, { sessionEnvPolicy: policy('FIRST') }));
  assert.doesNotThrow(() => runService.setSessionSnapshot(run.id, { sessionEnvPolicy: policy('FIRST') }));
  assert.throws(
    () => runService.setSessionSnapshot(run.id, { sessionEnvPolicy: policy('SECOND') }),
    /immutable/,
  );
  assert.deepEqual(JSON.parse(runService.getRun(run.id).session_claude_options_json).envPolicy.effectiveKeys, ['FIRST']);
});

test('omitting sessionEnvPolicy cannot clear an existing snapshot', async (t) => {
  const { runService } = await harness(t);
  const run = runService.createRun({ is_manager: true, prompt: 'preserve' });
  runService.setSessionSnapshot(run.id, { sessionEnvPolicy: policy('PINNED') });
  runService.setSessionSnapshot(run.id, { sessionModel: 'new-model' });
  const persisted = runService.getRun(run.id);
  assert.equal(persisted.session_model, 'new-model');
  assert.deepEqual(JSON.parse(persisted.session_claude_options_json).envPolicy.effectiveKeys, ['PINNED']);

  // The dangerous shape is a later write that DOES carry sessionClaudeOptions:
  // the options object is replaced wholesale, so without an explicit carry-over
  // the pinned policy is dropped. Omitting options entirely happens to survive
  // through a different branch, which is why that alone did not detect it.
  runService.setSessionSnapshot(run.id, {
    sessionModel: 'newer-model',
    sessionClaudeOptions: { tools: ['Read'] },
  });
  const afterOptions = JSON.parse(runService.getRun(run.id).session_claude_options_json);
  assert.deepEqual(afterOptions.tools, ['Read'], 'other options are replaceable');
  assert.deepEqual(afterOptions.envPolicy.effectiveKeys, ['PINNED'], 'the pin is not');
});

function fakeAdapter(starts) {
  return {
    type: 'codex', capabilities: { persistentProcess: false, supportsResume: true },
    startSession(runId, opts) { starts.push({ runId, opts }); return { sessionRef: { runId } }; },
    isSessionAlive() { return true; }, buildGuardrailsSection() { return ''; },
  };
}

async function operatorHarness(t, { failSnapshot = false } = {}) {
  const h = await harness(t);
  const projectService = createProjectService(h.db);
  const projectBriefService = createProjectBriefService(h.db);
  const agentProfileService = createAgentProfileService(h.db);
  const registry = createManagerRegistry({ runService: h.runService });
  const starts = [];
  const adapter = fakeAdapter(starts);
  const top = h.runService.createRun({ is_manager: true, manager_adapter: 'codex', prompt: 'top' });
  h.runService.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, adapter);
  if (failSnapshot) h.runService.setSessionSnapshot = () => { throw new Error('injected snapshot failure'); };
  const service = createOperatorSpawnService({
    runService: h.runService,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    projectService,
    projectBriefService,
    agentProfileService,
    resolveManagerAuth: () => ({ canAuth: true, env: {}, sources: [], diagnostics: [] }),
  });
  const project = projectService.createProject({ name: `snapshot-${failSnapshot}`, preferred_pm_adapter: 'codex' });
  return { ...h, service, project, starts };
}

test('operator spawn fails closed when env snapshot persistence fails, while success still starts', async (t) => {
  const failed = await operatorHarness(t, { failSnapshot: true });
  assert.throws(() => failed.service.ensureLiveOperator({ projectId: failed.project.id }), /snapshot failure/);
  assert.equal(failed.starts.length, 0);
  const failedRun = failed.runService.listRuns().find((row) => row.manager_layer === 'operator');
  assert.ok(failed.runService.getRunEvents(failedRun.id).some((event) => event.event_type === 'operator:env_snapshot_unwritable'));

  const ok = await operatorHarness(t);
  const result = ok.service.ensureLiveOperator({ projectId: ok.project.id });
  assert.equal(result.spawned, true);
  assert.equal(ok.starts.length, 1);
});

const { createLifecycleService } = require('../services/lifecycleService');

test('the real worker spawn path survives an unwritable snapshot and records it', async (t) => {
  // Drives lifecycleService's actual spawn, not a re-implementation of its
  // try/catch: a test that repeats the handling would keep passing after the
  // call site regressed to throwing, which is the regression being defended.
  //
  // Why non-fatal here: every reader of the envPolicy snapshot is in
  // routes/manager.js boot resume. Nothing resumes a worker from it, so failing
  // the run buys no safety -- and it cost the whole drain, marking every queued
  // run failed and spawning none.
  const h = await harness(t);
  const spawned = [];
  const runService = {
    ...h.runService,
    setSessionSnapshot() { throw new Error('injected snapshot failure'); },
  };
  const lifecycleService = createLifecycleService({
    runService,
    taskService: { getTask: (id) => ({ id, project_id: null }), updateTaskStatus() {} },
    agentProfileService: {
      getProfile: (id) => ({ id, command: 'claude', max_concurrent: 10, type: 'claude-code' }),
    },
    projectService: { getProject: () => null },
    executionEngine: {
      spawnAgent(runId) { spawned.push(runId); return { pid: 1 }; },
      isAlive: () => true, detectExitCode: () => null, getOutput: () => '', kill: () => true,
    },
  });
  t.after(() => { try { lifecycleService.stopMonitoring(); } catch { /* ignore */ } });

  const run = h.runService.createRun({
    task_id: null, agent_profile_id: 'claude-code', prompt: 'worker', node_id: 'local', is_manager: true,
  });
  await lifecycleService.spawnQueuedRun(run.id).catch(() => {});

  const after = h.runService.getRun(run.id);
  assert.notEqual(after.status, 'failed', 'an observability write must not fail the run');
  assert.ok(
    h.runService.getRunEvents(run.id).some((e) => e.event_type === 'worker:env_snapshot_unwritable'),
    'but it must be observable',
  );
});

test('envPolicy cannot be planted through the generic options bag', async (t) => {
  // write-once protects an EXISTING pin. Accepting the reserved field inside
  // sessionClaudeOptions let a caller plant the first one unvalidated, and that
  // planted value then becomes the immutable authority resume trusts.
  const { runService } = await harness(t);
  const run = runService.createRun({ is_manager: true, prompt: 'planted' });

  assert.throws(
    () => runService.setSessionSnapshot(run.id, {
      sessionClaudeOptions: { envPolicy: { version: 99, effectiveKeys: ['SMUGGLED'] } },
    }),
    /envPolicy must be supplied through sessionEnvPolicy/,
  );
  assert.equal(runService.getRun(run.id).session_claude_options_json, null, 'nothing was written');

  // The validated channel still works, and still refuses a later different pin.
  runService.setSessionSnapshot(run.id, { sessionEnvPolicy: policy('REAL') });
  assert.deepEqual(
    JSON.parse(runService.getRun(run.id).session_claude_options_json).envPolicy.effectiveKeys,
    ['REAL'],
  );
});
