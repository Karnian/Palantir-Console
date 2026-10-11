'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('./observeSnapshotStore');
const { isSafeId, validateSnapshot } = require('./observeSnapshotPolicy');
const { assertSpawnAllowed, isSpawnGuardActive } = require('../utils/spawnGuard');
const { reapProcessGroup } = require('../utils/reapProcessGroup');
const { reapExecutorGroup } = require('../utils/snapshotExecutorGroup');

const CLI = path.resolve(__dirname, '../../scripts/session-snapshot.mjs');
const FIXTURES = path.resolve(__dirname, '../tests/fixtures/bin');
const KEYS = ['name', 'kind', 'host', 'machineId', 'label', 'remoteNode', 'orcaBin'];
const LABEL = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/;
const ABSOLUTE = /^\/[A-Za-z0-9._/-]+$/;
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

function targetsFrom(raw) {
  const values = JSON.parse(raw || '[]');
  if (!Array.isArray(values)) throw fail('snapshot_targets_invalid');
  const names = new Set(); const ids = new Set();
  return values.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !KEYS.includes(key))
      || typeof value.name !== 'string' || !LABEL.test(value.name)
      || typeof value.machineId !== 'string' || !isSafeId(value.machineId)
      || !['local', 'ssh'].includes(value.kind) || names.has(value.name) || ids.has(value.machineId)) {
      throw fail('snapshot_targets_invalid');
    }
    if (value.kind === 'ssh') {
      if (typeof value.host !== 'string' || !/^[A-Za-z0-9._][A-Za-z0-9._-]*(?:@[A-Za-z0-9._-]+)?$/.test(value.host)) {
        throw fail('snapshot_targets_invalid');
      }
    } else if (value.host !== undefined || value.remoteNode !== undefined) throw fail('snapshot_targets_invalid');
    if (value.label !== undefined && (typeof value.label !== 'string' || !LABEL.test(value.label))) {
      throw fail('snapshot_targets_invalid');
    }
    for (const key of ['remoteNode', 'orcaBin']) {
      if (value[key] !== undefined && (typeof value[key] !== 'string' || !ABSOLUTE.test(value[key]))) {
        throw fail('snapshot_targets_invalid');
      }
    }
    names.add(value.name); ids.add(value.machineId);
    return Object.freeze({ ...value });
  });
}

function integer(raw, fallback, minimum) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(String(raw))) throw fail('snapshot_refresh_config_invalid');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) {
    throw fail('snapshot_refresh_config_invalid');
  }
  return value;
}

