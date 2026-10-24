'use strict';
const childProcess = require('node:child_process');
const path = require('node:path');
const { validId } = require('./spawnEnv');
const failed = () => ({ status: 'query_failed' });
const startPattern = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \d{4}$/;
function normalizeStart(value, psOutput = false) {
  if (typeof value !== 'string') return null;
  // ps adds one line terminator; the timestamp itself must contain no line breaks.
  const line = psOutput && value.endsWith('\n') ? value.slice(0, -1) : value;
  if (/[\r\n]/.test(line)) return null;
  const match = startPattern.exec(line);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 31 ||
      Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  return line.replace(/ +/g, ' ');
}
function createPsIdentityProbe({ pinnedPath, execFileSync = childProcess.execFileSync, kill = process.kill.bind(process) } = {}) {
  const roots = new Map();
  function run(args) {
    return execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { LC_ALL: 'C' } });
  }
  function start(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'query_failed' };
    try {
      const output = run(['-o', 'lstart=', '-p', String(pid)]);
      const startedAt = normalizeStart(output, true);
      if (!startedAt) return failed();
      return { status: 'ok', startedAt };
    } catch (error) {
      // macOS ps reports an absent PID with status 1 and no stdout/stderr.
      if (error.status === 1 && error.signal == null && !error.code &&
          (typeof error.stdout === 'string' || Buffer.isBuffer(error.stdout)) && error.stdout.length === 0 &&
          (typeof error.stderr === 'string' || Buffer.isBuffer(error.stderr)) && error.stderr.length === 0) return { status: 'absent' };
      return failed();
    }
  }
  function check(pid, startedAt) {
    const normalized = normalizeStart(startedAt);
    if (!normalized) return 'query_failed';
    const found = start(pid);
    if (found.status === 'absent') return 'mismatch_confirmed';
    if (found.status !== 'ok') return 'query_failed';
    return found.startedAt === normalized ? 'match' : 'mismatch_confirmed';
  }
  function scan(id) {
    if (!validId(id)) return failed();
    try {
      const output = run(['-E', '-ww', '-A', '-o', 'pid=,command=']);
      if (typeof output !== 'string' || !output.trim()) return failed();
      const marked = [];
      const seen = new Set();
      const lines = output.endsWith('\n') ? output.slice(0, -1).split('\n') : output.split('\n');
      for (const line of lines) {
        const row = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!row || !Number.isSafeInteger(Number(row[1])) || Number(row[1]) <= 0 || seen.has(Number(row[1]))) return failed();
        const pid = Number(row[1]);
        seen.add(pid);
        const trailingMarker = /(?:^|\s)PALANTIR_OWNED_INCARNATION=([^\s]*)$/.exec(row[2]);
        if (trailingMarker && trailingMarker[1].length < id.length && id.startsWith(trailingMarker[1])) return failed();
        const tokens = row[2].split(/\s+/);
        if (!tokens.includes(`PALANTIR_OWNED_INCARNATION=${id}`)) continue;
        if (tokens.filter(token => token.startsWith('PALANTIR_OWNED_INCARNATION=')).length !== 1) return failed();
        const identity = start(pid);
        if (identity.status !== 'ok') return failed();
        const parent = run(['-o', 'ppid=', '-p', String(pid)]);
        if (typeof parent !== 'string' || !/^\s*\d+\s*$/.test(parent)) return failed();
        marked.push({ pid, startedAt: identity.startedAt, ppid: Number(parent.trim()), command: row[2] });
      }
      return { status: 'ok', marked };
    } catch {
      return failed();
    }
  }
  function findMarked(id) {
    if (typeof pinnedPath !== 'string' || !path.isAbsolute(pinnedPath) || /[\0\r\n]/.test(pinnedPath)) return failed();
    const result = scan(id);
    if (result.status !== 'ok') return failed();
    if (!result.marked.length) return { status: 'ok', pids: [] };
    const candidates = result.marked.filter(row => !result.marked.some(parent => parent.pid === row.ppid));
    if (candidates.length !== 1 || !candidates[0].command.startsWith(`${pinnedPath} `)) return failed();
    const { pid, startedAt } = candidates[0];
    roots.set(id, { pid, startedAt });
    return { status: 'ok', pids: [{ pid, startedAt }] };
  }
  function listMarkedDescendants(id) {
    const result = scan(id);
    if (result.status !== 'ok') return failed();
    const root = roots.get(id);
    // Without a previously identified main, retain every marked process for conservative cleanup.
    const pids = result.marked.filter(row => !root || row.pid !== root.pid || row.startedAt !== root.startedAt)
      .map(({ pid, startedAt }) => ({ pid, startedAt }));
    return { status: 'ok', pids };
  }
  function verifyThenSignal(pid, startedAt, signal) {
    const status = check(pid, startedAt);
    if (status !== 'match') return status;
    try {
      kill(pid, signal);
      return 'match';
    } catch {
      return 'query_failed';
    }
  }
  return { findMarked, check, listMarkedDescendants, verifyThenSignal, signal: verifyThenSignal };
}
module.exports = { createPsIdentityProbe };
