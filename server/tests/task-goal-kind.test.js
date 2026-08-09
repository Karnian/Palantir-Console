const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const request = require('supertest');
const { createApp } = require('../app');
const { createDatabase } = require('../db/database');

async function makeTempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function createTestApp(t) {
  const root = await makeTempDir(t, 'task-goal-kind-');
  const dbPath = path.join(root, 'test.db');
  const app = createApp({
    storageRoot: path.join(root, 'storage'),
    fsRoot: path.join(root, 'fs'),
    dbPath,
    opencodeBin: 'opencode',
    authResolverOpts: { hasKeychain: () => false },
    authToken: null,
  });
  t.after(() => {
    if (app.shutdown) app.shutdown();
    else app.closeDb();
  });
  return { app, dbPath };
}

// Pins migration compatibility: every pre-089 task keeps its behavior as deliverable.
test('migration assigns deliverable to existing tasks', async (t) => {
  const handle = createDatabase(':memory:');
  t.after(() => handle.close());
  handle.migrate();
  const { db } = handle;
  db.prepare('INSERT INTO tasks (id, title, goal_enabled) VALUES (?, ?, ?)')
    .run('existing', 'Existing task', 0);

  assert.equal(db.prepare('SELECT goal_kind FROM tasks WHERE id = ?').get('existing').goal_kind, 'deliverable');
});

// Pins the HTTP contract: an out-of-domain goal_kind is a client error, never a 500.
test('create rejects an invalid goal_kind with 400', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).post('/api/tasks').send({ title: 'invalid kind', goal_kind: 'other' });
  assert.equal(res.status, 400);
});

// Pins the CREATE path of the cross-column invariant. Without service-level
// pre-validation the migration 089 CHECK surfaces as a raw SqliteError, which
// the error handler reports as 500 — a server fault for what is a client
// mistake. Removing the pre-check in taskService must fail THIS test; the
// update-path test below does not cover create.
test('create rejects action without an enabled goal with 400', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).post('/api/tasks').send({ title: 'unpaired action', goal_kind: 'action' });
  assert.equal(res.status, 400);
});

// Pins merged-state validation: action cannot be selected while the resulting goal is disabled.
test('update rejects final action plus disabled goal with 400', async (t) => {
  const { app } = await createTestApp(t);
  const created = await request(app).post('/api/tasks').send({ title: 'disabled action' });
  const res = await request(app)
    .patch(`/api/tasks/${created.body.task.id}`)
    .send({ goal_kind: 'action' });
  assert.equal(res.status, 400);
});

// Pins the valid paired transition and persistence in the API read model.
test('action plus enabled goal succeeds and is returned', async (t) => {
  const { app } = await createTestApp(t);
  const created = await request(app).post('/api/tasks').send({
    title: 'enabled action',
    goal_kind: 'action',
    goal_enabled: 1,
  });
  assert.equal(created.status, 201);

  const fetched = await request(app).get(`/api/tasks/${created.body.task.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.task.goal_kind, 'action');
  assert.equal(fetched.body.task.goal_enabled, 1);
});

// Pins the database as the last line of defense when callers bypass taskService.
test('raw SQL rejects action with a disabled goal', async (t) => {
  const { app, dbPath } = await createTestApp(t);
  const created = await request(app).post('/api/tasks').send({ title: 'raw guard' });
  const db = new Database(dbPath);
  t.after(() => db.close());

  assert.throws(
    () => db.prepare("UPDATE tasks SET goal_kind = 'action', goal_enabled = 0 WHERE id = ?")
      .run(created.body.task.id),
    /CHECK constraint failed: goal_kind != 'action' OR goal_enabled = 1/,
  );
});
