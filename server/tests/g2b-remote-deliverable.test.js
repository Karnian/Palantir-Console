// G2b §5k-1 — remote deliverable-mode goal harvest: enumerate + transactional
// bundle via a node executor, rmrf ONLY on a fully-verified bundle, retain
// 'captured' on any failure. Uses a MOCK executor (the real one is Pi-verified).

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
const { createVerifyCheckService } = require('../services/verifyCheckService');
const { createEventBus } = require('../services/eventBus');

// A mock remote executor over an in-memory file set {relPath: Buffer}.
function mockExecutor(fileSet, opts = {}) {
  const calls = { rmrf: 0, reads: [] };
  return {
    calls,
    async listFilesWithSizes(ws, { maxEntries } = {}) {
      const files = Object.entries(fileSet).map(([relPath, buf]) => ({ relPath, size: opts.sizeOverride ? opts.sizeOverride[relPath] ?? buf.length : buf.length }));
      return { files: files.slice(0, maxEntries), truncated: files.length > maxEntries };
    },
    async readFileCapped(p, cap) {
      calls.reads.push({ p, cap });
      if (opts.throwOnRead && opts.throwOnRead(p)) throw new Error('read failed');
      const rel = p.split('/.palantir-goal-workspaces/')[1]?.split('/').slice(1).join('/') || p;
      const buf = fileSet[rel] || Buffer.alloc(0);
      return buf.subarray(0, cap);
    },
    async rmrf() { calls.rmrf += 1; },
  };
}

async function harness(t, { executor }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-g2b-'));
  const cwd = process.cwd();
  process.chdir(dir); // control-plane bundle root = <dir>/runtime/goal-artifacts
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  const eventBus = createEventBus();
  // The 'pi' remote node (FK target for runs.node_id).
  db.prepare("INSERT INTO nodes (id, name, kind, can_execute, can_control, files_only, ssh_host, ssh_user, exposed_roots, reachable) VALUES ('pi','Pi','ssh',1,0,0,'h','u','[\"/exposed\"]',1)").run();
  const rs = createRunService(db, eventBus);
  const ts = createTaskService(db, eventBus);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const nodeService = {
    pickExecutor: () => executor,
    getNode: () => ({ id: 'pi', kind: 'ssh' }), // remote → isLocalNodeRun=false
  };
  const vcs = createVerifyCheckService(db);
  const harvest = createHarvestService({ runService: rs, eventBus, projectService: ps, taskService: ts, verifyCheckService: vcs, nodeService });
  t.after(async () => { process.chdir(cwd); close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { db, rs, ts, ps, aps, vcs, harvest, dir };
}

function makeRemoteDeliverableRun(h, wsPath = '/exposed/.palantir-goal-workspaces/run_x') {
  const project = h.ps.createProject({ name: 'P', directory: null });
  const profile = h.aps.createProfile({ name: 'a', type: 'claude-code', command: 'claude' });
  const task = h.ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  h.db.prepare('UPDATE tasks SET goal_enabled = 1 WHERE id = ?').run(task.id);
  const run = h.rs.createRun({ task_id: task.id, agent_profile_id: profile.id, prompt: 'x', node_id: 'pi' });
  h.rs.setGoalActive(run.id, 1);
  h.rs.markRunStarted(run.id, {});
  h.rs.updateRunStatus(run.id, 'running', { force: true });
  h.rs.updateRunStatus(run.id, 'completed', { force: true });
  h.rs.setGoalWorkspacePath(run.id, wsPath);
  return { run: h.rs.getRun(run.id), task };
}

function bundleDir(h, run) {
  return path.join(h.dir, 'runtime', 'goal-artifacts', run.task_id, run.id);
}
function events(h, runId) { return (h.rs.getRunEvents(runId) || []).map((e) => e.event_type); }

test('remote deliverable: enumerate + transactional bundle to control plane + rmrf on success', async (t) => {
  const files = { 'report.md': Buffer.from('report\n'), 'sub/n.txt': Buffer.from('nested\n'), 'blob.bin': Buffer.from([0, 1, 2, 3, 255, 254]) };
  const ex = mockExecutor(files);
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);

  await h.harvest.reharvestRemoteDeliverable(run); // drives harvestDeliverableRunRemote

  const dst = bundleDir(h, run);
  assert.deepEqual(fs.readFileSync(path.join(dst, 'report.md')).toString(), 'report\n');
  assert.deepEqual([...fs.readFileSync(path.join(dst, 'blob.bin'))], [0, 1, 2, 3, 255, 254], 'binary exact');
  assert.deepEqual(fs.readFileSync(path.join(dst, 'sub/n.txt')).toString(), 'nested\n', 'nested path bundled');
  assert.equal(h.rs.getRun(run.id).deliverable_state, 'bundled');
  assert.equal(ex.calls.rmrf, 1, 'remote workspace reclaimed on success');
  assert.ok(events(h, run.id).includes('harvest:deliverable_bundled'));
  // Gate 1 acceptance recorded as skipped(remote) is only when a check is assigned — none here, so none.
});

test('remote deliverable: a read failure retains captured (NO rmrf, no loss)', async (t) => {
  const files = { 'a.txt': Buffer.from('a'), 'b.txt': Buffer.from('b') };
  const ex = mockExecutor(files, { throwOnRead: (p) => p.endsWith('b.txt') });
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);

  await h.harvest.reharvestRemoteDeliverable(run);

  assert.equal(h.rs.getRun(run.id).deliverable_state, 'captured', 'stays captured on partial failure');
  assert.equal(ex.calls.rmrf, 0, 'remote workspace NOT reclaimed on failure (no artifact loss)');
  assert.ok(events(h, run.id).includes('goal:deliverable_bundle_deferred'));
});

