'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../app');
const { assertHumanSameOrigin } = require('../routes/operatorSchedules');
const { invokeApp } = require('./helpers/invokeApp');

async function appHarness(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-schedule-api-'));
  const app = createApp({
    storageRoot: path.join(root, 'storage'),
    fsRoot: root,
    dbPath: path.join(root, 'test.db'),
    authToken: 'schedule-secret',
    authResolverOpts: { hasKeychain: () => false },
    operatorSchedulerEnabled: false,
    ...overrides,
  });
  app.services._rawDb.prepare(`
    INSERT INTO operator_profiles (id, name, capabilities_json, is_private)
    VALUES ('op_api_scheduler', 'API Scheduler', '[]', 0)
  `).run();
  t.after(async () => {
    await app.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return app;
}

const cookie = ['Cookie', 'palantir_token=schedule-secret'];
const bearer = ['Authorization', 'Bearer schedule-secret'];
const BASE = new Date('2026-08-01T00:00:00.000Z');
const ONE = new Date('2026-08-01T01:00:00.000Z');

function createPrecheckFixture(app, suffix = '') {
  const project = app.services.projectService.createProject({
    name: `Precheck project ${suffix}`,
    directory: `/srv/precheck-${suffix || 'main'}`,
  });
  const otherProject = app.services.projectService.createProject({
    name: `Other project ${suffix}`,
    directory: `/srv/precheck-other-${suffix || 'main'}`,
  });
  const instance = app.services.operatorInstanceService.createInstance({
    profile_id: 'op_api_scheduler',
    primary_project_id: project.id,
  });
  app.services.operatorInstanceService.addRef(instance.id, {
    project_id: otherProject.id,
    role: 'reference',
  });
  const schedule = app.services.operatorScheduleService.createSchedule(instance.id, {
    name: `Precheck schedule ${suffix}`,
    prompt: 'Run after the attached artifact check passes',
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'UTC',
  }, BASE);
  return { project, otherProject, instance, schedule };
}

function createCheck(app, input, actor = 'human') {
  const row = {
    kind: input.kind,
    project_id: input.project_id ?? null,
    name: `${input.kind}-${actor}-${Math.random()}`,
    spec_json: JSON.stringify(input.kind === 'command'
      ? { command: 'true', timeout_ms: null }
      : { files: [], report: { min_chars: 0 } }),
    created_by: actor,
  };
  const info = app.services._rawDb.prepare(`
    INSERT INTO verify_checks (kind, project_id, name, spec_json, created_by)
    VALUES (@kind, @project_id, @name, @spec_json, @created_by)
  `).run(row);
  return { ...row, id: Number(info.lastInsertRowid) };
}

test('human API follows create Operator -> map primary folder -> register schedule', async (t) => {
  const app = await appHarness(t);
  const project = app.services.projectService.createProject({ name: 'Remote folder', directory: '/srv/work' });

  await request(app)
    .post('/api/operator-instances')
    .set('Authorization', 'Bearer schedule-secret')
    .send({ profile_id: 'op_api_scheduler' })
    .expect(403);

  const created = await request(app)
    .post('/api/operator-instances')
    .set(...cookie)
    .send({ profile_id: 'op_api_scheduler', display_name: 'Hourly Operator' })
    .expect(201);
  const instanceId = created.body.instance.id;
  assert.deepEqual(created.body.instance.refs, []);

  await request(app)
    .post(`/api/operator-instances/${instanceId}/schedules`)
    .set(...cookie)
    .send({ name: 'Hourly', prompt: 'Inspect', rule: { kind: 'interval', minutes: 60 } })
    .expect(409);

  await request(app)
    .post(`/api/operator-instances/${instanceId}/refs`)
    .set(...cookie)
    .send({ project_id: project.id, role: 'primary' })
    .expect(201);

  const schedule = await request(app)
    .post(`/api/operator-instances/${instanceId}/schedules`)
    .set(...cookie)
    .send({
      name: 'Hourly audit',
      prompt: 'Inspect the mapped folder and report blocked work.',
      rule: { kind: 'interval', minutes: 60 },
      timezone: 'Asia/Seoul',
    })
    .expect(201);
  assert.equal(schedule.body.schedule.operator_instance_id, instanceId);
  assert.equal(schedule.body.schedule.codebase_project_id, project.id);

  const list = await request(app)
    .get(`/api/operator-instances/${instanceId}/schedules`)
    .set(...cookie)
    .expect(200);
  assert.equal(list.body.schedules.length, 1);

  await request(app)
    .patch(`/api/operator-schedules/${schedule.body.schedule.id}`)
    .set(...cookie)
    .send({ enabled: false, expected_revision: schedule.body.schedule.revision })
    .expect(200)
    .expect((res) => {
      assert.equal(res.body.schedule.enabled, false);
      assert.equal(res.body.schedule.next_fire_at, null);
    });
});

test('schedule mutation blocks cross-origin cookie requests', async (t) => {
  const app = await appHarness(t);
  await request(app)
    .post('/api/operator-instances')
    .set(...cookie)
    .set('Host', 'console.local')
    .set('Origin', 'https://evil.example')
    .send({ profile_id: 'op_api_scheduler' })
    .expect(403);
});

test('assertHumanSameOrigin compares scheme, host, and port while allowing absent Origin', () => {
  function req(origin, { protocol = 'http', host = 'console.local' } = {}) {
    const headers = { host };
    if (origin !== undefined) headers.origin = origin;
    return { auth: { method: 'cookie' }, protocol, headers };
  }

  assert.doesNotThrow(() => assertHumanSameOrigin(req('http://console.local')));
  assert.throws(
    () => assertHumanSameOrigin(req('https://console.local')),
    /cross-origin write blocked/,
  );
  assert.throws(
    () => assertHumanSameOrigin(req('http://console.local:4178', { host: 'console.local:4177' })),
    /cross-origin write blocked/,
  );
  assert.doesNotThrow(() => assertHumanSameOrigin(req(
    'https://console.local:4177',
    { protocol: 'https', host: 'console.local:4177' },
  )));
  assert.doesNotThrow(() => assertHumanSameOrigin(req(undefined)));
});

test('schedule API validates grace and misfire policy while allowing null grace', async (t) => {
  const app = await appHarness(t);
  const project = app.services.projectService.createProject({ name: 'Policy folder', directory: '/srv/policy' });
  const created = await request(app)
    .post('/api/operator-instances')
    .set(...cookie)
    .send({ profile_id: 'op_api_scheduler', primary_project_id: project.id })
    .expect(201);
  const base = {
    name: 'Policy schedule', prompt: 'Inspect', rule: { kind: 'interval', minutes: 60 },
  };

  // MUTATION: coercing or omitting grace validation would accept this payload.
  await request(app)
    .post(`/api/operator-instances/${created.body.instance.id}/schedules`)
    .set(...cookie)
    .send({ ...base, grace_seconds: -1 })
    .expect(400);

  // MUTATION: accepting an unknown policy would defer failure to SQLite or persist invalid state.
  await request(app)
    .post(`/api/operator-instances/${created.body.instance.id}/schedules`)
    .set(...cookie)
    .send({ ...base, misfire_policy: 'fire_all' })
    .expect(400);

  const schedule = await request(app)
    .post(`/api/operator-instances/${created.body.instance.id}/schedules`)
    .set(...cookie)
    .send({ ...base, grace_seconds: null, misfire_policy: 'skip' })
    .expect(201);
  assert.equal(schedule.body.schedule.grace_seconds, null);
  assert.equal(schedule.body.schedule.misfire_policy, 'skip');

  await request(app)
    .patch(`/api/operator-schedules/${schedule.body.schedule.id}`)
    .set(...cookie)
    .send({ expected_revision: schedule.body.schedule.revision, grace_seconds: -1 })
    .expect(400);
  await request(app)
    .patch(`/api/operator-schedules/${schedule.body.schedule.id}`)
    .set(...cookie)
    .send({ expected_revision: schedule.body.schedule.revision, misfire_policy: 'latest' })
    .expect(400);
});

test('precheck attach gate is artifact-only in goal OFF and ON modes', async (t) => {
  for (const goalActive of [false, true]) {
    const app = await appHarness(t, { goalFeatureActive: () => goalActive });
    const { project, schedule } = createPrecheckFixture(app, goalActive ? 'on' : 'off');
    const command = createCheck(app, { kind: 'command', project_id: project.id });

    await request(app)
      .put(`/api/operator-schedules/${schedule.id}/precheck`)
      .set(...cookie)
      .send({ check_id: command.id, expected_revision: schedule.revision })
      .expect(400);
  }
});

test('in-process precheck API covers fixed gates, CAS, S9, and occurrence audit without TCP', async (t) => {
  const app = await appHarness(t, { goalFeatureActive: () => false });
  const { project, otherProject, schedule } = createPrecheckFixture(app, 'in-process');
  const human = createCheck(app, { kind: 'artifact', project_id: project.id });
  const operator = createCheck(app, { kind: 'artifact', project_id: project.id }, 'operator');
  const global = createCheck(app, { kind: 'artifact', project_id: null });
  const mismatch = createCheck(app, { kind: 'artifact', project_id: otherProject.id });
  const command = createCheck(app, { kind: 'command', project_id: project.id });
  const endpoint = `/api/operator-schedules/${schedule.id}/precheck`;
  const cookieHeaders = { cookie: 'palantir_token=schedule-secret' };

  for (const [checkId, expectedStatus] of [
    [command.id, 400],
    [operator.id, 403],
    [global.id, 400],
    [mismatch.id, 400],
  ]) {
    const response = await invokeApp(app, {
      method: 'PUT', path: endpoint, headers: cookieHeaders,
      body: { check_id: checkId, expected_revision: schedule.revision },
    });
    assert.equal(response.status, expectedStatus);
    assert.notEqual(response.status, 503);
  }
  assert.equal((await invokeApp(app, {
    method: 'PUT', path: endpoint,
    headers: { authorization: 'Bearer schedule-secret' },
    body: { check_id: human.id, expected_revision: schedule.revision },
  })).status, 403);
  assert.equal((await invokeApp(app, {
    method: 'PUT', path: endpoint,
    headers: { ...cookieHeaders, host: 'console.local', origin: 'https://evil.example' },
    body: { check_id: human.id, expected_revision: schedule.revision },
  })).status, 403);

  const attached = await invokeApp(app, {
    method: 'PUT', path: endpoint, headers: cookieHeaders,
    body: { check_id: human.id, expected_revision: schedule.revision },
  });
  assert.equal(attached.status, 200);
  assert.equal(attached.body.schedule.precheck_verify_check_id, human.id);
  assert.equal((await invokeApp(app, {
    method: 'DELETE', path: endpoint, headers: cookieHeaders,
    body: { expected_revision: schedule.revision },
  })).status, 409);
  assert.equal((await invokeApp(app, {
    method: 'PATCH', path: `/api/operator-schedules/${schedule.id}`, headers: cookieHeaders,
    body: {
      expected_revision: attached.body.schedule.revision,
      codebase_project_id: otherProject.id,
    },
  })).status, 409);

  app.services.operatorScheduleService.materializeDue(ONE);
  const audit = await invokeApp(app, {
    path: `/api/operator-schedules/${schedule.id}/occurrences?limit=1`,
    headers: cookieHeaders,
  });
  assert.equal(audit.status, 200);
  assert.equal(audit.body.occurrences.length, 1);
  assert.equal(audit.body.occurrences[0].precheck_check_id_snapshot, human.id);

  const detached = await invokeApp(app, {
    method: 'DELETE', path: endpoint, headers: cookieHeaders,
    body: { expected_revision: attached.body.schedule.revision },
  });
  assert.equal(detached.status, 200);
  assert.equal(detached.body.schedule.precheck_verify_check_id, null);

  const goalOnApp = await appHarness(t, { goalFeatureActive: () => true });
  const goalOnFixture = createPrecheckFixture(goalOnApp, 'in-process-goal-on');
  const goalOnCommand = createCheck(goalOnApp, {
    kind: 'command', project_id: goalOnFixture.project.id,
  });
  const goalOnResponse = await invokeApp(goalOnApp, {
    method: 'PUT',
    path: `/api/operator-schedules/${goalOnFixture.schedule.id}/precheck`,
    headers: cookieHeaders,
    body: {
      check_id: goalOnCommand.id,
      expected_revision: goalOnFixture.schedule.revision,
    },
  });
  assert.equal(goalOnResponse.status, 400);
});

test('precheck attach enforces provenance, strict project scope, cookie origin, and CAS', async (t) => {
  const app = await appHarness(t);
  const { project, otherProject, schedule } = createPrecheckFixture(app, 'gate');
  const human = createCheck(app, { kind: 'artifact', project_id: project.id });
  const operator = createCheck(app, { kind: 'artifact', project_id: project.id }, 'operator');
  const global = createCheck(app, { kind: 'artifact', project_id: null });
  const mismatched = createCheck(app, { kind: 'artifact', project_id: otherProject.id });

  await request(app).put(`/api/operator-schedules/${schedule.id}/precheck`).set(...cookie)
    .send({ check_id: operator.id, expected_revision: schedule.revision }).expect(403);
  await request(app).put(`/api/operator-schedules/${schedule.id}/precheck`).set(...cookie)
    .send({ check_id: global.id, expected_revision: schedule.revision }).expect(400);
  await request(app).put(`/api/operator-schedules/${schedule.id}/precheck`).set(...cookie)
    .send({ check_id: mismatched.id, expected_revision: schedule.revision }).expect(400);
  await request(app).put(`/api/operator-schedules/${schedule.id}/precheck`).set(...bearer)
    .send({ check_id: human.id, expected_revision: schedule.revision }).expect(403);
  await request(app).put(`/api/operator-schedules/${schedule.id}/precheck`).set(...cookie)
    .set('Host', 'console.local').set('Origin', 'https://evil.example')
    .send({ check_id: human.id, expected_revision: schedule.revision }).expect(403);

  const attached = await request(app).put(`/api/operator-schedules/${schedule.id}/precheck`).set(...cookie)
    .send({ check_id: human.id, expected_revision: schedule.revision }).expect(200);
  assert.equal(attached.body.schedule.precheck_verify_check_id, human.id);
  assert.equal(attached.body.schedule.revision, schedule.revision + 1);

  // Two clients holding the same revision cannot both attach or detach.
  await request(app).put(`/api/operator-schedules/${schedule.id}/precheck`).set(...cookie)
    .send({ check_id: human.id, expected_revision: schedule.revision }).expect(409);
  await request(app).delete(`/api/operator-schedules/${schedule.id}/precheck`).set(...cookie)
    .send({ expected_revision: schedule.revision }).expect(409);

  const detached = await request(app).delete(`/api/operator-schedules/${schedule.id}/precheck`).set(...cookie)
    .send({ expected_revision: attached.body.schedule.revision }).expect(200);
  assert.equal(detached.body.schedule.precheck_verify_check_id, null);
  assert.equal(detached.body.schedule.revision, attached.body.schedule.revision + 1);
  await request(app).delete(`/api/operator-schedules/${schedule.id}/precheck`).set(...cookie)
    .send({ expected_revision: attached.body.schedule.revision }).expect(409);
});

test('attached precheck blocks project changes and generic PATCH cannot replace it', async (t) => {
  const app = await appHarness(t);
  const { project, otherProject, schedule } = createPrecheckFixture(app, 's9');
  const attachedCheck = createCheck(app, { kind: 'artifact', project_id: project.id });
  const otherCheck = createCheck(app, { kind: 'artifact', project_id: otherProject.id });
  const attached = app.services.operatorScheduleService.attachPrecheck(schedule.id, {
    checkId: attachedCheck.id,
    expectedRevision: schedule.revision,
  });

  await request(app).patch(`/api/operator-schedules/${schedule.id}`).set(...cookie)
    .send({
      expected_revision: attached.revision,
      precheck_verify_check_id: otherCheck.id,
      name: 'Generic patch preserved precheck',
    })
    .expect(200)
    .expect((res) => assert.equal(res.body.schedule.precheck_verify_check_id, attachedCheck.id));

  const fresh = app.services.operatorScheduleService.getSchedule(schedule.id);
  await request(app).patch(`/api/operator-schedules/${schedule.id}`).set(...cookie)
    .send({ expected_revision: fresh.revision, codebase_project_id: otherProject.id })
    .expect(409);
  assert.equal(
    app.services.operatorScheduleService.getSchedule(schedule.id).codebase_project_id,
    project.id,
  );
});

test('occurrence audit endpoint lists bounded schedule occurrences', async (t) => {
  const app = await appHarness(t);
  const { project, schedule } = createPrecheckFixture(app, 'audit');
  const check = createCheck(app, { kind: 'artifact', project_id: project.id });
  app.services.operatorScheduleService.attachPrecheck(schedule.id, {
    checkId: check.id,
    expectedRevision: schedule.revision,
  });
  app.services.operatorScheduleService.materializeDue(ONE);

  const response = await request(app)
    .get(`/api/operator-schedules/${schedule.id}/occurrences?limit=1`)
    .set(...cookie)
    .expect(200);
  assert.equal(response.body.occurrences.length, 1);
  assert.equal(response.body.occurrences[0].schedule_id, schedule.id);
  assert.equal(response.body.occurrences[0].precheck_check_id_snapshot, check.id);
  assert.equal(response.body.occurrences[0].status, 'pending');
});
