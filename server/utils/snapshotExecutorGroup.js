'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { assertSpawnAllowed } = require('./spawnGuard');
const { reapProcessGroup } = require('./reapProcessGroup');

const failed = () => Object.assign(new Error('reap_failed'), { code: 'reap_failed' });

function readExecutorPgid(dir) {
  const filename = path.join(dir, 'executor.pgid');
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0
      || stat.size < 1 || stat.size > 16) throw failed();
    const raw = Buffer.alloc(17);
    const size = fs.readSync(fd, raw, 0, raw.length, 0);
    const text = raw.subarray(0, size).toString('utf8');
    const pgid = Number(text);
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(pgid) || pgid <= 1 || pgid > 2147483647) {
      throw failed();
    }
    return pgid;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw failed();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function reapExecutorPgid(pgid, options = {}) {
  if (pgid === null || pgid === undefined) return;
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid > 2147483647) throw failed();
  const kill = options.reapOptions?.kill || process.kill;
  try { kill(-pgid, 0); }
  catch (err) {
    if (err.code === 'ESRCH') return;
    if (err.code !== 'EPERM') throw failed();
  }
  const command = options.psBin || '/bin/ps';
  assertSpawnAllowed({ command, source: 'snapshot-refresh:executor-uid' });
  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      (options.execFile || execFile)(command, ['-axo', 'pid=,pgid=,uid='],
        { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 }, (err, output) => {
          if (err) reject(err); else resolve(output);
        });
    });
  } catch { throw failed(); }
  if (typeof stdout !== 'string') throw failed();
  const rows = [];
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (!/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) continue;
    const pid = Number(fields[0]); const group = Number(fields[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(group) || group <= 0) continue;
    const uid = Number(fields[2]);
    if (fields.length !== 3 || !/^-?\d+$/.test(fields[2]) || !Number.isSafeInteger(uid)) {
      // Ignore unrelated noise, but never hide an unreadable member or the server's own group.
      if (pid === process.pid || group === pgid) throw failed();
      continue;
    }
    rows.push([pid, group, uid]);
  }
  const own = rows.find(([pid]) => pid === process.pid);
  if (!own || own[1] === pgid) throw failed();
  const members = rows.filter(([, group]) => group === pgid);
  if (!members.length) {
    try { kill(-pgid, 0); }
    catch (err) { if (err.code === 'ESRCH') return; }
    throw failed();
  }
  if (members.some(([, , uid]) => uid !== process.getuid?.())) throw failed();
  await reapProcessGroup(pgid, options.reapOptions);
}

async function reapExecutorGroup(dir, options = {}) {
  return reapExecutorPgid(readExecutorPgid(dir), options);
}

module.exports = { readExecutorPgid, reapExecutorGroup, reapExecutorPgid };
