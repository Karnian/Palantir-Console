'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

async function createTestApp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-agents-route-'));
  const storageRoot = path.join(root, 'storage');
  const fsRoot = path.join(root, 'fs');
  await fs.mkdir(storageRoot);
  await fs.mkdir(fsRoot);
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath: path.join(root, 'test.db'),
    opencodeBin: 'opencode',
    authToken: null,
    authResolverOpts: {
      hasKeychain: () => false,
      hasCredentialsFile: () => false,
    },
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return app;
}

function api(app, method, requestPath, body) {
  return invokeApp(app, {
    method,
    path: requestPath,
    body,
  });
}

test('MUTATION: /api/agents refuses deletion while a resumable manager pins the profile', async (t) => {
  const app = await createTestApp(t);
  const created = await api(app, 'POST', '/api/agents', {
    name: 'ZZZ pinned Codex',
    type: 'codex',
    command: 'codex',
    env_allowlist: '["PIN_ONLY"]',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const profileId = created.body.agent.id;
  const run = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    manager_adapter: 'codex',
    agent_profile_id: profileId,
    conversation_id: 'top',
    prompt: 'pinned profile deletion guard',
  });

  const blocked = await api(app, 'DELETE', `/api/agents/${profileId}`);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(JSON.stringify(blocked.body), new RegExp(run.id));
  assert.equal((await api(app, 'GET', `/api/agents/${profileId}`)).status, 200);

  app.services.runService.updateRunStatus(run.id, 'stopped', { force: true });
  const deleted = await api(app, 'DELETE', `/api/agents/${profileId}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await api(app, 'GET', `/api/agents/${profileId}`)).status, 404);
});
