'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveProjectSource } = require('./projectSource');

const DEFAULT_GIT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_STALE_MS = 10 * 60 * 1000;

function repoFeatureEnabled() {
  return process.env.PALANTIR_PROJECT_REPO === '1';
}

function safeSegment(value, fallback = 'repo') {
  const raw = String(value || fallback).trim();
  const clean = raw
    .replace(/\\/g, '-')
    .replace(/\//g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 8);
}

function homePath(...parts) {
  return path.join(os.homedir(), '.palantir', ...parts);
}

function workspaceRoot() {
  return process.env.PALANTIR_WORKSPACES || homePath('workspaces');
}

function repoCacheRoot() {
  return process.env.PALANTIR_REPO_CACHE || homePath('repo-cache');
}

function assertRelativeSubdir(subdir) {
  if (!subdir) return null;
  const normalized = String(subdir).trim();
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) throw new Error('repo_subdir must be relative');
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('repo_subdir escapes repository root');
  }
  return parts.join(path.sep);
}

function buildPaths({ project, nodeId, source }) {
  const gen = Number(project.source_generation || 0);
  const fp = fingerprint(source.repoUrl);
  const ref = safeSegment(source.repoRef || 'HEAD', 'HEAD');
  const projectSlug = safeSegment(project.id || project.name || 'project', 'project');
  const nodeSlug = safeSegment(nodeId || 'local', 'local');
  const cachePath = path.join(repoCacheRoot(), `${projectSlug}-${nodeSlug}-${gen}-${fp}.gitcache`);
  const workspaceSlug = `${projectSlug}-${fp}-${ref}`;
  return {
    cachePath,
    workspaceBase: path.join(workspaceRoot(), workspaceSlug),
  };
}

function buildAttemptWorkspacePath({ workspaceBase, runId, claimToken }) {
  const runSlug = safeSegment(runId, 'run');
  const tokenSlug = safeSegment(claimToken, 'attempt');
  return path.join(workspaceBase, `${runSlug}-${tokenSlug}`);
}

function commandError(command, args, result) {
  const msg = `${command} ${args.join(' ')} failed (${result.code}): ${String(result.stderr || result.stdout || '').trim()}`;
  return new Error(msg.slice(0, 2000));
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}

