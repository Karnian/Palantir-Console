// ML PR5a — hard-cap admission control. A new active row enters a FULL project
// only by beating the lowest-score EVICTABLE item (active, unpinned, non-human).
// score = confidence*importance. human/pinned are never evicted.
// NOTE: promote clamps incoming confidence to the ceiling (0.7 default), so test
// scores stay in the realistic post-promote range.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-cap-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => { try { close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
  return db;
}

function seedActive(svc, { content, confidence, importance, origin = 'batch_llm', pinned = 0 }) {
  const item = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content, origin, confidence, importance, status: 'active' });
  if (pinned) svc.setPinned({ id: item.id, pinned: true });
  return item;
}

let dedupN = 0;
function promoteOne(svc, { content, confidence, importance, activeCap }) {
  const c = svc.createCandidate({ projectId: 'p1', rule: 'R1b', rawJson: { rule: 'R1b' }, dedupKey: `cap-${dedupN += 1}` });
  svc.enqueueDistillJob('p1');
  const job = svc.claimDistillJob({});
  return svc.promoteCandidates({
    jobId: job.id, claimToken: job.claim_token, activeCap,
    proposals: [{ candidateId: c.id, kind: 'pitfall', content, confidence, importance }],
  });
}

test('migration 029: archive_reason column exists', (t) => {
  const db = setupDb(t);
  const cols = db.prepare('PRAGMA table_info(memory_items)').all().map((c) => c.name);
  assert.ok(cols.includes('archive_reason'));
});

test('cap admission: incoming beats lowest evictable -> victim archived, new promoted', (t) => {
  const svc = createMemoryService(setupDb(t));
  seedActive(svc, { content: 'low score item', confidence: 0.3, importance: 2 });  // 0.6
  seedActive(svc, { content: 'high score item', confidence: 0.7, importance: 8 }); // 5.6
  const res = promoteOne(svc, { content: 'incoming strong', confidence: 0.7, importance: 9, activeCap: 2 }); // 6.3
  assert.equal(res.promoted.length, 1);
  assert.equal(res.evicted.length, 1);
  const active = svc.listForProject('p1');
  assert.equal(active.length, 2, 'still at cap (evict 1 + add 1)');
  assert.ok(!active.some((m) => m.content === 'low score item'), 'lowest-score item evicted');
  assert.ok(active.some((m) => m.content === 'incoming strong'));
});

test('cap admission: incoming <= victim -> skipped, no eviction', (t) => {
  const svc = createMemoryService(setupDb(t));
  seedActive(svc, { content: 'item a', confidence: 0.7, importance: 8 }); // 5.6
  seedActive(svc, { content: 'item b', confidence: 0.7, importance: 7 }); // 4.9
  const res = promoteOne(svc, { content: 'weak incoming', confidence: 0.2, importance: 2, activeCap: 2 }); // 0.4
  assert.equal(res.promoted.length, 0);
  assert.equal(res.evicted.length, 0);
  assert.equal(res.skipped[0].reason, 'active_cap_low_score');
  assert.equal(svc.listForProject('p1').length, 2);
});

test('cap admission: all active protected (human + pinned) -> all_protected skip', (t) => {
  const svc = createMemoryService(setupDb(t));
  seedActive(svc, { content: 'human item', confidence: 0.3, importance: 2, origin: 'human' });
  seedActive(svc, { content: 'pinned item', confidence: 0.3, importance: 2, pinned: 1 });
  const res = promoteOne(svc, { content: 'incoming x', confidence: 0.7, importance: 9, activeCap: 2 });
  assert.equal(res.promoted.length, 0);
  assert.equal(res.skipped[0].reason, 'active_cap_all_protected');
  assert.equal(svc.listForProject('p1').length, 2);
});

test('cap admission: human/pinned never evicted even when lowest score', (t) => {
  const svc = createMemoryService(setupDb(t));
  seedActive(svc, { content: 'human low', confidence: 0.1, importance: 1, origin: 'human' }); // 0.1, protected
  seedActive(svc, { content: 'batch mid', confidence: 0.5, importance: 4 });                  // 2.0, evictable
  const res = promoteOne(svc, { content: 'incoming', confidence: 0.7, importance: 9, activeCap: 2 }); // 6.3
  assert.equal(res.evicted.length, 1);
  const active = svc.listForProject('p1');
  assert.ok(active.some((m) => m.content === 'human low'), 'human protected, not evicted');
  assert.ok(!active.some((m) => m.content === 'batch mid'), 'evictable batch item evicted');
});

