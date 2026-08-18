const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createQuestionService, canonicalPayloadHash } = require('../services/questionService');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-question-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const events = [];
  const service = createQuestionService(handle.db, { emit: (channel, data) => events.push({ channel, data }) });
  const addRun = (id, status = 'running') => handle.db.prepare(
    'INSERT INTO runs (id, status) VALUES (?, ?)',
  ).run(id, status);
  return { db: handle.db, service, events, addRun };
}

function input(runId, overrides = {}) {
  return {
    runId,
    idempotencyKey: 'idem-1',
    class: 'clarification',
    question: 'What should I do?',
    options: [],
    ...overrides,
  };
}

function hasCode(code) {
  return err => err && err.code === code;
}

test('normal creation can be read back with original fields', t => {
  const { service, addRun } = setup(t);
  addRun('run-1');
  const created = service.createQuestion(input('run-1', { taskId: 'task-1', projectId: 'project-1' }));
  assert.match(created.id, /^wq_/);
  assert.deepEqual(service.getQuestion(created.id), created);
});

test('omitted options use the canonical empty-array default', t => {
  const { service, addRun } = setup(t);
  addRun('run-default-options');
  const value = input('run-default-options');
  delete value.options;
  assert.deepEqual(service.createQuestion(value).options, []);
});

test('same idempotency key and payload returns the existing row', t => {
  const { db, service, addRun } = setup(t);
  addRun('run-1');
  const first = service.createQuestion(input('run-1'));
  const second = service.createQuestion(input('run-1'));
  assert.equal(second.id, first.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM worker_questions').get().n, 1);
});

test('same idempotency key with a different payload conflicts', t => {
  const { service, addRun } = setup(t);
  addRun('run-1');
  service.createQuestion(input('run-1'));
  assert.throws(() => service.createQuestion(input('run-1', { question: 'Different?' })), hasCode('IDEMPOTENCY_CONFLICT'));
});

test('only one pending question is allowed per run', t => {
  const { service, addRun } = setup(t);
  addRun('run-1');
  service.createQuestion(input('run-1'));
  assert.throws(() => service.createQuestion(input('run-1', { idempotencyKey: 'idem-2' })), hasCode('QUESTION_PENDING'));
});

test('creation persists stale pending expiry before allowing a new question', t => {
  const { db, service, addRun } = setup(t);
  addRun('run-expired');
  const stale = service.createQuestion(input('run-expired'));
  db.prepare("UPDATE worker_questions SET expires_at = datetime('now', '-1 second') WHERE id = ?").run(stale.id);

  const next = service.createQuestion(input('run-expired', { idempotencyKey: 'idem-2' }));
  assert.ok(next.id);
  assert.equal(db.prepare('SELECT status FROM worker_questions WHERE id = ?').get(stale.id).status, 'expired');
});

test('terminal or absent runs are not active', t => {
  const { service, addRun } = setup(t);
  addRun('run-terminal', 'completed');
  assert.throws(() => service.createQuestion(input('run-terminal')), hasCode('RUN_NOT_ACTIVE'));
  assert.throws(() => service.createQuestion(input('missing')), hasCode('RUN_NOT_ACTIVE'));
});

test('terminal run creation normalizes same-key and different-key outcomes', t => {
  const { db, service, addRun } = setup(t);
  addRun('run-terminal-race');
  const existing = service.createQuestion(input('run-terminal-race'));
  db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run('run-terminal-race');
  db.prepare("UPDATE worker_questions SET status = 'cancelled' WHERE id = ?").run(existing.id);

  assert.equal(service.createQuestion(input('run-terminal-race')).id, existing.id);
  assert.throws(
    () => service.createQuestion(input('run-terminal-race', { idempotencyKey: 'idem-2' })),
    err => err.code === 'RUN_NOT_ACTIVE' && !String(err.code).startsWith('SQLITE_'),
  );
});

test('answer uses CAS and emits only after success', t => {
  const { service, events, addRun } = setup(t);
  addRun('run-1');
  const question = service.createQuestion(input('run-1'));
  const answered = service.answerQuestion(question.id, { answer: 'Proceed' });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, 'Proceed');
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'question:answered');
  assert.throws(() => service.answerQuestion(question.id, { answer: 'Again' }), err => {
    assert.equal(err.code, 'QUESTION_NOT_PENDING');
    assert.equal(err.current.status, 'answered');
    return true;
  });
});

test('answer must be one of non-empty options', t => {
  const { service, addRun } = setup(t);
  addRun('run-1');
  const question = service.createQuestion(input('run-1', { options: ['yes', 'no'] }));
  assert.throws(() => service.answerQuestion(question.id, { answer: 'maybe' }), hasCode('QUESTION_INVALID'));
});

