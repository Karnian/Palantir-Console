'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');
const { createMemoryDistillService } = require('../services/memoryDistillService');
const { createFakeDistiller } = require('../services/distillers/fakeDistiller');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-profile-distill-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  handle.db.prepare("INSERT INTO projects(id, name) VALUES('p1', 'Workspace One')").run();
  handle.db.prepare("INSERT INTO operator_profiles(id, name) VALUES('op_x', 'Operator X')").run();
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db: handle.db, svc: createMemoryService(handle.db) };
}

function candidateRaw(content = 'Prefer explicit owner keys in memory pipelines.') {
  return { schema_version: 1, rule: 'R4', content };
}

function conventionDistiller(calls = []) {
  return createFakeDistiller((input) => {
    calls.push(input);
    return input.candidates.map((candidate) => ({
      candidateId: candidate.id,
      kind: 'convention',
      content: 'Use explicit owner keys throughout the memory distill pipeline.',
      confidence: 0.6,
      importance: 6,
    }));
  });
}

test('profile candidate drains through distill and promote into active profile memory', async (t) => {
  const { db, svc } = setup(t);
  const calls = [];
  const candidate = svc.createCandidate({
    profileId: 'op_x',
    rule: 'R4',
    rawJson: candidateRaw(),
    dedupKey: 'profile-k1',
  });

  const results = await createMemoryDistillService({
    memoryService: svc,
    distiller: conventionDistiller(calls),
  }).drainAll();

  assert.equal(results.length, 1);
  assert.equal(results[0].promoted.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, null);
  assert.equal(calls[0].ownerType, 'profile');
  assert.equal(calls[0].ownerId, 'op_x');
  const item = db.prepare("SELECT * FROM memory_items WHERE owner_type='profile' AND owner_id='op_x'").get();
  assert.ok(item);
  assert.equal(item.project_id, null);
  assert.equal(item.status, 'active');
  assert.equal(item.kind, 'convention');
  assert.equal(db.prepare('SELECT status FROM memory_candidates WHERE id=?').get(candidate.id).status, 'promoted');
  assert.equal(svc.getRevisionForOwner('profile', 'op_x'), 1);
});

test('workspace wrappers preserve owner-core results and workspace promotion shape', async (t) => {
  const { db, svc } = setup(t);
  svc.createCandidate({
    projectId: 'p1',
    rule: 'R4',
    rawJson: candidateRaw(),
    dedupKey: 'workspace-k1',
  });
  assert.deepEqual(
    svc.listCandidates('p1', 'pending'),
    svc.listCandidatesForOwner('workspace', 'p1', 'pending'),
  );

  svc.enqueueDistillJob('p1');
  const result = await createMemoryDistillService({
    memoryService: svc,
    distiller: conventionDistiller(),
  }).runOnce({ projectId: 'p1' });

  assert.equal(result.promoted.length, 1);
  const item = db.prepare("SELECT * FROM memory_items WHERE owner_type='workspace' AND owner_id='p1'").get();
  assert.ok(item);
  assert.equal(item.project_id, 'p1');
  assert.equal(item.status, 'active');
});

test('claim supports cross-owner oldest and workspace-exact selection; profile enqueue is single-flight', (t) => {
  const { db, svc } = setup(t);
  const profileFirst = svc.enqueueDistillJobForOwner('profile', 'op_x');
  const profileSecond = svc.enqueueDistillJobForOwner('profile', 'op_x');
  assert.equal(profileFirst.created, true);
  assert.equal(profileSecond.created, false);
  assert.equal(profileSecond.job.id, profileFirst.job.id);
  svc.enqueueDistillJob('p1');
  db.prepare("UPDATE memory_jobs SET created_at='2000-01-01 00:00:00' WHERE owner_type='profile'").run();
  db.prepare("UPDATE memory_jobs SET created_at='2000-01-02 00:00:00' WHERE owner_type='workspace'").run();

  const oldest = svc.claimDistillJob({});
  assert.equal(oldest.owner_type, 'profile');
  assert.equal(oldest.owner_id, 'op_x');
  const workspace = svc.claimDistillJob({ projectId: 'p1' });
  assert.equal(workspace.owner_type, 'workspace');
  assert.equal(workspace.owner_id, 'p1');
  assert.throws(
    () => svc.claimDistillJob({ projectId: 'p1', ownerType: 'profile', ownerId: 'op_x' }),
    /mutually exclusive/,
  );
});

test('drainAll enqueues and drains both profile and workspace owners without skip warning', async (t) => {
  const { db, svc } = setup(t);
  const warnings = [];
  svc.createCandidate({ profileId: 'op_x', rule: 'R4', rawJson: candidateRaw(), dedupKey: 'both-profile' });
  svc.createCandidate({ projectId: 'p1', rule: 'R4', rawJson: candidateRaw(), dedupKey: 'both-workspace' });

  const results = await createMemoryDistillService({
    memoryService: svc,
    distiller: conventionDistiller(),
    logger: { warn: (message) => warnings.push(message) },
  }).drainAll();

  assert.equal(results.length, 2);
  assert.deepEqual(
    db.prepare("SELECT owner_type, owner_id, status FROM memory_jobs ORDER BY owner_type, owner_id").all(),
    [
      { owner_type: 'profile', owner_id: 'op_x', status: 'done' },
      { owner_type: 'workspace', owner_id: 'p1', status: 'done' },
    ],
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE status='active'").get().n, 2);
  assert.equal(warnings.some((message) => message.includes('skip non-workspace owner')), false);
});
