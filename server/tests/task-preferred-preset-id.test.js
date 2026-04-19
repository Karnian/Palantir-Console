// Gap #1 — PATCH /api/tasks/:id preferred_preset_id validation
// null is allowed; valid preset id passes; unknown id → 400; deleted preset id → 400.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function mkdirTemp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await mkdirTemp('palantir-storage-');
  const fsRoot = await mkdirTemp('palantir-fs-');
  const dbDir = await mkdirTemp('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  const app = createApp({
    storageRoot, fsRoot, opencodeBin: 'opencode', dbPath, pluginsRoot,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown(); else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(pluginsRoot, { recursive: true, force: true });
  });
  return app;
}

// Helpers

async function createTask(app, body = {}) {
  const res = await request(app).post('/api/tasks').send({ title: 'Test task', ...body });
  assert.equal(res.status, 201);
  return res.body.task;
}

async function createPreset(app, name = 'test-preset') {
  const res = await request(app).post('/api/worker-presets').send({ name });
  assert.equal(res.status, 201);
  return res.body.preset;
}

// ─── POST Tests (Gap #2) ─────────────────────────────────────────────────────

test('POST /api/tasks — valid preferred_preset_id is accepted', async (t) => {
  const app = await createTestApp(t);
  const preset = await createPreset(app, 'post-preset');
  const res = await request(app)
    .post('/api/tasks')
    .send({ title: 'Task with preset', preferred_preset_id: preset.id });
  assert.equal(res.status, 201);
  assert.equal(res.body.task.preferred_preset_id, preset.id);
});

test('POST /api/tasks — unknown preferred_preset_id → 400', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app)
    .post('/api/tasks')
    .send({ title: 'Bad preset', preferred_preset_id: 'does_not_exist' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown preset id/);
});

test('POST /api/tasks — preferred_preset_id null is accepted', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app)
    .post('/api/tasks')
    .send({ title: 'Null preset', preferred_preset_id: null });
  assert.equal(res.status, 201);
});

test('POST /api/tasks — omitting preferred_preset_id works normally', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app)
    .post('/api/tasks')
    .send({ title: 'No preset' });
  assert.equal(res.status, 201);
  assert.equal(res.body.task.preferred_preset_id ?? null, null);
});

// ─── PATCH Tests (Gap #1) ────────────────────────────────────────────────────

test('PATCH /api/tasks/:id — preferred_preset_id null is accepted', async (t) => {
  const app = await createTestApp(t);
  const task = await createTask(app);
  const res = await request(app)
    .patch(`/api/tasks/${task.id}`)
    .send({ preferred_preset_id: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.preferred_preset_id ?? null, null);
});

test('PATCH /api/tasks/:id — valid preset id is accepted', async (t) => {
  const app = await createTestApp(t);
  const task = await createTask(app);
  const preset = await createPreset(app, 'my-preset');
  const res = await request(app)
    .patch(`/api/tasks/${task.id}`)
    .send({ preferred_preset_id: preset.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.preferred_preset_id, preset.id);
});

test('PATCH /api/tasks/:id — unknown preset id → 400', async (t) => {
  const app = await createTestApp(t);
  const task = await createTask(app);
  const res = await request(app)
    .patch(`/api/tasks/${task.id}`)
    .send({ preferred_preset_id: 'preset_does_not_exist' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown preset id/);
});

test('PATCH /api/tasks/:id — deleted preset id → 400', async (t) => {
  const app = await createTestApp(t);
  const task = await createTask(app);
  const preset = await createPreset(app, 'soon-deleted');

  // Assign the preset first
  const link = await request(app)
    .patch(`/api/tasks/${task.id}`)
    .send({ preferred_preset_id: preset.id });
  assert.equal(link.status, 200);

  // Delete the preset
  const del = await request(app).delete(`/api/worker-presets/${preset.id}`);
  assert.equal(del.status, 200);

  // Try to assign the now-deleted preset id to a NEW task → 400
  const task2 = await createTask(app);
  const res = await request(app)
    .patch(`/api/tasks/${task2.id}`)
    .send({ preferred_preset_id: preset.id });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown preset id/);
});

test('PATCH /api/tasks/:id — omitting preferred_preset_id leaves existing value intact', async (t) => {
  const app = await createTestApp(t);
  const preset = await createPreset(app, 'stable-preset');
  const task = await createTask(app);
  // First, link the preset
  await request(app)
    .patch(`/api/tasks/${task.id}`)
    .send({ preferred_preset_id: preset.id });
  // Then update something else — preset link must survive
  const res = await request(app)
    .patch(`/api/tasks/${task.id}`)
    .send({ title: 'Updated title' });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.preferred_preset_id, preset.id);
});
