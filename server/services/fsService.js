const path = require('path');
const { isWithinRoot } = require('../utils/pathGuard');
const { createLocalNodeExecutor } = require('./nodeExecutor');
const { sanitizeMessage } = require('../utils/errors');

// task_85d43f96 — node-aware directory browsing.
//
// The project form picks an execution node FIRST and then browses that node's
// filesystem, so /api/fs has to answer for two very different roots:
//   * the control plane (`local`)  → storage.fsRoot, guarded by pathGuard
//   * an ssh execution node        → the node's exposed_roots, guarded by the
//                                    remote executor's realpath containment
// Both paths are fail-closed: the canonical (realpath-resolved) target must
// live inside the applicable root, so a symlink that lives inside the root but
// points outside it is rejected on both sides.
//
// Failure REASONS are part of the contract. An operator staring at "failed to
// read directory" cannot tell an unreachable pod from a typo, so every failure
// carries one of these machine-readable reasons which the picker maps to copy.
const BROWSE_REASONS = {
  nodeNotFound: 'node_not_found',
  nodeNotBrowsable: 'node_not_browsable',
  nodeUnreachable: 'node_unreachable',
  nodeTimeout: 'node_timeout',
  pathOutsideRoot: 'path_outside_root',
  symlinkEscape: 'symlink_escape',
  pathNotFound: 'path_not_found',
  permissionDenied: 'permission_denied',
  browseFailed: 'browse_failed',
};

function browseError(message, status, reason) {
  const err = new Error(message);
  err.status = status;
  err.reason = reason;
  return err;
}

function parseExposedRoots(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw || 'null');
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((root) => typeof root === 'string' && path.posix.isAbsolute(root));
}

function isWithinPosixRoot(target, root) {
  if (root === '/') return path.posix.isAbsolute(target);
  return target === root || target.startsWith(`${root}/`);
}

function sortByName(a, b) {
  return a.name.localeCompare(b.name);
}

// Map a low-level executor / fs failure onto a browse reason. Errors that were
// raised BY this module already carry `reason` and pass through untouched.
function classifyBrowseError(error) {
  if (error && error.reason && error.status) {
    return {
      status: Number(error.status),
      reason: error.reason,
      message: sanitizeMessage(error.message),
    };
  }
  const code = error && error.code;
  const text = `${(error && error.stderr) || ''} ${(error && error.message) || ''}`;

  if (code === 'EXPOSED_ROOTS') {
    const reason = error.reason === BROWSE_REASONS.symlinkEscape
      ? BROWSE_REASONS.symlinkEscape
      : BROWSE_REASONS.pathOutsideRoot;
    return { status: 403, reason, message: sanitizeMessage(error.message) };
  }
  if (code === 'SSH_TRANSPORT') {
    return { status: 502, reason: BROWSE_REASONS.nodeUnreachable, message: 'Execution node is unreachable' };
  }
  if (code === 'ETIMEDOUT') {
    return { status: 504, reason: BROWSE_REASONS.nodeTimeout, message: 'Execution node did not respond in time' };
  }
  if (code === 'ENOENT' || code === 'ENOTDIR' || /No such file or directory|Not a directory/i.test(text)) {
    return { status: 404, reason: BROWSE_REASONS.pathNotFound, message: 'Path not found' };
  }
  if (code === 'EACCES' || code === 'EPERM' || /Permission denied|not permitted/i.test(text)) {
    return { status: 403, reason: BROWSE_REASONS.permissionDenied, message: 'Access denied' };
  }
  if (error && Number(error.status) >= 400 && Number(error.status) < 600) {
    return {
      status: Number(error.status),
      reason: error.reason || BROWSE_REASONS.browseFailed,
      message: sanitizeMessage(error.message),
    };
  }
  return { status: 500, reason: BROWSE_REASONS.browseFailed, message: 'Failed to read directory' };
}

