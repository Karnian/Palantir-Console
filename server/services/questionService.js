const crypto = require('node:crypto');
const { detectInjection, redactSecrets } = require('./memorySanitize');

const CLASSES = new Set(['clarification', 'choice', 'approval']);

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

const ID_COLLISION_RETRIES = 3;
const UNSAFE_PLACEHOLDER = '[UNSAFE CONTENT REMOVED]';
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);

function sanitizeResumeField(value) {
  const text = String(value == null ? '' : value);
  if (detectInjection(text)) return { text: UNSAFE_PLACEHOLDER, sanitized: true, reason: 'injection' };
  const redacted = redactSecrets(text);
  return { text: redacted.text, sanitized: redacted.redacted, reason: redacted.redacted ? 'secret' : null };
}

function compileResumePrompt({ basePrompt, question }) {
  const id = sanitizeResumeField(question && question.id);
  const questionText = sanitizeResumeField(question && question.question);
  const answer = sanitizeResumeField(question && question.answer);
  const block = [
    '[ANSWERED QUESTION]',
    `question_id: ${id.text}`,
    `question: ${questionText.text}`,
    `answer: ${answer.text}`,
  ].join('\n');
  return [basePrompt || '', block].filter(Boolean).join('\n\n');
}

function createQuestionService(db, eventBus, options = {}) {
  const runService = options.runService || null;
  const onRunCreated = typeof options.onRunCreated === 'function' ? options.onRunCreated : null;
  const generateId = typeof options.generateId === 'function'
    ? options.generateId
    : () => `wq_${crypto.randomUUID().slice(0, 12)}`;
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
    db.prepare(`
      UPDATE worker_questions SET status = 'expired'
      WHERE run_id = ? AND status = 'pending' AND expires_at <= datetime('now')
    `).run(input.runId);

    const classifyCreateFailure = () => {
      const existing = db.prepare(
        'SELECT * FROM worker_questions WHERE run_id = ? AND idempotency_key = ?',
      ).get(input.runId, input.idempotencyKey);
      if (existing) {
        if (existing.payload_hash === hash) return materialize(existing);
        throw serviceError('IDEMPOTENCY_CONFLICT', 'idempotency key was already used for a different question');
      }
      if (db.prepare("SELECT 1 FROM worker_questions WHERE run_id = ? AND status = 'pending'").get(input.runId)) {
        throw serviceError('QUESTION_PENDING', 'run already has a pending question');
      }
      throw serviceError('RUN_NOT_ACTIVE', 'run does not exist or is terminal');
    };

    const existing = db.prepare(
      'SELECT * FROM worker_questions WHERE run_id = ? AND idempotency_key = ?',
    ).get(input.runId, input.idempotencyKey);
    if (existing) {
      if (existing.payload_hash === hash) return materialize(existing);
      throw serviceError('IDEMPOTENCY_CONFLICT', 'idempotency key was already used for a different question');
    }

    if (db.prepare("SELECT 1 FROM worker_questions WHERE run_id = ? AND status = 'pending'").get(input.runId)) {
      throw serviceError('QUESTION_PENDING', 'run already has a pending question');
    }

    const insert = db.prepare(`
      INSERT INTO worker_questions (
        id, run_id, task_id, project_id, idempotency_key, payload_hash,
        class, question, options_json, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 days')
      FROM runs
      WHERE id = ? AND status NOT IN ('completed','failed','cancelled','stopped')
    `);
    // A primary-key collision is not a contract violation like the UNIQUE
    // indexes are -- it just means this id is taken. Retry with a fresh id
    // instead of misdiagnosing it through classifyCreateFailure(), and never
    // let the raw SQLITE_CONSTRAINT_PRIMARYKEY escape the service.
    let id;
    let result;
    for (let attempt = 0; ; attempt += 1) {
      id = generateId();
      try {
        result = insert.run(id, input.runId, input.taskId ?? null, input.projectId ?? null,
          input.idempotencyKey, hash, input.class, input.question, JSON.stringify(input.options ?? []), input.runId);
        break;
      } catch (err) {
        if (err && err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          if (attempt < ID_COLLISION_RETRIES) continue;
          throw serviceError('QUESTION_ID_COLLISION', 'could not allocate a unique question id');
        }
        if (err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT')) {
          return classifyCreateFailure();
        }
        throw err;
      }
    }
    if (result.changes === 0) return classifyCreateFailure();
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

  function requireResumeService() {
    if (!runService) throw serviceError('RESUME_UNAVAILABLE', 'question resume service is unavailable');
  }

  function claimGoalSuccessor(originalRun, successorRunId) {
    if (originalRun.goal_active !== 1) return true;
    return db.prepare(`
      UPDATE runs SET goal_retry_run_id = ?
      WHERE id = ? AND goal_retry_run_id IS NULL
    `).run(successorRunId, originalRun.id).changes === 1;
  }

  const answerTx = db.transaction((id, answer, resume) => {
    if (typeof answer !== 'string' || answer.length === 0 || [...answer].length > 4000) {
      throw serviceError('QUESTION_INVALID', 'answer must be a non-empty string of at most 4000 characters');
    }
    const row = getRaw.get(id);
    const current = materialize(row);
    if (!current || current.status !== 'pending') {
      throw serviceError('QUESTION_NOT_PENDING', 'question is not pending', current);
    }
    const options = JSON.parse(row.options_json);
    if (options.length > 0 && !options.includes(answer)) {
      throw serviceError('QUESTION_INVALID', 'answer must match one of the question options');
    }
    if (resume) requireResumeService();
    const resumeRow = resume ? runService.buildRunRow : null;
    let newRun = null;
    let newRunId = null;
    let resumeSkipped = null;
    if (resume) {
      const originalRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(row.run_id);
      if (!originalRun) throw serviceError('RESUME_UNAVAILABLE', 'original question run is unavailable');
      if (!TERMINAL_RUN_STATUSES.has(originalRun.status)) {
        resumeSkipped = 'run_active';
      } else {
        const prompt = compileResumePrompt({ basePrompt: originalRun.prompt,
          question: { id: row.id, question: row.question, answer } });
        const built = resumeRow({ task_id: originalRun.task_id, agent_profile_id: originalRun.agent_profile_id,
          node_id: originalRun.node_id, operator_instance_id: originalRun.operator_instance_id,
          parent_run_id: originalRun.parent_run_id, prompt, source_question_id: row.id,
          queued_args: originalRun.queued_args,
          // A goal resume is linked through goal_retry_run_id and starts a fresh
          // storage retry root so the inherited count does not collide with the
          // UNIQUE (retry_root_run_id, retry_count) attempt key.
          retry_root_run_id: originalRun.goal_active === 1
            ? originalRun.id
            : (originalRun.retry_root_run_id || originalRun.id),
          // Goal resume continues the same budget: answering a question neither
          // consumes a failure retry nor resets attempts already used. Non-goal
          // resume stays at zero because it is outside the B-lite goal budget.
          retry_count: originalRun.goal_active === 1 ? Number(originalRun.retry_count || 0) : 0 });
        newRunId = built.id;
        if (claimGoalSuccessor(originalRun, newRunId)) {
          newRun = { built, goalActive: originalRun.goal_active === 1 };
        } else {
          newRunId = null;
          resumeSkipped = 'successor_exists';
        }
      }
    }
    const result = db.prepare(`
      UPDATE worker_questions
      SET status = 'answered', answer = ?, answered_at = datetime('now'), resumed_run_id = ?
      WHERE id = ? AND status = 'pending' AND expires_at > datetime('now')
    `).run(answer, newRunId, id);
    if (result.changes === 0) {
      throw serviceError('QUESTION_NOT_PENDING', 'question is not pending', materialize(getRaw.get(id)));
    }
    if (newRun) {
      runService.insertRunRow(newRun.built);
      if (newRun.goalActive) {
        db.prepare('UPDATE runs SET goal_active = 1 WHERE id = ?').run(newRun.built.id);
      }
      newRun = runService.readRunRow(newRun.built.id);
    }
    return { question: materialize(getRaw.get(id)), run: newRun, resumeSkipped };
  });

  function emitResumeEffects(result) {
    if (!result.run) return;
    // These are ordered post-commit effects, but each is isolated: an event
    // subscriber failure must never suppress the queue-drain wakeup.
    try { runService.emitRunCreated(result.run); } catch { /* best effort */ }
    try { if (onRunCreated) onRunCreated(result.run); } catch { /* best effort */ }
    const raw = getRaw.get(result.question.id);
    const fields = { question_id: raw.id, question: raw.question, answer: raw.answer };
    const sanitized = Object.entries(fields).filter(([, value]) => sanitizeResumeField(value).sanitized)
      .map(([field, value]) => ({ field, reason: sanitizeResumeField(value).reason }));
    if (sanitized.length && typeof runService.addRunEvent === 'function') {
      try {
        runService.addRunEvent(result.run.id, 'question:resume_prompt_sanitized', JSON.stringify({ fields: sanitized }));
      } catch { /* best effort */ }
    }
  }

  function answerQuestion(id, { answer, resume = false }) {
    const result = answerTx(id, answer, resume === true);
    emitResumeEffects(result);
    if (eventBus) eventBus.emit('question:answered', result.question);
    return { ...result.question, resumeSkipped: result.resumeSkipped };
  }

  const resumeTx = db.transaction((id) => {
    requireResumeService();
    const row = getRaw.get(id);
    if (!row || row.status !== 'answered') {
      throw serviceError('QUESTION_NOT_ANSWERED', 'question is not answered', materialize(row));
    }
    if (row.resumed_run_id) {
      const err = serviceError('QUESTION_ALREADY_RESUMED', 'question was already resumed', materialize(row));
      err.resumedRunId = row.resumed_run_id;
      throw err;
    }
    const originalRun = db.prepare('SELECT * FROM runs WHERE id = ?').get(row.run_id);
    if (!originalRun) throw serviceError('RESUME_UNAVAILABLE', 'original question run is unavailable');
    if (!TERMINAL_RUN_STATUSES.has(originalRun.status)) {
      throw serviceError('RUN_STILL_ACTIVE', 'original question run is still active', materialize(row));
    }
    const prompt = compileResumePrompt({ basePrompt: originalRun.prompt,
      question: { id: row.id, question: row.question, answer: row.answer } });
    const built = runService.buildRunRow({ task_id: originalRun.task_id, agent_profile_id: originalRun.agent_profile_id,
      node_id: originalRun.node_id, operator_instance_id: originalRun.operator_instance_id,
      parent_run_id: originalRun.parent_run_id, prompt, source_question_id: row.id,
      queued_args: originalRun.queued_args,
      // A goal resume is linked through goal_retry_run_id and starts a fresh
      // storage retry root so the inherited count does not collide with the
      // UNIQUE (retry_root_run_id, retry_count) attempt key.
      retry_root_run_id: originalRun.goal_active === 1
        ? originalRun.id
        : (originalRun.retry_root_run_id || originalRun.id),
      // Goal resume continues the same budget: answering a question neither
      // consumes a failure retry nor resets attempts already used. Non-goal
      // resume stays at zero because it is outside the B-lite goal budget.
      retry_count: originalRun.goal_active === 1 ? Number(originalRun.retry_count || 0) : 0 });
    const changed = db.prepare("UPDATE worker_questions SET resumed_run_id = ? WHERE id = ? AND status = 'answered' AND resumed_run_id IS NULL")
      .run(built.id, id).changes;
    if (!changed) {
      const current = materialize(getRaw.get(id));
      const err = serviceError('QUESTION_ALREADY_RESUMED', 'question was already resumed', current);
      err.resumedRunId = current && current.resumedRunId;
      throw err;
    }
    if (!claimGoalSuccessor(originalRun, built.id)) {
      throw serviceError('SUCCESSOR_EXISTS', 'goal run already has a successor', materialize(getRaw.get(id)));
    }
    runService.insertRunRow(built);
    if (originalRun.goal_active === 1) {
      db.prepare('UPDATE runs SET goal_active = 1 WHERE id = ?').run(built.id);
    }
    return { question: materialize(getRaw.get(id)), run: runService.readRunRow(built.id) };
  });

  function resumeQuestion(id) {
    const result = resumeTx(id);
    emitResumeEffects(result);
    return result.question;
  }

  function cancelPendingForRun(runId, { terminalReason } = {}) {
    if (!db.inTransaction) {
      throw serviceError('MUST_BE_IN_TRANSACTION', 'cancelPendingForRun must be called inside a transaction');
    }
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

  return { createQuestion, getQuestion, listQuestions, answerQuestion, resumeQuestion, cancelPendingForRun, expireStale };
}

createQuestionService.compileResumePrompt = compileResumePrompt;
module.exports = { createQuestionService, canonicalPayloadHash, compileResumePrompt };
