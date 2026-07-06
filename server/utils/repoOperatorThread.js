'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function repoFeatureEnabled() {
  return process.env.PALANTIR_PROJECT_REPO === '1';
}

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

function repoSourceHash(project = {}) {
  // Capture every field that makes a stored operator thread stale: repo
  // identity (url/ref/subdir) AND the MCP source (source enum + relpath). If
  // any of these change the operator must not resume against the old thread
  // (Codex PR5 review SERIOUS — mcp_config_source/relpath were previously
  // absent from the hash, so a missed generation bump would go undetected).
  const payload = {
    repo_url: project.repo_url || null,
    repo_ref: project.repo_ref || 'HEAD',
    repo_subdir: project.repo_subdir || null,
    mcp_config_source: project.mcp_config_source || 'legacy_control_plane_path',
    mcp_config_relpath: project.mcp_config_relpath || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function cwdFromWorkspacePath(workspacePath, project = {}) {
  if (!workspacePath) return null;
  const subdir = normalizeRepoSubdir(project.repo_subdir || null);
  return subdir ? path.join(workspacePath, subdir) : workspacePath;
}

function resolveMaterializedRepoCwd(run, project = {}) {
  if (!run?.workspace_path || !run.resolved_commit) return null;
  const sourceGeneration = Number(project?.source_generation || 0);
  if (Number(run.workspace_generation) !== sourceGeneration) return null;
  const subdir = normalizeRepoSubdir(run.repo_subdir_snapshot || project?.repo_subdir || null);
  return subdir ? path.join(run.workspace_path, subdir) : run.workspace_path;
}

function repoThreadSourceReset(brief, project = {}) {
  if (!brief?.pm_thread_id) return null;
  const fromGeneration = brief.pm_thread_source_generation;
  const toGeneration = Number(project.source_generation || 0);
  const base = () => ({
    from_generation: fromGeneration == null ? null : Number(fromGeneration),
    to_generation: toGeneration,
  });
  // Each branch tags a distinct reason so a reset is diagnosable when the
  // generation happens to match (Codex PR5 review NIT).
  if (Number(fromGeneration) !== toGeneration) {
    return { ...base(), reason: 'generation_mismatch' };
  }
  // Hash guard: even when the generation matches, a content change that failed
  // to bump the generation (e.g. direct DB edit) still makes the thread stale.
  const storedHash = brief.pm_thread_source_hash || null;
  if (storedHash && storedHash !== repoSourceHash(project)) {
    return { ...base(), reason: 'hash_mismatch' };
  }
  const workspacePath = brief.pm_thread_workspace_path || null;
  const expectedCwd = cwdFromWorkspacePath(workspacePath, project);
  if (!workspacePath || !expectedCwd) {
    return { ...base(), reason: 'workspace_missing' };
  }
  if (brief.pm_thread_cwd && brief.pm_thread_cwd !== expectedCwd) {
    return { ...base(), reason: 'cwd_mismatch' };
  }
  return null;
}

module.exports = {
  repoFeatureEnabled,
  normalizeRepoSubdir,
  repoSourceHash,
  cwdFromWorkspacePath,
  resolveMaterializedRepoCwd,
  repoThreadSourceReset,
};
