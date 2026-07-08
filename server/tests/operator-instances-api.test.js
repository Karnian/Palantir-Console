'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-oi-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-oi-fs-'));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-oi-db-'));
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath: path.join(dbDir, 'test.db'),
    authToken: null,
    authResolverOpts: { hasKeychain: () => false },
  });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  return app;
}

function createProject(app, name) {
  return app.services.projectService.createProject({ name });
}

function api(app, method, path, body) {
  return invokeApp(app, { method, path, body });
}

function ensurePrimary(app, projectId) {
  return app.services.runService.ensurePrimaryOperatorInstanceForProject(projectId);
}

function fakeAdapter({ failDispose = false } = {}) {
  return {
    isSessionAlive: () => true,
    detectExitCode: () => null,
    disposeSession: () => {
      if (failDispose) throw new Error('dispose exploded');
    },
  };
}

function makeOperatorRun(app, instanceId, adapter = null) {
  const run = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instanceId}`,
    operator_instance_id: instanceId,
    manager_adapter: 'codex',
    prompt: `PM ${instanceId}`,
  });
  if (adapter) app.managerRegistry.setActive(`operator:${instanceId}`, run.id, adapter);
  return run;
}

test('operator instances API exposes refs CRUD and expected conflict/404 cases', async (t) => {
  const app = await createTestApp(t);
  const primaryProject = createProject(app, 'alpha');
  const refProject = createProject(app, 'beta');
  const otherProject = createProject(app, 'gamma');
  const resolved = ensurePrimary(app, primaryProject.id);
  const instanceId = resolved.instanceId;
  // W-P6a R1 (Codex): watchlist_version bump is live-only — make the slot live
  // so ref edits below exercise the bump path.
  makeOperatorRun(app, instanceId, { disposeSession() {} });

  const list = await api(app, 'GET', '/api/operator-instances');
  assert.equal(list.status, 200);
  assert.equal(list.body.instances.length, 1);
  assert.equal(list.body.instances[0].id, instanceId);
  assert.equal(list.body.instances[0].watchlist_version, 0);
  assert.deepEqual(list.body.instances[0].refs.map((ref) => [ref.project_id, ref.role]), [
    [primaryProject.id, 'primary'],
  ]);

  const single = await api(app, 'GET', `/api/operator-instances/${instanceId}`);
  assert.equal(single.status, 200);
  assert.equal(single.body.instance.id, instanceId);

  const add = await api(app, 'POST', `/api/operator-instances/${instanceId}/refs`, {
    project_id: refProject.id,
    role: 'reference',
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.ref.project_id, refProject.id);
  assert.equal(add.body.ref.role, 'reference');
  assert.equal(add.body.instance.watchlist_version, 1);

  const duplicatePrimary = await api(app, 'POST', `/api/operator-instances/${instanceId}/refs`, {
    project_id: otherProject.id,
    role: 'primary',
  });
  assert.equal(duplicatePrimary.status, 409);

  const remove = await api(app, 'DELETE', `/api/operator-instances/${instanceId}/refs/${refProject.id}`);
  assert.equal(remove.status, 200);
  assert.equal(remove.body.instance.watchlist_version, 2);
  assert.ok(!remove.body.instance.refs.some((ref) => ref.project_id === refProject.id));

  const removePrimary = await api(app, 'DELETE', `/api/operator-instances/${instanceId}/refs/${primaryProject.id}`);
  assert.equal(removePrimary.status, 409);

  assert.equal((await api(app, 'GET', '/api/operator-instances/oi_missing')).status, 404);
  assert.equal(
    (await api(app, 'POST', '/api/operator-instances/oi_missing/refs', {
      project_id: refProject.id,
      role: 'reference',
    })).status,
    404,
  );
  assert.equal(
    (await api(app, 'POST', `/api/operator-instances/${instanceId}/refs`, {
      project_id: 'proj_missing',
      role: 'reference',
    })).status,
    404,
  );
  assert.equal((await api(app, 'DELETE', `/api/operator-instances/${instanceId}/refs/${refProject.id}`)).status, 404);
});

test('live watch-list changes bump version and annotate the active operator run', async (t) => {
  const app = await createTestApp(t);
  const primaryProject = createProject(app, 'alpha');
  const refProject = createProject(app, 'beta');
  const { instanceId } = ensurePrimary(app, primaryProject.id);
  const run = makeOperatorRun(app, instanceId, fakeAdapter());

  const add = await api(app, 'POST', `/api/operator-instances/${instanceId}/refs`, {
    project_id: refProject.id,
    role: 'reference',
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.instance.watchlist_version, 1);

  const remove = await api(app, 'DELETE', `/api/operator-instances/${instanceId}/refs/${refProject.id}`);
  assert.equal(remove.status, 200);
  assert.equal(remove.body.instance.watchlist_version, 2);

  const events = app.services.runService.getRunEvents(run.id);
  const watchEvents = events.filter((event) => event.event_type === 'operator:watchlist_changed');
  assert.equal(watchEvents.length, 2);
  assert.deepEqual(
    watchEvents.map((event) => JSON.parse(event.payload_json).action),
    ['ref_added', 'ref_removed'],
  );
});

test('project delete removes all refs, bumps affected versions, and leaves orphan instances observable', async (t) => {
  const app = await createTestApp(t);
  const primaryA = createProject(app, 'alpha');
  const deletedProject = createProject(app, 'shared');
  const instanceA = ensurePrimary(app, primaryA.id).instanceId;
  const instanceB = ensurePrimary(app, deletedProject.id).instanceId;
  makeOperatorRun(app, instanceA, { disposeSession() {} }); // live: bump is live-only
  const orphanRun = makeOperatorRun(app, instanceB);

  app.services.runService.setOperatorInstanceThread(instanceB, {
    thread_id: 'thread-shared',
    pm_adapter: 'codex',
    node_id: 'local',
    cwd: '/tmp/shared',
  });

  const addRef = await api(app, 'POST', `/api/operator-instances/${instanceA}/refs`, {
    project_id: deletedProject.id,
    role: 'reference',
  });
  assert.equal(addRef.status, 201);
  assert.equal(addRef.body.instance.watchlist_version, 1);

  const del = await api(app, 'DELETE', `/api/projects/${deletedProject.id}`);
  assert.equal(del.status, 200);

  assert.equal((await api(app, 'GET', `/api/projects/${deletedProject.id}`)).status, 404);

  const afterA = (await api(app, 'GET', `/api/operator-instances/${instanceA}`)).body.instance;
  assert.equal(afterA.watchlist_version, 2);
  assert.deepEqual(afterA.refs.map((ref) => ref.project_id), [primaryA.id]);

  const afterB = (await api(app, 'GET', `/api/operator-instances/${instanceB}`)).body.instance;
  // live-only bump contract: instanceB was never a live slot, so the orphaning
  // ref removal must NOT bump its version (it re-reads refs at next spawn).
  assert.equal(afterB.watchlist_version, 0);
  assert.deepEqual(afterB.refs, []);
  assert.equal(afterB.thread_id, null);
  assert.equal(afterB.cwd, null);

  const orphanEvents = app.services.runService.getRunEvents(orphanRun.id)
    .filter((event) => event.event_type === 'operator:watchlist_changed')
    .map((event) => JSON.parse(event.payload_json));
  assert.equal(orphanEvents.length, 1);
  assert.equal(orphanEvents[0].action, 'project_deleted_ref_removed');
  assert.equal(orphanEvents[0].orphan, true);
});

test('project delete remains fail-closed when the primary instance is live and dispose fails', async (t) => {
  const app = await createTestApp(t);
  const project = createProject(app, 'alpha');
  const { instanceId } = ensurePrimary(app, project.id);
  makeOperatorRun(app, instanceId, fakeAdapter({ failDispose: true }));

  const res = await api(app, 'DELETE', `/api/projects/${project.id}`);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'pm_dispose_failed');

  assert.equal((await api(app, 'GET', `/api/projects/${project.id}`)).status, 200);
  const instance = (await api(app, 'GET', `/api/operator-instances/${instanceId}`)).body.instance;
  assert.deepEqual(instance.refs.map((ref) => [ref.project_id, ref.role]), [[project.id, 'primary']]);
});

test('router name matching targets the primary instance, preserves ambiguity, and falls back without primary', async (t) => {
  const app = await createTestApp(t);
  const primaryProject = createProject(app, 'alpha');
  const ambiguousProject = createProject(app, 'beta');
  const noPrimaryProject = createProject(app, 'gamma');
  const { instanceConversationId } = ensurePrimary(app, primaryProject.id);
  ensurePrimary(app, ambiguousProject.id);

  const primary = await api(app, 'POST', '/api/router/resolve', { text: 'please inspect alpha' });
  assert.equal(primary.status, 200);
  assert.equal(primary.body.target, instanceConversationId);
  assert.equal(primary.body.matchedRule, '3_namematch');

  const ambiguous = await api(app, 'POST', '/api/router/resolve', { text: 'alpha beta' });
  assert.equal(ambiguous.status, 200);
  assert.equal(ambiguous.body.ambiguous, true);
  assert.equal(ambiguous.body.target, 'top');
  assert.deepEqual(ambiguous.body.candidates.map((candidate) => candidate.projectId).sort(), [
    ambiguousProject.id,
    primaryProject.id,
  ].sort());

  const fallback = await api(app, 'POST', '/api/router/resolve', { text: 'please inspect gamma' });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.target, `operator:${noPrimaryProject.id}`);
  assert.equal(fallback.body.matchedRule, '3_namematch');
});
