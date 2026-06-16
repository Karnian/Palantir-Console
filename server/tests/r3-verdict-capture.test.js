// ML PR2c (R3) — PM verdict capture. A COHERENT task_complete claim (the PM's
// claim matched DB truth, task is 'done') is a trustworthy "how this kind of
// task gets done here" signal -> candidate. A hallucinated (incoherent) claim
// is never captured. Deterministic, LLM-free.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');
const { createR3Capture } = require('../app');

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-r3-'));
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

function wireR3(svc) {
  const subs = [];
  const eventBus = { subscribe: (cb) => subs.push(cb) };
  createR3Capture({ eventBus, memoryService: svc });
  return (audit) => subs[0]({ channel: 'dispatch_audit:recorded', data: { audit } });
}

function audit(over = {}) {
  return {
    id: 'a1', project_id: 'p1', task_id: 't1', pm_run_id: 'pm1',
    incoherence_flag: 0,
    pm_claim: JSON.stringify({ kind: 'task_complete', task_id: 't1' }),
    db_truth: JSON.stringify({ task_id: 't1', status: 'done' }),
    rationale: 'finished the feature and tests pass',
    ...over,
  };
}

test('R3: coherent task_complete + done -> candidate with rationale', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  wireR3(svc)(audit());
  const cands = svc.listCandidates('p1');
  assert.equal(cands.length, 1);
  const raw = JSON.parse(cands[0].raw_json);
  assert.equal(raw.rule, 'R3');
  assert.equal(raw.task_id, 't1');
  assert.equal(raw.pm_run_id, 'pm1');
  assert.equal(raw.verdict, 'task_complete');
  assert.match(raw.rationale, /finished/);
  assert.equal(cands[0].dedup_key, 'r3:task_complete:t1:pm1');
});

test('R3: incoherent (hallucinated) verdict -> NO candidate', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  wireR3(svc)(audit({ incoherence_flag: 1, incoherence_kind: 'pm_hallucination' }));
  assert.equal(svc.listCandidates('p1').length, 0, 'a hallucinated claim must never become memory');
});

test('R3: non-task_complete claim -> no candidate', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  wireR3(svc)(audit({ pm_claim: JSON.stringify({ kind: 'worker_spawned', run_id: 'r1' }) }));
  assert.equal(svc.listCandidates('p1').length, 0);
});

test('R3: truth status not done -> no candidate', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  wireR3(svc)(audit({ db_truth: JSON.stringify({ task_id: 't1', status: 'in_progress' }) }));
  assert.equal(svc.listCandidates('p1').length, 0);
});

test('R3: missing fields / malformed JSON -> no candidate, never throws', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR3(svc);
  assert.doesNotThrow(() => {
    emit(audit({ pm_run_id: null }));
    emit(audit({ project_id: null }));
    // task_id absent from envelope AND claim AND truth -> cannot derive -> skip.
    emit(audit({ task_id: null, pm_claim: JSON.stringify({ kind: 'task_complete' }), db_truth: JSON.stringify({ status: 'done' }) }));
    emit(audit({ pm_claim: 'not json{' }));
    emit(audit({ db_truth: '{{' }));
    emit(undefined);
  });
  assert.equal(svc.listCandidates('p1').length, 0);
});

test('R3: repeated task_complete from same PM session -> deduped', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR3(svc);
  emit(audit({ id: 'a1' }));
  emit(audit({ id: 'a2' })); // same task+pm_run, different audit id
  assert.equal(svc.listCandidates('p1').length, 1, 'same task+pm_run collapses to one');
});

test('R3: different task or pm_run -> separate candidates', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR3(svc);
  emit(audit({ task_id: 't1', pm_run_id: 'pm1' }));
  emit(audit({ task_id: 't2', pm_run_id: 'pm1' }));
  emit(audit({ task_id: 't1', pm_run_id: 'pm2' }));
  assert.equal(svc.listCandidates('p1').length, 3);
});

test('R3: envelope task_id NULL but pm_claim carries it -> candidate (derive id)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  // dispatch_audit_log.task_id is nullable; the coherent claim still has t1.
  wireR3(svc)(audit({ task_id: null }));
  const cands = svc.listCandidates('p1');
  assert.equal(cands.length, 1, 'a coherent task_complete with null envelope task_id must still capture');
  assert.equal(JSON.parse(cands[0].raw_json).task_id, 't1');
  assert.equal(cands[0].dedup_key, 'r3:task_complete:t1:pm1');
});

test('R3: pm_claim / db_truth = "null" (parses to null) -> no candidate, no throw', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR3(svc);
  assert.doesNotThrow(() => {
    emit(audit({ pm_claim: 'null' }));
    emit(audit({ db_truth: 'null' }));
  });
  assert.equal(svc.listCandidates('p1').length, 0);
});
