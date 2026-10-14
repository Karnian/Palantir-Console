'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertSpawnAllowed, isSpawnGuardActive } = require('../utils/spawnGuard');
const { reapProcessGroup } = require('../utils/reapProcessGroup');
const CLI = path.resolve(__dirname, '../../scripts/session-snapshot.mjs');
const FIXTURES = path.resolve(__dirname, '../tests/fixtures/bin');

function prepareSnapshotCli({ env, execPath, scriptPath, source }) {
  execPath ||= process.execPath; scriptPath ||= CLI;
  const guarded = isSpawnGuardActive() || Object.hasOwn(env, 'NODE_TEST_CONTEXT')
    || env.PALANTIR_BLOCK_REAL_SPAWN === '1';
  if (guarded && !fs.realpathSync(scriptPath).startsWith(fs.realpathSync(FIXTURES) + path.sep)) {
    throw Object.assign(new Error('snapshot_fixture_required'), { code: 'snapshot_fixture_required' });
  }
  assertSpawnAllowed({ command: execPath, source });
  const childEnv = { ...env, PALANTIR_SNAPSHOT_EXECUTOR_GROUP: 'inherit' };
  if (guarded) {
    childEnv.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT || env.NODE_TEST_CONTEXT || 'snapshot-refresh';
    childEnv.PALANTIR_BLOCK_REAL_SPAWN = '1'; childEnv.PALANTIR_ALLOW_REAL_SPAWN = '0';
  }
  return { execPath, scriptPath, childEnv };
}
function cancelCliRun(run, reason) {
  if (run.cancelled) return;
  run.cancelled = reason; run.resolveCancellation({ code: reason });
}
function reapCliRun(run, options) {
  run.reaping ||= reapProcessGroup(run.pgid, options);
  return run.reaping;
}
async function runSnapshotCli({ execPath, scriptPath, childEnv, argv, run, timeoutMs,
  reapOptions, spawn: spawnImpl = spawn, maxStdoutBytes = 65536, maxStderrBytes = 65536, waitForOutput = false }) {
  if (run.cancelled) return { code: run.cancelled };
  try {
    const child = spawnImpl(execPath, [scriptPath, ...argv],
      { detached: true, shell: false, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    run.pgid = child.pid;
    for (const name of ['stdout', 'stderr']) {
      const output = { bytes: 0, chunks: [], truncated: false };
      run[name] = output;
      const limit = name === 'stdout' ? maxStdoutBytes : maxStderrBytes;
      child[name].on('data', chunk => {
        const remaining = limit - output.bytes;
        if (chunk.length > remaining) output.truncated = true;
        if (remaining > 0) {
          output.chunks.push(Buffer.from(chunk.subarray(0, remaining)));
          output.bytes += Math.min(chunk.length, remaining);
        }
      });
    }
    const drained = new Promise(resolve => { child.once('close', resolve); });
    const exited = new Promise(resolve => {
      child.once('exit', status => resolve({ code: 'failed', status_code: status }));
      child.once('error', () => resolve({ code: 'failed', status_code: null }));
    });
    const timeout = setTimeout(() => cancelCliRun(run, 'timeout'), timeoutMs);
    try {
      const result = await Promise.race([exited, run.cancellation]);
      await reapCliRun(run, reapOptions);
      if (waitForOutput) await Promise.race([drained, run.cancellation]);
      return run.cancelled ? { code: run.cancelled } : result;
    } finally { clearTimeout(timeout); }
  } catch (error) {
    // A failed reap remains rejected: callers retain the group id and lock its machine.
    if (run.pgid) await reapCliRun(run, reapOptions);
    throw error;
  }
}
module.exports = { prepareSnapshotCli, runSnapshotCli, reapCliRun, cancelCliRun };
