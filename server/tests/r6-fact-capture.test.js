// ML PR2a (R6) — environment-fact capture + memoryService.upsertFact +
// GET evidence whitelist. Deterministic facts (test_command / node resolution)
// flow from harvest:test into project memory, superseding prior values, while
// run-specific noise (output_tail/pass/diff) is excluded and never leaks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');
const { createR6FactCapture, isStableEnvFact } = require('../app');
const { toPublicMemory } = require('../routes/memory');

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-r6-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    try { close(); } catch { /* */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Proj One')").run();
  return db;
}

function fakeRun(over = {}) {
  return { id: 'run1', is_manager: 0, project_id: 'p1', task_id: 't1', ...over };
}

function wireCapture(svc, runEvents, logger) {
  const subs = [];
  const eventBus = { subscribe: (cb) => subs.push(cb) };
  const runService = { getRunEvents: () => runEvents };
  createR6FactCapture({ eventBus, runService, memoryService: svc, logger });
  return (run) => subs[0]({ channel: 'run:harvested', data: { run } });
}

// --------------------------------------------------------------------------
// memoryService.upsertFact unit
// --------------------------------------------------------------------------

test('upsertFact: first fact is active rule:R6, revision 1', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const f = svc.upsertFact({ projectId: 'p1', factKey: 'env.test_command', content: 'Project test command: npm test' });
  assert.equal(f.kind, 'fact');
  assert.equal(f.fact_key, 'env.test_command');
  assert.equal(f.origin, 'rule:R6');
  assert.equal(f.status, 'active');
  assert.equal(svc.getRevision('p1'), 1);
});

test('upsertFact: unchanged content -> no-op, no revision bump, single row', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const a = svc.upsertFact({ projectId: 'p1', factKey: 'env.test_command', content: 'npm test' });
  assert.equal(svc.getRevision('p1'), 1);
  const b = svc.upsertFact({ projectId: 'p1', factKey: 'env.test_command', content: 'npm test' });
  assert.equal(b.id, a.id, 'same row returned on no-op');
  assert.equal(svc.getRevision('p1'), 1, 'no revision bump on no-op');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memory_items WHERE project_id='p1'").get().c, 1);
});

test('upsertFact: changed content -> supersede old + new active + revision bump', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const a = svc.upsertFact({ projectId: 'p1', factKey: 'env.node_resolution', content: 'Project Node major: 20' });
  const b = svc.upsertFact({ projectId: 'p1', factKey: 'env.node_resolution', content: 'Project Node major: 22' });
  assert.notEqual(b.id, a.id, 'new row created');
  assert.equal(b.status, 'active');
  const old = db.prepare('SELECT * FROM memory_items WHERE id=?').get(a.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.superseded_by, b.id);
  assert.ok(old.valid_to, 'valid_to stamped on superseded row');
  assert.equal(svc.getRevision('p1'), 2);
  const active = svc.listForProject('p1').filter((r) => r.fact_key === 'env.node_resolution');
  assert.equal(active.length, 1, 'exactly one active fact per key');
  assert.equal(active[0].content, 'Project Node major: 22');
});

test('upsertFact: requires projectId/factKey/content', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  assert.throws(() => svc.upsertFact({ factKey: 'k', content: 'c' }), /projectId/);
  assert.throws(() => svc.upsertFact({ projectId: 'p1', content: 'c' }), /factKey/);
  assert.throws(() => svc.upsertFact({ projectId: 'p1', factKey: 'k' }), /content/);
});

// --------------------------------------------------------------------------
// createR6FactCapture (run:harvested subscriber)
// --------------------------------------------------------------------------

test('isStableEnvFact: admits only stable R6 environment facts', () => {
  assert.equal(isStableEnvFact('env.test_command'), true);
  assert.equal(isStableEnvFact('env.node_resolution', { node_source: 'project' }), true);
  for (const node_source of ['fallback', 'server', 'executor', undefined]) {
    assert.equal(isStableEnvFact('env.node_resolution', { node_source }), false);
  }
  assert.equal(isStableEnvFact('env.node_resolution', null), false);
  assert.equal(isStableEnvFact('env.unknown', { node_source: 'project' }), false);
});

