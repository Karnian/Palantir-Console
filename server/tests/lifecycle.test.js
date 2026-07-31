// P5-5: lifecycleService unit tests
//
// Tests for the core lifecycle behaviours without spawning real processes.
// Stubs are injected for streamJsonEngine and executionEngine; the DB is a
// real in-memory SQLite instance so run/task state assertions are meaningful.

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
const { createEnvironmentProviderService } = require('../services/environmentProviderService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createEventBus } = require('../services/eventBus');

// ---------------------------------------------------------------------------
// Test DB helper
// ---------------------------------------------------------------------------

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-lc-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeStubExecutionEngine({ alive = true, exitCode = null, output = '' } = {}) {
  const spawned = [];
  const killed = [];
  const inputs = [];
  let aliveState = alive;
  let exitCodeState = exitCode;
  return {
    type: 'subprocess',
    spawned,
    killed,
    inputs,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `session-${runId}` };
    },
    isAlive(runId) { return aliveState; },
    detectExitCode(runId) { return exitCodeState; },
    setAlive(value) { aliveState = value; },
    setExitCode(value) { exitCodeState = value; },
    getOutput(runId) { return output; },
    sendInput(runId, text) { inputs.push({ runId, text }); return true; },
    kill(runId) { killed.push(runId); },
    discoverGhostSessions() { return []; },
    hasProcess(runId) { return false; },
  };
}

function makeStubStreamJsonEngine({ alive = true, spawnOk = true } = {}) {
  const spawned = [];
  const killed = [];
  const inputs = [];
  return {
    spawned,
    killed,
    inputs,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      if (!spawnOk) throw new Error('spawn failed');
      return { sessionName: null };
    },
    hasProcess(runId) { return spawned.some(s => s.runId === runId); },
    isAlive(runId) { return alive; },
    detectExitCode(runId) { return null; },
    sendInput(runId, text) { inputs.push({ runId, text }); return true; },
    kill(runId) { killed.push(runId); return true; },
  };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedProject(db, { dir = null } = {}) {
  const ps = createProjectService(db);
  return ps.createProject({ name: 'TestProject', directory: dir });
}

function seedTask(db, projectId) {
  const ts = createTaskService(db);
  return ts.createTask({ project_id: projectId, title: 'Do something', description: 'desc' });
}

