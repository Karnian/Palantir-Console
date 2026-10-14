'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { AppError, ForbiddenError } = require('../utils/errors');
const { isSafeId, isSafeInstructionId } = require('../services/observeSnapshotPolicy');
const snapshotStore = require('../services/observeSnapshotStore');
const { assertSameOrigin } = require('../utils/sameOrigin');

const ERROR_STATUS = Object.freeze({
  observe_off: 404,
  answers_off: 404,
  invalid_query: 400,
  answer_busy: 429,
  snapshot_unavailable: 503,
  method_not_allowed: 405,
  snapshot_changed: 409,
  invalid_machine_id: 400,
  not_found: 404,
  not_regular: 422,
  symlink: 422,
  identity_mismatch: 422,
  too_large: 413,
  total_limit: 413,
  parse_error: 422,
  policy_violation: 422,
  observe_root_changed: 503,
  read_error: 503,
  route_not_found: 404,
});

function createObserveOffGate(state) {
  return function observeOffGate(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!state.on) return res.status(404).json({ error: 'observe_off', reason: 'observe_off' });
    return next();
  };
}

function requireResult(result) {
  if (!result.ok) throw new AppError(result.reason, ERROR_STATUS[result.reason] || 503);
  return result;
}

function createObserveRouter({ state, store = snapshotStore, answers = true, answerService }) {
  const router = express.Router();
  router.all('/answers', asyncHandler(async function answersQuery(req, res) {
    res.set('Cache-Control', 'no-store');
    if (req.auth?.method !== 'cookie') throw new ForbiddenError('cookie auth required');
    if (req.method !== 'GET') { res.set('Allow', 'GET'); throw new AppError('method_not_allowed', 405); }
    if (!answers) throw new AppError('answers_off', 404);
    assertSameOrigin(req);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenError('cross-origin read blocked');
    const query = req.query;
    const keys = ['machine', 'key', 'instruction', 'rev'];
    if (Object.keys(query).length !== keys.length || keys.some(key => typeof query[key] !== 'string')
      || !isSafeId(query.machine) || !isSafeId(query.key) || !isSafeInstructionId(query.instruction)
      || !/^[0-9a-f]{64}$/.test(query.rev)) throw new AppError('invalid_query', 400);
    const result = await answerService.query({ machineId: query.machine, sessionKey: query.key,
      instructionId: query.instruction, rev: query.rev });
    if (!res.destroyed) return res.json(result);
  }));
  router.get('/snapshots', asyncHandler(function snapshotList(req, res) {
    if (req.auth?.method !== 'cookie') throw new ForbiddenError('cookie auth required');
    if (req.method !== 'GET') throw new AppError('route_not_found', 404);
    const entries = requireResult(store.readAllSnapshots(state)).snapshots;
    return res.json({ snapshots: entries.map(entry => snapshotStore.snapshotMetadata(entry, true)),
      rev: snapshotStore.snapshotRevision(entries), answers });
  }));
  router.get('/snapshots/:machineId', asyncHandler(function snapshotDetail(req, res) {
    if (req.auth?.method !== 'cookie') throw new ForbiddenError('cookie auth required');
    if (req.method !== 'GET') throw new AppError('route_not_found', 404);
    if (!isSafeId(req.params.machineId)) throw new AppError('invalid_machine_id', 400);
    const result = requireResult(store.readSnapshotHashed(state, req.params.machineId));
    if (req.query.sha256 !== undefined && req.query.sha256 !== result.sha256) {
      throw new AppError('snapshot_changed', 409);
    }
    return res.json(result.snapshot);
  }));
  router.use(function observeFallback(req, res, next) {
    if (req.auth?.method !== 'cookie') return next(new ForbiddenError('cookie auth required'));
    // Spec §5.3: unmatched path structure is 404; matched invalid IDs are 400.
    return next(new AppError('route_not_found', 404));
  });
  return router;
}

// Spec §5.3/§5.6: scope auth status normalization and closed errors to observe.
function observeErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  res.set('Cache-Control', 'no-store');
  if (error.message === 'Authentication required') {
    return res.status(401).json({ error: 'authentication_required', reason: 'authentication_required' });
  }
  if (error instanceof ForbiddenError) {
    const code = error.message === 'cookie auth required' ? 'cookie auth required' : 'authentication_failed';
    return res.status(403).json({ error: code, reason: code });
  }
  if (req.auth?.method !== 'cookie') {
    return res.status(403).json({ error: 'cookie auth required', reason: 'cookie auth required' });
  }
  if (Object.hasOwn(ERROR_STATUS, error.message)) {
    return res.status(ERROR_STATUS[error.message]).json({ error: error.message, reason: error.message });
  }
  if (error instanceof URIError) {
    return res.status(400).json({ error: 'invalid_machine_id', reason: 'invalid_machine_id' });
  }
  const code = error.type === 'entity.parse.failed' ? 'request_invalid' : 'internal_error';
  return res.status(code === 'request_invalid' ? 400 : 500).json({ error: code, reason: code });
}

module.exports = { createObserveOffGate, createObserveRouter, observeErrorHandler, ERROR_STATUS };
