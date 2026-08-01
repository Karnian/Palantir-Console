const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createAdmissionGate } = require('../services/admissionGate');
const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createApp } = require('../app');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function makeDb(t, prefix = 'palantir-admission-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'test.db');
  const handle = createDatabase(dbPath);
  handle.migrate();
  t.after(async () => {
    try { handle.close(); } catch { /* app-owned handles may already be closed */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { ...handle, dir, dbPath };
}

function seedProfile(db, { maxConcurrent = 5 } = {}) {
  const id = `profile-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (
      id, name, type, command, args_template, capabilities_json,
      env_allowlist, max_concurrent
    ) VALUES (?, 'Admission Agent', 'codex', 'codex', '{prompt}', '{}', '[]', ?)
  `).run(id, maxConcurrent);
  return id;
}

function seedQueuedRun(db, { directory = null } = {}) {
  const projectService = createProjectService(db);
  const taskService = createTaskService(db);
  const runService = createRunService(db, null);
  const project = projectService.createProject({
    name: `Admission ${Math.random().toString(36).slice(2)}`,
    directory,
    allow_non_git_dir: directory ? 1 : 0,
  });
  const task = taskService.createTask({
    project_id: project.id,
    title: 'Admission task',
    status: 'in_progress',
  });
  const profileId = seedProfile(db);
  const run = runService.createRun({
    task_id: task.id,
    agent_profile_id: profileId,
    prompt: 'wait at the admission boundary',
  });
  return { project, task, profileId, run };
}

function lifecycleHarness(db, {
  admissionStartsClosed = false,
  fileExists = async () => true,
} = {}) {
  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const spawned = [];
  const killed = [];
  const nodeExecutor = {
    fileExists,
    async spawnWorker(runId, payload) {
      spawned.push({ runId, payload });
      return { sessionName: `session-${runId}` };
    },
    async kill(runId, engine) {
      killed.push({ runId, engine });
      return true;
    },
  };
  const executionEngine = {
    type: 'subprocess',
    isAlive() { return true; },
    detectExitCode() { return null; },
    kill() { return true; },
    discoverGhostSessions() { return []; },
  };
  const streamJsonEngine = {
    hasProcess() { return false; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    kill() { return true; },
  };
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    projectService,
    agentProfileService,
    executionEngine,
    streamJsonEngine,
    nodeExecutor,
    worktreeService: null,
    eventBus: null,
    admissionStartsClosed,
  });
  return { lifecycleService, runService, spawned, killed };
}

test('admission gate enter is synchronous and close snapshots the registered deferred ticket', async () => {
  const gate = createAdmissionGate({ startsClosed: true });
  assert.equal(gate.enter(), null);
  assert.equal(gate.inFlightCount(), 0);

  gate.open();
  const ticket = gate.enter();
  assert.ok(ticket);
  assert.equal(gate.inFlightCount(), 1, 'ticket is registered before enter returns');

  const snapshot = gate.close();
  assert.equal(snapshot.length, 1);
  let settled = false;
  snapshot[0].then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  ticket.resolve();
  await Promise.allSettled(snapshot);
  assert.equal(settled, true);
  assert.equal(gate.inFlightCount(), 0);
});

test('closed lifecycle admission rejects before claim, leaves queued, and drain terminates', async (t) => {
  const { db } = await makeDb(t);
  const seeded = seedQueuedRun(db);
  const h = lifecycleHarness(db, { admissionStartsClosed: true });

  assert.equal(await h.lifecycleService.spawnQueuedRun(seeded.run.id), null);
  assert.equal(h.runService.getRun(seeded.run.id).status, 'queued');
  assert.equal(h.runService.getHeldLease(seeded.run.id), null);
  assert.equal(h.spawned.length, 0);

  // Bound the loop's per-iteration lookup so a missing admission break is a
  // deterministic failure, not a hang — the drain's inner while does not yield
  // to a timer, so a Promise.race guard alone cannot catch the regression.
  let lookups = 0;
  const bound = (orig) => (...args) => {
    lookups += 1;
    if (lookups > 20) throw new Error('closed drain loop did not terminate');
    return orig(...args);
  };
  for (const name of ['getOldestQueuedReadyOnNode', 'getOldestQueuedOnNode', 'getOldestQueued']) {
    if (typeof h.runService[name] === 'function') {
      h.runService[name] = bound(h.runService[name].bind(h.runService));
    }
  }
  const drained = await h.lifecycleService.drainQueue(seeded.profileId);
  assert.equal(drained, 0);
  assert.ok(lookups <= 3, `a closed gate must stop the drain promptly, saw ${lookups} lookups`);
  assert.equal(h.runService.getRun(seeded.run.id).status, 'queued');
});

test('spawn finally settles its synchronous ticket and a mid-flight close prevents the late spawn', async (t) => {
  const { db } = await makeDb(t);
  const seeded = seedQueuedRun(db, { directory: '/virtual/admission-project' });
  const fileCheck = deferred();
  const h = lifecycleHarness(db, {
    fileExists: () => fileCheck.promise,
  });

  const spawning = h.lifecycleService.spawnQueuedRun(seeded.run.id);
  const snapshot = h.lifecycleService.closeAdmission();
  assert.equal(snapshot.length, 1, 'close sees the spawn ticket in the same turn');
  let ticketSettled = false;
  snapshot[0].then(() => { ticketSettled = true; });
  await Promise.resolve();
  assert.equal(ticketSettled, false);

  fileCheck.resolve(true);
  assert.equal(await spawning, null);
  await Promise.allSettled(snapshot);

  assert.equal(ticketSettled, true, 'spawnQueuedRun finally resolves the ticket');
  assert.equal(h.spawned.length, 0, 'channel spawn is not called after admission closes');
  assert.equal(h.runService.getRun(seeded.run.id).status, 'queued');
  assert.equal(h.runService.getHeldLease(seeded.run.id), null);
});

function shutdownSweepHarness(leases, ownerStates, {
  releaseResult = () => true,
  killResult = () => true,
} = {}) {
  const order = [];
  const leaseState = new Map(leases.map((lease) => [lease.run_id, 'held']));
  const runService = {
    listHeldOwnerLeases() { return leases; },
    releaseOwner(runId, leaseId, options) {
      const outcome = releaseResult(runId);
      if (outcome instanceof Error) {
        order.push(`release_throw:${runId}`);
        throw outcome;
      }
      order.push(`release:${runId}:${options.state}:${options.evidence}:${outcome}`);
      const lease = leases.find((item) => item.run_id === runId);
      assert.equal(lease?.lease_id, leaseId);
      if (outcome) leaseState.set(runId, options.state);
      return outcome;
    },
  };
  const nodeExecutor = {
    spawnWorker() { throw new Error('not used'); },
    engineFor(_runId, durableEngine) {
      return durableEngine === 'stream-json' ? 'stream-json' : 'cli';
    },
    async ownerState(runId) {
      order.push(`probe:${runId}`);
      return ownerStates[runId];
    },
    async kill(runId, engine) {
      order.push(`kill:${runId}:${engine}`);
      return killResult(runId);
    },
  };
  const lifecycleService = createLifecycleService({
    runService,
    taskService: {},
    projectService: {},
    agentProfileService: {},
    executionEngine: { type: 'subprocess' },
    streamJsonEngine: {},
    nodeExecutor,
    nodeService: {
      getNode(nodeId) {
        return nodeId === 'pod-remote'
          ? { id: nodeId, kind: 'ssh' }
          : { id: nodeId || 'local', kind: 'local' };
      },
    },
    eventBus: null,
  });
  return { lifecycleService, order, leaseState };
}

test('shutdown sweep releases dead before kill, holds alive/unknown, skips remote, and routes by lease engine', async () => {
  const leases = [
    {
      run_id: 'dead-cli', lease_id: 'lease-dead', engine: 'tmux', acquired_at: '2026-08-01 00:00:00',
      run_status: 'running', node_id: 'local', tmux_session: 'palantir-run-dead-cli', is_manager: 0,
    },
    {
      run_id: 'alive-stream', lease_id: 'lease-stream', engine: 'stream-json', acquired_at: '2026-08-01 00:00:00',
      run_status: 'running', node_id: 'local', tmux_session: null, is_manager: 0,
    },
    {
      run_id: 'unknown-cli', lease_id: 'lease-unknown', engine: 'subprocess', acquired_at: '2026-08-01 00:00:00',
      run_status: 'paused', node_id: 'local', tmux_session: null, is_manager: 0,
    },
    {
      run_id: 'remote', lease_id: 'lease-remote', engine: 'remote', acquired_at: '2026-08-01 00:00:00',
      run_status: 'running', node_id: 'pod-remote', tmux_session: 'palantir-run-remote', is_manager: 0,
    },
  ];
  const h = shutdownSweepHarness(leases, {
    'dead-cli': 'dead',
    'alive-stream': 'alive',
    'unknown-cli': 'unknown',
  });

  await h.lifecycleService.shutdownWorkerSweep();

  assert.ok(
    h.order.indexOf('release:dead-cli:released:probe:dead')
      < h.order.indexOf('kill:dead-cli:cli'),
    'dead sentinel lease is released before the evidence-destroying kill',
  );
  assert.ok(h.order.includes('kill:alive-stream:stream-json'));
  assert.ok(h.order.includes('kill:unknown-cli:cli'));
  assert.equal(h.order.some((entry) => entry.includes('remote')), false);
  assert.equal(h.leaseState.get('dead-cli'), 'released');
  assert.equal(h.leaseState.get('alive-stream'), 'held');
  assert.equal(h.leaseState.get('unknown-cli'), 'held');
  assert.equal(h.leaseState.get('remote'), 'held');
});

async function seedBootDb(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'test.db');
  const handle = createDatabase(dbPath);
  handle.migrate();
  const row = seedQueuedRun(handle.db);
  handle.close();
  return { dir, dbPath, row };
}

