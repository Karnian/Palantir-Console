const { BadRequestError } = require('../utils/errors');
const { BROWSE_REASONS } = require('./fsService');

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function normalizeOptionalPath(value) {
  if (!hasValue(value)) return null;
  return typeof value === 'string' ? value.trim() : value;
}

// task_85d43f96: the bind failure used to be one undifferentiated 400, so the
// project form could only say "that directory did not work". The reason lets
// the form distinguish an unreachable node from a denied or missing path — the
// same reason vocabulary the /api/fs picker uses. The message keeps its
// historical prefix; the reason is what callers should branch on.
function classifyBindingFailure(err) {
  const code = err && err.code;
  const text = `${(err && err.stderr) || ''} ${(err && err.message) || ''}`;
  if (code === 'SSH_TRANSPORT') return BROWSE_REASONS.nodeUnreachable;
  if (code === 'ETIMEDOUT') return BROWSE_REASONS.nodeTimeout;
  if (err?.reason === BROWSE_REASONS.symlinkEscape) return BROWSE_REASONS.symlinkEscape;
  if (code === 'EXPOSED_ROOTS' || /outside exposed_roots/i.test(text)) {
    return BROWSE_REASONS.pathOutsideRoot;
  }
  if (/Permission denied|not permitted/i.test(text)) return BROWSE_REASONS.permissionDenied;
  if (err?.reason === BROWSE_REASONS.pathNotDirectory
    || code === 'ENOTDIR'
    || /Not a directory|is not a directory/i.test(text)) {
    return BROWSE_REASONS.pathNotDirectory;
  }
  return BROWSE_REASONS.pathNotFound;
}

function directoryBindingError(nodeId, directory, reason = BROWSE_REASONS.pathNotFound) {
  const err = new BadRequestError(`Directory not found or outside exposed_roots on node ${nodeId}: ${directory}`);
  err.reason = reason;
  return err;
}

function createNodeBindingValidator({ nodeService } = {}) {
  // Note: mcp_config_path is NOT validated here (control-plane, lazy at spawn)
  // so no fs dependency is needed — tests may still pass `fs:` harmlessly.
  async function validateBinding({ nodeId, directory } = {}) {
    // mcp_config_path is intentionally NOT hard-validated for existence here.
    // It is a control-plane path (brief R3) read lazily at spawn time; blocking
    // project create/update because the file is not present yet breaks the
    // legitimate "configure the path, create the file later" flow (and the
    // existing P4-2 contract that a project can simply STORE the path). The UI
    // surfaces a "read on the control plane" hint instead — see ProjectsView.
    const normalizedDirectory = normalizeOptionalPath(directory);
    if (!nodeId || nodeId === 'local' || !normalizedDirectory) return;

    // Remote directory IS hard-validated: this is the local↔remote path
    // mismatch N2-2 exists to catch. executor.realpath canonicalizes and the
    // remote executor's exposed_roots guard throws for out-of-root paths.
    const executor = nodeService.pickExecutor(nodeId);
    try {
      const resolvedDirectory = await executor.realpath(normalizedDirectory);
      // Existence alone is NOT the invariant — this value becomes the run's
      // working directory, so a regular file (or FIFO/socket) that merely
      // exists would be accepted here and only blow up much later at spawn.
      // stat() is the same `test -d` the executor already uses elsewhere.
      const stats = await executor.stat(resolvedDirectory);
      if (!stats) throw directoryBindingError(nodeId, normalizedDirectory);
      if (!stats.isDirectory()) {
        throw directoryBindingError(nodeId, normalizedDirectory, BROWSE_REASONS.pathNotDirectory);
      }
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      throw directoryBindingError(nodeId, normalizedDirectory, classifyBindingFailure(err));
    }
  }

  return { validateBinding };
}

module.exports = { createNodeBindingValidator };
