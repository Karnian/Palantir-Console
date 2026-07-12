// ML PR2b (R1b) — failure->fix pair capture + memory_candidates CRUD.
// A worker run that finishes PASS while the immediately-preceding same-task
// test run FAILed is the highest-signal learning event; R1b stages it as a
// candidate (PR3 distills it). Deterministic, no output_tail leak.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');
const { createR1bCapture } = require('../app');

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-r1b-'));
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

function hTest(passed, id) {
  return { id, event_type: 'harvest:test', payload_json: JSON.stringify({ passed, output_tail: 'SECRET token=xyz', command: 'npm test' }) };
}
function hDiff(stat, id) {
  return { id, event_type: 'harvest:diff', payload_json: JSON.stringify({ stat }) };
}

function wireR1b(svc, runs, eventsByRun) {
  const subs = [];
  const eventBus = { subscribe: (cb) => subs.push(cb) };
  const runService = {
    listRuns: ({ task_id }) => runs.filter((r) => r.task_id === task_id),
    getRunEvents: (runId) => eventsByRun[runId] || [],
  };
  createR1bCapture({ eventBus, runService, memoryService: svc });
  return (run) => subs[0]({ channel: 'run:harvested', data: { run } });
}

// --------------------------------------------------------------------------
// memory_candidates CRUD
// --------------------------------------------------------------------------

test('createCandidate: insert pending + idempotent on dedup_key (INSERT OR IGNORE)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const c = svc.createCandidate({ projectId: 'p1', rule: 'R1b', rawJson: { a: 1 }, dedupKey: 'k1' });
  assert.equal(c.rule, 'R1b');
  assert.equal(c.status, 'pending');
  const c2 = svc.createCandidate({ projectId: 'p1', rule: 'R1b', rawJson: { a: 2 }, dedupKey: 'k1' });
  assert.equal(c2.id, c.id, 'same dedup_key -> same row');
  assert.equal(JSON.parse(c2.raw_json).a, 1, 'original raw_json kept (ignore on conflict)');
  assert.equal(svc.listCandidates('p1').length, 1);
});

test('createCandidate: requires projectId/rule/rawJson/dedupKey', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  assert.throws(() => svc.createCandidate({ rule: 'R1b', rawJson: {}, dedupKey: 'k' }), /projectId/);
  assert.throws(() => svc.createCandidate({ projectId: 'p1', rawJson: {}, dedupKey: 'k' }), /rule/);
  assert.throws(() => svc.createCandidate({ projectId: 'p1', rule: 'R1b', dedupKey: 'k' }), /rawJson/);
  assert.throws(() => svc.createCandidate({ projectId: 'p1', rule: 'R1b', rawJson: {} }), /dedupKey/);
});

// --------------------------------------------------------------------------
// R1b capture
// --------------------------------------------------------------------------

const TWO_RUNS = [
  { id: 'x', task_id: 't1', created_at: '2026-01-01 00:00:00' },
  { id: 'y', task_id: 't1', created_at: '2026-01-01 01:00:00' },
];

test('R1b: FAIL run -> PASS run = fix-pair candidate (diff_stat kept, output_tail NOT leaked)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, TWO_RUNS, {
    x: [hTest(false, 10)],
    y: [hDiff('1 file changed, 3 insertions', 20), hTest(true, 21)],
  });
  emit({ id: 'y', is_manager: 0, project_id: 'p1', task_id: 't1' });

  const cands = svc.listCandidates('p1');
  assert.equal(cands.length, 1);
  const raw = JSON.parse(cands[0].raw_json);
  assert.equal(raw.rule, 'R1b');
  assert.equal(raw.fail_run.id, 'x');
  assert.equal(raw.fix_run.id, 'y');
  assert.match(raw.fix_run.diff_stat, /1 file changed/);
  assert.doesNotMatch(cands[0].raw_json, /SECRET/, 'output_tail must NOT leak into candidate');
  assert.equal(cands[0].dedup_key, 'r1b:t1:x:y');
});

