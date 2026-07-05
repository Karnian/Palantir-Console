'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  createRunService,
  VALID_STATUSES,
  VALID_TRANSITIONS,
} = require('../services/runService');
const { createDatabase } = require('../db/database');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-status-materializing-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  t.after(async () => {
    handle.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return handle.db;
}

function seedRun(db, { id, status = 'queued', isManager = 0, nodeId = null } = {}) {
  db.prepare(`
    INSERT INTO runs (id, agent_profile_id, status, prompt, is_manager, node_id)
    VALUES (?, 'codex', ?, 'prompt', ?, ?)
  `).run(id, status, isManager, nodeId);
}

test('run status enum and transitions include materializing but require queued before running', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  seedRun(db, { id: 'run_materializing_transition' });

  assert.ok(VALID_STATUSES.includes('materializing'));
  assert.ok(VALID_TRANSITIONS.queued.includes('materializing'));
  assert.deepEqual(VALID_TRANSITIONS.materializing, ['queued', 'failed', 'cancelled', 'stopped']);
  assert.ok(!VALID_TRANSITIONS.materializing.includes('running'));

  const materializing = runService.updateRunStatus('run_materializing_transition', 'materializing');
  assert.equal(materializing.status, 'materializing');

  assert.throws(
    () => runService.updateRunStatus('run_materializing_transition', 'running'),
    /Cannot transition run from 'materializing' to 'running'/,
  );

  const queued = runService.updateRunStatus('run_materializing_transition', 'queued');
  assert.equal(queued.status, 'queued');

  runService.updateRunStatus('run_materializing_transition', 'materializing');
  const failed = runService.updateRunStatus('run_materializing_transition', 'failed');
  assert.equal(failed.status, 'failed');
});

test('countRunning helpers remain running-only and exclude materializing', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);

  seedRun(db, { id: 'run_running_worker', status: 'running' });
  seedRun(db, { id: 'run_materializing_worker', status: 'materializing' });
  seedRun(db, { id: 'run_running_manager', status: 'running', isManager: 1 });

  assert.equal(runService.countRunning('codex'), 1);
  assert.equal(runService.countRunningOnNode('local', 'codex'), 1);
  assert.equal(runService.countRunningTotalOnNode('local'), 1);
});
