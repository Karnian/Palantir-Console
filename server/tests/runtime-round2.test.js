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
const request = require('supertest');

const { createDatabase } = require('../db/database');
const { createRunService, derivePmProjectId } = require('../services/runService');
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

// ---- ADD-1: derivePmProjectId ----

test('ADD-1 derivePmProjectId: pm:<id> run derives project_id from conversation_id', () => {
  const run = { manager_layer: 'pm', conversation_id: 'pm:proj-123', project_id: null };
  assert.equal(derivePmProjectId(run), 'proj-123');
});

test('ADD-1 derivePmProjectId: top manager stays null', () => {
  const run = { manager_layer: 'top', conversation_id: 'top', project_id: null };
  assert.equal(derivePmProjectId(run), null);
});

test('ADD-1 derivePmProjectId: worker with JOIN-derived project_id wins', () => {
  const run = { manager_layer: null, project_id: 'proj-abc', conversation_id: null };
  assert.equal(derivePmProjectId(run), 'proj-abc');
});

test('ADD-1 derivePmProjectId: pm layer but malformed conversation_id → null', () => {
  assert.equal(derivePmProjectId({ manager_layer: 'pm', conversation_id: 'bogus' }), null);
  assert.equal(derivePmProjectId({ manager_layer: 'pm', conversation_id: 'pm:' }), null);
  assert.equal(derivePmProjectId({ manager_layer: 'pm', conversation_id: null }), null);
});

test('ADD-1 derivePmProjectId: null / undefined run → null', () => {
  assert.equal(derivePmProjectId(null), null);
  assert.equal(derivePmProjectId(undefined), null);
});

test('ADD-1 runService.createRun emits run:status with derived pm project_id', async (t) => {
  const db = await mkdb(t);
  const captured = [];
  const bus = createEventBus();
  bus.subscribe((ev) => { if (ev.channel === 'run:status') captured.push(ev.data); });
  const rs = createRunService(db, bus);
  rs.createRun({
    is_manager: true,
    manager_layer: 'pm',
    conversation_id: 'pm:proj-xyz',
    prompt: 'hi',
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].project_id, 'proj-xyz', 'pm run envelope must carry derived project_id');
});

// ---- NEW-B3: pmCleanupService fail-closed brief clear ----

test('NEW-B3 pmCleanupService re-throws on brief clear failure', async (t) => {
  const { createPmCleanupService } = require('../services/pmCleanupService');
  const db = await mkdb(t);
  // Insert a project + brief with a pm_thread_id so the clear path runs.
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1','P')").run();
  db.prepare(`
    INSERT INTO project_briefs (project_id, pm_thread_id, pm_adapter)
    VALUES ('p1', 'thread-123', 'codex')
  `).run();

  // Build a minimal fake set of deps. The brief service is the thing we
  // want to detonate on clear.
  const projectService = {
    getProject: (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null,
  };
  const projectBriefService = {
    getBrief: (id) => db.prepare('SELECT * FROM project_briefs WHERE project_id = ?').get(id) || null,
    clearPmThread: () => { throw new Error('simulated sqlite lock'); },
  };
  const managerRegistry = {
    snapshot: () => ({ top: null, pms: [] }),
    getActiveRunId: () => null,
    getActiveAdapter: () => null,
    clearActive: () => {},
  };
  const runService = { updateRunStatus: () => {}, getRun: () => null };
  const managerAdapterFactory = { get: () => null };

  const svc = require('../services/pmCleanupService').createPmCleanupService({
    projectService, projectBriefService, managerRegistry,
    managerAdapterFactory, runService,
  });

  assert.throws(
    () => svc.reset('p1'),
    /pm brief clear failed/,
    'reset must re-throw on brief clear failure (fail-closed)'
  );

  // Verify the thrown error carries httpStatus=503 so the HTTP error
  // handler can route it correctly. 503 > 502 here because the brief
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

  const r1 = await request(app).get('/bang404');
  assert.equal(r1.status, 404);
  assert.equal(r1.body.error, 'not found');

  const r2 = await request(app).get('/bang502');
  assert.equal(r2.status, 502);

  const r3 = await request(app).get('/bang200-ish');
  assert.equal(r3.status, 418, '.status convention still honored');

  const r4 = await request(app).get('/bang-default');
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
  const http = require('node:http');

  await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          // First frame should arrive quickly (flushHeaders + server_session emit)
          if (buf.includes('event: server_session') && buf.includes('server_session_id')) {
            try {
              const m = buf.match(/data: (\{[^\n]*\})/);
              assert.ok(m, `no data line in: ${buf}`);
              const parsed = JSON.parse(m[1]);
              assert.match(parsed.server_session_id, /^[0-9a-f-]{36}$/);
              req.destroy();
              res.destroy();
              server.close(() => resolve());
            } catch (err) {
              req.destroy();
              res.destroy();
              server.close(() => reject(err));
            }
          }
        });
      });
      req.on('error', (err) => {
        if (String(err.message).match(/hang up|aborted|ECONNRESET/i)) return;
        server.close(() => reject(err));
      });
    });
    setTimeout(() => reject(new Error('server_session frame not received in time')), 5000).unref();
  });
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