function seedProfile(db, {
  command = 'codex',
  capabilities_json = '{}',
  env_allowlist = '[]',
  idle_timeout_ms = null,
} = {}) {
  // Insert directly so we can use any command string without the allowlist guard.
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO agent_profiles (
       id, name, type, command, capabilities_json, env_allowlist,
       max_concurrent, idle_timeout_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 5, ?)`
  ).run(id, 'TestAgent', 'codex', command, capabilities_json, env_allowlist, idle_timeout_ms);
  return { id, name: 'TestAgent', type: 'codex', command, capabilities_json, env_allowlist, max_concurrent: 5 };
}

test('recoverOrphanSessions revokes legacy tmux workers after actor-token separation', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db);
  const run = rs.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'legacy worker',
  });
  rs.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });
  rs.updateRunStatus(run.id, 'needs_input');

  let alive = true;
  const execEngine = makeStubExecutionEngine();
  execEngine.type = 'tmux';
  execEngine.discoverGhostSessions = () => [{
    name: `palantir-run-${run.id}`,
    isPalantir: true,
  }];
  execEngine.isAlive = () => alive;
  execEngine.kill = (runId) => {
    execEngine.killed.push(runId);
    alive = false;
    return true;
  };

  const lc = createLifecycleService({
    runService: rs,
    taskService: ts,
    agentProfileService: aps,
    projectService: ps,
    executionEngine: execEngine,
    streamJsonEngine: makeStubStreamJsonEngine(),
    worktreeService: null,
    eventBus: null,
    actorTokens: {
      humanToken: 'human-secret',
      agentToken: 'agent-secret',
      separated: true,
      boundary: 'separated_tokens',
    },
  });

  const recovered = await lc.recoverOrphanSessions();

  assert.deepEqual(execEngine.killed, [run.id]);
  assert.deepEqual(recovered, [{ runId: run.id, status: 'credential_revoked' }]);
  assert.equal(rs.getRun(run.id).status, 'stopped');
});

test('recoverOrphanSessions continues revoking legacy workers after one kill fails', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const project = seedProject(db);
  const profile = seedProfile(db);
  const runs = ['first', 'second'].map((label) => {
    const task = ts.createTask({ project_id: project.id, title: `Legacy ${label}` });
    const run = rs.createRun({
      task_id: task.id,
      agent_profile_id: profile.id,
      prompt: `legacy ${label}`,
    });
    rs.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });
    return run;
  });
  rs.updateRunStatus(runs[1].id, 'paused');

  const alive = new Map(runs.map((run) => [run.id, true]));
  const execEngine = makeStubExecutionEngine();
  execEngine.type = 'tmux';
  execEngine.discoverGhostSessions = () => runs.map((run) => ({
    name: `palantir-run-${run.id}`,
    isPalantir: true,
  }));
  execEngine.isAlive = (runId) => alive.get(runId);
  execEngine.kill = (runId) => {
    execEngine.killed.push(runId);
    if (runId === runs[0].id) throw new Error('simulated kill failure');
    alive.set(runId, false);
    return true;
  };

  const lc = createLifecycleService({
    runService: rs,
    taskService: ts,
    agentProfileService: aps,
    projectService: ps,
    executionEngine: execEngine,
    streamJsonEngine: makeStubStreamJsonEngine(),
    worktreeService: null,
    eventBus: null,
    actorTokens: {
      humanToken: 'human-secret',
      agentToken: 'agent-secret',
      separated: true,
      boundary: 'separated_tokens',
    },
  });

  const recovered = await lc.recoverOrphanSessions();

  assert.deepEqual(execEngine.killed, runs.map((run) => run.id));
  assert.deepEqual(recovered, [
    { runId: runs[0].id, status: 'credential_revocation_failed' },
    { runId: runs[1].id, status: 'credential_revoked' },
  ]);
  assert.equal(rs.getRun(runs[0].id).status, 'running');
  assert.equal(rs.getRun(runs[1].id).status, 'stopped');
  assert.ok(
    rs.getRunEvents(runs[0].id)
      .some((event) => event.event_type === 'security:credential_revoke_failed'),
  );
});

test('recoverOrphanSessions preserves a completed scoped worker result before revocation', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db);
  const run = rs.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'completed while Console was offline',
  });
  rs.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });
  rs.addRunEvent(run.id, 'security:worker_capability_scoped', JSON.stringify({
    project_id: project.id,
  }));

  const execEngine = makeStubExecutionEngine({ alive: false, exitCode: 0 });
  execEngine.type = 'tmux';
  execEngine.discoverGhostSessions = () => [{
    name: `palantir-run-${run.id}`,
    isPalantir: true,
  }];

  const lc = createLifecycleService({
    runService: rs,
    taskService: ts,
    agentProfileService: aps,
    projectService: ps,
    executionEngine: execEngine,
    streamJsonEngine: makeStubStreamJsonEngine(),
    worktreeService: null,
    eventBus: null,
  });

  const recovered = await lc.recoverOrphanSessions();

  assert.deepEqual(recovered, [{ runId: run.id, status: 'terminated' }]);
  assert.deepEqual(execEngine.killed, [run.id]);
  assert.equal(rs.getRun(run.id).status, 'completed');
  assert.equal(rs.getRun(run.id).exit_code, 0);
  assert.equal(ts.getTask(task.id).status, 'review');
});

// ---------------------------------------------------------------------------
// executeTask — spawn args
// ---------------------------------------------------------------------------

test('executeTask: spawns via executionEngine for non-claude agent', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine();
  const sje = makeStubStreamJsonEngine();

  const lc = createLifecycleService({
    runService: rs,
    taskService: ts,
    agentProfileService: aps,
    projectService: ps,
    executionEngine: execEngine,
    streamJsonEngine: sje,
    worktreeService: null,
    eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });

  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hello' });

  assert.equal(execEngine.spawned.length, 1, 'executionEngine.spawnAgent called once');
  assert.equal(sje.spawned.length, 0, 'streamJsonEngine NOT used for non-claude agent');
  assert.equal(run.status, 'running');
});

test('executeTask: spawns via streamJsonEngine for claude agent', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine();
  const sje = makeStubStreamJsonEngine();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: sje, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'claude' });

  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'task prompt' });

  assert.equal(sje.spawned.length, 1, 'streamJsonEngine.spawnAgent called once');
  assert.equal(execEngine.spawned.length, 0, 'executionEngine NOT used for claude agent');
  assert.equal(sje.spawned[0].opts.isManager, false);
  assert.equal(sje.spawned[0].opts.prompt, 'task prompt');
  assert.equal(run.status, 'running');
});

test('executeTask: passes mcpConfig from project to streamJsonEngine', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine();
  const sje = makeStubStreamJsonEngine();

  // Inject a project service that returns a project with mcp_config_path
  const fakeProject = { id: 'p1', name: 'P', directory: null, mcp_config_path: '/etc/mcp.json' };
  const fakePs = {
    getProject: () => fakeProject,
  };

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: fakePs,
    executionEngine: execEngine, streamJsonEngine: sje, worktreeService: null, eventBus: null,
  });

  // Insert a task row that references the fake project
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','P')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  const profile = seedProfile(db, { command: 'claude' });

  await lc.executeTask('t1', { agentProfileId: profile.id, prompt: 'mcp test' });

  assert.equal(sje.spawned[0].opts.mcpConfig, '/etc/mcp.json', 'mcpConfig passed through');
});

test('executeTask: env_allowlist is filtered from process.env', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine();
  const sje = makeStubStreamJsonEngine();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: sje, worktreeService: null, eventBus: null,
  });

  // Set a sentinel env var and allowlist it
  process.env._PALANTIR_TEST_VAR = 'secret';
  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, {
    command: 'codex',
    env_allowlist: JSON.stringify(['_PALANTIR_TEST_VAR']),
  });

  await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'env test' });

  const spawnedEnv = execEngine.spawned[0].opts.env;
  assert.equal(spawnedEnv._PALANTIR_TEST_VAR, 'secret', 'allowed env var is passed through');

  // Cleanup
  delete process.env._PALANTIR_TEST_VAR;
});

test('executeTask: provider env reaches the child but provider-only secrets stay blocked until profile approval', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const environmentProviders = createEnvironmentProviderService(db);
  const execEngine = makeStubExecutionEngine();
  const sje = makeStubStreamJsonEngine();
  const lc = createLifecycleService({
    runService: rs,
    taskService: ts,
    agentProfileService: aps,
    projectService: ps,
    executionEngine: execEngine,
    streamJsonEngine: sje,
    worktreeService: null,
    eventBus: null,
  });

  const previous = {
    PROVIDER_REGION_CANARY: process.env.PROVIDER_REGION_CANARY,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    CUSTOM_PROVIDER_API_KEY: process.env.CUSTOM_PROVIDER_API_KEY,
  };
  process.env.PROVIDER_REGION_CANARY = 'ap-northeast-test';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret-value';
  process.env.CUSTOM_PROVIDER_API_KEY = 'custom-secret-value';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const provider = environmentProviders.createProvider({
    name: 'operator-declared-provider',
    env_keys: [
      'PROVIDER_REGION_CANARY',
      'AWS_SECRET_ACCESS_KEY',
      'CUSTOM_PROVIDER_API_KEY',
    ],
  });
  const project = seedProject(db);
  const firstTask = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  aps.updateProfile(profile.id, {
    environment_provider_ids: [provider.id],
  });

  await lc.executeTask(firstTask.id, {
    agentProfileId: profile.id,
    prompt: 'provider env test',
  });

  const providerOnlyEnv = execEngine.spawned[0].opts.env;
  assert.equal(providerOnlyEnv.PROVIDER_REGION_CANARY, 'ap-northeast-test');
  assert.equal(
    Object.prototype.hasOwnProperty.call(providerOnlyEnv, 'AWS_SECRET_ACCESS_KEY'),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(providerOnlyEnv, 'CUSTOM_PROVIDER_API_KEY'),
    false,
  );

  aps.updateProfile(profile.id, {
    env_allowlist: JSON.stringify([
      'AWS_SECRET_ACCESS_KEY',
      'CUSTOM_PROVIDER_API_KEY',
    ]),
  });
  const secondTask = seedTask(db, project.id);
  await lc.executeTask(secondTask.id, {
    agentProfileId: profile.id,
    prompt: 'explicit secret approval test',
  });

  const explicitlyApprovedEnv = execEngine.spawned[1].opts.env;
  assert.equal(explicitlyApprovedEnv.PROVIDER_REGION_CANARY, 'ap-northeast-test');
  assert.equal(explicitlyApprovedEnv.AWS_SECRET_ACCESS_KEY, 'aws-secret-value');
  assert.equal(explicitlyApprovedEnv.CUSTOM_PROVIDER_API_KEY, 'custom-secret-value');
});

test('executeTask: worker receives only a run-bound memory proposal capability', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine();
  const minted = [];

  const lc = createLifecycleService({
    runService: rs,
    taskService: ts,
    agentProfileService: aps,
    projectService: ps,
    executionEngine: execEngine,
    streamJsonEngine: null,
    worktreeService: null,
    eventBus: null,
    actorTokens: {
      humanToken: 'human-secret',
      agentToken: 'manager-secret',
      separated: true,
      processIsolated: true,
      capabilitiesEnabled: true,
      boundary: 'separated_tokens',
    },
    workerProposalTokenService: {
      mint: (runId, claims) => {
        minted.push({ runId, claims });
        return `scoped-${runId}`;
      },
    },
    workerProposalBaseUrl: 'http://console.internal:4177',
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'capture reusable lessons',
  });

  const spawned = execEngine.spawned[0].opts;
  assert.equal(spawned.env.PALANTIR_WORKER_TOKEN, `scoped-${run.id}`);
  assert.equal(spawned.env.PALANTIR_API_BASE, 'http://console.internal:4177');
  assert.equal('PALANTIR_TOKEN' in spawned.env, false);
  assert.equal('PALANTIR_PM_TOKEN' in spawned.env, false);
  assert.doesNotMatch(spawned.args.join(' '), /memory\/propose/);
  assert.match(spawned.stdin, new RegExp(`/api/runs/${run.id}/memory/propose`));
  assert.deepEqual(minted, [{
    runId: run.id,
    claims: { projectId: project.id },
  }]);
  const capabilityEvent = rs.getRunEvents(run.id)
    .find((event) => event.event_type === 'security:worker_capability_scoped');
  assert.equal(JSON.parse(capabilityEvent.payload_json).project_id, project.id);

  // The proposal grant is signed by a boot-local key. A restarted Console
  // cannot reissue it into this live process, so recovery must stop rather
  // than reattach the worker with a permanently failing grant.
  let alive = true;
  execEngine.type = 'tmux';
  execEngine.discoverGhostSessions = () => [{
    name: `palantir-run-${run.id}`,
    isPalantir: true,
  }];
  execEngine.isAlive = () => alive;
  execEngine.kill = (runId) => {
    execEngine.killed.push(runId);
    alive = false;
    return true;
  };

  const recovered = await lc.recoverOrphanSessions();
  assert.deepEqual(recovered, [{ runId: run.id, status: 'credential_revoked' }]);
  assert.deepEqual(execEngine.killed, [run.id]);
  assert.equal(rs.getRun(run.id).status, 'stopped');
  const revoked = rs.getRunEvents(run.id)
    .find((event) => event.event_type === 'security:credential_revoked');
  assert.equal(JSON.parse(revoked.payload_json).reason, 'worker_capability_restart');
});

test('executeTask: project-less workers are marked safe for orphan recovery without a proposal token', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine();

  const lc = createLifecycleService({
    runService: rs,
    taskService: ts,
    agentProfileService: aps,
    projectService: ps,
    executionEngine: execEngine,
    streamJsonEngine: null,
    worktreeService: null,
    eventBus: null,
    actorTokens: {
      humanToken: 'human-secret',
      agentToken: 'manager-secret',
      separated: true,
      boundary: 'separated_tokens',
    },
    workerProposalTokenService: {
      mint: () => {
        throw new Error('project-less workers must not receive proposal tokens');
      },
    },
    workerProposalBaseUrl: 'http://console.internal:4177',
  });

  const task = ts.createTask({ title: 'Project-less maintenance task' });
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'perform maintenance',
  });

  const policyEvent = rs.getRunEvents(run.id)
    .find((event) => event.event_type === 'security:worker_credential_policy_applied');
  assert.deepEqual(JSON.parse(policyEvent.payload_json), {
    version: 1,
    policy: 'actor_tokens_scrubbed',
    memory_propose: false,
  });
  assert.equal('PALANTIR_WORKER_TOKEN' in execEngine.spawned[0].opts.env, false);

  execEngine.type = 'tmux';
  execEngine.discoverGhostSessions = () => [{
    name: `palantir-run-${run.id}`,
    isPalantir: true,
  }];
  execEngine.isAlive = () => true;

  const recovered = await lc.recoverOrphanSessions();
  assert.deepEqual(recovered, [{ runId: run.id, status: 'reattached' }]);
  assert.deepEqual(execEngine.killed, []);
  assert.equal(rs.getRun(run.id).status, 'running');
});

test('executeTask: marks task as in_progress', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });

  assert.equal(ts.getTask(task.id).status, 'backlog');
  await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });
  assert.equal(ts.getTask(task.id).status, 'in_progress');
});

test('executeTask: marks run as failed and rethrows when spawnAgent throws', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const failingEngine = makeStubExecutionEngine();
  failingEngine.spawnAgent = () => { throw new Error('no tmux'); };

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: failingEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });

  await assert.rejects(() => lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'boom' }), /no tmux/);

  // The run row should exist and be failed
  const runs = rs.listRuns({ task_id: task.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.equal(
    rs.getRunEvents(runs[0].id)
      .some((event) => event.event_type === 'security:worker_credential_policy_applied'),
    false,
    'a failed spawn must not be marked safe for orphan recovery',
  );
});

// ---------------------------------------------------------------------------
// sendAgentInput (handleRunInput)
// ---------------------------------------------------------------------------

test('sendAgentInput: delivers input to active run via executionEngine', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'start' });

  const sent = await lc.sendAgentInput(run.id, 'user reply');
  assert.equal(sent, true);
  assert.equal(execEngine.inputs[0].text, 'user reply');
});

test('sendAgentInput: throws when run is not in running/needs_input state', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'start' });

  // Move to completed (terminal)
  rs.updateRunStatus(run.id, 'completed', { force: true });

  assert.throws(
    () => lc.sendAgentInput(run.id, 'hello'),
    /Cannot send input to run in status: completed/
  );
});

test('sendAgentInput: prefers streamJsonEngine over executionEngine', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine();
  const sje = makeStubStreamJsonEngine();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: sje, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'claude' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'claude task' });

  await lc.sendAgentInput(run.id, 'stream input');

  assert.equal(sje.inputs.length, 1, 'streamJsonEngine received the input');
  assert.equal(execEngine.inputs.length, 0, 'executionEngine did not receive the input');
});

// ---------------------------------------------------------------------------
// Health check — is_manager guard
// ---------------------------------------------------------------------------

test('checkHealth: skips manager runs (is_manager guard)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine({ alive: false, exitCode: 0 });

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  // Seed a manager run manually (is_manager=1)
  const mgrRun = rs.createRun({ is_manager: true, prompt: 'manage', manager_adapter: 'claude-code' });
  rs.updateRunStatus(mgrRun.id, 'running', { force: true });

  await lc.checkHealth();

  // executionEngine.isAlive should NOT have been called for the manager run
  // (the guard exits early). The run should still be 'running'.
  const after = rs.getRun(mgrRun.id);
  assert.equal(after.status, 'running', 'manager run untouched by health check');
});

test('checkHealth: detects terminated non-manager run and transitions to completed', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine({ alive: false, exitCode: 0 });

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'test' });

  await lc.checkHealth();

  const after = rs.getRun(run.id);
  assert.equal(after.status, 'completed');
});

test('checkHealth: nonzero exit code transitions a dead run to failed', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine({ alive: false, exitCode: 9 });

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'test' });

  await lc.checkHealth();

  const after = rs.getRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.exit_code, 9);
  assert.equal(after.result_summary, 'Agent exited with code 9');
});

test('checkHealth: dead run with unknown exit code fails closed with an explicit reason', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine({ alive: false, exitCode: null });
  const statusEvents = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'run:status') statusEvents.push(event.data);
  });

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'test' });
  statusEvents.length = 0;

  await lc.checkHealth();

  const after = rs.getRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.exit_code, null);
  assert.equal(after.result_summary, null);
  assert.ok(statusEvents.some((event) => (
    event.run.id === run.id
    && event.to_status === 'failed'
    && event.reason === 'agent-exit-unknown'
  )));
});

test('checkHealth: unknown exit preserves previously persisted result and usage', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine({ alive: false, exitCode: null });
  const statusEvents = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'run:status') statusEvents.push(event.data);
  });

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'test' });
  rs.updateRunResult(run.id, {
    result_summary: 'Persisted stream-json result',
    exit_code: 0,
    input_tokens: 123,
    output_tokens: 456,
    cost_usd: 0.789,
  });
  statusEvents.length = 0;

  await lc.checkHealth();

  const after = rs.getRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.result_summary, 'Persisted stream-json result');
  assert.equal(after.exit_code, 0);
  assert.equal(after.input_tokens, 123);
  assert.equal(after.output_tokens, 456);
  assert.equal(after.cost_usd, 0.789);
  assert.ok(statusEvents.some((event) => (
    event.run.id === run.id
    && event.to_status === 'failed'
    && event.reason === 'agent-exit-unknown'
  )));
});

test('checkHealth: alive run with unknown exit code remains running', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine({ alive: true, exitCode: null, output: 'working' });

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'test' });

  await lc.checkHealth();

  const after = rs.getRun(run.id);
  assert.equal(after.status, 'running');
  assert.equal(after.ended_at, null);
  assert.equal(execEngine.killed.includes(run.id), false);
});

test('checkHealth: transitions stale running run to needs_input on idle timeout (simulated)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  // Agent is alive (no exit), same output each poll → idle
  const execEngine = makeStubExecutionEngine({ alive: true, exitCode: null, output: 'same output' });

  const eventBus = createEventBus();
  const needsInputEvents = [];
  eventBus.subscribe((ev) => {
    if (ev.channel === 'run:needs_input') needsInputEvents.push(ev.data);
  });

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });

  // Establish the output hash first; that poll records a fresh heartbeat.
  await lc.checkHealth();
  // Use SQLite's stored format beyond the 30-minute default so the regression
  // covers the same zone-less UTC timestamps produced in production — an ISO
  // string here would not exercise the parse this test exists for. Backdate
  // after the baseline poll so its heartbeat cannot mask the simulated idle.
  db.prepare(`UPDATE runs SET started_at = datetime('now', '-31 minutes') WHERE id = ?`).run(run.id);
  db.prepare(`UPDATE run_events SET created_at = datetime('now', '-31 minutes') WHERE run_id = ?`).run(run.id);

  // The same output now reaches the idle check against the backdated heartbeat.
  await lc.checkHealth();

  const after = rs.getRun(run.id);
  assert.equal(after.status, 'needs_input', 'idle run transitions to needs_input');
  assert.equal(needsInputEvents.length, 1, 'run:needs_input event emitted');
  assert.equal(needsInputEvents[0].priority, 'alert');
  assert.equal(needsInputEvents[0].reason, 'idle_timeout');
});

// The direction that matches the original bug report: a run that is NOT idle
// must survive the idle check. Under the local-time misparse its zone-less
// stamps read as hours old the moment they are written, so a run whose output
// simply has not changed between two polls gets flagged straight away. Both
// offsets are exercised because only the eastern one produces that inflation —
// on a UTC host the broken and fixed parses are the same instant.
for (const tz of ['Asia/Seoul', 'America/Los_Angeles']) {
  test(`[TZ=${tz}] checkHealth: a fresh run with unchanged output is not idle-timed-out`, async (t) => {
    const db = await mkdb(t);
    const rs = createRunService(db, null);
    const ts = createTaskService(db);
    const ps = createProjectService(db);
    const aps = createAgentProfileService(db);
    const execEngine = makeStubExecutionEngine({ alive: true, exitCode: null, output: 'same output' });

    const lc = createLifecycleService({
      runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
      executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
    });

    const project = seedProject(db);
    const task = seedTask(db, project.id);
    const profile = seedProfile(db, { command: 'codex' });
    const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });

    const previousTz = process.env.TZ;
    process.env.TZ = tz;
    try {
      // First poll records the heartbeat; the second reaches the idle comparison
      // with identical output. No backdating — every stamp is genuinely fresh.
      await lc.checkHealth();
      await lc.checkHealth();
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }

    assert.equal(
      rs.getRun(run.id).status,
      'running',
      'a run that has been alive for seconds must not be treated as 30 minutes idle',
    );
  });
}
test('checkHealth: profile idle_timeout_ms overrides the default while NULL opts out', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine({
    alive: true,
    exitCode: null,
    output: 'same output',
  });
  const clockNow = Math.floor(Date.now() / 1000) * 1000;
  const sqliteUtc = (milliseconds) => (
    new Date(milliseconds).toISOString().slice(0, 19).replace('T', ' ')
  );
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
    now: () => clockNow,
  });
  const project = seedProject(db);

  const configuredTask = seedTask(db, project.id);
  const configuredProfile = seedProfile(db, {
    command: 'codex',
    idle_timeout_ms: 60 * 1000,
  });
  const configuredRun = await lc.executeTask(configuredTask.id, {
    agentProfileId: configuredProfile.id,
    prompt: 'configured',
  });
  await lc.checkHealth();

  const twoMinutesAgo = sqliteUtc(clockNow - 2 * 60 * 1000);
  db.prepare('UPDATE run_events SET created_at = ? WHERE run_id = ?')
    .run(twoMinutesAgo, configuredRun.id);
  await lc.checkHealth();
  assert.equal(rs.getRun(configuredRun.id).status, 'needs_input');

  const defaultTask = seedTask(db, project.id);
  const defaultProfile = seedProfile(db, { command: 'codex', idle_timeout_ms: null });
  const defaultRun = await lc.executeTask(defaultTask.id, {
    agentProfileId: defaultProfile.id,
    prompt: 'default',
  });
  await lc.checkHealth();
  const exactlyThirtyMinutesAgo = sqliteUtc(clockNow - 30 * 60 * 1000);
  db.prepare('UPDATE run_events SET created_at = ? WHERE run_id = ?')
    .run(exactlyThirtyMinutesAgo, defaultRun.id);
  await lc.checkHealth();
  assert.equal(
    rs.getRun(defaultRun.id).status,
    'running',
    'NULL preserves the strict greater-than comparison at the 30-minute default',
  );
  const justOverThirtyMinutesAgo = sqliteUtc(clockNow - 30 * 60 * 1000 - 1000);
  db.prepare('UPDATE run_events SET created_at = ? WHERE run_id = ?')
    .run(justOverThirtyMinutesAgo, defaultRun.id);
  await lc.checkHealth();
  assert.equal(
    rs.getRun(defaultRun.id).status,
    'needs_input',
    'NULL preserves the existing 30-minute threshold',
  );
});

test('checkHealth: a run finalized after idle timeout keeps completed compatibility and terminal provenance', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine({
    alive: true,
    exitCode: null,
    output: 'same output',
  });
  const endedEvents = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'run:ended') endedEvents.push(event.data);
  });
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus,
  });
  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, {
    command: 'codex',
    idle_timeout_ms: 60 * 1000,
  });
  const run = await lc.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'timeout',
  });
  await lc.checkHealth();
  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  db.prepare('UPDATE run_events SET created_at = ? WHERE run_id = ?')
    .run(twoMinutesAgo, run.id);
  await lc.checkHealth();
  assert.equal(rs.getRun(run.id).status, 'needs_input');

  execEngine.setAlive(false);
  execEngine.setExitCode(0);
  await lc.checkHealth();

  const finalized = rs.getRun(run.id);
  assert.equal(finalized.status, 'completed');
  assert.equal(finalized.terminal_reason, 'idle_timeout');
  assert.ok(endedEvents.some(event => (
    event.run.id === run.id
    && event.to_status === 'completed'
    && event.run.terminal_reason === 'idle_timeout'
  )));

  const normalTask = seedTask(db, project.id);
  const normalRun = await lc.executeTask(normalTask.id, {
    agentProfileId: profile.id,
    prompt: 'normal',
  });
  await lc.checkHealth();
  assert.equal(rs.getRun(normalRun.id).status, 'completed');
  assert.equal(rs.getRun(normalRun.id).terminal_reason, null);
});

test('cancelling an idle-parked run keeps the idle provenance', async (t) => {
  // Codex review: without this the operator's cancellation erases WHY the run
  // was parked, and the history shows a bare `cancelled` — the same loss of
  // provenance #466 is about.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine({
    alive: true,
    exitCode: null,
    output: 'same output',
  });
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });
  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex', idle_timeout_ms: 60 * 1000 });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'timeout' });

  await lc.checkHealth();
  db.prepare('UPDATE run_events SET created_at = ? WHERE run_id = ?')
    .run(new Date(Date.now() - 2 * 60 * 1000).toISOString(), run.id);
  await lc.checkHealth();
  assert.equal(rs.getRun(run.id).status, 'needs_input');

  await lc.cancelRun(run.id);

  const cancelled = rs.getRun(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.terminal_reason, 'idle_timeout');
});

// Codex round-2 review: the first fix read the caller's run snapshot, so a
// status change during the awaited kill() either stamped a stale idle_timeout
// or dropped a fresh one. Both directions are pinned here with a kill() the
// test controls, which is the only way to open that window deterministically.
for (const [initial, during, expected] of [
  ['needs_input', 'running', null],
  ['running', 'needs_input', 'idle_timeout'],
]) {
  test(`cancel resolves idle provenance at write time (${initial} → ${during})`, async (t) => {
    const db = await mkdb(t);
    const rs = createRunService(db, null);
    const ts = createTaskService(db);
    const ps = createProjectService(db);
    const aps = createAgentProfileService(db);
    const project = seedProject(db);
    const task = seedTask(db, project.id);
    const profile = seedProfile(db, { command: 'codex' });
    const run = rs.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'work' });
    rs.markRunStarted(run.id, {});
    rs.updateRunStatus(run.id, initial, {
      force: true,
      reason: initial === 'needs_input' ? 'idle_timeout' : 'started',
    });

    let releaseKill;
    const execEngine = makeStubExecutionEngine({ alive: true, exitCode: null });
    execEngine.kill = () => new Promise((resolve) => { releaseKill = resolve; });

    const lc = createLifecycleService({
      runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
      executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
    });

    const pending = lc.cancelRun(run.id);
    // The window: health re-parks or resumes the run while kill() is in flight.
    rs.updateRunStatus(run.id, during, {
      force: true,
      reason: during === 'needs_input' ? 'idle_timeout' : 'user_input',
    });
    releaseKill(true);
    await pending;

    const cancelled = rs.getRun(run.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(
      cancelled.terminal_reason,
      expected,
      'terminal_reason must reflect the status at write time, not at cancel entry',
    );
  });
}

test('cancelling a run that was never idle records no terminal reason', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine({ alive: true, exitCode: null, output: 'out' });
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });
  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'work' });

  await lc.cancelRun(run.id);

  const cancelled = rs.getRun(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.terminal_reason, null, 'a plain cancellation must not fabricate a reason');
});

// ---------------------------------------------------------------------------
// INS-02: needs_input → sendAgentInput → running recovery
// ---------------------------------------------------------------------------

test('INS-02: sendAgentInput recovers needs_input run back to running', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine();

  const statusEvents = [];
  eventBus.subscribe((ev) => {
    if (ev.channel === 'run:status') statusEvents.push(ev.data);
  });

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'work' });

  await lc.checkHealth();
  // Keep this in SQLite's zone-less UTC format so idle recovery exercises the
  // production parse path rather than an already-zoned ISO test value. Apply
  // it after the baseline poll, which creates a heartbeat event.
  db.prepare(`UPDATE runs SET started_at = datetime('now', '-31 minutes') WHERE id = ?`).run(run.id);
  db.prepare(`UPDATE run_events SET created_at = datetime('now', '-31 minutes') WHERE run_id = ?`).run(run.id);
  await lc.checkHealth();

  const afterIdle = rs.getRun(run.id);
  assert.equal(afterIdle.status, 'needs_input', 'run is needs_input after idle timeout');

  // INS-02 core: send input while needs_input → should recover to running
  statusEvents.length = 0; // clear prior status events
  const sent = await lc.sendAgentInput(run.id, 'user response');
  assert.equal(sent, true, 'sendAgentInput succeeds on needs_input run');

  const afterInput = rs.getRun(run.id);
  assert.equal(afterInput.status, 'running', 'run recovers to running after sendAgentInput');

  // Verify run:status event was emitted for the recovery transition (UI depends on this)
  const recoveryEvt = statusEvents.find(e => e.to_status === 'running' && e.from_status === 'needs_input');
  assert.ok(recoveryEvt, 'run:status event emitted for needs_input → running recovery');

  // Verify user_input event was recorded
  const events = rs.getRunEvents(run.id);
  const userInputEvts = events.filter(e => e.event_type === 'user_input');
  assert.ok(userInputEvts.length >= 1, 'user_input event recorded');
});

test('INS-02: sendAgentInput on needs_input — streamJsonEngine first, executionEngine fallback', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  // streamJsonEngine returns false (run not owned) → falls through to executionEngine
  const fakeStreamJsonEngine = {
    sendInput() { return false; },
  };
  const execEngine = makeStubExecutionEngine();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: fakeStreamJsonEngine, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'start' });

  // Force needs_input
  rs.updateRunStatus(run.id, 'needs_input', { force: true });

  const sent = await lc.sendAgentInput(run.id, 'fallback input');
  assert.equal(sent, true, 'executionEngine fallback succeeds');
  assert.equal(execEngine.inputs.length, 1, 'executionEngine.sendInput was called');
  assert.equal(execEngine.inputs[0].text, 'fallback input');

  const afterInput = rs.getRun(run.id);
  assert.equal(afterInput.status, 'running', 'needs_input → running recovery via executionEngine fallback');
});

// ---------------------------------------------------------------------------
// Status transition: completed → task review
// ---------------------------------------------------------------------------

test('checkHealth: transitions task to review when all runs complete with success', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const execEngine = makeStubExecutionEngine({ alive: false, exitCode: 0 });

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'single run' });

  await lc.checkHealth();

  const updatedTask = ts.getTask(task.id);
  assert.equal(updatedTask.status, 'review', 'task promoted to review after successful run');
});

// ---------------------------------------------------------------------------
// cancelRun
// ---------------------------------------------------------------------------

test('cancelRun: transitions running run to cancelled', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });

  const cancelled = await lc.cancelRun(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(execEngine.killed.includes(run.id), 'executionEngine.kill was called');
});

test('cancelRun: is a no-op for already terminal runs', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const execEngine = makeStubExecutionEngine();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: execEngine, streamJsonEngine: null, worktreeService: null, eventBus: null,
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, { command: 'codex' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });
  rs.updateRunStatus(run.id, 'completed', { force: true });

  const result = await lc.cancelRun(run.id);
  assert.equal(result.status, 'completed', 'already-terminal run is returned unchanged');
});
