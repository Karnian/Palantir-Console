'use strict';

const { resolveSpawnCwd } = require('../utils/spawnCwd');
const { resolveProjectSource } = require('./projectSource');

function resolveRunWorkspace(run, project = {}) {
  void run;
  const source = resolveProjectSource(project);

  if (source.isRepo) {
    // Repo materialization is introduced in a later PR. Until then this helper
    // must not invent a workspace path for git-backed projects.
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
