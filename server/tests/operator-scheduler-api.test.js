'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../app');

async function appHarness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-schedule-api-'));
  const app = createApp({
    storageRoot: path.join(root, 'storage'),
    fsRoot: root,
    dbPath: path.join(root, 'test.db'),
    authToken: 'schedule-secret',
    authResolverOpts: { hasKeychain: () => false },
    operatorSchedulerEnabled: false,
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
