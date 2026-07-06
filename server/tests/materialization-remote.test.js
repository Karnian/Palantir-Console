'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createTaskService } = require('../services/taskService');
const { createProjectMaterializationService } = require('../services/projectMaterializationService');

const COMMIT = '0123456789012345678901234567890123456789';

async function mkdb(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'materialization-remote-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  t.after(async () => {
    try { handle.close(); } catch { /* ignore */ }
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return handle.db;
}

function withRepoFlag(t) {
  const prev = process.env.PALANTIR_PROJECT_REPO;
  process.env.PALANTIR_PROJECT_REPO = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev;
  });
}

function seedProfile(db) {
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES ('profile_remote', 'Remote Materialize', 'codex', 'codex', '{prompt}', '{}', '[]', 1)
  `).run();
  return { id: 'profile_remote' };
}

function createRemoteExecutor({
  root = '/pod/root',
  canonicalRoot = root,
  failClone = false,
  forceRevParseMiss = false,
  rejectAssert = null,
} = {}) {
  const calls = [];
  const existing = new Set();

  function record(method, fields = {}) {
    calls.push({ method, ...fields });
  }

  function isWithin(target) {
    return (
      target === root
      || String(target).startsWith(`${root}/`)
      || target === canonicalRoot
      || String(target).startsWith(`${canonicalRoot}/`)
    );
  }

  function canonicalize(target) {
    const text = String(target);
    if (text === canonicalRoot || text.startsWith(`${canonicalRoot}/`)) return text;
    if (text === root) return canonicalRoot;
    if (text.startsWith(`${root}/`)) return `${canonicalRoot}${text.slice(root.length)}`;
    return text;
  }

  async function assertWithinRoots(target, options = {}) {
    record('assertWithinRoots', { target, options });
    if ((rejectAssert && rejectAssert(target, options)) || !isWithin(target)) {
      const err = new Error(`Remote path is outside exposed_roots: ${target}`);
      err.code = 'EXPOSED_ROOTS';
      throw err;
    }
    return canonicalize(target);
  }

  function removeExisting(target) {
    for (const item of Array.from(existing)) {
      if (item === target || item.startsWith(`${target}/`)) existing.delete(item);
    }
  }

  return {
    calls,
    existing,
    async exec(command, args, opts = {}) {
      record('exec', { command, args: [...args], opts: { ...opts, env: { ...(opts.env || {}) } } });
      if (opts.cwd) await assertWithinRoots(opts.cwd);
      if (command !== 'git') return { code: 127, stdout: '', stderr: 'bad command' };
      if (args[0] === 'clone') {
        if (failClone) return { code: 1, stdout: '', stderr: 'no node-local git credentials' };
        existing.add(args[4]);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') {
        return existing.has(opts.cwd) ? { code: 0, stdout: '.git\n', stderr: '' } : { code: 1, stdout: '', stderr: 'missing' };
      }
      if (args[0] === 'rev-parse' && forceRevParseMiss) return { code: 1, stdout: '', stderr: 'missing ref' };
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${COMMIT}\n`, stderr: '' };
      if (args[0] === 'ls-remote') return { code: 0, stdout: `${COMMIT}\trefs/heads/main\n`, stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'prune') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        existing.add(args[3]);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeExisting(args.at(-1));
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async fileExists(target) {
      record('fileExists', { target });
      await assertWithinRoots(target);
      return existing.has(target);
    },
    async mkdir(target, options = {}) {
      record('mkdir', { target, options });
      await assertWithinRoots(target);
    },
    async rmrf(target) {
      record('rmrf', { target });
      await assertWithinRoots(target);
      removeExisting(target);
    },
    async move(src, dst) {
      record('move', { src, dst });
      await assertWithinRoots(src);
      await assertWithinRoots(dst);
      existing.delete(src);
      existing.add(dst);
    },
    async readFile(target) {
      record('readFile', { target });
      await assertWithinRoots(target);
      return '';
    },
    assertWithinRoots,
  };
}

