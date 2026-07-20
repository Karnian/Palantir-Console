const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../app');

const COOKIE = ['Cookie', 'palantir_token=b0-secret'];

function createTestApp(t, { authToken = 'b0-secret' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-b0-life-'));
  const app = createApp({
    storageRoot: root,
    fsRoot: root,
    dbPath: path.join(root, 'test.db'),
    authToken,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    if (app.shutdown) await app.shutdown();
    else app.closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return app;
}

function ensurePrimary(app, name) {
  const project = app.services.projectService.createProject({ name });
  const resolved = app.services.runService.ensurePrimaryOperatorInstanceForProject(project.id);
  return { project, instanceId: resolved.instanceId };
}

function createProfile(app, name, persona = null) {
  return app.services.operatorProfileService.createProfile({ name, persona, capabilities: [] });
}

function makeOperatorRun(app, instanceId, adapter) {
  const run = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instanceId}`,
  });
  app.managerRegistry.setActive(`operator:${instanceId}`, run.id, adapter);
  return run;
}

function fakeAdapter({ failDispose = false, onDispose } = {}) {
  const calls = [];
  return {
    calls,
    disposeSession(runId) {
      calls.push(runId);
      if (onDispose) onDispose(runId);
      if (failDispose) throw new Error('dispose failed');
    },
  };
}

test('assign resets only the assigned instance and reset failure preserves its profile', async (t) => {
  const app = createTestApp(t);
  const a = ensurePrimary(app, 'assign-a');
  const b = ensurePrimary(app, 'assign-b');
  const shared = createProfile(app, 'Shared assign');
  const adapterA = fakeAdapter();
  const adapterB = fakeAdapter();
  makeOperatorRun(app, a.instanceId, adapterA);
  makeOperatorRun(app, b.instanceId, adapterB);

  await request(app).patch(`/api/operator-instances/${a.instanceId}/profile`).set(...COOKIE).send({ profile_id: shared.id }).expect(200);
  assert.equal(app.services.operatorInstanceService.getInstance(a.instanceId).profile_id, shared.id);
  assert.equal(adapterA.calls.length, 1);
  assert.equal(adapterB.calls.length, 0);
  await request(app).patch(`/api/operator-instances/${b.instanceId}/profile`).set(...COOKIE).send({ profile_id: shared.id }).expect(200);
  assert.equal(app.services.operatorInstanceService.getInstance(b.instanceId).profile_id, shared.id);

  const replacement = createProfile(app, 'Replacement');
  const failed = fakeAdapter({ failDispose: true });
  makeOperatorRun(app, a.instanceId, failed);
  await request(app).patch(`/api/operator-instances/${a.instanceId}/profile`).set(...COOKIE).send({ profile_id: replacement.id }).expect(502);
  assert.equal(app.services.operatorInstanceService.getInstance(a.instanceId).profile_id, shared.id);
});

test('unassign creates a new private profile only after reset succeeds', async (t) => {
  const app = createTestApp(t);
  const { instanceId } = ensurePrimary(app, 'unassign');
  const before = app.services.operatorInstanceService.getInstance(instanceId).profile_id;
  await request(app).delete(`/api/operator-instances/${instanceId}/profile`).set(...COOKIE).expect(200);
  const changed = app.services.operatorInstanceService.getInstance(instanceId);
  assert.notEqual(changed.profile_id, before);
  assert.equal(app.services.operatorProfileService.getProfile(changed.profile_id).is_private, true);

  const countBeforeFailure = app.services._rawDb.prepare('SELECT COUNT(*) AS n FROM operator_profiles').get().n;
  const failed = fakeAdapter({ failDispose: true });
  makeOperatorRun(app, instanceId, failed);
  await request(app).delete(`/api/operator-instances/${instanceId}/profile`).set(...COOKIE).expect(502);
  assert.equal(app.services.operatorInstanceService.getInstance(instanceId).profile_id, changed.profile_id);
  assert.equal(app.services._rawDb.prepare('SELECT COUNT(*) AS n FROM operator_profiles').get().n, countBeforeFailure);
});

test('profile identity PATCH resets all sharers before write; non-identity and invalid PATCH do not reset', async (t) => {
  const app = createTestApp(t);
  const a = ensurePrimary(app, 'patch-a');
  const b = ensurePrimary(app, 'patch-b');
  const shared = createProfile(app, 'Shared patch', 'old persona');
  app.services.operatorInstanceService.setProfileId(a.instanceId, shared.id);
  app.services.operatorInstanceService.setProfileId(b.instanceId, shared.id);
  const disposeA = fakeAdapter({ onDispose: () => assert.equal(app.services.operatorProfileService.getProfile(shared.id).persona, 'old persona') });
  const disposeB = fakeAdapter({ onDispose: () => assert.equal(app.services.operatorProfileService.getProfile(shared.id).persona, 'old persona') });
  makeOperatorRun(app, a.instanceId, disposeA);
  makeOperatorRun(app, b.instanceId, disposeB);

  await request(app).patch(`/api/operator/profiles/${shared.id}`).set(...COOKIE).send({ persona: 'new persona' }).expect(200);
  assert.equal(disposeA.calls.length, 1);
  assert.equal(disposeB.calls.length, 1);
  assert.equal(app.services.operatorProfileService.getProfile(shared.id).persona, 'new persona');

  const nameOnly = fakeAdapter();
  makeOperatorRun(app, a.instanceId, nameOnly);
  await request(app).patch(`/api/operator/profiles/${shared.id}`).set(...COOKIE).send({ name: 'Shared patch renamed' }).expect(200);
  assert.equal(nameOnly.calls.length, 0);

  const duplicate = createProfile(app, 'Duplicate target');
  const invalid = fakeAdapter();
  makeOperatorRun(app, b.instanceId, invalid);
  await request(app).patch(`/api/operator/profiles/${shared.id}`).set(...COOKIE).send({ name: duplicate.name, persona: 'must not write' }).expect(409);
  assert.equal(invalid.calls.length, 0);
  assert.equal(app.services.operatorProfileService.getProfile(shared.id).persona, 'new persona');
});

test('profile delete protects references and deletes unreferenced profiles', async (t) => {
  const app = createTestApp(t);
  const { instanceId } = ensurePrimary(app, 'delete-ref');
  const referencedId = app.services.operatorInstanceService.getInstance(instanceId).profile_id;
  await request(app).delete(`/api/operator/profiles/${referencedId}`).set(...COOKIE).expect(409);
  const unused = createProfile(app, 'Unused profile');
  await request(app).delete(`/api/operator/profiles/${unused.id}`).set(...COOKIE).expect(200);
});

test('profile delete is blocked when the profile has a memory footprint (integration-review SERIOUS)', async (t) => {
  const app = createTestApp(t);
  const profile = createProfile(app, 'Profile with memory');
  // A profile-owned distill candidate (R4b remember for a bearer/none actor).
  // Deleting the profile now would orphan the candidate: the profile_memory_revision
  // FK cascades away while the candidate survives, so the next distill drain would
  // FK-fail on the revision bump and re-enqueue the job forever. Must 409 instead.
  app.services.memoryService.createCandidate({
    profileId: profile.id,
    rule: 'R4',
    rawJson: { content: 'prefers concise diffs' },
    dedupKey: 'k-footprint',
  });
  const res = await request(app).delete(`/api/operator/profiles/${profile.id}`).set(...COOKIE).expect(409);
  assert.match(res.body.error || '', /memory record/i);
});

test('resetInstance clears instance and primary brief thread bridges', async (t) => {
  const app = createTestApp(t);
  const { project, instanceId } = ensurePrimary(app, 'bridge-clear');
  app.services.runService.setOperatorInstanceThread(instanceId, { thread_id: 'old-instance-thread', pm_adapter: 'codex' });
  app.services._rawDb.prepare('INSERT INTO project_briefs (project_id, pm_thread_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET pm_thread_id=excluded.pm_thread_id').run(project.id, 'old-brief-thread');

  const result = await app.services.operatorCleanupService.resetInstance(instanceId);
  assert.equal(result.clearedThread, true);
  assert.equal(app.services.operatorInstanceService.getInstance(instanceId).thread_id, null);
  assert.equal(app.services._rawDb.prepare('SELECT pm_thread_id FROM project_briefs WHERE project_id = ?').get(project.id).pm_thread_id, null);
});

test('assign and unassign routes require human cookie auth', async (t) => {
  const app = createTestApp(t);
  const { instanceId } = ensurePrimary(app, 'auth');
  const profile = createProfile(app, 'Auth target');
  const bearer = ['Authorization', 'Bearer b0-secret'];

  await request(app).patch(`/api/operator-instances/${instanceId}/profile`).set(...bearer).send({ profile_id: profile.id }).expect(403);
  await request(app).patch(`/api/operator-instances/${instanceId}/profile`).send({ profile_id: profile.id }).expect(403);
  await request(app).delete(`/api/operator-instances/${instanceId}/profile`).set(...bearer).expect(403);
  await request(app).delete(`/api/operator-instances/${instanceId}/profile`).expect(403);
});
