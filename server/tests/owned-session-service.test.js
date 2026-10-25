'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers/session-host-fixture');
const { createOwnedSessionService, lockStatus } = require('../services/ownedSessionService');
const { acquireLock } = require('../sessionHost/lock');
function bridge(t, options = {}) {
  const f = fixture(t, { manual: true });
  let online = true, held = false, boot = 'one', launches = 0, connects = 0, lookups = 0, closes = 0;
  let reconcileCalls = 0, loseReply = false;
  const scheduled = new Map();
  let timerId = 0;
  const client = {
    async connect() { connects++; if (!online) throw Error('private socket error'); },
    get hostBootId() { return boot; },
    async reconcile() { reconcileCalls++; return client.lookup('unknown'); },
    list: () => f.core.listSessions(), snapshot: id => f.core.snapshot(id),
    lookup(key) { lookups++; return f.core.lookup(key); },
    settingsPreview: cwd => f.core.settingsPreview(cwd),
    eventsSince: seq => f.core.eventsSince(seq),
    async submit(req) {
      const receipt = f.core.submitWithReceipt(req);
      if (loseReply) { loseReply = false; throw Error('acceptance_unknown'); }
      if (!receipt.durable) throw Object.assign(Error(receipt.code), { code: receipt.code });
      return receipt.result;
    },
    close() { closes++; }
  };
  const service = createOwnedSessionService({ createClient: () => client,
    ensureHost: async () => { launches++; online = true; return { close() {} }; },
    diagnose: () => ({ held, pid: 123, identity: { status: 'query_failed' } }),
    timers: { setTimeout(fn) { const id = ++timerId; scheduled.set(id, fn); return id; }, clearTimeout(id) { scheduled.delete(id); } },
    clock: () => f.time, ...options });
  t.after(() => service.shutdown());
  return { f, service, client, scheduled, set online(value) { online = value; }, set held(value) { held = value; },
    set boot(value) { boot = value; }, set loseReply(value) { loseReply = value; },
    get launches() { return launches; }, get lookups() { return lookups; }, get connects() { return connects; },
    get closes() { return closes; }, get reconciles() { return reconcileCalls; },
    async tick() { const [id, fn] = scheduled.entries().next().value || []; scheduled.delete(id); fn?.();
      for (let i = 0; i < 100; i++) await Promise.resolve(); }
  };
}
test('reads never launch host, distinguish absent lock and unreachable stale values', async t => {
  const h = bridge(t); h.online = false;
  assert.deepEqual(await h.service.list(), { host: 'not_running' });
  assert.deepEqual(await h.service.snapshot('missing'), { host: 'not_running' });
  assert.deepEqual(await h.service.lookup(h.f.key()), { host: 'not_running' });
  assert.equal(h.launches, 0);
  h.online = true; h.f.start();
  const known = await h.service.snapshot(h.f.sid);
  h.online = false; h.held = true;
  const stale = await h.service.snapshot(h.f.sid);
  assert.equal(stale.host, 'unreachable'); assert.equal(stale.current_state_known, false);
  assert.equal(stale.as_of, h.f.time); assert.equal(stale.last_known.state.session.id, known.state.session.id);
  assert.equal(stale.last_known.state.session.state, known.state.session.state);
  assert.equal(h.launches, 0);
});
for (const kind of ['start', 'prompt', 'tool_decision', 'question_answer', 'interrupt', 'stop', 'resume', 'close', 'delete']) {
  test('unreachable lock owner rejects mutation: ' + kind, async t => {
    const h = bridge(t); h.online = false; h.held = true;
    await assert.rejects(h.service.submit({ kind, request_key: h.f.key(), cwd: process.cwd(), confirmed_settings: true, incarnation_id: '12345678-1234-1234-1234-123456789abc' }),
      { code: 'host_unreachable', status: 503 });
    assert.equal(h.launches, 0);
  });
}
test('settings preview fails 503 for unreachable owner', async t => {
  const h = bridge(t); h.online = false; h.held = true;
  await assert.rejects(h.service.settingsPreview(process.cwd()), { code: 'host_unreachable', status: 503 });
});
test('mutation launches missing host, preserves key and distinguishes unknown and rejected', async t => {
  const h = bridge(t); h.online = false;
  const req = { kind: 'start', request_key: h.f.key(), cwd: process.cwd(), confirmed_settings: true };
  h.loseReply = true;
  assert.equal((await h.service.submit(req)).acceptance, 'acceptance_unknown');
  assert.equal(h.launches, 1);
  const accepted = await h.service.submit(req);
  assert.equal(accepted.acceptance, 'accepted'); assert.equal(accepted.request_key, req.request_key);
  assert.equal(h.f.adapter.log.starts.length, 1);
  const conflict = await h.service.submit({ ...req, cwd: '/private/tmp' });
  assert.equal(conflict.acceptance, 'rejected'); assert.equal(conflict.code, 'fingerprint_conflict');
  h.boot = 'two'; await h.service.list(); assert.equal(h.reconciles, 1);
});
test('request format, confirmation, cwd and remote node fail before host access', async t => {
  const h = bridge(t);
  const req = { kind: 'start', request_key: h.f.key(), cwd: process.cwd(), confirmed_settings: true };
  for (const change of [{ request_key: 'bad' }, { confirmed_settings: false }, { cwd: 'relative' },
    { cwd: '/does-not-exist-owned-session' }, { cwd: '/etc' }, { cwd: '/' }, { node_id: 'remote' }]) {
    await assert.rejects(h.service.submit({ ...req, ...change }), { status: 400 });
  }
  assert.equal(h.connects, 0);
  const link = path.join(h.f.dir, 'system-link'); fs.symlinkSync('/etc', link);
  await assert.rejects(h.service.submit({ ...req, cwd: link }), { code: 'invalid_cwd' });
  const file = path.join(h.f.dir, 'file'); fs.writeFileSync(file, 'x');
  await assert.rejects(h.service.submit({ ...req, cwd: file }), { code: 'invalid_cwd' });
  await assert.rejects(h.service.submit({ kind: 'prompt', incarnation_id: '12345678-1234-1234-1234-123456789abc', request_key: h.f.key(), body: 'x'.repeat(600000) }), { status: 413 });
});
test('snapshot to subscription replays intervening raw message without gaps and polls only with subscribers', async t => {
  const h = bridge(t); h.f.start();
  assert.equal(h.scheduled.size, 0);
  const snapshot = await h.service.snapshot(h.f.sid);
  h.f.core.onEvent({ type: 'sdk_message', incarnation_id: h.f.iid, message: { text: 'intervening' } });
  const frames = [];
  const off = h.service.subscribe(snapshot.seq_high, (event, data) => frames.push({ event, data }));
  await h.tick();
  assert.equal(frames[0].event, 'event'); assert.equal(frames[0].data.seq, snapshot.seq_high + 1);
  assert.deepEqual(frames[0].data.json, { message: { text: 'intervening' } });
  off(); assert.equal(h.scheduled.size, 0);
});
test('replay gap emits resync; disconnect/reconnect includes last seq and boot change resync', async t => {
  const h = bridge(t); const frames = [];
  const off = h.service.subscribe(999, (event, data) => frames.push({ event, data }));
  await h.tick(); assert.equal(frames.at(-1).event, 'resync'); off();
  h.service.subscribe(0, (event, data) => frames.push({ event, data }));
  h.online = false; await h.tick();
  assert.equal(frames.at(-1).event, 'host_unreachable'); assert.equal(frames.at(-1).data.seq, 0);
  h.online = true; await h.tick(); assert.equal(frames.at(-1).event, 'reconnected');
  h.boot = 'two'; await h.tick(); assert.equal(frames.at(-1).event, 'resync');
});
test('bridge replacement preserves host pending approvals and sends decision exactly once', async t => {
  const h = bridge(t); h.f.start(); h.f.adapter.toolRequest(h.f.iid, 'tool', 'Bash', { command: 'fake' });
  await h.service.snapshot(h.f.sid); await h.service.shutdown();
  const service = createOwnedSessionService({ createClient: () => h.client, diagnose: () => ({ held: true }) });
  t.after(() => service.shutdown());
  assert.equal((await service.snapshot(h.f.sid)).state.tool_requests[0].state, 'pending');
  const req = { kind: 'tool_decision', incarnation_id: h.f.iid, session_id: h.f.sid, request_key: h.f.key(), target_tool_use_id: 'tool', body: { behavior: 'allow' } };
  assert.equal((await service.submit(req)).acceptance, 'accepted'); await service.submit(req);
  assert.equal(h.f.adapter.log.decisions.length, 1);
  assert.equal(h.f.adapter.log.closes.length, 0);
});
test('lock diagnosis never opens session DB and free stale lock means not running', t => {
  const h = bridge(t); const lock = acquireLock(h.f.dir); lock.release();
  assert.deepEqual(lockStatus(h.f.dir), { held: false });
});

