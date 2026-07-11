// G2 §5k-1 — goal workspace (deliverable mode) provider: an isolated cwd for a
// goal run with no git workspace; fail-closed; non-goal runs unaffected.

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
const { createLifecycleService } = require('../services/lifecycleService');

function stubExec() {
  const spawned = [];
  return {
    spawned, type: 'cli',
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: `s-${runId}` }; },
    isAlive() { return false; }, detectExitCode() { return 0; }, getOutput() { return ''; },
    sendInput() { return true; }, kill() {}, discoverGhostSessions() { return []; }, listSessions() { return []; }, hasProcess() { return false; },
  };
}
function stubSJE() {
  return { spawnAgent() { return { sessionName: null }; }, isAlive() { return false; }, detectExitCode() { return 0; }, getOutput() { return ''; }, sendInput() { return true; }, kill() {}, discoverGhostSessions() { return []; }, hasProcess() { return false; } };
}

async function harness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-g2ws-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 't.db'));
  migrate();
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const exec = stubExec();
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: exec, streamJsonEngine: stubSJE(), worktreeService: null, eventBus: null,
    goalFeatureActive: () => true, // G2 §6: exercise goal features in tests
  });
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, ts, ps, exec, lc };
}
function seedProfile(db) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'A', 'codex', 'codex', '{prompt}', '{}', '[]', 5)`).run(id);
  return { id };
}

test('goal deliverable run (no git workspace) executes in an isolated goal workspace', async (t) => {
  const { db, rs, ts, exec, lc } = await harness(t);
  const task = ts.createTask({ title: 'research', description: 'no project' }); // project_id null → no git workspace
  db.prepare('UPDATE tasks SET goal_enabled = 1 WHERE id = ?').run(task.id);
  const profile = seedProfile(db);
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });
  assert.equal(exec.spawned.length, 1);
  const cwd = exec.spawned[0].opts.cwd;
  assert.match(cwd, /goal-workspaces/, 'cwd is an isolated goal workspace');
  assert.ok(cwd.includes(run.id), 'workspace path is per-run');
  assert.ok(fs.existsSync(cwd), 'workspace dir created');
  assert.equal(rs.getRun(run.id).goal_workspace_path, cwd, 'goal_workspace_path persisted');
  t.after(() => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} });
});

test('goal task with goal mode OFF runs as a normal task (no goal workspace) — §6', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-g2ws-off-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 't.db'));
  migrate();
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const exec = stubExec();
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: exec, streamJsonEngine: stubSJE(), worktreeService: null, eventBus: null,
    goalFeatureActive: () => false, // goal mode OFF → goal features inert
  });
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const task = ts.createTask({ title: 'goal but mode off', description: 'd' });
  db.prepare('UPDATE tasks SET goal_enabled = 1 WHERE id = ?').run(task.id);
  const profile = seedProfile(db);
  await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });
  const cwd = exec.spawned[0].opts.cwd;
  assert.ok(!/goal-workspaces/.test(cwd), 'goal mode off → no goal workspace (runs normally)');
});

test('non-goal project-less run does NOT get a goal workspace (unchanged)', async (t) => {
  const { db, ts, exec, lc } = await harness(t);
  const task = ts.createTask({ title: 't', description: 'd' }); // goal_enabled stays 0
  const profile = seedProfile(db);
  await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });
  const cwd = exec.spawned[0].opts.cwd;
  assert.ok(!/goal-workspaces/.test(cwd), 'non-goal run keeps the existing cwd policy');
});

test('goal run WITH a git worktree stays in code mode (uses the worktree, not a goal workspace)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-g2ws-wt-'));
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-g2ws-wtroot-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 't.db'));
  migrate();
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const exec = stubExec();
  // worktreeService that reports a git repo and hands back a worktree path.
  const worktreeService = {
    async classifyProjectDir() { return 'git'; },
    async createWorktree() { return { path: wtRoot, branch: 'run-branch' }; },
    async removeWorktree() {},
  };
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: exec, streamJsonEngine: stubSJE(), worktreeService, eventBus: null,
  });
  t.after(() => { close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(wtRoot, { recursive: true, force: true }); });
  const project = ps.createProject({ name: 'P', directory: wtRoot });
  const task = ts.createTask({ project_id: project.id, title: 't', description: 'd' });
  db.prepare('UPDATE tasks SET goal_enabled = 1 WHERE id = ?').run(task.id);
  const profile = seedProfile(db);
  await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'go' });
  const cwd = exec.spawned[0].opts.cwd;
  assert.ok(!/goal-workspaces/.test(cwd), 'a git-workspace goal run stays in code mode (worktree)');
  assert.equal(cwd, wtRoot);
});
