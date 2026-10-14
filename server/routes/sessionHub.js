'use strict';

const express = require('express');
const { isSafeId, isSafeInstructionId } = require('../services/observeSnapshotPolicy');
const { timingSafeEqualStr } = require('../middleware/auth');
const { createSessionHubBroker } = require('../services/sessionHubBroker');

const ERROR_STATUS = Object.freeze({ session_hub_off: 404, invalid_query: 400, not_found: 404,
  answers_off: 404, turn_not_active: 409, answer_out_of_scope: 403,
  answer_budget_exceeded: 429, answer_busy: 429, snapshot_unavailable: 503, snapshot_changed: 409,
  session_hub_rate_limited: 429, forbidden: 403 });
const noToken = Object.freeze({ current: () => null });

function fail(res, code) {
  res.set('Cache-Control', 'no-store');
  return res.status(ERROR_STATUS[code]).json({ error: code, reason: code });
}

function createSessionHubOffGate(active) {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    return active ? next() : fail(res, 'session_hub_off');
  };
}

function brokerGet(req) {
  const raw = String(req.originalUrl || req.url).split('?')[0];
  // Express also accepts a trailing slash and case-insensitive route literals.
  if (req.method === 'POST' && raw === '/api/session-hub/memory/proposals') return true;
  return req.method === 'GET'
    && (raw === '/api/session-hub/history/search'
      || /^\/api\/session-hub\/answers\/[^/]+\/[^/]+\/?$/i.test(raw)
      || /^\/api\/session-hub\/(?:sessions(?:\/[^/]+)?|search)\/?$/i.test(raw));
}

function createSessionHubTokenGate(provider = noToken) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    const current = provider.current();
    if (!current || !header?.startsWith('Bearer ') || !timingSafeEqualStr(header.slice(7), current)) return next();
    if (!brokerGet(req)) return fail(res, 'forbidden');
    req.auth = { method: 'bearer', actor: 'session_hub' };
    return next();
  };
}

function createSessionHubRouter({ state, store, provider = noToken, clock = Date.now, broker, history,
  answers = false, answerService = null, hub = null }) {
  const router = express.Router();
  const service = broker || createSessionHubBroker({ state, store });
  const buckets = { broker: {}, history: {} };
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.auth?.method !== 'cookie' && req.auth?.actor !== 'session_hub') return fail(res, 'forbidden');
    if (req.auth.actor === 'session_hub') {
      const current = provider.current();
      const time = clock();
      const isHistory = String(req.originalUrl).split('?')[0] === '/api/session-hub/history/search';
      const bucket = isHistory ? buckets.history : buckets.broker;
      if (current !== bucket.token || time - bucket.started >= 60000) {
        bucket.token = current; bucket.started = time; bucket.calls = 0;
      }
      const used = ++bucket.calls;
      if (used > 30) return fail(res, 'session_hub_rate_limited');
    }
    return next();
  });
  const get = handler => async (req, res, next) => {
    if (req.method !== 'GET') return fail(res, 'not_found');
    try { return res.json(await handler(req, res)); } catch (error) { return next(error); }
  };
  router.get('/history/search', get(req => {
    if (req.auth?.actor !== 'session_hub' || !history) throw new Error('forbidden');
    if (Object.keys(req.query).some(key => !['q', 'limit'].includes(key))) throw new Error('invalid_query');
    return history.searchHistory(req.query);
  }));
  const returned = (req, res) => {
    let handle = null;
    if (req.auth?.actor === 'session_hub') {
      try { handle = hub?.captureHubTurn(req.headers.authorization.slice(7)); } catch { /* preserve reads */ }
    }
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) gone = true; });
    return { onBindings: bindings => {
      if (handle && !gone && !res.destroyed) hub.recordReturnedKeys(handle, bindings);
    } };
  };
  router.get('/sessions', get((req, res) => service.list(req.query, returned(req, res))));
  router.get('/search', get((req, res) => service.search(req.query, returned(req, res))));
  router.get('/sessions/:key', get((req, res) => service.detail(req.params.key, req.query, returned(req, res))));
  router.get('/answers/:key/:instructionId', async (req, res, next) => {
    if (!answers || !answerService || !hub) return fail(res, 'answers_off');
    if (req.auth?.actor !== 'session_hub') return fail(res, 'forbidden');
    if (req.method !== 'GET') return fail(res, 'not_found');
    const raw = String(req.originalUrl || req.url).split('?').slice(1).join('?');
    const match = /^rev=([0-9a-f]{16})$/.exec(raw);
    const { key, instructionId } = req.params;
    if (Buffer.byteLength(raw) > 256 || !match || raw.length !== 20 || !isSafeId(key) || !isSafeInstructionId(instructionId)) {
      return fail(res, 'invalid_query');
    }
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) gone = true; });
    try {
      // All three checks happen synchronously before query can yield or throw.
      const handle = hub.captureHubTurn(req.headers.authorization.slice(7));
      const binding = hub.answerBinding(handle, key, match[1]);
      hub.reserveAnswer(handle, key);
      const result = await answerService.query({ machineId: binding.machineId, sessionKey: key,
        instructionId, rev: binding.sha256 });
      if (gone || res.destroyed) return;
      const { budget_clipped } = hub.completeAnswer(handle, key,
        result.text == null ? 0 : Buffer.byteLength(result.text));
      const body = { answer: { trust: 'untrusted_worker_report',
        source: { machine: binding.label, key, instruction_id: instructionId },
        status: result.status, text: budget_clipped ? null : result.text,
        truncated: result.truncated, redacted: result.redacted, shared_turn: result.shared_turn,
        reason: result.reason, budget_clipped, answer_at: result.answer_at, observed_at: result.observed_at },
      meta: { rev: binding.rev } };
      if (Buffer.byteLength(JSON.stringify(body)) > 65536) return fail(res, 'snapshot_unavailable');
      return res.json(body);
    } catch (error) {
      if (gone || res.destroyed) return;
      return next(error);
    }
  });
  router.use((req, res) => fail(res, 'not_found'));
  return router;
}

function sessionHubErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const code = error.code || error.message;
  if (Object.hasOwn(ERROR_STATUS, code)) return fail(res, code);
  if (error instanceof URIError || error.type === 'entity.parse.failed') return fail(res, 'invalid_query');
  if (!req.auth || req.auth.method !== 'cookie' && req.auth.actor !== 'session_hub') return fail(res, 'forbidden');
  return fail(res, 'snapshot_unavailable');
}

module.exports = { createSessionHubOffGate, createSessionHubTokenGate, createSessionHubRouter,
  sessionHubErrorHandler, ERROR_STATUS };
