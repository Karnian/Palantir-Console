// G4b §5j — goal 산출물 전달. code-mode branch promotion against a REAL git repo
// fixture + deliverable-mode + the guarded selection/race/idempotency/failure paths.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createWorktreeService } = require('../services/worktreeService');
const { createGoalDeliveryService } = require('../services/goalDeliveryService');
const { createEventBus } = require('../services/eventBus');

function git(cwd, args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-g4b-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'base']);
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
  return dir;
}

// Make a worker branch with a commit ahead of main (simulates harvested work).
function makeWorkerBranch(repo, branch) {
  git(repo, ['branch', branch, 'main']);
  git(repo, ['checkout', '-q', branch]);
  fs.writeFileSync(path.join(repo, 'work.txt'), 'worker output\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'work']);
  git(repo, ['checkout', '-q', 'main']);
}

function branchExists(repo, branch) {
  try { git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]); return true; } catch { return false; }
}

async function harness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-g4b-db-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db, eventBus);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const wts = createWorktreeService();
  const svc = createGoalDeliveryService({
    runService: rs, taskService: ts, projectService: ps, worktreeService: wts,
    goalFeatureActive: () => true,
  });
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, ts, ps, aps, wts, svc, eventBus };
}

// Build a goal task + a terminal goal run with the given verdict + branch.
function makeGoalTaskRun(h, { repoDir = null, verdict = 'gate2', branch = null, status = 'completed', deliverableJson = null, sourceType = 'legacy_directory' } = {}) {
  const project = h.ps.createProject({ name: `P-${Math.random().toString(36).slice(2, 7)}`, directory: repoDir || '/tmp/none' });
  if (sourceType !== 'legacy_directory') h.db.prepare('UPDATE projects SET source_type = ? WHERE id = ?').run(sourceType, project.id);
  const profile = h.aps.createProfile({ name: `A-${Math.random().toString(36).slice(2, 7)}`, type: 'claude-code', command: 'claude' });
  const task = h.ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  h.db.prepare('UPDATE tasks SET goal_enabled = 1, goal_max_attempts = 3 WHERE id = ?').run(task.id);
  if (deliverableJson) h.db.prepare('UPDATE tasks SET deliverable_json = ? WHERE id = ?').run(JSON.stringify(deliverableJson), task.id);
  const run = h.rs.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'x', node_id: 'local' });
  h.rs.setGoalActive(run.id, 1);
  h.rs.markRunStarted(run.id, branch ? { branch } : {});
  h.rs.updateRunStatus(run.id, 'running', { force: true });
  h.rs.updateRunStatus(run.id, status, { force: true });
  h.db.prepare('UPDATE runs SET goal_verdict = ? WHERE id = ?').run(verdict, run.id);
  return { project, task, run: h.rs.getRun(run.id) };
}

function delivery(h, taskId) {
  const t = h.ts.getTask(taskId);
  try { return t.goal_delivery_json ? JSON.parse(t.goal_delivery_json) : null; } catch { return null; }
}
function runEvents(h, runId) { return (h.rs.getRunEvents(runId) || []).map((e) => e.event_type); }

test('code mode: gate2 tip → promotes the branch to palantir/goal/<taskId> + records delivered', async (t) => {
  const h = await harness(t);
  const repo = makeRepo(t);
  makeWorkerBranch(repo, 'palantir-run-abc');
  const { task, run } = makeGoalTaskRun(h, { repoDir: repo, verdict: 'gate2', branch: 'palantir-run-abc' });
  h.ts.updateTaskStatus(task.id, 'done');

  const res = await h.svc.deliver(task.id);
  assert.equal(res.delivered, true);
  assert.equal(res.mode, 'branch');
  assert.ok(branchExists(repo, `palantir/goal/${task.id}`), 'stable delivery ref created');
  const d = delivery(h, task.id);
  assert.equal(d.state, 'delivered');
  assert.equal(d.run_id, run.id);
  assert.equal(d.branch, `palantir/goal/${task.id}`);
  assert.ok(runEvents(h, run.id).includes('goal:delivered'));
});

test('B1: an exhausted/error tip is NOT auto-delivered (no_accepted_attempt)', async (t) => {
  const h = await harness(t);
  const repo = makeRepo(t);
  makeWorkerBranch(repo, 'palantir-run-ex');
  const { task, run } = makeGoalTaskRun(h, { repoDir: repo, verdict: 'exhausted', branch: 'palantir-run-ex', status: 'failed' });
  h.ts.updateTaskStatus(task.id, 'done');
  const res = await h.svc.deliver(task.id);
  assert.equal(res.delivered, false);
  assert.equal(res.reason, 'no_accepted_attempt');
  assert.ok(!branchExists(repo, `palantir/goal/${task.id}`), 'no promotion for a non-gate2 tip');
  assert.equal(delivery(h, task.id).state, 'failed');
  assert.ok(runEvents(h, run.id).includes('goal:deliver_failed'));
});

