'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createApp } = require('../app');

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-router-http-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-router-http-fs-'));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-router-http-db-'));
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath: path.join(dbDir, 'test.db'),
    authResolverOpts: { hasKeychain: true },
    authToken: null,
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}

test('A2b-3a router HTTP passes through codebase context for an Operator mention', async (t) => {
  const app = await createTestApp(t);
  const { project: beta } = (await request(app).post('/api/projects').send({ name: 'beta' })).body;

  const res = await request(app).post('/api/router/resolve').send({
    text: '@beta hi',
    currentConversationId: 'operator:oi_current',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    target: 'operator:oi_current',
    codebaseProjectId: beta.id,
    turnMode: 'codebase',
    text: 'hi',
    matchedRule: '1_explicit',
  });
});

test('A2b-3a router HTTP keeps Top mention rerouting free of codebase context', async (t) => {
  const app = await createTestApp(t);
  const { project: alpha } = (await request(app).post('/api/projects').send({ name: 'alpha' })).body;

  const res = await request(app).post('/api/router/resolve').send({
    text: '@alpha status',
    currentConversationId: 'top',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.target, `operator:${alpha.id}`);
  assert.equal(res.body.text, 'status');
  assert.equal(res.body.matchedRule, '1_explicit');
  assert.equal(Object.hasOwn(res.body, 'codebaseProjectId'), false);
  assert.equal(Object.hasOwn(res.body, 'turnMode'), false);
});
