'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough, Writable } = require('node:stream');

const { createApp } = require('../app');

function setupApp(t, { authToken = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-composer-parity-'));
  const dbPath = path.join(tmp, 'test.db');
  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath,
    authResolverOpts: { hasKeychain: () => false },
    masterMemoryXprojectScanEnabled: false,
    authToken,
  });
  t.after(async () => {
    try {
      if (app.shutdown) await app.shutdown();
      else if (app.closeDb) app.closeDb();
    } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return app;
}

function invoke(app, { method = 'GET', url, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
    );
    req.socket = { encrypted: false };
    req.connection = req.socket;

    const out = [];
    const headerMap = new Map();
    const res = new Writable({
      write(chunk, encoding, callback) {
        out.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        callback();
      },
    });
    res.statusCode = 200;
    res.setHeader = (name, value) => {
      headerMap.set(String(name).toLowerCase(), { name, value });
    };
    res.getHeader = (name) => {
      const entry = headerMap.get(String(name).toLowerCase());
      return entry && entry.value;
    };
    res.getHeaders = () => {
      const result = {};
      for (const { name, value } of headerMap.values()) result[String(name).toLowerCase()] = value;
      return result;
    };
    res.removeHeader = (name) => {
      headerMap.delete(String(name).toLowerCase());
    };
    res.writeHead = (statusCode, statusMessage, writeHeaders) => {
      res.statusCode = statusCode;
      const h = (typeof statusMessage === 'object' && statusMessage) || writeHeaders;
      if (h) {
        for (const [name, value] of Object.entries(h)) res.setHeader(name, value);
      }
      return res;
    };
    res.end = (chunk, encoding, callback) => {
      if (chunk) out.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      const text = Buffer.concat(out).toString('utf8');
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (typeof callback === 'function') callback();
      resolve({ status: res.statusCode, text, body, headers: res.getHeaders() });
      return res;
    };

    try {
      req.end();
      app.handle(req, res, reject);
    } catch (err) {
      reject(err);
    }
  });
}

test('GET /api/memory/composer-parity returns parity diagnostics when auth is disabled', async (t) => {
  const app = setupApp(t, { authToken: null });

  const res = await invoke(app, { url: '/api/memory/composer-parity' });

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.parity, 'object');
  assert.equal(typeof res.body.failures, 'object');
  assert.equal(typeof res.body.gateParity, 'object');
  assert.equal(res.body.gateParity.total, 0);
  assert.equal(res.body.gateParity.agree, 0);
  assert.equal(res.body.gateParity.disagree, 0);
});

test('GET /api/memory/composer-parity is auth-protected when a token is configured', async (t) => {
  const app = setupApp(t, { authToken: 'secret-token' });

  const blocked = await invoke(app, { url: '/api/memory/composer-parity' });
  assert.equal(blocked.status, 403);

  const allowed = await invoke(app, {
    url: '/api/memory/composer-parity',
    headers: { Authorization: 'Bearer secret-token' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(typeof allowed.body.parity, 'object');
  assert.equal(typeof allowed.body.failures, 'object');
  assert.equal(typeof allowed.body.gateParity, 'object');
});
