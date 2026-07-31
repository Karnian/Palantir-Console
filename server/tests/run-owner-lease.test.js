const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createDatabase } = require('../db/database');
const { createEventBus } = require('../services/eventBus');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createSubprocessEngine } = require('../services/executionEngine');

async function mkdb(t, prefix = 'palantir-owner-lease-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'test.db');
  const database = createDatabase(dbPath);
  database.migrate();
  t.after(async () => {
    try { database.close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return database.db;
}

function insertBareRun(db, id, status = 'queued', isManager = 0) {
  db.prepare(`
    INSERT INTO runs (id, status, is_manager, prompt)
    VALUES (?, ?, ?, 'lease test')
  `).run(id, status, isManager);
}

function ownerEvents(db, runId) {
  return db.prepare(`
    SELECT * FROM run_events
    WHERE run_id = ? AND event_type LIKE 'worker:owner_%'
    ORDER BY id
  `).all(runId);
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      try {
        if (predicate()) return resolve();
        if (Date.now() >= deadline) {
          assert.ok(predicate(), 'condition was not met before timeout');
          return resolve();
        }
      } catch (error) {
        return reject(error);
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function seedLifecycle(db, executionEngine) {
  const eventBus = createEventBus();
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const project = projectService.createProject({ name: `Lease-${Math.random()}` });
  const task = taskService.createTask({
    project_id: project.id,
    title: 'Lease worker',
    description: 'exercise claim to spawn',
  });
  const profileId = `lease-profile-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (
      id, name, type, command, args_template, capabilities_json,
      env_allowlist, max_concurrent
    ) VALUES (?, 'Lease Agent', 'codex', ?, ?, '{}', '[]', 5)
  `).run(profileId, process.execPath, '-e "setTimeout(() => process.exit(0), 25)"');
  const streamJsonEngine = {
    spawnAgent() { throw new Error('stream-json should not be selected'); },
    hasProcess() { return false; },
    isAlive() { return false; },
    detectExitCode() { return null; },
    sendInput() { return false; },
    kill() { return false; },
  };
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    projectService,
    agentProfileService,
    executionEngine,
    streamJsonEngine,
    worktreeService: null,
    eventBus,
  });
  return {
    eventBus,
    runService,
    taskService,
    lifecycleService,
    task,
    profileId,
  };
}

function createQueuedWorker(h, queuedArgs = {}) {
  return h.runService.createRun({
    task_id: h.task.id,
    agent_profile_id: h.profileId,
    prompt: 'lease worker prompt',
    queued_args: queuedArgs,
  });
}

test('claim creates one reserved lease atomically and markRunStarted acquires it once', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, createEventBus());

  insertBareRun(db, 'claim-winner');
  const claim = runService.claimQueuedRun('claim-winner', { withLease: true });
  assert.equal(claim.claimed, true);
  assert.match(claim.leaseId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(runService.getHeldLease('claim-winner'), {
    run_id: 'claim-winner',
    lease_id: claim.leaseId,
    state: 'held',
    acquired_at: null,
    terminal_observed_at: null,
    closed_at: null,
    created_at: runService.getHeldLease('claim-winner').created_at,
  });

  assert.equal(runService.claimQueuedRun('claim-winner', { withLease: true }), null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM run_owner_leases WHERE run_id = ?').get('claim-winner').count,
    1,
  );
  assert.throws(() => {
    db.prepare(`
      INSERT INTO run_owner_leases (run_id, lease_id, state)
      VALUES ('claim-winner', 'duplicate-held', 'held')
    `).run();
  }, /UNIQUE constraint failed/);

  insertBareRun(db, 'claim-loser', 'running');
  assert.equal(runService.claimQueuedRun('claim-loser', { withLease: true }), null);
  assert.equal(runService.getHeldLease('claim-loser'), null);

  insertBareRun(db, 'claim-rollback');
  db.prepare(`
    INSERT INTO run_owner_leases (run_id, lease_id, state)
    VALUES ('claim-rollback', 'preexisting', 'held')
  `).run();
  assert.throws(
    () => runService.claimQueuedRun('claim-rollback', { withLease: true }),
    /UNIQUE constraint failed/,
  );
  assert.equal(runService.getRun('claim-rollback').status, 'queued', 'lease conflict rolls back claim CAS');

  runService.markRunStarted('claim-winner', claim.leaseId, {});
  const acquired = runService.getHeldLease('claim-winner');
  assert.ok(acquired.acquired_at);
  db.prepare(`
    UPDATE run_owner_leases SET acquired_at = '2000-01-01 00:00:00'
    WHERE run_id = 'claim-winner'
  `).run();
  runService.markRunStarted('claim-winner', claim.leaseId, {});
  assert.equal(
    runService.getHeldLease('claim-winner').acquired_at,
    '2000-01-01 00:00:00',
    'acquired_at CAS is a no-op after the first stamp',
  );
});

test('releaseOwner winner commits lease and durable event before one bus emit; losers are silent', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const runService = createRunService(db, eventBus);
  insertBareRun(db, 'release-run');
  const { leaseId } = runService.claimQueuedRun('release-run', { withLease: true });

  const observations = [];
  const unsubscribe = eventBus.subscribe((event) => {
    if (event.channel !== 'run:event' || event.data.eventType !== 'worker:owner_released') return;
    observations.push({
      event,
      lease: db.prepare('SELECT * FROM run_owner_leases WHERE run_id = ?').get('release-run'),
      durable: db.prepare('SELECT * FROM run_events WHERE id = ?').get(event.data.eventId),
    });
  });
  t.after(unsubscribe);

  assert.equal(runService.releaseOwner('release-run', 'wrong-lease', {
    state: 'released', evidence: 'process_exit',
  }), false);
  assert.equal(ownerEvents(db, 'release-run').length, 0);
  assert.equal(observations.length, 0);

  assert.equal(runService.releaseOwner('release-run', leaseId, {
    state: 'released', evidence: 'process_exit',
  }), true);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].lease.state, 'released');
  assert.ok(observations[0].lease.closed_at);
  assert.equal(observations[0].durable.event_type, 'worker:owner_released');
  assert.deepEqual(JSON.parse(observations[0].durable.payload_json), {
    lease_id: leaseId,
    evidence: 'process_exit',
  });

  assert.equal(runService.releaseOwner('release-run', leaseId, {
    state: 'released', evidence: 'process_exit',
  }), false);
  assert.equal(ownerEvents(db, 'release-run').length, 1);
  assert.equal(observations.length, 1);
});

