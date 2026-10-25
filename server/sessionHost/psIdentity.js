'use strict';
const childProcess = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { validId } = require('./spawnEnv');
const failed = () => ({ status: 'query_failed' });
const startPattern = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) \d{4}$/;
function normalizeStart(value, psOutput = false) {
  if (typeof value !== 'string') return null;
  // ps adds one line terminator; the timestamp itself must contain no line breaks.
  const line = (psOutput && value.endsWith('\n') ? value.slice(0, -1) : value).replace(/ +$/, '');
  if (/[\r\n]/.test(line)) return null;
  const match = startPattern.exec(line);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 31 ||
      Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  return line.replace(/ +/g, ' ');
}
function isAbsent(error) {
  return error != null && error.status === 1 && error.signal == null && !error.code &&
    (typeof error.stdout === 'string' || Buffer.isBuffer(error.stdout)) && error.stdout.length === 0 &&
    (typeof error.stderr === 'string' || Buffer.isBuffer(error.stderr)) && error.stderr.length === 0;
}
function markerState(output, id) {
  const exact = new RegExp(`(?:^|\\s)PALANTIR_OWNED_INCARNATION=${id}(?=\\s|$)`).test(output);
  const endings = output.matchAll(/(?:^|\s)PALANTIR_OWNED_INCARNATION=([^\s]*)$/gm);
  const partial = [...endings].some(match => match[1].length < id.length && id.startsWith(match[1]));
  return { exact, partial };
}
function createPsIdentityProbe({ pinnedPath, execFileSync = childProcess.execFileSync, kill = process.kill.bind(process),
  clock = () => performance.now(), maxPids = 4096, deadlineMs = 10000 } = {}) {
  const roots = new Map();
  function run(args, budget) {
    let timeout = 5000;
    if (budget) {
      const remaining = deadlineMs - (clock() - budget.started);
      if (remaining <= 0) throw Error('ps_query_failed');
      timeout = Math.min(timeout, Math.ceil(remaining));
      budget.queryCount++;
    }
    const output = execFileSync('/bin/ps', args, {
      encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: { LC_ALL: 'C' }
    });
    if (budget && clock() - budget.started >= deadlineMs) throw Error('ps_query_failed');
    return output;
  }
  function readProcess(args, budget) {
    try {
      const output = run(args, budget);
      return typeof output === 'string' && output.trim() ? { status: 'ok', output } : failed();
    } catch (error) {
      return isAbsent(error) ? { status: 'absent' } : failed();
    }
  }
  function start(pid, budget) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'query_failed' };
    try {
      const output = run(['-o', 'lstart=', '-p', String(pid)], budget);
      const startedAt = normalizeStart(output, true);
      if (!startedAt) return failed();
      return { status: 'ok', startedAt };
    } catch (error) {
      // macOS ps reports an absent PID with status 1 and no stdout/stderr.
      if (isAbsent(error)) return { status: 'absent' };
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
  function candidateMapping(output, id) {
    const candidates = [];
    let nearestPid;
    for (const line of output.split('\n')) {
      const row = /^ *([1-9]\d*) /.exec(line);
      if (row) nearestPid = Number(row[1]);
      if (markerState(line, id).exact) candidates.push(nearestPid);
    }
    return candidates;
  }
  function scanCandidates(output, pids, id, budget) {
    const candidates = candidateMapping(output, id);
    const knownPids = new Set(pids);
    if (candidates.some(pid => !knownPids.has(pid))) return null;
    if (new Set(candidates).size !== candidates.length) return null;
    const marked = [];
    for (const pid of candidates) {
      const before = start(pid, budget);
      if (before.status === 'absent') return null;
      if (before.status !== 'ok') return failed();
      const command = readProcess(['-E', '-ww', '-o', 'command=', '-p', String(pid)], budget);
      if (command.status === 'absent') return null;
      if (command.status !== 'ok') return failed();
      const marker = markerState(command.output, id);
      if (marker.partial) return failed();
      if (!marker.exact) return null;
      const markers = command.output.split(/\s+/).filter(token => token.startsWith('PALANTIR_OWNED_INCARNATION='));
      if (markers.length !== 1) return failed();
      const parent = readProcess(['-o', 'ppid=', '-p', String(pid)], budget);
      if (parent.status === 'absent') return null;
      if (parent.status !== 'ok') return failed();
      const parentLine = parent.output.endsWith('\n') ? parent.output.slice(0, -1) : parent.output;
      const ppid = /^ *\d+ *$/.test(parentLine) ? Number(parentLine) : NaN;
      if (!Number.isSafeInteger(ppid)) return failed();
      const after = start(pid, budget);
      if (after.status === 'absent') return null;
      if (after.status !== 'ok' || before.startedAt !== after.startedAt) return failed();
      marked.push({ pid, startedAt: before.startedAt, ppid, command: command.output });
    }
    // Adopt only an injective mapping whose every candidate has a per-PID marker,
    // no candidate was absent, and a fresh global mapping still agrees. Only then
    // does equal cardinality justify the bijection; ambiguity uses the full scan.
    const fresh = run(['-E', '-ww', '-A', '-o', 'pid=,command='], budget);
    if (typeof fresh !== 'string' || !fresh.trim() || markerState(fresh, id).partial) return failed();
    const mapping = candidateMapping(fresh, id);
    if (mapping.some(pid => !knownPids.has(pid))) return failed();
    if (mapping.length !== candidates.length || mapping.some((pid, index) => pid !== candidates[index])) return null;
    return { status: marked.length ? 'ok' : 'inconsistent', marked };
  }
  function scanOnce(id, budget) {
    // Global command output supplies untrusted candidates: argv may contain arbitrary newlines.
    const output = run(['-E', '-ww', '-A', '-o', 'pid=,command='], budget);
    if (typeof output !== 'string' || !output.trim()) return failed();
    const globalMarker = markerState(output, id);
    if (globalMarker.partial) return failed();
    if (!globalMarker.exact) return { status: 'ok', marked: [] };
    const pidOutput = run(['-A', '-o', 'pid='], budget);
    if (typeof pidOutput !== 'string' || !pidOutput.trim()) return failed();
    const lines = (pidOutput.endsWith('\n') ? pidOutput.slice(0, -1) : pidOutput).split('\n');
    if (budget.pidCount + lines.length > maxPids) return failed();
    const pids = lines.map(line => /^ *[1-9]\d* *$/.test(line) ? Number(line) : NaN);
    if (pids.some(pid => !Number.isSafeInteger(pid)) || new Set(pids).size !== pids.length) return failed();
    budget.pidCount += pids.length;
    const candidates = scanCandidates(output, pids, id, budget);
    if (candidates) return candidates;
    // Keep the conservative full scan for ambiguous or forged global attribution.
    const marked = [];
    for (const pid of pids) {
      // Read before every command: whether this PID is marked is not known yet.
      const before = start(pid, budget);
      if (before.status === 'absent') continue;
      if (before.status !== 'ok') return failed();
      const command = readProcess(['-E', '-ww', '-o', 'command=', '-p', String(pid)], budget);
      if (command.status === 'absent') continue;
      if (command.status !== 'ok') return failed();
      const marker = markerState(command.output, id);
      if (marker.partial) return failed();
      if (!marker.exact) continue;
      const markers = command.output.split(/\s+/).filter(token => token.startsWith('PALANTIR_OWNED_INCARNATION='));
      if (markers.length !== 1) return failed();
      const parent = readProcess(['-o', 'ppid=', '-p', String(pid)], budget);
      if (parent.status === 'absent') continue;
      if (parent.status !== 'ok') return failed();
      const parentLine = parent.output.endsWith('\n') ? parent.output.slice(0, -1) : parent.output;
      const ppid = /^ *\d+ *$/.test(parentLine) ? Number(parentLine) : NaN;
      if (!Number.isSafeInteger(ppid)) return failed();
      const after = start(pid, budget);
      if (after.status === 'absent') continue;
      if (after.status !== 'ok' || before.startedAt !== after.startedAt) return failed();
      marked.push({ pid, startedAt: before.startedAt, ppid, command: command.output });
    }
    return { status: marked.length ? 'ok' : 'inconsistent', marked };
  }
  function scan(id) {
    const budget = { started: clock(), queryCount: 0, pidCount: 0 };
    function finish(result) {
      const elapsedMs = Math.max(0, clock() - budget.started);
      const diagnostics = { elapsedMs, queryCount: budget.queryCount };
      return { ...(elapsedMs >= deadlineMs ? failed() : result), diagnostics };
    }
    if (!validId(id) || !Number.isSafeInteger(maxPids) || maxPids < 1 || maxPids > 4096 ||
        !Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 10000) return finish(failed());
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = scanOnce(id, budget);
        if (result.status !== 'inconsistent') return finish(result);
      }
      return finish(failed());
    } catch {
      return finish(failed());
    }
  }
  function findMarked(id) {
    if (typeof pinnedPath !== 'string' || !path.isAbsolute(pinnedPath) || /[\0\r\n]/.test(pinnedPath)) {
      return { ...failed(), diagnostics: { elapsedMs: 0, queryCount: 0 } };
    }
    const result = scan(id);
    const { diagnostics } = result;
    if (result.status !== 'ok') return { ...failed(), diagnostics };
    if (!result.marked.length) return { status: 'ok', pids: [], diagnostics };
    const candidates = result.marked.filter(row => !result.marked.some(parent => parent.pid === row.ppid));
    if (candidates.length !== 1 || !candidates[0].command.startsWith(`${pinnedPath} `)) return { ...failed(), diagnostics };
    const { pid, startedAt } = candidates[0];
    roots.set(id, { pid, startedAt });
    return { status: 'ok', pids: [{ pid, startedAt }], diagnostics };
  }
  function listMarkedDescendants(id) {
    const result = scan(id);
    if (result.status !== 'ok') return { ...failed(), diagnostics: result.diagnostics };
    const root = roots.get(id);
    // Without a previously identified main, retain every marked process for conservative cleanup.
    const pids = result.marked.filter(row => !root || row.pid !== root.pid || row.startedAt !== root.startedAt)
      .map(({ pid, startedAt }) => ({ pid, startedAt }));
    return { status: 'ok', pids, diagnostics: result.diagnostics };
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
  return {
    findMarked, check, listMarkedDescendants, verifyThenSignal, signal: verifyThenSignal,
    readStartTime(pid) {
      const result = start(pid);
      return result.status === 'ok' ? result : failed();
    }
  };
}
module.exports = { createPsIdentityProbe };
