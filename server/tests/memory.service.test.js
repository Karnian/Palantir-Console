const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');

// ML PR1 — unit coverage for memoryService against the real migration 025
// (memory_items + FTS5 + triggers + project_memory_revision +
// pm_memory_injection). setupDb mirrors preset.service.test.js.

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupDb(t) {
  const dbDir = mkTempDir('palantir-mem-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    try { close(); } catch { /* */ }
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  // FK target — project_id REFERENCES projects(id).
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Proj One')").run();
  db.prepare("INSERT INTO projects (id, name) VALUES ('p2', 'Proj Two')").run();
  return db;
}

test('migration 025: memory tables + FTS + triggers + revision + ledger exist', (t) => {
  const db = setupDb(t);
  const names = new Set(
    db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','trigger') AND name LIKE '%memory%'"
    ).all().map((r) => r.name)
  );
  for (const expected of [
    'memory_items',
    'memory_fts',
    'memory_fts_ai',
    'memory_fts_ad',
    'memory_fts_au',
    'project_memory_revision',
    'pm_memory_injection',
  ]) {
    assert.ok(names.has(expected), `expected object ${expected} to exist`);
  }
  // PR2/PR3 tables must NOT exist in PR1.
  const all = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  // memory_candidates now exists (PR2b, migration 026). memory_jobs remains PR3.
  assert.equal(all.has('memory_jobs'), false, 'memory_jobs is PR3 — out of scope');
});

test('createMemoryItem: inserts active row, revision 1 on first change, 2 on second', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);

  assert.equal(svc.getRevision('p1'), 0, 'no row yet -> 0');

  const a = svc.createMemoryItem({
    projectId: 'p1', kind: 'convention', content: 'use tabs', origin: 'human',
  });
  assert.ok(a.id, 'row has id');
  assert.equal(a.status, 'active');
  assert.equal(a.source_count, 1);
  assert.equal(a.importance, 5);
  assert.equal(a.confidence, 0.5);
  assert.equal(svc.getRevision('p1'), 1, 'first active change -> revision 1 (VALUES(?,1))');

  svc.createMemoryItem({
    projectId: 'p1', kind: 'pitfall', content: 'never double runTurn', origin: 'human',
  });
  assert.equal(svc.getRevision('p1'), 2, 'second distinct active insert -> revision 2');

  // Revision is per-project.
  assert.equal(svc.getRevision('p2'), 0);
});

test('content_hash dedup: identical active content MERGES (source_count++ , no new row, revision NOT bumped)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);

  const first = svc.createMemoryItem({
    projectId: 'p1', kind: 'heuristic', content: 'prefer small PRs', origin: 'human',
  });
  assert.equal(svc.getRevision('p1'), 1);
  const revAfterFirst = svc.getRevision('p1');

  const merged = svc.createMemoryItem({
    projectId: 'p1', kind: 'heuristic', content: 'prefer small PRs', origin: 'human',
  });
  // Same row id (merge into existing), source_count incremented.
  assert.equal(merged.id, first.id, 'merge returns the existing row');
  assert.equal(merged.source_count, 2, 'source_count incremented on merge');

  const count = db.prepare("SELECT COUNT(*) c FROM memory_items WHERE project_id='p1'").get().c;
  assert.equal(count, 1, 'no new row created on merge');
  assert.equal(svc.getRevision('p1'), revAfterFirst, 'merge must NOT bump revision');
});

test('fact <=> fact_key enforcement', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);

  // fact without fact_key -> error
  assert.throws(
    () => svc.createMemoryItem({ projectId: 'p1', kind: 'fact', content: 'node 22', origin: 'human' }),
    /factKey/i
  );
  // non-fact WITH fact_key -> error
  assert.throws(
    () => svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'x', factKey: 'k', origin: 'human' }),
    /factKey/i
  );
  // fact WITH fact_key -> ok
  const ok = svc.createMemoryItem({
    projectId: 'p1', kind: 'fact', fact_key: undefined, factKey: 'node_major', content: 'node 22', origin: 'human',
  });
  assert.equal(ok.kind, 'fact');
  assert.equal(ok.fact_key, 'node_major');
});

