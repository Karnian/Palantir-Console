// R2-C.1: GET /api/manager/summary aggregation tests.
//
// These cover the five pieces of the response shape and the invariants the
// ManagerChat SuggestedActions strip depends on:
//   1. empty state (no runs at all) → zeros across the board
//   2. mixed worker state (running / needs_input / failed / completed)
//   3. is_manager=1 rows are NEVER counted (Top/PM sessions would otherwise
//      skew the "active"/"completed_today" counters)
//   4. cost_usd NULL rows don't break SUM
//   5. completed_today uses local-timezone day boundary (we can't time-travel
//      inside node --test, so this test asserts the positive side: freshly
//      inserted "today" rows ARE counted; the negative side is covered by a
//      manual yesterday-row fixture that backdates created_at)
//
// We drive the endpoint through supertest + createApp so the route wiring
// (asyncHandler, auth-disabled-when-no-token, JSON shape) is also exercised.

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
  const storageRoot = await createTempDir('palantir-summary-storage-');
  const fsRoot = await createTempDir('palantir-summary-fs-');
  const dbDir = await createTempDir('palantir-summary-db-');
  const dbPath = path.join(dbDir, 'test.db');
  // authToken: null — prevent sibling tests' PALANTIR_TOKEN from leaking
  // into this suite (CLAUDE.md "preset-route.test.js" pattern note).
  const app = createApp({
    storageRoot,
    fsRoot,
    opencodeBin: 'opencode',
    dbPath,
    authToken: null,
  });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  return app;
}

// Direct DB insertion helper. We bypass runService.createRun() on purpose:
// createRun() forces status='queued' and zero cost, but we need to fabricate
// arbitrary state (failed runs, cost_usd present/null, backdated created_at).
function insertRun(app, row) {
  // Same columns as migrations/001 + later preset/cost columns. created_at is
  // only written when explicitly overridden — otherwise SQLite's default
  // (datetime('now')) fires.
  const db = app.services.runService.__db__ || null;
  // runService doesn't expose its db handle, so reach through services.
  // Tests only — production has no reason to touch raw SQL here.
  const rawDb = app.services._rawDb;
  const handle = rawDb || db;
  if (!handle) throw new Error('app.services._rawDb not wired for tests');

  const stmt = handle.prepare(`
    INSERT INTO runs (id, task_id, agent_profile_id, prompt, status, is_manager, cost_usd, created_at)
    VALUES (@id, @task_id, @agent_profile_id, @prompt, @status, @is_manager, @cost_usd,
            COALESCE(@created_at, datetime('now')))
  `);
  stmt.run({
    id: row.id,
    task_id: row.task_id || null,
    agent_profile_id: row.agent_profile_id || null,
    prompt: row.prompt || 'test',
    status: row.status,
    is_manager: row.is_manager ? 1 : 0,
    cost_usd: row.cost_usd === undefined ? null : row.cost_usd,
    created_at: row.created_at || null,
  });
}

test('GET /api/manager/summary returns all zeros on empty DB', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/manager/summary');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    active: 0,
    needs_input: 0,
    failed: 0,
    completed_today: 0,
    total_cost_today: 0,
  });
});

test('GET /api/manager/summary aggregates mixed worker states', async (t) => {
  const app = await createTestApp(t);
  // 2 running, 1 needs_input, 1 failed, 2 completed (today), 1 completed yesterday
  insertRun(app, { id: 'r1', status: 'running', is_manager: 0, cost_usd: 0.01 });
  insertRun(app, { id: 'r2', status: 'running', is_manager: 0, cost_usd: 0.02 });
  insertRun(app, { id: 'r3', status: 'needs_input', is_manager: 0, cost_usd: 0.03 });
  insertRun(app, { id: 'r4', status: 'failed', is_manager: 0, cost_usd: 0.04 });
  insertRun(app, { id: 'r5', status: 'completed', is_manager: 0, cost_usd: 0.05 });
  insertRun(app, { id: 'r6', status: 'completed', is_manager: 0, cost_usd: 0.06 });
  // Yesterday row (backdated) — must NOT be counted in completed_today or
  // total_cost_today. Use 2 days ago to avoid timezone edge cases around
  // midnight local vs UTC.
  insertRun(app, {
    id: 'r7',
    status: 'completed',
    is_manager: 0,
    cost_usd: 99.99,
    created_at: "datetime('now','-2 days')", // gets swapped via raw SQL below
  });
  // SQLite COALESCE + literal-string param above would make 'datetime(...)' a
  // bare string, not a function. Rewrite r7 with a direct UPDATE so the value
  // is evaluated as SQL.
  app.services._rawDb
    .prepare(`UPDATE runs SET created_at = datetime('now','-2 days') WHERE id = 'r7'`)
    .run();

  // Manager rows (must be excluded)
  insertRun(app, { id: 'rm1', status: 'running', is_manager: 1, cost_usd: 1.23 });
  insertRun(app, { id: 'rm2', status: 'needs_input', is_manager: 1, cost_usd: 0 });
  insertRun(app, { id: 'rm3', status: 'failed', is_manager: 1 }); // cost_usd: NULL

  const res = await request(app).get('/api/manager/summary');
  assert.equal(res.status, 200);
  assert.equal(res.body.active, 3, 'active = running(2) + needs_input(1) for workers only');
  assert.equal(res.body.needs_input, 1);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.completed_today, 2, 'yesterday\'s completed row must be excluded');
  // 0.01 + 0.02 + 0.03 + 0.04 + 0.05 + 0.06 = 0.21 (2-day-old row excluded)
  assert.ok(
    Math.abs(res.body.total_cost_today - 0.21) < 1e-9,
    `expected ~0.21 got ${res.body.total_cost_today}`
  );
});

