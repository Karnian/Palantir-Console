'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveProjectSource } = require('../services/projectSource');
const { resolveRunWorkspace } = require('../services/workspaceResolver');
const { resolveSpawnCwd } = require('../utils/spawnCwd');

test('resolveProjectSource preserves legacy directory projects', () => {
  const source = resolveProjectSource({
    id: 'proj_legacy',
    directory: '/tmp/legacy-project',
  });

  assert.deepEqual(source, {
    sourceType: 'legacy_directory',
    isRepo: false,
    isLegacyDirectory: true,
    directory: '/tmp/legacy-project',
    repoUrl: null,
    repoRef: null,
    repoSubdir: null,
  });
});

test('resolveProjectSource exposes git source fields without consuming them', () => {
  const source = resolveProjectSource({
    id: 'proj_git',
    source_type: 'git',
    repo_url: 'https://example.test/repo.git',
    repo_ref: 'main',
    repo_subdir: 'packages/app',
    directory: '/legacy/ignored',
  });

  assert.deepEqual(source, {
    sourceType: 'git',
    isRepo: true,
    isLegacyDirectory: false,
    directory: null,
    repoUrl: 'https://example.test/repo.git',
    repoRef: 'main',
    repoSubdir: 'packages/app',
  });
});

test('resolveProjectSource defaults git repo_ref to HEAD', () => {
  const source = resolveProjectSource({
    source_type: 'git',
    repo_url: 'https://example.test/repo.git',
  });

  assert.equal(source.repoRef, 'HEAD');
});

test('resolveRunWorkspace matches legacy spawn cwd resolution', () => {
  const project = {
    id: 'proj_legacy',
    source_type: 'legacy_directory',
    directory: '/tmp/legacy-workspace',
  };
  const result = resolveRunWorkspace({ id: 'run_1' }, project);

  assert.deepEqual(result, {
    cwd: resolveSpawnCwd({ workspaceDir: project.directory }),
    isMaterialized: false,
  });
});

test('resolveRunWorkspace keeps legacy no-directory fallback behavior', () => {
  const result = resolveRunWorkspace({ id: 'run_2' }, {
    id: 'proj_no_dir',
    source_type: 'legacy_directory',
    directory: null,
  });

  assert.deepEqual(result, {
    cwd: resolveSpawnCwd({ workspaceDir: null }),
    isMaterialized: false,
  });
});
