const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createEventBus } = require('../services/eventBus');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createLocalWorkerChannel } = require('../services/nodeExecutor');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-owner-state-'));
  const database = createDatabase(path.join(dir, 'test.db'));
  database.migrate();
  t.after(async () => {
    try { database.close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return database.db;
}

function makeEngine({ type = 'tmux', alive = true, exitCode = null, onKill } = {}) {
  const spawned = new Set();
  const killed = [];
  let aliveState = alive;
  let exitCodeState = exitCode;
  return {
    type,
    killed,
    spawnAgent(runId) {
      spawned.add(runId);
      return { sessionName: type === 'tmux' ? `palantir-run-${runId}` : `subprocess-${runId}` };
    },
    hasProcess(runId) { return type === 'subprocess' && spawned.has(runId); },
    listSessions() {
      return [...spawned].map((runId) => ({
        runId,
        name: type === 'tmux' ? `palantir-run-${runId}` : `subprocess-${runId}`,
      }));
    },
    isAlive() { return aliveState; },
    detectExitCode() { return exitCodeState; },
    setAlive(value) { aliveState = value; },
    setExitCode(value) { exitCodeState = value; },
    getOutput() { return ''; },
    sendInput() { return false; },
    kill(runId) {
      killed.push(runId);
      if (onKill) onKill(runId);
      spawned.delete(runId);
      return true;
    },
    discoverGhostSessions() { return []; },
  };
}

function createHarness(db, executionEngine, eventBus = createEventBus()) {
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const project = projectService.createProject({ name: `Owner state ${Math.random()}` });
  const task = taskService.createTask({ project_id: project.id, title: 'Probe owner' });
  const profileId = `owner-state-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (
      id, name, type, command, args_template, capabilities_json,
      env_allowlist, max_concurrent
    ) VALUES (?, 'Owner State', 'codex', 'codex', '', '{}', '[]', 5)
  `).run(profileId);
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    projectService,
    agentProfileService,
    executionEngine,
    streamJsonEngine: null,
    worktreeService: null,
    eventBus,
  });
  return { runService, lifecycleService, task, profileId };
}

async function spawnWorker(h) {
  const run = h.runService.createRun({
    task_id: h.task.id,
    agent_profile_id: h.profileId,
    prompt: 'probe me',
    queued_args: {},
  });
  return h.lifecycleService.spawnQueuedRun(run.id);
}

test('engineFor routes an attached engine without claiming that a missing handle is alive', async () => {
  const channel = createLocalWorkerChannel({
    executionEngine: {
      type: 'subprocess',
      hasProcess() { return false; },
      isAlive() { return false; },
      detectExitCode() { return null; },
      listSessions() { return []; },
    },
  });

  assert.equal(channel.engineFor('restarted-run', 'subprocess'), 'cli');
  assert.equal(await channel.ownerState('restarted-run', 'subprocess'), 'unknown');
});

test('dead evidence still falls through to terminalization after ownership routing is split', async (t) => {
  const db = await mkdb(t);
  const engine = makeEngine({ type: 'tmux', alive: true });
  const h = createHarness(db, engine);
  const run = await spawnWorker(h);
  engine.setAlive(false);
  engine.setExitCode(0);

  await h.lifecycleService.checkHealth();

  assert.equal(h.runService.getRun(run.id).status, 'completed');
});

test('unknown owner evidence holds status, lease, and cleanup and annotates once per lease', async (t) => {
  const db = await mkdb(t);
  const engine = makeEngine({ type: 'subprocess', alive: false, exitCode: null });
  const h = createHarness(db, engine);
  const run = await spawnWorker(h);
  // Simulate a controller restart: the subprocess handle is not durable.
  engine.kill(run.id);
  engine.killed.length = 0;

  await h.lifecycleService.checkHealth();
  await h.lifecycleService.checkHealth();

  assert.equal(h.runService.getRun(run.id).status, 'running');
  assert.equal(h.runService.getHeldLease(run.id).state, 'held');
  assert.deepEqual(engine.killed, []);
  assert.equal(
    h.runService.getRunEvents(run.id)
      .filter((event) => event.event_type === 'worker:lease_probe_unknown').length,
    1,
  );
});

