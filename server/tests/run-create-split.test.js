const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createQuestionService } = require('../services/questionService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');

function setup(t, { injectQuestions = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-run-split-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const events = [];
  const eventBus = { emit: (channel, data) => events.push({ channel, data }) };
  const questionService = createQuestionService(handle.db, eventBus);
  const runService = createRunService(
    handle.db,
    eventBus,
    injectQuestions ? questionService : null,
  );
  return { db: handle.db, events, questionService, runService };
}

const managerArgs = overrides => ({
  is_manager: true,
  prompt: 'do the work',
  queued_args: { mode: 'safe' },
  retry_count: 2,
  ...overrides,
});

function createPendingQuestion(questionService, runId) {
  return questionService.createQuestion({
    runId,
    idempotencyKey: `idem-${runId}`,
    class: 'clarification',
    question: 'Continue?',
    options: ['yes', 'no'],
  });
}

test('buildRunRow is pure apart from allocating a fresh id', t => {
  const { db, runService } = setup(t);
  const before = db.prepare('SELECT count(*) AS n FROM runs').get().n;
  const first = runService.buildRunRow(managerArgs());
  const second = runService.buildRunRow(managerArgs());
  assert.notEqual(first.id, second.id);
  assert.deepEqual({ ...first, id: null }, { ...second, id: null });
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, before);
});

test('createRun returns and emits the persisted row', t => {
  const { db, events, runService } = setup(t);
  const run = runService.createRun(managerArgs());
  const persisted = db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id);
  assert.deepEqual(run, runService.readRunRow(run.id));
  assert.equal(run.created_at, persisted.created_at);
  assert.equal(events.length, 1);
  assert.strictEqual(events[0].data.run, run);
  assert.deepEqual(events[0].data, {
    run,
    from_status: null,
    to_status: 'queued',
    reason: 'created',
    task_id: null,
    project_id: null,
    node_id: null,
  });
});

test('split create primitives can roll back without emitting', t => {
  const { db, events, runService } = setup(t);
  const marker = new Error('rollback');
  assert.throws(() => db.transaction(() => {
    const row = runService.buildRunRow(managerArgs());
    runService.insertRunRow(row);
    assert.equal(runService.readRunRow(row.id).id, row.id);
    throw marker;
  })(), error => error === marker);
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, 0);
  assert.equal(events.length, 0);
});

test('source_question_id persists and defaults to null', t => {
  const { runService } = setup(t);
  assert.equal(runService.createRun(managerArgs({ source_question_id: 'wq_source' })).source_question_id, 'wq_source');
  assert.equal(runService.createRun(managerArgs()).source_question_id, null);
});

test('terminal transition cancels pending questions', t => {
  const { questionService, runService } = setup(t, { injectQuestions: true });
  const run = runService.createRun(managerArgs());
  runService.updateRunStatus(run.id, 'running', { force: true });
  const question = createPendingQuestion(questionService, run.id);
  runService.updateRunStatus(run.id, 'failed', { force: true, terminalReason: 'worker_failed' });
  assert.equal(questionService.getQuestion(question.id).status, 'cancelled');
});

test('question_unanswered terminal reason preserves pending questions', t => {
  const { questionService, runService } = setup(t, { injectQuestions: true });
  const run = runService.createRun(managerArgs());
  runService.updateRunStatus(run.id, 'running', { force: true });
  const question = createPendingQuestion(questionService, run.id);
  runService.updateRunStatus(run.id, 'failed', { force: true, terminalReason: 'question_unanswered' });
  assert.equal(questionService.getQuestion(question.id).status, 'pending');
});

test('terminal transition works without questionService injection', t => {
  const { runService } = setup(t);
  const run = runService.createRun(managerArgs());
  runService.updateRunStatus(run.id, 'running', { force: true });
  assert.equal(runService.updateRunStatus(run.id, 'completed', { force: true }).status, 'completed');
});

