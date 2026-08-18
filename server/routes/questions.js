'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ForbiddenError, NotFoundError } = require('../utils/errors');
const { assertSameOrigin } = require('../utils/sameOrigin');

// Palantir Console is a single-process server. If clustered, this per-process
// waiter count must be replaced by shared coordination.
// NOTE (codex review): waitersByRun/globalWaiterCount are module-global while
// activeWaiters/waitersStopped/maxGlobalWaiters are per-router. That is fine for
// the documented single-app, single-process deployment, but two createApp()
// instances in one process would share the counters and interfere. Revisit if
// multi-instance hosting is ever introduced.
const waitersByRun = new Map();
let globalWaiterCount = 0;
const MAX_GLOBAL_WAITERS = 64;

const CREATE_ERROR_MAP = Object.freeze({
  QUESTION_INVALID: [400, 'question_invalid'],
  IDEMPOTENCY_CONFLICT: [409, 'idempotency_conflict'],
  QUESTION_PENDING: [409, 'question_pending'],
  RUN_NOT_ACTIVE: [409, 'run_not_active'],
  QUESTION_ID_COLLISION: [500, 'question_id_collision'],
});

function sendServiceError(res, err, mapping) {
  const mapped = mapping[err && err.code];
  if (!mapped) throw err;
  const [status, reason] = mapped;
  const body = { error: err.message, reason };
  if (err.current !== undefined) body.question = err.current;
  return res.status(status).json(body);
}

function requireWorkerForRun(req) {
  if (!req.auth || req.auth.method !== 'worker' || req.auth.runId !== req.params.runId) {
    throw new ForbiddenError('worker question token does not match this run');
  }
}

function createQuestionsRouter({
  questionService,
  runService,
  waitTimeoutMs = 25_000,
  pollIntervalMs = 500,
  maxGlobalWaiters = MAX_GLOBAL_WAITERS,
  onWaiterActive,
} = {}) {
  const router = express.Router();
  const activeWaiters = new Set();
  let waitersStopped = false;

  router.stopWaiters = () => {
    waitersStopped = true;
    const drains = [];
    for (const waiter of activeWaiters) {
      drains.push(waiter.done);
      if (waiter.wake) waiter.wake();
    }
    return Promise.allSettled(drains);
  };
  router.getGlobalWaiterCount = () => globalWaiterCount;

  router.post('/runs/:runId/questions', asyncHandler(async (req, res) => {
    requireWorkerForRun(req);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
    let run = null;
    try { run = runService.getRun(req.params.runId); } catch { /* service classifies inactive */ }
    try {
      const question = questionService.createQuestion({
        runId: req.params.runId,
        taskId: run && run.task_id,
        projectId: req.auth.projectId || (run && run.project_id),
        idempotencyKey: body.idempotency_key,
        class: body.class,
        question: body.question,
        options: body.options,
        waitBudgetMs: body.wait_budget_ms,
      });
      return res.status(201).json({ question });
    } catch (err) {
      return sendServiceError(res, err, CREATE_ERROR_MAP);
    }
  }));

  router.get('/runs/:runId/questions/:id/wait', asyncHandler(async (req, res) => {
    requireWorkerForRun(req);
    res.set('Cache-Control', 'no-store');
    res.set('X-Accel-Buffering', 'no');

    const initial = questionService.getQuestion(req.params.id);
    if (!initial || initial.runId !== req.params.runId) {
      throw new NotFoundError('question not found');
    }
    if (initial.status !== 'pending') return res.json({ question: initial });

    if (waitersStopped) return res.json({ question: initial });

    if ((waitersByRun.get(req.params.runId) || 0) >= 1) {
      res.set('Retry-After', '1');
      return res.status(429).json({ error: 'run already has an active waiter', reason: 'waiter_busy' });
    }

    const globalLimit = Number.isFinite(maxGlobalWaiters)
      ? Math.max(0, Math.floor(maxGlobalWaiters))
      : MAX_GLOBAL_WAITERS;
    if (globalWaiterCount >= globalLimit) {
      res.set('Retry-After', '1');
      return res.status(429).json({ error: 'global waiter capacity reached', reason: 'waiter_capacity' });
    }

    waitersByRun.set(req.params.runId, 1);
    globalWaiterCount += 1;
    let closed = false;
    let wakePoll = null;
    let resolveDone;
    const waiter = {
      done: new Promise(resolve => { resolveDone = resolve; }),
      wake: null,
    };
    activeWaiters.add(waiter);
    try {
      if (typeof onWaiterActive === 'function') onWaiterActive({ runId: req.params.runId, questionId: req.params.id });
    } catch { /* test/observability hooks must not affect waiter lifecycle */ }
    // IncomingMessage may emit `close` after a normally completed request body;
    // only an aborted/destroyed connection should cancel the response wait.
    const onClose = () => {
      if (req.aborted || res.destroyed) {
        closed = true;
        if (wakePoll) wakePoll();
      }
    };
    req.on('close', onClose);
    try {
      const deadline = Date.now() + Math.min(25_000, Math.max(0, waitTimeoutMs));
      let current = initial;
      // waitersStopped must gate the loop itself: waking the sleep alone just
      // sends the waiter back around for another poll interval.
      while (!closed && !waitersStopped && current.status === 'pending' && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            wakePoll = null;
            waiter.wake = null;
            resolve();
          }, Math.min(pollIntervalMs, remaining));
          wakePoll = () => {
            clearTimeout(timer);
            wakePoll = null;
            waiter.wake = null;
            resolve();
          };
          waiter.wake = wakePoll;
        });
        if (!closed) current = questionService.getQuestion(req.params.id) || current;
      }
      if (!closed && !res.headersSent) return res.json({ question: current });
      return undefined;
    } finally {
      req.off('close', onClose);
      waitersByRun.delete(req.params.runId);
      activeWaiters.delete(waiter);
      globalWaiterCount = Math.max(0, globalWaiterCount - 1);
      resolveDone();
    }
  }));

  router.post('/questions/:id/respond', asyncHandler(async (req, res) => {
    if (!req.auth || req.auth.method !== 'cookie') {
      throw new ForbiddenError('cookie auth required');
    }
    assertSameOrigin(req);
    try {
      const question = questionService.answerQuestion(req.params.id, {
        answer: req.body && req.body.answer,
      });
      return res.json({ question });
    } catch (err) {
      return sendServiceError(res, err, {
        QUESTION_INVALID: [400, 'question_invalid'],
        QUESTION_NOT_PENDING: [409, 'question_not_pending'],
      });
    }
  }));

  router.get('/questions', asyncHandler(async (req, res) => {
    if (!req.auth || !['cookie', 'bearer'].includes(req.auth.method)) {
      throw new ForbiddenError('human auth required');
    }
    res.json({ questions: questionService.listQuestions({ status: req.query.status }) });
  }));

  return router;
}

module.exports = { createQuestionsRouter, MAX_GLOBAL_WAITERS };
