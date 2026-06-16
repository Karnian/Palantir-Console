// ML PR5d — decay: TTL on auto memories + valid_to normalization + maintenance
// expiry (active -> archived) so stale memory stops being injected and frees cap.
// human / pinned / fact rows never get a valid_to, so they never decay.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-decay-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => { try { close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P1')").run();
  return db;
}

let dn = 0;
function promote(svc, { content, ttlDays }) {
  const c = svc.createCandidate({ projectId: 'p1', rule: 'R1b', rawJson: { rule: 'R1b' }, dedupKey: `decay-${dn += 1}` });
  svc.enqueueDistillJob('p1');
  const job = svc.claimDistillJob({});
  const res = svc.promoteCandidates({
    jobId: job.id, claimToken: job.claim_token, ttlDays,
    proposals: [{ candidateId: c.id, kind: 'pitfall', content, confidence: 0.6, importance: 5 }],
  });
  svc.releaseDistillJob({ jobId: job.id, claimToken: job.claim_token, outcome: 'done' });
  return res;
}

test('promote stamps a TTL valid_to on a freshly-promoted auto memory', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const res = promote(svc, { content: 'auto lesson with ttl', ttlDays: 90 });
  const item = svc.getMemoryItem(res.promoted[0].itemId);
  assert.ok(item.valid_to, 'valid_to set');
  // ~90 days out
  const days = (new Date(item.valid_to + 'Z') - Date.now()) / 86400000;
  assert.ok(days > 80 && days < 100, `valid_to ~90 days out, got ${days.toFixed(1)}`);
});

test('promote ttlDays=0 -> no valid_to (permanent)', (t) => {
  const svc = createMemoryService(setupDb(t));
  const res = promote(svc, { content: 'permanent auto lesson', ttlDays: 0 });
  assert.equal(svc.getMemoryItem(res.promoted[0].itemId).valid_to, null);
});

test('expireStaleMemories: archives expired active rows (ttl_expired), bumps revision', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const item = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'about to expire', origin: 'batch_llm' });
  db.prepare("UPDATE memory_items SET valid_to = datetime('now','-1 hour') WHERE id=?").run(item.id);
  const rev0 = svc.getRevision('p1');
  const n = svc.expireStaleMemories();
  assert.equal(n, 1);
  const after = svc.getMemoryItem(item.id);
  assert.equal(after.status, 'archived');
  assert.equal(after.archive_reason, 'ttl_expired');
  assert.ok(svc.getRevision('p1') > rev0, 'expiry bumps revision (active set changed)');
  assert.equal(svc.listForProject('p1').length, 0);
});

test('expireStaleMemories: leaves human/pinned (no valid_to) untouched', (t) => {
  const svc = createMemoryService(setupDb(t));
  svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'human permanent', origin: 'human' });
  const p = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'pinned permanent', origin: 'batch_llm' });
  svc.setPinned({ id: p.id, pinned: true });
  assert.equal(svc.expireStaleMemories(), 0, 'nothing to expire (no valid_to)');
  assert.equal(svc.listForProject('p1').length, 2);
});

test('valid_to normalization: an ISO-format (T/Z) past valid_to is still excluded from retrieve', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const item = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'iso expired lesson', origin: 'batch_llm' });
  // write an ISO-8601 timestamp (T + Z) in the past — lexicographic compare vs
  // 'YYYY-MM-DD HH:MM:SS' would mishandle this; datetime() normalization fixes it.
  db.prepare("UPDATE memory_items SET valid_to = ? WHERE id=?").run('2020-01-01T00:00:00Z', item.id);
  const contents = svc.retrieveForProject('p1').map((r) => r.content);
  assert.ok(!contents.includes('iso expired lesson'), 'ISO-format expired row excluded after datetime() normalization');
});

test('expireStaleMemories: emits memory:decayed when something expires', (t) => {
  const db = setupDb(t);
  const events = [];
  const eventBus = { emit: (channel, data) => events.push({ channel, data }), subscribe: () => {} };
  const svc = createMemoryService(db, eventBus);
  const item = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'expiring soon', origin: 'batch_llm' });
  db.prepare("UPDATE memory_items SET valid_to = datetime('now','-1 hour') WHERE id=?").run(item.id);
  svc.expireStaleMemories();
  assert.ok(events.some((e) => e.channel === 'memory:decayed'));
});

test('markReviewed extends valid_to for auto memory (re-observation refresh); permanent rows stay NULL', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const auto = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'auto soon to expire', origin: 'batch_llm' });
  db.prepare("UPDATE memory_items SET valid_to = datetime('now','+1 day') WHERE id=?").run(auto.id);
  const before = svc.getMemoryItem(auto.id).valid_to;
  const r = svc.markReviewed(auto.id, { ttlDays: 90 });
  assert.ok(r.valid_to > before, 'review extends valid_to');
  const days = (new Date(r.valid_to + 'Z') - Date.now()) / 86400000;
  assert.ok(days > 80, `extended ~90 days, got ${days.toFixed(1)}`);
  // a permanent (human) row has no valid_to and stays permanent after review.
  const human = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'human permanent item', origin: 'human' });
  assert.equal(svc.markReviewed(human.id).valid_to, null);
});
