'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createProjectService } = require('../services/projectService');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-project-service-repo-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

test('createProject stores git repo source fields', async (t) => {
  const db = await mkdb(t);
  const projectService = createProjectService(db);

  const project = projectService.createProject({
    name: 'Git Project',
    source_type: 'git',
    repo_url: 'git@github.com:acme/repo.git',
    repo_ref: 'main',
    repo_subdir: 'apps/api',
    mcp_config_source: 'repo_relpath',
    mcp_config_relpath: 'config/mcp.json',
    repo_remote_fingerprint: '0123456789abcdef0123456789abcdef01234567',
    last_repo_preflight_at: '2026-07-05T00:00:00.000Z',
  });

  const row = projectService.getProject(project.id);
  assert.equal(row.source_type, 'git');
  assert.equal(row.repo_url, 'git@github.com:acme/repo.git');
  assert.equal(row.repo_ref, 'main');
  assert.equal(row.repo_subdir, 'apps/api');
  assert.equal(row.mcp_config_source, 'repo_relpath');
  assert.equal(row.mcp_config_relpath, 'config/mcp.json');
  assert.equal(row.repo_remote_fingerprint, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(row.last_repo_preflight_at, '2026-07-05T00:00:00.000Z');
  assert.equal(row.source_generation, 0);
});

test('updateProject bumps source_generation when repo_ref changes', async (t) => {
  const db = await mkdb(t);
  const projectService = createProjectService(db);
  const project = projectService.createProject({
    name: 'Git Project',
    source_type: 'git',
    repo_url: 'git@github.com:acme/repo.git',
    repo_ref: 'main',
  });

  const updated = projectService.updateProject(project.id, { repo_ref: 'release' });
  assert.equal(updated.repo_ref, 'release');
  assert.equal(updated.source_generation, 1);

  const metadataOnly = projectService.updateProject(project.id, {
    last_repo_preflight_at: '2026-07-05T00:00:00.000Z',
    repo_remote_fingerprint: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  });
  assert.equal(metadataOnly.source_generation, 1);
});

test('legacy_directory creation preserves legacy fields and defaults repo metadata', async (t) => {
  const db = await mkdb(t);
  const projectService = createProjectService(db);

  const project = projectService.createProject({
    name: 'Legacy Project',
    directory: '/tmp/legacy-repo',
    allow_non_git_dir: 1,
    mcp_config_path: '/tmp/mcp.json',
  });

  assert.equal(project.source_type, 'legacy_directory');
  assert.equal(project.directory, '/tmp/legacy-repo');
  assert.equal(project.allow_non_git_dir, 1);
  assert.equal(project.mcp_config_path, '/tmp/mcp.json');
  assert.equal(project.repo_url, null);
  assert.equal(project.repo_ref, 'HEAD');
  assert.equal(project.source_generation, 0);
  assert.equal(project.mcp_config_source, 'legacy_control_plane_path');
});

test('service remains permissive for mixed source fields; route validation owns rejection', async (t) => {
  const db = await mkdb(t);
  const projectService = createProjectService(db);

  const project = projectService.createProject({
    name: 'Mixed Project',
    source_type: 'git',
    repo_url: 'git@github.com:acme/repo.git',
    directory: '/tmp/legacy-repo',
  });

  assert.equal(project.source_type, 'git');
  assert.equal(project.repo_url, 'git@github.com:acme/repo.git');
  assert.equal(project.directory, '/tmp/legacy-repo');
});
