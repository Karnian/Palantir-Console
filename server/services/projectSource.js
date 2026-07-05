'use strict';

const SOURCE_TYPE = Object.freeze({
  GIT: 'git',
  LEGACY_DIRECTORY: 'legacy_directory',
});

function resolveProjectSource(project = {}) {
  const sourceType = project.source_type || SOURCE_TYPE.LEGACY_DIRECTORY;

  if (sourceType === SOURCE_TYPE.GIT) {
    return {
      sourceType,
      isRepo: true,
      isLegacyDirectory: false,
      directory: null,
      repoUrl: project.repo_url ?? null,
      repoRef: project.repo_ref || 'HEAD',
      repoSubdir: project.repo_subdir ?? null,
    };
  }

  if (sourceType !== SOURCE_TYPE.LEGACY_DIRECTORY) {
    throw new Error(`Unsupported project source_type: ${sourceType}`);
  }

  return {
    sourceType,
    isRepo: false,
    isLegacyDirectory: true,
    directory: project.directory ?? null,
    repoUrl: null,
    repoRef: null,
    repoSubdir: null,
  };
}

module.exports = {
  SOURCE_TYPE,
  resolveProjectSource,
};