function buildHarness(db, { executor, node = {} } = {}) {
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const taskService = createTaskService(db);
  const nodeRow = {
    id: 'pod-a',
    kind: 'ssh',
    reachable: 1,
    can_execute: 1,
    files_only: 0,
    cordoned: 0,
    exposed_roots: JSON.stringify(['/pod/root']),
    ...node,
  };
  db.prepare(`
    INSERT INTO nodes (id, name, kind, can_execute, can_control, files_only, reachable, ssh_host, ssh_user, exposed_roots)
    VALUES (?, 'Pod A', 'ssh', ?, 0, ?, ?, 'pod.example', 'runner', ?)
  `).run(
    nodeRow.id,
    Number(nodeRow.can_execute),
    Number(nodeRow.files_only),
    Number(nodeRow.reachable),
    nodeRow.exposed_roots,
  );
  const nodeService = {
    getNode(nodeId) {
      assert.equal(nodeId, 'pod-a');
      return nodeRow;
    },
    pickExecutor(nodeId) {
      assert.equal(nodeId, 'pod-a');
      return executor;
    },
  };
  const materializationService = createProjectMaterializationService({
    runService,
    projectService,
    nodeService,
  });
  return { runService, projectService, taskService, materializationService };
}

function createRepoRun(h, db) {
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'Remote Repo',
    source_type: 'git',
    repo_url: 'https://github.com/acme/repo.git',
    repo_ref: 'main',
  });
  const task = h.taskService.createTask({ project_id: project.id, title: 'remote', status: 'in_progress' });
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'remote',
    node_id: 'pod-a',
  });
  h.runService.claimQueuedRunForMaterialization(run.id);
  return { project, run };
}

function execCalls(executor) {
  return executor.calls.filter((call) => call.method === 'exec');
}

function assertExecCallsDoNotContain(executor, secret) {
  for (const call of execCalls(executor)) {
    assert.equal(JSON.stringify({ args: call.args, env: call.opts.env }).includes(secret), false);
  }
}

