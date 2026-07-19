// PR3a — runtime correctness bundle (P1-8, NEW-B1, NEW-B3, ADD-1, ADD-3).
//
// Five independent server-side fixes sharing a PR because Codex recommended
// grouping them: they all touch failure-recovery, event contract, or error
// routing — the kind of thing you want to validate together rather than
// drip-merge across a week. Each test block is scoped to one finding so
// failures point directly at the regression.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable, Writable } = require('node:stream');

const { createDatabase } = require('../db/database');
const { createRunService, deriveOperatorProjectId } = require('../services/runService');
const { createEventBus } = require('../services/eventBus');
const { createApp } = require('../app');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-rt2-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

async function mkApp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-rt2-app-'));
  const dbPath = path.join(dir, 'test.db');
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-rt2-store-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-rt2-fs-'));
  const app = createApp({
    dbPath, storageRoot, fsRoot,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    else app.closeDb();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
  });
  return app;
}

function httpJson(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = new Readable({
      read() {
        if (payload) this.push(payload);
        this.push(null);
      },
    });
    req.method = method;
    req.url = url;
    req.headers = {
      host: '127.0.0.1',
      ...(payload ? {
        'content-type': 'application/json',
        'content-length': String(payload.length),
      } : {}),
    };

    const chunks = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
    res.getHeader = (name) => res.headers[String(name).toLowerCase()];
    res.removeHeader = (name) => { delete res.headers[String(name).toLowerCase()]; };
    res.writeHead = (statusCode, headers = {}) => {
      res.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      return res;
    };
    res.end = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed = {};
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      if (typeof callback === 'function') callback();
      resolve({ status: res.statusCode, body: parsed, text });
      return res;
    };

    try {
      if (typeof app.handle === 'function') app.handle(req, res);
      else app.emit('request', req, res);
    } catch (err) {
      reject(err);
    }
  });
}

function captureSseUntil(app, url, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = '';
    const req = new Readable({
      read() { this.push(null); },
    });
    req.method = 'GET';
    req.url = url;
    req.headers = { host: '127.0.0.1' };

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setImmediate(() => req.emit('close'));
      fn(value);
    };

    const res = new Writable({
      write(chunk, _encoding, callback) {
        buf += chunk.toString('utf8');
        if (predicate(buf)) done(resolve, buf);
        callback();
      },
    });
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
    res.getHeader = (name) => res.headers[String(name).toLowerCase()];
    res.removeHeader = (name) => { delete res.headers[String(name).toLowerCase()]; };
    res.write = (chunk, encoding, callback) => {
      buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined).toString('utf8');
      if (predicate(buf)) done(resolve, buf);
      if (typeof encoding === 'function') encoding();
      if (typeof callback === 'function') callback();
      return true;
    };
    res.writeHead = (statusCode, headers = {}) => {
      res.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      return res;
    };
    res.flushHeaders = () => {};
    res.end = (chunk, encoding, callback) => {
      if (chunk) buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk, encoding).toString('utf8');
      if (typeof callback === 'function') callback();
      if (!settled) done(resolve, buf);
      return res;
    };

    const timer = setTimeout(() => done(reject, new Error('server_session frame not received in time')), timeoutMs);
    timer.unref();
    try {
      if (typeof app.handle === 'function') app.handle(req, res);
      else app.emit('request', req, res);
    } catch (err) {
      done(reject, err);
    }
  });
}

// ---- ADD-1: deriveOperatorProjectId ----

test('ADD-1 deriveOperatorProjectId: operator:<id> run derives project_id from conversation_id', () => {
  const run = { manager_layer: 'operator', conversation_id: 'operator:proj-123', project_id: null };
  assert.equal(deriveOperatorProjectId(run), 'proj-123');
});

test('ADD-1 deriveOperatorProjectId: top manager stays null', () => {
  const run = { manager_layer: 'top', conversation_id: 'top', project_id: null };
  assert.equal(deriveOperatorProjectId(run), null);
});

test('ADD-1 deriveOperatorProjectId: worker with JOIN-derived project_id wins', () => {
  const run = { manager_layer: null, project_id: 'proj-abc', conversation_id: null };
  assert.equal(deriveOperatorProjectId(run), 'proj-abc');
});

test('ADD-1 deriveOperatorProjectId: operator layer but malformed conversation_id → null', () => {
  assert.equal(deriveOperatorProjectId({ manager_layer: 'operator', conversation_id: 'bogus' }), null);
  assert.equal(deriveOperatorProjectId({ manager_layer: 'operator', conversation_id: 'operator:' }), null);
  assert.equal(deriveOperatorProjectId({ manager_layer: 'operator', conversation_id: null }), null);
});

test('ADD-1 deriveOperatorProjectId: null / undefined run → null', () => {
  assert.equal(deriveOperatorProjectId(null), null);
  assert.equal(deriveOperatorProjectId(undefined), null);
});

test('ADD-1 runService.createRun emits run:status with derived pm project_id', async (t) => {
  const db = await mkdb(t);
  const captured = [];
  const bus = createEventBus();
  bus.subscribe((ev) => { if (ev.channel === 'run:status') captured.push(ev.data); });
  const rs = createRunService(db, bus);
  rs.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:proj-xyz',
    prompt: 'hi',
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].project_id, 'proj-xyz', 'operator run envelope must carry derived project_id');
});

// ---- NEW-B3: operatorCleanupService fail-closed thread clear ----