test('DB write failure refuses bridge transmission without exposing private error or executing a prompt', async t => {
  const h = bridge(t); h.f.start();
  const original = h.f.faults.hit.bind(h.f.faults);
  h.f.faults.hit = point => { if (point === 'db_write') throw Error('PRIVATE DB /path'); return original(point); };
  await assert.rejects(h.service.submit({ kind: 'prompt', incarnation_id: h.f.iid, request_key: h.f.key(), session_id: h.f.sid, body: 'hello' }),
    { code: 'host_unreachable', status: 503 });
  assert.equal(h.f.adapter.log.received.length, 0);
});

test('scrubbed tombstone retries preserve client incarnation and return the durable result', async t => {
  const h = bridge(t); h.f.start();
  const req = { kind: 'prompt', incarnation_id: h.f.iid, request_key: h.f.key(), session_id: h.f.sid, body: 'hello' };
  await h.service.submit(req);
  h.f.core.submit(h.f.req('close')); h.f.core.submit(h.f.req('delete'));
  const retry = await h.service.submit(req);
  assert.equal(retry.acceptance, 'accepted');
  assert.equal(retry.result.session_deleted, 1);
  assert.equal(h.f.adapter.log.received.length, 1);
});

test('held lock diagnosis returns only pid and projected identity facts', t => {
  const h = bridge(t); const lock = acquireLock(h.f.dir);
  t.after(() => lock.release());
  const status = lockStatus(h.f.dir, { readStartTime: () => ({ status: 'ok', startedAt: 'known-birth', env: 'PRIVATE' }) });
  assert.deepEqual(status, { held: true, pid: process.pid, identity: { status: 'ok', startedAt: 'known-birth' } });
});

