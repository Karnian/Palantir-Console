'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../app');

const COOKIE = ['Cookie', 'palantir_token=adapter-secret'];

function createTestApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-adapter-pref-'));
  const app = createApp({
    storageRoot: root,
    fsRoot: root,
    dbPath: path.join(root, 'test.db'),
    authToken: 'adapter-secret',
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    if (app.shutdown) await app.shutdown();
    else app.closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return app;
}

function fakeAdapter({ failDispose = false } = {}) {
  const calls = [];
  return {
    calls,
    disposeSession(runId) {
      calls.push(runId);
      if (failDispose) throw new Error('dispose failed');
      return true;
    },
  };
}

function makeOperatorRun(app, instanceId, adapter) {
  const conversationId = `operator:${instanceId}`;
  const run = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: conversationId,
    operator_instance_id: instanceId,
    manager_adapter: 'codex',
  });
  app.services.runService.updateRunStatus(run.id, 'running', { force: true });
  app.managerRegistry.setActive(conversationId, run.id, adapter);
  return run;
}

test('operator instance create persists an explicit CLI preference', async (t) => {
  const app = createTestApp(t);
  const profile = app.services.operatorProfileService.createProfile({
    name: 'CLI profile',
    capabilities: [],
  });

  const created = await request(app)
    .post('/api/operator-instances')
    .set(...COOKIE)
    .send({
      profile_id: profile.id,
      display_name: 'Claude Operator',
      preferred_adapter: 'claude',
    })
    .expect(201);

  assert.equal(created.body.instance.preferred_adapter, 'claude');
  assert.equal(
    app.services.operatorInstanceService.getInstance(created.body.instance.id).preferred_adapter,
    'claude',
  );
  const columns = app.services._rawDb.pragma('table_info(operator_instances)');
  assert.ok(columns.some((column) => column.name === 'preferred_adapter'));
  assert.throws(
    () => app.services._rawDb
      .prepare('UPDATE operator_instances SET preferred_adapter = ? WHERE id = ?')
      .run('opencode', created.body.instance.id),
    /CHECK constraint failed/,
  );
});

test('adapter PATCH preserves the Operator identity and resets only its runtime thread', async (t) => {
  const app = createTestApp(t);
  const project = app.services.projectService.createProject({ name: 'Adapter switch' });
  const resolved = app.services.runService.ensurePrimaryOperatorInstanceForProject(project.id);
  const instanceId = resolved.instanceId;
  const before = app.services.operatorInstanceService.getInstance(instanceId);
  app.services.runService.setOperatorInstanceThread(instanceId, {
    thread_id: 'codex-thread',
    pm_adapter: 'codex',
  });
  const adapter = fakeAdapter();
  const run = makeOperatorRun(app, instanceId, adapter);

  const switched = await request(app)
    .patch(`/api/operator-instances/${instanceId}/adapter`)
    .set(...COOKIE)
    .send({ preferred_adapter: 'claude' })
    .expect(200);

  assert.equal(switched.body.changed, true);
  assert.equal(switched.body.instance.id, instanceId);
  assert.equal(switched.body.instance.profile_id, before.profile_id);
  assert.deepEqual(switched.body.instance.refs, before.refs);
  assert.equal(switched.body.instance.preferred_adapter, 'claude');
  assert.equal(switched.body.instance.thread_id, null);
  assert.equal(switched.body.instance.pm_adapter, null);
  assert.deepEqual(adapter.calls, [run.id]);
  assert.equal(app.managerRegistry.getActiveRunId(`operator:${instanceId}`), null);
  assert.equal(app.services.runService.getRun(run.id).status, 'cancelled');
});

test('adapter PATCH validates before reset, is no-op for the same value, and fails closed', async (t) => {
  const app = createTestApp(t);
  const project = app.services.projectService.createProject({ name: 'Adapter guards' });
  const { instanceId } = app.services.runService.ensurePrimaryOperatorInstanceForProject(project.id);
  app.services.operatorInstanceService.setPreferredAdapter(instanceId, 'codex');

  const invalidAdapter = fakeAdapter();
  makeOperatorRun(app, instanceId, invalidAdapter);
  await request(app)
    .patch(`/api/operator-instances/${instanceId}/adapter`)
    .set(...COOKIE)
    .send({ preferred_adapter: 'opencode' })
    .expect(400);
  assert.equal(invalidAdapter.calls.length, 0);
  assert.equal(app.services.operatorInstanceService.getInstance(instanceId).preferred_adapter, 'codex');

  const same = await request(app)
    .patch(`/api/operator-instances/${instanceId}/adapter`)
    .set(...COOKIE)
    .send({ preferred_adapter: 'codex' })
    .expect(200);
  assert.equal(same.body.changed, false);
  assert.equal(invalidAdapter.calls.length, 0);

  const failingAdapter = fakeAdapter({ failDispose: true });
  makeOperatorRun(app, instanceId, failingAdapter);
  await request(app)
    .patch(`/api/operator-instances/${instanceId}/adapter`)
    .set(...COOKIE)
    .send({ preferred_adapter: 'claude' })
    .expect(502);
  assert.equal(app.services.operatorInstanceService.getInstance(instanceId).preferred_adapter, 'codex');
});

test('adapter PATCH is human-only and requires an explicit preference field', async (t) => {
  const app = createTestApp(t);
  const project = app.services.projectService.createProject({ name: 'Adapter auth' });
  const { instanceId } = app.services.runService.ensurePrimaryOperatorInstanceForProject(project.id);

  await request(app)
    .patch(`/api/operator-instances/${instanceId}/adapter`)
    .set('Authorization', 'Bearer adapter-secret')
    .send({ preferred_adapter: 'claude' })
    .expect(403);
  await request(app)
    .patch(`/api/operator-instances/${instanceId}/adapter`)
    .set(...COOKIE)
    .send({})
    .expect(400);
});
