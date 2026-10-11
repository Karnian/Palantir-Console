'use strict';
const express = require('express');

function createSessionHubMemoryRouter({ memory, service, provider, clock = Date.now }) {
  const router = express.Router();
  const bucket = {};
  const error = (res, code, status = 403) => res.status(status).json({ error: code, reason: code });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.auth?.actor === 'session_hub') {
      const path = String(req.originalUrl).split('?')[0];
      if (req.method !== 'POST' || path !== '/api/session-hub/memory/proposals') return error(res, 'forbidden');
      const token = provider.current();
      const time = clock();
      if (bucket.token !== token || time - bucket.started >= 60000) {
        bucket.token = token; bucket.started = time; bucket.calls = 0;
      }
      if (++bucket.calls > 5) return error(res, 'session_hub_rate_limited', 429);
    } else {
      if (req.auth?.method !== 'cookie') return error(res, 'forbidden');
      if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        const scheme = req.socket.encrypted ? 'https' : 'http';
        if (req.headers.origin !== `${scheme}://${req.headers.host}`) return error(res, 'forbidden');
      } else if (req.method === 'GET') {
        const site = req.headers['sec-fetch-site'];
        if (site !== undefined && !['same-origin', 'none'].includes(site)) return error(res, 'forbidden');
      } else return error(res, 'not_found', 404);
    }
    return next();
  });
  router.use(express.json({ limit: 4096 }));
  const handle = fn => (req, res, next) => {
    try { res.json(fn(req)); } catch (err) { next(err); }
  };
  router.post('/proposals', handle(req => {
    if (req.auth?.actor !== 'session_hub') throw Object.assign(new Error('forbidden'), { status: 403 });
    return service.proposeMemory(memory, req.body, req.headers.authorization.slice(7));
  }));
  router.get('/', handle(() => memory.list()));
  router.post('/proposals/:id/decision', handle(req => memory.decision(req.params.id, req.body)));
  router.post('/', handle(req => memory.add(req.body)));
  router.patch('/:id', handle(req => memory.edit(req.params.id, req.body)));
  router.post('/:id/archive', handle(req => memory.archive(req.params.id, req.body)));
  router.use((req, res) => error(res, 'not_found', 404));
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return error(res, 'invalid_query', 400);
    }
    return error(res, err.code || err.message || 'memory_failed', err.status || 503);
  });
  return router;
}
module.exports = { createSessionHubMemoryRouter };
