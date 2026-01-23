const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await createTempDir('palantir-storage-');
  const fsRoot = await createTempDir('palantir-fs-');
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode' });

  t.after(async () => {
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
  });

  return { app, storageRoot, fsRoot };
}

async function writeSession(storageRoot, session) {
  const sessionDir = path.join(storageRoot, 'session', session.projectID || 'global');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, `${session.id}.json`),
    `${JSON.stringify(session, null, 2)}\n`,
    'utf8'
  );
}

test('GET /api/sessions returns empty list', async (t) => {
  const { app, storageRoot } = await createTestApp(t);
  const res = await request(app).get('/api/sessions');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sessions, []);
  assert.equal(res.body.storageRoot, storageRoot);
});

test('POST /api/sessions validates and creates session', async (t) => {
  const { app } = await createTestApp(t);
  const bad = await request(app).post('/api/sessions').send({});

  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'title is required');

  const res = await request(app)
    .post('/api/sessions')
    .send({ title: 'My Session', projectId: 'global', directory: '/tmp' });

  assert.equal(res.status, 201);
  assert.ok(res.body.session);
  assert.ok(res.body.session.id);
  assert.equal(res.body.session.title, 'My Session');
});

test('PATCH /api/sessions/:id renames session', async (t) => {
  const { app, storageRoot } = await createTestApp(t);
  const session = {
    id: 'ses_test_rename',
    projectID: 'global',
    title: 'Old Title',
    time: { created: Date.now(), updated: Date.now() }
  };
  await writeSession(storageRoot, session);

  const res = await request(app)
    .patch(`/api/sessions/${session.id}`)
    .send({ title: 'New Title' });

  assert.equal(res.status, 200);
  assert.equal(res.body.session.title, 'New Title');
});

test('DELETE /api/sessions/:id moves session to trash', async (t) => {
  const { app, storageRoot } = await createTestApp(t);
  const session = {
    id: 'ses_test_delete',
    projectID: 'global',
    title: 'Delete Me',
    time: { created: Date.now(), updated: Date.now() }
  };
  await writeSession(storageRoot, session);

  const res = await request(app).delete(`/api/sessions/${session.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');

  const trash = await request(app).get('/api/trash/sessions');
  assert.equal(trash.status, 200);
  assert.ok(Array.isArray(trash.body.items));
  assert.equal(trash.body.items.length, 1);
});

test('GET /api/fs lists directories and blocks escapes', async (t) => {
  const { app, fsRoot } = await createTestApp(t);
  const childDir = path.join(fsRoot, 'projects');
  await fs.mkdir(childDir, { recursive: true });

  const res = await request(app).get('/api/fs');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.directories));
  assert.equal(res.body.root, fsRoot);

  const blocked = await request(app).get('/api/fs?path=/');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'Path not allowed');
});