test('goal verdict retry child uses the canonical run row builder', t => {
  const { db, runService } = setup(t);
  const project = createProjectService(db).createProject({ name: 'retry project', directory: '/tmp/retry-project' });
  const profile = createAgentProfileService(db).createProfile({ name: 'retry agent', type: 'claude-code', command: 'claude' });
  const task = createTaskService(db).createTask({ project_id: project.id, title: 'retry task', description: 'retry me' });
  const parent = runService.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'first attempt' });

  const result = runService.persistGoalVerdictTx({
    runId: parent.id,
    verdict: 'retry',
    effectTypes: [],
    retryChild: {
      task_id: task.id,
      agent_profile_id: profile.id,
      prompt: 'retry attempt',
      parent_run_id: parent.id,
      queued_args: { reason: 'goal_retry' },
      retry_count: 1,
      node_id: 'local',
      retry_root_run_id: parent.id,
      source_question_id: 'wq_retry_source',
    },
  });

  assert.equal(result.winner, true);
  const child = runService.getRun(result.childId);
  assert.equal(child.conversation_id, `worker:${result.childId}`);
  assert.equal(child.source_question_id, 'wq_retry_source');
  assert.equal(Number(child.goal_active), 1);
  assert.equal(runService.getRun(parent.id).goal_retry_run_id, result.childId);
});

test('terminal update inside an external transaction rolls back run and question together', t => {
  const { db, questionService, runService } = setup(t, { injectQuestions: true });
  const run = runService.createRun(managerArgs());
  runService.updateRunStatus(run.id, 'running', { force: true });
  const question = createPendingQuestion(questionService, run.id);
  const marker = new Error('outer rollback');

  assert.throws(() => db.transaction(() => {
    runService.updateRunStatus(run.id, 'failed', { force: true, terminalReason: 'worker_failed' });
    assert.equal(runService.getRun(run.id).status, 'failed');
    assert.equal(questionService.getQuestion(question.id).status, 'cancelled');
    throw marker;
  })(), error => error === marker);

  assert.equal(runService.getRun(run.id).status, 'running');
  assert.equal(questionService.getQuestion(question.id).status, 'pending');
});

test('a terminal transition inside an external transaction emits immediately (legacy contract)', t => {
  // Deliberate contract: events fire even though the caller could still roll
  // back. Suppressing them would be a worse failure mode -- run:ended drives
  // B-lite retry, the goal verdict loop and harvest, so a caller that wrapped a
  // terminal transition in a transaction would silently stop all three.
  // better-sqlite3 has no outer commit hook, so the contract is "do not wrap a
  // terminal transition in a transaction you may roll back".
  const { db, events, questionService, runService } = setup(t, { injectQuestions: true });
  const run = runService.createRun(managerArgs());
  runService.updateRunStatus(run.id, 'running', { force: true });
  createPendingQuestion(questionService, run.id);
  const eventCountBefore = events.length;

  assert.throws(() => db.transaction(() => {
    runService.updateRunStatus(run.id, 'failed', { force: true, terminalReason: 'worker_failed' });
    throw new Error('outer rollback');
  })(), /outer rollback/);

  const emitted = events.slice(eventCountBefore)
    .filter(({ channel }) => channel === 'run:status' || channel === 'run:ended')
    .map(({ channel }) => channel);
  assert.ok(emitted.includes('run:ended'), 'run:ended must still fire; suppressing it breaks B-lite/goal/harvest');

  // The DATA is still atomic with the caller's transaction: the rollback
  // reverted both the run status and the question cancellation.
  assert.equal(runService.getRun(run.id).status, 'running', 'run status rolled back with the outer transaction');
});

test('terminal-to-terminal force transition still cancels pending questions', t => {
  const { questionService, runService } = setup(t, { injectQuestions: true });
  const run = runService.createRun(managerArgs());
  const question = createPendingQuestion(questionService, run.id);
  runService.updateRunStatus(run.id, 'failed', { force: true, terminalReason: 'question_unanswered' });
  assert.equal(questionService.getQuestion(question.id).status, 'pending');

  runService.updateRunStatus(run.id, 'cancelled', { force: true, terminalReason: 'user_cancelled' });

  assert.equal(questionService.getQuestion(question.id).status, 'cancelled');
});
