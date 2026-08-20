const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createGoalVerdictService } = require('../services/goalVerdictService');

const GATE_FAIL = { gate: true, kind: 'command', status: 'ran', passed: false, reason: 'same failure' };

async function harness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-goal-parent-fp-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  const eventBus = { emit() {} };
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const svc = createGoalVerdictService({ runService: rs, taskService: ts, eventBus });
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, ts, ps, aps, svc };
}

function terminalRun(h, { status = 'completed', acceptance = GATE_FAIL } = {}) {
  const project = h.ps.createProject({ name: `P-${Math.random()}`, directory: '/tmp/x' });
  const profile = h.aps.createProfile({ name: `A-${Math.random()}`, type: 'claude-code', command: 'claude' });
  const task = h.ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  h.db.prepare('UPDATE tasks SET goal_enabled = 1, goal_max_attempts = 5 WHERE id = ?').run(task.id);
  h.ts.updateTaskStatus(task.id, 'in_progress');
  const run = h.rs.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'x', node_id: 'local' });
  h.rs.setGoalActive(run.id, 1);
  h.rs.markRunStarted(run.id, {});
  h.rs.updateRunStatus(run.id, status, { force: true });
  if (acceptance) h.rs.updateGoalAcceptance(run.id, acceptance);
  return h.rs.getRun(run.id);
}

function parentAndChild(h, { parentStatus = 'completed' } = {}) {
  const parent = terminalRun(h, { status: parentStatus });
  const child = terminalRun(h, { status: 'completed' });
  h.db.prepare('UPDATE runs SET goal_retry_run_id = ? WHERE id = ?').run(child.id, parent.id);
  return { parent: h.rs.getRun(parent.id), child: h.rs.getRun(child.id) };
}

test('unsettled completed parent fingerprint is recomputed for repeat detection', async (t) => {
  const h = await harness(t);
  const { parent, child } = parentAndChild(h);
  assert.equal(parent.goal_fingerprint, null);
  assert.equal(h.svc.computeInputs(child, null).fingerprintRepeat, true);
});

test('fallback fingerprint exactly equals the value settlement persists for the same parent row', async (t) => {
  const h = await harness(t);
  const { parent, child } = parentAndChild(h);
  const recomputed = h.svc.computeInputs(child, null).fingerprint;
  assert.equal(h.svc.computeInputs(child, null).fingerprintRepeat, true);

  h.db.prepare('UPDATE runs SET goal_retry_run_id = NULL WHERE id = ?').run(parent.id);
  assert.equal(h.svc.settle(parent.id).winner, true);
  assert.equal(h.rs.getRun(parent.id).goal_fingerprint, recomputed);
});

test('cancelled and stopped parents never acquire or contribute a fingerprint', async (t) => {
  const h = await harness(t);
  for (const status of ['cancelled', 'stopped']) {
    const { parent, child } = parentAndChild(h, { parentStatus: status });
    assert.equal(h.svc.computeInputs(child, null).fingerprintRepeat, false, status);
    assert.equal(h.rs.getRun(parent.id).goal_fingerprint, null, `${status} remains NULL`);
  }
});

// Both pending shapes are deliberately "unknown". The expired one is the case a
// reviewer flags as a residual: resolveJudge would CAS it to 'error' and settle,
// so guessing 'error' here would usually match. It is still a guess made without
// taking the CAS -- if the judge finalizes 'fail' the guess produces a signature
// the parent never stores, and a WRONG signature ends the goal early while a
// missing one only costs an attempt. The asymmetry is why this stays unknown.
for (const [label, deadline] of [
  ['in flight', '2999-01-01T00:00:00.000Z'],
  ['past its deadline', '2000-01-01T00:00:00.000Z'],
]) {
  test(`a parent judge ${label} is unknown and is never mutated while checking a child`, async (t) => {
    const h = await harness(t);
    const { parent, child } = parentAndChild(h);
    const pending = JSON.stringify({ status: 'pending', deadline });
    h.db.prepare('UPDATE runs SET goal_judge_active = 1, judge_json = ? WHERE id = ?').run(pending, parent.id);

    assert.equal(h.svc.computeInputs(child, null).fingerprintRepeat, false);
    // No CAS to 'error', no verdict: deciding an expired judge belongs to the
    // parent's own settle, never to a child settling first.
    assert.equal(h.rs.getRun(parent.id).judge_json, pending);
    assert.equal(h.rs.getRun(parent.id).goal_fingerprint, null);
  });
}

