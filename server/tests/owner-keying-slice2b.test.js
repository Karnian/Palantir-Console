'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createMasterMemoryService } = require('../services/masterMemoryService');
const { runSlice2aMerge } = require('../services/ownerMergeSlice2a');
const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

const migrationsDir = path.join(__dirname, '../db/migrations');
const COOKIE = { Cookie: 'palantir_token=secret-token' };

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function applyMigrationsThrough(db, maxVersion) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const files = fs.readdirSync(migrationsDir)
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const version = Number.parseInt(file.split('_')[0], 10);
    if (version > maxVersion) break;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      if (version === 34) runSlice2aMerge(db);
      db.exec(sql);
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
    })();
  }
}

function setupDb(t, maxVersion = 34) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-ok-slice2b-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  applyMigrationsThrough(db, maxVersion);

  t.after(() => {
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return db;
}

async function setupApp(t) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-ok-slice2b-app-'));
  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false },
    authToken: 'secret-token',
  });
  t.after(async () => {
    try { if (app.shutdown) app.shutdown(); else app.closeDb(); } catch { /* ignore */ }
    await fsp.rm(tmp, { recursive: true, force: true });
  });
  return app;
}

function seedItem(db, overrides = {}) {
  const content = overrides.content || `slice2b content ${crypto.randomUUID()}`;
  const kind = overrides.kind || (overrides.factKey ? 'fact' : 'pattern');
  const row = {
    id: overrides.id || crypto.randomUUID(),
    scope: overrides.scope || 'user',
    project_id: overrides.projectId || null,
    kind,
    fact_key: kind === 'fact' ? overrides.factKey : null,
    content,
    content_hash: overrides.contentHash || sha256(content),
    evidence_json: JSON.stringify(overrides.evidence || {}),
    origin: overrides.origin || 'deterministic',
    source_count: overrides.sourceCount ?? 1,
    confidence: overrides.confidence ?? 0.5,
    importance: overrides.importance ?? 5,
    pinned: overrides.pinned ? 1 : 0,
    status: overrides.status || 'active',
    valid_to: overrides.validTo ?? null,
    archived_at: overrides.archivedAt ?? null,
    archive_reason: overrides.archiveReason ?? null,
    created_at: overrides.createdAt || '2026-01-01 00:00:00',
    updated_at: overrides.updatedAt || '2026-01-01 00:00:00',
    owner_type: overrides.ownerType || 'user',
    owner_id: overrides.ownerId || 'user',
  };

  db.prepare(`
    INSERT INTO master_memory_items (
      id, scope, project_id, kind, fact_key, content, content_hash,
      evidence_json, origin, source_count, confidence, importance, pinned,
      status, valid_to, archived_at, archive_reason, created_at, updated_at,
      owner_type, owner_id
    ) VALUES (
      @id, @scope, @project_id, @kind, @fact_key, @content, @content_hash,
      @evidence_json, @origin, @source_count, @confidence, @importance, @pinned,
      @status, @valid_to, @archived_at, @archive_reason, @created_at, @updated_at,
      @owner_type, @owner_id
    )
  `).run(row);

  return row;
}

function activeOwnerCount(db) {
  return db.prepare(`
    SELECT COUNT(*) AS n
    FROM master_memory_items
    WHERE owner_type='user' AND owner_id='user' AND status='active'
  `).get().n;
}

test('1. owner-keyed retrieve can span owner pool and optionally filter provenance', (t) => {
  const db = setupDb(t);
  const user = seedItem(db, {
    id: 'owner-read-user',
    scope: 'user',
    content: 'owner pool user provenance row',
    importance: 8,
  });
  const cross = seedItem(db, {
    id: 'owner-read-cross',
    scope: 'cross_project',
    content: 'owner pool cross provenance row',
    importance: 7,
  });
  const svc = createMasterMemoryService(db);

  const allIds = svc.retrieve('user', 'user', {}).map((row) => row.id);
  assert.ok(allIds.includes(user.id));
  assert.ok(allIds.includes(cross.id));

  assert.deepEqual(svc.retrieve('user', 'user', { provenance: 'user' }).map((row) => row.id), [user.id]);
  assert.deepEqual(svc.retrieve('user', 'user', { provenance: 'cross_project' }).map((row) => row.id), [cross.id]);
  assert.deepEqual(svc.retrieve('user', {}).map((row) => row.id), [user.id], 'old scope-form remains provenance-scoped');
});

