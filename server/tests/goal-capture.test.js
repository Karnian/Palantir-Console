// G1 — integration tests for goal capture (spec §5b/§5c/§5k-2):
//   1. spawnQueuedRun compiles the goal prompt for goal-enabled tasks.
//   2. On run terminal, captureGoalOutput persists runs.final_output +
//      runs.goal_report and emits harvest:goal_capture — goal runs only.
//   3. Non-goal runs are completely unaffected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createEventBus } = require('../services/eventBus');

function tick() { return new Promise((r) => setImmediate(() => setImmediate(r))); }

function stubExecEngine(outputByRun) {
  const spawned = [];
  return {
    spawned,
    type: 'cli',
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: `s-${runId}` }; },
    isAlive() { return false; },
    detectExitCode() { return 0; },
    getOutput(runId) { return outputByRun.get(runId) ?? ''; },
    sendInput() { return true; },
    kill() {},
    discoverGhostSessions() { return []; },
    listSessions() { return []; },
    hasProcess() { return false; },
  };
}
function stubSJE() {
  return {
    spawnAgent() { return { sessionName: null }; },
    isAlive() { return false; }, detectExitCode() { return 0; }, getOutput() { return ''; },
    sendInput() { return true; }, kill() {}, discoverGhostSessions() { return []; }, hasProcess() { return false; },
  };
}

async function harness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-g1-cap-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const outputByRun = new Map();
  const exec = stubExecEngine(outputByRun);
  const harvested = [];
  const harvestService = { harvestRun(run) { harvested.push(run.id); return Promise.resolve(); } };
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: exec, streamJsonEngine: stubSJE(), worktreeService: null,
    eventBus, harvestService,
  });
  lc.startMonitoring();
  t.after(async () => { lc.stopMonitoring(); close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, ts, ps, aps, exec, lc, outputByRun, harvested };
}

