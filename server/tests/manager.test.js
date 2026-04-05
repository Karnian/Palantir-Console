const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await createTempDir('palantir-mgr-storage-');
  const fsRoot = await createTempDir('palantir-mgr-fs-');
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode' });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
  });

  return { app, storageRoot, fsRoot };
}

// --- Manager API Tests ---

test('GET /api/manager/status returns inactive when no session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/manager/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
  assert.equal(res.body.run, null);
});

test('POST /api/manager/message returns 404 when no active session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/manager/message')
    .send({ text: 'hello' });
  assert.equal(res.status, 404);
});

test('POST /api/manager/stop returns no_active_session when no session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).post('/api/manager/stop');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'no_active_session');
});

test('GET /api/manager/events returns empty when no session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/manager/events');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, []);
});

test('GET /api/manager/output returns null when no session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/manager/output');
  assert.equal(res.status, 200);
  assert.equal(res.body.output, null);
});

// --- StreamJsonEngine Unit Tests ---

test('StreamJsonEngine module exports createStreamJsonEngine', async (t) => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  assert.equal(typeof createStreamJsonEngine, 'function');

  const engine = createStreamJsonEngine({});
  assert.equal(engine.type, 'stream-json');
  assert.equal(typeof engine.spawnAgent, 'function');
  assert.equal(typeof engine.sendInput, 'function');
  assert.equal(typeof engine.getOutput, 'function');
  assert.equal(typeof engine.getEvents, 'function');
  assert.equal(typeof engine.getUsage, 'function');
  assert.equal(typeof engine.kill, 'function');
  assert.equal(typeof engine.isAlive, 'function');
  assert.equal(typeof engine.detectExitCode, 'function');
});

test('StreamJsonEngine.isAlive returns false for unknown runId', async (t) => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const engine = createStreamJsonEngine({});
  assert.equal(engine.isAlive('nonexistent'), false);
  assert.equal(engine.detectExitCode('nonexistent'), null);
  assert.equal(engine.getOutput('nonexistent'), null);
  assert.deepEqual(engine.getEvents('nonexistent'), []);
  assert.equal(engine.getUsage('nonexistent'), null);
  assert.equal(engine.getSessionId('nonexistent'), null);
  assert.equal(engine.kill('nonexistent'), false);
  assert.equal(engine.sendInput('nonexistent', 'test'), false);
});

test('StreamJsonEngine.listSessions returns empty array initially', async (t) => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const engine = createStreamJsonEngine({});
  assert.deepEqual(engine.listSessions(), []);
  assert.deepEqual(engine.discoverGhostSessions(), []);
});

// --- DB Migration Tests ---

test('002 migration adds manager columns to runs', async (t) => {
  const { createDatabase } = require('../db/database');
  const dbPath = path.join(os.tmpdir(), `palantir-mgr-test-${Date.now()}.db`);
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();

  t.after(async () => {
    close();
    await fs.unlink(dbPath).catch(() => {});
  });

  // Check that is_manager column exists
  const info = db.pragma('table_info(runs)');
  const columnNames = info.map(c => c.name);
  assert.ok(columnNames.includes('is_manager'), 'is_manager column should exist');
  assert.ok(columnNames.includes('parent_run_id'), 'parent_run_id column should exist');
  assert.ok(columnNames.includes('claude_session_id'), 'claude_session_id column should exist');

  // Insert a manager run
  db.prepare(`
    INSERT INTO runs (id, task_id, agent_profile_id, prompt, status, is_manager)
    VALUES ('run_mgr_test', NULL, NULL, 'test prompt', 'queued', 1)
  `).run();

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('run_mgr_test');
  assert.equal(run.is_manager, 1);
  assert.equal(run.task_id, null);
});

// --- RunService Manager Methods ---

test('runService.getActiveManager returns null when no manager', async (t) => {
  const { createDatabase } = require('../db/database');
  const { createRunService } = require('../services/runService');
  const dbPath = path.join(os.tmpdir(), `palantir-runsvc-test-${Date.now()}.db`);
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();

  t.after(async () => {
    close();
    await fs.unlink(dbPath).catch(() => {});
  });

  const runService = createRunService(db, null);
  const mgr = runService.getActiveManager();
  assert.equal(mgr, null);
});

test('runService.createRun with is_manager allows null task_id', async (t) => {
  const { createDatabase } = require('../db/database');
  const { createRunService } = require('../services/runService');
  const dbPath = path.join(os.tmpdir(), `palantir-runsvc-mgr-${Date.now()}.db`);
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();

  t.after(async () => {
    close();
    await fs.unlink(dbPath).catch(() => {});
  });

  const runService = createRunService(db, null);
  const run = runService.createRun({
    is_manager: true,
    prompt: 'Manager test',
  });

  assert.ok(run.id.startsWith('run_mgr_'));
  assert.equal(run.status, 'queued');
  assert.equal(run.task_id, null);
});