async function makeAppRoots(prefix) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-storage-`));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-fs-`));
  return { storageRoot, fsRoot };
}

test('app boot keeps admission closed and starts drain only after recovery completes', async (t) => {
  const seeded = await seedBootDb('palantir-boot-admission-');
  const roots = await makeAppRoots('palantir-boot-admission');
  const recovery = deferred();
  const spawned = [];
  const executionEngine = {
    type: 'tmux',
    discoverGhostSessions() { return []; },
    reapStartupArtifacts() { return recovery.promise; },
    spawnAgent(runId) {
      spawned.push(runId);
      return { sessionName: `palantir-run-${runId}` };
    },
    listSessions() { return spawned.map((runId) => ({ runId, name: `palantir-run-${runId}` })); },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() { return true; },
  };
  const app = createApp({
    dbPath: seeded.dbPath,
    ...roots,
    executionEngine,
    authToken: null,
    forceBootDrain: true,
  });
  t.after(async () => {
    await app.shutdown();
    await fs.rm(roots.storageRoot, { recursive: true, force: true });
    await fs.rm(roots.fsRoot, { recursive: true, force: true });
    await fs.rm(seeded.dir, { recursive: true, force: true });
  });

  assert.equal(app.services.lifecycleService.admissionClosed(), true);
  assert.deepEqual(spawned, []);
  assert.equal(app.services.runService.getRun(seeded.row.run.id).status, 'queued');

  recovery.resolve({ action: 'preserved' });
  for (let i = 0; i < 10 && spawned.length === 0; i += 1) await immediate();

  assert.equal(app.services.lifecycleService.admissionClosed(), false);
  assert.deepEqual(spawned, [seeded.row.run.id]);
});

