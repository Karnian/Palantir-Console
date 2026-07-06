'use strict';

const path = require('node:path');
const { resolveSpawnCwd } = require('../utils/spawnCwd');
const { resolveProjectSource } = require('./projectSource');

function normalizeRepoSubdir(subdir) {
  if (!subdir) return null;
  const raw = String(subdir).trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) throw new Error('repo_subdir must be relative');
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('repo_subdir escapes repository root');
  }
  return parts.join(path.sep);
}

function resolveRunWorkspace(run, project = {}) {
  const source = resolveProjectSource(project);

  if (source.isRepo) {
    const generation = Number(project.source_generation || 0);
    if (
      run?.workspace_path
      && run.resolved_commit
      && Number(run.workspace_generation) === generation
    ) {
      const subdir = normalizeRepoSubdir(run.repo_subdir_snapshot || source.repoSubdir);
      const workspaceDir = subdir ? path.join(run.workspace_path, subdir) : run.workspace_path;
      return {
        cwd: resolveSpawnCwd({ workspaceDir }),
        workspacePath: run.workspace_path,
        resolvedCommit: run.resolved_commit,
        isMaterialized: true,
      };
    }
    return { cwd: resolveSpawnCwd({}), isMaterialized: false };
  }

  return {
    cwd: resolveSpawnCwd({ workspaceDir: source.directory }),
    isMaterialized: false,
  };
}

module.exports = {
  resolveRunWorkspace,
};
