// L2 Master Memory P1a — governed top-K retrieval (migration 030 + masterMemoryService).
// Mirrors the L1 memory test harness. Scope is user/cross_project (no projects FK).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMasterMemoryService } = require('../services/masterMemoryService');

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-mm-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => { try { close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

test('migration 030: master_memory_items + fts + revision/injection tables exist', (t) => {
  const db = setupDb(t);
  const cols = db.prepare('PRAGMA table_info(master_memory_items)').all().map((c) => c.name);
  for (const c of ['scope', 'kind', 'fact_key', 'content_hash', 'origin', 'pinned', 'valid_to', 'archived_at']) {
    assert.ok(cols.includes(c), `column ${c}`);
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name);
  for (const tbl of ['master_memory_items', 'master_memory_fts', 'master_memory_revision', 'master_memory_injection']) {
    assert.ok(tables.includes(tbl), `table ${tbl}`);
  }
});

test('createMemoryItem + retrieve via FTS (top-K)', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  svc.createMemoryItem({ scope: 'user', kind: 'constraint', content: 'always run tests with node --test runner', origin: 'human' });
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'prefer raw SQL over an ORM for queries', origin: 'human' });
  const rows = svc.retrieve('user', { taskContext: 'how do I run the test suite' });
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r) => /node --test/.test(r.content)), 'FTS surfaces the relevant item');
});

test('remember: human origin → active', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  const item = svc.remember({ scope: 'user', content: 'respond to me in Korean', kind: 'constraint' });
  assert.equal(item.origin, 'human');
  assert.equal(item.status, 'active');
  assert.equal(svc.listForScope('user').length, 1);
});

test('dedup: identical active content merges (source_count++), no double revision bump', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  const a = svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'same content x', origin: 'human' });
  const rev1 = svc.getRevision('user');
  const b = svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'same content x', origin: 'human' });
  assert.equal(a.id, b.id, 'merge returns the existing row');
  assert.equal(b.source_count, 2);
  assert.equal(svc.getRevision('user'), rev1, 'merge does not bump revision (content unchanged)');
  assert.equal(svc.listForScope('user').length, 1);
});

test('retrieve: capped to TOP_K (12), escape-safe query does not throw', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  for (let i = 0; i < 15; i++) {
    svc.createMemoryItem({ scope: 'user', kind: 'preference', content: `widget rule number ${i} about deploys`, origin: 'human' });
  }
  const rows = svc.retrieve('user', { taskContext: 'widget deploys rule', limit: 100 });
  assert.ok(rows.length <= 12, `top-K cap (got ${rows.length})`);
  // escape-safety: punctuation / FTS operators must not throw
  const safe = svc.retrieve('user', { taskContext: 'foo"bar; OR (deploys) AND *' });
  assert.ok(Array.isArray(safe));
});

test('retrieve fallback (no taskContext) → importance-ordered active', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'low importance note', origin: 'human', importance: 2 });
  svc.createMemoryItem({ scope: 'user', kind: 'constraint', content: 'high importance rule', origin: 'human', importance: 9 });
  const rows = svc.retrieve('user', {});
  assert.equal(rows[0].importance, 9, 'fallback orders by importance DESC');
});

test('buildInjectionBlock: ## User Memory header + bullets; null on empty', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  assert.equal(svc.buildInjectionBlock([]), null);
  const block = svc.buildInjectionBlock([{ kind: 'constraint', content: 'use node --test' }]);
  assert.ok(block.startsWith('## User Memory'));
  assert.ok(block.includes('- [constraint] use node --test'));
});

test('revision + injection ledger: once-per-run, re-inject on revision bump', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'first memory', origin: 'human' });
  const run = 'master-run-1';
  let g = svc.shouldInject(run, 'user');
  assert.equal(g.inject, true, 'fresh run injects');
  svc.recordInjection(run, 'user', g.revision);
  assert.equal(svc.shouldInject(run, 'user').inject, false, 'already injected at this revision');
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'second memory', origin: 'human' });
  assert.equal(svc.shouldInject(run, 'user').inject, true, 're-injects after revision bump');
});

test('upsertFact: supersede on change, no-op (no bump) on unchanged', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  const v1 = svc.upsertFact({ scope: 'user', factKey: 'env.node', content: 'node 22' });
  const r1 = svc.getRevision('user');
  const v2 = svc.upsertFact({ scope: 'user', factKey: 'env.node', content: 'node 24' });
  assert.notEqual(v1.id, v2.id);
  assert.equal(svc.getMemoryItem(v1.id).status, 'superseded');
  assert.ok(svc.getRevision('user') > r1, 'change bumps revision');
  const r2 = svc.getRevision('user');
  svc.upsertFact({ scope: 'user', factKey: 'env.node', content: 'node 24' });
  assert.equal(svc.getRevision('user'), r2, 'unchanged content is a no-op');
  assert.equal(svc.listForScope('user').length, 1, 'only the current fact is active');
});

test('archiveMemory: status archived, bumps revision, excluded from active', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  const item = svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'archive me', origin: 'human' });
  const r1 = svc.getRevision('user');
  const arch = svc.archiveMemory(item.id);
  assert.equal(arch.status, 'archived');
  assert.ok(arch.archived_at);
  assert.ok(svc.getRevision('user') > r1);
  assert.equal(svc.listForScope('user').length, 0);
  assert.equal(svc.listForScope('user', 'archived').length, 1);
});

test('scope isolation + cross_project dedup (NOT NULL scope avoids NULL-distinct hole)', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'shared text', origin: 'human' });
  svc.createMemoryItem({ scope: 'cross_project', kind: 'preference', content: 'shared text', origin: 'human' });
  // different scope = different dedup partition → both active
  assert.equal(svc.listForScope('user').length, 1);
  assert.equal(svc.listForScope('cross_project').length, 1);
  // retrieve does not cross scopes
  const u = svc.retrieve('user', { taskContext: 'shared text' });
  assert.ok(u.every((r) => r.scope === 'user'));
  // two cross_project identical → dedup merges (scope NOT NULL → unique index fires)
  const c2 = svc.createMemoryItem({ scope: 'cross_project', kind: 'preference', content: 'shared text', origin: 'human' });
  assert.equal(c2.source_count, 2, 'cross_project dedup works (no NULL-distinct hole)');
});