function createProjectMaterializationService({
  runService,
  projectService,
  nodeService,
  eventBus,
  logger = console,
  gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  leaseStaleMs = DEFAULT_LEASE_STALE_MS,
} = {}) {
  if (!runService) throw new Error('runService is required');
  const effectiveLeaseStaleMs = Math.max(
    Number(leaseStaleMs || 0),
    Number(gitTimeoutMs || DEFAULT_GIT_TIMEOUT_MS) * 2 + 60000,
  );
  // NOTE: nodeService.pickExecutor is required only to actually materialize
  // (ensureWorkspace → executorForNode), which happens exclusively when the
  // PALANTIR_PROJECT_REPO feature is on. Do NOT require it at construction:
  // lifecycleService constructs this service unconditionally, and many queue/
  // drain/sweep test harnesses (and flag-off production) wire a nodeService
  // without pickExecutor. Deferring the check keeps flag-off byte-compatible.

  function executorForNode(nodeId) {
    if (!nodeService || typeof nodeService.pickExecutor !== 'function') {
      throw new Error('nodeService.pickExecutor is required to materialize a repo workspace');
    }
    return nodeService.pickExecutor(nodeId || 'local');
  }

  async function git(executor, args, { cwd } = {}) {
    const result = await executor.exec('git', args, {
      cwd,
      timeoutMs: gitTimeoutMs,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        LANG: 'C',
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    return result;
  }

  async function pathExists(executor, target) {
    if (executor && typeof executor.fileExists === 'function') {
      return executor.fileExists(target);
    }
    return fs.existsSync(target);
  }

  async function cacheLooksValid({ executor, cachePath }) {
    if (!await pathExists(executor, cachePath)) return false;
    try {
      const result = await git(executor, ['rev-parse', '--git-dir'], { cwd: cachePath });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async function cloneAtomic({ executor, repoUrl, cachePath, replaceInvalid = false }) {
    await ensureDir(path.dirname(cachePath));
    const tmpPath = `${cachePath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    await fsp.rm(tmpPath, { recursive: true, force: true });
    try {
      const clone = await git(executor, ['clone', '--no-checkout', repoUrl, tmpPath], { cwd: path.dirname(cachePath) });
      if (clone.code !== 0) throw commandError('git', ['clone', '--no-checkout', repoUrl, tmpPath], clone);
      if (replaceInvalid && await pathExists(executor, cachePath)) {
        if (await cacheLooksValid({ executor, cachePath })) {
          await fsp.rm(tmpPath, { recursive: true, force: true });
          return { cloned: false, reusedValidCache: true };
        }
        await fsp.rm(cachePath, { recursive: true, force: true });
      }
      await fsp.rename(tmpPath, cachePath);
      return { cloned: true };
    } catch (err) {
      await fsp.rm(tmpPath, { recursive: true, force: true });
      throw err;
    }
  }

  async function cloneOrFetch({ executor, repoUrl, cachePath, touchLease }) {
    await ensureDir(path.dirname(cachePath));
    if (await cacheLooksValid({ executor, cachePath })) {
      if (touchLease) touchLease();
      const fetch = await git(executor, ['fetch', '--all', '--tags', '--prune'], { cwd: cachePath });
      if (fetch.code !== 0) throw commandError('git', ['fetch', '--all', '--tags', '--prune'], fetch);
      if (touchLease) touchLease();
      return { cloned: false };
    }
    if (touchLease) touchLease();
    const replaceInvalid = await pathExists(executor, cachePath);
    const cloned = await cloneAtomic({ executor, repoUrl, cachePath, replaceInvalid });
    if (touchLease) touchLease();
    return cloned;
  }

  async function resolveCommit({ executor, repoUrl, cachePath, ref }) {
    const requested = ref || 'HEAD';
    const revParse = await git(executor, ['rev-parse', '--verify', `${requested}^{commit}`], { cwd: cachePath });
    if (revParse.code === 0 && revParse.stdout.trim()) return revParse.stdout.trim().split(/\s+/)[0];

    const remote = await git(executor, ['ls-remote', repoUrl, requested], { cwd: cachePath });
    if (remote.code !== 0) throw commandError('git', ['rev-parse', '--verify', `${requested}^{commit}`], revParse);
    const first = remote.stdout.trim().split(/\s+/)[0];
    if (!/^[0-9a-fA-F]{40}$/.test(first)) {
      throw new Error(`Unable to resolve git ref: ${requested}`);
    }
    const fetch = await git(executor, ['fetch', 'origin', first], { cwd: cachePath });
    if (fetch.code !== 0) throw commandError('git', ['fetch', 'origin', first], fetch);
    return first;
  }

  async function materializeCache({ project, nodeId, source, cachePath, executor, runId, currentReady }) {
    const sourceGeneration = Number(project.source_generation || 0);
    const lease = runService.acquireMaterializationLease({
      projectId: project.id,
      nodeId,
      sourceGeneration,
      ownerRunId: runId,
      staleMs: effectiveLeaseStaleMs,
    });
    if (!lease.acquired) {
      if (currentReady && currentReady.status === 'ready' && currentReady.repo_cache_path && currentReady.resolved_commit) {
        return { ready: currentReady, leaseSkipped: true };
      }
      return { pending: true, backoffMs: 1000 };
    }

    try {
      const effectiveCachePath = currentReady?.repo_cache_path || cachePath;
      const touchLease = () => {
        if (typeof runService.touchMaterializationLease === 'function') {
          runService.touchMaterializationLease(lease.token);
        }
      };
      await cloneOrFetch({ executor, repoUrl: source.repoUrl, cachePath: effectiveCachePath, touchLease });
      touchLease();
      const resolvedCommit = await resolveCommit({
        executor,
        repoUrl: source.repoUrl,
        cachePath: effectiveCachePath,
        ref: source.repoRef || 'HEAD',
      });
      touchLease();
      const ready = runService.markProjectNodeWorkspaceReady({
        project_id: project.id,
        node_id: nodeId,
        source_generation: sourceGeneration,
        repo_url: source.repoUrl,
        repo_ref: source.repoRef || 'HEAD',
        resolved_commit: resolvedCommit,
        repo_cache_path: effectiveCachePath,
      });
      runService.releaseMaterializationLease(lease.token, { status: 'completed' });
      return { ready };
    } catch (err) {
      runService.markProjectNodeWorkspaceFailed({
        project_id: project.id,
        node_id: nodeId,
        source_generation: sourceGeneration,
        repo_url: source.repoUrl,
        repo_ref: source.repoRef || 'HEAD',
        repo_cache_path: currentReady?.repo_cache_path || cachePath,
        last_error: err.message,
      });
      runService.releaseMaterializationLease(lease.token, { status: 'failed', error: err });
      throw err;
    }
  }

  async function addRunWorktree({ executor, cachePath, workspacePath, resolvedCommit }) {
    await ensureDir(path.dirname(workspacePath));
    await pruneWorktrees({ executor, cachePath });
    if (await pathExists(executor, workspacePath)) {
      await fsp.rm(workspacePath, { recursive: true, force: true });
      await pruneWorktrees({ executor, cachePath });
    }
    const result = await git(executor, ['worktree', 'add', workspacePath, resolvedCommit], { cwd: cachePath });
    if (result.code !== 0) {
      const err = commandError('git', ['worktree', 'add', workspacePath, resolvedCommit], result);
      await cleanupRunWorktree({ executor, cachePath, workspacePath });
      throw err;
    }
  }

  async function pruneWorktrees({ executor, cachePath }) {
    try {
      await git(executor, ['worktree', 'prune'], { cwd: cachePath });
    } catch {
      // Prune is best-effort cleanup.
    }
  }

  async function cleanupRunWorktree({ executor, cachePath, workspacePath }) {
    let removed = false;
    if (cachePath) {
      try {
        const result = await git(executor, ['worktree', 'remove', '--force', workspacePath], { cwd: cachePath });
        removed = result.code === 0;
      } catch {
        // Fall back to filesystem cleanup below.
      }
    }
    if (!removed) await fsp.rm(workspacePath, { recursive: true, force: true });
    if (cachePath) await pruneWorktrees({ executor, cachePath });
  }

  async function cleanupAttemptResources({ run, project, nodeId = 'local', claimToken = null } = {}) {
    const effectiveRun = run || null;
    const effectiveClaimToken = claimToken || effectiveRun?.materialize_claim_token || null;
    if (!effectiveRun?.id || !effectiveClaimToken) return false;
    const effectiveProject = project || (effectiveRun.project_id && projectService
      ? projectService.getProject(effectiveRun.project_id)
      : null);
    const source = resolveProjectSource(effectiveProject || {});
    if (!source.isRepo || !source.repoUrl) return false;

    let node = { kind: 'local' };
    if (nodeService?.getNode) {
      try {
        node = nodeService.getNode(nodeId || effectiveRun.node_id || 'local');
      } catch (err) {
        if ((nodeId || effectiveRun.node_id || 'local') !== 'local') throw err;
      }
    }
    if (node && (node.kind || 'local') !== 'local') return false;

    const executor = executorForNode(nodeId || effectiveRun.node_id || 'local');
    const sourceGeneration = Number(effectiveProject.source_generation || effectiveRun.run_source_generation || 0);
    const { cachePath, workspaceBase } = buildPaths({
      project: effectiveProject,
      nodeId: nodeId || effectiveRun.node_id || 'local',
      source,
    });
    const ready = runService.getProjectNodeWorkspace(
      effectiveProject.id,
      nodeId || effectiveRun.node_id || 'local',
      sourceGeneration,
    );
    const workspacePath = buildAttemptWorkspacePath({
      workspaceBase,
      runId: effectiveRun.id,
      claimToken: effectiveClaimToken,
    });
    if (typeof runService.releaseWorkspaceRefByRunAndPath === 'function') {
      runService.releaseWorkspaceRefByRunAndPath(effectiveRun.id, workspacePath);
    }
    await cleanupRunWorktree({
      executor,
      cachePath: ready?.repo_cache_path || effectiveRun.repo_cache_path || cachePath,
      workspacePath,
    });
    return true;
  }

  async function ensureWorkspace({ project, nodeId = 'local', runId, claimToken = null }) {
    if (!repoFeatureEnabled()) throw new Error('project repo materialization is disabled');
    const run = runService.getRun(runId);
    const effectiveClaimToken = claimToken || run.materialize_claim_token || null;
    if (!effectiveClaimToken) throw new Error('materialization claim token is required');
    const effectiveProject = project || (run.project_id && projectService ? projectService.getProject(run.project_id) : null);
    const source = resolveProjectSource(effectiveProject || {});
    if (!source.isRepo) {
      const marked = runService.markMaterializedReady(runId, effectiveClaimToken);
      if (!marked) return { stale: true, ready: false };
      return { ready: true, skipped: true };
    }
    if (!source.repoUrl) throw new Error('repo_url is required for git project materialization');
    const repoSubdir = assertRelativeSubdir(source.repoSubdir);

    let node = { kind: 'local' };
    if (nodeService.getNode) {
      try {
        node = nodeService.getNode(nodeId || 'local');
      } catch (err) {
        if ((nodeId || 'local') !== 'local') throw err;
      }
    }
    if (node && (node.kind || 'local') !== 'local') {
      return { pending: false, unsupported: true, error: 'repo materialization is unsupported on remote nodes' };
    }

    const executor = executorForNode(nodeId);
    const sourceGeneration = Number(effectiveProject.source_generation || 0);
    const { cachePath, workspaceBase } = buildPaths({ project: effectiveProject, nodeId, source });
    let ready = runService.getProjectNodeWorkspace(effectiveProject.id, nodeId || 'local', sourceGeneration);

    let workspacePath = null;
    let worktreeAdded = false;
    let durableReady = false;
    try {
      const cache = await materializeCache({
        project: effectiveProject,
        nodeId: nodeId || 'local',
        source,
        cachePath,
        executor,
        runId,
        currentReady: ready,
      });
      if (cache.pending) {
        runService.markMaterializePending(runId, { backoffMs: cache.backoffMs, token: effectiveClaimToken });
        return cache;
      }
      ready = cache.ready;

      workspacePath = buildAttemptWorkspacePath({
        workspaceBase,
        runId,
        claimToken: effectiveClaimToken,
      });
      await addRunWorktree({
        executor,
        cachePath: ready.repo_cache_path,
        workspacePath,
        resolvedCommit: ready.resolved_commit,
      });
      worktreeAdded = true;
      const materialized = runService.updateRunMaterialized(runId, {
        materialize_claim_token: effectiveClaimToken,
        source_type_snapshot: 'git',
        run_source_generation: sourceGeneration,
        repo_url_snapshot: source.repoUrl,
        repo_ref_snapshot: source.repoRef || 'HEAD',
        repo_subdir_snapshot: source.repoSubdir || null,
        repo_cache_path: ready.repo_cache_path,
        workspace_path: workspacePath,
        workspace_generation: sourceGeneration,
        resolved_commit: ready.resolved_commit,
      });
      if (!materialized) {
        await cleanupRunWorktree({ executor, cachePath: ready.repo_cache_path, workspacePath });
        return { stale: true, ready: false };
      }
      durableReady = true;
      try {
        runService.acquireWorkspaceRef({
          runId,
          projectId: effectiveProject.id,
          nodeId: nodeId || 'local',
          sourceGeneration,
          repoCachePath: ready.repo_cache_path,
          worktreePath: workspacePath,
          refType: 'run',
        });
      } catch (refErr) {
        logger.warn(`[materialize] run ${runId} ready without workspace ref: ${refErr.message}`);
      }
      const payload = {
        run_id: runId,
        project_id: effectiveProject.id,
        node_id: nodeId || 'local',
        resolved_commit: ready.resolved_commit,
      };
      runService.addRunEvent(runId, 'materialize:ready', JSON.stringify(payload));
      if (eventBus) eventBus.emit('materialize:ready', payload);
      return {
        ready: true,
        run: runService.getRun(runId),
        workspacePath,
        cwd: repoSubdir ? path.join(workspacePath, repoSubdir) : workspacePath,
        resolvedCommit: ready.resolved_commit,
      };
    } catch (err) {
      if (!durableReady && worktreeAdded && workspacePath && ready?.repo_cache_path) {
        try {
          await cleanupRunWorktree({ executor, cachePath: ready.repo_cache_path, workspacePath });
        } catch { /* ignore cleanup failure; lifecycle owns retry/fail policy */ }
      }
      logger.warn(`[materialize] run ${runId} failed: ${err.message}`);
      throw err;
    }
  }

  return {
    ensureWorkspace,
    cleanupAttemptResources,
    buildPaths,
    buildAttemptWorkspacePath,
    getConfig() {
      return { gitTimeoutMs, leaseStaleMs, effectiveLeaseStaleMs };
    },
  };
}

module.exports = {
  createProjectMaterializationService,
};
