'use strict';

const fs = require('node:fs');
const path = require('node:path');
const invalid = () => Object.assign(new Error('snapshot_refresh_locked'), { code: 'snapshot_refresh_locked' });

function readLock(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 1024) {
      throw invalid();
    }
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647
      || typeof value.started_at !== 'string' || !Number.isFinite(Date.parse(value.started_at))) throw invalid();
    return { stat, value };
  } finally { fs.closeSync(fd); }
}

function removeOwned(filename, owned) {
  try {
    const stat = fs.lstatSync(filename);
    if (stat.dev === owned.dev && stat.ino === owned.ino) fs.unlinkSync(filename);
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

function acquireSnapshotRefreshLock(base, { kill = process.kill } = {}) {
  const filename = path.join(base, '.lock');
  const data = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  function create(name) {
    const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const stat = fs.fstatSync(fd);
    try { fs.writeFileSync(fd, data); }
    catch (err) { removeOwned(name, stat); throw err; }
    finally { fs.closeSync(fd); }
    return stat;
  }
  function live(pid) {
    try { kill(pid, 0); return true; }
    catch (err) {
      if (err.code === 'ESRCH') return false;
      if (err.code === 'EPERM') return true;
      throw err;
    }
  }
  let owned;
  try { owned = create(filename); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (live(readLock(filename).value.pid)) return null;
    // Serialize stale-lock takers so one cannot unlink another's newly acquired lock.
    const reclaim = path.join(base, '.lock.reclaim');
    let claim;
    try { claim = create(reclaim); }
    catch (err) { if (err.code === 'EEXIST') return null; throw err; }
    try {
      try {
        const old = readLock(filename);
        if (live(old.value.pid)) return null;
        removeOwned(filename, old.stat);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      try { owned = create(filename); }
      catch (err) { if (err.code === 'EEXIST') return null; throw err; }
    } finally { removeOwned(reclaim, claim); }
  }
  return () => {
    try {
      const stat = fs.lstatSync(filename);
      if (stat.dev !== owned.dev || stat.ino !== owned.ino) return;
      const current = readLock(filename);
      if (JSON.stringify(current.value) === data) removeOwned(filename, owned);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  };
}

module.exports = { acquireSnapshotRefreshLock };