test('app boot opens admission but skips drain when recovery fails', async (t) => {
  const seeded = await seedBootDb('palantir-boot-recovery-fail-');
  const roots = await makeAppRoots('palantir-boot-recovery-fail');
  const spawned = [];
  const executionEngine = {
    get type() { throw new Error('forced recovery failure'); },
    spawnAgent(runId) {
      spawned.push(runId);
      return { sessionName: `session-${runId}` };
    },
    kill() { return true; },
  };
  const app = createApp({
    dbPath: seeded.dbPath,
    ...roots,
    executionEngine,
    authToken: null,
    forceBootDrain: true,
  });
  t.after(async () => {
    await app.shutdown();
    await fs.rm(roots.storageRoot, { recursive: true, force: true });
    await fs.rm(roots.fsRoot, { recursive: true, force: true });
    await fs.rm(seeded.dir, { recursive: true, force: true });
  });

  await immediate();
  await immediate();

  assert.equal(app.services.lifecycleService.admissionClosed(), false);
  assert.deepEqual(spawned, []);
  assert.equal(app.services.runService.getRun(seeded.row.run.id).status, 'queued');
});

test('a close that lands after claim aborts the spawn and terminates the drain loop', async (t) => {
  // The pre-claim reject is the fast path; this pins the SLOWER one — the run is
  // already claimed when admission closes, so the re-check right before the
  // channel spawn must abort AND drainQueue must not loop the same run forever.
  const { db } = await makeDb(t);
  const seeded = seedQueuedRun(db, { directory: '/virtual/admission-late' });
  // Seed a second queued run to prove the loop stops rather than moving on.
  seedQueuedRun(db, { directory: '/virtual/admission-late' });

  const h = lifecycleHarness(db);
  let closedMidFlight = false;
  const realSpawn = h.spawned;
  // Wrap the executor spawn so we can close the gate AFTER the claim but the
  // lifecycle re-check happens BEFORE the actual channel spawn — so this hook
  // should never fire for the aborted run.
  const observed = [];
  const origSpawnWorker = h.lifecycleService; // marker
  // Close admission the moment the first claim happens: patch claimQueuedRun.
  const rs = h.runService;
  const baseClaim = rs.claimQueuedRun.bind(rs);
  rs.claimQueuedRun = (id, opts) => {
    const out = baseClaim(id, opts);
    if (out && !closedMidFlight) {
      closedMidFlight = true;
      h.lifecycleService.closeAdmission();
    }
    return out;
  };

  // A missing admission break re-selects the restored-to-queued run every
  // iteration forever. Once admission closes, spawnQueuedRun rejects at enter()
  // (before claim), so the loop's only observable per-iteration call is the
  // oldest-queued lookup — bound THAT so the regression is a deterministic
  // failure, not a hang (an await-yielding busy loop still never terminates).
  let lookups = 0;
  const boundLookup = (orig) => (...args) => {
    lookups += 1;
    if (lookups > 20) throw new Error('drain loop did not terminate after admission closed');
    return orig(...args);
  };
  // Wrap EVERY oldest-queued variant — the loop picks one by repo-feature +
  // capability, so binding only the plain one misses the repo-ready path.
  for (const name of ['getOldestQueuedReadyOnNode', 'getOldestQueuedOnNode', 'getOldestQueued']) {
    if (typeof rs[name] === 'function') rs[name] = boundLookup(rs[name].bind(rs));
  }

  const started = await h.lifecycleService.drainQueue(seeded.profileId);

  assert.equal(started, 0, 'the aborted spawn did not count as started');
  assert.equal(h.spawned.length, 0, 'the channel spawn was aborted before it ran');
  assert.ok(lookups <= 3, `drain must stop promptly once admission closes, saw ${lookups} lookups`);
  // The claimed run was restored to queued by the ADMISSION_CLOSED handler.
  assert.equal(rs.getRun(seeded.run.id).status, 'queued');
});

