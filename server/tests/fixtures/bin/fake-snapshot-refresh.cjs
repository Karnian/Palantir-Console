'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const env = process.env;
const dir = args[args.indexOf('--out-dir') + 1];
fs.appendFileSync(env.FAKE_REFRESH_LOG, JSON.stringify({ args, blocked: env.PALANTIR_BLOCK_REAL_SPAWN,
  context: env.NODE_TEST_CONTEXT, pid: process.pid }) + '\n');
const mode = env.FAKE_REFRESH_MODE || 'ok';
if (mode === 'stopped_cli') {
  const executor = spawn(process.execPath, [__filename, '--executor'], { detached: true,
    env: { ...env, FAKE_REFRESH_MODE: 'executor' }, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'executor.pgid'), String(executor.pid), { mode: 0o600 });
  setInterval(() => {}, 1000);
} else if (mode === 'executor') {
  spawn(process.execPath, [__filename, '--grandchild'], { env: { ...env,
    FAKE_REFRESH_MODE: 'grandchild' }, stdio: 'ignore' });
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'descendant' || mode === 'early_exit') {
  const child = spawn(process.execPath, [__filename, '--grandchild'], { env: { ...env,
    FAKE_REFRESH_MODE: 'grandchild' }, stdio: 'ignore' });
  child.on('exit', () => { if (stopping) process.exit(0); });
  let stopping = false;
  process.on('SIGTERM', () => {
    if (mode === 'early_exit') process.exit(0);
    stopping = true;
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 100);
  });
  setInterval(() => {}, 1000);
} else if (mode === 'grandchild') {
  fs.writeFileSync(env.FAKE_REFRESH_PID, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    if (mode === 'failed') process.exit(7);
    const snapshot = JSON.parse(fs.readFileSync(env.FAKE_REFRESH_INPUT, 'utf8'));
    if (mode === 'mismatch') snapshot.machine.id = 'unexpected';
    if (mode === 'invalid') snapshot.extra = 'forbidden';
    fs.writeFileSync(path.join(dir, `${snapshot.machine.id}.json`), JSON.stringify(snapshot) + '\n');
    if (mode === 'flood') {
      process.stdout.write('x'.repeat(200000)); process.stderr.write('sensitive'.repeat(30000));
    }
  }, Number(env.FAKE_REFRESH_DELAY || 0));
}