test('persisted parent fingerprint takes precedence over recomputation', async (t) => {
  const h = await harness(t);
  const { parent, child } = parentAndChild(h);
  const childFingerprint = h.svc.computeInputs(child, null).fingerprint;
  h.db.prepare('UPDATE runs SET acceptance_json = ?, goal_fingerprint = ? WHERE id = ?')
    .run(JSON.stringify({ ...GATE_FAIL, reason: 'different row signature' }), childFingerprint, parent.id);

  assert.equal(h.svc.computeInputs(child, null).fingerprintRepeat, true);
});

test('an inactive judge is ignored exactly as settlement ignores it', async (t) => {
  // resolveJudge yields judge=null whenever goal_judge_active is falsy, even when
  // judge_json still holds a finalized verdict. A recompute that parses judge_json
  // unconditionally adds the judge leg to the signature and produces a fingerprint
  // the parent's own settlement would never store — silently defeating repeat
  // detection instead of restoring it.
  const h = await harness(t);
  const { parent, child } = parentAndChild(h);
  h.db.prepare(
    "UPDATE runs SET goal_judge_active = 0, judge_json = ?, acceptance_json = NULL WHERE id = ?",
  ).run(JSON.stringify({ status: 'fail', input_fp: 'judge-input-fp' }), parent.id);
  h.db.prepare('UPDATE runs SET acceptance_json = NULL WHERE id = ?').run(child.id);

  const withFallback = h.svc.computeInputs(h.rs.getRun(child.id), null);

  // Settle the parent and compare against what it actually persists.
  h.svc.settle(parent.id);
  const settled = h.rs.getRun(parent.id);
  assert.ok(settled.goal_fingerprint, 'parent must have settled');
  assert.equal(
    h.svc.computeInputs(h.rs.getRun(child.id), null).fingerprintRepeat,
    withFallback.fingerprintRepeat,
    'the recomputed signature must agree with the persisted one',
  );
  assert.equal(withFallback.fingerprintRepeat, true);
});

test('a child whose parent judge is still pending defers instead of verdicting', async (t) => {
  const h = await harness(t);
  const { parent, child } = parentAndChild(h);
  h.db.prepare('UPDATE runs SET goal_judge_active = 1, judge_json = ? WHERE id = ?')
    .run(JSON.stringify({ status: 'pending', deadline: '2000-01-01T00:00:00.000Z' }), parent.id);

  const deferred = h.svc.settle(child.id);
  assert.equal(deferred.settled, false);
  assert.equal(deferred.pendingParentFingerprint, true);
  assert.equal(h.rs.getRun(child.id).goal_verdict, null, 'no verdict may be written while deferred');

  // Once the parent has settled -- by whichever sweep reaches it -- the child
  // settles with the signature the parent actually stored, which is the point of
  // waiting rather than guessing.
  h.svc.settle(parent.id);
  assert.ok(h.rs.getRun(parent.id).goal_fingerprint, 'parent settled');
  const settled = h.svc.settle(child.id);
  assert.equal(settled.settled, true);
  assert.equal(h.svc.computeInputs(h.rs.getRun(child.id), null).fingerprintRepeat, true);
});

for (const status of ['cancelled', 'stopped']) {
  test(`a ${status} parent never defers its child -- absence is an answer`, async (t) => {
    // These parents are not attempts under 5d, so they never acquire a
    // fingerprint. Treating that as "undecidable" would strand every child of a
    // cancelled run forever: nothing would ever resolve the wait.
    const h = await harness(t);
    const { parent, child } = parentAndChild(h, { parentStatus: status });
    assert.equal(h.rs.getRun(parent.id).goal_fingerprint, null);

    const result = h.svc.settle(child.id);
    assert.notEqual(result.pendingParentFingerprint, true);
    assert.equal(result.settled, true);
    assert.ok(h.rs.getRun(child.id).goal_verdict, 'the child must reach a verdict');
  });
}

