const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createGoalVerdictService } = require('../services/goalVerdictService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');

async function harness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-judge-deadline-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  const eventBus = { emit() {} };
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const project = ps.createProject({ name: 'P', directory: '/tmp/x' });
  const profile = aps.createProfile({ name: 'A', type: 'claude-code', command: 'claude' });
  const task = ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  const svc = createGoalVerdictService({ runService: rs, taskService: ts, eventBus });
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, svc, task, profile };
}

function pendingRun(h, judge) {
  const run = h.rs.createRun({ task_id: h.task.id, agent_profile_id: h.profile.id, prompt: 'x', node_id: 'local' });
  h.rs.setGoalActive(run.id, 1);
  h.rs.setGoalJudgeActive(run.id, 1);
  h.rs.updateRunStatus(run.id, 'completed', { force: true });
  const judgeJson = JSON.stringify(judge);
  h.db.prepare('UPDATE runs SET judge_json = ? WHERE id = ?').run(judgeJson, run.id);
  return { run: h.rs.getRun(run.id), judgeJson };
}

const DEADLINES = [
  ['absent', undefined],
  ['not-a-date', 'not-a-date'],
  ['Date.parse-only', 'January 1, 2000'],
  ['julian day', 2451545],
  ['time only', '12:00'],
  ['now', 'now'],
  ['past ISO', '2000-01-01T00:00:00.000Z'],
];

test('deadline oracle and expiry CAS agree for every deadline shape', async (t) => {
  const h = await harness(t);
  for (const [label, deadline] of DEADLINES) {
    const judge = deadline === undefined ? { status: 'pending' } : { status: 'pending', deadline };
    const { run, judgeJson } = pendingRun(h, judge);
    const oracle = h.rs.isJudgeDeadlineExpired(judgeJson);
    const cas = h.rs.casJudgeExpiredToError(
      run.id,
      JSON.stringify({ status: 'error', reason: 'deadline_expired' }),
    );
    assert.equal(cas, oracle, label);
    assert.equal(oracle, true, `${label} is expired`);
  }
});

test('a future ISO deadline is not expired and resolveJudge keeps waiting', async (t) => {
  const h = await harness(t);
  const { run, judgeJson } = pendingRun(h, {
    status: 'pending',
    deadline: '2999-01-01T00:00:00.000Z',
  });
  assert.equal(h.rs.isJudgeDeadlineExpired(judgeJson), false);
  assert.equal(h.rs.casJudgeExpiredToError(run.id, JSON.stringify({ status: 'error' })), false);
  assert.deepEqual(h.svc.settle(run.id), { settled: false, pendingJudge: true });
  assert.equal(JSON.parse(h.rs.getRun(run.id).judge_json).status, 'pending');
});

test('unreadable deadlines expire and CAS pending judges to error', async (t) => {
  const h = await harness(t);
  for (const judge of [{ status: 'pending' }, { status: 'pending', deadline: 'not-a-date' }]) {
    const { run, judgeJson } = pendingRun(h, judge);
    const errorJson = JSON.stringify({ status: 'error', reason: 'deadline_expired' });
    assert.equal(h.rs.isJudgeDeadlineExpired(judgeJson), true);
    assert.equal(h.rs.casJudgeExpiredToError(run.id, errorJson), true);
    assert.deepEqual(JSON.parse(h.rs.getRun(run.id).judge_json), JSON.parse(errorJson));
  }
});

test('a judge_json that is not valid JSON settles as "never started", not as a stall', async (t) => {
  // Adversarial review flagged this as a possible remaining stall: json_extract
  // cannot read it, so the expiry CAS can never match. It is not a stall --
  // resolveJudge's JSON.parse fails, yields judge=null, and returns skip:false,
  // which is the "never started" path. Pinned so the claim stays checkable.
  const h = await harness(t);
  const run = h.rs.createRun({ task_id: h.task.id, agent_profile_id: h.profile.id, prompt: 'x', node_id: 'local' });
  h.rs.setGoalActive(run.id, 1);
  h.rs.setGoalJudgeActive(run.id, 1);
  h.rs.updateRunStatus(run.id, 'completed', { force: true });
  h.db.prepare('UPDATE runs SET judge_json = ? WHERE id = ?').run('{not json', run.id);

  const result = h.svc.settle(run.id);
  assert.notEqual(result.pendingJudge, true, 'an unreadable judge must not park the run');
  assert.equal(result.settled, true);
  assert.ok(h.rs.getRun(run.id).goal_verdict, 'the run must reach a verdict');
});