test('R1b: first test run on task (no prior) -> no candidate', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, [{ id: 'y', task_id: 't1', created_at: 't' }], { y: [hTest(true, 1)] });
  emit({ id: 'y', is_manager: 0, project_id: 'p1', task_id: 't1' });
  assert.equal(svc.listCandidates('p1').length, 0);
});

test('R1b: immediately-preceding run already PASSed -> no candidate (not a fix)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, TWO_RUNS, { x: [hTest(true, 1)], y: [hTest(true, 2)] });
  emit({ id: 'y', is_manager: 0, project_id: 'p1', task_id: 't1' });
  assert.equal(svc.listCandidates('p1').length, 0);
});

test('R1b: fix run itself is FAIL -> no candidate', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, TWO_RUNS, { x: [hTest(false, 1)], y: [hTest(false, 2)] });
  emit({ id: 'y', is_manager: 0, project_id: 'p1', task_id: 't1' });
  assert.equal(svc.listCandidates('p1').length, 0);
});

test('R1b: manager / no project / no task -> no candidate, never throws', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, [], {});
  assert.doesNotThrow(() => {
    emit({ id: 'y', is_manager: 1, project_id: 'p1', task_id: 't1' });
    emit({ id: 'y', is_manager: 0, project_id: null, task_id: 't1' });
    emit({ id: 'y', is_manager: 0, project_id: 'p1', task_id: null });
    emit(undefined);
  });
  assert.equal(svc.listCandidates('p1').length, 0);
});

test('R1b: re-harvest the same fix pair -> idempotent (one candidate)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, TWO_RUNS, { x: [hTest(false, 10)], y: [hTest(true, 21)] });
  emit({ id: 'y', is_manager: 0, project_id: 'p1', task_id: 't1' });
  emit({ id: 'y', is_manager: 0, project_id: 'p1', task_id: 't1' });
  assert.equal(svc.listCandidates('p1').length, 1, 'same fail->fix pair deduped');
});

test('R1b: intervening run WITHOUT harvest:test breaks the pair (no candidate)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  // X(FAIL) -> Z(no test) -> Y(PASS): Y's immediate previous RUN is Z, not X.
  const runs = [
    { id: 'x', task_id: 't1', created_at: '2026-01-01 00:00:00' },
    { id: 'z', task_id: 't1', created_at: '2026-01-01 00:30:00' },
    { id: 'y', task_id: 't1', created_at: '2026-01-01 01:00:00' },
  ];
  const emit = wireR1b(svc, runs, {
    x: [hTest(false, 10)],
    z: [hDiff('noop', 15)], // no harvest:test
    y: [hTest(true, 21)],
  });
  emit({ id: 'y', is_manager: 0, project_id: 'p1', task_id: 't1' });
  assert.equal(svc.listCandidates('p1').length, 0, 'intervening no-test run must break the fix pair');
});

test('R1b: malformed prev harvest:test (no boolean passed) is not a FAIL', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const runs = [
    { id: 'x', task_id: 't1', created_at: '2026-01-01 00:00:00' },
    { id: 'y', task_id: 't1', created_at: '2026-01-01 01:00:00' },
  ];
  const emit = wireR1b(svc, runs, {
    x: [{ id: 10, event_type: 'harvest:test', payload_json: '{}' }], // no boolean
    y: [hTest(true, 21)],
  });
  emit({ id: 'y', is_manager: 0, project_id: 'p1', task_id: 't1' });
  assert.equal(svc.listCandidates('p1').length, 0, 'malformed prev test must not form a pair');
});

test('R1b: same-second runs tie-break by id deterministically', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const runs = [
    { id: 'aaa-x', task_id: 't1', created_at: '2026-01-01 00:00:00' },
    { id: 'bbb-y', task_id: 't1', created_at: '2026-01-01 00:00:00' },
  ];
  const emit = wireR1b(svc, runs, { 'aaa-x': [hTest(false, 10)], 'bbb-y': [hTest(true, 21)] });
  emit({ id: 'bbb-y', is_manager: 0, project_id: 'p1', task_id: 't1' });
  const cands = svc.listCandidates('p1');
  assert.equal(cands.length, 1);
  assert.equal(JSON.parse(cands[0].raw_json).fail_run.id, 'aaa-x');
});