test('remote deliverable: oversize file (size>5MB) is skipped, not read', async (t) => {
  const files = { 'small.txt': Buffer.from('ok'), 'huge.bin': Buffer.from('x') };
  const ex = mockExecutor(files, { sizeOverride: { 'huge.bin': 6 * 1024 * 1024 } });
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);

  await h.harvest.reharvestRemoteDeliverable(run);

  // huge.bin was never read (size-first skip); small.txt bundled; overall bundled.
  assert.ok(!ex.calls.reads.some((r) => r.p.endsWith('huge.bin')), 'oversize file never read');
  assert.equal(h.rs.getRun(run.id).deliverable_state, 'bundled');
  const deliv = JSON.parse(h.ts.getTask(run.task_id).deliverable_json);
  const huge = deliv.files.find((f) => f.path === 'huge.bin');
  assert.equal(huge.skipped, 'too_large');
  assert.ok(deliv.truncated);
});

test('remote deliverable: acceptance for a remote run is skipped(runner_unavailable, provider:remote) → fail-open', async (t) => {
  const files = { 'r.md': Buffer.from('r') };
  const ex = mockExecutor(files);
  const h = await harness(t, { executor: ex });
  const { run, task } = makeRemoteDeliverableRun(h);
  // Assign a human (gate) command check so acceptance resolves — for a remote run
  // it must be recorded skipped, never actually run.
  const check = h.vcs.createCheck({ kind: 'command', project_id: h.ts.getTask(task.id).project_id, name: 'unit', spec_json: { command: 'echo ok' } }, { actor: 'human' });
  h.db.prepare('UPDATE tasks SET verify_check_id = ? WHERE id = ?').run(check.id, task.id);

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  const acc = JSON.parse(h.rs.getRun(run.id).acceptance_json);
  assert.equal(acc.status, 'skipped');
  assert.equal(acc.reason, 'runner_unavailable');
  assert.equal(acc.provider, 'remote');
  assert.equal(acc.passed, null);
});

test('remote deliverable: a file that grew past the cap (read returns cap+1) is bundled truncated, not claimed complete', async (t) => {
  // listed size within budget, but the read returns MORE than requested (grew).
  const big = Buffer.alloc(64, 7);
  const ex = {
    calls: { rmrf: 0 },
    async listFilesWithSizes() { return { files: [{ relPath: 'grew.bin', size: 32 }], truncated: false }; },
    async readFileCapped(p, cap) { return Buffer.alloc(cap, 7); }, // always returns exactly `cap` (= readCap+1 → grew)
    async rmrf() { this.calls.rmrf += 1; },
  };
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);
  await h.harvest.reharvestRemoteDeliverable(run);
  const deliv = JSON.parse(h.ts.getTask(run.task_id).deliverable_json);
  const f = deliv.files.find((x) => x.path === 'grew.bin');
  assert.equal(f.truncated, 'budget', 'growth-past-cap flagged truncated');
  assert.ok(deliv.truncated);
  assert.equal(h.rs.getRun(run.id).deliverable_state, 'bundled');
});

