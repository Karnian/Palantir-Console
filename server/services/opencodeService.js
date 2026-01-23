const { spawn } = require('child_process');
const { AppError } = require('../utils/errors');

function createOpencodeService({ opencodeBin }) {
  function queueMessage({ sessionId, content, cwd }) {
    return new Promise((resolve, reject) => {
      const child = spawn(opencodeBin, ['run', '--session', sessionId, content], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED || '0'
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
