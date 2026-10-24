'use strict';
const childProcess = require('node:child_process');
const { validId } = require('./spawnEnv');
const failed = () => ({ status: 'query_failed' });
const startPattern = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
function createPsIdentityProbe({ execFileSync = childProcess.execFileSync, kill = process.kill.bind(process) } = {}) {
  const roots = new Map();
  function run(args) {
    return execFileSync('/bin/ps', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { LC_ALL: 'C' } });
  }
  function start(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'query_failed' };
    try {
      const output = run(['-o', 'lstart=', '-p', String(pid)]);
      if (typeof output !== 'string' || !startPattern.test(output.trim())) return failed();
      return { status: 'ok', startedAt: output.trim() };
    } catch (error) {
      // macOS ps reports an absent PID with status 1 and no stdout/stderr.
      if (error.status === 1 && error.signal == null && !error.code &&
          String(error.stdout ?? '').trim() === '' && String(error.stderr ?? '').trim() === '') return { status: 'absent' };
      return failed();
    }
  }
  function check(pid, startedAt) {
    if (typeof startedAt !== 'string' || !startPattern.test(startedAt)) return 'query_failed';
    const found = start(pid);
    if (found.status === 'absent') return 'mismatch_confirmed';
    if (found.status !== 'ok') return 'query_failed';
    return found.startedAt === startedAt ? 'match' : 'mismatch_confirmed';
  }
  function scan(id) {
    if (!validId(id)) return failed();
    try {
      const output = run(['-E', '-ww', '-A', '-o', 'pid=,command=']);
      if (typeof output !== 'string' || !output.trim()) return failed();
      const marked = [];
      const seen = new Set();
      for (const line of output.trimEnd().split('\n')) {
        const row = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!row || !Number.isSafeInteger(Number(row[1])) || Number(row[1]) <= 0 || seen.has(Number(row[1]))) return failed();
        const pid = Number(row[1]);
        seen.add(pid);
        const tokens = row[2].split(/\s+/);
        if (!tokens.includes(`PALANTIR_OWNED_INCARNATION=${id}`)) continue;
        if (tokens.filter(token => token.startsWith('PALANTIR_OWNED_INCARNATION=')).length !== 1) return failed();
        const identity = start(pid);
        if (identity.status !== 'ok') return failed();
        const parent = run(['-o', 'ppid=', '-p', String(pid)]);
        if (typeof parent !== 'string' || !/^\s*\d+\s*$/.test(parent)) return failed();
        marked.push({ pid, startedAt: identity.startedAt, ppid: Number(parent.trim()) });
      }
      return { status: 'ok', marked };
    } catch {
      return failed();
    }
  }
  function findMarked(id) {
    const result = scan(id);
    if (result.status !== 'ok') return failed();
    if (!result.marked.length) return { status: 'ok', pids: [] };
    const candidates = result.marked.filter(row => !result.marked.some(parent => parent.pid === row.ppid));
    if (candidates.length !== 1) return failed();
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
