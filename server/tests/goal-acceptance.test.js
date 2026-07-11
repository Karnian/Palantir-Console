// G2 §5f/§5k-2 — Gate 1 acceptance + deliverable harvest integration.

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
const { createVerifyCheckService } = require('../services/verifyCheckService');
const { createHarvestService } = require('../services/harvestService');
const { createEventBus } = require('../services/eventBus');

async function harness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-g2acc-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 't.db'));
  migrate();
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const vcs = createVerifyCheckService(db);
  const harvested = [];
  eventBus.subscribe((e) => { if (e.channel === 'run:harvested') harvested.push(e.data); });
  const worktreeService = { async autoSaveWorktree() {}, async getWorktreeDiff() { return { base: 'HEAD', stat: '', files: [] }; }, async removeWorktree() {} };
  const hs = createHarvestService({
    runService: rs, worktreeService, projectService: ps, eventBus,
    taskService: ts, verifyCheckService: vcs,
    goalFeatureActive: () => true, // G2 §6
  });
  const profileId = `profile-${Math.random().toString(36).slice(2)}`;
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'A', 'codex', 'codex', '{prompt}', '{}', '[]', 5)`).run(profileId);
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, ts, ps, vcs, hs, harvested, dir, profileId };
}

test('deliverable goal run: artifact acceptance runs + acceptance_json + harvest:acceptance + bundle', async (t) => {
  const { db, rs, ts, vcs, hs, harvested, profileId } = await harness(t);
  // an artifact check (operator/advisory or human/gate — use human = gate)
  const check = vcs.createCheck({ kind: 'artifact', name: 'has-output', spec_json: { files: [{ glob: 'result.txt', must_exist: true, min_bytes: 3 }] } }, { actor: 'human' });
  const task = ts.createTask({ title: 'deliverable', description: 'd' });
  db.prepare('UPDATE tasks SET goal_enabled = 1, verify_check_id = ? WHERE id = ?').run(check.id, task.id);
  // goal workspace with a matching artifact
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-g2acc-ws-'));
  fs.writeFileSync(path.join(ws, 'result.txt'), 'SHIPPED');
  t.after(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} });
  const run = rs.createRun({ is_manager: false, task_id: task.id, agent_profile_id: profileId, prompt: 'x' });
  rs.setGoalWorkspacePath(run.id, ws);
  rs.updateRunStatus(run.id, 'completed', { force: true });

  await hs.harvestRun({ ...rs.getRun(run.id) });
  const after = rs.getRun(run.id);
  assert.ok(after.acceptance_json, 'acceptance_json persisted');
  const acc = JSON.parse(after.acceptance_json);
  assert.equal(acc.kind, 'artifact');
  assert.equal(acc.passed, true, 'artifact check passed against the workspace');
  assert.equal(acc.gate, true, 'human check = gate');
  const events = rs.getRunEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes('harvest:acceptance'), 'harvest:acceptance emitted');
  assert.ok(events.includes('harvest:deliverable'), 'deliverable manifest emitted');
  assert.equal(after.deliverable_state, 'bundled', 'bundle copied out');
  assert.equal(harvested.length, 1, 'run:harvested exactly once');
});

test('deliverable goal run: FAILED artifact check is surfaced (passed:false), still one harvest', async (t) => {
  const { db, rs, ts, vcs, hs, harvested, profileId } = await harness(t);
  const check = vcs.createCheck({ kind: 'artifact', name: 'needs-dist', spec_json: { files: [{ glob: 'dist/app.js', must_exist: true }] } }, { actor: 'human' });
  const task = ts.createTask({ title: 't', description: 'd' });
  db.prepare('UPDATE tasks SET goal_enabled = 1, verify_check_id = ? WHERE id = ?').run(check.id, task.id);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-g2acc-ws2-'));
  fs.writeFileSync(path.join(ws, 'other.txt'), 'x');
  t.after(() => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} });
  const run = rs.createRun({ is_manager: false, task_id: task.id, agent_profile_id: profileId, prompt: 'x' });
  rs.setGoalWorkspacePath(run.id, ws);
  rs.updateRunStatus(run.id, 'completed', { force: true });
  await hs.harvestRun({ ...rs.getRun(run.id) });
  const acc = JSON.parse(rs.getRun(run.id).acceptance_json);
  assert.equal(acc.passed, false, 'missing dist/app.js → not passed');
  assert.equal(harvested.length, 1);
});

test('non-goal run: no acceptance stage (unchanged)', async (t) => {
  const { rs, ts, hs, profileId } = await harness(t);
  const task = ts.createTask({ title: 't', description: 'd' }); // not goal-enabled
  const run = rs.createRun({ is_manager: false, task_id: task.id, agent_profile_id: profileId, prompt: 'x' });
  rs.updateRunStatus(run.id, 'completed', { force: true });
  await hs.harvestRun({ ...rs.getRun(run.id) });
  const after = rs.getRun(run.id);
  assert.equal(after.acceptance_json, null, 'non-goal run has no acceptance');
  const events = rs.getRunEvents(run.id).map((e) => e.event_type);
  assert.ok(!events.includes('harvest:acceptance'));
});
