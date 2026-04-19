const path = require('path');

function isWithinRoot(rootDir, targetPath) {
  const rootResolved = path.resolve(rootDir);
  const targetResolved = path.resolve(targetPath);
  return targetResolved === rootResolved || targetResolved.startsWith(`${rootResolved}${path.sep}`);
}

module.exports = { isWithinRoot };
