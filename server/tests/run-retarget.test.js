'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createTaskService } = require('../services/taskService');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-retarget-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function buildHarness(db) {
  const projectService = createProjectService(db);
  const taskService = createTaskService(db);
  const runService = createRunService(db);
  for (const nodeId of ['node-a', 'node-b', 'node-c']) {
    db.prepare(`
      INSERT INTO nodes (id, name, kind, can_execute, can_control, reachable, max_concurrent)
      VALUES (?, ?, 'local', 1, 1, 1, 1)
    `).run(nodeId, nodeId);
  }
  const project = projectService.createProject({ name: `P-${Math.random().toString(36).slice(2)}` });
  const task = taskService.createTask({
    project_id: project.id,
    title: `T-${Math.random().toString(36).slice(2)}`,
    status: 'todo',
  });
  const profileId = `profile-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'RetargetAgent', 'codex', 'codex', '{prompt}', '{}', '[]', 1)
  `).run(profileId);
  return { projectService, taskService, runService, project, task, profileId };
}

function createQueuedRun(runService, taskId, profileId, nodeId) {
  return runService.createRun({
    task_id: taskId,
    agent_profile_id: profileId,
    prompt: 'queued',
    node_id: nodeId,
  });
}

function retargetEvents(runService, runId) {
  return runService.getRunEvents(runId).filter((evt) => evt.event_type === 'queue:retargeted');
}

test('retargetQueuedRuns moves N queued runs and writes queue:retargeted events', async (t) => {
  const db = await mkdb(t);
  const h = buildHarness(db);
  const first = createQueuedRun(h.runService, h.task.id, h.profileId, 'node-a');
  const second = createQueuedRun(h.runService, h.task.id, h.profileId, 'node-a');

  const result = h.runService.retargetQueuedRuns([first.id, second.id], 'node-a', 'node-b');

  assert.deepEqual(result, { moved: 2 });
  assert.equal(h.runService.getRun(first.id).node_id, 'node-b');
  assert.equal(h.runService.getRun(second.id).node_id, 'node-b');
  for (const run of [first, second]) {
    const events = retargetEvents(h.runService, run.id);
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].payload_json), {
      from_node: 'node-a',
      to_node: 'node-b',
    });
  }
});

test('retargetQueuedRuns rolls back when a run is claimed before retarget', async (t) => {
  const db = await mkdb(t);
  const h = buildHarness(db);
  const first = createQueuedRun(h.runService, h.task.id, h.profileId, 'node-a');
  const second = createQueuedRun(h.runService, h.task.id, h.profileId, 'node-a');
  h.runService.claimQueuedRun(second.id);

  assert.throws(
    () => h.runService.retargetQueuedRuns([first.id, second.id], 'node-a', 'node-b'),
    (err) => err && err.httpStatus === 409,
  );

  assert.equal(h.runService.getRun(first.id).status, 'queued');
  assert.equal(h.runService.getRun(first.id).node_id, 'node-a');
  assert.equal(h.runService.getRun(second.id).status, 'running');
  assert.equal(h.runService.getRun(second.id).node_id, 'node-a');
  assert.equal(retargetEvents(h.runService, first.id).length, 0);
  assert.equal(retargetEvents(h.runService, second.id).length, 0);
});

test('retargetQueuedRuns returns moved 0 for an empty run id list', async (t) => {
  const db = await mkdb(t);
  const h = buildHarness(db);

  assert.deepEqual(h.runService.retargetQueuedRuns([], 'node-a', 'node-b'), { moved: 0 });
});

test('retargetQueuedRuns rejects from-node mismatch without moving the run', async (t) => {
  const db = await mkdb(t);
  const h = buildHarness(db);
  const run = createQueuedRun(h.runService, h.task.id, h.profileId, 'node-c');

  assert.throws(
    () => h.runService.retargetQueuedRuns([run.id], 'node-a', 'node-b'),
    (err) => err && err.httpStatus === 409,
  );

  assert.equal(h.runService.getRun(run.id).node_id, 'node-c');
  assert.equal(retargetEvents(h.runService, run.id).length, 0);
});