test('R6 capture: harvest:test -> env.test_command + env.node_resolution, no output leak', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireCapture(svc, [
    { id: 10, event_type: 'harvest:diff', payload_json: '{}' },
    { id: 11, event_type: 'harvest:test', payload_json: JSON.stringify({
      command: 'npm test', passed: true, exit_code: 0, duration_ms: 100,
      output_tail: 'SECRET token=abc123', node_major: 22, node_source: 'project',
    }) },
  ]);
  emit(fakeRun());

  const rows = svc.listForProject('p1');
  const cmd = rows.find((r) => r.fact_key === 'env.test_command');
  const node = rows.find((r) => r.fact_key === 'env.node_resolution');
  assert.ok(cmd, 'test_command fact created');
  assert.match(cmd.content, /npm test/);
  assert.doesNotMatch(cmd.content, /SECRET/, 'output_tail must NOT leak into fact content');
  assert.ok(node, 'node_resolution fact created');
  assert.equal(node.content, 'Project requires Node major 22');
  assert.match(node.content, /requires Node major 22/);
  assert.doesNotMatch(node.content, /\(resolved\)/);
  // evidence carries run provenance only — never output_tail/secret.
  const ev = JSON.parse(cmd.evidence_json);
  assert.equal(ev.run_id, 'run1');
  assert.equal(ev.event_id, 11);
  assert.equal(ev.task_id, 't1');
  assert.doesNotMatch(cmd.evidence_json, /SECRET/);
});

test('R6 capture: node_source=fallback -> node fact rejected, test command retained', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const warnings = [];
  const emit = wireCapture(svc, [
    { id: 5, event_type: 'harvest:test', payload_json: JSON.stringify({ command: 'x', node_major: 18, node_source: 'fallback' }) },
  ], { warn: (message) => warnings.push(message) });
  emit(fakeRun());
  const rows = svc.listForProject('p1');
  assert.ok(rows.find((r) => r.fact_key === 'env.test_command'));
  assert.equal(rows.find((r) => r.fact_key === 'env.node_resolution'), undefined);
  assert.ok(warnings.some((message) => /admission rejected \(episodic\).*node_source=fallback.*run=run1/.test(message)));
});

test('R6 capture: manager / no project / no harvest:test -> no fact, never throws', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireCapture(svc, []); // no events
  assert.doesNotThrow(() => {
    emit(fakeRun({ is_manager: 1 }));
    emit(fakeRun({ project_id: null }));
    emit(fakeRun()); // no harvest:test in events
    emit(undefined);
  });
  assert.equal(svc.listForProject('p1').length, 0);
});

test('R6 capture: re-harvest identical env -> idempotent (no revision churn)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireCapture(svc, [
    { id: 7, event_type: 'harvest:test', payload_json: JSON.stringify({ command: 'npm test', node_major: 22, node_source: 'project' }) },
  ]);
  emit(fakeRun());
  const rev1 = svc.getRevision('p1');
  assert.ok(rev1 >= 1);
  emit(fakeRun({ id: 'run2' }));
  assert.equal(svc.getRevision('p1'), rev1, 'unchanged env facts do not bump revision again');
});

test('R6 capture: node_source=server -> node fact rejected, test command retained', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireCapture(svc, [
    { id: 9, event_type: 'harvest:test', payload_json: JSON.stringify({ command: 'x', node_major: 22, node_source: 'server' }) },
  ]);
  emit(fakeRun());
  const rows = svc.listForProject('p1');
  assert.ok(rows.find((r) => r.fact_key === 'env.test_command'));
  assert.equal(rows.find((r) => r.fact_key === 'env.node_resolution'), undefined);
});

test('R6 capture: node_source=executor -> node fact rejected as episodic', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireCapture(svc, [
    { id: 12, event_type: 'harvest:test', payload_json: JSON.stringify({ command: 'x', node_major: 22, node_source: 'executor' }) },
  ]);
  emit(fakeRun());
  const rows = svc.listForProject('p1');
  assert.ok(rows.find((r) => r.fact_key === 'env.test_command'));
  assert.equal(rows.find((r) => r.fact_key === 'env.node_resolution'), undefined);
});