test('retrieveForProject: empty/blank taskContext -> fallback, no throw, active rows by importance', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);

  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'low', origin: 'human', importance: 2 });
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'high', origin: 'human', importance: 9 });
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'mid', origin: 'human', importance: 5 });

  for (const ctx of [undefined, '', '   ', '\n\t ']) {
    const rows = svc.retrieveForProject('p1', { taskContext: ctx });
    assert.ok(Array.isArray(rows));
    assert.equal(rows[0].content, 'high', `importance DESC ordering for ctx=${JSON.stringify(ctx)}`);
  }
});

test('retrieveForProject: FTS5 special chars do NOT throw and return sensibly', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);

  svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'foo bar baz boom', origin: 'human' });
  svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'unrelated content here', origin: 'human' });

  const nasty = [
    '"foo* OR bar" AND (baz)',
    '"',
    'NEAR',
    'foo OR (bar',
    '^*:-"',           // all special -> escapes to empty -> fallback
    'foo NEAR/2 bar',
  ];
  for (const q of nasty) {
    assert.doesNotThrow(() => {
      const rows = svc.retrieveForProject('p1', { taskContext: q });
      assert.ok(Array.isArray(rows), `array for ${JSON.stringify(q)}`);
    }, `must not throw for ${JSON.stringify(q)}`);
  }

  // A query with real tokens should surface the matching row.
  const rows = svc.retrieveForProject('p1', { taskContext: 'foo baz' });
  assert.ok(rows.some((r) => r.content === 'foo bar baz boom'), 'matching row retrieved');
});

test('retrieveForProject: respects TOP_K (<=12)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  for (let i = 0; i < 20; i++) {
    svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: `rule number ${i}`, origin: 'human', importance: 5 });
  }
  const fallback = svc.retrieveForProject('p1', { taskContext: '' });
  assert.ok(fallback.length <= 12, `fallback returned ${fallback.length} (<=12)`);
  const fts = svc.retrieveForProject('p1', { taskContext: 'rule number' });
  assert.ok(fts.length <= 12, `fts returned ${fts.length} (<=12)`);
});

test('retrieveForProject: respects CHAR_CAP (~2000, stops accumulating)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  // Each item ~500 chars; 12 of them would be ~6000 — cap must stop early.
  const big = 'x'.repeat(500);
  for (let i = 0; i < 12; i++) {
    svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: `${big}${i}`, origin: 'human', importance: 5 });
  }
  const rows = svc.retrieveForProject('p1', { taskContext: '' });
  const total = rows.reduce((acc, r) => acc + r.content.length, 0);
  // After the first row, no row is added once total would exceed 2000.
  // So total <= 2000 + (length of one boundary row) is the loose bound; the
  // tight bound the impl guarantees: every added row (after the first) kept
  // total <= 2000. With ~501-char rows that means at most ~4 rows.
  assert.ok(rows.length < 12, `cap stopped before all 12 (got ${rows.length})`);
  assert.ok(total <= 2000 + 501, `total chars bounded (${total})`);
  // Stronger: dropping the last row keeps us within cap.
  const withoutLast = rows.slice(0, -1).reduce((acc, r) => acc + r.content.length, 0);
  assert.ok(withoutLast <= 2000, `prefix within cap (${withoutLast})`);
});

test('retrieveForProject: bm25 ordering — strong match ranks first', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  // Strong match: contains the query terms densely.
  svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'codex codex resume thread race condition', origin: 'human', importance: 5 });
  // Weak/no match.
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'completely different subject about colors', origin: 'human', importance: 10 });
  const rows = svc.retrieveForProject('p1', { taskContext: 'codex resume thread' });
  assert.ok(rows.length >= 1);
  assert.match(rows[0].content, /codex codex resume thread/, 'strong bm25 match ranks first despite lower importance');
});

