'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createTaskService } = require('../services/taskService');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runservice-materialize-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  t.after(async () => {
    try { handle.close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return handle.db;
}

function withRepoFlag(t, value = '1') {
  const prev = process.env.PALANTIR_PROJECT_REPO;
  process.env.PALANTIR_PROJECT_REPO = value;
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev;
  });
}

function seedProfile(db) {
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES ('profile_mat', 'Materialize', 'codex', 'codex', '{prompt}', '{}', '[]', 1)
  `).run();
  return 'profile_mat';
}

function seedRunSet(db) {
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const taskService = createTaskService(db);
  const profileId = seedProfile(db);
  const project = projectService.createProject({
    name: 'Repo Project',
    source_type: 'git',
    repo_url: '/tmp/source-repo',
    repo_ref: 'main',
  });
  const task = taskService.createTask({
    project_id: project.id,
    title: 'Materialize task',
    status: 'in_progress',
  });
  const run = runService.createRun({
    task_id: task.id,
    agent_profile_id: profileId,
    prompt: 'work',
  });
  return { runService, projectService, taskService, project, task, run, profileId };
}

test('claimQueuedRun rejects unmaterialized git runs when repo flag is on', async (t) => {
  withRepoFlag(t, '1');
  const db = await mkdb(t);
  const { runService, project, run } = seedRunSet(db);

  assert.equal(runService.claimQueuedRun(run.id), 0);
  assert.equal(runService.getRun(run.id).status, 'queued');

  const materializeClaim = runService.claimQueuedRunForMaterialization(run.id);
  runService.updateRunMaterialized(run.id, {
    materialize_claim_token: materializeClaim.token,
    source_type_snapshot: 'git',
    run_source_generation: project.source_generation,
    repo_url_snapshot: project.repo_url,
    repo_ref_snapshot: project.repo_ref,
    repo_cache_path: '/tmp/cache',
    workspace_path: '/tmp/workspace',
    workspace_generation: project.source_generation,
    resolved_commit: '0123456789012345678901234567890123456789',
  });
  assert.equal(runService.claimQueuedRun(run.id), 1);
  const claimed = runService.getRun(run.id);
  assert.equal(claimed.status, 'running');
  assert.ok(claimed.started_at);
});

test('materialization lease CAS allows one in-flight lease per project node generation', async (t) => {
  const db = await mkdb(t);
  const { runService, project, run } = seedRunSet(db);

  const first = runService.acquireMaterializationLease({
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    ownerRunId: run.id,
  });
  const second = runService.acquireMaterializationLease({
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    ownerRunId: 'run_other',
  });

  assert.equal(first.acquired, true);
  assert.deepEqual(second, { acquired: false, pending: true });
  assert.equal(runService.releaseMaterializationLease(first.token, { status: 'completed' }), 1);

  const third = runService.acquireMaterializationLease({
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    ownerRunId: 'run_after',
  });
  assert.equal(third.acquired, true);
});

test('materialization durable writer stores workspace snapshots and refs release once', async (t) => {
  const db = await mkdb(t);
  const { runService, project, run } = seedRunSet(db);

  const materializeClaim = runService.claimQueuedRunForMaterialization(run.id);
  runService.updateRunMaterialized(run.id, {
    materialize_claim_token: materializeClaim.token,
    source_type_snapshot: 'git',
    run_source_generation: 2,
    repo_url_snapshot: 'file:///repo',
    repo_ref_snapshot: 'feature',
    repo_subdir_snapshot: 'packages/app',
    repo_cache_path: '/tmp/cache',
    workspace_path: '/tmp/worktree',
    workspace_generation: 2,
    resolved_commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  });
  runService.acquireWorkspaceRef({
    runId: run.id,
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: 2,
    repoCachePath: '/tmp/cache',
    worktreePath: '/tmp/worktree',
  });
  assert.equal(runService.releaseWorkspaceRefByRun(run.id), 1);
  assert.equal(runService.releaseWorkspaceRefByRun(run.id), 0);

  const after = runService.getRun(run.id);
  assert.equal(after.source_type_snapshot, 'git');
  assert.equal(after.workspace_path, '/tmp/worktree');
  assert.equal(after.workspace_generation, 2);
  assert.equal(after.resolved_commit, 'abcdefabcdefabcdefabcdefabcdefabcdefabcd');
  assert.ok(after.workspace_ref_released_at);
});

test('workspace ref release can be scoped to a single worktree path', async (t) => {
  const db = await mkdb(t);
  const { runService, project, run } = seedRunSet(db);

  runService.acquireWorkspaceRef({
    runId: run.id,
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    repoCachePath: '/tmp/cache',
    worktreePath: '/tmp/worktree-a',
  });
  runService.acquireWorkspaceRef({
    runId: run.id,
    projectId: project.id,
    nodeId: 'local',
    sourceGeneration: project.source_generation,
    repoCachePath: '/tmp/cache',
    worktreePath: '/tmp/worktree-b',
  });

  assert.equal(runService.releaseWorkspaceRefByRunAndPath(run.id, '/tmp/worktree-a'), 1);
  assert.equal(runService.releaseWorkspaceRefByRunAndPath(run.id, '/tmp/worktree-a'), 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM project_workspace_refs WHERE run_id = ? AND worktree_path = ? AND released_at IS NULL').get(run.id, '/tmp/worktree-b').count,
    1,
  );
  assert.equal(runService.getRun(run.id).workspace_ref_released_at, null);
});

test('materialization failure and requeue transitions require current token', async (t) => {
  const db = await mkdb(t);
  const { runService, taskService, project, run, profileId } = seedRunSet(db);
  const firstClaim = runService.claimQueuedRunForMaterialization(run.id);

  runService.updateRunStatus(run.id, 'cancelled');
  assert.equal(runService.failMaterializingRun(run.id, {
    token: firstClaim.token,
    error: 'late failure',
  }), null);
  const cancelled = runService.getRun(run.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.materialize_last_error, null);

  const secondRun = runService.createRun({
    task_id: taskService.createTask({
      project_id: project.id,
      title: 'Second materialize task',
      status: 'in_progress',
    }).id,
    agent_profile_id: profileId,
    prompt: 'second',
  });
  const staleClaim = runService.claimQueuedRunForMaterialization(secondRun.id);
  db.prepare('UPDATE runs SET materialize_claim_token = ? WHERE id = ?').run('new-token', secondRun.id);

  assert.equal(runService.failMaterializingRun(secondRun.id, {
    token: staleClaim.token,
    error: 'stale fail',
  }), null);
  assert.equal(runService.requeueMaterializingRun(secondRun.id, {
    token: staleClaim.token,
    error: 'stale requeue',
  }), null);
  const stillMaterializing = runService.getRun(secondRun.id);
  assert.equal(stillMaterializing.status, 'materializing');
  assert.equal(stillMaterializing.materialize_claim_token, 'new-token');
  assert.equal(stillMaterializing.materialize_last_error, null);

  const requeued = runService.requeueMaterializingRun(secondRun.id, {
    token: 'new-token',
    error: 'retry later',
    backoffMs: 1,
  });
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.materialize_claim_token, null);
  assert.match(requeued.materialize_last_error, /retry later/);
});
