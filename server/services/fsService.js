const path = require('path');
const { isWithinRoot } = require('../utils/pathGuard');
const { createLocalNodeExecutor } = require('./nodeExecutor');

function createFsService(storage, { nodeExecutor = createLocalNodeExecutor() } = {}) {

  async function listDirectories(resolved, showHidden) {
    const entries = await nodeExecutor.readdir(resolved, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: path.join(resolved, entry.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { root: storage.fsRoot, path: resolved, directories };
  }

  return {
    isWithinRoot,
    listDirectories,
    fsRoot: storage.fsRoot
  };
}

module.exports = { createFsService };
