'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-brief-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-brief-fs-'));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-brief-db-'));
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath: path.join(dbDir, 'test.db'),
    authToken: 'brief-test-secret',
    authResolverOpts: { hasKeychain: () => false },
  });

  t.after(async () => {
    if (app.shutdown) await app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}

function api(app, method, requestPath, body, headers = {}) {
  return invokeApp(app, {
    method,
    path: requestPath,
    body,
    headers: {
      cookie: 'palantir_token=brief-test-secret',
      ...headers,
    },
  });
}

function createLiveOperator(app, instanceId, disposeSession) {
  const run = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instanceId}`,
    operator_instance_id: instanceId,
    manager_adapter: 'codex',
    prompt: `Operator ${instanceId}`,
  });
  app.services.runService.updateRunStatus(run.id, 'running', { force: true });
  app.services.runService.setOperatorInstanceThread(instanceId, {
    thread_id: `thread_${instanceId}`,
    pm_adapter: 'codex',
    node_id: 'local',
    cwd: '/tmp',
  });
  app.managerRegistry.setActive(`operator:${instanceId}`, run.id, {
    isSessionAlive: () => true,
    detectExitCode: () => null,
    disposeSession,
  });
  return run;
}

test('effective Operator Brief composes profile persona with selected codebase context', async (t) => {
  const app = await createTestApp(t);
  const profile = app.services.operatorProfileService.createProfile({
    name: 'Release Operator',
    persona: 'Verify release evidence before acting.',
  });
  const alpha = app.services.projectService.createProject({ name: 'Alpha' });
  const beta = app.services.projectService.createProject({ name: 'Beta' });
  const instance = app.services.operatorInstanceService.createInstance({
    profile_id: profile.id,
    primary_project_id: alpha.id,
  });
  app.services.operatorInstanceService.addRef(instance.id, {
    project_id: beta.id,
    role: 'reference',
  });
  await app.services.operatorBriefService.updateProjectContext(alpha.id, {
    conventions: 'Use tabs.',
    known_pitfalls: 'Do not publish twice.',
  });
  await app.services.operatorBriefService.updateProjectContext(beta.id, {
    conventions: 'Use spaces.',
    known_pitfalls: 'Generated files are checked in.',
  });

  const primary = await api(app, 'GET', `/api/operator-instances/${instance.id}/brief`);
  assert.equal(primary.status, 200);
  assert.equal(primary.body.brief.profile.id, profile.id);
  assert.equal(primary.body.brief.project.id, alpha.id);
  assert.equal(primary.body.brief.persona, 'Verify release evidence before acting.');
  assert.equal(primary.body.brief.conventions, 'Use tabs.');
  assert.match(primary.body.brief.prompt_section, /## Operator Brief/);
  assert.match(primary.body.brief.prompt_section, /### Role and Behavior/);
  assert.match(primary.body.brief.prompt_section, /### Codebase Conventions/);

  const reference = await api(
    app,
    'GET',
    `/api/operator-instances/${instance.id}/brief?project_id=${beta.id}`,
  );
  assert.equal(reference.status, 200);
  assert.equal(reference.body.brief.project.id, beta.id);
  assert.equal(reference.body.brief.persona, primary.body.brief.persona);
  assert.equal(reference.body.brief.conventions, 'Use spaces.');
});

test('saving an Operator Brief resets the union of profile sharers and codebase watchers once', async (t) => {
  const app = await createTestApp(t);
  const sharedProfile = app.services.operatorProfileService.createProfile({
    name: 'Shared Operator',
    persona: 'Old persona.',
  });
  const otherProfile = app.services.operatorProfileService.createProfile({
    name: 'Other Operator',
    persona: 'Other persona.',
  });
  const alpha = app.services.projectService.createProject({ name: 'Alpha' });
  const beta = app.services.projectService.createProject({ name: 'Beta' });
  const gamma = app.services.projectService.createProject({ name: 'Gamma' });
  const instanceA = app.services.operatorInstanceService.createInstance({
    profile_id: sharedProfile.id,
    primary_project_id: alpha.id,
  });
  const instanceB = app.services.operatorInstanceService.createInstance({
    profile_id: sharedProfile.id,
    primary_project_id: beta.id,
  });
  const instanceC = app.services.operatorInstanceService.createInstance({
    profile_id: otherProfile.id,
    primary_project_id: gamma.id,
  });
  app.services.operatorInstanceService.addRef(instanceC.id, {
    project_id: alpha.id,
    role: 'reference',
  });
  await app.services.operatorBriefService.updateProjectContext(alpha.id, {
    conventions: 'Old convention.',
    known_pitfalls: 'Old pitfall.',
  });

  const disposeCounts = new Map();
  for (const instance of [instanceA, instanceB, instanceC]) {
    createLiveOperator(app, instance.id, () => {
      disposeCounts.set(instance.id, (disposeCounts.get(instance.id) || 0) + 1);
    });
  }

  const saved = await api(
    app,
    'PATCH',
    `/api/operator-instances/${instanceA.id}/brief?project_id=${alpha.id}`,
    {
      persona: 'New shared persona.',
      conventions: 'New Alpha convention.',
      known_pitfalls: 'New Alpha pitfall.',
    },
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(
    saved.body.reset_instance_ids,
    [instanceA.id, instanceB.id, instanceC.id].sort(),
  );
  assert.equal(saved.body.brief.persona, 'New shared persona.');
  assert.equal(saved.body.brief.conventions, 'New Alpha convention.');
  assert.equal(saved.body.brief.known_pitfalls, 'New Alpha pitfall.');
  for (const instance of [instanceA, instanceB, instanceC]) {
    assert.equal(disposeCounts.get(instance.id), 1, `${instance.id} disposed exactly once`);
    assert.equal(app.managerRegistry.getActiveRunId(`operator:${instance.id}`), null);
    assert.equal(app.services.runService.getOperatorInstance(instance.id).thread_id, null);
  }
  assert.equal(
    app.services.operatorProfileService.getProfile(sharedProfile.id).persona,
    'New shared persona.',
  );
  assert.equal(
    app.services.operatorProfileService.getProfile(otherProfile.id).persona,
    'Other persona.',
  );

  const noop = await api(
    app,
    'PATCH',
    `/api/operator-instances/${instanceA.id}/brief?project_id=${alpha.id}`,
    {
      persona: 'New shared persona.',
      conventions: 'New Alpha convention.',
      known_pitfalls: 'New Alpha pitfall.',
    },
  );
  assert.equal(noop.status, 200);
  assert.deepEqual(noop.body.reset_instance_ids, []);
});

test('Operator Brief writes fail closed when a live session cannot be reset', async (t) => {
  const app = await createTestApp(t);
  const profile = app.services.operatorProfileService.createProfile({
    name: 'Fail Closed Operator',
    persona: 'Original persona.',
  });
  const project = app.services.projectService.createProject({ name: 'Alpha' });
  const instance = app.services.operatorInstanceService.createInstance({
    profile_id: profile.id,
    primary_project_id: project.id,
  });
  await app.services.operatorBriefService.updateProjectContext(project.id, {
    conventions: 'Original convention.',
    known_pitfalls: 'Original pitfall.',
  });
  createLiveOperator(app, instance.id, () => {
    throw new Error('dispose exploded');
  });

  const failed = await api(
    app,
    'PATCH',
    `/api/operator-instances/${instance.id}/brief?project_id=${project.id}`,
    {
      persona: 'Must not persist.',
      conventions: 'Must not persist.',
      known_pitfalls: 'Must not persist.',
    },
  );
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /disposeSession failed/);
  assert.equal(
    app.services.operatorProfileService.getProfile(profile.id).persona,
    'Original persona.',
  );
  const brief = app.services.operatorBriefService.readEffectiveBrief(instance.id, {
    projectId: project.id,
  });
  assert.equal(brief.conventions, 'Original convention.');
  assert.equal(brief.known_pitfalls, 'Original pitfall.');
  assert.ok(app.managerRegistry.getActiveRunId(`operator:${instance.id}`));
});

test('Operator Brief validates scope, size, body shape, and human same-origin writes', async (t) => {
  const app = await createTestApp(t);
  const profile = app.services.operatorProfileService.createProfile({ name: 'Validated Operator' });
  const alpha = app.services.projectService.createProject({ name: 'Alpha' });
  const beta = app.services.projectService.createProject({ name: 'Beta' });
  const instance = app.services.operatorInstanceService.createInstance({
    profile_id: profile.id,
    primary_project_id: alpha.id,
  });
  const endpoint = `/api/operator-instances/${instance.id}/brief?project_id=${alpha.id}`;

  assert.equal(
    (await api(app, 'GET', `/api/operator-instances/${instance.id}/brief?project_id=${beta.id}`)).status,
    400,
  );
  assert.equal(
    (await api(app, 'PATCH', endpoint, { persona: 'x'.repeat(2001) })).status,
    400,
  );
  assert.equal(
    (await api(app, 'PATCH', endpoint, { conventions: 'x'.repeat(12001) })).status,
    400,
  );
  assert.equal(
    (await api(app, 'PATCH', endpoint, ['not-an-object'])).status,
    400,
  );
  assert.equal(
    (await api(app, 'PATCH', endpoint, { unrelated: true })).status,
    400,
  );

  const bearer = await api(
    app,
    'PATCH',
    endpoint,
    { persona: 'Bearer must not write.' },
    { authorization: 'Bearer brief-test-secret' },
  );
  assert.equal(bearer.status, 403);

  const crossOrigin = await api(
    app,
    'PATCH',
    endpoint,
    { persona: 'Cross-origin must not write.' },
    { host: 'console.local', origin: 'https://evil.example' },
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(app.services.operatorProfileService.getProfile(profile.id).persona, null);
});
