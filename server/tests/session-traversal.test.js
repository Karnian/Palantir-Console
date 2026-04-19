const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createStorageContext } = require('../services/storage');
const { createSessionService } = require('../services/sessionService');
const { isWithinRoot } = require('../utils/pathGuard');
const { hasInvalidSessionProjectId } = require('../routes/sessions');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestService(t) {
  const storageRoot = await createTempDir('palantir-storage-');
  const fsRoot = await createTempDir('palantir-fs-');
  const storage = createStorageContext({ storageRoot, fsRoot });
  const sessionService = createSessionService(storage);

  t.after(async () => {
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
  });

  return { sessionService, storageRoot };
}

test('isWithinRoot allows descendants and blocks traversal outside the root', () => {
  const root = path.join(os.tmpdir(), 'palantir-path-root');
  assert.equal(isWithinRoot(root, root), true);
  assert.equal(isWithinRoot(root, path.join(root, 'child', 'session.json')), true);
  assert.equal(isWithinRoot(root, path.join(root, '..', 'escape')), false);
});

test('session route validator rejects traversal-like project ids', () => {
  const blocked = ['../../etc', 'foo/bar', '..', '.', 'foo\\bar', 123];
  for (const projectId of blocked) {
    assert.equal(hasInvalidSessionProjectId(projectId), true, `expected invalid for ${String(projectId)}`);
  }
  for (const projectId of [null, undefined, '', 'valid-project']) {
    assert.equal(hasInvalidSessionProjectId(projectId), false, `expected valid for ${String(projectId)}`);
  }
});

test('session service rejects project ids that escape the session root', async (t) => {
  const { sessionService } = await createTestService(t);

  await assert.rejects(
    () => sessionService.createSession({
      title: 'Blocked',
      projectId: '../../etc',
      directory: '/tmp',
    }),
    /Invalid projectId/
  );
});

test('session service accepts a normal project id and writes inside session root', async (t) => {
  const { sessionService, storageRoot } = await createTestService(t);

  const session = await sessionService.createSession({
    title: 'Valid',
    projectId: 'valid-project',
    directory: '/tmp',
  });

  const sessionPath = path.join(storageRoot, 'session', 'valid-project', `${session.id}.json`);
  const raw = await fs.readFile(sessionPath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.projectID, 'valid-project');
});

test('session service with null projectId falls back to global', async (t) => {
  const { sessionService, storageRoot } = await createTestService(t);

  const session = await sessionService.createSession({
    title: 'Global Session',
    projectId: null,
    directory: '/tmp',
  });

  const sessionPath = path.join(storageRoot, 'session', 'global', `${session.id}.json`);
  const raw = await fs.readFile(sessionPath, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.projectID, 'global');
});
