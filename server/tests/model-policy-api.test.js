'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../app');

const COOKIE = ['Cookie', 'palantir_token=secret-token'];
const BEARER = ['Authorization', 'Bearer secret-token'];

function setupApp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-model-policy-'));
  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false },
    authToken: 'secret-token',
  });
  t.after(async () => {
    try {
      if (app.shutdown) await app.shutdown();
      else app.closeDb();
    } catch { /* cleanup only */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return app;
}

test('model policy API performs CAS writes, audit, listing, and effective resolution', async (t) => {
  const app = setupApp(t);

  const created = await request(app)
    .put('/api/model-policies/global/*/codex')
    .set(...COOKIE)
    .send({ params: { tier: 'fast' } })
    .expect(200);
  assert.equal(created.body.policy.revision, 1);
  assert.deepEqual(created.body.policy.params, { tier: 'fast' });
  assert.equal(created.body.policy.changed_by, 'human');

  const listed = await request(app)
    .get('/api/model-policies')
    .set(...BEARER)
    .expect(200);
  assert.equal(listed.body.policies.length, 1);
  assert.deepEqual(listed.body.policies[0].params, { tier: 'fast' });

  const updated = await request(app)
    .put('/api/model-policies/global/*/codex')
    .set(...COOKIE)
    .send({ params: { tier: 'standard' }, expectedRevision: 1 })
    .expect(200);
  assert.equal(updated.body.policy.revision, 2);
  assert.deepEqual(updated.body.policy.params, { tier: 'standard' });

  const audit = app.services._rawDb.prepare(`
    SELECT action, params_json_after, changed_by
    FROM model_policy_audit
    WHERE scope_type = 'global' AND scope_id = '*' AND vendor = 'codex'
    ORDER BY id
  `).all();
  assert.deepEqual(audit, [
    { action: 'insert', params_json_after: '{"tier":"fast"}', changed_by: 'human' },
    { action: 'update', params_json_after: '{"tier":"standard"}', changed_by: 'human' },
  ]);

  await request(app)
    .put('/api/model-policies/global/*/codex')
    .set(...COOKIE)
    .send({ params: { tier: 'fast' }, expectedRevision: 1 })
    .expect(409);
  await request(app)
    .put('/api/model-policies/global/*/codex')
    .set(...COOKIE)
    .send({ params: { tier: 'fast' } })
    .expect(409);

  await request(app)
    .put('/api/model-policies/layer:operator/*/codex')
    .set(...COOKIE)
    .send({ params: { tier: 'fast' } })
    .expect(200);
  const effective = await request(app)
    .get('/api/model-policies/effective?layer=operator&vendor=codex')
    .set(...BEARER)
    .expect(200);
  assert.equal(effective.body.effective.tier, 'fast');
  assert.equal(effective.body.effective.sources.tier, 'layer');
});

test('model policy writes require cookie auth and a same-host Origin', async (t) => {
  const app = setupApp(t);
  const route = '/api/model-policies/layer:top/*/claude';

  await request(app)
    .put(route)
    .set(...BEARER)
    .send({ params: { model: 'claude-test' } })
    .expect(403);
  await request(app)
    .put(route)
    .send({ params: { model: 'claude-test' } })
    .expect(403);
  await request(app)
    .put(route)
    .set(...COOKIE)
    .set('Origin', 'http://evil.example')
    .send({ params: { model: 'claude-test' } })
    .expect(403);

  const allowed = await request(app)
    .put(route)
    .set(...COOKIE)
    .send({ params: { model: 'claude-test' } })
    .expect(200);
  assert.equal(allowed.body.policy.revision, 1);

  await request(app)
    .delete(route)
    .set(...BEARER)
    .expect(403);
  await request(app)
    .delete(route)
    .set(...COOKIE)
    .expect(200, { deleted: true });
});

test('model policy API rejects invalid scopes and vendor parameters', async (t) => {
  const app = setupApp(t);

  await request(app)
    .put('/api/model-policies/codebase/nonexistent-project/codex')
    .set(...COOKIE)
    .send({ params: {} })
    .expect(404);
  await request(app)
    .put('/api/model-policies/global/*/codex')
    .set(...COOKIE)
    .send({ params: { tier: '__cli_default__' } })
    .expect(400);
  await request(app)
    .put('/api/model-policies/global/*/claude')
    .set(...COOKIE)
    .send({ params: { reasoning_effort: 'high' } })
    .expect(400);
  await request(app)
    .put('/api/model-policies/layer:top/*/claude')
    .set(...COOKIE)
    .send({ params: { model: 'x'.repeat(999) } })
    .expect(400);
});