test('shutdown sweep skips the evidence-destroying kill when the dead release loses its CAS', async () => {
  // codex S2a R2: a reclaim can supersede the probed generation, so the dead
  // release loses the CAS. Killing anyway destroys the tmux sentinel while the
  // lease stays held → stuck unknown next boot. Only release success authorises
  // the kill.
  const leases = [{
    run_id: 'dead-stale', lease_id: 'lease-stale', engine: 'tmux',
    acquired_at: '2026-08-01 00:00:00', run_status: 'running',
    node_id: 'local', tmux_session: 'palantir-run-dead-stale', is_manager: 0,
  }];
  const h = shutdownSweepHarness(leases, { 'dead-stale': 'dead' }, {
    releaseResult: () => false, // the CAS lost
  });
  const results = await h.lifecycleService.shutdownWorkerSweep();
  const settled = results.map((r) => r.value ?? r.reason);
  assert.equal(settled[0].status, 'release_lost');
  assert.ok(!h.order.some((e) => e.startsWith('kill:')), 'no kill after a lost release');
});

test('shutdown sweep skips the kill when the dead release throws', async () => {
  const leases = [{
    run_id: 'dead-throw', lease_id: 'lease-throw', engine: 'tmux',
    acquired_at: '2026-08-01 00:00:00', run_status: 'running',
    node_id: 'local', tmux_session: 'palantir-run-dead-throw', is_manager: 0,
  }];
  const h = shutdownSweepHarness(leases, { 'dead-throw': 'dead' }, {
    releaseResult: () => new Error('db gone'),
  });
  const results = await h.lifecycleService.shutdownWorkerSweep();
  const settled = results.map((r) => r.value ?? r.reason);
  assert.equal(settled[0].status, 'release_lost');
  assert.ok(!h.order.some((e) => e.startsWith('kill:')), 'a thrown release must not authorise the kill');
});

test('shutdown sweep records a kill primitive that returns false as a failure', async () => {
  // codex S2a R3: subprocess/tmux/stream-json kill all can return false; the
  // sweep must not report kill_sent for a real orphan.
  const leases = [{
    run_id: 'alive-fail', lease_id: 'lease-fail', engine: 'stream-json',
    acquired_at: '2026-08-01 00:00:00', run_status: 'running',
    node_id: 'local', tmux_session: null, is_manager: 0,
  }];
  const h = shutdownSweepHarness(leases, { 'alive-fail': 'alive' }, {
    killResult: () => false,
  });
  const results = await h.lifecycleService.shutdownWorkerSweep();
  const settled = results.map((r) => r.value ?? r.reason);
  assert.equal(settled[0].status, 'kill_failed');
  assert.equal(settled[0].engine, 'stream-json');
});
