// G4a §5h — durable, verdict-gated Gate 2 review dispatch. Uses a real in-memory
// DB (runService/taskService) + fake managerRegistry/conversationService and a
// SYNCHRONOUS defer so the send + marker resolve inline for deterministic asserts.

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
const { createEventBus } = require('../services/eventBus');
const { createPmAutoReview } = require('../app');

async function harness(t, { throwOnSend = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-g4a-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const sent = [];
  const state = { throwOnSend };
  const conversationService = { sendMessage(slot, message) { if (state.throwOnSend) throw new Error('send failed'); sent.push({ slot, message }); } };
  const managerRegistry = { getActiveRunId() { return 'run_top_active'; }, onSlotCleared() { return () => {}; } };
  const warnings = [];
  const ctrl = createPmAutoReview({
    eventBus, managerRegistry, conversationService, runService: rs, taskService: ts,
    defer: (fn) => fn(), // synchronous → send + marker inline
    logger: { warn: (m) => warnings.push(String(m)) },
  });
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, ts, ps, aps, eventBus, sent, ctrl, state, warnings };
}

function makeGoalRun(h, { verdict = 'gate2', reason = null } = {}) {
  const project = h.ps.createProject({ name: `P-${Math.random().toString(36).slice(2, 7)}`, directory: '/tmp/x' });
  const profile = h.aps.createProfile({ name: `A-${Math.random().toString(36).slice(2, 7)}`, type: 'claude-code', command: 'claude' });
  const task = h.ts.createTask({ project_id: project.id, title: 'T', description: 'd', acceptance_criteria: '- ok' });
  h.db.prepare('UPDATE tasks SET goal_enabled = 1, goal_max_attempts = 3 WHERE id = ?').run(task.id);
  const run = h.rs.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'x', node_id: 'local' });
  h.rs.setGoalActive(run.id, 1);
  h.rs.markRunStarted(run.id, {});
  h.rs.updateRunStatus(run.id, 'running', { force: true });
  h.rs.updateRunStatus(run.id, 'completed', { force: true });
  h.db.prepare('UPDATE runs SET goal_verdict = ?, goal_verdict_reason = ?, acceptance_json = ?, goal_report = ? WHERE id = ?')
    .run(verdict, reason, JSON.stringify({ name: 'unit', kind: 'command', gate: true, status: 'ran', passed: true }), JSON.stringify({ summary: 's', blockers: [] }), run.id);
  return { run: h.rs.getRun(run.id), task, project };
}

function markerCount(h, runId) {
  return (h.rs.getRunEvents(runId) || []).filter((e) => e.event_type === 'goal:gate2_review_sent').length;
}

test('retry verdict → NO Gate 2 review (a retry child is running)', async (t) => {
  const h = await harness(t);
  const { run } = makeGoalRun(h, { verdict: 'retry' });
  h.eventBus.emit('goal:verdict', { run_id: run.id, verdict: 'retry' });
  assert.equal(h.sent.length, 0, 'retry does not trigger a review');
  assert.equal(markerCount(h, run.id), 0);
});

test('gate2 verdict → exactly one review + durable marker; a re-drive is idempotent (no second send)', async (t) => {
  const h = await harness(t);
  const { run } = makeGoalRun(h, { verdict: 'gate2' });
  h.eventBus.emit('goal:verdict', { run_id: run.id, verdict: 'gate2' });
  assert.equal(h.sent.length, 1, 'one review sent');
  assert.match(h.sent[0].message.text, /verdict: GATE2/);
  assert.equal(markerCount(h, run.id), 1, 'durable marker written after successful send');

  // Re-drive via sweep — the marker guard must skip it.
  h.ctrl.reviewSweep();
  assert.equal(h.sent.length, 1, 'no second send (marker idempotency)');
});

test('send failure → no marker → reviewSweep re-drives to success; breaker not wedged (single successful consume)', async (t) => {
  const h = await harness(t, { throwOnSend: true });
  const { run } = makeGoalRun(h, { verdict: 'gate2' });
  h.eventBus.emit('goal:verdict', { run_id: run.id, verdict: 'gate2' });
  assert.equal(h.sent.length, 0, 'send threw');
  assert.equal(markerCount(h, run.id), 0, 'no false marker on failure');

  // Endpoint recovers; the periodic sweep re-drives.
  h.state.throwOnSend = false;
  h.ctrl.reviewSweep();
  assert.equal(h.sent.length, 1, 're-driven to a successful send');
  assert.equal(markerCount(h, run.id), 1, 'marker now written');

  // And it does not keep re-sending afterward.
  h.ctrl.reviewSweep();
  assert.equal(h.sent.length, 1, 'stable after marker');
});

test('exhausted + error verdicts also review; a claim released after failure allows the next sweep', async (t) => {
  const h = await harness(t);
  const ex = makeGoalRun(h, { verdict: 'exhausted', reason: 'exhausted' });
  const er = makeGoalRun(h, { verdict: 'error', reason: 'source_changed' });
  h.ctrl.reviewSweep();
  const texts = h.sent.map((s) => s.message.text).join('\n---\n');
  assert.match(texts, /EXHAUSTED/);
  assert.match(texts, /ERROR \(source_changed\)/);
  assert.equal(markerCount(h, ex.run.id), 1);
  assert.equal(markerCount(h, er.run.id), 1);
});

test('non-goal run is NOT handled by the Gate 2 path (dispatchGate2Review no-ops)', async (t) => {
  const h = await harness(t);
  const project = h.ps.createProject({ name: 'NG', directory: '/tmp/x' });
  const profile = h.aps.createProfile({ name: 'ng', type: 'claude-code', command: 'claude' });
  const task = h.ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  const run = h.rs.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'x', node_id: 'local' });
  h.rs.updateRunStatus(run.id, 'running', { force: true });
  h.rs.updateRunStatus(run.id, 'completed', { force: true });
  assert.equal(h.ctrl.dispatchGate2Review(run.id), false, 'non-goal run ignored by Gate 2 review');
  assert.equal(h.sent.length, 0);
});
