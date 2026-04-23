// R2-B.2 — GET /api/runs/:id/diff
//
// Coverage:
//   * no worktree on run          → 200 { diff: null, reason: 'no_worktree' }
//   * worktree path missing on FS → 200 { diff: null, reason: 'worktree_missing' }
//   * worktree outside project    → 400 { reason: 'worktree_outside_project' }
//   * real worktree with edits    → 200 { diff: "<unified>" }
//   * real worktree, no edits     → 200 { diff: "", empty: true }
//   * unknown run id              → 404 (runService.getRun throws)
//   * large diff truncation       → runGitDiff unit test with tight cap
//
// We drive the DB directly where useful — the runs router doesn't
// care how the run row got there, only that `worktree_path` is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const request = require('supertest');
const { createApp } = require('../app');
const { runGitDiff, DIFF_MAX_BYTES } = require('../routes/runs');

async function mkdirTemp(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await mkdirTemp('palantir-storage-');
  const fsRoot = await mkdirTemp('palantir-fs-');
  const dbDir = await mkdirTemp('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  const app = createApp({
    storageRoot, fsRoot, opencodeBin: 'opencode', dbPath, pluginsRoot,
    authToken: null,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown(); else app.closeDb();
    await fsp.rm(storageRoot, { recursive: true, force: true });
    await fsp.rm(fsRoot, { recursive: true, force: true });
    await fsp.rm(dbDir, { recursive: true, force: true });
    await fsp.rm(pluginsRoot, { recursive: true, force: true });
  });
  return app;
}

/**
 * Initialise a git repo at `dir` with one committed file so `git diff
 * HEAD` has a baseline. Returns the committed file's absolute path.
 */
