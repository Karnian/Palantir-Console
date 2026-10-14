'use strict';

const snapshotStore = require('./observeSnapshotStore');
const { validateAnswerEnvelope } = require('./observeSnapshotPolicy');
const { parseSnapshotTargets } = require('./snapshotTargets');
const { prepareSnapshotCli, runSnapshotCli, cancelCliRun } = require('./snapshotCliRunner');
const { reapProcessGroup } = require('../utils/reapProcessGroup');
const fail = (code, status) => Object.assign(new Error(code), { code, status });
const FIELDS = Object.freeze(['status', 'reason', 'text', 'truncated', 'redacted', 'shared_turn', 'answer_at', 'observed_at']);

function createAnswerQueryService(options = {}) {
  const env = { ...(options.env || process.env) };
  const store = options.store || snapshotStore;
  const observeState = options.observeState || { on: false };
  const clock = options.clock || (() => new Date());
  const now = () => new Date(clock()).toISOString();
  const timeoutMs = Math.min(options.timeoutMs ?? 30000, 30000);
  let targets = [];
  try { targets = parseSnapshotTargets(env.PALANTIR_SNAPSHOT_TARGETS); }
  catch { (options.warn || console.warn)('snapshot_targets_invalid'); }
  const active = new Map(); const locked = new Map(); const cooling = new Map();
  let closed = false; let shutdownPromise;
  const status = (value, reason) => ({ status: value, reason, text: null, truncated: false,
    redacted: false, shared_turn: false, answer_at: null, observed_at: now() });

  async function execute(machineId, expectedTarget, target, run) {
    let remoteTimedOut = false;
    try {
      const cli = prepareSnapshotCli({ ...options, env, source: 'answer-query:cli' });
      const argv = target.kind === 'ssh' ? ['remote', '--host', target.host] : [];
      if (target.remoteNode) argv.push('--remote-node', target.remoteNode);
      argv.push('answer', '--instruction', `${expectedTarget.instrId}#${expectedTarget.ref}`,
        '--file-fp', expectedTarget.file_fp, '--emit-envelope');
      // Snapshot validation and CLI setup consume the same request-time budget.
      const remainingMs = Math.min(timeoutMs, run.startedAt + timeoutMs - +new Date(clock()));
      if (remainingMs <= 0) {
        cancelCliRun(run, 'timeout');
        return status('unavailable', run.cancelled === 'timeout' ? 'timeout' : 'exec_failed');
      }
      const result = await runSnapshotCli({ ...cli, argv, run, timeoutMs: remainingMs, reapOptions: options.reapOptions,
        spawn: options.spawn, maxStdoutBytes: 128 * 1024, waitForOutput: true });
      if (result.code === 'timeout') return status('unavailable', 'timeout');
      if (result.status_code !== 0 || run.stdout.truncated) return status('unavailable', 'exec_failed');
      const raw = Buffer.concat(run.stdout.chunks).toString('utf8');
      // Exactly one JSON line; one final line terminator is optional.
      const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
      if (!line || Buffer.byteLength(line, 'utf8') > 65536 || /[\r\n]/.test(line)) return status('unavailable', 'exec_failed');
      const envelope = JSON.parse(line);
      if (!validateAnswerEnvelope(envelope, { allowDiag: false, expectedMachineId: machineId, expectedTarget }).ok) {
        return status('unavailable', 'exec_failed');
      }
      remoteTimedOut = envelope.status === 'unavailable' && envelope.reason === 'timeout';
      return Object.fromEntries(FIELDS.map(key => [key, envelope[key]]));
    } catch (error) {
      if (error.code === 'reap_failed' || run.reaping && await run.reaping.then(() => false, () => true)) {
        locked.set(machineId, run.pgid);
        (options.warn || console.warn)('reap_failed');
      }
      return status('unavailable', 'exec_failed');
    } finally {
      // SSH must launch within the server's 30s execution window; the remote reader
      // then has its own 25s deadline. Reserve this machine until request start + 60s.
      // The remote overlap bound depends on the remote reader's cooperative 25s
      // deadline. A blocked readSync (disk/NFS stall), or a single operation stalled
      // between deadline checks, is outside the threat model. Cooling retains global capacity.
      if (target.kind === 'ssh' && (run.cancelled || remoteTimedOut)) {
        cooling.set(machineId, run.startedAt + 60000);
      }
    }
  }
  function query({ machineId, sessionKey, instructionId, rev }) {
    const startedAt = +new Date(clock());
    for (const [machine, until] of cooling) if (startedAt >= until) cooling.delete(machine);
    if (!closed && cooling.has(machineId)) throw fail('answer_busy', 429);
    let result;
    try { result = store.readSnapshotHashed(observeState, machineId); }
    catch { throw fail('snapshot_unavailable', 503); }
    if (!result.ok) throw fail(result.reason === 'not_found' ? 'not_found' : 'snapshot_unavailable',
      result.reason === 'not_found' ? 404 : 503);
    if (result.sha256 !== rev) throw fail('snapshot_changed', 409);
    const session = result.snapshot.sessions.find(value => value.key === sessionKey);
    const instruction = result.snapshot.instructions.find(value => value.id === instructionId && value.session_key === sessionKey);
    if (!session || !instruction) throw fail('not_found', 404);
    if (!session.file_fp) return Promise.resolve(status('target_changed', 'file_missing'));
    const target = targets.find(value => value.machineId === machineId);
    if (!target) throw fail('snapshot_unavailable', 503);
    if (closed || locked.has(machineId)) return Promise.resolve(status('unavailable', 'exec_failed'));
    const expectedTarget = { instrId: instruction.id, ref: instruction.ref, file_fp: session.file_fp };
    const key = JSON.stringify([machineId, instruction.id, instruction.ref, session.file_fp]);
    if (active.has(key)) return active.get(key).task;
    // Unreaped groups retain their global capacity as well as their machine lock.
    if (active.size + locked.size + cooling.size >= 2
      || [...active.values()].some(entry => entry.machineId === machineId)) throw fail('answer_busy', 429);
    const run = { cancelled: null, pgid: null, startedAt };
    run.cancellation = new Promise(resolve => { run.resolveCancellation = resolve; });
    const entry = { machineId, run };
    entry.task = Promise.resolve().then(() => execute(machineId, expectedTarget, target, run))
      .finally(() => { active.delete(key); });
    active.set(key, entry);
    return entry.task;
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    for (const entry of active.values()) cancelCliRun(entry.run, 'cancelled');
    // Await local group reaping, but not cooling: remote readers finish under
    // their own deadline within the bound above, with no server-side timer to drain.
    shutdownPromise = Promise.allSettled([...active.values()].map(entry => entry.task)).then(async () => {
      const results = await Promise.allSettled([...locked.values()].map(pgid => reapProcessGroup(pgid, options.reapOptions)));
      if (results.some(result => result.status === 'rejected')) throw fail('reap_failed', 503);
    });
    return shutdownPromise;
  }
  return { query, shutdown };
}
module.exports = { createAnswerQueryService };