test('claim-to-spawn failures release reserved leases on distinct early-return and throw paths', async (t) => {
  const db = await mkdb(t);
  const throwingEngine = {
    type: 'subprocess',
    spawnAgent() { throw new Error('engine spawn exploded'); },
    isAlive() { return false; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return false; },
    kill() { return false; },
    discoverGhostSessions() { return []; },
  };
  const h = seedLifecycle(db, throwingEngine);

  const invalidArgs = createQueuedWorker(h, '{not-json');
  assert.equal(await h.lifecycleService.spawnQueuedRun(invalidArgs.id), null);
  const invalidLease = db.prepare('SELECT * FROM run_owner_leases WHERE run_id = ?').get(invalidArgs.id);
  assert.equal(invalidLease.state, 'released');
  assert.deepEqual(JSON.parse(ownerEvents(db, invalidArgs.id)[0].payload_json), {
    lease_id: invalidLease.lease_id,
    evidence: 'spawn_failed',
  });

  const spawnThrow = createQueuedWorker(h, {});
  await assert.rejects(
    h.lifecycleService.spawnQueuedRun(spawnThrow.id),
    /engine spawn exploded/,
  );
  const thrownLease = db.prepare('SELECT * FROM run_owner_leases WHERE run_id = ?').get(spawnThrow.id);
  assert.equal(thrownLease.state, 'released');
  assert.deepEqual(JSON.parse(ownerEvents(db, spawnThrow.id)[0].payload_json), {
    lease_id: thrownLease.lease_id,
    evidence: 'spawn_failed',
  });
});