test('remote deliverable: a manifest-persist failure retains captured (no rmrf, no loss)', async (t) => {
  const ex = mockExecutor({ 'a.txt': Buffer.from('a') });
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);
  // Force setDeliverableJson to throw.
  h.ts.setDeliverableJson = () => { throw new Error('db down'); };
  await h.harvest.reharvestRemoteDeliverable(run);
  assert.equal(h.rs.getRun(run.id).deliverable_state, 'captured', 'not bundled when manifest failed to persist');
  assert.equal(ex.calls.rmrf, 0, 'workspace not reclaimed without a durable manifest');
});

// --- G3b §5f Part A: remote deliverable ARTIFACT acceptance on the CLEAN local
// bundle (pure fs eval, no shell). Command checks stay deferred (Part B). ---

function assignArtifactCheck(h, task, spec, actor = 'human') {
  const check = h.vcs.createCheck({ kind: 'artifact', project_id: h.ts.getTask(task.id).project_id, name: 'artifact', spec_json: spec }, { actor });
  h.db.prepare('UPDATE tasks SET verify_check_id = ? WHERE id = ?').run(check.id, task.id);
  return check;
}

test('G3b: remote ARTIFACT check evaluates the clean local bundle → real PASS (not skipped)', async (t) => {
  const files = { 'report.md': Buffer.from('a complete report body\n') };
  const ex = mockExecutor(files);
  const h = await harness(t, { executor: ex });
  const { run, task } = makeRemoteDeliverableRun(h);
  assignArtifactCheck(h, task, { files: [{ glob: 'report.md', min_bytes: 1 }] });

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  const acc = JSON.parse(h.rs.getRun(run.id).acceptance_json);
  assert.equal(acc.status, 'ran', 'artifact check actually ran against the bundle (no local shell needed)');
  assert.equal(acc.passed, true);
  assert.equal(acc.kind, 'artifact');
  assert.equal(acc.gate, true, 'human-authored → gate');
  assert.equal(acc.provider, 'remote');
  assert.equal(h.rs.getRun(run.id).deliverable_state, 'bundled');
  assert.equal(ex.calls.rmrf, 1, 'workspace reclaimed after a durable bundle + acceptance');
});

test('G3b: remote ARTIFACT check on the bundle → real FAIL when a required file is absent', async (t) => {
  const files = { 'report.md': Buffer.from('present\n') };
  const ex = mockExecutor(files);
  const h = await harness(t, { executor: ex });
  const { run, task } = makeRemoteDeliverableRun(h);
  assignArtifactCheck(h, task, { files: [{ glob: 'MISSING.txt' }] });

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  const acc = JSON.parse(h.rs.getRun(run.id).acceptance_json);
  assert.equal(acc.status, 'ran');
  assert.equal(acc.passed, false, 'missing required artifact → fail, never a silent pass');
});

test('G3b: a LOSSY bundle (oversize file skipped) → skipped(incomplete_bundle), never a silent pass', async (t) => {
  const files = { 'report.md': Buffer.from('r'), 'huge.bin': Buffer.from('x') };
  const ex = mockExecutor(files, { sizeOverride: { 'huge.bin': 6 * 1024 * 1024 } });
  const h = await harness(t, { executor: ex });
  const { run, task } = makeRemoteDeliverableRun(h);
  // This check WOULD pass on report.md — but a lossy bundle must NOT be evaluated.
  assignArtifactCheck(h, task, { files: [{ glob: 'report.md' }] });

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  const acc = JSON.parse(h.rs.getRun(run.id).acceptance_json);
  assert.equal(acc.status, 'skipped');
  assert.equal(acc.reason, 'incomplete_bundle', 'a partial copy is not soundly evaluable → fail-open to gate2');
  assert.equal(acc.passed, null);
  assert.equal(acc.provider, 'remote');
  assert.equal(h.rs.getRun(run.id).deliverable_state, 'bundled', 'the (partial) bundle still persisted');
});

