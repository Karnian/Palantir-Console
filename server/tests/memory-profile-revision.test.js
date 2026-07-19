'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');
const { buildProfileAdapter } = require('../services/memoryComposer');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-profile-revision-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  const { db } = handle;
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.prepare("INSERT INTO operator_profiles(id, name) VALUES('op_rev_a', 'Revision A')").run();
  db.prepare("INSERT INTO operator_profiles(id, name) VALUES('op_rev_b', 'Revision B')").run();
  db.prepare("INSERT INTO projects(id, name) VALUES('proj_rev', 'Revision project')").run();
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, svc: createMemoryService(db) };
}

function createProfileItem(svc, profileId, content) {
  return svc.createMemoryItem({
    profileId,
    kind: 'convention',
    content,
    origin: 'human',
    status: 'active',
  });
}

function createWorkspaceItem(svc, content) {
  return svc.createMemoryItem({
    projectId: 'proj_rev',
    kind: 'convention',
    content,
    origin: 'human',
    status: 'active',
  });
}

test('profile and workspace active-set mutations bump only their owner revision', (t) => {
  const { db, svc } = setup(t);

  const profileOne = createProfileItem(svc, 'op_rev_a', 'profile revision first');
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 1);
  const profileTwo = createProfileItem(svc, 'op_rev_a', 'profile revision second');
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 2);

  const workspace = createWorkspaceItem(svc, 'workspace revision first');
  assert.equal(svc.getRevision('proj_rev'), 1);
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 2);

  svc.updateMemoryContent({ id: profileOne.id, content: 'profile revision updated' });
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 3);
  svc.archiveMemory(profileOne.id);
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 4);
  svc.restoreMemory(profileOne.id);
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 5);
  assert.equal(svc.getRevision('proj_rev'), 1);

  svc.updateMemoryContent({ id: workspace.id, content: 'workspace revision updated' });
  assert.equal(svc.getRevision('proj_rev'), 2);
  svc.archiveMemory(workspace.id);
  assert.equal(svc.getRevision('proj_rev'), 3);
  svc.restoreMemory(workspace.id);
  assert.equal(svc.getRevision('proj_rev'), 4);
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 5);

  svc.setPinned({ id: profileTwo.id, pinned: true });
  svc.markReviewed(profileTwo.id);
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 5, 'pin/review are revision-invariant');

  const expiringProfile = createProfileItem(svc, 'op_rev_a', 'profile revision expiry');
  const expiringWorkspace = createWorkspaceItem(svc, 'workspace revision expiry');
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 6);
  assert.equal(svc.getRevision('proj_rev'), 5);
  db.prepare("UPDATE memory_items SET valid_to='2000-01-01 00:00:00' WHERE id IN (?, ?)")
    .run(expiringProfile.id, expiringWorkspace.id);
  assert.equal(svc.expireStaleMemories(), 2);
  assert.equal(svc.getRevisionForOwner('profile', 'op_rev_a'), 7);
  assert.equal(svc.getRevision('proj_rev'), 6);

  const adapter = buildProfileAdapter(svc);
  assert.equal(adapter.getRevision('op_rev_a'), 7);
  assert.notEqual(adapter.getRevision('op_rev_a'), 0);
});

test('profile revision parity is scanned separately and FK deletion cascades', (t) => {
  const { db, svc } = setup(t);

  createProfileItem(svc, 'op_rev_a', 'profile parity normal');
  assert.deepEqual(
    svc.checkOwnerParity().filter((m) => m.table === 'profile_memory_revision'),
    [],
  );

  createProfileItem(svc, 'op_rev_b', 'profile parity corruptible');
  db.prepare("UPDATE profile_memory_revision SET owner_id='wrong-profile' WHERE profile_id='op_rev_b'").run();
  const mismatches = svc.checkOwnerParity().filter((m) => m.table === 'profile_memory_revision');
  assert.equal(mismatches.length, 1);
  assert.deepEqual(mismatches[0], {
    table: 'profile_memory_revision',
    pk: 'op_rev_b',
    expected: { owner_type: 'profile', owner_id: 'op_rev_b' },
    actual: { owner_type: 'profile', owner_id: 'wrong-profile' },
  });

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profile_memory_revision WHERE profile_id='op_rev_a'").get().n, 1);
  db.prepare("DELETE FROM operator_profiles WHERE id='op_rev_a'").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profile_memory_revision WHERE profile_id='op_rev_a'").get().n, 0);

  const workspaceParity = svc.checkOwnerParity().filter((m) => m.table === 'project_memory_revision');
  assert.deepEqual(workspaceParity, []);
});