test('2. A1 exact-then-prefix retrieval ordering is preserved within owner pool', (t) => {
  const db = setupDb(t);
  const exact = seedItem(db, {
    id: 'a1-exact',
    scope: 'cross_project',
    content: 'alpha anchor exact owner row',
    importance: 1,
  });
  const prefix = seedItem(db, {
    id: 'a1-prefix',
    scope: 'user',
    content: 'anchorx prefix owner row',
    importance: 10,
  });
  const svc = createMasterMemoryService(db);

  const ids = svc.retrieve('user', 'user', { taskContext: 'anchor', limit: 12 }).map((row) => row.id);
  assert.ok(ids.includes(exact.id));
  assert.ok(ids.includes(prefix.id));
  assert.ok(ids.indexOf(exact.id) < ids.indexOf(prefix.id), 'exact hit stays before prefix-only hit');
});

test('3. write merge fixes cross-scope content, fact, and candidate owner collisions', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);

  const existing = svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'shared owner duplicate content',
    origin: 'deterministic',
  });
  const merged = svc.createMemoryItem({
    scope: 'cross_project',
    kind: 'pattern',
    content: 'shared owner duplicate content',
    origin: 'deterministic',
  });
  assert.equal(merged.id, existing.id);
  assert.equal(merged.source_count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE content_hash=? AND status='active'").get(existing.content_hash).n, 1);

  const fact1 = svc.upsertFact({
    scope: 'user',
    factKey: 'slice2b.fact',
    content: 'old deterministic fact',
    origin: 'deterministic',
  });
  const fact2 = svc.upsertFact({
    scope: 'cross_project',
    factKey: 'slice2b.fact',
    content: 'new deterministic fact',
    origin: 'deterministic',
  });
  assert.notEqual(fact2.id, fact1.id);
  assert.equal(svc.getMemoryItem(fact1.id).status, 'superseded');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE fact_key='slice2b.fact' AND status='active'").get().n, 1);

  const candidate = svc.createCandidate({
    scope: 'user',
    rule: 'R4',
    rawJson: { schema_version: 1, kind: 'preference', content: 'candidate owner dedup' },
    dedupKey: 'owner-candidate-dedup',
  });
  const crossCandidate = svc.createCandidate({
    scope: 'cross_project',
    rule: 'R4',
    rawJson: { schema_version: 1, kind: 'preference', content: 'candidate owner dedup' },
    dedupKey: 'owner-candidate-dedup',
  });
  assert.equal(crossCandidate.id, candidate.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_candidates WHERE rule='R4' AND dedup_key='owner-candidate-dedup'").get().n, 1);
});

test('4. human active rows are never downgraded by non-human content or fact writes', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);

  const human = svc.remember({
    scope: 'user',
    kind: 'preference',
    content: 'human protected duplicate content',
  });
  const llm = svc.createMemoryItem({
    scope: 'cross_project',
    kind: 'preference',
    content: 'human protected duplicate content',
    origin: 'llm_candidate',
    confidence: 1,
    importance: 10,
  });
  assert.equal(llm.id, human.id);
  assert.equal(llm.origin, 'human');
  assert.equal(llm.valid_to, null);
  assert.equal(svc.getMemoryItem(human.id).origin, 'human');

  const humanFact = svc.upsertFact({
    scope: 'user',
    factKey: 'human.protected.fact',
    content: 'human fact wins',
    origin: 'human',
  });
  const deterministic = svc.upsertFact({
    scope: 'cross_project',
    factKey: 'human.protected.fact',
    content: 'deterministic fact loses',
    origin: 'deterministic',
    importance: 10,
  });
  assert.equal(deterministic.id, humanFact.id);
  assert.equal(deterministic.origin, 'human');
  assert.equal(deterministic.content, 'human fact wins');
  assert.equal(svc.getMemoryItem(humanFact.id).status, 'active');
});

