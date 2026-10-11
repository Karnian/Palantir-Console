'use strict';

const express = require('express');

function chatError(res, code, status = 403) {
  return res.status(status).json({ error: code, reason: code });
}
function createSessionHubChatRouter({ service }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.auth?.method !== 'cookie') return chatError(res, 'forbidden');
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const scheme = req.socket.encrypted ? 'https' : 'http';
      // Compare the serialized origin exactly. Neither proxy headers nor Referer grant access.
      if (typeof origin !== 'string' || origin !== `${scheme}://${req.headers.host}`) {
        return chatError(res, 'forbidden');
      }
    } else if (req.method === 'GET') {
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return chatError(res, 'forbidden');
    } else return chatError(res, 'not_found', 404);
    return next();
  });
  router.use(express.json({ limit: '1mb' }));
  const post = handler => async (req, res, next) => {
    try { res.json(await handler(req)); } catch (err) { next(err); }
  };
  router.post('/start', post(() => service.start()));
  router.post('/message', post(req => service.message(req.body?.text)));
  router.post('/stop', post(() => service.stop()));
  router.post('/clear', post(() => service.clear()));
  router.get('/state', (req, res) => res.json(service.state()));
  router.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = value => res.write(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`);
    const unsubscribe = service.subscribe(send);
    send(service.state());
    res.on('close', unsubscribe);
  });
  router.use((req, res) => chatError(res, 'not_found', 404));
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return chatError(res, 'invalid_message', 400);
    }
    return chatError(res, err.code || 'session_hub_failed', err.status || 503);
  });
  return router;
}
module.exports = { createSessionHubChatRouter };