function seedProfile(db) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
     VALUES (?, 'A', 'codex', 'codex', '{prompt}', '{}', '[]', 5)`
  ).run(id);
  return { id };
}

const REPORT = '```palantir-goal-report\n{"goal_status":"done","summary":"built it","blockers":[]}\n```';

test('spawnQueuedRun compiles the goal prompt for a goal-enabled task', async (t) => {
  const { db, rs, ts, ps, aps, exec, lc } = await harness(t);
  const project = ps.createProject({ name: 'P', directory: null });
  const task = ts.createTask({ project_id: project.id, title: 'Do the thing', description: 'details', acceptance_criteria: '- works' });
  db.prepare('UPDATE tasks SET goal_enabled = 1, goal_max_attempts = 4 WHERE id = ?').run(task.id);
  const profile = seedProfile(db);
  await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'caller says hi' });
  const args = exec.spawned[0].opts.args.join('\n');
  assert.match(args, /\[GOAL\]/);
  assert.match(args, /Do the thing/);
  assert.match(args, /\[ACCEPTANCE CRITERIA/);
  assert.match(args, /\[ATTEMPT 1\/4\]/, 'uses task.goal_max_attempts');
  assert.match(args, /caller says hi/, 'caller prompt preserved');
  assert.match(args, /palantir-goal-report/, 'requests completion report');
});

test('captureGoalOutput persists final_output + goal_report on terminal (goal run)', async (t) => {
  const { db, rs, ts, ps, outputByRun, harvested } = await harness(t);
  const project = ps.createProject({ name: 'P', directory: null });
  const task = ts.createTask({ project_id: project.id, title: 'T', description: 'd', acceptance_criteria: '- ok' });
  db.prepare('UPDATE tasks SET goal_enabled = 1 WHERE id = ?').run(task.id);
  const profile = seedProfile(db);
  const run = rs.createRun({ is_manager: false, task_id: task.id, agent_profile_id: profile.id, node_id: 'local', prompt: 'x' });
  outputByRun.set(run.id, `some worker chatter\n${REPORT}\n`);
  rs.updateRunStatus(run.id, 'completed', { force: true });
  await tick();
  const after = rs.getRun(run.id);
  assert.ok(after.final_output && after.final_output.includes('palantir-goal-report'), 'final_output captured');
  assert.ok(after.goal_report, 'goal_report parsed + stored');
  assert.equal(JSON.parse(after.goal_report).goal_status, 'done');
  const events = rs.getRunEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes('harvest:goal_capture'), 'capture event emitted');
  assert.ok(harvested.includes(run.id), 'harvest still ran after capture');
});

test('captureGoalOutput does NOT touch a non-goal run', async (t) => {
  const { db, rs, ts, ps, outputByRun } = await harness(t);
  const project = ps.createProject({ name: 'P', directory: null });
  const task = ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  // goal_enabled stays 0 (default)
  const profile = seedProfile(db);
  const run = rs.createRun({ is_manager: false, task_id: task.id, agent_profile_id: profile.id, node_id: 'local', prompt: 'x' });
  outputByRun.set(run.id, REPORT);
  rs.updateRunStatus(run.id, 'completed', { force: true });
  await tick();
  const after = rs.getRun(run.id);
  assert.equal(after.final_output, null, 'non-goal run final_output untouched');
  assert.equal(after.goal_report, null, 'non-goal run goal_report untouched');
  const events = rs.getRunEvents(run.id).map((e) => e.event_type);
  assert.ok(!events.includes('harvest:goal_capture'), 'no capture event for non-goal run');
});

test('captureGoalOutput persists final_output even when no report present (null report)', async (t) => {
  const { db, rs, ts, ps, outputByRun } = await harness(t);
  const project = ps.createProject({ name: 'P', directory: null });
  const task = ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  db.prepare('UPDATE tasks SET goal_enabled = 1 WHERE id = ?').run(task.id);
  const profile = seedProfile(db);
  const run = rs.createRun({ is_manager: false, task_id: task.id, agent_profile_id: profile.id, node_id: 'local', prompt: 'x' });
  outputByRun.set(run.id, 'worker output without any report fence');
  rs.updateRunStatus(run.id, 'completed', { force: true });
  await tick();
  const after = rs.getRun(run.id);
  assert.match(after.final_output, /without any report/);
  assert.equal(after.goal_report, null, 'no fence → null goal_report (annotate-only)');
});

test('captureGoalOutput prefers the file-backed tee log over channel.getOutput (§5k-2)', async (t) => {
  const { db, rs, ts, ps, outputByRun } = await harness(t);
  const project = ps.createProject({ name: 'P', directory: null });
  const task = ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  db.prepare('UPDATE tasks SET goal_enabled = 1 WHERE id = ?').run(task.id);
  const profile = seedProfile(db);
  const run = rs.createRun({ is_manager: false, task_id: task.id, agent_profile_id: profile.id, node_id: 'local', prompt: 'x' });
  // getOutput would return a STALE/empty tail; the durable tee log has the real report.
  outputByRun.set(run.id, 'stale buffer with no report');
  const logPath = path.resolve(process.cwd(), 'runtime', 'goal-output', `${run.id}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `durable tee output\n${REPORT}\n`);
  t.after(() => { try { fs.unlinkSync(logPath); } catch { /* cleaned by lifecycle already */ } });
  rs.updateRunStatus(run.id, 'completed', { force: true });
  await tick();
  const after = rs.getRun(run.id);
  assert.match(after.final_output, /durable tee output/, 'read from the file, not the stale buffer');
  assert.ok(after.goal_report, 'report parsed from the tee log');
  assert.equal(JSON.parse(after.goal_report).goal_status, 'done');
});

test('migration 054: goal columns exist', async (t) => {
  const { db } = await harness(t);
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  const runCols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
  assert.ok(taskCols.includes('goal_enabled') && taskCols.includes('goal_max_attempts'));
  assert.ok(runCols.includes('goal_report') && runCols.includes('final_output'));
});
