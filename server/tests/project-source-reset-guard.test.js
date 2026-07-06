const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createProjectBriefService } = require('../services/projectBriefService');
const { createNodeService } = require('../services/nodeService');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-source-guard-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function createSshNode(nodeService, id = 'nodeA') {
  return nodeService.createNode({
    id,
    name: id,
    kind: 'ssh',
    ssh_host: `${id}.example`,
    ssh_user: 'runner',
    exposed_roots: ['/workspace'],
    can_execute: true,
    reachable: true,
  });
}

test('repo source changes are rejected while a stored Operator thread exists', async (t) => {
  const db = await mkdb(t);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const project = projectService.createProject({
    name: 'repo',
    source_type: 'git',
    repo_url: 'file:///tmp/repo.git',
    repo_ref: 'main',
  });
  projectBriefService.setPmThread(project.id, { pm_thread_id: 'thread-1', pm_adapter: 'codex' });

  assert.throws(
    () => projectService.updateProject(project.id, { repo_url: 'file:///tmp/other.git' }),
    (err) => err.httpStatus === 409 && /reset the operator before changing/.test(err.message),
  );
  assert.equal(projectService.getProject(project.id).source_generation, project.source_generation);
});

test('source_type changes are rejected while a live Operator run exists', async (t) => {
  const db = await mkdb(t);
  const runService = createRunService(db, null);
  const projectService = createProjectService(db);
  const project = projectService.createProject({ name: 'legacy', directory: '/tmp/legacy' });
  runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${project.id}`,
    manager_adapter: 'codex',
    prompt: 'operator',
  });

  assert.throws(
    () => projectService.updateProject(project.id, { source_type: 'git', repo_url: 'file:///tmp/repo.git' }),
    (err) => err.httpStatus === 409 && /current repo source/.test(err.message),
  );
});

test('repo source changes without an Operator bump source_generation', async (t) => {
  const db = await mkdb(t);
  const projectService = createProjectService(db);
  const project = projectService.createProject({
    name: 'repo-free',
    source_type: 'git',
    repo_url: 'file:///tmp/repo.git',
    repo_ref: 'main',
  });

  const updated = projectService.updateProject(project.id, { repo_ref: 'release' });

  assert.equal(updated.repo_ref, 'release');
  assert.equal(updated.source_generation, project.source_generation + 1);
});

test('source_type changes without an Operator bump source_generation', async (t) => {
  const db = await mkdb(t);
  const projectService = createProjectService(db);
  const project = projectService.createProject({ name: 'convert', directory: '/tmp/convert' });

  const updated = projectService.updateProject(project.id, {
    source_type: 'git',
    repo_url: 'file:///tmp/repo.git',
  });

  assert.equal(updated.source_type, 'git');
  assert.equal(updated.source_generation, project.source_generation + 1);
});

test('node rebinding guard still rejects stored Operator thread', async (t) => {
  const db = await mkdb(t);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = createNodeService(db, { localExecutor: { local: true } });
  createSshNode(nodeService, 'nodeA');
  const project = projectService.createProject({ name: 'node-guard', directory: '/tmp/node-guard' });
  projectBriefService.setPmThread(project.id, { pm_thread_id: 'thread-node', pm_adapter: 'codex' });

  assert.throws(
    () => projectService.updateProject(project.id, { node_id: 'nodeA' }),
    (err) => err.httpStatus === 409 && /reset the operator before rebinding/.test(err.message),
  );
});
