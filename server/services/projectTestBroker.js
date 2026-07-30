'use strict';

const childProcess = require('node:child_process');

const SPAWN_ERROR_MARKER = '__PALANTIR_PROJECT_TEST_SPAWN_ERROR__';
const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  process.stderr.write(`${SPAWN_ERROR_MARKER}${Buffer.from(JSON.stringify({
    message: 'project test broker requires a command',
    code: 'EINVAL',
  })).toString('base64')}\n`);
  process.exit(126);
}

const child = childProcess.spawn(command, args, {
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
});

for (const signal of [
  'SIGINT',
  'SIGTERM',
  ...(process.platform === 'win32' ? [] : ['SIGHUP']),
]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    }
  });
}

child.once('error', (err) => {
  const payload = {
    message: err?.message || `spawn ${command} failed`,
    code: err?.code,
    errno: err?.errno,
    syscall: err?.syscall,
    path: err?.path,
    spawnargs: err?.spawnargs,
  };
  process.stderr.write(
    `${SPAWN_ERROR_MARKER}${Buffer.from(JSON.stringify(payload)).toString('base64')}\n`,
  );
  process.exitCode = 126;
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