test('5. revision is SCOPE-keyed: cross_project write does not advance user revision or user injection gate', (t) => {
  // BLOCKER regression kill-test: if revision were owner-keyed, a cross_project write would
  // bump the shared owner revision and re-trigger the user injection gate. scope-keyed means
  // each scope (user / cross_project) has an independent counter.
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);

  const userRev0 = svc.getRevision('user');
  const crossRev0 = svc.getRevision('cross_project');
  assert.equal(userRev0, 0);
  assert.equal(crossRev0, 0);

  // user write bumps user revision only
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'user scope write', origin: 'human' });
  assert.equal(svc.getRevision('user'), 1, 'user write bumps user revision');
  assert.equal(svc.getRevision('cross_project'), 0, 'user write does NOT bump cross_project revision');

  // cross_project write bumps cross_project revision only — must NOT advance user gate
  const runId = 'kill-test-run-blocker';
  const dec = svc.shouldInject(runId, 'user');
  assert.equal(dec.inject, true);
  svc.recordInjection(runId, 'user', dec.revision);
  assert.equal(svc.shouldInject(runId, 'user').inject, false, 'user gate closed after injection');

  svc.createMemoryItem({ scope: 'cross_project', kind: 'pattern', content: 'cross write must not reopen user gate', origin: 'deterministic' });
  assert.equal(svc.getRevision('cross_project'), 1, 'cross_project write bumps cross_project revision');
  assert.equal(svc.getRevision('user'), 1, 'cross_project write does NOT change user revision');
  // BLOCKER: this assertion proves cross_project writes do NOT re-trigger user injection
  assert.equal(svc.shouldInject(runId, 'user').inject, false,
    'BLOCKER: cross_project write must NOT reopen user injection gate');

  // Only a user write re-opens the user gate
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'second user write reopens gate', origin: 'human' });
  assert.equal(svc.getRevision('user'), 2);
  assert.equal(svc.shouldInject(runId, 'user').inject, true, 'user write does reopen user injection gate');
});

test('6. injection ledger is SCOPE-keyed: user and cross_project have independent ledger entries', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'scope injection memory', origin: 'human' });
  svc.createMemoryItem({ scope: 'cross_project', kind: 'pattern', content: 'cross scope injection memory', origin: 'human' });

  const run = 'scope-injection-run';
  const userDec = svc.shouldInject(run, 'user');
  assert.equal(userDec.inject, true);
  svc.recordInjection(run, 'user', userDec.revision);
  assert.equal(svc.shouldInject(run, 'user').inject, false, 'user gate closed after user injection');

  // cross_project gate is INDEPENDENT — recording user injection does NOT close cross_project gate
  const crossDec = svc.shouldInject(run, 'cross_project');
  assert.equal(crossDec.inject, true, 'cross_project gate independent of user ledger entry');
  svc.recordInjection(run, 'cross_project', crossDec.revision);
  assert.equal(svc.shouldInject(run, 'cross_project').inject, false);

  assert.ok(svc.getInjectionRecord(run, 'user'), 'user injection record exists');
  assert.ok(svc.getInjectionRecord(run, 'cross_project'), 'cross_project injection record exists');

  // Only a user write re-opens the user gate (not cross_project writes)
  svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'user write reopens user gate only',
    origin: 'human',
  });
  assert.equal(svc.shouldInject(run, 'user').inject, true, 'user write reopens user gate');
  assert.equal(svc.shouldInject(run, 'cross_project').inject, false, 'user write does NOT reopen cross_project gate');
});

