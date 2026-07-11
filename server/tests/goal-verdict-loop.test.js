// G3 — integration tests for the goal verdict RECONCILER (spec §5d). Exercises
// the DB primitives (persistGoalVerdictTx + outbox) via runService and the
// orchestration (settle/reconcile/dispatchEffects/sweep) via goalVerdictService
// against a real in-memory DB. No lifecycle spawn — the verdict layer is driven
// from persisted terminal state, so it is tested in isolation.

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

async function harness(t, { onEmit = null } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-g3-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  const emits = [];
  const eventBus = {
    emit(channel, data) {
      emits.push({ channel, data });
      if (onEmit) onEmit(channel, data); // may throw to simulate a failed dispatch
    },
  };
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const drained = [];
  const svc = createGoalVerdictService({
    runService: rs, taskService: ts, eventBus,
    scheduleDrain: (pid) => drained.push(pid),
  });
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, ts, ps, aps, svc, emits, drained };
}

// Build a terminal goal run in the DB. acceptance = { gate, kind, status, passed, reason }.
function makeGoalRun(h, { status = 'completed', acceptance = null, retryCount = 0, maxAttempts = 3, started = true } = {}) {
  const project = h.ps.createProject({ name: `P-${Math.random().toString(36).slice(2, 7)}`, directory: '/tmp/x' });
  const profile = h.aps.createProfile({ name: `A-${Math.random().toString(36).slice(2, 7)}`, type: 'claude-code', command: 'claude' });
  const task = h.ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  // The verdict layer reads runs.acceptance_json (the aggregate), not the task's
  // verify_check_id — so no verify_checks row is needed to exercise it.
  h.db.prepare('UPDATE tasks SET goal_enabled = 1, goal_max_attempts = ? WHERE id = ?')
    .run(maxAttempts, task.id);
  // A goal worker running means its task is in_progress — mirror that so the
  // newest-goal-run authority (syncTaskStatus) has a realistic starting status.
  h.ts.updateTaskStatus(task.id, 'in_progress');
  const run = h.rs.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'do it', node_id: 'local', retry_count: retryCount });
  h.rs.setGoalActive(run.id, 1);
  // Drive through a legal path to the requested terminal status.
  if (started) h.rs.markRunStarted(run.id, {});
  if (status === 'completed') { h.rs.updateRunStatus(run.id, 'running', { force: true }); h.rs.updateRunStatus(run.id, 'completed', { force: true }); }
  else if (status === 'failed') { if (started) h.rs.updateRunStatus(run.id, 'running', { force: true }); h.rs.updateRunStatus(run.id, 'failed', { force: true }); }
  else h.rs.updateRunStatus(run.id, status, { force: true });
  if (acceptance) h.rs.updateGoalAcceptance(run.id, acceptance);
  return { run: h.rs.getRun(run.id), task, project, profile };
}

// The fake eventBus captures ALL emits (run:status too); goalChannels() keeps
// only the goal outbox effects for exact-set assertions.
function goalChannels(emits) { return emits.map((e) => e.channel).filter((c) => c.startsWith('goal:')).sort(); }

const GATE_FAIL = { gate: true, kind: 'command', status: 'ran', passed: false, reason: null };
const GATE_PASS = { gate: true, kind: 'command', status: 'ran', passed: true, reason: null };

test('completed + gating check FAILED + budget left → retry: child queued (goal_active, retry lineage), parent linked, task in_progress, effect dispatched, child drained', async (t) => {
  const h = await harness(t);
  const { run, task, profile } = makeGoalRun(h, { status: 'completed', acceptance: GATE_FAIL, retryCount: 0, maxAttempts: 3 });

  const res = h.svc.settle(run.id);
  assert.equal(res.winner, true);
  assert.equal(res.verdict, 'retry');

  const parent = h.rs.getRun(run.id);
  assert.equal(parent.goal_verdict, 'retry');
  assert.ok(parent.goal_retry_run_id, 'parent linked to child');

  const child = h.rs.getRun(parent.goal_retry_run_id);
  assert.equal(child.status, 'queued');
  assert.equal(Number(child.goal_active), 1, 'child inherits goal control');
  assert.equal(Number(child.retry_count), 1, 'attempt incremented');
  assert.equal(child.retry_root_run_id, run.id, 'retry root anchored to first attempt');
  assert.equal(child.agent_profile_id, profile.id);

  assert.equal(h.ts.getTask(task.id).status, 'in_progress');
  assert.ok(h.drained.includes(profile.id), 'scheduleDrain woke the child profile');

  const verdictEmits = h.emits.filter((e) => e.channel === 'goal:verdict');
  assert.equal(verdictEmits.length, 1, 'goal:verdict dispatched exactly once');
  assert.equal(verdictEmits[0].data.idempotency_key, `${run.id}:goal:verdict`);
  assert.equal(h.rs.listPendingGoalEffects(run.id).length, 0, 'no effect left pending after dispatch');
});

