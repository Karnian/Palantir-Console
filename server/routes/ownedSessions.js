'use strict';
const express = require('express');
const { requireSessionHubCookie } = require('../middleware/sessionHubCookie');
const { MAX_BODY_BYTES, validateIncarnation } = require('../services/ownedSessionService');
const invalid = code => Object.assign(new Error(code), { code, status: 400 });
function createOwnedSessionsRouter({ service }) {
  const router = express.Router();
  router.use(requireSessionHubCookie);
  router.use(express.json({ limit: MAX_BODY_BYTES }));
  const handle = operation => async (req, res, next) => {
    try {
      const value = await operation(req);
      const status = value?.found === false ? 404 : value?.acceptance === 'rejected' && value.code === 'fingerprint_conflict' ? 409 : 200;
      res.status(status).json(value);
    } catch (error) { next(error); }
  };
  router.get('/', handle(() => service.list()));
  router.post('/reconnect', handle(() => service.reconnect()));
  router.post('/requests/:request_key/abandon', handle(req => service.abandon(req.params.request_key)));
  router.get('/requests/:request_key', handle(req => service.lookup(req.params.request_key)));
  router.get('/stream', (req, res, next) => {
    const since = Number(req.query.since);
    if (typeof req.query.since !== 'string' || !/^\d+$/.test(req.query.since) || !Number.isSafeInteger(since)) {
      return next(invalid('invalid_since'));
    }
    let unsubscribe;
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; unsubscribe?.(); };
    try {
      unsubscribe = service.subscribe(since, (event, data) => {
        if (closed) return;
        if (event === 'shutdown') { cleanup(); res.end(); return; }
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        // Disconnect a slow reader; its last sequence can be replayed on a new connection.
        if (res.writableLength > 2 * 1024 * 1024) { cleanup(); res.destroy(); return; }
        res.write(frame);
      });
      res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
    } catch (error) { cleanup(); next(error); }
  });
  router.get('/:id/chunks', handle(req => {
    const { source, ref } = req.query;
    const raw = req.query.offset ?? '0';
    if (!['event', 'delivery_body', 'tool_input'].includes(source) || typeof ref !== 'string' || !ref || ref.length > 256 ||
        typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw invalid('invalid_chunk');
    return service.chunk(req.params.id, source, ref, Number(raw));
  }));
  router.get('/:id', handle(req => service.snapshot(req.params.id)));
  router.get('/:id/transcript', handle(req => {
    const number = (value, fallback) => {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid('invalid_request');
      return Number(value);
    };
    const before = number(req.query.before_seq, undefined);
    const limit = number(req.query.limit, 50);
    if (limit < 1 || limit > 100) throw invalid('invalid_request');
    return service.transcript(req.params.id, before, limit);
  }));
  router.post('/settings-preview', handle(req => {
    if (req.body?.node_id !== undefined && req.body.node_id !== 'local') throw invalid('local_node_required');
    return service.settingsPreview(req.body?.cwd);
  }));
  router.post('/start', handle(req => {
    const body = req.body || {};
    if (body.confirmed_settings !== true) throw invalid('settings_confirmation_required');
    return service.submit({ kind: 'start', request_key: body.request_key, cwd: body.cwd,
      confirmed_settings: body.confirmed_settings, ...(body.node_id !== undefined ? { node_id: body.node_id } : {}) });
  }));
  for (const [route, kind] of [['prompt', 'prompt'], ['tool-decision', 'tool_decision'], ['question-answer', 'question_answer'],
    ['interrupt', 'interrupt'], ['stop', 'stop'], ['resume', 'resume'], ['close', 'close'], ['handoff', 'handoff']]) {
    router.post(`/:id/${route}`, handle(req => {
      const input = req.body || {};
      const request = { kind, request_key: input.request_key, session_id: req.params.id };
      if (['prompt', 'tool_decision', 'question_answer', 'interrupt', 'handoff'].includes(kind)) {
        request.incarnation_id = validateIncarnation(input.incarnation_id);
      }
      if (kind === 'prompt') {
        if (typeof input.body !== 'string' || !input.body.trim()) throw invalid('invalid_body');
        request.body = input.body;
      }
      if (kind === 'tool_decision' || kind === 'question_answer') {
        if (typeof input.tool_use_id !== 'string' || !input.tool_use_id) throw invalid('invalid_tool_use_id');
        request.target_tool_use_id = input.tool_use_id;
        if (kind === 'tool_decision') {
          if (!['allow', 'deny'].includes(input.behavior) || input.message !== undefined && typeof input.message !== 'string') {
            throw invalid('invalid_decision');
          }
          request.body = { behavior: input.behavior, ...(input.message !== undefined ? { message: input.message } : {}) };
        } else {
          if (input.answer === undefined) throw invalid('invalid_answer');
          request.body = { answer: input.answer };
        }
      }
      return service.submit(request);
    }));
  }
  router.delete('/:id', handle(req => service.submit({ kind: 'delete', session_id: req.params.id, request_key: req.body?.request_key })));
  router.use((req, res) => res.status(404).json({ error: 'not_found', reason: 'not_found' }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const parse = error.type === 'entity.parse.failed' || error.type === 'entity.too.large';
    const code = parse ? 'invalid_body' : error.code || 'host_unreachable';
    res.status(parse ? 400 : error.status || 503).json({ error: code, reason: code });
  });
  return router;
}
module.exports = { createOwnedSessionsRouter };