test('7. Top injection behavior keeps user provenance and excludes cross_project rows', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  svc.createMemoryItem({ scope: 'user', kind: 'constraint', content: 'top user provenance only', origin: 'human' });
  svc.createMemoryItem({ scope: 'cross_project', kind: 'pattern', content: 'top cross provenance deferred', origin: 'human' });

  const all = svc.retrieve('user', 'user', {});
  assert.ok(all.some((row) => row.content.includes('top cross provenance deferred')));

  const topRows = svc.retrieve('user', 'user', { provenance: 'user' });
  const block = svc.buildInjectionBlock(topRows);
  assert.match(block, /top user provenance only/);
  assert.doesNotMatch(block, /top cross provenance deferred/);
});

test('8. GET /api/master-memory remains provenance-filtered for user and cross_project scopes', async (t) => {
  const app = await setupApp(t);
  const svc = app.services.masterMemoryService;
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'route user provenance row', origin: 'human' });
  svc.createMemoryItem({ scope: 'cross_project', kind: 'pattern', content: 'route cross provenance row', origin: 'human' });

  const user = await invokeApp(app, { path: '/api/master-memory?scope=user', headers: COOKIE });
  assert.equal(user.status, 200);
  assert.equal(user.body.memory.length, 1);
  assert.match(user.body.memory[0].content, /route user provenance row/);
  assert.equal(user.body.memory[0].scope, 'user');

  const cross = await invokeApp(app, { path: '/api/master-memory?scope=cross_project', headers: COOKIE });
  assert.equal(cross.status, 200);
  assert.equal(cross.body.memory.length, 1);
  assert.match(cross.body.memory[0].content, /route cross provenance row/);
  assert.equal(cross.body.memory[0].scope, 'cross_project');
});

test('9. owner cap is 1000 and eviction never selects human or pinned rows', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  const victim = seedItem(db, {
    id: 'cap-owner-victim',
    scope: 'user',
    content: 'owner cap weakest evictable',
    confidence: 0.1,
    importance: 1,
  });
  const pinned = seedItem(db, {
    id: 'cap-owner-pinned',
    scope: 'cross_project',
    content: 'owner cap pinned protected',
    confidence: 0.01,
    importance: 1,
    pinned: true,
  });
  const human = seedItem(db, {
    id: 'cap-owner-human',
    scope: 'user',
    content: 'owner cap human protected',
    origin: 'human',
    confidence: 0.01,
    importance: 1,
  });
  for (let i = 0; i < 997; i += 1) {
    seedItem(db, {
      id: `cap-owner-filler-${i}`,
      scope: i % 2 === 0 ? 'user' : 'cross_project',
      content: `owner cap filler ${i}`,
      confidence: 0.6,
      importance: 1,
    });
  }
  assert.equal(activeOwnerCount(db), 1000);

  const rejected = svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'owner cap too weak',
    origin: 'deterministic',
    confidence: 0.05,
    importance: 1,
  });
  assert.deepEqual(rejected, { skipped: true, reason: 'cap_rejected', scope: 'user' });
  assert.equal(activeOwnerCount(db), 1000);

  const admitted = svc.createMemoryItem({
    scope: 'cross_project',
    kind: 'pattern',
    content: 'owner cap strong entrant',
    origin: 'deterministic',
    confidence: 1,
    importance: 10,
  });
  assert.equal(admitted.status, 'active');
  assert.equal(activeOwnerCount(db), 1000);
  assert.equal(svc.getMemoryItem(victim.id).status, 'archived');
  assert.equal(svc.getMemoryItem(pinned.id).status, 'active');
  assert.equal(svc.getMemoryItem(human.id).status, 'active');
});

