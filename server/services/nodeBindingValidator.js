const { BadRequestError } = require('../utils/errors');

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function normalizeOptionalPath(value) {
  if (!hasValue(value)) return null;
  return typeof value === 'string' ? value.trim() : value;
}

function directoryBindingError(nodeId, directory) {
  return new BadRequestError(`Directory not found or outside exposed_roots on node ${nodeId}: ${directory}`);
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
      const exists = await executor.fileExists(resolvedDirectory);
      if (!exists) throw directoryBindingError(nodeId, normalizedDirectory);
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      throw directoryBindingError(nodeId, normalizedDirectory);
    }
  }

  return { validateBinding };
}

module.exports = { createNodeBindingValidator };