test('R1b: same-second runs use rowid (_seq) creation order, NOT id sort', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  // All share created_at. id-sort would order aaa<mmm<zzz => X,Y,Z and wrongly
  // pair X->Y. _seq is the true creation order X(1)->Z(2)->Y(3): Y's prev RUN
  // is Z (no harvest:test), so NO candidate (Codex r2 BLOCKER repro).
  const runs = [
    { id: 'run_aaa_fail', task_id: 't1', created_at: '2026-01-01 00:00:00', _seq: 1 },
    { id: 'run_zzz_notest', task_id: 't1', created_at: '2026-01-01 00:00:00', _seq: 2 },
    { id: 'run_mmm_pass', task_id: 't1', created_at: '2026-01-01 00:00:00', _seq: 3 },
  ];
  const emit = wireR1b(svc, runs, {
    run_aaa_fail: [hTest(false, 10)],
    run_zzz_notest: [hDiff('noop', 15)],
    run_mmm_pass: [hTest(true, 21)],
  });
  emit({ id: 'run_mmm_pass', is_manager: 0, project_id: 'p1', task_id: 't1' });
  assert.equal(svc.listCandidates('p1').length, 0, 'rowid order: same-second intervening no-test run still breaks the pair');
});

test('R1b: rowid (_seq) ordering forms the pair when prev RUN is the FAIL', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  // Same second, _seq X(1)->Y(2): Y's prev run is the FAIL X -> candidate.
  const runs = [
    { id: 'run_zzz_fail', task_id: 't1', created_at: '2026-01-01 00:00:00', _seq: 1 },
    { id: 'run_aaa_pass', task_id: 't1', created_at: '2026-01-01 00:00:00', _seq: 2 },
  ];
  const emit = wireR1b(svc, runs, { run_zzz_fail: [hTest(false, 10)], run_aaa_pass: [hTest(true, 21)] });
  emit({ id: 'run_aaa_pass', is_manager: 0, project_id: 'p1', task_id: 't1' });
  const cands = svc.listCandidates('p1');
  assert.equal(cands.length, 1);
  assert.equal(JSON.parse(cands[0].raw_json).fail_run.id, 'run_zzz_fail', 'pairs by rowid even when id-sort would invert');
});

test('createCandidate: invalid rule violates CHECK and throws (not swallowed)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  assert.throws(
    () => svc.createCandidate({ projectId: 'p1', rule: 'BOGUS', rawJson: { a: 1 }, dedupKey: 'k' }),
    /CHECK|constraint/i,
    'a CHECK violation must surface, not be hidden by ON CONFLICT'
  );
  assert.equal(svc.listCandidates('p1').length, 0);
});

// --------------------------------------------------------------------------
// G5 §5i — goal Gate 1 (harvest:acceptance) as the R1b signal for goal runs.
// Goal-ness is authoritative (run.goal_active): a goal run's ONLY signal is a
// human-gate acceptance; it NEVER falls back to the worker test command.
// --------------------------------------------------------------------------

function hAccept(passed, id, { gate = true, status = 'ran' } = {}) {
  return { id, event_type: 'harvest:acceptance', payload_json: JSON.stringify({ passed, gate, status, kind: 'command', name: 'unit', reason: null }) };
}
const GOAL_RUNS = [
  { id: 'gx', task_id: 'tg', goal_active: 1, created_at: '2026-01-01 00:00:00' },
  { id: 'gy', task_id: 'tg', goal_active: 1, created_at: '2026-01-01 01:00:00' },
];