test('remote clone and worktree use exposed root paths and executor filesystem primitives', async (t) => {
  withRepoFlag(t);
  const db = await mkdb(t);
  const executor = createRemoteExecutor();
  const h = buildHarness(db, { executor });
  const { project, run } = createRepoRun(h, db);
  const originalFs = { mkdir: fsp.mkdir, rm: fsp.rm, rename: fsp.rename };
  const fsCalls = { mkdir: 0, rm: 0, rename: 0 };
  fsp.mkdir = async () => { fsCalls.mkdir += 1; throw new Error('control-plane mkdir must not be used'); };
  fsp.rm = async () => { fsCalls.rm += 1; throw new Error('control-plane rm must not be used'); };
  fsp.rename = async () => { fsCalls.rename += 1; throw new Error('control-plane rename must not be used'); };

  let result;
  try {
    result = await h.materializationService.ensureWorkspace({ project, nodeId: 'pod-a', runId: run.id });
  } finally {
    fsp.mkdir = originalFs.mkdir;
    fsp.rm = originalFs.rm;
    fsp.rename = originalFs.rename;
  }

  assert.equal(result.ready, true);
  assert.equal(fsCalls.mkdir, 0);
  assert.equal(fsCalls.rm, 0);
  assert.equal(fsCalls.rename, 0);
  assert.match(result.workspacePath, /^\/pod\/root\/\.palantir-workspaces\//);
  assert.match(h.runService.getRun(run.id).repo_cache_path, /^\/pod\/root\/\.palantir-repo-cache\//);
  const clone = execCalls(executor).find((call) => call.args[0] === 'clone');
  assert.ok(clone);
  assert.equal(clone.args[1], '--no-checkout');
  assert.equal(clone.args[2], '--');
  assert.equal(clone.args[3], project.repo_url);
  assert.match(clone.args[4], /^\/pod\/root\/\.palantir-repo-cache\/.*\.tmp-/);
  assert.equal(clone.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(clone.opts.env.GIT_SSH_COMMAND, 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new');
  assert.equal(clone.opts.env.LC_ALL, 'C');
  assert.equal(clone.opts.env.LANG, 'C');
  const move = executor.calls.find((call) => call.method === 'move');
  assert.ok(move);
  assert.equal(move.src, clone.args[4]);
  assert.equal(move.dst, h.runService.getRun(run.id).repo_cache_path);
  const worktree = execCalls(executor).find((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
  assert.ok(worktree);
  assert.equal(worktree.args[2], '--');
  assert.equal(worktree.args[3], result.workspacePath);
});

test('remote clone and worktree argv use canonical-safe targets before writing', async (t) => {
  withRepoFlag(t);
  const db = await mkdb(t);
  const executor = createRemoteExecutor({ root: '/srv/root', canonicalRoot: '/real/root' });
  const h = buildHarness(db, {
    executor,
    node: { exposed_roots: JSON.stringify(['/srv/root']) },
  });
  const { project, run } = createRepoRun(h, db);

  const result = await h.materializationService.ensureWorkspace({ project, nodeId: 'pod-a', runId: run.id });

  const clone = execCalls(executor).find((call) => call.args[0] === 'clone');
  assert.ok(clone);
  assert.match(clone.args[4], /^\/real\/root\/\.palantir-repo-cache\/.*\.tmp-/);
  const move = executor.calls.find((call) => call.method === 'move');
  assert.ok(move);
  assert.match(move.src, /^\/real\/root\/\.palantir-repo-cache\//);
  assert.match(move.dst, /^\/real\/root\/\.palantir-repo-cache\//);
  const worktree = execCalls(executor).find((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
  assert.ok(worktree);
  assert.match(worktree.args[3], /^\/real\/root\/\.palantir-workspaces\//);
  assert.match(result.workspacePath, /^\/real\/root\/\.palantir-workspaces\//);
});

test('remote clone parent outside exposed_roots fails before clone or filesystem writes', async (t) => {
  withRepoFlag(t);
  const db = await mkdb(t);
  const executor = createRemoteExecutor({
    rejectAssert: (target, options) => Boolean(options.allowMissing) && String(target).includes('.palantir-repo-cache'),
  });
  const h = buildHarness(db, { executor });
  const { project, run } = createRepoRun(h, db);

  await assert.rejects(
    () => h.materializationService.ensureWorkspace({ project, nodeId: 'pod-a', runId: run.id }),
    (err) => err.code === 'EXPOSED_ROOTS',
  );

  assert.equal(execCalls(executor).some((call) => call.args[0] === 'clone'), false);
  assert.equal(executor.calls.some((call) => ['mkdir', 'rmrf', 'move'].includes(call.method)), false);
  const workspace = h.runService.getProjectNodeWorkspace(project.id, 'pod-a', project.source_generation);
  assert.equal(workspace.status, 'failed');
});

test('remote git argv terminates options for clone rev-parse ls-remote fetch and worktree add', async (t) => {
  withRepoFlag(t);
  const db = await mkdb(t);
  const executor = createRemoteExecutor({ forceRevParseMiss: true });
  const h = buildHarness(db, { executor });
  const { project, run } = createRepoRun(h, db);
  const hostileProject = h.projectService.updateProject(project.id, { repo_ref: '--config=core.sshCommand=bad' });

  await h.materializationService.ensureWorkspace({ project: hostileProject, nodeId: 'pod-a', runId: run.id });

  const clone = execCalls(executor).find((call) => call.args[0] === 'clone');
  assert.deepEqual(clone.args.slice(0, 3), ['clone', '--no-checkout', '--']);
  const revParse = execCalls(executor).find((call) => call.args[0] === 'rev-parse' && call.args[1] === '--verify');
  assert.deepEqual(revParse.args.slice(0, 3), ['rev-parse', '--verify', '--end-of-options']);
  const lsRemote = execCalls(executor).find((call) => call.args[0] === 'ls-remote');
  assert.deepEqual(lsRemote.args.slice(0, 2), ['ls-remote', '--']);
  const fetchSha = execCalls(executor).find((call) => call.args[0] === 'fetch' && call.args[1] === 'origin');
  assert.deepEqual(fetchSha.args.slice(0, 3), ['fetch', 'origin', '--']);
  const worktree = execCalls(executor).find((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
  assert.deepEqual(worktree.args.slice(0, 3), ['worktree', 'add', '--']);
});

test('remote executor without assertWithinRoots fails closed before writes', async (t) => {
  withRepoFlag(t);
  const db = await mkdb(t);
  const executor = createRemoteExecutor();
  delete executor.assertWithinRoots;
  const h = buildHarness(db, { executor });
  const { project, run } = createRepoRun(h, db);

  await assert.rejects(
    () => h.materializationService.ensureWorkspace({ project, nodeId: 'pod-a', runId: run.id }),
    /assertWithinRoots/,
  );

  assert.equal(execCalls(executor).length, 0);
  assert.equal(executor.calls.some((call) => ['mkdir', 'rmrf', 'move'].includes(call.method)), false);
});

test('remote ready cache fetches through executor instead of recloning', async (t) => {
  withRepoFlag(t);
  const db = await mkdb(t);
  const executor = createRemoteExecutor();
  const h = buildHarness(db, { executor });
  const first = createRepoRun(h, db);
  await h.materializationService.ensureWorkspace({ project: first.project, nodeId: 'pod-a', runId: first.run.id });
  executor.calls.length = 0;
  const task = h.taskService.createTask({ project_id: first.project.id, title: 'remote 2', status: 'in_progress' });
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: 'profile_remote',
    prompt: 'remote 2',
    node_id: 'pod-a',
  });
  h.runService.claimQueuedRunForMaterialization(run.id);

  await h.materializationService.ensureWorkspace({ project: first.project, nodeId: 'pod-a', runId: run.id });

  assert.equal(execCalls(executor).filter((call) => call.args[0] === 'clone').length, 0);
  assert.equal(execCalls(executor).filter((call) => call.args[0] === 'fetch').length, 1);
});

test('remote paths outside exposed_roots fail closed and mark workspace failed', async (t) => {
  withRepoFlag(t);
  const db = await mkdb(t);
  const executor = createRemoteExecutor();
  const h = buildHarness(db, { executor });
  const { project, run } = createRepoRun(h, db);
  h.runService.markProjectNodeWorkspaceReady({
    project_id: project.id,
    node_id: 'pod-a',
    source_generation: project.source_generation,
    repo_url: project.repo_url,
    repo_ref: project.repo_ref,
    repo_cache_path: '/outside/cache.git',
    resolved_commit: COMMIT,
  });

  await assert.rejects(
    () => h.materializationService.ensureWorkspace({ project, nodeId: 'pod-a', runId: run.id }),
    (err) => err.code === 'EXPOSED_ROOTS',
  );
  const workspace = h.runService.getProjectNodeWorkspace(project.id, 'pod-a', project.source_generation);
  assert.equal(workspace.status, 'failed');
  assert.match(workspace.last_error, /outside exposed_roots/);
});

test('remote clone without node-local git auth fails closed without exporting controller tokens', async (t) => {
  withRepoFlag(t);
  const prevSecret = process.env.CONTROLLER_TOKEN_SHOULD_NOT_LEAK;
  process.env.CONTROLLER_TOKEN_SHOULD_NOT_LEAK = 'controller-secret-token';
  t.after(() => {
    if (prevSecret === undefined) delete process.env.CONTROLLER_TOKEN_SHOULD_NOT_LEAK;
    else process.env.CONTROLLER_TOKEN_SHOULD_NOT_LEAK = prevSecret;
  });
  const db = await mkdb(t);
  const executor = createRemoteExecutor({ failClone: true });
  const h = buildHarness(db, { executor });
  const { project, run } = createRepoRun(h, db);

  await assert.rejects(
    () => h.materializationService.ensureWorkspace({ project, nodeId: 'pod-a', runId: run.id }),
    /no node-local git credentials/,
  );

  const clone = execCalls(executor).find((call) => call.args[0] === 'clone');
  assert.ok(clone);
  assert.equal(clone.opts.env.GIT_TERMINAL_PROMPT, '0');
  assertExecCallsDoNotContain(executor, 'controller-secret-token');
  const workspace = h.runService.getProjectNodeWorkspace(project.id, 'pod-a', project.source_generation);
  assert.equal(workspace.status, 'failed');
});
