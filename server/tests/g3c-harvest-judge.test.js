// G3c §5k-4 — the Gate 1.5 judge stage in harvest: runs once (durable CAS claim)
// for a goal_judge_active run, persists judge_json + emits harvest:judge, skips
// when Gate 1 failed, and never runs when disabled. Mock judge → 0 LLM calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createHarvestService } = require('../services/harvestService');
const { createEventBus } = require('../services/eventBus');

function mockJudge(result = { status: 'fail', reasons: ['not good enough'], input_fp: 'fp', model: 'mock' }) {
  const calls = [];
  return { calls, hardDeadlineMs: 5000, async runJudge(input) { calls.push(input); return result; } };
}

async function harness(t, { judge } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-g3c-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db, eventBus);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const harvest = createHarvestService({ runService: rs, eventBus, projectService: ps, taskService: ts, goalJudgeService: judge || null });
  t.after(async () => { process.chdir(cwd); close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, ts, ps, aps, harvest, dir };
}

// A completed local deliverable-mode goal run with a real workspace + one file.
function makeJudgeRun(h, { judgeActive = 1, acceptance = null } = {}) {
  const project = h.ps.createProject({ name: 'P', directory: null });
  const profile = h.aps.createProfile({ name: 'a', type: 'claude-code', command: 'claude' });
  const task = h.ts.createTask({ project_id: project.id, title: 'T', description: 'd', acceptance_criteria: '- correct' });
  h.db.prepare('UPDATE tasks SET goal_enabled = 1, goal_judge_enabled = 1 WHERE id = ?').run(task.id);
  const run = h.rs.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'x', node_id: 'local' });
  h.rs.setGoalActive(run.id, 1);
  h.rs.setGoalJudgeActive(run.id, judgeActive);
  h.rs.markRunStarted(run.id, {});
  h.rs.updateRunStatus(run.id, 'running', { force: true });
  h.rs.updateRunStatus(run.id, 'completed', { force: true });
  h.rs.updateGoalCapture(run.id, { final_output: 'my deliverable summary', goal_report: null });
  const ws = path.join(h.dir, 'runtime', 'goal-workspaces', run.id);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'out.md'), 'deliverable body\n');
  h.rs.setGoalWorkspacePath(run.id, ws);
  if (acceptance) h.rs.updateGoalAcceptance(run.id, acceptance);
  return { run: h.rs.getRun(run.id), task };
}

function events(h, runId) { return (h.rs.getRunEvents(runId) || []).map((e) => e.event_type); }

test('judge runs once on a goal_judge_active harvest → judge_json finalized + harvest:judge', async (t) => {
  const judge = mockJudge({ status: 'fail', reasons: ['missing detail'], input_fp: 'fp1', model: 'mock' });
  const h = await harness(t, { judge });
  const { run } = makeJudgeRun(h);
  await h.harvest.harvestRun(run, {});
  const j = JSON.parse(h.rs.getRun(run.id).judge_json);
  assert.equal(j.status, 'fail');
  assert.deepEqual(j.reasons, ['missing detail']);
  assert.equal(judge.calls.length, 1, 'exactly one judge call');
  assert.ok(events(h, run.id).includes('harvest:judge'));
  // the judge saw the rubric + output.
  assert.match(judge.calls[0].criteria, /correct/);
  assert.match(judge.calls[0].finalOutput, /deliverable summary/);
});

test('judge is SKIPPED when Gate 1 (human gate check) FAILED — verdict is already retry', async (t) => {
  const judge = mockJudge();
  const h = await harness(t, { judge });
  const { run } = makeJudgeRun(h, { acceptance: { check_id: 'c', name: 'x', kind: 'command', gate: true, status: 'ran', passed: false } });
  await h.harvest.harvestRun(run, {});
  assert.equal(judge.calls.length, 0, 'Gate 1 fail → no judge call');
  assert.equal(h.rs.getRun(run.id).judge_json, null);
});

test('judge is idempotent — a second harvest does not re-invoke (CAS claim)', async (t) => {
  const judge = mockJudge({ status: 'pass', reasons: [], input_fp: 'fp', model: 'mock' });
  const h = await harness(t, { judge });
  const { run } = makeJudgeRun(h);
  await h.harvest.harvestRun(run, {});
  // A re-run (fresh run object) must not re-claim/re-call.
  await h.harvest.harvestRun(h.rs.getRun(run.id), {});
  assert.equal(judge.calls.length, 1, 'CAS claim prevents a second invocation');
});

test('goal_judge_active run but NO service wired → explicit error (fail-open→gate2), not a silent skip', async (t) => {
  const h = await harness(t, { judge: null });
  const { run } = makeJudgeRun(h); // stamped goal_judge_active=1
  await h.harvest.harvestRun(run, {});
  const j = JSON.parse(h.rs.getRun(run.id).judge_json);
  assert.equal(j.status, 'error');
  assert.equal(j.reason, 'judge_unavailable', 'enabled-without-a-service is observable, not silent');
  assert.ok(events(h, run.id).includes('harvest:judge'));
});

test('a run that is NOT goal_judge_active is never judged even with a service present', async (t) => {
  const judge = mockJudge();
  const h = await harness(t, { judge });
  const { run } = makeJudgeRun(h, { judgeActive: 0 });
  await h.harvest.harvestRun(run, {});
  assert.equal(judge.calls.length, 0);
  assert.equal(h.rs.getRun(run.id).judge_json, null);
});