test('B3: an active goal run defers delivery; a non-done task is not delivered', async (t) => {
  const h = await harness(t);
  const repo = makeRepo(t);
  makeWorkerBranch(repo, 'palantir-run-act');
  const { task } = makeGoalTaskRun(h, { repoDir: repo, verdict: 'gate2', branch: 'palantir-run-act' });
  // A second, still-running goal attempt on the same task.
  const prof = h.aps.createProfile({ name: 'a2', type: 'claude-code', command: 'claude' });
  const active = h.rs.createRun({ task_id: task.id, agent_profile_id: prof.id, prompt: 'x', node_id: 'local' });
  h.rs.setGoalActive(active.id, 1);
  h.rs.markRunStarted(active.id, {});
  h.rs.updateRunStatus(active.id, 'running', { force: true });
  h.ts.updateTaskStatus(task.id, 'done');
  assert.equal((await h.svc.deliver(task.id)).reason, 'active_run', 'deferred while a run is active');

  // Non-done task never delivers.
  const { task: t2 } = makeGoalTaskRun(h, { repoDir: repo, verdict: 'gate2', branch: 'palantir-run-act' });
  assert.equal((await h.svc.deliver(t2.id)).reason, 'not_done');
});

test('idempotency: two deliveries promote once + keep a single delivered record (CAS)', async (t) => {
  const h = await harness(t);
  const repo = makeRepo(t);
  makeWorkerBranch(repo, 'palantir-run-idem');
  const { task } = makeGoalTaskRun(h, { repoDir: repo, verdict: 'gate2', branch: 'palantir-run-idem' });
  h.ts.updateTaskStatus(task.id, 'done');
  const a = await h.svc.deliver(task.id);
  const b = await h.svc.deliver(task.id);
  assert.equal(a.delivered, true);
  assert.equal(b.reason, 'already_delivered');
  assert.equal(delivery(h, task.id).state, 'delivered');
});

test('failure mode: a bad/absent source branch → deliver_failed, done stays done, no throw', async (t) => {
  const h = await harness(t);
  const repo = makeRepo(t);
  // branch on the run does NOT exist in the repo → promote fails.
  const { task, run } = makeGoalTaskRun(h, { repoDir: repo, verdict: 'gate2', branch: 'palantir-run-missing' });
  h.ts.updateTaskStatus(task.id, 'done');
  const res = await h.svc.deliver(task.id);
  assert.equal(res.delivered, false);
  assert.equal(res.reason, 'promote_failed');
  assert.equal(h.ts.getTask(task.id).status, 'done', 'delivery never reverts done');
  assert.equal(delivery(h, task.id).state, 'failed');
  assert.ok(runEvents(h, run.id).includes('goal:deliver_failed'));
});

test('deliverable mode: no branch + deliverable_json → recorded as delivered bundle', async (t) => {
  const h = await harness(t);
  const { task, run } = makeGoalTaskRun(h, { verdict: 'gate2', branch: null, deliverableJson: { run_id: 'r', files: [{ path: 'out.md' }] } });
  h.ts.updateTaskStatus(task.id, 'done');
  const res = await h.svc.deliver(task.id);
  assert.equal(res.delivered, true);
  assert.equal(res.mode, 'deliverable');
  const d = delivery(h, task.id);
  assert.equal(d.state, 'delivered');
  assert.equal(d.mode, 'deliverable');
  assert.ok(d.bundle && Array.isArray(d.bundle.files));
  assert.ok(runEvents(h, run.id).includes('goal:delivered'));
});

test('materialized git-source project → repo_delivery_deferred (surfaced, not silent)', async (t) => {
  const h = await harness(t);
  const { task, run } = makeGoalTaskRun(h, { verdict: 'gate2', branch: 'palantir-run-repo', sourceType: 'git' });
  h.ts.updateTaskStatus(task.id, 'done');
  const res = await h.svc.deliver(task.id);
  assert.equal(res.reason, 'repo_delivery_deferred');
  assert.equal(delivery(h, task.id).state, 'failed');
  assert.ok(runEvents(h, run.id).includes('goal:deliver_failed'));
});

// --- HTTP route: POST /api/tasks/:id/goal/deliver is cookie-only (human authority) ---
const request = require('supertest');
const { createApp } = require('../app');

function routeApp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-g4b-route-'));
  const app = createApp({
    storageRoot: tmp, fsRoot: tmp, dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false }, authToken: 'secret-token',
    goalFeatureActive: () => true,
  });
  t.after(() => { try { if (app.shutdown) app.shutdown(); else app.closeDb(); } catch { /* */ } fs.rmSync(tmp, { recursive: true, force: true }); });
  const db = app.services._rawDb;
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P1')").run();
  db.prepare("INSERT INTO tasks (id, project_id, title, goal_enabled, status) VALUES ('t1', 'p1', 'T1', 1, 'done')").run();
  return app;
}

test('route: goal/deliver rejects bearer/none, accepts cookie (human-only)', async (t) => {
  const app = routeApp(t);
  await request(app).post('/api/tasks/t1/goal/deliver').set('Authorization', 'Bearer secret-token').expect(403);
  const ok = await request(app).post('/api/tasks/t1/goal/deliver').set('Cookie', 'palantir_token=secret-token').expect(200);
  // No accepted gate2 attempt on this bare task → deliver returns a reason, not a throw.
  assert.ok(ok.body.result && typeof ok.body.result.delivered === 'boolean');
});

test('route: goal/deliver 404 for an unknown task', async (t) => {
  const app = routeApp(t);
  await request(app).post('/api/tasks/nope/goal/deliver').set('Cookie', 'palantir_token=secret-token').expect(404);
});