// Every formerly divergent deadline shape is deferred while its parent is still
// pending, then converges because the shared SQLite oracle gives every claim an
// escape path (unreadable deadlines expire immediately).
for (const [label, judge] of [
  ['absent', { status: 'pending' }],
  ['unparseable', { status: 'pending', deadline: 'not-a-date' }],
  ['parseable by Date.parse but not by SQLite', { status: 'pending', deadline: 'January 1, 2000' }],
  ['a SQLite julian day', { status: 'pending', deadline: 2451545 }],
  ['a SQLite time-only value', { status: 'pending', deadline: '12:00' }],
  ["SQLite's 'now'", { status: 'pending', deadline: 'now' }],
]) {
  test(`a judge deadline ${label} is deferred and then converges`, async (t) => {
    const h = await harness(t);
    const { parent, child } = parentAndChild(h);
    h.db.prepare('UPDATE runs SET goal_judge_active = 1, judge_json = ? WHERE id = ?')
      .run(JSON.stringify(judge), parent.id);

    const result = h.svc.settle(child.id);
    assert.equal(result.pendingParentFingerprint, true);
    assert.equal(h.rs.getRun(child.id).goal_verdict, null);

    let sweeps = 0;
    while ((!h.rs.getRun(parent.id).goal_verdict || !h.rs.getRun(child.id).goal_verdict) && sweeps < 3) {
      h.svc.sweep();
      sweeps += 1;
    }
    assert.ok(h.rs.getRun(parent.id).goal_verdict, 'the parent must settle');
    assert.equal(JSON.parse(h.rs.getRun(parent.id).judge_json).status, 'error');
    assert.ok(h.rs.getRun(child.id).goal_verdict, 'the child must settle');
    assert.ok(sweeps <= 3);
  });
}

test('sweep converges a deferred lineage without parent-first ordering', async (t) => {
  // listUnverdictedTerminalGoalRunIds has no ORDER BY, so a sweep may visit a
  // child before its parent. What must hold is that every sweep makes progress,
  // so a depth-N lineage drains in at most N sweeps rather than deadlocking.
  const h = await harness(t);
  const a = terminalRun(h, { status: 'completed' });
  const b = terminalRun(h, { status: 'completed' });
  const c = terminalRun(h, { status: 'completed' });
  h.db.prepare('UPDATE runs SET goal_retry_run_id = ? WHERE id = ?').run(b.id, a.id);
  h.db.prepare('UPDATE runs SET goal_retry_run_id = ? WHERE id = ?').run(c.id, b.id);
  // Expired-but-parseable: resolveJudge CASes it to error on the sweep that
  // reaches it, so the lineage is unblocked one generation at a time.
  h.db.prepare('UPDATE runs SET goal_judge_active = 1, judge_json = ? WHERE id = ?')
    .run(JSON.stringify({ status: 'pending', deadline: '2000-01-01T00:00:00.000Z' }), a.id);

  // Force the adverse order. Left alone, the unordered SELECT returns rowid
  // order, which happens to be parent-first and would drain in a single sweep --
  // proving nothing about the property under test.
  const originalList = h.rs.listUnverdictedTerminalGoalRunIds;
  h.rs.listUnverdictedTerminalGoalRunIds = () => {
    const ids = originalList.call(h.rs);
    const rank = new Map([[c.id, 0], [b.id, 1], [a.id, 2]]);
    return [...ids].sort((x, y) => (rank.get(x) ?? 99) - (rank.get(y) ?? 99));
  };
  assert.deepEqual(
    h.rs.listUnverdictedTerminalGoalRunIds().slice(0, 3), [c.id, b.id, a.id],
    'the sweep must see children before their parents',
  );

  const verdicted = () => [a, b, c].filter((r) => h.rs.getRun(r.id).goal_verdict).length;
  let sweeps = 0;
  while (verdicted() < 3 && sweeps < 6) { h.svc.sweep(); sweeps += 1; }

  assert.equal(verdicted(), 3, 'the whole lineage must settle even child-first');
  assert.ok(sweeps > 1, 'child-first ordering must actually cost extra sweeps, or the test proves nothing');
  assert.ok(sweeps <= 3, `depth-3 lineage should drain within 3 sweeps, took ${sweeps}`);
});
