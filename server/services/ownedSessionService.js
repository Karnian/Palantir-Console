'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const launcher = require('../sessionHost/launcher');
const { createPsIdentityProbe } = require('../sessionHost/psIdentity');
const { isWithinRoot } = require('../utils/pathGuard');
const POLL_MS = 500;
const MAX_BODY_BYTES = 512 * 1024;
const KINDS = new Set(['start', 'prompt', 'tool_decision', 'question_answer', 'interrupt', 'stop', 'resume', 'close', 'delete']);
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
function validateKey(key) {
  if (typeof key !== 'string' || key.length > 256 || !/^rk_\d{1,16}_[a-fA-F0-9]{16,}$/.test(key)) throw failure('invalid_request_key');
  return key;
}
function validateCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) throw failure('invalid_cwd');
  try {
    const real = fs.realpathSync(cwd);
    // Console's documented system-directory policy, with canonical containment checks.
    const blocked = ['/', '/etc', '/var', '/usr', '/bin', '/sbin', '/System', '/private/etc', '/private/var'];
    if (blocked.some(root => root === '/' ? real === root : isWithinRoot(root, real)) || !fs.statSync(real).isDirectory()) {
      throw failure('invalid_cwd');
    }
    return real;
  } catch { throw failure('invalid_cwd'); }
}
function lockStatus(runtimeDir, identityProbe = createPsIdentityProbe()) {
  const file = path.join(runtimeDir, 'host.lock');
  if (!fs.existsSync(file)) return { held: false };
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    db.prepare('SELECT pid FROM owner').get();
    return { held: false };
  } catch (error) {
    if (error.code !== 'SQLITE_BUSY' && error.code !== 'SQLITE_LOCKED') return { held: true, pid: null, identity: { status: 'query_failed' } };
    let copy;
    try {
      // Only the lock metadata is inspected. Never open the host's session database.
      copy = new Database(fs.readFileSync(file));
      const pid = copy.prepare('SELECT pid FROM owner').get()?.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw failure('invalid_lock');
      const identity = identityProbe.readStartTime(pid);
      return { held: true, pid, identity: identity.status === 'ok' ?
        { status: 'ok', startedAt: identity.startedAt } : { status: 'query_failed' } };
    } catch { return { held: true, pid: null, identity: { status: 'query_failed' } }; }
    finally { copy?.close(); }
  } finally { db?.close(); }
}
function createOwnedSessionService({ runtimeDir = path.resolve(process.cwd(), 'runtime', 'session-host'),
  createClient = launcher.createClient, ensureHost = launcher.ensureHost, diagnose = () => lockStatus(runtimeDir),
  timers = globalThis, pollMs = POLL_MS, clock = Date.now } = {}) {
  const client = createClient({ runtimeDir });
  const cache = new Map();
  const subscribers = new Set();
  let closed = false;
  let timer;
  let polling;
  let connecting;
  let bootId;
  let startup;
  function emit(subscriber, event, data) {
    if (!subscribers.has(subscriber)) return;
    try { subscriber.send(event, data); } catch { subscribers.delete(subscriber); }
  }
  async function connect() {
    if (closed) throw failure('service_closed', 503);
    if (connecting) return connecting;
    connecting = (async () => {
      await client.connect();
      if (closed) { client.close(); throw failure('service_closed', 503); }
      const changed = bootId !== undefined && bootId !== client.hostBootId;
      if (changed) await client.reconcile();
      bootId = client.hostBootId;
      for (const subscriber of subscribers) {
        if (subscriber.offline) emit(subscriber, 'reconnected', { host_boot_id: bootId, seq: subscriber.seq });
        if (changed) {
          subscriber.paused = true;
          emit(subscriber, 'resync', { host_boot_id: bootId, seq: subscriber.seq });
        }
        subscriber.offline = false;
      }
      return client;
    })();
    try { return await connecting; } finally { connecting = null; }
  }
  function unavailable(key) {
    const diagnosis = diagnose();
    const previous = cache.get(key);
    if (!diagnosis.held) return { host: 'not_running' };
    return { host: 'unreachable', current_state_known: false, as_of: previous?.as_of ?? null,
      last_known: previous?.value ?? null, diagnostics: { pid: diagnosis.pid ?? null,
        identity: diagnosis.identity || { status: 'query_failed' } } };
  }
  async function read(key, operation) {
    try {
      await connect();
      const result = await operation(client);
      cache.set(key, { as_of: clock(), value: result });
      return { host: 'running', host_boot_id: bootId, ...result };
    } catch { return unavailable(key); }
  }
  async function writable() {
    try { return await connect(); } catch {
      if (closed || diagnose().held) throw failure('host_unreachable', 503);
      if (!startup) startup = (async () => {
        const ready = await ensureHost({ runtimeDir });
        ready.close();
      })().finally(() => { startup = null; });
      try { await startup; return await connect(); } catch { throw failure('host_unreachable', 503); }
    }
  }
  async function submit(request) {
    validateKey(request?.request_key);
    if (!KINDS.has(request.kind)) throw failure('invalid_request');
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_BODY_BYTES) throw failure('body_too_large', 413);
    if (request.node_id !== undefined && request.node_id !== 'local') throw failure('local_node_required');
    if (request.kind === 'start') {
      if (request.confirmed_settings !== true) throw failure('settings_confirmation_required');
      request = { ...request, cwd: validateCwd(request.cwd) };
    }
    const host = await writable();
    try {
      if (['prompt', 'tool_decision', 'question_answer', 'interrupt'].includes(request.kind)) {
        const existing = await host.lookup(request.request_key);
        // Scrubbed tombstones have no original incarnation to bind a new submission to.
        if (existing.session_deleted) return { acceptance: 'rejected', request_key: request.request_key,
          code: 'session_deleted', result: existing };
        const snapshot = existing.found === false ? await host.snapshot(request.session_id) : null;
        request = { ...request, incarnation_id: existing.incarnation_id || snapshot?.state?.incarnations?.at(-1)?.id || null };
      }
      const result = await host.submit(request);
      return { acceptance: 'accepted', request_key: request.request_key, result };
    } catch (error) {
      if (error.message === 'acceptance_unknown') return { acceptance: 'acceptance_unknown', request_key: request.request_key };
      const codes = new Set(['invalid_request', 'key_expired', 'key_future', 'fingerprint_conflict', 'not_accepted']);
      if (codes.has(error.code || error.message)) return { acceptance: 'rejected', request_key: request.request_key,
        code: error.code || error.message };
      throw failure('host_unreachable', 503);
    }
  }
  async function poll() {
    if (closed || !subscribers.size) return;
    try {
      await connect();
      for (const subscriber of [...subscribers]) {
        if (subscriber.paused) continue;
        const result = await client.eventsSince(subscriber.seq);
        if (result.snapshot_required) {
          subscriber.paused = true;
          emit(subscriber, 'resync', { seq: subscriber.seq, host_boot_id: bootId });
        } else {
          for (const event of result.events) {
            emit(subscriber, 'event', event);
            subscriber.seq = event.seq;
          }
        }
      }
    } catch {
      for (const subscriber of subscribers) {
        if (!subscriber.offline) emit(subscriber, 'host_unreachable', { seq: subscriber.seq, current_state_known: false });
        subscriber.offline = true;
      }
    }
  }
  function schedule() {
    if (closed || !subscribers.size || timer !== undefined || polling) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      polling = poll().finally(() => { polling = null; schedule(); });
    }, pollMs);
    timer?.unref?.();
  }
  return {
    list: () => read('list', host => host.list()),
    snapshot: id => read(`snapshot:${id}`, host => host.snapshot(id)),
    lookup(key) { validateKey(key); return read(`lookup:${key}`, async host => ({ result: await host.lookup(key) })); },
    submit,
    async settingsPreview(cwd) {
      cwd = validateCwd(cwd);
      const host = await writable();
      try { return await host.settingsPreview(cwd); } catch { throw failure('host_unreachable', 503); }
    },
    subscribe(since, send) {
      if (!Number.isSafeInteger(since) || since < 0) throw failure('invalid_since');
      if (closed) throw failure('service_closed', 503);
      const subscriber = { seq: since, send, offline: false, paused: false };
      subscribers.add(subscriber); schedule();
      return () => {
        subscribers.delete(subscriber);
        if (!subscribers.size && timer !== undefined) { timers.clearTimeout(timer); timer = undefined; }
      };
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      for (const subscriber of subscribers) emit(subscriber, 'shutdown', { seq: subscriber.seq });
      subscribers.clear();
      client.close();
      await Promise.allSettled([polling, connecting, startup]);
    }
  };
}
module.exports = { createOwnedSessionService, validateKey, validateCwd, lockStatus, POLL_MS, MAX_BODY_BYTES };
