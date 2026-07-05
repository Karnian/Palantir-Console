'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Duplex, Writable } = require('node:stream');
const { createNodesRouter } = require('../routes/nodes');
const { errorHandler } = require('../middleware/errorHandler');

// N3-1 SERIOUS (Codex review): uncordoning a node (cordoned 1→0) via PATCH must
// wake that node's queue via lifecycleService.scheduleDrainForNode, mirroring
// the heartbeat-recovery drain (N0-2). Without it, queued runs pinned to the
// node stay asleep until the next run:ended or a server restart.

function createRouteApp({ nodeService, lifecycleService }) {
  const app = express();
  app.use(express.json());
  app.use('/api/nodes', createNodesRouter({ nodeService, lifecycleService }));
  app.use(errorHandler);
  return app;
}

// Same lightweight in-process dispatch harness used by projects-route.test.js.
function dispatch(app, method, url, body = undefined) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const socket = new Duplex({ read() {}, write(chunk, enc, cb) { cb(); } });
    socket.encrypted = false;
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = {
      host: 'localhost',
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
    };
    process.nextTick(() => { req.push(payload); req.push(null); });

    const chunks = [];
    const headers = new Map();
    let resolved = false;
    const res = new Writable({ write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    res.statusCode = 200;
    res.setHeader = (name, value) => { headers.set(String(name).toLowerCase(), value); };
    res.getHeader = (name) => headers.get(String(name).toLowerCase());
    res.getHeaders = () => Object.fromEntries(headers);
    res.removeHeader = (name) => { headers.delete(String(name).toLowerCase()); };
    res.writeHead = (statusCode, reasonOrHeaders, maybeHeaders) => {
      res.statusCode = statusCode;
      const headerValues = typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
      for (const [name, value] of Object.entries(headerValues || {})) res.setHeader(name, value);
      return res;
    };
    res.end = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof cb === 'function') cb();
      if (!resolved) {
        resolved = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
        resolve({ status: res.statusCode, body: parsed, text });
      }
      return res;
    };

    app.handle(req, res, (err) => {
      if (err) { if (!resolved) { resolved = true; reject(err); } return; }
      if (!resolved) { resolved = true; resolve({ status: res.statusCode || 404, body: {}, text: '' }); }
    });
  });
}

function fakeNodeService(before, after) {
  return { getNode: () => before, updateNode: () => after };
}

test('PATCH uncordon (cordoned 1→0) triggers scheduleDrainForNode', async () => {
  const drained = [];
  const app = createRouteApp({
    nodeService: fakeNodeService({ id: 'pod-a', cordoned: 1 }, { id: 'pod-a', cordoned: 0 }),
    lifecycleService: { scheduleDrainForNode: (id) => drained.push(id) },
  });
  const res = await dispatch(app, 'PATCH', '/api/nodes/pod-a', { cordoned: 0 });
  assert.equal(res.status, 200);
  assert.deepEqual(drained, ['pod-a']);
});

test('PATCH cordon (0→1) does NOT trigger drain', async () => {
  const drained = [];
  const app = createRouteApp({
    nodeService: fakeNodeService({ id: 'pod-a', cordoned: 0 }, { id: 'pod-a', cordoned: 1 }),
    lifecycleService: { scheduleDrainForNode: (id) => drained.push(id) },
  });
  const res = await dispatch(app, 'PATCH', '/api/nodes/pod-a', { cordoned: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(drained, []);
});

test('PATCH unrelated field on a cordoned node does NOT trigger drain', async () => {
  const drained = [];
  const app = createRouteApp({
    nodeService: fakeNodeService({ id: 'pod-a', cordoned: 1 }, { id: 'pod-a', cordoned: 1 }),
    lifecycleService: { scheduleDrainForNode: (id) => drained.push(id) },
  });
  const res = await dispatch(app, 'PATCH', '/api/nodes/pod-a', { max_concurrent: 3 });
  assert.equal(res.status, 200);
  assert.deepEqual(drained, []);
});

test('PATCH uncordon without lifecycleService wired is a no-op (no throw)', async () => {
  const app = createRouteApp({
    nodeService: fakeNodeService({ id: 'pod-a', cordoned: 1 }, { id: 'pod-a', cordoned: 0 }),
    lifecycleService: undefined,
  });
  const res = await dispatch(app, 'PATCH', '/api/nodes/pod-a', { cordoned: 0 });
  assert.equal(res.status, 200);
});