test('GET /api/manager/summary excludes manager runs (is_manager=1)', async (t) => {
  // Dedicated test for lock-in #1 of this endpoint — manager rows must
  // never inflate the worker counters. A regression here would make
  // SuggestedActions show "N agents need input" for Top/PM sessions.
  const app = await createTestApp(t);
  insertRun(app, { id: 'mgr1', status: 'running', is_manager: 1, cost_usd: 5 });
  insertRun(app, { id: 'mgr2', status: 'needs_input', is_manager: 1, cost_usd: 7 });
  insertRun(app, { id: 'mgr3', status: 'failed', is_manager: 1, cost_usd: 2 });
  insertRun(app, { id: 'mgr4', status: 'completed', is_manager: 1, cost_usd: 10 });

  const res = await request(app).get('/api/manager/summary');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    active: 0,
    needs_input: 0,
    failed: 0,
    completed_today: 0,
    total_cost_today: 0,
  });
});

test('GET /api/manager/summary handles NULL cost_usd without NaN', async (t) => {
  // NULL cost_usd (the default for runs that never got a final
  // updateRunResult call — e.g. still-running, or older rows before
  // cost tracking) must not poison the SUM. Number(null) is 0 in JS
  // but Number(undefined) is NaN, so we lean on the implementation to
  // guard both.
  const app = await createTestApp(t);
  insertRun(app, { id: 'n1', status: 'running', is_manager: 0 }); // cost_usd NULL
  insertRun(app, { id: 'n2', status: 'completed', is_manager: 0 }); // cost_usd NULL
  insertRun(app, { id: 'n3', status: 'completed', is_manager: 0, cost_usd: 0.5 });

  const res = await request(app).get('/api/manager/summary');
  assert.equal(res.status, 200);
  assert.equal(res.body.active, 1);
  assert.equal(res.body.completed_today, 2);
  assert.equal(typeof res.body.total_cost_today, 'number');
  assert.ok(
    !Number.isNaN(res.body.total_cost_today),
    'total_cost_today must be a finite number, got ' + res.body.total_cost_today
  );
  assert.ok(Math.abs(res.body.total_cost_today - 0.5) < 1e-9);
});

test('GET /api/manager/summary counts active as running + needs_input only', async (t) => {
  // Explicit contract: `active` is the operational "needs monitoring"
  // bucket. completed/failed/cancelled/stopped/paused/queued do NOT
  // count. This is what the SuggestedActions "모두 idle" rule depends on.
  const app = await createTestApp(t);
  insertRun(app, { id: 'q1', status: 'queued', is_manager: 0 });
  insertRun(app, { id: 'p1', status: 'paused', is_manager: 0 });
  insertRun(app, { id: 's1', status: 'stopped', is_manager: 0 });
  insertRun(app, { id: 'c1', status: 'cancelled', is_manager: 0 });
  insertRun(app, { id: 'r1', status: 'running', is_manager: 0 });
  insertRun(app, { id: 'n1', status: 'needs_input', is_manager: 0 });

  const res = await request(app).get('/api/manager/summary');
  assert.equal(res.status, 200);
  assert.equal(res.body.active, 2, 'queued/paused/stopped/cancelled are NOT active');
  assert.equal(res.body.needs_input, 1);
});
