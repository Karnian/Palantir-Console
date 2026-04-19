// D3-3 — createApp wiring: validatePresetId injected through taskService
//
// Codex review (Round 2) feedback: HTTP integration tests cannot bypass the
// route-layer guard (tasks.js checks presetService.getPreset before calling
// taskService.updateTask), so they cannot verify D2c service-layer wiring in
// isolation. This file adds:
//
//   Part A — Service-layer wiring (real DB, no HTTP):
//     Directly wires createPresetService + createTaskService with the same
//     injection pattern used in app.js (validatePresetId = presetService.getPreset).
//     Calls taskService.updateTask() directly → confirms service rejects unknown ids
//     even when the route guard is absent. This is the definitive D2c wiring test.
//
//   Part B — HTTP integration (createApp, real server, supertest):
//     Smoke-tests the end-to-end path. Documents that creation does NOT validate
//     preferred_preset_id (known spec boundary), and that PATCH rejects unknown ids.
//     These tests duplicate some coverage from task-preferred-preset-id.test.js
//     but confirm the full createApp wire-up is consistent.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createDatabase } = require('../db/database');
const { createPresetService } = require('../services/presetService');
const { createTaskService } = require('../services/taskService');
const { BadRequestError } = require('../utils/errors');
const { createApp } = require('../app');

// ─── Setup helpers ─────────────────────────────────────────────────────────────

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupDb(t) {
  const dbDir = mkTempDir('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    try { close(); } catch { /* */ }
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  return db;
}

function setupPluginsRoot(t) {
  const dir = mkTempDir('palantir-plugins-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function mkdirTempAsync(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await mkdirTempAsync('palantir-storage-');
  const fsRoot = await mkdirTempAsync('palantir-fs-');
  const dbDir = await mkdirTempAsync('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const pluginsRoot = await mkdirTempAsync('palantir-plugins-');
  const app = createApp({
    storageRoot, fsRoot, opencodeBin: 'opencode', dbPath, pluginsRoot,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown(); else app.closeDb();
    await fsp.rm(storageRoot, { recursive: true, force: true });
    await fsp.rm(fsRoot, { recursive: true, force: true });
    await fsp.rm(dbDir, { recursive: true, force: true });
    await fsp.rm(pluginsRoot, { recursive: true, force: true });
  });
  return app;
}

// ─── Part A: Service-layer wiring (real DB, no HTTP) ──────────────────────────
//
// These tests call taskService.updateTask() directly — bypassing the route guard
// entirely — to verify that the validatePresetId callback is wired correctly at
// the service level (D2c injection pattern from app.js lines 112-115).

test('D3-3 service wiring: taskService.updateTask rejects unknown preset id via real presetService (no HTTP)', (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);

  // Wire the same way app.js does:
  //   const taskService = createTaskService(db, eventBus, {
  //     validatePresetId: (id) => presetService.getPreset(id),
  //   });
  const presetService = createPresetService(db, { pluginsRoot });
  const taskService = createTaskService(db, null, {
    validatePresetId: (id) => presetService.getPreset(id), // exact app.js wiring
  });

  const task = taskService.createTask({ title: 'Wiring test task' });
  assert.ok(task.id, 'task created');

  // Attempt to set an unknown preset id — must throw BadRequestError
  assert.throws(
    () => taskService.updateTask(task.id, { preferred_preset_id: 'wp_does_not_exist_d3' }),
    (err) => {
      assert.ok(err instanceof BadRequestError,
        `expected BadRequestError but got ${err.constructor.name}: ${err.message}`);
      assert.match(err.message, /preferred_preset_id not found/,
        'service error message indicates validation failed via wired callback');
      return true;
    },
    'service-layer rejects unknown preset id when validatePresetId is wired to real presetService',
  );
});

test('D3-3 service wiring: taskService.updateTask accepts valid preset id (real presetService, no HTTP)', (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);

  const presetService = createPresetService(db, { pluginsRoot });
  const taskService = createTaskService(db, null, {
    validatePresetId: (id) => presetService.getPreset(id),
  });

  const preset = presetService.createPreset({ name: 'valid-wired-preset' });
  const task = taskService.createTask({ title: 'Task for wiring test' });

  assert.doesNotThrow(
    () => taskService.updateTask(task.id, { preferred_preset_id: preset.id }),
    'valid preset id passes through real presetService.getPreset validator',
  );

  const updated = taskService.getTask(task.id);
  assert.equal(updated.preferred_preset_id, preset.id, 'preset id persisted');
});

test('D3-3 service wiring: taskService.updateTask rejects deleted preset id (real cascade, no HTTP)', (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);

  const presetService = createPresetService(db, { pluginsRoot });
  const taskService = createTaskService(db, null, {
    validatePresetId: (id) => presetService.getPreset(id),
  });

  // Create and immediately delete a preset
  const preset = presetService.createPreset({ name: 'soon-deleted-wired' });
  presetService.deletePreset(preset.id);

  const task = taskService.createTask({ title: 'Task for deleted-preset wiring test' });

  // Attempt to assign the now-deleted preset via the service layer
  assert.throws(
    () => taskService.updateTask(task.id, { preferred_preset_id: preset.id }),
    (err) => {
      assert.ok(err instanceof BadRequestError, `expected BadRequestError, got ${err.constructor.name}`);
      assert.match(err.message, /preferred_preset_id not found/);
      return true;
    },
    'deleted preset id is rejected by the wired real presetService validator',
  );
});

