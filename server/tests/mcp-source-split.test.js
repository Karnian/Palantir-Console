const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');

async function mkdb(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mcp-source-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function withRepoFeature(t) {
  const prev = process.env.PALANTIR_PROJECT_REPO;
  process.env.PALANTIR_PROJECT_REPO = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev;
  });
}

function stubExecEngine() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `s-${runId}` };
    },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() { /* test stub */ },
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function seedProfile(db, command = 'codex') {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
     VALUES (?, ?, ?, ?, ?, ?, ?, 5)`
  ).run(id, 'Agent', command, command, '{prompt}', '{}', '[]');
  return { id, command };
}

function buildHarness(db, { nodeService } = {}) {
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const exec = stubExecEngine();
  const lc = createLifecycleService({
    runService: rs,
    taskService: ts,
    agentProfileService: aps,
    projectService: ps,
    executionEngine: exec,
    streamJsonEngine: null,
    worktreeService: null,
    eventBus: null,
    nodeService,
  });
  return { rs, ts, ps, aps, exec, lc };
}

function seedTaskAndRun(db, h, project, {
  nodeId = null,
  workspacePath = null,
  resolvedCommit = '0123456789abcdef0123456789abcdef01234567',
} = {}) {
  const task = h.ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  const profile = seedProfile(db, 'codex');
  const run = h.rs.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'hi',
    node_id: nodeId,
  });
  if (workspacePath) {
    db.prepare(`
      UPDATE runs
         SET source_type_snapshot = 'git',
             run_source_generation = 0,
             workspace_path = ?,
             workspace_generation = 0,
             resolved_commit = ?
       WHERE id = ?
    `).run(workspacePath, resolvedCommit, run.id);
  }
  return h.rs.getRun(run.id);
}

function repoProject(ps, fields = {}) {
  return ps.createProject({
    name: fields.name || 'Repo',
    source_type: 'git',
    repo_url: 'https://example.com/repo.git',
    repo_ref: 'HEAD',
    mcp_config_source: 'repo_relpath',
    mcp_config_relpath: fields.relpath || '.palantir/mcp.json',
    ...fields.extra,
  });
}

function snapshotFor(rs, runId) {
  const raw = rs.getRun(runId).mcp_config_snapshot;
  return raw ? JSON.parse(raw) : null;
}

function eventTypes(rs, runId) {
  return rs.getRunEvents(runId).map((e) => e.event_type);
}

test('legacy_control_plane_path reads control-plane absolute path and keeps boundary behavior', async (t) => {
  const db = await mkdb(t);
  const h = buildHarness(db);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-legacy-proj-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-legacy-out-'));
  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const configPath = path.join(projectDir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: { legacy: { command: 'legacy-cmd' } },
  }));
  const project = h.ps.createProject({
    name: 'Legacy',
    directory: projectDir,
    mcp_config_path: configPath,
  });
  const run = seedTaskAndRun(db, h, project);
  await h.lc.spawnQueuedRun(run.id);

  assert.equal(snapshotFor(h.rs, run.id).mcpServers.legacy.command, 'legacy-cmd');
  assert.equal(h.exec.spawned.length, 1);

  const escapedPath = path.join(outsideDir, 'mcp.json');
  fs.writeFileSync(escapedPath, JSON.stringify({
    mcpServers: { escaped: { command: 'nope' } },
  }));
  const escapedProject = h.ps.createProject({
    name: 'EscapedLegacy',
    directory: projectDir,
    mcp_config_path: escapedPath,
  });
  const escapedRun = seedTaskAndRun(db, h, escapedProject);
  await h.lc.spawnQueuedRun(escapedRun.id);

  assert.equal(snapshotFor(h.rs, escapedRun.id), null);
  assert.equal(h.rs.getRun(escapedRun.id).status, 'running');
});

test('repo_relpath local reads workspace-relative JSON and merges it for codex', async (t) => {
  withRepoFeature(t);
  const db = await mkdb(t);
  const h = buildHarness(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-repo-local-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.palantir'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.palantir', 'mcp.json'), JSON.stringify({
    mcpServers: { repoLocal: { command: 'local-cmd', args: ['--ok'] } },
  }));

  const project = repoProject(h.ps);
  const run = seedTaskAndRun(db, h, project, { workspacePath: workspace });
  await h.lc.spawnQueuedRun(run.id);

  const merged = snapshotFor(h.rs, run.id);
  assert.equal(merged.mcpServers.repoLocal.command, 'local-cmd');
  const args = h.exec.spawned[0].opts.args;
  assert.ok(args.join('\n').includes('mcp_servers.repoLocal.command'));
  assert.equal(args.some((arg) => String(arg).includes('.palantir/mcp.json')), false);
});

test('repo_relpath remote reads through executor and only passes flattened MCP to codex', async (t) => {
  withRepoFeature(t);
  const db = await mkdb(t);
  db.prepare(`
    INSERT INTO nodes (id, name, kind, can_execute, can_control, files_only, reachable, max_concurrent, ssh_host, ssh_user, exposed_roots)
    VALUES ('remote-a', 'Remote A', 'ssh', 1, 0, 0, 1, 5, 'example.invalid', 'runner', '["/tmp"]')
  `).run();
  const readPaths = [];
  const remoteSpawned = [];
  const remoteExecutor = {
    async readFile(p) {
      readPaths.push(p);
      return JSON.stringify({
        mcpServers: { remoteRepo: { command: 'remote-cmd', args: ['--pod'] } },
      });
    },
    async fileExists() { return true; },
    async spawnWorker(runId, opts) {
      remoteSpawned.push({ runId, opts });
      return { sessionName: `remote-${runId}` };
    },
  };
  const nodeService = {
    getNode(id) {
      if (id !== 'remote-a') return null;
      return {
        id,
        name: 'Remote A',
        kind: 'ssh',
        can_execute: 1,
        files_only: 0,
        reachable: 1,
        max_concurrent: 5,
        node_prefix: '/remote',
      };
    },
    pickExecutor(id) {
      assert.equal(id, 'remote-a');
      return remoteExecutor;
    },
  };
  const h = buildHarness(db, { nodeService });
  const workspace = path.join(os.tmpdir(), `palantir-remote-workspace-${Date.now()}`);
  const project = repoProject(h.ps, { relpath: 'config/mcp.json' });
  const run = seedTaskAndRun(db, h, project, { nodeId: 'remote-a', workspacePath: workspace });

  await h.lc.spawnQueuedRun(run.id);

  assert.deepEqual(readPaths, [path.join(workspace, 'config/mcp.json')]);
  assert.equal(snapshotFor(h.rs, run.id).mcpServers.remoteRepo.command, 'remote-cmd');
  assert.equal(remoteSpawned.length, 1);
  const args = remoteSpawned[0].opts.spec.args;
  assert.ok(args.join('\n').includes('mcp_servers.remoteRepo.command'));
  assert.equal(args.some((arg) => String(arg).includes('config/mcp.json')), false);
});

test('repo_relpath invalid relpaths fail closed', async (t) => {
  withRepoFeature(t);
  for (const relpath of ['../mcp.json', '/tmp/mcp.json']) {
    await t.test(relpath, async (st) => {
      const db = await mkdb(st);
      const h = buildHarness(db);
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-repo-invalid-'));
      st.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
      const project = repoProject(h.ps, { relpath });
      const run = seedTaskAndRun(db, h, project, { workspacePath: workspace });

      await assert.rejects(
        () => h.lc.spawnQueuedRun(run.id),
        /mcp_config_relpath/
      );
      assert.equal(h.rs.getRun(run.id).status, 'failed');
      assert.equal(h.exec.spawned.length, 0);
    });
  }
});

test('repo_relpath unmaterialized or missing file warns and skips empty config', async (t) => {
  withRepoFeature(t);
  const db = await mkdb(t);
  const h = buildHarness(db);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-repo-unmat-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-repo-missing-'));
  t.after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const unmaterializedProject = h.ps.createProject({
    name: 'Unmaterialized',
    directory: projectDir,
    mcp_config_source: 'repo_relpath',
    mcp_config_relpath: '.palantir/mcp.json',
  });
  const unmaterializedRun = seedTaskAndRun(db, h, unmaterializedProject);
  await h.lc.spawnQueuedRun(unmaterializedRun.id);
  assert.equal(snapshotFor(h.rs, unmaterializedRun.id), null);
  assert.ok(eventTypes(h.rs, unmaterializedRun.id).includes('mcp:repo_relpath_unmaterialized'));

  const missingProject = repoProject(h.ps);
  const missingRun = seedTaskAndRun(db, h, missingProject, { workspacePath: workspace });
  await h.lc.spawnQueuedRun(missingRun.id);
  assert.equal(snapshotFor(h.rs, missingRun.id), null);
  assert.ok(eventTypes(h.rs, missingRun.id).includes('mcp:repo_relpath_missing'));
});

test('repo_relpath malformed JSON fails closed', async (t) => {
  withRepoFeature(t);
  const db = await mkdb(t);
  const h = buildHarness(db);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-repo-badjson-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.palantir'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.palantir', 'mcp.json'), '{bad json');

  const project = repoProject(h.ps);
  const run = seedTaskAndRun(db, h, project, { workspacePath: workspace });

  await assert.rejects(
    () => h.lc.spawnQueuedRun(run.id),
    /Failed to parse repo MCP config/
  );
  assert.equal(h.rs.getRun(run.id).status, 'failed');
  assert.ok(eventTypes(h.rs, run.id).includes('mcp:repo_relpath_parse_failed'));
  assert.equal(h.exec.spawned.length, 0);
});
