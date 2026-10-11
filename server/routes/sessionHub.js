'use strict';

const express = require('express');
const { timingSafeEqualStr } = require('../middleware/auth');
const { createSessionHubBroker } = require('../services/sessionHubBroker');

const ERROR_STATUS = Object.freeze({ session_hub_off: 404, invalid_query: 400, not_found: 404,
  snapshot_unavailable: 503, snapshot_changed: 409, session_hub_rate_limited: 429, forbidden: 403 });
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

function createSessionHubRouter({ state, store, provider = noToken, clock = Date.now, broker, history }) {
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
    try { return res.json(await handler(req)); } catch (error) { return next(error); }
  };
  router.get('/history/search', get(req => {
    if (req.auth?.actor !== 'session_hub' || !history) throw new Error('forbidden');
    if (Object.keys(req.query).some(key => !['q', 'limit'].includes(key))) throw new Error('invalid_query');
    return history.searchHistory(req.query);
  }));
  router.get('/sessions', get(req => service.list(req.query)));
  router.get('/search', get(req => service.search(req.query)));
  router.get('/sessions/:key', get(req => service.detail(req.params.key, req.query)));
  router.use((req, res) => fail(res, 'not_found'));
  return router;
}

function sessionHubErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (Object.hasOwn(ERROR_STATUS, error.message)) return fail(res, error.message);
  if (error instanceof URIError || error.type === 'entity.parse.failed') return fail(res, 'invalid_query');
  if (!req.auth || req.auth.method !== 'cookie' && req.auth.actor !== 'session_hub') return fail(res, 'forbidden');
  return fail(res, 'snapshot_unavailable');
}

module.exports = { createSessionHubOffGate, createSessionHubTokenGate, createSessionHubRouter,
  sessionHubErrorHandler, ERROR_STATUS };
