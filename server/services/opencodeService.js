const { spawn } = require('node:child_process');
const { AppError } = require('../utils/errors');
const { assertSpawnAllowed } = require('../utils/spawnGuard');

function createOpencodeService({ opencodeBin }) {
  function queueMessage({ sessionId, content, cwd }) {
    return new Promise((resolve, reject) => {
      assertSpawnAllowed({ command: opencodeBin, source: 'opencodeService:queueMessage' });
      const child = spawn(opencodeBin, ['run', '--session', sessionId, content], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED || '1'
        }
      });

      child.on('error', (spawnError) => {
        reject(new AppError('Failed to launch opencode', 500, spawnError.message));
      });

      child.on('spawn', () => {
        child.unref();
        resolve({ status: 'ok', queued: true });
      });
    });
  }

  return { queueMessage };
}

module.exports = { createOpencodeService };
