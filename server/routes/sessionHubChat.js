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
    const maxBytes = 2 * 1024 * 1024;
    let waiting = false;
    let pending = null;
    let timer = null;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true; pending = null; clearTimeout(timer);
      unsubscribe(); res.removeListener('drain', drained);
    };
    const disconnect = () => { cleanup(); res.destroy(); };
    const write = frame => {
      if (closed) return;
      if (res.writableLength + Buffer.byteLength(frame) > maxBytes) return disconnect();
      if (waiting) { pending = frame; return; }
      if (!res.write(frame)) {
        waiting = true;
        timer = setTimeout(disconnect, 30000);
        timer.unref?.();
      }
    };
    const send = value => write(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`);
    const drained = () => {
      if (closed) return;
      waiting = false; clearTimeout(timer); timer = null;
      const latest = pending; pending = null;
      if (latest) write(latest);
    };
    const unsubscribe = service.subscribe(send);
    res.on('drain', drained);
    res.on('close', cleanup);
    res.on('error', disconnect);
    send(service.state());
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