test('held-lease sweep releases a draining tmux lease from its durable exit sentinel', async (t) => {
  const db = await mkdb(t);
  const engine = makeEngine({ type: 'tmux', alive: true });
  const h = createHarness(db, engine);
  const run = await spawnWorker(h);
  h.runService.updateRunStatus(run.id, 'completed', { force: true });
  engine.setAlive(false);
  engine.setExitCode(0);

  await h.lifecycleService.checkHealth();

  const lease = db.prepare('SELECT * FROM run_owner_leases WHERE run_id = ?').get(run.id);
  assert.equal(h.runService.getRun(run.id).status, 'completed', 'the lease sweep never writes run status');
  assert.equal(lease.state, 'released');
  assert.equal(lease.evidence, 'probe:dead');
});

test('terminal health handling releases the lease before tmux cleanup destroys dead evidence', async (t) => {
  const db = await mkdb(t);
  let leaseStateAtKill = null;
  const engine = makeEngine({
    type: 'tmux',
    alive: true,
    onKill(runId) {
      leaseStateAtKill = db.prepare(
        'SELECT state FROM run_owner_leases WHERE run_id = ?',
      ).get(runId)?.state;
      engine.setExitCode(null);
    },
  });
  const h = createHarness(db, engine);
  const run = await spawnWorker(h);
  engine.setAlive(false);
  engine.setExitCode(0);

  await h.lifecycleService.checkHealth();

  assert.equal(leaseStateAtKill, 'released');
  assert.equal(h.runService.getHeldLease(run.id), null);
});

test('reserved alive leases are acquired late exactly once without changing run status', async (t) => {
  const db = await mkdb(t);
  const engine = makeEngine({ type: 'tmux', alive: true });
  const h = createHarness(db, engine);
  const run = h.runService.createRun({
    task_id: h.task.id,
    agent_profile_id: h.profileId,
    prompt: 'reserved',
  });
  const claim = h.runService.claimQueuedRun(run.id, { withLease: true });
  h.runService.recordOwnerEngine(run.id, claim.leaseId, 'tmux');

  await h.lifecycleService.checkHealth();
  await h.lifecycleService.checkHealth();

  assert.ok(h.runService.getHeldLease(run.id).acquired_at);
  assert.equal(h.runService.getRun(run.id).status, 'running');
  assert.equal(
    h.runService.getRunEvents(run.id)
      .filter((event) => event.event_type === 'worker:lease_acquired_late').length,
    1,
  );
});

// --- codex S1b adversarial round 1 -----------------------------------------

test('a finished worker inside a surviving tmux shell is dead, not alive', async (t) => {
  // codex R1 #1: session existence was checked before the exit sentinel, so a
  // worker that wrote its exit code and terminated — while the surrounding
  // tmux shell lived on — read as `alive` forever: running status, held lease,
  // no terminalization.
  const db = await mkdb(t);
  const engine = makeEngine({ type: 'tmux', alive: true, exitCode: null });
  const h = createHarness(db, engine);
  const run = await spawnWorker(h);

  // Worker finishes and records its exit; the tmux shell is still present.
  engine.setExitCode(0);

  await h.lifecycleService.checkHealth();

  assert.equal(h.runService.getRun(run.id).status, 'completed', 'the recorded exit code wins over the shell');
  const lease = db.prepare('SELECT state FROM run_owner_leases WHERE run_id = ?').get(run.id);
  assert.equal(lease.state, 'released');
});

