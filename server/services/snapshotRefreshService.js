'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./observeSnapshotStore');
const { isSafeId, validateSnapshot } = require('./observeSnapshotPolicy');
const { reapProcessGroup } = require('../utils/reapProcessGroup');
const { acquireSnapshotRefreshLock } = require('../utils/snapshotRefreshLock');

const { parseSnapshotTargets } = require('./snapshotTargets');
const { prepareSnapshotCli, runSnapshotCli, reapCliRun, cancelCliRun } = require('./snapshotCliRunner');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });

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
    targets = parseSnapshotTargets(env.PALANTIR_SNAPSHOT_TARGETS);
    intervalMs = integer(env.PALANTIR_SNAPSHOT_REFRESH_MS, 300000, 0);
    timeoutMs = integer(env.PALANTIR_SNAPSHOT_TIMEOUT_MS, 120000, 1);
  } catch (err) {
    code = err.code || 'snapshot_targets_invalid'; targets = [];
    (options.warn || console.warn)(code);
  }
  let enabled = observe.on && !code && targets.length > 0;
  let releaseLock;
  if (enabled) {
    try {
      releaseLock = acquireSnapshotRefreshLock(stagingBase(), { kill: options.lockKill });
      if (!releaseLock) { enabled = false; code = 'snapshot_refresh_locked'; }
      else cleanOldStaging();
    } catch (err) {
      releaseLock?.(); releaseLock = null;
      enabled = false; code = err.code === 'snapshot_refresh_locked' ? err.code : 'snapshot_staging_invalid';
      (options.warn || console.warn)(code);
    }
  }
  code ||= !observe.on ? 'observe_off' : !targets.length ? 'snapshot_targets_unset' : null;
  const entries = targets.map(target => ({ target, running: false, last_success_at: null,
    last_attempt_at: null, last_result: null, locked: false, task: null, run: null, failedPgid: null }));
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
      if (name.startsWith('.')) continue;
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
  async function execute(entry, run) {
    let dir;
    let validating = false;
    try {
      const cli = prepareSnapshotCli({ ...options, env, source: 'snapshot-refresh:cli' });
      dir = staging(entry); run.dir = dir;
      const result = await runSnapshotCli({ ...cli, argv: argumentsFor(entry.target, dir), run,
        timeoutMs, reapOptions: options.reapOptions, spawn: options.spawn, maxStdoutBytes: 65536 });
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
  const reap = run => reapCliRun(run, options.reapOptions);
  const cancel = cancelCliRun;
  function start(entry) {
    if (entry.running || entry.locked || closed) return entry.task;
    const run = { cancelled: null, pgid: null };
    run.cancellation = new Promise(resolve => { run.resolveCancellation = resolve; });
    entry.running = true; entry.run = run; entry.last_attempt_at = new Date().toISOString();
    entry.task = Promise.resolve().then(() => execute(entry, run)).then(result => {
      entry.last_result = result;
      if (entry.locked) entry.failedPgid = run.pgid;
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
    shutdownPromise = Promise.allSettled(entries.map(entry => entry.task)).then(async () => {
      const cleanup = await Promise.allSettled(entries.filter(entry => entry.locked).map(async entry => {
        await reapProcessGroup(entry.failedPgid, options.reapOptions);
        entry.failedPgid = null;
      }));
      if (cleanup.some(result => result.status === 'rejected')) throw fail('reap_failed', 503);
      releaseLock?.(); releaseLock = null;
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
