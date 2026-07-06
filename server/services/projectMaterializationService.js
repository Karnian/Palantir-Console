'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
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

function unsupportedMaterialization(message) {
  const err = new Error(message);
  err.code = 'MATERIALIZE_UNSUPPORTED';
  return err;
}

function parseExposedRoots(node) {
  let roots;
  try {
    roots = Array.isArray(node?.exposed_roots)
      ? node.exposed_roots
      : JSON.parse(node?.exposed_roots || 'null');
  } catch {
    throw unsupportedMaterialization(`SSH node ${node?.id || '(unknown)'} has invalid exposed_roots JSON`);
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    throw unsupportedMaterialization(`SSH node ${node?.id || '(unknown)'} must declare exposed_roots`);
  }
  for (const root of roots) {
    if (typeof root !== 'string' || !path.posix.isAbsolute(root)) {
      throw unsupportedMaterialization('exposed_roots must contain absolute remote paths');
    }
  }
  return roots;
}

function nodePathConfig(node) {
  if (!node || (node.kind || 'local') === 'local') {
    return {
      join: path.join,
      workspaceRoot: workspaceRoot(),
      repoCacheRoot: repoCacheRoot(),
    };
  }
  const firstRoot = parseExposedRoots(node)[0];
  return {
    join: path.posix.join,
    workspaceRoot: path.posix.join(firstRoot, '.palantir-workspaces'),
    repoCacheRoot: path.posix.join(firstRoot, '.palantir-repo-cache'),
  };
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

function buildPaths({ project, nodeId, source, node = null }) {
  const gen = Number(project.source_generation || 0);
  const fp = fingerprint(source.repoUrl);
  const ref = safeSegment(source.repoRef || 'HEAD', 'HEAD');
  const projectSlug = safeSegment(project.id || project.name || 'project', 'project');
  const nodeSlug = safeSegment(nodeId || 'local', 'local');
  const pathConfig = nodePathConfig(node);
  const cachePath = pathConfig.join(pathConfig.repoCacheRoot, `${projectSlug}-${nodeSlug}-${gen}-${fp}.gitcache`);
  const workspaceSlug = `${projectSlug}-${fp}-${ref}`;
  return {
    cachePath,
    workspaceBase: pathConfig.join(pathConfig.workspaceRoot, workspaceSlug),
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

function requireExecutorMethod(executor, method) {
  if (!executor || typeof executor[method] !== 'function') {
    throw new Error(`Node executor is missing required method: ${method}`);
  }
  return executor[method].bind(executor);
}

async function ensureDir(executor, dir) {
  await requireExecutorMethod(executor, 'mkdir')(dir, { recursive: true, mode: 0o700 });
}

async function removePath(executor, target) {
  await requireExecutorMethod(executor, 'rmrf')(target);
}

async function movePath(executor, src, dst) {
  await requireExecutorMethod(executor, 'move')(src, dst);
}

function pathDirnameFor(target) {
  return target.includes('\\') ? path.dirname(target) : path.posix.dirname(target);
}

function pathJoinFor(base, subdir) {
  return base.includes('\\') ? path.join(base, subdir) : path.posix.join(base, subdir);
}

function isRemoteNode(node) {
  return Boolean(node && (node.kind || 'local') !== 'local');
}

function requireRemoteRootGuard(executor, node) {
  if (isRemoteNode(node) && (!executor || typeof executor.assertWithinRoots !== 'function')) {
    throw new Error('remote repo materialization requires executor.assertWithinRoots');
  }
}

async function canonicalTargetForWrite(executor, node, target) {
  if (!isRemoteNode(node)) return target;
  requireRemoteRootGuard(executor, node);
  const safeTarget = await executor.assertWithinRoots(target, { allowMissing: true });
  if (!safeTarget) throw new Error(`remote write target cannot be canonicalized within exposed_roots: ${target}`);
  return safeTarget;
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
        GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
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

  async function cloneAtomic({ executor, node, repoUrl, cachePath, replaceInvalid = false }) {
    const cacheParent = pathDirnameFor(cachePath);
    await canonicalTargetForWrite(executor, node, cacheParent);
    await ensureDir(executor, cacheParent);
    const safeCachePath = await canonicalTargetForWrite(executor, node, cachePath);
    const tmpPath = `${cachePath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const safeTmpPath = await canonicalTargetForWrite(executor, node, tmpPath);
    await removePath(executor, safeTmpPath);
    try {
      const cloneArgs = ['clone', '--no-checkout', '--', repoUrl, safeTmpPath];
      const clone = await git(executor, cloneArgs, { cwd: pathDirnameFor(safeCachePath) });
      if (clone.code !== 0) throw commandError('git', cloneArgs, clone);
      if (replaceInvalid && await pathExists(executor, safeCachePath)) {
        if (await cacheLooksValid({ executor, cachePath: safeCachePath })) {
          await removePath(executor, safeTmpPath);
          return { cloned: false, reusedValidCache: true, cachePath: safeCachePath };
        }
        await removePath(executor, safeCachePath);
      }
      await movePath(executor, safeTmpPath, safeCachePath);
      return { cloned: true, cachePath: safeCachePath };
    } catch (err) {
      await removePath(executor, safeTmpPath);
      throw err;
    }
  }

  async function cloneOrFetch({ executor, node, repoUrl, cachePath, touchLease }) {
    const cacheParent = pathDirnameFor(cachePath);
    await canonicalTargetForWrite(executor, node, cacheParent);
    await ensureDir(executor, cacheParent);
    const safeCachePath = await canonicalTargetForWrite(executor, node, cachePath);
    if (await cacheLooksValid({ executor, cachePath: safeCachePath })) {
      if (touchLease) touchLease();
      const fetch = await git(executor, ['fetch', '--all', '--tags', '--prune'], { cwd: safeCachePath });
      if (fetch.code !== 0) throw commandError('git', ['fetch', '--all', '--tags', '--prune'], fetch);
      if (touchLease) touchLease();
      return { cloned: false, cachePath: safeCachePath };
    }
    if (touchLease) touchLease();
    const replaceInvalid = await pathExists(executor, safeCachePath);
    const cloned = await cloneAtomic({ executor, node, repoUrl, cachePath, replaceInvalid });
    if (touchLease) touchLease();
    return cloned;
  }

  async function resolveCommit({ executor, repoUrl, cachePath, ref }) {
    const requested = ref || 'HEAD';
    const revParseArgs = ['rev-parse', '--verify', '--end-of-options', `${requested}^{commit}`];
    const revParse = await git(executor, revParseArgs, { cwd: cachePath });
    if (revParse.code === 0 && revParse.stdout.trim()) return revParse.stdout.trim().split(/\s+/)[0];

    const lsRemoteArgs = ['ls-remote', '--', repoUrl, requested];
    const remote = await git(executor, lsRemoteArgs, { cwd: cachePath });
    if (remote.code !== 0) throw commandError('git', revParseArgs, revParse);
    const first = remote.stdout.trim().split(/\s+/)[0];
    if (!/^[0-9a-fA-F]{40}$/.test(first)) {
      throw new Error(`Unable to resolve git ref: ${requested}`);
    }
    const fetchArgs = ['fetch', 'origin', '--', first];
    const fetch = await git(executor, fetchArgs, { cwd: cachePath });
    if (fetch.code !== 0) throw commandError('git', fetchArgs, fetch);
    return first;
  }

  async function materializeCache({ project, node, nodeId, source, cachePath, executor, runId, currentReady }) {
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
      const materializedCache = await cloneOrFetch({
        executor,
        node,
        repoUrl: source.repoUrl,
        cachePath: effectiveCachePath,
        touchLease,
      });
      const readyCachePath = materializedCache.cachePath || effectiveCachePath;
      touchLease();
      const resolvedCommit = await resolveCommit({
        executor,
        repoUrl: source.repoUrl,
        cachePath: readyCachePath,
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
        repo_cache_path: readyCachePath,
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

  async function addRunWorktree({ executor, node, cachePath, workspacePath, resolvedCommit }) {
    const workspaceParent = pathDirnameFor(workspacePath);
    await canonicalTargetForWrite(executor, node, workspaceParent);
    await ensureDir(executor, workspaceParent);
    const safeWorkspacePath = await canonicalTargetForWrite(executor, node, workspacePath);
    await pruneWorktrees({ executor, cachePath });
    if (await pathExists(executor, safeWorkspacePath)) {
      await removePath(executor, safeWorkspacePath);
      await pruneWorktrees({ executor, cachePath });
    }
    const worktreeArgs = ['worktree', 'add', '--', safeWorkspacePath, resolvedCommit];
    const result = await git(executor, worktreeArgs, { cwd: cachePath });
    if (result.code !== 0) {
      const err = commandError('git', worktreeArgs, result);
      await cleanupRunWorktree({ executor, cachePath, workspacePath: safeWorkspacePath });
      throw err;
    }
    return safeWorkspacePath;
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
    if (!removed) await removePath(executor, workspacePath);
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
    const sourceGeneration = Number(effectiveProject.source_generation || effectiveRun.run_source_generation || 0);
    let cachePath;
    let workspaceBase;
    try {
      ({ cachePath, workspaceBase } = buildPaths({
        project: effectiveProject,
        nodeId: nodeId || effectiveRun.node_id || 'local',
        source,
        node,
      }));
    } catch (err) {
      if (err.code === 'MATERIALIZE_UNSUPPORTED') return false;
      throw err;
    }
    const executor = executorForNode(nodeId || effectiveRun.node_id || 'local');
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

    const sourceGeneration = Number(effectiveProject.source_generation || 0);
    let cachePath;
    let workspaceBase;
    try {
      ({ cachePath, workspaceBase } = buildPaths({ project: effectiveProject, nodeId, source, node }));
    } catch (err) {
      if (err.code === 'MATERIALIZE_UNSUPPORTED') {
        return { pending: false, unsupported: true, error: err.message };
      }
      throw err;
    }
    const executor = executorForNode(nodeId);
    let ready = runService.getProjectNodeWorkspace(effectiveProject.id, nodeId || 'local', sourceGeneration);

    let workspacePath = null;
    let worktreeAdded = false;
    let durableReady = false;
    try {
      const cache = await materializeCache({
        project: effectiveProject,
        node,
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
      workspacePath = await addRunWorktree({
        executor,
        node,
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
        cwd: repoSubdir ? pathJoinFor(workspacePath, repoSubdir) : workspacePath,
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