test('NEW-B3 operatorCleanupService re-throws on operator instance thread clear failure', async (t) => {
  const { createOperatorCleanupService } = require('../services/operatorCleanupService');
  const db = await mkdb(t);
  // Insert a project + operator instance thread so the clear path runs.
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1','P')").run();
  db.prepare("INSERT INTO operator_profiles (id, name, is_private) VALUES ('op_priv_oi_p1', 'Private: oi_p1', 1)").run();
  db.prepare("INSERT INTO operator_instances (id, profile_id, thread_id, pm_adapter) VALUES ('oi_p1', 'op_priv_oi_p1', 'thread-123', 'codex')").run();
  db.prepare("INSERT INTO operator_codebase_refs (instance_id, project_id, role) VALUES ('oi_p1', 'p1', 'primary')").run();

  // Build a minimal fake set of deps. The instance thread clear is the thing
  // we want to detonate.
  const projectService = {
    getProject: (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null,
  };
  const projectBriefService = {};
  const managerRegistry = {
    snapshot: () => ({ top: null, pms: [] }),
    getActiveRunId: () => null,
    getActiveAdapter: () => null,
    clearActive: () => {},
  };
  const runService = {
    updateRunStatus: () => {},
    getRun: () => null,
    resolveOperatorConversationId: () => ({ instanceId: 'oi_p1', legacyProjectId: 'p1' }),
    getOperatorInstance: () => ({ id: 'oi_p1', thread_id: 'thread-123' }),
    setOperatorInstanceThread: () => { throw new Error('simulated sqlite lock'); },
  };
  const managerAdapterFactory = { get: () => null };

  const svc = require('../services/operatorCleanupService').createOperatorCleanupService({
    projectService, projectBriefService, managerRegistry,
    managerAdapterFactory, runService,
  });

  assert.throws(
    () => svc.reset('p1'),
    /operator instance thread clear failed/,
    'reset must re-throw on operator instance thread clear failure (fail-closed)'
  );

  // Verify the thrown error carries httpStatus=503 so the HTTP error
  // handler can route it correctly. 503 > 502 here because the thread
  // store is a local persistence dependency, not an upstream service
  // (Codex PR3a R1 suggestion #2).
  try {
    svc.reset('p1');
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.httpStatus, 503);
  }
});

// ---- P1-8: errorHandler recognizes httpStatus ----

test('P1-8 errorHandler maps err.httpStatus to response status', async (t) => {
  // Build a tiny Express app that throws an error carrying .httpStatus
  // and mount the real errorHandler.
  const express = require('express');
  const { errorHandler } = require('../middleware/errorHandler');
  const app = express();
  app.get('/bang404', (req, res, next) => {
    const e = new Error('not found');
    e.httpStatus = 404;
    next(e);
  });
  app.get('/bang502', (req, res, next) => {
    const e = new Error('bad gateway');
    e.httpStatus = 502;
    next(e);
  });
  app.get('/bang200-ish', (req, res, next) => {
    const e = new Error('legacy .status');
    e.status = 418;
    next(e);
  });
  app.get('/bang-default', (req, res, next) => {
    next(new Error('generic'));
  });
  app.use(errorHandler);

  const r1 = await httpJson(app, 'GET', '/bang404');
  assert.equal(r1.status, 404);
  assert.equal(r1.body.error, 'not found');

  const r2 = await httpJson(app, 'GET', '/bang502');
  assert.equal(r2.status, 502);

  const r3 = await httpJson(app, 'GET', '/bang200-ish');
  assert.equal(r3.status, 418, '.status convention still honored');

  const r4 = await httpJson(app, 'GET', '/bang-default');
  assert.equal(r4.status, 500);
});

// ---- ADD-3: server_session_id in SSE ----

test('ADD-3 eventBus exposes stable serverSessionId', async () => {
  const bus1 = createEventBus();
  const bus2 = createEventBus();
  assert.ok(bus1.serverSessionId, 'serverSessionId must be set');
  assert.match(bus1.serverSessionId, /^[0-9a-f-]{36}$/, 'looks like a uuid');
  assert.notEqual(bus1.serverSessionId, bus2.serverSessionId, 'different bus → different id');
});

test('ADD-3 /api/events emits server_session frame on connect', async (t) => {
  const app = await mkApp(t);
  const buf = await captureSseUntil(
    app,
    '/api/events',
    (text) => text.includes('event: server_session') && text.includes('server_session_id')
  );
  const m = buf.match(/data: (\{[^\n]*\})/);
  assert.ok(m, `no data line in: ${buf}`);
  const parsed = JSON.parse(m[1]);
  assert.match(parsed.server_session_id, /^[0-9a-f-]{36}$/);
});

// ---- NEW-B1: app.js wiring — monitoring starts BEFORE orphan recovery ----

test('NEW-B1 startMonitoring runs before recoverOrphanSessions', async (t) => {
  // We can't easily instrument createApp mid-flight without a larger
  // refactor. Instead, verify the file order statically by reading
  // server/app.js and checking the location of both calls. This is a
  // drift guard — if someone reverses the order again the test fails
  // loudly.
  const src = await fs.readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const startIdx = src.indexOf('lifecycleService.startMonitoring()');
  const recoverIdx = src.indexOf('lifecycleService.recoverOrphanSessions()');
  assert.ok(startIdx >= 0, 'startMonitoring call missing');
  assert.ok(recoverIdx >= 0, 'recoverOrphanSessions call missing');
  assert.ok(
    startIdx < recoverIdx,
    `startMonitoring must precede recoverOrphanSessions in app.js (start@${startIdx}, recover@${recoverIdx})`
  );
});
