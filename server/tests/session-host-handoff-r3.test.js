'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/session-host-fixture');
const { SimulatedCrash } = require('../sessionHost/faults');
const { buildHandoffCommand } = require('../sessionHost/handoffCommand');
function update(f, sql, ...args) {
  const db = new Database(f.dbPath);
  try { db.prepare(sql).run(...args); } finally { db.close(); }
}
function assertNoHandoff(f) {
  assert.equal(f.state().session.state, 'active');
  assert.equal(f.state().handoff_command, undefined);
  assert.equal(f.core.eventsSince(0).events.some(event => event.type === 'handoff_ready'), false);
}
for (const point of ['after_spawn_sent_before_spawn', 'after_spawn_before_identity']) {
  for (const changedHome of [false, true]) {
    test(`R3 latest resume ${point}, child gone, changed HOME=${changedHome}: no older fallback`, t => {
      const f = fixture(t, { home: '/home/A' }); f.start(); f.core.submit(f.req('stop'));
      f.adapter.home = changedHome ? '/home/B' : '/home/A';
      f.faults.arm(point); const resume = f.req('resume');
      assert.throws(() => f.core.submit(resume), SimulatedCrash);
      const crashedId = f.core.lookup(resume.request_key).incarnation_id;
      assert.equal(f.adapter.log.starts.length, point === 'after_spawn_before_identity' ? 2 : 1);
      f.adapter.exit(crashedId); f.reboot().recover(); f.iid = crashedId;
      const latest = f.state().incarnations.find(row => row.id === crashedId);
      assert.equal(latest.state, 'never_started'); assert.equal(latest.pid, null);
      assert.equal(latest.pid_started_at, null); assert.equal(latest.account_snapshot, null);
      f.adapter.home = '/home/A';
      const closes = f.adapter.log.closes.length, signals = f.adapter.log.signals.length;
      assert.equal(f.core.submit(f.req('handoff')).reason, 'handoff_identity_unavailable');
      assertNoHandoff(f);
      assert.equal(f.adapter.log.closes.length, closes); assert.equal(f.adapter.log.signals.length, signals);
      const fresh = f.core.submit(f.req('resume')); assert.equal(fresh.state, 'done'); f.iid = fresh.incarnation_id;
      assert.equal(f.core.submit(f.req('stop')).state, 'done');
      assert.equal(f.core.submit(f.req('handoff')).state, 'done');
      assert.ok(f.state().handoff_command);
    });
  }
}
for (const field of ['pid', 'pid_started_at', 'cli_home', 'cli_path', 'cli_sha256', 'account_snapshot']) {
  test(`R3 latest ${field} missing is unavailable; restoring only that field passes`, t => {
    const f = fixture(t); f.start(); f.core.submit(f.req('stop'));
    const resumed = f.core.submit(f.req('resume')); f.iid = resumed.incarnation_id;
    const original = f.state().incarnations.find(row => row.id === f.iid)[field];
    update(f, `UPDATE incarnations SET ${field}=NULL WHERE id=?`, f.iid);
    assert.equal(f.core.submit(f.req('handoff')).reason, 'handoff_identity_unavailable');
    assertNoHandoff(f);
    assert.equal(f.adapter.log.closes.length, 1);
    update(f, `UPDATE incarnations SET ${field}=? WHERE id=?`, original, f.iid);
    assert.equal(f.core.submit(f.req('handoff')).state, 'done');
  });
}
test('R3 durable gate completion is required even with account snapshot and pid', t => {
  const f = fixture(t); const start = f.start();
  update(f, "UPDATE control_requests SET state='failed' WHERE request_key=?", start.request_key);
  assert.equal(f.core.submit(f.req('handoff')).reason, 'handoff_identity_unavailable');
  assertNoHandoff(f); assert.equal(f.adapter.log.closes.length, 0);
  update(f, "UPDATE control_requests SET state='done' WHERE request_key=?", start.request_key);
  assert.equal(f.core.submit(f.req('handoff')).state, 'done');
});
test('R3 liveness_unknown returns identity_unavailable without effects', t => {
  const f = fixture(t); f.start();
  update(f, "UPDATE incarnations SET state='liveness_unknown' WHERE id=?", f.iid);
  assert.equal(f.core.submit(f.req('handoff')).reason, 'handoff_identity_unavailable');
  assertNoHandoff(f); assert.equal(f.adapter.log.closes.length, 0);
  update(f, "UPDATE incarnations SET state='alive' WHERE id=?", f.iid);
  assert.equal(f.core.submit(f.req('handoff')).state, 'done');
});
const input = { cwd: "/work/space ' $ `", home: "/home/space ' $ `", executablePath: "/bundled/space ' $ `",
  claudeSessionId: '12345678-1234-4234-8234-123456789abc' };
for (const field of ['cwd', 'home', 'executablePath']) {
  for (const slash of ['\\', '\\\\', "'\\\\'"]) {
    test(`R3 ${field} rejects backslash sequence ${JSON.stringify(slash)} with one-field control`, () => {
      assert.throws(() => buildHandoffCommand({ ...input, [field]: input[field] + slash }), { code: 'unsupported_path_character' });
      assert.ok(buildHandoffCommand(input));
    });
  }
  test(`R3 ${field} backslash is refused before interrupt close signal; quote-only path passes`, t => {
    const f = fixture(t); f.start();
    const bad = "/safe/'\\\\$` space", good = "/safe/'$` space";
    const configure = value => {
      if (field === 'cwd') update(f, 'UPDATE owned_sessions SET cwd=? WHERE id=?', value, f.sid);
      else {
        const column = field === 'home' ? 'cli_home' : 'cli_path';
        f.adapter[field] = value;
        update(f, `UPDATE incarnations SET ${column}=? WHERE id=?`, value, f.iid);
      }
    };
    configure(bad);
    assert.equal(f.core.submit(f.req('handoff')).reason, 'unsupported_path_character');
    assertNoHandoff(f);
    for (const kind of ['closes', 'interrupts', 'signals']) assert.equal(f.adapter.log[kind].length, 0);
    configure(good);
    assert.equal(f.core.submit(f.req('handoff')).state, 'done');
    assert.equal(f.adapter.log.closes.length, 1);
  });
}
