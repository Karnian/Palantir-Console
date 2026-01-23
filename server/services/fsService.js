const path = require('path');
const fs = require('fs/promises');

function createFsService(storage) {
  function isWithinRoot(rootDir, targetPath) {
    const rootResolved = path.resolve(rootDir);
    const targetResolved = path.resolve(targetPath);
    return targetResolved === rootResolved || targetResolved.startsWith(`${rootResolved}${path.sep}`);
  }

  async function listDirectories(resolved, showHidden) {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
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