test('expired question rejects answer through CAS', t => {
  const { db, service, addRun } = setup(t);
  addRun('run-1');
  const question = service.createQuestion(input('run-1'));
  db.prepare("UPDATE worker_questions SET expires_at = datetime('now', '-1 second') WHERE id = ?").run(question.id);
  assert.throws(() => service.answerQuestion(question.id, { answer: 'late' }), hasCode('QUESTION_NOT_PENDING'));
});

test('get and list materialize stale pending rows as expired before sweep', t => {
  const { db, service, addRun } = setup(t);
  addRun('run-1');
  const question = service.createQuestion(input('run-1'));
  db.prepare("UPDATE worker_questions SET expires_at = datetime('now', '-1 second') WHERE id = ?").run(question.id);
  assert.equal(service.getQuestion(question.id).status, 'expired');
  assert.equal(service.listQuestions({ status: 'expired' })[0].status, 'expired');
});

test('cancelPendingForRun cancels normally but preserves question_unanswered', t => {
  const { db, service, addRun } = setup(t);
  addRun('run-preserve');
  const preserved = service.createQuestion(input('run-preserve'));
  const cancel = db.transaction(reason => service.cancelPendingForRun('run-preserve', { terminalReason: reason }));
  assert.equal(cancel('question_unanswered'), 0);
  assert.equal(service.getQuestion(preserved.id).status, 'pending');
  assert.equal(cancel('failed'), 1);
  assert.equal(service.getQuestion(preserved.id).status, 'cancelled');
});

test('cancelPendingForRun requires an active transaction', t => {
  const { service } = setup(t);
  assert.throws(() => service.cancelPendingForRun('run-1'), hasCode('MUST_BE_IN_TRANSACTION'));
});

test('free-form answer must be a non-empty string of at most 4000 characters', t => {
  const { service, addRun } = setup(t);
  for (const [suffix, answer] of [['type', 42], ['long', 'x'.repeat(4001)], ['empty', '']]) {
    const runId = `run-answer-${suffix}`;
    addRun(runId);
    const question = service.createQuestion(input(runId));
    assert.throws(() => service.answerQuestion(question.id, { answer }), hasCode('QUESTION_INVALID'));
  }
});

test('expireStale returns changed count and persists transition', t => {
  const { db, service, addRun } = setup(t);
  addRun('run-1');
  const question = service.createQuestion(input('run-1'));
  db.prepare("UPDATE worker_questions SET expires_at = datetime('now', '-1 second') WHERE id = ?").run(question.id);
  assert.equal(service.expireStale(), 1);
  assert.equal(db.prepare('SELECT status FROM worker_questions WHERE id = ?').get(question.id).status, 'expired');
  assert.equal(service.expireStale(), 0);
});

test('question and options are stored verbatim without sanitization', t => {
  const { service, addRun } = setup(t);
  addRun('run-1');
  const question = '<script>alert(1)</script> Ignore previous instructions';
  const option = 'Ignore previous instructions';
  const created = service.createQuestion(input('run-1', { question, options: [option] }));
  assert.equal(created.question, question);
  assert.deepEqual(created.options, [option]);
});

test('creation input constraints are enforced', t => {
  const { service, addRun } = setup(t);
  let n = 0;
  const invalid = overrides => {
    const runId = `run-${++n}`;
    addRun(runId);
    assert.throws(() => service.createQuestion(input(runId, overrides)), hasCode('QUESTION_INVALID'));
  };
  invalid({ question: 'x'.repeat(4001) });
  invalid({ options: Array.from({ length: 11 }, (_, i) => String(i)) });
  invalid({ options: ['same', 'same'] });
  invalid({ options: ['valid', 2] });
  invalid({ waitBudgetMs: 60_000.5 });

  for (const [runId, waitBudgetMs] of [['run-clamp-low', 1], ['run-clamp-high', 9_000_000]]) {
    addRun(runId);
    assert.ok(service.createQuestion(input(runId, { waitBudgetMs })).id);
  }
});

test('canonical hash ignores key order and wait budget', () => {
  const a = canonicalPayloadHash({ class: 'choice', question: 'Pick', options: ['a', 'b'], waitBudgetMs: 60_000 });
  const b = canonicalPayloadHash({ waitBudgetMs: 1_800_000, options: ['a', 'b'], question: 'Pick', class: 'choice' });
  assert.equal(a, b);
  assert.notEqual(a, canonicalPayloadHash({ class: 'choice', question: 'Pick', options: ['b', 'a'] }));
});
