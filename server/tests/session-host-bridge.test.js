'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');

test('C1 raw SDK messages replay without any state transition', t => {
  const f = fixture(t); f.start();
  const before = f.state();
  const seq = f.core.snapshot(f.sid).seq_high;
  const message = { type: 'assistant', message: { content: [{ type: 'text', text: 'full answer' }] } };
  f.core.onEvent({ type: 'sdk_message', incarnation_id: f.iid, message });
  assert.deepEqual(f.state(), before);
  const replay = f.core.eventsSince(seq);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].type, 'sdk_message');
  assert.deepEqual(replay.events[0].json, { message });
});

test('C1 list projects latest incarnation, pending count and activity in one view', t => {
  const f = fixture(t); f.start();
  f.adapter.toolRequest(f.iid, 'tool', 'Bash', { command: 'secret' });
  const listed = f.core.listSessions();
  assert.equal(listed.sessions.length, 1);
  const row = listed.sessions[0];
  assert.equal(row.id, f.sid);
  assert.equal(row.incarnation.state, 'alive');
  assert.equal(row.incarnation.has_pid, true);
  assert.equal(row.pending_approvals, 1);
  assert.equal(row.last_activity_seq, listed.seq_high);
  assert.equal(JSON.stringify(listed).includes('secret'), false);
  f.core.submit(f.req('close')); f.core.submit(f.req('delete'));
  assert.deepEqual(f.core.listSessions().sessions, []);
});

test('C1 preview only exposes names, paths and verdict without spawn', async t => {
  const f = fixture(t);
  f.adapter.checkSettings = () => ({ effective: {
    env: { SAFE: 'SECRET-ENV' }, hooks: { PermissionRequest: [{ command: 'SECRET-CMD' }] },
    mcpServers: { local: { headers: { Authorization: 'SECRET-HEADER' }, args: ['SECRET-ARG'] } }
  }, sources: [{ path: '/safe/settings', settings: { secret: 'SECRET-SOURCE' } }],
  provenance: { hooks: { path: '/safe/settings' }, mcpServers: { path: '/safe/mcp' } } });
  const preview = await f.core.settingsPreview('/safe');
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.hooks, [{ event: 'PermissionRequest', paths: ['/safe/settings'] }]);
  assert.deepEqual(preview.mcp_servers, [{ name: 'local', paths: ['/safe/mcp'] }]);
  assert.deepEqual(preview.warnings, ['permission_request_hook']);
  assert.equal(JSON.stringify(preview).includes('SECRET'), false);
  assert.equal(f.adapter.log.starts.length, 0);
  f.adapter.checkSettings = () => { throw new Error('SECRET-FAILURE'); };
  assert.deepEqual(await f.core.settingsPreview('/safe'), { ok: false, reason: 'settings_check_failed' });
});

for (const invalid of [null, {}, { effective: {}, sources: {}, provenance: {} },
  { effective: { env: { SAFE: 3 } }, sources: [], provenance: {} }]) {
  test('C1 malformed settings preview fails closed: ' + JSON.stringify(invalid), async t => {
    const f = fixture(t);
    f.adapter.checkSettings = () => invalid;
    assert.deepEqual(await f.core.settingsPreview('/safe'), { ok: false, reason: 'settings_check_failed' });
    assert.equal(f.adapter.log.starts.length, 0);
  });
}

test('C1 preview rejects auth override using fixed code and paths only', async t => {
  const f = fixture(t);
  f.adapter.checkSettings = () => ({ effective: { env: { ANTHROPIC_API_KEY: 'SECRET' } },
    sources: [], provenance: { env: { path: '/safe/settings' } } });
  const verdict = await f.core.settingsPreview('/safe');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'settings_auth_override');
  assert.equal(verdict.detail, '/safe/settings');
  assert.equal(JSON.stringify(verdict).includes('SECRET'), false);
});

test('C1 preview deadline settles a stuck adapter without starting a process', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(t);
  f.adapter.checkSettings = () => new Promise(() => {});
  const preview = f.core.settingsPreview('/safe');
  await Promise.resolve();
  t.mock.timers.tick(require('../sessionHost/pin').resolveSettingsDeadlineMs);
  assert.deepEqual(await preview, { ok: false, reason: 'settings_check_failed' });
  assert.equal(f.adapter.log.starts.length, 0);
});

test('C1 deleting session remains listed and deleted session disappears', t => {
  const { SimulatedCrash } = require('../sessionHost/faults');
  const f = fixture(t); f.start(); f.core.submit(f.req('close'));
  f.faults.arm('after_deleting_commit');
  assert.throws(() => f.core.submit(f.req('delete')), SimulatedCrash);
  f.reboot();
  assert.equal(f.core.listSessions().sessions[0].state, 'deleting');
  f.core.recover();
  assert.deepEqual(f.core.listSessions().sessions, []);
});

test('C1 list holds one read view when a writer inserts between rows and high sequence', t => {
  const Database = require('better-sqlite3');
  let writer;
  let inserted = false;
  const f = fixture(t, { readHooks: { afterState() {
    if (!writer || inserted) return;
    inserted = true;
    writer.prepare("INSERT INTO events(session_id,type,json,created_at) VALUES(?,'sdk_message','{}',0)").run(f.sid);
  } } });
  f.start();
  writer = new Database(f.dbPath);
  t.after(() => writer.close());
  const listed = f.core.listSessions();
  assert.equal(listed.seq_high, listed.sessions[0].last_activity_seq);
  const replay = f.core.eventsSince(listed.seq_high);
  assert.equal(replay.events.length, 1);
  assert.equal(replay.events[0].seq, listed.seq_high + 1);
});