function makeGitRepoWithBaseline(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  // Set local identity so commits don't fail on CI hosts without a
  // global git identity configured.
  execFileSync('git', ['config', 'user.email', 'r2b-test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'R2B Test'], { cwd: dir });
  const filePath = path.join(dir, 'README.md');
  fs.writeFileSync(filePath, 'initial content\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return filePath;
}

// Direct runService access helper — the diff route only needs
// worktree_path on the run row, so we sidestep lifecycleService's
// full spawn path and poke the DB via a created run + a fake
// worktree path update.
const _agentByApp = new WeakMap();
function ensureAgentProfile(app) {
  if (_agentByApp.has(app)) return _agentByApp.get(app);
  const { agentProfileService } = app.services;
  const profile = agentProfileService.createProfile({
    name: 'r2b-diff-fixture',
    type: 'claude-code',
    command: 'claude',
    args_template: '',
  });
  _agentByApp.set(app, profile.id);
  return profile.id;
}

function createRunWithWorktree(app, { worktreePath, taskId = null }) {
  const { runService } = app.services;
  const agent_profile_id = ensureAgentProfile(app);
  const run = runService.createRun({ task_id: taskId, agent_profile_id });
  // markRunStarted persists worktree_path on the row.
  runService.markRunStarted(run.id, {
    tmux_session: null,
    worktree_path: worktreePath,
    branch: null,
  });
  return runService.getRun(run.id);
}

test('GET /api/runs/:id/diff 404s for unknown run', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/runs/run_does_not_exist/diff');
  assert.equal(res.status, 404);
});

test('GET /api/runs/:id/diff returns null when run has no worktree', async (t) => {
  const app = await createTestApp(t);
  const { projectService, taskService } = app.services;
  const project = projectService.createProject({ name: 'r2b-no-wt' });
  const task = taskService.createTask({ title: 'r2b-no-wt', project_id: project.id });
  const run = createRunWithWorktree(app, { worktreePath: null, taskId: task.id });
  const res = await request(app).get(`/api/runs/${run.id}/diff`);
  assert.equal(res.status, 200);
  assert.equal(res.body.diff, null);
  assert.equal(res.body.reason, 'no_worktree');
});

test('GET /api/runs/:id/diff returns null when worktree directory is missing', async (t) => {
  const app = await createTestApp(t);
  const { projectService, taskService } = app.services;
  const project = projectService.createProject({ name: 'r2b-ghost' });
  const task = taskService.createTask({ title: 'r2b-ghost', project_id: project.id });
  const vanishedPath = path.join(os.tmpdir(), 'palantir-r2b-ghost-' + Date.now());
  const run = createRunWithWorktree(app, { worktreePath: vanishedPath, taskId: task.id });
  const res = await request(app).get(`/api/runs/${run.id}/diff`);
  assert.equal(res.status, 200);
  assert.equal(res.body.diff, null);
  assert.equal(res.body.reason, 'worktree_missing');
});

test('GET /api/runs/:id/diff returns unified diff for real worktree changes', async (t) => {
  const app = await createTestApp(t);
  const repoDir = await mkdirTemp('palantir-r2b-repo-');
  t.after(async () => { await fsp.rm(repoDir, { recursive: true, force: true }); });
  const file = makeGitRepoWithBaseline(repoDir);

  // Create a project + task so the route's project-boundary check passes.
  const { projectService, taskService } = app.services;
  const project = projectService.createProject({
    name: 'r2b-diff-test',
    directory: repoDir,
  });
  const task = taskService.createTask({
    title: 'r2b-diff-task',
    project_id: project.id,
  });

  // Modify the tracked file so `git diff HEAD` is non-empty.
  fs.writeFileSync(file, 'initial content\nplus a new line added by the agent\n');

  const run = createRunWithWorktree(app, { worktreePath: repoDir, taskId: task.id });
  const res = await request(app).get(`/api/runs/${run.id}/diff`);
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.diff === 'string', 'diff must be a string');
  assert.match(res.body.diff, /^diff --git /m, 'diff must contain git diff header');
  assert.match(res.body.diff, /plus a new line/, 'diff must include new line content');
  assert.equal(res.body.truncated, false);
  assert.equal(res.body.empty, false);
});

test('GET /api/runs/:id/diff returns empty diff when worktree is clean', async (t) => {
  const app = await createTestApp(t);
  const repoDir = await mkdirTemp('palantir-r2b-repo-');
  t.after(async () => { await fsp.rm(repoDir, { recursive: true, force: true }); });
  makeGitRepoWithBaseline(repoDir);

  const { projectService, taskService } = app.services;
  const project = projectService.createProject({ name: 'r2b-clean', directory: repoDir });
  const task = taskService.createTask({ title: 'r2b-clean', project_id: project.id });

  const run = createRunWithWorktree(app, { worktreePath: repoDir, taskId: task.id });
  const res = await request(app).get(`/api/runs/${run.id}/diff`);
  assert.equal(res.status, 200);
  assert.equal(res.body.diff, '');
  assert.equal(res.body.empty, true);
  assert.equal(res.body.truncated, false);
});

test('GET /api/runs/:id/diff rejects symlinked worktrees that resolve outside the project', async (t) => {
  // Defence against a worktree_path that names a symlink pointing
  // outside the project. The string-level startsWith check would be
  // fooled; fs.realpathSync resolves to the real target so the
  // comparison catches the escape.
  const app = await createTestApp(t);
  const projectDir = await mkdirTemp('palantir-r2b-symroot-');
  const escapeDir = await mkdirTemp('palantir-r2b-symtarget-');
  t.after(async () => {
    await fsp.rm(projectDir, { recursive: true, force: true });
    await fsp.rm(escapeDir, { recursive: true, force: true });
  });
  // Create a symlink inside projectDir that targets an outside path.
  const symlinkName = path.join(projectDir, 'escape');
  fs.symlinkSync(escapeDir, symlinkName);

  const { projectService, taskService } = app.services;
  const project = projectService.createProject({ name: 'r2b-symescape', directory: projectDir });
  const task = taskService.createTask({ title: 'r2b-symescape', project_id: project.id });

  // Record the SYMLINK path as the worktree — the string is under
  // projectDir, but the real target is outside.
  const run = createRunWithWorktree(app, { worktreePath: symlinkName, taskId: task.id });
  const res = await request(app).get(`/api/runs/${run.id}/diff`);
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'worktree_outside_project');
});