test('local subprocess exit releases its acquired lease exactly once', async (t) => {
  const db = await mkdb(t);
  const executionEngine = createSubprocessEngine();
  const h = seedLifecycle(db, executionEngine);
  const run = createQueuedWorker(h, {});

  const started = await h.lifecycleService.spawnQueuedRun(run.id);
  assert.equal(started.status, 'running');
  await waitFor(() => {
    const lease = db.prepare('SELECT state FROM run_owner_leases WHERE run_id = ?').get(run.id);
    return lease?.state === 'released';
  });

  const lease = db.prepare('SELECT * FROM run_owner_leases WHERE run_id = ?').get(run.id);
  assert.equal(lease.state, 'released');
  const events = ownerEvents(db, run.id);
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0].payload_json), {
    lease_id: lease.lease_id,
    evidence: 'process_exit',
  });
});

test('tmux spawn receives no deterministic exit callback and keeps its lease held', async (t) => {
  const db = await mkdb(t);
  const spawned = [];
  const tmuxEngine = {
    type: 'tmux',
    spawnAgent(runId, spec) {
      spawned.push({ runId, spec });
      return { sessionName: `palantir-run-${runId}` };
    },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() { return true; },
    discoverGhostSessions() { return []; },
    listSessions() { return []; },
  };
  const h = seedLifecycle(db, tmuxEngine);
  const run = createQueuedWorker(h, {});

  await h.lifecycleService.spawnQueuedRun(run.id);
  assert.equal(spawned.length, 1);
  assert.equal(Object.hasOwn(spawned[0].spec, 'onExit'), false);
  const lease = h.runService.getHeldLease(run.id);
  assert.equal(lease.state, 'held');
  assert.ok(lease.acquired_at);
  assert.equal(ownerEvents(db, run.id).length, 0);
});

test('deleteRun abandons a held lease with run_deleted evidence before deleting the run', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const runService = createRunService(db, eventBus);
  insertBareRun(db, 'delete-run');
  const { leaseId } = runService.claimQueuedRun('delete-run', { withLease: true });
  let observedBeforeDelete = false;
  const unsubscribe = eventBus.subscribe((event) => {
    if (event.channel !== 'run:event' || event.data.eventType !== 'worker:owner_abandoned') return;
    observedBeforeDelete = runService.getRun('delete-run').id === 'delete-run';
  });
  t.after(unsubscribe);

  runService.deleteRun('delete-run');
  assert.equal(observedBeforeDelete, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runs WHERE id = ?').get('delete-run').count, 0);
  const lease = db.prepare('SELECT * FROM run_owner_leases WHERE run_id = ?').get('delete-run');
  assert.equal(lease.lease_id, leaseId);
  assert.equal(lease.state, 'abandoned');
  assert.ok(lease.closed_at);
});

test('migration backfills only active workers as reserved leases', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        is_manager INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        started_at TEXT
      );
    `);
    const insert = db.prepare('INSERT INTO runs (id, is_manager, status, started_at) VALUES (?, ?, ?, ?)');
    for (const status of ['running', 'paused', 'needs_input']) {
      insert.run(`worker-${status}`, 0, status, '2026-01-01 00:00:00');
    }
    insert.run('manager-running', 1, 'running', '2026-01-01 00:00:00');
    for (const status of ['queued', 'completed', 'failed', 'cancelled', 'stopped']) {
      insert.run(`worker-${status}`, 0, status, '2026-01-01 00:00:00');
    }

    const migration = await fs.readFile(
      path.join(__dirname, '..', 'db', 'migrations', '084_run_owner_leases.sql'),
      'utf8',
    );
    db.exec(migration);

    const leases = db.prepare('SELECT * FROM run_owner_leases ORDER BY run_id').all();
    assert.deepEqual(leases.map((row) => row.run_id), [
      'worker-needs_input',
      'worker-paused',
      'worker-running',
    ]);
    for (const lease of leases) {
      assert.equal(lease.state, 'held');
      assert.equal(lease.acquired_at, null, 'started_at is not spawn evidence');
      assert.match(lease.lease_id, /^[0-9a-f-]{36}$/i);
    }
    assert.deepEqual(
      db.prepare('PRAGMA index_list(run_owner_leases)').all()
        .map((row) => row.name)
        .sort(),
      ['idx_run_owner_leases_state', 'ux_run_owner_leases_held_run'],
    );
  } finally {
    db.close();
  }
});