function createFsService(storage, { nodeExecutor = createLocalNodeExecutor(), nodeService = null } = {}) {

  async function listDirectories(resolved, showHidden) {
    const entries = await nodeExecutor.readdir(resolved, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: path.join(resolved, entry.name)
      }))
      .sort(sortByName);
    return { root: storage.fsRoot, path: resolved, directories };
  }

  async function browseLocal(requestedPath, showHidden) {
    const requested = typeof requestedPath === 'string' && requestedPath.trim()
      ? requestedPath.trim()
      : storage.fsRoot;
    const resolved = path.resolve(requested);
    if (!isWithinRoot(storage.fsRoot, resolved)) {
      throw browseError('Path not allowed', 403, BROWSE_REASONS.pathOutsideRoot);
    }
    // The lexical guard above is satisfied by a symlink that LIVES inside
    // fsRoot but POINTS outside it, so re-check the canonical form of both
    // sides. Both are canonicalized so a symlinked fsRoot (a /tmp that is
    // really /private/tmp) does not become a false positive.
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      nodeExecutor.realpath(storage.fsRoot),
      nodeExecutor.realpath(resolved),
    ]);
    if (!isWithinRoot(canonicalRoot, canonicalTarget)) {
      throw browseError('Symlink target is outside the allowed root', 403, BROWSE_REASONS.symlinkEscape);
    }
    const result = await listDirectories(resolved, showHidden);
    return { ...result, node_id: 'local', node_kind: 'local', truncated: false };
  }

  async function browseNode(nodeId, requestedPath, showHidden) {
    if (!nodeService || typeof nodeService.getNode !== 'function') {
      throw browseError('Node browsing is not available', 501, BROWSE_REASONS.nodeNotBrowsable);
    }

    let node;
    try {
      node = nodeService.getNode(nodeId);
    } catch {
      throw browseError(`Node not found: ${nodeId}`, 404, BROWSE_REASONS.nodeNotFound);
    }

    // A local-kind node IS the control plane — browse the same fsRoot the
    // picker has always browsed rather than inventing a second local root.
    if (!node.kind || node.kind === 'local') return browseLocal(requestedPath, showHidden);
    if (node.kind !== 'ssh') {
      throw browseError(`Node kind cannot be browsed: ${node.kind}`, 400, BROWSE_REASONS.nodeNotBrowsable);
    }

    const roots = parseExposedRoots(node.exposed_roots);
    if (roots.length === 0) {
      throw browseError(`Node ${node.id} declares no exposed_roots`, 400, BROWSE_REASONS.nodeNotBrowsable);
    }

    let executor;
    try {
      executor = nodeService.pickExecutor(node.id);
    } catch (err) {
      throw browseError(
        sanitizeMessage(err && err.message) || `Node ${node.id} cannot be browsed`,
        400,
        BROWSE_REASONS.nodeNotBrowsable,
      );
    }
    if (!executor || typeof executor.listDirectoryEntries !== 'function') {
      throw browseError(`Node ${node.id} executor cannot list directories`, 501, BROWSE_REASONS.nodeNotBrowsable);
    }

    const requested = typeof requestedPath === 'string' && requestedPath.trim()
      ? requestedPath.trim()
      : roots[0];
    // listDirectoryEntries runs the exposed_roots realpath guard itself, so an
    // out-of-root or symlink-escaping target throws before anything is read.
    const listing = await executor.listDirectoryEntries(requested);
    const canonicalRoots = typeof executor.canonicalExposedRoots === 'function'
      ? await executor.canonicalExposedRoots()
      : roots;
    const directories = (listing.entries || [])
      .filter((entry) => entry.isDirectory)
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: path.posix.join(listing.path, entry.name) }))
      .sort(sortByName);

    return {
      root: canonicalRoots.find((root) => isWithinPosixRoot(listing.path, root)) || canonicalRoots[0],
      roots: canonicalRoots,
      path: listing.path,
      directories,
      node_id: node.id,
      node_kind: node.kind,
      truncated: Boolean(listing.truncated),
    };
  }

  function browse({ nodeId, path: requestedPath, showHidden } = {}) {
    const normalizedNodeId = String(nodeId || '').trim();
    if (!normalizedNodeId || normalizedNodeId === 'local') {
      return browseLocal(requestedPath, showHidden);
    }
    return browseNode(normalizedNodeId, requestedPath, showHidden);
  }

  return {
    isWithinRoot,
    listDirectories,
    browse,
    classifyBrowseError,
    fsRoot: storage.fsRoot
  };
}

module.exports = { createFsService, classifyBrowseError, BROWSE_REASONS };