test('D3-3 service wiring: null preferred_preset_id skips validator (no HTTP)', (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);

  let validatorCalled = false;
  const presetService = createPresetService(db, { pluginsRoot });
  const taskService = createTaskService(db, null, {
    validatePresetId: (id) => {
      validatorCalled = true;
      return presetService.getPreset(id);
    },
  });

  const task = taskService.createTask({ title: 'null skip wiring test' });
  assert.doesNotThrow(
    () => taskService.updateTask(task.id, { preferred_preset_id: null }),
    'null preferred_preset_id must not call validator',
  );
  assert.equal(validatorCalled, false, 'validator was NOT called for null value');
});

// ─── Part B: HTTP integration smoke (createApp, supertest) ────────────────────
//
// These confirm the full HTTP wire-up is consistent with Part A.
// Note: route guard in tasks.js fires BEFORE taskService.updateTask, so these
// tests exercise Layer 1 (route) + confirm global consistency, not Layer 2 alone.

test('D3-3 HTTP: PATCH /api/tasks/:id — valid preset id accepted', async (t) => {
  const app = await createTestApp(t);
  const preset = (await request(app).post('/api/worker-presets').send({ name: 'http-valid' })).body.preset;
  const task = (await request(app).post('/api/tasks').send({ title: 'http test' })).body.task;

  const res = await request(app)
    .patch(`/api/tasks/${task.id}`)
    .send({ preferred_preset_id: preset.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.task.preferred_preset_id, preset.id);
});

test('D3-3 HTTP: PATCH /api/tasks/:id — unknown preset id → 400', async (t) => {
  const app = await createTestApp(t);
  const task = (await request(app).post('/api/tasks').send({ title: 'http reject' })).body.task;

  const res = await request(app)
    .patch(`/api/tasks/${task.id}`)
    .send({ preferred_preset_id: 'd3_http_unknown_id' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown preset id/);
});

test('D3-3 HTTP: POST /api/tasks — creation validates preferred_preset_id (gap fixed)', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app)
    .post('/api/tasks')
    .send({ title: 'Task with bogus preset', preferred_preset_id: 'nonexistent_d3_create' });
  assert.equal(res.status, 400, 'creation rejects unknown preferred_preset_id');
  assert.match(res.body.error, /Unknown preset id/);
});