test('cap admission: a merge bypasses the cap (no new row)', (t) => {
  const svc = createMemoryService(setupDb(t));
  seedActive(svc, { content: 'duplicate content here', confidence: 0.5, importance: 5 });
  seedActive(svc, { content: 'other item here', confidence: 0.5, importance: 5 });
  const res = promoteOne(svc, { content: 'duplicate content here', confidence: 0.5, importance: 5, activeCap: 2 });
  assert.equal(res.promoted.length, 1);
  assert.equal(res.promoted[0].merged, true);
  assert.equal(res.evicted.length, 0);
  assert.equal(svc.listForProject('p1').length, 2);
});

test('cap admission: emits memory:evicted + memory:promoted events', (t) => {
  const db = setupDb(t);
  const events = [];
  const eventBus = { emit: (channel, data) => events.push({ channel, data }), subscribe: () => {} };
  const svc = createMemoryService(db, eventBus);
  seedActive(svc, { content: 'low ev', confidence: 0.2, importance: 2 });
  seedActive(svc, { content: 'mid ev', confidence: 0.5, importance: 5 });
  promoteOne(svc, { content: 'strong ev', confidence: 0.7, importance: 9, activeCap: 2 });
  assert.ok(events.some((e) => e.channel === 'memory:evicted'), 'evicted event emitted');
  assert.ok(events.some((e) => e.channel === 'memory:promoted'), 'promoted event emitted');
});

test('cap admission: restore into a full project evicts a weaker victim (Codex BLOCKER)', (t) => {
  const svc = createMemoryService(setupDb(t));
  const arch = seedActive(svc, { content: 'to restore strong', confidence: 0.7, importance: 8 }); // 5.6
  svc.archiveMemory(arch.id); // active now 0
  seedActive(svc, { content: 'occupant low', confidence: 0.2, importance: 2 }); // 0.4, fills cap=1
  const r = svc.restoreMemory(arch.id, { activeCap: 1 });
  assert.ok(r && r.status === 'active');
  const active = svc.listForProject('p1');
  assert.equal(active.length, 1);
  assert.ok(active.some((m) => m.content === 'to restore strong'));
  assert.ok(!active.some((m) => m.content === 'occupant low'), 'weaker occupant evicted');
});

test('cap admission: restore rejected when it cannot beat the victim -> MEMORY_CAP_FULL', (t) => {
  const svc = createMemoryService(setupDb(t));
  const arch = seedActive(svc, { content: 'weak restore', confidence: 0.1, importance: 1 }); // 0.1
  svc.archiveMemory(arch.id);
  seedActive(svc, { content: 'strong occupant', confidence: 0.7, importance: 8 }); // 5.6
  assert.throws(() => svc.restoreMemory(arch.id, { activeCap: 1 }), (e) => e.code === 'MEMORY_CAP_FULL');
  assert.equal(svc.getMemoryItem(arch.id).status, 'archived', 'rejected restore leaves it archived');
});

test('archive_reason: manual on archive, cleared on restore (Codex SERIOUS)', (t) => {
  const svc = createMemoryService(setupDb(t));
  const a = seedActive(svc, { content: 'reason item', confidence: 0.5, importance: 5 });
  svc.archiveMemory(a.id);
  assert.equal(svc.getMemoryItem(a.id).archive_reason, 'manual', 'manual archive tagged');
  svc.restoreMemory(a.id, { activeCap: 10 });
  assert.equal(svc.getMemoryItem(a.id).archive_reason, null, 'restore clears stale reason');
});

test('archive_reason: cap_evicted set on eviction', (t) => {
  const svc = createMemoryService(setupDb(t));
  const victim = seedActive(svc, { content: 'evicted victim', confidence: 0.2, importance: 2 });
  seedActive(svc, { content: 'other strong', confidence: 0.7, importance: 8 });
  promoteOne(svc, { content: 'incoming wins', confidence: 0.7, importance: 9, activeCap: 2 });
  assert.equal(svc.getMemoryItem(victim.id).status, 'archived');
  assert.equal(svc.getMemoryItem(victim.id).archive_reason, 'cap_evicted');
});

test('cap admission: under cap -> normal promote, no eviction', (t) => {
  const svc = createMemoryService(setupDb(t));
  seedActive(svc, { content: 'only item', confidence: 0.5, importance: 5 });
  const res = promoteOne(svc, { content: 'second item', confidence: 0.6, importance: 6, activeCap: 5 });
  assert.equal(res.promoted.length, 1);
  assert.equal(res.evicted.length, 0);
  assert.equal(svc.listForProject('p1').length, 2);
});
