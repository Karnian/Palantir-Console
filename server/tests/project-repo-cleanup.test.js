'use strict';

// PR7 (Project Repo-Defined cleanup): pins the wrap-up / rollback guarantees.
//   1. a git project stores directory NULL (repo directory is not written).
//   2. resolveProjectSource is FLAG-INDEPENDENT: PALANTIR_PROJECT_REPO gates
//      only the materialize/execution path, never a project's classification —
//      so turning the flag off leaves both legacy and git rows untouched
//      (rollback = legacy無손상, repo row preserved, just inert).
// Route-layer coherence (directory rejected for git, legacy→git transition
// clearing) is already covered by projects-route / project-source-reset-guard;
// this file guards only the storage + flag-independence facts to avoid dup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createProjectService } = require('../services/projectService');
const { resolveProjectSource } = require('../services/projectSource');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-project-repo-cleanup-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

test('git project stores directory NULL', async (t) => {
  const svc = createProjectService(await mkdb(t));
  const project = svc.createProject({
    name: 'Repo A',
    source_type: 'git',
    repo_url: 'https://github.com/octocat/Hello-World.git',
    repo_ref: 'main',
  });
  assert.equal(project.source_type, 'git');
  assert.equal(project.directory, null);
  const src = resolveProjectSource(project);
  assert.equal(src.isRepo, true);
  assert.equal(src.directory, null);
  assert.equal(src.repoUrl, 'https://github.com/octocat/Hello-World.git');
});

test('rollback: resolveProjectSource is flag-independent for a legacy project', async (t) => {
  const svc = createProjectService(await mkdb(t));
  const legacy = svc.createProject({ name: 'Legacy', directory: '/srv/app' });
  assert.equal(legacy.source_type, 'legacy_directory');

  const prev = process.env.PALANTIR_PROJECT_REPO;
  try {
    process.env.PALANTIR_PROJECT_REPO = '1';
    const on = resolveProjectSource(svc.getProject(legacy.id));
    delete process.env.PALANTIR_PROJECT_REPO;
    const off = resolveProjectSource(svc.getProject(legacy.id));
    assert.deepEqual(on, off);
    assert.equal(off.isLegacyDirectory, true);
    assert.equal(off.directory, '/srv/app');
  } finally {
    if (prev === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev;
  }
});

test('rollback: a git project row survives flag-off (classified isRepo, execution gated elsewhere)', async (t) => {
  const svc = createProjectService(await mkdb(t));
  const repo = svc.createProject({
    name: 'Repo B',
    source_type: 'git',
    repo_url: 'https://github.com/octocat/Hello-World.git',
    repo_ref: 'HEAD',
  });

  const prev = process.env.PALANTIR_PROJECT_REPO;
  try {
    // The flag being off must NOT mutate or reclassify the row — the repo
    // project is preserved verbatim and merely inert until the flag is on.
    delete process.env.PALANTIR_PROJECT_REPO;
    const off = resolveProjectSource(svc.getProject(repo.id));
    assert.equal(off.isRepo, true);
    assert.equal(off.repoUrl, 'https://github.com/octocat/Hello-World.git');
    assert.equal(off.directory, null);
  } finally {
    if (prev === undefined) delete process.env.PALANTIR_PROJECT_REPO;
    else process.env.PALANTIR_PROJECT_REPO = prev;
  }
});