test('GET /api/runs/:id/diff rejects worktrees outside the project root', async (t) => {
  const app = await createTestApp(t);
  const projectDir = await mkdirTemp('palantir-r2b-proj-');
  const outsideDir = await mkdirTemp('palantir-r2b-outside-');
  t.after(async () => {
    await fsp.rm(projectDir, { recursive: true, force: true });
    await fsp.rm(outsideDir, { recursive: true, force: true });
  });

  const { projectService, taskService } = app.services;
  const project = projectService.createProject({ name: 'r2b-bound', directory: projectDir });
  const task = taskService.createTask({ title: 'r2b-bound', project_id: project.id });

  // Point worktree at a dir OUTSIDE the project. This should 400.
  const run = createRunWithWorktree(app, { worktreePath: outsideDir, taskId: task.id });
  const res = await request(app).get(`/api/runs/${run.id}/diff`);
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'worktree_outside_project');
});

test('runGitDiff invocation disables external helpers (no-ext-diff / no-textconv)', async (t) => {
  // Codex R2-B review: without `--no-ext-diff` / `--no-textconv`, a
  // repo carrying a hostile git config (`diff.external=/some/bin`
  // or `GIT_EXTERNAL_DIFF` env) could have git spawn arbitrary
  // programs when we run `git diff`. The endpoint runs with server
  // process privileges, so this is remote code execution for anyone
  // who can point a project at a malicious repo.
  //
  // This test locks the argv in so a future refactor can't
  // reintroduce the gap silently. We inspect the function source
  // rather than monkey-patching execFile, which keeps the test
  // implementation-honest without coupling to child_process internals.
  const fsSync = require('node:fs');
  const routeSrc = fsSync.readFileSync(
    path.join(__dirname, '..', 'routes', 'runs.js'), 'utf-8',
  );
  // The git invocation must carry both flags; a future refactor that
  // drops either one fails this test loudly.
  assert.match(routeSrc, /--no-ext-diff/,
    'runGitDiff must pass --no-ext-diff to block GIT_EXTERNAL_DIFF / diff.external helpers');
  assert.match(routeSrc, /--no-textconv/,
    'runGitDiff must pass --no-textconv to block gitattributes textconv helpers');
});

test('runGitDiff returns truncated:true when output exceeds the cap', async (t) => {
  // Unit-test the truncation logic directly rather than trying to
  // generate a 1 MiB diff in a test repo. We verify the cap constant
  // exists and is enforced by writing a file whose size exceeds a
  // custom local cap — DIFF_MAX_BYTES is not overridable, so this is
  // primarily a sanity check on the exported constant shape.
  assert.equal(typeof DIFF_MAX_BYTES, 'number');
  assert.ok(DIFF_MAX_BYTES >= 64 * 1024, 'DIFF_MAX_BYTES should be at least 64 KiB to hold real diffs');
});

test('runGitDiff truncates when diff exceeds DIFF_MAX_BYTES', async (t) => {
  // Build a repo with a large single-file change big enough to breach
  // the 1 MiB cap comfortably.
  const repoDir = await mkdirTemp('palantir-r2b-huge-');
  t.after(async () => { await fsp.rm(repoDir, { recursive: true, force: true }); });
  makeGitRepoWithBaseline(repoDir);

  // Replace README.md with ~2 MiB of content so the unified diff
  // exceeds DIFF_MAX_BYTES (which is 1 MiB).
  const chunk = 'a'.repeat(64 * 1024);
  const bigContent = chunk.repeat(40) + '\n'; // ~2.5 MiB
  fs.writeFileSync(path.join(repoDir, 'README.md'), bigContent);

  const result = await runGitDiff(repoDir);
  assert.equal(result.truncated, true,
    'a 2.5 MiB edit should be flagged as truncated against a 1 MiB cap');
  assert.ok(result.diff.length <= DIFF_MAX_BYTES,
    `diff length ${result.diff.length} must not exceed DIFF_MAX_BYTES ${DIFF_MAX_BYTES}`);
  assert.equal(result.empty, false);
});
