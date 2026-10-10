'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { AppError, ForbiddenError } = require('../utils/errors');
const { isSafeId } = require('../services/observeSnapshotPolicy');
const snapshotStore = require('../services/observeSnapshotStore');

const ERROR_STATUS = Object.freeze({
  observe_off: 404,
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

function createObserveRouter({ state, store = snapshotStore }) {
  const router = express.Router();
  router.get('/snapshots', asyncHandler(function snapshotList(req, res) {
    if (req.auth?.method !== 'cookie') throw new ForbiddenError('cookie auth required');
    if (req.method !== 'GET') throw new AppError('route_not_found', 404);
    return res.json({ snapshots: requireResult(store.listSnapshots(state)).snapshots });
  }));
  router.get('/snapshots/:machineId', asyncHandler(function snapshotDetail(req, res) {
    if (req.auth?.method !== 'cookie') throw new ForbiddenError('cookie auth required');
    if (req.method !== 'GET') throw new AppError('route_not_found', 404);
    if (!isSafeId(req.params.machineId)) throw new AppError('invalid_machine_id', 400);
    return res.json(requireResult(store.readSnapshot(state, req.params.machineId)).snapshot);
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