test('G3b: a grew-past-cap bundle (truncated file) → skipped(incomplete_bundle)', async (t) => {
  const ex = {
    calls: { rmrf: 0 },
    async listFilesWithSizes() { return { files: [{ relPath: 'grew.bin', size: 32 }], truncated: false }; },
    async readFileCapped(p, cap) { return Buffer.alloc(cap, 7); }, // returns cap (=readCap+1) → truncated:'budget'
    async rmrf() { this.calls.rmrf += 1; },
  };
  const h = await harness(t, { executor: ex });
  const { run, task } = makeRemoteDeliverableRun(h);
  assignArtifactCheck(h, task, { files: [{ glob: 'grew.bin' }] });

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  const acc = JSON.parse(h.rs.getRun(run.id).acceptance_json);
  assert.equal(acc.status, 'skipped');
  assert.equal(acc.reason, 'incomplete_bundle');
});

test('G3b: a COMMAND check on a remote deliverable stays skipped(runner_unavailable) — Part B deferred', async (t) => {
  const ex = mockExecutor({ 'r.md': Buffer.from('r') });
  const h = await harness(t, { executor: ex });
  const { run, task } = makeRemoteDeliverableRun(h);
  const check = h.vcs.createCheck({ kind: 'command', project_id: h.ts.getTask(task.id).project_id, name: 'unit', spec_json: { command: 'echo ok' } }, { actor: 'human' });
  h.db.prepare('UPDATE tasks SET verify_check_id = ? WHERE id = ?').run(check.id, task.id);

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  const acc = JSON.parse(h.rs.getRun(run.id).acceptance_json);
  assert.equal(acc.status, 'skipped');
  assert.equal(acc.reason, 'runner_unavailable', 'no sandboxed remote shell → command stays deferred');
});

test('G3b: concurrent harvest + re-harvest of one run — single-flight admits exactly one', async (t) => {
  let listCalls = 0;
  const ex = {
    calls: { rmrf: 0 },
    async listFilesWithSizes() { listCalls += 1; await Promise.resolve(); return { files: [{ relPath: 'report.md', size: 5 }], truncated: false }; },
    async readFileCapped(p, cap) { return Buffer.from('body\n').subarray(0, cap); },
    async rmrf() { this.calls.rmrf += 1; },
  };
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);

  await Promise.all([
    h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id)),
    h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id)),
  ]);

  assert.equal(listCalls, 1, 'the second concurrent harvest is excluded by the per-run single-flight guard');
  assert.equal(ex.calls.rmrf, 1, 'workspace reclaimed exactly once');
});

test('G3b: a symlinked bundle dest is REFUSED (never rmSync-followed) → captured, no rmrf', async (t) => {
  const ex = mockExecutor({ 'r.md': Buffer.from('r') });
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);
  // Pre-create the per-run dest as a symlink pointing OUTSIDE the artifact root.
  const dst = bundleDir(h, run);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const outside = path.join(h.dir, 'ELSEWHERE');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete me');
  fs.symlinkSync(outside, dst);

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  assert.ok(fs.lstatSync(dst).isSymbolicLink(), 'the symlink was NOT deleted/followed');
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'the symlink target contents survived (no rm outside root)');
  assert.equal(h.rs.getRun(run.id).deliverable_state, 'captured', 'refused dest → retain captured, no loss');
  assert.equal(ex.calls.rmrf, 0, 'remote workspace not reclaimed on a refused dest');
  assert.ok(events(h, run.id).includes('harvest:error'));
});

test('G3b: a symlinked ANCESTOR (goal-artifacts/<taskId>) is refused too — not just the leaf', async (t) => {
  const ex = mockExecutor({ 'r.md': Buffer.from('r') });
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);
  // Make the <taskId> directory a symlink pointing outside the artifact root.
  const taskDir = path.dirname(bundleDir(h, run));
  fs.mkdirSync(path.dirname(taskDir), { recursive: true });
  const outside = path.join(h.dir, 'ELSEWHERE2');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete me');
  fs.symlinkSync(outside, taskDir);

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  assert.ok(fs.lstatSync(taskDir).isSymbolicLink(), 'the symlinked ancestor was NOT followed/cleared');
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'nothing outside the root was rmSync-deleted');
  assert.equal(ex.calls.rmrf, 0, 'no rmrf on a refused ancestor');
  assert.ok(events(h, run.id).includes('harvest:error'));
});