test('R6 capture: declared_node_major promotes even when runtime source is server', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireCapture(svc, [
    { id: 13, event_type: 'harvest:test', payload_json: JSON.stringify({
      node_major: 22,
      node_source: 'server',
      declared_node_major: 22,
    }) },
  ]);

  emit(fakeRun());

  const node = svc.listForProject('p1').find((r) => r.fact_key === 'env.node_resolution');
  assert.ok(node);
  assert.equal(node.content, 'Project requires Node major 22');
  assert.equal(node.status, 'active');
});

test('R6 capture: declared_node_major=null retracts an existing R6 fact', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const fact = svc.upsertFact({
    projectId: 'p1',
    factKey: 'env.node_resolution',
    content: 'Project requires Node major 22',
  });
  const beforeRevision = svc.getRevision('p1');
  const emit = wireCapture(svc, [
    { id: 14, event_type: 'harvest:test', payload_json: JSON.stringify({
      node_major: 22,
      node_source: 'server',
      declared_node_major: null,
    }) },
  ]);

  emit(fakeRun());

  const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(fact.id);
  assert.equal(row.status, 'archived');
  assert.equal(row.archive_reason, 'b_adm_declaration_removed');
  assert.equal(svc.getRevision('p1'), beforeRevision + 1);
});

test('R6 capture transition: exact declaration promotes, then confirmed removal retracts', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const events = [
    { id: 15, event_type: 'harvest:test', payload_json: JSON.stringify({
      node_major: 22,
      node_source: 'server',
      declared_node_major: 22,
    }) },
  ];
  const emit = wireCapture(svc, events);

  emit(fakeRun());
  const promoted = svc.listForProject('p1').find((r) => r.fact_key === 'env.node_resolution');
  assert.ok(promoted);
  assert.equal(promoted.content, 'Project requires Node major 22');
  const promotedRevision = svc.getRevision('p1');

  events[0] = { id: 16, event_type: 'harvest:test', payload_json: JSON.stringify({
    node_major: 22,
    node_source: 'server',
    declared_node_major: null,
  }) };
  emit(fakeRun({ id: 'run2' }));

  const retracted = db.prepare('SELECT * FROM memory_items WHERE id=?').get(promoted.id);
  assert.equal(retracted.status, 'archived');
  assert.equal(retracted.archive_reason, 'b_adm_declaration_removed');
  assert.equal(svc.getRevision('p1'), promotedRevision + 1);
});

test('upsertFact: content already active under a different key -> no-op, no throw', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  // A human memory already holds the exact content R6 would write.
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'Project test command: npm test', origin: 'human' });
  const rev = svc.getRevision('p1');
  assert.doesNotThrow(() => {
    svc.upsertFact({ projectId: 'p1', factKey: 'env.test_command', content: 'Project test command: npm test' });
  });
  assert.equal(svc.getRevision('p1'), rev, 'no revision bump when the content is already active elsewhere');
});

// --------------------------------------------------------------------------
// GET evidence whitelist (toPublicMemory)
// --------------------------------------------------------------------------

test('toPublicMemory: excludes evidence_json / content_hash / superseded_by / rowid_pk', (t) => {
  const pub = toPublicMemory({
    rowid_pk: 3, id: 'x', project_id: 'p1', kind: 'fact', content: 'c', fact_key: 'k',
    content_hash: 'deadbeef', evidence_json: '{"secret":"leak"}', origin: 'rule:R6',
    importance: 5, source_count: 1, status: 'active', superseded_by: null,
    valid_to: null, created_at: 't', updated_at: 't', confidence: 0.9,
  });
  assert.equal(pub.evidence_json, undefined, 'evidence_json must not be exposed');
  assert.equal(pub.content_hash, undefined);
  assert.equal(pub.superseded_by, undefined);
  assert.equal(pub.rowid_pk, undefined);
  // PR4: confidence + origin are now exposed for the correction UI (both are
  // non-sensitive — a 0..1 score and an origin enum). evidence_json stays out.
  assert.equal(pub.confidence, 0.9);
  assert.equal(pub.origin, 'rule:R6');
  // whitelisted fields survive.
  assert.equal(pub.id, 'x');
  assert.equal(pub.content, 'c');
  assert.equal(pub.fact_key, 'k');
  assert.equal(pub.kind, 'fact');
  assert.equal(pub.importance, 5);
});