test('a stream-json lease with an expired unknown grace still terminalizes', async (t) => {
  // codex R1 #2: the stream-json branch handled dead only and continued on
  // expired unknown — after a restart wipes the process map nothing else would
  // ever terminalize the run.
  const db = await mkdb(t);
  const engine = makeEngine({ type: 'subprocess', alive: false, exitCode: null });
  const h = createHarness(db, engine);
  const run = await spawnWorker(h);
  // Simulate the restart: durable identity says stream-json, no handle exists.
  db.prepare("UPDATE run_owner_leases SET engine = 'stream-json' WHERE run_id = ?").run(run.id);
  engine.hasProcess = () => false;
  const lease = db.prepare('SELECT lease_id FROM run_owner_leases WHERE run_id = ?').get(run.id);
  // Expired anchor: backdate the first unknown annotation past the TTL.
  h.runService.annotateOwnerProbeUnknown(run.id, lease.lease_id);
  db.prepare(`
    UPDATE run_events SET created_at = datetime('now', '-11 minutes')
    WHERE run_id = ? AND event_type = 'worker:lease_probe_unknown'
  `).run(run.id);

  await h.lifecycleService.checkHealth();

  assert.equal(h.runService.getRun(run.id).status, 'failed', 'expired unknown must terminalize stream-json too');
  assert.equal(
    db.prepare('SELECT state FROM run_owner_leases WHERE run_id = ?').get(run.id).state,
    'held',
    'no dead evidence — the lease stays held',
  );
});

test('an alive recovery resets the unknown grace anchor', async (t) => {
  // codex R1 #3: the anchor kept the FIRST unknown forever, so a transient
  // outage long ago stripped every later unknown of its grace.
  const db = await mkdb(t);
  const runService = createRunService(db, createEventBus());
  db.prepare(`
    INSERT INTO runs (id, status, is_manager, prompt) VALUES ('anchor-run', 'queued', 0, 'p')
  `).run();
  const claim = runService.claimQueuedRun('anchor-run', { withLease: true });

  // First unknown, long ago.
  runService.annotateOwnerProbeUnknown('anchor-run', claim.leaseId);
  db.prepare(`
    UPDATE run_events SET created_at = datetime('now', '-2 hours')
    WHERE run_id = 'anchor-run' AND event_type = 'worker:lease_probe_unknown'
  `).run();
  // Recovery: alive marker resets the window.
  assert.equal(runService.annotateOwnerProbeAlive('anchor-run', claim.leaseId), true);
  // A healthy lease is not spammed with markers on every poll.
  assert.equal(runService.annotateOwnerProbeAlive('anchor-run', claim.leaseId), false);

  // New transient unknown: the anchor must be NOW, not two hours ago.
  assert.equal(runService.ownerProbeUnknownSince('anchor-run', claim.leaseId), null);
  runService.annotateOwnerProbeUnknown('anchor-run', claim.leaseId);
  const since = runService.ownerProbeUnknownSince('anchor-run', claim.leaseId);
  assert.ok(since, 'a fresh unknown after recovery re-anchors');
  const ageMs = Date.now() - Date.parse(`${since.replace(' ', 'T')}Z`);
  assert.ok(ageMs < 60_000, `the anchor must be fresh, got ${Math.round(ageMs / 1000)}s old`);
});

test('cancel settles the lease before the kill destroys the evidence', async (t) => {
  // codex R1 #5: cancelRun killed first (tmux kill removes the exit sentinel)
  // and never settled the lease — cancelled/held forever, blocking requeue and
  // (flag on) a capacity slot.
  const db = await mkdb(t);
  const order = [];
  const engine = makeEngine({ type: 'tmux', alive: true, exitCode: null, onKill: () => order.push('kill') });
  const h = createHarness(db, engine);
  const run = await spawnWorker(h);

  await h.lifecycleService.cancelRun(run.id);

  const lease = db.prepare('SELECT state, evidence FROM run_owner_leases WHERE run_id = ?').get(run.id);
  assert.equal(lease.state, 'abandoned', 'an unverifiable kill is abandonment, not release');
  assert.equal(lease.evidence, 'cancel_kill');
  assert.deepEqual(order, ['kill'], 'the kill still happens, after the settle');
  assert.equal(h.runService.getRun(run.id).status, 'cancelled');
});