test('R5 invalid answer is a definitive rejected receipt and can be corrected on the same pending card', async t => {
  const h = bridge(t); h.f.start();
  h.f.adapter.toolRequest(h.f.iid, 'question', 'AskUserQuestion', { questions: [{ question: 'Which?' }] });
  const request = { kind: 'question_answer', request_key: h.f.key(), session_id: h.f.sid, incarnation_id: h.f.iid,
    target_tool_use_id: 'question', body: { answer: { Choice: 'A' } } };
  const invalid = await h.service.submit(request);
  assert.equal(invalid.acceptance, 'rejected'); assert.equal(invalid.code, 'invalid_answer');
  assert.equal(h.f.state().tool_requests[0].state, 'pending');
  assert.equal((await h.service.submit({ ...request, body: { answer: 'A' } })).acceptance, 'accepted');
  assert.equal(h.f.adapter.log.decisions.length, 1);
});

test('R7 metadata overflow is an explicit 503, not a stale snapshot or host restart', async t => {
  const h = bridge(t);
  h.client.snapshot = () => { throw Object.assign(Error('snapshot_too_large'), { code: 'snapshot_too_large' }); };
  await assert.rejects(h.service.snapshot('session'), { code: 'snapshot_too_large', status: 503 });
  assert.equal((await h.service.list()).host, 'running'); assert.equal(h.launches, 0);
});