test('retrieveForProject: respects project scoping + valid_to TTL', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'p1 secret', origin: 'human' });
  svc.createMemoryItem({ projectId: 'p2', kind: 'convention', content: 'p2 secret', origin: 'human' });
  const p1rows = svc.retrieveForProject('p1', { taskContext: '' });
  assert.ok(p1rows.every((r) => r.project_id === 'p1'), 'no cross-project leak');

  // Expire a row via valid_to in the past — must be filtered out.
  const expired = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'stale fact', origin: 'human' });
  db.prepare("UPDATE memory_items SET valid_to = datetime('now','-1 day') WHERE id = ?").run(expired.id);
  const after = svc.retrieveForProject('p1', { taskContext: '' });
  assert.ok(!after.some((r) => r.id === expired.id), 'expired row excluded by valid_to');
});

test('buildInjectionBlock: null for empty, markdown block otherwise', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  assert.equal(svc.buildInjectionBlock([]), null);
  assert.equal(svc.buildInjectionBlock(null), null);
  const block = svc.buildInjectionBlock([
    { kind: 'convention', content: 'use tabs' },
    { kind: 'pitfall', content: 'never double runTurn' },
  ]);
  assert.match(block, /^## Learned Memory/);
  assert.match(block, /use tabs/);
  assert.match(block, /never double runTurn/);
});

test('listForProject: active rows by importance DESC', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'a', origin: 'human', importance: 3 });
  const b = svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'b', origin: 'human', importance: 8 });
  // archive one — should be excluded from listForProject.
  const c = svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'c', origin: 'human', importance: 9 });
  db.prepare("UPDATE memory_items SET status='archived' WHERE id=?").run(c.id);

  const rows = svc.listForProject('p1');
  assert.equal(rows.length, 2, 'archived excluded');
  assert.equal(rows[0].id, b.id, 'importance DESC');
});

test('injection ledger: shouldInject gates per-session and per-revision', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const pmRunId = 'run_pm_1';

  // No memory yet, no ledger -> revision 0, inject true (decision is
  // independent of whether there's content — composition layer checks block).
  let d = svc.shouldInject(pmRunId, 'p1');
  assert.equal(d.inject, true, 'first call (no ledger) -> inject true');
  assert.equal(d.revision, 0);
  assert.equal(d.block, null, 'shouldInject does not retrieve/build');

  // Seed memory -> revision becomes 1.
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'seed', origin: 'human' });
  d = svc.shouldInject(pmRunId, 'p1');
  assert.equal(d.revision, 1);
  assert.equal(d.inject, true, 'still inject (ledger says revision 0 < 1, or no ledger)');

  // Record injection at revision 1.
  svc.recordInjection(pmRunId, 'p1', d.revision);
  const rec = svc.getInjectionRecord(pmRunId);
  assert.equal(rec.injected_revision, 1);
  assert.ok(rec.injected_at, 'injected_at written');

  // Now injected_revision == current revision -> no re-inject (per-session gate).
  d = svc.shouldInject(pmRunId, 'p1');
  assert.equal(d.inject, false, 'same revision -> no re-inject');

  // A new active insert bumps revision -> inject true again (revision change gate).
  svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'new learning', origin: 'human' });
  d = svc.shouldInject(pmRunId, 'p1');
  assert.equal(d.revision, 2);
  assert.equal(d.inject, true, 'revision bumped -> inject again');

  // A different pm_run_id (fresh session) always injects until it records.
  const d2 = svc.shouldInject('run_pm_2', 'p1');
  assert.equal(d2.inject, true, 'new session injects');
});

test('recordInjection: upsert is idempotent on pm_run_id', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  svc.recordInjection('run_x', 'p1', 1);
  svc.recordInjection('run_x', 'p1', 3);
  const rec = svc.getInjectionRecord('run_x');
  assert.equal(rec.injected_revision, 3, 'upsert updates injected_revision');
  const count = db.prepare("SELECT COUNT(*) c FROM pm_memory_injection WHERE pm_run_id='run_x'").get().c;
  assert.equal(count, 1, 'single ledger row per pm_run_id');
});