test('completed + gating check PASSED → gate2 (semantic review), no child, task review, only goal:verdict', async (t) => {
  const h = await harness(t);
  const { run, task } = makeGoalRun(h, { status: 'completed', acceptance: GATE_PASS });
  const res = h.svc.settle(run.id);
  assert.equal(res.verdict, 'gate2');
  assert.equal(h.rs.getRun(run.id).goal_retry_run_id, null, 'no retry child');
  assert.equal(h.ts.getTask(task.id).status, 'review');
  assert.deepEqual(goalChannels(h.emits), ['goal:verdict']);
});

test('failed + budget exhausted → exhausted: task failed, goal:verdict + goal:exhausted both dispatched', async (t) => {
  const h = await harness(t);
  // retryCount 2, maxAttempts 3 → attemptsUsed 3 == budget → no budget left.
  const { run, task } = makeGoalRun(h, { status: 'failed', retryCount: 2, maxAttempts: 3 });
  const res = h.svc.settle(run.id);
  assert.equal(res.verdict, 'exhausted');
  assert.equal(h.ts.getTask(task.id).status, 'failed');
  assert.deepEqual(goalChannels(h.emits), ['goal:exhausted', 'goal:verdict']);
  const exhausted = h.emits.find((e) => e.channel === 'goal:exhausted');
  assert.equal(exhausted.data.idempotency_key, `${run.id}:goal:exhausted`);
  assert.equal(h.rs.getRun(run.id).goal_retry_run_id, null);
});

test('failed before start (never entered execution) → error/non_retryable: task review, goal:error dispatched', async (t) => {
  const h = await harness(t);
  const { run, task } = makeGoalRun(h, { status: 'failed', started: false, retryCount: 0, maxAttempts: 3 });
  const res = h.svc.settle(run.id);
  assert.equal(res.verdict, 'error');
  assert.equal(h.rs.getRun(run.id).goal_verdict_reason, 'non_retryable');
  assert.equal(h.ts.getTask(task.id).status, 'review');
  assert.deepEqual(goalChannels(h.emits), ['goal:error', 'goal:verdict']);
});

test('CAS single-winner: two concurrent settle() → one winner, exactly one child, effects dispatched once', async (t) => {
  const h = await harness(t);
  const { run } = makeGoalRun(h, { status: 'completed', acceptance: GATE_FAIL, retryCount: 0, maxAttempts: 3 });
  const a = h.svc.settle(run.id);
  const b = h.svc.settle(run.id); // second call — already verdicted → reconcile-only
  assert.equal(a.winner, true);
  assert.equal(b.winner, false);
  // Exactly one retry child in the DB for this task.
  const children = h.rs.listRuns({ task_id: run.task_id }).filter((r) => r.retry_root_run_id === run.id);
  assert.equal(children.length, 1, 'exactly one retry child');
  assert.equal(h.emits.filter((e) => e.channel === 'goal:verdict').length, 1, 'effect dispatched once (sent, not re-emitted)');
});

test('outbox at-least-once: a throwing emit leaves the effect pending; a later dispatch re-drives it; once sent it never re-emits', async (t) => {
  let failNext = true;
  const h = await harness(t, {
    onEmit(channel) {
      if (channel === 'goal:verdict' && failNext) { failNext = false; throw new Error('subscriber down'); }
    },
  });
  const { run } = makeGoalRun(h, { status: 'completed', acceptance: GATE_PASS });
  h.svc.settle(run.id); // first dispatch throws on goal:verdict → stays pending
  assert.equal(h.rs.listPendingGoalEffects(run.id).length, 1, 'effect still pending after failed emit (never lost)');

  h.svc.dispatchEffects(run.id); // re-drive
  assert.equal(h.rs.listPendingGoalEffects(run.id).length, 0, 'effect sent on re-drive');
  const verdictEmits = h.emits.filter((e) => e.channel === 'goal:verdict');
  assert.equal(verdictEmits.length, 2, 'emitted twice total (at-least-once)');

  h.svc.dispatchEffects(run.id); // no more pending → no further emit
  assert.equal(h.emits.filter((e) => e.channel === 'goal:verdict').length, 2, 'sent rows never re-emit (bounded)');
});

test('fingerprint repeat across attempts → early gate2/no_progress even with budget left', async (t) => {
  const h = await harness(t);
  // First attempt: completed + gate fail → retry, persists a fingerprint.
  const { run: a, task } = makeGoalRun(h, { status: 'completed', acceptance: GATE_FAIL, retryCount: 0, maxAttempts: 5 });
  const r1 = h.svc.settle(a.id);
  assert.equal(r1.verdict, 'retry');
  const childId = h.rs.getRun(a.id).goal_retry_run_id;

  // The child re-runs, completes, and hits the SAME gate failure (same fingerprint).
  h.rs.markRunStarted(childId, {});
  h.rs.updateRunStatus(childId, 'running', { force: true });
  h.rs.updateRunStatus(childId, 'completed', { force: true });
  h.rs.updateGoalAcceptance(childId, GATE_FAIL);

  const r2 = h.svc.settle(childId);
  assert.equal(r2.verdict, 'gate2', 'no progress → escalate to Gate 2 instead of looping');
  assert.equal(h.rs.getRun(childId).goal_verdict_reason, 'no_progress');
  assert.equal(h.ts.getTask(task.id).status, 'review');
});

