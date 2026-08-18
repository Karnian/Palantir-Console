const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createQuestionService } = require('../services/questionService');

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
