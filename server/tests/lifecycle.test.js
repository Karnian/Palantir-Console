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
  return {
    type: 'subprocess',
    spawned,
    killed,
    inputs,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `session-${runId}` };
    },
    isAlive(runId) { return alive; },
    detectExitCode(runId) { return exitCode; },
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

function seedProfile(db, { command = 'codex', capabilities_json = '{}', env_allowlist = '[]' } = {}) {
  // Insert directly so we can use any command string without the allowlist guard.
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO agent_profiles (id, name, type, command, capabilities_json, env_allowlist, max_concurrent)
     VALUES (?, ?, ?, ?, ?, ?, 5)`
  ).run(id, 'TestAgent', 'codex', command, capabilities_json, env_allowlist);
  return { id, name: 'TestAgent', type: 'codex', command, capabilities_json, env_allowlist, max_concurrent: 5 };
}

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

  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hello' });

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

  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'task prompt' });

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

  lc.executeTask('t1', { agentProfileId: profile.id, prompt: 'mcp test' });

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

  lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'env test' });

  const spawnedEnv = execEngine.spawned[0].opts.env;
  assert.equal(spawnedEnv._PALANTIR_TEST_VAR, 'secret', 'allowed env var is passed through');

  // Cleanup
  delete process.env._PALANTIR_TEST_VAR;
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
  lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });
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

  assert.throws(() => lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'boom' }), /no tmux/);

  // The run row should exist and be failed
  const runs = rs.listRuns({ task_id: task.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'start' });

  const sent = lc.sendAgentInput(run.id, 'user reply');
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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'start' });

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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'claude task' });

  lc.sendAgentInput(run.id, 'stream input');

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

  lc.checkHealth();

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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'test' });

  lc.checkHealth();

  const after = rs.getRun(run.id);
  assert.equal(after.status, 'completed');
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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });

  // Backdate the run's started_at so the idle timeout fires (10 min)
  const pastTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  db.prepare(`UPDATE runs SET started_at = ? WHERE id = ?`).run(pastTime, run.id);
  // Also backdate any events so lastActivity is also old
  db.prepare(`UPDATE run_events SET created_at = ? WHERE run_id = ?`).run(pastTime, run.id);

  // First health check: records outputHash baseline (prevHash undefined → sets hash, no idle check yet)
  // Second health check: same hash as prev → checks idle timeout → triggers
  lc.checkHealth();
  lc.checkHealth();

  const after = rs.getRun(run.id);
  assert.equal(after.status, 'needs_input', 'idle run transitions to needs_input');
  assert.equal(needsInputEvents.length, 1, 'run:needs_input event emitted');
  assert.equal(needsInputEvents[0].priority, 'alert');
  assert.equal(needsInputEvents[0].reason, 'idle_timeout');
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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'work' });

  // Simulate idle timeout: backdate + double checkHealth → needs_input
  const pastTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  db.prepare(`UPDATE runs SET started_at = ? WHERE id = ?`).run(pastTime, run.id);
  db.prepare(`UPDATE run_events SET created_at = ? WHERE run_id = ?`).run(pastTime, run.id);
  lc.checkHealth();
  lc.checkHealth();

  const afterIdle = rs.getRun(run.id);
  assert.equal(afterIdle.status, 'needs_input', 'run is needs_input after idle timeout');

  // INS-02 core: send input while needs_input → should recover to running
  statusEvents.length = 0; // clear prior status events
  const sent = lc.sendAgentInput(run.id, 'user response');
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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'start' });

  // Force needs_input
  rs.updateRunStatus(run.id, 'needs_input', { force: true });

  const sent = lc.sendAgentInput(run.id, 'fallback input');
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
  lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'single run' });

  lc.checkHealth();

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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });

  const cancelled = lc.cancelRun(run.id);
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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });
  rs.updateRunStatus(run.id, 'completed', { force: true });

  const result = lc.cancelRun(run.id);
  assert.equal(result.status, 'completed', 'already-terminal run is returned unchanged');
});
