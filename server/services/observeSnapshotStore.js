'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ID_RE, SNAPSHOT_LIMITS, COVERAGE_KEYS, validateSnapshot } = require('./observeSnapshotPolicy');

const STORE_LIMITS = Object.freeze({ fileBytes: SNAPSHOT_LIMITS.bytes, totalBytes: 64 * 1024 * 1024 });
const FILE_RE = /^[A-Za-z0-9:_-]{1,128}\.json$/;

function offState(code) {
  return Object.freeze({ on: false, code, root: null });
}

// Spec §5.1: seal once; requests never change the activation decision.
function sealObserveState({ dir, authToken, uid = process.getuid?.() }) {
  if (!dir) return offState('observe_dir_unset');
  if (!authToken) return offState('observe_auth_off');
  try {
    const root = path.resolve(dir);
    if (fs.realpathSync(root) !== root) return offState('observe_root_invalid');
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return offState('observe_root_invalid');
    if (uid === undefined || stat.uid !== uid) return offState('observe_root_owner');
    if ((stat.mode & 0o022) !== 0) return offState('observe_root_writable');
    return Object.freeze({ on: true, code: null, root });
  } catch {
    return offState('observe_root_invalid');
  }
}

function failure(reason, bytes = 0) {
  return { ok: false, reason, bytes };
}

function checkRoot(state) {
  if (!state.on) return failure('observe_off');
  try {
    if (fs.realpathSync(state.root) === state.root) return { ok: true };
  } catch {
    // Spec §5.4: missing or replaced roots require a restart, not resealing.
  }
  return failure('observe_root_changed');
}

function fileError(error) {
  if (error.code === 'ENOENT') return 'not_found';
  if (error.code === 'ELOOP') return 'symlink';
  return 'read_error';
}

// Spec §5.4: bound actual reads, including growth after fstat and invalid JSON.
function readBounded(fd, limit, budget) {
  const chunks = [];
  while (budget.bytes < limit) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, limit - budget.bytes));
    const count = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    budget.bytes += count;
  }
  return { bytes: budget.bytes, text: Buffer.concat(chunks, budget.bytes).toString('utf8') };
}

function readFileSnapshot(root, machineId, limits, remaining) {
  let fd;
  const budget = { bytes: 0 };
  try {
    const filename = path.join(root, `${machineId}.json`);
    const before = fs.lstatSync(filename);
    if (before.isSymbolicLink()) return failure('symlink');
    if (!before.isFile()) return failure('not_regular');
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino) return failure('identity_mismatch');
    if (!opened.isFile()) return failure('not_regular');
    if (opened.size > limits.fileBytes) return failure('too_large');
    if (opened.size > remaining) return failure('total_limit');
    const content = readBounded(fd, Math.min(limits.fileBytes, remaining), budget);
    const bytes = content.bytes;
    const after = fs.fstatSync(fd);
    if (after.size > limits.fileBytes) return failure('too_large', bytes);
    if (after.size > remaining) return failure('total_limit', bytes);
    let snapshot;
    try {
      snapshot = JSON.parse(content.text);
    } catch {
      return failure('parse_error', bytes);
    }
    if (!validateSnapshot(snapshot).ok || snapshot.machine.id !== machineId) {
      return failure('policy_violation', bytes);
    }
    return { ok: true, snapshot, bytes };
  } catch (error) {
    return failure(fileError(error), budget.bytes);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function coverageSummary(coverage) {
  return Object.fromEntries(Object.entries(COVERAGE_KEYS).map(function providerCounts([provider, keys]) {
    return [provider, Object.fromEntries(keys.map(function coverageCount(key) {
      return [key, coverage[provider][key]];
    }))];
  }));
}

function listSnapshots(state, limits = STORE_LIMITS) {
  const rootCheck = checkRoot(state);
  if (!rootCheck.ok) return rootCheck;
  let names;
  try {
    names = fs.readdirSync(state.root).filter(function snapshotName(name) {
      return FILE_RE.test(name) && ID_RE.test(name.slice(0, -5));
    }).map(function machineName(name) { return name.slice(0, -5); }).sort();
  } catch {
    return failure('read_error');
  }
  let remaining = limits.totalBytes;
  const snapshots = names.map(function snapshotMetadata(machineId) {
    const result = readFileSnapshot(state.root, machineId, limits, remaining);
    remaining -= result.bytes;
    if (!result.ok) return { name_id: machineId, error_code: result.reason };
    return {
      machine_id: machineId,
      machine_label: result.snapshot.machine.label,
      generated_at: result.snapshot.generated_at,
      bytes: result.bytes,
      coverage_summary: coverageSummary(result.snapshot.coverage),
    };
  });
  return { ok: true, snapshots };
}

function readSnapshot(state, machineId, limits = STORE_LIMITS) {
  const rootCheck = checkRoot(state);
  if (!rootCheck.ok) return rootCheck;
  if (typeof machineId !== 'string' || !ID_RE.test(machineId)) return failure('invalid_machine_id');
  return readFileSnapshot(state.root, machineId, limits, limits.totalBytes);
}

// Smaller budgets keep limit tests practical; production caps cannot be raised.
function createObserveSnapshotStore({ fileBytes = STORE_LIMITS.fileBytes, totalBytes = STORE_LIMITS.totalBytes } = {}) {
  for (const [key, value] of Object.entries({ fileBytes, totalBytes })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > STORE_LIMITS[key]) {
      throw new RangeError('invalid observe limit');
    }
  }
  const limits = Object.freeze({ fileBytes, totalBytes });
  return {
    listSnapshots: function listWithLimits(state) { return listSnapshots(state, limits); },
    readSnapshot: function readWithLimits(state, machineId) { return readSnapshot(state, machineId, limits); },
  };
}

module.exports = { sealObserveState, listSnapshots, readSnapshot, createObserveSnapshotStore, STORE_LIMITS };