test('10. residual restore, expire, update, and archive paths bump their own scope revision', (t) => {
  // With scope-keyed revision: each write bumps only the scope of the item written.
  // cross_project writes do not touch the user revision counter (and vice versa).
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);

  const userExpired = svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'expired scope user row',
    origin: 'deterministic',
  });
  const crossExpired = svc.createMemoryItem({
    scope: 'cross_project',
    kind: 'pattern',
    content: 'expired scope cross row',
    origin: 'deterministic',
  });
  db.prepare("UPDATE master_memory_items SET valid_to=datetime('now','-1 hour') WHERE id IN (?, ?)").run(userExpired.id, crossExpired.id);
  const userRevBeforeExpire = svc.getRevision('user');
  const crossRevBeforeExpire = svc.getRevision('cross_project');
  assert.equal(svc.expireStaleMemories(), 2);
  assert.equal(svc.getRevision('user'), userRevBeforeExpire + 1, 'user expiry bumps user revision');
  assert.equal(svc.getRevision('cross_project'), crossRevBeforeExpire + 1, 'cross_project expiry bumps cross_project revision');

  const archivedCross = svc.createMemoryItem({
    scope: 'cross_project',
    kind: 'pattern',
    content: 'restore scope duplicate row',
    origin: 'human',
  });
  svc.archiveMemory(archivedCross.id);
  const activeUser = svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'restore scope duplicate row',
    origin: 'deterministic',
  });
  const folded = svc.restoreMemory(archivedCross.id);
  assert.equal(folded.id, activeUser.id);
  assert.equal(folded.origin, 'human');
  assert.equal(svc.getMemoryItem(archivedCross.id).status, 'archived');

  // cross_project update/archive bumps cross_project revision, NOT user revision
  const cross = svc.createMemoryItem({
    scope: 'cross_project',
    kind: 'preference',
    content: 'scope update archive bump row',
    origin: 'human',
  });
  const userRevBeforeUpdate = svc.getRevision('user');
  const crossRevBeforeUpdate = svc.getRevision('cross_project');
  svc.updateMemory(cross.id, { content: 'scope update archive bumped row' });
  assert.equal(svc.getRevision('cross_project'), crossRevBeforeUpdate + 1, 'cross_project update bumps cross_project revision');
  assert.equal(svc.getRevision('user'), userRevBeforeUpdate, 'cross_project update does NOT bump user revision');

  const crossRevBeforeArchive = svc.getRevision('cross_project');
  const userRevBeforeArchive = svc.getRevision('user');
  svc.archiveMemory(cross.id);
  assert.equal(svc.getRevision('cross_project'), crossRevBeforeArchive + 1, 'cross_project archive bumps cross_project revision');
  assert.equal(svc.getRevision('user'), userRevBeforeArchive, 'cross_project archive does NOT bump user revision');
});

test('11. candidate owner-dedup cross-scope collapse is intentional (FIX2)', (t) => {
  // This is INTENTIONAL, not silent: createCandidate uses owner-keyed dedup
  // (slice-2a owner-unique invariant). If a candidate with the same (owner, rule, dedup_key)
  // already exists — even from a different provenance scope — the existing candidate is
  // returned. Content is staged once; the calling actor receives the existing candidate back.
  // This is a fail-safe by design: no content duplication, no constraint violation.
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);

  const original = svc.createCandidate({
    scope: 'user',
    rule: 'R4',
    rawJson: { schema_version: 1, kind: 'preference', content: 'candidate collapse test content' },
    dedupKey: 'collapse-dedup-key',
  });
  assert.ok(original && original.id, 'first candidate created');
  assert.equal(original.scope, 'user', 'first candidate has user scope');

  // Second createCandidate with SAME dedup_key but DIFFERENT scope returns existing candidate
  const collapsed = svc.createCandidate({
    scope: 'cross_project',
    rule: 'R4',
    rawJson: { schema_version: 1, kind: 'preference', content: 'candidate collapse test content' },
    dedupKey: 'collapse-dedup-key',
  });
  assert.ok(collapsed && collapsed.id, 'collapsed candidate returned');
  assert.equal(collapsed.id, original.id, 'intentional collapse: existing candidate returned (same id)');

  // Only one candidate row in DB
  const count = db.prepare(
    "SELECT COUNT(*) AS n FROM master_memory_candidates WHERE rule='R4' AND dedup_key='collapse-dedup-key'"
  ).get();
  assert.equal(count.n, 1, 'owner-dedup collapse: exactly one candidate row stored');
});