test('G5 R1b: goal Gate 1 FAIL -> PASS = acceptance-signal fix-pair candidate', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, GOAL_RUNS, {
    gx: [hAccept(false, 10)],
    gy: [hDiff('2 files changed', 20), hAccept(true, 21)],
  });
  emit({ id: 'gy', is_manager: 0, project_id: 'p1', task_id: 'tg', goal_active: 1 });
  const cands = svc.listCandidates('p1');
  assert.equal(cands.length, 1);
  const raw = JSON.parse(cands[0].raw_json);
  assert.equal(raw.signal, 'acceptance', 'goal pair uses the acceptance signal');
  assert.equal(raw.fail_run.id, 'gx');
  assert.equal(raw.fix_run.id, 'gy');
  assert.match(raw.fix_run.diff_stat, /2 files changed/);
  assert.doesNotMatch(cands[0].raw_json, /unit|reason/, 'acceptance name/reason not leaked');
});

test('G5 R1b: advisory (gate=false) acceptance is NOT a signal -> no candidate', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, GOAL_RUNS, {
    gx: [hAccept(false, 1, { gate: false })],
    gy: [hAccept(true, 2, { gate: false })],
  });
  emit({ id: 'gy', is_manager: 0, project_id: 'p1', task_id: 'tg', goal_active: 1 });
  assert.equal(svc.listCandidates('p1').length, 0);
});

test('G5 R1b: skipped acceptance is NOT a signal -> no candidate', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, GOAL_RUNS, {
    gx: [hAccept(null, 1, { status: 'skipped' })],
    gy: [hAccept(true, 2)],
  });
  emit({ id: 'gy', is_manager: 0, project_id: 'p1', task_id: 'tg', goal_active: 1 });
  assert.equal(svc.listCandidates('p1').length, 0);
});

test('G5 R1b: a goal run NEVER falls back to the worker test signal (missing acceptance -> no pair)', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  // Both attempts have ONLY harvest:test (no acceptance) but are goal_active — a
  // worker cannot game the test command to forge a goal fix-pair.
  const emit = wireR1b(svc, GOAL_RUNS, { gx: [hTest(false, 1)], gy: [hTest(true, 2)] });
  emit({ id: 'gy', is_manager: 0, project_id: 'p1', task_id: 'tg', goal_active: 1 });
  assert.equal(svc.listCandidates('p1').length, 0, 'no test fallback for goal runs');
});

test('G5 R1b: mixed goal_active lineage (X goal, Y non-goal) -> source mismatch -> no candidate', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const mixed = [
    { id: 'mx', task_id: 'tm', goal_active: 1, created_at: '2026-01-01 00:00:00' },
    { id: 'my', task_id: 'tm', goal_active: 0, created_at: '2026-01-01 01:00:00' },
  ];
  const emit = wireR1b(svc, mixed, { mx: [hAccept(false, 1)], my: [hTest(true, 2)] });
  emit({ id: 'my', is_manager: 0, project_id: 'p1', task_id: 'tm', goal_active: 0 });
  assert.equal(svc.listCandidates('p1').length, 0, 'acceptance(FAIL) X vs test(PASS) Y is not a coherent pair');
});

test('G5 R1b: a non-gating acceptance preceding a valid gating one does NOT mask the signal', (t) => {
  const db = setupDb(t);
  const svc = createMemoryService(db);
  const emit = wireR1b(svc, GOAL_RUNS, {
    // Each run has an advisory (gate:false) acceptance BEFORE its real gating one.
    gx: [hAccept(true, 9, { gate: false }), hAccept(false, 10)],
    gy: [hDiff('1 file', 20), hAccept(false, 21, { gate: false }), hAccept(true, 22)],
  });
  emit({ id: 'gy', is_manager: 0, project_id: 'p1', task_id: 'tg', goal_active: 1 });
  const cands = svc.listCandidates('p1');
  assert.equal(cands.length, 1, 'valid gating acceptance is found past the advisory one');
  assert.equal(JSON.parse(cands[0].raw_json).signal, 'acceptance');
});