test('sweep: settles an unverdicted terminal goal run and redrives a verdicted run with a pending effect', async (t) => {
  // Build one unverdicted terminal run + one verdicted run whose effect is stuck pending.
  let dropVerdict = true;
  const h = await harness(t, {
    onEmit(channel) { if (channel === 'goal:verdict' && dropVerdict) { dropVerdict = false; throw new Error('down'); } },
  });
  const unverdicted = makeGoalRun(h, { status: 'completed', acceptance: GATE_PASS });
  const stuck = makeGoalRun(h, { status: 'completed', acceptance: GATE_PASS });
  h.svc.settle(stuck.run.id); // its goal:verdict emit throws → verdict set, effect pending
  assert.equal(h.rs.getRun(stuck.run.id).goal_verdict, 'gate2');
  assert.equal(h.rs.listPendingGoalEffects(stuck.run.id).length, 1);
  assert.equal(h.rs.getRun(unverdicted.run.id).goal_verdict, null);

  const out = h.svc.sweep();
  assert.ok(out.swept >= 1 && out.reconciled >= 1);
  assert.ok(h.rs.getRun(unverdicted.run.id).goal_verdict, 'unverdicted run settled by sweep');
  assert.equal(h.rs.listPendingGoalEffects(stuck.run.id).length, 0, 'stuck effect redriven to sent by sweep');
});

test('boot-sweep reconciling an OLDER attempt never reverts the task from the lineage-tip verdict (codex BLOCKER)', async (t) => {
  const h = await harness(t);
  // Attempt A: completed + gate fail → retry (task stays in_progress), child B.
  const { run: a, task } = makeGoalRun(h, { status: 'completed', acceptance: GATE_FAIL, retryCount: 0, maxAttempts: 3 });
  assert.equal(h.svc.settle(a.id).verdict, 'retry');
  const childId = h.rs.getRun(a.id).goal_retry_run_id;
  // Attempt B (the tip): completed + gate pass → gate2 → task review.
  h.rs.markRunStarted(childId, {});
  h.rs.updateRunStatus(childId, 'running', { force: true });
  h.rs.updateRunStatus(childId, 'completed', { force: true });
  h.rs.updateGoalAcceptance(childId, GATE_PASS);
  assert.equal(h.svc.settle(childId).verdict, 'gate2');
  assert.equal(h.ts.getTask(task.id).status, 'review', 'tip verdict drives the task');

  // A reboot sweep reconciles BOTH A (verdict=retry) and B (verdict=gate2) in
  // arbitrary order. The task must remain 'review' (tip), never revert to
  // in_progress from A's stale retry verdict.
  h.svc.sweep();
  assert.equal(h.ts.getTask(task.id).status, 'review', 'sweep of the old attempt did not revert the task');
  // Reconciling A directly must also not revert.
  h.svc.reconcile(a.id);
  assert.equal(h.ts.getTask(task.id).status, 'review', 'direct reconcile of the old attempt did not revert the task');
});

test('cancelled/stopped goal run: settle (and boot sweep) syncs the task to review, never strands it (codex final BLOCKER)', async (t) => {
  const h = await harness(t);
  // A goal run that was cancelled after the task was left in_progress, with the
  // synchronous checkTaskCompletion never having fired (simulated crash).
  const { run, task } = makeGoalRun(h, { status: 'completed' });
  h.rs.updateRunStatus(run.id, 'running', { force: true });
  h.rs.updateRunStatus(run.id, 'cancelled', { force: true });
  assert.equal(h.ts.getTask(task.id).status, 'in_progress', 'precondition: task not yet reconciled');

  // The sweep enters via settle for this unverdicted terminal run.
  const res = h.svc.settle(run.id);
  assert.equal(res.settled, true);
  assert.equal(h.rs.getRun(run.id).goal_verdict, null, 'cancelled is not an attempt — no verdict');
  assert.equal(h.ts.getTask(task.id).status, 'review', 'task reconciled to review, not stranded');
});

test('settle no-ops for a non-goal run and a non-terminal goal run', async (t) => {
  const h = await harness(t);
  // non-goal
  const project = h.ps.createProject({ name: 'NG', directory: '/tmp/x' });
  const profile = h.aps.createProfile({ name: 'ng', type: 'claude-code', command: 'claude' });
  const task = h.ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  const ng = h.rs.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'x', node_id: 'local' });
  h.rs.updateRunStatus(ng.id, 'running', { force: true });
  h.rs.updateRunStatus(ng.id, 'completed', { force: true });
  assert.equal(h.svc.settle(ng.id).settled, false, 'non-goal run ignored');

  // goal but still running
  const g = makeGoalRun(h, { status: 'completed' });
  h.rs.updateRunStatus(g.run.id, 'running', { force: true }); // back to non-terminal
  assert.equal(h.svc.settle(g.run.id).settled, false, 'non-terminal goal run ignored');
  assert.equal(goalChannels(h.emits).length, 0, 'no goal effects for ignored runs');
});