function createSnapshotRefreshService(options = {}) {
  const env = { ...(options.env || process.env) };
  const observe = options.observeState || { on: false };
  let targets = []; let code = null; let intervalMs = 0; let timeoutMs = 120000;
  try {
    targets = targetsFrom(env.PALANTIR_SNAPSHOT_TARGETS);
    intervalMs = integer(env.PALANTIR_SNAPSHOT_REFRESH_MS, 300000, 0);
    timeoutMs = integer(env.PALANTIR_SNAPSHOT_TIMEOUT_MS, 120000, 1);
  } catch (err) {
    code = err.code || 'snapshot_targets_invalid'; targets = [];
    (options.warn || console.warn)(code);
  }
  let enabled = observe.on && !code && targets.length > 0;
  if (enabled) {
    try { cleanOldStaging(); }
    catch {
      enabled = false; code = 'snapshot_staging_invalid';
      (options.warn || console.warn)(code);
    }
  }
  code ||= !observe.on ? 'observe_off' : !targets.length ? 'snapshot_targets_unset' : null;
  const entries = targets.map(target => ({ target, running: false, last_success_at: null,
    last_attempt_at: null, last_result: null, locked: false, task: null, run: null }));
  let closed = false; let shutdownPromise; let timer;
  const state = () => ({ enabled, code, closed, auto_interval_ms: enabled ? intervalMs : 0,
    targets: entries.map(entry => ({ name: entry.target.name, machine_id: entry.target.machineId,
      running: entry.running, last_success_at: entry.last_success_at, last_attempt_at: entry.last_attempt_at,
      last_result: entry.last_result ? { ...entry.last_result } : null, locked: entry.locked })) });

  function privateDirectory(dir) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
      throw fail('invalid_output');
    }
    fs.chmodSync(dir, 0o700);
  }
  function stagingBase() {
    if (!observe.on || fs.realpathSync(observe.root) !== observe.root) throw fail('invalid_output');
    const base = path.join(observe.root, '.staging');
    privateDirectory(base);
    return base;
  }
  function cleanOldStaging() {
    const base = stagingBase();
    for (const name of fs.readdirSync(base)) {
      if (!isSafeId(name)) continue;
      const dir = path.join(base, name);
      privateDirectory(dir);
      for (const old of fs.readdirSync(dir)) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
    }
  }
  function staging(entry) {
    const parent = path.join(stagingBase(), entry.target.machineId);
    privateDirectory(parent);
    const dir = fs.mkdtempSync(path.join(parent, 'run-'));
    fs.chmodSync(dir, 0o700);
    return dir;
  }
  function argumentsFor(target, dir) {
    const argv = target.kind === 'ssh' ? ['remote', '--host', target.host] : [];
    if (target.remoteNode) argv.push('--remote-node', target.remoteNode);
    argv.push('snapshot', '--out-dir', dir);
    if (target.label) argv.push('--label', target.label);
    if (target.orcaBin) argv.push('--orca-bin', target.orcaBin);
    return argv;
  }
  function fixtureScript(script) {
    const real = fs.realpathSync(script);
    if (!real.startsWith(fs.realpathSync(FIXTURES) + path.sep)) throw fail('snapshot_fixture_required');
  }
  async function execute(entry, run) {
    let dir;
    let validating = false;
    try {
      const command = options.execPath || process.execPath;
      const script = options.scriptPath || CLI;
      const guarded = isSpawnGuardActive() || Object.hasOwn(env, 'NODE_TEST_CONTEXT')
        || env.PALANTIR_BLOCK_REAL_SPAWN === '1';
      if (guarded) fixtureScript(script);
      assertSpawnAllowed({ command, source: 'snapshot-refresh:cli' });
      dir = staging(entry); run.dir = dir;
      if (run.cancelled) return { code: run.cancelled };
      const childEnv = { ...env };
      if (guarded) {
        childEnv.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT || env.NODE_TEST_CONTEXT || 'snapshot-refresh';
        childEnv.PALANTIR_BLOCK_REAL_SPAWN = '1'; childEnv.PALANTIR_ALLOW_REAL_SPAWN = '0';
      }
      const child = (options.spawn || spawn)(command, [script, ...argumentsFor(entry.target, dir)],
        { detached: true, shell: false, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      run.pgid = child.pid;
      for (const name of ['stdout', 'stderr']) {
        const output = { bytes: 0, chunks: [], truncated: false };
        run[name] = output;
        child[name].on('data', chunk => {
          const remaining = 65536 - output.bytes;
          if (chunk.length > remaining) output.truncated = true;
          if (remaining > 0) { output.chunks.push(Buffer.from(chunk.subarray(0, remaining)));
            output.bytes += Math.min(chunk.length, remaining); }
        });
      }
      const exited = new Promise(resolve => {
        child.once('exit', status => resolve({ code: 'failed', status_code: status }));
        child.once('error', () => resolve({ code: 'failed', status_code: null }));
      });
      const timeout = setTimeout(() => cancel(run, 'timeout'), timeoutMs);
      let result;
      try {
        result = await Promise.race([exited, run.cancellation]);
        await reap(run);
      } finally { clearTimeout(timeout); }
      if (run.cancelled) return { code: run.cancelled };
      if (result.status_code !== 0) return result;
      validating = true;
      const batch = store.readAllSnapshots({ on: true, root: dir });
      if (!batch.ok || batch.snapshots.length !== 1) return { code: 'invalid_output' };
      const output = batch.snapshots[0];
      if (!output.ok) {
        // Store rejects filename/id disagreements too; inspect only its bounded, policy-valid candidate.
        if (output.reason === 'policy_violation' && output.bytes <= store.STORE_LIMITS.fileBytes) {
          const filename = path.join(dir, `${output.machineId}.json`);
          const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          try {
            const stat = fs.fstatSync(fd);
            const size = stat.size;
            if (stat.isFile() && size <= store.STORE_LIMITS.fileBytes) {
              const raw = Buffer.alloc(size);
              fs.readSync(fd, raw, 0, size, 0);
              const candidate = JSON.parse(raw.toString('utf8'));
              if (validateSnapshot(candidate).ok && candidate.machine.id !== entry.target.machineId) {
                return { code: 'machine_mismatch' };
              }
            }
          } finally { fs.closeSync(fd); }
        }
        return { code: 'invalid_output' };
      }
      if (output.snapshot.machine.id !== entry.target.machineId) return { code: 'machine_mismatch' };
      if (run.cancelled || closed) return { code: run.cancelled || 'cancelled' };
      if (fs.realpathSync(observe.root) !== observe.root) return { code: 'invalid_output' };
      const source = path.join(dir, `${entry.target.machineId}.json`);
      fs.chmodSync(source, 0o600);
      fs.renameSync(source, path.join(observe.root, `${entry.target.machineId}.json`));
      return { code: 'ok' };
    } catch (err) {
      if (run.pgid) {
        try { await reap(run); } catch { entry.locked = true; return { code: 'reap_failed' }; }
      }
      if (err.code === 'reap_failed') { entry.locked = true; return { code: 'reap_failed' }; }
      return { code: run.cancelled || (validating ? 'invalid_output' : 'failed'),
        ...(!run.cancelled && !validating ? { status_code: null } : {}) };
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  function reap(run) {
    if (!run.reaping) run.reaping = (async () => {
      // Inspect the executor only after the CLI can no longer create or replace its marker.
      const cli = await Promise.allSettled([reapProcessGroup(run.pgid, options.reapOptions)]);
      if (run.dir) await reapExecutorGroup(run.dir, options);
      if (cli[0].status === 'rejected') throw cli[0].reason;
    })();
    return run.reaping;
  }
  function cancel(run, reason) {
    if (run.cancelled) return;
    run.cancelled = reason; run.resolveCancellation({ code: reason });
  }
  function start(entry) {
    if (entry.running || entry.locked || closed) return entry.task;
    const run = { cancelled: null, pgid: null };
    run.cancellation = new Promise(resolve => { run.resolveCancellation = resolve; });
    entry.running = true; entry.run = run; entry.last_attempt_at = new Date().toISOString();
    entry.task = Promise.resolve().then(() => execute(entry, run)).then(result => {
      entry.last_result = result;
      if (result.code === 'ok') entry.last_success_at = new Date().toISOString();
    }).finally(() => { entry.running = false; entry.run = null; });
    return entry.task;
  }
  function refresh(names) {
    if (closed) throw fail('snapshot_refresh_closed', 409);
    if (!enabled) throw fail(code || 'snapshot_refresh_off', 503);
    if (names !== undefined && (!Array.isArray(names) || names.some(name =>
      typeof name !== 'string' || !entries.some(entry => entry.target.name === name)))) throw fail('request_invalid');
    const selected = names === undefined ? entries : entries.filter(entry => names.includes(entry.target.name));
    if (selected.some(entry => entry.locked)) throw fail('reap_failed', 409);
    for (const entry of selected) start(entry);
    return state();
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true; (options.clearInterval || clearInterval)(timer);
    for (const entry of entries) if (entry.run) cancel(entry.run, 'cancelled');
    shutdownPromise = Promise.allSettled(entries.map(entry => entry.task)).then(() => {
      if (entries.some(entry => entry.locked)) throw fail('reap_failed', 503);
    });
    return shutdownPromise;
  }
  if (enabled && intervalMs) {
    timer = (options.setInterval || setInterval)(() => {
      if (!closed) for (const entry of entries) start(entry);
    }, intervalMs);
    timer.unref?.();
  }
  return { state, refresh, shutdown, settled: () => Promise.allSettled(entries.map(entry => entry.task)) };
}

module.exports = { createSnapshotRefreshService };
