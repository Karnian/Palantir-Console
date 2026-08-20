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

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-attempt-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const project = projectService.createProject({ name: 'Attempt identity', directory: dir });
  const profile = agentProfileService.createProfile({
    name: 'Attempt agent', type: 'codex', command: 'codex',
  });
  const task = taskService.createTask({
    project_id: project.id, title: 'Attempt task', status: 'in_progress',
  });
  const inertEngine = {
    spawnAgent() { throw new Error('not used'); },
    isAlive() { return false; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    kill() { return true; },
  };
  const lifecycle = createLifecycleService({
    runService,
    taskService,
    projectService,
    agentProfileService,
    executionEngine: inertEngine,
    streamJsonEngine: inertEngine,
    worktreeService: null,
    eventBus: null,
  });

  function addRun(status, { goal = false } = {}) {
    const run = runService.createRun({
      task_id: task.id,
      agent_profile_id: profile.id,
      prompt: status,
    });
    db.prepare('UPDATE runs SET status = ?, goal_active = ? WHERE id = ?')
      .run(status, goal ? 1 : 0, run.id);
    return runService.getRun(run.id);
  }

  return { db, runService, taskService, task, lifecycle, addRun };
}

const cases = [
  { name: 'completed then failed uses the failed current attempt', statuses: ['completed', 'failed'], expected: 'failed' },
  { name: 'failed then completed remains review', statuses: ['failed', 'completed'], expected: 'review' },
  { name: 'cancelled after completed does not replace the completed attempt', statuses: ['completed', 'cancelled'], expected: 'review' },
  { name: 'cancelled after failed does not replace the failed attempt', statuses: ['failed', 'cancelled'], expected: 'failed' },
  { name: 'only cancelled and stopped runs returns the task to todo', statuses: ['cancelled', 'stopped'], expected: 'todo' },
];

for (const { name, statuses, expected } of cases) {
  test(name, async (t) => {
    const h = await harness(t);
    statuses.forEach(status => h.addRun(status));
    h.lifecycle.checkTaskCompletion(h.task.id);
    assert.equal(h.taskService.getTask(h.task.id).status, expected);
  });
}

test('newest attempt uses rowid when attempts share the same created_at second', async (t) => {
  const h = await harness(t);
  const first = h.addRun('completed');
  const second = h.addRun('failed');
  h.db.prepare('UPDATE runs SET created_at = ? WHERE id IN (?, ?)')
    .run('2026-08-20 12:34:56', first.id, second.id);

  const newest = h.runService.getNewestAttemptRun(h.task.id);
  assert.equal(newest.id, second.id);
  assert.equal(newest.status, 'failed');
});

test('an unfinished run preserves the allComplete transition gate', async (t) => {
  const h = await harness(t);
  h.addRun('completed');
  h.addRun('running');
  h.lifecycle.checkTaskCompletion(h.task.id);
  assert.equal(h.taskService.getTask(h.task.id).status, 'in_progress');
});

test('goal task still delegates status to the goal verdict authority', async (t) => {
  const h = await harness(t);
  const run = h.addRun('failed', { goal: true });
  h.db.prepare("UPDATE runs SET goal_verdict = 'gate2' WHERE id = ?").run(run.id);

  h.lifecycle.checkTaskCompletion(h.task.id);
  assert.equal(h.taskService.getTask(h.task.id).status, 'review');
});

test('three attempts: the newest one decides, not the best one', async (t) => {
  // The two-run cases could pass by "look at the last row"; this pins that the
  // rule is the newest ATTEMPT rather than any aggregation over a longer history.
  const h = await harness(t);
  h.addRun('failed');
  h.addRun('completed');
  h.addRun('failed');
  h.lifecycle.checkTaskCompletion(h.task.id);
  assert.equal(h.taskService.getTask(h.task.id).status, 'failed');
});

test('a manager run linked to a task is not an attempt', async (t) => {
  // Production never creates one: neither routes/manager.js nor
  // operatorSpawnService passes task_id when spawning a manager. Pinned anyway,
  // because the previous aggregation would have counted such a row and the
  // exclusion is deliberate -- a manager session is not a dispatch attempt.
  const h = await harness(t);
  const worker = h.addRun('failed');
  const manager = h.addRun('completed');
  h.db.prepare('UPDATE runs SET is_manager = 1 WHERE id = ?').run(manager.id);

  assert.equal(h.runService.getNewestAttemptRun(h.task.id).id, worker.id);
  h.lifecycle.checkTaskCompletion(h.task.id);
  assert.equal(h.taskService.getTask(h.task.id).status, 'failed');
});