test('G3b: a LOSSY bundle is NOT reclaimed — remote retained so nothing lives only there (no rmrf)', async (t) => {
  const files = { 'small.txt': Buffer.from('ok'), 'huge.bin': Buffer.from('x') };
  const ex = mockExecutor(files, { sizeOverride: { 'huge.bin': 6 * 1024 * 1024 } });
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  assert.equal(h.rs.getRun(run.id).deliverable_state, 'bundled', 'the captured subset is bundled locally');
  assert.equal(ex.calls.rmrf, 0, 'a lossy bundle keeps the remote (oversize file lives only there)');
  assert.ok(events(h, run.id).includes('goal:deliverable_remote_retained'));
});

test('G3b: a COMPLETE bundle whose acceptance FAILS to persist is NOT reclaimed (no rmrf)', async (t) => {
  const ex = mockExecutor({ 'report.md': Buffer.from('body\n') });
  const h = await harness(t, { executor: ex });
  const { run, task } = makeRemoteDeliverableRun(h);
  assignArtifactCheck(h, task, { files: [{ glob: 'report.md' }] });
  // The Gate-1 record write fails → we must NOT delete the remote workspace.
  h.rs.updateGoalAcceptance = () => { throw new Error('db down'); };

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  assert.equal(ex.calls.rmrf, 0, 'no durable acceptance → do not reclaim the remote');
});

test('G3b: if setDeliverableState(bundled) throws, the workspace is NOT reclaimed (no rmrf)', async (t) => {
  const ex = mockExecutor({ 'report.md': Buffer.from('body\n') });
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);
  const realSet = h.rs.setDeliverableState.bind(h.rs);
  h.rs.setDeliverableState = (id, state) => { if (state === 'bundled') throw new Error('db down'); return realSet(id, state); };

  await h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id));

  assert.equal(ex.calls.rmrf, 0, 'a failed bundled-state write must not reclaim the workspace');
  assert.notEqual(h.rs.getRun(run.id).deliverable_state, 'bundled');
});

test('G3b: a non-path-safe run id is FAIL-CLOSED (no collidable dest, no bundle, no rmrf)', async (t) => {
  const ex = mockExecutor({ 'r.md': Buffer.from('r') });
  const h = await harness(t, { executor: ex });
  const { run } = makeRemoteDeliverableRun(h);
  // Simulate an anomalous id whose sanitized segment differs from the raw id.
  const evil = { ...h.rs.getRun(run.id), id: '../evil', task_id: h.rs.getRun(run.id).task_id };
  await h.harvest.reharvestRemoteDeliverable(evil);
  assert.equal(ex.calls.rmrf, 0, 'refused → no remote reclaim');
  // enumerate/list must not have run either (guard returns before any executor use).
  assert.equal(ex.calls.reads.length, 0, 'no bundling attempted on an unsafe id');
});

test('G3b: concurrent primary + re-harvest — BOTH observe the durable acceptance (loser awaits winner)', async (t) => {
  const files = { 'report.md': Buffer.from('a body\n') };
  const ex = mockExecutor(files);
  const h = await harness(t, { executor: ex });
  const { run, task } = makeRemoteDeliverableRun(h);
  assignArtifactCheck(h, task, { files: [{ glob: 'report.md' }] });

  await Promise.all([
    h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id)),
    h.harvest.reharvestRemoteDeliverable(h.rs.getRun(run.id)),
  ]);

  // By the time BOTH resolve, the acceptance is durable (the loser awaited the gate).
  const acc = JSON.parse(h.rs.getRun(run.id).acceptance_json);
  assert.equal(acc.status, 'ran');
  assert.equal(acc.passed, true);
  assert.equal(ex.calls.rmrf, 1, 'reclaimed exactly once');
});
