const crypto = require('node:crypto');

const CLASSES = new Set(['clarification', 'choice', 'approval']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);

function serviceError(code, message, current) {
  const err = new Error(message);
  err.code = code;
  if (current !== undefined) err.current = current;
  return err;
}

function canonicalPayloadHash(payload = {}) {
  const canonical = {
    class: payload.class === undefined ? null : payload.class,
    options: payload.options === undefined ? [] : payload.options,
    question: payload.question === undefined ? '' : payload.question,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validateCreate(input) {
  const { idempotencyKey, class: cls, question, options = [], waitBudgetMs } = input;
  if (typeof question !== 'string' || question.length === 0 || [...question].length > 4000) {
    throw serviceError('QUESTION_INVALID', 'question must be a non-empty string of at most 4000 characters');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0
      || [...idempotencyKey].length > 200 || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) {
    throw serviceError('QUESTION_INVALID', 'idempotencyKey must be non-empty, at most 200 characters, and contain no control characters');
  }
  if (!CLASSES.has(cls)) {
    throw serviceError('QUESTION_INVALID', 'class must be clarification, choice, or approval');
  }
  if (!Array.isArray(options) || options.length > 10) {
    throw serviceError('QUESTION_INVALID', 'options must be an array of at most 10 strings');
  }
  const seen = new Set();
  for (const option of options) {
    if (typeof option !== 'string' || [...option].length > 200 || seen.has(option)) {
      throw serviceError('QUESTION_INVALID', 'options must be unique strings of at most 200 characters');
    }
    seen.add(option);
  }
  if (waitBudgetMs !== undefined && !Number.isInteger(waitBudgetMs)) {
    throw serviceError('QUESTION_INVALID', 'waitBudgetMs must be an integer');
  }

  // The clamped value is intentionally not persisted or hashed in PR1a, but
  // computing it here keeps validation semantics explicit for future callers.
  return waitBudgetMs === undefined
    ? undefined
    : Math.min(1_800_000, Math.max(60_000, waitBudgetMs));
}

function createQuestionService(db, eventBus) {
  function materialize(row) {
    if (!row) return null;
    const expired = row.status === 'pending'
      && db.prepare("SELECT ? <= datetime('now') AS expired").get(row.expires_at).expired;
    return {
      id: row.id,
      runId: row.run_id,
      taskId: row.task_id,
      projectId: row.project_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      class: row.class,
      question: row.question,
      options: JSON.parse(row.options_json),
      status: expired ? 'expired' : row.status,
      answer: row.answer,
      answeredAt: row.answered_at,
      resumedRunId: row.resumed_run_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  const getRaw = db.prepare('SELECT * FROM worker_questions WHERE id = ?');
  const createTx = db.transaction((input) => {
    validateCreate(input);
    const hash = canonicalPayloadHash(input);
    const existing = db.prepare(
      'SELECT * FROM worker_questions WHERE run_id = ? AND idempotency_key = ?',
    ).get(input.runId, input.idempotencyKey);
    if (existing) {
      if (existing.payload_hash === hash) return materialize(existing);
      throw serviceError('IDEMPOTENCY_CONFLICT', 'idempotency key was already used for a different question');
    }

    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(input.runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
      throw serviceError('RUN_NOT_ACTIVE', 'run does not exist or is terminal');
    }
    if (db.prepare("SELECT 1 FROM worker_questions WHERE run_id = ? AND status = 'pending'").get(input.runId)) {
      throw serviceError('QUESTION_PENDING', 'run already has a pending question');
    }

    const id = `wq_${crypto.randomUUID().slice(0, 12)}`;
    db.prepare(`
      INSERT INTO worker_questions (
        id, run_id, task_id, project_id, idempotency_key, payload_hash,
        class, question, options_json, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days'))
    `).run(id, input.runId, input.taskId ?? null, input.projectId ?? null,
      input.idempotencyKey, hash, input.class, input.question, JSON.stringify(input.options ?? []));
    return materialize(getRaw.get(id));
  });

  function createQuestion(input) {
    return createTx(input);
  }

  function getQuestion(id) {
    return materialize(getRaw.get(id));
  }

  function listQuestions({ status } = {}) {
    const rows = db.prepare('SELECT * FROM worker_questions ORDER BY created_at, id').all();
    return rows.map(materialize).filter(row => !status || row.status === status);
  }

  const answerTx = db.transaction((id, answer) => {
    const row = getRaw.get(id);
    const current = materialize(row);
    if (!current || current.status !== 'pending') {
      throw serviceError('QUESTION_NOT_PENDING', 'question is not pending', current);
    }
    const options = JSON.parse(row.options_json);
    if (options.length > 0 && !options.includes(answer)) {
      throw serviceError('QUESTION_INVALID', 'answer must match one of the question options');
    }
    const result = db.prepare(`
      UPDATE worker_questions
      SET status = 'answered', answer = ?, answered_at = datetime('now')
      WHERE id = ? AND status = 'pending' AND expires_at > datetime('now')
    `).run(answer, id);
    if (result.changes === 0) {
      throw serviceError('QUESTION_NOT_PENDING', 'question is not pending', materialize(getRaw.get(id)));
    }
    return materialize(getRaw.get(id));
  });

  function answerQuestion(id, { answer }) {
    const answered = answerTx(id, answer);
    if (eventBus) eventBus.emit('question:answered', answered);
    return answered;
  }

  function cancelPendingForRun(runId, { terminalReason } = {}) {
    if (terminalReason === 'question_unanswered') return 0;
    return db.prepare(
      "UPDATE worker_questions SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'",
    ).run(runId).changes;
  }

  function expireStale() {
    return db.prepare(`
      UPDATE worker_questions SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= datetime('now')
    `).run().changes;
  }

  return { createQuestion, getQuestion, listQuestions, answerQuestion, cancelPendingForRun, expireStale };
}

module.exports = { createQuestionService, canonicalPayloadHash };
