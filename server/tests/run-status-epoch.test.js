'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../app');
const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');

async function createServiceFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-status-epoch-'));
  const { db, migrate, close } = createDatabase(path.join(root, 'test.db'));
  migrate();
  t.after(async () => {
    close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const runService = createRunService(db);
  const createRun = () => runService.createRun({ is_manager: true, node_id: 'local' });
  return { db, runService, createRun };
}

test('every representative status transition path monotonically bumps status_epoch', async (t) => {
  const { runService, createRun } = await createServiceFixture(t);

  const updateRun = createRun();
  const updateBefore = runService.getRun(updateRun.id).status_epoch;
  runService.updateRunStatus(updateRun.id, 'running', { force: true });
  assert.equal(runService.getRun(updateRun.id).status_epoch, updateBefore + 1, 'updateRunStatus');

  const startedRun = createRun();
  const startedBefore = runService.getRun(startedRun.id).status_epoch;
  runService.markRunStarted(startedRun.id, { tmux_session: `session-${startedRun.id}` });
  assert.equal(runService.getRun(startedRun.id).status_epoch, startedBefore + 1, 'markRunStarted');

  const claimedRun = createRun();
  const claimedBefore = runService.getRun(claimedRun.id).status_epoch;
  assert.equal(runService.claimQueuedRun(claimedRun.id), 1);
  assert.equal(runService.getRun(claimedRun.id).status_epoch, claimedBefore + 1, 'claimQueuedRun');

  const rejectedRun = createRun();
  const rejectedBefore = runService.getRun(rejectedRun.id).status_epoch;
  assert.equal(runService.rejectQueuedRun(rejectedRun.id, { reason: 'invalid queue item' }), true);
  assert.equal(runService.getRun(rejectedRun.id).status_epoch, rejectedBefore + 1, 'rejectQueuedRun');
});

test('an UPDATE that does not write status does not bump status_epoch', async (t) => {
  const { db, runService, createRun } = await createServiceFixture(t);
  const run = createRun();
  const before = runService.getRun(run.id).status_epoch;
  db.prepare('UPDATE runs SET cost_usd = ? WHERE id = ?').run(1.25, run.id);
  assert.equal(runService.getRun(run.id).status_epoch, before);
});

test('writing the current status still bumps status_epoch', async (t) => {
  const { db, runService, createRun } = await createServiceFixture(t);
  const run = createRun();
  const before = runService.getRun(run.id).status_epoch;
  db.prepare("UPDATE runs SET status = 'queued' WHERE id = ?").run(run.id);
  assert.equal(runService.getRun(run.id).status_epoch, before + 1);
});

test('status_epoch distinguishes a same-second completed-queued-completed ABA', async (t) => {
  const { db, runService, createRun } = await createServiceFixture(t);
  const run = createRun();
  runService.updateRunStatus(run.id, 'completed', { force: true });
  const before = runService.getRun(run.id);

  db.transaction(() => {
    runService.updateRunStatus(run.id, 'queued', { force: true });
    runService.updateRunStatus(run.id, 'completed', { force: true });
    db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(before.ended_at, run.id);
  })();

  const after = runService.getRun(run.id);
  assert.equal(after.status, before.status);
  assert.equal(after.ended_at, before.ended_at);
  assert.ok(after.status_epoch > before.status_epoch);
});

async function createRouteFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-status-epoch-route-'));
  const app = createApp({
    storageRoot: path.join(root, 'storage'),
    fsRoot: path.join(root, 'fs'),
    pluginsRoot: path.join(root, 'plugins'),
    dbPath: path.join(root, 'test.db'),
    authToken: null,
    authResolverOpts: { hasKeychain: () => false },
  });
  const server = http.createServer(app);
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (app.shutdown) await app.shutdown(); else app.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });

  const {
    runService, nodeService, projectService, taskService, agentProfileService,
  } = app.services;
  nodeService.createNode({
    id: 'remote-epoch', name: 'Epoch remote', kind: 'ssh',
    ssh_host: 'epoch.invalid', ssh_user: 'tester', exposed_roots: ['/tmp'],
  });
  const project = projectService.createProject({ name: 'Status epoch route' });
  const task = taskService.createTask({ title: 'ABA route', project_id: project.id });
  const profile = agentProfileService.createProfile({
    name: 'Epoch profile', type: 'claude-code', command: 'claude', args_template: '',
  });
  const run = runService.createRun({
    task_id: task.id, agent_profile_id: profile.id, node_id: 'remote-epoch',
  });
  runService.updateRunStatus(run.id, 'completed', { force: true });
  return { server, app, runService, nodeService, run };
}

// A terminal run whose output is gone: the shape that is allowed to 410.
function stubMissingOutput(nodeService, onRead) {
  nodeService.pickExecutor = () => ({
    readOutputRange: async () => {
      if (onRead) onRead();
      return {
        source_id: null, data: Buffer.alloc(0), next_offset: 0, end_offset: 0,
        has_more: false, sealed: false, generation_changed: false,
        deleted: false, missing: true,
      };
    },
  });
}

test('incremental output does not return 410 across a same-status, same-ended_at ABA', async (t) => {
  const { server, runService, nodeService, run } = await createRouteFixture(t);
  const initial = runService.getRun(run.id);
  stubMissingOutput(nodeService, () => {
    runService.updateRunStatus(run.id, 'queued', { force: true });
    runService.updateRunStatus(run.id, 'completed', { force: true });
  });
  const originalGetRun = runService.getRun;
  runService.getRun = (id) => {
    const current = originalGetRun(id);
    return current.status_epoch > initial.status_epoch
      ? { ...current, ended_at: initial.ended_at }
      : current;
  };

  const res = await request(server).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 200, 'the ABA must defer expiry instead of returning 410');
  assert.equal(res.body.run_status, 'completed');
});

test('a run snapshot without status_epoch is treated as movement, never as expiry', async (t) => {
  // The comparison must not read `undefined === undefined` as "never moved":
  // that silently restores the false 410 this column exists to close. getRun
  // selects r.*, but a projection or an injected double may not carry it, and
  // the unrecoverable direction is the one to refuse.
  const { server, runService, nodeService, run } = await createRouteFixture(t);
  stubMissingOutput(nodeService);
  const originalGetRun = runService.getRun;
  runService.getRun = (id) => {
    const { status_epoch: _dropped, ...withoutEpoch } = originalGetRun(id);
    return withoutEpoch;
  };

  const res = await request(server).get(`/api/runs/${run.id}/output?after=0`);
  assert.equal(res.status, 200, 'an unobservable epoch must defer expiry, not claim it');
});

test('the epoch trigger does not inflate CAS change counts', async (t) => {
  // Single-winner CAS is spelled `UPDATE ... WHERE status = <expected>` and read
  // through `.changes` in many places (claimQueuedRun, rejectQueuedRun, the
  // materialization leases). The bump trigger writes a second row version for
  // every one of those statements; if that counted, every CAS in the codebase
  // would report a win. SQLite excludes trigger-caused changes from
  // sqlite3_changes() -- pin it, because the whole design rests on it.
  const { db, runService, createRun } = await createServiceFixture(t);
  const run = createRun();
  const cas = db.prepare("UPDATE runs SET status = 'running' WHERE id = ? AND status = 'queued'");

  assert.equal(cas.run(run.id).changes, 1, 'the winner sees exactly one change');
  assert.equal(cas.run(run.id).changes, 0, 'the loser sees none');
  assert.equal(runService.getRun(run.id).status_epoch, 1, 'and only the winner bumped the epoch');
});
