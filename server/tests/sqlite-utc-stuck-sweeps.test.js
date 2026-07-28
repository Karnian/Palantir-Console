'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createLifecycleService } = require('../services/lifecycleService');

const QUEUE_STUCK_MS = 15 * 60 * 1000;
const MATERIALIZE_STUCK_MS = 10 * 60 * 1000;

// The bug is a timezone bug, so the tests must not inherit the host's timezone.
// Under TZ=UTC a mis-parsed stamp and a correctly-parsed one are the SAME
// instant, so every assertion here would pass just as well against the broken
// code — on a UTC-default CI box these tests would silently protect nothing.
// Both signs are covered because they fail in opposite directions: east of
// Greenwich a fresh row reads as already old (sweeps fire immediately), west of
// it an old row reads as still fresh (sweeps never fire).
const TIMEZONES = ['Asia/Seoul', 'UTC', 'America/Los_Angeles'];

// process.env.TZ is re-read per Date operation, so setting it mid-process is
// enough; restore it so an ambient-TZ assumption elsewhere is not disturbed.
function withTimezone(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

async function createHarness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-utc-stuck-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  t.after(async () => {
    handle.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const { db } = handle;
  db.prepare(`
    INSERT INTO nodes (id, name, kind, can_execute, can_control, reachable)
    VALUES ('node-unreachable', 'Unreachable', 'local', 1, 0, 0)
  `).run();
  db.prepare("INSERT INTO projects (id, name) VALUES ('project-utc', 'UTC parsing')").run();
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, status)
    VALUES ('task-utc', 'project-utc', 'Check UTC parsing', 'in_progress')
  `).run();
  db.prepare(`
    INSERT INTO agent_profiles (
      id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent
    ) VALUES (
      'profile-utc', 'UTC profile', 'codex', 'codex', '{prompt}', '{}', '[]', 1
    )
  `).run();

  const runService = createRunService(db, null);
  const lifecycle = createLifecycleService({
    runService,
    taskService: {},
    agentProfileService: {},
    projectService: {},
    executionEngine: {},
    streamJsonEngine: {},
    authResolver: {},
    nodeService: {
      getNode(id) {
        if (id !== 'node-unreachable') throw new Error(`unexpected node: ${id}`);
        return {
          id,
          kind: 'local',
          reachable: 0,
          cordoned: 0,
          can_execute: 1,
          files_only: 0,
        };
      },
    },
    nodeExecutor: {
      async fileExists() { return false; },
      async spawnWorker() { return { sessionName: 'unused' }; },
    },
    projectMaterializationService: {
      cleanupAttemptResources() {},
    },
    queueStuckMs: QUEUE_STUCK_MS,
    materializeStuckMs: MATERIALIZE_STUCK_MS,
    now: Date.now,
  });

  function createRun(prompt) {
    return runService.createRun({
      task_id: 'task-utc',
      agent_profile_id: 'profile-utc',
      node_id: 'node-unreachable',
      prompt,
    });
  }

  return { db, runService, lifecycle, createRun };
}

for (const tz of TIMEZONES) {
  test(`[TZ=${tz}] queued sweep treats fresh and stale SQLite UTC timestamps consistently`, async (t) => {
    const { db, runService, lifecycle, createRun } = await createHarness(t);
    const fresh = createRun('fresh queued run');
    const stale = createRun('stale queued run');
    db.prepare(`
      UPDATE runs
         SET created_at = datetime('now', '-16 minutes')
       WHERE id = ?
    `).run(stale.id);

    assert.match(runService.getRun(fresh.id).created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    withTimezone(tz, () => {
      assert.equal(lifecycle.sweepStuckQueuedRuns(), 1);
    });
    assert.deepEqual(
      runService.getRunEvents(fresh.id).filter((event) => event.event_type === 'queue:stuck'),
      [],
      'a just-created run must never be swept, whatever the host timezone',
    );
    assert.equal(
      runService.getRunEvents(stale.id).filter((event) => event.event_type === 'queue:stuck').length,
      1,
      'a genuinely stuck run must still be swept, whatever the host timezone',
    );
  });

  test(`[TZ=${tz}] materialization sweep keeps a fresh SQLite UTC claim and requeues a stale one`, async (t) => {
    const { db, runService, lifecycle, createRun } = await createHarness(t);
    const fresh = createRun('fresh materialization');
    const stale = createRun('stale materialization');
    runService.claimQueuedRunForMaterialization(fresh.id);
    runService.claimQueuedRunForMaterialization(stale.id);
    db.prepare(`
      UPDATE runs
         SET materialize_started_at = datetime('now', '-11 minutes')
       WHERE id = ?
    `).run(stale.id);

    assert.match(
      runService.getRun(fresh.id).materialize_started_at,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    withTimezone(tz, () => {
      assert.equal(lifecycle.sweepStuckMaterializations(), 1);
    });
    assert.equal(runService.getRun(fresh.id).status, 'materializing');
    assert.equal(runService.getRun(stale.id).status, 'queued');
  });
}
